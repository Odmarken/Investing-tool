// Trading floor trend research: signals and a per-desk perpetual simulator.
// Decisions use completed hourly bars only; orders fill on the next hourly open.
// See floor-trend-protocol.md. Nothing here touches the live desks.
import {activeSignal} from '../crypto-momentum-active-signal.js';

export const HOUR=3600000,DAY=24*HOUR;
export const LOOKBACKS=Object.freeze([5,10,20,30,60,90,150,250,360]);
export const COSTS=Object.freeze({fee:.00055,slip:.0005});
export const SIZING=Object.freeze({volTarget:.25,maxLeverage:1,volDays:90,minVolDays:30,band:.25,maintenance:.01});

// UTC day closes: the close of each 23:00 bar. i is that bar's index.
export function dailyCloses(bars){
  const days=[];
  for(let i=0;i<bars.length;i++)if((bars[i].t+HOUR)%DAY===0)days.push({t:bars[i].t+HOUR,c:bars[i].c,i});
  return days;
}
// Annualised volatility of the latest volDays daily log returns ending at day d.
export function dailyVol(days,volDays=SIZING.volDays,minDays=SIZING.minVolDays){
  const vol=new Float64Array(days.length).fill(NaN);
  for(let d=1;d<days.length;d++){
    const from=Math.max(1,d-volDays+1),n=d-from+1;if(n<minDays)continue;
    let s=0,s2=0;for(let j=from;j<=d;j++){const r=Math.log(days[j].c/days[j-1].c);s+=r;s2+=r*r;}
    const mean=s/n;vol[d]=Math.sqrt(Math.max(0,(s2-n*mean*mean)/(n-1))*365);
  }
  return vol;
}
// Sliding max/min over the n values ending at k (fewer at the start).
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
// One Donchian horizon: breakout over the n previous closes, trailing stop at
// the midpoint of the n closes ending now. An exit does not re-enter the same step.
export function donchianSides(closes,n,short=false){
  const side=new Int8Array(closes.length),{mx,mn}=slidingExtrema(closes,n);
  let s=0,stop=NaN;
  for(let k=n;k<closes.length;k++){
    const c=closes[k],mid=(mx[k]+mn[k])/2;
    if(s===1){if(c<stop)s=0;else stop=Math.max(stop,mid);}
    else if(s===-1){if(c>stop)s=0;else stop=Math.min(stop,mid);}
    else if(c>mx[k-1]){s=1;stop=mid;}
    else if(short&&c<mn[k-1]){s=-1;stop=mid;}
    side[k]=s;
  }
  return side;
}
export function ensembleSignal(closes,steps,short=false){
  const sum=new Float64Array(closes.length);
  for(const n of steps){const side=donchianSides(closes,n,short);for(let k=0;k<closes.length;k++)sum[k]+=side[k];}
  return sum.map(v=>v/steps.length);
}
function emaSeries(values,n){
  const out=new Float64Array(values.length),a=2/(n+1);let e=values[0];
  for(let k=0;k<values.length;k++){e=k?a*values[k]+(1-a)*e:values[k];out[k]=e;}
  return out;
}

