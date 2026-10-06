import test from 'node:test';
import assert from 'node:assert/strict';
import {ACCOUNT,SETTING_LIMITS,accountKey,newForecastAccount,validateForecastAccount,readForecastAccount,migrateForecastAccount,updateSettings,setPaused,setAuto,
  markProcessed,sizePosition,openPosition,settlePosition,checkQuote,closePosition,accountLive,accountStats,tradeReasons,previewOrder,openManual,
  previewLevels,setLevels,deposit,withdraw,setFree,stepDecimals} from '../forecast-account.js';
// levelDecimals through the namespace, so this file also loads against an account module without it.
import * as accountModule from '../forecast-account.js';
import {TF,SYMBOLS,SIGNAL_PARAMS,MODEL} from '../forecast-config.js';
import {CONTRACTS,CONTRACT_UNITS,LIMIT_TTL,isolatedLevel,bybitIsolatedLevel,maxLeverageFor} from '../bybit-contracts.js';
import {filtersFor,LOT} from './forecast-fixtures.mjs';

const MIN=60000,HOUR=3600000,STEP=ACCOUNT.step,FEE=ACCOUNT.fee,SLIP=ACCOUNT.slip;
// An hour boundary: the 1h candle that opened an hour earlier has just closed.
const T=Date.parse('2026-10-05T10:00:00Z');
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps*Math.max(1,Math.abs(b)),a+' vs '+b);
const deepFreeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.freeze(x);Object.values(x).forEach(deepFreeze);}return x;};
const SINGLE=[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}];
// Tier 2's deduction keeps the maintenance margin continuous at tier 1's cap, as on Bybit.
const TIERED=[{id:1,cap:1000,max:150,maintenance:.005,deduction:0},{id:2,cap:100000,max:50,maintenance:.01,deduction:5}];
// Bybit's limits as parseContract returns them; bybitLimits adds today's order filters, which manual orders need.
const limits=(symbol='BTC',at=T,tiers=SINGLE,max=150)=>({symbol,contract:CONTRACTS[symbol],at,min:1,max,step:.01,tiers:tiers.map(t=>({...t}))});
const bybitLimits=(symbol='BTC',at=T,tiers=SINGLE,max=150)=>({...limits(symbol,at,tiers,max),filters:filtersFor(symbol)});
// A stored signal record as forecast-store's signalRecord builds it: the candle closed at T.
function signal({symbol='BTC',tf='1h',side='long',barTime,sl,tp,entry=100}={}){
  const ms=TF[tf].ms;barTime??=T-ms;sl??=side==='long'?98:102;tp??=side==='long'?104:96;
  return {id:`s|u1|${symbol}|${tf}|${barTime}|${MODEL.signal}`,kind:'signal',schema:1,uid:'u1',symbol,tf,model:MODEL.signal,barTime,confirmedAt:barTime+ms,
    side,entry,sl,tp,atr:Math.abs(entry-sl)/SIGNAL_PARAMS.slAtr,regime:side==='long'?'trend-up':'trend-down',hash:'0123456789abcd'};
}
function open(a,{sig=signal(),symbol=sig.symbol,price=100,mark=price,now=T+1000,quoteAt=now,contract=limits(symbol,now),reliable=true}={}){
  return openPosition(a,{signal:sig,symbol,quote:{price,mark,at:quoteAt},contract,now,tfMs:TF[sig.tf].ms,dataReliable:reliable});
}
// 10× with the position size binding: liquidation sits far beyond the stop.
const tenX=(over={})=>newForecastAccount(T-HOUR,{leverage:10,positionPct:.2,riskPct:1,...over});
// fetchPositionRisk's result: flat 5-minute mark and last-price candles from the
// position's history start through `now`, and flat 1-minute candles of the step it
// opened in, or its levels last changed in: mark prices from the minute after the
// open, last prices from the minute after the later of the two; with per-candle overrides.
function riskFor(p,now,{price=100,marks={},lasts={},minuteMarks={},minuteLasts={},funding=[],quote=price}={}){
  const from=Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP),markBars=[],lastBars=[],mm=[],ml=[];
  for(let t=from;t<=Math.floor(now/STEP)*STEP;t+=STEP){
    const flat={t,o:price,h:price,l:price,c:price};
    markBars.push({...flat,...marks[t]});lastBars.push({...flat,...lasts[t]});
  }
  const since=Math.max(p.openedAt,p.levelsAt??p.openedAt),first=(Math.floor(since/STEP)+1)*STEP;
  for(let t=Math.max(first-STEP,Math.ceil(p.openedAt/MIN)*MIN);t<first&&t<=now;t+=MIN){
    const flat={t,o:price,h:price,l:price,c:price};
    mm.push({...flat,...minuteMarks[t]});
    if(t>=Math.ceil(since/MIN)*MIN)ml.push({...flat,...minuteLasts[t]});
  }
  return {price:quote,mark:quote,at:now,markBars,lastBars,minuteMarks:mm,minuteLasts:ml,funding,fundingThrough:now,historyFrom:from};
}
const memoryStorage=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v))};};

test('a new account holds 100 $ of its own under its own key, trades manually until auto-trading is switched on, and storage refuses unknown versions',()=>{
  const a=newForecastAccount(T);
  assert.deepEqual({...a,settings:null},{version:'ai-forecast-account-v2',createdAt:T,start:100,cash:100,settings:null,positions:[],trades:[],transfers:[],log:[],processed:{},fees:0,funding:0});
  assert.deepEqual(a.settings,{tf:'1h',symbols:[...SYMBOLS],positionPct:.25,riskPct:.1,maxOpen:3,leverage:'max',paused:false,auto:false});
  assert.equal(setAuto(a,true).settings.auto,true);assert.equal(setAuto(setAuto(a,true),false).settings.auto,false);
  assert.equal(newForecastAccount(T,{auto:true}).settings.auto,true);
  assert.throws(()=>setAuto(a,'ja'),/Ogiltigt läge för auto-handel/);assert.throws(()=>newForecastAccount(T,{auto:1}),/Ogiltigt läge för auto-handel/);
  assert.deepEqual(SETTING_LIMITS,{positionPct:[.01,1],riskPct:[.001,1],maxOpen:[1,7],leverage:[1,200]});
  assert.equal(accountKey('anna b@x.se'),'riptide.forecast.v1:anna%20b%40x.se');
  assert.equal(newForecastAccount(T,{leverage:20,symbols:['ETH','BTC']}).settings.leverage,20);
  assert.deepEqual(newForecastAccount(T,{symbols:['PEPE','BTC']}).settings.symbols,['BTC','PEPE']);
  assert.throws(()=>newForecastAccount(T,{fart:1}),/inställningar/);
  assert.throws(()=>newForecastAccount(NaN),/starttid/);
  const storage=memoryStorage(),key=accountKey('u1');
  assert.deepEqual(readForecastAccount(storage,key,T),a);
  const held=open(newForecastAccount(T-HOUR)).account;storage.setItem(key,JSON.stringify(held));
  assert.deepEqual(readForecastAccount(storage,key,T+5000),held);
  storage.setItem(key,JSON.stringify({...held,version:'ai-forecast-account-v3'}));
  assert.throws(()=>readForecastAccount(storage,key,T),/Ladda om sidan/);
  storage.setItem(key,'{trasig');assert.throws(()=>readForecastAccount(storage,key,T),/kan inte läsas/);
});

test('at Bybit\'s maximum on a single tier the risk per trade binds and the liquidation is Bybit\'s isolated level',()=>{
  const settings=newForecastAccount(T).settings,c=limits(),fill=100*(1+SLIP);
  const s=sizePosition({equity:100,cash:100,settings,contract:c,side:'long',price:100,mark:100,sl:98,now:T});
  assert.equal(s.ok,true);assert.equal(s.leverage,150);
  assert.equal(s.leverage,maxLeverageFor(c,s.margin,{price:fill,mark:100},T).leverage);
  // 150 × (2 % to the stop plus fees and slippage) exceeds 1: the liquidation comes first and takes the whole
  // margin plus the opening fee, so margin × (1 + 150 × fee) = 10 % of equity.
  const M=10/(1+150*FEE);
  near(s.lossFraction,1+150*FEE);near(s.margin,M);near(s.lossAtStop,10);
  near(s.fill,fill);near(s.notional,150*M);near(s.units,150*M/fill);near(s.openFee,150*M*FEE);near(s.margin+s.openFee,10);
  assert.deepEqual([s.maintenance,s.deduction,s.riskId],[.005,0,1]);
  near(s.liq,isolatedLevel('long',fill,M+150*M*FEE,150*M/fill,FEE,SINGLE[0]));
  // At that price the position's equity equals the maintenance margin plus the closing fee.
  near(M+(s.liq-fill)*s.units,s.liq*s.units*(.005+FEE));
  assert.ok(s.liq<fill&&s.liq>98,'at 150× liquidation comes long before the stop');
  const short=sizePosition({equity:100,cash:100,settings,contract:c,side:'short',price:100,mark:100,sl:102,now:T});
  near(short.fill,100*(1-SLIP));assert.equal(short.leverage,150);near(short.margin,M);near(short.lossAtStop,10);assert.ok(short.liq>short.fill);
  near(M+(short.fill-short.liq)*short.units,short.liq*short.units*(.005+FEE));
  assert.match(sizePosition({equity:100,cash:100,settings,contract:c,side:'long',price:100,mark:100,sl:101,now:T}).reason,/fel sida/);
  assert.match(sizePosition({equity:100,cash:100,settings,contract:c,side:'up',price:100,mark:100,sl:98,now:T}).reason,/riktning/);
});

// Bybit's first six risk tiers per coin as read for the research on 4 October 2026: [cap, max, maintenance, deduction].
const SOL_TIERS=[[5e4,100,.005,0],[1e5,90,.0056,30],[2.5e5,80,.0063,100],[4e5,75,.0067,200],[5.5e5,70,.0071,360],[7e5,65,.0077,690]];
const SHIB_TIERS=[[2e5,50,.01,0],[4e5,33.33,.015,1000],[6e5,25,.02,3000],[8e5,20,.025,6000],[1e6,16.67,.03,10000],[1.2e6,14.29,.035,15000]];
const BYBIT_TIERS={
  BTC:[[3e5,150,.0033,0],[2e6,100,.005,510],[2.6e6,90,.0056,1710],[3.2e6,80,.0063,3530],[3.8e6,75,.0067,4810],[4.4e6,70,.0071,6330]],
  ETH:[[3e5,150,.0033,0],[9e5,100,.005,510],[1.2e6,90,.0056,1050],[1.5e6,80,.0063,1890],[1.8e6,75,.0067,2490],[2.4e6,70,.0071,3210]],
  SOL:SOL_TIERS,XRP:SOL_TIERS,
  DOGE:[[2.5e5,75,.0075,0],[5e5,50,.01,625],[7.5e5,33.33,.015,3125],[1.5e6,25,.02,6875],[3e6,20,.025,14375],[5e6,16.67,.03,29375]],
  SHIB:SHIB_TIERS,PEPE:SHIB_TIERS};
const bybit=(symbol,at=T)=>limits(symbol,at,BYBIT_TIERS[symbol].map(([cap,max,maintenance,deduction],k)=>({id:k+1,cap,max,maintenance,deduction})),BYBIT_TIERS[symbol][0][1]);
// The loss when the price moves straight to the stop, as the ledger books it: the whole margin and the opening fee when
// Bybit's isolated liquidation lies at or before the stop, else the stop's exit with slippage and both fees.
function stopLoss(s,side,sl){
  const dir=side==='long'?1:-1;
  if(dir*(s.liq-sl)>=0)return s.margin+s.openFee;
  const exit=sl*(1-dir*SLIP);
  return s.margin+s.openFee-Math.max(0,s.margin+dir*(exit-s.fill)*s.units-s.units*exit*FEE);
}

test('risk per trade holds when Bybit\'s liquidation lies before the stop: DOGE at 75× with a 0,56 % stop loses 10 $, not 18 $',()=>{
  const c=bybit('DOGE'),price=.2,fill=price*(1+SLIP),sl=fill*(1-.0056);
  const s=sizePosition({equity:100,cash:100,settings:newForecastAccount(T).settings,contract:c,side:'long',price,mark:price,sl,now:T});
  assert.deepEqual([s.ok,s.leverage,s.riskId],[true,75,1]);
  // Bybit's isolated level at 75× with 0,75 % maintenance lies 0,53 % below the fill, inside the 0,56 % stop.
  near((s.fill-s.liq)/s.fill,(1/75-.0075-FEE)/(1-.0075-FEE));assert.ok(s.liq>sl);
  // The stop's own share, 75 × (0,56 % + 0,21 %) = 58 % of the margin, would allow 17,32 $ of margin, and the fall to the
  // stop would take all of it plus 0,71 $ of fees: 18,03 $. The liquidation's share sizes it instead.
  near(s.lossFraction,1+75*FEE);near(s.margin,10/(1+75*FEE));near(s.lossAtStop,10);near(stopLoss(s,'long',sl),10);
  // The ledger books the fall to the stop as that liquidation: exactly 10 % of equity.
  const sig=signal({symbol:'DOGE',entry:price,sl,tp:price*1.02});
  const {account:a,position:p}=open(newForecastAccount(T-HOUR),{sig,price,contract:c});
  assert.deepEqual([p.leverage,p.liq],[s.leverage,s.liq]);
  const bar=p.nextBar,now=bar+STEP+1000,t=settlePosition(a,p.id,riskFor(p,now,{price,marks:{[bar]:{l:sl}},lasts:{[bar]:{l:sl}}}),now).trades[0];
  assert.equal(t.reason,'likvidation');near(t.pnl,-10);
  // A liquidation just beyond the stop counts as coming first too: at 75× a 0,5 % stop has it only 0,03 % further on,
  // where funding or a candle running past the stop would reach it.
  const tight=sizePosition({equity:100,cash:100,settings:newForecastAccount(T).settings,contract:c,side:'long',price,mark:price,sl:fill*(1-.005),now:T});
  assert.ok(tight.liq<fill*(1-.005)&&tight.liq>fill*(1-.005-ACCOUNT.liqBuffer));near(tight.lossFraction,1+75*FEE);near(tight.lossAtStop,10);
  // With the liquidation more than 1 % of the price beyond the stop, the stop's share sizes it: 25× and a 2 % stop.
  const wide=sizePosition({equity:100,cash:100,settings:{...newForecastAccount(T).settings,leverage:25},contract:c,side:'long',price,mark:price,sl:fill*(1-.02),now:T});
  assert.equal(ACCOUNT.liqBuffer,.01);assert.ok(wide.liq<fill*(1-.02-ACCOUNT.liqBuffer));
  near(wide.lossFraction,25*(.02+2*(FEE+SLIP)));near(wide.lossAtStop,10);assert.ok(stopLoss(wide,'long',fill*(1-.02))<=10);
});

// The final review's cases: a 5-minute signal at Bybit's top leverage, its stop a few hundredths of a percent inside the
// liquidation distance; one ordinary funding moves the liquidation in front of the stop, then a candle falls exactly to the stop.
test('funding paid after the entry cannot turn a move to the stop into more than the risk: a liquidation less than 1 % beyond the stop sizes the margin',()=>{
  const cases=[['BTC',100000,.0028,.0001],['ETH',4000,.0028,.0001],['SOL',150,.0044,.0001],['DOGE',.2,.0053,.0001],['BTC',100000,.0027,.0003]];
  for(const [symbol,price,d,rate] of cases){
    const fill=price*(1+SLIP),sl=fill*(1-d),barTime=T-STEP,c=bybit(symbol,T+1000),label=symbol+' '+d;
    const sig=signal({symbol,tf:'5m',barTime,entry:price,sl,tp:price*(1+3*d)});
    const plan=sizePosition({equity:100,cash:100,settings:newForecastAccount(T).settings,contract:c,side:'long',price,mark:price,sl,now:T+1000});
    const {account:a,position:p}=open(newForecastAccount(T-HOUR,{tf:'5m'}),{sig,price,contract:c});
    // At entry the stop lies before the liquidation, but by less than 1 %: sized as if the liquidation came first.
    assert.ok(p.liq<sl&&p.liq>sl-ACCOUNT.liqBuffer*fill,label);
    near(plan.lossFraction,1+p.leverage*FEE);near(p.margin+p.fees,10);
    const hour=T+HOUR,now=hour+STEP+1000;
    const t=settlePosition(a,p.id,riskFor(p,now,{price,marks:{[hour]:{l:sl}},lasts:{[hour]:{l:sl}},funding:[{t:hour,rate}]}),now).trades[0];
    // The funding moved the liquidation in front of the stop and the candle reached it: the margin and the opening fee, 10 $.
    assert.equal(t.reason,'likvidation',label);near(t.pnl,-10);assert.ok(t.funding>0,label);
  }
  // A liquidation more than 1 % beyond the stop leaves the stop first: 50× BTC with the same 0,28 % stop.
  const price=100000,fill=price*(1+SLIP),sl=fill*(1-.0028),c=bybit('BTC',T+1000);
  const sig=signal({symbol:'BTC',tf:'5m',barTime:T-STEP,entry:price,sl,tp:price*1.01});
  const {account:a,position:p}=open(newForecastAccount(T-HOUR,{tf:'5m',leverage:50}),{sig,price,contract:c});
  assert.ok(p.liq<sl-ACCOUNT.liqBuffer*fill);near(p.margin,25);
  const hour=T+HOUR,now=hour+STEP+1000;
  const t=settlePosition(a,p.id,riskFor(p,now,{price,marks:{[hour]:{l:sl}},lasts:{[hour]:{l:sl}},funding:[{t:hour,rate:.0003}]}),now).trades[0];
  const exit=sl*(1-SLIP);
  assert.equal(t.reason,'stopp');near(-t.pnl-t.funding,p.fees+(p.entry-exit)*p.units+p.units*exit*FEE);assert.ok(-t.pnl-t.funding<10);
});

test('property: whatever the coin, risk tier, leverage, side or stop, a move to the stop never loses more than the risk per trade',()=>{
  let seed=20261005;const rnd=()=>(seed=seed*16807%2147483647)/2147483647;
  const leverages=['max','max','max','max',1,2,3,5,10,20,25,50,75,100,150,200],pick=xs=>xs[Math.floor(rnd()*xs.length)];
  const base=newForecastAccount(T).settings,seen={liquidation:0,stop:0,tiers:new Set()};
  for(let n=0;n<6000;n++){
    const symbol=SYMBOLS[n%SYMBOLS.length],side=rnd()<.5?'long':'short',dir=side==='long'?1:-1;
    // Equity from 1 $ to 1 M$ reaches the higher tiers; stops from 0,01 % to 60 % away; a mark up to 1 % off the price.
    const equity=10**(6*rnd()),cash=equity*(.05+.95*rnd()),riskPct=10**(-3+3*rnd()),positionPct=.01+.99*rnd(),leverage=pick(leverages);
    const price=10**(-5+10*rnd()),mark=price*(1+(rnd()-.5)*.02),d=10**(-4+3.78*rnd()),fill=price*(1+dir*SLIP),sl=fill*(1-dir*d);
    const s=sizePosition({equity,cash,settings:{...base,riskPct,positionPct,leverage},contract:bybit(symbol),side,price,mark,sl,now:T});
    if(!s.ok){assert.match(s.reason,/för liten|Otillräcklig kassa|ryms inte inom Bybits/,JSON.stringify({symbol,equity,cash,riskPct,leverage}));continue;}
    const risk=riskPct*equity,loss=stopLoss(s,side,sl),label=JSON.stringify({symbol,side,equity,cash,riskPct,positionPct,leverage,d,L:s.leverage});
    assert.ok(loss<=risk*(1+1e-9),'loses '+loss+' > '+risk+' '+label);
    assert.ok(loss<=s.lossAtStop*(1+1e-9)&&s.lossAtStop<=risk*(1+1e-9),'lossAtStop '+s.lossAtStop+' vs '+loss+' '+label);
    // Sized on the stop's share only with Bybit's liquidation more than 1 % of the price beyond the stop.
    if(s.lossFraction<1)assert.ok(dir*(s.liq-sl)+ACCOUNT.liqBuffer*s.fill<0,'stop first with the liquidation near it '+label);
    else near(s.lossFraction,1+s.leverage*FEE);
    assert.ok(s.margin+s.openFee<=cash*(1+1e-9)&&s.margin<=positionPct*equity*(1+1e-9),label);
    // Within Bybit's limits: the tier for the notional at the mark allows the leverage.
    const tier=bybit(symbol).tiers.find(t=>t.id===s.riskId);
    assert.ok(s.notional*Math.max(1,mark/s.fill)<=tier.cap*(1+1e-9)&&s.leverage<=tier.max+1e-9&&(leverage==='max'||s.leverage<=leverage),label);
    dir*(s.liq-sl)>=0?seen.liquidation++:seen.stop++;seen.tiers.add(symbol+s.riskId);
  }
  assert.ok(seen.liquidation>1000&&seen.stop>1000&&seen.tiers.size>14,JSON.stringify({...seen,tiers:seen.tiers.size}));
  // The same through the ledger itself: open at 100 $ of equity, then a 5-minute candle straight to the stop.
  let traded=0;
  for(let n=0;n<420;n++){
    const symbol=SYMBOLS[n%SYMBOLS.length],side=n%2?'short':'long',dir=side==='long'?1:-1,leverage=pick(leverages);
    const riskPct=10**(-2+2*rnd()),positionPct=.05+.95*rnd(),price=10**(-5+10*rnd()),d=10**(-3+2.7*rnd());
    const fill=price*(1+dir*SLIP),sl=fill*(1-dir*d),tp=price+dir*1.5*Math.abs(price-sl);
    const r=open(newForecastAccount(T-HOUR,{leverage,riskPct,positionPct}),{sig:signal({symbol,side,entry:price,sl,tp}),price,contract:bybit(symbol,T+1000)});
    if(!r.opened){assert.match(r.reason,/för liten|likvidationsnivån/,r.reason);continue;}
    const p=r.position,bar=p.nextBar,now=bar+STEP+1000,move=dir>0?{l:sl}:{h:sl};
    const t=settlePosition(r.account,p.id,riskFor(p,now,{price,marks:{[bar]:move},lasts:{[bar]:move}}),now).trades[0];
    assert.equal(t.reason,dir*(p.liq-sl)>=0?'likvidation':'stopp');
    assert.ok(-t.pnl<=riskPct*100*(1+1e-9),'loses '+(-t.pnl)+' > '+riskPct*100+' '+JSON.stringify({symbol,side,leverage,riskPct,d}));
    traded++;
  }
  assert.ok(traded>350,'traded '+traded);
});

