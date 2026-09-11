import test from 'node:test';
import assert from 'node:assert/strict';
import {momentum,choice,simulate,DAY} from '../research/crypto-slow-core.mjs';
const start=Date.parse('2023-01-02T00:00:00Z');
const bars=Array.from({length:200},(_,i)=>({t:start+(i-100)*DAY,o:100+i,h:101+i,l:99+i,c:100+i,v:1}));

test('weekly decision ignores decision-day close and all future observations',()=>{
  const changed=bars.map((b,i)=>i>=100?{...b,c:.01,h:99999}:b);
  assert.equal(momentum(bars,100,28),momentum(changed,100,28));
  assert.deepEqual(choice('momentum28',{BTC:bars},100),['BTC']);
  assert.deepEqual(choice('rotation28',{BTC:bars,ETH:changed},100),['BTC']);
});

test('holding an unchanged position incurs only entry and exit costs',()=>{
  const r=simulate('momentum28',{BTC:bars},start,start+14*DAY);
  assert.equal(r.n,1);assert.equal(r.trades[0].opened,start);assert.equal(r.trades[0].closed,start+14*DAY);
  const expected=100/(200*1.0005*1.001)*(213*.9995*.999);
  assert.ok(Math.abs(r.balance-expected)<1e-10);
  assert.ok(Math.abs(100+r.trades[0].pnl-r.balance)<1e-10);
  assert.equal(r.daily.length,14);
});

test('negative momentum stays in cash; rotation respects available capital',()=>{
  const down=bars.map((b,i)=>({...b,o:300-i,h:301-i,l:299-i,c:300-i}));
  const cash=simulate('momentum28',{BTC:down},start,start+14*DAY);
  assert.equal(cash.n,0);assert.equal(cash.balance,100);assert.equal(cash.maxDDPct,0);
  const rotation=simulate('rotation28',{BTC:bars,ETH:down},start,start+14*DAY);
  assert.equal(rotation.n,1);assert.equal(rotation.trades[0].symbol,'BTC');
  assert.ok(rotation.exposurePct<=100.000001);
});
