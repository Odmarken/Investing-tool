// Immutable, versioned AI Forecast records. Every signal and forecast is
// stored once under an id derived from what it describes (put-if-absent,
// never overwritten), deep-frozen, and sealed with a hash of its content, so
// a later visit can show that a stored forecast is exactly what was made then.
import {MODEL,SIGNAL_PARAMS,TF} from './forecast-config.js';
export const STORE_SCHEMA=1;
// The `code` of the error a put throws when the archive has no room left.
export const ARCHIVE_FULL='archive-full';
const ORIGINS=Object.freeze(['live','backfill']),SIDES=Object.freeze(['long','short']);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
// Ids join their parts with '|', so only the uid (the first part) may contain one.
const part=x=>typeof x==='string'&&x!==''&&!x.includes('|');
const omitted=v=>v===undefined||typeof v==='function'||typeof v==='symbol';

// JSON.stringify's rules with object keys sorted at every level, so a record
// hashes the same before and after a JSON or structured-clone round trip.
function canonical(x){
  if(x!==null&&typeof x==='object'&&typeof x.toJSON==='function')x=x.toJSON();
  if(x===null||typeof x!=='object')return JSON.stringify(x)??'null';
  if(Array.isArray(x))return '['+x.map(v=>omitted(v)?'null':canonical(v)).join(',')+']';
  return '{'+Object.keys(x).sort().filter(k=>!omitted(x[k])).map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
// cyrb53 (bryc, public domain): a fast 53-bit hash. It detects edits, not deliberate forgery.
function cyrb53(text){
  let h1=0xdeadbeef,h2=0x41c6ce57;
  for(let i=0;i<text.length;i++){const ch=text.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}
  h1=Math.imul(h1^(h1>>>16),2246822507);h1^=Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507);h2^=Math.imul(h1^(h1>>>13),3266489909);
  return 4294967296*(2097151&h2)+(h1>>>0);
}
export function hashOf(value){return cyrb53(canonical(value)).toString(16).padStart(14,'0');}

export function deepFreeze(x){
  const seen=new WeakSet();
  const walk=v=>{
    // Typed arrays cannot be frozen; records never hold them.
    if(v===null||typeof v!=='object'||seen.has(v)||ArrayBuffer.isView(v))return;
    seen.add(v);
    for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(d&&'value' in d)walk(d.value);}
    Object.freeze(v);
  };
  walk(x);return x;
}

// When and by whom a record was made: the runner and the chart can both compute
// the same signal at different moments, so these never decide identity.
const META=Object.freeze(['createdAt','recordedAt','origin','hash','contentHash']);
const contentOf=r=>{const c={...r};for(const k of META)delete c[k];return c;};
// The body goes through JSON once, so what is hashed is exactly what any backend
// returns later. contentHash covers what the record says; hash seals everything.
function seal(body){
  const plain=JSON.parse(JSON.stringify(body));
  plain.contentHash=hashOf(contentOf(plain));
  return deepFreeze({...plain,hash:hashOf(plain)});
}
export function forecastRecord(uid,symbol,tf,forecast,{createdAt,origin,tfMs=TF[tf]?.ms}={}){
  if(typeof uid!=='string'||!uid||!part(symbol)||!part(tf)||!forecast||typeof forecast!=='object'||forecast.ok===false||!finite(forecast.cutoff)||
    !part(forecast.model)||!finite(createdAt)||!ORIGINS.includes(origin)||!finite(tfMs)||tfMs<=0)throw Error('Ogiltig prognospost');
  const content={...forecast};delete content.ok;
  return seal({id:`f|${uid}|${symbol}|${tf}|${forecast.cutoff}|${forecast.model}`,kind:'forecast',schema:STORE_SCHEMA,uid,symbol,tf,
    model:forecast.model,createdAt,cutoff:forecast.cutoff,cutoffClose:forecast.cutoff+tfMs,origin,forecast:content});
}
export function signalRecord(uid,symbol,tf,evaluation,{recordedAt,origin,params=SIGNAL_PARAMS,tfMs=TF[tf]?.ms,model=MODEL.signal}={}){
  const e=evaluation;
  if(typeof uid!=='string'||!uid||!part(symbol)||!part(tf)||!e||typeof e!=='object'||!finite(e.t)||!SIDES.includes(e.side)||
    ![e.entry,e.sl,e.tp,e.atr].every(finite)||!finite(recordedAt)||!ORIGINS.includes(origin)||!finite(tfMs)||tfMs<=0||!part(model))throw Error('Ogiltig signalpost');
  return seal({id:`s|${uid}|${symbol}|${tf}|${e.t}|${model}`,kind:'signal',schema:STORE_SCHEMA,uid,symbol,tf,model,paramsHash:hashOf(params),
    barTime:e.t,confirmedAt:e.t+tfMs,recordedAt,origin,side:e.side,entry:e.entry,sl:e.sl,tp:e.tp,atr:e.atr,
    regime:e.regime??null,explanation:e.explanation??[],checks:e.checks??[],features:e.features??null});
}
export function verifyRecord(r){
  if(!r||typeof r!=='object'||typeof r.hash!=='string'||typeof r.contentHash!=='string')return false;
  const body={...r};delete body.hash;
  try{return hashOf(body)===r.hash&&hashOf(contentOf(r))===r.contentHash;}catch{return false;}
}

