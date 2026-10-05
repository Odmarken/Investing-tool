import test from 'node:test';
import assert from 'node:assert/strict';
import {ACCOUNT,SETTING_LIMITS,accountKey,newForecastAccount,validateForecastAccount,readForecastAccount,updateSettings,setPaused,markProcessed,
  sizePosition,openPosition,settlePosition,checkQuote,closePosition,accountLive,accountStats,tradeReasons} from '../forecast-account.js';
import {TF,SYMBOLS,SIGNAL_PARAMS,MODEL} from '../forecast-config.js';
import {CONTRACTS,LIMIT_TTL,isolatedLevel,maxLeverageFor} from '../bybit-contracts.js';

const MIN=60000,HOUR=3600000,STEP=ACCOUNT.step,FEE=ACCOUNT.fee,SLIP=ACCOUNT.slip;
// An hour boundary: the 1h candle that opened an hour earlier has just closed.
const T=Date.parse('2026-10-05T10:00:00Z');
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps*Math.max(1,Math.abs(b)),a+' vs '+b);
const deepFreeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.freeze(x);Object.values(x).forEach(deepFreeze);}return x;};
const SINGLE=[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}];
// Tier 2's deduction keeps the maintenance margin continuous at tier 1's cap, as on Bybit.
const TIERED=[{id:1,cap:1000,max:150,maintenance:.005,deduction:0},{id:2,cap:100000,max:50,maintenance:.01,deduction:5}];
// Bybit's limits as parseContract returns them.
const limits=(symbol='BTC',at=T,tiers=SINGLE,max=150)=>({symbol,contract:CONTRACTS[symbol],at,min:1,max,step:.01,tiers:tiers.map(t=>({...t}))});
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
// opened in from the minute after the open, with per-candle overrides.
function riskFor(p,now,{price=100,marks={},lasts={},minuteMarks={},minuteLasts={},funding=[],quote=price}={}){
  const from=Math.min(p.nextBar,Math.floor(p.fundingThrough/STEP)*STEP),markBars=[],lastBars=[],mm=[],ml=[];
  for(let t=from;t<=Math.floor(now/STEP)*STEP;t+=STEP){
    const flat={t,o:price,h:price,l:price,c:price};
    markBars.push({...flat,...marks[t]});lastBars.push({...flat,...lasts[t]});
  }
  for(let t=Math.ceil(p.openedAt/MIN)*MIN;t<(Math.floor(p.openedAt/STEP)+1)*STEP&&t<=now;t+=MIN){
    const flat={t,o:price,h:price,l:price,c:price};
    mm.push({...flat,...minuteMarks[t]});ml.push({...flat,...minuteLasts[t]});
  }
  return {price:quote,mark:quote,at:now,markBars,lastBars,minuteMarks:mm,minuteLasts:ml,funding,fundingThrough:now,historyFrom:from};
}
const memoryStorage=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v))};};

test('a new account holds 100 $ of its own under its own key, and storage refuses unknown versions',()=>{
  const a=newForecastAccount(T);
  assert.deepEqual({...a,settings:null},{version:'ai-forecast-account-v1',createdAt:T,start:100,cash:100,settings:null,positions:[],trades:[],log:[],processed:{},fees:0,funding:0});
  assert.deepEqual(a.settings,{tf:'1h',symbols:[...SYMBOLS],positionPct:.25,riskPct:.1,maxOpen:3,leverage:'max',paused:false});
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
  storage.setItem(key,JSON.stringify({...held,version:'ai-forecast-account-v2'}));
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
    [x=>{x.version='ai-forecast-account-v2';},/annan version \(ai-forecast-account-v2\)\. Ladda om sidan/],
    [x=>{x.version='trading-floor-v3';},/Ogiltigt AI Forecast-konto/],
    [x=>{delete x.positions;},/Ogiltigt AI Forecast-konto/],
    [x=>{x.createdAt=0;},/Ogiltigt AI Forecast-konto/]
  ];
  for(const [corrupt,reason] of cases)assert.throws(()=>validateForecastAccount(broken(corrupt)),reason);
  for(const value of [null,undefined,42,'konto',[]])assert.throws(()=>validateForecastAccount(value),/Ogiltigt AI Forecast-konto/);
  assert.equal(validateForecastAccount(JSON.parse(JSON.stringify(both))).positions[0].symbol,'ETH');
  // Every function checks the account it is given.
  const bad=broken(x=>{x.cash+=1;});
  for(const run of [()=>open(bad),()=>settlePosition(bad,'x',null,T),()=>checkQuote(bad,'x',null,T),()=>closePosition(bad,'x',{price:1,now:T,reason:'manuell'}),
    ()=>accountLive(bad,{},T),()=>accountStats(bad),()=>updateSettings(bad,{}),()=>markProcessed(bad,'BTC',T)])assert.throws(run,/kassa stämmer inte/);
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
    updateSettings(a,deepFreeze({maxOpen:4,symbols:['BTC']})),setPaused(a,true),markProcessed(a,'BTC',T)
  ];
  for(const r of results){assert.notEqual(r,a);assert.equal(validateForecastAccount(r),r);}
  assert.equal(results[2].trades[0].reason,'stopp');near(results[2].funding,p.units*100*.001);
  sizePosition(deepFreeze({equity:100,cash:100,settings:a.settings,contract:c,side:'long',price:100,mark:100,sl:98,now:T+1000}));
  accountLive(a,deepFreeze({BTC:q}),T+3000);accountStats(a);
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
