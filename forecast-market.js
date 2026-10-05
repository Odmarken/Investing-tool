// Bybit market data for AI Forecast: public V5 kline, mark-price and funding
// endpoints through the page's grab(), linear USDT perpetuals only. Bybit's own
// server time decides which candles are closed, so a forming candle never
// reaches a signal or a forecast. Demo only: nothing here sends orders.
import {CONTRACTS,CONTRACT_UNITS} from './bybit-contracts.js';
import {TF} from './forecast-config.js';
export const POLL_MS=5000,STALE=Object.freeze({delayed:15000,stale:60000}),MAX_SKEW=120000;
// LONGEST_FUNDING: Bybit's longest funding interval (8 h). A longer gap between funding times is a missing time, and so
// is one at least twice the gaps on both sides of it; either is waited for while the funding after it is younger than this.
const API='https://api.bybit.com/v5/market/',PAGE=1000,MIN=60000,STEP=300000,DAY=86400000,WEEK=7*DAY,LONGEST_FUNDING=8*3600000;
const PAUSED=' — nya demoaffärer pausade';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
// Bybit sends numbers as strings; an empty string must not turn into 0.
const num=x=>typeof x==='number'?x:typeof x==='string'&&x.trim()!==''?Number(x):NaN;
const clockOf=now=>typeof now==='function'?now:finite(now)?()=>now:()=>Date.now();
const byTime=(a,b)=>a.t-b.t;
function frame(key){
  if(!Object.hasOwn(TF,key))throw Error('Okänd tidsram');
  return TF[key];
}
function contractOf(symbol){
  if(!Object.hasOwn(CONTRACTS,symbol))throw Error('Okänt perpetualkontrakt');
  return {contract:CONTRACTS[symbol],scale:CONTRACT_UNITS[symbol]};
}
// Weekly candles open on Monday 00:00 UTC (1970-01-05 was a Monday); shorter ones divide the epoch.
const bucket=(t,tf)=>tf.key==='1w'?Math.floor((t-4*DAY)/WEEK)*WEEK+4*DAY:Math.floor(t/tf.ms)*tf.ms;
const sv=n=>n.toLocaleString('sv-SE');
const candles=n=>n===1?'1 candle':sv(n)+' candles';
function duration(ms){
  const s=Math.round(Math.max(0,ms)/1000);
  return s<120?s+' s':s<7200?Math.round(s/60)+' min':sv(Math.round(s/3600))+' h';
}

/**
 * One Bybit V5 kline answer → ascending {t,o,h,l,c,v} (v = turnover in USDT).
 * SHIB/PEPE contracts quote 1000 tokens, so prices are divided back to one token.
 */
export function parseKlines(json,symbol,tfKey,now){
  const tf=frame(tfKey),{contract,scale}=contractOf(symbol),at=clockOf(now)(),serverTime=json?.time;
  if(json?.retCode!==0||json.result?.category!=='linear'||json.result.symbol!==contract||!Array.isArray(json.result.list)||
    !finite(serverTime)||Math.abs(at-serverTime)>MAX_SKEW)throw Error('Färska priser saknas för '+symbol);
  const bars=json.result.list.map(r=>{
    const n=Array.isArray(r)?r.slice(0,7).map(num):[];
    const b={t:n[0],o:n[1]/scale,h:n[2]/scale,l:n[3]/scale,c:n[4]/scale,v:n[6]};
    // A candle opening after Bybit's own clock cannot exist (1 s allows for clocks inside Bybit;
    // such a candle is never closed, and splitForming leaves it out).
    if(n.length<7||!Number.isSafeInteger(b.t)||bucket(b.t,tf)!==b.t||b.t>serverTime+1000||![b.o,b.h,b.l,b.c].every(positive)||
      !finite(n[5])||n[5]<0||!finite(b.v)||b.v<0||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c))throw Error('Ogiltig candle för '+symbol);
    return b;
  }).sort(byTime);
  if(bars.some((b,i)=>i&&b.t===bars[i-1].t))throw Error('Ogiltig candle för '+symbol);
  return {bars,serverTime};
}

