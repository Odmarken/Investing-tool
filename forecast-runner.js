// Background demo trading for the AI Forecast account, page-wide, while the
// crypto page is open and someone is logged in. tick() (every few seconds)
// guards open positions on live quotes and replays one position's funding and
// 5-minute history per tick, in turns. When Bybit's own clock says a candle of
// the account's timeframe has closed, it evaluates every closed candle since
// the last decision, stores each signal once and acts only on a fresh one: a
// position on the other side closes at market, then a new one opens. Data that
// is not live pauses new entries with a visible reason; exits keep working.
// Every change is read, applied and written inside the account's tab lock
// before it is shown. Demo only: public market data, no orders.
import {TF,SYMBOLS,SIGNAL_PARAMS} from './forecast-config.js';
import {requiredLookback,computeIndicators,aggregateClosed,evaluateBar,signalsInRange} from './forecast-model.js';
import {ACCOUNT,accountKey,newForecastAccount,readForecastAccount,updateSettings as withSettings,setPaused as withPaused,markProcessed,
  openPosition,settlePosition,checkQuote,closePosition as closeAt,accountLive,tradeReasons} from './forecast-account.js';
import {signalRecord,createForecastStore,defaultBackend,deepFreeze,ARCHIVE_FULL} from './forecast-store.js';
import {fetchKlines,splitForming,dataStatus,fetchPositionRisk} from './forecast-market.js';
import {fetchMomentumQuotes} from './crypto-momentum-live.js';
import {createContractCache,LIMIT_TTL} from './bybit-contracts.js';

// interval: how often the page calls tick(); retry/maxRetry: backoff after a failed or unreliable read,
// short enough that recovered data still meets a signal inside its 30-minute window; grace: how long
// Bybit may lack the candle of a 5-minute step that has just begun before that counts as a problem.
// timeout: how long one awaited read may take. read: one Bybit request (the page's grab gives up on its
// proxies within about 23 s, unless a response body stalls); quote: a ticker (its own budget ends within
// 8.5 s), short enough that the other coins' quotes are still fresh when a hung one gives up; archive: one
// call to the record archive.
export const RUNNER=Object.freeze({interval:5000,klines:1000,retry:15000,maxRetry:60000,notes:10,grace:15000,
  timeout:Object.freeze({read:30000,quote:10000,archive:10000})});
