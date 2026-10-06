// Background demo trading for the AI Forecast account, page-wide, while the
// crypto page is open and someone is logged in. tick() (every few seconds)
// guards open positions on live quotes and replays one position's funding and
// 5-minute history per tick, in turns (after a long absence one window of it per
// turn, see fetchPositionRisk). When Bybit's own clock says a candle of
// the account's timeframe has closed, it evaluates every closed candle since
// the last decision and stores each signal once. With auto-trading on it acts
// only on a fresh one: a signal position on the other side closes at market,
// then a new one opens; with it off (the default) signals are only stored. Data
// that is not live pauses new signal entries with a visible reason; exits keep
// working. The user's own market orders, stop and target changes, deposits and
// withdrawals go through the same lock. Every change is read, applied and written
// inside the account's tab lock before it is shown. Demo only: public market
// data, no orders.
import {TF,SYMBOLS,SIGNAL_PARAMS} from './forecast-config.js';
import {requiredLookback,computeIndicators,aggregateClosed,evaluateBar,signalsInRange} from './forecast-model.js';
import {ACCOUNT,accountKey,newForecastAccount,readForecastAccount,updateSettings as withSettings,setPaused as withPaused,setAuto as withAuto,markProcessed,
  openPosition,settlePosition,checkQuote,closePosition as closeAt,accountLive,tradeReasons,previewOrder,openManual,previewLevels,
  setLevels as withLevels,deposit,withdraw,setFree as withFree,stepDecimals,levelDecimals} from './forecast-account.js';
import {signalRecord,createForecastStore,defaultBackend,deepFreeze,ARCHIVE_FULL} from './forecast-store.js';
import {fetchKlines,splitForming,dataStatus,fetchPositionRisk} from './forecast-market.js';
import {fetchMomentumQuotes} from './crypto-momentum-live.js';
import {createContractCache,fetchContract,LIMIT_TTL} from './bybit-contracts.js';

// interval: how often the page calls tick(); retry/maxRetry: backoff after a failed or unreliable read,
// short enough that recovered data still meets a signal inside its 30-minute window; grace: how long
// Bybit may lack the candle of a 5-minute step that has just begun before that counts as a problem.
// timeout: how long one awaited read may take. read: one Bybit request (the page's grab gives up on its
// proxies within about 23 s, unless a response body stalls); quote: a ticker (its own budget ends within
// 8.5 s), short enough that the other coins' quotes are still fresh when a hung one gives up; archive: one
// call to the record archive. soon: how long a close or a change of levels waits before it reads again when
// all that is missing is the candle of a step that has just begun (Bybit publishes it a second or two late).
export const RUNNER=Object.freeze({interval:5000,klines:1000,retry:15000,maxRetry:60000,notes:10,grace:15000,
  timeout:Object.freeze({read:30000,quote:10000,archive:10000,soon:1000})});
