import test from 'node:test';
import assert from 'node:assert/strict';
import {STORE_SCHEMA,hashOf,deepFreeze,forecastRecord,signalRecord,verifyRecord,createForecastStore,memoryBackend,localStorageBackend,indexedDbBackend,defaultBackend} from '../forecast-store.js';
import {MODEL,SIGNAL_PARAMS,TF} from '../forecast-config.js';

const HOUR=3600000,T=Date.parse('2026-10-04T12:00:00Z');
const PREFIX='riptide.forecast.records.v1';
// Shaped like forecastAt's result; `shift` changes the content without changing the id.
const forecast=(cutoff,shift=0)=>({ok:true,model:MODEL.forecast,cutoff,base:100+shift,unit:.0082,horizon:3,k:30,
  candles:[1,2,3].map(h=>({t:cutoff+h*HOUR,o:100+h,h:101.5+h,l:99+h,c:100.5+h})),
  bands:[1,2,3].map(h=>({t:cutoff+h*HOUR,q10:97-h,q25:98.5,q50:100+h/10,q75:101.5,q90:103+h})),
  medoid:{t:cutoff-40*HOUR,d:.4172},analogs:[cutoff-40*HOUR,cutoff-90*HOUR],train:{from:cutoff-1500*HOUR,to:cutoff,n:1312}});
// Shaped like evaluateBar's result for a long signal.
const evaluation=(t,side='long')=>({t,close:85230,regime:side==='long'?'trend-up':'trend-down',side,entry:85230,
  sl:side==='long'?84300:86160,tp:side==='long'?87090:83370,atr:620,
  checks:[{key:'trend',label:'Trend',ok:true,value:27},{key:'htf',label:'Högre tidsram',ok:true,value:1}],reason:'',
  explanation:['Trend upp: EMA20 över EMA50 och EMA50 stiger · ADX 27','Volym 1,6× median'],
  features:{adx:27,rsi:63,roc:.021,relVol:1.6,volRank:.54,atrPct:.0082,emaFast:85010,emaSlow:84500,slope:120,donHigh:85010,donLow:83100,htf:{dir:1,close:85100,ema:84000,t:t-4*HOUR}}});
const fRec=(cutoff,{uid='u1',symbol='BTC',tf='1h',createdAt=cutoff+HOUR+5000,origin='live',shift=0}={})=>
  forecastRecord(uid,symbol,tf,forecast(cutoff,shift),{createdAt,origin,tfMs:TF[tf].ms});
const sRec=(t,{uid='u1',symbol='BTC',tf='1h',side='long',recordedAt=t+HOUR+2000,origin='live'}={})=>
  signalRecord(uid,symbol,tf,evaluation(t,side),{recordedAt,origin,params:SIGNAL_PARAMS,tfMs:TF[tf].ms});
const memoryStorage=()=>{const m=new Map();return {get length(){return m.size;},key:i=>[...m.keys()][i]??null,getItem:k=>m.has(k)?m.get(k):null,
  setItem(k,v){m.set(k,String(v));},removeItem(k){m.delete(k);}};};

// A small IndexedDB: asynchronous requests, auto-committing transactions that
// roll back on abort, key-path stores, compound indexes, and add() failing
// with a ConstraintError when the key exists. An error event that is not
// preventDefault()-ed aborts its transaction, as in the browser.
function fakeIndexedDB({failAdd=null,failOpen=false}={}){
  // reads: how many records each kind of request returned, so a test can see what was read.
  const databases=new Map(),log=[],reads={get:0,getAll:0,getAllKeys:0},later=fn=>setTimeout(fn,0);
  const domError=name=>Object.assign(new Error(name),{name});
  const event=target=>{const e={target,defaultPrevented:false,preventDefault(){e.defaultPrevented=true;},stopPropagation(){}};return e;};
  function transaction(db,names,mode){
    const queue=[],undo=[];let state='active',scheduled=false;
    const schedule=()=>{if(!scheduled){scheduled=true;later(step);}};
    function step(){
      scheduled=false;if(state!=='active')return;
      const op=queue.shift();
      if(op){op();schedule();return;}
      state='done';tx.oncomplete?.(event(tx));
    }
    function abort(error){state='aborted';undo.reverse().forEach(f=>f());tx.error=error;later(()=>tx.onabort?.(event(tx)));}
    function request(run){
      if(state!=='active')throw domError('TransactionInactiveError');
      const req={result:undefined,error:null,onsuccess:null,onerror:null};
      queue.push(()=>{if(state==='active')run(req);});schedule();return req;
    }
    const succeed=(req,result)=>{req.result=result;req.onsuccess?.(event(req));};
    const fail=(req,name)=>{req.error=domError(name);const e=event(req);req.onerror?.(e);if(!e.defaultPrevented)abort(req.error);};
    const tx={mode,error:null,oncomplete:null,onabort:null,
      objectStore(name){
        if(!names.includes(name))throw domError('NotFoundError');
        const s=db.stores.get(name);
        return {
          add(value){
            if(mode!=='readwrite')throw domError('ReadOnlyError');
            const copy=structuredClone(value),key=copy[s.keyPath];
            return request(req=>{
              if(failAdd)return fail(req,failAdd);
              if(s.rows.has(key))return fail(req,'ConstraintError');
              s.rows.set(key,copy);undo.push(()=>s.rows.delete(key));succeed(req,key);
            });
          },
          get(key){return request(req=>{if(s.rows.has(key))reads.get++;succeed(req,s.rows.has(key)?structuredClone(s.rows.get(key)):undefined);});},
          index(indexName){
            const path=s.indexes.get(indexName);if(!path)throw domError('NotFoundError');
            // Entries with equal index keys come in primary-key order, as in the browser.
            const match=key=>[...s.rows.entries()].filter(([,v])=>JSON.stringify(path.map(p=>v[p]))===JSON.stringify(key)).sort(([a],[b])=>a<b?-1:a>b?1:0);
            return {
              getAll(key){return request(req=>{const rows=match(key);reads.getAll+=rows.length;succeed(req,rows.map(([,v])=>structuredClone(v)));});},
              getAllKeys(key){return request(req=>{const rows=match(key);reads.getAllKeys+=rows.length;succeed(req,rows.map(([k])=>k));});}
            };
          }
        };
      }};
    return tx;
  }
  function connection(db){
    return {
      objectStoreNames:{contains:n=>db.stores.has(n)},
      createObjectStore(name,{keyPath}){
        if(!db.upgrading)throw domError('InvalidStateError');
        const s={keyPath,indexes:new Map(),rows:new Map()};db.stores.set(name,s);log.push('createObjectStore:'+name+':'+keyPath);
        return {createIndex(indexName,path){s.indexes.set(indexName,path);log.push('createIndex:'+indexName+':'+path.join(','));}};
      },
      transaction(names,mode='readonly'){return transaction(db,[].concat(names),mode);},
      close(){}
    };
  }
  return {databases,log,reads,
    open(name,version){
      log.push('open:'+name+':'+version);
      const req={result:null,error:null,onsuccess:null,onerror:null,onupgradeneeded:null};
      later(()=>{
        if(failOpen){req.error=domError('InvalidStateError');req.onerror?.(event(req));return;}
        let db=databases.get(name);if(!db)databases.set(name,db={version:0,stores:new Map(),upgrading:false});
        if(version<db.version){req.error=domError('VersionError');req.onerror?.(event(req));return;}
        req.result=connection(db);
        if(version>db.version){
          const oldVersion=db.version;db.version=version;db.upgrading=true;
          try{req.onupgradeneeded?.({target:req,oldVersion,newVersion:version});}finally{db.upgrading=false;}
        }
        req.onsuccess?.(event(req));
      });
      return req;
    }};
}

