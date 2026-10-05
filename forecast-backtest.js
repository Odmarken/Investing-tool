// AI Forecast backtest: the af-signal-v1 rules traded on the demo account's own
// ledger rules, and the af-forecast-v1 analog forecast scored against what
// happened. Sizing is forecast-account.js's sizePosition; fees, slippage,
// funding, Bybit's isolated liquidation level and the order of events inside a
// candle (liquidation, then the stop, then the target) are booked the way its
// settlePosition and closePosition book them, so a backtest trade and a demo
// trade are the same arithmetic. Pure and deterministic: no network, no clock.
// Nothing reads past the moment it simulates: signals come from closed candles,
// entries fill at the next candle's open, and a walk-forward fold's forecasts
// draw their analogs only from history that ended before the fold.
import {TF,CHART_TFS,SYMBOLS,SIGNAL_PARAMS,FORECAST_PARAMS,MODEL} from './forecast-config.js';
import {computeIndicators,aggregateClosed,signalsInRange,requiredLookback,forecastFeatures,forecastAt} from './forecast-model.js';
import {ACCOUNT,newForecastAccount,sizePosition} from './forecast-account.js';
import {CONTRACTS,isolatedLevel} from './bybit-contracts.js';

// End of the research's development period (research/ai-forecast-protocol.md), where the predetermined
// rules were tested; no parameter was chosen on any data. Evaluations test after it.
export const DEV_END=Date.UTC(2025,9,1);

const DAY=86400000,FUNDING_SLACK=9*3600000;
// No prototype: a side such as '__proto__' must not count as a direction.
const DIR=Object.freeze(Object.assign(Object.create(null),{long:1,short:-1}));
const MONTHS=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
const NO_NEXT='Ingen candle efter signalen inom perioden',GAP='Lucka i datan — ingen ny affär',SHORT='För kort historik — ingen ny affär';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const count=x=>Number.isInteger(x)&&x>=1;
const sum=(xs,f)=>xs.reduce((s,x)=>s+f(x),0);
const dateText=t=>{const d=new Date(t);return d.getUTCDate()+' '+MONTHS[d.getUTCMonth()]+' '+d.getUTCFullYear();};
const pctText=x=>(x*100).toFixed(2).replace('.',',')+'\u00a0%';
const firstAfter=(xs,t)=>{let lo=0,hi=xs.length;while(lo<hi){const m=(lo+hi)>>1;if(xs[m].t<=t)lo=m+1;else hi=m;}return lo;};
function drain(steps){let r;do r=steps.next();while(!r.done);return r.value;}
function frame(tf){
  if(!CHART_TFS.includes(tf))throw Error('Okänd tidsram');
  return TF[tf];
}

