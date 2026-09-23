import test from 'node:test';
import assert from 'node:assert/strict';
import {HOUR,DAY,slidingExtrema,donchianSides,ensembleSignal,dailyCloses,dailyVol,dayIndexAtBar,simulateDesk,simulatePulse12,firmMetrics,strategySignal} from '../research/floor-trend-core.mjs';

const T0=Date.parse('2024-01-01T00:00:00Z');
const flatBars=(n,price=100,t0=T0)=>Array.from({length:n},(_,i)=>({t:t0+i*HOUR,o:price,h:price,l:price,c:price,v:1}));
const desk=(bars,funding=[])=>{const days=dailyCloses(bars);return {bars,funding,days,vol:dailyVol(days),dayAt:dayIndexAtBar(bars,days)};};

test('sliding extrema match a naive window scan',()=>{
  let x=1;const values=Float64Array.from({length:500},()=>(x=(x*16807)%2147483647)/2147483647);
  for(const n of [1,3,17,120]){
    const {mx,mn}=slidingExtrema(values,n);
    values.forEach((_,k)=>{const w=values.slice(Math.max(0,k-n+1),k+1);assert.equal(mx[k],Math.max(...w));assert.equal(mn[k],Math.min(...w));});
  }
});

test('a Donchian horizon enters above the previous channel and exits below the trailing midpoint',()=>{
  const closes=Float64Array.from([10,10,10,10,11,12,13,12,11.4,11.2]);
  // n=4: close 11 at k=4 breaks max(10,10,10,10). Mid of [10,10,10,11] is 10.5,
  // then trails to 11 (k=5), 11.5 (k=6) and stays; 11.4 < 11.5 exits at k=8.
  assert.deepEqual([...donchianSides(closes,4)],[0,0,0,0,1,1,1,1,0,0]);
  const down=Float64Array.from([10,10,10,10,9,8,9.2,9.6]);
  assert.deepEqual([...donchianSides(down,4)],[0,0,0,0,0,0,0,0]);
  // Short mid after k=4: [10,10,10,9]=9.5, k=5: min(9.5,9)=9, 9.2 > 9 exits at k=6.
  assert.deepEqual([...donchianSides(down,4,true)],[0,0,0,0,-1,-1,0,0]);
});

test('ensemble signals never read later closes',()=>{
  let x=7;const closes=Float64Array.from({length:3000},(_,i)=>100*Math.exp(Math.sin(i/90)+((x=(x*48271)%2147483647)/2147483647-.5)*.05));
  const full=ensembleSignal(closes,[5,20,60,250],true);
  for(const k of [300,1200,2999]){
    const cut=ensembleSignal(closes.slice(0,k+1),[5,20,60,250],true);
    assert.equal(cut[k],full[k]);
    const changed=Float64Array.from(closes);for(let j=k+1;j<changed.length;j++)changed[j]*=j%2?3:.2;
    assert.equal(ensembleSignal(changed,[5,20,60,250],true)[k],full[k]);
  }
});

test('the desk ledger charges fees, slippage and funding exactly once',()=>{
  const bars=flatBars(24*40),start=T0+35*DAY,end=start+2*DAY;
  const funding=[{t:start+8*HOUR,rate:.001},{t:start+16*HOUR,rate:-.0005}];
  const d=desk(bars,funding),signal=new Float64Array(bars.length).fill(NaN);
  signal[(start-T0)/HOUR-1]=1;
  const r=simulateDesk('BTC',d,signal,{start,end,fixedExposure:1});
  // Buy 1x at 100.05 with a 0.055 % fee, then pay 0.1 % and receive 0.05 % funding at 100.
  const units=100/100,paid=units*100.05,fee=units*100.05*.00055;
  assert.equal(r.orders,1);
  assert.ok(Math.abs(r.fees-fee)<1e-12);
  assert.ok(Math.abs(r.funding-(units*100*.001-units*100*.0005))<1e-12);
  const expected=100-paid-fee-r.funding+units*100-units*100*(.00055+.0005);
  assert.ok(Math.abs(r.final-expected)<1e-9,r.final+' vs '+expected);
});

