// Shared test data for AI Forecast: a scripted market on any timeframe (a quiet
// range, a zigzag uptrend whose volume spikes trigger long breakouts, a zigzag
// down leg with short breakdowns, then quiet again), Bybit's limits as
// parseContract returns them, and a fake Bybit V5 market API that serves every
// public endpoint the runner and the page read, all from that one price path.
import {TF,SYMBOLS} from '../forecast-config.js';
import {requiredLookback,computeIndicators,aggregateClosed,evaluateBar,signalsInRange} from '../forecast-model.js';
import {CONTRACTS,CONTRACT_UNITS,orderFilters} from '../bybit-contracts.js';

export const MIN=60000,STEP=300000,HOUR=3600000,DAY=86400000,WEEK=7*DAY,FUND=8*HOUR;
// A Monday 00:00 UTC, so every bucket from 5 minutes to the week starts with the data.
export const START=Date.UTC(2026,5,1);
// Token prices of the unit path (SHIB and PEPE per token; the API quotes them per 1000).
export const SCALE=Object.freeze({BTC:60000,ETH:3000,SOL:150,XRP:.6,DOGE:.2,SHIB:.000012,PEPE:.00001});
export const MAX_LEVERAGE=Object.freeze({BTC:100,ETH:100,SOL:50,XRP:75,DOGE:75,SHIB:50,PEPE:50});
// Bybit's order filters as its instruments-info listed them on 6 October 2026, in Bybit's units: SHIB1000USDT and
// 1000PEPEUSDT count 1000 tokens per unit of quantity and quote the price of 1000 tokens.
export const LOT=Object.freeze({
  BTC:Object.freeze({qtyStep:'0.001',minOrderQty:'0.001',maxOrderQty:'1500.000',maxMktOrderQty:'150.000',minNotionalValue:'5',tickSize:'0.10'}),
  ETH:Object.freeze({qtyStep:'0.01',minOrderQty:'0.01',maxOrderQty:'10000.00',maxMktOrderQty:'2000.00',minNotionalValue:'5',tickSize:'0.01'}),
  SOL:Object.freeze({qtyStep:'0.1',minOrderQty:'0.1',maxOrderQty:'96000.0',maxMktOrderQty:'12000.0',minNotionalValue:'5',tickSize:'0.010'}),
  XRP:Object.freeze({qtyStep:'0.1',minOrderQty:'0.1',maxOrderQty:'7500000.0',maxMktOrderQty:'1500000.0',minNotionalValue:'5',tickSize:'0.0001'}),
  DOGE:Object.freeze({qtyStep:'1',minOrderQty:'1',maxOrderQty:'43678900',maxMktOrderQty:'5991100',minNotionalValue:'5',tickSize:'0.00001'}),
  SHIB:Object.freeze({qtyStep:'10',minOrderQty:'10',maxOrderQty:'134076000',maxMktOrderQty:'15555000',minNotionalValue:'5',tickSize:'0.000001'}),
  PEPE:Object.freeze({qtyStep:'100',minOrderQty:'100',maxOrderQty:'110000000',maxMktOrderQty:'42000000',minNotionalValue:'5',tickSize:'0.0000010'})});
// instruments-info's lotSizeFilter and priceFilter for these values (null: Bybit sends none).
export function lotFilters(lot){
  if(!lot)return {};
  return {lotSizeFilter:{maxOrderQty:lot.maxOrderQty,minOrderQty:lot.minOrderQty,qtyStep:lot.qtyStep,postOnlyMaxOrderQty:lot.maxOrderQty,
    maxMktOrderQty:lot.maxMktOrderQty,minNotionalValue:lot.minNotionalValue},priceFilter:{minPrice:lot.tickSize,maxPrice:'1999999.80',tickSize:lot.tickSize}};
}
// The filters as parseContract returns them, per token.
export const filtersFor=(symbol,lot=LOT[symbol])=>orderFilters(symbol,lotFilters(lot));
export const FUNDING_RATE=.0001;
const INTERVAL=Object.freeze({'1':MIN,'5':STEP,'15':15*MIN,'60':HOUR,'240':4*HOUR,'D':DAY,'W':WEEK});
const bucket=(t,ms)=>ms===WEEK?Math.floor((t-4*DAY)/WEEK)*WEEK+4*DAY:Math.floor(t/ms)*ms;

