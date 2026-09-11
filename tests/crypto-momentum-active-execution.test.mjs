import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVE_RISK,openActivePosition,inspectActivePosition,stopRiskNow} from '../crypto-momentum-active-execution.js';
import {LEVERAGE,liquidationPrice,closeLeveraged,leveragedValue} from '../crypto-leverage.js';
import {CONTRACTS,LIMIT_TTL} from '../bybit-contracts.js';

const TIME=Date.parse('2026-09-11T12:00:00Z'),STEP=LEVERAGE.step,HOUR=3600000;
const near=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const contract=(symbol='BTC',extra={})=>({symbol,contract:CONTRACTS[symbol],at:TIME,min:1,max:150,step:.01,
  tiers:[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}],...extra});
const signal=(extra={})=>({symbol:'BTC',at:TIME,score:.1,reference:100,slDistance:2,rewardMultiple:3,maxHoldMs:12*HOUR,...extra});
const quote=(extra={})=>({price:100,mark:100,at:TIME,contract:contract(),...extra});
const position=(extraSignal={},extraMarket={},settings=ACTIVE_RISK,at=TIME)=>{
  const p=openActivePosition(100,quote(extraMarket),signal(extraSignal),at,settings);
  assert.ok(p,'Expected an admissible position');return p;
};
const bar=(t,extra={})=>({t,o:100,h:100,l:100,c:100,...extra});
function history(p,now,extra={}){
  const historyFrom=Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP),end=Math.floor(now/STEP)*STEP;
  return {price:100,mark:100,at:now,historyFrom,fundingThrough:now,funding:[],
    markBars:Array.from({length:(end-historyFrom)/STEP+1},(_,i)=>bar(historyFrom+i*STEP)),...extra};
}
function settle(p,observation,now){
  const r=inspectActivePosition(p,observation,now);assert.ok(r.exit,'Expected a protective exit');
  return {...r,...closeLeveraged(r.position,r.exit.price,r.exit.at,r.exit.reason)};
}

test('active sizing preserves at least half the account and reconciles the entire ordinary SL cost',()=>{
  for(const equity of [1,100,12500]){
    const p=openActivePosition(equity,quote(),signal(),TIME);
    assert.ok(p);assert.ok(p.budget<=equity*.5+1e-8);assert.ok(p.initialRisk<=equity*.5+1e-8);
    const closed=closeLeveraged(p,p.sl,TIME+STEP,'SL'),cashOutside=equity-p.budget;
    const loss=equity-(cashOutside+closed.cash);
    near(loss,p.initialRisk);near(stopRiskNow(p),loss);
    near(closed.trade.pnl,-loss);near(closed.trade.fees,p.fee+closed.exitFee);
    assert.ok(cashOutside+closed.cash>=equity*.5-1e-8);
    // Cash left outside the isolated position is not consumed even on liquidation.
    const liquidated=closeLeveraged(p,liquidationPrice(p),TIME+STEP,'likvidation');
    near(liquidated.cash,0);near(liquidated.trade.pnl,-p.budget);
    assert.ok(cashOutside+liquidated.cash>=equity*.5-1e-8);
  }
});

test('risk and margin limits bind independently without silently allocating extra isolated margin',()=>{
  const riskLimited=position({}, {},{...ACTIVE_RISK,riskFraction:.01});
  near(riskLimited.initialRisk,1);assert.ok(riskLimited.budget<50);
  near(riskLimited.budget,riskLimited.units*riskLimited.entry/riskLimited.rules.leverage+riskLimited.fee);
  const marginLimited=position({}, {},{...ACTIVE_RISK,marginFraction:.1});
  near(marginLimited.budget,10);assert.ok(marginLimited.initialRisk<50);
  const exposureLimited=position({}, {},{...ACTIVE_RISK,maxExposure:.2});
  near(exposureLimited.units*exposureLimited.entry,20);assert.ok(exposureLimited.budget<50);
});

test('the chosen leverage leaves the required liquidation buffer and the next step is unsafe',()=>{
  const p=position(),distance=p.entry-p.sl,boundary=p.sl-ACTIVE_RISK.liquidationBuffer*distance;
  assert.ok(p.rules.leverage<150);near(p.rules.leverage/.01,Math.round(p.rules.leverage/.01),1e-7);
  assert.ok(liquidationPrice(p)<=boundary+1e-8);
  // For a zero-deduction single tier, liquidation depends on entry and leverage,
  // not position size: the next permitted step must fail the buffer.
  const higher=p.rules.leverage+.01;
  const higherLiquidation=p.entry*(1-1/higher)/(1-p.rules.maintenance-p.rules.fee);
  assert.ok(higherLiquidation>boundary);
});

