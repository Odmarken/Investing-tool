import test from 'node:test';
import assert from 'node:assert/strict';
import {TREND,WINDOW,newTrendSignal,advanceTrendSignal,trendCount,trendStops,trendEntryPlan,newTrendDesk,validateTrendDesk,advanceTrendDesk,settleTrendRisk,closeTrendDesk,trendLiveValue,trendLiquidation,trendEquity} from '../floor-trend.js';
import {fetchHourly,fetchTrendMarket,clearTrendCache,historyStart} from '../floor-trend-market.js';
import {CONTRACTS,isolatedLevel} from '../bybit-contracts.js';
import {donchianSides,slidingExtrema} from '../research/floor-trend-core.mjs';

const HOUR=3600000,STEP=TREND.step;
const T0=Date.parse('2024-01-01T00:00:00Z');
// A seeded random walk with trends: each open equals the previous close.
function walk(n,seed=11,cycle=900,amp=.0012,t0=T0){
  let x=seed,c=100;const bars=[];
  const rnd=()=>(x=(x*48271)%2147483647)/2147483647;
  for(let i=0;i<n;i++){
    const drift=Math.sin(i/cycle)*amp,o=c;c=o*Math.exp(drift+(rnd()-.5)*.02);
    bars.push({t:t0+i*HOUR,o,h:Math.max(o,c)*(1+rnd()*.004),l:Math.min(o,c)*(1-rnd()*.004),c});
  }
  return bars;
}
// Bybit's limits as parseContract returns them; tier 2 shows a larger position's lower ceiling.
const limits=(at,max=150,maintenance=.005)=>({symbol:'BTC',contract:CONTRACTS.BTC,at,min:1,max,step:.01,
  tiers:[{id:1,cap:300000,max,maintenance,deduction:0},{id:2,cap:2000000,max:100,maintenance:.01,deduction:510}]});
const flatMarks=(from,to,price=100)=>{const out=[];for(let t=from;t<=to;t+=STEP)out.push({t,o:price,h:price,l:price,c:price});return out;};
const market=(bars,now,extra={})=>{
  const hour=Math.floor(now/HOUR)*HOUR,upto=bars.filter(b=>b.t<hour),price=bars.find(b=>b.t===hour)?.o??upto.at(-1).c;
  return {hour,bars:upto,price,mark:price,at:now,contract:limits(now),...extra};
};
const risk=(desk,now,price,extra={})=>{
  const p=desk.position,from=Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP);
  return {price,mark:price,at:now,historyFrom:from,fundingThrough:now,funding:[],markBars:flatMarks(from,Math.floor(now/STEP)*STEP,price),...extra};
};
// One hourly decision with the risk history a held desk needs.
const step=(desk,symbol,bars,t,extra={})=>{const m=market(bars,t,extra);if(desk.position)Object.assign(m,risk(desk,t,m.price));return advanceTrendDesk(desk,symbol,m,t);};
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps*Math.max(1,Math.abs(b)),a+' vs '+b);
// Flat with noise for 400 days, then a steady climb that breaks every channel.
function climb(){
  const bars=[];let c=100;
  for(let i=0;i<24*420;i++){const o=c;if(i>=24*400)c*=1.001;bars.push({t:T0+i*HOUR,o,h:Math.max(o,c),l:Math.min(o,c),c});}
  return bars.map((b,i)=>i<24*400?{...b,c:b.c*(1+.01*Math.sin(i/7)),h:b.c*1.02,l:b.c*.98}:b);
}
// A fresh desk stepped from the start of the climb until it buys; t is the next decision hour.
function heldDesk(symbol='BTC',bars=climb()){
  let desk=newTrendDesk(),t=bars[24*400].t;
  while(!desk.position){desk=step(desk,symbol,bars,t);t+=HOUR;assert.ok(t<bars[24*405].t,'the climb should buy within days');}
  return {desk,t,bars};
}

