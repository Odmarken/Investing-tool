import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTRACTS,LIMIT_TTL,parseContract,fetchContract,maxLeverageFor,createContractCache,isolatedLevel} from '../bybit-contracts.js';
const at=Date.parse('2026-09-11T12:00:00Z');
const instrument=(symbol,max=150)=>({symbol,status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:String(max),leverageStep:'.01'}});
const risks=(symbol)=>[
  {symbol,id:1,riskLimitValue:'300000',maxLeverage:'150',maintenanceMargin:'.0033',mmDeduction:''},
  {symbol,id:2,riskLimitValue:'2000000',maxLeverage:'100',maintenanceMargin:'.005',mmDeduction:'510'}
];
const btc=()=>parseContract('BTC',[instrument('BTCUSDT')],risks('BTCUSDT'),at);
test('maps all seven coins to active USDT perpetuals, including contract multipliers',()=>{
  assert.equal(CONTRACTS.SHIB,'SHIB1000USDT');assert.equal(CONTRACTS.PEPE,'1000PEPEUSDT');
  for(const [symbol,id] of Object.entries(CONTRACTS)){
    const c=parseContract(symbol,[instrument(id)],risks(id),at);
    assert.equal(c.contract,id);assert.equal(c.max,150);assert.equal(c.tiers[0].maintenance,.0033);
    assert.equal(c.tiers[0].deduction,0);assert.equal(c.tiers[1].deduction,510);
  }
  assert.throws(()=>parseContract('BTC',[instrument('ETHUSDT')],risks('BTCUSDT'),at));
  assert.throws(()=>parseContract('BTC',[{...instrument('BTCUSDT'),status:'PreLaunch'}],risks('BTCUSDT'),at));
  assert.throws(()=>parseContract('BTC',[instrument('BTCUSDT')],[],at));
});
test('selects maximum feasible leverage, including intermediate values and larger risk tiers',()=>{
  const c=btc();assert.equal(maxLeverageFor(c,100,{},at).leverage,150);
  assert.equal(maxLeverageFor(c,2500,{},at).leverage,120);
  const big=maxLeverageFor(c,4000,{},at);
  assert.equal(big.leverage,100);assert.equal(big.riskId,2);assert.equal(big.maintenance,.005);assert.equal(big.deduction,510);
  assert.equal(maxLeverageFor(c,2500,{mark:2,price:1},at).leverage,100);
  const paid=maxLeverageFor(c,2500,{fee:.00055},at);
  assert.equal(paid.leverage,128.47);
  assert.ok(2500/(1/paid.leverage+.00055)<=300000);
  assert.ok(2500/(1/(paid.leverage+.01)+.00055)>300000);
  assert.throws(()=>maxLeverageFor(c,3e6,{},at));
});
test('never opens with missing, stale or future limits',()=>{
  assert.throws(()=>maxLeverageFor(null,100,{},at));
  assert.throws(()=>maxLeverageFor(btc(),100,{},at+LIMIT_TTL+1));
  assert.throws(()=>maxLeverageFor(btc(),100,{},at-6000));
});
test('loader validates API freshness and paginates risk limits',async()=>{
  const urls=[];
  const grab=async url=>{
    urls.push(url);const u=new URL(url),info=u.pathname.endsWith('instruments-info'),second=u.searchParams.has('cursor');
    return {retCode:0,time:at,result:{category:'linear',list:info?[instrument('BTCUSDT')]:[risks('BTCUSDT')[second?1:0]],nextPageCursor:info||second?'':'next'}};
  };
  assert.equal((await fetchContract(grab,'BTC',()=>at)).tiers.length,2);assert.equal(urls.length,3);
  await assert.rejects(fetchContract(async url=>({...await grab(url),time:at-180000}),'BTC',()=>at));
  await assert.rejects(fetchContract(async url=>({...await grab(url),retCode:10001}),'BTC',()=>at));
});
test('cache shares requests, expires limits, and retries after a public API failure',async()=>{
  let now=at,calls=0,fail=false;
  const cache=createContractCache(async url=>{
    calls++;if(fail)throw Error('offline');
    return {retCode:0,time:now,result:{category:'linear',list:url.includes('instruments-info')?[instrument('BTCUSDT')]:risks('BTCUSDT')}};
  },()=>now);
  await Promise.all([cache.load('BTC'),cache.load('BTC')]);assert.equal(calls,2);
  assert.equal(cache.get('BTC').max,150);
  now+=LIMIT_TTL+1;fail=true;assert.equal(cache.get('BTC'),null);
  assert.equal(await cache.load('BTC'),null);const failed=calls;
  assert.equal(await cache.load('BTC'),null);assert.equal(calls,failed);
  now+=60000;fail=false;assert.equal((await cache.load('BTC')).max,150);
});
test('long and short liquidation levels reconcile equity with maintenance and closing fees',()=>{
  const plan={maintenance:.005,deduction:510},entry=100,budget=4000,units=4000,fee=.00055;
  for(const side of ['long','short']){
    const price=isolatedLevel(side,entry,budget,units,fee,plan),dir=side==='long'?1:-1;
    const equity=budget-units*entry*fee+dir*(price-entry)*units;
    assert.ok(Math.abs(equity-(price*units*(plan.maintenance+fee)-plan.deduction))<1e-7);
  }
});