test('contract maximum, tier maximum and marked notional cap all constrain entry',()=>{
  const c=contract('BTC',{max:75,step:.25,tiers:[
    {id:1,cap:500,max:25,maintenance:.005,deduction:0},
    {id:2,cap:10000,max:10,maintenance:.01,deduction:2.5}
  ]});
  const p=position({}, {contract:c,mark:101});
  const notional=p.units*Math.max(p.entry,101),tier=c.tiers.find(t=>notional<=t.cap+1e-8);
  assert.ok(tier);assert.equal(p.rules.riskId,tier.id);assert.equal(p.rules.maintenance,tier.maintenance);
  assert.equal(p.rules.deduction,tier.deduction);assert.ok(p.rules.leverage<=Math.min(c.max,tier.max));
  assert.ok(notional<=tier.cap+1e-8);near(p.rules.leverage/c.step,Math.round(p.rules.leverage/c.step));
  near(p.rules.leverage,25);near(notional,500);
  assert.ok(liquidationPrice(p)<=p.sl-.25*(p.entry-p.sl)+1e-8);
});

test('small token prices retain the correct contract identity and dollar risk scale',()=>{
  for(const symbol of ['SHIB','PEPE']){
    const raw=.00001,c=contract(symbol,{max:50,tiers:[{id:1,cap:1e6,max:50,maintenance:.01,deduction:0}]});
    const p=position({symbol,reference:raw,slDistance:raw*.1},{price:raw,mark:raw,contract:c});
    assert.equal(p.rules.contract,CONTRACTS[symbol]);assert.ok(p.entry<.001);assert.ok(p.units>1e6);
    assert.ok(p.initialRisk<=50+1e-8);assert.ok(p.budget<=50+1e-8);
    near(50-closeLeveraged(p,p.sl,TIME+STEP,'SL').cash,p.initialRisk);
  }
});

test('stale or mismatched limits and unsafe settings cannot create positions',()=>{
  assert.throws(()=>position({}, {contract:contract('ETH')}),/Bybit/);
  assert.throws(()=>position({}, {contract:contract('BTC',{at:TIME-LIMIT_TTL-1})}),/Bybit/);
  assert.throws(()=>position({}, {contract:contract('BTC',{at:TIME+5001})}),/Bybit/);
  for(const settings of [{...ACTIVE_RISK,riskFraction:.51},{...ACTIVE_RISK,marginFraction:.51},
    {...ACTIVE_RISK,riskFraction:0},{...ACTIVE_RISK,liquidationBuffer:.24}])
    assert.throws(()=>openActivePosition(100,quote(),signal(),TIME,settings),/riskbudget/);
  assert.equal(openActivePosition(100,quote({contract:contract('BTC',{min:100})}),signal(),TIME),null);
});

test('entry rejects chased prices, invalid stop geometry and insufficient reward after costs',()=>{
  assert.equal(openActivePosition(100,quote({price:102,mark:102}),signal(),TIME),null);
  assert.equal(openActivePosition(100,quote({mark:98}),signal(),TIME),null);
  assert.equal(openActivePosition(100,quote({mark:106}),signal(),TIME),null);
  assert.equal(openActivePosition(100,quote(),signal({slDistance:101}),TIME),null);
  assert.equal(openActivePosition(100,quote(),signal({slDistance:.5,rewardMultiple:2}),TIME),null);
});

test('a stop encountered before a lower liquidation level closes at SL even on an ambiguous candle',()=>{
  const p=position(),now=TIME+2*STEP,q=history(p,now);
  q.markBars[1]=bar(TIME+STEP,{h:p.tp+1,l:liquidationPrice(p)-1,c:100});
  const done=settle(p,q,now);
  assert.equal(done.exit.reason,'SL');near(done.exit.price,p.sl);assert.equal(done.exit.at,now);
  near(done.cash,p.budget-p.initialRisk);assert.ok(done.cash>0);
  near(100-p.budget+done.cash,100-p.initialRisk);
});