// Random access noise: the same (seed, bar, slot) always gives the same number in [0,1).
function draw(seed,i,k){
  let h=Math.imul(seed,0x9e3779b1)^Math.imul(i+0x632be5ab,0x85ebca6b)^Math.imul(k+0x2f,0xc2b2ae35);
  h=Math.imul(h^(h>>>16),0x45d9f3b);h=Math.imul(h^(h>>>16),0x45d9f3b);h^=h>>>16;
  return (h>>>0)/4294967296;
}
// One bar in log price. The range keeps closes within ±0.2 % of its level; a trend
// leg alternates a 1 % move with a 0.6 % pullback (mirrored for the down leg), so
// every leg bar breaks the channel and only the volume spikes complete a signal.
function patternBar(seed,i,x,leg,k,level){
  const r=n=>draw(seed,i,n),o=x;let c,hi,lo;
  if(leg===0){c=level+.002*(2*r(1)-1);hi=Math.max(o,c)+.0005+.001*r(2);lo=Math.min(o,c)-.0005-.001*r(3);}
  else{
    c=o+leg*(k%2===0?.010+.002*(r(1)-.5):-.006+.002*(r(1)-.5));
    const w1=.0005+.001*r(2),w2=.0005+.001*r(3);
    hi=Math.max(o,c)+(leg>0?w1:w2);lo=Math.min(o,c)-(leg>0?w2:w1);
  }
  return {o,c,hi,lo,v:Math.round(1e6*(1+.04*(r(4)-.5)))};
}
function build({tf,start,quiet,up,down,seed,spikes}){
  const ms=TF[tf].ms,end=quiet+up+down,out=[];let x=0;
  for(let i=0;i<end;i++){
    const leg=i<quiet?0:i<quiet+up?1:-1,k=leg>0?i-quiet:i-quiet-up,b=patternBar(seed,i,x,leg,k,0);
    x=b.c;out.push(unitBar(start+i*ms,b,spikes.has(i)));
  }
  return {bars:out,level:x};
}
const unitBar=(t,b,spike)=>Object.freeze({t,o:Math.exp(b.o),h:Math.exp(b.hi),l:Math.exp(b.lo),c:Math.exp(b.c),v:spike?Math.round(b.v*2.5):b.v});
// Exact pieces of a bar (5-minute pieces of a bar, 1-minute pieces of a 5-minute one): a log-linear path from
// open to close with the wick at the end of the move, so they aggregate back to the bar exactly.
function split(b,m,dt=STEP){
  if(m===1)return [b];
  const lo=Math.log(b.o),d=Math.log(b.c)-lo,up=b.c>=b.o,base=Math.floor(b.v/m),extra=b.v-base*m,out=[];
  const at=q=>q===0?b.o:q===m?b.c:Math.exp(lo+d*q/m);
  for(let q=0;q<m;q++){
    const o=at(q),c=at(q+1);let h=Math.max(o,c),l=Math.min(o,c);
    if(up?q===m-1:q===0)h=b.h;
    if(up?q===0:q===m-1)l=b.l;
    out.push(Object.freeze({t:b.t+q*dt,o,h,l,c,v:base+(q<extra?1:0)}));
  }
  return out;
}

const markets=new Map();
/**
 * A scripted market in unit prices on the grid of `tf`: `quiet` range bars
 * (enough for every indicator and the higher timeframe), `up` zigzag bars up,
 * `down` zigzag bars down, then a range forever. Volume spikes go on the first
 * `longs` up-leg bars (and `shorts` down-leg bars) where every rule except volume
 * holds, at least `spacing` bars apart, and the fixture checks that exactly
 * those bars signal. bar(i) and sub(k) give any bar or 5-minute piece.
 */
