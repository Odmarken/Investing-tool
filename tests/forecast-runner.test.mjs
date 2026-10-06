import test from 'node:test';
import assert from 'node:assert/strict';
import {createForecastRunner,RUNNER} from '../forecast-runner.js';
import {ACCOUNT,accountKey,newForecastAccount as plainAccount,openPosition,markProcessed,sizePosition,setPaused,updateSettings,previewOrder,previewLevels,
  validateForecastAccount} from '../forecast-account.js';
import {createForecastStore,memoryBackend,localStorageBackend,signalRecord,verifyRecord,hashOf} from '../forecast-store.js';
import {fetchKlines,fetchHistory,splitForming,fetchPositionRisk} from '../forecast-market.js';
import {fetchMomentumQuotes} from '../crypto-momentum-live.js';
import {fetchContract,createContractCache,LIMIT_TTL} from '../bybit-contracts.js';
import {TF,SYMBOLS,CHART_TFS,SIGNAL_PARAMS,MODEL} from '../forecast-config.js';
import {evaluateBar,requiredLookback,signalsInRange,aggregateClosed} from '../forecast-model.js';
import {scriptMarket,fakeBybit,limitsFor,memoryStorage,tabLocks,urlKinds,START,STEP,HOUR,DAY,FUND,SCALE,MAX_LEVERAGE,FUNDING_RATE} from './forecast-fixtures.mjs';

const SEC=1000,MIN=60000,SLIP=ACCOUNT.slip;
// Most tests here are about trading the signals: their accounts have auto-trading on (a new account has it off).
const newForecastAccount=(t,settings={})=>plainAccount(t,{auto:true,...settings});
const m=scriptMarket(),[L1,L2,L3]=m.longs,[S1]=m.shorts;
// A moment after bar i closed on Bybit's clock.
const after=(i,ms=2*SEC)=>m.closeOf(i)+ms;
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps*Math.max(1,Math.abs(b)),a+' vs '+b);
const hhmm=t=>new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm',hour:'2-digit',minute:'2-digit'});
const API='https://api.bybit.com/v5/market/';

// One browser profile: storage, record archive and tab locks are shared by every tab() runner.
function harness({user='u1',time,settings=null,created=null,runtime={},storage=memoryStorage(),store=createForecastStore(memoryBackend()),locks=tabLocks()}={}){
  const rt={at:time,urls:[],market:m,...runtime},who={user,active:true};
  if(settings)storage.setItem(accountKey(user),JSON.stringify(newForecastAccount(created??time-HOUR,settings)));
  const tab=(over={})=>createForecastRunner({grab:fakeBybit(rt),storage,store,locks,now:()=>rt.at,getUser:()=>who.user,isActive:()=>who.active,...over});
  return {rt,who,storage,store,locks,tab,runner:tab()};
}
const saved=(storage,user='u1')=>JSON.parse(storage.getItem(accountKey(user)));
// What the runner sees at this moment, without adding to the request log.
const quoteAt=async(rt,symbol)=>(await fetchMomentumQuotes(fakeBybit({...rt,urls:[]}),[symbol],()=>rt.at))[symbol];
const signalsOf=async(store,symbol,user='u1',tf='1h')=>(await store.listSignals(user,symbol,tf)).records;
const opens=a=>a.log.filter(e=>e.kind==='öppnad');
async function ticks(runner,n){for(let k=0;k<n;k++)await runner.tick();}

test('the scripted market signals exactly at its volume spikes on every timeframe',()=>{
  for(const tf of CHART_TFS){
    const mk=scriptMarket({tf}),bars=mk.bars(0,mk.end+10);
    assert.deepEqual(mk.signals.map(s=>s.side),['long','long','long','short','short'],tf);
    assert.deepEqual(signalsInRange(bars,0,bars.length-1,{tf}).map(e=>[e.t,e.side]),mk.signals.map(s=>[s.t,s.side]),tf);
    assert.ok(mk.signals[0].i>=requiredLookback(tf),tf+' has the full lookback before its first signal');
    assert.ok(mk.signals.every(s=>s.close===s.t+TF[tf].ms&&s.i>=mk.quiet&&s.i<mk.end));
    // Spikes are at least `spacing` bars apart, so no signal waits on the cooldown.
    assert.ok(mk.longs.every((s,k)=>!k||s.i-mk.longs[k-1].i>=8));
  }
  assert.equal(scriptMarket(),m,'memoized');
  // Random access beyond the script continues with valid candles that open at the previous close.
  for(const i of [m.end-1,m.end,m.end+1,m.end+500]){
    const b=m.bar(i),prev=m.bar(i-1);
    assert.ok(b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.v>0);
    assert.equal(b.o,prev.c);assert.equal(b.t,START+i*HOUR);
  }
  assert.equal(m.bar(-1),null);
  // A quiet market has no signals at all.
  const flat=scriptMarket({up:0,down:0,longs:0,shorts:0});
  assert.deepEqual(flat.signals,[]);
});

test('the fake Bybit serves one consistent price path to every endpoint the runner reads',async()=>{
  const rt={at:L1.close+90*SEC,urls:[],market:m},grab=fakeBybit(rt),now=()=>rt.at;
  const hourly=await fetchKlines(grab,'BTC','1h',{limit:1000,now}),{closed,forming}=splitForming(hourly.bars,'1h',hourly.serverTime);
  assert.equal(hourly.serverTime,rt.at);
  assert.equal(closed[0].t,START);assert.equal(closed.length,L1.i+1);assert.equal(closed.at(-1).t,L1.t);
  assert.equal(forming.t,L1.close,'Bybit includes the forming candle');
  near(closed.at(-1).c,m.bar(L1.i).c*SCALE.BTC);assert.equal(closed.at(-1).v,m.bar(L1.i).v);
  // 5-minute candles aggregate into the hour exactly, hours into the 4h candle.
  const b=closed.at(-1),five=(await fetchKlines(grab,'BTC','5m',{limit:12,end:b.t+HOUR-1,now})).bars;
  assert.deepEqual(five.map(x=>x.t),Array.from({length:12},(_,k)=>b.t+k*STEP));
  assert.deepEqual({t:b.t,o:five[0].o,h:Math.max(...five.map(x=>x.h)),l:Math.min(...five.map(x=>x.l)),c:five.at(-1).c,v:five.reduce((s,x)=>s+x.v,0)},b);
  // `end` picks candles by open time; the 08:00 4h candle is still forming, the one before is complete.
  const four=(await fetchKlines(grab,'BTC','4h',{limit:3,end:b.t,now})).bars;
  assert.equal(four.at(-1).t,Math.floor(b.t/(4*HOUR))*4*HOUR);
  assert.deepEqual(four.at(-2),aggregateClosed(closed,'1h','4h',b.t+HOUR).at(-1));
  // start/end/limit paging, newest first, as Bybit answers.
  const page=await grab(API+'kline?'+new URLSearchParams({category:'linear',symbol:'ETHUSDT',interval:'60',start:String(m.bar(10).t),end:String(m.bar(14).t),limit:'3'}));
  assert.deepEqual(page.result.list.map(r=>+r[0]),[14,13,12].map(i=>m.bar(i).t));
  const all=await fetchHistory(grab,'ETH','1h',{count:2000,now});
  assert.equal(all.bars.length,L1.i+2);assert.equal(all.bars[0].t,START);
  // Tickers: SHIB quotes 1000 tokens and the quote divides back; the price is the forming candle's close.
  const q=await fetchMomentumQuotes(grab,['BTC','SHIB'],now);
  near(q.BTC.price,forming.c);assert.equal(q.BTC.at,rt.at);
  const shib=(await grab(API+'tickers?category=linear&symbol=SHIB1000USDT')).result.list[0];
  near(+shib.lastPrice/1000,q.SHIB.price);near(q.SHIB.price/SCALE.SHIB,q.BTC.price/SCALE.BTC);
  // Limits match limitsFor; funding every 8 hours; the risk replay reads mark and last 5-minute candles.
  assert.deepEqual(await fetchContract(grab,'SOL',now),limitsFor('SOL',rt.at));
  const p={nextBar:Math.floor((rt.at-5*HOUR)/STEP)*STEP,fundingThrough:rt.at-5*HOUR};
  const risk=await fetchPositionRisk(grab,'BTC',p,now);
  assert.deepEqual(risk.funding,[{t:Math.floor(rt.at/FUND)*FUND,rate:FUNDING_RATE}]);
  assert.equal(risk.markBars[0].t,p.nextBar);assert.equal(risk.lastBars.at(-1).t,Math.floor(rt.at/STEP)*STEP);
  assert.deepEqual(risk.markBars.slice(0,-1),risk.lastBars.slice(0,-1).map(({t,o,h,l,c})=>({t,o,h,l,c})));
  assert.deepEqual(urlKinds(rt.urls),['funding/history','instruments-info','kline:240','kline:5','kline:60','mark-price-kline:5','risk-limit','tickers']);
});

test('fixture knobs: price override, shocks, holes, lag, clock skew and failures',async()=>{
  const rt={at:L1.close+7*MIN,urls:[],market:m},grab=fakeBybit(rt),now=()=>rt.at;
  const base=await quoteAt(rt,'BTC');
  rt.price={BTC:50000};
  const q=await quoteAt(rt,'BTC');
  assert.equal(q.price,50000);assert.equal(q.mark,50000);
  const formingNow=(await fetchKlines(grab,'BTC','1h',{limit:2,now})).bars.at(-1);
  assert.equal(formingNow.c,50000);assert.equal(formingNow.l,50000);
  rt.mark={BTC:49000};assert.equal((await quoteAt(rt,'BTC')).mark,49000);
  delete rt.price;delete rt.mark;
  near((await quoteAt(rt,'BTC')).price,base.price);
  // A shock scales every candle from its 5-minute candle on, so the gap shows at that open.
  const at=L1.close+5*MIN;rt.shocks=[{symbol:'BTC',at,factor:.9}];
  const five=(await fetchKlines(grab,'BTC','5m',{limit:3,now})).bars;
  assert.equal(five.at(-1).t,at);
  near(five.at(-1).o,m.sub((at-START)/STEP).o*SCALE.BTC*.9);
  near(five.at(-2).c,m.sub((at-START)/STEP-1).c*SCALE.BTC);
  near((await quoteAt(rt,'ETH')).price/SCALE.ETH,(await quoteAt({...rt,shocks:[]},'BTC')).price/SCALE.BTC);
  rt.shocks=[];
  // Holes leave out a candle; lag serves candles from an earlier moment; server shifts Bybit's time.
  rt.holes=new Set([`BTC:60:${m.bar(L1.i-2).t}`]);
  const holed=(await fetchKlines(grab,'BTC','1h',{limit:5,now})).bars.map(b=>b.t);
  assert.ok(!holed.includes(m.bar(L1.i-2).t)&&holed.includes(m.bar(L1.i-1).t));
  rt.holes=null;rt.lag={ETH:2*HOUR};
  assert.equal((await fetchKlines(grab,'ETH','1h',{limit:2,now})).bars.at(-1).t,m.bar(L1.i-1).t);
  rt.lag=null;rt.server=rt.at-3*SEC;
  assert.equal((await fetchKlines(grab,'BTC','1h',{limit:2,now})).serverTime,rt.at-3*SEC);
  rt.server=null;rt.fail=u=>u.pathname.endsWith('/tickers')?'Nätverksfel':null;
  await assert.rejects(grab(API+'tickers?category=linear&symbol=BTCUSDT'),/Nätverksfel/);
  rt.fail='Proxy nere';
  await assert.rejects(grab(API+'kline?category=linear&symbol=BTCUSDT&interval=60'),/Proxy nere/);
  rt.fail=null;
  assert.equal((await grab(API+'kline?category=spot&symbol=BTCUSDT&interval=60')).retCode,10001);
  await assert.rejects(grab(API+'orderbook?category=linear&symbol=BTCUSDT'),/Unexpected request/);
});

test('a scripted session: signals are stored once, fresh signals open at Bybit\'s maximum leverage in coin order, max open positions and one per coin hold, and liquidation, funding and targets settle',async()=>{
  const {rt,runner,storage,store}=harness({time:after(L1.i-3)});
  // Switching auto-trading on creates the account.
  assert.equal((await runner.setAuto(true)).ok,true);
  const first=await runner.tick();
  // A new 100 $ account trading every coin, decided up to the newest closed candle.
  let a=saved(storage);
  assert.equal(a.cash,100);assert.equal(a.createdAt,rt.at);assert.deepEqual(a.settings.symbols,[...SYMBOLS]);
  assert.deepEqual(a.processed,Object.fromEntries(SYMBOLS.map(s=>[s,m.bar(L1.i-3).t])));
  assert.deepEqual(urlKinds(rt.urls),['kline:60']);assert.equal(rt.urls.length,SYMBOLS.length);
  assert.ok(rt.urls.every(u=>u.searchParams.get('limit')===String(RUNNER.klines)));
  assert.equal(first.state,'trading');
  assert.equal(first.text,'Handlar · 0 av 3 positioner · nästa beslut '+hhmm(m.closeOf(L1.i-2)));
  assert.equal(first.nextDecision,m.closeOf(L1.i-2));
  assert.equal(Object.keys(runner.evaluations()).length,SYMBOLS.length);
  assert.equal(runner.evaluations().BTC.evaluation.side,null);
  // Within the same candle nothing is read.
  rt.urls=[];rt.at+=5*SEC;await runner.tick();
  assert.equal(rt.urls.length,0);

  // The first long breakout closes.
  const before=saved(storage);
  rt.at=after(L1.i);rt.urls=[];
  const st=await runner.tick();
  a=saved(storage);
  assert.deepEqual(a.positions.map(p=>[p.symbol,p.side,p.leverage]),[['BTC','long',MAX_LEVERAGE.BTC],['ETH','long',MAX_LEVERAGE.ETH],['SOL','long',MAX_LEVERAGE.SOL]]);
  assert.equal(st.text,'Handlar · 3 av 3 positioner · nästa beslut '+hhmm(m.closeOf(L1.i+1)));
  // Each coin's signal is stored once, live, sealed, and is what evaluateBar says about that candle.
  const bars=splitForming((await fetchKlines(fakeBybit({...rt,urls:[]}),'BTC','1h',{limit:1000,now:()=>rt.at})).bars,'1h',rt.at).closed;
  const expected=signalRecord('u1','BTC','1h',evaluateBar(bars,bars.length-1,{tf:'1h'}),{recordedAt:rt.at,origin:'live',tfMs:HOUR});
  for(const symbol of SYMBOLS){
    const list=await signalsOf(store,symbol);
    assert.equal(list.length,1,symbol);
    const r=list[0];
    assert.ok(verifyRecord(r));
    assert.deepEqual([r.barTime,r.confirmedAt,r.side,r.origin,r.recordedAt,r.model,r.paramsHash],[L1.t,L1.close,'long','live',rt.at,MODEL.signal,hashOf(SIGNAL_PARAMS)]);
    if(symbol==='BTC')assert.equal(r.contentHash,expected.contentHash);
  }
  // The same inputs through the account module give exactly this account: Bybit's limits, a fresh ticker
  // after the close, coin order for the last free slot, and every refusal logged once.
  let replay=before;
  for(const symbol of SYMBOLS){
    const rec=(await signalsOf(store,symbol))[0],quote=await quoteAt(rt,symbol),room=replay.positions.length<replay.settings.maxOpen;
    replay=openPosition(replay,{signal:rec,symbol,quote,contract:room?limitsFor(symbol,rt.at):null,now:rt.at,tfMs:HOUR,dataReliable:true}).account;
    replay=markProcessed(replay,symbol,L1.t);
  }
  assert.deepEqual(a,replay);
  assert.deepEqual(a.log.map(e=>[e.kind,e.symbol,e.text.replace(/ till .*/,'')]),[
    ['öppnad','BTC','Öppnade lång BTC'],['öppnad','ETH','Öppnade lång ETH'],['öppnad','SOL','Öppnade lång SOL'],
    ...['XRP','DOGE','SHIB','PEPE'].map(s=>['avvisad',s,'Max antal öppna positioner är nått (3)'])]);
  // At 100× the liquidation comes before the stop, so risk per trade sets the margin plus the opening fee: 10 % of equity.
  const btc=a.positions[0],rec=(await signalsOf(store,'BTC'))[0],quote=await quoteAt(rt,'BTC');
  const plan=sizePosition({equity:100,cash:100,settings:a.settings,contract:limitsFor('BTC',rt.at),side:'long',price:quote.price,mark:quote.mark,sl:rec.sl,now:rt.at});
  assert.deepEqual([btc.leverage,btc.margin,btc.units,btc.liq,btc.entry],[plan.leverage,plan.margin,plan.units,plan.liq,quote.price*(1+SLIP)]);
  assert.ok(btc.liq>rec.sl);near(btc.margin,10/(1+100*ACCOUNT.fee));near(btc.margin+btc.fees,10);near(plan.lossFraction,1+100*ACCOUNT.fee);
  assert.equal(btc.deadline,L1.close+SIGNAL_PARAMS.maxHold*HOUR);
  // Positions are live right away: fresh quotes and a settlement at the open.
  const live=runner.live();
  assert.notEqual(live.equity,null);assert.deepEqual(live.waiting,[]);

  // Ticking again in the same candle changes nothing and reads no candles.
  const snapshot=storage.getItem(accountKey('u1')),records=JSON.stringify(await signalsOf(store,'BTC'));
  rt.urls=[];await runner.tick();
  assert.ok(!urlKinds(rt.urls).includes('kline:60'));
  assert.deepEqual(saved(storage).positions,JSON.parse(snapshot).positions);
  assert.equal(JSON.stringify(await signalsOf(store,'BTC')),records);

  // The next candle is a 0,6 % pullback: at 100× its 5-minute low reaches the liquidation level, at 50× it does not.
  // Each tick replays one position's history, the least recently settled first.
  rt.at=after(L1.i+1);
  await ticks(runner,3);
  a=saved(storage);
  assert.deepEqual(a.positions.map(p=>p.symbol),['SOL']);
  assert.deepEqual(a.trades.map(t=>t.reason).sort(),['likvidation','likvidation']);
  for(const t of a.trades){
    const p=replay.positions.find(x=>x.symbol===t.symbol);
    assert.equal(t.exit,p.liq);near(t.pnl,-(p.margin+p.fees));
    assert.ok(t.closedAt>L1.close&&t.closedAt<=m.closeOf(L1.i+1)&&t.closedAt%STEP===0);
  }
  assert.ok(a.log.some(e=>e.kind==='stängd'&&/^Likvidation: lång BTC −/.test(e.text)));

  // The second breakout: the liquidated coins open again, SOL is still held, the rest find no free slot.
  for(let i=L1.i+2;i<=L2.i;i++){rt.at=after(i);await ticks(runner,2);}
  a=saved(storage);
  assert.deepEqual(a.positions.map(p=>p.symbol),['SOL','BTC','ETH']);
  const late=a.log.filter(e=>e.t===after(L2.i));
  assert.deepEqual(late.map(e=>[e.kind,e.symbol,e.kind==='avvisad'?e.text:'']),[['öppnad','BTC',''],['öppnad','ETH',''],
    ['avvisad','SOL','Det finns redan en position i SOL'],...['XRP','DOGE','SHIB','PEPE'].map(s=>['avvisad',s,'Max antal öppna positioner är nått (3)'])]);

  // SOL ends in the trend: at its target if the 5-minute path reaches it within the holding time (as with the
  // first frozen SIGNAL_PARAMS), else at the deadline candle's open; either way after the 16:00 UTC funding on the mark price.
  const sol=replay.positions.find(p=>p.symbol==='SOL'),solSignal=(await signalsOf(store,'SOL'))[0];
  let reach=false;for(let t=sol.nextBar;t<sol.deadline&&!reach;t+=STEP)reach=m.sub((t-START)/STEP).h*SCALE.SOL>=sol.tp;
  for(let i=L2.i+1;i<=L1.i+SIGNAL_PARAMS.maxHold+1&&!saved(storage).trades.some(t=>t.symbol==='SOL');i++){rt.at=after(i);await ticks(runner,3);}
  a=saved(storage);
  const target=a.trades.find(t=>t.symbol==='SOL');
  if(reach)assert.deepEqual([target.reason,target.exit],['mål',solSignal.tp*(1-SLIP)]);
  else{assert.deepEqual([target.reason,target.closedAt],['tid',sol.deadline]);near(target.exit,m.sub((sol.deadline-START)/STEP).o*SCALE.SOL*(1-SLIP));}
  // Funding at a candle's open is charged before that candle's exit; the time stop leaves at the deadline candle's open.
  const fundings=[];for(let t=Math.ceil(sol.openedAt/FUND)*FUND;t<target.closedAt||target.reason==='tid'&&t===target.closedAt;t+=FUND)fundings.push(t);
  assert.ok(fundings.length>=1);
  near(target.funding,fundings.reduce((s,t)=>s+sol.units*m.sub((t-START)/STEP).o*SCALE.SOL*FUNDING_RATE,0));
  assert.ok(target.funding>0&&target.pnl>0);
  near(a.funding,a.trades.reduce((s,t)=>s+t.funding,0)+a.positions.reduce((s,p)=>s+p.funding,0));
  // Every stored signal so far: each breakout per coin, stored once, live.
  for(const symbol of SYMBOLS)assert.deepEqual((await signalsOf(store,symbol)).map(r=>[r.barTime,r.origin]),m.longs.filter(s=>s.close<=rt.at).map(s=>[s.t,'live']));
});