test('property: funding, the mark and a candle running past the stop, together under 1 % of the price, never make a move to the stop cost more than the risk',()=>{
  let seed=51005;const rnd=()=>(seed=seed*16807%2147483647)/2147483647;
  const leverages=['max','max','max',10,20,25,40,50,75,100,150],pick=xs=>xs[Math.floor(rnd()*xs.length)],seen={stop:0,liquidation:0,stopFirst:0};
  for(let n=0;n<700;n++){
    const symbol=SYMBOLS[n%SYMBOLS.length],side=n%2?'short':'long',dir=side==='long'?1:-1,leverage=pick(leverages),c=bybit(symbol,T+1000);
    const tier=c.tiers[0],L=Math.min(leverage==='max'?c.max:leverage,c.max),liqAt=(1/L-tier.maintenance-FEE)/(1-tier.maintenance-FEE);
    // Half the stops within 1,5 % inside Bybit's liquidation distance, where the order of the two is in doubt.
    const d=rnd()<.5?liqAt-.015*rnd():10**(-3+1.7*rnd());
    if(!(d>.001))continue;
    const riskPct=.01+.2*rnd(),price=10**(-5+10*rnd()),fill=price*(1+dir*SLIP),sl=fill*(1-dir*d),tp=price+dir*2*Math.abs(price-sl);
    const r=open(newForecastAccount(T-HOUR,{leverage,riskPct}),{sig:signal({symbol,side,entry:price,sl,tp}),price,contract:c});
    if(!r.opened){assert.match(r.reason,/för liten|likvidationsnivån/,r.reason);continue;}
    const p=r.position,risk=riskPct*100,stopFirst=dir*(p.liq-sl)+ACCOUNT.liqBuffer*fill<0;
    // Funding the position pays moves its liquidation by f of the fill; the mark runs m beyond the last price, which goes o past the stop.
    const share=.98*rnd(),f=ACCOUNT.liqBuffer*share*rnd(),m=(ACCOUNT.liqBuffer*share-f)*rnd(),o=ACCOUNT.liqBuffer*share-f-m;
    const rate=dir*f*(1-p.maintenance-FEE)*fill/price,bar=p.nextBar,move=bar+STEP,now=move+STEP+1000;
    const last=dir>0?{l:sl-o*fill}:{h:sl+o*fill},mark=dir>0?{l:sl-(o+m)*fill}:{h:sl+(o+m)*fill};
    const t=settlePosition(r.account,p.id,riskFor(p,now,{price,marks:{[move]:mark},lasts:{[move]:last},funding:[{t:bar,rate}]}),now).trades[0];
    const label=JSON.stringify({symbol,side,leverage,riskPct,d,f,m,o,L:p.leverage});
    assert.ok(t&&t.funding>0,label);
    // Apart from the funding paid, never more than the risk; a liquidation costs the margin and the opening fee.
    assert.ok(-t.pnl-t.funding<=risk*(1+1e-9),'loses '+(-t.pnl-t.funding)+' > '+risk+' '+label);
    if(t.reason==='likvidation')assert.ok(-t.pnl<=risk*(1+1e-9),label);
    // Sized on the stop: the liquidation, moved by the funding, stays beyond the mark's low, so the stop books it.
    if(stopFirst){assert.equal(t.reason,'stopp',label);seen.stopFirst++;}
    seen[t.reason==='likvidation'?'liquidation':'stop']++;
  }
  assert.ok(seen.stopFirst>100&&seen.liquidation>100&&seen.stop>150,JSON.stringify(seen));
});

test('on a multi-tier contract the leverage follows the notional and the tier sets the maintenance margin',()=>{
  const c=limits('BTC',T,TIERED),base={...newForecastAccount(T).settings,riskPct:1};
  const size=(equity,over={})=>sizePosition({equity,cash:equity,settings:base,contract:c,side:'long',price:100,mark:100,sl:98,now:T,...over});
  // 25 $ at 150× would be 3 750 $ of notional, beyond tier 1: tier 2's 50× is the most Bybit allows for that margin.
  const big=size(100);
  assert.equal(big.leverage,50);near(big.margin,25);near(big.notional,1250);assert.deepEqual([big.riskId,big.maintenance,big.deduction],[2,.01,5]);
  near(big.liq,isolatedLevel('long',big.fill,big.margin+big.openFee,big.units,FEE,TIERED[1]));
  // A smaller account stays inside tier 1 at 150×.
  const small=size(20);
  assert.equal(small.leverage,150);near(small.margin,5);near(small.notional,750);assert.deepEqual([small.riskId,small.maintenance],[1,.005]);
  // Risk per trade cuts the margin: the liquidation comes first, so margin × (1 + L × fee) = 10 $. Re-reading the
  // tiers for the smaller margin gives a higher leverage that just fits tier 1, and the margin follows it.
  const risky=size(100,{settings:{...base,riskPct:.1}});
  assert.equal(risky.leverage,105.81);near(risky.margin,10/(1+105.81*FEE));near(risky.lossFraction,1+105.81*FEE);near(risky.lossAtStop,10);
  assert.ok(risky.notional<=1000&&risky.notional>999);assert.equal(risky.riskId,1);
  // A mark above the fill counts toward the risk limit, as in maxLeverageFor.
  const marked=size(20,{mark:140});
  assert.ok(marked.leverage<150&&marked.notional*140/marked.fill<=1000+1e-9);assert.equal(marked.riskId,1);
  // A numeric leverage below the maximum lands in the tier of its own, smaller notional.
  const thirty=size(100,{settings:{...base,leverage:30}});
  assert.equal(thirty.leverage,30);near(thirty.notional,750);assert.deepEqual([thirty.riskId,thirty.maintenance],[1,.005]);
});

test('with a large account the margin is the largest at which the stop still comes first, as Bybit\'s deduction moves the liquidation with the margin',()=>{
  // SOL at 40× on 20 000 $ (risk 2 000 $), a stop 0,91 % below the fill. The stop's own margin, 4 464 $, reaches tier 3,
  // whose deduction leaves the liquidation 1,88 % away: less than 1 % beyond the stop. The liquidation's margin, 1 957 $,
  // sits in tier 2 with the liquidation 1,94 % away. In between lies the largest margin with the stop first.
  const c=bybit('SOL'),price=150,fill=price*(1+SLIP),d=.0091,sl=fill*(1-d),per=d+2*(FEE+SLIP);
  const s=sizePosition({equity:2e4,cash:2e4,settings:{...newForecastAccount(T).settings,leverage:40},contract:c,side:'long',price,mark:price,sl,now:T});
  assert.deepEqual([s.ok,s.leverage,s.riskId],[true,40,3]);
  const liqAt=m=>isolatedLevel('long',fill,m*(1+40*FEE),m*40/fill,FEE,c.tiers.find(t=>m*40<=t.cap));
  assert.ok(liqAt(2e3/(40*per))>sl-ACCOUNT.liqBuffer*fill&&liqAt(2e3/(1+40*FEE))<sl-ACCOUNT.liqBuffer*fill);
  assert.ok(s.margin>2e3/(1+40*FEE)&&s.margin<2e3/(40*per),String(s.margin));
  near(s.lossFraction,40*per);near(s.lossAtStop,s.margin*40*per);assert.ok(s.lossAtStop<2e3);
  // The stop comes first at that margin, and not at a margin a millionth larger.
  assert.ok(s.liq<sl-ACCOUNT.liqBuffer*fill&&liqAt(s.margin*(1+1e-6))>sl-ACCOUNT.liqBuffer*fill);
  near(s.margin,3051.888,1e-6);
});

test('risk per trade, position size and cash each bind when they are the smallest',()=>{
  const c=limits(),settings=newForecastAccount(T).settings,fill=100*(1+SLIP),per=(fill-98)/fill+2*(FEE+SLIP);
  const size=(over,account={})=>sizePosition({equity:100,cash:100,settings:{...settings,...over},contract:c,side:'long',price:100,mark:100,sl:98,now:T,...account});
  // 20×: 45 % of the margin is lost at the stop, so 10 % risk allows 22,1 $ of margin, below the 25 $ position size.
  const risk=size({leverage:20});
  assert.equal(risk.leverage,20);near(risk.lossFraction,20*per);near(risk.margin,10/(20*per));near(risk.lossAtStop,10);assert.ok(risk.margin<25);
  // 5×: the stop costs 11 % of the margin, so the 25 % position size binds first.
  const sized=size({leverage:5});
  assert.equal(sized.leverage,5);near(sized.margin,25);near(sized.lossAtStop,25*5*per);assert.ok(sized.lossAtStop<10);
  // Cash left after other positions: margin plus the opening fee must fit.
  const cash=size({leverage:5},{cash:12});near(cash.margin,12/(1+5*FEE));near(cash.margin+cash.openFee,12);
  assert.match(size({},{cash:.005}).reason,/Otillräcklig kassa/);
  assert.match(size({riskPct:.001},{equity:5,cash:5}).reason,/för liten/);
  assert.match(size({},{cash:0}).reason,/Otillräcklig kassa/);
});

test('a numeric leverage is capped at Bybit\'s maximum and rounded down to Bybit\'s step',()=>{
  const settings=newForecastAccount(T).settings;
  const size=(leverage,contract=limits())=>sizePosition({equity:100,cash:100,settings:{...settings,leverage},contract,side:'short',price:100,mark:100,sl:102,now:T});
  assert.equal(size(200).leverage,150);assert.equal(size(150).leverage,150);assert.equal(size(25).leverage,25);assert.equal(size(25.555).leverage,25.55);
  // The same setting stops at a lower-ceiling coin's maximum.
  const doge=limits('DOGE',T,[{id:1,cap:1e6,max:75,maintenance:.01,deduction:0}],75);
  assert.equal(size(200,doge).leverage,75);assert.equal(size('max',doge).leverage,75);
  assert.match(size(1,{...limits(),min:2}).reason,/lägre än Bybits minsta \(2×\)/);
});

test('fees and slippage are exact for long and short round trips',()=>{
  for(const side of ['long','short']){
    const dir=side==='long'?1:-1,{account:a,opened,position:p}=open(tenX(),{sig:signal({side})}),fill=100*(1+dir*SLIP);
    assert.equal(opened,true);assert.equal(p.side,side);assert.equal(p.leverage,10);
    near(p.entry,fill);near(p.margin,20);near(p.units,200/fill);near(p.fees,200*FEE);
    near(a.cash,100-20-200*FEE);near(a.fees,200*FEE);assert.equal(p.equityAtOpen,100);
    assert.equal(p.nextBar,T+STEP);assert.equal(p.fundingThrough,T+1000);assert.equal(p.deadline,T+SIGNAL_PARAMS.maxHold*HOUR);
    assert.equal(a.log.at(-1).kind,'öppnad');assert.match(a.log.at(-1).text,new RegExp('Öppnade '+(dir>0?'lång':'kort')+' BTC .*10× · marginal 20,00 \\$'));
    const price=dir>0?101:99,closed=closePosition(a,p.id,{price,now:T+60000,reason:'manuell'}),t=closed.trades[0];
    const exit=price*(1-dir*SLIP),closeFee=(200/fill)*exit*FEE,proceeds=20+dir*(exit-fill)*(200/fill)-closeFee;
    near(t.exit,exit);near(t.fees,200*FEE+closeFee);near(t.pnl,proceeds-20-200*FEE);
    near(closed.cash,100+t.pnl);near(closed.fees,t.fees);near(t.equityAfter,closed.cash);
    assert.deepEqual([t.reason,t.side,t.symbol,t.signalId,t.tf,t.margin,t.leverage,t.openedAt,t.closedAt,t.funding],['manuell',side,'BTC',p.signalId,'1h',p.margin,10,T+1000,T+60000,0]);
    assert.equal(closed.positions.length,0);assert.equal(closed.log.at(-1).kind,'stängd');assert.match(closed.log.at(-1).text,/^Stängd manuellt: /);
    assert.throws(()=>closePosition(closed,p.id,{price,now:T+70000,reason:'manuell'}),/redan stängd/);
    assert.throws(()=>closePosition(a,p.id,{price,now:T+70000,reason:'panik'}),/Ogiltig orsak/);
    assert.throws(()=>closePosition(a,p.id,{price:NaN,now:T+70000,reason:'manuell'}),/Färskt pris/);
  }
});

test('one position per symbol and never more than maxOpen positions',()=>{
  let a=open(newForecastAccount(T-HOUR,{maxOpen:2})).account;
  // The next candle's BTC signal while the first BTC trade is still open.
  const later=T+HOUR+1000,second=open(a,{sig:signal({barTime:T}),now:later});
  assert.equal(second.opened,false);assert.match(second.reason,/redan en position i BTC/);
  const eth=open(a,{sig:signal({symbol:'ETH',side:'short'}),symbol:'ETH'});
  assert.equal(eth.opened,true);a=eth.account;
  // ETH is sized on realized equity: cash plus the margin locked in BTC.
  near(eth.position.equityAtOpen,a.positions[0].margin+(100-a.positions[0].margin-a.positions[0].fees));
  const sol=open(a,{sig:signal({symbol:'SOL'}),symbol:'SOL'});
  assert.equal(sol.opened,false);assert.match(sol.reason,/Max antal öppna positioner är nått \(2\)/);
  assert.deepEqual(sol.account.positions.map(p=>p.symbol),['BTC','ETH']);
  // Closing BTC records realized equity as cash plus the margin still in ETH.
  const closed=closePosition(a,a.positions[0].id,{price:100.5,now:T+90000,reason:'signal'}),t=closed.trades[0];
  near(t.equityAfter,closed.cash+closed.positions[0].margin);assert.equal(t.reason,'signal');
  assert.equal(open(closed,{sig:signal({symbol:'SOL'}),symbol:'SOL',now:T+100000}).opened,true);
});

test('every rejected entry gives a Swedish reason and a log entry, and nothing else changes',()=>{
  const base=newForecastAccount(T-HOUR),{account:held,position:p}=open(base);
  const traded=closePosition(held,p.id,{price:100,now:T+2000,reason:'manuell'});
  const cases=[
    ['pausad',setPaused(base,true),{},/^Nya affärer är pausade$/],
    ['opålitlig data',base,{reliable:false},/inte tillförlitlig/],
    ['gammalt pris',base,{quoteAt:T+1000-ACCOUNT.quoteTtl-1},/^Färskt pris saknas för BTC$/],
    ['framtida pris',base,{quoteAt:T+7000},/Färskt pris saknas/],
    ['gammal signal',base,{now:T+ACCOUNT.maxSignalAge+1},/^Signalen är för gammal \(30 min\)$/],
    ['5m-signal äldre än en candle',newForecastAccount(T-HOUR,{tf:'5m'}),{sig:signal({tf:'5m'}),now:T+TF['5m'].ms+1},/för gammal/],
    ['obekräftad signal',base,{now:T-10000},/inte bekräftad/],
    ['under stoppet',base,{price:97.9},/^Priset ligger redan utanför stopp och mål$/],
    ['över målet',base,{price:104.1},/utanför stopp och mål/],
    ['låg R:R',base,{price:101.5},/^Kvarvarande vinst\/risk 0,71 är under 1$/],
    ['redan handlad',traded,{now:T+3000},/^Signalen är redan handlad$/],
    ['saknade gränser',base,{contract:null},/^Bybits hävstångsgräns saknas eller är för gammal$/],
    ['gamla gränser',base,{contract:limits('BTC',T+1000-LIMIT_TTL-1)},/^Bybits hävstångsgräns saknas eller är för gammal$/],
    ['fel kontrakt',base,{contract:limits('ETH')},/annat kontrakt än BTC/],
    ['par som inte handlas',updateSettings(base,{symbols:['ETH']}),{},/^BTC ingår inte i de handlade paren$/],
    ['fel tidsram',base,{sig:signal({tf:'15m'})},/^Signalen gäller 15m men kontot handlar 1h$/],
    ['markpris vid likvidation',base,{mark:99.5},/likvidationsnivån/],
    ['ogiltig signal',base,{sig:{...signal(),sl:105}},/Ogiltig signal/]
  ];
  for(const [name,a,opts,reason] of cases){
    const r=open(a,opts),sig=opts.sig??signal();
    assert.equal(r.opened,false,name);assert.match(r.reason,reason,name);
    assert.deepEqual(r.account.positions,a.positions,name);assert.equal(r.account.cash,a.cash,name);assert.deepEqual(r.account.trades,a.trades,name);
    assert.equal(r.account.log.length,a.log.length+1,name);
    assert.deepEqual(r.account.log.at(-1),{t:opts.now??T+1000,kind:'avvisad',symbol:'BTC',signalId:sig.id,text:r.reason},name);
    assert.equal(validateForecastAccount(r.account),r.account);
  }
  // With every dollar in margin there is nothing left for a second entry.
  const all=open(newForecastAccount(T-HOUR,{positionPct:1,riskPct:1,leverage:2}));
  const none=open(all.account,{sig:signal({symbol:'ETH'}),symbol:'ETH'});
  assert.ok(all.account.cash>=0&&all.account.cash<1e-9);assert.equal(none.opened,false);assert.match(none.reason,/Otillräcklig kassa/);
});

test('a retried rejection is not logged twice, and the log keeps only the latest entries',()=>{
  const a=newForecastAccount(T-HOUR),once=open(a,{reliable:false}).account,twice=open(once,{reliable:false}).account;
  assert.equal(once.log.length,1);assert.equal(twice.log.length,1);
  assert.equal(open(twice,{quoteAt:T-60000}).account.log.length,2,'a new reason for the same signal is logged');
  const full=validateForecastAccount({...structuredClone(a),log:Array.from({length:ACCOUNT.logLimit},(_,i)=>({t:T+i,kind:'avvisad',symbol:'BTC',signalId:'old'+i,text:'Gammal'}))});
  const next=open(full,{reliable:false}).account;
  assert.equal(next.log.length,ACCOUNT.logLimit);assert.equal(next.log[0].signalId,'old1');assert.equal(next.log.at(-1).signalId,signal().id);
  assert.throws(()=>validateForecastAccount({...full,log:[...full.log,full.log[0]]}),/för lång/);
});

test('funding is paid out of the position margin and moves the liquidation level',()=>{
  for(const side of ['long','short']){
    const dir=side==='long'?1:-1,{account:a,position:p}=open(tenX(),{sig:signal({side})});
    const ft=T+HOUR,now=T+HOUR+2*STEP+1000,funding=[{t:ft-8*HOUR,rate:.5},{t:ft,rate:.001}];
    const done=settlePosition(a,p.id,riskFor(p,now,{marks:{[ft]:{o:101,h:101}},funding}),now),q=done.positions[0];
    // Charged on the mark at the funding candle's open; the event before the position opened is ignored.
    const cost=dir*p.units*101*.001;
    near(q.margin,p.margin-cost);near(q.funding,cost);near(done.funding,cost);assert.equal(done.cash,a.cash);
    near(q.liq,isolatedLevel(side,p.entry,q.margin+p.units*p.entry*FEE,p.units,FEE,p));
    // A long that pays has less margin, so its liquidation moves up toward the price; a short that receives moves its level away.
    assert.ok(q.liq>p.liq);
    assert.equal(q.fundingThrough,now);assert.equal(q.nextBar,Math.floor(now/STEP)*STEP);
    const again=settlePosition(done,p.id,riskFor(q,now+STEP,{funding}),now+STEP);
    near(again.funding,cost,1e-12);near(again.positions[0].margin,q.margin,1e-12);
    const closed=closePosition(again,p.id,{price:100,now:now+STEP,reason:'manuell'}),t=closed.trades[0],exit=100*(1-dir*SLIP);
    near(t.funding,cost);near(t.margin,p.margin);
    near(t.pnl,q.margin+dir*(exit-p.entry)*p.units-p.units*exit*FEE-p.margin-p.fees);near(closed.cash,100+t.pnl);
  }
});

test('funding larger than the margin is carried by a winning position until it closes',()=>{
  const {account:a,position:p}=open(newForecastAccount(T-HOUR),{sig:signal({tp:120})}),ft=T+HOUR,now=ft+STEP+1000;
  const done=settlePosition(a,p.id,riskFor(p,now,{price:110,funding:[{t:ft,rate:.02}]}),now),q=done.positions[0];
  const cost=p.units*110*.02;
  near(q.margin,p.margin-cost);assert.ok(q.margin<0);assert.ok(q.liq>p.entry&&q.liq<110,'liquidation moved above the entry, still below the mark');
  assert.equal(validateForecastAccount(JSON.parse(JSON.stringify(done))).positions.length,1);
  const t=closePosition(done,p.id,{price:110,now,reason:'manuell'}).trades[0],exit=110*(1-SLIP);
  near(t.pnl,q.margin+(exit-p.entry)*p.units-p.units*exit*FEE-p.margin-p.fees);near(t.funding,cost);near(t.margin,p.margin);
});

test('inside one 5-minute candle liquidation on mark comes first, then the stop, then the target',()=>{
  const bar=T+HOUR,now=bar+STEP+1000;
  // 150×: liquidation sits just under the entry, far inside the stop.
  const maxed=open(newForecastAccount(T-HOUR)),p=maxed.position;
  assert.equal(p.leverage,150);assert.ok(p.liq>p.sl);
  const liq=settlePosition(maxed.account,p.id,riskFor(p,now,{marks:{[bar]:{l:p.liq-.01}},lasts:{[bar]:{l:97,h:105}}}),now),t=liq.trades[0];
  assert.equal(t.reason,'likvidation');near(t.exit,p.liq);assert.equal(t.closedAt,bar+STEP);
  near(t.pnl,-(p.margin+p.fees));near(liq.cash,maxed.account.cash);assert.equal(liq.positions.length,0);
  assert.match(liq.log.at(-1).text,/^Likvidation: lång BTC −/);
  for(const side of ['long','short']){
    const dir=side==='long'?1:-1,{account:a,position:q}=open(tenX(),{sig:signal({side})});
    assert.ok(dir*(q.sl-q.liq)>0,'at 10× the stop comes before liquidation');
    const worst=dir>0?'l':'h',best=dir>0?'h':'l',crash=dir>0?q.liq-.01:q.liq+.01;
    const all={[worst]:dir>0?97:103,[best]:dir>0?105:95};
    // Even when the stop would be hit first on the way down, a mark through liquidation in the same candle wins.
    assert.equal(settlePosition(a,q.id,riskFor(q,now,{marks:{[bar]:{[worst]:crash}},lasts:{[bar]:all}}),now).trades[0].reason,'likvidation');
    const stop=settlePosition(a,q.id,riskFor(q,now,{lasts:{[bar]:all}}),now).trades[0];
    assert.equal(stop.reason,'stopp');near(stop.exit,q.sl*(1-dir*SLIP));assert.equal(stop.closedAt,bar+STEP);
    const target=settlePosition(a,q.id,riskFor(q,now,{lasts:{[bar]:{[best]:dir>0?105:95}}}),now).trades[0];
    assert.equal(target.reason,'mål');near(target.exit,q.tp*(1-dir*SLIP));
    const fee=q.units*target.exit*FEE;near(target.pnl,dir*(target.exit-q.entry)*q.units-fee-q.fees);
    // The candles before were flat: none of them closed anything, and the open candle is still pending.
    const quiet=settlePosition(a,q.id,riskFor(q,now),now);
    assert.equal(quiet.positions.length,1);assert.equal(quiet.positions[0].nextBar,bar+STEP);assert.equal(quiet.positions[0].fundingThrough,now);
  }
});