export function scriptMarket({tf='1h',start=START,quiet=null,up=200,down=200,longs=3,shorts=2,spacing=8,seed=3}={}){
  if(!Object.hasOwn(TF,tf)||tf==='1w')throw Error('Okänd tidsram '+tf);
  quiet??=requiredLookback(tf)+40;
  const key=[tf,start,quiet,up,down,longs,shorts,spacing,seed].join('|');
  if(markets.has(key))return markets.get(key);
  const ms=TF[tf].ms,end=quiet+up+down,opts={tf,start,quiet,up,down,seed};
  const pick=(plain,from,to,side,n)=>{
    const out=[];if(!n)return out;
    const ind=computeIndicators(plain),htfBars=aggregateClosed(plain,tf,TF[tf].htf,plain.at(-1).t+ms);
    for(let i=from;i<to&&out.length<n;i++){
      if(out.length&&i<out.at(-1)+spacing)continue;
      const e=evaluateBar(plain,i,{tf,ind,htfBars});
      if(e.regime===(side==='long'?'trend-up':'trend-down')&&e.checks.every(c=>c.ok||c.key==='volume'))out.push(i);
    }
    if(out.length<n)throw Error(`Fixture: only ${out.length} ${side} candidates on ${tf}`);
    return out;
  };
  const plain=build({...opts,spikes:new Set()}).bars;
  const longAt=pick(plain,quiet,quiet+up,'long',longs),shortAt=pick(plain,quiet+up,end,'short',shorts);
  const {bars,level}=build({...opts,spikes:new Set([...longAt,...shortAt])});
  const expected=[...longAt.map(i=>[i,'long']),...shortAt.map(i=>[i,'short'])];
  if(bars.length){
    const got=signalsInRange(bars,0,bars.length-1,{tf}).map(e=>[(e.t-start)/ms,e.side]);
    if(JSON.stringify(got)!==JSON.stringify(expected))throw Error('Fixture: signals '+JSON.stringify(got)+' instead of '+JSON.stringify(expected));
  }
  const tail=new Map(),pieces=new Map(),m=ms/STEP;
  const bar=i=>{
    if(!Number.isInteger(i)||i<0)return null;
    if(i<end)return bars[i];
    if(!tail.has(i)){
      // The closing range is random access: each bar opens at the previous bar's close.
      const prev=i===end?(end?Math.log(bars[end-1].c):0):level+.002*(2*draw(seed,i-1,1)-1);
      tail.set(i,unitBar(start+i*ms,patternBar(seed,i,prev,0,0,level),false));
    }
    return tail.get(i);
  };
  const sub=k=>{
    if(!Number.isInteger(k)||k<0)return null;
    const j=Math.floor(k/m);
    if(!pieces.has(j))pieces.set(j,split(bar(j),m));
    return pieces.get(j)[k-j*m];
  };
  const signals=Object.freeze(expected.map(([i,side])=>Object.freeze({i,t:start+i*ms,close:start+(i+1)*ms,side})));
  const market=Object.freeze({tf,ms,start,quiet,up,down,end,signals,
    longs:Object.freeze(signals.filter(s=>s.side==='long')),shorts:Object.freeze(signals.filter(s=>s.side==='short')),
    bar,sub,index:t=>Math.floor((t-start)/ms),closeOf:i=>start+(i+1)*ms,
    bars:(from,to)=>Array.from({length:Math.max(0,to-from)},(_,k)=>bar(from+k))});
  markets.set(key,market);
  return market;
}

// Bybit's limits as parseContract returns them for fakeBybit's instruments-info and risk-limit, with the order filters.
export function limitsFor(symbol,at,max=MAX_LEVERAGE[symbol],lot=LOT[symbol]){
  const c={symbol,contract:CONTRACTS[symbol],max,min:1,step:.01,
    tiers:[{id:1,cap:2e6,max,maintenance:.005,deduction:0},{id:2,cap:1e7,max:max/2,maintenance:.01,deduction:1e4}],at};
  const filters=filtersFor(symbol,lot);
  return filters?{...c,filters}:c;
}