// Validated copies of the input: closed candles only (when serverTime is
// given), ascending, aligned to the timeframe, with valid OHLC; funding sorted.
function seriesOf(series,tf,serverTime){
  const ms=frame(tf).ms;
  if(!series||typeof series!=='object'||Array.isArray(series))throw Error('Prishistorik saknas');
  const unknown=Object.keys(series).find(s=>!SYMBOLS.includes(s));
  if(unknown!==undefined)throw Error('Okänt par: '+unknown);
  if(serverTime!=null&&!finite(serverTime))throw Error('Ogiltig servertid');
  const out=SYMBOLS.filter(s=>Object.hasOwn(series,s)).map(symbol=>{
    const src=series[symbol];
    if(!src||!Array.isArray(src.bars))throw Error('Prishistorik saknas för '+symbol);
    const bars=[];
    for(const b of src.bars){
      if(!b||!Number.isSafeInteger(b.t)||b.t%ms||![b.o,b.h,b.l,b.c].every(positive)||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c)||
        bars.length&&b.t<=bars.at(-1).t)throw Error('Ogiltig candle för '+symbol);
      // A candle still forming can change before it closes, so it never reaches a signal.
      if(serverTime==null||b.t+ms<=serverTime)bars.push(b);
    }
    return {symbol,bars,funding:fundingOf(src.funding,symbol),index:new Map(bars.map((b,i)=>[b.t,i]))};
  });
  if(!out.length)throw Error('Prishistorik saknas');
  return out;
}
function fundingOf(f,symbol){
  if(f==null)return null;
  const bad=()=>Error('Ogiltig fundinghistorik för '+symbol);
  if(!Array.isArray(f))throw bad();
  const out=f.map(x=>{if(!x||!Number.isSafeInteger(x.t)||!finite(x.rate))throw bad();return {t:x.t,rate:x.rate};}).sort((a,b)=>a.t-b.t);
  if(out.some((x,i)=>i&&x.t===out[i-1].t&&x.rate!==out[i-1].rate))throw bad();
  return out.filter((x,i)=>!i||x.t!==out[i-1].t);
}
// contracts: {[symbol]:limits}, a Map, or the page's contract cache (get(symbol) gives fresh limits or null).
function contractOf(contracts,symbol){
  const c=typeof contracts?.get==='function'?contracts.get(symbol):contracts&&Object.hasOwn(contracts,symbol)?contracts[symbol]:null;
  if(!c||typeof c!=='object'||!positive(c.at))throw Error('Bybits hävstångsgränser saknas för '+symbol);
  if(c.symbol!==symbol||c.contract!==CONTRACTS[symbol])throw Error('Bybits gränser gäller ett annat kontrakt än '+symbol);
  return c;
}
function signalParams(p){
  // The model validates the rule parameters; the holding time is only read here.
  if(!p||typeof p!=='object'||!count(p.maxHold))throw Error('Ogiltiga signalparametrar');
  return p;
}
// Precomputed signals ({[symbol]:[{t,side,entry,sl,tp}]}) for research and tests, instead of evaluating the rules.
function givenSignals(list,x,lo,hi){
  if(list==null)return [];
  if(!Array.isArray(list))throw Error('Ogiltiga signaler för '+x.symbol);
  for(const e of list){
    const d=DIR[e?.side];
    if(!d||!x.index.has(e.t)||![e.entry,e.sl,e.tp].every(positive)||d*(e.entry-e.sl)<=0||d*(e.tp-e.entry)<=0)throw Error('Ogiltig signal för '+x.symbol);
  }
  return list.filter(e=>e.t>=lo&&e.t<=hi);
}

/**
 * The trading run as steps (one per coin's signal pass, then the bar loop), so
 * a page can yield between them. Per candle on the union timeline:
 * 1. at the open: funding due by then (on units × the open), a gap through the
 *    liquidation level, the time stop and an exit on an opposite signal (only
 *    on data that would also allow an entry);
 * 2. entries for signals of the candle that just closed, coins in SYMBOLS
 *    order, at this open with slippage, sized by sizePosition;
 * 3. inside the candle, as settlePosition orders it: liquidation on the worst
 *    price, then the stop (an open beyond it fills at the open), then the target;
 * 4. at the close: new signals and the mark-to-market equity.
 * A stop that gaps at the open is booked in step 3, so the slot it frees is
 * not reused at that same open.
 */