const cmp=(a,b)=>a<b?-1:a>b?1:0,at=x=>finite(x)?x:-Infinity;
const ORDER={
  forecast:(a,b)=>cmp(at(a.cutoff),at(b.cutoff))||cmp(at(a.createdAt),at(b.createdAt))||cmp(String(a.id),String(b.id)),
  signal:(a,b)=>cmp(at(a.barTime),at(b.barTime))||cmp(String(a.id),String(b.id))
};
const inSeries=(r,kind,uid,symbol,tf)=>r.kind===kind&&r.uid===uid&&r.symbol===symbol&&r.tf===tf;
// The id the builders derive from a record's own fields. A sealed record whose id says
// otherwise could take the id of another record and block it for good.
const idOf=r=>r.kind==='forecast'?`f|${r.uid}|${r.symbol}|${r.tf}|${r.cutoff}|${r.model}`:`s|${r.uid}|${r.symbol}|${r.tf}|${r.barTime}|${r.model}`;
const checkBackend=b=>{if(!b||['add','get','series'].some(k=>typeof b[k]!=='function'))throw Error('Ogiltig lagring för prognoser');return b;};

// A bounded list reads only the ids of a series, orders them by the time inside each id (cutoff or
// bar time, then the id) and reads and checks just the page: the newest `limit` before the cursor.
function pager(kind,uid,symbol,tf,{limit=Infinity,before=null}={}){
  const head=(kind==='forecast'?'f|':'s|')+uid+'|'+symbol+'|'+tf+'|';
  const timeOf=id=>{const t=Number(id.slice(head.length).split('|')[0]);return id.startsWith(head)&&Number.isFinite(t)?t:-Infinity;};
  if(!(limit===Infinity||Number.isSafeInteger(limit)&&limit>0))throw Error('Ogiltigt antal poster att läsa ur prognosarkivet');
  if(before!==null&&(typeof before!=='string'||timeOf(before)===-Infinity))throw Error('Ogiltig markör för prognosarkivet');
  const order=(a,b)=>cmp(a.t,b.t)||cmp(a.id,b.id);
  return ids=>{
    const keyed=[...new Set(ids)].filter(id=>typeof id==='string').map(id=>({id,t:timeOf(id)})).sort(order);
    let end=keyed.length;
    if(before!==null){const c={id:before,t:timeOf(before)};end=keyed.findIndex(k=>order(k,c)>=0);if(end<0)end=keyed.length;}
    const from=Math.max(0,end-limit);
    return {ids:keyed.slice(from,end).map(k=>k.id),total:keyed.length,older:from,next:from>0?keyed[from].id:null};
  };
}

/**
 * put*: stores a sealed record unless its id exists; an existing record is never
 * replaced, whether the new one is identical or not (a conflict keeps the original).
 * Identical means the same content (contentHash) in an intact stored record; a
 * different recordedAt, createdAt or origin is not a conflict, and the stored
 * record keeps its own.
 * list*(uid,symbol,tf): {records, corrupt}, both sorted (forecasts by cutoff then
 * createdAt, signals by barTime). Records that fail their hash, or that a backend
 * could not read, are left untouched and returned only in `corrupt`, so nothing
 * changed or damaged is ever shown or traded as if it were the original.
 * list*(uid,symbol,tf,{limit,before}): one page, newest first by the record's time
 * (cutoff or barTime, then id): {records, corrupt (both of this page only, sorted as
 * above), total (stored entries in the series), older (entries before this page),
 * next (cursor: pass as `before` for the next older page; null when none is left)}.
 * info(): where the records are kept, {kind, note} (note: Swedish, '' when nothing needs saying).
 */
