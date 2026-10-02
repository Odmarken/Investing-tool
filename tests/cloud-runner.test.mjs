import test from 'node:test';
import assert from 'node:assert/strict';
import {hourOf,needsDecision,momentumActive,fetchPlan,applyPlan,sampleFirmEquity} from '../cloud-runner.js';
import {ACTIVE,newActiveAccount,advanceActiveAccount} from '../crypto-momentum-active.js';
import {FLOOR,newFirm,advanceFirm,heldSymbols,setFirmPaused,needsHourly} from '../trading-floor.js';
import {trendLiquidation} from '../floor-trend.js';
import {clearTrendCache} from '../floor-trend-market.js';
import {LEVERAGE} from '../crypto-leverage.js';
import {CONTRACTS} from '../bybit-contracts.js';
import {TIME,HOUR,trendSnapshot,withRisk,riskSnapshot,fakeBybit,unitBars,extendUnit} from './floor-fixtures.mjs';

const STEP=LEVERAGE.step;
const contract=(symbol,at)=>({symbol,contract:CONTRACTS[symbol],at,min:1,max:150,step:.01,tiers:[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}]});
// The momentum account's own snapshot: every coin with a positive hourly signal.
function snapshot(time=TIME,scores={}){
  const hour=Math.floor(time/HOUR)*HOUR;
  return {hour,market:Object.fromEntries(ACTIVE.symbols.map(symbol=>[symbol,{at:time,price:100,mark:100,contract:contract(symbol,time),
    signal:{symbol,at:hour,score:scores[symbol]??.1,reference:100,slDistance:2,rewardMultiple:2,maxHoldMs:12*HOUR},
    historyFrom:TIME-STEP,fundingThrough:time,funding:[],
    markBars:Array.from({length:Math.floor((time-TIME)/STEP)+2},(_,i)=>({t:TIME-STEP+i*STEP,o:100,h:100,l:100,c:100}))}]))};
}
const enabled=()=>({...newActiveAccount(),enabled:true});
const path=u=>u.pathname.replace('/v5/market/','')+(u.searchParams.get('interval')==='60'?':hourly':'');
// A reset firm switches every trend off at TIME; the rally's next new high buys all six desks.
const UNIT=unitBars(TIME),UP=extendUnit(UNIT,1.001),BUY=TIME+HOUR;
const holding=()=>advanceFirm(advanceFirm(newFirm(TIME),trendSnapshot(TIME,UNIT),TIME),trendSnapshot(BUY,UP),BUY);

test('the momentum account needs hourly candles only when it is free, enabled, undecided this hour and past its cooldown',()=>{
  const a=enabled();
  assert.equal(needsDecision(a,TIME),true);
  assert.equal(needsDecision({...a,enabled:false},TIME),false);
  assert.equal(needsDecision({...a,lastSignalAt:hourOf(TIME)},TIME),false);
  assert.equal(needsDecision({...a,lastSignalAt:hourOf(TIME)-HOUR},TIME),true);
  assert.equal(needsDecision({...a,cooldownUntil:TIME+1},TIME),false);
  assert.equal(needsDecision(advanceActiveAccount(a,snapshot(),TIME),TIME+1000),false);
  assert.equal(needsDecision(null,TIME),false);
  assert.equal(momentumActive(null),false);assert.equal(momentumActive({...newActiveAccount(),enabled:false}),false);assert.equal(momentumActive(a),true);
});

test('the floor decides every hour for all six desks, paused or not, and only then fetches candles',()=>{
  const firm=newFirm(TIME);
  assert.equal(needsHourly(firm,TIME),true);assert.equal(needsHourly(setFirmPaused(firm,true),TIME),true);
  const decided=holding();
  assert.equal(needsHourly(decided,BUY+1000),false);assert.equal(needsHourly(decided,BUY+HOUR),true);
});

