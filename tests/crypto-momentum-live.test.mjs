import test from 'node:test';
import assert from 'node:assert/strict';
import { MOMENTUM, weekStart, momentumScore, newMomentumAccount, validateMomentumAccount, advanceMomentum, momentumValue, fetchMomentumSnapshot,readMomentum } from '../crypto-momentum.js';
import { mountMomentum } from '../crypto-momentum-ui.js';
import { policy } from '../research/crypto-momentum-policies.mjs';
import {LEVERAGE,openLeveraged,liquidationPrice,leveragedValue} from '../crypto-leverage.js';
const now = Date.parse('2026-09-11T12:00:00Z'), week = weekStart(now), DAY=MOMENTUM.day;
const contract=(symbol,at,max=20)=>({symbol,contract:symbol+'USDT',max,min:1,step:.01,at,tiers:[{id:1,cap:1e7,max,maintenance:.0033,deduction:0}]});
const snapshot = (time=now,score=.1,price=100) => ({ week:weekStart(time), market:Object.fromEntries(MOMENTUM.symbols.map(s=>[s,{at:time,score,price,mark:price,
  contract:{...contract(s,time),tiers:[{id:1,cap:1e7,max:20,maintenance:.005,deduction:0}]},
  historyFrom:now-LEVERAGE.step,fundingThrough:time,funding:[],markBars:Array.from({length:Math.max(0,Math.floor((time-now)/LEVERAGE.step)+2)},(_,i)=>({t:now-LEVERAGE.step+i*LEVERAGE.step,o:100,h:100,l:100,c:100}))}])) });
const enabled = () => ({...newMomentumAccount(),enabled:true});
const dailyBars = time => Array.from({length:100},(_,i)=>{
  const t=Math.floor(time/DAY)*DAY-(99-i)*DAY,c=100+i;
  return {t,o:c,h:c+1,l:c-1,c,v:1};
});
const fakeGrab = time => async url => {
  const u=new URL(url),symbol=u.searchParams.get('symbol');
  if(u.pathname.endsWith('/tickers'))return {retCode:0,time,result:{list:[{symbol,lastPrice:'199',markPrice:'199',nextFundingTime:String((Math.floor(time/28800000)+1)*28800000)}]}};
  if(u.pathname.endsWith('/instruments-info'))return {retCode:0,time,result:{category:'linear',list:[{symbol,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'20',leverageStep:'.01'}}]}};
  if(u.pathname.endsWith('/risk-limit'))return {retCode:0,time,result:{category:'linear',list:[{id:1,symbol,riskLimitValue:'10000000',maxLeverage:'20',maintenanceMargin:'.005',mmDeduction:''}]}};
  if(u.pathname.endsWith('/funding/history'))return {retCode:0,time,result:{list:Array.from({length:10},(_,i)=>({symbol,fundingRate:'0',fundingRateTimestamp:String(Math.floor(time/28800000)*28800000-i*28800000)}))}};
  if(u.pathname.endsWith('/mark-price-kline'))return {retCode:0,time,result:{category:'linear',symbol,list:Array.from({length:1000},(_,i)=>[Math.floor(time/300000)*300000-i*300000,199,199,199,199].map(String))}};
  return {retCode:0,time,result:{category:'spot',symbol,list:dailyBars(time).reverse().map(b=>[b.t,b.o,b.h,b.l,b.c,b.v].map(String))}};
};
const storage = () => {const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),values};};
const locks = () => {let chain=Promise.resolve();return {request:(key,fn)=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;}};};
const root = () => {const nodes=new Map();return {innerHTML:'',querySelector:k=>{if(!nodes.has(k))nodes.set(k,{});return nodes.get(k);}};};

test('each new momentum trade uses its coin maximum and freezes its entry rules',()=>{
  const q=snapshot();
  for(const [s,max] of Object.entries({BTC:150,ETH:100,SOL:75}))q.market[s].contract=contract(s,now,max);
  const a=advanceMomentum(enabled(),q,now);
  assert.deepEqual(a.sleeves.map(s=>s.position.rules.leverage),[150,100,75]);
  const before=a.sleeves.map(s=>liquidationPrice(s.position));
  const next=snapshot(now+1000);for(const v of Object.values(next.market))v.contract=null;
  const b=advanceMomentum(a,next,now+1000);
  assert.deepEqual(b.sleeves.map(s=>liquidationPrice(s.position)),before);
  const exit=snapshot(now+7*DAY,-.1,101);
  const c=advanceMomentum(b,exit,now+7*DAY);
  assert.deepEqual(c.trades.map(t=>t.leverage),[150,100,75]);
  assert.equal(validateMomentumAccount(c),c);
});

