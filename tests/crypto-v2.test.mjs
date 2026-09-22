import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,features,signal,Book,STEP,HOUR,FEE,geometry} from '../research/crypto-v2-engine.mjs';
const bar=(t=0,o=100,h=100.5,l=99.5,c=100)=>({t,o,h,l,c,v:10});
const s={symbol:'BTC',kind:'breakout',dir:1,stop:98,target:108,time:0,deadline:72*HOUR};
test('aggregation only includes complete aligned hours',()=>{
  const bars=Array.from({length:7},(_,i)=>bar(i*STEP));
  assert.equal(aggregate(bars,HOUR).length,1);
  assert.equal(aggregate(bars.slice(1),HOUR).length,0);
});
test('future candles cannot alter past features or signals; incomplete 4h ignored',()=>{
  const bars=Array.from({length:1400},(_,i)=>bar(i*STEP,100+i*.1,100.5+i*.1,99.5+i*.1,100+i*.1));
  const all=features(bars),prefix=features(bars.slice(0,1217));
  for(const [t,f] of prefix){assert.deepEqual(f,all.get(t));for(const v of ['breakout','pullback','range','regime'])assert.deepEqual(signal(v,'BTC',f),signal(v,'BTC',all.get(t)));}
  assert.equal(all.get(199*HOUR).trend,0);assert.equal(all.get(200*HOUR).trend,1);
});
test('sizing includes both fees and stop slippage; exposure capped',()=>{
  const b=new Book('breakout',.0005);b.enter([s],{BTC:bar()},0);
  const p=b.p,stopFill=98*(1-.0005),risk=p.units*(p.entry-stopFill+FEE*(p.entry+stopFill));
  assert.ok(Math.abs(risk-.5)<1e-10);assert.ok(p.units*p.entry<=200);
  assert.equal(geometry({...s,stop:99.9},100,.0005).valid,false);
});
test('entry is at next open; stale signal is rejected',()=>{
  const b=new Book('breakout',0);b.step([{...s,time:HOUR}],{BTC:bar()},0);
  assert.equal(b.p,null);b.step([{...s,time:HOUR}],{BTC:bar(HOUR,101,101.5,100.5,101)},HOUR);
  assert.equal(b.p.entry,101);assert.equal(b.p.time,HOUR);
});
test('ambiguous candle stops first; gap fills at open',()=>{
  const b=new Book('breakout',0);b.step([s],{BTC:bar(0,100,109,97,100)},0);
  assert.equal(b.trades[0].reason,'stop');assert.equal(b.trades[0].exit,98);
  const c=new Book('breakout',0);c.step([s],{BTC:bar()},0);c.step([],{BTC:bar(STEP,96,97,95,96)},STEP);
  assert.equal(c.trades[0].exit,96);
});
test('long/short funding, fees, P/L and account reconcile',()=>{
  for(const dir of [1,-1]){
    const b=new Book('pullback',.0005),sig={...s,kind:'pullback',dir,stop:100-dir*2,target:100+dir*8};
    b.step([sig],{BTC:bar()},0,{BTC:.001});assert.equal(b.p.funding,0);
    const units=b.p.units,entry=b.p.entry;b.step([],{BTC:bar(STEP)},STEP,{BTC:.001});
    b.close(100+dir*3,2*STEP,'test');const t=b.trades[0],exit=(100+dir*3)*(1-dir*.0005);
    const expected=units*(dir*(exit-entry)-FEE*(entry+exit)-dir*100*.001);
    assert.ok(Math.abs(t.pnl-expected)<1e-10);assert.ok(Math.abs(b.balance-100-expected)<1e-10);
  }
});
test('closed-hour trailing only affects subsequent bars; cooldown prevents immediate entry',()=>{
  const b=new Book('breakout',0);b.step([s],{BTC:bar(0,100,106,99,105)},0);
  b.trail({BTC:{b:{c:105},atr:.5}});assert.equal(b.p.stop,103.5);assert.equal(b.trades.length,0);
  b.step([],{BTC:bar(STEP,105,106,103,104)},STEP);assert.equal(b.trades[0].exit,103.5);
  b.step([{...s,time:2*STEP}],{BTC:bar(2*STEP)},2*STEP);assert.equal(b.p,null);
});
test('time exit uses current open, without looking at later intrabar stop',()=>{
  const b=new Book('breakout',0);b.step([{...s,deadline:STEP}],{BTC:bar()},0);
  b.step([],{BTC:bar(STEP,101,102,97,100)},STEP);assert.equal(b.trades[0].reason,'timeout');assert.equal(b.trades[0].exit,101);
});
test('fixed regime switches only at declared thresholds',()=>{
  const f={time:0,b:{c:105,l:104,h:106,v:20},prev:{c:104},atr:1,trend:1,high:104,low:95,volume:10,eff:.4};
  assert.equal(signal('regime','BTC',f).kind,'breakout');
  assert.equal(signal('regime','BTC',{...f,eff:.25}),null);
});