test('planning pages hourly candles for a decision, mark history only for held desks, and runs idle accounts every minute',async()=>{
  clearTrendCache();
  const runtime={at:TIME,urls:[]},unit=unitBars(TIME);runtime.unit=unit;
  assert.deepEqual(await fetchPlan(fakeBybit(runtime),()=>runtime.at,null,null),{momentum:{mode:'idle'},floor:{mode:'idle'}});
  assert.equal(runtime.urls.length,0);
  const decide=await fetchPlan(fakeBybit(runtime),()=>runtime.at,enabled(),newFirm(TIME));
  assert.equal(decide.momentum.mode,'decide');assert.equal(decide.floor.mode,'decide');assert.equal(decide.floor.snapshot.hour,hourOf(TIME));
  // The momentum account asks for the latest 100 candles; the desks page theirs by start and end.
  const hourly=runtime.urls.filter(u=>path(u)==='kline:hourly');
  assert.equal(hourly.filter(u=>!u.searchParams.has('start')).length,ACTIVE.symbols.length);
  const paged=hourly.filter(u=>u.searchParams.has('start')).map(u=>u.searchParams.get('symbol'));
  assert.deepEqual([...new Set(paged)].sort(),FLOOR.desks.map(s=>CONTRACTS[s]).sort());
  for(const s of FLOOR.desks)assert.equal(decide.floor.snapshot.market[s].bars.at(-1).t,hourOf(TIME)-HOUR);
  // Flat desks get Bybit's limits so a breakout can buy at the maximum.
  assert.ok(FLOOR.desks.every(s=>decide.floor.snapshot.market[s].contract?.max===150));
  const applied=applyPlan(decide,enabled(),newFirm(TIME),TIME);
  assert.equal(applied.momentum.error,null);assert.equal(applied.firm.error,null);
  assert.equal(applied.momentum.account.sleeves.filter(s=>s.position).length,1);
  assert.equal(heldSymbols(applied.firm.firm).length,0,'a reset firm starts with every trend off');
  // Next hour the rally makes a new high and every desk buys.
  runtime.urls.length=0;runtime.at=BUY;runtime.unit=UP;
  const buy=await fetchPlan(fakeBybit(runtime),()=>runtime.at,null,applied.firm.firm);
  assert.equal(buy.floor.mode,'decide');
  const bought=applyPlan(buy,null,applied.firm.firm,runtime.at);
  assert.equal(bought.firm.error,null);assert.deepEqual(heldSymbols(bought.firm.firm),[...FLOOR.desks]);
  assert.ok(FLOOR.desks.every(s=>bought.firm.firm.desks[s].position.leverage===150));
  // Within the hour: no candles, mark history for each held desk.
  runtime.urls.length=0;runtime.at=BUY+60000;
  const risk=await fetchPlan(fakeBybit(runtime),()=>runtime.at,applied.momentum.account,bought.firm.firm);
  assert.equal(risk.floor.mode,'risk');assert.equal(risk.momentum.mode,'risk');
  assert.equal(runtime.urls.filter(u=>path(u)==='kline:hourly').length,0,'no hourly candles within the hour');
  const marked=runtime.urls.filter(u=>path(u)==='mark-price-kline').map(u=>u.searchParams.get('symbol'));
  assert.ok(FLOOR.desks.every(s=>marked.includes(CONTRACTS[s])));
  const settled=applyPlan(risk,applied.momentum.account,bought.firm.firm,runtime.at);
  assert.equal(settled.momentum.error,null);assert.equal(settled.firm.error,null);
  assert.ok(FLOOR.desks.every(s=>settled.firm.firm.desks[s].position.fundingThrough===runtime.at));
  // A flat, decided firm still gets a (no-op) run each minute so the page sees the cloud alive.
  const flat=advanceFirm(newFirm(BUY),trendSnapshot(BUY,extendUnit(unitBars(TIME,{rally:false}),.999)),BUY);
  assert.equal(heldSymbols(flat).length,0);assert.equal(needsHourly(flat,runtime.at),false);runtime.urls.length=0;
  const quiet=await fetchPlan(fakeBybit(runtime),()=>runtime.at,null,flat);
  assert.equal(quiet.floor.mode,'risk');assert.deepEqual(quiet.floor.risk,{market:{}});assert.equal(runtime.urls.length,0);
  assert.equal(applyPlan(quiet,null,flat,runtime.at).firm.firm,flat);
});

