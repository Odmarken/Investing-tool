import test from 'node:test';
import assert from 'node:assert/strict';
import { Portfolio,hourlyTrends,netRatio } from '../research/crypto-simulator.mjs';

const signal={id:'test',inst:'BTC',side:'long',sl:98,tp:106,fam:'trend',trend:1};
const candle=(o=100,h=101,l=99,c=100)=>({o,h,l,c,t:0});
test('net ratio includes both fees and adverse exit slippage',()=>{
  assert.ok(netRatio(100,99.9,100.2,1,0)<.44);
  assert.ok(netRatio(100,99.9,100.2,1,.0005)<netRatio(100,99.9,100.2,1,0));
});
test('future data cannot change historical hourly trend; unfinished hours do not count',()=>{
  const bars=Array.from({length:1200},(_,i)=>({t:i*300000,c:100+i*.1}));
  const all=hourlyTrends(bars),prefix=hourlyTrends(bars.slice(0,800));
  assert.deepEqual(all.slice(0,800),prefix);
  assert.equal(all[598],0);
  assert.equal(all[599],1);
  const changed=bars.slice(0,610).map((b,i)=>i===609?{...b,c:1}:b);
  assert.equal(hourlyTrends(changed).at(-1),1);
});
test('no trade before signal; simultaneous stop and target conservatively stops out',()=>{
  const b=new Portfolio('current',.0005,'risk1','test');
  b.step([],{BTC:candle()},0,{},{});
  assert.equal(b.position,null);
  b.step([signal],{BTC:candle(100,107,97,101)},300000,{},{});
  assert.equal(b.trades[0].reason,'stop');
  assert.ok(b.trades[0].pnl< -1);
  assert.equal(b.trades[0].opened,300000);
});
test('gap through stop executes at the worse open, not the stop level',()=>{
  const b=new Portfolio('current',0,'risk1','test');
  b.step([signal],{BTC:candle()},0,{},{});
  b.step([],{BTC:candle(97,97.5,96,97)},300000,{},{});
  assert.equal(b.trades[0].exits[0].price,97);
});
test('net filters reject small gross wins and reject gaps that destroy geometry',()=>{
  const b=new Portfolio('net',.0005,'risk1','test');
  b.step([{...signal,sl:99.9,tp:100.2}],{BTC:candle()},0,{},{});
  assert.equal(b.position,null);
  b.step([signal],{BTC:candle(107,108,106,107)},300000,{},{});
  assert.equal(b.position,null);
});
test('funding is paid only by a position held at the funding timestamp',()=>{
  const b=new Portfolio('current',0,'risk1','test');
  b.step([signal],{BTC:candle()},0,{BTC:.001},{});
  assert.equal(b.position.funding,0);
  b.step([],{BTC:candle()},300000,{BTC:.001},{});
  assert.equal(b.position.funding,.05);
});
test('runner stop computed from a bar applies only on the next bar',()=>{
  const b=new Portfolio('pullback-runner',0,'risk1','test');
  b.step([signal],{BTC:candle(100,105,99,104)},0,{}, {BTC:1});
  assert.ok(b.position);
  assert.equal(b.position.left,.5);
  assert.equal(b.position.stop,103);
  b.step([],{BTC:candle(104,104.5,102,103)},300000,{}, {BTC:1});
  assert.equal(b.position,null);
  assert.equal(b.trades[0].exits.length,2);
  assert.equal(b.trades[0].exits[1].price,103);
});

test('long and short P/L reconcile entry fee, exit fee and funding exactly',()=>{
  for(const dir of [1,-1]) {
    const b=new Portfolio('current',0,'risk1','test');
    const s={...signal,side:dir===1?'long':'short',sl:100-dir*2,tp:100+dir*6};
    b.step([s],{BTC:candle()},0,{},{});
    b.step([],{BTC:candle()},300000,{BTC:.001},{});
    b.finish({...candle(),c:100+dir*4,t:300000},'period-end');
    const expected=.5*(4-.00055*(200+dir*4))-dir*.05;
    assert.ok(Math.abs(b.trades[0].pnl-expected)<1e-10);
    assert.ok(Math.abs(b.balance-(100+expected))<1e-10);
  }
});

test('all-saldo liquidation ends the account, while normal sizing isolates only posted margin',()=>{
  for(const size of ['risk1','all20']) {
    const b=new Portfolio('current',0,size,'test');
    b.step([signal],{BTC:candle()},0,{},{});
    b.step([],{BTC:candle(94,95,90,94)},300000,{},{});
    assert.equal(b.trades[0].reason,'liquidation');
    assert.equal(b.balance,size==='risk1'?97.5:0);
    assert.equal(b.halted,size==='all20');
  }
});