test('the live signal replays exactly the research Donchian horizons, in one pass or hour by hour',()=>{
  const bars=walk(24*400),closes=Float64Array.from(bars,b=>b.c);
  const research=TREND.lookbacks.map(n=>donchianSides(closes,n*24));
  const upto=bars.at(-1).t+HOUR,batch=advanceTrendSignal(newTrendSignal(),bars,upto);
  assert.deepEqual(batch.sides,research.map(s=>s.at(-1)));
  assert.equal(batch.through,upto);
  // Incremental from a mid-point state gives the same states at every hour.
  const mid=bars[24*380].t;let s=advanceTrendSignal(newTrendSignal(),bars.filter(b=>b.t<mid),mid);
  for(let t=mid+HOUR;t<=upto;t+=HOUR){
    s=advanceTrendSignal(s,bars.filter(b=>b.t<t),t);
    const k=(t-HOUR-T0)/HOUR;assert.deepEqual(s.sides,research.map(r=>r[k]),'hour '+k);
  }
  assert.deepEqual(s,batch);
  assert.equal(advanceTrendSignal(s,bars,upto),s);
  // Every active horizon has a stop below the latest close; flat ones have none.
  s.sides.forEach((side,i)=>side?assert.ok(s.stops[i]>0&&s.stops[i]<closes.at(-1)*1.5):assert.equal(s.stops[i],null));
  assert.throws(()=>advanceTrendSignal(s,bars.slice(-100),upto+HOUR),/timhistorik|beslutstimmen/);
  assert.equal(trendStops(newTrendSignal()),null);
});

test('a new desk starts with every horizon off and switches one on only on a breakout after its start',()=>{
  const bars=walk(24*400,5,80,.004),closes=Float64Array.from(bars,b=>b.c);
  // Start in an hour where the full history has horizons on, so the reset visibly differs.
  const full=TREND.lookbacks.map(n=>donchianSides(closes,n*24));
  let k0=24*372;while(full.every(s=>s[k0-1]===0))k0++;
  const start=bars[k0].t;
  // Reference: the research rule from an all-off state at the start hour.
  const reference=TREND.lookbacks.map(n=>{
    const N=n*24,{mx,mn}=slidingExtrema(closes,N),out=[];let s=0,stop=NaN;
    for(let k=k0;k<closes.length;k++){const c=closes[k],mid=(mx[k]+mn[k])/2;if(s===1){if(c<stop)s=0;else stop=Math.max(stop,mid);}else if(c>mx[k-1]){s=1;stop=mid;}out[k]=s;}
    return out;
  });
  let desk=step(newTrendDesk(),'BTC',bars,start);
  assert.equal(desk.decisions[0].action,'start');assert.equal(desk.signal.through,start);assert.equal(trendCount(desk.signal),0);
  assert.equal(desk.position,null);assert.equal(validateTrendDesk(desk,'BTC'),desk);
  const replayed=advanceTrendSignal(newTrendSignal(),bars.filter(b=>b.t<start),start);
  assert.ok(trendCount(replayed)>0,'the full history would have had horizons on at the start');
  let bought=false;
  for(let t=start+HOUR;t<=bars.at(-1).t;t+=HOUR){
    const before=trendCount(desk.signal);desk=step(desk,'BTC',bars,t);
    const k=(t-HOUR-T0)/HOUR;assert.deepEqual(desk.signal.sides,reference.map(r=>r[k]),'hour '+k);
    // The first horizon to switch on after the start buys with the whole balance.
    if(!bought&&before===0&&trendCount(desk.signal)>0){assert.equal(desk.decisions.at(-1).action,'köp');assert.equal(desk.position.leverage,150);bought=true;}
  }
  assert.ok(bought,'the walk breaks out after the start');
});

