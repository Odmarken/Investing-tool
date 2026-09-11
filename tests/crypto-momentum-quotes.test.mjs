import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchMomentumQuotes,momentumLiveValue} from '../crypto-momentum-live.js';
import {mountMomentum} from '../crypto-momentum-ui.js';
import {newMomentumAccount,validateMomentumAccount} from '../crypto-momentum.js';
import {newActiveAccount,validateActiveAccount} from '../crypto-momentum-active.js';
import {openActivePosition} from '../crypto-momentum-active-execution.js';
import {openLeveraged} from '../crypto-leverage.js';

const start=Date.parse('2026-09-11T19:20:00Z'),key='riptide.momentum.20x.v1:one';
const account=()=>{
  const a=newMomentumAccount(),p=openLeveraged(100,100,start);
  a.sleeves[0]={symbol:'BTC',cash:0,position:p};a.fees=p.fee;
  return validateMomentumAccount(a);
};
const reply=(symbol,at,last=100)=>({retCode:0,time:at,result:{category:'linear',list:[{symbol,lastPrice:String(last),markPrice:String(last-.01)}]}});
const root=()=>{const nodes=new Map();return {innerHTML:'',querySelector:k=>{if(!nodes.has(k))nodes.set(k,{});return nodes.get(k);}};};
const activeAccount=()=>{
  const a=newActiveAccount(),at=Math.floor(start/3600000)*3600000;
  const contract={symbol:'BTC',contract:'BTCUSDT',at:start,min:1,max:150,step:.01,
    tiers:[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}]};
  const p=openActivePosition(100,{price:100,mark:100,contract},
    {symbol:'BTC',at,reference:100,score:.1,slDistance:2,rewardMultiple:2,maxHoldMs:12*3600000},start);
  assert.ok(p);assert.ok(p.budget<=50+1e-8);
  a.sleeves[0]={symbol:'BTC',cash:100-p.budget,position:p};a.fees=p.fee;a.startedAt=start;
  return validateActiveAccount(a);
};
const storage=()=>{const m=new Map([[key,JSON.stringify(activeAccount())]]);return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};};
const options=(s,runtime)=>({getUser:()=>runtime.user,isActive:()=>runtime.active,grab:runtime.grab,storage:s,locks:{request:(_,fn)=>Promise.resolve(fn())},now:()=>runtime.at});
function mockDerivatives(runtime,urls=[]){
  return async url=>{
    const u=new URL(url),symbol=u.searchParams.get('symbol'),path=u.pathname.replace('/v5/market/',''),at=runtime.at;
    urls.push(u);assert.equal(symbol,'BTCUSDT','Fast risk updates only request the held contract');
    assert.equal(u.searchParams.get('category'),'linear');
    if(runtime.fail)throw Error('offline');
    if(path==='tickers'){
      const r=reply(symbol,at,runtime.price??100);
      r.result.list[0].nextFundingTime=String((Math.floor(at/28800000)+1)*28800000);return r;
    }
    if(path==='instruments-info')return {retCode:0,time:at,result:{category:'linear',list:[{
      symbol,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',
      leverageFilter:{minLeverage:'1',maxLeverage:'150',leverageStep:'.01'}
    }]}};
    if(path==='risk-limit')return {retCode:0,time:at,result:{category:'linear',list:[{
      id:1,symbol,riskLimitValue:'10000000',maxLeverage:'150',maintenanceMargin:'.005',mmDeduction:''
    }]}};
    if(path==='mark-price-kline')return {retCode:0,time:at,result:{category:'linear',symbol,
      list:Array.from({length:1000},(_,i)=>[Math.floor(at/300000)*300000-i*300000,100,100,100,100].map(String))}};
    if(path==='funding/history')return {retCode:0,time:at,result:{category:'linear',list:Array.from({length:3},(_,i)=>({
      symbol,fundingRate:String(runtime.fundingRate??0),fundingRateTimestamp:String(Math.floor(at/28800000)*28800000-i*28800000)
    }))}};
    assert.fail('Unexpected entry-data request: '+url);
  };
}

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

