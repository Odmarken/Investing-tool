// Trend desks for the trading floor: the nine-horizon Donchian ensemble on
// hourly closes with volatility-targeted size that research/floor-trend-*
// selected and validated. One linear perpetual ledger per desk; the desk's
// whole balance backs its position. Demo only: nothing here sends orders.
import {QUOTE_TTL} from './crypto-momentum-live.js';
const HOUR=3600000,DAY=24*HOUR;
export const TREND=Object.freeze({version:'floor-trend-v1',start:100,hour:HOUR,step:300000,
  lookbacks:Object.freeze([5,10,20,30,60,90,150,250,360]),volTarget:1,maxLeverage:4,volDays:90,minVolDays:30,band:.25,
  fee:.00055,slip:.0005,maintenance:.01,initHours:2*365*24,decisionLimit:500});
// Hourly closes spanned by the longest channel.
export const WINDOW=TREND.lookbacks.at(-1)*24;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const fresh=(q,now)=>q&&positive(q.price)&&positive(q.mark)&&finite(q.at)&&q.at<=now+5000&&now-q.at<=QUOTE_TTL;

// Sliding max/min over the n values ending at each index (fewer at the start).
export function slidingExtrema(values,n){
  const N=values.length,mx=new Float64Array(N),mn=new Float64Array(N),qx=new Int32Array(N),qn=new Int32Array(N);
  let hx=0,tx=0,hn=0,tn=0;
  for(let k=0;k<N;k++){
    const v=values[k];
    while(tx>hx&&values[qx[tx-1]]<=v)tx--;qx[tx++]=k;
    while(tn>hn&&values[qn[tn-1]]>=v)tn--;qn[tn++]=k;
    const lo=k-n+1;while(qx[hx]<lo)hx++;while(qn[hn]<lo)hn++;
    mx[k]=values[qx[hx]];mn[k]=values[qn[hn]];
  }
  return {mx,mn};
}

export function newTrendSignal(){return {through:null,sides:TREND.lookbacks.map(()=>0),stops:TREND.lookbacks.map(()=>null)};}
export function validateTrendSignal(s){
  if(!s||!(s.through===null||positive(s.through)&&s.through%HOUR===0)||!Array.isArray(s.sides)||!Array.isArray(s.stops)||
    s.sides.length!==TREND.lookbacks.length||s.stops.length!==TREND.lookbacks.length)throw Error('Ogiltigt trendläge');
  s.sides.forEach((side,i)=>{if(side===1?!positive(s.stops[i]):side!==0||s.stops[i]!==null)throw Error('Ogiltigt trendläge');});
  if(s.through===null&&s.sides.some(Boolean))throw Error('Ogiltigt trendläge');
  return s;
}
function checkBars(bars){
  if(!Array.isArray(bars)||!bars.length)throw Error('Timpriser saknas');
  bars.forEach((b,i)=>{if(!b||!finite(b.t)||b.t%HOUR||!positive(b.c)||i&&b.t!==bars[i-1].t+HOUR)throw Error('Sammanhängande timpriser saknas');});
}
/**
 * Process every completed hourly close after signal.through up to `upto` (the
 * current hour boundary). Per horizon n: a close above the previous n days of
 * closes goes long with its stop at the midpoint of the n days ending now; the
 * stop only rises, and a close below it goes flat. A new signal starts flat at
 * the first full window of the supplied history, like the research replay.
 */