function* simulation(o){
  const T=frame(o.tf),tf=T.key,ms=T.ms,fee=ACCOUNT.fee;
  const params=signalParams(o.params??SIGNAL_PARAMS),settings=newForecastAccount(1,o.settings??{}).settings;
  const start=o.start??ACCOUNT.start,slip=o.slip??ACCOUNT.slip;
  if(!positive(start))throw Error('Ogiltigt startkapital');
  if(!finite(slip)||slip<0||slip>=.01)throw Error('Ogiltig slippage');
  if(o.signals!=null&&(typeof o.signals!=='object'||Array.isArray(o.signals)))throw Error('Ogiltiga signaler');
  const list=o.prepared??seriesOf(o.series,tf,o.serverTime),have=list.filter(x=>x.bars.length);
  if(!have.length)throw Error('Prishistorik saknas');
  const lo=o.from??Math.min(...have.map(x=>x.bars[0].t)),hi=o.to??Math.max(...have.map(x=>x.bars.at(-1).t));
  if(!finite(lo)||!finite(hi)||lo>hi)throw Error('Ogiltig period för backtest');
  const lookback=requiredLookback(tf,params),coins=[];
  for(const x of list){
    const bars=x.bars,first=bars.findIndex(b=>b.t>=lo),last=bars.findLastIndex(b=>b.t<=hi);
    if(first>=0&&last>=first){
      const contract=contractOf(o.contracts,x.symbol),found=new Map();
      // signalsInRange gives exactly evaluateBar's result for every bar that signals. Each value at bar i
      // reads only bars ≤ i, and the higher timeframe only buckets closed by bar i's close.
      const evals=o.signals?givenSignals(o.signals[x.symbol],x,lo,hi):
        signalsInRange(bars,first,last,{tf,params,ind:computeIndicators(bars,params),htfBars:aggregateClosed(bars,tf,T.htf,bars.at(-1).t+ms)});
      for(const e of evals)found.set(x.index.get(e.t),e);
      // lastGap[i]: the latest k ≤ i with a missing candle between k−1 and k.
      const lastGap=new Int32Array(bars.length);
      for(let i=0,g=-1;i<bars.length;i++){if(i&&bars[i].t-bars[i-1].t!==ms)g=i;lastGap[i]=g;}
      coins.push({symbol:x.symbol,bars,funding:x.funding,contract,first,last,k:first,found,lastGap,pos:null,pending:null,opposite:null,fi:0,bar:null});
    }
    yield {stage:'signaler',symbol:x.symbol};
  }
  const times=[...new Set(coins.flatMap(x=>x.bars.slice(x.first,x.last+1).map(b=>b.t)))].sort((a,b)=>a-b);
  if(!times.length)throw Error('Inga candles i perioden för backtest');
  let cash=start,fees=0,funding=0,late=false,missed=false;
  const trades=[],decisions=[],skipped={},equity=[{t:times[0],v:start}];
  const realized=()=>cash+sum(coins,x=>x.pos?x.pos.margin:0);
  const fill=(dir,level)=>level*(1-dir*slip);
  // forecast-account.js's levelOf: Bybit's isolated level for the margin the position holds now.
  const levelOf=p=>isolatedLevel(p.side,p.entry,p.margin+p.units*p.entry*fee,p.units,fee,p);
  const skip=(d,reason)=>{d.reason=reason;skipped[reason]=(skipped[reason]??0)+1;};
  // The live runner's data check (dataStatus over lookback+1 closed candles), for an entry and for an exit on
  // an opposite signal alike: the candle after the signal follows at once, and the lookback+1 candles up to
  // the signal exist without a gap. Otherwise nothing is decided.
  const unready=(x,i,b)=>!b||x.k!==i+1||b.t!==x.bars[i].t+ms?GAP:i<lookback?SHORT:x.lastGap[i+1]>i-lookback?GAP:'';
  // forecast-account.js's closeAt: the margin plus the result after the closing fee, never below zero; a liquidation returns nothing.
  function close(x,price,at,reason){
    const p=x.pos,dir=DIR[p.side],liquidated=reason==='likvidation',closeFee=liquidated?0:p.units*price*fee;
    const proceeds=liquidated?0:Math.max(0,p.margin+dir*(price-p.entry)*p.units-closeFee),marginOpen=p.margin+p.funding;
    // Funding due inside the candle the position closed in is not charged: OHLC cannot tell whether it came before the exit.
    const due=x.funding?.[x.fi];if(due&&due.t<at)missed=true;
    x.pos=null;cash+=proceeds;fees+=closeFee;
    trades.push({id:p.id,symbol:p.symbol,side:p.side,signalId:p.signalId,tf,entry:p.entry,exit:price,units:p.units,margin:marginOpen,leverage:p.leverage,
      openedAt:p.openedAt,closedAt:at,reason,pnl:proceeds-marginOpen-p.fees,fees:p.fees+closeFee,funding:p.funding,equityAfter:realized(),
      signalAt:p.signalAt,sl:p.sl,tp:p.tp,liq:p.liq});
  }
  // Funding the position held at its timestamp: charged at the first candle open at or after it (at
  // its own candle when the timestamp is an open), out of the margin, which moves the liquidation level.
  function charge(x,until,price){
    const p=x.pos,f=x.funding,dir=DIR[p.side];
    for(;f&&x.fi<f.length&&f[x.fi].t<=until;x.fi++){
      const ev=f[x.fi];if(ev.t<=p.fundingThrough)continue;
      const cost=dir*p.units*price*ev.rate;p.margin-=cost;p.funding+=cost;funding+=cost;p.liq=levelOf(p);
      if(ev.t<until)late=true;
    }
    p.fundingThrough=Math.max(p.fundingThrough,until);
  }
  function atOpen(x,b,t){
    const p=x.pos,dir=DIR[p.side],opposite=x.opposite?.id===p.id&&!unready(x,x.opposite.i,b);
    x.opposite=null;charge(x,t,b.o);
    if(dir*(b.o-p.liq)<=0)return close(x,b.o,t,'likvidation');
    if(t<p.deadline&&!opposite)return;
    // As settlePosition at the deadline: an open beyond the stop is a stop, beyond the target fills at the target.
    if(dir*(b.o-p.sl)<=0)return close(x,fill(dir,b.o),t,'stopp');
    if(dir*(b.o-p.tp)>=0)return close(x,fill(dir,p.tp),t,'mål');
    close(x,fill(dir,b.o),t,t>=p.deadline?'tid':'signal');
  }
  function enter(x,b,t){
    const {i,e,d}=x.pending,why=unready(x,i,b);x.pending=null;
    if(why)return skip(d,why);
    if(x.pos)return skip(d,'Det finns redan en position i paret');
    if(coins.filter(c=>c.pos).length>=settings.maxOpen)return skip(d,'Max antal öppna positioner är nått');
    const dir=DIR[e.side],price=b.o,fillPrice=price*(1+dir*slip);
    if(!(dir*(price-e.sl)>0&&dir*(e.tp-price)>0&&dir*(fillPrice-e.sl)>0&&dir*(e.tp-fillPrice)>0))return skip(d,'Priset ligger redan utanför stopp och mål');
    if(Math.abs(e.tp-price)/Math.abs(price-e.sl)<ACCOUNT.minRR)return skip(d,'Kvarvarande vinst/risk är under '+ACCOUNT.minRR);
    // Bybit's historical limits are not published: today's limits size every trade, read as current at their own time.
    // sizePosition adds the account's slippage itself, so a stressed slippage is passed in through the price.
    const equity=realized(),plan=sizePosition({equity,cash,settings,contract:x.contract,side:e.side,
      price:slip===ACCOUNT.slip?price:fillPrice/(1+dir*ACCOUNT.slip),mark:price,sl:e.sl,now:x.contract.at});
    if(!plan.ok)return skip(d,plan.reason);
    if(dir*(price-plan.liq)<=0)return skip(d,'Markpriset ligger redan vid likvidationsnivån');
    const p={id:'p|'+d.id,symbol:x.symbol,side:e.side,signalId:d.id,tf,entry:plan.fill,units:plan.units,margin:plan.margin,leverage:plan.leverage,
      maintenance:plan.maintenance,deduction:plan.deduction,riskId:plan.riskId,sl:e.sl,tp:e.tp,liq:plan.liq,openedAt:t,
      deadline:x.bars[i].t+ms+params.maxHold*ms,fees:plan.openFee,funding:0,fundingThrough:t,signalAt:x.bars[i].t,equityAtOpen:equity};
    cash-=plan.margin+plan.openFee;
    // The sizing keeps margin plus fee within cash; only rounding can dip below zero.
    if(cash<0&&cash>-1e-9)cash=0;
    fees+=plan.openFee;x.pos=p;x.fi=x.funding?firstAfter(x.funding,t):0;d.trade=p.id;
  }
  function inside(x,b,t){
    const p=x.pos,dir=DIR[p.side],end=t+ms,worst=dir>0?b.l:b.h,best=dir>0?b.h:b.l;
    if(dir*(worst-p.liq)<=0)return close(x,p.liq,end,'likvidation');
    if(dir*(b.o-p.sl)<=0)return close(x,fill(dir,b.o),t,'stopp');
    if(dir*(worst-p.sl)<=0)return close(x,fill(dir,p.sl),end,'stopp');
    if(dir*(best-p.tp)>=0)close(x,fill(dir,p.tp),dir*(b.o-p.tp)>=0?t:end,'mål');
  }
  function atClose(x,b){
    const i=x.k,e=x.found.get(i);x.bar=b;
    if(e){
      const id=`s|backtest|${x.symbol}|${tf}|${b.t}|${MODEL.signal}`,d={id,symbol:x.symbol,t:b.t,side:e.side,entry:e.entry,sl:e.sl,tp:e.tp,trade:null,reason:''};
      decisions.push(d);
      if(x.pos&&x.pos.side!==e.side)x.opposite={id:x.pos.id,i};
      x.pending={i,e,d};
    }
    if(i<x.last)return;
    // The coin's last candle in the period: what is still open closes at its close.
    if(x.pending){skip(x.pending.d,NO_NEXT);x.pending=null;}
    if(x.pos){const end=b.t+ms;charge(x,end,b.c);close(x,fill(DIR[x.pos.side],b.c),end,'slut');}
  }
  // accountLive's value with the close as the mark: what a close at market would return now.
  const valueOf=(p,c)=>{const dir=DIR[p.side],exit=fill(dir,c);return dir*(c-p.liq)<=0?0:Math.max(0,p.margin+dir*(exit-p.entry)*p.units-p.units*exit*fee);};
  for(const t of times){
    const now=coins.map(x=>{while(x.k<=x.last&&x.bars[x.k].t<t)x.k++;return x.k<=x.last&&x.bars[x.k].t===t?x.bars[x.k]:null;});
    coins.forEach((x,n)=>{if(now[n]&&x.pos)atOpen(x,now[n],t);});
    coins.forEach((x,n)=>{if(x.pending)enter(x,now[n],t);});
    coins.forEach((x,n)=>{if(now[n]&&x.pos)inside(x,now[n],t);});
    coins.forEach((x,n)=>{if(now[n])atClose(x,now[n]);});
    equity.push({t:t+ms,v:cash+sum(coins,x=>x.pos?valueOf(x.pos,x.bar.c):0)});
  }
  yield {stage:'handel'};
  const notes=['Bybits nuvarande hävstångsgränser används bakåt.','Likvidation prövas på candlens sämsta pris, strängare än Bybits markpris.'];
  for(const x of coins){
    const from=x.bars[x.first].t,to=x.bars[x.last].t+ms,f=x.funding;
    if(!f||!f.length&&to-from>FUNDING_SLACK)notes.push('Fundinghistorik saknas för '+x.symbol+' — funding är inte medräknad.');
    else if(to-from>FUNDING_SLACK&&(f[0].t>from+FUNDING_SLACK||f.at(-1).t<to-FUNDING_SLACK))notes.push('Fundinghistoriken för '+x.symbol+' täcker inte hela perioden.');
  }
  if(late)notes.push('Funding mellan två candle-öppningar dras vid nästa öppning.');
  if(missed)notes.push('Funding som infaller inne i den candle där en position stängs är inte medräknad.');
  if(slip!==ACCOUNT.slip)notes.push('Slippage '+pctText(slip)+' per sida i stället för '+pctText(ACCOUNT.slip)+'.');
  return {trades,equity,metrics:metricsOf(trades,equity,start),notes,decisions,skipped,ledger:{start,cash,fees,funding},from:lo,to:hi};
}

