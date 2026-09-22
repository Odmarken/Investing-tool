import test from 'node:test';
import assert from 'node:assert/strict';
import {hourOf,needsDecision,activeAccounts,mergedPositions,fetchPlan,applyPlan,sampleFirmEquity} from '../cloud-runner.js';
import {ACTIVE,newActiveAccount,advanceActiveAccount} from '../crypto-momentum-active.js';
import {FLOOR,newFirm,advanceFirm,heldSymbols,setFirmPaused} from '../trading-floor.js';
import {LEVERAGE} from '../crypto-leverage.js';
import {CONTRACTS} from '../bybit-contracts.js';

const TIME=Date.parse('2026-09-22T12:00:00Z'),HOUR=3600000,STEP=LEVERAGE.step;
const contract=(symbol,at)=>({symbol,contract:CONTRACTS[symbol],at,min:1,max:150,step:.01,tiers:[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}]});
function snapshot(time=TIME,scores={}){
  const hour=Math.floor(time/HOUR)*HOUR;
  return {hour,market:Object.fromEntries(ACTIVE.symbols.map(symbol=>[symbol,{at:time,price:100,mark:100,contract:contract(symbol,time),
    signal:{symbol,at:hour,score:scores[symbol]??.1,reference:100,slDistance:2,rewardMultiple:2,maxHoldMs:12*HOUR},
    historyFrom:TIME-STEP,fundingThrough:time,funding:[],
    markBars:Array.from({length:Math.floor((time-TIME)/STEP)+2},(_,i)=>({t:TIME-STEP+i*STEP,o:100,h:100,l:100,c:100}))}]))};
}
const enabled=()=>({...newActiveAccount(),enabled:true});
const dailyBars=(time,step)=>Array.from({length:100},(_,i)=>{const t=Math.floor(time/step)*step-(99-i)*step,c=100+i;return {t,o:c,h:c+1,l:c-1,c,v:1};});
const fakeGrab=runtime=>async url=>{
  const u=new URL(url),symbol=u.searchParams.get('symbol'),time=runtime.at;runtime.urls.push(u);
  if(u.pathname.endsWith('/tickers'))return {retCode:0,time,result:{category:'linear',list:[{symbol,lastPrice:'199',markPrice:'199',nextFundingTime:String((Math.floor(time/28800000)+1)*28800000)}]}};
  if(u.pathname.endsWith('/instruments-info'))return {retCode:0,time,result:{category:'linear',list:[{symbol,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'150',leverageStep:'.01'}}]}};
  if(u.pathname.endsWith('/risk-limit'))return {retCode:0,time,result:{category:'linear',list:[{id:1,symbol,riskLimitValue:'10000000',maxLeverage:'150',maintenanceMargin:'.005',mmDeduction:''}]}};
  if(u.pathname.endsWith('/funding/history'))return {retCode:0,time,result:{category:'linear',list:Array.from({length:10},(_,i)=>({symbol,fundingRate:'0',fundingRateTimestamp:String(Math.floor(time/28800000)*28800000-i*28800000)}))}};
  if(u.pathname.endsWith('/mark-price-kline'))return {retCode:0,time,result:{category:'linear',symbol,list:Array.from({length:1000},(_,i)=>[Math.floor(time/300000)*300000-i*300000,199,199,199,199].map(String))}};
  if(u.searchParams.get('interval')==='60')return {retCode:0,time,result:{category:'linear',symbol,list:dailyBars(time,3600000).reverse().map(b=>[b.t,b.o,b.h,b.l,b.c,b.v].map(String))}};
  throw Error('Unexpected request '+url);
};
const path=u=>u.pathname.replace('/v5/market/','')+(u.searchParams.get('interval')==='60'?':hourly':'');

test('an account needs the hourly candles only when it is free, enabled, undecided this hour and past its cooldown',()=>{
  const a=enabled();
  assert.equal(needsDecision(a,TIME),true);
  assert.equal(needsDecision({...a,enabled:false},TIME),false);
  assert.equal(needsDecision({...a,lastSignalAt:hourOf(TIME)},TIME),false);
  assert.equal(needsDecision({...a,lastSignalAt:hourOf(TIME)-HOUR},TIME),true);
  assert.equal(needsDecision({...a,cooldownUntil:TIME+1},TIME),false);
  assert.equal(needsDecision(advanceActiveAccount(a,snapshot(),TIME),TIME+1000),false);
  assert.equal(needsDecision(null,TIME),false);
});

test('the shared fetch covers every account and starts each contract history at the earliest open position',()=>{
  const momentum=advanceActiveAccount(enabled(),snapshot(TIME-HOUR),TIME-HOUR),firm=advanceFirm(newFirm(TIME),snapshot(),TIME);
  const accounts=activeAccounts(momentum,firm);
  assert.equal(accounts.length,7);assert.equal(accounts[0].kind,'momentum');
  const merged=mergedPositions(accounts),btc=merged.sleeves.find(s=>s.symbol==='BTC').position;
  assert.equal(merged.profile,'pulse12');assert.equal(merged.sleeves.length,ACTIVE.symbols.length);
  const older=momentum.sleeves.find(s=>s.position).position;
  assert.equal(older.symbol??'BTC','BTC');assert.equal(btc.nextBar,Math.min(older.nextBar,firm.desks.BTC.sleeves.find(s=>s.position).position.nextBar));
  assert.equal(btc.fundingThrough,TIME-HOUR);
  assert.equal(merged.sleeves.find(s=>s.symbol==='PEPE').position,null);
  assert.deepEqual(activeAccounts(null,null),[]);assert.deepEqual(activeAccounts({...newActiveAccount(),enabled:false},setFirmPaused(newFirm(TIME),true)),[]);
});