export function advanceTrendSignal(signal,bars,upto){
  validateTrendSignal(signal);checkBars(bars);
  if(!positive(upto)||upto%HOUR)throw Error('Ogiltig beslutstimme');
  if(signal.through!==null&&signal.through>=upto)return signal;
  const last=(upto-HOUR-bars[0].t)/HOUR,first=signal.through===null?null:(signal.through-bars[0].t)/HOUR;
  if(last<0||last>=bars.length)throw Error('Timpriserna når inte fram till beslutstimmen');
  const closes=Float64Array.from(bars,b=>b.c),next={through:upto,sides:[...signal.sides],stops:[...signal.stops]};
  TREND.lookbacks.forEach((n,j)=>{
    const N=n*24,lo=first===null?0:first-N;
    if(lo<0)throw Error('För kort timhistorik för '+n+' dygn');
    const slice=closes.subarray(lo,last+1),{mx,mn}=slidingExtrema(slice,N);
    let s=next.sides[j],stop=next.stops[j];
    for(let k=N;k<slice.length;k++){
      const c=slice[k],mid=(mx[k]+mn[k])/2;
      if(s===1){if(c<stop){s=0;stop=null;}else stop=Math.max(stop,mid);}
      else if(c>mx[k-1]){s=1;stop=mid;}
    }
    next.sides[j]=s;next.stops[j]=stop;
  });
  return next;
}
export const trendCount=signal=>signal.sides.reduce((sum,side)=>sum+side,0);
// Annualised volatility of the latest 90 daily log returns (UTC closes) at or before `upto`.
export function trendVol(bars,upto){
  checkBars(bars);
  const closes=[];
  for(let i=bars.length-1;i>=0&&closes.length<TREND.volDays+1;i--){const t=bars[i].t+HOUR;if(t<=upto&&t%DAY===0)closes.unshift(bars[i].c);}
  if(closes.length<TREND.minVolDays+1)return NaN;
  const n=closes.length-1;let s=0,s2=0;
  for(let i=1;i<closes.length;i++){const r=Math.log(closes[i]/closes[i-1]);s+=r;s2+=r*r;}
  const mean=s/n;return Math.sqrt(Math.max(0,(s2-n*mean*mean)/(n-1))*365);
}
// Target position value as a multiple of the desk balance.
export const trendTarget=(count,vol)=>positive(vol)?count/TREND.lookbacks.length*Math.min(TREND.maxLeverage,TREND.volTarget/vol):0;
// Every active horizon's stop: the highest shrinks the position first, the lowest ends it.
export function trendStops(signal){
  const stops=signal.stops.filter(positive);
  return stops.length?{first:Math.max(...stops),last:Math.min(...stops)}:null;
}

export function newTrendDesk(){
  return {version:TREND.version,enabled:true,cash:TREND.start,position:null,signal:newTrendSignal(),lastCount:0,decisions:[],trades:[],fees:0,funding:0,startedAt:null};
}
export function validateTrendDesk(d,symbol){
  if(d?.version!==TREND.version||typeof d.enabled!=='boolean'||!finite(d.cash)||!Array.isArray(d.decisions)||!Array.isArray(d.trades)||
    !finite(d.fees)||d.fees<0||!finite(d.funding)||!Number.isInteger(d.lastCount)||d.lastCount<0||d.lastCount>TREND.lookbacks.length||
    !(d.startedAt===null||positive(d.startedAt)))throw Error('Ogiltigt trendbord');
  validateTrendSignal(d.signal);
  const p=d.position;
  if(p!==null&&(![p.units,p.entry,p.openedAt,p.equityAtOpen,p.nextBar,p.fundingThrough].every(positive)||!finite(p.fees)||p.fees<0||!finite(p.funding)||
    !positive(p.peakExposure)||p.nextBar%TREND.step))throw Error('Ogiltig trendposition');
  if(p!==null&&p.symbol!==symbol)throw Error('Bord '+symbol+' håller fel coin');
  if(p===null&&d.cash<0)throw Error('Negativ kassa utan position');
  if(d.decisions.some((x,i)=>!x||!positive(x.hour)||x.hour%HOUR||!positive(x.at)||x.at<x.hour||!Number.isInteger(x.count)||i&&x.hour<=d.decisions[i-1].hour)||
    (d.decisions.at(-1)?.hour??null)!==(d.signal.through===null?null:d.signal.through))throw Error('Ogiltiga timbeslut');
  if(d.trades.some(t=>t?.symbol!==symbol||!positive(t.opened)||!positive(t.at)||t.at<t.opened||!finite(t.pnl)||!['trend','likvidation'].includes(t.reason)))throw Error('Bord '+symbol+' har ogiltiga avslut');
  return d;
}
export const trendEquity=(desk,price)=>desk.cash+(desk.position?.units??0)*price;
// Cross margin on the desk balance: liquidation when equity falls to the maintenance margin.
export const trendLiquidation=desk=>{const p=desk.position;return p&&desk.cash<0?-desk.cash/(p.units*(1-TREND.maintenance)):0;};