/**
 * Trades the signal rules over `series` ({[symbol]:{bars (closed, ascending),
 * funding:[{t,rate}]|null}}) with the demo account's rules and costs. Optional:
 * from/to (bar open times; default all), start (100 $), slip (stress test),
 * serverTime (drops candles not closed by then), signals (precomputed, instead
 * of evaluating the rules). → {trades,equity:[{t,v}],metrics,notes,decisions,skipped,ledger,from,to}
 */
export function simulate(opts={}){return drain(simulation(opts));}

// Daily returns of the equity → annualised Sharpe, √365. A UTC day closes at
// its last value (a value at exactly midnight closes the day before); the
// first value is the start, so it closes the day before its own. A day without
// a value closed where the day before did, a zero return: a realized curve only
// moves at a trade, and skipping such days would count a week as one day.
function sharpeOf(curve){
  const closes=[];
  for(const p of curve){
    const d=closes.length?Math.floor((p.t-1)/DAY):Math.floor(p.t/DAY)-1,last=closes.at(-1);
    if(last?.d===d)last.v=p.v;else closes.push({d,v:p.v});
  }
  const r=[];let flat=0;
  for(let k=1;k<closes.length;k++){
    const a=closes[k-1],b=closes[k];if(!(a.v>0))continue;
    r.push(b.v/a.v-1);flat+=Math.max(0,b.d-a.d-1);
  }
  const n=r.length+flat;
  if(n<2)return null;
  const mean=sum(r,x=>x)/n,sd=Math.sqrt((sum(r,x=>(x-mean)**2)+flat*mean*mean)/(n-1));
  return sd>0?mean/sd*Math.sqrt(365):null;
}
// Realized equity after each trade when no equity curve is given: by close
// time when the trades have times, else in the order given.
function curveOf(trades,start){
  if(!trades.length)return [];
  const timed=trades.every(t=>finite(t.openedAt)&&finite(t.closedAt)),sorted=timed?[...trades].sort((a,b)=>a.closedAt-b.closedAt):trades;
  let v=start;
  return [{t:timed?trades.reduce((m,t)=>Math.min(m,t.openedAt),Infinity):0,v},...sorted.map((t,k)=>({t:timed?t.closedAt:k+1,v:v+=t.pnl}))];
}
/**
 * Trade statistics. Fractions, not percent: winRate, netPct and maxDrawdownPct.
 * maxDrawdown is in dollars, from the running peak of `equity` (or of realized
 * equity after each trade when equity is null), which starts at `start`.
 * profitFactor is null without a losing trade; sharpe is null under two daily returns.
 */
