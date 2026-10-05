import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DEV_END,simulate,metricsOf,forecastErrors,walkForward,walkForwardSteps} from '../forecast-backtest.js';
import {ACCOUNT,newForecastAccount,openPosition,settlePosition,validateForecastAccount,tradeReasons} from '../forecast-account.js';
import {TF,SIGNAL_PARAMS as P,FORECAST_PARAMS as FP,MODEL,evaluateBar,requiredLookback,forecastAt,forecastFeatures} from '../forecast-model.js';
import {dataStatus} from '../forecast-market.js';
import {CONTRACTS,isolatedLevel} from '../bybit-contracts.js';

const HOUR=3600000,M5=300000,FEE=ACCOUNT.fee,SLIP=ACCOUNT.slip;
// A Monday, so every higher-timeframe bucket starts with the data.
const T0=Date.UTC(2024,0,1);
// When Bybit's limits were read: long after the candles, as in a real backtest.
const AT=Date.UTC(2026,9,4,12);
const SINGLE=[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}];
const limits=(symbol='BTC',{at=AT,tiers=SINGLE,max=150}={})=>({symbol,contract:CONTRACTS[symbol],at,min:1,max,step:.01,tiers:tiers.map(t=>({...t}))});
const contractsFor=symbols=>Object.fromEntries(symbols.map(s=>[s,limits(s)]));
const near=(a,b,eps=1e-9,msg='')=>assert.ok(Math.abs(a-b)<=eps*Math.max(1,Math.abs(a),Math.abs(b)),`${msg} ${a} vs ${b}`);
const ix=(bars,t)=>bars.findIndex(b=>b.t===t);
const sum=xs=>xs.reduce((a,b)=>a+b,0);

function rng(seed){let x=seed;return ()=>(x=(x*48271)%2147483647)/2147483647;}
// The model tests' constructed trend: about +1 % then -0,6 % per bar, small wicks, steady volume except
// 2,5x spikes. With a spike at bar 350 the rules give exactly one signal there (long; sign -1 mirrors it short).
function zigzag(n,{sign=1,spikes=[],seed=3,tf='1h',t0=T0}={}){
  const r=rng(seed),ms=TF[tf].ms,out=[];let x=0;
  for(let i=0;i<n;i++){
    const s=sign,o=x;
    x+=s*(i%2===0?.010+.002*(r()-.5):-.006+.002*(r()-.5));
    const w1=.0005+.001*r(),w2=.0005+.001*r(),h=Math.max(o,x)+(s>0?w1:w2),l=Math.min(o,x)-(s>0?w2:w1);
    const v=spikes.includes(i)?250:100*(1+.04*(r()-.5));
    out.push({t:t0+i*ms,o:100*Math.exp(o),h:100*Math.exp(h),l:100*Math.exp(l),c:100*Math.exp(x),v});
  }
  return out;
}
// A random walk with steady volatility (normal steps), wicks and volume.
function walk(n,{seed=7,tf='1h',t0=T0,drift=0,vol=.006}={}){
  const r=rng(seed),ms=TF[tf].ms,bars=[],normal=()=>Math.sqrt(-2*Math.log(r()))*Math.cos(2*Math.PI*r());
  let c=100;
  for(let i=0;i<n;i++){
    const o=c,d=typeof drift==='function'?drift(i):drift;c=o*Math.exp(d+vol*normal());
    bars.push({t:t0+i*ms,o,h:Math.max(o,c)*(1+vol*.4*r()),l:Math.min(o,c)*(1-vol*.4*r()),c,v:100*(.5+r())});
  }
  return bars;
}

// A real signal from the model's rules at S; the candles after it are `rows` ([o,h,l,c] as multiples of
// the signal close), so everything after the signal is known exactly. The quiet rows stay inside the stop
// and the target; a row meant to reach one is built from levels(), so it holds for any frozen stop and target.
const S=350,QUIET=[1.003,1.004,1.002,1.003],QUIET_SHORT=[.997,.998,.996,.997];
function scenario(rows,{sign=1}={}){
  const z=zigzag(S+1,{sign,spikes:[S]}),e=evaluateBar(z,S,{tf:'1h'}),c=z[S].c;
  assert.equal(e.side,sign>0?'long':'short');
  return {bars:[...z,...rows.map(([o,h,l,cl],k)=>({t:z[S].t+(k+1)*HOUR,o:o*c,h:h*c,l:l*c,c:cl*c,v:90}))],e,c};
}
// The scenario signal's stop and target as multiples of its close (the same for every scenario of a side).
function levels(sign=1){const {e,c}=scenario([],{sign});return {sl:e.sl/c,tp:e.tp/c};}
const quiet=(n,row=QUIET)=>Array.from({length:n},()=>row);
const run=(series,opts={})=>simulate({tf:'1h',contracts:contractsFor(Object.keys(series)),...opts,settings:{leverage:10,...opts.settings},series});
const one=(bars,opts={})=>run({BTC:{bars,funding:null}},opts);
const signalId=(symbol,tf,t)=>`s|backtest|${symbol}|${tf}|${t}|${MODEL.signal}`;

test('a signal fills at the next candle\'s open with slippage, never at the signal candle\'s close',()=>{
  const {bars,e,c}=scenario(quiet(25)),r=one(bars),[t]=r.trades;
  assert.equal(r.trades.length,1);
  assert.equal(t.signalAt,bars[S].t);assert.equal(t.openedAt,bars[S+1].t);
  assert.equal(t.entry,bars[S+1].o*(1+SLIP));
  assert.notEqual(bars[S+1].o,c);assert.notEqual(t.entry,c*(1+SLIP));
  assert.deepEqual([t.sl,t.tp,t.side,t.symbol,t.tf,t.leverage],[e.sl,e.tp,'long','BTC','1h',10]);
  assert.deepEqual(r.decisions,[{id:signalId('BTC','1h',bars[S].t),symbol:'BTC',t:bars[S].t,side:'long',entry:e.entry,sl:e.sl,tp:e.tp,trade:t.id,reason:''}]);
  // Nothing touched the stop or the target: the time stop closes it at the open maxHold candles after the signal.
  assert.equal(t.reason,'tid');assert.equal(t.closedAt,bars[S+1+P.maxHold].t);assert.equal(t.exit,bars[S+1+P.maxHold].o*(1-SLIP));
  // The account's exact round trip: 10x on 25 % of equity, both fees, slippage both ways.
  const fill=t.entry,units=250/fill,closeFee=units*t.exit*FEE;
  near(t.units,units);near(t.margin,25);near(t.fees,250*FEE+closeFee);near(t.pnl,(t.exit-fill)*units-250*FEE-closeFee);
  near(r.ledger.cash,100+t.pnl);near(r.metrics.net,t.pnl);
  // An open beyond the target or the stop is no entry: the signal's edge is gone.
  const {sl,tp}=levels();
  for(const open of [tp+.003,sl-.003]){
    const gone=one(scenario([[open,open+.001,open-.001,open],...quiet(5)]).bars);
    assert.deepEqual(gone.trades,[]);assert.equal(gone.decisions[0].reason,'Priset ligger redan utanför stopp och mål');
    assert.deepEqual(gone.skipped,{'Priset ligger redan utanför stopp och mål':1});
  }
  // Too little reward left for the risk at the open: three quarters of the way from the stop to the target.
  const late=sl+.75*(tp-sl);
  assert.equal(one(scenario([[late,late+.0005,late-.0005,late],...quiet(5)]).bars).decisions[0].reason,'Kvarvarande vinst/risk är under 1');
});