function close(desk,symbol,exit,at,reason,pnl){
  const p=desk.position;
  desk.trades.push({symbol,opened:p.openedAt,at,entry:p.entry,exit,pnl,fees:p.fees,funding:p.funding,reason,peakExposure:p.peakExposure});
  desk.position=null;
}
// Fill from the current size to `units` at price with slippage and fee. Returns the decision action.
function tradeTo(desk,symbol,units,price,now){
  const p=desk.position,held=p?.units??0,du=units-held;
  if(!du||units>0&&Math.abs(du)*price<.01)return held?'behåll':'avvakta';
  const fill=price*(1+Math.sign(du)*TREND.slip),fee=Math.abs(du)*fill*TREND.fee,before=trendEquity(desk,price);
  desk.cash-=du*fill+fee;desk.fees+=fee;
  if(!p){
    desk.position={symbol,units,entry:fill,openedAt:now,equityAtOpen:before,fees:fee,funding:0,
      nextBar:(Math.floor(now/TREND.step)+1)*TREND.step,fundingThrough:now,peakExposure:units*price/(desk.cash+units*price)};
    return 'köp';
  }
  p.fees+=fee;
  if(units<=0){close(desk,symbol,fill,now,'trend',desk.cash-p.equityAtOpen);return 'sälj';}
  if(du>0)p.entry=(held*p.entry+du*fill)/units;
  p.units=units;p.peakExposure=Math.max(p.peakExposure,units*price/trendEquity(desk,price));
  return du>0?'öka':'minska';
}
function quote(m,now){
  if(!m||![m.price,m.mark].every(positive)||!finite(m.at)||m.at>now+5000||now-m.at>120000)throw Error('Färska perpetualpriser saknas');
}
// Funding and liquidation on mark-price history since the last check, in time order.
export function settleTrendRisk(desk,symbol,market,now){
  validateTrendDesk(desk,symbol);
  if(!desk.position)return desk;
  const step=TREND.step,bars=market?.markBars,funds=market?.funding,p0=desk.position;
  if(!Array.isArray(bars)||!Array.isArray(funds)||!finite(market.historyFrom)||market.historyFrom>Math.min(p0.nextBar,Math.floor(p0.fundingThrough/step)*step)||
    !finite(market.fundingThrough)||market.fundingThrough<now-120000||market.fundingThrough<p0.fundingThrough||!positive(market.mark)||!positive(market.price))throw Error('Markpris- eller fundinghistorik saknas');
  if(bars.some(b=>!finite(b.t)||b.t%step||![b.o,b.h,b.l,b.c].every(positive)||b.h<Math.max(b.o,b.c,b.l)||b.l>Math.min(b.o,b.c)))throw Error('Ogiltiga markpriser');
  if(funds.some((f,i)=>!finite(f.t)||!finite(f.rate)||i&&f.t<=funds[i-1].t))throw Error('Ogiltig fundinghistorik');
  const next=structuredClone(desk),p=next.position,current=Math.floor(now/step)*step,required=bars.filter(b=>b.t>=p.nextBar&&b.t<=current);
  if(p.nextBar<=current&&(required.length!==(current-p.nextBar)/step+1||required.some((b,i)=>b.t!==p.nextBar+i*step)))throw Error('Lucka i markprishistoriken');
  const outstanding=funds.filter(f=>f.t>p.fundingThrough&&f.t<=now);let fi=0;
  const charge=until=>{while(fi<outstanding.length&&outstanding[fi].t<=until){
    const f=outstanding[fi++],b=bars.find(b=>b.t===f.t);if(!b)throw Error('Fundingmarkpris saknas');
    const cost=p.units*b.o*f.rate;next.cash-=cost;next.funding+=cost;p.funding+=cost;}};
  // Liquidation takes the whole desk balance, as in the research simulation.
  const liquidate=(price,at)=>{next.cash=0;close(next,symbol,price,at,'likvidation',-p.equityAtOpen);return validateTrendDesk(next,symbol);};
  for(const b of required){
    charge(b.t);
    const liq=trendLiquidation(next);
    if(b.o<=liq)return liquidate(b.o,b.t);
    if(b.l<=liq)return liquidate(liq,Math.min(now,b.t+step));
    if(b.t+step<=now)p.nextBar=b.t+step;
  }
  charge(now);p.fundingThrough=market.fundingThrough;
  if(market.mark<=trendLiquidation(next))return liquidate(Math.min(market.price,market.mark),now);
  return validateTrendDesk(next,symbol);
}
/**
 * One decision per UTC hour. market: {hour, bars (completed hourly candles),
 * price, mark, at, and mark-price/funding history when a position is held}.
 * Risk settles first. Trades happen when the number of active horizons changes
 * or volatility moves the target by more than a quarter; a paused desk only reduces.
 */