export function metricsOf(trades,equity,start){
  if(!Array.isArray(trades)||trades.some(t=>!t||!finite(t.pnl)||!finite(t.fees)||!finite(t.funding)))throw Error('Ogiltiga affärer');
  if(!positive(start))throw Error('Ogiltigt startkapital');
  const curve=equity==null?curveOf(trades,start):equity;
  if(!Array.isArray(curve)||curve.some(p=>!p||!finite(p.t)||!finite(p.v)))throw Error('Ogiltig kapitalkurva');
  const pnl=trades.map(t=>t.pnl),n=pnl.length,wins=pnl.filter(x=>x>0).length,net=sum(pnl,x=>x);
  const gain=sum(pnl.filter(x=>x>0),x=>x),loss=-sum(pnl.filter(x=>x<0),x=>x);
  let peak=start,maxDrawdown=0,maxDrawdownPct=0;
  for(const {v} of curve){peak=Math.max(peak,v);maxDrawdown=Math.max(maxDrawdown,peak-v);maxDrawdownPct=Math.max(maxDrawdownPct,(peak-v)/peak);}
  return {trades:n,wins,losses:pnl.filter(x=>x<0).length,winRate:n?wins/n:null,net,netPct:net/start,maxDrawdown,maxDrawdownPct,
    profitFactor:loss>0?gain/loss:null,fees:sum(trades,t=>t.fees),funding:sum(trades,t=>t.funding),
    liquidations:trades.filter(t=>t.reason==='likvidation').length,avgTrade:n?net/n:null,sharpe:sharpeOf(curve)};
}