test('funding is charged before a stop that the price gaps through, which fills at the open',async()=>{
  const {rt,runner,storage}=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await runner.tick();
  rt.at=after(L1.i);await runner.tick();
  const p=saved(storage).positions[0];
  // At 10× the stop costs 17 % of the margin, so the 25 % position size binds.
  assert.equal(p.leverage,10);near(p.margin,25);
  // 16:10 UTC: the market opens 1 % below the stop.
  const funding=m.closeOf(L1.i+6),gap=funding+10*MIN,factor=p.sl/(m.sub((gap-START)/STEP).o*SCALE.BTC)*.99;
  assert.equal(funding%FUND,0);
  rt.shocks=[{symbol:'BTC',at:gap,factor}];
  rt.at=funding+2*SEC;await runner.tick();
  let a=saved(storage);
  const markOpen=m.sub((funding-START)/STEP).o*SCALE.BTC;
  assert.equal(a.positions.length,1);
  near(a.positions[0].funding,p.units*markOpen*FUNDING_RATE);
  near(a.positions[0].margin,p.margin-p.units*markOpen*FUNDING_RATE);
  rt.at=gap+10*MIN+2*SEC;await runner.tick();
  a=saved(storage);
  const t=a.trades[0];
  assert.deepEqual([t.reason,t.closedAt],['stopp',gap]);
  near(t.exit,m.sub((gap-START)/STEP).o*factor*SCALE.BTC*(1-SLIP));
  assert.ok(t.exit<p.sl*(1-SLIP),'the gap fills below the stop level');
  near(t.funding,p.units*markOpen*FUNDING_RATE);
  near(t.pnl,(t.exit-p.entry)*t.units-t.fees-t.funding);
  near(a.cash,100+t.pnl);
});

test('between settlements a live price through the stop closes the position at once',async()=>{
  const {rt,runner,storage}=harness({time:after(L1.i),settings:{symbols:['BTC','ETH'],leverage:10}});
  await runner.tick();
  assert.deepEqual(saved(storage).positions.map(p=>p.symbol),['BTC','ETH']);
  const t0=rt.at;
  // Turns: BTC, then ETH, then BTC again, each replaying its own history.
  rt.at=t0+5*SEC;await runner.tick();
  assert.deepEqual(saved(storage).positions.map(p=>p.fundingThrough),[t0+5*SEC,t0]);
  rt.at=t0+10*SEC;await runner.tick();
  assert.deepEqual(saved(storage).positions.map(p=>p.fundingThrough),[t0+5*SEC,t0+10*SEC]);
  // ETH drops through its stop while it is BTC's turn: the fresh quote closes ETH at that price.
  const eth=saved(storage).positions[1];
  rt.price={ETH:eth.sl*.99};rt.at=t0+15*SEC;
  const st=await runner.tick();
  const a=saved(storage),t=a.trades[0];
  assert.deepEqual([t.symbol,t.reason,t.closedAt],['ETH','stopp',rt.at]);
  near(t.exit,eth.sl*.99*(1-SLIP));
  assert.deepEqual(a.positions.map(p=>[p.symbol,p.fundingThrough]),[['BTC',rt.at]]);
  assert.equal(st.state,'trading');
  assert.equal(runner.live().positions.length,1);
});

test('right after a funding time a live stop waits for the position\'s own settlement, which charges the funding first',async()=>{
  const {rt,runner,storage}=harness({time:after(L1.i),settings:{symbols:['BTC','ETH'],leverage:10}});
  await runner.tick();
  // Both settled shortly before the 16:00 UTC funding, BTC first.
  const F=m.closeOf(L1.i+6);
  assert.equal(F%FUND,0);
  rt.at=F-15*SEC;await runner.tick();rt.at=F-10*SEC;await runner.tick();
  const eth=saved(storage).positions[1];
  assert.deepEqual(saved(storage).positions.map(p=>[p.symbol,p.fundingThrough]),[['BTC',F-15*SEC],['ETH',F-10*SEC]]);
  // At 16:00:05 ETH trades through its stop on BTC's turn: the quote alone would book it without the 16:00 funding.
  rt.price={ETH:eth.sl*.99};rt.at=F+5*SEC;await runner.tick();
  let a=saved(storage);
  assert.deepEqual([a.trades,a.positions.map(p=>[p.symbol,p.fundingThrough])],[[],[['BTC',F+5*SEC],['ETH',F-10*SEC]]]);
  // ETH's own turn replays the 16:00 candle: the funding on the mark at its open, then the stop.
  rt.at=F+10*SEC;await runner.tick();
  a=saved(storage);
  const [t]=a.trades;
  assert.deepEqual([t.symbol,t.reason,t.closedAt],['ETH','stopp',F+10*SEC]);
  near(t.funding,eth.units*m.sub((F-START)/STEP).o*SCALE.ETH*FUNDING_RATE);
  near(t.exit,eth.sl*(1-SLIP));
});