const STEP=ACCOUNT.step,MIN=60000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const LATE='Bybit svarade inte i tid',ARCHIVE_LATE='Prognosarkivet svarar inte';
const FULL='Prognosarkivet är fullt: nya signaler kan inte sparas och nya affärer är pausade';
// A read that never settles (a stalled response body has no deadline in the page's grab) would hold the
// tick, and through it every later tick and its protection checks. Only the race awaits the read, so an
// answer that comes after the deadline is dropped and can never be acted on.
function within(promise,ms,text){
  let timer;
  const late=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(text)),ms);});
  return Promise.race([promise,late]).finally(()=>clearTimeout(timer));
}
// Browser errors arrive in English ('Failed to fetch', an aborted request, a proxy's HTML page read as
// JSON, blocked or full storage); the status line speaks Swedish.
function reasonOf(e){
  const name=e?.name,text=String(e?.message??e??'');
  if(name==='AbortError'||name==='TimeoutError')return 'Bybit svarade inte i tid via proxyn';
  if(name==='TypeError'&&/^(failed to fetch|fetch failed|networkerror|load failed)/i.test(text))return 'Bybit kunde inte nås via proxyn';
  if(name==='SyntaxError')return 'Proxyn gav ett oläsligt svar från Bybit';
  if(name==='SecurityError')return 'Webbläsarens lagring är blockerad';
  if(name==='QuotaExceededError')return 'Webbläsarens lagring är full';
  return text||'okänt fel';
}
const fresh=(q,now)=>!!q&&q.price>0&&q.mark>0&&finite(q.at)&&q.at<=now+5000&&now-q.at<=ACCOUNT.quoteTtl;
const usable=(c,now)=>!!c&&finite(c.at)&&now-c.at<=LIMIT_TTL&&c.at<=now+5000;
// settlePosition replays every 5-minute candle up to the one the clock is in, and, until a position's first full
// 5-minute candle is settled, the closed 1-minute candles of the step it opened in. The newest such candle is
// missing when its period began during the read, or for a moment after, until Bybit publishes it.
// → {state:'ok'|'soon'|'behind', late: what is missing, in Swedish}
function coverage(risk,p,t){
  const s=Math.floor(t/STEP)*STEP,last=Math.min(risk.markBars.at(-1)?.t??-Infinity,p.nextBar>s?Infinity:risk.lastBars.at(-1)?.t??-Infinity);
  if(last<s)return {state:last===s-STEP&&t-s<=RUNNER.grace?'soon':'behind',late:'Bybits senaste 5-minuterspriser saknas ännu'};
  const first=(Math.floor(p.openedAt/STEP)+1)*STEP,start=Math.ceil(p.openedAt/MIN)*MIN,need=Math.min(first,Math.floor(t/MIN)*MIN)-MIN;
  const have=Math.min(risk.minuteMarks?.at(-1)?.t??-Infinity,risk.minuteLasts?.at(-1)?.t??-Infinity);
  if(p.nextBar!==first||need<start||have>=need)return {state:'ok',late:''};
  // Only the newest closed minute is missing (the first one replayed has no minute before it): Bybit may publish it in a moment.
  return {state:Math.max(have,start-MIN)===need-MIN&&t-(need+MIN)<=RUNNER.grace?'soon':'behind',late:'Bybits senaste 1-minuterspriser saknas ännu'};
}
const holds=(a,id)=>a.positions.some(p=>p.id===id);
const unsettled=(p,why)=>'Tidsstoppet för '+p.symbol+' är inte avräknat'+(why?' — '+why:'');
const money=x=>(x<0?'−':'+')+Math.abs(x).toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const priceText=x=>x.toLocaleString('sv-SE',{maximumSignificantDigits:6});
const SIDE=Object.freeze({long:'lång',short:'kort'});
// Read on every call: some private modes throw on localStorage access, which then shows as a status.
const local=()=>{
  let s;
  try{s=globalThis.localStorage;}catch{throw Error('Webbläsarens lagring är blockerad — AI Forecast-kontot kan inte sparas');}
  if(!s)throw Error('Webbläsarens lagring saknas');
  return s;
};
const pageStorage=Object.freeze({getItem:k=>local().getItem(k),setItem:(k,v)=>local().setItem(k,v)});
// Candle times in Swedish time; a daily account's next decision is another day.
function when(t,tf){
  const o={timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'};
  return new Date(t).toLocaleString('sv-SE',tf==='1d'?{...o,day:'numeric',month:'short'}:o);
}
function closeText(t){
  if(!t)return 'Positionen är stängd';
  const what=SIDE[t.side]+' '+t.symbol;
  if(t.reason==='manuell')return 'Stängde '+what+' till '+priceText(t.exit)+' · '+money(t.pnl);
  if(t.reason==='likvidation')return what+' likviderades innan stängningen hann gå igenom · '+money(t.pnl);
  return tradeReasons[t.reason]+' hann före den manuella stängningen: '+what+' '+money(t.pnl);
}

/**
 * createForecastRunner({grab,storage,store,locks,now,getUser,isActive,contracts,onChange,timeouts}) →
 *   {tick(), account(), live(), status(), evaluations(), quotes(), closePosition(id), updateSettings(patch), setPaused(bool), reset()}
 * grab: the page's proxy fetch for public Bybit market endpoints. storage: localStorage-like.
 * store: createForecastStore(...) (default: IndexedDB, else localStorage, else memory).
 * locks: navigator.locks-like {request(name,fn)}. contracts: {get(symbol),load(symbol)} like createContractCache.
 * timeouts: {read,quote,archive} in ms, each optional (defaults RUNNER.timeout); a read past its time fails
 *   with 'Bybit svarade inte i tid' (an archive call with 'Prognosarkivet svarar inte').
 * tick() never throws; problems become status().text. status(): {state:'signed-out'|'loading'|'error'|'inactive'|
 *   'waiting'|'paused'|'unreliable'|'trading', text (Swedish), paused, open, maxOpen, tf, nextDecision (Bybit time of
 *   the next candle close), data:{[symbol]:dataStatus at the last read}, unreliable:[symbol], waiting:{[symbol]:reason},
 *   protection (failed price reads this tick, and failed protection checks until their position settles), error,
 *   archiveFull (the archive refused the last new signal for lack of room: state 'waiting' and a text saying so),
 *   notes:[integrity and storage warnings], last (latest decision), busy, at}.
 * closePosition(id) resolves {ok,text,trade}; updateSettings/setPaused/reset resolve the new account or reject in Swedish.
 */
export function createForecastRunner({grab,storage=pageStorage,store=null,locks=globalThis.navigator?.locks,now=()=>Date.now(),
  getUser=()=>null,isActive=()=>true,contracts=null,onChange=null,timeouts=null}={}){
  if(typeof grab!=='function')throw Error('AI Forecast saknar anslutning till Bybit');
  if(!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function')throw Error('AI Forecast saknar lagring');
  const wait=Object.fromEntries(Object.entries(RUNNER.timeout).map(([k,ms])=>[k,finite(timeouts?.[k])&&timeouts[k]>0?timeouts[k]:ms]));
  // Every Bybit request of the runner, a synchronous throw included, settles within wait.read.
  const read=(url,options)=>within(new Promise(resolve=>resolve(grab(url,options))),wait.read,LATE);
  const ticker=symbol=>within(fetchMomentumQuotes(read,[symbol],now),wait.quote,LATE).then(q=>q[symbol]);
  // contracts: the page's shared cache, which reads through the page's grab. A stalled answer there never settles,
  // and its pending read then holds that coin's limits until a reload. A load that does not settle in time falls back,
  // for that coin and until the shared read settles, to the runner's own cache on its bounded reads; the shared
  // cache itself is left as it is for its other users.
  const own=createContractCache(read,now),shared=contracts??null,stuck=new Set();
  async function limitsOf(symbol){
    if(shared&&!stuck.has(symbol)){
      const task=Promise.resolve().then(()=>shared.load(symbol));
      try{return await within(task,wait.read,LATE);}
      catch(e){
        if(e?.message!==LATE)throw e;
        stuck.add(symbol);task.then(()=>stuck.delete(symbol),()=>stuck.delete(symbol));
      }
    }
    return within(own.load(symbol),wait.read,LATE);
  }
  let records=store;
  const archive=()=>records??=createForecastStore(defaultBackend(globalThis));
  let uid=null,acct=null,generation=0,running=null,epoch=null;
  let quotes={},evals={},data={},waiting={},gate={},fails={},tried={},trouble={},skew=0,error='',protection='',notes=[],last=null,full=false;
  const who=()=>{const u=getUser();return u?String(u):null;};
  const stale=(user,token)=>who()!==user||token!==generation;
  function switchUser(user){
    uid=user;acct=null;generation++;epoch=null;
    quotes={};evals={};data={};waiting={};gate={};fails={};tried={};trouble={};skew=0;error='';protection='';notes=[];last=null;full=false;
  }
  // Follows the logged-in user and shows a saved account before the first tick; only a tick creates one.
  function sync(){
    const user=who();
    if(user!==uid)switchUser(user);
    if(uid&&!acct)try{if(storage.getItem(accountKey(uid))!==null)acct=deepFreeze(readForecastAccount(storage,accountKey(uid),now()));}catch(e){error=reasonOf(e);}
    return uid;
  }
  function notify(){if(typeof onChange==='function')try{onChange(status());}catch{/* the page's problem, not the runner's */}}
  const note=message=>{notes=[...notes.filter(x=>x!==message),message].slice(-RUNNER.notes);};
  function accept(symbol,q){
    if(q&&q.price>0&&q.mark>0&&finite(q.at)&&!(quotes[symbol]?.at>q.at))quotes={...quotes,[symbol]:Object.freeze({price:q.price,mark:q.mark,at:q.at})};
  }
  function retry(symbol){
    fails[symbol]=(fails[symbol]??0)+1;
    gate[symbol]=now()+Math.min(RUNNER.maxRetry,RUNNER.retry*2**(fails[symbol]-1));
  }
  // A wait ends once its candle is decided, here or in another tab, or once the coin is neither traded nor held.
  function prune(){
    const keep=([s,w])=>!(acct.processed[s]>=w.t)&&(acct.settings.symbols.includes(s)||acct.positions.some(p=>p.symbol===s));
    const list=Object.entries(waiting);
    if(!list.every(keep))waiting=Object.fromEntries(list.filter(keep));
  }
  // An open position's funding and 5-minute history, read once more when a 5-minute step (or a funding
  // time, which is one) began during the read and the read failed or left the new candle out. Last prices
  // start where the mark prices do, at the last settlement's step: a just-opened position's first step
  // can be one Bybit has not published yet, and that is no gap.
  async function riskOf(p){
    const from={...p,nextBar:Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP)},step=Math.floor(now()/STEP);
    try{
      const risk=await fetchPositionRisk(read,p.symbol,from,now);
      if(Math.floor(now()/STEP)===step||coverage(risk,p,now()).state==='ok')return risk;
    }catch(e){if(Math.floor(now()/STEP)===step)throw e;}
    return fetchPositionRisk(read,p.symbol,from,now);
  }

  const exclusive=(user,fn)=>locks&&typeof locks.request==='function'?locks.request(accountKey(user),()=>fn()):
    Promise.reject(Error('AI Forecast kräver en webbläsare med stöd för säkra fliklås'));
  // Read, change and write inside the account's lock, so no two tabs act on the same
  // stale copy; the write lands before anything is shown. change returns the next account or null.
  function commit(user,token,change){
    return exclusive(user,()=>{
      if(stale(user,token))return null;
      const key=accountKey(user);
      let raw=storage.getItem(key);
      if(raw===null){raw=JSON.stringify(newForecastAccount(now()));storage.setItem(key,raw);}
      let current;
      try{current=readForecastAccount(storage,key,now());}catch(e){acct=null;throw e;}
      const next=change?change(current):null;
      if(next){const json=JSON.stringify(next);if(json!==raw)storage.setItem(key,json);}
      return acct=deepFreeze(next??current);
    });
  }

  function tick(){
    if(running)return running;
    running=(async()=>{
      try{await step();}catch(e){error=reasonOf(e);}
      finally{running=null;}
      notify();
      return status();
    })();
    return running;
  }
  async function step(){
    const user=who();
    if(user!==uid)switchUser(user);
    if(!user||!isActive())return;
    const token=generation;
    await commit(user,token,null);
    if(stale(user,token)||!acct)return;
    error='';
    // Retry times and waits belong to one account and timeframe; another tab may have reset it or changed the timeframe.
    const key=acct.createdAt+'|'+acct.settings.tf;
    if(key!==epoch){epoch=key;gate={};fails={};waiting={};}
    prune();
    await protect(user,token);
    // Logged out or switched user meanwhile: nothing of this tick belongs to the new state.
    if(stale(user,token)||!acct)return;
    const tf=acct.settings.tf;
    // Bybit's coin order, as in the backtest, decides who gets the last free slot.
    for(const symbol of SYMBOLS){
      if(stale(user,token)||!acct||acct.settings.tf!==tf)return;
      if((acct.settings.symbols.includes(symbol)||acct.positions.some(p=>p.symbol===symbol))&&due(symbol,tf))await decide(user,token,symbol,tf);
    }
  }

  // Quotes for every held coin, then funding and the 5-minute history for one position, then the stop,
  // target and liquidation check on the quotes. The turn goes to the position settled or tried longest ago,
  // so one whose history keeps failing cannot hold up the others; its reason shows until it settles.
  async function protect(user,token){
    const positions=acct.positions;
    if(!positions.length){protection='';tried={};trouble={};return;}
    const problems=[],symbols=[...new Set(positions.map(p=>p.symbol))];
    const got=await Promise.allSettled(symbols.map(ticker));
    got.forEach((r,k)=>{if(r.status==='fulfilled')accept(symbols[k],r.value);else problems.push('pris för '+symbols[k]+': '+reasonOf(r.reason));});
    const turn=x=>Math.max(x.fundingThrough,tried[x.id]??-Infinity);
    const p=[...positions].sort((x,y)=>turn(x)-turn(y)||SYMBOLS.indexOf(x.symbol)-SYMBOLS.indexOf(y.symbol))[0];
    tried={...tried,[p.id]:now()};
    let risk=null,why='',soon=false;
    try{risk=await riskOf(p);accept(p.symbol,risk);}catch(e){why=reasonOf(e);}
    if(stale(user,token))return;
    await commit(user,token,current=>{
      let next=current;const t=now(),pos=current.positions.find(x=>x.id===p.id);
      // Another tab settled it after this fetch: its newer state stands until the next turn.
      if(risk&&pos&&pos.fundingThrough<=risk.fundingThrough){
        // Bybit has not published the candle of a step that just began: the same position goes first next tick.
        if(coverage(risk,pos,t).state==='soon')soon=true;
        else try{next=settlePosition(next,p.id,risk,t);}catch(e){why=reasonOf(e);}
      }
      for(const x of next.positions)if(fresh(quotes[x.symbol],t))next=checkQuote(next,x.id,quotes[x.symbol],t);
      return next;
    });
    if(stale(user,token))return;
    if(soon){const rest={...tried};delete rest[p.id];tried=rest;}
    if(why)trouble={...trouble,[p.id]:Object.freeze({symbol:p.symbol,why,at:now()})};
    // A failure stands until the position settles, here or in another tab, or closes.
    const held=new Map(acct.positions.map(x=>[x.id,x]));
    trouble=Object.fromEntries(Object.entries(trouble).filter(([id,x])=>held.get(id)?.fundingThrough<x.at));
    tried=Object.fromEntries(Object.entries(tried).filter(([id])=>held.has(id)));
    protection=[...problems,...Object.values(trouble).map(x=>'skyddskontroll för '+x.symbol+': '+x.why)].join(' · ');
  }

  // A decision is due when Bybit's clock (ours plus the skew of its last answer) has
  // closed a candle after the last decision, or nothing is known yet for this timeframe.
  function due(symbol,tf){
    const t=now();
    if(t<(gate[symbol]??-Infinity))return false;
    const done=acct.processed[symbol],ev=evals[symbol];
    if(!finite(done)||ev?.tf!==tf||ev.t<done)return true;
    const ms=TF[tf].ms;
    return Math.floor((t+skew)/ms)*ms-ms>done;
  }
  function remember(symbol,tf,evaluation,st,sig){
    evals={...evals,[symbol]:Object.freeze({symbol,tf,t:evaluation.t,evaluation,data:st,record:sig?.record??null,store:sig?.state??null,at:now()})};
  }
  // A time stop has passed once Bybit's clock reaches it: a computer clock behind Bybit's makes the decision
  // before its own clock gets there, and settling has to wait for our clock to pass it.
  const ended=(p,t)=>p.deadline<=t+Math.max(0,skew);
  // Settles every position whose time stop has passed with the history read for it: settlePosition books
  // the time stop at the deadline candle's open, or an earlier liquidation, stop or target. The first one
  // that cannot settle yet names why, and the entry waits for a new read rather than being refused.
  function settleEnded(a,ends,t){
    let next=a;
    for(const x of a.positions.filter(x=>ended(x,t))){
      const r=ends.get(x.id),c=r?coverage(r,x,t):null,why=x.deadline>t?'datorns klocka går efter Bybits':!r?'':x.fundingThrough>r.fundingThrough?'positionen ändrades under tiden':
        c.state!=='ok'?c.late:null;
      if(why!==null)return [next,unsettled(x,why)];
      try{next=settlePosition(next,x.id,r,t);}catch(e){return [next,unsettled(x,reasonOf(e))];}
      if(holds(next,x.id))return [next,unsettled(x,'')];
    }
    return [next,''];
  }
  async function decide(user,token,symbol,tf){
    const T=TF[tf],need=requiredLookback(tf,SIGNAL_PARAMS);
    let page;
    try{page=await fetchKlines(read,symbol,tf,{limit:RUNNER.klines,now});}
    catch(e){
      if(stale(user,token))return;
      data={...data,[symbol]:Object.freeze({state:'error',reliable:false,text:'Data saknas — '+reasonOf(e),ageMs:null,tf,at:now(),serverTime:null})};
      return retry(symbol);
    }
    if(stale(user,token))return;
    const at=now(),{closed,forming}=splitForming(page.bars,tf,page.serverTime);
    skew=page.serverTime-at;
    // The newest closed candle needs `need` complete candles before it.
    const st=dataStatus({bars:closed,forming,serverTime:page.serverTime,lastOk:at},at,tf,{lookback:need+1});
    data={...data,[symbol]:Object.freeze({...st,tf,at,serverTime:page.serverTime})};
    if(!st.reliable)return retry(symbol);
    const latest=closed.at(-1),done=acct.processed[symbol];
    // Candles older than the last decision cannot be Bybit's current state: ask again later.
    if(finite(done)&&latest.t<done)return retry(symbol);
    if(finite(done)&&latest.t===done){
      // Bybit has not closed a newer candle (our clock runs ahead), or another tab decided it.
      if(evals[symbol]?.tf!==tf||evals[symbol].t!==latest.t)remember(symbol,tf,evaluateBar(closed,closed.length-1,{tf,params:SIGNAL_PARAMS}),st,null);
      fails[symbol]=0;
      gate[symbol]=at+Math.max(1000,(forming?forming.t+T.ms:latest.t+2*T.ms)-page.serverTime+500);
      return;
    }
    // Every candle closed since the last decision, as far back as the fetched window reaches.
    // Each value only reads `need` candles back, so the slice gives the same evaluations.
    const from=Math.max(need,finite(done)?closed.findIndex(b=>b.t>done):closed.length-1),sub=closed.slice(from-need);
    const ctx={tf,params:SIGNAL_PARAMS,ind:computeIndicators(sub,SIGNAL_PARAMS),htfBars:T.htf?aggregateClosed(sub,tf,T.htf,latest.t+T.ms):[]};
    // A candle missing among those `need` would shift every window, so such a candle gets no record
    // here; the complete history can still give it one. dataStatus checked the newest candle's window.
    const index=new Map(sub.map((b,k)=>[b.t,k])),whole=e=>{const k=index.get(e.t);return sub[k].t-sub[k-need].t===need*T.ms;};
    const found=signalsInRange(sub,need,sub.length-1,ctx).filter(whole),evaluation=evaluateBar(sub,sub.length-1,ctx),saved=new Map();
    for(const e of found){
      // Stamped on Bybit's clock, as the view stamps its forecast versions: its time when the candles were read plus
      // the time since. Never before the candle closed, so no record claims to predate its own signal.
      const close=e.t+T.ms,recordedAt=Math.max(close,page.serverTime,page.serverTime+now()-at);
      try{
        const record=signalRecord(user,symbol,tf,e,{recordedAt,origin:recordedAt-close<=T.ms?'live':'backfill',params:SIGNAL_PARAMS,tfMs:T.ms});
        const res=await within(archive().putSignal(record),wait.archive,ARCHIVE_LATE);
        // Only a record written proves room; an existing one is found without writing.
        if(res.stored&&!stale(user,token))full=false;
        // The chart may have stored the same signal first; that record is the one traded.
        if(res.stored||res.identical)saved.set(e.t,{record:res.stored?record:res.existing,state:res.stored?'stored':'identical'});
        else{saved.set(e.t,{record:null,state:'conflict'});note('Den sparade signalen för '+symbol+' '+when(e.t+T.ms,tf)+' skiljer sig från en ny beräkning — originalet behålls och handlas inte');}
      }catch(err){
        if((err?.code===ARCHIVE_FULL||err?.message==='Prognosarkivet är fullt')&&!stale(user,token))full=true;
        saved.set(e.t,{record:null,state:'error'});note('Signalen för '+symbol+' '+when(e.t+T.ms,tf)+' kunde inte sparas: '+reasonOf(err));
      }
      if(stale(user,token))return;
    }
    const sig=evaluation.side?saved.get(evaluation.t):null,record=sig?.record??null;
    remember(symbol,tf,evaluation,st,sig);
    // Only the newest candle's signal can still be fresh; older ones in the backlog were missed.
    const age=now()-(evaluation.t+T.ms),live=!!evaluation.side&&age<=Math.min(ACCOUNT.maxSignalAge,T.ms);
    const a=acct,s=a.settings,pos=a.positions.find(p=>p.symbol===symbol)??null;
    // A signal whose record could not be stored is never traded, but its candle's evaluation on live data still
    // ends a position on the other side: an exit needs no record. Only the entry waits for the record.
    const unsaved=sig?.state==='error'?'Signalen för '+symbol+' kunde inte sparas':'';
    const flip=live&&(!!record||!!unsaved)&&!!pos&&pos.side!==evaluation.side&&pos.tf===tf,enter=live&&!!record&&s.symbols.includes(symbol);
    // The backtest ends positions at their time stop at this open before it takes entries, so here they are
    // settled before an entry too: a position past its deadline holds neither a slot nor its coin.
    const expired=enter&&!s.paused?a.positions.filter(p=>ended(p,now())&&!(flip&&p.id===pos.id)):[],ends=new Map();
    let quote=null,risk=null,contract=null,missing='',noLimits='',endWait='';
    // Slow reads first and the price last, so it is still fresh when the decision is written.
    // Limits matter only for an entry that can reach sizing; any earlier refusal keeps its own reason.
    if(enter&&!s.paused&&(!pos||flip||expired.includes(pos))&&a.positions.length-(flip?1:0)-expired.length<s.maxOpen){
      try{contract=await limitsOf(symbol);}catch{contract=null;}
      if(!contract)noLimits='Bybits hävstångsgräns saknas för '+symbol;
    }
    if(flip){try{risk=await riskOf(pos);accept(symbol,risk);}catch(e){missing=reasonOf(e);}}
    if(!missing&&!noLimits)for(const p of expired){
      try{const r=await riskOf(p);accept(p.symbol,r);ends.set(p.id,r);}catch(e){endWait=unsettled(p,reasonOf(e));break;}
    }
    if(!missing&&(flip||enter&&!s.paused&&!noLimits&&!endWait)){
      try{quote=await ticker(symbol);accept(symbol,quote);}catch(e){missing=reasonOf(e);}
    }
    missing||=noLimits||endWait||(live?unsaved:'');
    if(stale(user,token))return;
    // A signal that could not be stored is not traded for that reason, also once it has aged past its window.
    let skipped=false,blocked='',opened=null,closedTrade=null,reason=unsaved||(evaluation.side&&!live?'Signalen är för gammal ('+Math.round(age/60000)+' min)':'');
    try{
      await commit(user,token,current=>{
        // A reset, a new timeframe or another tab's decision for this candle stands.
        if(current.createdAt!==a.createdAt||current.settings.tf!==tf||(current.processed[symbol]??-Infinity)>=latest.t){skipped=true;return null;}
        let next=current;const t=now(),p=current.positions.find(x=>x.symbol===symbol);
        if(flip&&quote&&risk&&p?.id===pos.id){
          // Settle first: funding, liquidation and the deadline up to now, then close at market.
          const c=coverage(risk,p,t);
          blocked=p.fundingThrough>risk.fundingThrough?'positionen i '+symbol+' ändrades under tiden':!fresh(quote,t)?'Färskt pris saknas för '+symbol:
            c.state!=='ok'?c.late:'';
          if(!blocked)try{
            next=settlePosition(next,p.id,risk,t);
            if(holds(next,p.id))next=checkQuote(next,p.id,quote,t);
            if(holds(next,p.id))next=closeAt(next,p.id,{price:quote.price,now:t,reason:'signal'});
            closedTrade=next.trades.findLast(x=>x.id===p.id)??null;
          }catch(e){next=current;closedTrade=null;blocked=reasonOf(e);}
        }
        if(enter&&!blocked){
          if(next.settings.paused||quote&&!missing){
            if(!next.settings.paused)[next,blocked]=settleEnded(next,ends,t);
            // What only our own reads would refuse (a price or limits that aged on the way) waits for a new read.
            const n=next.settings,room=n.symbols.includes(symbol)&&!next.positions.some(x=>x.symbol===symbol)&&next.positions.length<n.maxOpen;
            blocked||=n.paused?'':!fresh(quote,t)?'Färskt pris saknas för '+symbol:quote.at<record.confirmedAt?'Färskt pris efter signalen saknas för '+symbol:
              room&&!usable(contract,t)?'Bybits hävstångsgräns saknas för '+symbol:'';
            if(!blocked){
              const r=openPosition(next,{signal:record,symbol,quote,contract,now:t,tfMs:T.ms,dataReliable:true});
              next=r.account;opened=r.opened?r.position:null;reason=r.reason;
            }
          }else if(!missing)blocked='kontot återupptogs under tiden';
        }
        // A fresh signal that waits for a price, limits or its record is tried again; anything else is decided.
        if(!live||!missing&&!blocked)next=markProcessed(next,symbol,latest.t);
        return next;
      });
    }catch(e){
      // The account could not be read or written: nothing happened, so try the candle again.
      if(stale(user,token))return;
      error=reasonOf(e);
      return retry(symbol);
    }
    if(stale(user,token))return;
    const rest={...waiting};delete rest[symbol];waiting=rest;
    if(!skipped&&live&&(missing||blocked)){
      // `unsaved`: the wait is only for the record, which the status says once for a full archive.
      waiting={...waiting,[symbol]:Object.freeze({why:missing||blocked,t:latest.t,unsaved:!!unsaved&&(missing||blocked)===unsaved})};
      retry(symbol);
    }else{fails[symbol]=0;delete gate[symbol];}
    if(!skipped)last=Object.freeze({symbol,tf,t:evaluation.t,side:evaluation.side,fresh:live,opened,closed:closedTrade,reason:missing||blocked||reason,at:now()});
  }

  // Manual close: settle funding and the 5-minute history first, then sell at a fresh quote.
  async function closeOne(id){
    const user=sync();
    if(!user)return {ok:false,text:'Logga in för att stänga positionen',trade:null};
    const token=generation,changed={ok:false,text:'Kontot byttes medan stängningen pågick',trade:null};
    let symbol=null;
    try{
      for(let attempt=0;;attempt++){
        const a=await commit(user,token,null);
        if(!a)return changed;
        const p=a.positions.find(x=>x.id===id);
        if(!p)return {ok:false,text:'Positionen är redan stängd',trade:a.trades.findLast(x=>x.id===id)??null};
        symbol=p.symbol;
        const risk=await riskOf(p),quote=await ticker(p.symbol);
        accept(p.symbol,risk);accept(p.symbol,quote);
        let again='',gone=false,trade=null;
        const next=await commit(user,token,current=>{
          const pos=current.positions.find(x=>x.id===id),t=now();
          if(!pos){gone=true;return null;}
          // Another tab settled it after this fetch, or a 5-minute step began since: read again rather than
          // replay older history or close without the newest candle, which may hold a liquidation or the time stop.
          if(pos.fundingThrough>risk.fundingThrough){again='positionen ändrades under tiden, försök igen';return null;}
          const c=coverage(risk,pos,t);
          if(c.state!=='ok'){again=c.late+', försök igen om en stund';return null;}
          let out=settlePosition(current,id,risk,t);
          if(holds(out,id))out=checkQuote(out,id,quote,t);
          if(holds(out,id)){
            if(!fresh(quote,t)){again='Färskt pris saknas för '+pos.symbol;return null;}
            out=closeAt(out,id,{price:quote.price,now:t,reason:'manuell'});
          }
          trade=out.trades.findLast(x=>x.id===id)??null;
          return out;
        });
        if(!next)return changed;
        if(gone)return {ok:false,text:'Positionen är redan stängd',trade:next.trades.findLast(x=>x.id===id)??null};
        if(again){if(attempt<2)continue;throw Error(again);}
        return {ok:true,text:closeText(trade),trade};
      }
    }catch(e){return {ok:false,text:'Kunde inte stänga '+(symbol??'positionen')+': '+reasonOf(e),trade:null};}
    finally{notify();}
  }
  async function change(apply,signedOut){
    const user=sync();
    if(!user)throw Error(signedOut);
    const tf=acct?.settings.tf,next=await commit(user,generation,apply);
    if(!next)throw Error('Kontot byttes medan ändringen sparades');
    // Bar times from another timeframe say nothing about the new one.
    if(next.settings.tf!==tf){gate={};fails={};waiting={};}
    prune();
    notify();
    return next;
  }
  // Archive first, under <key>:before-reset:<t>; a failed archive or write leaves the saved account as it was.
  async function resetAccount(){
    const user=sync();
    if(!user)throw Error('Logga in för att återställa AI Forecast-kontot');
    const token=++generation;
    const created=await exclusive(user,()=>{
      if(stale(user,token))return null;
      const key=accountKey(user),raw=storage.getItem(key),t=now();
      let settings={};
      // The user's settings carry over; an unreadable account starts from the defaults.
      try{if(raw!==null)settings=readForecastAccount(storage,key,t).settings;}catch{settings={};}
      const next=newForecastAccount(t,settings);
      if(raw!==null){let suffix=t,backup=key+':before-reset:'+suffix;while(storage.getItem(backup)!==null)backup=key+':before-reset:'+(++suffix);storage.setItem(backup,raw);}
      storage.setItem(key,JSON.stringify(next));
      return acct=deepFreeze(next);
    });
    if(!created)throw Error('Kontot byttes medan återställningen pågick');
    gate={};fails={};waiting={};tried={};trouble={};last=null;error='';protection='';
    notify();
    return created;
  }

  function status(){
    const user=sync(),t=now();
    let on=false;try{on=!!isActive();}catch{on=false;}
    const base={paused:null,open:null,maxOpen:null,tf:null,nextDecision:null,data:{...data},unreliable:[],
      waiting:Object.fromEntries(Object.entries(waiting).map(([x,w])=>[x,w.why])),protection,error,archiveFull:full,notes:[...notes],last,busy:!!running,at:t};
    const idle=['inactive','Vilar — handlar när kryptosidan är öppen'];
    const out=([state,text],more={})=>Object.freeze({...base,...more,state,text});
    if(!user)return out(['signed-out','Logga in för att handla med AI Forecast-kontot']);
    if(!acct)return out(error?['error',error]:on?['loading','Laddar AI Forecast-kontot…']:idle);
    const s=acct.settings,ms=TF[s.tf].ms,next=(Math.floor((t+skew)/ms)+1)*ms,open=acct.positions.length;
    const unreliable=s.symbols.filter(x=>data[x]?.tf===s.tf&&!data[x].reliable);
    // A full archive is said once, plainly, instead of as one unsaved signal per coin.
    const pending=[protection,...Object.entries(waiting).filter(([,w])=>!(full&&w.unsaved)).map(([x,w])=>'ny affär i '+x+': '+w.why)].filter(Boolean);
    const more={paused:s.paused,open,maxOpen:s.maxOpen,tf:s.tf,nextDecision:next,unreliable};
    if(error)return out(['error',error],more);
    if(!on)return out(idle,more);
    if(full)return out(['waiting',FULL+(pending.length?' · Väntar på '+pending.join(' · '):'')],more);
    if(pending.length)return out(['waiting','Väntar på '+pending.join(' · ')],more);
    if(s.paused)return out(['paused','Pausad'],more);
    if(unreliable.length)return out(['unreliable','Data opålitlig för '+unreliable.join(', ')+' — nya affärer pausade'],more);
    return out(['trading','Handlar · '+open+' av '+s.maxOpen+' positioner · nästa beslut '+when(next,s.tf)],more);
  }

  return {
    tick,status,
    account(){sync();return acct;},
    live(){sync();try{return acct?accountLive(acct,quotes,now()):null;}catch{return null;}},
    quotes(){sync();return {...quotes};},
    evaluations(){sync();const tf=acct?.settings.tf;return Object.freeze(Object.fromEntries(Object.entries(evals).filter(([,e])=>!tf||e.tf===tf)));},
    closePosition:closeOne,
    updateSettings:patch=>change(a=>withSettings(a,patch),'Logga in för att ändra AI Forecast-kontot'),
    setPaused:paused=>change(a=>withPaused(a,paused),'Logga in för att pausa AI Forecast-kontot'),
    reset:resetAccount
  };
}