// localStorage with key()/length, as the account and the record archive use it.
export function memoryStorage(){
  const m=new Map();
  return {get length(){return m.size;},key:i=>[...m.keys()][i]??null,getItem:k=>m.has(k)?m.get(k):null,
    setItem(k,v){m.set(k,String(v));},removeItem(k){m.delete(k);},keys:()=>[...m.keys()]};
}
// navigator.locks: one exclusive queue per lock name, shared by every "tab" given it.
export function tabLocks(){
  const queues=new Map(),held=[];
  return {held,request(name,fn){
    const p=(queues.get(name)??Promise.resolve()).then(async()=>{held.push(name);try{return await fn({name,mode:'exclusive'});}finally{held.pop();}});
    queues.set(name,p.catch(()=>{}));return p;
  }};
}

const factorAt=(rt,symbol,t)=>(rt.shocks??[]).reduce((f,s)=>(s.symbol==null||s.symbol===symbol)&&s.at<=t?f*s.factor:f,1);
const shockInside=(rt,symbol,a,b)=>(rt.shocks??[]).some(s=>(s.symbol==null||s.symbol===symbol)&&s.at>a&&s.at<b);
const scaled=(b,f)=>f===1?b:{t:b.t,o:b.o*f,h:b.h*f,l:b.l*f,c:b.c*f,v:b.v};
function combine(t,pieces){
  if(!pieces.length)return null;
  let h=-Infinity,l=Infinity,v=0;
  for(const p of pieces){h=Math.max(h,p.h);l=Math.min(l,p.l);v+=p.v;}
  return {t,o:pieces[0].o,h,l,c:pieces.at(-1).c,v};
}
// A 5-minute piece in unit prices; the one containing `until` is still forming and
// ends at the current price (runtime.price/mark override it, in token prices, at Bybit's now).
function piece(m,symbol,s,until,rt,kind,live){
  const k=(s-m.start)/STEP;
  if(k<0||s>until)return null;
  const base=m.sub(k),f=factorAt(rt,symbol,s);
  if(s+STEP<=until)return scaled(base,f);
  const set=until===live?(kind==='mark'?rt.mark?.[symbol]??rt.price?.[symbol]:rt.price?.[symbol]):undefined;
  const o=base.o*f,c=set!==undefined?set/SCALE[symbol]:(base.o+(base.c-base.o)*(until-s)/STEP)*f;
  return {t:s,o,h:Math.max(o,c),l:Math.min(o,c),c,v:base.v};
}
// A 1-minute piece in unit prices: a closed 5-minute piece split in five; inside the forming 5-minute piece the
// minutes follow piece()'s path and the forming minute ends at the current price. runtime.wicks adds a wick that
// only the 1-minute candle shows.
function minutePiece(m,symbol,s,until,rt,kind,live){
  const p=Math.floor(s/STEP)*STEP,k=(p-m.start)/STEP;
  if(k<0||s>until)return null;
  const base=m.sub(k),f=factorAt(rt,symbol,p);
  let b;
  if(p+STEP<=until)b=scaled(split(base,5,MIN)[(s-p)/MIN],f);
  else{
    const at=x=>(base.o+(base.c-base.o)*x/STEP)*f,o=at(s-p);
    const set=until===live&&s+MIN>until?(kind==='mark'?rt.mark?.[symbol]??rt.price?.[symbol]:rt.price?.[symbol]):undefined;
    const c=set!==undefined?set/SCALE[symbol]:at(Math.min(s+MIN,until)-p);
    b={t:s,o,h:Math.max(o,c),l:Math.min(o,c),c,v:Math.floor(base.v/5)};
  }
  const w=(rt.wicks??[]).find(x=>x.symbol===symbol&&x.at===s&&(x.kind==null||x.kind===kind));
  return w?{...b,h:Math.max(b.h,(w.h??0)/SCALE[symbol]),l:Math.min(b.l,(w.l??Infinity)/SCALE[symbol])}:b;
}
// One candle of any interval from the scripted bars: whole closed bars where no
// shock falls inside them, otherwise their 5-minute pieces (or a 1-minute piece).
function candleOf(m,symbol,t,iv,until,rt,kind,live){
  if(t>until||t+iv<=m.start)return null;
  if(iv<STEP)return iv===MIN?minutePiece(m,symbol,t,until,rt,kind,live):null;
  const out=[];
  if(iv>=m.ms&&iv%m.ms===0){
    for(let s=Math.max(t,m.start);s<t+iv&&s<=until;s+=m.ms){
      const b=m.bar((s-m.start)/m.ms),end=s+m.ms;
      if(end<=until&&!shockInside(rt,symbol,s,end))out.push(scaled(b,factorAt(rt,symbol,s)));
      else for(let p=s;p<end&&p<=until;p+=STEP)out.push(piece(m,symbol,p,until,rt,kind,live));
    }
  }else for(let s=Math.max(t,m.start);s<t+iv&&s<=until;s+=STEP)out.push(piece(m,symbol,s,until,rt,kind,live));
  return combine(t,out.filter(Boolean));
}