// LIMIT_MARGIN: the life Bybit's limits must have left when an order or a change of levels takes them, so they cannot age
// past LIMIT_TTL while the price (and a change's history) is read.
const STEP=ACCOUNT.step,MIN=60000,LIMIT_MARGIN=2*MIN;
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
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
// 5-minute candle after its opening (or after its levels last changed) is settled, the closed 1-minute candles of
// that step: the mark from the minute after the opening, the last price from the minute after the later of the two.
// The newest such candle is missing when its period began during the read, or for a moment after, until Bybit
// publishes it. A window of a long absence holds only closed candles, all there.
// → {state:'ok'|'soon'|'behind', late: what is missing, in Swedish}
function coverage(risk,p,t){
  if(risk.through!==undefined)return {state:'ok',late:''};
  const s=Math.floor(t/STEP)*STEP,last=Math.min(risk.markBars.at(-1)?.t??-Infinity,p.nextBar>s?Infinity:risk.lastBars.at(-1)?.t??-Infinity);
  if(last<s)return {state:last===s-STEP&&t-s<=RUNNER.grace?'soon':'behind',late:'Bybits senaste 5-minuterspriser saknas ännu'};
  const since=Math.max(p.openedAt,p.levelsAt??p.openedAt),first=(Math.floor(since/STEP)+1)*STEP,need=Math.min(first,Math.floor(t/MIN)*MIN)-MIN;
  // Each series from its first minute, those whose newest closed minute is not in yet.
  const short=[[Math.max(first-STEP,Math.ceil(p.openedAt/MIN)*MIN),risk.minuteMarks],[Math.ceil(since/MIN)*MIN,risk.minuteLasts]]
    .map(([start,bars])=>({start,have:bars?.at(-1)?.t??-Infinity})).filter(x=>need>=x.start&&x.have<need);
  if(p.nextBar!==first||!short.length)return {state:'ok',late:''};
  // Only the newest closed minute is missing (the first one replayed has no minute before it): Bybit may publish it in a moment.
  return {state:short.every(x=>Math.max(x.have,x.start-MIN)===need-MIN)&&t-(need+MIN)<=RUNNER.grace?'soon':'behind',late:'Bybits senaste 1-minuterspriser saknas ännu'};
}
const holds=(a,id)=>a.positions.some(p=>p.id===id);
const unsettled=(p,why)=>'Tidsstoppet för '+p.symbol+' är inte avräknat'+(why?' — '+why:'');
const money=x=>(x<0?'−':'+')+Math.abs(x).toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const dollars=x=>x.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const priceText=x=>x.toLocaleString('sv-SE',{maximumSignificantDigits:6});
const SIDE=Object.freeze({long:'lång',short:'kort'});
const marked=x=>x?.origin==='manual'?' (manuell)':'';
// A position closed by its stop, target, liquidation or time stop while a request about it was on its way.
function overtaken(t,what){
  if(t.reason==='likvidation')return SIDE[t.side]+' '+t.symbol+marked(t)+' likviderades innan '+what+' hann gå igenom · '+money(t.pnl);
  return tradeReasons[t.reason]+' hann före '+what+': '+SIDE[t.side]+' '+t.symbol+marked(t)+' '+money(t.pnl);
}
// A manual order's prices in the coin's tick on Bybit, as the page writes them (six significant digits without its
// filters): a fill or an exit with all of the tick's decimals ('85 432,0'), a stop or a target as levelDecimals has it.
const tickOf=f=>finite(f?.tickSize)&&f.tickSize>0?stepDecimals(f.tickSize):null;
const fixedPrice=(x,d)=>d===null?priceText(x):x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
const tickPrice=(x,f)=>fixedPrice(x,tickOf(f));
const tickLevel=(x,f)=>{const d=tickOf(f);return fixedPrice(x,d===null?null:levelDecimals(x,d));};
// 'Köpte 0,017 BTC till 85 432,1 · 150× · marginal 10,00 $' for a long, 'Sålde …' for a short, and the levels set with it.
function orderText(p,preview){
  const f=preview.filters,qty=p.units.toLocaleString('sv-SE',{maximumFractionDigits:stepDecimals(f.qtyStep)});
  return (p.side==='long'?'Köpte ':'Sålde ')+qty+' '+p.symbol+' till '+tickPrice(p.entry,f)+' · '+p.leverage.toLocaleString('sv-SE',{maximumFractionDigits:2})+'× · marginal '+
    dollars(p.margin)+(p.sl===null?'':' · SL '+tickLevel(p.sl,f))+(p.tp===null?'':' · TP '+tickLevel(p.tp,f));
}
const levelsText=(p,f)=>SIDE[p.side]+' '+p.symbol+': '+(p.sl===null?'ingen SL':'SL '+tickLevel(p.sl,f))+', '+(p.tp===null?'ingen TP':'TP '+tickLevel(p.tp,f));
// After a long absence a position's history is settled a window at a time; until it reaches now the status says so.
const catchingUp=risk=>'lång frånvaro, historiken läses ikapp (klar t.o.m. '+
  new Date(risk.through).toLocaleDateString('sv-SE',{timeZone:'Europe/Stockholm',day:'numeric',month:'short',year:'numeric'})+')';
const positions=n=>n===1?'1 öppen position':n+' öppna positioner';
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
// f: Bybit's filters for the coin, when the runner has read them (the exit then has the tick's decimals, as in Historik).
function closeText(t,f=null){
  if(!t)return 'Positionen är stängd';
  if(t.reason==='manuell')return 'Stängde '+SIDE[t.side]+' '+t.symbol+marked(t)+' till '+tickPrice(t.exit,f)+' · '+money(t.pnl);
  return overtaken(t,t.reason==='likvidation'?'stängningen':'den manuella stängningen');
}