test('inside one candle the stop comes before the target, and an open beyond the stop fills at the open',()=>{
  const {sl,tp}=levels(),short=levels(-1);
  const both=scenario([QUIET,QUIET,[1.003,tp+.005,sl-.005,1],...quiet(5)]),t=one(both.bars).trades[0];
  assert.deepEqual([t.reason,t.exit,t.closedAt],['stopp',both.e.sl*(1-SLIP),both.bars[S+3].t+HOUR]);
  const gap=scenario([QUIET,QUIET,[sl-.005,sl-.001,sl-.01,sl-.005],...quiet(5)]),g=one(gap.bars).trades[0];
  assert.deepEqual([g.reason,g.exit,g.closedAt],['stopp',gap.bars[S+3].o*(1-SLIP),gap.bars[S+3].t]);
  assert.ok(g.exit<gap.e.sl*(1-SLIP),'a gap costs more than the stop level');
  // The target alone fills at the target; an open beyond it also fills at the target, at the open.
  const hit=scenario([QUIET,QUIET,[1.01,tp+.005,1.005,1.01],...quiet(5)]),w=one(hit.bars).trades[0];
  assert.deepEqual([w.reason,w.exit,w.closedAt],['mål',hit.e.tp*(1-SLIP),hit.bars[S+3].t+HOUR]);
  const leap=scenario([QUIET,QUIET,[tp+.005,tp+.015,tp+.002,tp+.01],...quiet(5)]),l=one(leap.bars).trades[0];
  assert.deepEqual([l.reason,l.exit,l.closedAt],['mål',leap.e.tp*(1-SLIP),leap.bars[S+3].t]);
  assert.ok(w.pnl>0&&t.pnl<0);
  // Shorts mirror it: the high is the adverse side.
  const sh=scenario([QUIET_SHORT,QUIET_SHORT,[.997,short.sl+.005,short.tp-.005,1],...quiet(5,QUIET_SHORT)],{sign:-1}),s=one(sh.bars).trades[0];
  assert.deepEqual([s.side,s.reason,s.exit],['short','stopp',sh.e.sl*(1+SLIP)]);
});

test('liquidation is tested on the candle\'s worst price before the stop',()=>{
  // The second candle falls through the stop.
  const {sl}=levels(),{bars,e}=scenario([[1.003,1.004,1.0028,1.0035],[1.0035,1.004,sl-.005,sl],...quiet(3)]);
  const r=one(bars,{settings:{leverage:'max'}}),[t]=r.trades;
  // At Bybit's 150x the liquidation level sits between the entry and the stop.
  assert.equal(t.leverage,150);assert.ok(t.liq>e.sl&&t.liq<t.entry);
  near(t.liq,isolatedLevel('long',t.entry,t.margin+t.units*t.entry*FEE,t.units,FEE,SINGLE[0]));
  assert.deepEqual([t.reason,t.exit,t.closedAt],['likvidation',t.liq,bars[S+2].t+HOUR]);
  // The margin is gone, and only the opening fee was paid.
  near(t.fees,t.units*t.entry*FEE);near(t.pnl,-(t.margin+t.fees));near(r.ledger.cash,100+t.pnl);
  assert.equal(r.metrics.liquidations,1);
  // The same candle at 10x reaches the stop first, far above that leverage's liquidation level.
  const ten=one(bars).trades[0];
  assert.deepEqual([ten.reason,ten.exit],['stopp',e.sl*(1-SLIP)]);
  // An open beyond the liquidation level is a liquidation at the open.
  const gap=scenario([[1.003,1.004,1.0028,1.0035],[.99,.995,.985,.99],...quiet(3)]),g=one(gap.bars,{settings:{leverage:'max'}}).trades[0];
  assert.deepEqual([g.reason,g.exit,g.closedAt],['likvidation',gap.bars[S+2].o,gap.bars[S+2].t]);
});

test('an opposite signal closes at the next open and the new side opens there; one position per coin',()=>{
  const {bars,e}=scenario(quiet(30)),k=bars[S+4].c;
  const signals={BTC:[{t:bars[S].t,side:'long',entry:e.entry,sl:e.sl,tp:e.tp},
    {t:bars[S+2].t,side:'long',entry:bars[S+2].c,sl:bars[S+2].c*.98,tp:bars[S+2].c*1.04},
    {t:bars[S+4].t,side:'short',entry:k,sl:k*1.02,tp:k*.96}]};
  const r=one(bars,{signals}),[a,b]=r.trades;
  assert.equal(r.trades.length,2);
  assert.deepEqual([a.side,a.reason,a.closedAt,a.exit],['long','signal',bars[S+5].t,bars[S+5].o*(1-SLIP)]);
  assert.deepEqual([b.side,b.openedAt,b.entry,b.signalAt],['short',bars[S+5].t,bars[S+5].o*(1-SLIP),bars[S+4].t]);
  // The short holds its own maxHold candles.
  assert.deepEqual([b.reason,b.closedAt],['tid',bars[S+5+P.maxHold].t]);
  assert.deepEqual(r.decisions.map(d=>d.reason),['','Det finns redan en position i paret','']);
  assert.deepEqual(r.skipped,{'Det finns redan en position i paret':1});
  // A position still open when the data ends closes at the last close.
  const end=one(bars.slice(0,S+12),{signals}).trades.at(-1);
  assert.deepEqual([end.reason,end.closedAt,end.exit],['slut',bars[S+11].t+HOUR,bars[S+11].c*(1+SLIP)]);
});

test('an opposite signal on data the live check refuses is stale: it neither closes nor reverses the position',()=>{
  const {bars,e}=scenario(quiet(30)),k=bars[S+3].c;
  const signals={BTC:[{t:bars[S].t,side:'long',entry:e.entry,sl:e.sl,tp:e.tp},{t:bars[S+3].t,side:'short',entry:k,sl:k*1.02,tp:k*.96}]};
  // On complete data the long closes at the next open and the short opens there.
  assert.deepEqual(one(bars,{signals}).trades.map(t=>[t.side,t.reason,t.closedAt]),[['long','signal',bars[S+4].t],['short','tid',bars[S+24].t]]);
  // The candles after the short signal are missing (it would act hours late), or one in its lookback is
  // (the live runner calls such data unreliable): the long runs on to its own time stop instead.
  for(const gone of [[S+4,S+5,S+6],[S+2]]){
    const r=one(bars.filter((_,j)=>!gone.includes(j)),{signals});
    assert.deepEqual(r.trades.map(t=>[t.side,t.reason,t.closedAt]),[['long','tid',bars[S+1+P.maxHold].t]],'gap at '+gone);
    assert.deepEqual(r.decisions.map(d=>d.reason),['','Lucka i datan — ingen ny affär'],'gap at '+gone);
  }
});