export async function fetchKlines(grab,symbol,tfKey,{limit=PAGE,end=null,now=()=>Date.now(),timeout=8000,budget=0}={}){
  const tf=frame(tfKey),{contract}=contractOf(symbol);
  if(!Number.isInteger(limit)||limit<1||limit>PAGE||end!==null&&!finite(end))throw Error('Ogiltig candlebegäran');
  const params={category:'linear',symbol:contract,interval:tf.bybit,limit:String(limit)};
  if(end!==null)params.end=String(Math.floor(end));
  const j=await grab(API+'kline?'+new URLSearchParams(params),budget?{json:true,timeout,budget}:{json:true,timeout});
  return parseKlines(j,symbol,tfKey,now);
}

/**
 * The newest `count` candles, paging backwards (end = oldest − 1) until there are
 * enough or Bybit has nothing older (the listing start). The first page's server
 * time is returned: it is the moment the newest candle was read, so it alone may
 * decide whether that candle had closed.
 */
export async function fetchHistory(grab,symbol,tfKey,{count=2000,now=()=>Date.now()}={}){
  if(!Number.isInteger(count)||count<1)throw Error('Ogiltig candlebegäran');
  const seen=new Map();let end=null,serverTime=null;
  for(let pages=0;seen.size<count;pages++){
    if(pages>Math.ceil(count/PAGE)+3)throw Error('Prishistoriken kunde inte hämtas för '+symbol);
    const page=await fetchKlines(grab,symbol,tfKey,{limit:Math.min(PAGE,count-seen.size),end,now});
    serverTime??=page.serverTime;
    // Anything newer than the requested end is a repeat; a page without older candles ends the history.
    const older=end===null?page.bars:page.bars.filter(b=>b.t<=end);
    if(!older.length)break;
    for(const b of older)if(!seen.has(b.t))seen.set(b.t,b);
    end=older[0].t-1;
  }
  return {bars:[...seen.values()].sort(byTime).slice(-count),serverTime};
}

// A candle is closed once its close time has passed on Bybit's clock.
export function splitForming(bars,tfKey,serverTime){
  const tf=frame(tfKey);
  if(!finite(serverTime))throw Error('Servertid saknas');
  const closed=[];let forming=null;
  for(const b of bars){
    if(b.t+tf.ms<=serverTime)closed.push(b);
    else if(b.t<=serverTime&&(!forming||b.t>forming.t))forming=b;
  }
  return {closed,forming};
}

export function findGaps(bars,tfKey){
  const tf=frame(tfKey),gaps=[];
  for(let i=1;i<bars.length;i++){
    const step=bars[i].t-bars[i-1].t;
    if(step>tf.ms)gaps.push({after:bars[i-1].t,missing:Math.round(step/tf.ms)-1});
  }
  return gaps;
}

/**
 * base: the closed candles known so far. incoming: a newer Bybit page read at
 * serverTime (it may end with the forming candle). Returns every candle
 * ascending (the forming one last), the candles that are newly known closed,
 * and the times of closed candles Bybit changed afterwards: the array takes
 * Bybit's values, as market data, while stored signals and forecasts stay as
 * they were.
 */
export function mergeBars(base,incoming,tfKey,serverTime){
  const tf=frame(tfKey);
  if(!finite(serverTime))throw Error('Servertid saknas');
  const known=new Map(base.map(b=>[b.t,b])),out=new Map(known),closedNew=[],revised=[];
  for(const b of new Map(incoming.map(b=>[b.t,b])).values()){
    const old=known.get(b.t),closed=b.t+tf.ms<=serverTime;
    if(!old){out.set(b.t,b);if(closed)closedNew.push(b);}
    else if(!closed)out.set(b.t,b);
    else if(['o','h','l','c','v'].some(k=>old[k]!==b[k])){out.set(b.t,b);revised.push(b.t);}
  }
  return {bars:[...out.values()].sort(byTime),closedNew:closedNew.sort(byTime),revised:revised.sort((a,b)=>a-b)};
}