// Funding times at or before `end`, newest first: every 8 hours, or, with runtime.fundingSwitch {at,every}
// (`at` on the 8-hour grid), every `every` ms after `at`, as when Bybit moved SOL from 8 to 2 hours.
function* fundingTimes(rt,end,start){
  const sw=rt.fundingSwitch;let t=Math.floor(end/FUND)*FUND;
  if(sw&&end>sw.at){for(t=sw.at+Math.floor((end-sw.at)/sw.every)*sw.every;t>sw.at&&t>=start;t-=sw.every)yield t;t=sw.at;}
  for(;t>=start;t-=FUND)yield t;
}
const nextFunding=(rt,at)=>{const sw=rt.fundingSwitch;return sw&&at>=sw.at?sw.at+(Math.floor((at-sw.at)/sw.every)+1)*sw.every:(Math.floor(at/FUND)+1)*FUND;};

/**
 * Bybit V5 public market endpoints for the runner and page tests: kline (any
 * interval, newest first, start/end/limit, including the forming candle),
 * mark-price-kline, tickers, instruments-info, risk-limit and funding/history.
 * runtime (mutable): {at, urls, market, markets?:{[symbol]:market}, price?, mark?,
 * shocks?:[{symbol?,at,factor}] (from that 5-minute candle on), funding?:rate|fn(symbol,t),
 * fundingSwitch?:{at,every} (funding every `every` ms after `at` instead of every 8 hours),
 * wicks?:[{symbol,at,kind?:'last'|'mark',h?,l?}] (token prices; a wick only the 1-minute candle starting at `at` shows),
 * fail?:message|fn(url)→message, lag?:ms|{[symbol]:ms} (kline data behind Bybit's clock),
 * holes?:Set('SYMBOL:interval:t'), server?: Bybit's clock when it differs from the page's `at`,
 * leverage?:{[symbol]:max}, lots?:{[symbol]:LOT-shaped filters, or null for none} (default LOT),
 * delay?: event-loop turns per request}. Everything is served as of Bybit's clock.
 */