// What contentHash covers: everything except when and by whom the record was made.
const contentHashOf=r=>{const c={...r};for(const k of ['createdAt','recordedAt','origin','hash','contentHash'])delete c[k];return hashOf(c);};

test('hashOf is a 14-hex cyrb53 of canonical JSON: key order never matters, content always does',()=>{
  const a={b:[1,{y:2,x:'å'}],a:null},b={a:null,b:[1,{x:'å',y:2}]};
  assert.equal(hashOf(a),hashOf(b));
  // Pinned: a change of hashing would turn every stored record corrupt.
  assert.equal(hashOf(a),'0bc88ce7a229bb');
  assert.equal(hashOf({a:1}),'1034b77cc1d846');
  assert.match(hashOf([]),/^[0-9a-f]{14}$/);
  assert.notEqual(hashOf(a),hashOf({...a,a:0}));
  assert.notEqual(hashOf([1,2]),hashOf([2,1]));
  assert.notEqual(hashOf({a:'1'}),hashOf({a:1}));
  // Same as after a JSON round trip: undefined keys are dropped, NaN becomes null.
  const odd={x:1,y:undefined,z:NaN,w:[undefined,-0]};
  assert.equal(hashOf(odd),hashOf(JSON.parse(JSON.stringify(odd))));
  assert.equal(hashOf(odd),hashOf(structuredClone(odd)));
});

test('deepFreeze freezes every nested object and array in place',()=>{
  const x={a:[{b:1}],c:{d:{e:[2]}}};
  assert.equal(deepFreeze(x),x);
  for(const o of [x,x.a,x.a[0],x.c,x.c.d,x.c.d.e])assert.ok(Object.isFrozen(o));
  assert.throws(()=>{x.a[0].b=2;},TypeError);
  assert.throws(()=>{x.c.d.e.push(3);},TypeError);
  // A shallowly frozen parent still gets its children frozen; cycles are fine.
  const outer=Object.freeze({inner:{v:1}});deepFreeze(outer);assert.ok(Object.isFrozen(outer.inner));
  const loop={};loop.self=loop;assert.equal(deepFreeze(loop),loop);assert.ok(Object.isFrozen(loop));
  assert.equal(deepFreeze(5),5);assert.equal(deepFreeze(null),null);
});

test('a forecast record has a derived id, the forecast without ok, and a hash of everything else',()=>{
  const f=forecast(T),r=forecastRecord('u1','BTC','1h',f,{createdAt:T+HOUR+5000,origin:'live',tfMs:HOUR});
  assert.equal(r.id,`f|u1|BTC|1h|${T}|${MODEL.forecast}`);
  const content={...f};delete content.ok;
  assert.deepEqual(r,{id:r.id,kind:'forecast',schema:STORE_SCHEMA,uid:'u1',symbol:'BTC',tf:'1h',model:MODEL.forecast,createdAt:T+HOUR+5000,
    cutoff:T,cutoffClose:T+HOUR,origin:'live',forecast:content,contentHash:r.contentHash,hash:r.hash});
  assert.equal(STORE_SCHEMA,1);
  assert.equal(r.hash,hashOf({...r,hash:undefined}));
  // contentHash covers what the forecast says, not when or how it was made.
  assert.equal(r.contentHash,contentHashOf(r));
  assert.equal(forecastRecord('u1','BTC','1h',f,{createdAt:T+9*HOUR,origin:'backfill',tfMs:HOUR}).contentHash,r.contentHash);
  assert.notEqual(forecastRecord('u1','BTC','1h',{...f,base:f.base*1.01},{createdAt:T+HOUR+5000,origin:'live',tfMs:HOUR}).contentHash,r.contentHash);
  assert.ok(verifyRecord(r));
  // tfMs defaults to the timeframe's own length.
  assert.deepEqual(forecastRecord('u1','BTC','1h',f,{createdAt:T+HOUR+5000,origin:'live'}),r);
  // The input is neither changed nor frozen; the record is a deep-frozen copy.
  assert.equal(f.ok,true);assert.ok(!Object.isFrozen(f)&&!Object.isFrozen(f.candles));
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.forecast)&&Object.isFrozen(r.forecast.candles[0])&&Object.isFrozen(r.forecast.train));
  assert.throws(()=>{r.forecast.candles[0].c=1;},TypeError);
  assert.throws(()=>{r.cutoff=0;},TypeError);
  assert.throws(()=>{r.forecast.bands.push({});},TypeError);
  assert.throws(()=>{delete r.hash;},TypeError);
  assert.throws(()=>{r.forecast.analogs[0]=1;},TypeError);
  assert.ok(verifyRecord(r));
});