/**
 * Live candles for one coin and timeframe. load() reads `count` candles; poll()
 * reads the newest three and merges them. Candles missing between what was
 * known and the new page are fetched once by range; whatever Bybit still lacks
 * stays in `gaps`. Errors never throw: they are kept in lastError ({at,message})
 * for dataStatus. Calls run one at a time; a poll during another call is skipped.
 */
export function createLiveSeries({grab,symbol,tf,now=()=>Date.now(),count=2000}){
  const frameOf=frame(tf),clock=clockOf(now),ms=frameOf.ms;
  contractOf(symbol);
  if(!Number.isInteger(count)||count<1)throw Error('Ogiltig candlebegäran');
  let bars=[],forming=null,serverTime=null,lastOk=null,lastError=null,gaps=[],revised=[],loading=false;
  const tried=new Set(),gapKey=g=>g.after+':'+g.missing;
  const state=()=>({bars:bars.slice(),forming,serverTime,lastOk,lastError,gaps:gaps.slice(),revised:revised.slice(),loading});
  function commit(closed,form,time,changed){
    bars=closed.slice(-count);bars.forEach(b=>Object.freeze(b));
    forming=form?Object.freeze(form):null;serverTime=time;lastOk=clock();lastError=null;
    gaps=findGaps(forming?[...bars,forming]:bars,tf).map(g=>Object.freeze(g));
    revised=[...new Set([...revised,...changed])].slice(-100);
  }
  const failed=e=>{
    const at=clock();
    // Failing while the clock reads earlier than the last good read: the clock was set back,
    // so how old the candles are is unknown until Bybit answers again.
    if(finite(lastOk)&&at<lastOk)lastOk=null;
    lastError=Object.freeze({at,message:String(e?.message??e)});
  };
  // History merges into what is known, so a reload also reports revised candles;
  // older known candles are dropped, since they may not connect to the new window.
  async function reload(){
    const h=await fetchHistory(grab,symbol,tf,{count,now:clock}),had=serverTime!==null,start=h.bars.length?h.bars[0].t:-Infinity;
    const m=mergeBars(bars,h.bars,tf,h.serverTime),changed=had?m.revised:[];
    const {closed,forming:form}=splitForming(m.bars.filter(b=>b.t>=start),tf,h.serverTime);
    commit(closed,form,h.serverTime,changed);
    // Gaps in a complete history are Bybit's own: refetching them would return the same.
    for(const g of gaps)tried.add(gapKey(g));
    return {closedNew:had&&bars.length?m.closedNew.filter(b=>b.t>=bars[0].t):[],revised:changed};
  }
  async function doLoad(){
    loading=true;
    try{await reload();}catch(e){failed(e);}finally{loading=false;}
    return state();
  }
  // Candles inside one gap, newest page first.
  async function fetchGap(g){
    const out=[];let end=g.after+g.missing*ms,left=g.missing;
    for(let pages=0;left>0&&pages<=Math.ceil(g.missing/PAGE);pages++){
      const page=await fetchKlines(grab,symbol,tf,{limit:Math.min(PAGE,left),end,now:clock});
      const got=page.bars.filter(b=>b.t>g.after&&b.t<=end);
      if(!got.length)break;
      out.push(...got);end=got[0].t-1;left=Math.round((got[0].t-g.after)/ms)-1;
    }
    return out;
  }
  async function doPoll(){
    if(serverTime===null){const st=await doLoad();return st.lastError?{closedNew:[],revised:[],error:st.lastError.message}:{closedNew:[],revised:[]};}
    try{
      const page=await fetchKlines(grab,symbol,tf,{limit:3,now:clock,timeout:4000,budget:4500});
      // Not newer than what we have (e.g. a cached proxy answer): nothing to learn, and not a fresh read.
      if(page.serverTime<=serverTime)return {closedNew:[],revised:[]};
      const m=mergeBars(bars,page.bars,tf,page.serverTime),closedNew=[...m.closedNew],changed=[...m.revised];
      let {closed,forming:form}=splitForming(m.bars,tf,page.serverTime);
      const fresh=findGaps(form?[...closed,form]:closed,tf).filter(g=>!tried.has(gapKey(g)));
      // Away for longer than the whole window (e.g. a sleeping laptop): reload it instead.
      if(fresh.some(g=>g.missing>=count))return await reload();
      for(const g of fresh){
        const filled=mergeBars(closed,await fetchGap(g),tf,page.serverTime);
        closed=splitForming(filled.bars,tf,page.serverTime).closed;closedNew.push(...filled.closedNew);changed.push(...filled.revised);
      }
      commit(closed,form,page.serverTime,changed);
      // One refetch per gap: what is still missing is Bybit's gap and stays reported.
      for(const g of gaps)tried.add(gapKey(g));
      return {closedNew:closedNew.sort(byTime),revised:changed.sort((a,b)=>a-b)};
    }catch(e){failed(e);return {closedNew:[],revised:[],error:lastError.message};}
  }
  let queue=Promise.resolve(),busy=0;
  const serial=fn=>{busy++;const p=queue.then(fn).finally(()=>{busy--;});queue=p.catch(()=>{});return p;};
  return {symbol,tf,
    load:()=>serial(doLoad),
    poll:()=>busy?Promise.resolve({closedNew:[],revised:[],skipped:true}):serial(doPoll),
    state};
}

