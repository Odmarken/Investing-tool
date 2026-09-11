import test from 'node:test';
import assert from 'node:assert/strict';
import { MOMENTUM, weekStart, momentumScore, newMomentumAccount, validateMomentumAccount, advanceMomentum, momentumValue, fetchMomentumSnapshot,readMomentum } from '../crypto-momentum.js';
import {CONTRACTS,CONTRACT_UNITS} from '../bybit-contracts.js';
import {fetchDerivatives} from '../crypto-momentum-market.js';
import { mountMomentum } from '../crypto-momentum-ui.js';
import { policy } from '../research/crypto-momentum-policies.mjs';
import {LEVERAGE,openLeveraged,liquidationPrice,leveragedValue,inspectLeveraged} from '../crypto-leverage.js';
const now = Date.parse('2026-09-11T12:00:00Z'), week = weekStart(now), DAY=MOMENTUM.day;
const contract=(symbol,at,max=20)=>({symbol,contract:CONTRACTS[symbol],max,min:1,step:.01,at,tiers:[{id:1,cap:1e7,max,maintenance:.0033,deduction:0}]});
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

test('reset archives only the current momentum account and persists a paused 100 dollar restart',async()=>{
  const s=storage(),r=root(),key='riptide.momentum.20x.v1:one';
  const previous=JSON.stringify(advanceMomentum(enabled(),snapshot(),now));
  s.setItem(key,previous);s.setItem('riptide.momentum.20x.v1:two',previous);s.setItem('riptide.krypto.v1','ordinary');
  const options={getUser:()=> 'one',isActive:()=>false,grab:fakeGrab(now),storage:s,locks:locks(),now:()=>now};
  const ui=mountMomentum(r,options);await ui.refresh();await r.querySelector('[data-momentum-reset]').onclick();
  assert.deepEqual(JSON.parse(s.getItem(key)),newMomentumAccount());
  assert.equal(s.getItem(key+':before-reset:'+now),previous);
  assert.equal(s.getItem('riptide.momentum.20x.v1:two'),previous);assert.equal(s.getItem('riptide.krypto.v1'),'ordinary');
  assert.equal(r.querySelector('[data-momentum-toggle]').checked,false);
  assert.match(r.querySelector('[data-momentum-balance]').innerHTML,/100\.00/);
  await mountMomentum(root(),options).refresh();assert.equal(momentumValue(readMomentum(s,key),null,now),100);
});

test('failed reset writes leave original account intact and report the error',async()=>{
  for(const failAt of ['archive','account']){
    const s=storage(),r=root(),key='riptide.momentum.20x.v1:one',previous=JSON.stringify(enabled());
    s.setItem(key,previous);const save=s.setItem;
    s.setItem=(k,v)=>{if(failAt==='archive'||k===key)throw Error('storage full');save(k,v);};
    const ui=mountMomentum(r,{getUser:()=> 'one',isActive:()=>false,grab:fakeGrab(now),storage:s,locks:locks(),now:()=>now});
    await ui.refresh();await ui.reset();assert.equal(s.getItem(key),previous);
    assert.match(r.querySelector('[data-momentum-status]').textContent,/storage full/);
  }
});

test('a price request started before reset cannot repopulate the fresh account',async()=>{
  const s=storage(),key='riptide.momentum.20x.v1:one';s.setItem(key,JSON.stringify(enabled()));
  let release;const waiting=new Promise(resolve=>release=resolve);
  const ui=mountMomentum(root(),{getUser:()=> 'one',isActive:()=>true,grab:async url=>{await waiting;return fakeGrab(now)(url);},storage:s,locks:locks(),now:()=>now});
  const pending=ui.refresh();await ui.reset();release();await pending;
  assert.deepEqual(JSON.parse(s.getItem(key)),newMomentumAccount());
});