test('paused trades get five-second live balances and saved risk cursors without new entries or repeated fees',async()=>{
  const s=storage(),r=root(),before=s.getItem(key),runtime={user:'one',active:true,at:start,price:100};
  const urls=[];runtime.grab=mockDerivatives(runtime,urls);
  let writes=0;const save=s.setItem;s.setItem=(k,v)=>{writes++;save(k,v);};
  const tickerCalls=()=>urls.filter(u=>u.pathname.endsWith('/tickers')).length;
  const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  const first=r.querySelector('[data-momentum-balance]').innerHTML;
  assert.match(r.querySelector('[data-momentum-positions]').innerHTML,/Livesaldo · hela kontot/);
  assert.match(r.querySelector('[data-momentum-live-status]').textContent,/var 5:e sekund/);
  runtime.at+=1000;await ui.refreshLive();assert.equal(tickerCalls(),1);assert.equal(writes,1);
  runtime.at+=4000;runtime.price=102;await ui.refreshLive();assert.equal(tickerCalls(),2);assert.equal(writes,2);
  const saved=validateActiveAccount(JSON.parse(s.getItem(key))),original=JSON.parse(before);
  const expected=momentumLiveValue(saved,{BTC:{price:102,mark:101.99,at:runtime.at}},runtime.at).balance.toFixed(2)+' $';
  assert.notEqual(r.querySelector('[data-momentum-balance]').innerHTML,first);
  assert.ok(r.querySelector('[data-momentum-balance]').innerHTML.includes(expected));
  assert.ok(r.querySelector('[data-momentum-positions]').innerHTML.includes(expected));
  assert.equal(saved.enabled,false);assert.equal(saved.trades.length,0);assert.equal(saved.activeDecisions.length,0);
  assert.equal(saved.sleeves.filter(s=>s.position).length,1);assert.equal(saved.fees,original.fees);
  assert.equal(saved.funding,original.funding);assert.equal(saved.sleeves[0].position.fundingThrough,runtime.at);
  assert.equal(saved.sleeves[0].position.budget,original.sleeves[0].position.budget);
  assert.ok(urls.every(u=>!u.pathname.endsWith('/kline')),'Fast protection never fetches entry signals');
});

test('SL and TP continue while new entries are paused and each exit is booked only once',async()=>{
  for(const [reason,price] of [['SL',97.9],['TP',104.1]]){
    const s=storage(),r=root(),original=JSON.parse(s.getItem(key)),runtime={user:'one',active:true,at:start,price:100};
    runtime.grab=mockDerivatives(runtime);
    const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
    runtime.at+=5000;runtime.price=price;await ui.refreshLive();
    const closed=validateActiveAccount(JSON.parse(s.getItem(key)));
    assert.equal(closed.enabled,false);assert.equal(closed.trades.length,1);assert.equal(closed.trades[0].reason,reason);
    assert.ok(closed.sleeves.every(s=>!s.position));assert.equal(closed.activeDecisions.length,0);
    assert.ok(Math.abs(closed.fees-closed.trades[0].fees)<1e-10);assert.ok(closed.fees>original.fees);
    const balance=closed.sleeves.reduce((sum,s)=>sum+s.cash,0);
    assert.ok(Math.abs(balance-100-closed.trades[0].pnl)<1e-10);assert.ok(balance>=50-1e-8);
    assert.match(r.querySelector('[data-momentum-positions]').innerHTML,/Inga öppna positioner/);
    assert.ok(r.querySelector('[data-momentum-balance]').innerHTML.includes(balance.toFixed(2)+' $'));
    assert.match(r.querySelector('[data-momentum-history]').innerHTML,new RegExp('<td>'+reason+'</td>'));
    runtime.at+=5000;runtime.price=100;await ui.refreshLive();
    assert.deepEqual(JSON.parse(s.getItem(key)),closed);
  }
});

test('fast risk polling saves funding while paused and cannot charge the same payment twice',async()=>{
  const s=storage(),r=root(),original=JSON.parse(s.getItem(key)),runtime={user:'one',active:true,at:start,price:100,fundingRate:.0001};
  runtime.grab=mockDerivatives(runtime);const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  runtime.at=(Math.floor(start/28800000)+1)*28800000;await ui.refreshLive();
  const saved=validateActiveAccount(JSON.parse(s.getItem(key))),paid=original.sleeves[0].position.units*100*runtime.fundingRate;
  assert.equal(saved.enabled,false);assert.equal(saved.trades.length,0);assert.equal(saved.activeDecisions.length,0);
  assert.ok(Math.abs(saved.funding-paid)<1e-10);assert.ok(Math.abs(saved.sleeves[0].position.funding-paid)<1e-10);
  assert.equal(saved.fees,original.fees);assert.equal(saved.sleeves[0].position.fundingThrough,runtime.at);
  runtime.at+=5000;await ui.refreshLive();
  const again=validateActiveAccount(JSON.parse(s.getItem(key)));
  assert.equal(again.funding,saved.funding);assert.equal(again.fees,saved.fees);assert.equal(again.trades.length,0);
  const expected=momentumLiveValue(again,{BTC:{price:100,mark:99.99,at:runtime.at}},runtime.at).balance.toFixed(2)+' $';
  assert.ok(r.querySelector('[data-momentum-positions]').innerHTML.includes(expected));
});

