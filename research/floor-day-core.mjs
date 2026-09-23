// Trading floor day-trading research (floor-day-protocol.md): short channel
// breakouts inside the desks' nine-horizon trend. Discrete long trades with a
// stop order, sized either for research (fixed risk, cross margin) or with the
// old desks' Bybit leverage rules through their own openActivePosition.
import {HOUR,DAY,LOOKBACKS,COSTS,ensembleSignal,slidingExtrema} from './floor-trend-core.mjs';
import {activeSignal} from '../crypto-momentum-active-signal.js';
import {openActivePosition} from '../crypto-momentum-active-execution.js';
import {closeLeveraged,liquidationPrice,leveragedValue} from '../crypto-leverage.js';

export const CANDIDATES=Object.freeze({
  'b24-f-72':Object.freeze({kind:'breakout',hours:24,filter:true,maxHold:72}),
  'b24-f-24':Object.freeze({kind:'breakout',hours:24,filter:true,maxHold:24}),
  'b48-f-72':Object.freeze({kind:'breakout',hours:48,filter:true,maxHold:72}),
  'b24-n-72':Object.freeze({kind:'breakout',hours:24,filter:false,maxHold:72}),
  'vb-f-1d':Object.freeze({kind:'vb',k:.5,filter:true})
});
export const MIN_STOP=.005,TREND_MIN=5;
export const RESEARCH=Object.freeze({risk:.01,cap:5,maintenance:.01});
export const OLD_RULES=Object.freeze({riskFraction:.5,marginFraction:.5,liquidationBuffer:.25});

// Per-coin series shared by every candidate. count[i] is the number of the nine
// trend horizons that are long after the close of bar i, as in the live desks.
export function prepareDay(raw){
  const bars=raw.bars,closes=Float64Array.from(bars,b=>b.c);
  const trend=ensembleSignal(closes,LOOKBACKS.map(n=>n*24));
  const count=Int8Array.from(trend,s=>Math.round(s*LOOKBACKS.length));
  const channels={};
  for(const n of [24,48]){const {mx,mn}=slidingExtrema(closes,n);channels[n]={mx,mn};}
  // UTC day open and the previous day's range, known at each bar.
  const dayOpen=new Float64Array(bars.length).fill(NaN),prevRange=new Float64Array(bars.length).fill(NaN);
  let open=NaN,hi=-Infinity,lo=Infinity,lastRange=NaN;
  for(let i=0;i<bars.length;i++){
    const b=bars[i];
    if(b.t%DAY===0){if(Number.isFinite(open))lastRange=hi-lo;open=b.o;hi=-Infinity;lo=Infinity;}
    hi=Math.max(hi,b.h);lo=Math.min(lo,b.l);dayOpen[i]=open;prevRange[i]=lastRange;
  }
  return {bars,funding:raw.funding,closes,count,channels,dayOpen,prevRange};
}

// Entry decided at the close of bar i: {reference, stop, deadlineFrom(openTime)} or null.
export function entryAt(name,d,i,state){
  const c=CANDIDATES[name],ref=d.closes[i];
  if(c.filter&&d.count[i]<TREND_MIN)return null;
  if(c.kind==='breakout'){
    const {mx,mn}=d.channels[c.hours];
    if(i<c.hours||!(ref>mx[i-1]))return null;
    const stop=Math.min((mx[i]+mn[i])/2,ref*(1-MIN_STOP));
    return {reference:ref,stop,maxHoldMs:c.maxHold*HOUR};
  }
  // Volatility breakout: once per UTC day, never at the day's last close.
  const t=d.bars[i].t,day=Math.floor(t/DAY)*DAY;
  if((t+HOUR)%DAY===0||state.lastEntryDay===day||!Number.isFinite(d.prevRange[i]))return null;
  if(!(ref>d.dayOpen[i]+c.k*d.prevRange[i]))return null;
  return {reference:ref,stop:Math.min(d.dayOpen[i],ref*(1-MIN_STOP)),day,untilNextDay:day+DAY};
}
export function trailAt(name,d,i,stop){
  const c=CANDIDATES[name];
  if(c.kind!=='breakout')return stop;
  const {mx,mn}=d.channels[c.hours];
  return Math.max(stop,(mx[i]+mn[i])/2);
}