test('a signal record keeps the decision, its explanation and the parameter hash',()=>{
  const e=evaluation(T),r=signalRecord('u1','ETH','15m',e,{recordedAt:T+16*60000,origin:'live',params:SIGNAL_PARAMS,tfMs:TF['15m'].ms});
  assert.equal(r.id,`s|u1|ETH|15m|${T}|${MODEL.signal}`);
  assert.deepEqual(r,{id:r.id,kind:'signal',schema:1,uid:'u1',symbol:'ETH',tf:'15m',model:MODEL.signal,paramsHash:hashOf(SIGNAL_PARAMS),
    barTime:T,confirmedAt:T+15*60000,recordedAt:T+16*60000,origin:'live',side:'long',entry:e.entry,sl:e.sl,tp:e.tp,atr:e.atr,
    regime:e.regime,explanation:e.explanation,checks:e.checks,features:e.features,contentHash:r.contentHash,hash:r.hash});
  assert.equal(r.contentHash,contentHashOf(r));
  assert.equal(signalRecord('u1','ETH','15m',e,{recordedAt:T+9*HOUR,origin:'backfill'}).contentHash,r.contentHash);
  assert.ok(verifyRecord(r));assert.ok(Object.isFrozen(r.features.htf)&&Object.isFrozen(r.checks[1]));
  // Defaults: the frozen rule parameters, the current signal model, the timeframe's length.
  assert.deepEqual(signalRecord('u1','ETH','15m',e,{recordedAt:T+16*60000,origin:'live'}),r);
  assert.notEqual(signalRecord('u1','ETH','15m',e,{recordedAt:T,origin:'live',params:{...SIGNAL_PARAMS,adxTrend:25}}).paramsHash,r.paramsHash);
  assert.equal(signalRecord('u1','ETH','15m',e,{recordedAt:T,origin:'backfill',model:'af-signal-v2'}).id,`s|u1|ETH|15m|${T}|af-signal-v2`);
  const short=sRec(T,{side:'short'});assert.equal(short.side,'short');assert.ok(short.sl>short.entry);
});

test('record builders refuse what cannot be stored as a valid record',()=>{
  const opts={createdAt:T+HOUR,origin:'live',tfMs:HOUR};
  for(const [uid,symbol,tf,f,o] of [
    ['','BTC','1h',forecast(T),opts],[7,'BTC','1h',forecast(T),opts],['u1','BT|C','1h',forecast(T),opts],['u1','BTC','',forecast(T),opts],
    ['u1','BTC','1h',{ok:false,reason:'För kort historik för prognos'},opts],['u1','BTC','1h',{...forecast(T),cutoff:NaN},opts],
    ['u1','BTC','1h',{...forecast(T),model:''},opts],['u1','BTC','1h',null,opts],['u1','BTC','1h',forecast(T),{...opts,origin:'replay'}],
    ['u1','BTC','1h',forecast(T),{...opts,createdAt:undefined}],['u1','BTC','1h',forecast(T),{...opts,tfMs:0}],['u1','BTC','2h',forecast(T),{createdAt:T,origin:'live'}]])
    assert.throws(()=>forecastRecord(uid,symbol,tf,f,o),{message:'Ogiltig prognospost'},JSON.stringify([uid,symbol,tf,o]));
  const ok={recordedAt:T+HOUR,origin:'live'};
  for(const [e,o] of [[{...evaluation(T),side:null,entry:null,sl:null,tp:null},ok],[{...evaluation(T),sl:NaN},ok],[{...evaluation(T),t:undefined},ok],
    [evaluation(T),{...ok,origin:'?'}],[evaluation(T),{...ok,recordedAt:null}],[evaluation(T),{...ok,model:'a|b'}],[null,ok]])
    assert.throws(()=>signalRecord('u1','BTC','1h',e,o),{message:'Ogiltig signalpost'});
});

test('verifyRecord catches any change to a record, including its id or hash',()=>{
  const r=fRec(T),copy=()=>JSON.parse(JSON.stringify(r));
  assert.ok(verifyRecord(copy()));assert.ok(verifyRecord(structuredClone(r)));
  for(const edit of [x=>{x.forecast.candles[0].c*=1.001;},x=>{x.createdAt+=1;},x=>{x.id+='x';},x=>{x.hash='0'.repeat(14);},
    x=>{delete x.origin;},x=>{x.extra=1;},x=>{delete x.hash;},x=>{x.forecast.analogs.reverse();},x=>{x.origin='live ';},
    x=>{delete x.contentHash;},x=>{x.forecast.base*=2;const b={...x};delete b.hash;x.hash=hashOf(b);}]){
    const x=copy();edit(x);assert.equal(verifyRecord(x),false);
  }
  for(const x of [null,undefined,'x',5,[]])assert.equal(verifyRecord(x),false);
});