test('take profit realizes its value once with both execution fees and adverse slippage',()=>{
  const p=position(),now=TIME+2*STEP,q=history(p,now);
  q.markBars[1]=bar(TIME+STEP,{h:p.tp+.5,l:99,c:p.tp});
  const done=settle(p,q,now),exitFill=p.tp*(1-p.rules.slip);
  assert.equal(done.exit.reason,'TP');near(done.trade.exit,exitFill);
  near(done.trade.pnl,p.units*(exitFill-p.entry)-p.fee-p.units*exitFill*p.rules.fee);
  near(done.trade.pnl/p.initialRisk,p.netRR);
  near(100-p.budget+done.cash,100+done.trade.pnl);
});

test('adverse opening gaps fill below SL or liquidate when already beyond the margin boundary',()=>{
  const p=position(),now=TIME+STEP+1000,liq=liquidationPrice(p);
  const gap=(liq+p.sl)/2,q=history(p,now);q.markBars[1]=bar(TIME+STEP,{o:gap,h:gap+.05,l:gap-.05,c:gap});
  const stopped=settle(p,q,now);assert.equal(stopped.exit.reason,'SL');near(stopped.exit.price,gap);
  assert.ok(-stopped.trade.pnl>p.initialRisk);assert.ok(stopped.cash>0);
  const failed=history(p,now),past=liq-.1;failed.markBars[1]=bar(TIME+STEP,{o:past,h:past+.05,l:past-.05,c:past});
  const liquidated=settle(p,failed,now);assert.equal(liquidated.exit.reason,'likvidation');assert.equal(liquidated.cash,0);
  near(100-p.budget+liquidated.cash,50);
});

test('a favorable opening gap triggers TP before a later opposite excursion',()=>{
  const p=position(),now=TIME+2*STEP,q=history(p,now);
  q.markBars[1]=bar(TIME+STEP,{o:p.tp+1,h:p.tp+2,l:p.sl-1,c:p.tp});
  const done=settle(p,q,now);assert.equal(done.exit.reason,'TP');near(done.exit.price,p.tp);
  assert.equal(done.exit.at,TIME+STEP);
});

test('funding is charged in chronological order once and changes both equity and liquidation',()=>{
  for(const rate of [.0001,-.0001]){
    const p=position(),unchanged=structuredClone(p),now=TIME+2*STEP,q=history(p,now,{funding:[{t:TIME+STEP,rate}]});
    const result=inspectActivePosition(p,q,now),cost=p.units*100*rate;
    assert.equal(result.exit,null);near(result.funding,cost);near(result.position.funding,cost);
    near(leveragedValue(result.position,100),leveragedValue(p,100)-cost);
    assert.equal(Math.sign(liquidationPrice(result.position)-liquidationPrice(p)),Math.sign(rate));
    assert.deepEqual(p,unchanged);
    const again=inspectActivePosition(result.position,history(result.position,now+1000,{funding:q.funding}),now+1000);
    near(again.funding,0);near(again.position.funding,cost);assert.equal(again.exit,null);
  }
});

test('funding paid at a stop bar is included, while funding after an earlier exit is omitted',()=>{
  const p=position(),now=TIME+3*STEP,q=history(p,now,{funding:[{t:TIME+STEP,rate:.0001},{t:TIME+2*STEP,rate:.5}]});
  q.markBars[1]=bar(TIME+STEP,{h:100,l:p.sl-.01,c:p.sl});
  const done=settle(p,q,now),paid=p.units*100*.0001;
  assert.equal(done.exit.reason,'SL');near(done.funding,paid);near(done.trade.funding,paid);
  near(done.trade.pnl,-p.initialRisk-paid);
});

test('funding that moves liquidation above SL closes the position before waiting for the stop',()=>{
  const p=position(),now=TIME+STEP+1000,desired=p.sl+.1;
  const rate=(desired-liquidationPrice(p))*(1-p.rules.maintenance-p.rules.fee)/100;
  const q=history(p,now,{funding:[{t:TIME+STEP,rate}]}),done=settle(p,q,now);
  assert.equal(done.exit.reason,'risk');near(liquidationPrice(done.position),desired);
  near(done.exit.price,100);assert.ok(done.cash>0);
});