/**
 * One desk, one position at a time. mode 'research': fixed risk at the stop on
 * a cross-margined balance. mode 'bybit': the old desks' openActivePosition with
 * today's Bybit tiers, isolated margin and crypto-leverage.js liquidation.
 */
export function simulateDay(coin,d,name,{start,end,costs=COSTS,mode='research',risk=RESEARCH.risk,cap=RESEARCH.cap,contracts=null,capital=100}){
  const bars=d.bars,first=bars[0].t,i0=(start-first)/HOUR,i1=(end-first)/HOUR;
  if(!Number.isInteger(i0)||i0<80||i1>bars.length)throw Error(coin+' lacks bars for the period');
  const H=i1-i0,equity=new Float64Array(H),trades=[],pulse=name==='pulse12';
  let cash=capital,p=null,pending=null,fi=0,cooldown=-Infinity,fees=0,funding=0,barsIn=0,exposureSum=0;
  const state={lastEntryDay:null};
  const funds=d.funding;while(fi<funds.length&&funds[fi].t<bars[i0].t)fi++;
  const liqResearch=()=>p.cash<0?-p.cash/(p.units*(1-RESEARCH.maintenance)):0;
  const exit=(price,at,reason)=>{
    let pnl,fill;
    if(mode==='bybit'){
      const closed=closeLeveraged(p.lev,price,at,reason==='liquidation'?'likvidation':reason);
      cash+=closed.cash;fees+=closed.exitFee;pnl=closed.trade.pnl;fill=closed.trade.exit;
    }else if(reason==='liquidation'){pnl=-p.equityAtOpen;cash=0;fill=price;}
    else{
      fill=price*(1-costs.slip);const fee=p.units*fill*costs.fee;
      cash=p.cash+p.units*fill-fee;fees+=fee;pnl=cash-p.equityAtOpen;
    }
    trades.push({coin,opened:p.at,closed:at,entry:p.entry,exit:fill,pnl,r:pnl/p.risk,reason,hours:(at-p.at)/HOUR,leverage:p.leverage??null,riskPct:p.risk/p.equityAtOpen});
    p=null;cooldown=at+HOUR;
  };
  const value=price=>mode==='bybit'?cash+(p?leveragedValue(p.lev,price):0):(p?p.cash+p.units*price:cash);
  const decide=i=>{
    if(p||pending)return;
    const t=bars[i].t+HOUR;
    if(pulse){
      if(t<cooldown)return;
      const s=activeSignal(coin,bars.slice(i-79,i+1),t,'pulse12');
      if(s)pending={pulse:s,reference:s.reference};
      return;
    }
    const e=entryAt(name,d,i,state);if(e)pending=e;
  };
  const open=(i,b)=>{
    const e=pending;pending=null;const raw=b.o,equityNow=cash;
    if(equityNow<=0)return;
    let stop,tp=Infinity,deadline,slDistance,rewardMultiple=1e6;
    if(e.pulse){slDistance=e.pulse.slDistance;stop=raw-slDistance;tp=raw+e.pulse.rewardMultiple*slDistance;rewardMultiple=e.pulse.rewardMultiple;deadline=b.t+e.pulse.maxHoldMs;}
    else{stop=e.stop;slDistance=raw-stop;deadline=e.untilNextDay??b.t+e.maxHoldMs;}
    if(!(slDistance>0))return;
    if(mode==='bybit'){
      const contract={...contracts[coin],at:b.t};
      const signal={symbol:coin,reference:e.reference,slDistance,rewardMultiple,maxHoldMs:deadline-b.t};
      const lev=openActivePosition(equityNow,{price:raw,mark:raw,contract},signal,b.t,{...OLD_RULES,fee:costs.fee,slip:costs.slip,step:300000});
      if(!lev)return;
      cash-=lev.budget;fees+=lev.fee;
      p={lev,at:b.t,entry:lev.entry,stop:lev.sl,tp,deadline,risk:lev.initialRisk,equityAtOpen:equityNow,leverage:lev.rules.leverage};
    }else{
      const fill=raw*(1+costs.slip),stopFill=stop*(1-costs.slip),riskPerUnit=fill-stopFill+costs.fee*(fill+stopFill);
      if(e.pulse){
        const targetFill=tp*(1-costs.slip),netRR=(targetFill-fill-costs.fee*(fill+targetFill))/riskPerUnit;
        if(Math.abs(raw-e.reference)>slDistance*.5||netRR<1.5)return;
      }
      const units=Math.min(equityNow*risk/riskPerUnit,equityNow*cap/fill),fee=units*fill*costs.fee;
      if(!(units>0))return;
      fees+=fee;
      p={cash:equityNow-units*fill-fee,units,at:b.t,entry:fill,stop,tp,deadline,risk:units*riskPerUnit,equityAtOpen:equityNow};
      cash=0;
    }
    if(e.day!==undefined)state.lastEntryDay=e.day;
  };
  decide(i0-1);
  for(let i=i0;i<i1;i++){
    const b=bars[i];
    while(fi<funds.length&&funds[fi].t<=b.t){
      if(funds[fi].t===b.t&&p&&p.at<b.t){
        const units=mode==='bybit'?p.lev.units:p.units,cost=units*b.o*funds[fi].rate;funding+=cost;
        if(mode==='bybit')p.lev.funding+=cost;else p.cash-=cost;
      }
      fi++;
    }
    if(p){
      const liq=mode==='bybit'?liquidationPrice(p.lev):liqResearch();
      if(b.o<=liq)exit(b.o,b.t,'liquidation');
      else if(b.o<=p.stop)exit(b.o,b.t,'stop-gap');
      else if(b.o>=p.tp)exit(p.tp,b.t,'tp');
      else if(mode==='bybit'&&liquidationPrice(p.lev)>=p.stop)exit(b.o,b.t,'risk');
      else if(b.t>=p.deadline)exit(b.o,b.t,'time');
    }
    if(pending&&!p)open(i,b);else pending=null;
    if(p){
      // The stop order fills before the lower liquidation price.
      if(b.l<=p.stop)exit(p.stop,b.t+HOUR,'stop');
      else if(b.h>=p.tp)exit(p.tp,b.t+HOUR,'tp');
    }
    if(p&&!pulse){p.stop=trailAt(name,d,i,p.stop);if(mode==='bybit')p.lev.sl=p.stop;}
    const v=value(b.c);equity[i-i0]=v;
    if(p){barsIn++;const units=mode==='bybit'?p.lev.units:p.units;exposureSum+=v>0?units*b.c/v:0;}
    if(i<i1-1)decide(i);
  }
  // Open positions are valued net of the estimated closing fee and slippage.
  const last=bars[i1-1].c;
  if(p){
    if(mode==='bybit')equity[H-1]=cash+leveragedValue(p.lev,last);
    else equity[H-1]=p.cash+p.units*last*(1-costs.slip)*(1-costs.fee);
    trades.push({coin,opened:p.at,closed:null,entry:p.entry,exit:null,pnl:equity[H-1]-p.equityAtOpen,r:null,reason:'open',hours:(end-p.at)/HOUR,leverage:p.leverage??null,riskPct:p.risk/p.equityAtOpen});
  }
  const closedTrades=trades.filter(t=>t.reason!=='open');
  return {coin,equity,final:equity[H-1],trades,roundTrips:closedTrades.length,orders:closedTrades.length*2+(p?1:0),fees,funding,
    liquidations:closedTrades.filter(t=>t.reason==='liquidation').length,barsIn,barsShort:0,timeInMarket:barsIn/H,avgExposure:barsIn?exposureSum/barsIn:0};
}

const quantile=(xs,q)=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b),i=(s.length-1)*q,j=Math.floor(i);return s[j]+(s[Math.ceil(i)]-s[j])*(i-j);};
export function tradeStats(desks){
  const all=desks.flatMap(d=>d.trades),closed=all.filter(t=>t.reason!=='open');
  const reasons={};for(const t of closed)reasons[t.reason]=(reasons[t.reason]??0)+1;
  const lev=closed.map(t=>t.leverage).filter(x=>x!==null);
  return {closed:closed.length,winShare:closed.length?closed.filter(t=>t.pnl>0).length/closed.length:null,meanR:closed.length?closed.reduce((s,t)=>s+t.r,0)/closed.length:null,
    medianHours:quantile(closed.map(t=>t.hours),.5),p90Hours:quantile(closed.map(t=>t.hours),.9),reasons,
    leverage:lev.length?{min:Math.min(...lev),median:quantile(lev,.5),max:Math.max(...lev)}:null,medianRiskPct:quantile(closed.map(t=>t.riskPct),.5)};
}