// ---- Forecast errors --------------------------------------------------------
function tally(horizons){
  return {forecasts:0,failed:0,from:null,to:null,rows:horizons.map(h=>({h,n:0,abs:0,naive:0,scenario:0,dirHits:0,dirN:0,in50:0,in80:0,missing:0}))};
}
// Each cutoff's forecast uses bars[0..c] only; the realized close h candles
// later (matched by time, so a gap is skipped, not misread) only scores it.
function score(acc,{bars,tf,cutoffs,library,params,features,index}){
  const ms=TF[tf].ms;
  for(const c of cutoffs){
    // A fixed walk-forward library is used whole for every cutoff of its window: the model's own
    // rolling window (train) would otherwise shrink it as the cutoff moves away from it.
    const p=library?{...params,train:Math.max(params.train,c-library.from)}:params;
    const f=forecastAt(bars,c,{tf,params:p,features,library});
    if(!f.ok){acc.failed++;for(const r of acc.rows)r.missing++;continue;}
    acc.forecasts++;
    acc.from=acc.from===null?f.train.from:Math.min(acc.from,f.train.from);acc.to=acc.to===null?f.train.to:Math.max(acc.to,f.train.to);
    for(const r of acc.rows){
      const k=index.get(bars[c].t+r.h*ms);
      if(k===undefined){r.missing++;continue;}
      const real=bars[k].c,base=f.base,q=f.bands[r.h-1],fd=Math.sign(q.q50-base),rd=Math.sign(real-base);
      r.n++;r.abs+=Math.abs(q.q50-real)/base;r.naive+=Math.abs(real-base)/base;r.scenario+=Math.abs(f.candles[r.h-1].c-real)/base;
      // The protocol's share of right direction when the median points up or down: an unchanged close is a miss.
      if(fd){r.dirN++;if(fd===rd)r.dirHits++;}
      if(real>=q.q25&&real<=q.q75)r.in50++;
      if(real>=q.q10&&real<=q.q90)r.in80++;
    }
  }
  return acc;
}
function merged(accs,horizons){
  const out=tally(horizons);
  for(const a of accs){
    out.forecasts+=a.forecasts;out.failed+=a.failed;
    if(a.from!==null){out.from=out.from===null?a.from:Math.min(out.from,a.from);out.to=out.to===null?a.to:Math.max(out.to,a.to);}
    a.rows.forEach((r,k)=>{const o=out.rows[k];for(const key of ['n','abs','naive','scenario','dirHits','dirN','in50','in80','missing'])o[key]+=r[key];});
  }
  return out;
}
function errorsOut(acc){
  const out={};
  for(const r of acc.rows){
    const n=r.n;
    out[r.h]={h:r.h,n,mae:n?r.abs/n:null,naiveMae:n?r.naive/n:null,skill:n&&r.naive>0?1-r.abs/r.naive:null,dirHit:r.dirN?r.dirHits/r.dirN:null,
      dirN:r.dirN,cover50:n?r.in50/n:null,cover80:n?r.in80/n:null,scenarioMae:n?r.scenario/n:null,missing:r.missing};
  }
  return out;
}
// The page's 5/10/20 candles, as far as the model's frozen horizon reaches.
const HORIZONS=Object.freeze([5,10,20]);
function checkHorizons(horizons,params){
  if(!params||typeof params!=='object'||!count(params.horizon)||!count(params.train))throw Error('Ogiltiga prognosparametrar');
  horizons??=HORIZONS.filter(h=>h<=params.horizon);
  if(!Array.isArray(horizons)||!horizons.length||horizons.some(h=>!count(h)||h>params.horizon)||new Set(horizons).size!==horizons.length)
    throw Error('Ogiltiga prognoshorisonter');
  return horizons;
}
/**
 * Forecast errors at the given cutoff indices, per horizon h (keyed by h):
 * {h,n,mae,naiveMae,skill,dirHit,dirN,cover50,cover80,scenarioMae,missing}.
 * Errors are |forecast − real close| / the price at the cutoff: mae for the
 * median band (q50), naiveMae for "no change", scenarioMae for the drawn
 * scenario; skill = 1 − mae/naiveMae. dirHit, cover50 and cover80 are
 * fractions; dirN counts forecasts whose median moved, and dirHit is the share
 * of those whose real close moved the same way.
 * missing counts cutoffs without a forecast or without the real candle.
 * library {from,to} (indices) is a fixed walk-forward library, used whole.
 */