test('any of seven coins can win, uses its own maximum, and stays alone while positive',()=>{
  for(const [symbol,max] of Object.entries({BTC:150,ETH:150,SOL:100,XRP:100,DOGE:75,SHIB:50,PEPE:50})){
    const q=snapshot();q.market[symbol].score=.3;q.market[symbol].contract=contract(symbol,now,max);
    const a=advanceMomentum(enabled(),q,now),held=a.sleeves.filter(s=>s.position);
    assert.equal(held.length,1);assert.equal(held[0].symbol,symbol);assert.equal(held[0].position.rules.leverage,max);
    assert.equal(held[0].position.budget,100);assert.equal(a.sleeves.reduce((sum,s)=>sum+s.cash,0),0);
    const before=liquidationPrice(held[0].position),next=snapshot(now+7*DAY);
    for(const q of Object.values(next.market))q.contract=null;
    next.market.BTC.score=1; // A stronger alternative never displaces a positive holding.
    const b=advanceMomentum(a,next,now+7*DAY),p=b.sleeves.find(s=>s.position).position;
    assert.equal(p.rules.leverage,max);assert.equal(liquidationPrice(p),before);
    const c=advanceMomentum(b,snapshot(now+14*DAY,-.1,101),now+14*DAY);
    assert.equal(c.trades.length,1);assert.equal(c.trades[0].leverage,max);validateMomentumAccount(c);
  }
});

const legacyAccount=()=>{
  const sleeves=['BTC','ETH','SOL'].map(symbol=>({symbol,cash:0,position:openLeveraged(100/3,100,now)}));
  return {version:'momentum-14-28-56-20x-v1',enabled:true,startedAt:now,lastWeek:week,
    fees:sleeves.reduce((sum,s)=>sum+s.position.fee,0),funding:0,sleeves,trades:[],
    decisions:[{week,at:now,signals:sleeves.map(s=>({symbol:s.symbol,score:.1,action:'köp',price:100}))}]};
};

test('legacy balances and history migrate; surplus positions close once at current prices',()=>{
  const old=legacyAccount();for(const s of old.sleeves)delete s.position.rules;
  const loaded=readMomentum({getItem:()=>JSON.stringify(old)},'old');
  assert.equal(loaded.version,MOMENTUM.version);assert.equal(loaded.enabled,true);assert.equal(loaded.singlePending,true);
  assert.deepEqual(loaded.sleeves.slice(0,3),old.sleeves);assert.deepEqual(loaded.decisions,old.decisions);
  const q=snapshot(now+1000);q.market.ETH.score=.3;
  const next=advanceMomentum(loaded,q,now+1000);
  assert.equal(next.sleeves.filter(s=>s.position).length,1);assert.ok(next.sleeves[1].position);
  assert.equal(next.trades.length,2);assert.ok(next.trades.every(t=>t.reason==='single-position'));
  assert.equal(next.decisions.length,1);assert.equal(next.singlePending,undefined);
  assert.ok(Math.abs(momentumValue(next,q,now+1000)-momentumValue(loaded,q,now+1000))<1e-10);
  assert.equal(advanceMomentum(next,q,now+1000).trades.length,2);
});

test('paused Bybit-max accounts consolidate without resizing or changing the retained terms',()=>{
  const old=legacyAccount();old.version='momentum-14-28-56-bybitmax-v2';old.enabled=false;
  for(const s of old.sleeves)s.position=openLeveraged(100/3,100,now,{...LEVERAGE,leverage:100,maintenance:.0033});
  old.fees=old.sleeves.reduce((sum,s)=>sum+s.position.fee,0);
  const q=snapshot(now+1000);q.market.SOL.score=.3;
  const next=advanceMomentum(old,q,now+1000);
  assert.deepEqual(next.sleeves[2].position.rules,old.sleeves[2].position.rules);
  assert.equal(next.sleeves[2].position.budget,100/3);
  assert.equal(next.sleeves.filter(s=>s.position).length,1);assert.equal(next.trades.length,2);
  assert.ok(next.sleeves.reduce((sum,s)=>sum+s.cash,0)>0);
});

test('current accounts reject parallel positions even when the cash and fees reconcile',()=>{
  const old=legacyAccount(),a={...old,version:MOMENTUM.version,sleeves:[...old.sleeves,...newMomentumAccount().sleeves.slice(3)]};
  assert.throws(()=>validateMomentumAccount(a),/en öppen position/);
});