test('a short desk is liquidated on a spike and stays out afterwards',()=>{
  const bars=flatBars(24*40),start=T0+35*DAY,end=start+3*DAY,i=(start-T0)/HOUR;
  bars[i+5]={...bars[i+5],h:260};
  const d=desk(bars),signal=new Float64Array(bars.length).fill(NaN);signal[i-1]=-1;signal[i+10]=1;
  const r=simulateDesk('BTC',d,signal,{start,end,fixedExposure:1});
  assert.equal(r.liquidations,1);assert.equal(r.final,0);assert.equal(r.orders,1);
});

test('vol-targeted exposure follows the 25 % target and the leverage cap',()=>{
  // Alternating +-2 % daily closes: about 38 % annualised volatility.
  const bars=[];let p=100;
  for(let dd=0;dd<120;dd++){p*=dd%2?1.02:1/1.02;for(let h=0;h<24;h++)bars.push({t:T0+(dd*24+h)*HOUR,o:p,h:p,l:p,c:p,v:1});}
  const d=desk(bars),signal=new Float64Array(bars.length).fill(NaN),start=T0+100*DAY,i=(start-T0)/HOUR;
  signal[i-1]=1;
  const r=simulateDesk('BTC',d,signal,{start,end:start+DAY});
  const v=d.vol[d.dayAt[i-1]];assert.ok(v>.3&&v<.5);
  // Units are sized at the decision close and filled at the next open.
  assert.ok(Math.abs(r.avgExposure-.25/v*bars[i].o/bars[i-1].c)<.002);
  const capped=simulateDesk('BTC',d,signal,{start,end:start+DAY,sizing:{volTarget:2,maxLeverage:1.5,volDays:90,minVolDays:30,band:.25,maintenance:.01}});
  assert.ok(Math.abs(capped.peakExposure-1.5*bars[i].o/bars[i-1].c)<.005);
});

test('pulse12 reference exits at TP on a steady climb and respects the one-hour cooldown',()=>{
  const bars=[];let p=100;
  for(let i=0;i<24*10;i++){const o=p;p*=1.004;bars.push({t:T0+i*HOUR,o,h:p*1.001,l:o*.999,c:p,v:1});}
  const start=T0+5*DAY,r=simulatePulse12('BTC',{bars,funding:[]},{start,end:start+2*DAY});
  assert.ok(r.roundTrips>0);
  assert.ok(r.trades.filter(t=>!t.open).every(t=>['TP','SL','timeout'].includes(t.reason)));
  const closed=r.trades.filter(t=>!t.open);
  for(let k=1;k<r.trades.length;k++)assert.ok(r.trades[k].opened>=closed[k-1].closed+HOUR-1);
});

test('firm metrics sum desks and measure drawdown on hourly equity',()=>{
  const a={coin:'A',equity:Float64Array.from([100,120,90,110]),roundTrips:1,orders:2,fees:0,funding:0,liquidations:0,avgExposure:1,timeInMarket:1,barsIn:4,barsShort:0,final:110};
  const b={...a,coin:'B',equity:Float64Array.from([100,100,100,100]),final:100,timeInMarket:0,barsIn:0};
  const m=firmMetrics([a,b],T0,200);
  assert.equal(m.final,210);assert.ok(Math.abs(m.maxDD-(1-190/220))<1e-12);
});

test('weekly momentum decides on Mondays only',()=>{
  const bars=flatBars(24*80).map((b,i)=>({...b,c:100+i*.01,h:100+i*.01}));
  const days=dailyCloses(bars),s=strategySignal('tsm3-w-L',bars,days);
  bars.forEach((b,i)=>{if(Number.isFinite(s[i]))assert.equal(new Date(b.t+HOUR).getUTCDay(),1);});
  assert.ok([...s].some(v=>v===1));
});