test('old 20x accounts migrate without resetting balances, switch or open positions',()=>{
  const old=advanceMomentum(enabled(),snapshot(),now);old.version='momentum-14-28-56-20x-v1';
  for(const s of old.sleeves)delete s.position.rules;
  const loaded=readMomentum({getItem:()=>JSON.stringify(old)},'old');
  assert.equal(loaded.version,MOMENTUM.version);assert.equal(loaded.enabled,true);
  assert.deepEqual(loaded.sleeves,old.sleeves);assert.deepEqual(loaded.decisions,old.decisions);
  assert.equal(liquidationPrice(loaded.sleeves[0].position),liquidationPrice(old.sleeves[0].position));
});

test('missing entry limits defer the week while liquidation monitoring continues',()=>{
  const q=snapshot();q.market.SOL.score=-.1;
  const a=advanceMomentum(enabled(),q,now),time=now+7*DAY;
  const pending=snapshot(time);pending.market.SOL.contract=null;pending.market.BTC.markBars.at(-1).l=90;
  const b=advanceMomentum(a,pending,time);
  assert.equal(b.trades[0].reason,'likvidation');assert.equal(b.sleeves[0].cash,0);
  assert.equal(b.decisions.length,1);assert.match(b.waitReason,/Veckobeslut/);assert.equal(b.sleeves[2].position,null);
  pending.market.SOL.contract=contract('SOL',time,100);
  const c=advanceMomentum(b,pending,time);
  assert.equal(c.decisions.length,2);assert.equal(c.sleeves[2].position.rules.leverage,100);assert.equal(c.waitReason,undefined);
});

test('weekly signal matches researched multi policy and ignores unfinished and post-decision closes',()=>{
  const bars=dailyBars(now),i=bars.findIndex(b=>b.t===week);
  const score=momentumScore(bars,week);
  const expected=[14,28,56].reduce((sum,n)=>sum+bars[i-1].c/bars[i-1-n].c-1,0)/3;
  assert.equal(score,expected);
  assert.deepEqual(policy('multi').wanted({BTC:bars},i,[null]),score>0?['BTC']:[null]);
  assert.equal(momentumScore(bars.map(b=>b.t>=week?{...b,c:1e9}:b),week),score);
  assert.throws(()=>momentumScore(bars.filter(b=>b.t!==week-10*DAY),week));
});

test('live fills use observation prices, only once weekly, and paused mode does not trade',()=>{
  const initial=enabled(),a=advanceMomentum(initial,snapshot(),now);
  assert.equal(initial.sleeves[0].position,null);
  assert.equal(a.sleeves[0].position.at,now);
  assert.equal(a.sleeves[0].position.entry,100*1.0005);
  assert.equal(a.decisions[0].week,week);assert.equal(a.decisions[0].at,now);
  assert.equal(advanceMomentum(a,snapshot(now+1000,-.2),now+1000).decisions.length,1);
  const paused={...a,enabled:false};
  assert.equal(advanceMomentum(paused,snapshot(now+7*DAY,-.2),now+7*DAY).trades.length,0);
  assert.equal(a.decisions.length,1);
});

test('weekly exits reconcile cash, both fees, slippage and net liquidation value',()=>{
  const a=advanceMomentum(enabled(),snapshot(),now),time=now+7*DAY;
  const b=advanceMomentum(a,snapshot(time,-.1,120),time);
  const entry=100*1.0005,units=100/(entry*(1/20+.00055));
  const expected=100+units*(120*.9995-entry)-units*entry*.00055-units*120*.9995*.00055;
  assert.equal(b.trades.length,3);
  assert.ok(Math.abs(momentumValue(b,null,time)-expected)<1e-10);
  assert.ok(Math.abs(b.trades.reduce((sum,t)=>sum+t.pnl,0)-(expected-100))<1e-10);
  assert.ok(Math.abs(momentumValue(a,snapshot(),now)-leveragedValue(openLeveraged(100,100,now),100))<1e-10);
  assert.equal(momentumValue(a,snapshot(),now+180000),null);
  assert.equal(validateMomentumAccount(JSON.parse(JSON.stringify(b))).trades.length,3);
});

test('missing data, stale snapshots and corrupt accounts cannot execute',()=>{
  assert.throws(()=>advanceMomentum(enabled(),snapshot(now-180000),now));
  assert.throws(()=>advanceMomentum(enabled(),snapshot(now+7*DAY),now));
  const q=snapshot();delete q.market.ETH;assert.throws(()=>advanceMomentum(enabled(),q,now));
  const a=enabled();a.sleeves[0].cash=100;assert.throws(()=>validateMomentumAccount(a));
});

test('Bybit loader validates market, candles, freshness and UTC decision week',async()=>{
  const good=await fetchMomentumSnapshot(fakeGrab(now),()=>now);
  assert.equal(good.week,week);assert.equal(good.market.BTC.price,199);
  const bad=async url=>{const r=await fakeGrab(now)(url);r.result.category='linear';return r;};
  await assert.rejects(fetchMomentumSnapshot(bad,()=>now));
  await assert.rejects(fetchMomentumSnapshot(fakeGrab(now-180000),()=>now));
});