export const fakeBybit=runtime=>async url=>{
  const rt=runtime,u=new URL(url);
  (rt.urls??=[]).push(u);
  for(let i=0;i<(rt.delay??0);i++)await new Promise(r=>setImmediate(r));
  const failed=typeof rt.fail==='function'?rt.fail(u):rt.fail;
  if(failed)throw Error(failed);
  const q=Object.fromEntries(u.searchParams),path=u.pathname.replace('/v5/market/',''),at=rt.server??rt.at,time=at;
  const symbol=SYMBOLS.find(s=>CONTRACTS[s]===q.symbol);
  if(q.category!=='linear'||!symbol)return {retCode:10001,retMsg:'params error',result:{},retExtInfo:{},time};
  const unit=CONTRACT_UNITS[symbol],px=x=>String(x*SCALE[symbol]*unit),ok=result=>({retCode:0,retMsg:'OK',result,retExtInfo:{},time});
  const m=rt.markets?.[symbol]??(rt.market??=scriptMarket()),max=rt.leverage?.[symbol]??MAX_LEVERAGE[symbol];
  const now=(kind='last')=>candleOf(m,symbol,bucket(at,STEP),STEP,at,rt,kind,at);
  if(path==='kline'||path==='mark-price-kline'){
    const iv=INTERVAL[q.interval];
    if(!iv)return {retCode:10001,retMsg:'invalid interval',result:{},retExtInfo:{},time};
    const kind=path==='kline'?'last':'mark',lag=path==='kline'?(typeof rt.lag==='object'?rt.lag?.[symbol]??0:rt.lag??0):0;
    const until=at-lag,end=Math.min(q.end===undefined?Infinity:+q.end,until),from=Math.max(q.start===undefined?-Infinity:+q.start,m.start);
    const limit=Math.min(1000,q.limit===undefined?200:+q.limit),list=[];
    for(let t=bucket(end,iv);t>=from&&list.length<limit;t-=iv){
      if(rt.holes?.has(`${symbol}:${q.interval}:${t}`))continue;
      const b=candleOf(m,symbol,t,iv,until,rt,kind,at);
      if(!b)continue;
      list.push(kind==='last'?[b.t,px(b.o),px(b.h),px(b.l),px(b.c),String(b.v/(b.c*SCALE[symbol])),String(b.v)]:[String(b.t),px(b.o),px(b.h),px(b.l),px(b.c)]);
    }
    return ok({category:'linear',symbol:q.symbol,list:list.map(r=>r.map(String))});
  }
  if(path==='tickers'){
    const last=now('last'),mark=now('mark');
    if(!last)return {retCode:10001,retMsg:'not listed yet',result:{},retExtInfo:{},time};
    return ok({category:'linear',list:[{symbol:q.symbol,lastPrice:px(last.c),markPrice:px(mark.c),indexPrice:px(mark.c),
      fundingRate:String(typeof rt.funding==='function'?rt.funding(symbol,at):rt.funding??FUNDING_RATE),nextFundingTime:String(nextFunding(rt,at))}]});
  }
  if(path==='instruments-info')return ok({category:'linear',list:[{symbol:q.symbol,status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',
    fundingInterval:String((rt.fundingSwitch&&at>=rt.fundingSwitch.at?rt.fundingSwitch.every:FUND)/MIN),leverageFilter:{minLeverage:'1',maxLeverage:String(max),leverageStep:'0.01'},
    ...lotFilters(rt.lots&&Object.hasOwn(rt.lots,symbol)?rt.lots[symbol]:LOT[symbol])}]});
  if(path==='risk-limit')return ok({category:'linear',list:limitsFor(symbol,at,max).tiers.map(t=>({id:t.id,symbol:q.symbol,riskLimitValue:String(t.cap),
    maxLeverage:String(t.max),maintenanceMargin:String(t.maintenance),mmDeduction:t.deduction?String(t.deduction):''}))});
  if(path==='funding/history'){
    const end=Math.min(q.endTime===undefined?at:+q.endTime,at),limit=Math.min(200,q.limit===undefined?200:+q.limit),list=[];
    for(const t of fundingTimes(rt,end,m.start)){
      if(list.length>=limit)break;
      list.push({symbol:q.symbol,fundingRate:String(typeof rt.funding==='function'?rt.funding(symbol,t):rt.funding??FUNDING_RATE),fundingRateTimestamp:String(t)});
    }
    return ok({category:'linear',list});
  }
  throw Error('Unexpected request '+url);
};
// The kinds of requests made, e.g. ['kline:60','tickers'].
export const urlKinds=urls=>[...new Set(urls.map(u=>u.pathname.replace('/v5/market/','')+(u.searchParams.get('interval')?':'+u.searchParams.get('interval'):'')))].sort();
