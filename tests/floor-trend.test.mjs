import test from 'node:test';
import assert from 'node:assert/strict';
import {TREND,WINDOW,newTrendSignal,advanceTrendSignal,trendCount,trendVol,trendTarget,trendStops,newTrendDesk,validateTrendDesk,advanceTrendDesk,settleTrendRisk,trendLiveValue,trendLiquidation} from '../floor-trend.js';
import {fetchHourly,fetchTrendMarket,clearTrendCache,historyStart} from '../floor-trend-market.js';
import {donchianSides,dailyCloses,dailyVol,dayIndexAtBar,strategySignal,simulateDesk,SIZING} from '../research/floor-trend-core.mjs';

const HOUR=3600000,DAY=24*HOUR,STEP=TREND.step;
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
const flatMarks=(from,to,price=100)=>{const out=[];for(let t=from;t<=to;t+=STEP)out.push({t,o:price,h:price,l:price,c:price});return out;};
const market=(bars,now,extra={})=>{
  const hour=Math.floor(now/HOUR)*HOUR,upto=bars.filter(b=>b.t<hour),price=bars.find(b=>b.t===hour)?.o??upto.at(-1).c;
  return {hour,bars:upto,price,mark:price,at:now,...extra};
};
const risk=(desk,now,price,extra={})=>{
  const p=desk.position,from=Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP);
  return {price,mark:price,at:now,historyFrom:from,fundingThrough:now,funding:[],markBars:flatMarks(from,Math.floor(now/STEP)*STEP,price),...extra};
};

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
});

test('volatility and target match the research sizing',()=>{
  const bars=walk(24*200),days=dailyCloses(bars),vol=dailyVol(days),dayAt=dayIndexAtBar(bars,days);
  for(const i of [24*120+5,24*150+23,bars.length-1]){
    const upto=bars[i].t+HOUR;assert.ok(Math.abs(trendVol(bars,upto)-vol[dayAt[i]])<1e-12);
  }
  assert.ok(Number.isNaN(trendVol(bars.slice(0,24*20),T0+24*20*HOUR)));
  assert.equal(trendTarget(9,.5),Math.min(TREND.maxLeverage,TREND.volTarget/.5));
  assert.equal(trendTarget(3,.1),3/9*TREND.maxLeverage);assert.equal(trendTarget(5,NaN),0);
  assert.equal(trendStops(newTrendSignal()),null);
});

test('a live desk stepped hour by hour ends where the research simulator ends',()=>{
  // Short trend cycles so the month buys, scales and sells more than once.
  const bars=walk(24*400,11,80,.004),start=bars[24*370].t,end=bars.at(-1).t+HOUR;
  const days=dailyCloses(bars),signal=strategySignal('ens9-h-L',bars,days);
  const sizing={...SIZING,volTarget:TREND.volTarget,maxLeverage:TREND.maxLeverage};
  const research=simulateDesk('BTC',{bars,funding:[],days,vol:dailyVol(days),dayAt:dayIndexAtBar(bars,days)},signal,{start,end,sizing});
  let desk=newTrendDesk();
  for(let t=start;t<end;t+=HOUR){
    const m=market(bars,t);
    if(desk.position)Object.assign(m,risk(desk,t,m.price));
    desk=advanceTrendDesk(desk,'BTC',m,t);
  }
  // Reconcile to the end, then value at the last close like the research ledger.
  const last=bars.at(-1).c;
  if(desk.position)desk=settleTrendRisk(desk,'BTC',risk(desk,end,last),end);
  const value=trendLiveValue(desk,{price:last,mark:last,at:end},end).balance;
  assert.ok(research.orders>=10&&research.roundTrips>=2,'the walk should trade');
  assert.equal(desk.trades.length,research.trades.filter(t=>!t.open).length);
  assert.ok(Math.abs(value-research.final)<1e-4*research.final,value+' vs '+research.final);
});