test('the step a position opens in is replayed from the minute after the entry with Bybit\'s 1-minute candles',()=>{
  // Opened at 10:00:01: the 10:00 5-minute candle also holds prices from before the entry, so it is never replayed;
  // its minutes from 10:01 to 10:04 are, before the 5-minute candles from 10:05.
  const {account:a,position:p}=open(tenX()),first=T+STEP,now=first+STEP+1000;
  assert.equal(p.nextBar,first);
  // A stop wick in the 10:02 minute that no 5-minute candle after the entry shows: the stop, at that minute's end.
  const stop=settlePosition(a,p.id,riskFor(p,now,{minuteLasts:{[T+2*MIN]:{l:97.5}}}),now).trades[0];
  assert.deepEqual([stop.reason,stop.closedAt],['stopp',T+3*MIN]);near(stop.exit,p.sl*(1-SLIP));
  // In one minute the liquidation on the mark comes first; an open beyond the stop fills at it; the target fills at its level.
  const liq=settlePosition(a,p.id,riskFor(p,now,{minuteMarks:{[T+3*MIN]:{l:p.liq-.01}},minuteLasts:{[T+3*MIN]:{l:97}}}),now).trades[0];
  assert.deepEqual([liq.reason,liq.closedAt,liq.exit],['likvidation',T+4*MIN,p.liq]);
  const gap=settlePosition(a,p.id,riskFor(p,now,{minuteLasts:{[T+4*MIN]:{o:97.5,h:97.6,l:97.4,c:97.5}}}),now).trades[0];
  assert.deepEqual([gap.reason,gap.closedAt],['stopp',T+4*MIN]);near(gap.exit,97.5*(1-SLIP));
  const target=settlePosition(a,p.id,riskFor(p,now,{minuteLasts:{[T+MIN]:{h:104.2}}}),now).trades[0];
  assert.deepEqual([target.reason,target.closedAt],['mål',T+2*MIN]);near(target.exit,p.tp*(1-SLIP));
  // A short mirrors it on the high.
  const {account:s,position:q}=open(tenX(),{sig:signal({side:'short'})});
  const sstop=settlePosition(s,q.id,riskFor(q,now,{minuteLasts:{[T+2*MIN]:{h:102.5}}}),now).trades[0];
  assert.deepEqual([sstop.side,sstop.reason,sstop.closedAt],['short','stopp',T+3*MIN]);near(sstop.exit,q.sl*(1+SLIP));
  // The minute the entry fell in is not replayed: a low in it before the entry does not count.
  const r=riskFor(p,now),flat={o:100,h:100,l:100,c:100};
  const early={...r,minuteMarks:[{t:T,...flat},...r.minuteMarks],minuteLasts:[{t:T,...flat,l:97},...r.minuteLasts]};
  assert.deepEqual(settlePosition(a,p.id,early,now).positions.map(x=>x.nextBar),[first+STEP]);
  // Every closed minute is needed; a missing one is a gap, not a quiet minute.
  for(const k of ['minuteMarks','minuteLasts'])
    assert.throws(()=>settlePosition(a,p.id,{...r,[k]:r[k].filter(b=>b.t!==T+2*MIN)},now),/^Error: Lucka i 1-minuterspriserna för BTC$/);
  assert.throws(()=>settlePosition(a,p.id,{...r,minuteMarks:undefined,minuteLasts:undefined},now),/Lucka i 1-minuterspriserna för BTC/);
  assert.throws(()=>settlePosition(a,p.id,{...r,minuteLasts:[{...r.minuteLasts[0],t:T+MIN+1}]},now),/Ogiltiga 1-minuterspriser för BTC/);
  // Inside the opening step: the closed minutes are needed, the forming one is checked when Bybit has it.
  const mid=T+3*MIN+30000,m=riskFor(p,mid);
  assert.deepEqual(m.minuteLasts.map(b=>b.t),[T+MIN,T+2*MIN,T+3*MIN]);
  const pending=settlePosition(a,p.id,{...m,minuteMarks:m.minuteMarks.slice(0,2),minuteLasts:m.minuteLasts.slice(0,2)},mid).positions[0];
  assert.deepEqual([pending.nextBar,pending.fundingThrough],[first,mid]);
  const forming=settlePosition(a,p.id,riskFor(p,mid,{minuteLasts:{[T+3*MIN]:{l:97.9}}}),mid).trades[0];
  assert.deepEqual([forming.reason,forming.closedAt],['stopp',mid]);
  // Replayed again until the first full 5-minute candle is settled; after that the minutes are not read.
  const later=settlePosition(a,p.id,riskFor(p,now),now);
  assert.equal(later.positions[0].nextBar,first+STEP);
  const q2=later.positions[0],n2=now+STEP;
  assert.deepEqual(settlePosition(later,p.id,{...riskFor(q2,n2,{minuteLasts:{[T+2*MIN]:{l:97}}}),minuteMarks:[],minuteLasts:[]},n2).trades,[]);
  assert.deepEqual(settlePosition(later,p.id,riskFor(q2,n2,{minuteLasts:{[T+2*MIN]:{l:97}}}),n2).trades,[]);
});

test('a gap through the stop fills at the open, not at the stop',()=>{
  const bar=T+HOUR,now=bar+STEP+1000;
  for(const side of ['long','short']){
    const dir=side==='long'?1:-1,{account:a,position:p}=open(tenX(),{sig:signal({side})}),open_=dir>0?96.5:103.5;
    const gap=dir>0?{o:open_,l:96}:{o:open_,h:104};
    const t=settlePosition(a,p.id,riskFor(p,now,{marks:{[bar]:gap},lasts:{[bar]:gap}}),now).trades[0];
    assert.equal(t.reason,'stopp');near(t.exit,open_*(1-dir*SLIP));assert.equal(t.closedAt,bar);
    const fee=p.units*t.exit*FEE;near(t.pnl,dir*(t.exit-p.entry)*p.units-fee-p.fees);
    assert.ok(dir*(t.exit-p.sl*(1-dir*SLIP))<0,'the gap fill is worse than the stop');
  }
});

test('the time stop closes at the open of the deadline candle and ignores later candles',()=>{
  const sig=signal({tf:'5m'}),{account:a,position:p}=open(tenX({tf:'5m'}),{sig});
  assert.equal(p.tf,'5m');assert.equal(p.deadline,sig.confirmedAt+SIGNAL_PARAMS.maxHold*TF['5m'].ms);
  const now=p.deadline+30*60000;
  // The target only trades after the deadline, when the trade is already over.
  const t=settlePosition(a,p.id,riskFor(p,now,{price:101,lasts:{[p.deadline+2*STEP]:{h:105}}}),now).trades[0];
  assert.equal(t.reason,'tid');assert.equal(t.closedAt,p.deadline);near(t.exit,101*(1-SLIP));
  const early=settlePosition(a,p.id,riskFor(p,p.deadline-1000,{price:101}),p.deadline-1000);
  assert.equal(early.positions.length,1);assert.equal(early.positions[0].nextBar,p.deadline-STEP);
  assert.equal(settlePosition(early,p.id,riskFor(early.positions[0],p.deadline+1000,{price:101}),p.deadline+1000).trades[0].reason,'tid');
  // A deadline inside the current candle closes at the risk quote once reached.
  const odd=structuredClone(a);odd.positions[0].deadline=p.openedAt+2000;
  const quick=settlePosition(validateForecastAccount(odd),p.id,riskFor(p,p.openedAt+3000,{quote:100.4}),p.openedAt+3000).trades[0];
  assert.equal(quick.reason,'tid');near(quick.exit,100.4*(1-SLIP));assert.equal(quick.closedAt,p.openedAt+3000);
  assert.equal(tradeReasons[quick.reason],'Tidsstopp');
});

test('a position never loses more than its margin plus the opening fee',()=>{
  for(const settings of [{},{leverage:10,positionPct:.2,riskPct:1},{leverage:1,positionPct:1,riskPct:1}]){
    for(const side of ['long','short']){
      const dir=side==='long'?1:-1,{account:a,position:p}=open(newForecastAccount(T-HOUR,settings),{sig:signal({side})});
      const floor=-(p.margin+p.fees);
      for(const price of [1,50,90,97,99.9,100,100.1,103,110,200,1000]){
        const t=closePosition(a,p.id,{price,now:T+5000,reason:'manuell'}).trades[0];
        assert.ok(t.pnl>=floor-1e-12,side+' '+price+': '+t.pnl);
      }
      const ruin=closePosition(a,p.id,{price:dir>0?1:1000,now:T+5000,reason:'manuell'});
      if(settings.leverage!==1){near(ruin.trades[0].pnl,floor);near(ruin.cash,a.cash);}
      // Funding paid out of the margin, then a crash that gaps past every level, cannot push the loss past it either.
      const ft=T+HOUR,now=ft+2*STEP+1000,crash=dir>0?{o:1,l:1}:{o:1000,h:1000};
      const burnt=settlePosition(a,p.id,riskFor(p,now,{funding:[{t:ft,rate:dir*.002}],marks:{[ft+STEP]:crash},lasts:{[ft+STEP]:crash}}),now).trades[0];
      assert.ok(['likvidation','stopp'].includes(burnt.reason));assert.ok(burnt.funding>0);near(burnt.margin,p.margin);
      // At 1× a long that falls 99 % keeps 1 % of its value; with leverage the whole stake is gone, never more.
      assert.ok(burnt.pnl>=floor-1e-12);if(settings.leverage!==1)near(burnt.pnl,floor);
    }
  }
});

test('between settlements a fresh quote can liquidate, stop or take profit; a stale or older quote cannot',()=>{
  const {account:a,position:p}=open(tenX()),now=T+6000,at=T+5000;
  const stop=checkQuote(a,p.id,{price:97,mark:97.2,at},now).trades[0];
  assert.equal(stop.reason,'stopp');near(stop.exit,97*(1-SLIP),1e-12);assert.equal(stop.closedAt,now);
  near(checkQuote(a,p.id,{price:97.99,mark:98,at},now).trades[0].exit,97.99*(1-SLIP));
  const target=checkQuote(a,p.id,{price:104.5,mark:104.4,at},now).trades[0];
  assert.equal(target.reason,'mål');near(target.exit,104*(1-SLIP));
  const liq=checkQuote(a,p.id,{price:90,mark:p.liq-.01,at},now).trades[0];
  assert.equal(liq.reason,'likvidation');near(liq.pnl,-(p.margin+p.fees));
  const unchanged=x=>{assert.deepEqual(x,a);assert.notEqual(x,a);};
  unchanged(checkQuote(a,p.id,{price:101,mark:101,at},now));
  unchanged(checkQuote(a,p.id,{price:97,mark:97,at:now-ACCOUNT.quoteTtl-1},now));
  unchanged(checkQuote(a,p.id,{price:97,mark:97,at:p.openedAt-1},now));
  unchanged(checkQuote(a,p.id,null,now));
  unchanged(checkQuote(a,'saknas',{price:97,mark:97,at},now));
  // Three minutes without a settlement: an older gap must be replayed candle by candle first.
  unchanged(checkQuote(a,p.id,{price:97,mark:97,at:T+180000},T+181000));
  // Exits keep working while new entries are paused.
  assert.equal(checkQuote(setPaused(a,true),p.id,{price:97,mark:97.2,at},now).trades[0].reason,'stopp');
});

test('a live quote books no exit across a funding time since the last settlement; the replay books it after the funding',()=>{
  // Settled 30 s before the 16:00 UTC funding (Bybit's funding times are whole hours).
  const {account:a,position:p}=open(tenX()),ft=T+6*HOUR,s=settlePosition(a,p.id,riskFor(p,ft-30000),ft-30000);
  assert.equal(s.positions[0].fundingThrough,ft-30000);
  // At 16:00:20 the price is through the stop: booking it from the quote would skip the funding, so it waits.
  const now=ft+20000,unchanged=x=>{assert.deepEqual(x,s);assert.notEqual(x,s);};
  for(const q of [{price:97,mark:97.2},{price:104.5,mark:104.4},{price:90,mark:p.liq-.01}])unchanged(checkQuote(s,p.id,{...q,at:now-1000},now));
  // The replay charges the 16:00 funding on the mark at that candle's open, then books the stop inside it.
  const done=settlePosition(s,p.id,riskFor(s.positions[0],now,{funding:[{t:ft,rate:.001}],lasts:{[ft]:{l:97}}}),now),t=done.trades[0];
  assert.deepEqual([t.reason,t.closedAt],['stopp',now]);near(t.funding,p.units*100*.001);near(t.pnl,(t.exit-p.entry)*p.units-t.fees-t.funding);
  // Once settled past the hour, the live check acts again; before the hour it acted at once.
  const after=settlePosition(s,p.id,riskFor(s.positions[0],now,{funding:[{t:ft,rate:.001}]}),now);
  assert.equal(checkQuote(after,p.id,{price:97,mark:97.2,at:now+1000},now+2000).trades[0].reason,'stopp');
  assert.equal(checkQuote(s,p.id,{price:97,mark:97.2,at:ft-20000},ft-10000).trades[0].reason,'stopp');
});

test('accountLive values positions at the quote and withholds equity while a quote is stale',()=>{
  const {account:a,position:p}=open(tenX()),now=T+6000,q={price:101,mark:101.2,at:T+5000};
  const live=accountLive(a,{BTC:q},now),row=live.positions[0],exit=101*(1-SLIP),value=p.margin+(exit-p.entry)*p.units-p.units*exit*FEE;
  near(live.equity,a.cash+value);near(row.value,value);near(row.pnl,value-p.margin-p.fees);near(row.pnlPct,(value-p.margin-p.fees)/p.margin);
  near(live.openPnl,row.pnl);near(live.marginUsed,p.margin);assert.equal(live.cash,a.cash);assert.deepEqual(live.waiting,[]);assert.equal(live.at,q.at);
  assert.equal(live.reason,'');assert.equal(row.price,101);assert.equal(row.mark,101.2);assert.equal(row.id,p.id);
  near(row.toLiq,(101.2-p.liq)/101.2);near(row.toSl,(101-98)/101);near(row.toTp,(104-101)/101);
  for(const quotes of [{BTC:{...q,at:now-ACCOUNT.quoteTtl-1}},{},null,{BTC:{...q,price:NaN}}]){
    const stale=accountLive(a,quotes,now);
    assert.equal(stale.equity,null);assert.equal(stale.openPnl,null);assert.equal(stale.at,null);assert.deepEqual(stale.waiting,['BTC']);
    assert.equal(stale.positions[0].price,null);assert.equal(stale.positions[0].pnl,null);assert.match(stale.reason,/Väntar på färskt pris för BTC/);
    assert.equal(stale.cash,a.cash);near(stale.marginUsed,p.margin);
  }
  const unsettled=accountLive(a,{BTC:{...q,at:T+200000}},T+200000);
  assert.equal(unsettled.equity,null);assert.match(unsettled.reason,/likvidationskontroll/);assert.equal(unsettled.positions[0].price,101);
  // A mark through the liquidation level is worth nothing.
  assert.equal(accountLive(a,{BTC:{price:90,mark:p.liq-.01,at:q.at}},now).positions[0].value,0);
  const empty=accountLive(newForecastAccount(T),{},T);
  assert.deepEqual([empty.equity,empty.openPnl,empty.marginUsed,empty.at,empty.waiting],[100,0,0,null,[]]);
});

test('accountStats measures win rate, profit factor and drawdown on realized equity',()=>{
  const a=newForecastAccount(T-10*HOUR),pnls=[[10,'mål'],[-5,'stopp'],[20,'mål'],[-10.1,'likvidation'],[-4.9,'tid']];
  let equity=a.start;
  a.trades=pnls.map(([pnl,reason],i)=>{equity+=pnl;return {id:'p|s'+i,symbol:SYMBOLS[i],side:i%2?'short':'long',signalId:'s'+i,tf:'1h',entry:100,exit:100+pnl/10,
    units:1,margin:10,leverage:10,openedAt:T+i*HOUR,closedAt:T+i*HOUR+60000,reason,pnl,fees:.1,funding:.01,equityAfter:equity};});
  a.cash=equity;a.fees=.5;a.funding=.05;
  const s=accountStats(validateForecastAccount(a));
  assert.deepEqual([s.trades,s.wins,s.losses,s.liquidations,s.open],[5,2,3,1,0]);
  near(s.winRate,.4);near(s.net,10);near(s.profitFactor,30/20);near(s.fees,.5);near(s.funding,.05);
  // Peak 125 after the third trade, trough 110 after the fifth.
  near(s.maxDrawdown,15/125);assert.equal(s.best,20);assert.equal(s.worst,-10.1);
  const none=accountStats(newForecastAccount(T));
  assert.deepEqual([none.trades,none.winRate,none.profitFactor,none.maxDrawdown,none.best,none.worst,none.net],[0,null,null,0,null,null,0]);
  const onlyWins=structuredClone(a);onlyWins.trades=a.trades.filter(t=>t.pnl>0).map((t,i)=>({...t,equityAfter:i?130:110}));onlyWins.cash=130;onlyWins.fees=.2;onlyWins.funding=.02;
  const w=accountStats(onlyWins);assert.equal(w.profitFactor,null);assert.equal(w.winRate,1);assert.equal(w.maxDrawdown,0);
});

test('settlement refuses missing or broken price history instead of guessing',()=>{
  const {account:a,position:p}=open(tenX()),now=T+HOUR,good=riskFor(p,now);
  assert.throws(()=>settlePosition(a,p.id,{...good,lastBars:good.lastBars.filter(b=>b.t!==T+30*60000)},now),/Lucka i 5-minuterspriserna för BTC/);
  assert.throws(()=>settlePosition(a,p.id,{...good,markBars:good.markBars.filter(b=>b.t!==now)},now),/Lucka/);
  assert.throws(()=>settlePosition(a,p.id,{...good,fundingThrough:now-200000},now),/fundinghistorik saknas för BTC/);
  assert.throws(()=>settlePosition(a,p.id,{...good,historyFrom:p.nextBar+STEP},now),/saknas/);
  assert.throws(()=>settlePosition(a,p.id,null,now),/saknas/);
  assert.throws(()=>settlePosition(a,p.id,{...good,markBars:[...good.markBars.slice(0,-1),{t:now,o:100,h:99,l:100,c:100}]},now),/Ogiltiga 5-minuterspriser/);
  assert.throws(()=>settlePosition(a,p.id,{...good,funding:[{t:now-STEP,rate:.001},{t:now-2*STEP,rate:.001}]},now),/Ogiltig fundinghistorik/);
  assert.throws(()=>settlePosition(a,p.id,good,p.openedAt-1),/Ogiltig tid/);
  const gone=settlePosition(a,'saknas',null,now);assert.deepEqual(gone,a);assert.notEqual(gone,a);
});

test('settings are validated, only affect future entries, and a new timeframe forgets old bar times',()=>{
  const {account:a,position:p}=open(newForecastAccount(T-HOUR));
  const b=updateSettings(a,{leverage:5,maxOpen:4,symbols:['ETH','BTC']});
  assert.deepEqual(b.settings,{...a.settings,leverage:5,maxOpen:4,symbols:['BTC','ETH']});assert.deepEqual(b.positions,a.positions);
  assert.equal(a.settings.leverage,'max');assert.equal(p.leverage,150);
  assert.equal(open(b,{sig:signal({symbol:'ETH'}),symbol:'ETH'}).position.leverage,5);
  // Lowering maxOpen below the open count keeps the open positions.
  assert.equal(updateSettings(b,{maxOpen:1}).positions.length,1);
  for(const [patch,reason] of [[{positionPct:0},/Positionsstorleken ska vara 1 %–100 %/],[{riskPct:2},/Risken per affär/],[{maxOpen:8},/Max öppna positioner ska vara 1–7/],
    [{maxOpen:2.5},/Max öppna/],[{leverage:.5},/Hävstången/],[{leverage:'mycket'},/Hävstången/],[{symbols:[]},/minst ett par/],[{symbols:['BTC','LUNA']},/par/],
    [{tf:'1w'},/tidsram/],[{paused:'ja'},/pausläge/],[{färg:'röd'},/Okänd inställning: färg/],[null,/inställningar/]])
    assert.throws(()=>updateSettings(a,patch),reason);
  assert.throws(()=>setPaused(a,'ja'),/pausläge/);
  const paused=setPaused(a,true);assert.equal(paused.settings.paused,true);assert.equal(setPaused(paused,false).settings.paused,false);
  const marked=markProcessed(a,'BTC',T);assert.equal(marked.processed.BTC,T);
  assert.equal(markProcessed(marked,'BTC',T-HOUR).processed.BTC,T);
  assert.throws(()=>markProcessed(a,'LUNA',T),/bearbetningsmarkering/);
  assert.deepEqual(updateSettings(marked,{tf:'15m'}).processed,{});
  assert.deepEqual(updateSettings(marked,{maxOpen:2}).processed,{BTC:T});
});