test('planning fetches candles only when a decision is due, mark history only for held contracts, and nothing when idle',async()=>{
  const runtime={at:TIME,urls:[]};
  assert.deepEqual(await fetchPlan(fakeGrab(runtime),()=>runtime.at,null,null),{mode:'idle'});
  assert.deepEqual(await fetchPlan(fakeGrab(runtime),()=>runtime.at,{...newActiveAccount(),enabled:false},setFirmPaused(newFirm(TIME),true)),{mode:'idle'});
  assert.equal(runtime.urls.length,0);
  const decide=await fetchPlan(fakeGrab(runtime),()=>runtime.at,enabled(),newFirm(TIME));
  assert.equal(decide.mode,'decide');assert.equal(decide.snapshot.hour,hourOf(TIME));
  assert.equal(runtime.urls.filter(u=>path(u)==='kline:hourly').length,ACTIVE.symbols.length);
  const applied=applyPlan(decide,enabled(),newFirm(TIME),TIME);
  assert.equal(applied.momentum.error,null);assert.equal(applied.firm.error,null);
  assert.equal(applied.momentum.account.sleeves.filter(s=>s.position).length,1);
  assert.deepEqual(heldSymbols(applied.firm.firm),[...FLOOR.desks]);
  for(const s of FLOOR.desks)assert.equal(applied.firm.firm.desks[s].sleeves.find(x=>x.position).symbol,s);
  runtime.urls.length=0;runtime.at=TIME+60000;
  const risk=await fetchPlan(fakeGrab(runtime),()=>runtime.at,applied.momentum.account,applied.firm.firm);
  assert.equal(risk.mode,'risk');
  assert.equal(runtime.urls.filter(u=>path(u)==='kline:hourly').length,0,'no hourly candles while every account is held');
  const marked=runtime.urls.filter(u=>path(u)==='mark-price-kline').map(u=>u.searchParams.get('symbol'));
  assert.deepEqual([...new Set(marked)].sort(),FLOOR.desks.map(s=>CONTRACTS[s]).sort());
  const settled=applyPlan(risk,applied.momentum.account,applied.firm.firm,runtime.at);
  assert.equal(settled.momentum.error,null);assert.equal(settled.firm.error,null);
  assert.equal(settled.momentum.account.sleeves.find(s=>s.position).position.fundingThrough,runtime.at);
  assert.ok(FLOOR.desks.every(s=>settled.firm.firm.desks[s].sleeves.find(x=>x.position).position.fundingThrough===runtime.at));
});

test('a failing plan or a broken account is reported per account without touching the other',()=>{
  const momentum=enabled(),firm=newFirm(TIME);
  const failed=applyPlan({mode:'error',error:'offline'},momentum,firm,TIME);
  assert.equal(failed.momentum.account,momentum);assert.equal(failed.firm.firm,firm);assert.equal(failed.momentum.error,'offline');assert.equal(failed.firm.error,'offline');
  assert.equal(applyPlan({mode:'error',error:'offline'},null,firm,TIME).momentum.error,null);
  const idle=applyPlan({mode:'idle'},momentum,firm,TIME);assert.equal(idle.momentum.account,momentum);assert.equal(idle.firm.firm,firm);
  const wrongHour=applyPlan({mode:'decide',snapshot:snapshot(TIME-HOUR)},momentum,firm,TIME);
  assert.match(wrongHour.momentum.error,/fel timme/);assert.match(wrongHour.firm.error,/fel timme/);assert.equal(wrongHour.firm.firm,firm);
  const half=applyPlan({mode:'decide',snapshot:snapshot()},momentum,null,TIME);
  assert.equal(half.firm.firm,null);assert.equal(half.firm.error,null);assert.equal(half.momentum.account.sleeves.filter(s=>s.position).length,1);
});

test('stops settle in risk mode and the equity curve samples the firm from fresh tickers',async()=>{
  const firm=advanceFirm(newFirm(TIME),snapshot(),TIME),time=TIME+2*STEP,p=firm.desks.SOL.sleeves.find(s=>s.position).position,q=snapshot(time);
  q.market.SOL.markBars=q.market.SOL.markBars.map(b=>b.t===TIME+STEP?{...b,l:p.sl-.01,c:p.sl}:b);
  const out=applyPlan({mode:'risk',risk:{market:q.market}},null,firm,time);
  assert.equal(out.firm.error,null);assert.equal(out.firm.firm.desks.SOL.trades.length,1);assert.equal(out.firm.firm.desks.SOL.trades[0].reason,'SL');assert.equal(heldSymbols(out.firm.firm).length,5);
  const runtime={at:time,urls:[]};
  const points=await sampleFirmEquity(fakeGrab(runtime),()=>runtime.at,out.firm.firm,[]);
  assert.equal(points.length,1);assert.equal(points[0].t,time);assert.ok(points[0].v>0);
  assert.equal(runtime.urls.filter(u=>path(u)==='tickers').length,5);
  assert.equal(await sampleFirmEquity(fakeGrab(runtime),()=>runtime.at,out.firm.firm,points),points,'at most one sample per minute');
  const idle=await sampleFirmEquity(async()=>{throw Error('no quotes needed');},()=>time,newFirm(TIME),[]);
  assert.equal(idle.length,1);assert.equal(idle[0].v,600);
});