test('missing entry limits defer the week without delaying the existing position exit',()=>{
  const a=advanceMomentum(enabled(),snapshot(),now),time=now+7*DAY;
  const pending=snapshot(time);pending.market.BTC.score=-.1;pending.market.SOL.score=.3;pending.market.SOL.contract=null;
  const b=advanceMomentum(a,pending,time);
  assert.equal(b.trades.length,1);assert.equal(b.trades[0].reason,'signal');assert.ok(b.sleeves.every(s=>!s.position));
  assert.equal(b.decisions.length,1);assert.match(b.waitReason,/Veckobeslut/);
  pending.market.SOL.contract=contract('SOL',time,100);
  const c=advanceMomentum(b,pending,time);
  assert.equal(c.decisions.length,2);assert.equal(c.sleeves[2].position.rules.leverage,100);assert.equal(c.waitReason,undefined);
  assert.equal(c.trades.length,1);assert.equal(c.sleeves.filter(s=>s.position).length,1);
});

test('ties are deterministic; nonpositive momentum stays in cash',()=>{
  assert.equal(advanceMomentum(enabled(),snapshot(),now).sleeves.find(s=>s.position).symbol,'BTC');
  const a=advanceMomentum(enabled(),snapshot(now,0),now);
  assert.ok(a.sleeves.every(s=>!s.position));assert.equal(momentumValue(a,null,now),100);
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
  assert.equal(b.trades.length,1);
  assert.ok(Math.abs(momentumValue(b,null,time)-expected)<1e-10);
  assert.ok(Math.abs(b.trades.reduce((sum,t)=>sum+t.pnl,0)-(expected-100))<1e-10);
  assert.ok(Math.abs(momentumValue(a,snapshot(),now)-leveragedValue(openLeveraged(100,100,now),100))<1e-10);
  assert.equal(momentumValue(a,snapshot(),now+180000),null);
  assert.equal(validateMomentumAccount(JSON.parse(JSON.stringify(b))).trades.length,1);
});

test('missing data, stale snapshots and corrupt accounts cannot execute',()=>{
  assert.throws(()=>advanceMomentum(enabled(),snapshot(now-180000),now));
  assert.throws(()=>advanceMomentum(enabled(),snapshot(now+7*DAY),now));
  const q=snapshot();delete q.market.ETH;assert.throws(()=>advanceMomentum(enabled(),q,now));
  const a=enabled();a.sleeves[0].cash=101;assert.throws(()=>validateMomentumAccount(a));
});

test('Bybit loader validates market, candles, freshness and UTC decision week',async()=>{
  const good=await fetchMomentumSnapshot(fakeGrab(now),()=>now);
  assert.equal(good.week,week);assert.equal(good.market.BTC.price,199);
  const bad=async url=>{const r=await fakeGrab(now)(url);r.result.category='linear';return r;};
  await assert.rejects(fetchMomentumSnapshot(bad,()=>now));
  await assert.rejects(fetchMomentumSnapshot(fakeGrab(now-180000),()=>now));
});

test('1000-token contracts normalize quotes, liquidation and funding with four-hour coverage',async()=>{
  const time=now+8*3600000,interval=4*3600000,rawPrice=.006;
  for(const symbol of ['SHIB','PEPE']){
    const paths=[];
    const grab=async url=>{
      const u=new URL(url);paths.push(u.searchParams.get('symbol'));
      const r=await fakeGrab(time)(url);
      if(u.pathname.endsWith('/tickers'))Object.assign(r.result.list[0],{lastPrice:String(rawPrice),markPrice:String(rawPrice),nextFundingTime:String(time+interval)});
      if(u.pathname.endsWith('/instruments-info'))r.result.list[0].fundingInterval='240';
      if(u.pathname.endsWith('/mark-price-kline'))r.result.list=r.result.list.map(row=>[row[0],rawPrice,rawPrice,rawPrice,rawPrice].map(String));
      if(u.pathname.endsWith('/funding/history'))r.result.list=Array.from({length:4},(_,i)=>({symbol:CONTRACTS[symbol],fundingRate:'.0001',fundingRateTimestamp:String(time-i*interval)}));
      return r;
    };
    const p=openLeveraged(100,rawPrice/CONTRACT_UNITS[symbol],now),market=await fetchDerivatives(grab,symbol,p,()=>time);
    assert.ok(paths.every(s=>s===CONTRACTS[symbol]));
    assert.equal(market.price,rawPrice/1000);assert.equal(market.mark,rawPrice/1000);
    assert.ok(market.markBars.every(b=>b.o===rawPrice/1000&&b.l===rawPrice/1000));
    assert.equal(market.funding.length,2);
    const checked=inspectLeveraged(p,market,time),raw=openLeveraged(100,rawPrice,now);
    assert.equal(checked.liquidated,null);
    assert.ok(Math.abs(checked.funding-raw.units*rawPrice*.0001*2)<1e-10);
    assert.ok(Math.abs(liquidationPrice(p)*1000-liquidationPrice(raw))<1e-10);
    assert.ok(Math.abs(leveragedValue(p,market.price)-leveragedValue(raw,rawPrice))<1e-10);
    const missing=async url=>{
      const r=await grab(url);
      if(new URL(url).pathname.endsWith('/funding/history'))r.result.list=r.result.list.filter(f=>+f.fundingRateTimestamp!==now+interval);
      return r;
    };
    await assert.rejects(fetchDerivatives(missing,symbol,p,()=>time),/komplett/);
  }
});