/**
 * Whether the candles behind a chart or a decision are current. Only 'live' is
 * reliable: Bybit answered within STALE.delayed, its clock agrees with ours,
 * the forming candle is the current period and the one before it is the last
 * closed candle, and the last `lookback` closed candles have no gaps.
 * state: createLiveSeries().state() or the same shape (gaps are recounted from bars).
 */
export function dataStatus(state,now,tfKey,{lookback=400}={}){
  const tf=frame(tfKey),at=clockOf(now)(),lastOk=state?.lastOk;
  lookback=finite(lookback)&&lookback>=1?Math.ceil(lookback):1;
  const out=(s,text,ageMs=null)=>({state:s,reliable:s==='live',text,ageMs});
  if(!finite(lastOk))return state?.lastError&&!state.loading?out('error','Data saknas'+PAUSED):out('loading','Hämtar data…');
  // A clock set back after the last read would make any old read look fresh, and the failures
  // since then look older than it; beyond MAX_SKEW the age of the data is unknown.
  if(lastOk-at>MAX_SKEW)return out('error','Datorns klocka skiljer sig från Bybit ('+duration(lastOk-at)+')'+PAUSED);
  const ageMs=Math.max(0,at-lastOk),err=state.lastError,failed=!!err&&!(finite(err.at)&&err.at<lastOk);
  if(failed&&ageMs>STALE.delayed)return out('error','Data saknas'+PAUSED,ageMs);
  if(ageMs>STALE.stale)return out('stale','Inaktuell data ('+duration(ageMs)+')'+PAUSED,ageMs);
  if(ageMs>STALE.delayed)return out('delayed','Fördröjd data ('+duration(ageMs)+')'+PAUSED,ageMs);
  if(!finite(state.serverTime))return out('error','Servertid saknas'+PAUSED,ageMs);
  const skew=state.serverTime-lastOk;
  if(Math.abs(skew)>MAX_SKEW)return out('error','Datorns klocka skiljer sig från Bybit ('+duration(Math.abs(skew))+')'+PAUSED,ageMs);
  const closed=Array.isArray(state.bars)?state.bars:[],forming=state.forming??null,tail=closed.slice(-lookback);
  const missing=findGaps(forming?[...tail,forming]:tail,tfKey).reduce((n,g)=>n+g.missing,0);
  if(missing)return out('gap','Lucka i datan ('+candles(missing)+' saknas)'+PAUSED,ageMs);
  if(closed.length<lookback)return out('gap','För kort historik ('+sv(closed.length)+' av '+sv(lookback)+' candles)'+PAUSED,ageMs);
  // Bybit's clock now, from its last answer plus the time since.
  const current=bucket(state.serverTime+ageMs,tf);
  if(forming?.t!==current||tail.at(-1).t!==current-tf.ms)return out('delayed','Väntar på ny candle'+PAUSED,ageMs);
  return out('live','Live · uppdaterad '+Math.round(ageMs/1000)+' s sedan',ageMs);
}