test('at most maxOpen positions across coins, filled in the fixed coin order',()=>{
  const {bars}=scenario(quiet(25));
  // Object order is not the coin order: XRP is listed first.
  const series=Object.fromEntries(['XRP','SOL','ETH','BTC'].map(s=>[s,{bars,funding:null}]));
  const r=run(series,{settings:{maxOpen:2}});
  assert.deepEqual(r.trades.map(t=>t.symbol).sort(),['BTC','ETH']);
  assert.ok(r.trades.every(t=>t.openedAt===bars[S+1].t));
  assert.deepEqual(r.decisions.map(d=>[d.symbol,d.reason]),[['BTC',''],['ETH',''],['SOL','Max antal öppna positioner är nått'],['XRP','Max antal öppna positioner är nått']]);
  // ETH is sized on realized equity: cash plus BTC's margin, i.e. 100 $ less BTC's opening fee.
  const [btc,eth]=['BTC','ETH'].map(s=>r.trades.find(t=>t.symbol===s));
  near(eth.margin,.25*(100-btc.units*btc.entry*FEE));
  assert.deepEqual(run(series,{settings:{maxOpen:3}}).trades.map(t=>t.symbol).sort(),['BTC','ETH','SOL']);
});

test('funding: a long pays a positive rate and a short receives it, at the open of the funding candle',()=>{
  const long=scenario(quiet(25)),short=scenario(quiet(25,QUIET_SHORT),{sign:-1});
  // At the entry open (not held yet), two at candle opens, one in the middle of a candle (charged at the next open).
  const events=b=>[{t:b[S+1].t,rate:.0003},{t:b[S+3].t,rate:.0001},{t:b[S+6].t,rate:-.0002},{t:b[S+8].t+HOUR/2,rate:.0002}];
  const plain=run({BTC:{bars:long.bars,funding:[]},ETH:{bars:short.bars,funding:[]}}).trades;
  const paid=run({BTC:{bars:long.bars,funding:events(long.bars)},ETH:{bars:short.bars,funding:events(short.bars)}});
  for(const [symbol,sym] of [['BTC',long],['ETH',short]]){
    const t=paid.trades.find(x=>x.symbol===symbol),base=plain.find(x=>x.symbol===symbol),dir=t.side==='long'?1:-1,b=sym.bars;
    const expected=dir*t.units*(b[S+3].o*.0001+b[S+6].o*-.0002+b[S+9].o*.0002);
    near(t.funding,expected,1e-12,symbol);
    // The same trade otherwise: funding comes out of the margin, so the result moves by exactly the funding.
    assert.deepEqual([t.entry,t.exit,t.units,t.reason,t.closedAt],[base.entry,base.exit,base.units,base.reason,base.closedAt]);
    near(t.pnl,base.pnl-t.funding,1e-12,symbol);near(t.margin,base.margin);
  }
  const btc=paid.trades.find(x=>x.symbol==='BTC'),eth=paid.trades.find(x=>x.symbol==='ETH');
  // Only a positive rate: the long pays (funding is a cost), the short is paid.
  const pos=b=>[{t:b[S+3].t,rate:.0001}];
  const once=run({BTC:{bars:long.bars,funding:pos(long.bars)},ETH:{bars:short.bars,funding:pos(short.bars)}}).trades;
  assert.ok(once.find(x=>x.symbol==='BTC').funding>0&&once.find(x=>x.symbol==='ETH').funding<0);
  near(paid.ledger.funding,btc.funding+eth.funding);
  assert.ok(paid.notes.includes('Funding mellan två candle-öppningar dras vid nästa öppning.'));
  assert.ok(!paid.notes.some(n=>/Fundinghistorik saknas/.test(n)));
  assert.ok(run({BTC:{bars:long.bars,funding:null}}).notes.includes('Fundinghistorik saknas för BTC — funding är inte medräknad.'));
});

test('funding inside the candle a position closes in is not charged, and the notes say so',()=>{
  const DAY=24*HOUR,pre=walk(500,{seed:3,tf:'1d',vol:.01}),i=pre.length-1,c=pre[i].c;
  const row=(k,[o,h,l,cl])=>({t:pre[i].t+k*DAY,o:o*c,h:h*c,l:l*c,c:cl*c,v:100});
  const bars=[...pre,row(1,[1,1.001,.95,.97]),...[2,3,4].map(k=>row(k,[.97,.975,.965,.97]))];
  const funding=[];for(let t=bars[0].t;t<=bars.at(-1).t+DAY;t+=8*HOUR)funding.push({t,rate:.001});
  const signals={BTC:[{t:pre[i].t,side:'long',entry:c,sl:c*.97,tp:c*1.06}]};
  const r=simulate({series:{BTC:{bars,funding}},tf:'1d',contracts:contractsFor(['BTC']),settings:{leverage:5},signals}),[t]=r.trades;
  // Stopped inside the entry day: its 08:00 and 16:00 funding fell inside that candle, before or after the stop.
  assert.deepEqual([t.reason,t.openedAt,t.closedAt,t.funding],['stopp',pre[i].t+DAY,pre[i].t+2*DAY,0]);
  assert.ok(r.notes.includes('Funding som infaller inne i den candle där en position stängs är inte medräknad.'));
  // On 1h candles every funding time is a candle open, so a stop inside a candle leaves nothing out.
  const {sl,tp}=levels(),h1=scenario([QUIET,QUIET,[1.003,tp+.005,sl-.005,1],...quiet(5)]).bars,f1=[];
  for(let x=h1[0].t;x<=h1.at(-1).t+HOUR;x+=8*HOUR)f1.push({t:x,rate:.001});
  const s=run({BTC:{bars:h1,funding:f1}});
  assert.equal(s.trades[0].reason,'stopp');assert.ok(!s.notes.some(n=>/inne i den candle/.test(n)));
});