export function forecastErrors({bars,tf,cutoffs,library=null,horizons=null,params=FORECAST_PARAMS,features=null}={}){
  if(!Object.hasOwn(TF,tf??''))throw Error('Okänd tidsram');
  if(!Array.isArray(bars))throw Error('Candles saknas');
  // Real candles are found by time, so the history must be strictly ascending.
  if(bars.some((b,i)=>!b||!finite(b.t)||i&&b.t<=bars[i-1].t))throw Error('Ogiltig candle');
  if(!Array.isArray(cutoffs)||cutoffs.some(c=>!Number.isInteger(c)||c<0||c>=bars.length))throw Error('Ogiltiga prognospunkter');
  if(library!=null&&(!Number.isInteger(library.from)||!Number.isInteger(library.to)||library.from>library.to))throw Error('Ogiltigt prognosbibliotek');
  horizons=checkHorizons(horizons,params);
  const F=features??forecastFeatures(bars);
  return errorsOut(score(tally(horizons),{bars,tf,cutoffs,library,params,features:F,index:new Map(bars.map((b,i)=>[b.t,i]))}));
}

// ---- Walk-forward -----------------------------------------------------------
const everyText=n=>n===1?'varje candle':n===2?'varannan candle':'var '+n+':e candle';
/**
 * walkForward as steps ({done,total,text} between coins and folds), for a page
 * that yields to the UI; the generator's return value is walkForward's result.
 */
