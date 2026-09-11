import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateLeveraged} from '../research/crypto-momentum-20x-core.mjs';
import {LEVERAGE,openLeveraged,liquidationPrice,closeLeveraged} from '../crypto-leverage.js';
const day=86400000,step=900000,from=Date.parse('2025-01-06T00:00:00Z'),to=from+8*day;
function data(){
  return Object.fromEntries(['BTC','ETH','SOL'].map(s=>[s,{
    daily:Array.from({length:100},(_,i)=>({t:from+(i-80)*day,c:100+i})),
    bars:Array.from({length:8*day/step},(_,i)=>({t:from+i*step,o:100,h:101,l:99,c:100})),
    marks:Array.from({length:8*day/step},(_,i)=>({t:from+i*step,o:100,h:101,l:99,c:100})),
    funding:[],
  }]));
}
test('20x entry reserves margin and fee within available capital',()=>{
  const p=openLeveraged(100,100,from);
  assert.ok(Math.abs(p.units*p.entry/20+p.fee-100)<1e-10);
  assert.ok(liquidationPrice(p)>95&&liquidationPrice(p)<97);
  const closed=closeLeveraged(p,100,from+step);
  assert.ok(closed.cash<100);assert.ok(closed.cash>95);
});
test('a mark-price low can liquidate 20x while 1x survives identical last-trade prices',()=>{
  const d=data();for(const s of Object.values(d))s.marks[2].l=94;
  const high=simulateLeveraged(d,{from,to,leverage:20}),low=simulateLeveraged(d,{from,to,leverage:1});
  assert.equal(high.balance,0);assert.equal(high.liquidations,3);assert.equal(high.n,3);
  assert.ok(low.balance>99);assert.equal(low.liquidations,0);
});
test('funding after entry is charged by direction and no funding is charged on entry timestamp',()=>{
  const d=data();for(const s of Object.values(d))s.funding=[{t:from,rate:.5},{t:from+8*3600000,rate:-.001}];
  const b=simulateLeveraged(d,{from,to});
  assert.ok(b.funding<0);assert.equal(b.liquidations,0);
  assert.ok(Math.abs(b.funding+openLeveraged(100,100,from).units*100*.001)<1e-10);
});
test('a weekly exit precedes a later low in the same candle',()=>{
  const d=data();
  for(const s of Object.values(d)){
    s.daily.find(b=>b.t===from+6*day).c=50;
    s.marks[7*day/step].l=50;
  }
  const b=simulateLeveraged(d,{from,to});
  assert.equal(b.liquidations,0);assert.equal(b.n,3);
  assert.ok(b.trades.every(t=>t.reason==='signal'&&t.at===from+7*day));
});