// The live account's own functions on the same 5-minute candles: openPosition at the open after the signal,
// then settlePosition over the candles that follow (mark = last price here).
function viaAccount(bars,i,sig,{settings,funding=[]}){
  const s=bars[i+1],a=newForecastAccount(bars[0].t,{...settings,tf:'5m'});
  const signal={id:`s|u1|BTC|5m|${bars[i].t}|${MODEL.signal}`,symbol:'BTC',tf:'5m',side:sig.side,entry:sig.entry,sl:sig.sl,tp:sig.tp,barTime:bars[i].t,confirmedAt:bars[i].t+M5};
  const o=openPosition(a,{signal,symbol:'BTC',quote:{price:s.o,mark:s.o,at:s.t},contract:limits('BTC',{at:s.t}),now:s.t,tfMs:M5,dataReliable:true});
  assert.equal(o.opened,true,o.reason);
  const now=bars.at(-1).t+60000,later=bars.slice(i+1);
  // The entry candle's 1-minute candles: flat at its open, then its range in the last minute, as the backtest books it.
  const minutes=[0,1,2,3,4].map(k=>k<4?{t:s.t+k*60000,o:s.o,h:s.o,l:s.o,c:s.o}:{t:s.t+k*60000,o:s.o,h:s.h,l:s.l,c:s.c});
  const risk={price:bars.at(-1).c,mark:bars.at(-1).c,at:now,markBars:later,lastBars:later,minuteMarks:minutes,minuteLasts:minutes,
    funding:funding.filter(f=>f.t>s.t&&f.t<=now),fundingThrough:now,historyFrom:s.t};
  const settled=settlePosition(o.account,o.position.id,risk,now);
  assert.equal(settled.trades.length,1);
  return settled.trades[0];
}
test('the backtest books a trade exactly as the demo account does (sizing, fees, slippage, funding, liquidation)',()=>{
  const r=rng(9),pre=[];let c=100;
  for(let i=0;i<800;i++){const o=c;c=o*(1+(r()-.5)*.002);pre.push({t:T0+i*M5,o,h:Math.max(o,c)*1.0004,l:Math.min(o,c)*.9996,c,v:100});}
  const i=pre.length-1,base=pre[i].c,Q=[1.002,1.003,1.0018,1.002],QS=[.998,.9982,.997,.998];
  const build=rows=>[...pre,...rows.map(([o,h,l,cl],k)=>({t:pre[i].t+(k+1)*M5,o:o*base,h:h*base,l:l*base,c:cl*base,v:100}))];
  const long={side:'long',entry:base,sl:base*.985,tp:base*1.03},short={side:'short',entry:base,sl:base*1.015,tp:base*.97};
  // Rates that do not cancel on flat prices, so the funding really moves the margin and the liquidation level.
  const fund=bars=>[{t:bars[i+3].t,rate:.0001},{t:bars[i+10].t,rate:-.0003},{t:bars[i+12].t,rate:.0006}];
  const cases=[
    ['target',long,[Q,Q,Q,[1.01,1.035,1.005,1.03],...quiet(3,Q)],{leverage:10},'mål'],
    ['stop',long,[Q,Q,[1.002,1.004,.98,.99],...quiet(3,Q)],{leverage:10},'stopp'],
    ['gap through the stop',long,[Q,Q,[.98,.982,.978,.98],...quiet(3,Q)],{leverage:10},'stopp'],
    ['liquidation at 150x',long,[Q,Q,[1.002,1.003,.995,.999],...quiet(3,Q)],{leverage:'max'},'likvidation'],
    ['time stop with funding',long,quiet(26,Q),{leverage:20},'tid',true],
    ['short target with funding',short,[...quiet(14,QS),[.99,.992,.965,.97],...quiet(3,QS)],{leverage:5},'mål',true],
    ['short liquidated at an open beyond its level, after funding',short,[...quiet(12,QS),[.999,1.02,.995,1.01],...quiet(3,QS)],{leverage:'max',riskPct:.05},'likvidation',true]
  ];
  const keys=['side','entry','exit','units','margin','leverage','openedAt','closedAt','reason','pnl','fees','funding','equityAfter'];
  for(const [name,sig,rows,settings,reason,funded] of cases){
    const bars=build(rows),funding=funded?fund(bars):[];
    const live=viaAccount(bars,i,sig,{settings,funding});
    const bt=simulate({series:{BTC:{bars,funding}},tf:'5m',settings,contracts:{BTC:limits('BTC')},signals:{BTC:[{t:bars[i].t,...sig}]}}).trades;
    assert.equal(bt.length,1,name);assert.equal(live.reason,reason,name);
    for(const k of keys)typeof live[k]==='number'?near(bt[0][k],live[k],1e-12,name+' '+k):assert.equal(bt[0][k],live[k],name+' '+k);
    if(funded)assert.ok(Math.abs(live.funding)>1e-4,name+' funding '+live.funding);
  }
});

test('the ledger reconciles under the account\'s own validation, and the equity curve ends at the cash',()=>{
  const symbols=['BTC','ETH','SOL'],series={};
  symbols.forEach((s,k)=>{
    const bars=walk(3000,{seed:21+k,drift:i=>.0012*Math.sin(i/180)});
    const funding=[];for(let t=bars[0].t;t<=bars.at(-1).t;t+=8*HOUR)funding.push({t,rate:.0001*Math.cos(t/HOUR/50)});
    series[s]={bars,funding};
  });
  for(const settings of [{leverage:10,riskPct:.02},{leverage:'max'},{leverage:3,positionPct:.5,riskPct:.05,maxOpen:2}]){
    const r=run(series,{settings});
    assert.ok(r.trades.length>=10,'trades: '+r.trades.length);
    const a={version:ACCOUNT.version,createdAt:T0,start:100,cash:r.ledger.cash,settings:newForecastAccount(T0,settings).settings,positions:[],trades:r.trades,
      log:[],processed:{},fees:r.ledger.fees,funding:r.ledger.funding};
    assert.equal(validateForecastAccount(a),a);
    assert.ok(r.trades.every(t=>Object.hasOwn(tradeReasons,t.reason)&&t.closedAt>=t.openedAt&&t.openedAt>t.signalAt));
    near(r.equity.at(-1).v,r.ledger.cash);near(r.metrics.net,r.ledger.cash-100);
    // One position per coin at any time, and never more than maxOpen together.
    const max=newForecastAccount(T0,settings).settings.maxOpen;
    for(const t of r.trades){
      const open=r.trades.filter(x=>x.openedAt<=t.openedAt&&x.closedAt>t.openedAt);
      assert.ok(open.length<=max);assert.equal(new Set(open.map(x=>x.symbol)).size,open.length);
    }
  }
});

test('signals are the rules\' own on closed candles only: each equals evaluateBar on the history up to its close',()=>{
  const bars=walk(2200,{seed:5,drift:i=>.0015*Math.sin(i/150)}),r=one(bars),L=requiredLookback('1h');
  assert.ok(r.decisions.length>=5,'signals: '+r.decisions.length);
  for(const d of r.decisions){
    const i=ix(bars,d.t),e=evaluateBar(bars.slice(0,i+1),i,{tf:'1h'});
    assert.deepEqual([e.side,e.entry,e.sl,e.tp],[d.side,d.entry,d.sl,d.tp]);
  }
  const seen=new Set(r.decisions.map(d=>d.t));
  for(let i=L;i<bars.length;i+=37)if(!seen.has(bars[i].t))assert.equal(evaluateBar(bars.slice(0,i+1),i,{tf:'1h'}).side,null);
  // A candle that has not closed by serverTime is dropped before anything reads it.
  const last=bars.at(-1),cut=simulate({series:{BTC:{bars,funding:null}},tf:'1h',contracts:contractsFor(['BTC']),serverTime:last.t+HOUR-1});
  assert.equal(cut.to,bars.at(-2).t);assert.equal(cut.equity.at(-1).t,last.t);
  assert.ok(cut.trades.every(t=>t.closedAt<=last.t));
});