export function createForecastStore(backend){
  checkBackend(backend);
  const put=kind=>async record=>{
    if(record?.kind!==kind||typeof record.id!=='string'||record.id!==idOf(record)||!verifyRecord(record))throw Error(kind==='forecast'?'Ogiltig prognospost':'Ogiltig signalpost');
    const r=deepFreeze(JSON.parse(JSON.stringify(record))),res=await backend.add(r);
    if(res?.ok===true)return {stored:true};
    const existing=res?.existing&&typeof res.existing==='object'?deepFreeze(res.existing):null;
    return existing&&verifyRecord(existing)&&existing.contentHash===r.contentHash?{stored:false,identical:true,existing}:{stored:false,conflict:true,existing};
  };
  const page=async(kind,uid,symbol,tf,options)=>{
    const pick=pager(kind,uid,symbol,tf,options);
    let rows=null,ids;
    // Backends without ids()/getMany() are read whole; only the page is still checked.
    if(typeof backend.ids==='function'&&typeof backend.getMany==='function')ids=await backend.ids(kind,uid,symbol,tf)??[];
    else{
      rows=new Map();
      for(const row of await backend.series(kind,uid,symbol,tf)??[])if(row&&typeof row==='object'&&!rows.has(row.id))rows.set(row.id,row);
      ids=[...rows.keys()];
    }
    const p=pick(ids),got=rows?p.ids.map(id=>rows.get(id)):await backend.getMany(p.ids)??[];
    const records=[],corrupt=[];
    p.ids.forEach((id,k)=>{
      // Listed but gone (deleted after it was stored): reported, never skipped.
      const row=got[k]&&typeof got[k]==='object'?got[k]:{id,missing:true,kind,uid,symbol,tf};
      deepFreeze(row);
      (row.id===id&&verifyRecord(row)&&inSeries(row,kind,uid,symbol,tf)&&row.id===idOf(row)?records:corrupt).push(row);
    });
    return {records:records.sort(ORDER[kind]),corrupt:corrupt.sort(ORDER[kind]),total:p.total,older:p.older,next:p.next};
  };
  const list=kind=>async(uid,symbol,tf,options)=>{
    if(options!=null)return page(kind,uid,symbol,tf,options);
    const records=[],corrupt=[],seen=new Set();
    for(const row of await backend.series(kind,uid,symbol,tf)??[]){
      if(!row||typeof row!=='object'||seen.has(row.id))continue;
      seen.add(row.id);deepFreeze(row);
      (verifyRecord(row)&&inSeries(row,kind,uid,symbol,tf)&&row.id===idOf(row)?records:corrupt).push(row);
    }
    return {records:records.sort(ORDER[kind]),corrupt:corrupt.sort(ORDER[kind])};
  };
  return {putForecast:put('forecast'),putSignal:put('signal'),listForecasts:list('forecast'),listSignals:list('signal'),
    async get(id){const r=await backend.get(id);return r&&typeof r==='object'?deepFreeze(r):null;},
    async info(){
      const v=typeof backend.ready==='function'?await backend.ready():backend;
      return Object.freeze({kind:typeof v?.kind==='string'?v.kind:'custom',note:typeof v?.note==='string'?v.note:''});
    }};
}

const VISIT='Signaler och prognoser sparas bara under det här besöket.';
const charsText=n=>n>=1e6&&n%1e5===0?(n/1e6).toLocaleString('sv-SE')+' miljoner':n.toLocaleString('sv-SE');

/**
 * Backend interface: {add(record)→{ok:true}|{ok:false,existing}, get(id)→record|null,
 * series(kind,uid,symbol,tf)→records} and, for bounded lists, ids(kind,uid,symbol,tf)→ids
 * and getMany(ids)→records (null where none), in that order. kind and note say where
 * records are kept (note: Swedish, '' when nothing needs saying).
 */
export function memoryBackend(){
  const rows=new Map(),of=(kind,uid,symbol,tf)=>[...rows.values()].filter(r=>inSeries(r,kind,uid,symbol,tf));
  return Object.freeze({kind:'memory',note:VISIT,
    async add(record){
      if(rows.has(record.id))return {ok:false,existing:rows.get(record.id)};
      rows.set(record.id,deepFreeze(structuredClone(record)));return {ok:true};
    },
    async get(id){return rows.get(id)??null;},
    async series(kind,uid,symbol,tf){return of(kind,uid,symbol,tf);},
    async ids(kind,uid,symbol,tf){return of(kind,uid,symbol,tf).map(r=>r.id);},
    async getMany(ids){return ids.map(id=>rows.get(id)??null);}
  });
}

/**
 * One JSON value per record and an id list per series. The other demo
 * accounts share this storage, so the archive stops at maxChars instead of
 * filling it. Unreadable or deleted records come back as stubs, so they are
 * reported as corrupt and their ids are never reused.
 */