export function advanceTrendDesk(desk,symbol,market,now){
  let next=settleTrendRisk(desk,symbol,market,now);
  const hour=Math.floor(now/HOUR)*HOUR;
  if(market?.hour!==hour)throw Error('Timpriserna tillhör fel timme');
  if(next.signal.through!==null&&next.signal.through>=hour)return next;
  quote(market,now);
  if(next===desk)next=structuredClone(desk);
  next.signal=advanceTrendSignal(next.signal,market.bars,hour);
  const count=trendCount(next.signal),vol=trendVol(market.bars,hour),price=market.price;
  const units=next.position?.units??0,equity=trendEquity(next,price),alive=equity>0;
  const target=alive?trendTarget(count,vol):0,current=alive?units*price/equity:0;
  const changed=count!==next.lastCount,drift=Math.abs(target-current)>TREND.band*Math.max(Math.abs(target),Math.abs(current));
  let action=units?'behåll':'avvakta';
  if(alive&&(changed||target!==current&&drift||target===0&&units!==0)){
    if(!next.enabled&&target>current)action='pausad';
    else{action=tradeTo(next,symbol,target*equity/price,price,now);next.lastCount=count;}
  }
  const after=trendEquity(next,price);
  next.startedAt??=now;
  next.decisions.push({hour,at:now,count,target,vol:finite(vol)?vol:null,exposure:after>0&&next.position?next.position.units*price/after:0,action,price});
  if(next.decisions.length>TREND.decisionLimit)next.decisions=next.decisions.slice(-TREND.decisionLimit);
  return validateTrendDesk(next,symbol);
}
// Live balance net of estimated closing costs; waits for a fresh quote and a recent risk check.
export function trendLiveValue(desk,q,now){
  const p=desk.position;
  if(!p)return {balance:desk.cash,openNet:null,openReturn:null,exposure:0,at:null,reason:'',quote:null};
  if(!fresh(q,now))return {balance:null,openNet:null,openReturn:null,exposure:null,at:null,reason:'Väntar på färskt pris',quote:null};
  if(!finite(p.fundingThrough)||now-p.fundingThrough>120000)return {balance:null,openNet:null,openReturn:null,exposure:null,at:null,reason:'Väntar på funding- och likvidationskontroll',quote:q};
  const exit=q.price*(1-TREND.slip),balance=Math.max(0,desk.cash+p.units*exit*(1-TREND.fee)),equity=trendEquity(desk,q.price);
  return {balance,openNet:balance-p.equityAtOpen,openReturn:(balance-p.equityAtOpen)/p.equityAtOpen,exposure:equity>0?p.units*q.price/equity:null,at:q.at,reason:'',quote:q};
}