test('every timeframe trades only the rules\' own signals, from its own higher timeframe',()=>{
  for(const [tf,n] of [['5m',3000],['15m',1800],['4h',1800],['1d',1500]]){
    const bars=walk(n,{seed:17,tf,vol:tf==='1d'?.03:.006,drift:i=>(tf==='1d'?.006:.0015)*Math.sin(i/90)}),ms=TF[tf].ms;
    const r=simulate({series:{BTC:{bars,funding:null}},tf,contracts:contractsFor(['BTC']),settings:{leverage:5}});
    assert.ok(r.decisions.length>=10&&r.trades.length>=10,tf+': '+r.decisions.length+' signals');
    for(const d of r.decisions){
      const i=ix(bars,d.t);
      assert.ok(i>=requiredLookback(tf),tf);
      assert.deepEqual([d.side,d.sl,d.tp],(e=>[e.side,e.sl,e.tp])(evaluateBar(bars.slice(0,i+1),i,{tf})),tf);
    }
    assert.ok(r.trades.every(t=>t.openedAt===t.signalAt+ms&&ix(bars,t.openedAt)>0),tf);
    assert.equal(r.equity.length,bars.length+1,tf);
  }
});

test('a missing candle in the lookback or right after the signal blocks the entry, as the live data check does',()=>{
  const {bars,e}=scenario(quiet(25)),L=requiredLookback('1h'),signals={BTC:[{t:bars[S].t,side:'long',entry:e.entry,sl:e.sl,tp:e.tp}]};
  const drop=k=>bars.filter((_,j)=>j!==k);
  // A gap older than the lookback window does not matter.
  assert.equal(one(drop(S-L-5),{signals}).trades.length,1);
  for(const k of [S-L+5,S-100,S+1]){
    const r=one(drop(k),{signals});
    assert.deepEqual(r.trades,[],'gap at '+k);assert.equal(r.decisions[0].reason,'Lucka i datan — ingen ny affär');
  }
  assert.equal(one(bars.slice(S-200),{signals}).decisions[0].reason,'För kort historik — ingen ny affär');
  // Exactly the runner's check (forecast-runner.js decide): dataStatus over the need+1 closed candles up to the
  // signal, with the next candle forming. Right at the window's far edge and at the shortest history.
  const live=kept=>{
    const i=ix(kept,bars[S].t),now=kept[i+1].t+1000;
    return dataStatus({bars:kept.slice(0,i+1),forming:kept[i+1],serverTime:now,lastOk:now},now,'1h',{lookback:L+1}).reliable;
  };
  for(const back of [L-1,L,L+1,L+2]){
    const kept=bars.filter(b=>b.t!==bars[S].t-back*HOUR);
    assert.equal(one(kept,{signals}).trades.length,live(kept)?1:0,'missing '+back+' h before the signal');
  }
  assert.deepEqual([live(bars.slice(S-L)),live(bars.slice(S-L+1))],[true,false]);
  assert.equal(one(bars.slice(S-L),{signals}).trades.length,1);
  assert.equal(one(bars.slice(S-L+1),{signals}).decisions[0].reason,'För kort historik — ingen ny affär');
  const after=bars.at(-1).t+HOUR;
  assert.throws(()=>one(bars,{from:after,to:after+10*HOUR}),/Inga candles i perioden/);
  assert.throws(()=>one(bars,{from:after,to:bars[0].t}),/Ogiltig period/);
});

test('future poisoning: changing every candle after T changes no trade or forecast error decided before T',()=>{
  const symbols=['BTC','ETH'],make=k=>walk(2600,{seed:31+k,drift:i=>.0015*Math.sin(i/120)});
  const clean=Object.fromEntries(symbols.map((s,k)=>[s,{bars:make(k),funding:null}])),cut=2000,T=clean.BTC.bars[cut].t;
  const poison=b=>b.map((x,j)=>j<cut?x:{...x,o:x.o*1.3,h:x.h*1.6,l:x.l*.7,c:x.c*.8,v:x.v*20});
  const dirty=Object.fromEntries(symbols.map(s=>[s,{bars:poison(clean[s].bars),funding:null}]));
  for(const settings of [{leverage:10},{leverage:'max'}]){
    const a=run(clean,{settings}),b=run(dirty,{settings});
    const before=r=>r.trades.filter(t=>t.closedAt<=T);
    assert.ok(before(a).length>=5);
    assert.deepEqual(before(b),before(a));
    const opened=r=>r.trades.filter(t=>t.openedAt<T).map(t=>[t.id,t.entry,t.units,t.margin,t.leverage,t.sl,t.tp]);
    assert.deepEqual(opened(b),opened(a));
    const early=r=>r.decisions.filter(d=>d.t+HOUR<T);
    assert.deepEqual(early(b),early(a));
    assert.deepEqual(b.equity.filter(p=>p.t<=T),a.equity.filter(p=>p.t<=T));
    assert.notDeepEqual(b.decisions,a.decisions,'the poisoned future does change later signals');
  }
  // Forecasts whose whole horizon ended before T score the same; later ones see the change.
  const bars=clean.BTC.bars,bad=dirty.BTC.bars,F=forecastFeatures(bars);
  const cutoffs=[];for(let c=1600;c+20<cut;c+=4)cutoffs.push(c);
  assert.deepEqual(forecastErrors({bars:bad,tf:'1h',cutoffs}),forecastErrors({bars,tf:'1h',cutoffs,features:F}));
  const late=[cut-10,cut-6];
  assert.notDeepEqual(forecastErrors({bars:bad,tf:'1h',cutoffs:late}),forecastErrors({bars,tf:'1h',cutoffs:late}));
});