export function* walkForwardSteps(o={}){
  const T=frame(o.tf),tf=T.key,start=o.start??ACCOUNT.start,trainBars=o.trainBars??FORECAST_PARAMS.train,folds=o.folds??4;
  const minTestFrom=o.minTestFrom??DEV_END,stride=o.stride??4,fp=o.forecastParams??FORECAST_PARAMS,horizons=checkHorizons(o.horizons,fp);
  if(!count(trainBars)||!count(folds)||!count(stride)||!finite(minTestFrom))throw Error('Ogiltiga inställningar för walk-forward');
  const series=seriesOf(o.series,tf,o.serverTime).filter(x=>x.bars.length);
  if(!series.length)throw Error('Prishistorik saknas');
  const times=[...new Set(series.flatMap(x=>x.bars.map(b=>b.t)))].sort((a,b)=>a-b),firstTest=times.findIndex(t=>t>=minTestFrom);
  if(firstTest<0)throw Error('Ingen data från '+dateText(minTestFrom)+' att testa på');
  // The test region starts once trainBars candles of history exist and not before minTestFrom.
  const s0=Math.max(trainBars,firstTest),span=times.length-s0;
  if(span<folds)throw Error('För kort historik för walk-forward: '+Math.max(0,span)+' candles efter träningsfönstret');
  const bounds=Array.from({length:folds+1},(_,k)=>s0+Math.floor(k*span/folds));
  const plan=bounds.slice(0,-1).map((b,k)=>({train:{from:times[Math.max(0,b-trainBars)],to:times[b-1]},test:{from:times[b],to:times[bounds[k+1]-1]}}));
  const total=2*series.length+1+folds*series.length;let done=0;
  const step=text=>({done:++done,total,text});
  // Trading runs once over all test windows, so equity and open positions carry across folds.
  const run=simulation({...o,tf,start,prepared:series,from:plan[0].test.from,to:plan.at(-1).test.to});
  let r;while(!(r=run.next()).done)yield step(r.value.stage==='handel'?'Handel':'Signaler '+r.value.symbol);
  const result=r.value,tallies=plan.map(()=>tally(horizons));
  for(const x of series){
    const features=forecastFeatures(x.bars);
    yield step('Prognosunderlag '+x.symbol);
    for(const [k,f] of plan.entries()){
      const first=x.bars.findIndex(b=>b.t>=f.test.from),cutoffs=[];
      for(let i=first;i>0&&i<x.bars.length&&x.bars[i].t<=f.test.to;i+=stride)cutoffs.push(i);
      // The library: the coin's candles in the fold's training window (by time, so a coin with missing
      // candles reaches no further back than the others); analog outcomes must end before the fold too.
      const from=x.bars.findIndex(b=>b.t>=f.train.from);
      if(cutoffs.length)score(tallies[k],{bars:x.bars,tf,cutoffs,library:{from,to:first-1},params:fp,features,index:x.index});
      yield step('Prognoser '+x.symbol+' · fönster '+(k+1)+' av '+folds);
    }
  }
  const out=plan.map((f,k)=>{
    const from=f.test.from,until=k+1<plan.length?plan[k+1].test.from:Infinity,a=tallies[k];
    let base=start;const curve=[];
    for(const p of result.equity){if(p.t<=from)base=p.v;else if(p.t<=until)curve.push(p);}
    // A trade belongs to the window in which it was opened.
    const trades=result.trades.filter(t=>t.openedAt>=from&&t.openedAt<until);
    // An account emptied in an earlier window (possible with the largest settings) cannot trade in this one:
    // no trades, no change, nothing to divide by.
    return {train:f.train,test:f.test,trading:base>0?metricsOf(trades,[{t:from,v:base},...curve],base):metricsOf(trades,[],start),forecast:errorsOut(a),
      library:a.forecasts?{from:a.from,to:a.to,forecasts:a.forecasts,failed:a.failed}:null};
  });
  const all=merged(tallies,horizons);
  // Where the windows really start: history can begin after an early minTestFrom. The research chose no
  // parameter (it kept the predetermined defaults), so the note must not say that one was chosen on data.
  const notes=[plan[0].test.from>=DEV_END?'Reglerna och parametrarna bestämdes i förväg; inget valdes på testfönstren efter '+dateText(DEV_END)+'.':
    'Testfönstren börjar före '+dateText(DEV_END)+' och överlappar forskningens utvecklingsperiod, där reglerna prövades.',
    'Alla mått är uppmätta i efterhand på historik utanför träningsfönstren, inte löften om framtiden.',...result.notes,
    'Prognosens analoger hämtas bara från de '+trainBars.toLocaleString('sv-SE')+' candles som slutar före varje testfönster; prognos vid '+everyText(stride)+' per par.'];
  if(all.failed)notes.push(all.failed.toLocaleString('sv-SE')+' prognospunkter saknade tillräcklig historik.');
  return {folds:out,aggregate:{trading:result.metrics,forecast:errorsOut(all),
    bySymbol:Object.fromEntries(series.map(x=>[x.symbol,metricsOf(result.trades.filter(t=>t.symbol===x.symbol),null,start)]))},
    trades:result.trades,equity:result.equity,notes,decisions:result.decisions,skipped:result.skipped,ledger:result.ledger};
}
/**
 * Walk-forward evaluation. Folds tile the candles after max(trainBars, the
 * first candle ≥ minTestFrom) into `folds` equal test windows. Trading runs
 * continuously across them (equity compounds; a trade counts in the window it
 * opened in). Forecasts: every `stride` candles per coin, each fold's library
 * restricted to the trainBars candles before its window, analog outcomes ending
 * before it. → {folds:[{train,test,trading,forecast,library}],aggregate:{trading,forecast,bySymbol},trades,equity,notes,decisions,skipped,ledger}
 */
export function walkForward(opts={}){return drain(walkForwardSteps(opts));}