test('checked UI starts demo, persists through reload, and does not inherit legacy shadow setting',async()=>{
  const s=storage(),l=locks(),r=root(),opts={getUser:()=> 'one',isActive:()=>true,grab:fakeGrab(now),storage:s,locks:l,now:()=>now};
  const ui=mountMomentum(r,opts);await ui.refresh();
  assert.equal(r.querySelector('[data-momentum-toggle]').checked,false);
  r.querySelector('[data-momentum-toggle]').checked=true;await r.querySelector('[data-momentum-toggle]').onchange();
  const a=JSON.parse(s.getItem('riptide.momentum.20x.v1:one'));assert.equal(a.decisions.length,1);assert.equal(a.sleeves.filter(x=>x.position).length,1);
  const other=root();await mountMomentum(other,opts).refresh();
  assert.equal(other.querySelector('[data-momentum-toggle]').checked,true);
  assert.equal(JSON.parse(s.getItem('riptide.momentum.20x.v1:one')).decisions.length,1);
});

test('two tabs share a lock and cannot duplicate weekly orders',async()=>{
  const s=storage(),l=locks();s.setItem('riptide.momentum.20x.v1:one',JSON.stringify(enabled()));
  const options={getUser:()=> 'one',isActive:()=>true,grab:fakeGrab(now),storage:s,locks:l,now:()=>now};
  await Promise.all([mountMomentum(root(),options).refresh(),mountMomentum(root(),options).refresh()]);
  assert.equal(JSON.parse(s.getItem('riptide.momentum.20x.v1:one')).decisions.length,1);
  assert.equal(JSON.parse(s.getItem('riptide.momentum.20x.v1:one')).sleeves.filter(s=>s.position).length,1);
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

test('liquidation consumes the single full-balance position even while orders are paused',()=>{
  const a=advanceMomentum(enabled(),snapshot(),now);a.enabled=false;
  const q=snapshot(now+600000);
  q.market.BTC.markBars.at(-1).l=90;
  const b=advanceMomentum(a,q,now+600000);
  assert.equal(b.trades.length,1);assert.equal(b.trades[0].reason,'likvidation');
  assert.equal(b.sleeves[0].cash,0);assert.equal(b.sleeves[0].position,null);
  assert.ok(b.sleeves.every(s=>!s.position));
  assert.ok(Math.abs(b.trades[0].pnl+100)<1e-10);
});

test('funding is charged once while held and changes the liquidation threshold',()=>{
  const a=advanceMomentum(enabled(),snapshot(),now),time=now+4*3600000;
  const q=snapshot(time);q.market.BTC.funding=[{t:time,rate:.001}];
  const b=advanceMomentum(a,q,time),p=b.sleeves[0].position;
  assert.ok(Math.abs(p.funding-a.sleeves[0].position.units*100*.001)<1e-10);
  assert.ok(liquidationPrice(p)>liquidationPrice(a.sleeves[0].position));
  const c=advanceMomentum(b,q,time);assert.equal(c.funding,b.funding);
});