test('failed storage cannot display an unsaved exit; a later successful retry books it once',async()=>{
  const s=storage(),r=root(),runtime={user:'one',active:true,at:start,price:100};
  runtime.grab=mockDerivatives(runtime);const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  const before=s.getItem(key),save=s.setItem;s.setItem=()=>{throw Error('storage full');};
  runtime.at+=5000;runtime.price=97.9;await ui.refreshLive();
  assert.equal(s.getItem(key),before);assert.match(r.querySelector('[data-momentum-status]').textContent,/storage full/);
  assert.match(r.querySelector('[data-momentum-positions]').innerHTML,/data-position-balance/);
  assert.doesNotMatch(r.querySelector('[data-momentum-positions]').innerHTML,/Inga öppna positioner/);
  assert.doesNotMatch(r.querySelector('[data-momentum-history]').innerHTML,/<td>SL<\/td>/);
  s.setItem=save;runtime.at+=5000;await ui.refreshLive();
  const closed=validateActiveAccount(JSON.parse(s.getItem(key)));assert.equal(closed.trades.length,1);assert.equal(closed.trades[0].reason,'SL');
  assert.match(r.querySelector('[data-momentum-positions]').innerHTML,/Inga öppna positioner/);
  assert.doesNotMatch(r.querySelector('[data-momentum-status]').textContent,/storage full/);
});

test('failed quotes expire instead of freezing a live balance and recover on fresh data',async()=>{
  const s=storage(),r=root(),runtime={user:'one',active:true,at:start,fail:false};
  runtime.grab=mockDerivatives(runtime);
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
    const s=storage(),r=root(),before=s.getItem(key),runtime={user:'one',active:true,at:start,price:120};
    let release;const wait=new Promise(resolve=>release=resolve);
    const respond=mockDerivatives(runtime);runtime.grab=async url=>{await wait;return respond(url);};
    const ui=mountMomentum(r,options(s,runtime)),pending=ui.refreshLive();
    if(action==='reset')await ui.reset();
    else if(action==='logout')runtime.user=null;
    else if(action==='other-user')runtime.user='two';
    else s.setItem(key,JSON.stringify(newActiveAccount()));
    release();await pending;
    assert.doesNotMatch(r.querySelector('[data-momentum-positions]').innerHTML,/data-position-balance/);
    if(action==='logout')assert.equal(r.querySelector('[data-momentum-balance]').innerHTML,'');
    else assert.match(r.querySelector('[data-momentum-balance]').innerHTML,/100\.00/);
    if(action==='reset'||action==='other-tab-reset')assert.deepEqual(JSON.parse(s.getItem(key)),newActiveAccount());
    else assert.equal(s.getItem(key),before);
    assert.equal(s.getItem('riptide.momentum.20x.v1:two'),null);
  }
});

test('no live requests run while logged out, outside crypto, or without a position',async()=>{
  const s=storage(),r=root(),runtime={user:null,active:true,at:start,grab:()=>assert.fail('Unexpected request')};
  const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  runtime.user='one';runtime.active=false;await ui.refreshLive();
  runtime.active=true;s.setItem(key,JSON.stringify(newActiveAccount()));await ui.refreshLive();
});

test('live polling clears old decision history on user change and another tab reset',async()=>{
  const s=storage(),a=activeAccount(),r=root(),runtime={user:'one',active:true,at:start};
  runtime.grab=mockDerivatives(runtime);a.lastSignalAt=Math.floor(start/3600000)*3600000;
  a.activeDecisions=[{hour:a.lastSignalAt,at:start,symbol:'BTC',score:.1,action:'köp'}];
  s.setItem(key,JSON.stringify(validateActiveAccount(a)));
  const ui=mountMomentum(r,options(s,runtime));await ui.refreshLive();
  assert.match(r.querySelector('[data-momentum-history]').innerHTML,/BTC · köp/);
  runtime.user='two';await ui.refreshLive();
  assert.doesNotMatch(r.querySelector('[data-momentum-history]').innerHTML,/BTC · köp/);
  runtime.user='one';await ui.refreshLive();
  assert.match(r.querySelector('[data-momentum-history]').innerHTML,/BTC · köp/);
  s.setItem(key,JSON.stringify(newActiveAccount()));await ui.refreshLive();
  assert.doesNotMatch(r.querySelector('[data-momentum-history]').innerHTML,/BTC · köp/);
});