test('put-if-absent: stored once, identical repeats recognised, a different record never replaces the original',async()=>{
  const store=createForecastStore(memoryBackend()),r=fRec(T),snapshot=JSON.stringify(r);
  assert.deepEqual(await store.putForecast(r),{stored:true});
  // Rebuilt from the same inputs: identical.
  const again=await store.putForecast(fRec(T));
  assert.deepEqual(again,{stored:false,identical:true,existing:r});
  // Same content made at another moment or by another producer (later creation, backfill): identical, and the
  // stored record keeps its own creation time and origin.
  for(const other of [fRec(T,{createdAt:T+2*HOUR}),fRec(T,{origin:'backfill'})]){
    assert.equal(other.id,r.id);assert.notEqual(other.hash,r.hash);
    assert.deepEqual(await store.putForecast(other),{stored:false,identical:true,existing:r});
  }
  // Same id, other numbers: a conflict that keeps the original byte for byte.
  for(const other of [fRec(T,{shift:1}),fRec(T,{shift:1,createdAt:T+2*HOUR})]){
    assert.equal(other.id,r.id);
    const clash=await store.putForecast(other);
    assert.deepEqual(Object.keys(clash).sort(),['conflict','existing','stored']);
    assert.equal(clash.stored,false);assert.equal(clash.conflict,true);assert.equal(JSON.stringify(clash.existing),snapshot);
  }
  const stored=await store.get(r.id);
  assert.equal(JSON.stringify(stored),snapshot);assert.ok(verifyRecord(stored));
  assert.ok(Object.isFrozen(stored)&&Object.isFrozen(stored.forecast.candles[2]));
  assert.throws(()=>{stored.forecast.base=1;},TypeError);
  assert.equal(await store.get('f|nobody'),null);
  // Signals follow the same rule.
  const s=sRec(T);
  assert.deepEqual(await store.putSignal(s),{stored:true});
  assert.deepEqual(await store.putSignal(sRec(T,{recordedAt:T+9*HOUR})),{stored:false,identical:true,existing:s});
  assert.equal((await store.putSignal(sRec(T,{side:'short'}))).conflict,true);
  assert.deepEqual(await store.get(s.id),s);
});

test('the store accepts only sealed records of the right kind',async()=>{
  const store=createForecastStore(memoryBackend());
  await assert.rejects(store.putForecast(sRec(T)),{message:'Ogiltig prognospost'});
  await assert.rejects(store.putSignal(fRec(T)),{message:'Ogiltig signalpost'});
  // Edited after sealing: refused before it reaches storage.
  const forged=JSON.parse(JSON.stringify(fRec(T)));forged.forecast.base=1;
  await assert.rejects(store.putForecast(forged),{message:'Ogiltig prognospost'});
  await assert.rejects(store.putForecast(null),{message:'Ogiltig prognospost'});
  assert.deepEqual((await store.listForecasts('u1','BTC','1h')).records,[]);
  assert.throws(()=>createForecastStore({}),{message:'Ogiltig lagring för prognoser'});
  assert.throws(()=>createForecastStore(null),{message:'Ogiltig lagring för prognoser'});
});

test('lists are per series and sorted: forecasts by cutoff then creation, signals by bar time',async()=>{
  const store=createForecastStore(memoryBackend());
  const v2=forecastRecord('u1','BTC','1h',{...forecast(T),model:'af-forecast-v2'},{createdAt:T+HOUR,origin:'backfill',tfMs:HOUR});
  for(const r of [fRec(T+2*HOUR),fRec(T),v2,fRec(T+HOUR),fRec(T,{uid:'u2'}),fRec(T,{symbol:'ETH'}),fRec(T,{tf:'4h'})])
    assert.deepEqual(await store.putForecast(r),{stored:true});
  for(const t of [T+5*HOUR,T,T+3*HOUR])await store.putSignal(sRec(t));
  await store.putSignal(sRec(T,{symbol:'SOL'}));
  const f=await store.listForecasts('u1','BTC','1h');
  assert.deepEqual(f.records.map(r=>[r.cutoff-T,r.model]),[[0,'af-forecast-v2'],[0,MODEL.forecast],[HOUR,MODEL.forecast],[2*HOUR,MODEL.forecast]]);
  assert.deepEqual(f.corrupt,[]);
  assert.ok(f.records.every(r=>Object.isFrozen(r)&&verifyRecord(r)));
  assert.deepEqual((await store.listSignals('u1','BTC','1h')).records.map(r=>r.barTime-T),[0,3*HOUR,5*HOUR]);
  assert.equal((await store.listForecasts('u2','BTC','1h')).records.length,1);
  assert.equal((await store.listForecasts('u1','ETH','1h')).records.length,1);
  assert.equal((await store.listForecasts('u1','BTC','4h')).records[0].cutoffClose,T+4*HOUR);
  assert.deepEqual(await store.listSignals('u1','BTC','4h'),{records:[],corrupt:[]});
  assert.deepEqual((await store.listSignals('u1','SOL','1h')).records.map(r=>r.symbol),['SOL']);
});

test('a record whose hash no longer matches is listed only as corrupt, unchanged',async()=>{
  const inner=memoryBackend(),good=fRec(T),bad=fRec(T+HOUR);
  await inner.add(good);await inner.add(bad);
  const tampered=JSON.parse(JSON.stringify(bad));tampered.forecast.base*=2;
  const backend={...inner,series:async(...a)=>(await inner.series(...a)).map(r=>r.id===bad.id?tampered:r)};
  const {records,corrupt}=await createForecastStore(backend).listForecasts('u1','BTC','1h');
  assert.deepEqual(records,[good]);
  assert.deepEqual(corrupt,[tampered]);assert.equal(corrupt[0].forecast.base,bad.forecast.base*2);
  assert.ok(Object.isFrozen(corrupt[0].forecast));
});

test('concurrent puts of different content under one id store exactly one, in every backend',async()=>{
  for(const backend of [memoryBackend(),localStorageBackend(memoryStorage()),indexedDbBackend(fakeIndexedDB())]){
    const store=createForecastStore(backend),a=fRec(T),b=fRec(T,{shift:1,createdAt:T+9*HOUR});
    const [first,second]=await Promise.all([store.putForecast(a),store.putForecast(b)]);
    assert.deepEqual(first,{stored:true});
    assert.equal(second.conflict,true);assert.deepEqual(second.existing,a);
    assert.deepEqual(await store.get(a.id),a);
    assert.deepEqual((await store.listForecasts('u1','BTC','1h')).records,[a]);
  }
});