test('forecast errors: a random walk shows no skill and honest bands, a trend shows clear skill',()=>{
  const cutoffs=[];for(let c=1600;c<=2579;c+=4)cutoffs.push(c);
  const rw=forecastErrors({bars:walk(2600,{seed:7}),tf:'1h',cutoffs});
  assert.deepEqual(Object.keys(rw),['5','10','20']);
  for(const h of [5,10,20]){
    const e=rw[h];
    assert.equal(e.h,h);assert.equal(e.n,cutoffs.length);assert.equal(e.missing,0);
    assert.ok(e.skill>-.2&&e.skill<.1,`h${h} skill ${e.skill}`);
    near(e.skill,1-e.mae/e.naiveMae);
    assert.ok(e.cover80>=.6&&e.cover80<=.95,`h${h} cover80 ${e.cover80}`);
    assert.ok(e.cover50>=.35&&e.cover50<=.7,`h${h} cover50 ${e.cover50}`);
    assert.ok(e.cover50<e.cover80);
    assert.ok(e.dirHit>.35&&e.dirHit<.65,`h${h} direction ${e.dirHit}`);
    assert.ok(e.dirN>.9*e.n&&e.scenarioMae>0);
  }
  // A steady trend with a cycle and a little noise: the analogs carry the drift.
  const r=rng(11);let prev=100;
  const trend=Array.from({length:2600},(_,i)=>{const o=prev,c=100*Math.exp(.002*i+.002*(r()-.5)+.004*Math.sin(i/3));prev=c;return {t:T0+i*HOUR,o,h:Math.max(o,c)*1.001,l:Math.min(o,c)*.999,c,v:100};});
  const tr=forecastErrors({bars:trend,tf:'1h',cutoffs});
  for(const h of [5,10,20])assert.ok(tr[h].skill>.5&&tr[h].dirHit>.9,`trend h${h} skill ${tr[h].skill}`);
  // A cutoff without the real candle h later is counted as missing, never guessed.
  const end=forecastErrors({bars:trend,tf:'1h',cutoffs:[2590],horizons:[5,10,20]});
  assert.deepEqual([end[5].n,end[10].n,end[20].n,end[20].missing,end[20].mae],[1,0,0,1,null]);
  // The protocol's direction share counts every forecast whose median points up or down: a real close that
  // ends exactly unchanged is a miss, not left out.
  const c0=2000,base=trend[c0].c,still=trend.map((b,j)=>j===c0+5?{...b,c:base,h:Math.max(b.h,b.o,base),l:Math.min(b.l,b.o,base)}:b);
  const up=forecastErrors({bars:trend,tf:'1h',cutoffs:[c0],horizons:[5]})[5],flat=forecastErrors({bars:still,tf:'1h',cutoffs:[c0],horizons:[5]})[5];
  assert.deepEqual([up.dirN,up.dirHit,flat.n,flat.dirN,flat.dirHit,flat.naiveMae],[1,1,1,1,0,0]);
  // The default horizons stop at the model's own horizon.
  assert.deepEqual(Object.keys(forecastErrors({bars:trend,tf:'1h',cutoffs:[2000],params:{...FP,horizon:10}})),['5','10']);
  assert.throws(()=>forecastErrors({bars:[trend[1],trend[0],...trend.slice(2)],tf:'1h',cutoffs:[2000]}),/Ogiltig candle/);
  assert.throws(()=>forecastErrors({bars:trend,tf:'1h',cutoffs:[2600]}),/Ogiltiga prognospunkter/);
  assert.throws(()=>forecastErrors({bars:trend,tf:'1h',cutoffs:[2000],horizons:[25]}),/Ogiltiga prognoshorisonter/);
});

test('metricsOf: win rate, profit factor, drawdown and costs from a known trade list and equity curve',()=>{
  const trade=(pnl,reason,fees=1,funding=0)=>({pnl,reason,fees,funding});
  const trades=[trade(10,'mål',1,.5),trade(-5,'stopp',1,-.2),trade(-20,'likvidation',.5),trade(15,'tid',1.5)];
  const equity=[{t:0,v:100},{t:1,v:110},{t:2,v:105},{t:3,v:85},{t:4,v:100}];
  const m=metricsOf(trades,equity,100);
  assert.deepEqual({...m,sharpe:null},{trades:4,wins:2,losses:2,winRate:.5,net:0,netPct:0,maxDrawdown:25,maxDrawdownPct:25/110,profitFactor:1,
    fees:4,funding:.3,liquidations:1,avgTrade:0,sharpe:null});
  // No losing trade: the profit factor is undefined, not infinite.
  assert.equal(metricsOf([trade(3,'mål'),trade(0,'tid')],null,100).profitFactor,null);
  assert.equal(metricsOf([trade(-3,'stopp')],null,100).profitFactor,0);
  // The dollar and the percentage drawdowns are each the deepest of their own kind.
  const swing=metricsOf([],[{t:0,v:100},{t:1,v:50},{t:2,v:300},{t:3,v:240}],100);
  assert.deepEqual([swing.maxDrawdown,swing.maxDrawdownPct],[60,.5]);
  // Without a curve, realized equity after each trade by close time, from the start.
  const realized=metricsOf([{...trade(-10,'stopp'),openedAt:1,closedAt:5},{...trade(30,'mål'),openedAt:0,closedAt:2},{...trade(-40,'stopp'),openedAt:6,closedAt:9}],null,100);
  assert.deepEqual([realized.maxDrawdown,realized.maxDrawdownPct],[50,50/130]);
  const none=metricsOf([],[],100);
  assert.deepEqual([none.trades,none.winRate,none.profitFactor,none.avgTrade,none.maxDrawdown,none.net],[0,null,null,null,0,0]);
  // Sharpe from daily closes: a steady 1 % a day with a dip has a large positive Sharpe; flat has none.
  const days=Array.from({length:30},(_,d)=>({t:(d+1)*86400000,v:100*1.01**d*(d===10?.99:1)}));
  assert.ok(metricsOf([],days,100).sharpe>10);
  assert.equal(metricsOf([],days.map(p=>({...p,v:100})),100).sharpe,null);
  assert.throws(()=>metricsOf([{pnl:NaN,fees:0,funding:0}],null,100),/Ogiltiga affärer/);
  assert.throws(()=>metricsOf([],null,0),/startkapital/);
});

test('Sharpe: a day without a value is a flat day, and the first day counts from the start',()=>{
  const DAY=24*HOUR,r=rng(5),trades=[];let t=Date.UTC(2025,9,1,5);
  for(let k=0;k<40;k++){trades.push({pnl:(r()-.45)*4,fees:0,funding:0,reason:'tid',openedAt:t,closedAt:t+10*DAY-HOUR});t+=10*DAY;}
  // The same realized equity read at every UTC midnight: a trade every ten days is not ten days' return in one.
  const daily=[];let v=100,k=0;
  for(let d=Math.floor(trades[0].openedAt/DAY);d<=Math.floor((trades.at(-1).closedAt-1)/DAY)+1;d++){
    while(k<trades.length&&trades[k].closedAt<=d*DAY)v+=trades[k++].pnl;
    daily.push({t:d*DAY,v});
  }
  const sparse=metricsOf(trades,null,100).sharpe;
  assert.ok(Number.isFinite(sparse));near(sparse,metricsOf([],daily,100).sharpe,1e-9);
  // A curve that starts inside a day: that day's move from the start is a return like any other.
  const start=Date.UTC(2025,9,1,5),inside=[{t:start,v:100},{t:start+15*HOUR,v:90},{t:start+DAY+15*HOUR,v:99},{t:start+2*DAY+15*HOUR,v:89.1}];
  const midnights=[{t:Date.UTC(2025,9,1),v:100},{t:Date.UTC(2025,9,2),v:90},{t:Date.UTC(2025,9,3),v:99},{t:Date.UTC(2025,9,4),v:89.1}];
  near(metricsOf([],inside,100).sharpe,metricsOf([],midnights,100).sharpe,1e-12);
  assert.ok(metricsOf([],inside,100).sharpe<0);
});