// Funding rates with from ≤ t ≤ to, ascending, paged backwards 200 at a time by endTime.
export async function fetchFunding(grab,symbol,{from,to,now=()=>Date.now()}={}){
  const {contract}=contractOf(symbol),clock=clockOf(now);
  to??=clock();
  if(!finite(from)||!finite(to)||from>to)throw Error('Ogiltigt fundingintervall');
  const rates=new Map();let end=Math.floor(to);
  for(let pages=0;end>=from;pages++){
    if(pages>=200)throw Error('Fundinghistoriken kunde inte hämtas för '+symbol);
    const j=await grab(API+'funding/history?'+new URLSearchParams({category:'linear',symbol:contract,endTime:String(end),limit:'200'}),{json:true,timeout:8000});
    if(j?.retCode!==0||j.result?.category!=='linear'||!Array.isArray(j.result.list)||!finite(j.time)||Math.abs(clock()-j.time)>MAX_SKEW)
      throw Error('Färsk fundinghistorik saknas för '+symbol);
    let oldest=Infinity;
    for(const r of j.result.list){
      const f={t:num(r?.fundingRateTimestamp),rate:num(r?.fundingRate)};
      if(r?.symbol!==contract||!Number.isSafeInteger(f.t)||f.t<=0||!finite(f.rate))throw Error('Ogiltig funding för '+symbol);
      if(f.t>end)continue;
      oldest=Math.min(oldest,f.t);
      if(f.t>=from)rates.set(f.t,f);
    }
    // Nothing at or before endTime: the listing start.
    if(oldest===Infinity)break;
    end=oldest-1;
  }
  return [...rates.values()].sort(byTime);
}

// A public derivatives answer for an open position, checked as crypto-momentum-market.js's fetchDerivatives
// checks it: a linear list, and Bybit's clock at most 5 s ahead of ours and 2 minutes behind it.
async function derivative(grab,symbol,path,params,clock){
  const {contract}=contractOf(symbol);
  const j=await grab(API+path+'?'+new URLSearchParams({category:'linear',symbol:contract,...params}),{json:true,timeout:8000});
  if(j?.retCode!==0||!Array.isArray(j.result?.list)||!finite(j.time)||j.time>clock()+5000||clock()-j.time>MAX_SKEW)throw Error('Färskt derivatsvar saknas för '+symbol);
  return j;
}
// One row [t,o,h,l,c,…] of a kline or mark-price-kline answer on a `step` grid, per token; null if invalid.
function priceBar(r,scale,step){
  const n=Array.isArray(r)?r.slice(0,5).map(num):[],b={t:n[0],o:n[1]/scale,h:n[2]/scale,l:n[3]/scale,c:n[4]/scale};
  return n.length<5||!Number.isSafeInteger(b.t)||b.t%step||![b.o,b.h,b.l,b.c].every(positive)||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c)?null:b;
}
// Mark-price 5-minute candles from `from` through the current one, paged backwards, without a gap.
async function markPriceBars(grab,symbol,from,clock){
  const {contract,scale}=contractOf(symbol),bars=new Map();let end=clock();
  for(let pages=0;end>=from;pages++){
    if(pages>=40)throw Error('För lång frånvaro: markprishistoriken kunde inte återställas');
    const limit=Math.min(PAGE,Math.max(2,Math.ceil((end-from)/STEP)+1));
    const j=await derivative(grab,symbol,'mark-price-kline',{interval:'5',limit:String(limit),end:String(Math.floor(end))},clock);
    if(j.result.category!=='linear'||j.result.symbol!==contract||!j.result.list.length)throw Error('Markpriser saknas för '+symbol);
    let oldest=Infinity;
    for(const r of j.result.list){
      const b=priceBar(r,scale,STEP);
      if(!b)throw Error('Ogiltig markprisstapel för '+symbol);
      oldest=Math.min(oldest,b.t);
      if(b.t>=from&&b.t<=clock())bars.set(b.t,b);
    }
    if(oldest-1>=end)throw Error('Markprispaginering stannade för '+symbol);
    end=oldest-1;
  }
  const out=[...bars.values()].sort(byTime);
  if(out[0]?.t!==from||out.some((b,i)=>i&&b.t-out[i-1].t!==STEP))throw Error('Lucka i markpriser för '+symbol);
  return out;
}