test('entries, scaling, exits and pause follow the ensemble count',()=>{
  // Flat for a year, then a steady climb: horizons join one by one.
  const bars=[];let c=100;
  for(let i=0;i<24*420;i++){const o=c;if(i>=24*400)c*=1.001;bars.push({t:T0+i*HOUR,o,h:Math.max(o,c),l:Math.min(o,c),c});}
  const noise=bars.map((b,i)=>i<24*400?{...b,c:b.c*(1+.01*Math.sin(i/7)),h:b.c*1.02,l:b.c*.98}:b);
  let desk=newTrendDesk(),t=noise[24*400].t;
  const actions=[];
  for(;t<=noise[24*419].t;t+=HOUR){
    const m=market(noise,t);if(desk.position)Object.assign(m,risk(desk,t,m.price));
    desk=advanceTrendDesk(desk,'SOL',m,t);actions.push(desk.decisions.at(-1).action);
  }
  assert.ok(actions.includes('köp'));assert.ok(actions.includes('öka'));
  assert.ok(desk.position&&desk.position.units>0);assert.ok(trendCount(desk.signal)>=5);
  assert.equal(desk.decisions.length,actions.length);
  // Same hour twice: no second decision.
  const again=advanceTrendDesk(desk,'SOL',{...market(noise,t-HOUR),...risk(desk,t-HOUR+1000,noise.at(-1).c)},t-HOUR+1000);
  assert.equal(again.decisions.length,desk.decisions.length);
  // A close below every stop but above liquidation sells everything with one round-trip record.
  const stops=trendStops(desk.signal),liq=trendLiquidation(desk);
  assert.ok(liq<stops.last*.97,'liquidation sits below the lowest trend stop');
  const price=stops.last*.98,top=noise.at(-1).c,crash=[...noise.filter(b=>b.t<t),{t,o:top,h:top,l:price,c:price}];
  const m=market(crash,t+HOUR,{price,mark:price});Object.assign(m,risk(desk,t+HOUR,price));
  const out=advanceTrendDesk(desk,'SOL',m,t+HOUR);
  assert.equal(out.position,null);assert.equal(out.trades.length,1);assert.equal(out.trades[0].reason,'trend');
  assert.ok(Math.abs(out.cash-(desk.position.equityAtOpen+out.trades[0].pnl))<1e-9,'round-trip P/L is the balance change');
  assert.equal(out.decisions.at(-1).action,'sälj');assert.equal(validateTrendDesk(out,'SOL'),out);
  // Paused: horizons may join but the size cannot grow.
  let paused={...structuredClone(desk),enabled:false};const before=paused.position.units;
  const m2=market(noise,t);Object.assign(m2,risk(paused,t,m2.price));
  paused=advanceTrendDesk(paused,'SOL',m2,t);
  assert.ok(paused.position.units<=before);
});