// Signal per bar: NaN where the strategy makes no decision at that bar's close.
export const STRATEGIES=Object.freeze(['ens9-d-L','ens9-d-LS','ens9-h-L','ens9-h-LS','tsm3-w-L','tsm3-w-LS','ema3-d-LS']);
export function strategySignal(name,bars,days,options={}){
  const out=new Float64Array(bars.length).fill(NaN),dc=Float64Array.from(days,d=>d.c);
  const lookbacks=options.lookbacks??LOOKBACKS;
  const byDay=values=>{days.forEach((d,k)=>{if(Number.isFinite(values[k]))out[d.i]=values[k];});return out;};
  switch(name){
    case 'ens9-d-L':case 'ens9-d-LS':return byDay(ensembleSignal(dc,lookbacks,name.endsWith('LS')));
    case 'ens9-h-L':case 'ens9-h-LS':{
      const s=ensembleSignal(Float64Array.from(bars,b=>b.c),lookbacks.map(n=>n*24),name.endsWith('LS'));
      for(let i=0;i<bars.length;i++)out[i]=s[i];return out;
    }
    case 'tsm3-w-L':case 'tsm3-w-LS':{
      const v=new Float64Array(days.length).fill(NaN);
      days.forEach((d,k)=>{
        if(k<56||new Date(d.t).getUTCDay()!==1)return;
        const m=[14,28,56].reduce((s,n)=>s+dc[k]/dc[k-n]-1,0)/3;
        v[k]=name.endsWith('LS')?Math.sign(m):m>0?1:0;
      });
      return byDay(v);
    }
    case 'ema3-d-LS':{
      const pairs=[[8,32],[16,64],[32,128]].map(([f,s])=>[emaSeries(dc,f),emaSeries(dc,s)]);
      return byDay(Float64Array.from(dc,(_,k)=>k<128?NaN:pairs.reduce((s,[f,sl])=>s+Math.sign(f[k]-sl[k]),0)/3));
    }
    case 'bh':{days.forEach(d=>{out[d.i]=1;});return out;}
  }
  throw Error('Unknown strategy '+name);
}

// Index of the latest completed UTC day at each bar's close.
export function dayIndexAtBar(bars,days){
  const out=new Int32Array(bars.length).fill(-1);let d=-1;
  for(let i=0;i<bars.length;i++){while(d+1<days.length&&days[d+1].i<=i)d++;out[i]=d;}
  return out;
}

/**
 * Run one desk from `start` (inclusive) to `end` (exclusive) with 100 dollars.
 * signal[i] is the decision made at the close of bar i (NaN: no decision).
 * Returns hourly closing equity aligned to the period plus ledger totals.
 */
export function simulateDesk(coin,{bars,funding,days,vol,dayAt},signal,{start,end,costs=COSTS,sizing=SIZING,capital=100,fixedExposure=null}){
  const first=bars[0].t,i0=(start-first)/HOUR,i1=(end-first)/HOUR;
  if(!Number.isInteger(i0)||i0<1||i1>bars.length)throw Error(coin+' lacks bars for the period');
  const H=i1-i0,equity=new Float64Array(H);
  let cash=capital,units=0,pending=null,lastSignal=0,dead=false,fi=0;
  const t={orders:0,roundTrips:0,fees:0,slippage:0,funding:0,liquidations:0,barsIn:0,barsShort:0,exposureSum:0,peakExposure:0,trades:[]};
  let openAt=null,openEquity=null;
  while(fi<funding.length&&funding[fi].t<bars[i0].t)fi++;
  // A decision at the close of the bar before the start fills on the first bar.
  const decide=i=>{
    if(dead)return;
    const s=signal[i];if(!Number.isFinite(s))return;
    const c=bars[i].c,eq=cash+units*c,d=dayAt[i],v=d>=0?vol[d]:NaN;
    let target;
    if(fixedExposure!==null)target=s*fixedExposure;
    else target=Number.isFinite(v)&&v>0?s*Math.min(sizing.maxLeverage,sizing.volTarget/v):0;
    const current=units*c/eq,changed=s!==lastSignal;
    const drift=Math.abs(target-current)>sizing.band*Math.max(Math.abs(target),Math.abs(current));
    if(fixedExposure!==null&&!changed)return;
    if(changed||(target!==current&&drift)||(target===0&&units!==0)){pending={units:target*eq/c,signal:s};}
  };
  decide(i0-1);
  for(let i=i0;i<i1;i++){
    const b=bars[i];
    while(fi<funding.length&&funding[fi].t<=b.t){
      if(funding[fi].t===b.t&&units!==0){const cost=units*b.o*funding[fi].rate;cash-=cost;t.funding+=cost;}
      fi++;
    }
    if(pending&&!dead){
      const du=pending.units-units;
      if(du!==0){
        const px=b.o*(1+Math.sign(du)*costs.slip),fee=Math.abs(du)*px*costs.fee;
        cash-=du*px+fee;t.fees+=fee;t.slippage+=Math.abs(du)*b.o*costs.slip;t.orders++;
        const was=units;units=pending.units;
        if(Math.abs(units)<1e-12)units=0;
        if(was!==0&&(units===0||Math.sign(units)!==Math.sign(was))){t.roundTrips++;t.trades.push({opened:openAt,closed:b.t,side:Math.sign(was),pnl:cash+units*b.o-openEquity});openAt=null;}
        if(units!==0&&(was===0||Math.sign(units)!==Math.sign(was))){openAt=b.t;openEquity=cash+units*b.o;}
      }
      lastSignal=pending.signal;pending=null;
    }
    if(units!==0&&!dead){
      const worst=units>0?b.l:b.h,eqWorst=cash+units*worst;
      if(eqWorst<=sizing.maintenance*Math.abs(units)*worst){
        t.liquidations++;t.trades.push({opened:openAt,closed:b.t,side:Math.sign(units),pnl:-openEquity,liquidated:true});
        cash=0;units=0;dead=true;t.roundTrips++;
      }
    }
    const eq=cash+units*b.c;equity[i-i0]=eq;
    if(units!==0){t.barsIn++;if(units<0)t.barsShort++;const x=Math.abs(units*b.c)/eq;t.exposureSum+=x;t.peakExposure=Math.max(t.peakExposure,x);}
    if(i<i1-1)decide(i);
  }
  // Open positions are valued net of the estimated closing fee and slippage.
  const last=bars[i1-1].c,closeCost=Math.abs(units)*last*(costs.fee+costs.slip);
  equity[H-1]-=closeCost;
  if(units!==0)t.trades.push({opened:openAt,closed:null,side:Math.sign(units),pnl:equity[H-1]-openEquity,open:true});
  return {coin,equity,final:equity[H-1],...t,avgExposure:t.barsIn?t.exposureSum/t.barsIn:0,timeInMarket:t.barsIn/H,shortShare:t.barsIn?t.barsShort/t.barsIn:0};
}