test('validation rejects corrupted or inconsistent accounts',()=>{
  const {account:a}=open(tenX());
  const closed=closePosition(a,a.positions[0].id,{price:101,now:T+5000,reason:'manuell'});
  const both=open(closed,{sig:signal({symbol:'ETH'}),symbol:'ETH',now:T+6000}).account;
  assert.equal(both.positions.length,1);assert.equal(both.trades.length,1);
  const broken=f=>{const x=structuredClone(both);f(x);return x;};
  const cases=[
    [x=>{x.cash+=1;},/kassa stämmer inte/],
    [x=>{x.cash=-1;},/Ogiltigt AI Forecast-konto/],
    [x=>{x.fees+=.5;},/kassa stämmer inte/],
    [x=>{x.funding=1;},/kassa stämmer inte/],
    [x=>{x.trades[0].pnl+=1;},/kassa stämmer inte/],
    [x=>{x.positions[0].liq*=.9;},/Likvidationsnivån för ETH/],
    [x=>{x.positions[0].margin-=1;},/Likvidationsnivån/],
    [x=>{x.positions[0].symbol='LUNA';},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].units=NaN;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].sl=x.positions[0].tp;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].nextBar+=1;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].maintenance=1;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions.push({...x.positions[0],id:'p|annan',signalId:'annan'});},/en position per par/],
    [x=>{x.positions[0].signalId=x.trades[0].signalId;},/handlad två gånger/],
    [x=>{x.trades[0].reason='panik';},/Ogiltig AI Forecast-affär/],
    [x=>{x.trades[0].pnl=-1000;},/Ogiltig AI Forecast-affär/],
    [x=>{x.trades[0].closedAt=x.trades[0].openedAt-1;},/Ogiltig AI Forecast-affär/],
    [x=>{x.settings.positionPct=2;},/Positionsstorleken/],
    [x=>{x.settings.extra=1;},/inställningar/],
    [x=>{delete x.settings.paused;},/inställningar/],
    [x=>{x.processed={LUNA:T};},/bearbetningsmarkering/],
    [x=>{x.processed={BTC:-5};},/bearbetningsmarkering/],
    [x=>{x.processed=[];},/Ogiltigt AI Forecast-konto/],
    [x=>{x.log[0].kind='hack';},/logg/],
    [x=>{x.log[0].symbol='LUNA';},/logg/],
    [x=>{x.version='ai-forecast-account-v3';},/annan version \(ai-forecast-account-v3\)\. Ladda om sidan/],
    [x=>{x.version='trading-floor-v3';},/Ogiltigt AI Forecast-konto/],
    [x=>{delete x.positions;},/Ogiltigt AI Forecast-konto/],
    [x=>{x.createdAt=0;},/Ogiltigt AI Forecast-konto/],
    // Version 2: origins, the moment the levels took effect, the auto-trading switch and the transfers.
    [x=>{delete x.settings.auto;},/inställningar/],
    [x=>{x.settings.auto='ja';},/auto-handel/],
    [x=>{x.positions[0].origin='robot';},/Ogiltig AI Forecast-position/],
    [x=>{delete x.positions[0].levelsAt;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].levelsAt=x.positions[0].openedAt-1;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].levelsAt=x.positions[0].nextBar;},/Ogiltig AI Forecast-position/],
    // A signal position keeps its signal's stop, target and time stop; only a manual one may lack them.
    [x=>{x.positions[0].sl=null;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].deadline=null;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].signalId=null;},/Ogiltig AI Forecast-position/],
    [x=>{x.positions[0].origin='manual';x.positions[0].tp=x.positions[0].sl;},/Ogiltig AI Forecast-position/],
    [x=>{x.trades[0].origin='robot';},/Ogiltig AI Forecast-affär/],
    [x=>{x.trades[0].signalId=null;},/Ogiltig AI Forecast-affär/],
    [x=>{x.transfers=[{id:'t|1',t:T,kind:'in',amount:5,cashAfter:105,tradeCount:0}];},/kassa stämmer inte/],
    [x=>{x.transfers={};},/Ogiltigt AI Forecast-konto/]
  ];
  for(const [corrupt,reason] of cases)assert.throws(()=>validateForecastAccount(broken(corrupt)),reason);
  for(const value of [null,undefined,42,'konto',[]])assert.throws(()=>validateForecastAccount(value),/Ogiltigt AI Forecast-konto/);
  assert.equal(validateForecastAccount(JSON.parse(JSON.stringify(both))).positions[0].symbol,'ETH');
  // A converted signal position (manual, without a time stop, its signal's id and timeframe kept) is valid.
  const manual=broken(x=>{Object.assign(x.positions[0],{origin:'manual',deadline:null,sl:null});});
  assert.equal(validateForecastAccount(manual),manual);
  // Every function checks the account it is given.
  const bad=broken(x=>{x.cash+=1;}),q={price:100,mark:100,at:T},id=bad.positions[0].id;
  for(const run of [()=>open(bad),()=>settlePosition(bad,'x',null,T),()=>checkQuote(bad,'x',null,T),()=>closePosition(bad,'x',{price:1,now:T,reason:'manuell'}),
    ()=>accountLive(bad,{},T),()=>accountStats(bad),()=>updateSettings(bad,{}),()=>markProcessed(bad,'BTC',T),()=>setAuto(bad,true),()=>migrateForecastAccount(bad),
    ()=>previewOrder(bad,{symbol:'BTC',side:'long',margin:10,leverage:10,quote:q,contract:null,now:T}),()=>openManual(bad,{now:T}),
    ()=>previewLevels(bad,id,{sl:99},{quote:q,now:T}),()=>setLevels(bad,id,{sl:99},{quote:q,now:T}),()=>deposit(bad,5,T),()=>withdraw(bad,5,T),()=>setFree(bad,5,T)])
    assert.throws(run,/kassa stämmer inte/);
});

test('no function mutates its inputs and every result is a new object',()=>{
  const a0=deepFreeze(tenX()),sig=deepFreeze(signal()),c=deepFreeze(limits('BTC',T+1000)),q=deepFreeze({price:100,mark:100,at:T+1000});
  const opened=openPosition(a0,{signal:sig,symbol:'BTC',quote:q,contract:c,now:T+1000,tfMs:HOUR,dataReliable:true});
  assert.equal(opened.opened,true);assert.notEqual(opened.account,a0);
  const a=deepFreeze(opened.account),copy=structuredClone(a),p=a.positions[0];
  const ft=T+HOUR,now=ft+STEP+1000,risk=deepFreeze(riskFor(p,now,{funding:[{t:ft,rate:.001}],lasts:{[ft+STEP]:{l:97}}}));
  const results=[
    openPosition(a,{signal:sig,symbol:'BTC',quote:q,contract:c,now:T+1000,tfMs:HOUR,dataReliable:false}).account,
    openPosition(a,{signal:deepFreeze(signal({symbol:'ETH'})),symbol:'ETH',quote:q,contract:deepFreeze(limits('ETH',T+1000)),now:T+1000,tfMs:HOUR,dataReliable:true}).account,
    settlePosition(a,p.id,risk,now),settlePosition(a,p.id,deepFreeze(riskFor(p,ft)),ft),
    checkQuote(a,p.id,deepFreeze({price:97,mark:97,at:T+2000}),T+3000),checkQuote(a,p.id,q,T+3000),
    closePosition(a,p.id,deepFreeze({price:101,now:T+3000,reason:'manuell'})),
    updateSettings(a,deepFreeze({maxOpen:4,symbols:['BTC']})),setPaused(a,true),markProcessed(a,'BTC',T),setAuto(a,true),
    openManual(a,deepFreeze({symbol:'ETH',side:'short',margin:5,leverage:5,tp:95,quote:q,contract:deepFreeze(bybitLimits('ETH',T+1000)),now:T+1000})).account,
    setLevels(a,p.id,deepFreeze({sl:99,tp:null}),deepFreeze({quote:{price:100,mark:100,at:T+2000},contract:bybitLimits('BTC',T+1000),now:T+2000})).account,
    deposit(a,5,T+3000),withdraw(a,5,T+3000),setFree(a,50,T+3000)
  ];
  for(const r of results){assert.notEqual(r,a);assert.equal(validateForecastAccount(r),r);}
  assert.equal(results[2].trades[0].reason,'stopp');near(results[2].funding,p.units*100*.001);
  assert.equal(results[11].positions[1].origin,'manual');assert.equal(results[12].positions[0].sl,99);
  sizePosition(deepFreeze({equity:100,cash:100,settings:a.settings,contract:c,side:'long',price:100,mark:100,sl:98,now:T+1000}));
  accountLive(a,deepFreeze({BTC:q}),T+3000);accountStats(a);
  previewOrder(a,deepFreeze({symbol:'ETH',side:'long',margin:5,leverage:5,quote:q,contract:deepFreeze(bybitLimits('ETH',T+1000)),now:T+1000}));
  previewLevels(a,p.id,deepFreeze({sl:99}),deepFreeze({quote:q,contract:c,now:T+1000}));
  assert.deepEqual(a,copy);assert.deepEqual(a0,tenX());
});

test('an entry needs a price read after the signal\'s candle closed',()=>{
  const base=newForecastAccount(T-HOUR),sig=signal();
  // Four seconds before the close the quote is fresh by age, but the signal did not exist yet.
  const early=open(base,{quoteAt:T-4000,now:T+1000});
  assert.equal(early.opened,false);assert.equal(early.reason,'Färskt pris efter signalen saknas för BTC');
  assert.deepEqual(early.account.log.at(-1),{t:T+1000,kind:'avvisad',symbol:'BTC',signalId:sig.id,text:early.reason});
  assert.deepEqual(early.account.positions,[]);assert.equal(early.account.cash,100);
  // A price read at the close itself may fill the entry.
  assert.equal(open(base,{quoteAt:T,now:T+1000}).opened,true);
});

test('from the deadline on a live quote cannot decide the trade; it ends at the deadline candle\'s open, as a replay records it',()=>{
  const sig=signal({tf:'5m'}),{account:a,position:p}=open(tenX({tf:'5m'}),{sig});
  // Settled ten seconds before the deadline, so the quote checks are otherwise allowed.
  const before=p.deadline-10000,s=settlePosition(a,p.id,riskFor(p,before,{price:101}),before),q=s.positions[0];
  assert.equal(s.positions.length,1);
  assert.equal(checkQuote(s,p.id,{price:104.5,mark:104.5,at:before+1000},before+2000).trades[0].reason,'mål');
  const unchanged=x=>{assert.deepEqual(x,s);assert.notEqual(x,s);};
  for(const [price,mark] of [[104.5,104.5],[97,97],[90,q.liq-.01]]){
    unchanged(checkQuote(s,p.id,{price,mark,at:p.deadline+20000},p.deadline+21000));
    // A quote read just before the deadline but checked after it also waits for the settlement.
    unchanged(checkQuote(s,p.id,{price,mark,at:p.deadline-1000},p.deadline+1000));
  }
  const now=p.deadline+21000,t=settlePosition(s,p.id,riskFor(q,now,{price:101,lasts:{[p.deadline]:{h:104.5}}}),now).trades[0];
  assert.equal(t.reason,'tid');assert.equal(t.closedAt,p.deadline);near(t.exit,101*(1-SLIP));
});

test('a side is long or short, never an inherited property name',()=>{
  const {account:a}=open(tenX()),closed=closePosition(a,a.positions[0].id,{price:101,now:T+5000,reason:'manuell'});
  for(const side of ['__proto__','constructor','toString']){
    const x=structuredClone(a),p=x.positions[0];p.side=side;
    // Even with a liquidation level computed for that side the record is refused.
    p.liq=isolatedLevel(side,p.entry,p.margin+p.fees,p.units,FEE,p);
    assert.throws(()=>validateForecastAccount(x),/Ogiltig AI Forecast-position/,side);
    const y=structuredClone(closed);y.trades[0].side=side;
    assert.throws(()=>validateForecastAccount(y),/Ogiltig AI Forecast-affär/,side);
    assert.equal(sizePosition({equity:100,cash:100,settings:a.settings,contract:limits(),side,price:100,mark:100,sl:98,now:T}).reason,'Ogiltig riktning',side);
    assert.equal(open(newForecastAccount(T-HOUR),{sig:{...signal(),side}}).reason,'Ogiltig signal för BTC',side);
  }
});

test('settling every 100 s or once after a long absence books the same trade',()=>{
  // A deterministic random walk of 5-minute candles with funding every 40 minutes.
  let seed=7;const rnd=()=>(seed=seed*16807%2147483647)/2147483647,reasons=new Set();
  for(const [side,leverage,risk] of [['long',10,1.2],['short',10,1.2],['long','max',1.2],['short',3,.6],['long',3,.6],['short','max',1.2],['long',5,.6],['short',5,.6]]){
    const dir=side==='long'?1:-1,sig=signal({tf:'5m',side,sl:100-dir*risk,tp:100+dir*risk*1.2});
    const {account:a,position:p}=open(newForecastAccount(T-HOUR,{tf:'5m',leverage,positionPct:.2,riskPct:1}),{sig});
    const bars=[];let px=100;
    for(let t=T;t<T+40*STEP;t+=STEP){const o=px,c=o*(1+(rnd()-.5)*.006);bars.push({t,o,h:Math.max(o,c)*(1+rnd()*.002),l:Math.min(o,c)*(1-rnd()*.002),c});px=c;}
    const funding=bars.filter((b,i)=>i%8===3).map(b=>({t:b.t,rate:(rnd()-.3)*.002}));
    // fetchPositionRisk at `now`: the forming candle has shown only its open so far, and the
    // funding history may lag `now` (by up to 90 s here), so a just-passed event arrives next time.
    const riskAt=(q,now,lag=0)=>{
      const cur=Math.floor(now/STEP)*STEP,from=Math.min(q.nextBar,Math.floor(q.fundingThrough/STEP)*STEP),through=Math.max(q.fundingThrough,now-lag);
      const seen=bars.filter(b=>b.t>=from&&b.t<=cur).map(b=>b.t<cur?b:{t:b.t,o:b.o,h:b.o,l:b.o,c:b.o}),minutes=[];
      for(let t=Math.ceil(q.openedAt/MIN)*MIN;t<T+STEP&&t<=now;t+=MIN)minutes.push({t,o:bars[0].o,h:bars[0].o,l:bars[0].o,c:bars[0].o});
      return {price:seen.at(-1).o,mark:seen.at(-1).o,at:now,markBars:seen,lastBars:seen,minuteMarks:minutes,minuteLasts:minutes,funding:funding.filter(f=>f.t<=through),fundingThrough:through,historyFrom:from};
    };
    const end=T+30*STEP+1000,once=settlePosition(a,p.id,riskAt(p,end),end);
    let often=a;
    for(let now=T+2000;now<end&&often.positions.length;now+=STEP/3)often=settlePosition(often,p.id,riskAt(often.positions[0],now,90000),now);
    if(often.positions.length)often=settlePosition(often,p.id,riskAt(often.positions[0],end),end);
    assert.equal(once.trades.length,1,side+' '+leverage);reasons.add(once.trades[0].reason);
    assert.deepEqual(often,once,side+' '+leverage);
  }
  assert.deepEqual([...reasons].sort(),['likvidation','mål','stopp','tid']);
});

test('a manual position without a time stop or a target: settling every 100 s or once after a long absence books the same trade, also after a change of its stop',()=>{
  let seed=11;const rnd=()=>(seed=seed*16807%2147483647)/2147483647,reasons=new Set();
  for(const [side,leverage,stop] of [['long',10,1.6],['short',10,1.6],['long',3,2.5],['short',3,2.5],['long',100,null],['short',100,null],['long',5,1],['short',5,1]]){
    const dir=side==='long'?1:-1,c=bybitLimits('BTC',T+1000),sl=stop===null?null:100-dir*stop;
    const {account:a,position:p}=order(newForecastAccount(T-HOUR),{side,leverage,margin:20,sl,quote:btcQuote(T+1000,100)});
    assert.deepEqual([p.deadline,p.tp],[null,null]);
    // 60 five-minute candles (beyond 20 hourly candles' worth of steps would be 240; the time stop is absent either way), funding every 40 minutes.
    const bars=[];let px=100;
    for(let t=T;t<T+60*STEP;t+=STEP){const o=px,cl=o*(1+(rnd()-.5)*.008);bars.push({t,o,h:Math.max(o,cl)*(1+rnd()*.002),l:Math.min(o,cl)*(1-rnd()*.002),c:cl});px=cl;}
    const funding=bars.filter((b,i)=>i%8===3).map(b=>({t:b.t,rate:(rnd()-.3)*.002}));
    const riskAt=(q,now,lag=0)=>{
      const cur=Math.floor(now/STEP)*STEP,from=Math.min(q.nextBar,Math.floor(q.fundingThrough/STEP)*STEP),through=Math.max(q.fundingThrough,now-lag);
      const seen=bars.filter(b=>b.t>=from&&b.t<=cur).map(b=>b.t<cur?b:{t:b.t,o:b.o,h:b.o,l:b.o,c:b.o}),marks=[],lasts=[];
      // Mark minutes from the minute after the open, last-price minutes from the minute after the open or the change.
      const since=Math.max(q.openedAt,q.levelsAt),first=(Math.floor(since/STEP)+1)*STEP;
      for(let t=Math.max(first-STEP,Math.ceil(q.openedAt/MIN)*MIN);t<first&&t<=now;t+=MIN){
        const b=bars.find(x=>x.t===Math.floor(t/STEP)*STEP),m={t,o:b.o,h:b.o,l:b.o,c:b.o};
        marks.push(m);if(t>=Math.ceil(since/MIN)*MIN)lasts.push(m);
      }
      return {price:seen.at(-1).o,mark:seen.at(-1).o,at:now,markBars:seen,lastBars:seen,minuteMarks:marks,minuteLasts:lasts,funding:funding.filter(f=>f.t<=through),fundingThrough:through,historyFrom:from};
    };
    const end=T+55*STEP+1000,once=settlePosition(a,p.id,riskAt(p,end),end);
    let often=a;
    for(let now=T+2000;now<end&&often.positions.length;now+=STEP/3)often=settlePosition(often,p.id,riskAt(often.positions[0],now,90000),now);
    if(often.positions.length)often=settlePosition(often,p.id,riskAt(often.positions[0],end),end);
    assert.deepEqual(often,once,side+' '+leverage);
    for(const t of once.trades)reasons.add(t.reason);
    // The same after a change of the stop at 10:30:30: settled then, changed, then often or once to the end.
    const mid=T+6*STEP+30000,held=settlePosition(a,p.id,riskAt(p,mid),mid);
    if(!held.positions.length)continue;
    const price=bars.find(b=>b.t===Math.floor(mid/STEP)*STEP).o,moved=setLevels(held,p.id,{sl:price*(1-dir*.004)},{quote:{price,mark:price,at:mid},contract:{...c,at:mid},now:mid});
    assert.equal(moved.ok,true,moved.reason);
    const later=settlePosition(moved.account,p.id,riskAt(moved.account.positions[0],end),end);
    let step=moved.account;
    for(let now=mid+2000;now<end&&step.positions.length;now+=STEP/3)step=settlePosition(step,p.id,riskAt(step.positions[0],now,90000),now);
    if(step.positions.length)step=settlePosition(step,p.id,riskAt(step.positions[0],end),end);
    assert.deepEqual(step,later,'after the change '+side+' '+leverage);
    for(const t of later.trades)reasons.add(t.reason);
  }
  assert.ok(reasons.has('stopp')&&reasons.has('likvidation'),[...reasons].join());
});

test('per-token SHIB and PEPE prices size, settle and close like any other coin',()=>{
  const px=.000011873,sig=signal({symbol:'PEPE',entry:px,sl:px*.98,tp:px*1.04});
  const {account:a,position:p,opened}=open(newForecastAccount(T-HOUR),{sig,price:px});
  assert.equal(opened,true);assert.equal(p.leverage,150);near(p.margin,10/(1+150*FEE));near(p.units*p.entry,1500/(1+150*FEE));near(p.margin+p.fees,10);
  near(p.liq,isolatedLevel('long',p.entry,p.margin+p.fees,p.units,FEE,p),1e-12);assert.ok(p.liq<p.entry&&p.liq>p.sl);
  const now=T+HOUR+STEP+1000,s=settlePosition(a,p.id,riskFor(p,now,{price:px,funding:[{t:T+HOUR,rate:.0001}]}),now),q=s.positions[0];
  near(q.funding,p.units*px*.0001);assert.ok(q.liq>p.liq);
  const c=closePosition(s,p.id,{price:px*1.01,now,reason:'manuell'}),t=c.trades[0],exit=px*1.01*(1-SLIP);
  near(t.pnl,q.margin+(exit-p.entry)*p.units-p.units*exit*FEE-p.margin-p.fees);near(c.cash,100+t.pnl);
  assert.deepEqual(validateForecastAccount(JSON.parse(JSON.stringify(c))),c);
});

test('a liquidation costs the margin and the opening fee, nothing more, and the mark decides it',()=>{
  const {account:a,position:p}=open(newForecastAccount(T-HOUR)),bar=T+HOUR,now=bar+STEP+1000;
  for(const done of [settlePosition(a,p.id,riskFor(p,now,{marks:{[bar]:{l:p.liq-.01}}}),now),checkQuote(a,p.id,{price:99.9,mark:p.liq-.01,at:T+5000},T+6000)]){
    const t=done.trades[0];
    assert.equal(t.reason,'likvidation');near(t.fees,p.fees);near(done.fees,a.fees);near(t.pnl,-(p.margin+p.fees));near(done.cash,a.cash);
  }
  // A last price above the entry does not help once the mark is through the level.
  assert.equal(accountLive(a,{BTC:{price:100.3,mark:p.liq-.01,at:T+5000}},T+6000).positions[0].value,0);
});

test('inside one candle a mark through liquidation beats a gap through the stop at the open, as the spec orders them',()=>{
  const bar=T+HOUR,now=bar+STEP+1000;
  for(const side of ['long','short']){
    const dir=side==='long'?1:-1,{account:a,position:p}=open(tenX(),{sig:signal({side})});
    const last=dir>0?{o:97,l:96.5}:{o:103,h:103.5},mark=dir>0?{o:99,l:p.liq-.5}:{o:101,h:p.liq+.5};
    const t=settlePosition(a,p.id,riskFor(p,now,{marks:{[bar]:mark},lasts:{[bar]:last}}),now).trades[0];
    assert.equal(t.reason,'likvidation',side);near(t.exit,p.liq);assert.equal(t.closedAt,bar+STEP);
  }
});

test('Bybit\'s risk tier is read at the mark when the mark is above the fill',()=>{
  const TIERED=[{id:1,cap:1000,max:150,maintenance:.005,deduction:0},{id:2,cap:100000,max:50,maintenance:.01,deduction:5}];
  const settings={...newForecastAccount(T).settings,riskPct:1,positionPct:.2};
  const size=mark=>sizePosition({equity:100,cash:100,settings,contract:limits('BTC',T,TIERED),side:'long',price:100,mark,sl:98,now:T});
  // 1 000 $ of notional fills tier 1 exactly at the fill, but is 1 009 $ at a mark of 101.
  const flat=size(100),marked=size(101);
  assert.deepEqual([flat.leverage,flat.riskId,flat.maintenance],[50,1,.005]);near(flat.notional,1000);
  assert.deepEqual([marked.leverage,marked.riskId,marked.maintenance,marked.deduction],[50,2,.01,5]);near(marked.notional,1000);
  near(marked.liq,isolatedLevel('long',marked.fill,marked.margin+marked.openFee,marked.units,FEE,TIERED[1]));
});