test('localStorage backend: one JSON value per record and an id list per series, readable after a reload',async()=>{
  const storage=memoryStorage();storage.setItem('riptide.krypto.v1','ordinary');storage.setItem('riptide.forecast.v1:u1','account');
  const r=fRec(T),s=sRec(T);
  let store=createForecastStore(localStorageBackend(storage));
  assert.deepEqual(await store.putForecast(r),{stored:true});assert.deepEqual(await store.putSignal(s),{stored:true});
  assert.equal(storage.getItem(PREFIX+':record:'+r.id),JSON.stringify(r));
  assert.deepEqual(JSON.parse(storage.getItem(PREFIX+':series:forecast|u1|BTC|1h')),[r.id]);
  assert.deepEqual(JSON.parse(storage.getItem(PREFIX+':series:signal|u1|BTC|1h')),[s.id]);
  // A new page: another backend over the same storage.
  store=createForecastStore(localStorageBackend(storage));
  assert.deepEqual(await store.listForecasts('u1','BTC','1h'),{records:[r],corrupt:[]});
  assert.deepEqual(await store.get(s.id),s);
  assert.deepEqual(await store.putForecast(fRec(T)),{stored:false,identical:true,existing:r});
  assert.deepEqual(await store.putForecast(fRec(T,{createdAt:T+7*HOUR})),{stored:false,identical:true,existing:r});
  assert.equal((await store.putForecast(fRec(T,{shift:2,createdAt:T+7*HOUR}))).conflict,true);
  assert.equal(storage.getItem(PREFIX+':record:'+r.id),JSON.stringify(r));
  // The other accounts' keys are untouched.
  assert.equal(storage.getItem('riptide.krypto.v1'),'ordinary');assert.equal(storage.getItem('riptide.forecast.v1:u1'),'account');
  // A custom prefix keeps archives apart.
  const other=createForecastStore(localStorageBackend(storage,'test.archive'));
  assert.deepEqual(await other.putForecast(r),{stored:true});assert.equal(storage.getItem('test.archive:record:'+r.id),JSON.stringify(r));
});

test('localStorage backend: edited, unreadable or deleted records are corrupt, and an id is never reused',async()=>{
  const storage=memoryStorage(),store=createForecastStore(localStorageBackend(storage)),[a,b,c,d]=[0,1,2,3].map(i=>fRec(T+i*HOUR));
  for(const r of [a,b,c,d])await store.putForecast(r);
  const key=r=>PREFIX+':record:'+r.id;
  const edited=JSON.parse(storage.getItem(key(a)));edited.forecast.candles[0].c+=1;storage.setItem(key(a),JSON.stringify(edited));
  storage.setItem(key(b),'{not json');
  storage.removeItem(key(c));
  const {records,corrupt}=await store.listForecasts('u1','BTC','1h');
  assert.deepEqual(records,[d]);
  assert.deepEqual(corrupt.map(r=>r.id).sort(),[a.id,b.id,c.id].sort());
  assert.deepEqual(corrupt.find(r=>r.id===a.id),edited);
  assert.equal(corrupt.find(r=>r.id===b.id).unreadable,true);assert.equal(corrupt.find(r=>r.id===c.id).missing,true);
  // The damaged values stay as they are: a put under those ids is refused.
  const res=await store.putForecast(b);assert.equal(res.conflict,true);assert.equal(storage.getItem(key(b)),'{not json');
  assert.equal((await store.putForecast(a)).conflict,true);assert.deepEqual(JSON.parse(storage.getItem(key(a))),edited);
});

test('localStorage backend: a deleted record stays reported as missing and its id cannot be taken by other content',async()=>{
  const storage=memoryStorage(),store=createForecastStore(localStorageBackend(storage)),r=fRec(T),s=sRec(T);
  await store.putForecast(r);await store.putSignal(s);
  storage.removeItem(PREFIX+':record:'+r.id);storage.removeItem(PREFIX+':record:'+s.id);
  for(const [put,other] of [[store.putForecast,fRec(T,{shift:5,origin:'backfill',createdAt:T+9*HOUR})],[store.putForecast,r],[store.putSignal,sRec(T,{recordedAt:T+9*HOUR})]]){
    const res=await put(other);
    assert.equal(res.stored,false);assert.equal(res.conflict,true);assert.equal(res.existing.missing,true);assert.equal(res.existing.id,other.id);
  }
  assert.equal(storage.getItem(PREFIX+':record:'+r.id),null);assert.equal(storage.getItem(PREFIX+':record:'+s.id),null);
  const f=await store.listForecasts('u1','BTC','1h');
  assert.deepEqual(f.records,[]);assert.deepEqual(f.corrupt.map(x=>[x.id,x.missing]),[[r.id,true]]);
  assert.deepEqual((await store.listSignals('u1','BTC','1h')).corrupt.map(x=>[x.id,x.missing]),[[s.id,true]]);
});