// Last-price 5-minute candles from `from` through the current one, paged backwards.
async function lastPriceBars(grab,symbol,from,clock){
  if(from>Math.floor(clock()/STEP)*STEP)return [];
  const bars=new Map();let end=clock();
  for(let pages=0;end>=from;pages++){
    if(pages>=40)throw Error('För lång frånvaro: prishistoriken kunde inte återställas');
    const limit=Math.min(PAGE,Math.max(2,Math.ceil((end-from)/STEP)+1));
    const page=await fetchKlines(grab,symbol,'5m',{limit,end,now:clock});
    const got=page.bars.filter(b=>b.t<=end);
    if(!got.length)throw Error('Senaste priser saknas för '+symbol);
    for(const b of got)if(b.t>=from&&b.t<=clock())bars.set(b.t,b);
    end=got[0].t-1;
  }
  const out=[...bars.values()].sort(byTime);
  if(out[0]?.t!==from||out.some((b,i)=>i&&b.t-out[i-1].t!==STEP))throw Error('Lucka i senaste priser för '+symbol);
  return out;
}

// Bybit's 1-minute candles ('kline' for the last price, 'mark-price-kline' for the mark) with from ≤ t < to and
// t ≤ now, ascending, as Bybit has them: settlePosition decides which minutes it cannot do without.
async function minuteBars(grab,symbol,path,from,to,clock){
  const {contract,scale}=contractOf(symbol),end=Math.min(to-1,clock());
  if(end<from)return [];
  const j=await derivative(grab,symbol,path,{interval:'1',limit:String(Math.min(PAGE,Math.floor((end-from)/MIN)+1)),end:String(Math.floor(end))},clock);
  if(j.result.category!=='linear'||j.result.symbol!==contract)throw Error('1-minuterspriser saknas för '+symbol);
  const bars=new Map();
  for(const r of j.result.list){
    const b=priceBar(r,scale,MIN);
    if(!b)throw Error('Ogiltig 1-minuterscandle för '+symbol);
    if(b.t>=from&&b.t<to&&b.t<=clock())bars.set(b.t,b);
  }
  return [...bars.values()].sort(byTime);
}