test('funding that exhausts isolated margin triggers liquidation at the funding observation',()=>{
  const p=position(),now=TIME+STEP+1000,desired=100.1;
  const rate=(desired-liquidationPrice(p))*(1-p.rules.maintenance-p.rules.fee)/100;
  const done=settle(p,history(p,now,{funding:[{t:TIME+STEP,rate}]}),now);
  assert.equal(done.exit.reason,'likvidation');assert.equal(done.exit.at,TIME+STEP);assert.equal(done.cash,0);
});

test('timeout uses the first deadline opening before later candle highs and lows',()=>{
  const p=position({maxHoldMs:2*STEP}),now=TIME+3*STEP,q=history(p,now);
  q.markBars[2]=bar(TIME+2*STEP,{o:101,h:p.tp+1,l:p.sl-1,c:101});
  const done=settle(p,q,now);assert.equal(done.exit.reason,'timeout');near(done.exit.price,101);
  assert.equal(done.exit.at,p.deadline);
});

test('an entry between five-minute boundaries never extends its maximum holding period',()=>{
  const at=TIME+120000,p=position({maxHoldMs:2*STEP},{},ACTIVE_RISK,at),now=TIME+3*STEP,q=history(p,now);
  assert.equal(p.deadline%STEP,0);assert.ok(p.deadline<=at+2*STEP);
  q.markBars.find(b=>b.t===p.deadline).h=p.tp+1;
  q.markBars.find(b=>b.t===p.deadline).l=p.sl-1;
  const done=settle(p,q,now);
  assert.equal(done.exit.reason,'timeout');assert.equal(done.exit.at,p.deadline);
  near(done.exit.price,100);
});

test('earlier SL wins over a later timeout and uncompleted live bars can trigger protective exits',()=>{
  const p=position({maxHoldMs:3*STEP}),now=TIME+STEP+1000,q=history(p,now);
  q.markBars[1]=bar(TIME+STEP,{l:p.sl-.01,c:p.sl});
  const done=settle(p,q,now);assert.equal(done.exit.reason,'SL');assert.equal(done.exit.at,now);
});

test('entry candle extremes are excluded, but current observed mark can trigger an immediate stop',()=>{
  const at=TIME+120000,p=position({}, {},ACTIVE_RISK,at),now=at+1000,q=history(p,now);
  q.markBars[0]=bar(TIME,{h:p.tp+10,l:liquidationPrice(p)-10});
  assert.equal(inspectActivePosition(p,q,now).exit,null);
  const stopMark=(p.sl+liquidationPrice(p))/2;
  const done=settle(p,{...q,mark:stopMark,price:stopMark-.01},now);
  assert.equal(done.exit.reason,'SL');near(done.exit.price,stopMark-.01);assert.equal(done.exit.at,now);
});

test('missing or stale funding coverage and gaps in required mark history pause risk settlement',()=>{
  const p=position(),now=TIME+3*STEP,q=history(p,now);
  assert.throws(()=>inspectActivePosition(p,{...q,fundingThrough:now-120001},now),/historik saknas/);
  assert.throws(()=>inspectActivePosition(p,{...q,historyFrom:TIME+STEP},now),/historik saknas/);
  assert.throws(()=>inspectActivePosition(p,{...q,markBars:q.markBars.filter(b=>b.t!==TIME+STEP)},now),/Lucka/);
  assert.throws(()=>inspectActivePosition(p,{...q,markBars:[...q.markBars,q.markBars[1]]},now),/Lucka/);
  assert.throws(()=>inspectActivePosition(p,{...q,markBars:q.markBars.map(b=>b.t===TIME?{...b,h:99}:b)},now),/Ogiltiga markpriser/);
  assert.throws(()=>inspectActivePosition(p,{...q,funding:[{t:TIME+1,rate:.001}]},now),/Fundingmarkpris/);
  assert.throws(()=>inspectActivePosition(p,{...q,funding:[{t:TIME+STEP,rate:.001},{t:TIME+STEP,rate:.001}]},now),/Ogiltig funding/);
});

test('open positions retain their entry SL, TP and leverage throughout normal monitoring',()=>{
  const p=position(),before=structuredClone(p),now=TIME+2*STEP;
  const result=inspectActivePosition(p,history(p,now,{contract:contract('BTC',{max:10})}),now);
  assert.equal(result.exit,null);assert.equal(result.position.sl,p.sl);assert.equal(result.position.tp,p.tp);
  assert.deepEqual(result.position.rules,p.rules);assert.deepEqual(p,before);
  assert.equal(result.position.nextBar,now);assert.equal(result.position.fundingThrough,now);
});