test('a position still open at its deadline closes at that candle\'s open, and a failing protection check is shown',async()=>{
  // A long in the quiet range after the down leg, with stop and target far away.
  const R=m.end+30,t0=after(R),h=harness({time:t0}),quote=await quoteAt(h.rt,'BTC');
  const signal={id:`s|u1|BTC|1h|${m.bar(R).t}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.95,tp:quote.price*1.05,
    barTime:m.bar(R).t,confirmedAt:m.closeOf(R)};
  let a=openPosition(newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
  h.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(a,'BTC',m.bar(R).t)));
  const p=a.positions[0];
  assert.equal(p.deadline,m.closeOf(R)+SIGNAL_PARAMS.maxHold*HOUR);
  // Mark prices fail for a while: the position is still held, and the reason shows.
  h.rt.at=t0+HOUR;h.rt.fail=u=>u.pathname.endsWith('/mark-price-kline')?'Nätverksfel':null;
  let st=await h.runner.tick();
  assert.deepEqual([st.state,st.text],['waiting','Väntar på skyddskontroll för BTC: Nätverksfel']);
  assert.equal(st.protection,'skyddskontroll för BTC: Nätverksfel');
  const live=h.runner.live();
  assert.equal(live.equity,null);assert.equal(live.reason,'Väntar på funding- och likvidationskontroll för BTC');
  // Back after the deadline: the replay ends the trade at the deadline candle's open.
  h.rt.fail=null;h.rt.at=p.deadline+2*HOUR;
  st=await h.runner.tick();
  a=saved(h.storage);
  const [t]=a.trades,open=m.sub((p.deadline-START)/STEP).o*SCALE.BTC;
  assert.deepEqual([t.reason,t.closedAt],['tid',p.deadline]);
  near(t.exit,open*(1-SLIP));
  assert.equal(st.state,'trading');assert.equal(st.protection,'');
  assert.ok(a.log.at(-1).text.startsWith('Tidsstopp: lång BTC'));
});

test('Bybit changing the funding interval while a position is held stops neither its settlement, a manual close nor its time stop',async()=>{
  // Bybit moved SOL from funding every 8 hours to every 2 hours on 10 November 2022 (the research data has it): the last
  // 8-hour funding at 08:00 UTC, then 10:00, 12:00 … Here a long in the quiet range is held across the same change.
  const R=m.end+30,t0=after(R),every=2*HOUR,at=(Math.floor(t0/FUND)+1)*FUND;
  async function held(){
    const h=harness({time:t0,runtime:{fundingSwitch:{at,every}}}),quote=await quoteAt(h.rt,'SOL');
    const signal={id:`s|u1|SOL|1h|${m.bar(R).t}|${MODEL.signal}`,symbol:'SOL',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.95,tp:quote.price*1.05,
      barTime:m.bar(R).t,confirmedAt:m.closeOf(R)};
    const a=openPosition(newForecastAccount(t0-HOUR,{symbols:['SOL'],leverage:10}),{signal,symbol:'SOL',quote,contract:limitsFor('SOL',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
    h.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(a,'SOL',m.bar(R).t)));
    // Settled half an hour before the change.
    h.rt.at=at-30*MIN;await h.runner.tick();
    assert.equal(saved(h.storage).positions[0].fundingThrough,h.rt.at);
    return {...h,p:a.positions[0]};
  }
  const paid=(p,times)=>times.reduce((s,t)=>s+p.units*m.sub((t-START)/STEP).o*SCALE.SOL*FUNDING_RATE,0);
  // Two and a half hours after the change: the last 8-hour funding and the first 2-hour one, each on its mark-price open.
  const h=await held();
  h.rt.at=at+every+30*MIN;
  let st=await h.runner.tick();
  const q=saved(h.storage).positions[0];
  assert.deepEqual([st.state,st.protection,q.fundingThrough],['trading','',h.rt.at]);
  near(q.funding,paid(h.p,[at,at+every]));
  // The time stop at the deadline candle's open, after every 2-hour funding up to it.
  h.rt.at=h.p.deadline+HOUR;st=await h.runner.tick();
  const [t]=saved(h.storage).trades,times=[];
  for(let x=at;x<=h.p.deadline;x+=every)times.push(x);
  assert.deepEqual([t.reason,t.closedAt,st.protection],['tid',h.p.deadline,'']);
  near(t.funding,paid(h.p,times));
  // A manual close after the change settles the funding first and sells.
  const c=await held();
  c.rt.at=at+every+30*MIN;
  const res=await c.runner.closePosition(c.p.id);
  assert.deepEqual([res.ok,res.trade?.reason],[true,'manuell'],res.text);
  near(res.trade.funding,paid(c.p,[at,at+every]));
});

test('a signal that is stale when first seen, or missed while the page was closed, is stored but not traded',async()=>{
  // First seen 40 minutes after its candle closed: past the 30-minute limit for a new entry.
  const late=harness({time:after(L1.i,40*MIN),settings:{symbols:['BTC']}});
  let st=await late.runner.tick();
  let a=saved(late.storage);
  assert.deepEqual(a.positions,[]);assert.deepEqual(a.log,[]);assert.equal(a.processed.BTC,L1.t);
  assert.deepEqual((await signalsOf(late.store,'BTC')).map(r=>[r.barTime,r.origin]),[[L1.t,'live']]);
  assert.deepEqual(urlKinds(late.rt.urls),['kline:60'],'no price or limits for a stale signal');
  assert.deepEqual([st.last.symbol,st.last.side,st.last.fresh,st.last.reason],['BTC','long',false,'Signalen är för gammal (40 min)']);
  // 29 minutes after the close it is still fresh.
  const edge=harness({time:after(L1.i,29*MIN),settings:{symbols:['BTC']}});
  await edge.runner.tick();
  assert.equal(saved(edge.storage).positions.length,1);
  // Missed: the page was closed when the candle closed and the next one has closed too.
  const missed=harness({time:after(L1.i-1),settings:{symbols:['BTC']}});
  await missed.runner.tick();
  missed.rt.at=after(L1.i+1);st=await missed.runner.tick();
  a=saved(missed.storage);
  assert.deepEqual(a.positions,[]);assert.equal(a.processed.BTC,m.bar(L1.i+1).t);
  assert.deepEqual((await signalsOf(missed.store,'BTC')).map(r=>[r.barTime,r.origin]),[[L1.t,'backfill']]);
  assert.equal(st.last.t,m.bar(L1.i+1).t);assert.equal(st.last.side,null);
  // Away for a long time: every candle since the last decision is evaluated and recorded, none traded.
  const away=harness({time:after(L1.i-1),settings:{symbols:['BTC']}});
  await away.runner.tick();
  away.rt.at=after(L3.i+2);await away.runner.tick();
  assert.deepEqual((await signalsOf(away.store,'BTC')).map(r=>[r.barTime,r.origin]),[[L1.t,'backfill'],[L2.t,'backfill'],[L3.t,'backfill']]);
  assert.deepEqual(saved(away.storage).positions,[]);
});

test('unreliable data pauses new entries with a visible reason while protection goes on, and entries resume when it recovers',async()=>{
  const {rt,runner,storage,store}=harness({time:after(L1.i-1),settings:{symbols:['BTC','ETH','SOL','XRP'],leverage:10,maxOpen:4}});
  await runner.tick();
  rt.at=after(L1.i);
  rt.holes=new Set([`BTC:60:${m.bar(L1.i-5).t}`]);
  rt.lag={ETH:2*HOUR};
  rt.fail=u=>u.pathname.endsWith('/kline')&&u.searchParams.get('symbol')==='SOLUSDT'?'Nätverksfel':null;
  let st=await runner.tick(),a=saved(storage);
  assert.deepEqual(a.positions.map(p=>p.symbol),['XRP']);
  assert.equal(st.state,'unreliable');
  assert.equal(st.text,'Data opålitlig för BTC, ETH, SOL — nya affärer pausade');
  assert.deepEqual(st.unreliable,['BTC','ETH','SOL']);
  assert.deepEqual([st.data.BTC.state,st.data.BTC.text],['gap','Lucka i datan (1 candle saknas) — nya demoaffärer pausade']);
  assert.deepEqual([st.data.ETH.state,st.data.ETH.text],['delayed','Väntar på ny candle — nya demoaffärer pausade']);
  assert.deepEqual([st.data.SOL.state,st.data.SOL.text],['error','Data saknas — Nätverksfel']);
  assert.equal(st.data.XRP.state,'live');
  // Nothing is evaluated from such data: no record, and the last decision stays.
  for(const s of ['BTC','ETH','SOL']){assert.equal(a.processed[s],m.bar(L1.i-1).t,s);assert.deepEqual(await signalsOf(store,s),[]);}
  // While they wait to retry, no candles are read; the XRP position is still guarded.
  rt.urls=[];rt.at+=5*SEC;st=await runner.tick();
  assert.ok(!urlKinds(rt.urls).includes('kline:60'));
  assert.ok(urlKinds(rt.urls).includes('mark-price-kline:5'));
  assert.equal(saved(storage).positions[0].fundingThrough,rt.at);
  assert.equal(st.state,'unreliable');
  // Recovered while the signal is fresh: the entries go through.
  rt.holes=null;rt.lag=null;rt.fail=null;
  rt.at=after(L1.i,20*SEC);st=await runner.tick();
  a=saved(storage);
  assert.deepEqual(a.positions.map(p=>p.symbol),['XRP','BTC','ETH','SOL']);
  assert.equal(st.state,'trading');assert.deepEqual(st.unreliable,[]);
  assert.equal(st.text,'Handlar · 4 av 4 positioner · nästa beslut '+hhmm(m.closeOf(L1.i+1)));
  // Bybit's own gap that outlasts the signal: retries back off to once a minute, and the signal is never traded.
  const gap=harness({time:after(L1.i-1),settings:{symbols:['BTC']}});
  await gap.runner.tick();
  gap.rt.holes=new Set([`BTC:60:${m.bar(L1.i-5).t}`]);
  const reads=[];
  for(let t=after(L1.i);t<=after(L1.i,35*MIN);t+=5*SEC){
    gap.rt.at=t;gap.rt.urls=[];await gap.runner.tick();
    if(gap.rt.urls.some(u=>u.pathname.endsWith('/kline')))reads.push((t-after(L1.i))/SEC);
  }
  assert.deepEqual(reads,[0,15,45,...Array.from({length:34},(_,k)=>105+60*k)]);
  gap.rt.holes=null;gap.rt.at=after(L1.i)+(reads.at(-1)+60)*SEC;
  const later=await gap.runner.tick();
  assert.equal(later.state,'trading');assert.equal(later.data.BTC.state,'live');
  assert.deepEqual(saved(gap.storage).positions,[]);assert.equal(saved(gap.storage).processed.BTC,L1.t);
  assert.deepEqual((await signalsOf(gap.store,'BTC')).map(r=>r.origin),['live']);
  assert.equal(later.last.reason,'Signalen är för gammal (36 min)');
});

test('Bybit\'s clock decides when a candle has closed, whichever way the computer\'s clock is off',async()=>{
  // Our clock 3 s ahead: at our 10:00:01 Bybit's candle is still forming.
  const ahead=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await ahead.runner.tick();
  ahead.rt.at=L1.close+SEC;ahead.rt.server=L1.close-2*SEC;
  await ahead.runner.tick();
  let a=saved(ahead.storage);
  assert.equal(a.positions.length,0);assert.equal(a.processed.BTC,m.bar(L1.i-1).t);
  // It asks again once Bybit's candle should have closed (2 s by Bybit's answer), not before.
  const klines=()=>ahead.rt.urls.filter(u=>u.pathname.endsWith('/kline')).length;
  ahead.rt.urls=[];ahead.rt.at=L1.close+2*SEC;ahead.rt.server=L1.close-SEC;await ahead.runner.tick();
  assert.equal(klines(),0);
  ahead.rt.at=L1.close+4*SEC;ahead.rt.server=L1.close+SEC;await ahead.runner.tick();
  assert.equal(klines(),1);
  a=saved(ahead.storage);
  assert.equal(a.positions.length,1);assert.equal(a.positions[0].openedAt,L1.close+4*SEC);
  // Our clock 4 s behind: once Bybit's time is known, the decision comes at Bybit's close.
  const behind=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10},runtime:{server:after(L1.i-1)+4*SEC}});
  await behind.runner.tick();
  behind.rt.at=L1.close-3*SEC;behind.rt.server=L1.close+SEC;
  const st=await behind.runner.tick();
  a=saved(behind.storage);
  assert.equal(a.positions.length,1);assert.equal(a.positions[0].openedAt,L1.close-3*SEC);
  assert.equal(st.nextDecision,m.closeOf(L1.i+1));
});

test('signal records are stamped on Bybit\'s clock, never before their candle closed',async()=>{
  // Our clock 4 s behind Bybit's: the candle has closed on Bybit's clock, three seconds before ours gets there.
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10},runtime:{server:after(L1.i-1)+4*SEC}});
  await h.runner.tick();
  h.rt.at=L1.close-3*SEC;h.rt.server=L1.close+SEC;
  await h.runner.tick();
  const [r]=await signalsOf(h.store,'BTC');
  assert.deepEqual([r.barTime,r.confirmedAt,r.recordedAt,r.origin],[L1.t,L1.close,L1.close+SEC,'live']);
  assert.ok(verifyRecord(r));
  // Time that passes after the read counts on top of Bybit's time of it: two signals in a backlog, the archive taking 7 s each.
  const b=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await b.runner.tick();
  const slow=b.tab({store:{...b.store,async putSignal(x){const res=await b.store.putSignal(x);b.rt.at+=7*SEC;return res;}}});
  const read=after(L2.i);b.rt.at=read;b.rt.server=read+4*SEC;
  await slow.tick();
  assert.deepEqual((await signalsOf(b.store,'BTC')).map(x=>[x.barTime,x.recordedAt,x.origin]),[[L1.t,read+4*SEC,'backfill'],[L2.t,read+11*SEC,'live']]);
});

test('a fresh opposite signal settles the held position, closes it at market and opens the other side',async()=>{
  async function hold({paused=false,symbols=['BTC']}={}){
    const t0=after(S1.i-3),h=harness({time:t0}),barTime=m.bar(S1.i-3).t;
    let a=newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10});
    const quote=await quoteAt(h.rt,'BTC');
    // A long from an earlier signal, still inside its holding time when the short arrives.
    const signal={id:`s|u1|BTC|1h|${barTime}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.9,tp:quote.price*1.2,barTime,confirmedAt:barTime+HOUR};
    a=openPosition(a,{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
    a=markProcessed(setPaused(updateSettings(a,{symbols}),paused),'BTC',barTime);
    for(const s of symbols)a=markProcessed(a,s,barTime);
    h.storage.setItem(accountKey('u1'),JSON.stringify(a));
    return {...h,long:a.positions[0]};
  }
  const {rt,runner,storage,store,long}=await hold();
  rt.at=after(S1.i);
  await runner.tick();
  const a=saved(storage),[t]=a.trades,[short]=a.positions,rec=(await signalsOf(store,'BTC')).at(-1),q=await quoteAt(rt,'BTC');
  assert.deepEqual([rec.barTime,rec.side,rec.origin],[S1.t,'short','live']);
  assert.deepEqual([t.reason,t.signalId,t.closedAt],['signal',long.signalId,rt.at]);
  assert.equal(t.exit,q.price*(1-SLIP));
  // Settled first: the 16:00 UTC funding at the candle close was charged before the close.
  assert.equal(S1.close%FUND,0);
  near(t.funding,long.units*m.sub((S1.close-START)/STEP).o*SCALE.BTC*FUNDING_RATE);
  assert.deepEqual([short.side,short.signalId,short.entry],['short',rec.id,q.price*(1-SLIP)]);
  assert.deepEqual(a.log.slice(-2).map(e=>e.kind),['stängd','öppnad']);
  assert.match(a.log.at(-2).text,/^Motsatt signal: lång BTC [+−]/);
  // Paused: the exit still happens, the new entry does not.
  const p=await hold({paused:true});
  p.rt.at=after(S1.i);
  const st=await p.runner.tick();
  const b=saved(p.storage);
  assert.deepEqual(b.trades.map(x=>x.reason),['signal']);assert.deepEqual(b.positions,[]);
  assert.equal(b.log.at(-1).text,'Nya affärer är pausade');
  assert.deepEqual([st.state,st.text],['paused','Pausad']);
  // BTC removed from the traded pairs while held: still guarded and closed on the signal, never reopened.
  const gone=await hold({symbols:['ETH']});
  gone.rt.at=after(S1.i);
  await gone.runner.tick();
  const c=saved(gone.storage);
  assert.deepEqual(c.trades.map(x=>[x.symbol,x.reason]),[['BTC','signal']]);
  assert.deepEqual(c.positions.map(x=>[x.symbol,x.side]),[['ETH','short']]);
  assert.equal(c.processed.BTC,S1.t);
});

test('an opposite signal the archive cannot store still closes the held position; only the new entry waits, and the decision names the archive',async()=>{
  const t0=after(S1.i-3),barTime=m.bar(S1.i-3).t;
  // A long from an earlier signal is held when the short arrives; this tab's archive cannot store the short.
  async function hold(putSignal){
    const h=harness({time:t0}),quote=await quoteAt(h.rt,'BTC');
    const signal={id:`s|u1|BTC|1h|${barTime}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.9,tp:quote.price*1.2,barTime,confirmedAt:barTime+HOUR};
    const a=openPosition(newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
    h.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(a,'BTC',barTime)));
    return {...h,long:a.positions[0],tab:h.tab({store:{...h.store,putSignal:r=>putSignal(h.store,r)},timeouts:{archive:60}})};
  }
  // A full archive.
  const full=createForecastStore(localStorageBackend(memoryStorage(),undefined,{maxChars:10}));
  const f=await hold((_,r)=>full.putSignal(r));
  f.rt.at=after(S1.i);
  let st=await f.tab.tick(),a=saved(f.storage);
  const q=await quoteAt(f.rt,'BTC'),[t]=a.trades;
  assert.deepEqual([t.reason,t.signalId,t.closedAt,a.positions],['signal',f.long.signalId,f.rt.at,[]]);
  assert.equal(t.exit,q.price*(1-SLIP));
  // Settled first: the 16:00 UTC funding at the candle close was charged before the close.
  near(t.funding,f.long.units*m.sub((S1.close-START)/STEP).o*SCALE.BTC*FUNDING_RATE);
  // The short itself waits for its record: nothing opened, the candle not decided, and the status says why.
  assert.equal(a.processed.BTC,barTime);
  assert.deepEqual([st.state,st.text,st.waiting],['waiting','Prognosarkivet är fullt: nya signaler kan inte sparas och nya affärer är pausade',{BTC:'Signalen för BTC kunde inte sparas'}]);
  assert.deepEqual([st.last.closed?.reason,st.last.opened,st.last.reason],['signal',null,'Signalen för BTC kunde inte sparas']);
  // Still not stored when the signal's window has passed: decided, and the archive is named as the reason, not the age.
  f.rt.at=after(S1.i,31*MIN);st=await f.tab.tick();a=saved(f.storage);
  assert.deepEqual([a.processed.BTC,a.positions,st.waiting,st.last.fresh,st.last.reason],[S1.t,[],{},false,'Signalen för BTC kunde inte sparas']);
  assert.equal((await signalsOf(f.store,'BTC')).length,0);
  // An archive that does not answer: the same close, and once it answers inside the window the short opens as stored.
  let hang=true;
  const g=await hold((store,r)=>hang?new Promise(()=>{}):store.putSignal(r));
  g.rt.at=after(S1.i);
  st=await g.tab.tick();a=saved(g.storage);
  assert.deepEqual([a.trades.map(x=>x.reason),a.positions,st.state,st.text],[['signal'],[],'waiting','Väntar på ny affär i BTC: Signalen för BTC kunde inte sparas']);
  assert.deepEqual(st.notes,['Signalen för BTC '+hhmm(S1.close)+' kunde inte sparas: Prognosarkivet svarar inte']);
  hang=false;g.rt.at=after(S1.i,20*SEC);st=await g.tab.tick();a=saved(g.storage);
  const [rec]=await signalsOf(g.store,'BTC');
  assert.deepEqual([a.positions.map(p=>[p.side,p.signalId]),a.processed.BTC,st.waiting,st.state],[[['short',rec.id]],S1.t,{},'trading']);
});

test('manual close settles funding first and sells at a fresh price; it fails visibly when prices are missing',async()=>{
  const {rt,runner,storage}=harness({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}});
  await runner.tick();
  const p=saved(storage).positions[0];
  // No tick for six hours, past the 16:00 UTC funding: the close replays them first.
  rt.at=m.closeOf(L1.i+6)+30*MIN;
  rt.fail='Proxy nere';
  assert.deepEqual(await runner.closePosition(p.id),{ok:false,text:'Kunde inte stänga BTC: Proxy nere',trade:null});
  assert.equal(saved(storage).positions.length,1);
  rt.fail=null;
  const res=await runner.closePosition(p.id),q=await quoteAt(rt,'BTC'),a=saved(storage),[t]=a.trades;
  assert.equal(res.ok,true);assert.deepEqual(res.trade,t);
  assert.deepEqual([t.reason,t.closedAt],['manuell',rt.at]);
  assert.equal(t.exit,q.price*(1-SLIP));
  near(t.funding,p.units*m.sub((m.closeOf(L1.i+6)-START)/STEP).o*SCALE.BTC*FUNDING_RATE);
  const pnl=(t.pnl<0?'−':'+')+Math.abs(t.pnl).toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
  assert.equal(res.text,'Stängde lång BTC till '+t.exit.toLocaleString('sv-SE',{maximumSignificantDigits:6})+' · '+pnl);
  assert.deepEqual(await runner.closePosition(p.id),{ok:false,text:'Positionen är redan stängd',trade:t});
  assert.deepEqual(await runner.closePosition('p|okänd'),{ok:false,text:'Positionen är redan stängd',trade:null});
  // At Bybit's maximum the position may already be gone when the close is asked for.
  const max=harness({time:after(L1.i),settings:{symbols:['BTC']}});
  await max.runner.tick();
  const q2=saved(max.storage).positions[0];
  max.rt.at=after(L1.i+1,10*MIN);
  const gone=await max.runner.closePosition(q2.id);
  assert.equal(gone.ok,true);assert.equal(gone.trade.reason,'likvidation');
  assert.match(gone.text,/^lång BTC likviderades innan stängningen hann gå igenom · −\d+,\d\d \$$/);
});

test('reset archives the account under before-reset and starts a new 100 $ account with the same settings',async()=>{
  const {rt,runner,storage,store}=harness({time:after(L1.i),settings:{symbols:['BTC','ETH'],leverage:10,maxOpen:2}});
  await runner.tick();
  const raw=storage.getItem(accountKey('u1')),old=JSON.parse(raw);
  assert.equal(old.positions.length,2);
  rt.at+=MIN;
  const fresh=await runner.reset();
  assert.equal(storage.getItem(accountKey('u1')+':before-reset:'+rt.at),raw);
  assert.deepEqual(fresh,saved(storage));assert.deepEqual(runner.account(),fresh);
  assert.deepEqual([fresh.cash,fresh.createdAt,fresh.positions,fresh.trades,fresh.log,fresh.processed],[100,rt.at,[],[],[],{}]);
  assert.deepEqual(fresh.settings,old.settings);
  // A second reset in the same millisecond keeps the first archive.
  await runner.reset();
  assert.equal(storage.getItem(accountKey('u1')+':before-reset:'+rt.at),raw);
  assert.notEqual(storage.getItem(accountKey('u1')+':before-reset:'+(rt.at+1)),null);
  // Stored signals are market history and stay; the new account may still take a fresh one.
  assert.equal((await signalsOf(store,'BTC')).length,1);
  await runner.tick();
  assert.deepEqual(saved(storage).positions.map(p=>p.signalId),old.positions.map(p=>p.signalId));
  // An unreadable account is archived as it was and replaced by the defaults.
  const bad=harness({time:after(L1.i)});
  bad.storage.setItem(accountKey('u1'),'{trasig');
  assert.equal((await bad.runner.tick()).text,'AI Forecast-kontot kan inte läsas');
  const reset=await bad.runner.reset();
  assert.equal(bad.storage.getItem(accountKey('u1')+':before-reset:'+bad.rt.at),'{trasig');
  assert.deepEqual(reset.settings,plainAccount(bad.rt.at).settings);
});

test('a reload continues from the saved account without trading again or changing stored signals',async()=>{
  const h=harness({time:after(L1.i-1)});
  await h.runner.setAuto(true);
  await h.runner.tick();
  h.rt.at=after(L1.i);await h.runner.tick();
  const before=saved(h.storage),records=JSON.stringify(await Promise.all(SYMBOLS.map(s=>signalsOf(h.store,s))));
  // Reload in the same candle: a new runner (new caches, no memory) on the same storage and archive.
  const reload=h.tab();
  assert.deepEqual(reload.account(),before,'the saved account shows before the first tick');
  h.rt.urls=[];h.rt.at+=3*SEC;
  await reload.tick();
  let a=saved(h.storage);
  assert.deepEqual(a.positions.map(p=>p.id),before.positions.map(p=>p.id));
  assert.equal(opens(a).length,3);assert.equal(a.log.length,before.log.length);
  assert.equal(JSON.stringify(await Promise.all(SYMBOLS.map(s=>signalsOf(h.store,s)))),records);
  // It read the candles once to show the latest evaluation, and decided nothing again.
  assert.equal(h.rt.urls.filter(u=>u.pathname.endsWith('/kline')&&u.searchParams.get('interval')==='60').length,SYMBOLS.length);
  assert.equal(reload.evaluations().BTC.t,L1.t);assert.equal(reload.evaluations().BTC.evaluation.side,'long');
  // The reloaded runner takes the next decisions once.
  for(let i=L1.i+1;i<=L2.i;i++){h.rt.at=after(i);await ticks(reload,3);}
  a=saved(h.storage);
  assert.equal(new Set(opens(a).map(e=>e.signalId)).size,opens(a).length);
  for(const s of SYMBOLS)assert.deepEqual((await signalsOf(h.store,s)).map(r=>r.barTime),[L1.t,L2.t]);
  assert.equal(JSON.stringify((await Promise.all(SYMBOLS.map(s=>signalsOf(h.store,s)))).map(l=>l[0])),JSON.stringify(JSON.parse(records).map(l=>l[0])));
});

test('two tabs ticking together never open the same signal twice and write only inside the lock',async()=>{
  const storage=memoryStorage(),locks=tabLocks(),write=storage.setItem.bind(storage),puts=[];
  storage.setItem=(k,v)=>{assert.ok(locks.held.includes(k),'written outside the lock: '+k);write(k,v);};
  const store=createForecastStore(memoryBackend()),counted={...store,async putSignal(r){const res=await store.putSignal(r);puts.push(res.stored?'stored':res.identical?'identical':'conflict');return res;}};
  const h=harness({time:after(L1.i-1),storage,locks,store:counted,runtime:{delay:2}}),other=h.tab();
  await h.runner.setAuto(true);
  await Promise.all([h.runner.tick(),other.tick()]);
  h.rt.at=after(L1.i);
  await Promise.all([h.runner.tick(),other.tick()]);
  let a=saved(storage);
  assert.deepEqual(a.positions.map(p=>p.symbol),['BTC','ETH','SOL']);
  assert.equal(opens(a).length,3);
  assert.equal(a.log.filter(e=>e.kind==='avvisad').length,4,'only the four coins without a free slot');
  // Both tabs evaluated the candle and stored its signal: once stored, once found identical.
  assert.equal(puts.filter(x=>x==='stored').length,SYMBOLS.length);
  assert.equal(puts.filter(x=>x==='identical').length,SYMBOLS.length);
  for(const s of SYMBOLS)assert.equal((await signalsOf(store,s)).length,1);
  // Both keep ticking through the pullback and the next breakout.
  for(let i=L1.i+1;i<=L2.i;i++){h.rt.at=after(i);for(let k=0;k<3;k++){await Promise.all([h.runner.tick(),other.tick()]);h.rt.at+=5*SEC;}}
  a=saved(storage);
  const ids=[...a.positions,...a.trades].map(x=>x.signalId);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(opens(a).length,5);
  // With the platform's own lock manager (Node implements navigator.locks) the same holds.
  const shared=memoryStorage(),records=createForecastStore(memoryBackend()),rt={at:after(L1.i-1),urls:[],market:m,delay:1};
  const tab=()=>createForecastRunner({grab:fakeBybit(rt),storage:shared,store:records,now:()=>rt.at,getUser:()=>'u1',isActive:()=>true});
  const [x,y]=[tab(),tab()];
  await x.setAuto(true);
  await Promise.all([x.tick(),y.tick()]);
  rt.at=after(L1.i);await Promise.all([x.tick(),y.tick()]);
  assert.equal(opens(saved(shared)).length,3);
});

test('a signal the chart stored first is traded as stored; a different record under the same id is kept and not traded',async()=>{
  const h=harness({time:after(L1.i),settings:{symbols:['BTC','ETH'],leverage:10}});
  const closedBars=async symbol=>splitForming((await fetchKlines(fakeBybit({...h.rt,urls:[]}),symbol,'1h',{limit:1000,now:()=>h.rt.at})).bars,'1h',h.rt.at).closed;
  const btc=await closedBars('BTC'),eth=await closedBars('ETH');
  // The chart computed the same BTC signal from its own longer history a moment earlier.
  const chart=signalRecord('u1','BTC','1h',evaluateBar(btc,btc.length-1,{tf:'1h'}),{recordedAt:h.rt.at-SEC,origin:'backfill',tfMs:HOUR});
  // Under ETH's id lies a record with other content (say, rules edited by hand): a real integrity warning.
  const e=evaluateBar(eth,eth.length-1,{tf:'1h'});
  const other=signalRecord('u1','ETH','1h',{...e,sl:e.sl*.99},{recordedAt:h.rt.at-SEC,origin:'live',tfMs:HOUR});
  assert.deepEqual(await h.store.putSignal(chart),{stored:true});
  assert.deepEqual(await h.store.putSignal(other),{stored:true});
  const st=await h.runner.tick(),a=saved(h.storage);
  assert.deepEqual(a.positions.map(p=>[p.symbol,p.signalId,p.sl]),[['BTC',chart.id,chart.sl]]);
  assert.deepEqual(await signalsOf(h.store,'BTC'),[chart],'the stored record keeps its own time and origin');
  assert.deepEqual(await signalsOf(h.store,'ETH'),[other]);
  assert.deepEqual(st.notes,['Den sparade signalen för ETH '+hhmm(L1.close)+' skiljer sig från en ny beräkning — originalet behålls och handlas inte']);
  assert.equal(a.processed.ETH,L1.t,'decided: retrying would not change the record');
  assert.equal(h.runner.evaluations().ETH.store,'conflict');assert.equal(h.runner.evaluations().BTC.store,'identical');
});

test('paused: signals are still stored and every refusal is logged, no price is fetched, and resuming trades the next signal',async()=>{
  const {rt,runner,storage,store}=harness({time:after(L1.i-1),settings:{symbols:['BTC','ETH'],leverage:10}});
  await runner.tick();
  const paused=await runner.setPaused(true);
  assert.equal(paused.settings.paused,true);assert.deepEqual(saved(storage),paused);
  assert.deepEqual([runner.status().state,runner.status().text],['paused','Pausad']);
  rt.at=after(L1.i);rt.urls=[];
  const st=await runner.tick();
  let a=saved(storage);
  assert.deepEqual(a.positions,[]);
  assert.deepEqual(a.log.map(e=>[e.kind,e.symbol,e.text]),[['avvisad','BTC','Nya affärer är pausade'],['avvisad','ETH','Nya affärer är pausade']]);
  assert.deepEqual(urlKinds(rt.urls),['kline:60']);
  for(const s of ['BTC','ETH'])assert.equal((await signalsOf(store,s)).length,1);
  assert.deepEqual([st.state,st.text],['paused','Pausad']);
  // Resuming does not reach back for a signal already decided; the next breakout opens.
  await runner.setPaused(false);
  rt.at=after(L1.i,MIN);await runner.tick();
  assert.deepEqual(saved(storage).positions,[]);
  for(let i=L1.i+1;i<=L2.i;i++){rt.at=after(i);await runner.tick();}
  a=saved(storage);
  assert.deepEqual(a.positions.map(p=>[p.symbol,p.signalId.split('|')[4]]),[['BTC',String(L2.t)],['ETH',String(L2.t)]]);
  assert.equal(runner.status().state,'trading');
});

test('a fresh signal waits for a missing price or Bybit limits and is traded once they come, inside its window',async()=>{
  const {rt,runner,storage}=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await runner.tick();
  rt.at=after(L1.i);
  rt.fail=u=>u.pathname.endsWith('/tickers')?'Nätverksfel':null;
  let st=await runner.tick(),a=saved(storage);
  assert.deepEqual(a.positions,[]);assert.equal(a.processed.BTC,m.bar(L1.i-1).t,'not decided yet');
  assert.deepEqual([st.state,st.text],['waiting','Väntar på ny affär i BTC: Nätverksfel']);
  assert.deepEqual(st.waiting,{BTC:'Nätverksfel'});
  // The price comes back inside the signal's window: traded.
  rt.fail=null;rt.at=after(L1.i,20*SEC);st=await runner.tick();
  a=saved(storage);
  assert.equal(a.positions.length,1);assert.equal(a.processed.BTC,L1.t);
  assert.deepEqual(st.waiting,{});assert.equal(st.state,'trading');
  assert.equal(a.log.filter(e=>e.kind==='avvisad').length,0,'waiting is not a refusal');
  // Bybit's limits fail: the signal waits with that reason and reads no price it cannot use yet.
  const b=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await b.runner.tick();
  b.rt.at=after(L1.i);b.rt.urls=[];
  b.rt.fail=u=>/instruments-info|risk-limit/.test(u.pathname)?'Nätverksfel':null;
  st=await b.runner.tick();
  assert.deepEqual(st.waiting,{BTC:'Bybits hävstångsgräns saknas för BTC'});
  assert.ok(!urlKinds(b.rt.urls).includes('tickers'));
  // The contract cache waits a minute after a failure before asking Bybit again.
  b.rt.fail=null;b.rt.at=after(L1.i,50*SEC);st=await b.runner.tick();
  assert.equal(saved(b.storage).positions.length,0);
  assert.deepEqual(st.waiting,{BTC:'Bybits hävstångsgräns saknas för BTC'});
  b.rt.at=after(L1.i,2*MIN);st=await b.runner.tick();
  a=saved(b.storage);
  assert.equal(a.positions.length,1);assert.equal(a.processed.BTC,L1.t);
  assert.deepEqual(st.waiting,{});assert.equal(st.state,'trading');
  assert.equal(a.log.filter(e=>e.kind==='avvisad').length,0,'waiting is not a refusal');
});

test('a wait ends when another tab decides the candle, and a resume during a paused decision is not lost',async()=>{
  // Tab B cannot get tickers; tab A can. B waits, A trades, and B stops waiting.
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}}),good=fakeBybit(h.rt);
  const b=h.tab({grab:async(url,o)=>{if(url.includes('/tickers'))throw Error('Nätverksfel');return good(url,o);}});
  await b.tick();
  h.rt.at=after(L1.i);
  let st=await b.tick();
  assert.deepEqual(st.waiting,{BTC:'Nätverksfel'});assert.equal(saved(h.storage).positions.length,0);
  await h.runner.tick();
  assert.equal(saved(h.storage).positions.length,1);
  h.rt.at+=5*SEC;st=await b.tick();
  // B no longer waits to trade; it still cannot price the position A opened, and says so.
  assert.deepEqual(st.waiting,{});
  assert.equal(st.text,'Väntar på pris för BTC: Nätverksfel · skyddskontroll för BTC: Nätverksfel');
  assert.equal(saved(h.storage).positions.length,1);
  // Paused while the candle is read, resumed before the decision is written: the entry is tried again.
  const p=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10,paused:true}});
  let resume=null;
  const store=createForecastStore(memoryBackend()),hooked={...store,async putSignal(r){const res=await store.putSignal(r);if(!resume)resume=p.runner.setPaused(false);await resume;return res;}};
  const runner=p.tab({store:hooked});
  await runner.tick();
  p.rt.at=after(L1.i);
  st=await runner.tick();
  assert.equal(saved(p.storage).settings.paused,false);
  assert.deepEqual(saved(p.storage).positions,[]);assert.equal(saved(p.storage).processed.BTC,m.bar(L1.i-1).t);
  assert.deepEqual(st.waiting,{BTC:'kontot återupptogs under tiden'});
  p.rt.at=after(L1.i,20*SEC);st=await runner.tick();
  assert.equal(saved(p.storage).positions.length,1);assert.deepEqual(st.waiting,{});
});

test('tick never throws: missing locks, broken storage, unreadable or newer accounts, failing requests and a failing archive become status text',async()=>{
  const t=after(L1.i),rt={at:t,urls:[],market:m};
  const make=(over={})=>createForecastRunner({grab:fakeBybit(rt),storage:memoryStorage(),store:createForecastStore(memoryBackend()),locks:tabLocks(),now:()=>rt.at,getUser:()=>'u1',isActive:()=>true,...over});
  // No lock support: nothing is written.
  const noLocks=memoryStorage();
  let st=await make({storage:noLocks,locks:null}).tick();
  assert.deepEqual([st.state,st.text],['error','AI Forecast kräver en webbläsare med stöd för säkra fliklås']);
  assert.equal(noLocks.length,0);
  // Storage that throws, or none at all (the default reads the page's localStorage on every call).
  st=await make({storage:{getItem(){throw Error('Lagringen är spärrad');},setItem(){}}}).tick();
  assert.deepEqual([st.state,st.text],['error','Lagringen är spärrad']);
  if(globalThis.localStorage===undefined){
    st=await createForecastRunner({grab:fakeBybit(rt),store:createForecastStore(memoryBackend()),locks:tabLocks(),now:()=>rt.at,getUser:()=>'u1'}).tick();
    assert.deepEqual([st.state,st.text],['error','Webbläsarens lagring saknas']);
  }
  assert.throws(()=>createForecastRunner({storage:memoryStorage()}),{message:'AI Forecast saknar anslutning till Bybit'});
  assert.throws(()=>createForecastRunner({grab:fakeBybit(rt),storage:{}}),{message:'AI Forecast saknar lagring'});
  // A numeric user id from the login works as a string everywhere.
  const numeric=memoryStorage(),records=createForecastStore(memoryBackend()),r42=make({storage:numeric,store:records,getUser:()=>42});
  await r42.setAuto(true);await r42.tick();
  assert.equal(JSON.parse(numeric.getItem('riptide.forecast.v1:42')).positions.length,3);
  assert.equal((await signalsOf(records,'BTC','42'))[0].uid,'42');
  // An unreadable or newer account is never overwritten.
  for(const [raw,text] of [['{trasig','AI Forecast-kontot kan inte läsas'],[JSON.stringify({...newForecastAccount(t),version:'ai-forecast-account-v9'}),/Ladda om sidan/]]){
    const s=memoryStorage();s.setItem(accountKey('u1'),raw);
    const r=make({storage:s});
    st=await r.tick();st=await r.tick();
    assert.equal(st.state,'error');typeof text==='string'?assert.equal(st.text,text):assert.match(st.text,text);
    assert.equal(s.getItem(accountKey('u1')),raw);assert.equal(r.account(),null);
  }
  // A grab that throws synchronously, a stale proxy answer and onChange that throws.
  let calls=0;
  const thrower=make({grab:()=>{throw Error('Ingen anslutning');},onChange:()=>{calls++;throw Error('UI-fel');}});
  await thrower.setAuto(true);calls=0;
  st=await thrower.tick();
  assert.equal(calls,1);
  assert.equal(st.state,'unreliable');assert.equal(st.data.BTC.text,'Data saknas — Ingen anslutning');
  st=await make({grab:fakeBybit({...rt,server:t-3*MIN})}).tick();
  assert.equal(st.data.BTC.text,'Data saknas — Färska priser saknas för BTC');
  // The archive fails while the signal is fresh: no trade without its record, retried, then traded.
  let broken=true;const store=createForecastStore(memoryBackend());
  const flaky={...store,async putSignal(r){if(broken)throw Error('Prognosarkivet kunde inte sparas');return store.putSignal(r);}};
  const s=memoryStorage();s.setItem(accountKey('u1'),JSON.stringify(markProcessed(newForecastAccount(t-HOUR,{symbols:['BTC'],leverage:10}),'BTC',m.bar(L1.i-1).t)));
  const r=make({storage:s,store:flaky});
  st=await r.tick();
  assert.deepEqual(JSON.parse(s.getItem(accountKey('u1'))).positions,[]);
  assert.deepEqual(st.notes,['Signalen för BTC '+hhmm(L1.close)+' kunde inte sparas: Prognosarkivet kunde inte sparas']);
  assert.deepEqual(st.waiting,{BTC:'Signalen för BTC kunde inte sparas'});
  broken=false;rt.at=t+20*SEC;st=await r.tick();
  assert.equal(JSON.parse(s.getItem(accountKey('u1'))).positions.length,1);
  rt.at=t;
});

test('signed out or away from the crypto page nothing is read; a new user gets their own account',async()=>{
  const h=harness({time:after(L1.i)});
  h.who.user=null;
  let st=await h.runner.tick();
  assert.deepEqual([st.state,st.text],['signed-out','Logga in för att handla med AI Forecast-kontot']);
  assert.equal(h.rt.urls.length,0);assert.equal(h.storage.length,0);
  assert.equal(h.runner.account(),null);assert.equal(h.runner.live(),null);
  await assert.rejects(h.runner.updateSettings({maxOpen:2}),{message:'Logga in för att ändra AI Forecast-kontot'});
  assert.deepEqual(await h.runner.closePosition('x'),{ok:false,text:'Logga in för att stänga positionen',trade:null});
  h.who.user='u1';h.who.active=false;
  st=await h.runner.tick();
  assert.deepEqual([st.state,st.text],['inactive','Vilar — handlar när kryptosidan är öppen']);
  assert.equal(h.rt.urls.length,0);assert.equal(h.storage.length,0,'no account is created away from the crypto page');
  h.who.active=true;await h.runner.setAuto(true);await h.runner.tick();
  h.who.active=false;
  assert.deepEqual([h.runner.status().state,h.runner.status().text],['inactive','Vilar — handlar när kryptosidan är öppen']);
  h.who.active=true;
  assert.equal(saved(h.storage).positions.length,3);
  // Another user on the same browser: separate account key, no positions, nothing of the first user's state.
  h.who.user='anna b@x.se';h.rt.urls=[];
  assert.deepEqual(h.runner.evaluations(),{});assert.deepEqual(h.runner.quotes(),{});
  await h.runner.setAuto(true);
  await h.runner.tick();
  assert.ok(h.storage.getItem('riptide.forecast.v1:anna%20b%40x.se')!==null);
  assert.equal(saved(h.storage,'anna b@x.se').positions.length,3,'the fresh signal is traded by this account too');
  assert.equal(saved(h.storage,'u1').positions.length,3);
});

test('settings: invalid changes are refused in Swedish, a new timeframe starts over at its own candles',async()=>{
  const {rt,runner,storage}=harness({time:after(L1.i-1),settings:{symbols:['BTC']}});
  await runner.tick();
  await assert.rejects(runner.updateSettings({maxOpen:9}),{message:'Max öppna positioner ska vara 1–7'});
  await assert.rejects(runner.updateSettings({fart:1}),{message:'Okänd inställning: fart'});
  await assert.rejects(runner.setPaused('ja'),{message:'Ogiltigt pausläge'});
  assert.equal(saved(storage).settings.maxOpen,3);
  const next=await runner.updateSettings({tf:'4h',symbols:['ETH','BTC']});
  assert.deepEqual([next.settings.tf,next.settings.symbols,next.processed],['4h',['BTC','ETH'],{}]);
  // The scripted history is only about 2 weeks of 4h candles: too short for the 4h rules, so no entries.
  rt.urls=[];const st=await runner.tick();
  assert.ok(rt.urls.every(u=>!u.pathname.endsWith('/kline')||u.searchParams.get('interval')==='240'));
  assert.equal(st.state,'unreliable');
  assert.match(st.data.BTC.text,/^För kort historik \(\d+ av 385 candles\) — nya demoaffärer pausade$/);
  assert.equal(st.text,'Data opålitlig för BTC, ETH — nya affärer pausade');
});

test('any timeframe: a 5-minute account trades the 5-minute script with a 100-minute holding time',async()=>{
  const m5=scriptMarket({tf:'5m'}),[F1]=m5.longs;
  const {rt,runner,storage,store}=harness({time:m5.closeOf(F1.i-1)+2*SEC,settings:{tf:'5m',symbols:['BTC'],leverage:10},runtime:{market:m5}});
  await runner.tick();
  rt.at=m5.closeOf(F1.i)+2*SEC;
  const st=await runner.tick(),[p]=saved(storage).positions,[rec]=await signalsOf(store,'BTC','u1','5m');
  assert.deepEqual([p.tf,p.signalId,p.deadline],['5m',rec.id,F1.close+SIGNAL_PARAMS.maxHold*TF['5m'].ms]);
  assert.deepEqual([rec.barTime,rec.origin],[F1.t,'live']);
  assert.ok(rt.urls.some(u=>u.searchParams.get('interval')==='5'&&u.searchParams.get('limit')===String(RUNNER.klines)));
  assert.equal(st.text,'Handlar · 1 av 3 positioner · nästa beslut '+hhmm(F1.close+TF['5m'].ms));
});

test('a coin whose risk check keeps failing holds up neither the other positions\' settlement nor their live stop, and its reason stays visible',async()=>{
  const {rt,runner,storage}=harness({time:after(L1.i),settings:{symbols:['BTC','ETH'],leverage:10}});
  await runner.tick();
  assert.deepEqual(saved(storage).positions.map(p=>p.symbol),['BTC','ETH']);
  const t0=rt.at;
  rt.fail=u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('symbol')==='BTCUSDT'?'Nätverksfel':null;
  for(let k=1;k<=40;k++){
    rt.at=t0+5*SEC*k;
    const st=await runner.tick();
    // Shown on every tick, not only on BTC's turns.
    assert.deepEqual([st.state,st.protection],['waiting','skyddskontroll för BTC: Nätverksfel'],'tick '+k);
  }
  let a=saved(storage);
  const [btc,eth]=a.positions;
  assert.equal(btc.fundingThrough,t0,'BTC cannot be settled');
  assert.ok(rt.at-eth.fundingThrough<=10*SEC,'ETH is still settled in turns');
  const live=runner.live();
  assert.equal(live.equity,null);assert.deepEqual(live.waiting,['BTC']);
  assert.notEqual(live.positions[1].pnl,null,'ETH is valued');
  // ETH falls through its stop: the live check still closes it.
  rt.price={ETH:eth.sl*.99};rt.at+=5*SEC;
  const st=await runner.tick();
  a=saved(storage);
  assert.deepEqual(a.trades.map(t=>[t.symbol,t.reason,t.closedAt]),[['ETH','stopp',rt.at]]);
  assert.deepEqual([st.state,st.text],['waiting','Väntar på skyddskontroll för BTC: Nätverksfel']);
  // BTC's data returns: its next turn settles it and the reason goes.
  rt.fail=null;rt.at+=5*SEC;
  const back=await runner.tick();
  assert.equal(saved(storage).positions[0].fundingThrough,rt.at);
  assert.deepEqual([back.state,back.protection],['trading','']);
});

test('a wait for a coin that is then removed from the traded pairs ends at once',async()=>{
  const {rt,runner}=harness({time:after(L1.i-1),settings:{symbols:['BTC','ETH'],leverage:10}});
  await runner.tick();
  rt.at=after(L1.i);
  rt.fail=u=>u.pathname.endsWith('/tickers')&&u.searchParams.get('symbol')==='BTCUSDT'?'Nätverksfel':null;
  let st=await runner.tick();
  assert.deepEqual(st.waiting,{BTC:'Nätverksfel'});
  await runner.updateSettings({symbols:['ETH']});
  assert.deepEqual([runner.status().state,runner.status().waiting],['trading',{}]);
  rt.fail=null;
  for(let k=1;k<=3;k++){rt.at=after(L1.i+k);st=await runner.tick();}
  assert.deepEqual([st.state,st.waiting],['trading',{}]);
});

test('slow reads never cost a fresh signal: the price is read last, and a price or limits that age on the way are read again',async()=>{
  // Bybit's limits take 16 s through a slow proxy: the price read after them is still fresh.
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await h.runner.tick();
  h.rt.at=after(L1.i);
  const good=fakeBybit(h.rt);
  const slow=h.tab({grab:async(u,o)=>{if(u.includes('/instruments-info'))h.rt.at+=16*SEC;return good(u,o);}});
  await slow.tick();
  let a=saved(h.storage);
  assert.deepEqual([a.positions.length,a.positions[0]?.openedAt,a.processed.BTC],[1,h.rt.at,L1.t]);
  assert.deepEqual(a.log.filter(e=>e.kind==='avvisad'),[]);
  // The price ages after it was read (a busy page, a slow lock): the signal waits, nothing is refused, and the retry trades it.
  const g=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await g.runner.tick();
  g.rt.at=after(L1.i);
  // The tick's second lock request is the decision's write.
  let requests=0;
  const busy=g.tab({locks:{request:(name,fn)=>g.locks.request(name,()=>{if(++requests===2)g.rt.at+=16*SEC;return fn();})}});
  let st=await busy.tick();
  a=saved(g.storage);
  assert.deepEqual([a.positions,a.log,a.processed.BTC],[[],[],m.bar(L1.i-1).t]);
  assert.deepEqual(st.waiting,{BTC:'Färskt pris saknas för BTC'});
  g.rt.at+=RUNNER.retry;st=await busy.tick();
  a=saved(g.storage);
  assert.deepEqual([a.positions.length,a.processed.BTC,st.waiting],[1,L1.t,{}]);
  // Bybit's limits pass their 10 minutes between loading and the decision: loaded again, not refused.
  const c=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await c.runner.tick();
  c.rt.at=after(L1.i);
  let loads=0;
  const aging={get:()=>null,async load(s){loads++;return limitsFor(s,loads===1?c.rt.at-LIMIT_TTL+SEC:c.rt.at);}};
  const ticking=fakeBybit(c.rt);
  const late=c.tab({contracts:aging,grab:async(u,o)=>{const r=await ticking(u,o);if(loads===1&&u.includes('/tickers'))c.rt.at+=2*SEC;return r;}});
  st=await late.tick();
  a=saved(c.storage);
  assert.deepEqual([a.positions,a.log],[[],[]]);
  assert.deepEqual(st.waiting,{BTC:'Bybits hävstångsgräns saknas för BTC'});
  c.rt.at+=RUNNER.retry;await late.tick();
  assert.deepEqual([saved(c.storage).positions.length,loads],[1,2]);
});

test('a 5-minute step that begins while the history is read fails neither the settlement, a manual close nor an opposite-signal close',async()=>{
  // The clock passes a 5-minute boundary right after the first 5-minute candle read (after the hourly read, for the flip).
  const across=(h,boundary,{after1h=false}={})=>{
    const good=fakeBybit(h.rt);let hourly=!after1h,bumped=false;
    h.rt.at=boundary-300;
    return {crossed:()=>bumped,tab:h.tab({grab:async(u,o)=>{
      const res=await good(u,o);
      if(u.includes('interval=60'))hourly=true;
      else if(hourly&&!bumped&&u.includes('/market/kline')&&u.includes('interval=5')){bumped=true;h.rt.at=boundary+200;}
      return res;
    }})};
  };
  for(const what of ['tick','close']){
    const h=harness({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}});
    await h.runner.tick();
    const p=saved(h.storage).positions[0],x=across(h,p.nextBar+3*STEP);
    if(what==='tick'){
      const st=await x.tab.tick();
      assert.deepEqual([st.state,st.protection],['trading','']);
      assert.equal(saved(h.storage).positions[0].fundingThrough,h.rt.at);
    }else{
      const res=await x.tab.closePosition(p.id);
      assert.equal(res.ok,true,res.text);assert.equal(res.trade.reason,'manuell');assert.equal(res.trade.closedAt,h.rt.at);
    }
    assert.ok(x.crossed());
  }
  // Bybit publishes a step's last-price candle a second late, right after an opening: no problem shown, settled next tick.
  const o=harness({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}});
  await o.runner.tick();
  const first=saved(o.storage).positions[0];
  o.rt.at=first.nextBar+500;o.rt.lag=SEC;
  let late=await o.runner.tick();
  assert.deepEqual([late.state,late.protection,saved(o.storage).positions[0].fundingThrough],['trading','',first.fundingThrough]);
  o.rt.at+=5*SEC;late=await o.runner.tick();
  assert.deepEqual([late.state,late.protection,saved(o.storage).positions[0].fundingThrough],['trading','',o.rt.at]);
  // Still missing after the grace: shown.
  o.rt.at=first.nextBar+STEP+RUNNER.grace+SEC;o.rt.lag=RUNNER.grace+5*SEC;
  late=await o.runner.tick();
  assert.deepEqual([late.state,late.protection],['waiting','skyddskontroll för BTC: Lucka i 5-minuterspriserna för BTC']);
  // The boundary is the deadline: the close still books the time stop at the deadline candle's open.
  const R=m.end+30,t0=after(R),d=harness({time:t0}),quote=await quoteAt(d.rt,'BTC');
  const signal={id:`s|u1|BTC|1h|${m.bar(R).t}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.95,tp:quote.price*1.05,barTime:m.bar(R).t,confirmedAt:m.closeOf(R)};
  const held=openPosition(newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
  d.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(held,'BTC',m.bar(R).t)));
  const q=held.positions[0],y=across(d,q.deadline);
  const res=await y.tab.closePosition(q.id);
  assert.ok(y.crossed());
  assert.deepEqual([res.ok,res.trade?.reason,res.trade?.closedAt],[true,'tid',q.deadline],res.text);
  near(res.trade.exit,m.sub((q.deadline-START)/STEP).o*SCALE.BTC*(1-SLIP));
  assert.match(res.text,/^Tidsstopp hann före den manuella stängningen: lång BTC [+−]/);
  // An opposite signal whose position read straddles a step: closed and reversed in the same decision.
  const s0=after(S1.i-3),f=harness({time:s0}),barTime=m.bar(S1.i-3).t,fq=await quoteAt(f.rt,'BTC');
  const long={id:`s|u1|BTC|1h|${barTime}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:fq.price,sl:fq.price*.9,tp:fq.price*1.2,barTime,confirmedAt:barTime+HOUR};
  const acc=openPosition(newForecastAccount(s0-HOUR,{symbols:['BTC'],leverage:10}),{signal:long,symbol:'BTC',quote:fq,contract:limitsFor('BTC',s0),now:s0,tfMs:HOUR,dataReliable:true}).account;
  f.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(acc,'BTC',barTime)));
  const z=across(f,S1.close+5*MIN,{after1h:true});
  const st=await z.tab.tick();
  assert.ok(z.crossed());
  const a=saved(f.storage);
  assert.deepEqual([st.state,st.error,a.trades.map(t=>t.reason),a.positions.map(p=>p.side),a.processed.BTC],['trading','',['signal'],['short'],S1.t]);
  // Bybit's newest 5-minute candle is late: the opposite-signal close waits for it, then goes through inside the signal's window.
  const w=harness({time:s0}),ws=await quoteAt(w.rt,'BTC');
  const wl={...long,entry:ws.price,sl:ws.price*.9,tp:ws.price*1.2};
  w.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(openPosition(newForecastAccount(s0-HOUR,{symbols:['BTC'],leverage:10}),{signal:wl,symbol:'BTC',quote:ws,contract:limitsFor('BTC',s0),now:s0,tfMs:HOUR,dataReliable:true}).account,'BTC',barTime)));
  w.rt.at=S1.close+5*MIN+500;w.rt.lag=SEC;
  let ws1=await w.runner.tick();
  assert.deepEqual([ws1.state,ws1.waiting,saved(w.storage).trades],['waiting',{BTC:'Bybits senaste 5-minuterspriser saknas ännu'},[]]);
  w.rt.at+=RUNNER.retry;ws1=await w.runner.tick();
  assert.deepEqual([ws1.state,saved(w.storage).trades.map(t=>t.reason),saved(w.storage).positions.map(p=>p.side)],['trading',['signal'],['short']]);
  // A manual close while the candle stays missing: three reads, then a clear failure and the position kept.
  const k=harness({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}});
  await k.runner.tick();
  const kp=saved(k.storage).positions[0];
  k.rt.at=kp.nextBar+STEP+SEC;k.rt.lag=20*SEC;k.rt.urls=[];
  const kept=await k.runner.closePosition(kp.id);
  assert.deepEqual(kept,{ok:false,text:'Kunde inte stänga BTC: Bybits senaste 5-minuterspriser saknas ännu, försök igen om en stund',trade:null});
  assert.equal(k.rt.urls.filter(u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('interval')==='5').length,3);
  assert.equal(saved(k.storage).positions.length,1);
});

test('a wick in the minutes after an entry is booked although the page was not watching them',async()=>{
  for(const [leverage,kind,reason] of [[10,'last','stopp'],['max','mark','likvidation']]){
    const h=harness({time:after(L1.i),settings:{symbols:['BTC'],leverage}});
    await h.runner.tick();
    const p=saved(h.storage).positions[0],first=p.nextBar,wick=L1.close+3*MIN;
    assert.deepEqual([p.openedAt,first],[L1.close+2*SEC,L1.close+STEP]);
    // The page sleeps through the step the entry fell in. Bybit's 10:03 minute dips through the level, and only that
    // minute shows it: the 5-minute candles after the step do not.
    h.rt.wicks=[{symbol:'BTC',at:wick,kind,l:kind==='mark'?p.liq*.999:p.sl*.999}];
    h.rt.at=first+2*STEP+2*SEC;
    const st=await h.runner.tick(),[t]=saved(h.storage).trades;
    assert.deepEqual([t.reason,t.closedAt,st.protection],[reason,wick+MIN,''],String(leverage));
    near(t.exit,kind==='mark'?p.liq:p.sl*(1-SLIP));
    assert.ok(h.rt.urls.some(u=>u.pathname.endsWith('/kline')&&u.searchParams.get('interval')==='1'));
    assert.ok(h.rt.urls.some(u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('interval')==='1'));
  }
});

test('a late 1-minute candle of the opening step is waited for without a warning, a missing one is shown',async()=>{
  const open=async()=>{
    const h=harness({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}});
    await h.runner.tick();
    return {...h,p:saved(h.storage).positions[0]};
  };
  // Just after the step: Bybit has not published its last minute yet. The same position goes first next tick.
  const h=await open(),first=h.p.nextBar;
  h.rt.holes=new Set([`BTC:1:${first-MIN}`]);h.rt.at=first+3*SEC;
  let st=await h.runner.tick();
  assert.deepEqual([st.state,st.protection,saved(h.storage).positions[0].fundingThrough],['trading','',h.p.fundingThrough]);
  h.rt.holes=null;h.rt.at+=5*SEC;st=await h.runner.tick();
  assert.deepEqual([st.state,st.protection,saved(h.storage).positions[0].fundingThrough],['trading','',h.rt.at]);
  // The same for the first minute replayed, which has no minute before it: just closed, it and the forming minute not out yet.
  const e=await open(),firstMinute=Math.ceil(e.p.openedAt/MIN)*MIN;
  e.rt.holes=new Set([`BTC:1:${firstMinute}`,`BTC:1:${firstMinute+MIN}`]);e.rt.at=firstMinute+MIN+3*SEC;
  st=await e.runner.tick();
  assert.deepEqual([st.state,st.protection,saved(e.storage).positions[0].fundingThrough],['trading','',e.p.fundingThrough]);
  e.rt.holes=null;e.rt.at+=5*SEC;st=await e.runner.tick();
  assert.deepEqual([st.state,st.protection,saved(e.storage).positions[0].fundingThrough],['trading','',e.rt.at]);
  // Past the grace it is shown like any other minute.
  const late=await open();late.rt.holes=new Set([`BTC:1:${firstMinute}`,`BTC:1:${firstMinute+MIN}`]);late.rt.at=firstMinute+MIN+RUNNER.grace+3*SEC;
  st=await late.runner.tick();
  assert.deepEqual([st.state,st.protection],['waiting','skyddskontroll för BTC: Lucka i 1-minuterspriserna för BTC']);
  // Still missing after the grace: shown, and a manual close waits for it.
  const g=await open();
  g.rt.holes=new Set([`BTC:1:${first-MIN}`]);g.rt.at=first+RUNNER.grace+5*SEC;
  st=await g.runner.tick();
  assert.deepEqual([st.state,st.protection],['waiting','skyddskontroll för BTC: Lucka i 1-minuterspriserna för BTC']);
  assert.deepEqual(await g.runner.closePosition(g.p.id),{ok:false,text:'Kunde inte stänga BTC: Bybits senaste 1-minuterspriser saknas ännu, försök igen om en stund',trade:null});
  // An earlier minute that Bybit lacks is a gap at once.
  const k=await open();
  k.rt.holes=new Set([`BTC:1:${first-3*MIN}`]);k.rt.at=first+3*SEC;
  st=await k.runner.tick();
  assert.deepEqual([st.state,st.protection,saved(k.storage).positions.length],['waiting','skyddskontroll för BTC: Lucka i 1-minuterspriserna för BTC',1]);
  k.rt.holes=null;k.rt.at+=5*SEC;st=await k.runner.tick();
  assert.deepEqual([st.state,st.protection],['trading','']);
});

test('a missing candle in the backlog never yields a record: every stored signal is what the complete history gives',async()=>{
  const need=requiredLookback('1h'),back=L1.i+need+30;
  const away=harness({time:after(L1.i-1),settings:{symbols:['BTC']}});
  await away.runner.tick();
  // Bybit leaves out the candle before L2: it lies in the windows of L2 and later backlog candles, not in the newest one's.
  away.rt.holes=new Set([`BTC:60:${m.bar(L2.i-1).t}`]);
  away.rt.at=after(back);
  const st=await away.runner.tick();
  assert.equal(st.data.BTC.state,'live');
  assert.equal(saved(away.storage).processed.BTC,m.bar(back).t);
  const bars=splitForming((await fetchKlines(fakeBybit({...away.rt,holes:null,urls:[]}),'BTC','1h',{limit:1000,now:()=>away.rt.at})).bars,'1h',away.rt.at).closed;
  const recs=await signalsOf(away.store,'BTC');
  assert.deepEqual(recs.map(r=>r.barTime),[L1.t],'only L1\'s window is complete');
  for(const r of recs){
    const e=evaluateBar(bars,bars.findIndex(b=>b.t===r.barTime),{tf:'1h'});
    assert.equal(r.contentHash,signalRecord('u1','BTC','1h',e,{recordedAt:r.recordedAt,origin:r.origin,tfMs:HOUR}).contentHash);
  }
});

test('logging out while a tick reads leaves no error or protection text behind',async()=>{
  const h=harness({time:after(L1.i),settings:{symbols:['BTC'],leverage:10}});
  await h.runner.tick();
  assert.equal(saved(h.storage).positions.length,1);
  // The user logs out while the position's history is read, and the page asks for the status meanwhile.
  const good=fakeBybit(h.rt);
  const tab=h.tab({grab:async(u,o)=>{const res=await good(u,o);if(u.includes('mark-price-kline')){h.rt.fail='Nätverksfel';h.who.user=null;tab.status();}return res;}});
  h.rt.at+=5*SEC;
  let st=await tab.tick();
  assert.deepEqual([st.state,st.error,st.protection],['signed-out','','']);
  h.rt.at+=5*SEC;st=await tab.tick();
  assert.deepEqual([st.state,st.error,st.protection],['signed-out','','']);
});

test('another tab\'s new timeframe reaches this tab\'s decisions at once',async()=>{
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  const A=h.runner,B=h.tab();
  await A.tick();
  // B finds the candle decided by A and rests until the next hourly close.
  h.rt.at+=3*SEC;await B.tick();
  // A switches the account to 5-minute candles, then its tab closes.
  await A.updateSettings({tf:'5m'});
  const reads=[];
  for(let k=1;k<=12;k++){
    h.rt.at=after(L1.i-1,3*SEC+k*MIN);h.rt.urls=[];
    await B.tick();
    if(h.rt.urls.some(u=>u.pathname.endsWith('/kline')&&u.searchParams.get('interval')==='5'))reads.push(k);
  }
  assert.deepEqual(reads,[1,5,10]);
  assert.equal(saved(h.storage).processed.BTC,L1.t+5*MIN);
});

test('a Bybit read that never settles holds up neither later ticks nor the other positions\' protection; the hung coin shows why, and a late answer changes nothing',{timeout:20000},async()=>{
  const h=harness({time:after(L1.i),settings:{symbols:['BTC','ETH'],leverage:10}});
  await h.runner.tick();
  assert.deepEqual(saved(h.storage).positions.map(p=>p.symbol),['BTC','ETH']);
  // From here on every BTC request stalls, like a response body that never ends, until the test answers it.
  const good=fakeBybit(h.rt),stalled=[],t0=h.rt.at,why='Bybit svarade inte i tid';
  const tab=h.tab({timeouts:{read:120,quote:60},grab:(u,o)=>u.includes('BTCUSDT')?new Promise(resolve=>stalled.push(()=>resolve(good(u,o)))):good(u,o)});
  for(let k=1;k<=4;k++){
    h.rt.at=t0+5*SEC*k;
    // Every tick ends, and the hung coin's reason shows on each one.
    const st=await tab.tick();
    assert.equal(st.state,'waiting','tick '+k);
    assert.equal(st.protection,'pris för BTC: '+why+' · skyddskontroll för BTC: '+why,'tick '+k);
  }
  const [btc,eth]=saved(h.storage).positions;
  assert.equal(btc.fundingThrough,t0,'BTC cannot be settled');
  assert.equal(eth.fundingThrough,h.rt.at,'ETH is still settled on its turns');
  // ETH falls through its stop: the live check closes it while BTC still hangs.
  h.rt.price={ETH:eth.sl*.99};h.rt.at+=5*SEC;
  await tab.tick();
  assert.deepEqual(saved(h.storage).trades.map(t=>[t.symbol,t.reason,t.closedAt]),[['ETH','stopp',h.rt.at]]);
  // At the next close BTC's candles hang as well, which pauses its entries with the same reason.
  delete h.rt.price;h.rt.at=after(L1.i+1);
  let st=await tab.tick();
  assert.deepEqual([st.data.BTC.state,st.data.BTC.text],['error','Data saknas — '+why]);
  // Answers that arrive after their deadline are dropped: nothing they carry is used or written.
  const before=h.storage.getItem(accountKey('u1'));
  assert.ok(stalled.length>=8);
  for(const answer of stalled.splice(0))answer();
  await new Promise(resolve=>setTimeout(resolve,50));
  st=tab.status();
  assert.equal(h.storage.getItem(accountKey('u1')),before);
  assert.equal(tab.quotes().BTC,undefined);
  assert.deepEqual([st.protection,st.data.BTC.text,st.busy],['pris för BTC: '+why+' · skyddskontroll för BTC: '+why,'Data saknas — '+why,false]);
});

test('an archive or Bybit limits that never answer end the decision with a reason, and the signal is traded once they answer',{timeout:20000},async()=>{
  // The archive never answers: the fresh signal waits for its record.
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await h.runner.tick();
  let hang=true;
  const tab=h.tab({store:{...h.store,putSignal:r=>hang?new Promise(()=>{}):h.store.putSignal(r)},timeouts:{archive:60}});
  h.rt.at=after(L1.i);
  let st=await tab.tick();
  assert.deepEqual([st.state,st.waiting,saved(h.storage).positions],['waiting',{BTC:'Signalen för BTC kunde inte sparas'},[]]);
  assert.deepEqual(st.notes,['Signalen för BTC '+hhmm(L1.close)+' kunde inte sparas: Prognosarkivet svarar inte']);
  hang=false;h.rt.at=after(L1.i,20*SEC);st=await tab.tick();
  assert.deepEqual([st.state,saved(h.storage).positions.length],['trading',1]);
  // Bybit's limits never come from the page's contract cache, and the runner's own reads of them fail too: the signal
  // waits for them with the reason.
  const c=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10}});
  await c.runner.tick();
  const slow=c.tab({contracts:{get:()=>null,load:()=>new Promise(()=>{})},timeouts:{read:120}});
  c.rt.at=after(L1.i);c.rt.fail=u=>/instruments-info|risk-limit/.test(u.pathname)?'Nätverksfel':null;
  st=await slow.tick();
  assert.deepEqual([st.state,st.waiting,saved(c.storage).positions],['waiting',{BTC:'Bybits hävstångsgräns saknas för BTC'},[]]);
  // Like the page's cache, the runner's own asks Bybit again a minute after a failure; then the signal is traded.
  c.rt.fail=null;c.rt.at=after(L1.i,20*SEC);st=await slow.tick();
  assert.deepEqual([st.state,st.waiting,saved(c.storage).positions],['waiting',{BTC:'Bybits hävstångsgräns saknas för BTC'},[]]);
  c.rt.at=after(L1.i,80*SEC);st=await slow.tick();
  assert.deepEqual([st.state,saved(c.storage).positions.length],['trading',1]);
});

test('a read of Bybit\'s limits that stalls in the page\'s shared cache keeps no coin from trading, and the shared cache stays as it is',{timeout:20000},async()=>{
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC','ETH'],leverage:10}});
  await h.runner.tick();
  // The page's cache reads through the page's grab, where an answer can stall for good: here BTC's first instrument read.
  const good=fakeBybit(h.rt),loads=[];let stalls=1;
  const pageGrab=(url,o)=>url.includes('instruments-info')&&url.includes('BTCUSDT')&&stalls-->0?new Promise(()=>{}):good(url,o);
  const shared=createContractCache(pageGrab,()=>h.rt.at);
  const tab=h.tab({contracts:{get:s=>shared.get(s),load:s=>{loads.push(s);return shared.load(s);}},timeouts:{read:120}});
  h.rt.at=after(L1.i);
  const st=await tab.tick();
  // BTC's limits come from the runner's own bounded reads; ETH's from the shared cache, as before.
  assert.deepEqual([st.state,st.waiting,saved(h.storage).positions.map(p=>[p.symbol,p.leverage])],['trading',{},[['BTC',10],['ETH',10]]]);
  assert.deepEqual(loads,['BTC','ETH']);
  assert.equal(shared.get('BTC'),null,'the shared read of BTC is still pending');
  assert.deepEqual(shared.get('ETH'),limitsFor('ETH',h.rt.at));
  // BTC's next entry goes to the runner's own cache at once, without waiting on the stalled shared read again.
  h.rt.at+=5*SEC;
  const closed=await tab.closePosition(saved(h.storage).positions[0].id);
  assert.equal(closed.ok,true,closed.text);
  for(let i=L1.i+1;i<=L2.i;i++){h.rt.at=after(i);await ticks(tab,2);}
  assert.deepEqual(saved(h.storage).positions.map(p=>[p.symbol,p.signalId.split('|')[4]]),[['ETH',String(L1.t)],['BTC',String(L2.t)]]);
  // The stalled shared cache is not asked for BTC again; the held ETH's limits are read there again as they expire.
  assert.deepEqual(loads.slice(0,2),['BTC','ETH']);
  assert.ok(loads.length>2&&loads.slice(2).every(s=>s==='ETH'),loads.join(' '));
});

// Long positions in `symbols` from the signal of bar E = L2 − maxHold, so their time stop is L2's close.
async function expiring(symbols,settings){
  const E=L2.i-SIGNAL_PARAMS.maxHold,t0=after(E),h=harness({time:t0}),barTime=m.bar(E).t;
  let a=newForecastAccount(t0-HOUR,{leverage:10,maxOpen:symbols.length});
  for(const s of symbols){
    const q=await quoteAt(h.rt,s);
    a=openPosition(a,{signal:{id:`s|u1|${s}|1h|${barTime}|${MODEL.signal}`,symbol:s,tf:'1h',side:'long',entry:q.price,sl:q.price*.9,tp:q.price*1.2,barTime,confirmedAt:barTime+HOUR},
      symbol:s,quote:q,contract:limitsFor(s,t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
  }
  a=updateSettings(a,settings);
  for(const s of SYMBOLS)a=markProcessed(a,s,m.bar(L2.i-1).t);
  assert.ok(a.positions.every(p=>p.deadline===L2.close));
  h.storage.setItem(accountKey('u1'),JSON.stringify(a));
  return h;
}

test('positions past their time stop are settled before the entries, so like the backtest they hold neither a slot nor their coin',async()=>{
  for(const [maxOpen,open] of [[3,['BTC','ETH','SOL']],[2,['BTC','ETH']]]){
    // ETH and SOL end at L2's close, when every coin signals again; a tick settles one position per turn.
    const h=await expiring(['ETH','SOL'],{maxOpen});
    h.rt.at=after(L2.i);
    await h.runner.tick();
    const a=saved(h.storage);
    // Both time stops at the deadline candle's open, then the entries in coin order.
    assert.deepEqual(a.trades.map(t=>[t.symbol,t.reason,t.closedAt]),[['ETH','tid',L2.close],['SOL','tid',L2.close]]);
    for(const t of a.trades)near(t.exit,m.sub((L2.close-START)/STEP).o*SCALE[t.symbol]*(1-SLIP));
    assert.deepEqual(a.positions.map(p=>[p.symbol,p.signalId.split('|')[4]]),open.map(s=>[s,String(L2.t)]));
    assert.deepEqual(a.log.filter(e=>e.kind==='avvisad').map(e=>[e.symbol,e.text]),
      SYMBOLS.filter(s=>!open.includes(s)).map(s=>[s,'Max antal öppna positioner är nått ('+maxOpen+')']));
  }
});

test('an entry waits, unrefused, while a position past its time stop cannot be settled yet, and goes through once it can',async()=>{
  // SOL is held but no longer traded and fills the only slot; its time stop is L2's close.
  const h=await expiring(['SOL'],{symbols:['BTC'],maxOpen:1});
  // Bybit publishes SOL's 5-minute candle of the deadline late, so the time stop cannot be booked yet.
  h.rt.at=after(L2.i);h.rt.lag={SOL:10*SEC};
  let st=await h.runner.tick(),a=saved(h.storage);
  const why='Tidsstoppet för SOL är inte avräknat — Bybits senaste 5-minuterspriser saknas ännu';
  assert.deepEqual([st.state,st.text,st.waiting],['waiting','Väntar på ny affär i BTC: '+why,{BTC:why}]);
  assert.deepEqual([a.positions.map(p=>p.symbol),a.trades,a.log.filter(e=>e.kind==='avvisad'),a.processed.BTC],[['SOL'],[],[],m.bar(L2.i-1).t],'nothing refused or decided');
  // The candle comes: the time stop is booked at the deadline candle's open and the waiting entry is taken.
  h.rt.lag=null;h.rt.at+=RUNNER.retry;
  st=await h.runner.tick();a=saved(h.storage);
  assert.deepEqual(a.trades.map(t=>[t.symbol,t.reason,t.closedAt]),[['SOL','tid',L2.close]]);
  assert.deepEqual([a.positions.map(p=>[p.symbol,p.signalId.split('|')[4]]),a.processed.BTC,st.waiting,st.state],[[['BTC',String(L2.t)]],L2.t,{},'trading']);
  assert.deepEqual(a.log.filter(e=>e.kind==='avvisad'),[]);
  // The computer's clock 4 s behind Bybit's: the decision comes before our clock reaches SOL's time stop,
  // so the entry waits for it rather than finding the slot taken.
  const b=await expiring(['SOL'],{symbols:['BTC'],maxOpen:1});
  b.rt.at=L2.close-3*SEC;b.rt.server=L2.close+SEC;
  st=await b.runner.tick();a=saved(b.storage);
  const behind='Tidsstoppet för SOL är inte avräknat — datorns klocka går efter Bybits';
  assert.deepEqual([st.waiting,a.positions.map(p=>p.symbol),a.log.filter(e=>e.kind==='avvisad'),a.processed.BTC],[{BTC:behind},['SOL'],[],m.bar(L2.i-1).t]);
  b.rt.at+=RUNNER.retry;b.rt.server+=RUNNER.retry;
  st=await b.runner.tick();a=saved(b.storage);
  assert.deepEqual(a.trades.map(t=>[t.symbol,t.reason,t.closedAt]),[['SOL','tid',L2.close]]);
  assert.deepEqual([a.positions.map(p=>p.symbol),a.processed.BTC,st.waiting],[['BTC'],L2.t,{}]);
});

test('a full archive says plainly that new signals cannot be saved and new trades are paused, until a record fits again',async()=>{
  const h=harness({time:after(L1.i),settings:{symbols:['BTC','ETH'],leverage:10}});
  await h.runner.tick();
  assert.equal(saved(h.storage).positions.length,2);
  // A tab whose localStorage archive is full; its open positions are still guarded.
  let room=false;
  const full=createForecastStore(localStorageBackend(memoryStorage(),undefined,{maxChars:10}));
  const tab=h.tab({store:{...h.store,putSignal:r=>room?h.store.putSignal(r):full.putSignal(r)}});
  const FULL='Prognosarkivet är fullt: nya signaler kan inte sparas och nya affärer är pausade';
  h.rt.fail=u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('symbol')==='ETHUSDT'?'Nätverksfel':null;
  h.rt.at=after(L2.i);
  let st=await tab.tick();
  assert.deepEqual([st.state,st.text,st.archiveFull],['waiting',FULL,true]);
  assert.deepEqual(st.waiting,{BTC:'Signalen för BTC kunde inte sparas',ETH:'Signalen för ETH kunde inte sparas'});
  assert.deepEqual(st.notes,['BTC','ETH'].map(s=>'Signalen för '+s+' '+hhmm(L2.close)+' kunde inte sparas: Prognosarkivet är fullt'));
  // Any other problem is named after it.
  h.rt.at+=5*SEC;st=await tab.tick();
  assert.deepEqual([st.state,st.text],['waiting',FULL+' · Väntar på skyddskontroll för ETH: Nätverksfel']);
  // Past the signal's window it is decided as missed, and once ETH settles again the status still says why
  // nothing can be traded.
  h.rt.fail=null;h.rt.at=after(L2.i,31*MIN);st=await tab.tick();
  assert.deepEqual([st.waiting,saved(h.storage).processed.BTC],[{},L2.t]);
  h.rt.at+=5*SEC;st=await tab.tick();
  assert.deepEqual([st.state,st.text,st.protection],['waiting',FULL,'']);
  // Once a record is stored again the status is back to normal.
  room=true;h.rt.at=after(L3.i);st=await tab.tick();
  assert.deepEqual([st.state,st.archiveFull],['trading',false]);
  assert.deepEqual((await signalsOf(h.store,'BTC')).map(r=>r.barTime),[L1.t,L3.t]);
});

// ---- Manual trading: auto-trading off, the user's orders, stop and target, deposits and withdrawals -----------------

const money2=x=>x.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2});
const svPrice=x=>x.toLocaleString('sv-SE',{maximumSignificantDigits:6});
const sv=(x,d)=>x.toLocaleString('sv-SE',{maximumFractionDigits:d});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
// The quiet range after the scripted legs: no signals, prices near 61 000 $ for BTC.
const Q=m.end+30;

test('auto-trading off (a new account): signals are stored and shown, nothing is traded on them, and the status says manual trading',async()=>{
  const {rt,runner,storage,store}=harness({time:after(L1.i-1)});
  let st=await runner.tick();
  assert.deepEqual([st.state,st.text,st.auto,st.open,st.manual],['manual','Manuell handel · 0 öppna positioner',false,0,0]);
  assert.equal(saved(storage).settings.auto,false);
  rt.at=after(L1.i);rt.urls=[];
  st=await runner.tick();
  const a=saved(storage);
  // Every coin's breakout is stored and its candle decided, but no position opened and no refusal logged; no price or limits read.
  assert.deepEqual([a.positions,a.log],[[],[]]);
  for(const s of SYMBOLS){assert.deepEqual((await signalsOf(store,s)).map(r=>[r.barTime,r.origin]),[[L1.t,'live']],s);assert.equal(a.processed[s],L1.t);}
  assert.deepEqual(urlKinds(rt.urls),['kline:60']);
  assert.deepEqual([st.last.side,st.last.fresh,st.last.opened,st.last.reason],['long',true,null,'Auto-handel av — signalen handlas inte']);
  assert.equal(runner.evaluations().BTC.evaluation.side,'long');
  // Unreliable data does not stop manual trading; the coins are still named for the page's warnings.
  rt.at=after(L1.i+1);rt.holes=new Set([`BTC:60:${m.bar(L1.i-5).t}`]);
  st=await runner.tick();
  assert.deepEqual([st.state,st.text,st.unreliable],['manual','Manuell handel · 0 öppna positioner',['BTC']]);
  // An archive that cannot store a signal makes no wait for a trade.
  const full=createForecastStore(localStorageBackend(memoryStorage(),undefined,{maxChars:10}));
  const t2=harness({time:after(L1.i-1),store:full}),r2=t2.tab();
  await r2.tick();t2.rt.at=after(L1.i);st=await r2.tick();
  assert.deepEqual([st.state,st.waiting,st.archiveFull,st.text],['manual',{},true,'Manuell handel · 0 öppna positioner · prognosarkivet är fullt, nya signaler sparas inte']);
  assert.equal(saved(t2.storage).processed.BTC,L1.t);
});

test('auto-trading off: a held signal position keeps its own rules — no close on an opposite signal, but its stop, target and time stop',async()=>{
  const t0=after(S1.i-3),h=harness({time:t0}),barTime=m.bar(S1.i-3).t,quote=await quoteAt(h.rt,'BTC');
  const signal={id:`s|u1|BTC|1h|${barTime}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.9,tp:quote.price*1.2,barTime,confirmedAt:barTime+HOUR};
  const a=openPosition(plainAccount(t0-HOUR,{symbols:['BTC'],leverage:10}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
  h.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(a,'BTC',barTime)));
  const long=a.positions[0];
  // The short signal arrives: stored, but the long stays.
  h.rt.at=after(S1.i);
  let st=await h.runner.tick();
  let b=saved(h.storage);
  assert.deepEqual([b.positions.map(p=>[p.id,p.origin]),b.trades,b.processed.BTC],[[[long.id,'signal']],[],S1.t]);
  assert.deepEqual([st.state,st.text,st.last.reason],['manual','Manuell handel · 1 öppen position','Auto-handel av — signalen handlas inte']);
  assert.equal((await signalsOf(h.store,'BTC')).at(-1).side,'short');
  // Its 20-candle time stop still ends it, at the deadline candle's open.
  h.rt.at=long.deadline+2*HOUR;
  await ticks(h.runner,2);
  b=saved(h.storage);
  assert.deepEqual(b.trades.map(t=>[t.reason,t.closedAt,t.origin]),[['tid',long.deadline,'signal']]);
});

test('auto-trading on: a manual position is never closed by a signal or a time stop, and a signal in its coin is refused',async()=>{
  const t0=after(S1.i-3),h=harness({time:t0,settings:{symbols:['BTC','ETH'],leverage:10}});
  await h.runner.tick();
  const res=await h.runner.order({symbol:'BTC',side:'long',margin:20,leverage:10});
  assert.equal(res.ok,true,res.text);
  // The short breakout: ETH opens short; BTC's signal is refused because the manual long holds the coin, and the long stays.
  h.rt.at=after(S1.i);
  let st=await h.runner.tick(),a=saved(h.storage);
  assert.deepEqual(a.positions.map(p=>[p.symbol,p.side,p.origin]),[['BTC','long','manual'],['ETH','short','signal']]);
  assert.deepEqual(a.log.filter(e=>e.kind==='avvisad').map(e=>[e.symbol,e.text]),[['BTC','Det finns redan en position i BTC']]);
  assert.equal(st.text,'Handlar · 1 av 3 positioner · 1 manuell · nästa beslut '+hhmm(S1.close+HOUR));
  assert.deepEqual([st.state,st.open,st.manual],['trading',2,1]);
  // More than a day later (beyond any signal's 20 candles) the signal position has ended by its own rules; the manual one is still open.
  for(const k of [6,12,18,24,30]){h.rt.at=after(S1.i+k);await ticks(h.runner,2);}
  a=saved(h.storage);
  assert.deepEqual(a.positions.map(p=>[p.symbol,p.origin,p.deadline]),[['BTC','manual',null]]);
  assert.ok(a.trades.some(t=>t.symbol==='ETH'&&['tid','mål','stopp'].includes(t.reason)));
  assert.ok(!a.trades.some(t=>t.symbol==='BTC'));assert.ok(h.rt.at-a.positions[0].openedAt>20*HOUR);
});

test('order(): Bybit\'s limits and a fresh price are read, then exactly what the account previews is opened and written before the answer',async()=>{
  const h=harness({time:after(Q)}),r=h.runner;
  await r.tick();
  const before=saved(h.storage);
  h.rt.urls=[];
  const res=await r.order({symbol:'BTC',side:'long',margin:10,leverage:50,sl:60500,tp:62000});
  const quote=await quoteAt(h.rt,'BTC'),p=previewOrder(before,{symbol:'BTC',side:'long',margin:10,leverage:50,sl:60500,tp:62000,quote,contract:limitsFor('BTC',h.rt.at),now:h.rt.at});
  assert.equal(res.ok,true,res.text);assert.equal(p.ok,true);
  const pos=res.position;
  assert.deepEqual([pos.units,pos.entry,pos.margin,pos.fees,pos.liq,pos.leverage,pos.sl,pos.tp,pos.origin,pos.openedAt],[p.qty,p.fill,p.margin,p.fee,p.liq,50,60500,62000,'manual',h.rt.at]);
  assert.deepEqual(res.preview,p);
  assert.equal(res.text,'Köpte '+sv(p.qty,3)+' BTC till '+svPrice(p.fill)+' · 50× · marginal '+money2(p.margin)+' $ · SL '+svPrice(60500)+' · TP '+svPrice(62000));
  const a=saved(h.storage);
  assert.deepEqual(a.positions,[pos]);
  assert.equal(a.log.at(-1).text,'Öppnade lång '+sv(p.qty,3)+' BTC till '+svPrice(p.fill)+' · 50× · marginal '+money2(p.margin)+' $ · SL '+svPrice(60500)+' · TP '+svPrice(62000)+' (manuell)');
  assert.deepEqual(urlKinds(h.rt.urls),['instruments-info','risk-limit','tickers']);
  assert.equal(r.status().text,'Manuell handel · 1 öppen position');
  // A short in another coin: 'Sålde'. The limits read stay cached for ten minutes.
  h.rt.urls=[];h.rt.at+=10*SEC;
  const eth=await r.order({symbol:'ETH',side:'short',margin:15,leverage:20});
  assert.equal(eth.ok,true,eth.text);assert.match(eth.text,/^Sålde \d+,\d+ ETH till [\d ,]+ · 20× · marginal \d+,\d\d \$$/);
  h.rt.urls=[];h.rt.at+=10*SEC;
  await r.order({symbol:'SOL',side:'long',margin:10,leverage:5});
  h.rt.urls=[];h.rt.at+=10*SEC;
  assert.equal((await r.order({symbol:'BTC',side:'short',margin:10,leverage:5})).ok,false);
  assert.deepEqual(h.rt.urls,[],'a coin already held is refused before any read');
  assert.equal(r.status().text,'Manuell handel · 3 öppna positioner');
  // The positions are guarded from the next tick on, and survive a reload.
  h.rt.at+=5*SEC;await r.tick();
  const reload=h.tab();
  assert.deepEqual(reload.account().positions.map(x=>[x.symbol,x.side,x.origin]),[['BTC','long','manual'],['ETH','short','manual'],['SOL','long','manual']]);
});

test('order() never rejects: signed out, invalid requests, missing limits or price, and the account\'s own refusals come back as reasons, and nothing is written',async()=>{
  const h=harness({time:after(Q)}),r=h.runner;
  await r.tick();
  const raw=()=>h.storage.getItem(accountKey('u1')),before=raw();
  const no=(text,preview=null)=>({ok:false,text,position:null,preview});
  h.who.user=null;
  assert.deepEqual(await r.order({symbol:'BTC',side:'long',margin:10,leverage:10}),no('Logga in för att handla'));
  h.who.user='u1';
  assert.deepEqual(await r.order({symbol:'LUNA',side:'long',margin:10,leverage:10}),no('Okänt par'));
  assert.deepEqual(await r.order({symbol:'BTC',side:'köp',margin:10,leverage:10}),no('Välj köp (lång) eller sälj (kort)'));
  assert.deepEqual(await r.order(null),no('Okänt par'));
  h.rt.fail=u=>/instruments-info|risk-limit/.test(u.pathname)?'Nätverksfel':null;
  assert.deepEqual(await r.order({symbol:'BTC',side:'long',margin:10,leverage:10}),no('Bybits gränser för BTC saknas just nu — försök igen om en stund'));
  h.rt.fail=u=>u.pathname.endsWith('/tickers')?'Nätverksfel':null;
  h.rt.at+=61*SEC;
  assert.deepEqual(await r.order({symbol:'BTC',side:'long',margin:10,leverage:10}),no('Färskt pris saknas för BTC: Nätverksfel'));
  h.rt.fail=null;
  const small=await r.order({symbol:'BTC',side:'long',margin:5,leverage:10});
  assert.deepEqual([small.ok,small.text,small.position,small.preview.reasons],[false,'Under Bybits minsta order (0,001 BTC)',null,['Under Bybits minsta order (0,001 BTC)']]);
  const much=await r.order({symbol:'BTC',side:'long',margin:200,leverage:10});
  assert.equal(much.ok,false);assert.match(much.text,/^Otillräckligt tillgängligt saldo: \d+,\d\d \$ behövs, 100,00 \$ finns$/);
  // Bybit answering without its order filters: the limits load, but no order can be checked against them.
  h.rt.lots={ETH:null};
  const unfiltered=await r.order({symbol:'ETH',side:'long',margin:10,leverage:10});
  assert.deepEqual([unfiltered.ok,unfiltered.text,unfiltered.preview.filters],[false,'Bybits ordergränser för ETH saknas',null]);
  h.rt.lots=null;
  assert.equal(raw(),before,'nothing written');
  // A switch of user while the order is on its way: nothing is written to either account.
  const good=fakeBybit(h.rt);
  const t=h.tab({grab:async(u,o)=>{const res=await good(u,o);if(u.includes('/tickers'))h.who.user='u2';return res;}});
  assert.deepEqual(await t.order({symbol:'BTC',side:'long',margin:10,leverage:10}),no('Kontot byttes medan ordern lades'));
  assert.equal(raw(),before);assert.equal(h.storage.getItem(accountKey('u2')),null);
});

test('two tabs ordering the same coin at once open it once; the other is told the coin is taken',async()=>{
  const storage=memoryStorage(),locks=tabLocks(),write=storage.setItem.bind(storage);
  storage.setItem=(k,v)=>{assert.ok(locks.held.includes(k),'written outside the lock: '+k);write(k,v);};
  const h=harness({time:after(Q),storage,locks,runtime:{delay:2}}),other=h.tab();
  await h.runner.tick();
  const [x,y]=await Promise.all([h.runner.order({symbol:'BTC',side:'long',margin:10,leverage:10}),other.order({symbol:'BTC',side:'short',margin:10,leverage:10})]);
  assert.deepEqual([x.ok,y.ok].sort(),[false,true]);
  assert.equal((x.ok?y:x).text,'Det finns redan en position i BTC — stäng den först');
  const a=saved(storage);
  assert.equal(a.positions.length,1);assert.equal(a.log.filter(e=>e.kind==='öppnad').length,1);
});

test('a manual position is guarded like any other: funding, liquidation, and its stop and target, live and replayed',async()=>{
  const h=harness({time:after(Q)}),r=h.runner;
  await r.tick();
  const q=await quoteAt(h.rt,'BTC');
  const res=await r.order({symbol:'BTC',side:'long',margin:20,leverage:10,sl:q.price*.99,tp:q.price*1.01});
  const p=res.position;
  // Across a funding time: charged on the mark at that candle's open.
  const F=(Math.floor(h.rt.at/FUND)+1)*FUND;
  h.rt.at=F+2*SEC;await r.tick();
  let a=saved(h.storage);
  near(a.positions[0].funding,p.units*m.sub((F-START)/STEP).o*SCALE.BTC*FUNDING_RATE);
  // The price falls through the stop: the forming candle's replay books it at the stop, marked manual.
  h.rt.price={BTC:p.sl*.999};h.rt.at+=5*SEC;
  await r.tick();
  a=saved(h.storage);
  assert.deepEqual(a.trades.map(t=>[t.reason,t.origin,t.closedAt]),[['stopp','manual',h.rt.at]]);near(a.trades[0].exit,p.sl*(1-SLIP));
  assert.match(a.log.at(-1).text,/^Stopp: lång BTC −\d+,\d\d \$ \(manuell\)$/);
  // A target reached while the page slept is found in the replay.
  delete h.rt.price;
  const q2=await quoteAt(h.rt,'BTC'),res2=await r.order({symbol:'BTC',side:'short',margin:20,leverage:10,tp:q2.price*.995});
  assert.equal(res2.ok,true,res2.text);
  const S=(Math.floor(h.rt.at/STEP)+2)*STEP;
  h.rt.shocks=[{symbol:'BTC',at:S,factor:.99}];h.rt.at=S+STEP+2*SEC;
  await r.tick();
  a=saved(h.storage);
  const t=a.trades.at(-1);
  assert.deepEqual([t.reason,t.side,t.origin,t.closedAt],['mål','short','manual',S]);near(t.exit,res2.position.tp*(1+SLIP));
});

// A manual BTC long at 10× opened in the quiet range, its stop 1 % below the price; the page then ticks once.
async function manualLong(over={}){
  const h=harness({time:after(Q),...over});
  await h.runner.tick();
  const q=await quoteAt(h.rt,'BTC'),res=await h.runner.order({symbol:'BTC',side:'long',margin:20,leverage:10,sl:q.price*.99});
  assert.equal(res.ok,true,res.text);
  h.rt.at+=5*SEC;await h.runner.tick();
  return {...h,p:res.position,price:q.price};
}

test('setLevels(): the position is settled with its old levels up to now, then the new ones apply from now on, written before the answer',async()=>{
  const h=await manualLong(),{p}=h;
  h.rt.at+=3*MIN;h.rt.urls=[];
  const q=await quoteAt(h.rt,'BTC'),sl=q.price*.995,tp=q.price*1.02;
  const res=await h.runner.setLevels(p.id,{sl,tp});
  const a=saved(h.storage),pos=a.positions[0],want=previewLevels(a,p.id,{sl,tp},{quote:q,contract:limitsFor('BTC',h.rt.at),now:h.rt.at});
  assert.deepEqual([res.ok,res.trade,pos.sl,pos.tp,pos.levelsAt,pos.fundingThrough],[true,null,want.sl,want.tp,h.rt.at,h.rt.at]);
  assert.deepEqual(res.position,pos);
  assert.equal(res.text,'Nya nivåer för lång BTC: SL '+svPrice(want.sl)+', TP '+svPrice(want.tp));
  assert.deepEqual(a.log.at(-1),{t:h.rt.at,kind:'ändrad',symbol:'BTC',signalId:null,text:'Nya nivåer för lång BTC: SL '+svPrice(want.sl)+', TP '+svPrice(want.tp)+' (manuell)'});
  // The settlement read the position's history, its minutes and a fresh price; the tick size came from Bybit's limits.
  assert.deepEqual(urlKinds(h.rt.urls),['funding/history','instruments-info','kline:1','kline:5','mark-price-kline:1','mark-price-kline:5','tickers']);
  // Removing a level needs no limits; unchanged levels change nothing.
  h.rt.at+=10*SEC;
  assert.deepEqual([(await h.runner.setLevels(p.id,{tp:null})).text,saved(h.storage).positions[0].tp],['Nya nivåer för lång BTC: SL '+svPrice(want.sl)+', ingen TP',null]);
  h.rt.at+=10*SEC;
  const same=await h.runner.setLevels(p.id,{sl:want.sl});
  assert.deepEqual([same.ok,same.text],[true,'SL och TP är oförändrade']);
  // Persisted: a reload shows them, and the next tick keeps them.
  h.rt.at+=5*SEC;await h.runner.tick();
  assert.deepEqual([h.tab().account().positions[0].sl,h.tab().account().positions[0].tp],[want.sl,null]);
});

test('right after an order its SL can be previewed and set, though Bybit stamps every price a moment before the page writes the order',async()=>{
  // Bybit's clock 0,4 s behind the page's: the ticker an order fills at, and every ticker read just after, is stamped before
  // the position's opening.
  const h=harness({time:after(Q),runtime:{server:after(Q)-400}}),r=h.runner;
  await r.tick();
  const res=await r.order({symbol:'BTC',side:'long',margin:20,leverage:10});
  assert.equal(res.ok,true,res.text);
  const p=res.position,q=r.quotes().BTC;
  assert.ok(q.at<p.openedAt,'the price the order filled at is older than its position');
  // The chart's drag and the terminal preview on that price at once.
  const ql=r.quoteLevels(p.id,{sl:q.price*.99});
  assert.deepEqual([ql.ok,ql.reasons],[true,[]]);
  // The change itself reads a new price, stamped the same way, and goes through.
  const set=await r.setLevels(p.id,{sl:q.price*.99});
  assert.equal(set.ok,true,set.text);
  assert.equal(saved(h.storage).positions[0].sl,ql.sl);
});

test('setLevels() never rejects: on a refused level, missing history or price, or a signed-out user, the old levels stay and the reason is given',async()=>{
  const h=await manualLong(),{p}=h,sl=()=>saved(h.storage).positions[0].sl;
  const no=(text,more={})=>({ok:false,text,position:null,trade:null,...more});
  h.who.user=null;
  assert.deepEqual(await h.runner.setLevels(p.id,{sl:1}),no('Logga in för att ändra SL och TP'));
  h.who.user='u1';
  for(const [levels,text] of [[{},'Ange SL eller TP'],[null,'Ange SL eller TP'],[{sl:1,stop:2},'Ange SL eller TP'],[{sl:-1},'Ange SL som ett pris över 0'],[{tp:'x'},'Ange TP som ett pris över 0']])
    assert.deepEqual(await h.runner.setLevels(p.id,levels),no(text),JSON.stringify(levels));
  assert.deepEqual(await h.runner.setLevels('m|okänd',{sl:1}),no('Positionen är redan stängd'));
  // A level Bybit would refuse: refused; the settlement up to now is kept, the old level too.
  h.rt.at+=MIN;
  const q=await quoteAt(h.rt,'BTC'),bad=await h.runner.setLevels(p.id,{sl:q.price*1.001});
  assert.equal(bad.ok,false);assert.match(bad.text,/^SL för en lång position måste ligga under priset \([\d\u00a0,]+\) och över likvidationen \([\d\u00a0,]+\)$/);
  assert.deepEqual([sl(),saved(h.storage).positions[0].fundingThrough,bad.position.sl],[p.sl,h.rt.at,p.sl]);
  // The history cannot be read: nothing changes.
  h.rt.at+=MIN;h.rt.fail=u=>u.pathname.endsWith('/mark-price-kline')?'Nätverksfel':null;
  const before=h.storage.getItem(accountKey('u1'));
  assert.deepEqual(await h.runner.setLevels(p.id,{sl:q.price*.98}),no('Kunde inte ändra SL och TP för BTC: Nätverksfel'));
  assert.equal(h.storage.getItem(accountKey('u1')),before);
  // Bybit's limits cannot be read (its risk tiers fail): a new price level waits for them; removing a level does not.
  h.rt.fail=u=>u.pathname.endsWith('/risk-limit')?'Nätverksfel':null;h.rt.at+=11*MIN;
  assert.deepEqual(await h.runner.setLevels(p.id,{sl:q.price*.98}),no('Bybits prissteg för BTC saknas just nu — försök igen om en stund'));
  const removed=await h.runner.setLevels(p.id,{sl:null});assert.equal(removed.ok,true,removed.text);assert.equal(sl(),null);
  // Bybit's newest candle stays missing: three reads, then a clear failure.
  h.rt.fail=null;h.rt.at=(Math.floor(h.rt.at/STEP)+1)*STEP+SEC;h.rt.lag=20*SEC;h.rt.urls=[];
  assert.deepEqual(await h.runner.setLevels(p.id,{sl:q.price*.98}),no('Kunde inte ändra SL och TP för BTC: Bybits senaste 5-minuterspriser saknas ännu, försök igen om en stund'));
  assert.equal(h.rt.urls.filter(u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('interval')==='5').length,3);
  assert.equal(sl(),null);
});

test('a change of levels or a close in the moment after a 5-minute mark waits for Bybit to publish the new candle, then goes through',async()=>{
  const fives=rt=>rt.urls.filter(u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('interval')==='5').length;
  // 0,3 s after the next 5-minute mark Bybit has not published the new step's candle yet.
  const mark=h=>{h.rt.at=(Math.floor(h.rt.at/STEP)+1)*STEP+300;h.rt.lag=20*SEC;h.rt.urls=[];};
  // It does a moment later: this timer fires only once the runner yields to the event loop, which reads made one after
  // another never do, so only a runner that waits sees the candle.
  const publish=h=>setTimeout(()=>{h.rt.lag=0;},0);
  const h=await manualLong(),tab=h.tab({timeouts:{soon:20}});
  mark(h);
  const q=await quoteAt(h.rt,'BTC');
  publish(h);
  const set=await tab.setLevels(h.p.id,{sl:q.price*.98});
  assert.equal(set.ok,true,set.text);
  assert.equal(fives(h.rt),2,'read again once Bybit had published it');
  assert.deepEqual([saved(h.storage).positions[0].sl,saved(h.storage).positions[0].levelsAt],[set.position.sl,h.rt.at]);
  const c=await manualLong(),other=c.tab({timeouts:{soon:20}});
  mark(c);publish(c);
  const closed=await other.closePosition(c.p.id);
  assert.equal(closed.ok,true,closed.text);
  assert.deepEqual([closed.trade.reason,closed.trade.closedAt,saved(c.storage).positions.length,fives(c.rt)],['manuell',c.rt.at,0,2]);
});

test('setLevels(): an old stop reached before the change is booked and the change is refused; after a change only the new level counts',async()=>{
  // The page sleeps after 10:00; at the step after it BTC gaps below the old stop and stays there.
  const h=await manualLong(),{p}=h,S=(Math.floor(h.rt.at/STEP)+2)*STEP,factor=p.sl/(m.sub((S-START)/STEP).o*SCALE.BTC)*.998;
  h.rt.shocks=[{symbol:'BTC',at:S,factor}];h.rt.at=S+2*MIN;
  const late=await h.runner.setLevels(p.id,{sl:p.sl*.98});
  const a=saved(h.storage),t=a.trades[0];
  assert.deepEqual([t.reason,t.closedAt,t.origin],['stopp',S,'manual']);near(t.exit,m.sub((S-START)/STEP).o*factor*SCALE.BTC*(1-SLIP));
  assert.deepEqual([late.ok,late.trade,late.position],[false,t,null]);
  assert.equal(late.text,'Stopp hann före ändringen: lång BTC (manuell) '+(t.pnl<0?'−':'+')+money2(Math.abs(t.pnl))+' $');
  // Another position: a dip between the old and the new stop before the change does not count; one after the change does.
  const g=await manualLong(),{p:q}=g,D=(Math.floor(g.rt.at/STEP)+2)*STEP,open=t=>m.sub((t-START)/STEP).o*SCALE.BTC;
  const newSl=Number((q.sl*1.005).toFixed(1)),dip=(q.sl+newSl)/2;
  g.rt.shocks=[{symbol:'BTC',at:D,factor:dip/open(D)},{symbol:'BTC',at:D+STEP,factor:open(D)/dip}];
  g.rt.at=D+STEP+2*MIN;
  const moved=await g.runner.setLevels(q.id,{sl:newSl});
  assert.equal(moved.ok,true,moved.text);assert.deepEqual([moved.position.sl,moved.position.levelsAt],[newSl,g.rt.at]);
  assert.deepEqual(saved(g.storage).trades,[]);
  // Later the price gaps to between the two stops again, at a step after the change: the new stop is booked there.
  const E=(Math.floor(g.rt.at/STEP)+2)*STEP;
  g.rt.shocks=[...g.rt.shocks,{symbol:'BTC',at:E,factor:dip/open(E)}];g.rt.at=E+STEP+2*SEC;
  await g.runner.tick();
  const done=saved(g.storage).trades;
  assert.deepEqual(done.map(x=>[x.reason,x.closedAt]),[['stopp',E]]);near(done[0].exit,dip*(1-SLIP));
  assert.ok(done[0].exit>q.sl,'the old stop was never reached');
});

test('setLevels() on a signal position makes it manual: it then outlives its time stop, and two tabs agree on it',async()=>{
  const R=Q,t0=after(R),h=harness({time:t0,runtime:{delay:1}}),quote=await quoteAt(h.rt,'BTC');
  const signal={id:`s|u1|BTC|1h|${m.bar(R).t}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.95,tp:quote.price*1.05,barTime:m.bar(R).t,confirmedAt:m.closeOf(R)};
  const acc=openPosition(newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
  h.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(acc,'BTC',m.bar(R).t)));
  const p=acc.positions[0],other=h.tab();
  h.rt.at+=MIN;
  // One tab changes the target while the other ticks.
  const [res]=await Promise.all([h.runner.setLevels(p.id,{tp:quote.price*1.1}),other.tick()]);
  assert.equal(res.ok,true,res.text);
  // The signal's own stop lies off Bybit's tick and reads as the chart's tag writes it (whole dollars on BTC); the new
  // target lies on the tick.
  assert.equal(res.text,'Nya nivåer för lång BTC: SL '+sv(p.sl,0)+', TP '+svPrice(res.position.tp)+' — signalpositionen hanteras nu manuellt, utan tidsstopp');
  assert.deepEqual([res.position.origin,res.position.deadline,res.position.signalId],['manual',null,p.signalId]);
  // Past the signal's deadline both tabs keep it open.
  h.rt.at=p.deadline+2*HOUR;
  await Promise.all([h.runner.tick(),other.tick()]);
  const a=saved(h.storage);
  assert.deepEqual([a.positions.map(x=>[x.id,x.origin]),a.trades],[[[p.id,'manual']],[]]);
  assert.deepEqual(other.account().positions[0].tp,res.position.tp);
});

test('setAuto() switches signal trading on and off under the lock and never rejects; switched off, waits for entries end',async()=>{
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10,auto:false}}),r=h.runner;
  h.who.user=null;
  assert.deepEqual(await r.setAuto(true),{ok:false,text:'Logga in för att ändra auto-handeln',account:null});
  h.who.user='u1';
  await r.tick();
  assert.deepEqual([(await r.setAuto('ja')).ok,(await r.setAuto('ja')).text],[false,'Ogiltigt läge för auto-handel']);
  const on=await r.setAuto(true);
  assert.deepEqual([on.ok,on.text,on.account.settings.auto,saved(h.storage).settings.auto],[true,'Auto-handel på: nya signaler handlas automatiskt',true,true]);
  // A fresh signal waits for a price; switching auto-trading off ends the wait, and nothing opens later.
  h.rt.at=after(L1.i);h.rt.fail=u=>u.pathname.endsWith('/tickers')?'Nätverksfel':null;
  let st=await r.tick();
  assert.deepEqual(st.waiting,{BTC:'Nätverksfel'});
  const off=await r.setAuto(false);
  assert.deepEqual([off.ok,off.text],[true,'Auto-handel av: du handlar manuellt. Öppna signalpositioner följer sina egna regler tills de stängs.']);
  st=r.status();
  assert.deepEqual([st.state,st.waiting,st.auto],['manual',{},false]);
  h.rt.fail=null;h.rt.at=after(L1.i,20*SEC);st=await r.tick();
  assert.deepEqual([saved(h.storage).positions,st.state],[[],'manual']);
  // Switched on while a candle is read: the candle is read again and its signal traded.
  const p=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10,auto:false}});
  let flipped=null;
  const store=createForecastStore(memoryBackend()),hooked={...store,async putSignal(x){const res=await store.putSignal(x);flipped??=p.runner.setAuto(true);await flipped;return res;}};
  const tab=p.tab({store:hooked});
  await tab.tick();
  p.rt.at=after(L1.i);
  st=await tab.tick();
  assert.deepEqual([saved(p.storage).settings.auto,saved(p.storage).positions,saved(p.storage).processed.BTC],[true,[],m.bar(L1.i-1).t]);
  assert.deepEqual(st.waiting,{BTC:'auto-handeln slogs på under tiden'});
  p.rt.at=after(L1.i,20*SEC);st=await tab.tick();
  assert.deepEqual([saved(p.storage).positions.length,st.waiting,st.state],[1,{},'trading']);
});

test('transfer() and setFree() book deposits and withdrawals under the lock, never reject, and say what happened; a reset archives them',async()=>{
  const storage=memoryStorage(),locks=tabLocks(),write=storage.setItem.bind(storage);
  storage.setItem=(k,v)=>{assert.ok(locks.held.includes(accountKey('u1')),'written outside the lock: '+k);write(k,v);};
  const h=harness({time:after(Q),storage,locks}),r=h.runner,other=h.tab();
  h.who.user=null;
  assert.deepEqual(await r.transfer({kind:'in',amount:5}),{ok:false,text:'Logga in för att ändra saldot',account:null});
  assert.deepEqual(await r.setFree(5),{ok:false,text:'Logga in för att ändra saldot',account:null});
  h.who.user='u1';
  // Two tabs deposit at once: both are booked.
  const [x,y]=await Promise.all([r.transfer({kind:'in',amount:50}),other.transfer({kind:'in',amount:25.5})]);
  assert.deepEqual([x.ok,y.ok],[true,true]);
  assert.deepEqual([x.text,y.text],['Satte in 50,00 $ · tillgängligt 150,00 $','Satte in 25,50 $ · tillgängligt 175,50 $']);
  let a=saved(storage);
  assert.deepEqual([a.cash,a.transfers.map(t=>[t.kind,t.amount,t.cashAfter])],[175.5,[['in',50,150],['in',25.5,175.5]]]);
  const out=await r.transfer({kind:'out',amount:.5});
  assert.deepEqual([out.ok,out.text,out.account.cash],[true,'Tog ut 0,50 $ · tillgängligt 175,00 $',175]);
  for(const [req,text] of [[{kind:'out',amount:500},'Det går bara att ta ut tillgängligt saldo (högst 175,00 $), inte marginalen i öppna positioner'],
    [{kind:'in',amount:0},'Ange ett belopp över 0 $'],[{kind:'gåva',amount:5},'Välj insättning eller uttag'],[null,'Välj insättning eller uttag'],
    [{kind:'in',amount:1.234},'Ange beloppet i hela cent']]){
    const res=await r.transfer(req);
    assert.deepEqual([res.ok,res.text,res.account?.cash],[false,text,175],JSON.stringify(req));
  }
  assert.deepEqual([(await r.setFree(100)).text,(await r.setFree(130)).text],['Tog ut 75,00 $ · tillgängligt 100,00 $','Satte in 30,00 $ · tillgängligt 130,00 $']);
  assert.deepEqual([(await r.setFree(130)).ok,(await r.setFree(130)).text],[false,'Tillgängligt saldo är redan 130,00 $']);
  a=saved(storage);
  assert.deepEqual(a.log.map(e=>e.text),['Insättning 50,00 $','Insättning 25,50 $','Uttag 0,50 $','Uttag 75,00 $','Insättning 30,00 $']);
  // The result since the start leaves them out.
  h.rt.at+=5*SEC;await r.tick();
  assert.deepEqual([r.live().equity,r.live().netTransfers,r.live().result],[130,30,0]);
  // A reset archives the account with its transfers and starts again at 100 $ without any.
  const raw=storage.getItem(accountKey('u1'));
  const fresh=await r.reset();
  assert.equal(storage.getItem(accountKey('u1')+':before-reset:'+h.rt.at),raw);
  assert.equal(JSON.parse(raw).transfers.length,5);
  assert.deepEqual([fresh.cash,fresh.transfers,fresh.settings.auto],[100,[],false]);
});

test('quoteOrder() and quoteLevels() preview on the quote and limits the runner holds; watch() keeps a coin\'s price and limits fresh',async()=>{
  const h=harness({time:after(Q)}),r=h.runner,params={symbol:'ETH',side:'long',margin:10,leverage:20};
  const none=reason=>({ok:false,reasons:[reason],symbol:null,side:null,leverage:null,price:null,mark:null,fill:null,qty:null,value:null,margin:null,fee:null,reserve:null,cost:null,
    liq:null,maxLeverage:null,minMargin:null,maxMargin:null,sl:null,tp:null,riskId:null,maintenance:null,deduction:null,filters:null});
  h.who.user=null;
  assert.deepEqual(r.quoteOrder(params),none('Logga in för att handla'));
  h.who.user='u1';
  assert.deepEqual(r.quoteOrder(params),none('AI Forecast-kontot laddas'));
  await r.tick();
  // Nothing held for ETH yet: the preview says so, and starts reading its limits.
  h.rt.urls=[];
  assert.deepEqual(r.quoteOrder(params).reasons,['Färskt pris saknas för ETH','Bybits gränser för ETH saknas eller är för gamla']);
  for(let k=0;k<20&&!r.limits('ETH');k++)await turn();
  assert.deepEqual(r.limits('ETH'),limitsFor('ETH',h.rt.at));assert.deepEqual(urlKinds(h.rt.urls),['instruments-info','risk-limit']);
  // Watching ETH reads its price now and on every tick.
  h.rt.urls=[];
  assert.equal(r.watch('ETH'),'ETH');
  for(let k=0;k<20&&!r.quotes().ETH;k++)await turn();
  assert.deepEqual(urlKinds(h.rt.urls),['tickers']);
  const q=r.quoteOrder(params),want=previewOrder(r.account(),{...params,quote:r.quotes().ETH,contract:r.limits('ETH'),now:h.rt.at});
  assert.deepEqual(q,want);assert.equal(q.ok,true);
  h.rt.at+=5*SEC;h.rt.urls=[];await r.tick();
  assert.deepEqual(urlKinds(h.rt.urls),['tickers']);assert.equal(r.quotes().ETH.at,h.rt.at);
  // Not watched any more: no reads, and the preview goes stale with the price.
  assert.equal(r.watch(null),null);
  h.rt.at+=20*SEC;h.rt.urls=[];await r.tick();
  assert.deepEqual(h.rt.urls,[]);assert.deepEqual(r.quoteOrder(params).reasons,['Färskt pris saknas för ETH']);
  assert.equal(r.watch('LUNA'),null);
  // quoteLevels on a held position: what setLevels would accept, on the runner's quote.
  r.watch('BTC');await r.tick();
  const res=await r.order({symbol:'BTC',side:'long',margin:20,leverage:10});
  const p=res.position,price=r.quotes().BTC.price;
  const ql=r.quoteLevels(p.id,{sl:price*.99});
  assert.deepEqual(ql,previewLevels(r.account(),p.id,{sl:price*.99},{quote:r.quotes().BTC,contract:r.limits('BTC'),now:h.rt.at}));
  assert.equal(ql.ok,true);assert.ok(ql.slPnl<0);
  assert.deepEqual(r.quoteLevels(p.id,{sl:price*1.01}).ok,false);
  assert.deepEqual(r.quoteLevels('m|okänd',{sl:1}).reasons,['Positionen är redan stängd']);
  h.who.user=null;
  assert.deepEqual(r.quoteLevels(p.id,{sl:1}).reasons,['Logga in för att ändra SL och TP']);
});

test('the ticks keep Bybit\'s limits of every held coin fresh, so after a reload the page has their tick without a preview or a watch',async()=>{
  // An ETH position from an earlier page session: the reloaded page's runner has read nothing of ETH yet.
  const h=harness({time:after(Q)});await h.runner.tick();
  const o=await h.runner.order({symbol:'ETH',side:'long',margin:10,leverage:10});
  assert.equal(o.ok,true,o.text);
  const r=h.tab();h.rt.at+=5*SEC;h.rt.urls=[];
  assert.equal(r.limits('ETH'),null);
  await r.tick();
  for(let k=0;k<20&&!r.limits('ETH');k++)await turn();
  assert.deepEqual(r.limits('ETH'),limitsFor('ETH',h.rt.at));
  assert.ok(['instruments-info','risk-limit'].every(x=>urlKinds(h.rt.urls).includes(x)),urlKinds(h.rt.urls).join(' '));
  // Read again once they have expired; a coin neither held nor watched is never read.
  h.rt.at+=LIMIT_TTL+SEC;
  assert.equal(r.limits('ETH'),null);
  await r.tick();
  for(let k=0;k<20&&!r.limits('ETH');k++)await turn();
  assert.equal(r.limits('ETH')?.at,h.rt.at);
  assert.equal(r.limits('SOL'),null);
  assert.ok(!h.rt.urls.some(u=>/instruments-info|risk-limit/.test(u.pathname)&&u.searchParams.get('symbol')==='SOLUSDT'));
});

test('a version 1 account in storage is read as version 2 and written back so under the lock; it trades on as before',async()=>{
  const h=harness({time:after(L1.i)});
  // The released format: what version 1 stored for a 10× BTC long, written by hand from a version 2 account.
  const quote=await quoteAt(h.rt,'BTC'),t0=h.rt.at,barTime=m.bar(L1.i).t;
  const signal={id:`s|u1|BTC|1h|${barTime}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.9,tp:quote.price*1.2,barTime,confirmedAt:barTime+HOUR};
  const v2=markProcessed(openPosition(plainAccount(t0-HOUR,{symbols:['BTC'],leverage:10}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account,'BTC',m.bar(L1.i).t);
  const {transfers,...rest}=v2,{auto,...settings}=rest.settings;
  const v1={...rest,version:'ai-forecast-account-v1',settings,positions:rest.positions.map(({origin,levelsAt,...p})=>p)};
  assert.equal(validateForecastAccount(v1),v1);
  h.storage.setItem(accountKey('u1'),JSON.stringify(v1));
  // Shown at once, as version 2; written as version 2 by the first tick.
  assert.deepEqual([h.runner.account().version,h.runner.account().settings.auto,h.runner.account().positions[0].origin],['ai-forecast-account-v2',false,'signal']);
  h.rt.at+=5*SEC;
  const st=await h.runner.tick();
  const a=saved(h.storage);
  assert.deepEqual([a.version,a.settings.auto,a.positions.map(p=>[p.origin,p.levelsAt]),a.transfers],['ai-forecast-account-v2',false,[['signal',t0]],[]]);
  assert.equal(a.positions[0].fundingThrough,h.rt.at,'and settled as before');
  assert.deepEqual([st.state,st.text],['manual','Manuell handel · 1 öppen position']);
});

test('status: manual trading counts every open position; with auto-trading on the manual ones are named apart; protection problems show either way',async()=>{
  const h=await manualLong();
  assert.deepEqual([h.runner.status().state,h.runner.status().text,h.runner.status().manual],['manual','Manuell handel · 1 öppen position',1]);
  await h.runner.order({symbol:'ETH',side:'short',margin:10,leverage:10});
  assert.equal(h.runner.status().text,'Manuell handel · 2 öppna positioner');
  // A failing protection check shows in manual mode too.
  h.rt.fail=u=>u.pathname.endsWith('/mark-price-kline')?'Nätverksfel':null;h.rt.at+=5*SEC;
  let st=await h.runner.tick();
  assert.deepEqual([st.state,st.text],['waiting','Väntar på skyddskontroll för BTC: Nätverksfel']);
  h.rt.fail=null;h.rt.at+=5*SEC;await ticks(h.runner,2);
  await h.runner.setAuto(true);
  st=h.runner.status();
  assert.deepEqual([st.state,st.auto,st.open,st.manual],['trading',true,2,2]);
  assert.match(st.text,/^Handlar · 0 av 3 positioner · 2 manuella · nästa beslut \d\d:\d\d$/);
});

// ---- Fixes after the engine review ---------------------------------------------------------------------------------

test('a mark wick through the liquidation in the minute of a change of the stop, while the page was closed, still liquidates; a last price there does not hit the new stop',async()=>{
  for(const [kind,change] of [['mark',false],['mark',true],['last',true]]){
    const h=harness({time:after(Q,5*SEC)});await h.runner.tick();
    const step=Math.floor(h.rt.at/STEP)*STEP,o=await h.runner.order({symbol:'BTC',side:'long',margin:20,leverage:50}),p=o.position;
    assert.equal(o.ok,true,o.text);
    h.rt.at=step+2*MIN+30*SEC;await h.runner.tick();
    const sl=Math.round((await quoteAt(h.rt,'BTC')).price*.996);
    if(change){const lv=await h.runner.setLevels(p.id,{sl});assert.equal(lv.ok,true,lv.text);}
    // At 2:45 the price dips for a few seconds, between two live quotes: on the mark through the liquidation level, or on
    // the last price under the new stop (above the liquidation). Then the page sleeps for a few minutes.
    h.rt.wicks=[{symbol:'BTC',at:step+2*MIN,kind,l:kind==='mark'?p.liq*.999:sl*.999}];
    for(const s of [3*MIN+5*SEC,6*MIN+5*SEC,6*MIN+10*SEC]){h.rt.at=step+s;await h.runner.tick();}
    const a=saved(h.storage),label=kind+' '+change;
    if(kind==='mark')assert.deepEqual(a.trades.map(t=>[t.reason,t.closedAt-step]),[['likvidation',3*MIN]],label);
    else assert.deepEqual([a.positions.map(x=>x.sl),a.trades],[[sl],[]],label);
  }
});

test('after an absence of five months the positions are settled window by window: funding and a stop on day 100 at their candles, then a close works',async()=>{
  // A 1× SOL long without levels and a 1× BTC long (0,001 BTC) with its stop 15 % under the price; then the page stays closed for 150
  // days, and on day 100 BTC drops 20 % at once.
  const h=harness({time:after(Q)}),r=h.runner;await r.tick();
  const sol=(await r.order({symbol:'SOL',side:'long',margin:20,leverage:1})).position;
  const btc=(await r.order({symbol:'BTC',side:'long',margin:70,leverage:1,sl:Math.round((await quoteAt(h.rt,'BTC')).price*.85)})).position;
  const D=Math.floor((btc.openedAt+100*DAY)/STEP)*STEP,cash=saved(h.storage).cash;
  h.rt.shocks=[{symbol:'BTC',at:D,factor:.8}];h.rt.at=sol.openedAt+150*DAY;h.rt.urls=[];
  let st=await r.tick();
  // Each turn reads one window of about 69 days for one position, a bounded number of requests.
  assert.equal(st.state,'waiting');
  assert.match(st.text,/^Väntar på skyddskontroll för (BTC|SOL): lång frånvaro, historiken läses ikapp \(klar t\.o\.m\. \d{1,2} \S+ 20\d\d\)$/);
  assert.ok(h.rt.urls.length<80,String(h.rt.urls.length));
  assert.deepEqual([r.live().equity,r.live().reason.startsWith('Väntar på funding- och likvidationskontroll för')],[null,true]);
  for(let k=0;k<8&&st.state!=='manual';k++){h.rt.at+=5*SEC;st=await r.tick();}
  const a=saved(h.storage),t=a.trades[0],held=a.positions[0];
  assert.deepEqual([st.state,st.protection,a.trades.length,a.positions.map(x=>x.symbol)],['manual','',1,['SOL']]);
  // The stop: at the open of the candle that gapped through it.
  assert.deepEqual([t.symbol,t.reason,t.closedAt],['BTC','stopp',D]);near(t.exit,m.sub((D-START)/STEP).o*.8*SCALE.BTC*(1-SLIP));
  // Every 8-hour funding of the 150 days, on the mark at its candle's open, paid from the free cash.
  let paid=0,n=0;for(let f=Math.ceil(sol.openedAt/FUND)*FUND;f<=held.fundingThrough;f+=FUND){paid+=sol.units*m.sub((f-START)/STEP).o*SCALE.SOL*FUNDING_RATE;n++;}
  assert.ok(n>=449,String(n));near(held.funding,paid);
  near(a.cash,cash+btc.margin+btc.reserve+btc.fees+t.pnl-paid);
  assert.notEqual(r.live().equity,null);
  const closed=await r.closePosition(sol.id);
  assert.equal(closed.ok,true,closed.text);assert.match(closed.text,/^Stängde lång SOL \(manuell\) till /);
  // Closed or changed straight after the absence, without the ticks: every window is settled first.
  for(const act of ['close','levels']){
    const g=harness({time:after(Q)});await g.runner.tick();
    const p=(await g.runner.order({symbol:'SOL',side:'long',margin:20,leverage:1})).position;
    g.rt.at=p.openedAt+150*DAY;
    const res=act==='close'?await g.runner.closePosition(p.id):await g.runner.setLevels(p.id,{tp:Math.round((await quoteAt(g.rt,'SOL')).price*1.5)});
    assert.equal(res.ok,true,act+': '+res.text);
    const x=act==='close'?res.trade:saved(g.storage).positions[0];
    let due=0;for(let f=Math.ceil(p.openedAt/FUND)*FUND;f<=g.rt.at;f+=FUND)due+=p.units*m.sub((f-START)/STEP).o*SCALE.SOL*FUNDING_RATE;
    near(x.funding,due);
    if(act==='levels')assert.equal(x.fundingThrough,g.rt.at);
  }
});

test('Bybit\'s limits that would expire while an order or a change of levels is on its way are read again first, so neither is refused for them',async()=>{
  const h=harness({time:after(Q)}),good=fakeBybit(h.rt);let slow=false;
  // The price read takes 3 seconds.
  const r=h.tab({grab:async(u,o)=>{const res=await good(u,o);if(slow&&u.includes('/tickers'))h.rt.at+=3*SEC;return res;}});
  await r.tick();
  // A preview loads ETH's limits; 9 minutes 58 seconds later the order comes.
  r.quoteOrder({symbol:'ETH',side:'long',margin:10,leverage:10});
  for(let k=0;k<20&&!r.limits('ETH');k++)await turn();
  h.rt.at=r.limits('ETH').at+LIMIT_TTL-2*SEC;h.rt.urls=[];slow=true;
  const eth=await r.order({symbol:'ETH',side:'long',margin:10,leverage:10});
  assert.equal(eth.ok,true,eth.text);
  assert.deepEqual(urlKinds(h.rt.urls),['instruments-info','risk-limit','tickers']);
  // A change of levels whose history and price reads take 3 seconds, 9 minutes 57 seconds after BTC's limits were read.
  slow=false;h.rt.at=Math.floor(h.rt.at/STEP)*STEP+STEP+150*SEC;
  const btc=await r.order({symbol:'BTC',side:'long',margin:20,leverage:10}),sl=Math.round(btc.position.entry*.99);
  h.rt.at=r.limits('BTC').at+LIMIT_TTL-3*SEC;slow=true;h.rt.urls=[];
  const lv=await r.setLevels(btc.position.id,{sl});
  assert.deepEqual([lv.ok,lv.position?.sl],[true,sl],lv.text);
  assert.equal(h.rt.urls.filter(u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('interval')==='5').length,1);
});

test('previews say why the account cannot be read instead of that it is loading',async()=>{
  const t0=after(Q);
  for(const [raw,text] of [[JSON.stringify({...plainAccount(t0-HOUR),version:'ai-forecast-account-v3'}),'AI Forecast-kontot har en annan version (ai-forecast-account-v3). Ladda om sidan.'],
    ['{trasig','AI Forecast-kontot kan inte läsas']]){
    const h=harness({time:t0});h.storage.setItem(accountKey('u1'),raw);
    const st=await h.runner.tick();
    assert.deepEqual([st.state,st.text],['error',text]);
    assert.deepEqual(h.runner.quoteOrder({symbol:'BTC',side:'long',margin:10,leverage:10}).reasons,[text]);
    assert.deepEqual(h.runner.quoteLevels('m|BTC|1',{sl:1}).reasons,[text]);
  }
  // Signed in, nothing stored yet and nothing failed: it is loading.
  assert.deepEqual(harness({time:t0}).runner.quoteOrder({symbol:'BTC',side:'long',margin:10,leverage:10}).reasons,['AI Forecast-kontot laddas']);
});

test('a change of levels overtaken by the old stop says so, also when a tick booked the stop just before',async()=>{
  for(const tickFirst of [true,false]){
    const h=await manualLong(),{p}=h;
    h.rt.price={BTC:p.sl*.998};h.rt.at+=5*SEC;
    if(tickFirst){await h.runner.tick();assert.deepEqual(saved(h.storage).trades.map(t=>t.reason),['stopp']);h.rt.at+=SEC;}
    const res=await h.runner.setLevels(p.id,{sl:Math.round(p.sl*.99)}),t=saved(h.storage).trades[0];
    assert.deepEqual([res.ok,res.text,res.trade],[false,'Stopp hann före ändringen: lång BTC (manuell) '+(t.pnl<0?'−':'+')+money2(Math.abs(t.pnl))+' $',t],String(tickFirst));
  }
  // One the user closed, or one that was never there, is closed.
  const h=await manualLong(),c=await h.runner.closePosition(h.p.id);
  assert.equal(c.ok,true,c.text);
  assert.deepEqual(await h.runner.setLevels(h.p.id,{sl:1}),{ok:false,text:'Positionen är redan stängd',position:null,trade:c.trade});
  assert.deepEqual(await h.runner.setLevels('m|BTC|okänd',{sl:1}),{ok:false,text:'Positionen är redan stängd',position:null,trade:null});
});

test('auto-trading off: a fresh signal whose record could not be stored is stored on a later try, with no wait for a trade',async()=>{
  const base=createForecastStore(memoryBackend());let failures=0;
  const store={...base,async putSignal(x){if(x.symbol==='BTC'&&failures<1){failures++;throw Error('IndexedDB tillfälligt fel');}return base.putSignal(x);}};
  const h=harness({time:after(L1.i-1),store});
  await h.runner.tick();
  h.rt.at=after(L1.i);
  let st=await h.runner.tick();
  // BTC's candle stays open for its record; the other coins' are decided. Manual trading has nothing to wait for.
  assert.deepEqual([st.state,st.text,st.waiting,saved(h.storage).processed.BTC,saved(h.storage).processed.ETH],
    ['manual','Manuell handel · 0 öppna positioner',{},m.bar(L1.i-1).t,L1.t]);
  assert.deepEqual(await signalsOf(base,'BTC'),[]);
  h.rt.at=after(L1.i,20*SEC);st=await h.runner.tick();
  assert.deepEqual((await signalsOf(base,'BTC')).map(r=>[r.barTime,r.origin]),[[L1.t,'live']]);
  assert.deepEqual([st.state,st.waiting,saved(h.storage).processed.BTC,saved(h.storage).positions],['manual',{},L1.t,[]]);
  // A full archive is not retried: the candle is decided at once.
  const full=createForecastStore(localStorageBackend(memoryStorage(),undefined,{maxChars:10})),g=harness({time:after(L1.i-1),store:full});
  await g.runner.tick();g.rt.at=after(L1.i);await g.runner.tick();
  assert.equal(saved(g.storage).processed.BTC,L1.t);
});

test('order() and setLevels() carry out what was asked when they were called, whatever the caller does with its object meanwhile',async()=>{
  const h=harness({time:after(Q)});await h.runner.tick();
  const form={symbol:'BTC',side:'long',margin:10,leverage:10},pending=h.runner.order(form);
  // The ticket keeps changing while the order is on its way.
  Object.assign(form,{side:'short',margin:60,leverage:50,symbol:'ETH'});
  const res=await pending,p=res.position;
  assert.deepEqual([res.ok,p?.symbol,p?.side,p?.leverage],[true,'BTC','long',10],res.text);assert.ok(p.margin<=10);
  h.rt.at+=5*SEC;await h.runner.tick();
  const levels={sl:Math.round(p.entry*.99)},set=h.runner.setLevels(p.id,levels);
  levels.sl=1;levels.tp=2;
  const done=await set;
  assert.deepEqual([done.ok,done.position?.sl,done.position?.tp],[true,Math.round(p.entry*.99),null],done.text);
});

test('the runner\'s order and level texts give prices with the decimals of Bybit\'s tick, also from 100 000 $ on',async()=>{
  const h=harness({time:after(Q),runtime:{price:{BTC:123456.7}}}),r=h.runner;
  await r.tick();
  const res=await r.order({symbol:'BTC',side:'long',margin:20,leverage:10,sl:120000.1,tp:130000.3});
  assert.equal(res.text,'Köpte 0,001 BTC till '+sv(123518.4,1)+' · 10× · marginal '+money2(res.position.margin)+' $ · SL '+sv(120000.1,1)+' · TP '+sv(130000.3,1));
  h.rt.at+=5*SEC;await r.tick();h.rt.at+=10*SEC;
  assert.equal((await r.setLevels(res.position.id,{sl:119999.9})).text,'Nya nivåer för lång BTC: SL '+sv(119999.9,1)+', TP '+sv(130000.3,1));
});

test('the runner writes a fill and an exit with all of Bybit\'s tick decimals, as Positioner and Historik do, and a stop or a target as the chart\'s tag does',async()=>{
  const fx=(x,d)=>x.toLocaleString('sv-SE',{minimumFractionDigits:d,maximumFractionDigits:d}),pnl=x=>(x<0?'−':'+')+money2(Math.abs(x))+' $';
  // BTC at 60 000 $ fills a buy at 60 030,0; Stäng's answer has the exit's tenth, also from 100 000 $ on.
  const h=harness({time:after(Q),runtime:{price:{BTC:60000,SOL:120,PEPE:.0000043512}}}),r=h.runner;
  await r.tick();
  const btc=await r.order({symbol:'BTC',side:'long',margin:20,leverage:10,sl:59000});
  assert.equal(btc.text,'Köpte 0,003 BTC till '+fx(60030,1)+' · 10× · marginal '+money2(btc.position.margin)+' $ · SL '+fx(59000,0));
  h.rt.price={...h.rt.price,BTC:123456.7};h.rt.at+=5*SEC;await r.tick();
  const closed=await r.closePosition(btc.position.id);
  assert.equal(closed.ok,true,closed.text);
  assert.equal(closed.text,'Stängde lång BTC (manuell) till '+fx(closed.trade.exit,1)+' · '+pnl(closed.trade.pnl));
  assert.equal(fx(closed.trade.exit,1),fx(123456.7*(1-SLIP),1));
  // SOL's target at 120,8 reads 120,80 (a tick of 0,01 $), as the chart's tag writes it.
  const sol=await r.order({symbol:'SOL',side:'long',margin:10,leverage:10});
  assert.equal(sol.ok,true,sol.text);h.rt.at+=5*SEC;await r.tick();
  assert.equal((await r.setLevels(sol.position.id,{tp:120.8})).text,'Nya nivåer för lång SOL: ingen SL, TP 120,80');
  // PEPE: nine decimals per token, in the order's answer and in Stäng's.
  const pepe=await r.order({symbol:'PEPE',side:'short',margin:10,leverage:10});
  assert.equal(pepe.ok,true,pepe.text);
  assert.match(pepe.text,new RegExp('^Sålde [\\d\\s]+ PEPE till '+fx(.0000043512*(1-SLIP),9)+' · 10× · '));
  h.rt.at+=5*SEC;await r.tick();
  const out=await r.closePosition(pepe.position.id);
  assert.equal(out.text,'Stängde kort PEPE (manuell) till '+fx(out.trade.exit,9)+' · '+pnl(out.trade.pnl));
});

test('auto-trading switched off in another tab while a candle is decided: the held signal position is not closed on the signal and nothing opens',async()=>{
  for(const flip of [true,false]){
    const t0=flip?after(S1.i-3):after(L1.i-1),decided=flip?after(S1.i):after(L1.i),h=harness({time:t0});
    if(flip){
      const barTime=m.bar(S1.i-3).t,quote=await quoteAt(h.rt,'BTC');
      const signal={id:`s|u1|BTC|1h|${barTime}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.9,tp:quote.price*1.2,barTime,confirmedAt:barTime+HOUR};
      const acc=openPosition(newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true}).account;
      h.storage.setItem(accountKey('u1'),JSON.stringify(markProcessed(acc,'BTC',barTime)));
    }else h.storage.setItem(accountKey('u1'),JSON.stringify(newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10})));
    // The other tab switches auto-trading off while this one reads the hourly candles.
    const other=h.tab(),good=fakeBybit(h.rt);let off=null;
    const r=h.tab({grab:async(u,o)=>{const res=await good(u,o);if(u.includes('interval=60')&&h.rt.at>=decided){off??=other.setAuto(false);await off;}return res;}});
    if(!flip)await r.tick();
    h.rt.at=decided;
    const st=await r.tick(),a=saved(h.storage);
    assert.deepEqual([a.settings.auto,a.positions.map(p=>[p.side,p.origin]),a.trades],[false,flip?[['long','signal']]:[],[]],String(flip));
    assert.deepEqual([st.last.side,st.last.opened,st.last.closed,st.last.reason],[flip?'short':'long',null,null,'Auto-handel av — signalen handlas inte'],String(flip));
  }
});

test('auto-trading on: manual positions take no signal slot, so a fresh signal opens while they fill max open positions',async()=>{
  const h=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10,maxOpen:1}}),r=h.runner;
  await r.tick();
  assert.equal((await r.order({symbol:'ETH',side:'short',margin:10,leverage:10})).ok,true);
  h.rt.at=after(L1.i);
  const st=await r.tick(),a=saved(h.storage);
  assert.deepEqual(a.positions.map(p=>[p.symbol,p.origin]),[['ETH','manual'],['BTC','signal']]);
  assert.deepEqual([st.state,st.waiting],['trading',{}]);assert.match(st.text,/^Handlar · 1 av 1 positioner · 1 manuell · nästa beslut /);
  // Bybit's limits pass their 10 minutes between loading and the decision: the signal waits for new ones, unrefused, as it
  // does with free slots.
  const c=harness({time:after(L1.i-1),settings:{symbols:['BTC'],leverage:10,maxOpen:1}});
  let loads=0;
  const aging={get:()=>null,async load(s){if(s!=='BTC')return limitsFor(s,c.rt.at);loads++;return limitsFor(s,loads===1?c.rt.at-LIMIT_TTL+SEC:c.rt.at);}};
  const ticking=fakeBybit(c.rt),late=c.tab({contracts:aging,grab:async(u,o)=>{const res=await ticking(u,o);if(loads===1&&u.includes('/tickers')&&u.includes('BTCUSDT'))c.rt.at+=2*SEC;return res;}});
  await late.tick();
  assert.equal((await late.order({symbol:'ETH',side:'short',margin:10,leverage:10})).ok,true);
  c.rt.at=after(L1.i);
  const waits=await late.tick();
  assert.deepEqual([saved(c.storage).positions.map(p=>p.symbol),saved(c.storage).log.filter(e=>e.kind==='avvisad'),waits.waiting],[['ETH'],[],{BTC:'Bybits hävstångsgräns saknas för BTC'}]);
  c.rt.at+=RUNNER.retry;await late.tick();
  assert.deepEqual([saved(c.storage).positions.map(p=>[p.symbol,p.origin]),loads],[[['ETH','manual'],['BTC','signal']],2]);
});

test('a failing price read for the watched coin that is not held is no protection problem: the preview says the price is missing',async()=>{
  const h=harness({time:after(Q)}),r=h.runner;
  await r.tick();
  assert.equal((await r.order({symbol:'BTC',side:'long',margin:20,leverage:10})).ok,true);
  r.watch('ETH');
  h.rt.fail=u=>u.pathname.endsWith('/tickers')&&u.searchParams.get('symbol')==='ETHUSDT'?'Nätverksfel':null;
  h.rt.at+=20*SEC;
  const st=await r.tick();
  assert.deepEqual([st.state,st.protection,st.text],['manual','','Manuell handel · 1 öppen position']);
  assert.equal(r.quoteOrder({symbol:'ETH',side:'long',margin:10,leverage:10}).reasons[0],'Färskt pris saknas för ETH');
  // The held coin's failing price read is one.
  h.rt.fail=u=>u.pathname.endsWith('/tickers')&&u.searchParams.get('symbol')==='BTCUSDT'?'Nätverksfel':null;h.rt.at+=5*SEC;
  assert.match((await r.tick()).protection,/^pris för BTC: Nätverksfel/);
});

test('an opposite signal does not close a signal position at market while a long absence is still being settled, and does once it is',async()=>{
  // A market with 152 quiet days before its legs. A long signal position opened on day 1, whose holding time has not run
  // out by the short signal on day 162 (a stored position may say so), and the page closed all that time.
  const M=scriptMarket({start:START-152*DAY,quiet:152*24}),[S]=M.shorts,i0=24,t0=M.closeOf(i0)+2*SEC;
  const h=harness({time:t0,runtime:{market:M}}),quote=await quoteAt(h.rt,'BTC'),barTime=M.bar(i0).t;
  const signal={id:`s|u1|BTC|1h|${barTime}|${MODEL.signal}`,symbol:'BTC',tf:'1h',side:'long',entry:quote.price,sl:quote.price*.5,tp:quote.price*10,barTime,confirmedAt:barTime+HOUR};
  const opened=openPosition(newForecastAccount(t0-HOUR,{symbols:['BTC'],leverage:10,positionPct:.2,riskPct:1}),{signal,symbol:'BTC',quote,contract:limitsFor('BTC',t0),now:t0,tfMs:HOUR,dataReliable:true});
  const stored=markProcessed(opened.account,'BTC',M.bar(S.i-1).t);stored.positions[0].deadline=M.closeOf(S.i)+30*DAY;
  h.storage.setItem(accountKey('u1'),JSON.stringify(validateForecastAccount(stored)));
  // The first tick settles one window of the absence; the signal finds the next one unsettled and waits.
  h.rt.at=M.closeOf(S.i)+2*SEC;
  let st=await h.runner.tick(),a=saved(h.storage);
  assert.deepEqual([a.trades,a.positions.length,st.waiting],[[],1,{BTC:'historiken för BTC läses ikapp efter en lång frånvaro'}]);
  // Caught up a few ticks later, the signal closes it at market, with the funding of all 161 days paid.
  for(let k=0;k<12&&!saved(h.storage).trades.length;k++){h.rt.at+=5*SEC;st=await h.runner.tick();}
  a=saved(h.storage);
  const t=a.trades[0],p=opened.position;
  assert.deepEqual([t.reason,t.closedAt],['signal',h.rt.at]);
  let due=0;for(let f=Math.ceil(p.openedAt/FUND)*FUND;f<=t.closedAt;f+=FUND)due+=p.units*M.sub((f-M.start)/STEP).o*SCALE.BTC*FUNDING_RATE;
  near(t.funding,due);assert.ok(due>0);
});

test('a change of levels whose Bybit limits age past their 10 minutes on the way reads them again instead of refusing the level',async()=>{
  const h=harness({time:after(Q)});let loads=0,jumps=0;
  // The shared cache hands out limits read 7 1/2 minutes earlier the first time, fresh ones after.
  const aging={get:()=>null,async load(s){loads++;return limitsFor(s,loads===1?h.rt.at-7.5*MIN:h.rt.at);}};
  const good=fakeBybit(h.rt),r=h.tab({contracts:aging,grab:async(u,o)=>{const res=await good(u,o);if(jumps&&u.includes('/funding/history')){jumps--;h.rt.at+=100*SEC;}return res;}});
  await r.tick();
  h.rt.at=Math.floor(h.rt.at/STEP)*STEP+STEP+3*MIN+55*SEC;
  const o=await r.order({symbol:'BTC',side:'long',margin:20,leverage:10});
  assert.deepEqual([o.ok,loads],[true,1],o.text);
  // Five seconds later the stop is set. Its history read takes 100 s and a 5-minute step begins meanwhile, so it is read
  // again, another 100 s: at the write the limits are almost 11 minutes old.
  h.rt.at+=5*SEC;jumps=2;h.rt.urls=[];
  const sl=Math.round(o.position.entry*.99),lv=await r.setLevels(o.position.id,{sl});
  assert.deepEqual([lv.ok,lv.position?.sl,loads],[true,sl,2],lv.text);
  assert.equal(h.rt.urls.filter(u=>u.pathname.endsWith('/mark-price-kline')&&u.searchParams.get('interval')==='5').length,3);
});

test('after a change of levels a mark minute Bybit has not published yet is waited for quietly, like any newest minute',async()=>{
  const h=await manualLong(),{p}=h;
  // In a later step the stop moves up at 1:50; at 2:05 Bybit's 1:00 minute is late and the 2:00 minute is not out yet.
  const S=Math.floor(h.rt.at/STEP)*STEP+STEP;h.rt.at=S+MIN+50*SEC;
  await h.runner.tick();
  const lv=await h.runner.setLevels(p.id,{sl:Math.round(p.sl*1.002)});
  assert.equal(lv.ok,true,lv.text);
  h.rt.holes=new Set([`BTC:1:${S+MIN}`,`BTC:1:${S+2*MIN}`]);h.rt.at=S+2*MIN+5*SEC;
  let st=await h.runner.tick();
  assert.deepEqual([st.state,st.protection,saved(h.storage).positions[0].fundingThrough],['manual','',lv.position.fundingThrough]);
  h.rt.holes=null;h.rt.at+=5*SEC;st=await h.runner.tick();
  assert.deepEqual([st.state,st.protection,saved(h.storage).positions[0].fundingThrough],['manual','',h.rt.at]);
});
