import test from 'node:test';
import assert from 'node:assert/strict';
import {CANDIDATES,MIN_STOP,prepareDay,entryAt,trailAt,simulateDay,tradeStats} from '../research/floor-day-core.mjs';
import {slidingExtrema,HOUR,DAY} from '../research/floor-trend-core.mjs';
import {CONTRACTS} from '../bybit-contracts.js';

const T0=Date.parse('2024-01-01T00:00:00Z');
// Hand-built desk series: flat at 100 for `flat` hours, then the given closes.
function desk(closes,{count=9,wick=.002}={}){
  const bars=closes.map((c,i)=>{const o=i?closes[i-1]:c;return {t:T0+i*HOUR,o,h:Math.max(o,c)*(1+wick),l:Math.min(o,c)*(1-wick),c};});
  const cl=Float64Array.from(closes),channels={};
  for(const n of [24,48]){const {mx,mn}=slidingExtrema(cl,n);channels[n]={mx,mn};}
  const d=prepareDay({bars,funding:[]});
  return {...d,count:new Int8Array(bars.length).fill(count),channels};
}
const contract=symbol=>({symbol,contract:CONTRACTS[symbol],at:0,min:1,max:100,step:.01,tiers:[{id:1,cap:1e6,max:100,maintenance:.005,deduction:0}]});

test('a 24-hour breakout needs a close above the previous 24 closes and the trend filter',()=>{
  const closes=[...Array(120).fill(100),103];
  const d=desk(closes),i=closes.length-1;
  const e=entryAt('b24-f-72',d,i,{});
  assert.ok(e);assert.equal(e.reference,103);assert.equal(e.maxHoldMs,72*HOUR);
  const mid=(d.channels[24].mx[i]+d.channels[24].mn[i])/2;
  assert.equal(e.stop,Math.min(mid,103*(1-MIN_STOP)));
  assert.equal(entryAt('b24-f-72',{...d,count:new Int8Array(closes.length).fill(4)},i,{}),null,'filter needs 5 of 9');
  assert.ok(entryAt('b24-n-72',{...d,count:new Int8Array(closes.length).fill(0)},i,{}),'the control ignores the filter');
  assert.equal(entryAt('b24-f-72',d,i-1,{}),null);
  // Changing later closes never changes an earlier decision.
  const later=desk([...closes,50,40,200]);assert.deepEqual(entryAt('b24-f-72',later,i,{}),e);
  assert.equal(trailAt('b24-f-72',d,i,e.stop-5),Math.max(e.stop-5,mid));assert.equal(trailAt('vb-f-1d',d,i,90),90);
});

test('research sizing risks 1 % at the stop, fills the stop order and trails upward',()=>{
  // Flat, then a breakout, a climb, and a drop through the trailed stop.
  const closes=[...Array(120).fill(100),102,103,104,105,106,107,108,104,100];
  const d=desk(closes),start=T0+100*HOUR,end=T0+closes.length*HOUR;
  const r=simulateDay('BTC',d,'b24-f-72',{start,end});
  const t=r.trades[0];
  assert.equal(t.opened,T0+121*HOUR,'entry on the open after the breakout close');
  assert.ok(Math.abs(t.riskPct-.01)<1e-9);
  assert.equal(t.reason,'stop');assert.ok(t.pnl>0,'the trailed stop locked in a gain');
  assert.equal(r.roundTrips,r.trades.filter(x=>x.reason!=='open').length);
});

test('the time limit closes at the first open after the maximum hold',()=>{
  const closes=[...Array(120).fill(100),102,...Array(40).fill(0).map((_,i)=>102.5+i*.05)];
  const d=desk(closes,{wick:0}),start=T0+100*HOUR,end=T0+closes.length*HOUR;
  const r=simulateDay('ETH',d,'b24-f-24',{start,end});
  const t=r.trades[0];assert.equal(t.reason,'time');assert.equal(t.closed,t.opened+24*HOUR);
});

test('volatility breakout enters once per UTC day and exits at the next day open',()=>{
  // Three flat days with a 2-point range, then a day that rallies all day.
  const closes=[];for(let h=0;h<96;h++)closes.push(100+(h%2?1:-1));for(let h=0;h<24;h++)closes.push(100+h*.3);for(let h=0;h<24;h++)closes.push(107+Math.sin(h));
  const d=desk(closes);
  assert.ok(Number.isFinite(d.prevRange[100]));assert.equal(d.dayOpen[100],d.bars[96].o);
  const r=simulateDay('SOL',d,'vb-f-1d',{start:T0+96*HOUR,end:T0+closes.length*HOUR});
  const rally=r.trades.filter(t=>t.opened>=T0+96*HOUR&&t.opened<T0+120*HOUR);
  assert.equal(rally.length,1);assert.equal(rally[0].closed,T0+120*HOUR);assert.equal(rally[0].reason,'time');
});

test('the old Bybit rules use the old sizing function and a liquidation only takes the isolated margin',()=>{
  const closes=[...Array(120).fill(100),102,103,104];
  const d=desk(closes),n=closes.length;
  // Gap far below the stop and the liquidation price on the next open.
  d.bars.push({t:T0+n*HOUR,o:60,h:61,l:59,c:60});d.closes=Float64Array.from(d.bars,b=>b.c);
  d.count=new Int8Array(d.bars.length).fill(9);
  const r=simulateDay('BTC',d,'b24-f-72',{start:T0+100*HOUR,end:T0+(n+1)*HOUR,mode:'bybit',contracts:{BTC:contract('BTC')}});
  const t=r.trades[0];
  assert.ok(t.leverage>1&&t.leverage<=100);assert.ok(t.riskPct<=.5+1e-9);
  assert.equal(t.reason,'liquidation');
  assert.ok(r.final>=50-1e-6,'free cash outside the isolated margin survives: '+r.final);
  const stats=tradeStats([r]);assert.equal(stats.reasons.liquidation,1);assert.ok(stats.leverage.max<=100);
});

test('every candidate is declared with a hold of at most three days',()=>{
  for(const [name,c] of Object.entries(CANDIDATES))assert.ok(c.kind==='vb'||c.maxHold<=72,name);
  assert.equal(DAY,24*HOUR);
});