test('the buy takes Bybit\'s maximum for the whole balance and the liquidation follows the locked tier',()=>{
  const now=T0+HOUR,plan=trendEntryPlan(limits(now),100,100,100,now),fill=100*(1+TREND.slip);
  assert.equal(plan.leverage,150);assert.equal(plan.maintenance,.005);assert.equal(plan.deduction,0);assert.equal(plan.riskId,1);
  assert.ok(Math.abs(plan.units*fill*(1/150+TREND.fee)-100)<1e-9,'margin plus the opening fee is the whole balance');
  // A larger balance reaches the next tier: lower leverage, its maintenance margin and deduction.
  const big=trendEntryPlan(limits(now),5000,100,100,now);
  assert.equal(big.leverage,100);assert.equal(big.riskId,2);assert.equal(big.maintenance,.01);assert.equal(big.deduction,510);
  assert.equal(trendEntryPlan(limits(now,50,.01),100,100,100,now).leverage,50);
  assert.throws(()=>trendEntryPlan(null,100,100,100,now),/hävstångsgräns saknas/);
  assert.throws(()=>trendEntryPlan(limits(now-11*60000),100,100,100,now),/för gammal/);
  // The ledger's liquidation equals Bybit's isolated level for that margin.
  const {desk:bought}=heldDesk(),p=bought.position;
  assert.equal(bought.decisions.at(-1).action,'köp');assert.equal(p.leverage,150);assert.equal(p.maintenance,.005);assert.equal(p.riskId,1);
  near(trendLiquidation(bought),isolatedLevel('long',p.entry,100,p.units,TREND.fee,p));
  assert.ok(trendLiquidation(bought)>p.entry*.993&&trendLiquidation(bought)<p.entry,'150× sits well under one percent from liquidation');
  assert.ok(bought.decisions.at(-1).exposure>130,'the position is worth more than 130 times the balance after costs');
  near(p.equityAtOpen,100);near(trendEquity(bought,p.entry)+p.fees,100,1e-6);
});

test('a held desk keeps its size while trends join, and sells when every horizon is off',()=>{
  const noise=climb();
  let desk=newTrendDesk(),t=noise[24*400].t;
  const actions=[];let units=null;
  for(;t<=noise[24*419].t;t+=HOUR){
    desk=step(desk,'SOL',noise,t);actions.push(desk.decisions.at(-1).action);
    if(desk.position){units??=desk.position.units;assert.equal(desk.position.units,units,'no scaling at maximum leverage');}
  }
  assert.equal(actions[0],'start');assert.equal(actions.filter(a=>a==='köp').length,1);assert.ok(actions.includes('behåll'));
  assert.ok(desk.position&&desk.position.leverage===150);assert.ok(trendCount(desk.signal)>=5);
  assert.equal(desk.decisions.length,actions.length);
  // Same hour twice: no second decision.
  const again=advanceTrendDesk(desk,'SOL',{...market(noise,t-HOUR),...risk(desk,t-HOUR+1000,noise.at(-1).c)},t-HOUR+1000);
  assert.equal(again.decisions.length,desk.decisions.length);
  // A close below every stop but above liquidation sells everything with one round-trip record.
  const stops=trendStops(desk.signal),liq=trendLiquidation(desk);
  assert.ok(liq<stops.last*.97,'after the climb the liquidation sits below the lowest trend stop');
  const price=stops.last*.98,top=noise.at(-1).c,crash=[...noise.filter(b=>b.t<t),{t,o:top,h:top,l:price,c:price}];
  const m=market(crash,t+HOUR,{price,mark:price});Object.assign(m,risk(desk,t+HOUR,price));
  const out=advanceTrendDesk(desk,'SOL',m,t+HOUR);
  assert.equal(out.position,null);assert.equal(out.trades.length,1);assert.equal(out.trades[0].reason,'trend');assert.equal(out.trades[0].leverage,150);
  near(out.cash,desk.position.equityAtOpen+out.trades[0].pnl);
  assert.equal(out.decisions.at(-1).action,'sälj');assert.equal(out.lastCount,0);assert.equal(validateTrendDesk(out,'SOL'),out);
  // Paused and flat: a new horizon does not buy, and the buy waits for the resume.
  const paused=step({...structuredClone(newTrendDesk()),enabled:false},'SOL',noise,noise[24*400].t);
  let p=paused;for(let h=noise[24*400].t+HOUR;h<=noise[24*405].t;h+=HOUR)p=step(p,'SOL',noise,h);
  assert.equal(p.position,null);assert.ok(trendCount(p.signal)>0);assert.equal(p.decisions.at(-1).action,'pausad');
  assert.equal(p.lastCount,0,'a paused desk keeps the trends it has not bought');
  const resumed=step({...p,enabled:true},'SOL',noise,noise[24*405].t+HOUR);
  assert.equal(resumed.decisions.at(-1).action,'köp');
});

