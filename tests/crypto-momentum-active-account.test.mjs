import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVE,newActiveAccount,validateActiveAccount,readActiveAccount,advanceActiveRisk,advanceActiveAccount,fetchActiveSnapshot,fetchActiveRisk} from '../crypto-momentum-active.js';
import {MOMENTUM,newMomentumAccount,validateMomentumAccount,weekStart} from '../crypto-momentum.js';
import {LEVERAGE,openLeveraged,closeLeveraged,liquidationPrice} from '../crypto-leverage.js';
import {CONTRACTS,CONTRACT_UNITS} from '../bybit-contracts.js';

const TIME=Date.parse('2026-09-11T12:00:00Z'),HOUR=3600000,STEP=LEVERAGE.step;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const held=a=>a.sleeves.filter(s=>s.position);
const cash=a=>a.sleeves.reduce((sum,s)=>sum+s.cash,0);
const contract=(symbol,at)=>({symbol,contract:CONTRACTS[symbol],at,min:1,max:150,step:.01,
  tiers:[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}]});
function snapshot(time=TIME,winner='BTC'){
  const hour=Math.floor(time/HOUR)*HOUR;
  return {hour,market:Object.fromEntries(ACTIVE.symbols.map(symbol=>[symbol,{at:time,price:100,mark:100,contract:contract(symbol,time),
    signal:{symbol,at:hour,score:symbol===winner?.3:.1,reference:100,slDistance:2,rewardMultiple:2,maxHoldMs:12*HOUR},
    historyFrom:TIME-STEP,fundingThrough:time,funding:[],
    markBars:Array.from({length:Math.floor((time-TIME)/STEP)+2},(_,i)=>({t:TIME-STEP+i*STEP,o:100,h:100,l:100,c:100}))}]))};
}
const enabled=()=>({...newActiveAccount(),enabled:true});
const entered=(symbol='BTC',time=TIME)=>advanceActiveAccount(enabled(),snapshot(time,symbol),time);
function hit(account,reason,time=TIME+2*STEP){
  const s=held(account)[0],p=s.position,q=snapshot(time),row=q.market[s.symbol];
  row.markBars=row.markBars.map(b=>b.t===TIME+STEP?{...b,
    ...(reason==='SL'?{l:p.sl-.01,c:p.sl}:{h:p.tp+.01,c:p.tp})}:b);
  return q;
}

test('each of seven coins can be selected alone with at least half of account cash outside the position',()=>{
  for(const symbol of ACTIVE.symbols){
    const input=enabled(),copy=structuredClone(input),a=advanceActiveAccount(input,snapshot(TIME,symbol),TIME),positions=held(a);
    assert.deepEqual(input,copy);assert.equal(positions.length,1);assert.equal(positions[0].symbol,symbol);
    const p=positions[0].position;
    assert.ok(p.budget<=50+1e-7);assert.ok(p.initialRisk<=50+1e-7);assert.ok(cash(a)>=50-1e-7);
    near(cash(a)+p.budget,100);near(a.fees,p.fee);near(a.funding,0);
    assert.ok(p.rules.leverage<=p.rules.apiMax);assert.ok(liquidationPrice(p)<p.sl);
    near(-closeLeveraged(p,p.sl,TIME+STEP,'SL').trade.pnl,p.initialRisk);
    assert.equal(a.activeDecisions.length,1);assert.equal(a.activeDecisions[0].symbol,symbol);
    assert.equal(validateActiveAccount(a),a);
  }
});

test('repeated polling cannot duplicate an hourly entry or replace a held position with a stronger coin',()=>{
  const a=entered('SOL'),same=advanceActiveAccount(a,snapshot(TIME+1000,'ETH'),TIME+1000);
  assert.equal(held(same).length,1);assert.equal(held(same)[0].symbol,'SOL');assert.equal(same.activeDecisions.length,1);
  const next=advanceActiveAccount(same,snapshot(TIME+HOUR,'PEPE'),TIME+HOUR);
  assert.equal(next.activeDecisions.length,2);assert.equal(next.activeDecisions[1].action,'behåll');
  assert.equal(held(next)[0].symbol,'SOL');assert.equal(held(next)[0].position.at,TIME);
  near(next.fees,a.fees);assert.equal(next.trades.length,0);
});