test('drawdown counts a losing first trade from the 100 $ start',()=>{
  const a=newForecastAccount(T-10*HOUR);
  a.trades=[[-10,90],[5,95]].map(([pnl,equityAfter],i)=>({id:'p|s'+i,symbol:SYMBOLS[i],side:'long',signalId:'s'+i,tf:'1h',entry:100,exit:100+pnl/10,
    units:1,margin:20,leverage:5,openedAt:T+i*HOUR,closedAt:T+i*HOUR+60000,reason:pnl<0?'stopp':'mål',pnl,fees:0,funding:0,equityAfter}));
  a.cash=95;
  near(accountStats(validateForecastAccount(a)).maxDrawdown,.1);
});

test('settlement refuses a risk snapshot that is more than two minutes old or from the future',()=>{
  const {account:a,position:p}=open(tenX()),now=T+HOUR,good=riskFor(p,now);
  assert.equal(settlePosition(a,p.id,{...good,at:now-110000},now).positions.length,1);
  for(const at of [now-200000,now+6000])assert.throws(()=>settlePosition(a,p.id,{...good,at},now),/fundinghistorik saknas för BTC/);
});

// ---- Version 2: the migration, manual orders, their stop and target, and deposits and withdrawals ------------------

// A version 1 account exactly as the released module (commit 4073766) stored it: a closed BTC trade, an open ETH short
// that has received one funding, a refusal in the log, and the decided candles.
const V1_ACCOUNT='{"version":"ai-forecast-account-v1","createdAt":1791190800000,"start":100,"cash":81.149954772009,"settings":{"tf":"1h","symbols":["BTC","ETH"],"positionPct":0.2,"riskPct":1,"maxOpen":3,"leverage":10,"paused":false},"positions":[{"id":"p|s|u1|ETH|1h|1791194400000|af-signal-v1","symbol":"ETH","side":"short","signalId":"s|u1|ETH|1h|1791194400000|af-signal-v1","tf":"1h","entry":49.975,"units":4.0651170382792605,"margin":20.335747983992,"leverage":10,"maintenance":0.005,"deduction":0,"riskId":1,"sl":51,"tp":48,"liq":54.67405897270151,"openedAt":1791198002000,"deadline":1791270000000,"fees":0.11173482319340333,"funding":-0.020325585191396305,"nextBar":1791201900000,"fundingThrough":1791201901000,"equityAtOpen":101.577111994003}],"trades":[{"id":"p|s|u1|BTC|1h|1791190800000|af-signal-v1","symbol":"BTC","side":"long","signalId":"s|u1|BTC|1h|1791190800000|af-signal-v1","tf":"1h","entry":100.05,"exit":100.9495,"units":1.999000499750125,"margin":20,"leverage":10,"openedAt":1791194401000,"closedAt":1791195600000,"reason":"manuell","pnl":1.577111994003004,"fees":0.2209889555222389,"funding":0,"equityAfter":101.577111994003}],"log":[{"t":1791194401000,"kind":"öppnad","symbol":"BTC","signalId":"s|u1|BTC|1h|1791190800000|af-signal-v1","text":"Öppnade lång BTC till 100,05 · 10× · marginal 20,00 $"},{"t":1791195600000,"kind":"stängd","symbol":"BTC","signalId":"s|u1|BTC|1h|1791190800000|af-signal-v1","text":"Stängd manuellt: lång BTC +1,58 $"},{"t":1791198002000,"kind":"öppnad","symbol":"ETH","signalId":"s|u1|ETH|1h|1791194400000|af-signal-v1","text":"Öppnade kort ETH till 49,975 · 10× · marginal 20,32 $"},{"t":1791198003000,"kind":"avvisad","symbol":"BTC","signalId":"s|u1|BTC|1h|1791194400000|af-signal-v1","text":"Marknadsdatan är inte tillförlitlig just nu — ingen ny affär"}],"processed":{"BTC":1791194400000,"ETH":1791194400000},"fees":0.33272377871564224,"funding":-0.020325585191396305}';
const money2=x=>x.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2});
const sv=(x,d)=>x.toLocaleString('sv-SE',{maximumFractionDigits:d});
const svPrice=x=>x.toLocaleString('sv-SE',{maximumSignificantDigits:6});
// A fill, a price or a liquidation in a manual order's texts: all of the tick's decimals.
const fx=(x,d)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d});
const PRICES=Object.freeze({BTC:60000,ETH:3000,SOL:150,XRP:.6,DOGE:.2,SHIB:.000012,PEPE:.00001});

test('a version 1 account is read as version 2 under the same key without losing a position, a trade or its history, and the migration is pure',()=>{
  const v1=deepFreeze(JSON.parse(V1_ACCOUNT)),storage=memoryStorage(),key=accountKey('u1');
  // The released format still validates as what it is.
  assert.equal(validateForecastAccount(v1),v1);
  storage.setItem(key,V1_ACCOUNT);
  const a=readForecastAccount(storage,key,T+3*HOUR);
  assert.equal(storage.getItem(key),V1_ACCOUNT,'reading writes nothing');
  assert.equal(a.version,'ai-forecast-account-v2');
  // Auto-trading off, every position and trade from a signal, the levels in effect since the opening, no transfers.
  assert.deepEqual(a.settings,{...v1.settings,auto:false});
  assert.deepEqual(a.positions,v1.positions.map(p=>({...p,origin:'signal',levelsAt:p.openedAt})));
  assert.deepEqual(a.trades,v1.trades.map(t=>({...t,origin:'signal'})));
  assert.deepEqual(a.transfers,[]);
  // Nothing else changes: cash, fees, funding, the log and the decided candles.
  const rest=({version,settings,positions,trades,transfers,...x})=>x;
  assert.deepEqual(rest(a),rest(v1));
  assert.deepEqual(migrateForecastAccount(v1),a);assert.deepEqual(JSON.parse(V1_ACCOUNT),v1,'the input is untouched');
  // Every function takes the old format and returns the new one; the migrated position settles and closes as before.
  const p=a.positions[0],now=p.fundingThrough+STEP;
  const settled=settlePosition(v1,p.id,riskFor(p,now,{price:50}),now);
  assert.deepEqual([settled.version,settled.positions[0].fundingThrough,settled.positions[0].nextBar],['ai-forecast-account-v2',now,Math.floor(now/STEP)*STEP]);
  const closed=closePosition(v1,p.id,{price:49,now,reason:'manuell'}),t=closed.trades.at(-1),exit=49*(1+SLIP);
  near(t.pnl,p.margin+(p.entry-exit)*p.units-p.units*exit*FEE-(p.margin+p.funding)-p.fees);near(closed.cash,v1.cash+p.margin+(p.entry-exit)*p.units-p.units*exit*FEE);
  assert.deepEqual([t.origin,t.reason],['signal','manuell']);assert.match(closed.log.at(-1).text,/^Stängd manuellt: kort ETH \+\d+,\d\d \$$/);
  assert.equal(accountStats(v1).trades,1);assert.equal(accountLive(v1,{},now).netTransfers,0);
  // A version 1 account cannot hold what only version 2 knows.
  assert.throws(()=>validateForecastAccount({...v1,settings:{...v1.settings,auto:false}}),/inställningar/);
  const manual=structuredClone(v1);Object.assign(manual.positions[0],{origin:'manual',deadline:null});
  assert.throws(()=>validateForecastAccount(manual),/Ogiltig AI Forecast-position/);
  const moved=structuredClone(v1);moved.log.push({t:T,kind:'insättning',symbol:null,signalId:null,text:'Insättning 5,00 $'});
  assert.throws(()=>validateForecastAccount(moved),/logg/);
});

test('the backtest\'s ledger, version 2 without transfers or trade origins, validates; migrating it fills them in',()=>{
  const trades=JSON.parse(V1_ACCOUNT).trades,t=trades[0];
  const ledger={version:ACCOUNT.version,createdAt:T,start:100,cash:100+t.pnl,settings:newForecastAccount(T).settings,positions:[],trades,
    log:[],processed:{},fees:t.fees,funding:0};
  assert.equal(validateForecastAccount(ledger),ledger);
  const m=migrateForecastAccount(ledger);
  assert.deepEqual([m.transfers,m.trades.map(x=>x.origin),ledger.transfers,ledger.trades[0].origin],[[],['signal'],undefined,undefined]);
  // A complete version 2 account is returned as it is.
  assert.equal(migrateForecastAccount(m),m);
  assert.deepEqual(accountStats(ledger),accountStats(m));
});

// A manual BTC order at 60 000 $ with Bybit's real filters: 0,001 BTC steps and minimum, a 5 $ minimum value, a 0,1 $ tick.
const btcQuote=(at=T+1000,price=60000,mark=price)=>({price,mark,at});
const orderArgs=over=>({symbol:'BTC',side:'long',margin:10,leverage:10,quote:btcQuote(),contract:bybitLimits('BTC',T+1000),now:T+1000,...over});
const order=(a,over={})=>openManual(a,orderArgs(over));
const preview=(a,over={})=>previewOrder(a,orderArgs(over));

test('a market order fills as Bybit fills it: slippage, the quantity rounded down to Bybit\'s step, the margin from that quantity, Bybit\'s order cost and its isolated liquidation',()=>{
  const a=newForecastAccount(T-HOUR);
  for(const side of ['long','short']){
    const dir=side==='long'?1:-1,f=60000*(1+dir*SLIP),r=preview(a,{side});
    // 10 $ at 10× is 100 $ of value: 0,00166… BTC, rounded down to Bybit's step: 0,001 BTC.
    assert.deepEqual([r.ok,r.reasons,r.symbol,r.side,r.leverage,r.qty,r.price,r.mark],[true,[],'BTC',side,10,.001,60000,60000]);
    near(r.fill,f);near(r.value,.001*f);near(r.margin,.001*f/10);near(r.fee,.001*f*FEE);
    // Bybit's order cost: the margin, the fee to open and the fee to close, estimated at the bankruptcy price (1 ∓ 1/L).
    near(r.reserve,.001*f*(1-dir/10)*FEE);near(r.cost,r.margin+r.fee+r.reserve);
    near(r.liq,bybitIsolatedLevel(side,f,.001,10,{maintenance:.005,deduction:0}));
    assert.deepEqual([r.riskId,r.maintenance,r.deduction,r.maxLeverage,r.sl,r.tp],[1,.005,0,150,null,null]);
    assert.deepEqual(r.filters,filtersFor('BTC'));
    // The smallest stake that buys Bybit's minimum (0,001 BTC) at 10×, up to whole cents; the largest whose order cost fits 100 $.
    assert.equal(r.minMargin,Math.ceil(.001*f/10*100)/100);assert.equal(r.maxMargin,Math.floor(100/(1+10*FEE+(10-dir)*FEE)*100)/100);
    const o=order(a,{side});
    assert.deepEqual([o.ok,o.reason],[true,'']);
    assert.deepEqual(o.position,{id:'m|BTC|'+(T+1000),symbol:'BTC',side,signalId:null,tf:null,entry:r.fill,units:r.qty,margin:r.margin,leverage:10,maintenance:.005,
      deduction:0,riskId:1,sl:null,tp:null,liq:r.liq,openedAt:T+1000,deadline:null,fees:r.fee,reserve:r.reserve,funding:0,nextBar:T+STEP,fundingThrough:T+1000,
      equityAtOpen:100,origin:'manual',levelsAt:T+1000});
    assert.deepEqual(o.account.positions,[o.position]);
    near(o.account.cash,100-r.cost);near(o.account.fees,r.fee);
    assert.deepEqual(o.account.log,[{t:T+1000,kind:'öppnad',symbol:'BTC',signalId:null,
      text:'Öppnade '+(dir>0?'lång':'kort')+' 0,001 BTC till '+fx(f,1)+' · 10× · marginal '+money2(r.margin)+' $ (manuell)'}]);
    // At that price the margin balance, the fee to close aside, is Bybit's maintenance margin: Bybit holds the fee to close
    // in both, so it cancels.
    const p=o.position;near(p.margin+dir*(p.liq-p.entry)*p.units,p.liq*p.units*.005);
    // Closing it at once at the same price costs both fees and both slippages, nothing more: the fee to close comes back.
    const c=closePosition(o.account,p.id,{price:60000,now:T+2000,reason:'manuell'}),t=c.trades[0],exit=60000*(1-dir*SLIP);
    near(t.pnl,dir*(exit-p.entry)*p.units-p.units*exit*FEE-p.fees);near(c.cash,100+t.pnl);
    assert.deepEqual([t.origin,t.margin,t.reserve],['manual',p.margin,p.reserve]);
  }
  // A new order in the same coin and millisecond after a close gets its own id.
  const once=order(a),closed=closePosition(once.account,once.position.id,{price:60000,now:T+1000,reason:'manuell'});
  assert.equal(order(closed).position.id,'m|BTC|'+(T+1000)+'|2');
});

test('SHIB and PEPE quantities are counted in Bybit\'s units of 1000 tokens: whole steps of 10 000 SHIB or 100 000 PEPE, and prices round to the tick per token',()=>{
  const a=newForecastAccount(T-HOUR);
  const coin=(symbol,price,over={})=>({symbol,side:'long',margin:10,leverage:10,quote:{price,mark:price,at:T+1000},contract:bybitLimits(symbol,T+1000),now:T+1000,...over});
  const shib=previewOrder(a,coin('SHIB',.000012)),fill=.000012*(1+SLIP);
  // 100 $ of value is 8 329 169 SHIB, 832,9 of Bybit's steps of 10 × 1000 SHIB: rounded down to 8 320 000 SHIB.
  assert.equal(shib.qty,8320000);near(shib.value,8320000*fill);near(shib.margin,8320000*fill/10);
  assert.deepEqual([shib.filters.unit,shib.filters.qtyStep,shib.filters.minQty,shib.filters.maxMktQty,shib.filters.minNotional],[1000,10000,10000,15555000000,5]);
  near(shib.filters.tickSize,1e-9);
  // Bybit's 5 $ minimum value needs 416 459 SHIB, so 420 000 SHIB: 0,51 $ of stake at 10×.
  assert.equal(shib.minMargin,Math.ceil(420000*fill/10*100)/100);assert.equal(shib.minMargin,.51);
  const small=previewOrder(a,coin('SHIB',.000012,{margin:.4}));
  assert.deepEqual([small.qty,small.reasons],[330000,['Under Bybits minsta ordervärde (5,00 $)']]);
  // PEPE: 9 995 002 tokens of value, 99,95 steps of 100 × 1000 PEPE: 9 900 000 PEPE.
  const pepe=previewOrder(a,coin('PEPE',.00001));
  assert.equal(pepe.qty,9900000);assert.deepEqual([pepe.filters.qtyStep,pepe.filters.minQty],[100000,100000]);
  // 5 $ of PEPE is 499 750 tokens, 4,9975 steps: 400 000 PEPE is under Bybit's minimum value; 0,51 $ buys 500 000.
  const pepeSmall=previewOrder(a,coin('PEPE',.00001,{margin:.5}));
  assert.deepEqual([pepeSmall.qty,pepeSmall.reasons,pepeSmall.minMargin],[400000,['Under Bybits minsta ordervärde (5,00 $)'],.51]);
  assert.deepEqual([previewOrder(a,coin('PEPE',.00001,{margin:.51})).qty,previewOrder(a,coin('PEPE',.00001,{margin:.51})).ok],[500000,true]);
  // BTC's minimum is 0,001 BTC.
  assert.deepEqual(preview(a,{margin:5}).reasons,['Under Bybits minsta order (0,001 BTC)']);
  // A stop and a target round to the tick per token: 0,000000001 $ for SHIB.
  const lv=previewOrder(a,coin('SHIB',.000012,{sl:.0000115004,tp:.0000125006}));
  assert.equal(lv.ok,true);near(lv.sl,.0000115,1e-12);near(lv.tp,.000012501,1e-12);
  const opened=openManual(a,coin('SHIB',.000012));
  assert.equal(opened.account.log[0].text,'Öppnade lång '+sv(8320000,0)+' SHIB till '+svPrice(fill)+' · 10× · marginal '+money2(8320000*fill/10)+' $ (manuell)');
  assert.deepEqual([stepDecimals(.1),stepDecimals(10000),stepDecimals(1e-9),stepDecimals(.25),stepDecimals(.001)],[1,0,9,2,3]);
});

test('leverage: Bybit\'s step and minimum, and its maximum for the stake, which drops as the position value crosses a tier\'s cap',()=>{
  const a=deposit(newForecastAccount(T-HOUR),900,T),c=bybitLimits('BTC',T+1000,TIERED),fill=100*(1+SLIP);
  const at=(margin,leverage,over={})=>previewOrder(a,{symbol:'BTC',side:'long',margin,leverage,quote:{price:100,mark:100,at:T+1000},contract:c,now:T+1000,...over});
  // Tier 1 allows 150× up to 1 000 $ of value, tier 2 50× up to 100 000 $.
  assert.deepEqual([5,10,15,30,500].map(m=>at(m,1).maxLeverage),[150,100,66.66,50,50]);
  const over=at(10,150);
  assert.deepEqual([over.ok,over.maxLeverage,over.reasons],[false,100,['Bybits högsta hävstång för den här storleken är 100×']]);
  const top=at(10,100);
  assert.deepEqual([top.ok,top.leverage,top.riskId,top.maintenance],[true,100,1,.005]);assert.ok(top.value<=1000);
  assert.equal(at(10,25.555).leverage,25.55);
  assert.deepEqual(at(10,.5).reasons,['Bybits lägsta hävstång är 1×']);
  // Beyond tier 1's cap at 50×: tier 2, whose maintenance margin and deduction set the liquidation.
  const big=at(30,50);
  assert.deepEqual([big.ok,big.riskId,big.maintenance,big.deduction],[true,2,.01,5]);
  near(big.liq,bybitIsolatedLevel('long',fill,big.qty,50,TIERED[1]));
  // A mark above the fill counts toward the cap, as in maxLeverageFor.
  const marked=at(10,1,{quote:{price:100,mark:101,at:T+1000}});
  assert.equal(marked.maxLeverage,maxLeverageFor(c,10,{price:fill,mark:101},T+1000).leverage);assert.ok(marked.maxLeverage<100);
  // 3 000 $ fits tier 2 only up to 33,33×, and 1 499 BTC is beyond Bybit's largest market order: every reason is given.
  const huge=deposit(a,1e6,T),q={price:100,mark:100,at:T+1000};
  assert.deepEqual(previewOrder(huge,{symbol:'BTC',side:'long',margin:3000,leverage:50,quote:q,contract:c,now:T+1000}).reasons,
    ['Bybits högsta hävstång för den här storleken är 33,33×','Över Bybits största marknadsorder (150 BTC)']);
  // More than the largest tier holds even at 1×.
  const beyond=previewOrder(huge,{symbol:'BTC',side:'long',margin:2e5,leverage:1,quote:q,contract:c,now:T+1000});
  assert.deepEqual([beyond.maxLeverage,beyond.reasons],[null,['Positionen ryms inte inom Bybits risknivåer']]);
  // Without a stake: what can be worked out still is (the slider's maximum, the smallest and the largest stake).
  const blank=at(undefined,10);
  assert.deepEqual([blank.ok,blank.reasons,blank.maxLeverage,blank.minMargin,blank.maxMargin,blank.qty],[false,['Ange insatsen i $'],150,.51,989.65,null]);
});

test('Bybit\'s order cost must fit the free cash: the margin, the fee to open and the fee to close, which a short reserves more of; the largest stake offered fits it on its own side',()=>{
  const a=newForecastAccount(T-HOUR),c=bybitLimits('DOGE',T+1000,[{id:1,cap:1e7,max:75,maintenance:.01,deduction:0}],75),q={price:.2,mark:.2,at:T+1000};
  const doge=(margin,side='long',acc=a)=>previewOrder(acc,{symbol:'DOGE',side,margin,leverage:10,quote:q,contract:c,now:T+1000});
  // Per dollar of stake at 10×: 1 + 10 × 0,055 % to open + 9 × 0,055 % to close for a long, 11 × for a short.
  const max=doge(10).maxMargin,smax=doge(10,'short').maxMargin,fits=doge(max),sfits=doge(smax,'short'),over=doge(99.5);
  assert.deepEqual([max,smax],[Math.floor(100/(1+19*FEE)*100)/100,Math.floor(100/(1+21*FEE)*100)/100]);assert.deepEqual([max,smax],[98.96,98.85]);
  assert.deepEqual([fits.ok,fits.qty,sfits.ok],[true,4945,true]);assert.ok(fits.cost<=100&&sfits.cost<=100);
  near(fits.cost,fits.margin+fits.fee+fits.reserve);near(fits.reserve,fits.value*.9*FEE);near(sfits.reserve,sfits.value*1.1*FEE);
  // The long's largest stake is too much for a short: its fill is lower, so more DOGE, and its fee to close is larger.
  assert.equal(doge(max,'short').ok,false);
  assert.deepEqual([over.ok,over.qty,over.reasons],[false,4972,['Otillräckligt tillgängligt saldo: 100,53 $ behövs, 100,00 $ finns']]);
  // An open position's margin and reserved fee to close are not free cash.
  const held=openManual(a,{symbol:'DOGE',side:'long',margin:50,leverage:10,quote:q,contract:c,now:T+1000});
  near(held.account.cash,100-held.preview.cost);
  const eth=previewOrder(held.account,{symbol:'ETH',side:'short',margin:60,leverage:10,quote:{price:3000,mark:3000,at:T+1000},contract:bybitLimits('ETH',T+1000),now:T+1000});
  assert.deepEqual(eth.reasons,['Otillräckligt tillgängligt saldo: '+money2(Math.ceil(eth.cost*100)/100)+' $ behövs, '+money2(Math.floor(held.account.cash*100)/100)+' $ finns']);
  assert.equal(eth.maxMargin,Math.floor(held.account.cash/(1+21*FEE)*100)/100);
  // BTC at Bybit's maximum, 150×, on today's first tier (up to 300 000 $, 0,33 %): with 100 $ free a long can stake
  // 85,87 $ and a short 85,79 $. 92,37 $ (the stake whose margin and fee alone would fit) buys 0,161 BTC, and Bybit's
  // order cost for it, 107,29 $, is refused with that figure.
  const tiers=BYBIT_TIERS.BTC.map(([cap,max,maintenance,deduction],k)=>({id:k+1,cap,max,maintenance,deduction}));
  const btc=(side,margin)=>previewOrder(a,{symbol:'BTC',side,margin,leverage:150,quote:{price:85800,mark:85800,at:T+1000},contract:bybitLimits('BTC',T+1000,tiers),now:T+1000});
  assert.deepEqual([btc('long',10).maxMargin,btc('short',10).maxMargin],[85.87,85.79]);
  const most=btc('long',92.37);
  assert.deepEqual([most.ok,most.qty,most.reasons],[false,.161,['Otillräckligt tillgängligt saldo: 107,30 $ behövs, 100,00 $ finns']]);
  near(most.cost,107.29014766469999,1e-12);assert.ok(most.margin+most.fee<=100);
});