test('a sealed record whose id does not match its own fields is refused, and listed as corrupt if a backend holds one',async()=>{
  const reseal=(r,edit)=>{const body=JSON.parse(JSON.stringify(r));delete body.hash;edit(body);body.contentHash=contentHashOf(body);return deepFreeze({...body,hash:hashOf(body)});};
  const a=fRec(T),s=sRec(T);
  // Each verifies (the hash was recomputed) but claims an id that belongs to another record.
  const squatters=[reseal(a,x=>{x.uid='u2';}),reseal(a,x=>{x.cutoff=T+5*HOUR;x.cutoffClose=T+6*HOUR;}),reseal(a,x=>{x.model='af-forecast-v9';}),
    reseal(fRec(T+HOUR),x=>{x.id=a.id;})];
  for(const backend of [memoryBackend(),localStorageBackend(memoryStorage()),indexedDbBackend(fakeIndexedDB())]){
    const store=createForecastStore(backend);
    for(const x of squatters){assert.ok(verifyRecord(x));await assert.rejects(store.putForecast(x),{message:'Ogiltig prognospost'});}
    await assert.rejects(store.putSignal(reseal(s,x=>{x.barTime=T+HOUR;x.confirmedAt=T+2*HOUR;})),{message:'Ogiltig signalpost'});
    // The legitimate records still get their ids.
    assert.deepEqual(await store.putForecast(a),{stored:true});assert.deepEqual(await store.putSignal(s),{stored:true});
  }
  // One written past the store (an older page, a direct write) is not shown as a valid record.
  const inner=memoryBackend(),odd=reseal(fRec(T+2*HOUR),x=>{x.cutoff=T+3*HOUR;});
  await inner.add(a);await inner.add(odd);
  const listed=await createForecastStore(inner).listForecasts('u1','BTC','1h');
  assert.deepEqual(listed.records,[a]);assert.deepEqual(listed.corrupt.map(x=>x.id),[odd.id]);
});

test('localStorage backend: no half-written record after a failed write, a repaired index, and a size limit',async()=>{
  const storage=memoryStorage(),store=createForecastStore(localStorageBackend(storage)),r=fRec(T),setItem=storage.setItem;
  storage.setItem=(k,v)=>{if(k.includes(':series:'))throw Object.assign(Error('quota'),{name:'QuotaExceededError'});setItem.call(storage,k,v);};
  await assert.rejects(store.putForecast(r),{message:'Prognosarkivet kunde inte sparas'});
  assert.equal(storage.getItem(PREFIX+':record:'+r.id),null);
  storage.setItem=setItem;
  assert.deepEqual(await store.putForecast(r),{stored:true});
  // A crash between the record and its index entry: the next put lists it again.
  const sKey=PREFIX+':series:forecast|u1|BTC|1h';
  storage.setItem(sKey,'[]');
  assert.deepEqual((await store.listForecasts('u1','BTC','1h')).records,[]);
  assert.equal((await store.putForecast(r)).identical,true);
  assert.deepEqual((await store.listForecasts('u1','BTC','1h')).records,[r]);
  // An unreadable index is rebuilt from the records.
  storage.setItem(sKey,'garbage');
  assert.deepEqual((await store.listForecasts('u1','BTC','1h')).records,[r]);
  // The archive stops before it can crowd out the other accounts.
  const small=createForecastStore(localStorageBackend(memoryStorage(),undefined,{maxChars:JSON.stringify(r).length+10}));
  assert.deepEqual(await small.putForecast(r),{stored:true});
  await assert.rejects(small.putForecast(fRec(T+HOUR)),{message:'Prognosarkivet är fullt'});
  assert.throws(()=>localStorageBackend({}),{message:'Ogiltig lagring för prognoser'});
});

test('IndexedDB backend: one store and series index, add() as put-if-absent, reads and series lists',async()=>{
  const idb=fakeIndexedDB(),store=createForecastStore(indexedDbBackend(idb)),a=fRec(T),b=fRec(T+HOUR),s=sRec(T);
  assert.deepEqual(await store.putForecast(b),{stored:true});assert.deepEqual(await store.putForecast(a),{stored:true});
  assert.deepEqual(await store.putSignal(s),{stored:true});
  assert.deepEqual(idb.log.filter(x=>x.startsWith('create')),['createObjectStore:records:id','createIndex:series:kind,uid,symbol,tf']);
  assert.deepEqual(await store.listForecasts('u1','BTC','1h'),{records:[a,b],corrupt:[]});
  assert.deepEqual((await store.listSignals('u1','BTC','1h')).records,[s]);
  assert.deepEqual(await store.get(a.id),a);assert.equal(await store.get('nope'),null);
  assert.ok(Object.isFrozen(await store.get(a.id)));
  // Another page: the database persists and is not upgraded again. A ConstraintError
  // returns the stored record without aborting (a rejected add would throw here).
  const again=createForecastStore(indexedDbBackend(idb));
  const clash=await again.putForecast(fRec(T,{shift:3,createdAt:T+5*HOUR}));
  assert.equal(clash.conflict,true);assert.deepEqual(clash.existing,a);
  assert.deepEqual(await again.putForecast(fRec(T,{createdAt:T+5*HOUR})),{stored:false,identical:true,existing:a});
  assert.deepEqual(await again.putForecast(a),{stored:false,identical:true,existing:a});
  assert.equal(idb.log.filter(x=>x.startsWith('create')).length,2);
  assert.equal(idb.databases.get('riptide-forecast').stores.get('records').rows.size,3);
  // Tampered inside the database: corrupt.
  idb.databases.get('riptide-forecast').stores.get('records').rows.get(b.id).origin='backfill';
  const listed=await again.listForecasts('u1','BTC','1h');
  assert.deepEqual(listed.records,[a]);assert.deepEqual(listed.corrupt.map(r=>r.id),[b.id]);
});

test('IndexedDB backend: other write errors abort and reject in Swedish; a database that will not open says so',async()=>{
  const full=fakeIndexedDB({failAdd:'QuotaExceededError'}),store=createForecastStore(indexedDbBackend(full));
  await assert.rejects(store.putForecast(fRec(T)),{message:'Prognosarkivet kunde inte sparas'});
  assert.equal(full.databases.get('riptide-forecast').stores.get('records').rows.size,0);
  const closed=indexedDbBackend(fakeIndexedDB({failOpen:true}));
  await assert.rejects(closed.get('x'),{message:'Prognosarkivet kunde inte öppnas'});
  await assert.rejects(closed.series('forecast','u1','BTC','1h'),{message:'Prognosarkivet kunde inte öppnas'});
  assert.throws(()=>indexedDbBackend(null),{message:'Ogiltig lagring för prognoser'});
});

