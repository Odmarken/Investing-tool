import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchMomentumQuotes,momentumLiveValue} from '../crypto-momentum-live.js';
import {mountMomentum} from '../crypto-momentum-ui.js';
import {newMomentumAccount,validateMomentumAccount,weekStart} from '../crypto-momentum.js';
import {openLeveraged} from '../crypto-leverage.js';

const start=Date.parse('2026-09-11T19:20:00Z'),key='riptide.momentum.20x.v1:one';
const account=()=>{
  const a=newMomentumAccount(),p=openLeveraged(100,100,start);
  a.sleeves[0]={symbol:'BTC',cash:0,position:p};a.fees=p.fee;
  return validateMomentumAccount(a);
};
const reply=(symbol,at,last=100)=>({retCode:0,time:at,result:{category:'linear',list:[{symbol,lastPrice:String(last),markPrice:String(last-.01)}]}});
const root=()=>{const nodes=new Map();return {innerHTML:'',querySelector:k=>{if(!nodes.has(k))nodes.set(k,{});return nodes.get(k);}};};
const storage=()=>{const m=new Map([[key,JSON.stringify(account())]]);return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};};
const options=(s,runtime)=>({getUser:()=>runtime.user,isActive:()=>runtime.active,grab:runtime.grab,storage:s,locks:{request:(_,fn)=>Promise.resolve(fn())},now:()=>runtime.at});

test('quote loader requests only held perpetuals and normalizes both 1000-token contracts',async()=>{
  const urls=[];
  const q=await fetchMomentumQuotes(async url=>{
    urls.push(new URL(url));const r=reply(new URL(url).searchParams.get('symbol'),start,.006);r.result.list[0].markPrice='.0059';return r;
  },['SHIB','PEPE','SHIB'],()=>start);
  assert.equal(urls.length,2);
  assert.deepEqual(urls.map(u=>u.searchParams.get('symbol')),['SHIB1000USDT','1000PEPEUSDT']);
  assert.ok(urls.every(u=>u.pathname==='/v5/market/tickers'&&u.searchParams.get('category')==='linear'));
  assert.equal(q.SHIB.price,.000006);assert.equal(q.PEPE.price,.000006);
  assert.equal(q.SHIB.mark,.0059/1000);assert.equal(q.PEPE.mark,.0059/1000);
});

test('quote loader rejects stale, future, wrong-market and invalid-price responses',async()=>{
  for(const change of [r=>r.time=start-16000,r=>r.time=start+6000,r=>r.result.category='spot',
    r=>r.retCode=10001,r=>r.result.list[0].symbol='ETHUSDT',r=>r.result.list[0].markPrice='0',r=>r.result.list[0].lastPrice='NaN']){
    const r=reply('BTCUSDT',start);change(r);
    await assert.rejects(fetchMomentumQuotes(async()=>r,['BTC'],()=>start));
  }
});

test('live net balance includes free cash, open P/L, funding and both sides of costs exactly once',()=>{
  const a=account(),p=openLeveraged(60,100,start);p.funding=1;
  a.sleeves[0]={symbol:'BTC',cash:40,position:p};a.fees=p.fee;a.funding=1;validateMomentumAccount(a);
  const original=JSON.stringify(a),q={BTC:{price:102,mark:101.99,at:start+5000}};
  const live=momentumLiveValue(a,q,start+5000);
  const exit=102*.9995,expected=100+(exit-p.entry)*p.units-p.fee-p.units*exit*.00055-1;
  assert.ok(Math.abs(live.balance-expected)<1e-10);
  assert.ok(Math.abs(live.openNet-(expected-100))<1e-10);
  assert.equal(live.at,start+5000);assert.equal(JSON.stringify(a),original);
  assert.equal(momentumLiveValue(a,q,start+21000).balance,null);
  assert.equal(momentumLiveValue(a,{BTC:{...q.BTC,at:start+121000}},start+121000).balance,null);
  assert.equal(momentumLiveValue(newMomentumAccount(),null,start).balance,100);
});