test('without Bybit\'s limits a flat desk leaves the hour undecided and says why',()=>{
  const bars=climb();let desk=newTrendDesk(),t=bars[24*400].t;
  for(;;t+=HOUR){
    const next=step(desk,'BTC',bars,t,{contract:null});
    assert.ok(t<bars[24*405].t,'the climb should try to buy');
    if(next.waitReason){desk=next;break;}desk=next;
  }
  assert.match(desk.waitReason,/^Köpet väntar: Bybits hävstångsgräns saknas/);assert.equal(desk.signal.through,t-HOUR);assert.equal(desk.position,null);
  assert.equal(step(desk,'BTC',bars,t+60000,{contract:null}),desk,'the same reason is not rewritten');
  const bought=step(desk,'BTC',bars,t+120000);
  assert.equal(bought.decisions.at(-1).action,'köp');assert.equal(bought.waitReason,undefined);assert.equal(bought.signal.through,t);
});

test('Stäng trade settles risk, sells the clicked position at the quote and waits for a new horizon',()=>{
  let {desk:held,t,bars}=heldDesk();
  // Ride the climb until every horizon is on and the gain covers the round trip's costs.
  while(trendCount(held.signal)<TREND.lookbacks.length){held=step(held,'BTC',bars,t);t+=HOUR;}
  for(let i=0;i<6;i++){held=step(held,'BTC',bars,t);t+=HOUR;}
  const p=held.position,now=t-HOUR+20*60000,price=bars.find(b=>b.t===t-HOUR).o;
  const closed=closeTrendDesk(held,'BTC',risk(held,now,price),now,p.openedAt);
  assert.equal(closed.position,null);assert.equal(closed.trades.at(-1).reason,'manuell');assert.equal(closed.trades.at(-1).leverage,150);
  assert.ok(closed.trades.at(-1).pnl>0,'the climb paid');
  near(closed.trades.at(-1).exit,price*(1-TREND.slip));near(closed.cash,p.equityAtOpen+closed.trades.at(-1).pnl);
  assert.equal(closed.lastCount,TREND.lookbacks.length);assert.equal(validateTrendDesk(closed,'BTC'),closed);
  assert.deepEqual(held.position,p,'closing never mutates the input');
  // Every horizon is still on next hour: no new one switched on, so the desk does not buy back.
  const same=step(closed,'BTC',bars,t);
  assert.equal(trendCount(same.signal),TREND.lookbacks.length);assert.equal(same.decisions.at(-1).action,'avvakta');assert.equal(same.position,null);
  // A different trade id or a flat desk is left alone; a mark wick through liquidation wins over the close.
  assert.equal(closeTrendDesk(held,'BTC',risk(held,now,price),now,p.openedAt+1).position.openedAt,p.openedAt);
  const liq=trendLiquidation(held),wick=risk(held,now,price);wick.markBars=wick.markBars.map((b,i)=>i===1?{...b,l:liq*.999}:b);
  const gone=closeTrendDesk(held,'BTC',wick,now,p.openedAt);
  assert.equal(gone.trades.at(-1).reason,'likvidation');assert.equal(gone.cash,0);
  assert.throws(()=>closeTrendDesk(held,'BTC',{...risk(held,now,price),at:now-200000},now,p.openedAt),/Färska/);
});