export function localStorageBackend(storage,prefix='riptide.forecast.records.v1',{maxChars=1500000}={}){
  if(!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function')throw Error('Ogiltig lagring för prognoser');
  const head=prefix+':record:',recordKey=id=>head+id,sizeKey=prefix+':size';
  const seriesKey=(kind,uid,symbol,tf)=>prefix+':series:'+[kind,uid,symbol,tf].map(encodeURIComponent).join('|');
  const parse=(raw,id,series)=>{
    try{const v=JSON.parse(raw);if(v&&typeof v==='object'&&!Array.isArray(v))return v;}catch{}
    return {id,unreadable:true,...series};
  };
  // An unreadable index is rebuilt from the records themselves when the storage can be listed.
  function scan(kind,uid,symbol,tf){
    const ids=[];
    if(typeof storage.key!=='function'||!finite(storage.length))return ids;
    for(let i=0;i<storage.length;i++){
      const k=storage.key(i);
      if(typeof k==='string'&&k.startsWith(head)&&inSeries(parse(storage.getItem(k),''),kind,uid,symbol,tf))ids.push(k.slice(head.length));
    }
    return ids;
  }
  function index(kind,uid,symbol,tf){
    const raw=storage.getItem(seriesKey(kind,uid,symbol,tf));
    if(raw===null)return [];
    try{const v=JSON.parse(raw);if(Array.isArray(v)&&v.every(x=>typeof x==='string'))return v;}catch{}
    return scan(kind,uid,symbol,tf);
  }
  return Object.freeze({kind:'localStorage',note:'Signaler och prognoser sparas i webbläsarens lokala lagring, som rymmer högst '+charsText(maxChars)+' tecken.',
    async add(record){
      const {id,kind,uid,symbol,tf}=record,key=recordKey(id),sKey=seriesKey(kind,uid,symbol,tf),ids=index(kind,uid,symbol,tf),current=storage.getItem(key);
      if(current!==null){
        // A record written just before a crash may miss its index entry; listing must still find it.
        if(!ids.includes(id))try{storage.setItem(sKey,JSON.stringify([...ids,id]));}catch{}
        return {ok:false,existing:parse(current,id,{kind,uid,symbol,tf})};
      }
      // Listed but gone: the record was deleted after it was stored. Writing anew would
      // erase that evidence and let different content take the id.
      if(ids.includes(id))return {ok:false,existing:{id,missing:true,kind,uid,symbol,tf}};
      const json=JSON.stringify(record),used=Number(storage.getItem(sizeKey))||0;
      // The code lets the runner tell a full archive from a failing one.
      if(used+json.length>maxChars)throw Object.assign(Error('Prognosarkivet är fullt'),{code:ARCHIVE_FULL});
      try{
        storage.setItem(key,json);
        if(!ids.includes(id))storage.setItem(sKey,JSON.stringify([...ids,id]));
      }catch{
        // Never leave a record that no index lists.
        try{storage.removeItem(key);}catch{}
        throw Error('Prognosarkivet kunde inte sparas');
      }
      try{storage.setItem(sizeKey,String(used+json.length));}catch{}
      return {ok:true};
    },
    async get(id){const raw=storage.getItem(recordKey(id));return raw===null?null:parse(raw,id,{});},
    async series(kind,uid,symbol,tf){
      const out=[];
      for(const id of new Set(index(kind,uid,symbol,tf))){
        const raw=storage.getItem(recordKey(id));
        out.push(raw===null?{id,missing:true,kind,uid,symbol,tf}:parse(raw,id,{kind,uid,symbol,tf}));
      }
      return out;
    },
    async ids(kind,uid,symbol,tf){return [...new Set(index(kind,uid,symbol,tf))];},
    async getMany(ids){return ids.map(id=>{const raw=storage.getItem(recordKey(id));return raw===null?null:parse(raw,id,{});});}
  });
}

/**
 * Object store 'records' (keyPath id) with the index 'series' on
 * [kind,uid,symbol,tf]. add() is IndexedDB's own put-if-absent: a
 * ConstraintError means the id exists, and the stored record is read back in
 * the same transaction.
 */
export function indexedDbBackend(indexedDB,name='riptide-forecast'){
  if(!indexedDB||typeof indexedDB.open!=='function')throw Error('Ogiltig lagring för prognoser');
  let opening=null;
  const open=()=>opening??=new Promise((resolve,reject)=>{
    const req=indexedDB.open(name,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('records'))db.createObjectStore('records',{keyPath:'id'}).createIndex('series',['kind','uid','symbol','tf']);
    };
    req.onsuccess=()=>{
      const db=req.result;
      // A newer page upgrading the database: close, and reopen on the next call.
      db.onversionchange=()=>{db.close();opening=null;};
      resolve(db);
    };
    req.onerror=()=>reject(req.error);
  }).catch(()=>{opening=null;throw Error('Prognosarkivet kunde inte öppnas');});
  const run=(mode,fill)=>open().then(db=>new Promise((resolve,reject)=>{
    const fail=()=>reject(Error(mode==='readwrite'?'Prognosarkivet kunde inte sparas':'Prognosarkivet kunde inte läsas'));
    let tx,result=null;
    try{tx=db.transaction('records',mode);fill(tx.objectStore('records'),v=>{result=v;});}
    catch{opening=null;fail();return;}
    tx.oncomplete=()=>resolve(result);
    tx.onabort=fail;
  }));
  return Object.freeze({kind:'indexedDB',note:'',
    add(record){
      return run('readwrite',(store,done)=>{
        const req=store.add(record);
        req.onsuccess=()=>done({ok:true});
        req.onerror=event=>{
          // Any other error aborts the transaction, which rejects.
          if(req.error?.name!=='ConstraintError')return;
          event.preventDefault();event.stopPropagation?.();
          const read=store.get(record.id);
          read.onsuccess=()=>done({ok:false,existing:read.result??null});
        };
      });
    },
    get(id){return run('readonly',(store,done)=>{const req=store.get(id);req.onsuccess=()=>done(req.result??null);});},
    series(kind,uid,symbol,tf){
      return run('readonly',(store,done)=>{const req=store.index('series').getAll([kind,uid,symbol,tf]);req.onsuccess=()=>done(req.result??[]);});
    },
    // Keys only: no record is read or deserialized for the ids of a series.
    ids(kind,uid,symbol,tf){
      return run('readonly',(store,done)=>{const req=store.index('series').getAllKeys([kind,uid,symbol,tf]);req.onsuccess=()=>done(req.result??[]);});
    },
    // One transaction for the page; a transaction without requests may never complete, so none is opened for no ids.
    getMany(ids){
      if(!ids.length)return Promise.resolve([]);
      return run('readonly',(store,done)=>{
        const out=ids.map(()=>null);let left=ids.length;
        ids.forEach((id,k)=>{const req=store.get(id);req.onsuccess=()=>{out[k]=req.result??null;if(--left===0)done(out);};});
      });
    }
  });
}