test('the refusal for too little free cash never names the same amount twice: what is needed rounds up to the cent, what is free down',()=>{
  // Property: PEPE's 100 000-token steps make the cost of a stake near the most that fits land within a cent of the free
  // cash (100,37 $) at many prices; whatever it is, a refusal names a need above what is free.
  const a=deposit(newForecastAccount(T-HOUR),.37,T),pepe=bybitLimits('PEPE',T+1000,[{id:1,cap:2e5,max:50,maintenance:.01,deduction:0}],50);
  const cents=x=>Number(x.replace(/ /g,'').replace(',','.'));let refused=0;
  for(let k=0;k<1500;k++){
    const price=.0000105*(1+k*1e-5);
    for(const margin of [99.4,99.45,99.46,99.47,99.5,99.82,99.83,99.84]){
      const p=previewOrder(a,{symbol:'PEPE',side:'long',margin,leverage:10,quote:{price,mark:price,at:T+1000},contract:pepe,now:T+1000});
      const m=p.reasons.find(x=>x.startsWith('Otillräckligt'));
      if(!m)continue;
      refused++;
      const [,need,have]=/^Otillräckligt tillgängligt saldo: ([\d ,]+) \$ behövs, ([\d ,]+) \$ finns$/.exec(m).map((x,i)=>i?cents(x):x);
      assert.ok(need>have&&need>=p.cost-1e-9&&have<=a.cash+1e-9,JSON.stringify({price,margin,cost:p.cost,m}));
    }
  }
  assert.ok(refused>1000,String(refused));
  // 98,97 $ of DOGE at 10× costs 100,0037 $ with Bybit's fee to close, 0,0037 $ more than the 100 $ free.
  const c=bybitLimits('DOGE',T+1000,[{id:1,cap:1e7,max:75,maintenance:.01,deduction:0}],75),q={price:.2,mark:.2,at:T+1000};
  const r=previewOrder(newForecastAccount(T-HOUR),{symbol:'DOGE',side:'long',margin:98.97,leverage:10,quote:q,contract:c,now:T+1000});
  assert.ok(r.cost>100&&r.cost<100.005,String(r.cost));
  assert.deepEqual(r.reasons,['Otillräckligt tillgängligt saldo: 100,01 $ behövs, 100,00 $ finns']);
});

test('an order needs a fresh price and fresh limits with Bybit\'s order filters, one position per coin, and a mark away from the liquidation; a refusal changes nothing',()=>{
  const a=newForecastAccount(T-HOUR),held=open(a).account;
  const cases=[
    ['gammalt pris',a,{quote:btcQuote(T+1000-ACCOUNT.quoteTtl-1)},'Färskt pris saknas för BTC'],
    ['framtida pris',a,{quote:btcQuote(T+7000)},'Färskt pris saknas för BTC'],
    ['inget pris',a,{quote:null},'Färskt pris saknas för BTC'],
    ['inga gränser',a,{contract:null},'Bybits gränser för BTC saknas eller är för gamla'],
    ['gamla gränser',a,{contract:bybitLimits('BTC',T+1000-LIMIT_TTL-1)},'Bybits gränser för BTC saknas eller är för gamla'],
    ['ett annat kontrakt',a,{contract:bybitLimits('ETH',T+1000)},'Bybits gränser för BTC saknas eller är för gamla'],
    ['inga orderfilter',a,{contract:limits('BTC',T+1000)},'Bybits ordergränser för BTC saknas'],
    ['redan en position',held,{},'Det finns redan en position i BTC — stäng den först'],
    ['okänt par',a,{symbol:'LUNA'},'Okänt par'],
    ['ingen riktning',a,{side:'upp'},'Välj köp (lång) eller sälj (kort)'],
    ['__proto__',a,{side:'__proto__'},'Välj köp (lång) eller sälj (kort)'],
    ['ingen insats',a,{margin:0},'Ange insatsen i $'],
    ['ingen hävstång',a,{leverage:NaN},'Ange hävstången'],
    ['markpriset vid likvidationen',a,{leverage:150,margin:1,quote:btcQuote(T+1000,60000,59920)},'Markpriset ligger redan vid likvidationsnivån']
  ];
  for(const [name,acc,over,reason] of cases){
    const r=order(acc,over);
    assert.deepEqual([r.ok,r.reason,r.preview.reasons[0]],[false,reason,reason],name);
    assert.deepEqual(r.account,acc,name);
  }
  assert.throws(()=>openManual(a,{...orderArgs({}),now:NaN}),/Ogiltig tid/);
  // No limit on the number of manual positions: one in every coin with maxOpen 1.
  let all=deposit(newForecastAccount(T-HOUR,{maxOpen:1}),1000,T);
  for(const symbol of SYMBOLS){
    const r=openManual(all,{symbol,side:'long',margin:20,leverage:10,quote:{price:PRICES[symbol],mark:PRICES[symbol],at:T+1000},contract:bybitLimits(symbol,T+1000),now:T+1000});
    assert.equal(r.ok,true,symbol+': '+r.reason);all=r.account;
  }
  assert.equal(all.positions.length,7);
  // A manual position takes no slot from the signals, and a signal is refused in a coin held manually.
  const one=order(newForecastAccount(T-HOUR,{maxOpen:1})).account;
  assert.equal(open(one,{sig:signal({symbol:'ETH'}),symbol:'ETH'}).opened,true);
  assert.equal(open(one).reason,'Det finns redan en position i BTC');
});

test('a stop and a target sent with the order are rounded to Bybit\'s tick and checked against the last price and the liquidation price',()=>{
  const a=newForecastAccount(T-HOUR),long=preview(a),short=preview(a,{side:'short'}),price=fx(60000,1),tpLong='TP för en lång position måste ligga över priset ('+price+')';
  const ok=order(a,{sl:59000.04,tp:61000.06});
  assert.deepEqual([ok.ok,ok.position.sl,ok.position.tp],[true,59000,61000.1]);
  assert.equal(ok.account.log[0].text,'Öppnade lång 0,001 BTC till '+fx(60030,1)+' · 10× · marginal '+money2(long.margin)+' $ · SL '+sv(59000,1)+' · TP '+sv(61000.1,1)+' (manuell)');
  const slLong='SL för en lång position måste ligga under priset ('+price+') och över likvidationen ('+fx(long.liq,1)+')';
  const slShort='SL för en kort position måste ligga över priset ('+price+') och under likvidationen ('+fx(short.liq,1)+')';
  for(const [over,reasons] of [
    [{sl:60000},[slLong]],[{sl:long.liq-1},[slLong]],[{tp:59999.9},[tpLong]],
    [{side:'short',sl:59999.9},[slShort]],[{side:'short',sl:short.liq+1},[slShort]],[{side:'short',tp:60000},['TP för en kort position måste ligga under priset ('+price+')']],
    [{sl:-5},['Ange SL som ett pris över 0']],[{tp:'61000'},['Ange TP som ett pris över 0']],[{sl:60001,tp:59000},[slLong,tpLong]]])
    assert.deepEqual(preview(a,over).reasons,reasons,JSON.stringify(over));
  const s=order(a,{side:'short',sl:61000,tp:59000});
  assert.deepEqual([s.ok,s.position.sl,s.position.tp],[true,61000,59000]);
});

test('property: what previewOrder shows is exactly what openManual opens, within Bybit\'s steps, minimums, maximums, tiers and the free cash',()=>{
  let seed=20261006;const rnd=()=>(seed=seed*16807%2147483647)/2147483647;
  const base=deposit(newForecastAccount(T-HOUR),900,T);
  let opened=0,refused=0;
  for(let n=0;n<1400;n++){
    const symbol=SYMBOLS[n%SYMBOLS.length],side=rnd()<.5?'long':'short',price=PRICES[symbol]*(.5+rnd()),mark=price*(1+(rnd()-.5)*.004);
    const c={...bybit(symbol,T+1000),filters:filtersFor(symbol)},f=c.filters,margin=10**(-1.5+4*rnd()),leverage=.5+rnd()*(c.max+30);
    const params={symbol,side,margin,leverage,quote:{price,mark,at:T+1000},contract:c,now:T+1000},label=JSON.stringify({symbol,side,price,mark,margin,leverage});
    const r=previewOrder(base,params),o=openManual(base,params);
    assert.equal(o.ok,r.ok,label);
    if(!r.ok){assert.ok(r.reasons.length>0,label);assert.equal(o.reason,r.reasons[0],label);assert.deepEqual(o.account,base,label);refused++;continue;}
    const p=o.position;
    assert.deepEqual([p.entry,p.units,p.margin,p.fees,p.reserve,p.liq,p.leverage,p.riskId],[r.fill,r.qty,r.margin,r.fee,r.reserve,r.liq,r.leverage,r.riskId],label);
    // A whole number of Bybit's quantity steps, in Bybit's own units, and leverage on its 0,01 grid, never above the request.
    const steps=p.units/f.unit/f.bybit.qtyStep;
    assert.ok(Math.abs(steps-Math.round(steps))<1e-6&&Math.abs(p.leverage*100-Math.round(p.leverage*100))<1e-6&&p.leverage<=leverage,label);
    assert.ok(p.units>=f.minQty*(1-1e-12)&&p.units*p.entry>=f.minNotional-1e-9&&p.units<=f.maxMktQty*(1+1e-12),label);
    // The largest whole step within the stake: one step more would exceed it.
    assert.ok(p.units*p.entry<=margin*p.leverage*(1+1e-9)&&(p.units+f.qtyStep)*p.entry>margin*p.leverage*(1-1e-9),label);
    // Within the maximum of the tier the position's value at the mark falls in, and within that tier's cap (Bybit's maximum
    // for the stake before rounding, maxLeverage, can be a hair lower right at a cap).
    const tier=c.tiers.find(t=>t.id===p.riskId);
    assert.ok(p.leverage<=tier.max+1e-9&&p.units*p.entry*Math.max(1,mark/p.entry)<=tier.cap*(1+1e-9),label);
    assert.equal(tier,[...c.tiers].sort((x,y)=>x.cap-y.cap).find(t=>p.units*p.entry*Math.max(1,mark/p.entry)<=t.cap*(1+1e-12)),label);
    // Bybit's order cost (the margin, the fee to open and the fee to close it reserves) within the free cash.
    const dir=side==='long'?1:-1;
    near(p.reserve,p.units*p.entry*(1-dir/p.leverage)*FEE);
    assert.ok(p.margin+p.fees+p.reserve<=base.cash+1e-9,label);near(o.account.cash,base.cash-p.margin-p.fees-p.reserve);
    // Bybit's isolated liquidation: there the margin balance, the fee to close aside, is the tier's maintenance margin.
    near(p.liq,bybitIsolatedLevel(side,p.entry,p.units,p.leverage,tier));
    if(p.liq>0)near(p.margin+dir*(p.liq-p.entry)*p.units,p.liq*p.units*tier.maintenance-tier.deduction,1e-7);
    opened++;
  }
  assert.ok(opened>500&&refused>200,JSON.stringify({opened,refused}));
  // Bybit's maximum never rises with the stake.
  for(const symbol of SYMBOLS){
    const c={...bybit(symbol,T+1000),filters:filtersFor(symbol)},q={price:PRICES[symbol],mark:PRICES[symbol],at:T+1000};
    const maxes=[1,10,100,1e3,1e4,1e5].map(margin=>previewOrder(base,{symbol,side:'long',margin,leverage:1,quote:q,contract:c,now:T+1000}).maxLeverage);
    assert.ok(maxes.every((x,i)=>!i||x<=maxes[i-1]),symbol+' '+maxes);
  }
});

// Today's BTCUSDT risk tiers (the first: up to 300 000 $ at 150×, 0,33 %), with Bybit's order filters.
const btcTiers=()=>bybitLimits('BTC',T+1000,BYBIT_TIERS.BTC.map(([cap,max,maintenance,deduction],k)=>({id:k+1,cap,max,maintenance,deduction})));

test('a manual order\'s liquidation is Bybit\'s for an isolated position, where the fee to close cancels out: as in Bybit\'s own examples and on today\'s BTC tier at 150×',()=>{
  // Bybit's help centre: a long of 1 BTC at 40 000 USDT, 50×, 0,5 % maintenance margin and 3 000 USDT of margin added: 36 380,25.
  near(bybitIsolatedLevel('long',40000,1,50,{maintenance:.005,deduction:0},{extra:3000,fee:FEE}),36380.2503,1e-8);
  // Its short examples (USDC, the same formula): 1 BTC at 10 000, 10×, 0,4 %: 10 956,1753; at 9 900 with 100 added: 10 946,16.
  near(bybitIsolatedLevel('short',10000,1,10,{maintenance:.004,deduction:0},{fee:FEE}),10956.1753,1e-8);
  near(bybitIsolatedLevel('short',9900,1,10,{maintenance:.004,deduction:0},{extra:100,fee:FEE}),10946.1604,1e-8);
  // A long at 1× cannot be liquidated, and a tier's deduction moves the level away.
  assert.equal(bybitIsolatedLevel('long',100,1,1,{maintenance:.005,deduction:0}),0);
  assert.ok(bybitIsolatedLevel('long',100,1,10,{maintenance:.01,deduction:.5})<bybitIsolatedLevel('long',100,1,10,{maintenance:.01,deduction:0}));
  // 85 $ at 150× buys 0,148 BTC at a fill of 85 842,9: Bybit liquidates it at 85 552,94, not 85 600,17.
  const c=btcTiers(),a=newForecastAccount(T-HOUR),q={price:85800,mark:85800,at:T+1000};
  const long=openManual(a,{symbol:'BTC',side:'long',margin:85,leverage:150,quote:q,contract:c,now:T+1000}),p=long.position;
  assert.deepEqual([long.ok,p.units,p.entry,p.riskId],[true,.148,85842.9,1]);
  near(p.liq,85552.9387,1e-9);near(long.preview.cost,98.6270,1e-5);
  // A stop at 85 576,6 lies above it: Bybit takes it, and a mark there does not liquidate; a mark through 85 552,94 does.
  const at=T+2000,now={price:85700,mark:85700,at};
  assert.deepEqual(previewLevels(long.account,p.id,{sl:85576.6},{quote:now,contract:c,now:at}).reasons,[]);
  assert.equal(checkQuote(long.account,p.id,{price:85580,mark:85576.6,at},at).positions.length,1);
  assert.equal(checkQuote(long.account,p.id,{price:85540,mark:85552.9,at},at).trades[0].reason,'likvidation');
  // The short mirrors it: 0,148 BTC at 85 757,1, liquidated at 86 044,87.
  const short=openManual(a,{symbol:'BTC',side:'short',margin:85,leverage:150,quote:q,contract:c,now:T+1000}),s=short.position;
  near(s.liq,86044.8659,1e-9);
  assert.deepEqual(previewLevels(short.account,s.id,{sl:86020},{quote:now,contract:c,now:at}).reasons,[]);
  assert.equal(checkQuote(short.account,s.id,{price:86000,mark:86020,at},at).positions.length,1);
  assert.equal(checkQuote(short.account,s.id,{price:86050,mark:86044.9,at},at).trades[0].reason,'likvidation');
  // A signal position keeps the level it was sized with, the backtest's, and reserves no fee to close.
  const sig=open(newForecastAccount(T-HOUR)).position;
  near(sig.liq,isolatedLevel('long',sig.entry,sig.margin+sig.fees,sig.units,FEE,sig));assert.equal(sig.reserve,undefined);
});

test('the largest stake offered also fits a risk tier that allows the leverage, so with a large balance it can be ordered at Bybit\'s maximum',()=>{
  // Today's BTC tiers: up to 300 000 $ of value at 150×, 2 000 000 $ at 100×, 3 800 000 $ at 75×. The free cash alone would
  // allow 8 587,74 $ at 150× with 10 000 $ free, far past the first tier, which Bybit then refuses at 100×.
  const c=btcTiers(),q={price:85800,mark:85800,at:T+1000};
  const at=(a,side,margin,leverage)=>previewOrder(a,{symbol:'BTC',side,margin,leverage,quote:q,contract:c,now:T+1000});
  for(const [free,leverage,long,short] of [[10000,150,2000,1999],[2400,150,2000,1999],[50000,150,2000,1999],[10000,100,9013.47,9004.54],[50000,75,46212.85,46165.92]]){
    const a=deposit(newForecastAccount(T-HOUR),free-100,T);
    for(const [side,max] of [['long',long],['short',short]]){
      const r=at(a,side,10,leverage),label=free+' $ at '+leverage+'× '+side;
      assert.equal(r.maxMargin,max,label);
      // A short fills below the mark, so its value at the mark counts against the cap: 300 000 / (150 × 1,0005).
      if(leverage===150)assert.equal(max,Math.floor(3e5/(150*Math.max(1,85800/r.fill))*100)/100,label);
      const m=at(a,side,max,leverage);
      assert.deepEqual([m.ok,m.reasons],[true,[]],label);assert.ok(m.value*Math.max(1,85800/m.fill)<=3e5||leverage<150,label);
    }
  }
  // With 100 $ free the cash still decides.
  assert.deepEqual(['long','short'].map(side=>at(newForecastAccount(T-HOUR),side,10,150).maxMargin),[85.87,85.79]);
});

test('Bybit\'s maximum leverage is checked against the position the order opens: its value after the quantity is rounded down, at the mark',()=>{
  // 2 000,01 $ at 150× is 300 001,50 $ before rounding, just past the first tier's 300 000 $ (Bybit's maximum for that stake
  // is 149,99×). The order buys 3,494 BTC, 299 935,09 $ at the fill, inside the tier: Bybit takes it at 150×.
  const a=deposit(newForecastAccount(T-HOUR),9900,T),c=btcTiers(),q={price:85800,mark:85800,at:T+1000};
  const at=(side,margin)=>previewOrder(a,{symbol:'BTC',side,margin,leverage:150,quote:q,contract:c,now:T+1000});
  const edge=at('long',2000.01);
  assert.deepEqual([edge.ok,edge.reasons,edge.qty,edge.riskId,edge.maxLeverage],[true,[],3.494,1,149.99]);
  near(edge.value,299935.0926,1e-9);
  const opened=openManual(a,{symbol:'BTC',side:'long',margin:2000.01,leverage:150,quote:q,contract:c,now:T+1000});
  assert.deepEqual([opened.ok,opened.position.leverage,opened.position.units],[true,150,3.494]);
  // One step more crosses the cap: refused, with Bybit's maximum for the stake.
  assert.deepEqual(at('long',2000.3).reasons,['Bybits högsta hävstång för den här storleken är 149,97×']);
  // A short fills below the mark; 3,498 BTC is 300 128 $ at the mark, past the cap.
  assert.deepEqual(at('short',2000).reasons,['Bybits högsta hävstång för den här storleken är 149,92×']);
});

test('a manual order\'s funding is paid from the free cash first, as Bybit takes it: only what the cash lacks comes out of the margin and moves the liquidation, and funding received stays in the cash',()=>{
  // 900 $ deposited, a 10 $ long at 150× (0,017 BTC), one funding of 0,01 % at 16:00 on a mark of 85 800.
  const c=btcTiers(),q={price:85800,mark:85800,at:T+1000},ft=T+6*HOUR,now=ft+STEP+1000;
  const {account:a,position:p}=openManual(deposit(newForecastAccount(T-HOUR),900,T),{symbol:'BTC',side:'long',margin:10,leverage:150,quote:q,contract:c,now:T+1000});
  const paid=settlePosition(a,p.id,riskFor(p,now,{price:85800,funding:[{t:ft,rate:.0001}]}),now),x=paid.positions[0],cost=p.units*85800*.0001;
  assert.equal(p.units,.017);near(cost,.14586);
  near(paid.cash,a.cash-cost);assert.deepEqual([x.margin,x.liq],[p.margin,p.liq]);near(x.funding,cost);near(paid.funding,cost);
  // With only 5 cents free, those are paid and the rest comes out of the margin: the liquidation moves closer.
  const poor=setFree(a,.05,T+2000),lack=settlePosition(poor,p.id,riskFor(p,now,{price:85800,funding:[{t:ft,rate:.0001}]}),now),y=lack.positions[0];
  assert.equal(lack.cash,0);near(y.margin,p.margin-(cost-.05));near(y.funding,cost);
  near(y.liq,bybitIsolatedLevel('long',p.entry,p.units,150,p,{extra:-(cost-.05),fee:FEE}));assert.ok(y.liq>p.liq);
  // Funding received (a negative rate for a long) goes to the free cash and is kept through a liquidation.
  const got=settlePosition(a,p.id,riskFor(p,now,{price:85800,funding:[{t:ft,rate:-.0001}]}),now),z=got.positions[0];
  near(got.cash,a.cash+cost);assert.deepEqual([z.margin,z.liq],[p.margin,p.liq]);near(z.funding,-cost);
  const gone=checkQuote(got,p.id,{price:85500,mark:p.liq-1,at:now},now+1000),t=gone.trades[0];
  // Bybit liquidates at the bankruptcy price, where the reserved fee to close pays the closing fee.
  assert.equal(t.reason,'likvidation');near(gone.cash,got.cash);near(t.pnl,-(p.margin+p.fees+p.reserve)+cost);near(t.fees,p.fees+p.reserve);near(gone.fees,got.fees+p.reserve);
  assert.deepEqual([t.margin,t.reserve],[p.margin,p.reserve]);near(t.funding,-cost);
  // A stored trade cannot claim to have lost more than its margin, fees, reserved fee to close and funding paid.
  const broken=structuredClone(gone);broken.trades[0].pnl-=1;broken.cash-=1;
  assert.throws(()=>validateForecastAccount(broken),/Ogiltig AI Forecast-affär/);
});