// The desks' current rule, through the project's own activeSignal, sized at a
// comparable research risk. Hourly bars: SL before TP in the same bar.
export function simulatePulse12(coin,{bars,funding},{start,end,costs=COSTS,risk=.02,maxExposure=3,capital=100}){
  const first=bars[0].t,i0=(start-first)/HOUR,i1=(end-first)/HOUR;
  if(!Number.isInteger(i0)||i0<80||i1>bars.length)throw Error(coin+' lacks bars for the period');
  const H=i1-i0,equity=new Float64Array(H),out={orders:0,roundTrips:0,fees:0,slippage:0,funding:0,liquidations:0,barsIn:0,barsShort:0,exposureSum:0,peakExposure:0,trades:[]};
  let cash=capital,p=null,pending=null,cooldown=0,fi=0;
  while(fi<funding.length&&funding[fi].t<bars[i0].t)fi++;
  const decide=i=>{
    const now=bars[i].t+HOUR;if(p||now<cooldown)return;
    const sig=activeSignal(coin,bars.slice(i-79,i+1),now,'pulse12');if(sig)pending=sig;
  };
  const exit=(price,at,reason)=>{
    const px=price*(1-costs.slip),fee=p.units*px*costs.fee;
    cash+=p.units*px-fee;out.fees+=fee;out.slippage+=p.units*price*costs.slip;out.orders++;out.roundTrips++;
    out.trades.push({opened:p.at,closed:at,side:1,pnl:cash-p.equity,reason});p=null;cooldown=at+HOUR;
  };
  decide(i0-1);
  for(let i=i0;i<i1;i++){
    const b=bars[i];
    while(fi<funding.length&&funding[fi].t<=b.t){if(funding[fi].t===b.t&&p){const cost=p.units*b.o*funding[fi].rate;cash-=cost;out.funding+=cost;}fi++;}
    if(p){
      if(b.o<=p.sl)exit(b.o,b.t,'SL');
      else if(b.o>=p.tp)exit(p.tp,b.t,'TP');
      else if(b.t>=p.deadline)exit(b.o,b.t,'timeout');
    }
    if(pending&&!p){
      const s=pending,raw=b.o,sl=raw-s.slDistance,tp=raw+s.rewardMultiple*s.slDistance,entry=raw*(1+costs.slip);
      const stopFill=sl*(1-costs.slip),riskPerUnit=entry-stopFill+costs.fee*(entry+stopFill),targetFill=tp*(1-costs.slip);
      const netRR=(targetFill-entry-costs.fee*(entry+targetFill))/riskPerUnit;
      if(Math.abs(raw-s.reference)<=s.slDistance*.5&&sl>0&&netRR>=1.5){
        const units=Math.min(cash*risk/riskPerUnit,cash*maxExposure/entry),fee=units*entry*costs.fee;
        p={units,entry,sl,tp,at:b.t,deadline:b.t+s.maxHoldMs,equity:cash};
        cash-=units*entry+fee;out.fees+=fee;out.slippage+=units*raw*costs.slip;out.orders++;
      }
    }
    pending=null;
    if(p){
      const end=b.t+HOUR;
      if(b.l<=p.sl)exit(p.sl,end,'SL');else if(b.h>=p.tp)exit(p.tp,end,'TP');
    }
    const eq=cash+(p?p.units*b.c:0);equity[i-i0]=eq;
    if(p){out.barsIn++;const x=p.units*b.c/eq;out.exposureSum+=x;out.peakExposure=Math.max(out.peakExposure,x);}
    if(i<i1-1)decide(i);
  }
  if(p){equity[H-1]-=p.units*bars[i1-1].c*(costs.fee+costs.slip);out.trades.push({opened:p.at,closed:null,side:1,pnl:equity[H-1]-p.equity,open:true});}
  return {coin,equity,final:equity[H-1],...out,avgExposure:out.barsIn?out.exposureSum/out.barsIn:0,timeInMarket:out.barsIn/H,shortShare:0};
}