test('defaultBackend prefers IndexedDB, then localStorage, then memory',async()=>{
  const idb=fakeIndexedDB(),storage=memoryStorage(),r=fRec(T);
  assert.deepEqual(await createForecastStore(defaultBackend({indexedDB:idb,localStorage:storage})).putForecast(r),{stored:true});
  assert.equal(storage.length,0);assert.equal(idb.databases.get('riptide-forecast').stores.get('records').rows.size,1);
  // indexedDB exists but refuses to open (some private modes): localStorage for this visit.
  const viaLocal=createForecastStore(defaultBackend({indexedDB:fakeIndexedDB({failOpen:true}),localStorage:storage}));
  assert.deepEqual(await viaLocal.putForecast(r),{stored:true});
  assert.equal(storage.getItem(PREFIX+':record:'+r.id),JSON.stringify(r));
  assert.deepEqual((await createForecastStore(defaultBackend({localStorage:storage})).listForecasts('u1','BTC','1h')).records,[r]);
  // Storage that throws on access (blocked site data): memory.
  const blocked={get localStorage(){throw Error('SecurityError');},get indexedDB(){throw Error('SecurityError');}};
  const memory=createForecastStore(defaultBackend(blocked));
  assert.deepEqual(await memory.putForecast(r),{stored:true});
  assert.equal((await memory.putForecast(r)).identical,true);
  assert.deepEqual((await createForecastStore(defaultBackend({})).listForecasts('u1','BTC','1h')).records,[]);
});

test('a bounded list pages a series newest first, the same in every backend, and the call without options is unchanged',async()=>{
  // Stored out of order, with a cutoff whose id sorts before the others as text (9 digits) and a second model.
  const cutoffs=[5,1,9,3,7,2,8,4,6,0].map(i=>T+i*HOUR),early=forecastRecord('u1','BTC','1h',forecast(999999999),{createdAt:1e9,origin:'backfill',tfMs:HOUR});
  const v2=forecastRecord('u1','BTC','1h',{...forecast(T+9*HOUR),model:'af-forecast-v2'},{createdAt:T+11*HOUR,origin:'live',tfMs:HOUR});
  const all=[...cutoffs.map(c=>fRec(c)),early,v2];
  for(const backend of [memoryBackend(),localStorageBackend(memoryStorage()),indexedDbBackend(fakeIndexedDB())]){
    const store=createForecastStore(backend);
    for(const r of all)assert.deepEqual(await store.putForecast(r),{stored:true});
    // Other series stay out of every page and every count.
    await store.putForecast(fRec(T,{uid:'u2'}));await store.putForecast(fRec(T,{symbol:'ETH'}));await store.putSignal(sRec(T));
    const whole=await store.listForecasts('u1','BTC','1h');
    assert.deepEqual(Object.keys(whole),['records','corrupt']);
    assert.equal(whole.records.length,12);assert.equal(whole.records[0].id,early.id);
    // Newest 5, ascending like the whole list, then older pages through the cursor.
    let page=await store.listForecasts('u1','BTC','1h',{limit:5});
    assert.deepEqual(page.records,whole.records.slice(-5));
    assert.deepEqual([page.corrupt,page.total,page.older,page.next],[[],12,7,whole.records.at(-5).id]);
    const seen=[...page.records];
    while(page.next){page=await store.listForecasts('u1','BTC','1h',{limit:5,before:page.next});seen.unshift(...page.records);}
    assert.deepEqual(seen,whole.records);
    assert.deepEqual([page.records.length,page.total,page.older,page.next],[2,12,0,null]);
    assert.ok(Object.isFrozen(seen[0])&&Object.isFrozen(seen[0].forecast.candles[0]));
    // A page larger than what is left, no limit at all, an empty series, and signals the same way.
    assert.deepEqual((await store.listForecasts('u1','BTC','1h',{limit:50})).records,whole.records);
    assert.deepEqual((await store.listForecasts('u1','BTC','1h',{before:whole.records[3].id})).records,whole.records.slice(0,3));
    assert.deepEqual(await store.listForecasts('u1','SOL','1h',{limit:5}),{records:[],corrupt:[],total:0,older:0,next:null});
    const signals=await store.listSignals('u1','BTC','1h',{limit:1});
    assert.deepEqual([signals.records.map(r=>r.id),signals.total,signals.older,signals.next],[[sRec(T).id],1,0,null]);
    // What cannot be a page is refused in Swedish.
    for(const bad of [{limit:0},{limit:2.5},{limit:-1},{limit:'5'},{before:'f|u2|BTC|1h|1|x'},{before:5},{before:'nonsens'}])
      await assert.rejects(store.listForecasts('u1','BTC','1h',bad),{message:/^Ogiltig/},JSON.stringify(bad));
  }
});