test('funding is charged on mark history and a crash below the liquidation price takes the desk',()=>{
  const bars=walk(24*400,3);let desk=newTrendDesk(),t=bars[24*399].t;
  // A hand-made 2.5× long tests settlement independently of the signal.
  desk={...desk,cash:-150,position:{symbol:'BTC',units:2.5,entry:100,openedAt:t-HOUR,equityAtOpen:100,fees:.1,funding:0,nextBar:t,fundingThrough:t-HOUR,peakExposure:2.5,
    leverage:2.5,maintenance:.01,deduction:0,riskId:1},
    signal:{...newTrendSignal(),through:t,sides:[1,1,0,0,0,0,0,0,0],stops:[90,80,null,null,null,null,null,null,null]},lastCount:2,
    decisions:[{hour:t,at:t+1,count:2,leverage:2.5,exposure:2.5,action:'köp',price:100}],startedAt:t};
  validateTrendDesk(desk,'BTC');assert.throws(()=>validateTrendDesk(desk,'ETH'),/fel coin/);
  assert.throws(()=>validateTrendDesk({...desk,position:{...desk.position,maintenance:0}},'BTC'),/trendposition/);
  const now=t+30*60000,m={price:100,mark:100,at:now,historyFrom:t-HOUR,fundingThrough:now,funding:[{t,rate:.001}],markBars:flatMarks(t-HOUR,Math.floor(now/STEP)*STEP)};
  const paid=settleTrendRisk(desk,'BTC',m,now);
  near(paid.cash,-150-2.5*100*.001);near(paid.funding,.25);assert.equal(paid.position.fundingThrough,now);
  const liq=trendLiquidation(paid);near(liq,150.25/(2.5*(1-.01-TREND.fee)));
  const bad=flatMarks(t-HOUR,Math.floor(now/STEP)*STEP).map(b=>b.t===t+10*60000?{...b,l:liq-1,c:liq+1}:b);
  const gone=settleTrendRisk(desk,'BTC',{...m,markBars:bad},now);
  assert.equal(gone.position,null);assert.equal(gone.cash,0);assert.equal(gone.trades[0].reason,'likvidation');assert.equal(gone.trades[0].pnl,-100);assert.equal(gone.trades[0].leverage,2.5);
  assert.throws(()=>settleTrendRisk(desk,'BTC',{...m,markBars:bad.filter(b=>b.t!==t+5*60000)},now),/Lucka/);
  assert.throws(()=>settleTrendRisk(desk,'BTC',{...m,fundingThrough:now-300000},now),/historik saknas/);
  // A liquidated desk has no balance left and never buys again.
  const dead=advanceTrendDesk(gone,'BTC',market(bars.filter(b=>b.t<t+HOUR),t+HOUR+1000),t+HOUR+1000);
  assert.equal(dead.position,null);assert.equal(dead.decisions.at(-1).action,'avvakta');
  // Live value nets closing costs and waits for fresh, reconciled data.
  const v=trendLiveValue(paid,{price:110,mark:110,at:now},now);
  near(v.balance,paid.cash+2.5*110*(1-TREND.slip)*(1-TREND.fee));near(v.openNet,v.balance-100);
  assert.equal(trendLiveValue(paid,{price:110,mark:110,at:now-60000},now).balance,null);
  assert.equal(trendLiveValue(paid,{price:110,mark:110,at:now+200000},now+200000).reason,'Väntar på funding- och likvidationskontroll');
  assert.equal(trendLiveValue(newTrendDesk(),null,now).balance,100);
});

const NOW=T0+24*800*HOUR+90000;
function bybitKlines(bars,{skip=new Set(),calls=[]}={}){
  return async url=>{
    const u=new URL(url),q=Object.fromEntries(u.searchParams);calls.push(q);
    if(u.pathname.endsWith('/kline')){
      const list=bars.filter(b=>b.t>=+q.start&&b.t<=+q.end&&!skip.has(b.t)).slice(-(+q.limit)).reverse().map(b=>[String(b.t),String(b.o),String(b.h),String(b.l),String(b.c),'1','1']);
      return {retCode:0,result:{category:'linear',symbol:q.symbol,list},time:NOW};
    }
    if(u.pathname.endsWith('/tickers'))return {retCode:0,result:{category:'linear',list:[{symbol:q.symbol,lastPrice:'100',markPrice:'100',nextFundingTime:String(NOW+HOUR)}]},time:NOW};
    if(u.pathname.endsWith('/instruments-info'))return {retCode:0,time:NOW,result:{category:'linear',list:[{symbol:q.symbol,status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'150',leverageStep:'.01'}}]}};
    if(u.pathname.endsWith('/risk-limit'))return {retCode:0,time:NOW,result:{category:'linear',list:[{id:1,symbol:q.symbol,riskLimitValue:'300000',maxLeverage:'150',maintenanceMargin:'.0033',mmDeduction:''}]}};
    throw Error('unexpected '+url);
  };
}