test('paused open trades get five-second live balance updates without any account writes',async()=>{
  const s=storage(),r=root(),before=s.getItem(key),runtime={user:'one',active:true,at:start,price:100};
  let calls=0;
  runtime.grab=async url=>{calls++;assert.ok(url.includes('/tickers?'));return reply('BTCUSDT',runtime.at,runtime.price);};
  s.setItem=()=>assert.fail('Live valuation must never write trades or balances');
  const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  const first=r.querySelector('[data-momentum-balance]').innerHTML;
  assert.match(r.querySelector('[data-momentum-positions]').innerHTML,/Livesaldo · hela kontot/);
  assert.match(r.querySelector('[data-momentum-live-status]').textContent,/var 5:e sekund/);
  runtime.at+=1000;await ui.refreshLive();assert.equal(calls,1);
  runtime.at+=4000;runtime.price=102;await ui.refreshLive();assert.equal(calls,2);
  const expected=momentumLiveValue(account(),{BTC:{price:102,mark:101.99,at:runtime.at}},runtime.at).balance.toFixed(2)+' $';
  assert.notEqual(r.querySelector('[data-momentum-balance]').innerHTML,first);
  assert.ok(r.querySelector('[data-momentum-balance]').innerHTML.includes(expected));
  assert.ok(r.querySelector('[data-momentum-positions]').innerHTML.includes(expected));
  assert.equal(s.getItem(key),before);
});

test('failed quotes expire instead of freezing a live balance and recover on fresh data',async()=>{
  const s=storage(),r=root(),runtime={user:'one',active:true,at:start,fail:false};
  runtime.grab=async()=>{if(runtime.fail)throw Error('offline');return reply('BTCUSDT',runtime.at);};
  const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  runtime.fail=true;runtime.at+=5000;await ui.refreshLive();
  assert.match(r.querySelector('[data-momentum-live-status]').textContent,/misslyckades/);
  runtime.at+=11000;await ui.refreshLive();
  assert.match(r.querySelector('[data-momentum-live-status]').textContent,/Väntar på färskt pris/);
  assert.match(r.querySelector('[data-momentum-positions]').innerHTML,/data-position-balance>–</);
  runtime.at+=5000;runtime.fail=false;await ui.refreshLive();
  assert.match(r.querySelector('[data-momentum-live-status]').textContent,/Pris uppdaterat/);
  assert.doesNotMatch(r.querySelector('[data-momentum-positions]').innerHTML,/data-position-balance>–</);
});

test('late live quotes cannot restore a reset, logged-out or replaced account',async()=>{
  for(const action of ['reset','logout','other-user','other-tab-reset']){
    const s=storage(),r=root(),runtime={user:'one',active:true,at:start};
    let release;const wait=new Promise(resolve=>release=resolve);
    runtime.grab=async()=>{await wait;return reply('BTCUSDT',runtime.at,120);};
    const ui=mountMomentum(r,options(s,runtime)),pending=ui.refreshLive();
    if(action==='reset')await ui.reset();
    else if(action==='logout')runtime.user=null;
    else if(action==='other-user')runtime.user='two';
    else s.setItem(key,JSON.stringify(newMomentumAccount()));
    release();await pending;
    assert.doesNotMatch(r.querySelector('[data-momentum-positions]').innerHTML,/data-position-balance/);
    if(action==='logout')assert.equal(r.querySelector('[data-momentum-balance]').innerHTML,'');
    else assert.match(r.querySelector('[data-momentum-balance]').innerHTML,/100\.00/);
  }
});

test('no live requests run while logged out, outside crypto, or without a position',async()=>{
  const s=storage(),r=root(),runtime={user:null,active:true,at:start,grab:()=>assert.fail('Unexpected request')};
  const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  runtime.user='one';runtime.active=false;await ui.refreshLive();
  runtime.active=true;s.setItem(key,JSON.stringify(newMomentumAccount()));await ui.refreshLive();
});

test('live polling clears old decision history on user change and another tab reset',async()=>{
  const s=storage(),a=account(),r=root(),runtime={user:'one',active:true,at:start,grab:async()=>reply('BTCUSDT',start)};
  a.lastWeek=weekStart(start);a.startedAt=start;
  a.decisions=[{week:a.lastWeek,at:start,signals:a.sleeves.map(s=>({symbol:s.symbol,score:.1,price:100,action:s.position?'köp':'kontanter'}))}];
  s.setItem(key,JSON.stringify(validateMomentumAccount(a)));
  const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  assert.match(r.querySelector('[data-momentum-history]').innerHTML,/BTC: köp/);
  runtime.user='two';await ui.refreshLive();
  assert.doesNotMatch(r.querySelector('[data-momentum-history]').innerHTML,/BTC: köp/);
  runtime.user='one';await ui.refreshLive();
  assert.match(r.querySelector('[data-momentum-history]').innerHTML,/BTC: köp/);
  s.setItem(key,JSON.stringify(newMomentumAccount()));await ui.refreshLive();
  assert.doesNotMatch(r.querySelector('[data-momentum-history]').innerHTML,/BTC: köp/);
});