test('a stop settles once, waits a full hour, then a fresh hourly signal may open the next trade',()=>{
  const a=entered(),stopTime=TIME+2*STEP,stopped=advanceActiveAccount(a,hit(a,'SL',stopTime),stopTime);
  assert.equal(held(stopped).length,0);assert.equal(stopped.trades.length,1);assert.equal(stopped.trades[0].reason,'SL');
  assert.equal(stopped.cooldownUntil,stopTime+HOUR);
  const replay=advanceActiveAccount(stopped,snapshot(stopTime+1000),stopTime+1000);
  assert.deepEqual(replay,stopped);
  const early=advanceActiveAccount(stopped,snapshot(TIME+HOUR,'ETH'),TIME+HOUR);
  assert.equal(held(early).length,0);assert.equal(early.lastSignalAt,TIME);
  const nextTime=stopTime+HOUR,next=advanceActiveAccount(early,snapshot(nextTime,'ETH'),nextTime);
  assert.equal(held(next).length,1);assert.equal(held(next)[0].symbol,'ETH');assert.equal(next.trades.length,1);
  assert.equal(next.activeDecisions.length,2);assert.equal(next.lastSignalAt,TIME+HOUR);
  near(held(next)[0].position.accountAtEntry,cash(stopped));assert.ok(held(next)[0].position.budget<=cash(stopped)*.5+1e-7);
});

test('cash-only decisions do not invent entries and can enter at the next eligible hour',()=>{
  const q=snapshot();for(const row of Object.values(q.market))row.signal=null;
  const a=advanceActiveAccount(enabled(),q,TIME);
  assert.equal(held(a).length,0);assert.equal(cash(a),100);assert.equal(a.activeDecisions[0].action,'kontanter');
  assert.equal(held(advanceActiveAccount(a,snapshot(TIME+1000),TIME+1000)).length,0);
  const next=advanceActiveAccount(a,snapshot(TIME+HOUR,'DOGE'),TIME+HOUR);
  assert.equal(held(next)[0].symbol,'DOGE');
  const stale=snapshot();for(const row of Object.values(stale.market))row.signal.at-=HOUR;
  assert.equal(held(advanceActiveAccount(enabled(),stale,TIME)).length,0);
});

test('SL and TP remain active when paused and reconcile cash, slippage, fees and funding exactly once',()=>{
  for(const reason of ['SL','TP']){
    const a={...entered(),enabled:false},p=held(a)[0].position,time=TIME+2*STEP,q=hit(a,reason,time);
    q.market.BTC.funding=[{t:TIME+STEP,rate:.0001}];
    const funding=p.units*100*.0001,price=reason==='SL'?p.sl:p.tp;
    const expected=closeLeveraged({...p,funding},price,time,reason);
    const done=advanceActiveAccount(a,{market:{BTC:q.market.BTC}},time);
    assert.equal(held(done).length,0);assert.equal(done.trades.length,1);assert.equal(done.trades[0].reason,reason);
    near(cash(done),cash(a)+expected.cash);near(cash(done),100+expected.trade.pnl);
    near(done.fees,expected.trade.fees);near(done.funding,funding);near(done.trades[0].funding,funding);
    assert.equal(done.activeDecisions.length,1);assert.equal(done.enabled,false);
    const again=advanceActiveRisk(done,{market:{}},time+1000);assert.deepEqual(again,done);
    assert.equal(validateActiveAccount(done),done);
  }
});

test('a liquidation gap consumes only isolated margin and preserves the cash reserve',()=>{
  const a={...entered(),enabled:false},p=held(a)[0].position,time=TIME+STEP+1000,q=snapshot(time);
  const gap=liquidationPrice(p)-.1;
  q.market.BTC.markBars=q.market.BTC.markBars.map(b=>b.t===TIME+STEP?{t:b.t,o:gap,h:gap,l:gap,c:gap}:b);
  const done=advanceActiveRisk(a,{market:{BTC:q.market.BTC}},time);
  assert.equal(held(done).length,0);assert.equal(done.trades[0].reason,'likvidation');
  near(cash(done),cash(a));near(done.trades[0].pnl,-p.budget);assert.ok(cash(done)>=50-1e-7);
});

test('missing entry limits can retry within the same hour without losing or duplicating a committed risk exit',()=>{
  const a=entered(),time=TIME+2*STEP,stopped=advanceActiveRisk(a,hit(a,'SL',time),time),nextTime=time+HOUR;
  const bad=snapshot(nextTime,'ETH');bad.market.ETH.contract=null;
  const waiting=advanceActiveAccount(stopped,bad,nextTime);
  assert.match(waiting.waitReason,/Bybit/);assert.equal(waiting.lastSignalAt,TIME);assert.equal(waiting.trades.length,1);
  const done=advanceActiveAccount(waiting,snapshot(nextTime,'ETH'),nextTime);
  assert.equal(done.waitReason,undefined);assert.equal(done.trades.length,1);assert.equal(held(done)[0].symbol,'ETH');
});