test('a failing plan or a broken account is reported per account without touching the other',()=>{
  const momentum=enabled(),firm=newFirm(TIME);
  const failed=applyPlan({momentum:{mode:'error',error:'offline'},floor:{mode:'error',error:'down'}},momentum,firm,TIME);
  assert.equal(failed.momentum.account,momentum);assert.equal(failed.firm.firm,firm);assert.equal(failed.momentum.error,'offline');assert.equal(failed.firm.error,'down');
  assert.equal(applyPlan({momentum:{mode:'error',error:'offline'},floor:{mode:'idle'}},null,firm,TIME).momentum.error,null);
  const idle=applyPlan({momentum:{mode:'idle'},floor:{mode:'idle'}},momentum,firm,TIME);assert.equal(idle.momentum.account,momentum);assert.equal(idle.firm.firm,firm);
  const wrongHour=applyPlan({momentum:{mode:'decide',snapshot:snapshot(TIME-HOUR)},floor:{mode:'decide',snapshot:trendSnapshot(TIME-HOUR)}},momentum,firm,TIME);
  assert.match(wrongHour.momentum.error,/fel timme/);assert.match(wrongHour.firm.error,/fel timme/);assert.equal(wrongHour.firm.firm,firm);
  const half=applyPlan({momentum:{mode:'decide',snapshot:snapshot()},floor:{mode:'error',error:'Timpriser saknas'}},momentum,firm,TIME);
  assert.equal(half.firm.firm,firm);assert.equal(half.firm.error,'Timpriser saknas');assert.equal(half.momentum.account.sleeves.filter(s=>s.position).length,1);
});

test('risk mode settles funding and liquidation, and the equity curve samples the firm from fresh tickers',async()=>{
  const firm=holding(),time=BUY+10*60000;
  const out=applyPlan({floor:{mode:'risk',risk:riskSnapshot(firm,time)}},null,firm,time);
  assert.equal(out.firm.error,null);assert.equal(heldSymbols(out.firm.firm).length,6);
  // A mark crash through SOL's liquidation price closes only that desk.
  const risk=riskSnapshot(firm,time),liq=trendLiquidation(firm.desks.SOL);
  risk.market.SOL.markBars=risk.market.SOL.markBars.map((b,i)=>i===1?{...b,l:liq*.9}:b);
  const crash=applyPlan({floor:{mode:'risk',risk}},null,firm,time);
  assert.equal(crash.firm.error,null);assert.equal(crash.firm.firm.desks.SOL.trades.at(-1).reason,'likvidation');assert.equal(heldSymbols(crash.firm.firm).length,5);
  const runtime={at:time,urls:[]};
  const points=await sampleFirmEquity(fakeBybit(runtime),()=>runtime.at,out.firm.firm,[]);
  assert.equal(points.length,1);assert.equal(points[0].t,time);assert.ok(points[0].v>0);
  assert.equal(runtime.urls.filter(u=>path(u)==='tickers').length,6);
  assert.equal(await sampleFirmEquity(fakeBybit(runtime),()=>runtime.at,out.firm.firm,points),points,'at most one sample per minute');
  const idle=await sampleFirmEquity(async()=>{throw Error('no quotes needed');},()=>time,newFirm(TIME),[]);
  assert.equal(idle.length,1);assert.equal(idle[0].v,600);
  // The next hour's decision reuses the snapshot shape with risk history for held desks.
  const next=advanceFirm(out.firm.firm,withRisk(out.firm.firm,trendSnapshot(BUY+HOUR,extendUnit(UP,1.001)),BUY+HOUR),BUY+HOUR);
  assert.ok(FLOOR.desks.every(s=>next.desks[s].decisions.length===3&&next.desks[s].decisions[2].action==='behåll'));
});