test('checked UI starts demo, persists through reload, and does not inherit legacy shadow setting',async()=>{
  const s=storage(),l=locks(),r=root(),opts={getUser:()=> 'one',isActive:()=>true,grab:fakeGrab(now),storage:s,locks:l,now:()=>now};
  const ui=mountMomentum(r,opts);await ui.refresh();
  assert.equal(r.querySelector('[data-momentum-toggle]').checked,false);
  r.querySelector('[data-momentum-toggle]').checked=true;await r.querySelector('[data-momentum-toggle]').onchange();
  const a=JSON.parse(s.getItem('riptide.momentum.20x.v1:one'));assert.equal(a.decisions.length,1);assert.ok(a.sleeves.every(x=>x.position));
  const other=root();await mountMomentum(other,opts).refresh();
  assert.equal(other.querySelector('[data-momentum-toggle]').checked,true);
  assert.equal(JSON.parse(s.getItem('riptide.momentum.20x.v1:one')).decisions.length,1);
});

test('two tabs share a lock and cannot duplicate weekly orders',async()=>{
  const s=storage(),l=locks();s.setItem('riptide.momentum.20x.v1:one',JSON.stringify(enabled()));
  const options={getUser:()=> 'one',isActive:()=>true,grab:fakeGrab(now),storage:s,locks:l,now:()=>now};
  await Promise.all([mountMomentum(root(),options).refresh(),mountMomentum(root(),options).refresh()]);
  assert.equal(JSON.parse(s.getItem('riptide.momentum.20x.v1:one')).decisions.length,1);
});

test('pause or logout during a price request prevents delayed fills and clears private display',async()=>{
  for(const mode of ['pause','logout']){
    const s=storage(),r=root();s.setItem('riptide.momentum.20x.v1:one',JSON.stringify(enabled()));
    let user='one',release;const waiting=new Promise(resolve=>{release=resolve;});
    const ui=mountMomentum(r,{getUser:()=>user,isActive:()=>true,grab:async url=>{await waiting;return fakeGrab(now)(url);},storage:s,locks:locks(),now:()=>now});
    const pending=ui.refresh();
    if(mode==='pause'){r.querySelector('[data-momentum-toggle]').checked=false;await r.querySelector('[data-momentum-toggle]').onchange();}
    else user=null;
    release();await pending;
    assert.equal(JSON.parse(s.getItem('riptide.momentum.20x.v1:one')).decisions.length,0);
    if(mode==='logout') assert.equal(r.querySelector('[data-momentum-positions]').innerHTML,'');
  }
});

test('storage failure does not expose unsaved fills; another user gets a separate empty account',async()=>{
  const s=storage(),r=root(),l=locks();s.setItem('riptide.momentum.20x.v1:one',JSON.stringify(enabled()));
  let user='one';const set=s.setItem;s.setItem=()=>{throw Error('full');};
  const ui=mountMomentum(r,{getUser:()=>user,isActive:()=>true,grab:fakeGrab(now),storage:s,locks:l,now:()=>now});
  await ui.refresh();assert.match(r.querySelector('[data-momentum-status]').textContent,/full/);
  assert.equal(JSON.parse(s.getItem('riptide.momentum.20x.v1:one')).decisions.length,0);
  s.setItem=set;user='two';await ui.refresh(true);
  assert.equal(r.querySelector('[data-momentum-toggle]').checked,false);
  assert.doesNotMatch(r.querySelector('[data-momentum-positions]').innerHTML,/köpt/);
});

test('20x liquidation loses only that sleeve and still runs while strategy orders are paused',()=>{
  const a=advanceMomentum(enabled(),snapshot(),now);a.enabled=false;
  const q=snapshot(now+600000);
  q.market.BTC.markBars.at(-1).l=90;
  const b=advanceMomentum(a,q,now+600000);
  assert.equal(b.trades.length,1);assert.equal(b.trades[0].reason,'likvidation');
  assert.equal(b.sleeves[0].cash,0);assert.equal(b.sleeves[0].position,null);
  assert.ok(b.sleeves[1].position);assert.ok(b.sleeves[2].position);
  assert.ok(Math.abs(b.trades[0].pnl+100/3)<1e-10);
});

test('funding is charged once while held and changes the liquidation threshold',()=>{
  const a=advanceMomentum(enabled(),snapshot(),now),time=now+4*3600000;
  const q=snapshot(time);q.market.BTC.funding=[{t:time,rate:.001}];
  const b=advanceMomentum(a,q,time),p=b.sleeves[0].position;
  assert.ok(Math.abs(p.funding-a.sleeves[0].position.units*100*.001)<1e-10);
  assert.ok(liquidationPrice(p)>liquidationPrice(a.sleeves[0].position));
  const c=advanceMomentum(b,q,time);assert.equal(c.funding,b.funding);
});