export function prepare(raw,volDays=SIZING.volDays){
  const bars=raw.bars,days=dailyCloses(bars);
  return {bars,funding:raw.funding,days,vol:dailyVol(days,volDays),dayAt:dayIndexAtBar(bars,days)};
}

// Firm statistics from summed hourly equity. Sharpe uses UTC daily equity.
export function firmMetrics(desks,start,capital){
  const H=desks[0].equity.length,eq=new Float64Array(H);
  for(const d of desks)for(let h=0;h<H;h++)eq[h]+=d.equity[h];
  const daily=[capital];for(let h=0;h<H;h++)if((start+(h+1)*HOUR)%DAY===0)daily.push(eq[h]);
  const rets=[];for(let k=1;k<daily.length;k++)rets.push(daily[k]/daily[k-1]-1);
  const mean=rets.reduce((s,r)=>s+r,0)/rets.length,sd=Math.sqrt(rets.reduce((s,r)=>s+(r-mean)**2,0)/(rets.length-1));
  let peak=capital,maxDD=0;for(let h=0;h<H;h++){peak=Math.max(peak,eq[h]);maxDD=Math.max(maxDD,1-eq[h]/peak);}
  const final=eq[H-1],years=H/24/365.25;
  const sum=key=>desks.reduce((s,d)=>s+d[key],0);
  return {capital,final,net:final/capital-1,cagr:final>0?(final/capital)**(1/years)-1:-1,sharpe:sd>0?mean/sd*Math.sqrt(365):0,maxDD,
    roundTrips:sum('roundTrips'),orders:sum('orders'),fees:sum('fees'),funding:sum('funding'),liquidations:sum('liquidations'),
    avgExposure:desks.reduce((s,d)=>s+d.avgExposure*d.timeInMarket,0)/desks.length,timeInMarket:sum('timeInMarket')/desks.length,
    shortShare:sum('barsShort')/Math.max(1,sum('barsIn')),coins:Object.fromEntries(desks.map(d=>[d.coin,d.final-capital/desks.length])),equity:eq,daily};
}