test('a manual order\'s position holds its fee to close as the order reserved it; a signal position holds none',()=>{
  const {account:a}=order(newForecastAccount(T-HOUR)),bad=f=>{const x=structuredClone(a);f(x.positions[0],x);return ()=>validateForecastAccount(x);};
  assert.throws(bad(p=>{p.reserve+=.001;}),/Ogiltig AI Forecast-position/);
  assert.throws(bad(p=>{p.reserve=-1;}),/Ogiltig AI Forecast-position/);
  assert.throws(bad(p=>{p.reserve='0';}),/Ogiltig AI Forecast-position/);
  // Funding never adds to it: what is received goes to the free cash.
  assert.throws(bad((p,x)=>{p.margin+=1;x.cash-=1;}),/Ogiltig AI Forecast-position/);
  // Only a manual order's position margins as Bybit does: not a signal position, nor one in a version 1 account.
  const sig=open(newForecastAccount(T-HOUR)).account;sig.positions[0].reserve=0;
  assert.throws(()=>validateForecastAccount(sig),/Ogiltig AI Forecast-position/);
  const v1=JSON.parse(V1_ACCOUNT);v1.positions[0].reserve=0;
  assert.throws(()=>validateForecastAccount(v1),/Ogiltig AI Forecast-position/);
  // The ledger counts the reserve: cash taken from it does not reconcile.
  assert.throws(bad((p,x)=>{x.cash+=p.reserve;}),/kassa stämmer inte/);
});

test('levels: checked as Bybit checks them against the last price and the liquidation, rounded to the tick; a key left out keeps a level, null removes it',()=>{
  const {account:a,position:p}=order(newForecastAccount(T-HOUR),{sl:59000,tp:61000}),c=bybitLimits('BTC',T+1000),now=T+4000;
  const quote=(price=60000,at=now-500)=>({price,mark:price,at});
  const at=(levels,{price=60000,contract=c}={})=>previewLevels(a,p.id,levels,{quote:quote(price),contract,now});
  const resultAt=level=>{const exit=level*(1-SLIP);return p.margin+(exit-p.entry)*p.units-p.units*exit*FEE-p.margin-p.fees;};
  const r=at({sl:59500.04});
  assert.deepEqual([r.ok,r.reasons,r.changed,r.sl,r.tp,r.price,r.liq],[true,[],true,59500,61000,60000,p.liq]);
  // The result if the position closed at the level now: slippage, both fees and the funding so far.
  near(r.slPnl,resultAt(59500));near(r.tpPnl,resultAt(61000));
  const slLong='SL för en lång position måste ligga under priset ('+fx(60000,1)+') och över likvidationen ('+fx(p.liq,1)+')';
  for(const [levels,reason] of [[{sl:60000},slLong],[{sl:p.liq-.5},slLong],[{tp:60000},'TP för en lång position måste ligga över priset ('+fx(60000,1)+')'],
    [{sl:0},'Ange SL som ett pris över 0'],[{tp:'61000'},'Ange TP som ett pris över 0'],[{},'Ange SL eller TP'],[{sl:undefined},'Ange SL eller TP'],
    [null,'Ange SL eller TP'],[[],'Ange SL eller TP'],[{stop:1},'Okänd nivå: stop']])
    assert.deepEqual(at(levels).reasons,[reason],JSON.stringify(levels));
  // The price now decides: a target below a risen price is refused.
  assert.deepEqual(at({tp:60500},{price:60600}).reasons,['TP för en lång position måste ligga över priset ('+fx(60600,1)+')']);
  // Removing needs no limits; a new price does, and a fresh price is always needed.
  assert.deepEqual([at({sl:null},{contract:null}).ok,at({sl:null},{contract:null}).sl,at({sl:null},{contract:null}).slPnl],[true,null,null]);
  assert.deepEqual(at({sl:59500},{contract:null}).reasons,['Bybits prissteg för BTC saknas just nu']);
  assert.deepEqual(previewLevels(a,p.id,{sl:59500},{quote:quote(60000,now-ACCOUNT.quoteTtl-600),contract:c,now}).reasons,['Färskt pris saknas för BTC']);
  assert.deepEqual(previewLevels(a,'m|okänd',{sl:59500},{quote:quote(),contract:c,now}).reasons,['Positionen är redan stängd']);
  // setLevels applies exactly that, from now on: the next replay starts with the minutes after now.
  const s=setLevels(a,p.id,{sl:59500.04,tp:null},{quote:quote(),contract:c,now});
  assert.deepEqual([s.ok,s.changed,s.reason],[true,true,'']);
  const q=s.account.positions[0];
  assert.deepEqual([q.sl,q.tp,q.levelsAt,q.nextBar,q.origin,q.deadline],[59500,null,now,T+STEP,'manual',null]);assert.deepEqual(s.position,q);
  assert.deepEqual(s.account.log.at(-1),{t:now,kind:'ändrad',symbol:'BTC',signalId:null,text:'Nya nivåer för lång BTC: SL '+sv(59500,1)+', ingen TP (manuell)'});
  // A key left out keeps its level; unchanged levels change nothing.
  const t2=setLevels(s.account,p.id,{tp:62000},{quote:quote(60000,now+500),contract:c,now:now+1000}).account;
  assert.deepEqual([t2.positions[0].sl,t2.positions[0].tp,t2.positions[0].levelsAt],[59500,62000,now+1000]);
  const same=setLevels(t2,p.id,{sl:59500.01},{quote:quote(60000,now+1500),contract:c,now:now+2000});
  assert.deepEqual([same.ok,same.changed],[true,false]);assert.deepEqual(same.account,t2);
  // A refused change changes nothing.
  const bad=setLevels(a,p.id,{sl:60000},{quote:quote(),contract:c,now});
  assert.deepEqual([bad.ok,bad.changed,bad.reason],[false,false,slLong]);assert.deepEqual(bad.account,a);
  // The old levels must have been checked up to now: a position not settled within a quote's lifetime waits for that.
  assert.equal(setLevels(a,p.id,{sl:59500},{quote:quote(60000,T+30000),contract:c,now:T+30000}).reason,'Positionen i BTC är inte avräknad just nu — försök igen');
  assert.throws(()=>setLevels(a,p.id,{sl:59500},{quote:quote(),contract:c,now:NaN}),/Ogiltig tid/);
  // A short mirrors the rules.
  const {account:b,position:sp}=order(newForecastAccount(T-HOUR),{side:'short'});
  const slShort='SL för en kort position måste ligga över priset ('+fx(60000,1)+') och under likvidationen ('+fx(sp.liq,1)+')';
  for(const [levels,reason] of [[{sl:59900},slShort],[{sl:sp.liq+.5},slShort],[{tp:60100},'TP för en kort position måste ligga under priset ('+fx(60000,1)+')']])
    assert.deepEqual(previewLevels(b,sp.id,levels,{quote:quote(),contract:c,now}).reasons,[reason]);
  assert.equal(previewLevels(b,sp.id,{sl:60500,tp:59000},{quote:quote(),contract:c,now}).ok,true);
  // SHIB's prices in the reasons keep their nine decimals.
  const shib=openManual(newForecastAccount(T-HOUR),{symbol:'SHIB',side:'long',margin:10,leverage:10,quote:{price:.000012,mark:.000012,at:T+1000},
    contract:bybitLimits('SHIB',T+1000),now:T+1000});
  const sr=previewLevels(shib.account,shib.position.id,{tp:.0000119},{quote:{price:.000012,mark:.000012,at:T+2000},contract:bybitLimits('SHIB',T+1000),now:T+2000});
  assert.deepEqual(sr.reasons,['TP för en lång position måste ligga över priset (0,000012000)']);
});

test('right after an order its levels are checked on the price the order filled at, though Bybit stamped that price before the order was written',()=>{
  // Bybit stamps a ticker when it answers; the order is written a moment later on the page's clock (and that clock can run
  // ahead of Bybit's), so the freshest price for a just-opened position is older than the position.
  const bybitAt=T+1000-400,{account:a,position:p}=order(newForecastAccount(T-HOUR),{quote:btcQuote(bybitAt)}),c=bybitLimits('BTC',T+1000);
  assert.equal(p.openedAt,T+1000);
  const args={quote:btcQuote(bybitAt),contract:c,now:T+1200},r=previewLevels(a,p.id,{sl:59500,tp:61000},args);
  assert.deepEqual([r.ok,r.reasons,r.sl,r.tp,r.price],[true,[],59500,61000,60000]);
  const s=setLevels(a,p.id,{sl:59500},args);
  assert.deepEqual([s.ok,s.reason,s.position.sl,s.position.levelsAt],[true,'',59500,T+1200]);
  // The price must still be fresh, whenever the position opened.
  assert.deepEqual(previewLevels(a,p.id,{sl:59500},{...args,now:bybitAt+ACCOUNT.quoteTtl+1}).reasons,['Färskt pris saknas för BTC']);
  // Only the protection waits for a price taken after the opening: one from before it can trigger nothing.
  const sa=s.account;
  assert.deepEqual(checkQuote(sa,p.id,btcQuote(bybitAt,59000),T+1300),sa);
});

test('the levels a position has, sent back as they are or within half of Bybit\'s tick, change nothing: a signal position keeps its rules',()=>{
  // A signal's levels come from its ATR and lie off Bybit's 0,1 $ tick.
  const sig=signal({sl:58765.4321,tp:62345.6789,entry:60000}),{account:a,position:p}=open(tenX(),{sig,price:60000}),now=T+5000;
  const args={quote:{price:60000,mark:60000,at:now},contract:bybitLimits('BTC',now),now};
  for(const levels of [{sl:p.sl,tp:p.tp},{sl:p.sl},{tp:p.tp},{sl:58765.4,tp:62345.7},{sl:58765.4321+.049}]){
    const pv=previewLevels(a,p.id,levels,args),r=setLevels(a,p.id,levels,args),label=JSON.stringify(levels);
    assert.deepEqual([pv.ok,pv.reasons,pv.changed,pv.sl,pv.tp],[true,[],false,p.sl,p.tp],label);
    assert.deepEqual([r.ok,r.changed,r.reason],[true,false,''],label);assert.deepEqual(r.account,a,label);
  }
  // Without Bybit's limits only the very same level is known to be unchanged.
  assert.deepEqual([setLevels(a,p.id,{sl:p.sl},{...args,contract:null}).changed,previewLevels(a,p.id,{sl:58765.4},{...args,contract:null}).reasons],
    [false,['Bybits prissteg för BTC saknas just nu']]);
  // Further than half a tick away it is a new level on Bybit's tick, and the position becomes manual.
  const moved=setLevels(a,p.id,{sl:58765.36},args).position;
  assert.deepEqual([moved.sl,moved.tp,moved.origin,moved.deadline],[58765.4,p.tp,'manual',null]);
  // Removing a level a position does not have changes nothing either.
  const {account:m,position:q}=order(newForecastAccount(T-HOUR),{sl:59000});
  assert.deepEqual([setLevels(m,q.id,{tp:null},{quote:btcQuote(T+2000),contract:null,now:T+2000}).changed,setLevels(m,q.id,{sl:59000},{quote:btcQuote(T+2000),contract:null,now:T+2000}).changed],[false,false]);
});

test('a manual order\'s texts give prices with the decimals of Bybit\'s tick, also from 100 000 $ on',()=>{
  // BTC at 123 456,7: six significant digits would show 123 518 for a fill of 123 518,4 and 120 000 for a stop at 120 000,1.
  const q={price:123456.7,mark:123456.7,at:T+1000},c=bybitLimits('BTC',T+1000);
  const o=openManual(newForecastAccount(T-HOUR),{symbol:'BTC',side:'long',margin:13,leverage:10,sl:120000.1,tp:130000.3,quote:q,contract:c,now:T+1000});
  assert.equal(o.account.log[0].text,'Öppnade lång 0,001 BTC till '+sv(123518.4,1)+' · 10× · marginal 12,35 $ · SL '+sv(120000.1,1)+' · TP '+sv(130000.3,1)+' (manuell)');
  const s=setLevels(o.account,o.position.id,{sl:119999.9},{quote:{...q,at:T+2000},contract:c,now:T+2000});
  assert.equal(s.account.log.at(-1).text,'Nya nivåer för lång BTC: SL '+sv(119999.9,1)+', TP '+sv(130000.3,1)+' (manuell)');
  // SHIB keeps its nine decimals per token.
  const shib=openManual(newForecastAccount(T-HOUR),{symbol:'SHIB',side:'long',margin:10,leverage:10,tp:.0000125006,quote:{price:.000012,mark:.000012,at:T+1000},
    contract:bybitLimits('SHIB',T+1000),now:T+1000});
  assert.match(shib.account.log[0].text,/ till 0,000012006 · 10× · marginal \d+,\d\d \$ · TP 0,000012501 \(manuell\)$/);
});

test('in the texts a fill, a price and a liquidation have all of Bybit\'s tick decimals, as the page writes them; a stop or a target has as many as the page gives a price of its size, more where the level has them, never more than the tick',()=>{
  // BTC at a whole dollar: the fill reads 60 030,0, as Positioner and the chart's entry tag write it; a stop at 59 000 as the chart's tag.
  const o=order(newForecastAccount(T-HOUR),{sl:59000});
  assert.equal(o.account.log[0].text,'Öppnade lång 0,001 BTC till '+fx(60030,1)+' · 10× · marginal '+money2(o.position.margin)+' $ · SL '+fx(59000,0)+' (manuell)');
  // A refusal's price and liquidation likewise.
  const r=previewLevels(o.account,o.position.id,{sl:60000},{quote:btcQuote(T+2000),contract:bybitLimits('BTC',T+1000),now:T+2000});
  assert.deepEqual(r.reasons,['SL för en lång position måste ligga under priset ('+fx(60000,1)+') och över likvidationen ('+fx(o.position.liq,1)+')']);
  // SOL's tick is 0,01 $: a target at 120,8 reads 120,80, as the chart's tag writes it.
  const sol=openManual(newForecastAccount(T-HOUR),{symbol:'SOL',side:'long',margin:10,leverage:10,quote:{price:120,mark:120,at:T+1000},contract:bybitLimits('SOL',T+1000),now:T+1000});
  assert.match(sol.account.log[0].text,/^Öppnade lång 0,8 SOL till 120,06 · /);
  const s=setLevels(sol.account,sol.position.id,{tp:120.8},{quote:{price:120,mark:120,at:T+2000},contract:bybitLimits('SOL',T+1000),now:T+2000});
  assert.equal(s.account.log.at(-1).text,'Nya nivåer för lång SOL: ingen SL, TP 120,80 (manuell)');
  // SHIB: nine decimals per token (Bybit's tick), never the ten the chart gives a price of its size.
  const shib=openManual(newForecastAccount(T-HOUR),{symbol:'SHIB',side:'short',margin:10,leverage:10,tp:.0000058,quote:{price:.00000589,mark:.00000589,at:T+1000},
    contract:bybitLimits('SHIB',T+1000),now:T+1000});
  assert.match(shib.account.log[0].text,/ SHIB till 0,000005887 · 10× · marginal \d+,\d\d \$ · TP 0,000005800 \(manuell\)$/);
  // The rule: BTC 85 700 and 85 700,5 (tick 0,1), SOL 120,8 (0,01), PEPE and SHIB (0,000000001), ETH 4 123 (0,01), DOGE 0,21
  // (0,00001), BTC over 100 000; a signal's level off the tick as the chart writes it (BTC in whole dollars, PEPE and ETH
  // never past the tick); without the tick as the chart writes a price of its size, more where it has them.
  const d=accountModule.levelDecimals;
  assert.equal(typeof d,'function');
  assert.deepEqual([d(85700,1),d(85700.5,1),d(120.8,2),d(.000004366,9),d(.00000589,9),d(4123,2),d(.21,5),d(123456.7,1)],[0,1,2,9,9,1,5,1]);
  assert.deepEqual([d(86123.4567,1),d(.0000043661234,9),d(4123.456,2)],[0,9,1]);
  assert.deepEqual([d(120.8),d(.000004366),d(85700.25)],[2,10,2]);
});

test('changing the levels of a signal position makes it manual: no time stop and no close on a signal, and the log says so',()=>{
  const {account:a,position:p}=open(tenX()),c=bybitLimits('BTC',T+1000),now=T+5000;
  const s=setLevels(a,p.id,{tp:105},{quote:{price:100,mark:100,at:now},contract:c,now}),q=s.account.positions[0];
  assert.deepEqual([q.origin,q.deadline,q.signalId,q.tf,q.sl,q.tp,q.levelsAt],['manual',null,p.signalId,'1h',98,105,now]);
  assert.deepEqual(s.account.log.at(-1),{t:now,kind:'ändrad',symbol:'BTC',signalId:p.signalId,
    text:'Nya nivåer för lång BTC: SL 98,0, TP 105,0 — signalpositionen hanteras nu manuellt, utan tidsstopp'});
  // Past the signal's holding time it is still open.
  const later=p.deadline+HOUR,held=settlePosition(s.account,p.id,riskFor(q,later),later);
  assert.deepEqual([held.positions.length,held.trades],[1,[]]);
  assert.equal(checkQuote(held,p.id,{price:100,mark:100,at:later},later+1000).positions.length,1);
  // It closes only on its levels, liquidation or the user's close; the trade and the log say manual.
  for(const reason of ['signal','tid','slut'])
    assert.throws(()=>closePosition(s.account,p.id,{price:100,now,reason}),{message:'En manuell position stängs bara av SL, TP, likvidation eller Stäng'});
  const closed=closePosition(s.account,p.id,{price:100,now,reason:'manuell'});
  assert.equal(closed.trades[0].origin,'manual');assert.match(closed.log.at(-1).text,/^Stängd manuellt: lång BTC [+−]\d+,\d\d \$ \(manuell\)$/);
  // Untouched, a signal position keeps its rules.
  assert.equal(settlePosition(a,p.id,riskFor(p,later),later).trades[0].reason,'tid');
  // Removing a level converts it too; unchanged levels do not.
  assert.equal(setLevels(a,p.id,{tp:null},{quote:{price:100,mark:100,at:now},contract:null,now}).account.positions[0].origin,'manual');
  const kept=setLevels(a,p.id,{sl:98},{quote:{price:100,mark:100,at:now},contract:c,now});
  assert.deepEqual([kept.ok,kept.changed,kept.account.positions[0].origin],[true,false,'signal']);
});

test('a change of levels applies only to prices after it: the old stop hit before the change is booked, and after it only the new level counts, replayed from the minute after the change',()=>{
  // A manual long at 100,05 (10×) with its stop at 98, opened at 10:00:01. The change comes at 10:12:30, in the step
  // 10:10–10:15 that is still forming.
  const S0=T+2*STEP,t=S0+2*MIN+30000,c=bybitLimits('BTC',T+1000);
  const {account:a,position:p}=order(newForecastAccount(T-HOUR),{quote:btcQuote(T+1000,100),margin:20,sl:98});
  assert.deepEqual([p.entry,p.sl,p.nextBar],[100*(1+SLIP),98,T+STEP]);
  // The old stop was reached at 10:11, before the change: settling with the old levels books it, and the change finds no position.
  const hit=settlePosition(a,p.id,riskFor(p,t,{lasts:{[S0]:{l:97.9}}}),t);
  assert.deepEqual(hit.trades.map(x=>[x.reason,x.closedAt]),[['stopp',t]]);near(hit.trades[0].exit,98*(1-SLIP));
  assert.equal(setLevels(hit,p.id,{sl:95},{quote:btcQuote(t,100),contract:bybitLimits('BTC',t),now:t}).reason,'Positionen är redan stängd');
  // Not reached: settled up to 10:12:30 with the forming step's low at 98,5 so far, then the stop moves up to 99,5.
  const held=settlePosition(a,p.id,riskFor(p,t,{lasts:{[S0]:{l:98.5}}}),t);
  assert.deepEqual([held.positions.length,held.positions[0].nextBar,held.positions[0].fundingThrough],[1,S0,t]);
  const moved=setLevels(held,p.id,{sl:99.5},{quote:btcQuote(t,100),contract:bybitLimits('BTC',t),now:t}).account,q=moved.positions[0];
  assert.deepEqual([q.sl,q.levelsAt,q.nextBar],[99.5,t,S0+STEP]);
  // The step dipped to 99,2 at 10:11 and 99,1 at 10:12, before the change and under the new stop, and to 99,3 at 10:14,
  // after it. Only 10:14 counts: the new stop at that minute's end.
  const later=S0+2*STEP+1000,flat=x=>({o:100,h:100,l:100,c:100,...x}),early=[{t:S0+MIN,...flat({l:99.2})},{t:S0+2*MIN,...flat({l:99.1})}];
  const withEarly=r=>({...r,minuteMarks:[...early.map(b=>({...b,l:100})),...r.minuteMarks],minuteLasts:[...early,...r.minuteLasts]});
  const r=riskFor(q,later,{lasts:{[S0]:{l:99.1}},minuteLasts:{[S0+4*MIN]:{l:99.3}}});
  assert.deepEqual(r.minuteLasts.map(b=>b.t),[S0+3*MIN,S0+4*MIN]);
  const done=settlePosition(moved,p.id,withEarly(r),later);
  assert.deepEqual(done.trades.map(x=>[x.reason,x.closedAt]),[['stopp',S0+5*MIN]]);near(done.trades[0].exit,99.5*(1-SLIP));
  // Without that last dip nothing after the change reached the new stop: still open, settled to the next step.
  const quiet=settlePosition(moved,p.id,withEarly(riskFor(q,later,{lasts:{[S0]:{l:99.1}}})),later);
  assert.deepEqual([quiet.trades,quiet.positions[0].nextBar,quiet.positions[0].levelsAt],[[],S0+2*STEP,t]);
  // With the old stop the same prices never reached 98.
  assert.equal(settlePosition(held,p.id,riskFor(held.positions[0],later,{lasts:{[S0]:{l:99.1}}}),later).positions.length,1);
  // Every closed minute after the change is needed.
  assert.throws(()=>settlePosition(moved,p.id,{...r,minuteLasts:r.minuteLasts.filter(b=>b.t!==S0+3*MIN)},later),/Lucka i 1-minuterspriserna för BTC/);
  // Live: a quote taken before the change cannot trigger the new stop; one taken after it does. Liquidation needs no level.
  assert.equal(checkQuote(moved,p.id,{price:99.4,mark:99.4,at:t-1000},t+1000).positions.length,1);
  const live=checkQuote(moved,p.id,{price:99.4,mark:99.4,at:t+500},t+1000).trades[0];
  assert.deepEqual([live.reason,live.closedAt],['stopp',t+1000]);near(live.exit,99.4*(1-SLIP));
  assert.equal(checkQuote(moved,p.id,{price:90,mark:q.liq-.01,at:t-1000},t+1000).trades[0].reason,'likvidation');
});