function legacyWithHistory(){
  const a=newMomentumAccount(),opened=TIME-2*HOUR,previous=openLeveraged(50,100,opened);
  const oldTrade=closeLeveraged(previous,101,TIME-HOUR,'signal');
  const capital=100+oldTrade.trade.pnl,p=openLeveraged(capital,100,TIME);
  a.enabled=false;a.startedAt=opened;a.lastWeek=weekStart(TIME);
  a.sleeves[0]={symbol:'BTC',cash:0,position:p};a.fees=oldTrade.trade.fees+p.fee;
  a.trades=[{symbol:'ETH',...oldTrade.trade}];
  a.decisions=[{week:a.lastWeek,at:TIME,signals:MOMENTUM.symbols.map(symbol=>({symbol,score:.1,price:100,action:symbol==='BTC'?'köp':'kontanter'}))}];
  return validateMomentumAccount(a);
}

test('v3 migration preserves cash and history on read, then closes the old holding once at a costed observed exit',()=>{
  const old=legacyWithHistory(),raw=JSON.stringify(old),loaded=readActiveAccount({getItem:()=>raw},'account');
  assert.equal(loaded.version,ACTIVE.version);assert.equal(loaded.migrationPending,true);assert.equal(loaded.enabled,false);
  assert.deepEqual(loaded.sleeves,old.sleeves);assert.deepEqual(loaded.trades,old.trades);assert.deepEqual(loaded.decisions,old.decisions);
  const time=TIME+1000,q=snapshot(time);q.market.BTC.price=100.2;q.market.BTC.mark=100.2;
  const expected=closeLeveraged(old.sleeves[0].position,100.2,time,'strategy-change');
  const done=advanceActiveRisk(loaded,{market:{BTC:q.market.BTC}},time);
  assert.equal(held(done).length,0);assert.equal(done.migrationPending,false);assert.equal(done.trades.length,2);
  assert.deepEqual(done.trades[0],old.trades[0]);assert.deepEqual(done.decisions,old.decisions);
  assert.equal(done.trades[1].reason,'strategy-change');near(done.trades[1].pnl,expected.trade.pnl);
  near(cash(done),expected.cash);near(done.fees,old.fees+expected.exitFee);
  assert.equal(done.activeDecisions.length,0);assert.equal(done.cooldownUntil,time+HOUR);
  assert.deepEqual(advanceActiveRisk(done,{market:{}},time+1000),done);
  assert.equal(readActiveAccount({getItem:()=>JSON.stringify(done)},'account').version,ACTIVE.version);
  assert.deepEqual(readActiveAccount({getItem:()=>null},'absent'),newActiveAccount());
});

test('migration pauses previously enabled legacy accounts until the new experiment is explicitly activated',()=>{
  for(const legacy of [legacyWithHistory(),newMomentumAccount()]){
    legacy.enabled=true;
    const loaded=readActiveAccount({getItem:()=>JSON.stringify(legacy)},'account');
    assert.equal(loaded.enabled,false);assert.equal(loaded.migrationPending,held(legacy).length>0);
    assert.deepEqual(loaded.sleeves,legacy.sleeves);assert.deepEqual(loaded.trades,legacy.trades);
  }
  const current=entered(),restored=readActiveAccount({getItem:()=>JSON.stringify(current)},'account');
  assert.equal(restored.enabled,true);assert.deepEqual(restored,current);
});

const BASE={BTC:100,ETH:50,SOL:10,XRP:1,DOGE:.1,SHIB:.00001,PEPE:.000001};
function api(time,{failedHourly=null,mark=null,calls=[]}={}){
  return async url=>{
    const u=new URL(url),contractId=u.searchParams.get('symbol'),symbol=ACTIVE.symbols.find(s=>CONTRACTS[s]===contractId);
    calls.push({path:u.pathname,symbol,interval:u.searchParams.get('interval'),category:u.searchParams.get('category')});
    assert.ok(symbol);const scale=CONTRACT_UNITS[symbol],price=BASE[symbol],raw=price*scale;
    const response=list=>({retCode:0,time,result:{category:'linear',symbol:contractId,list}});
    if(u.pathname.endsWith('/kline')){
      if(symbol===failedHourly)throw Error('Hourly candles unavailable');
      const hour=Math.floor(time/HOUR)*HOUR;
      return response(Array.from({length:81},(_,i)=>{
        const t=hour-i*HOUR,c=raw*(1-.001*i);return [t,c,c+raw*.01,c-raw*.01,c,1].map(String);
      }));
    }
    if(u.pathname.endsWith('/tickers'))return response([{symbol:contractId,lastPrice:String(mark??raw),markPrice:String(mark??raw),nextFundingTime:String((Math.floor(time/(8*HOUR))+1)*8*HOUR)}]);
    if(u.pathname.endsWith('/instruments-info'))return response([{symbol:contractId,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'150',leverageStep:'.01'}}]);
    if(u.pathname.endsWith('/risk-limit'))return response([{id:1,symbol:contractId,riskLimitValue:'10000000',maxLeverage:'150',maintenanceMargin:'.005',mmDeduction:''}]);
    if(u.pathname.endsWith('/funding/history'))return response(Array.from({length:10},(_,i)=>({symbol:contractId,fundingRate:'0',fundingRateTimestamp:String(Math.floor(time/(8*HOUR))*8*HOUR-i*8*HOUR)})));
    if(u.pathname.endsWith('/mark-price-kline'))return response(Array.from({length:100},(_,i)=>[Math.floor(time/STEP)*STEP-i*STEP,raw,raw,raw,raw].map(String)));
    throw Error('Unexpected endpoint '+u.pathname);
  };
}