test('hourly candles are paged from Bybit, cached and refreshed one page at a time',async()=>{
  clearTrendCache();
  const bars=walk(24*801,9),hour=Math.floor(NOW/HOUR)*HOUR,calls=[];
  const grab=bybitKlines(bars.filter(b=>b.t<hour+HOUR),{calls}),now=()=>NOW;
  const from=hour-WINDOW*HOUR-HOUR,got=await fetchHourly(grab,'BTC',from,hour,now);
  assert.equal(got.length,WINDOW+1);assert.equal(got[0].t,from);assert.equal(got.at(-1).t,hour-HOUR);
  assert.equal(calls.length,Math.ceil((WINDOW+1)/1000));
  calls.length=0;const again=await fetchHourly(grab,'BTC',from,hour,now);
  assert.equal(calls.length,0);assert.deepEqual(again,got);
  // A later hour fetches only the new candle.
  const later=()=>NOW+HOUR;const grab2=bybitKlines(bars,{calls});
  calls.length=0;const next=await fetchHourly(async(u,o)=>({...(await grab2(u,o)),time:NOW+HOUR}),'BTC',from+HOUR,hour+HOUR,later);
  assert.equal(calls.length,1);assert.equal(next.at(-1).t,hour);
  // An old gap is filled flat; a missing latest candle waits.
  clearTrendCache();
  const gappy=bybitKlines(bars.filter(b=>b.t<hour),{skip:new Set([hour-50*HOUR])});
  const filled=await fetchHourly(gappy,'ETH',hour-100*HOUR,hour,now);
  assert.equal(filled.find(b=>b.t===hour-50*HOUR).c,filled.find(b=>b.t===hour-51*HOUR).c);
  clearTrendCache();
  await assert.rejects(fetchHourly(bybitKlines(bars.filter(b=>b.t<hour-HOUR)),'ETH',hour-100*HOUR,hour,now),/Senaste timstapeln/);
  assert.equal(historyStart(newTrendDesk(),hour),hour-WINDOW*HOUR);
  assert.equal(historyStart({signal:{through:hour-3*HOUR}},hour),hour-3*HOUR-WINDOW*HOUR);
});

test('the market fetch gives each desk candles, a quote and Bybit\'s limits for a flat desk',async()=>{
  clearTrendCache();
  const bars=walk(24*800+30,4),hour=Math.floor(NOW/HOUR)*HOUR,calls=[],grab=bybitKlines(bars.filter(b=>b.t<hour),{calls});
  const desks={BTC:newTrendDesk(),SHIB:newTrendDesk()},m=await fetchTrendMarket(grab,()=>NOW,desks);
  assert.equal(m.hour,hour);assert.deepEqual(Object.keys(m.market),['BTC','SHIB']);
  assert.equal(m.market.BTC.bars.length,WINDOW);assert.equal(m.market.BTC.price,100);
  assert.equal(m.market.BTC.contract.max,150);assert.equal(m.market.BTC.contract.tiers[0].maintenance,.0033);
  assert.ok(Math.abs(m.market.SHIB.bars.at(-1).c-bars.find(b=>b.t===hour-HOUR).c/1000)<1e-12);
  const next=advanceTrendDesk(desks.BTC,'BTC',{hour,...m.market.BTC},NOW);
  assert.equal(next.signal.through,hour);assert.equal(next.decisions.length,1);assert.equal(next.decisions[0].action,'start');
});