test('after a change of the stop or target the liquidation is still checked on every minute of that 5-minute step after the opening; the new levels only on the minutes after the change',()=>{
  // A manual long at 25× opened at 10:00:01, its stop at 98,5. At 10:12:20 the stop moves up to 99,2, settled up to then.
  const S0=T+2*STEP,t=S0+2*MIN+20000,later=S0+2*STEP+1000;
  const {account:a,position:p}=order(newForecastAccount(T-HOUR),{quote:btcQuote(T+1000,100),margin:20,leverage:25,sl:98.5});
  const held=settlePosition(a,p.id,riskFor(p,t),t);
  const moved=setLevels(held,p.id,{sl:99.2},{quote:btcQuote(t,100),contract:bybitLimits('BTC',t),now:t}).account,q=moved.positions[0];
  assert.deepEqual([q.sl,q.levelsAt,q.nextBar,q.liq],[99.2,t,S0+STEP,p.liq]);
  // The replay reads the mark from the start of the step, the last price from the minute after the change.
  const r=riskFor(q,later);
  assert.deepEqual([r.minuteMarks.map(b=>b.t),r.minuteLasts.map(b=>b.t)],[[0,1,2,3,4].map(k=>S0+k*MIN),[S0+3*MIN,S0+4*MIN]]);
  // A mark wick through the liquidation level while the page was closed, in the minute of the change or the one before:
  // liquidated at that minute's end, as the 5-minute candle liquidates it without the change.
  for(const minute of [S0+2*MIN,S0+MIN]){
    const done=settlePosition(moved,p.id,riskFor(q,later,{minuteMarks:{[minute]:{l:q.liq-.05}}}),later).trades[0];
    assert.deepEqual([done?.reason,done?.closedAt],['likvidation',minute+MIN],String((minute-S0)/MIN));
    near(done.pnl,-(p.margin+p.fees+p.reserve));near(done.fees,p.fees+p.reserve);
  }
  const without=settlePosition(held,p.id,riskFor(held.positions[0],later,{marks:{[S0]:{l:q.liq-.05}}}),later).trades[0];
  assert.deepEqual([without.reason,without.closedAt],['likvidation',S0+STEP]);
  // A last price under the new stop in the minute of the change does not stop it: that minute also holds prices from before
  // the change. One minute later it does, at the new stop.
  const early={...r,minuteLasts:[{t:S0+2*MIN,o:100,h:100,l:99.1,c:100},...r.minuteLasts]};
  assert.deepEqual(settlePosition(moved,p.id,early,later).positions.map(x=>x.nextBar),[S0+2*STEP]);
  const stop=settlePosition(moved,p.id,riskFor(q,later,{minuteLasts:{[S0+3*MIN]:{l:99.1}}}),later).trades[0];
  assert.deepEqual([stop.reason,stop.closedAt],['stopp',S0+4*MIN]);near(stop.exit,99.2*(1-SLIP));
  // Every closed minute of the mark is needed, also before the change.
  assert.throws(()=>settlePosition(moved,p.id,{...r,minuteMarks:r.minuteMarks.filter(b=>b.t!==S0+MIN)},later),/Lucka i 1-minuterspriserna för BTC/);
  // Opened inside that step, at 10:11:10: the minutes before the opening count for nothing, not even for the liquidation.
  const o=order(newForecastAccount(T-HOUR),{quote:btcQuote(S0+MIN+10000,100),margin:20,leverage:25,contract:bybitLimits('BTC',S0+MIN+10000),now:S0+MIN+10000});
  const o2=setLevels(settlePosition(o.account,o.position.id,riskFor(o.position,t),t),o.position.id,{sl:99.2},{quote:btcQuote(t,100),contract:bybitLimits('BTC',t),now:t}).account;
  const q2=o2.positions[0],r2=riskFor(q2,later);
  assert.deepEqual([r2.minuteMarks.map(b=>b.t),r2.minuteLasts.map(b=>b.t)],[[2,3,4].map(k=>S0+k*MIN),[S0+3*MIN,S0+4*MIN]]);
  const before={...r2,minuteMarks:[{t:S0+MIN,o:100,h:100,l:q2.liq-.05,c:100},...r2.minuteMarks]};
  assert.equal(settlePosition(o2,q2.id,before,later).positions.length,1);
  assert.equal(settlePosition(o2,q2.id,riskFor(q2,later,{minuteMarks:{[S0+2*MIN]:{l:q2.liq-.05}}}),later).trades[0].reason,'likvidation');
});

test('a long absence is settled window by window, each up to its end, and the windows book exactly what one long replay books',()=>{
  // Three days of 5-minute candles in a random walk, funding every 8 hours.
  let seed=29;const rnd=()=>(seed=seed*16807%2147483647)/2147483647;
  const bars=[];let px=100;
  for(let t=T;t<T+864*STEP;t+=STEP){const o=px,c=o*(1+(rnd()-.5)*.004);bars.push({t,o,h:Math.max(o,c)*(1+rnd()*.001),l:Math.min(o,c)*(1-rnd()*.001),c});px=c;}
  const funding=bars.filter(b=>b.t%(8*HOUR)===0).map(b=>({t:b.t,rate:(rnd()-.4)*.001}));
  const riskAt=(q,now)=>{
    const cur=Math.floor(now/STEP)*STEP,from=Math.min(q.nextBar,Math.floor(q.fundingThrough/STEP)*STEP),seen=bars.filter(b=>b.t>=from&&b.t<=cur),mm=[],ml=[];
    const since=Math.max(q.openedAt,q.levelsAt),first=(Math.floor(since/STEP)+1)*STEP;
    for(let t=Math.max(first-STEP,Math.ceil(q.openedAt/MIN)*MIN);t<first&&t<=now;t+=MIN){const b=bars.find(x=>x.t===first-STEP),m={t,o:b.o,h:b.o,l:b.o,c:b.o};mm.push(m);if(t>=Math.ceil(since/MIN)*MIN)ml.push(m);}
    return {price:seen.at(-1).c,mark:seen.at(-1).c,at:now,markBars:seen,lastBars:seen.filter(b=>b.t>=q.nextBar),minuteMarks:mm,minuteLasts:ml,
      funding:funding.filter(f=>f.t>q.fundingThrough&&f.t<=now),fundingThrough:now,historyFrom:from};
  };
  // fetchPositionRisk's window: the candles before `through`, the funding before it.
  const windowOf=(r,through)=>({...r,markBars:r.markBars.filter(b=>b.t<through),lastBars:r.lastBars.filter(b=>b.t<through),
    funding:r.funding.filter(f=>f.t<through),fundingThrough:through-STEP,through});
  const end=T+863*STEP+1000,start=(x,id)=>{const q=x.positions.find(y=>y.id===id);return Math.min(q.nextBar,Math.floor(q.fundingThrough/STEP)*STEP);};
  const cases=[
    order(newForecastAccount(T-HOUR),{quote:btcQuote(T+1000,100),margin:20,leverage:3}),
    order(newForecastAccount(T-HOUR),{quote:btcQuote(T+1000,100),margin:20,leverage:5,side:'short',sl:104}),
    open(tenX({tf:'15m'}),{sig:signal({tf:'15m',barTime:T-15*MIN,sl:97,tp:103})})];
  for(const {account:a,position:p} of cases){
    const once=settlePosition(a,p.id,riskAt(p,end),end);
    let x=a,windows=0;
    while(x.positions.length&&start(x,p.id)+200*STEP<=Math.floor((end-8*HOUR)/STEP)*STEP){
      const through=start(x,p.id)+200*STEP,before=x.positions[0];
      x=settlePosition(x,p.id,windowOf(riskAt(before,end),through),end);windows++;
      if(x.positions.length){
        const q=x.positions[0];
        // Settled up to the window's end and no further: its funding, not one at its end; nor the time stop due by now.
        assert.deepEqual([q.nextBar,q.fundingThrough],[through,through-STEP]);
        near(q.funding,funding.filter(f=>f.t>before.fundingThrough&&f.t<through).reduce((s,f)=>s+(q.side==='long'?1:-1)*q.units*bars.find(b=>b.t===f.t).o*f.rate,before.funding));
      }
    }
    if(x.positions.length)x=settlePosition(x,p.id,riskAt(x.positions[0],end),end);
    // The manual positions are still open at the end (the price fell from 100 to 94); the signal one ended at its time stop.
    assert.ok(p.origin==='signal'?windows===1&&x.trades[0].reason==='tid':windows===3&&x.positions.length===1,p.origin+' '+windows);
    assert.deepEqual(x,once,p.side+' '+p.origin);
  }
  // A window ends on a 5-minute boundary of a closed candle, and says so in its funding mark.
  const {account:a,position:p}=cases[0],r=riskAt(p,end),through=p.nextBar+100*STEP;
  for(const bad of [{...windowOf(r,through),through:through+1},{...windowOf(r,through),fundingThrough:through},windowOf(r,Math.floor(end/STEP)*STEP+STEP)])
    assert.throws(()=>settlePosition(a,p.id,bad,end),/Markpris- eller fundinghistorik saknas för BTC/);
  // A signal position past its time stop by now, with the deadline after the window: still open after it, closed at the
  // deadline candle by a later one.
  const s=cases[2],w=settlePosition(s.account,s.position.id,windowOf(riskAt(s.position,end),s.position.nextBar+2*STEP),end);
  assert.ok(end>s.position.deadline&&s.position.nextBar+2*STEP<s.position.deadline);assert.equal(w.positions.length,1);
});

test('a manual position without a stop, a target or a time stop ends only by liquidation or the user\'s close, and pays funding meanwhile',()=>{
  const {account:a,position:p}=order(newForecastAccount(T-HOUR),{quote:btcQuote(T+1000,100),margin:20});
  assert.deepEqual([p.sl,p.tp,p.deadline],[null,null,null]);
  // 30 hours later, the price having been far from the entry both ways, with a funding every 8 hours.
  const now=T+30*HOUR,funding=[8,16,24].map(h=>({t:T+h*HOUR,rate:.0001})),swings={[T+2*HOUR]:{l:92},[T+5*HOUR]:{h:130}};
  const s=settlePosition(a,p.id,riskFor(p,now,{lasts:swings,funding}),now),paid=3*p.units*100*.0001;
  assert.deepEqual([s.positions.length,s.trades],[1,[]]);near(s.positions[0].funding,paid);
  // Paid from the free cash, as Bybit takes it: the margin and the liquidation price stay where they were.
  near(s.cash,a.cash-paid);assert.deepEqual([s.positions[0].margin,s.positions[0].liq],[p.margin,p.liq]);
  assert.equal(checkQuote(s,p.id,{price:150,mark:150,at:now-1000},now).positions.length,1);
  assert.equal(checkQuote(s,p.id,{price:93,mark:93,at:now-1000},now).positions.length,1);
  // A liquidation loses the margin, the opening fee and the reserved fee to close; the funding was paid on the way.
  const liq=checkQuote(s,p.id,{price:80,mark:s.positions[0].liq-.01,at:now-1000},now).trades[0];
  assert.deepEqual([liq.reason,liq.origin],['likvidation','manual']);near(liq.pnl,-(p.margin+p.fees+p.reserve+paid));near(liq.funding,paid);
  // A mark through the level in a replayed candle liquidates it too.
  const crash=settlePosition(a,p.id,riskFor(p,now,{marks:{[T+3*HOUR]:{l:p.liq-.01}},funding}),now).trades[0];
  assert.deepEqual([crash.reason,crash.closedAt],['likvidation',T+3*HOUR+STEP]);
  // No distance to a missing level.
  const row=accountLive(s,{BTC:{price:101,mark:101,at:now-1000}},now).positions[0];
  assert.deepEqual([row.toSl,row.toTp,row.price],[null,null,101]);
});

test('deposits and withdrawals are ledger entries: free cash only, whole cents up to 1 000 000 $, and the ledger reconciles',()=>{
  let a=deposit(newForecastAccount(T-HOUR),50,T);
  assert.deepEqual([a.cash,a.transfers,a.log.at(-1)],[150,[{id:'t|1|'+T,t:T,kind:'in',amount:50,cashAfter:150,tradeCount:0}],
    {t:T,kind:'insättning',symbol:null,signalId:null,text:'Insättning 50,00 $'}]);
  a=withdraw(a,20.5,T+1000);
  assert.deepEqual([a.cash,a.transfers[1],a.log.at(-1).text],[129.5,{id:'t|2|'+(T+1000),t:T+1000,kind:'out',amount:20.5,cashAfter:129.5,tradeCount:0},'Uttag 20,50 $']);
  // With a position open, its margin cannot be withdrawn: only the free cash, as the page shows it in whole cents.
  const o=order(a,{margin:50}).account,free=o.cash;
  const refusal='Det går bara att ta ut tillgängligt saldo (högst '+money2(free)+' $), inte marginalen i öppna positioner';
  assert.throws(()=>withdraw(o,Math.round(free*100)/100+.01,T+2000),{message:refusal});
  // 89,8297… $ of free cash shows as 89,83 $, and 89,83 $ can be taken out: that takes all of it, to 0 $, and books what
  // there was (the amount typed is whole cents; the fees left the free cash with less than a cent more).
  const doge=openManual(newForecastAccount(T-HOUR),{symbol:'DOGE',side:'long',margin:10.07,leverage:10,quote:{price:.2,mark:.2,at:T+1000},
    contract:bybitLimits('DOGE',T+1000,[{id:1,cap:1e7,max:75,maintenance:.01,deduction:0}],75),now:T+1000}).account;
  assert.equal(money2(doge.cash),'89,83');assert.ok(doge.cash<89.83);
  const emptied=withdraw(doge,89.83,T+2000),out=emptied.transfers.at(-1);
  assert.deepEqual([emptied.cash,out.kind,out.amount,out.cashAfter,emptied.log.at(-1).text],[0,'out',doge.cash,0,'Uttag 89,83 $']);
  assert.deepEqual(emptied.positions,doge.positions);
  assert.throws(()=>withdraw(doge,89.84,T+2000),{message:'Det går bara att ta ut tillgängligt saldo (högst 89,83 $), inte marginalen i öppna positioner'});
  // Less than all of it leaves the rest.
  near(withdraw(doge,89.82,T+2000).cash,doge.cash-89.82);
  const all=withdraw(o,Math.floor(free*100)/100,T+2000);
  assert.ok(all.cash>=0&&all.cash<.01);assert.deepEqual(all.positions,o.positions);
  // Amounts: over 0, at most 1 000 000 $, whole cents.
  for(const [x,message] of [[0,'Ange ett belopp över 0 $'],[-5,'Ange ett belopp över 0 $'],[NaN,'Ange ett belopp över 0 $'],['50','Ange ett belopp över 0 $'],
    [1e6+.01,'Högst '+sv(1e6,0)+' $ per insättning eller uttag'],[12.345,'Ange beloppet i hela cent']]){
    assert.throws(()=>deposit(a,x,T),{message});assert.throws(()=>withdraw(a,x,T),{message});
  }
  assert.equal(deposit(a,1e6,T).cash,a.cash+1e6);assert.equal(deposit(a,.1+.2,T).transfers.at(-1).amount,.3);
  assert.throws(()=>deposit(a,5,NaN),/Ogiltig tid/);
  // setFree deposits or withdraws the difference.
  const down=setFree(a,75,T+3000),up=setFree(down,200,T+4000);
  assert.deepEqual([down.cash,down.transfers.at(-1).kind,down.transfers.at(-1).amount,down.log.at(-1).text],[75,'out',54.5,'Uttag 54,50 $']);
  assert.deepEqual([up.cash,up.transfers.at(-1).kind,up.transfers.at(-1).amount,up.log.at(-1).text],[200,'in',125,'Insättning 125,00 $']);
  assert.throws(()=>setFree(up,200,T+5000),{message:'Tillgängligt saldo är redan 200,00 $'});
  for(const [x,message] of [[-1,'Ange ett tillgängligt saldo på 0 $ eller mer'],[NaN,'Ange ett tillgängligt saldo på 0 $ eller mer'],[12.345,'Ange beloppet i hela cent'],
    [2e6,'Högst '+sv(1e6,0)+' $ per insättning eller uttag']])assert.throws(()=>setFree(a,x,T),{message});
  // With a position open, the free cash can be set to anything from 0 $: the margin stays where it is.
  const zero=setFree(o,0,T+5000);
  assert.equal(zero.cash,0);near(zero.transfers.at(-1).amount,free);assert.deepEqual(zero.positions,o.positions);
  const ten=setFree(o,10,T+5000);assert.equal(ten.cash,10);near(ten.transfers.at(-1).amount,free-10);
  // A trade closed after transfers: its realized equity includes them, and the transfer after it counts the trades before it.
  const closed=closePosition(ten,ten.positions[0].id,{price:60000,now:T+6000,reason:'manuell'}),later=deposit(closed,5,T+7000);
  near(closed.trades[0].equityAfter,closed.cash);assert.equal(later.transfers.at(-1).tradeCount,1);
  near(later.cash,100+50-20.5-(free-10)+closed.trades[0].pnl+5);
  // The ledger reconciles: start + deposits − withdrawals + realized results − what open positions locked up.
  const broken=f=>{const x=structuredClone(up);f(x);return ()=>validateForecastAccount(x);};
  assert.throws(broken(x=>{x.transfers[0].amount=60;}),/kassa stämmer inte/);
  assert.throws(broken(x=>{x.transfers[0].kind='gåva';}),/Ogiltig insättning eller uttag/);
  assert.throws(broken(x=>{x.transfers[0].tradeCount=1;}),/Ogiltig insättning eller uttag/);
  assert.throws(broken(x=>{x.transfers[1].id=x.transfers[0].id;}),/Ogiltig insättning eller uttag/);
  assert.throws(broken(x=>{x.transfers[0].cashAfter=-1;}),/Ogiltig insättning eller uttag/);
  assert.throws(broken(x=>{x.transfers[0].amount=2e6;x.cash+=2e6-50;}),/Ogiltig insättning eller uttag/);
  // Transfers stay in the order they were made: one cannot come after a trade and before an earlier transfer.
  const unordered=structuredClone(later);unordered.transfers[0].tradeCount=1;
  assert.throws(()=>validateForecastAccount(unordered),/Ogiltig insättning eller uttag/);
});

test('accountStats: a deposit is no gain and a withdrawal no drawdown; win rate and profit factor come from the trades alone',()=>{
  // +10, then a 1 000 $ deposit, −55, then a 500 $ withdrawal, +5,55.
  const a=newForecastAccount(T-10*HOUR);
  a.trades=[[10,110],[-55,1055],[5.55,560.55]].map(([pnl,equityAfter],i)=>({id:'p|s'+i,symbol:SYMBOLS[i],side:'long',signalId:'s'+i,tf:'1h',entry:100,exit:100+pnl/10,
    units:1,margin:60,leverage:10,openedAt:T+i*HOUR,closedAt:T+i*HOUR+60000,reason:pnl<0?'stopp':'mål',pnl,fees:0,funding:0,equityAfter,origin:'signal'}));
  a.transfers=[{id:'t|1',t:T+HOUR-1000,kind:'in',amount:1000,cashAfter:1110,tradeCount:1},{id:'t|2',t:T+2*HOUR-1000,kind:'out',amount:500,cashAfter:555,tradeCount:2}];
  a.cash=560.55;
  const s=accountStats(validateForecastAccount(a));
  assert.deepEqual([s.trades,s.wins,s.losses,s.deposits,s.withdrawals,s.netTransfers],[3,2,1,1000,500,500]);
  near(s.winRate,2/3);near(s.net,-39.45);near(s.profitFactor,15.55/55);assert.equal(s.best,10);assert.equal(s.worst,-55);
  // −55 on 1 110 $ is the deepest fall, 4,95 %; the 500 $ withdrawal is no fall from 1 055 $ to 560,55 $ (47 %).
  near(s.maxDrawdown,55/1110);
  // A deposit before any trade, then a loss: measured on the capital at the time.
  const b=newForecastAccount(T-10*HOUR);
  b.transfers=[{id:'t|1',t:T,kind:'in',amount:100,cashAfter:200,tradeCount:0}];
  b.trades=[{...a.trades[1],pnl:-20,equityAfter:180,id:'p|x',signalId:'x'}];b.cash=180;
  near(accountStats(validateForecastAccount(b)).maxDrawdown,.1);
  // A withdrawal down to 20 $, then a 2 $ gain: no drawdown at all.
  const c=newForecastAccount(T-10*HOUR);
  c.transfers=[{id:'t|1',t:T,kind:'out',amount:80,cashAfter:20,tradeCount:0}];
  c.trades=[{...a.trades[0],pnl:2,equityAfter:22,id:'p|y',signalId:'y'}];c.cash=22;
  assert.equal(accountStats(validateForecastAccount(c)).maxDrawdown,0);
  // An account emptied before a deposit stays at its 100 % drawdown: new money wins nothing back.
  const d=newForecastAccount(T-10*HOUR);
  d.trades=[{...a.trades[1],pnl:-100,equityAfter:0,id:'p|z',signalId:'z',margin:100},{...a.trades[0],pnl:5,equityAfter:55,id:'p|w',signalId:'w'}];
  d.transfers=[{id:'t|1',t:T,kind:'in',amount:50,cashAfter:50,tradeCount:1}];d.cash=55;
  assert.equal(accountStats(validateForecastAccount(d)).maxDrawdown,1);
  // accountLive: the result since the start leaves the transfers out.
  const live=accountLive(deposit(newForecastAccount(T),50,T),{},T);
  assert.deepEqual([live.equity,live.netTransfers,live.result],[150,50,0]);
  const {account:o,position:p}=order(withdraw(newForecastAccount(T-HOUR),30,T),{margin:20}),l=accountLive(o,{BTC:{price:61000,mark:61000,at:T+1500}},T+2000);
  near(l.result,l.equity-100+30);near(l.result,l.openPnl);assert.equal(l.netTransfers,-30);assert.equal(l.positions[0].id,p.id);
  assert.deepEqual([accountLive(o,{},T+2000).result,accountLive(o,{},T+2000).equity],[null,null]);
});