/**
 * createForecastRunner({grab,storage,store,locks,now,getUser,isActive,contracts,onChange,timeouts}) →
 *   {tick(), account(), live(), status(), evaluations(), quotes(), closePosition(id), updateSettings(patch), setPaused(bool), reset(),
 *    setAuto(bool), order(params), setLevels(id,levels), transfer({kind,amount}), setFree(amount), quoteOrder(params), quoteLevels(id,levels),
 *    watch(symbol), limits(symbol)}
 * grab: the page's proxy fetch for public Bybit market endpoints. storage: localStorage-like.
 * store: createForecastStore(...) (default: IndexedDB, else localStorage, else memory).
 * locks: navigator.locks-like {request(name,fn)}. contracts: {get(symbol),load(symbol)} like createContractCache.
 * timeouts: {read,quote,archive,soon} in ms, each optional (defaults RUNNER.timeout); a read past its time fails
 *   with 'Bybit svarade inte i tid' (an archive call with 'Prognosarkivet svarar inte'). soon: the wait before a
 *   close or a change of levels reads again while Bybit has yet to publish the candle of a step that has just begun.
 * tick() never throws; problems become status().text. status(): {state:'signed-out'|'loading'|'error'|'inactive'|
 *   'waiting'|'paused'|'unreliable'|'trading'|'manual', text (Swedish), auto, paused, open (all open positions), manual
 *   (manual ones), maxOpen, tf, nextDecision (Bybit time of the next candle close), data:{[symbol]:dataStatus at the last
 *   read}, unreliable:[symbol], waiting:{[symbol]:reason}, protection (failed price reads this tick, and failed protection
 *   checks until their position settles; after a long absence 'lång frånvaro, historiken läses ikapp (klar t.o.m. <date>)'
 *   until it has), error, archiveFull (the archive refused the last new signal for lack of room: state 'waiting' and a
 *   text saying so while auto-trading is on), notes:[integrity and storage warnings], last (latest decision), busy, at}.
 *   With auto-trading off the state is 'manual' unless something is wrong or awaited.
 * closePosition(id) resolves {ok,text,trade}; updateSettings/setPaused/reset resolve the new account or reject in Swedish.
 * The manual API never rejects; each resolves once its change is written (or refused) and notifies onChange:
 *   setAuto(bool) → {ok,text,account}; order({symbol,side,margin,leverage,sl?,tp?}) → {ok,text,position,preview} (a fresh
 *   ticker and Bybit's limits are read first); setLevels(id,{sl?,tp?}) → {ok,text,position,trade} (the position is settled
 *   with its old levels first, as closePosition settles it; on any failure the old levels stay); transfer({kind:'in'|'out',
 *   amount}) and setFree(amount) → {ok,text,account}. order and setLevels act on the request as it was when called, and
 *   take Bybit's limits with at least LIMIT_MARGIN of their life left (read again otherwise).
 * quoteOrder(params) and quoteLevels(id,levels) are synchronous: previewOrder and previewLevels on the latest quote and
 *   limits the runner holds (watch(symbol) keeps a coin's quote and limits fresh on every tick; held coins are always kept).
 *   Without a readable account they give why (status().error), or 'AI Forecast-kontot laddas' while it loads.
 *   limits(symbol): Bybit's limits held for that coin while they are fresh, else null.
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
  // The newest limits read per coin, for the synchronous previews.
  const limitsRead=new Map(),keep=(symbol,c)=>{if(c&&!(limitsRead.get(symbol)?.at>c.at))limitsRead.set(symbol,c);};
  async function limitsOf(symbol){
    let c=null;
    if(shared&&!stuck.has(symbol)){
      const task=Promise.resolve().then(()=>shared.load(symbol));
      try{c=await within(task,wait.read,LATE);keep(symbol,c);return c;}
      catch(e){
        if(e?.message!==LATE)throw e;
        stuck.add(symbol);task.then(()=>stuck.delete(symbol),()=>stuck.delete(symbol));
      }
    }
    c=await within(own.load(symbol),wait.read,LATE);
    keep(symbol,c);
    return c;
  }
  const limitsNow=symbol=>{const c=limitsRead.get(symbol);return usable(c,now())?c:null;};
  // Bybit's limits for an order or a change of levels, with LIMIT_MARGIN of their life left: the caches keep them until
  // LIMIT_TTL, so older ones are read again from Bybit. If that read fails, the older ones, still in date, are tried.
  async function freshLimits(symbol){
    const lasting=c=>!!c&&now()-c.at<=LIMIT_TTL-LIMIT_MARGIN&&c.at<=now()+5000;
    if(lasting(limitsRead.get(symbol)))return limitsRead.get(symbol);
    let c=null;
    try{c=await limitsOf(symbol);}catch{c=null;}
    if(lasting(c))return limitsRead.get(symbol)??c;
    try{const f=await fetchContract(read,symbol,now);keep(symbol,f);return f;}catch{return usable(c,now())?c:null;}
  }
  // A coin's limits read in the background when they are missing or old and a preview needs them, or on a tick for a held
  // or the watched coin; one read per coin at a time.
  const limitsLoading=new Set();
  function refreshLimits(symbol){
    if(!SYMBOLS.includes(symbol)||limitsNow(symbol)||limitsLoading.has(symbol))return;
    limitsLoading.add(symbol);
    limitsOf(symbol).catch(()=>null).then(c=>{limitsLoading.delete(symbol);if(c)notify();});
  }
  let records=store;
  const archive=()=>records??=createForecastStore(defaultBackend(globalThis));
  let uid=null,acct=null,generation=0,running=null,epoch=null,watched=null;
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
  // A wait ends once its candle is decided, here or in another tab, once the coin is neither traded nor held, or once
  // auto-trading is off.
  function prune(){
    const keep=([s,w])=>acct.settings.auto&&!(acct.processed[s]>=w.t)&&(acct.settings.symbols.includes(s)||acct.positions.some(p=>p.symbol===s));
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
  // A version 1 account is read as version 2 and written back so, under the same key.
  function commit(user,token,change){
    return exclusive(user,()=>{
      if(stale(user,token))return null;
      const key=accountKey(user);
      let raw=storage.getItem(key);
      if(raw===null){raw=JSON.stringify(newForecastAccount(now()));storage.setItem(key,raw);}
      let current;
      try{current=readForecastAccount(storage,key,now());}catch(e){acct=null;throw e;}
      const next=change?change(current):null,json=JSON.stringify(next??current);
      if(json!==raw)storage.setItem(key,json);
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

  // Quotes for every held coin (and the watched one, for the order previews), then funding and the 5-minute history
  // for one position, then the stop, target and liquidation check on the quotes. The turn goes to the position settled
  // or tried longest ago, so one whose history keeps failing cannot hold up the others; its reason shows until it settles.
  // The limits of these coins are kept fresh too: the previews need them, and the page writes their prices on Bybit's tick.
  async function protect(user,token){
    const positions=acct.positions,symbols=[...new Set(positions.map(p=>p.symbol))];
    const reads=watched&&!symbols.includes(watched)?[...symbols,watched]:symbols;
    for(const symbol of reads)refreshLimits(symbol);
    // A failed read of the watched coin is no protection problem: its preview says the price is missing.
    const got=reads.length?await Promise.allSettled(reads.map(ticker)):[];
    if(stale(user,token))return;
    const problems=[];
    got.forEach((r,k)=>{if(r.status==='fulfilled')accept(reads[k],r.value);else if(k<symbols.length)problems.push('pris för '+symbols[k]+': '+reasonOf(r.reason));});
    if(!positions.length){protection='';tried={};trouble={};return;}
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
    // A window of a long absence settled: the rest of the history is read on the next turns.
    if(!why&&risk?.through!==undefined&&holds(acct,p.id))why=catchingUp(risk);
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
  // before its own clock gets there, and settling has to wait for our clock to pass it. A manual position has none.
  const ended=(p,t)=>p.deadline!==null&&p.deadline<=t+Math.max(0,skew);
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
        const noRoom=err?.code===ARCHIVE_FULL||err?.message==='Prognosarkivet är fullt';
        if(noRoom&&!stale(user,token))full=true;
        saved.set(e.t,{record:null,state:'error',noRoom});note('Signalen för '+symbol+' '+when(e.t+T.ms,tf)+' kunde inte sparas: '+reasonOf(err));
      }
      if(stale(user,token))return;
    }
    const sig=evaluation.side?saved.get(evaluation.t):null,record=sig?.record??null;
    remember(symbol,tf,evaluation,st,sig);
    // Only the newest candle's signal can still be fresh; older ones in the backlog were missed.
    const age=now()-(evaluation.t+T.ms),live=!!evaluation.side&&age<=Math.min(ACCOUNT.maxSignalAge,T.ms);
    const a=acct,s=a.settings,auto=s.auto,pos=a.positions.find(p=>p.symbol===symbol)??null;
    // A signal whose record could not be stored is never traded, but its candle's evaluation on live data still
    // ends a position on the other side: an exit needs no record. Only the entry waits for the record.
    const unsaved=sig?.state==='error'?'Signalen för '+symbol+' kunde inte sparas':'';
    // With auto-trading off a signal is only stored: no entry, and no position closed on it. A manual position
    // never closes on a signal.
    const flipWanted=live&&(!!record||!!unsaved)&&!!pos&&pos.origin==='signal'&&pos.side!==evaluation.side&&pos.tf===tf;
    const enterWanted=live&&!!record&&s.symbols.includes(symbol),flip=auto&&flipWanted,enter=auto&&enterWanted;
    // With auto-trading off a fresh signal is still stored: one whose record failed (the archive had room) keeps its candle
    // open and is tried again with the usual backoff, without a wait for a trade.
    const storeAgain=!auto&&live&&!!unsaved&&!sig.noRoom;
    // The backtest ends positions at their time stop at this open before it takes entries, so here they are
    // settled before an entry too: a position past its deadline holds neither a slot nor its coin.
    const expired=enter&&!s.paused?a.positions.filter(p=>ended(p,now())&&!(flip&&p.id===pos.id)):[],ends=new Map();
    // maxOpen counts the signal positions; manual ones take no slot.
    const slots=a.positions.filter(p=>p.origin==='signal').length;
    let quote=null,risk=null,contract=null,missing='',noLimits='',endWait='';
    // Slow reads first and the price last, so it is still fresh when the decision is written.
    // Limits matter only for an entry that can reach sizing; any earlier refusal keeps its own reason.
    if(enter&&!s.paused&&(!pos||flip||expired.includes(pos))&&slots-(flip?1:0)-expired.length<s.maxOpen){
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
    missing||=noLimits||endWait||(live&&auto?unsaved:'');
    if(stale(user,token))return;
    // A signal that could not be stored is not traded for that reason, also once it has aged past its window.
    let skipped=false,blocked='',opened=null,closedTrade=null,reason=unsaved||(evaluation.side&&!live?'Signalen är för gammal ('+Math.round(age/60000)+' min)':'');
    try{
      await commit(user,token,current=>{
        // A reset, a new timeframe or another tab's decision for this candle stands.
        if(current.createdAt!==a.createdAt||current.settings.tf!==tf||(current.processed[symbol]??-Infinity)>=latest.t){skipped=true;return null;}
        let next=current;const t=now(),p=current.positions.find(x=>x.symbol===symbol),on=current.settings.auto;
        // Auto-trading switched on while the candle was read: the candle is read again, and the signal traded then.
        if(!auto&&on&&(flipWanted||enterWanted))blocked='auto-handeln slogs på under tiden';
        // Switched off meanwhile: nothing is traded on it.
        if(!on&&(flipWanted||enterWanted))reason||='Auto-handel av — signalen handlas inte';
        if(flip&&on&&quote&&risk&&p?.id===pos.id&&p.origin==='signal'){
          // Settle first: funding, liquidation and the deadline up to now, then close at market. After a long absence the
          // protection of open positions settles the history window by window first.
          const c=coverage(risk,p,t);
          blocked=p.fundingThrough>risk.fundingThrough?'positionen i '+symbol+' ändrades under tiden':!fresh(quote,t)?'Färskt pris saknas för '+symbol:
            risk.through!==undefined?'historiken för '+symbol+' läses ikapp efter en lång frånvaro':c.state!=='ok'?c.late:'';
          if(!blocked)try{
            next=settlePosition(next,p.id,risk,t);
            if(holds(next,p.id))next=checkQuote(next,p.id,quote,t);
            if(holds(next,p.id))next=closeAt(next,p.id,{price:quote.price,now:t,reason:'signal'});
            closedTrade=next.trades.findLast(x=>x.id===p.id)??null;
          }catch(e){next=current;closedTrade=null;blocked=reasonOf(e);}
        }
        if(enter&&on&&!blocked){
          if(next.settings.paused||quote&&!missing){
            if(!next.settings.paused)[next,blocked]=settleEnded(next,ends,t);
            // What only our own reads would refuse (a price or limits that aged on the way) waits for a new read.
            const n=next.settings,room=n.symbols.includes(symbol)&&!next.positions.some(x=>x.symbol===symbol)&&
              next.positions.filter(x=>x.origin==='signal').length<n.maxOpen;
            blocked||=n.paused?'':!fresh(quote,t)?'Färskt pris saknas för '+symbol:quote.at<record.confirmedAt?'Färskt pris efter signalen saknas för '+symbol:
              room&&!usable(contract,t)?'Bybits hävstångsgräns saknas för '+symbol:'';
            if(!blocked){
              const r=openPosition(next,{signal:record,symbol,quote,contract,now:t,tfMs:T.ms,dataReliable:true});
              next=r.account;opened=r.opened?r.position:null;reason=r.reason;
            }
          }else if(!missing)blocked='kontot återupptogs under tiden';
        }
        // A fresh signal that waits for a price, limits or its record is tried again; anything else is decided.
        if(!live||!missing&&!blocked&&!storeAgain)next=markProcessed(next,symbol,latest.t);
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
    }else if(!skipped&&storeAgain)retry(symbol);
    else{fails[symbol]=0;delete gate[symbol];}
    if(!skipped)last=Object.freeze({symbol,tf,t:evaluation.t,side:evaluation.side,fresh:live,opened,closed:closedTrade,reason:missing||blocked||reason,at:now()});
  }

  // Manual close: settle funding and the 5-minute history first, then sell at a fresh quote. After a long absence the
  // history is settled window by window first (each window is written as it is settled).
  async function closeOne(id){
    const user=sync();
    if(!user)return {ok:false,text:'Logga in för att stänga positionen',trade:null};
    const token=generation,changed={ok:false,text:'Kontot byttes medan stängningen pågick',trade:null};
    let symbol=null;
    try{
      for(let attempt=0;;){
        const a=await commit(user,token,null);
        if(!a)return changed;
        const p=a.positions.find(x=>x.id===id);
        if(!p)return {ok:false,text:'Positionen är redan stängd',trade:a.trades.findLast(x=>x.id===id)??null};
        symbol=p.symbol;
        const risk=await riskOf(p),quote=await ticker(p.symbol);
        accept(p.symbol,risk);accept(p.symbol,quote);
        let again='',soon=false,gone=false,behind=false,trade=null;
        const next=await commit(user,token,current=>{
          const pos=current.positions.find(x=>x.id===id),t=now();
          if(!pos){gone=true;return null;}
          // Another tab settled it after this fetch, or a 5-minute step began since: read again rather than
          // replay older history or close without the newest candle, which may hold a liquidation or the time stop.
          if(pos.fundingThrough>risk.fundingThrough){again='positionen ändrades under tiden, försök igen';return null;}
          const c=coverage(risk,pos,t);
          if(c.state!=='ok'){again=c.late+', försök igen om en stund';soon=c.state==='soon';return null;}
          let out=settlePosition(current,id,risk,t);
          if(risk.through!==undefined&&holds(out,id)){behind=true;return out;}
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
        if(behind)continue;
        // A candle Bybit publishes a moment after its step begins is waited for, not read again at once.
        if(again){if(++attempt<3){if(soon)await pause(wait.soon);continue;}throw Error(again);}
        return {ok:true,text:closeText(trade,limitsRead.get(p.symbol)?.filters),trade};
      }
    }catch(e){return {ok:false,text:'Kunde inte stänga '+(symbol??'positionen')+': '+reasonOf(e),trade:null};}
    finally{notify();}
  }
  // The user's own market order: Bybit's limits, then a fresh ticker, then previewOrder's checks and the opening inside the
  // lock, against the account as it is then. A refused order changes nothing. The order is what was asked when the call
  // came: later changes to the caller's object do not reach it.
  async function orderOne(params){
    const user=sync(),{symbol,side,margin,leverage,sl,tp}=params&&typeof params==='object'?params:{},p={side,margin,leverage,sl,tp};
    const no=(text,preview=null)=>({ok:false,text,position:null,preview});
    if(!user)return no('Logga in för att handla');
    if(!SYMBOLS.includes(symbol))return no('Okänt par');
    if(p.side!=='long'&&p.side!=='short')return no('Välj köp (lång) eller sälj (kort)');
    const token=generation,changed=no('Kontot byttes medan ordern lades');
    try{
      const a=await commit(user,token,null);
      if(!a)return changed;
      if(a.positions.some(x=>x.symbol===symbol))return no('Det finns redan en position i '+symbol+' — stäng den först');
      const contract=await freshLimits(symbol);
      if(!contract)return no('Bybits gränser för '+symbol+' saknas just nu — försök igen om en stund');
      // The price is read last, after the request, so it is fresh when the order is written.
      let quote;
      try{quote=await ticker(symbol);}catch(e){return no('Färskt pris saknas för '+symbol+': '+reasonOf(e));}
      if(stale(user,token))return changed;
      accept(symbol,quote);
      let result=null;
      const next=await commit(user,token,current=>{
        result=openManual(current,{symbol,side:p.side,margin:p.margin,leverage:p.leverage,sl:p.sl,tp:p.tp,quote,contract,now:now()});
        return result.ok?result.account:null;
      });
      if(!next||!result)return changed;
      if(!result.ok)return no(result.reason,result.preview);
      return {ok:true,text:orderText(result.position,result.preview),position:result.position,preview:result.preview};
    }catch(e){return no('Kunde inte lägga ordern: '+reasonOf(e));}
    finally{notify();}
  }
  // New stop and target: the position is settled with its old levels up to now first (funding, liquidation, the old
  // stop, target and time stop), as a close settles it, then the levels change from now on. Any failure leaves the old
  // levels; a position the old levels closed meanwhile, here or on a tick, stays closed and the text says so. The levels
  // are those asked when the call came.
  async function levelsOne(id,asked){
    const user=sync(),no=(text,more={})=>({ok:false,text,position:null,trade:null,...more});
    if(!user)return no('Logga in för att ändra SL och TP');
    const price=x=>x===undefined||x===null||finite(x)&&x>0,levels=asked&&typeof asked==='object'&&!Array.isArray(asked)?{...asked}:null;
    if(!levels||Object.keys(levels).some(k=>k!=='sl'&&k!=='tp')||levels.sl===undefined&&levels.tp===undefined)return no('Ange SL eller TP');
    if(!price(levels.sl))return no('Ange SL som ett pris över 0');
    if(!price(levels.tp))return no('Ange TP som ett pris över 0');
    const token=generation,changed=no('Kontot byttes medan ändringen pågick');
    // Closed before the change could be made: by its own stop, target, liquidation, time stop or signal, which the text
    // names, or by the user.
    const closed=a=>{const t=a.trades.findLast(x=>x.id===id)??null;return no(t&&t.reason!=='manuell'?overtaken(t,'ändringen'):'Positionen är redan stängd',{trade:t});};
    let symbol=null;
    try{
      for(let attempt=0;;){
        const a=await commit(user,token,null);
        if(!a)return changed;
        const p=a.positions.find(x=>x.id===id);
        if(!p)return closed(a);
        symbol=p.symbol;
        // A new price level is rounded to Bybit's tick; removing a level needs no limits.
        const tick=[levels.sl,levels.tp].some(x=>finite(x)),contract=tick?await freshLimits(p.symbol):null;
        if(tick&&!contract)return no('Bybits prissteg för '+p.symbol+' saknas just nu — försök igen om en stund');
        const risk=await riskOf(p),quote=await ticker(p.symbol);
        accept(p.symbol,risk);accept(p.symbol,quote);
        let again='',soon=false,gone=false,behind=false,trade=null,result=null,converted=false;
        const next=await commit(user,token,current=>{
          const pos=current.positions.find(x=>x.id===id),t=now();
          if(!pos){gone=true;return null;}
          if(pos.fundingThrough>risk.fundingThrough){again='positionen ändrades under tiden, försök igen';return null;}
          const c=coverage(risk,pos,t);
          if(c.state!=='ok'){again=c.late+', försök igen om en stund';soon=c.state==='soon';return null;}
          let out=settlePosition(current,id,risk,t);
          if(risk.through!==undefined&&holds(out,id)){behind=true;return out;}
          if(holds(out,id))out=checkQuote(out,id,quote,t);
          if(!holds(out,id)){trade=out.trades.findLast(x=>x.id===id)??null;return out;}
          if(!fresh(quote,t)){again='Färskt pris saknas för '+pos.symbol;return null;}
          // Limits that aged on the way are read again rather than refusing the level.
          if(tick&&!usable(contract,t)){again='Bybits prissteg för '+pos.symbol+' saknas just nu';return null;}
          converted=pos.origin==='signal';
          result=withLevels(out,id,levels,{quote,contract,now:t});
          return result.account;
        });
        if(!next)return changed;
        if(gone)return closed(next);
        if(behind)continue;
        // A candle Bybit publishes a moment after its step begins is waited for, not read again at once.
        if(again){if(++attempt<3){if(soon)await pause(wait.soon);continue;}throw Error(again);}
        if(trade||!result)return no(trade?overtaken(trade,'ändringen'):'Positionen är redan stängd',{trade});
        if(!result.ok)return no(result.reason,{position:result.position});
        if(!result.changed)return {ok:true,text:'SL och TP är oförändrade',position:result.position,trade:null};
        return {ok:true,text:'Nya nivåer för '+levelsText(result.position,contract?.filters)+(converted?' — signalpositionen hanteras nu manuellt, utan tidsstopp':''),
          position:result.position,trade:null};
      }
    }catch(e){return no('Kunde inte ändra SL och TP för '+(symbol??'positionen')+': '+reasonOf(e));}
    finally{notify();}
  }
  async function autoOne(on){
    const user=sync();
    if(!user)return {ok:false,text:'Logga in för att ändra auto-handeln',account:null};
    if(typeof on!=='boolean')return {ok:false,text:'Ogiltigt läge för auto-handel',account:acct};
    try{
      const next=await commit(user,generation,a=>withAuto(a,on));
      if(!next)return {ok:false,text:'Kontot byttes medan ändringen sparades',account:null};
      prune();
      return {ok:true,account:next,text:on?'Auto-handel på: nya signaler handlas automatiskt':
        'Auto-handel av: du handlar manuellt. Öppna signalpositioner följer sina egna regler tills de stängs.'};
    }catch(e){return {ok:false,text:reasonOf(e),account:acct};}
    finally{notify();}
  }
  // A deposit or a withdrawal, booked in the ledger; apply throws the Swedish reason for a refusal.
  async function moneyOne(apply){
    const user=sync();
    if(!user)return {ok:false,text:'Logga in för att ändra saldot',account:null};
    let refused='',done=null;
    try{
      const next=await commit(user,generation,a=>{try{return done=apply(a);}catch(e){refused=reasonOf(e);return null;}});
      if(!next)return {ok:false,text:'Kontot byttes medan ändringen sparades',account:null};
      if(refused)return {ok:false,text:refused,account:next};
      const x=done.transfers.at(-1);
      return {ok:true,text:(x.kind==='in'?'Satte in ':'Tog ut ')+dollars(x.amount)+' · tillgängligt '+dollars(done.cash),account:next};
    }catch(e){return {ok:false,text:reasonOf(e),account:null};}
    finally{notify();}
  }
  function transferOne(x){
    const {kind,amount}=x&&typeof x==='object'?x:{};
    return moneyOne(a=>{
      if(kind!=='in'&&kind!=='out')throw Error('Välj insättning eller uttag');
      return kind==='in'?deposit(a,amount,now()):withdraw(a,amount,now());
    });
  }
  const PREVIEW_KEYS=['symbol','side','leverage','price','mark','fill','qty','value','margin','fee','reserve','cost','liq','maxLeverage','minMargin','maxMargin','sl','tp',
    'riskId','maintenance','deduction','filters'];
  // Without an account: why it cannot be read, or that it is still loading.
  const missingAccount=()=>error||'AI Forecast-kontot laddas';
  function quoteOrder(params){
    const user=sync(),p=params&&typeof params==='object'?params:{};
    const none=reason=>Object.freeze({ok:false,reasons:[reason],...Object.fromEntries(PREVIEW_KEYS.map(k=>[k,null]))});
    if(!user)return none('Logga in för att handla');
    if(!acct)return none(missingAccount());
    if(SYMBOLS.includes(p.symbol))refreshLimits(p.symbol);
    try{return previewOrder(acct,{...p,quote:quotes[p.symbol],contract:limitsNow(p.symbol),now:now()});}catch(e){return none(reasonOf(e));}
  }
  function quoteLevels(id,levels){
    const user=sync(),p=acct?.positions.find(x=>x.id===id)??null;
    const none=reason=>Object.freeze({ok:false,reasons:[reason],changed:false,sl:p?.sl??null,tp:p?.tp??null,price:null,liq:p?.liq??null,slPnl:null,tpPnl:null});
    if(!user)return none('Logga in för att ändra SL och TP');
    if(!acct)return none(missingAccount());
    if(p)refreshLimits(p.symbol);
    try{return previewLevels(acct,id,levels,{quote:p?quotes[p.symbol]:null,contract:p?limitsNow(p.symbol):null,now:now()});}catch(e){return none(reasonOf(e));}
  }
  // The coin the order ticket shows: its ticker is read on every tick (and once now, when it is not fresh), its limits kept.
  const quoteReads=new Set();
  function watch(symbol){
    watched=SYMBOLS.includes(symbol)?symbol:null;
    const s=watched;
    if(s){
      refreshLimits(s);
      if(!fresh(quotes[s],now())&&!quoteReads.has(s)){
        quoteReads.add(s);
        ticker(s).then(q=>{accept(s,q);notify();},()=>{}).finally(()=>quoteReads.delete(s));
      }
    }
    return watched;
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
    const base={auto:null,paused:null,open:null,manual:null,maxOpen:null,tf:null,nextDecision:null,data:{...data},unreliable:[],
      waiting:Object.fromEntries(Object.entries(waiting).map(([x,w])=>[x,w.why])),protection,error,archiveFull:full,notes:[...notes],last,busy:!!running,at:t};
    const idle=['inactive','Vilar — handlar när kryptosidan är öppen'];
    const out=([state,text],more={})=>Object.freeze({...base,...more,state,text});
    if(!user)return out(['signed-out','Logga in för att handla med AI Forecast-kontot']);
    if(!acct)return out(error?['error',error]:on?['loading','Laddar AI Forecast-kontot…']:idle);
    const s=acct.settings,ms=TF[s.tf].ms,next=(Math.floor((t+skew)/ms)+1)*ms,open=acct.positions.length,manual=acct.positions.filter(p=>p.origin==='manual').length;
    const unreliable=s.symbols.filter(x=>data[x]?.tf===s.tf&&!data[x].reliable);
    // A full archive is said once, plainly, instead of as one unsaved signal per coin.
    const pending=[protection,...Object.entries(waiting).filter(([,w])=>!(full&&w.unsaved)).map(([x,w])=>'ny affär i '+x+': '+w.why)].filter(Boolean);
    const more={auto:s.auto,paused:s.paused,open,manual,maxOpen:s.maxOpen,tf:s.tf,nextDecision:next,unreliable};
    if(error)return out(['error',error],more);
    if(!on)return out(idle,more);
    // Manual trading: signals are stored, nothing is traded on them; only the protection of open positions is waited for.
    if(!s.auto){
      if(protection)return out(['waiting','Väntar på '+protection],more);
      return out(['manual','Manuell handel · '+positions(open)+(full?' · prognosarkivet är fullt, nya signaler sparas inte':'')],more);
    }
    if(full)return out(['waiting',FULL+(pending.length?' · Väntar på '+pending.join(' · '):'')],more);
    if(pending.length)return out(['waiting','Väntar på '+pending.join(' · ')],more);
    if(s.paused)return out(['paused','Pausad'],more);
    if(unreliable.length)return out(['unreliable','Data opålitlig för '+unreliable.join(', ')+' — nya affärer pausade'],more);
    // maxOpen counts the signal positions; manual ones are named apart.
    return out(['trading','Handlar · '+(open-manual)+' av '+s.maxOpen+' positioner'+(manual?' · '+manual+(manual===1?' manuell':' manuella'):'')+
      ' · nästa beslut '+when(next,s.tf)],more);
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
    reset:resetAccount,
    setAuto:autoOne,
    order:orderOne,
    setLevels:levelsOne,
    transfer:transferOne,
    setFree:amount=>moneyOne(a=>withFree(a,amount,now())),
    quoteOrder,quoteLevels,watch,
    limits:symbol=>limitsNow(symbol)
  };
}