// Two coins of 1h candles from 1 800 hours before DEV_END: 800 candles to test after it.
function wfSeries(n=2600){
  const t0=DEV_END-1800*HOUR;
  return {BTC:{bars:walk(n,{seed:41,t0,drift:i=>.0015*Math.sin(i/140)}),funding:null},ETH:{bars:walk(n,{seed:43,t0,drift:i=>.0015*Math.cos(i/160)}),funding:null}};
}
test('walk-forward folds tile the test region after the training history and never overlap',()=>{
  const series=wfSeries(),bars=series.BTC.bars,contracts=contractsFor(['BTC','ETH']);
  const w=walkForward({series,tf:'1h',contracts,settings:{leverage:10}});
  assert.equal(w.folds.length,4);
  // The region starts at the first candle on or after DEV_END (there are 1 800 before it, more than 1 500).
  assert.equal(w.folds[0].test.from,DEV_END);assert.equal(w.folds.at(-1).test.to,bars.at(-1).t);
  w.folds.forEach((f,k)=>{
    assert.ok(f.test.from>=DEV_END&&f.test.from<=f.test.to);
    assert.equal((f.test.to-f.test.from)/HOUR+1,200);
    if(k)assert.equal(f.test.from,w.folds[k-1].test.to+HOUR);
    assert.deepEqual(f.train,{from:f.test.from-FP.train*HOUR,to:f.test.from-HOUR});
    // Every analog of every forecast in the fold, outcome included, lies in its training window.
    assert.ok(f.library.from>=f.train.from&&f.library.to<=f.train.to&&f.library.to<f.test.from);
    assert.equal(f.library.forecasts,2*50);assert.equal(f.library.failed,0);
    for(const h of [5,10,20])assert.ok(f.forecast[h].n>0&&f.forecast[h].n<=100);
    assert.ok(f.trading.trades>=0&&Number.isFinite(f.trading.net));
  });
  // The trades are split by the window they opened in; equity carries over between windows.
  assert.equal(sum(w.folds.map(f=>f.trading.trades)),w.trades.length);
  near(sum(w.folds.map(f=>f.trading.net)),w.aggregate.trading.net,1e-9);
  assert.equal(w.aggregate.forecast[5].n,sum(w.folds.map(f=>f.forecast[5].n)));
  assert.deepEqual(Object.keys(w.aggregate.bySymbol),['BTC','ETH']);
  assert.ok(w.trades.every(t=>t.signalAt>=DEV_END));
  // Every note, in order. No parameter was chosen on any data (the research kept the predetermined
  // defaults), so no note may say otherwise.
  assert.deepEqual(w.notes,['Reglerna och parametrarna bestämdes i förväg; inget valdes på testfönstren efter 1 okt 2025.',
    'Alla mått är uppmätta i efterhand på historik utanför träningsfönstren, inte löften om framtiden.',
    'Bybits nuvarande hävstångsgränser används bakåt.','Likvidation prövas på candlens sämsta pris, strängare än Bybits markpris.',
    'Fundinghistorik saknas för BTC — funding är inte medräknad.','Fundinghistorik saknas för ETH — funding är inte medräknad.',
    'Prognosens analoger hämtas bara från de '+FP.train.toLocaleString('sv-SE')+' candles som slutar före varje testfönster; prognos vid var 4:e candle per par.']);
  // A fold's forecasts are exactly forecastErrors over its cutoffs with its fixed library.
  const f=w.folds[2],first=ix(bars,f.test.from),cut=[];for(let c=first;bars[c]?.t<=f.test.to;c+=4)cut.push(c);
  const lib={from:first-FP.train,to:first-1},solo=walkForward({series:{BTC:series.BTC},tf:'1h',contracts});
  assert.deepEqual(solo.folds[2].forecast,forecastErrors({bars,tf:'1h',cutoffs:cut,library:lib}));
  // The fold's last cutoff: its analogs' outcomes end before the fold, unlike the live rolling window's.
  const c=cut.at(-1),F=forecastFeatures(bars);
  const fixed=forecastAt(bars,c,{tf:'1h',features:F,library:lib,params:{...FP,train:c-lib.from}});
  assert.ok(fixed.ok&&fixed.analogs.every(t=>t+FP.horizon*HOUR<f.test.from));
  assert.ok(forecastAt(bars,c,{tf:'1h',features:F}).analogs.some(t=>t>=f.test.from));
  // An early minTestFrom: the region starts once trainBars candles of history exist. The first note follows
  // where the windows really start: 200 hours after DEV_END here, so they do not overlap the development data.
  const early=walkForward({series:{BTC:series.BTC},tf:'1h',contracts,minTestFrom:0,folds:2,trainBars:2000});
  assert.equal(early.folds[0].test.from,bars[2000].t);assert.ok(early.folds[0].test.from>DEV_END);
  assert.equal(early.notes[0],'Reglerna och parametrarna bestämdes i förväg; inget valdes på testfönstren efter 1 okt 2025.');
  const overlap=walkForward({series:{BTC:series.BTC},tf:'1h',contracts,minTestFrom:0,folds:2,trainBars:1000});
  assert.equal(overlap.folds[0].test.from,bars[1000].t);assert.ok(overlap.folds[0].test.from<DEV_END);
  assert.equal(overlap.notes[0],'Testfönstren börjar före 1 okt 2025 och överlappar forskningens utvecklingsperiod, där reglerna prövades.');
  assert.throws(()=>walkForward({series,tf:'1h',contracts,minTestFrom:bars.at(-1).t+HOUR}),/Ingen data från/);
  assert.throws(()=>walkForward({series:{BTC:{bars:bars.slice(0,1501),funding:null}},tf:'1h',contracts,minTestFrom:0,folds:4}),/För kort historik för walk-forward/);
});
test('a coin with missing candles draws its analogs only from the fold\'s training window, by time',()=>{
  const series=wfSeries(),eth=series.ETH.bars.filter((_,j)=>j<1000||j>=1040);
  const w=walkForward({series:{BTC:series.BTC,ETH:{bars:eth,funding:null}},tf:'1h',contracts:contractsFor(['BTC','ETH'])});
  for(const f of w.folds){
    assert.deepEqual(f.train,{from:f.test.from-FP.train*HOUR,to:f.test.from-HOUR});
    // Counting ETH's last 1 500 candles instead would reach 40 hours before the window.
    assert.ok(f.library.from>=f.train.from&&f.library.to<f.test.from,'library from '+new Date(f.library.from).toISOString());
    assert.equal(f.library.failed,0);
  }
  // ETH's part of a fold is forecastErrors with exactly its candles in that window as the library.
  const f=w.folds[1],first=ix(eth,f.test.from),cut=[];for(let c=first;eth[c]?.t<=f.test.to;c+=4)cut.push(c);
  const btc=series.BTC.bars,bFirst=ix(btc,f.test.from),bCut=cut.map(c=>c-first+bFirst);
  const parts=[forecastErrors({bars:eth,tf:'1h',cutoffs:cut,library:{from:ix(eth,f.train.from),to:first-1}}),
    forecastErrors({bars:btc,tf:'1h',cutoffs:bCut,library:{from:bFirst-FP.train,to:bFirst-1}})];
  for(const h of [5,10,20]){
    assert.equal(f.forecast[h].n,parts[0][h].n+parts[1][h].n);
    near(f.forecast[h].mae,(parts[0][h].mae*parts[0][h].n+parts[1][h].mae*parts[1][h].n)/f.forecast[h].n,1e-12);
  }
});