test('funding is charged on mark history and a crash below the liquidation price takes the desk',()=>{
  const bars=walk(24*400,3);let desk=newTrendDesk(),t=bars[24*399].t;
  // Force a leveraged long by hand to test settlement independently of the signal.
  desk={...desk,cash:-150,position:{symbol:'BTC',units:2.5,entry:100,openedAt:t-HOUR,equityAtOpen:100,fees:.1,funding:0,nextBar:t,fundingThrough:t-HOUR,peakExposure:2.5},
    signal:{...newTrendSignal(),through:t,sides:[1,1,0,0,0,0,0,0,0],stops:[90,80,null,null,null,null,null,null,null]},lastCount:2,
    decisions:[{hour:t,at:t+1,count:2,target:2.5,vol:.5,exposure:2.5,action:'köp',price:100}],startedAt:t};
  validateTrendDesk(desk,'BTC');assert.throws(()=>validateTrendDesk(desk,'ETH'),/fel coin/);
  const now=t+30*60000,m={price:100,mark:100,at:now,historyFrom:t-HOUR,fundingThrough:now,funding:[{t,rate:.001}],markBars:flatMarks(t-HOUR,Math.floor(now/STEP)*STEP)};
  const paid=settleTrendRisk(desk,'BTC',m,now);
  assert.ok(Math.abs(paid.cash-(-150-2.5*100*.001))<1e-9);assert.ok(Math.abs(paid.funding-.25)<1e-12);assert.equal(paid.position.fundingThrough,now);
  const liq=trendLiquidation(paid);assert.ok(liq>60&&liq<62);
  const bad=flatMarks(t-HOUR,Math.floor(now/STEP)*STEP).map(b=>b.t===t+10*60000?{...b,l:liq-1,c:liq+1}:b);
  const gone=settleTrendRisk(desk,'BTC',{...m,markBars:bad},now);
  assert.equal(gone.position,null);assert.equal(gone.cash,0);assert.equal(gone.trades[0].reason,'likvidation');assert.equal(gone.trades[0].pnl,-100);
  assert.throws(()=>settleTrendRisk(desk,'BTC',{...m,markBars:bad.filter(b=>b.t!==t+5*60000)},now),/Lucka/);
  assert.throws(()=>settleTrendRisk(desk,'BTC',{...m,fundingThrough:now-300000},now),/historik saknas/);
  // Live value nets closing costs and waits for fresh, reconciled data.
  const v=trendLiveValue(paid,{price:110,mark:110,at:now},now);
  assert.ok(Math.abs(v.balance-(paid.cash+2.5*110*(1-TREND.slip)*(1-TREND.fee)))<1e-9);assert.ok(Math.abs(v.openNet-(v.balance-100))<1e-12);
  assert.equal(trendLiveValue(paid,{price:110,mark:110,at:now-60000},now).balance,null);
  assert.equal(trendLiveValue(paid,{price:110,mark:110,at:now+200000},now+200000).reason,'Väntar på funding- och likvidationskontroll');
  assert.equal(trendLiveValue(newTrendDesk(),null,now).balance,100);
});

function bybitKlines(bars,{skip=new Set(),calls=[]}={}){
  return async url=>{
    const u=new URL(url),q=Object.fromEntries(u.searchParams);calls.push(q);
    if(u.pathname.endsWith('/kline')){
      const list=bars.filter(b=>b.t>=+q.start&&b.t<=+q.end&&!skip.has(b.t)).slice(-(+q.limit)).reverse().map(b=>[String(b.t),String(b.o),String(b.h),String(b.l),String(b.c),'1','1']);
      return {retCode:0,result:{category:'linear',symbol:q.symbol,list},time:NOW};
    }
    if(u.pathname.endsWith('/tickers'))return {retCode:0,result:{category:'linear',list:[{symbol:q.symbol,lastPrice:'100',markPrice:'100',nextFundingTime:String(NOW+HOUR)}]},time:NOW};
    throw Error('unexpected '+url);
  };
}
const NOW=T0+24*800*HOUR+90000;

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
  const desk=newTrendDesk();assert.equal(historyStart(desk,hour),hour-TREND.initHours*HOUR);
});

test('the market fetch gives each desk candles and a quote for the current hour',async()=>{
  clearTrendCache();
  const bars=walk(24*800+30,4),hour=Math.floor(NOW/HOUR)*HOUR,grab=bybitKlines(bars.filter(b=>b.t<hour));
  const desks={BTC:newTrendDesk(),SHIB:newTrendDesk()},m=await fetchTrendMarket(grab,()=>NOW,desks);
  assert.equal(m.hour,hour);assert.deepEqual(Object.keys(m.market),['BTC','SHIB']);
  assert.equal(m.market.BTC.bars.length,TREND.initHours);assert.equal(m.market.BTC.price,100);
  assert.ok(Math.abs(m.market.SHIB.bars.at(-1).c-bars.find(b=>b.t===hour-HOUR).c/1000)<1e-12);
  const next=advanceTrendDesk(desks.BTC,'BTC',{hour,...m.market.BTC},NOW);
  assert.equal(next.signal.through,hour);assert.equal(next.decisions.length,1);
});