/**
 * Everything an open demo position needs to settle: the ticker, mark-price
 * 5-minute candles from the last settlement's step, funding since the last
 * settlement, and last-price 5-minute candles since position.nextBar for the
 * stop and the target. While the position may still be in the step it opened
 * in (nextBar not past that step's successor), also the mark-price and
 * last-price 1-minute candles of that step from the minute after position.openedAt.
 * → {price,mark,at,markBars,lastBars,minuteMarks,minuteLasts,funding,fundingThrough,historyFrom}
 * Read here rather than with crypto-momentum-market.js's fetchDerivatives (which
 * AI-momentum keeps using as it is), because Bybit changes a contract's funding
 * interval now and then (SOL went from 8 to 2 hours on 10 November 2022): its
 * check that funding times lie at most the current interval apart then fails
 * for good for a position held across the change. Here the funding is complete
 * when the newest time is at most the current interval before Bybit's next one
 * and no gap since the last settlement looks like a missing time: longer than
 * Bybit's longest interval, 8 hours, or at least twice the gaps on both sides of
 * it (the newest gap's other side runs to Bybit's next time). A lone missing time
 * doubles a gap of a steady 1-, 2- or 4-hour schedule, while the gap across a
 * change of interval is shorter than the old and the new interval together, so
 * never twice both, and a change never looks like one; a time missing right at
 * a change cannot be told from it. A missing
 * time is waited for while the funding after it is less than 8 hours old. After
 * that the gap is Bybit's own record (a settlement it skipped, or an interval it
 * kept for a single funding) and is settled as Bybit has it, so no position can
 * stay unsettleable for good. Every read ends before the clock is read for
 * fundingThrough, and Bybit's next funding time must still lie after it.
 */
export async function fetchPositionRisk(grab,symbol,position,now){
  const {contract,scale}=contractOf(symbol);
  if(!position||!finite(position.nextBar)||position.nextBar%STEP||!finite(position.fundingThrough))throw Error('Ogiltig position');
  const clock=clockOf(now),settled=position.fundingThrough,from=Math.min(position.nextBar,Math.floor(settled/STEP)*STEP);
  const first=finite(position.openedAt)?(Math.floor(position.openedAt/STEP)+1)*STEP:-Infinity,opening=position.nextBar<=first;
  const minutes=path=>opening?minuteBars(grab,symbol,path,Math.ceil(position.openedAt/MIN)*MIN,first,clock):[];
  const [ticker,info,markBars,lastBars,rates,minuteMarks,minuteLasts]=await Promise.all([derivative(grab,symbol,'tickers',{},clock),
    derivative(grab,symbol,'instruments-info',{},clock),markPriceBars(grab,symbol,from,clock),lastPriceBars(grab,symbol,position.nextBar,clock),
    fetchFunding(grab,symbol,{from:settled-LONGEST_FUNDING,to:clock(),now:clock}),minutes('mark-price-kline'),minutes('kline')]);
  const q=ticker.result.list.find(x=>x?.symbol===contract),instrument=info.result.list.find(x=>x?.symbol===contract);
  const price=num(q?.lastPrice)/scale,mark=num(q?.markPrice)/scale,next=num(q?.nextFundingTime),interval=num(instrument?.fundingInterval)*60000,t=clock();
  if(!positive(price)||!positive(mark))throw Error('Ogiltigt derivatpris för '+symbol);
  if(!positive(interval)||!positive(next)||next<=t||next-t>interval+MAX_SKEW)throw Error('Fundingintervall saknas eller håller på att växla för '+symbol);
  // gap(i): from the funding time before rates[i] (none within 8 h before the last settlement: unbounded) to rates[i].
  const gap=i=>i?rates[i].t-rates[i-1].t:Infinity,after=i=>i+1<rates.length?gap(i+1):next-rates[i].t;
  const missing=i=>gap(i)>LONGEST_FUNDING||i>1&&gap(i)>=2*gap(i-1)&&gap(i)>=2*after(i);
  if(!rates.length||rates.at(-1).t<next-interval||rates.some((f,i)=>f.t>settled&&t-f.t<LONGEST_FUNDING&&missing(i)))
    throw Error('Fundinghistoriken är ännu inte komplett för '+symbol);
  return {price,mark,at:ticker.time,markBars,lastBars,minuteMarks,minuteLasts,funding:rates.filter(f=>f.t>settled&&f.t<=t),fundingThrough:t,historyFrom:from};
}