test('a bounded list reads and checks only the records of its page',async()=>{
  const n=60,records=Array.from({length:n},(_,i)=>fRec(T+i*HOUR));
  // IndexedDB: the series index gives ids only; the page's records are read one by one.
  const idb=fakeIndexedDB(),store=createForecastStore(indexedDbBackend(idb));
  for(const r of records.slice(0,12))await store.putForecast(r);
  idb.reads.get=idb.reads.getAll=idb.reads.getAllKeys=0;
  const page=await store.listForecasts('u1','BTC','1h',{limit:5});
  assert.deepEqual(page.records,records.slice(7,12));
  assert.deepEqual(idb.reads,{get:5,getAll:0,getAllKeys:12});
  // localStorage: the id list and the page's values are read, no other record.
  const storage=memoryStorage(),get=storage.getItem,asked=[];
  storage.getItem=k=>{asked.push(k);return get.call(storage,k);};
  const local=createForecastStore(localStorageBackend(storage));
  for(const r of records)await local.putForecast(r);
  asked.length=0;
  assert.deepEqual((await local.listForecasts('u1','BTC','1h',{limit:5})).records,records.slice(-5));
  assert.deepEqual(asked.filter(k=>k.includes(':record:')).sort(),records.slice(-5).map(r=>PREFIX+':record:'+r.id).sort());
  // A damaged record inside the page is reported as corrupt, one outside it is not read at all.
  const edited=JSON.parse(get.call(storage,PREFIX+':record:'+records[n-2].id));edited.forecast.base+=1;
  storage.setItem(PREFIX+':record:'+records[n-2].id,JSON.stringify(edited));
  storage.removeItem(PREFIX+':record:'+records[n-3].id);storage.setItem(PREFIX+':record:'+records[0].id,'{trasig');
  const damaged=await local.listForecasts('u1','BTC','1h',{limit:3});
  assert.deepEqual(damaged.records,[records[n-1]]);
  assert.deepEqual(damaged.corrupt.map(r=>[r.id,!!r.missing]).sort(),[[records[n-3].id,true],[records[n-2].id,false]].sort());
  assert.deepEqual([damaged.total,damaged.older,damaged.next],[n,n-3,records[n-3].id]);
  // A backend with only add/get/series is read whole, and still only the page is checked and returned.
  const inner=memoryBackend(),plain={add:r=>inner.add(r),get:id=>inner.get(id),series:(...a)=>inner.series(...a)},few=createForecastStore(plain);
  for(const r of records.slice(0,8))await few.putForecast(r);
  assert.deepEqual(await few.listForecasts('u1','BTC','1h',{limit:3}),{records:records.slice(5,8),corrupt:[],total:8,older:5,next:records[5].id});
});

test('backends say where records are kept: kind and a Swedish note, frozen, also through the store',async()=>{
  const local=localStorageBackend(memoryStorage()),memory=memoryBackend(),idb=indexedDbBackend(fakeIndexedDB());
  assert.deepEqual([local.kind,local.note],['localStorage','Signaler och prognoser sparas i webbläsarens lokala lagring, som rymmer högst 1,5 miljoner tecken.']);
  assert.deepEqual([memory.kind,memory.note],['memory','Signaler och prognoser sparas bara under det här besöket.']);
  assert.deepEqual([idb.kind,idb.note],['indexedDB','']);
  for(const b of [local,memory,idb]){assert.ok(Object.isFrozen(b));assert.throws(()=>{b.kind='x';},TypeError);}
  assert.deepEqual(await createForecastStore(local).info(),{kind:'localStorage',note:local.note});
  assert.ok(Object.isFrozen(await createForecastStore(memory).info()));
  // A backend that says nothing about itself.
  const inner=memoryBackend(),plain={add:inner.add,get:inner.get,series:inner.series};
  assert.deepEqual(await createForecastStore(plain).info(),{kind:'custom',note:''});
  // A full archive throws an error the runner can tell apart.
  const small=createForecastStore(localStorageBackend(memoryStorage(),undefined,{maxChars:10}));
  await assert.rejects(small.putForecast(fRec(T)),{message:'Prognosarkivet är fullt',code:'archive-full'});
});

test('defaultBackend says which backend it chose and why, also when IndexedDB fails to open and localStorage is blocked',async()=>{
  const blocked={get(){throw Object.assign(Error('The operation is insecure.'),{name:'SecurityError'});}};
  const env=(idb,local)=>Object.defineProperties({},{indexedDB:idb,localStorage:local});
  const LOCAL='signaler och prognoser sparas i webbläsarens lokala lagring, som rymmer högst 1,5 miljoner tecken.';
  const VISIT='signaler och prognoser sparas bara under det här besöket.';
  const cases=[
    [{value:fakeIndexedDB()},{value:memoryStorage()},'indexedDB',''],
    [{value:fakeIndexedDB({failOpen:true})},{value:memoryStorage()},'localStorage','IndexedDB kunde inte öppnas, så '+LOCAL],
    [{value:fakeIndexedDB({failOpen:true})},blocked,'memory','IndexedDB kunde inte öppnas och den lokala lagringen är blockerad, så '+VISIT],
    [{value:fakeIndexedDB({failOpen:true})},{value:undefined},'memory','IndexedDB kunde inte öppnas och lokal lagring saknas, så '+VISIT],
    [{value:undefined},{value:memoryStorage()},'localStorage','IndexedDB saknas i webbläsaren, så '+LOCAL],
    [blocked,{value:memoryStorage()},'localStorage','IndexedDB är blockerad, så '+LOCAL],
    [{value:undefined},blocked,'memory','IndexedDB saknas i webbläsaren och den lokala lagringen är blockerad, så '+VISIT],
    [blocked,blocked,'memory','Webbläsarens lagring är blockerad, så '+VISIT],
    [{value:undefined},{value:undefined},'memory','IndexedDB saknas i webbläsaren och lokal lagring saknas, så '+VISIT]];
  for(const [idb,local,kind,note] of cases){
    const backend=defaultBackend(env(idb,local)),store=createForecastStore(backend),probe=!!idb.value;
    // With IndexedDB to try, nothing is known until it has answered once.
    assert.deepEqual([backend.kind,backend.note],probe?['pending','']:[kind,note],kind+' before');
    assert.deepEqual(await store.info(),{kind,note});
    assert.deepEqual([backend.kind,backend.note],[kind,note],kind+' after');
    assert.ok(Object.isFrozen(backend));assert.throws(()=>{backend.kind='indexedDB';},TypeError);
    if(probe)assert.deepEqual(await backend.ready(),{kind,note});
    // The chosen backend keeps records, pages included.
    const r=fRec(T),s=sRec(T);
    assert.deepEqual(await store.putForecast(r),{stored:true});assert.deepEqual(await store.putSignal(s),{stored:true});
    assert.deepEqual(await store.listForecasts('u1','BTC','1h',{limit:1}),{records:[r],corrupt:[],total:1,older:0,next:null});
    assert.deepEqual((await store.listSignals('u1','BTC','1h')).records,[s]);
  }
});