const IDB_WHY=Object.freeze({missing:'IndexedDB saknas i webbläsaren',blocked:'IndexedDB är blockerad',failed:'IndexedDB kunde inte öppnas'});
const LOCAL_WHY=Object.freeze({missing:'lokal lagring saknas',blocked:'den lokala lagringen är blockerad'});
/**
 * IndexedDB when the browser has it, else localStorage, else memory. Some
 * private modes expose indexedDB but refuse to open it; then this visit uses
 * the fallback. kind and note say which one is used and why ('pending' and ''
 * until IndexedDB has answered once); ready() opens it if needed and resolves
 * to the final frozen {kind, note}.
 */
export function defaultBackend(globalThis_=globalThis){
  const g=globalThis_;
  // A fallback's note starts with why IndexedDB is not used.
  const told=(b,why)=>Object.freeze({...b,note:why+', så '+b.note[0].toLowerCase()+b.note.slice(1)});
  const fallback=idb=>{
    let local='missing';
    try{const s=g?.localStorage;if(s&&typeof s.getItem==='function'&&typeof s.setItem==='function')return told(localStorageBackend(s),IDB_WHY[idb]);}
    catch{local='blocked';}
    return told(memoryBackend(),idb==='blocked'&&local==='blocked'?'Webbläsarens lagring är blockerad':IDB_WHY[idb]+' och '+LOCAL_WHY[local]);
  };
  let idb=null,why='missing';
  try{idb=g?.indexedDB??null;}catch{why='blocked';}
  if(!idb||typeof idb.open!=='function')return fallback(why);
  const primary=indexedDbBackend(idb);let chosen=null,used=null;
  const pick=()=>chosen??=primary.get('').then(()=>primary,()=>fallback('failed')).then(b=>used=b);
  const via=k=>(...a)=>pick().then(b=>b[k](...a));
  return Object.freeze({get kind(){return used?.kind??'pending';},get note(){return used?.note??'';},
    ready:()=>pick().then(b=>Object.freeze({kind:b.kind,note:b.note})),
    add:via('add'),get:via('get'),series:via('series'),ids:via('ids'),getMany:via('getMany')});
}