test('hourly snapshots use all seven perpetual contracts with normalized token prices and completed-candle signals',async()=>{
  const calls=[],time=TIME+1000,q=await fetchActiveSnapshot(api(time,{calls}),()=>time,newActiveAccount());
  assert.equal(q.hour,TIME);assert.deepEqual(Object.keys(q.market),ACTIVE.symbols);
  for(const symbol of ACTIVE.symbols){
    const row=q.market[symbol];near(row.price,BASE[symbol]);near(row.mark,BASE[symbol]);
    assert.equal(row.signal.symbol,symbol);assert.equal(row.signal.at,TIME);near(row.signal.reference,BASE[symbol]*.999);
    assert.equal(row.contract.contract,CONTRACTS[symbol]);
  }
  const candles=calls.filter(c=>c.path.endsWith('/kline'));
  assert.equal(candles.length,7);assert.ok(candles.every(c=>c.category==='linear'&&c.interval==='60'));
});

test('held-position SL risk settles independently while another coin has unavailable hourly signal history',async()=>{
  const a=entered(),time=TIME+1000,calls=[];
  await assert.rejects(()=>fetchActiveSnapshot(api(time,{failedHourly:'PEPE'}),()=>time,a),/Hourly candles unavailable/);
  const q=await fetchActiveRisk(api(time,{failedHourly:'PEPE',mark:97.9,calls}),()=>time,a);
  assert.deepEqual(Object.keys(q.market),['BTC']);assert.ok(calls.every(c=>c.symbol==='BTC'));
  assert.ok(calls.every(c=>!c.path.endsWith('/kline')&&!c.path.endsWith('/risk-limit')));
  const done=advanceActiveRisk(a,q,time);assert.equal(held(done).length,0);assert.equal(done.trades[0].reason,'SL');
  assert.ok(cash(done)>50);assert.equal(done.activeDecisions.length,1);
});

test('corrupt balances, ledger totals, duplicate decisions and unsafe stop geometry are rejected',()=>{
  const original=entered();
  for(const corrupt of [
    a=>{a.sleeves[0].cash+=1;},a=>{a.fees+=1;},a=>{a.funding+=1;},a=>{a.activeDecisions.push({...a.activeDecisions[0]});},
    a=>{a.lastSignalAt+=HOUR;},a=>{a.sleeves[0].position.sl=a.sleeves[0].position.entry;},
    a=>{a.sleeves[0].position.tp=a.sleeves[0].position.entry;},a=>{a.sleeves[0].position.deadline=a.sleeves[0].position.at;}
  ]){
    const broken=structuredClone(original);corrupt(broken);assert.throws(()=>validateActiveAccount(broken));
  }
  assert.throws(()=>readActiveAccount({getItem:()=>'{'},'account'));
});

test('active-account validation cannot be bypassed with the legacy multiple-position flag',()=>{
  const a=entered(),first=a.sleeves[0].position;
  // Two equal half-sized positions reconcile to the same capital and total fees.
  const halve=p=>({...p,budget:p.budget/2,units:p.units/2,fee:p.fee/2,initialRisk:p.initialRisk/2});
  a.sleeves[0].position=halve(first);a.sleeves[1].position=halve(first);a.singlePending=true;
  assert.equal(a.migrationPending,false);assert.throws(()=>validateActiveAccount(a));
});

test('stored entry equity and initial SL risk must reconcile instead of accepting forged risk metadata',()=>{
  const a=entered();
  for(const corrupt of [p=>{p.accountAtEntry*=100;},p=>{p.initialRisk=.01;}]){
    const broken=structuredClone(a);corrupt(broken.sleeves[0].position);assert.throws(()=>validateActiveAccount(broken));
  }
});