test('walk-forward is untouched by the future: folds that ended before T score the same after later candles change',()=>{
  const series=wfSeries(),contracts=contractsFor(['BTC','ETH']),opts={tf:'1h',contracts,settings:{leverage:10}};
  const a=walkForward({...opts,series}),T=a.folds[2].test.from+24*HOUR;
  const poison=b=>b.map(x=>x.t<T?x:{...x,o:x.o*1.4,h:x.h*1.8,l:x.l*.6,c:x.c*1.2,v:x.v*9});
  const b=walkForward({...opts,series:{BTC:{bars:poison(series.BTC.bars),funding:null},ETH:{bars:poison(series.ETH.bars),funding:null}}});
  for(const k of [0,1]){
    assert.deepEqual(b.folds[k].forecast,a.folds[k].forecast,'fold '+k);
    assert.deepEqual(b.folds[k].trading,a.folds[k].trading,'fold '+k);
    assert.deepEqual(b.folds[k].library,a.folds[k].library);
  }
  assert.notDeepEqual(b.folds[3].forecast,a.folds[3].forecast);
});

test('a walk-forward whose account is emptied in its first window still reports the later windows',()=>{
  const series=wfSeries(),bars=series.BTC.bars.map(b=>({...b})),i=ix(bars,DEV_END),c=bars[i].c;
  // The entry candle falls 10 %: at Bybit's 150x with every dollar as margin (allowed settings) nothing is left.
  bars[i+1].l=Math.min(bars[i+1].o,bars[i+1].c)*.9;
  const opts={series:{BTC:{bars,funding:null}},tf:'1h',contracts:contractsFor(['BTC']),settings:{leverage:'max',positionPct:1,riskPct:1},
    signals:{BTC:[{t:bars[i].t,side:'long',entry:c,sl:c*.97,tp:c*1.06},{t:bars[i+300].t,side:'long',entry:bars[i+300].c,sl:bars[i+300].c*.97,tp:bars[i+300].c*1.06}]}};
  const s=simulate({...opts,from:DEV_END});
  assert.deepEqual(s.trades.map(t=>t.reason),['likvidation']);assert.equal(s.ledger.cash,0);
  assert.equal(s.decisions[1].trade,null);assert.ok(s.decisions[1].reason);
  const w=walkForward(opts);
  assert.deepEqual(w.folds.map(f=>f.trading.trades),[1,0,0,0]);
  near(w.folds[0].trading.net,-100);assert.equal(w.folds[0].trading.maxDrawdownPct,1);
  for(const f of w.folds.slice(1))assert.deepEqual([f.trading.net,f.trading.maxDrawdown,f.trading.sharpe],[0,0,null]);
  near(w.aggregate.trading.net,-100);assert.equal(w.aggregate.trading.liquidations,1);
});

test('walkForwardSteps reports progress between coins and folds and returns walkForward\'s result',()=>{
  const series=wfSeries(2300),opts={series,tf:'1h',contracts:contractsFor(['BTC','ETH']),folds:2};
  const steps=walkForwardSteps(opts),seen=[];let r;
  while(!(r=steps.next()).done)seen.push(r.value);
  assert.deepEqual(seen.map(s=>s.done),seen.map((_,k)=>k+1));
  assert.ok(seen.every(s=>s.total===seen.length&&typeof s.text==='string'&&s.text));
  assert.deepEqual(seen.map(s=>s.text),['Signaler BTC','Signaler ETH','Handel','Prognosunderlag BTC','Prognoser BTC · fönster 1 av 2','Prognoser BTC · fönster 2 av 2',
    'Prognosunderlag ETH','Prognoser ETH · fönster 1 av 2','Prognoser ETH · fönster 2 av 2']);
  assert.deepEqual(r.value,walkForward(opts));
});

test('the research hashes its sources with LF line ends, so a Windows checkout reproduces the published hashes',async()=>{
  const {sourceHash}=await import('../research/ai-forecast-run.mjs');
  const read=name=>readFileSync(new URL('../research/'+name,import.meta.url),'utf8'),protocol=read('ai-forecast-protocol.md');
  const published=read('ai-forecast-results.md').match(/\| Protokoll \(`ai-forecast-protocol\.md`\) \| ([0-9a-f]{64}) \|/)[1];
  // git with core.autocrlf=true checks the frozen protocol out with CRLF line ends.
  for(const text of [protocol,protocol.replace(/\r?\n/g,'\r\n')])assert.equal(sourceHash(text),published);
  assert.equal(sourceHash('a\r\nb\n'),createHash('sha256').update('a\nb\n').digest('hex'));
});

test('bad input is refused in Swedish, and a stressed slippage is applied and said',()=>{
  const {bars}=scenario(quiet(25)),c=contractsFor(['BTC']),go=o=>simulate({series:{BTC:{bars,funding:null}},tf:'1h',contracts:c,...o});
  assert.throws(()=>go({series:{FOO:{bars,funding:null}}}),/Okänt par: FOO/);
  assert.throws(()=>go({contracts:{}}),/Bybits hävstångsgränser saknas för BTC/);
  // A Map or the page's contract cache works as well as a plain object.
  assert.deepEqual(go({contracts:new Map([['BTC',limits('BTC')]])}).trades,go({}).trades);
  assert.deepEqual(go({contracts:{get:s=>s==='BTC'?limits('BTC'):null}}).trades,go({}).trades);
  assert.throws(()=>go({contracts:{get:()=>null}}),/Bybits hävstångsgränser saknas för BTC/);
  assert.throws(()=>go({contracts:{BTC:limits('ETH')}}),/annat kontrakt än BTC/);
  assert.throws(()=>go({tf:'2h'}),/Okänd tidsram/);
  assert.throws(()=>go({settings:{maxOpen:9}}),/Max öppna positioner/);
  assert.throws(()=>go({series:{BTC:{bars:[bars[1],bars[0]],funding:null}}}),/Ogiltig candle för BTC/);
  assert.throws(()=>go({series:{BTC:{bars:[{...bars[0],h:bars[0].c*.9}],funding:null}}}),/Ogiltig candle för BTC/);
  assert.throws(()=>go({series:{BTC:{bars:[{...bars[0],t:bars[0].t+1}],funding:null}}}),/Ogiltig candle för BTC/);
  assert.throws(()=>go({series:{BTC:{bars,funding:[{t:1,rate:'x'}]}}}),/Ogiltig fundinghistorik för BTC/);
  assert.throws(()=>go({params:{...P,maxHold:0}}),/Ogiltiga signalparametrar/);
  assert.throws(()=>go({signals:{BTC:[{t:bars[S].t,side:'long',entry:100,sl:101,tp:102}]}}),/Ogiltig signal för BTC/);
  // Twice the slippage on every fill, and the notes say so.
  const normal=go({settings:{leverage:10}}).trades[0],stress=go({settings:{leverage:10},slip:2*SLIP});
  const t=stress.trades[0];
  near(t.entry,bars[S+1].o*(1+2*SLIP));near(t.exit,bars[S+1+P.maxHold].o*(1-2*SLIP));assert.ok(t.pnl<normal.pnl);
  assert.ok(stress.notes.includes('Slippage 0,10\u00a0% per sida i stället för 0,05\u00a0%.'));
});
