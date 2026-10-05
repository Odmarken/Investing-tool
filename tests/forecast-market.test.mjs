import test from 'node:test';
import assert from 'node:assert/strict';
import {POLL_MS,STALE,MAX_SKEW,parseKlines,fetchKlines,fetchHistory,splitForming,findGaps,mergeBars,createLiveSeries,dataStatus,fetchFunding,fetchPositionRisk} from '../forecast-market.js';
import {createForecastStore,localStorageBackend,forecastRecord,hashOf,verifyRecord} from '../forecast-store.js';
import {CONTRACTS,CONTRACT_UNITS} from '../bybit-contracts.js';
import {fetchDerivatives} from '../crypto-momentum-market.js';
import {TF,CHART_TFS,MODEL} from '../forecast-config.js';

const MIN=60000,STEP=300000,HOUR=3600000,DAY=86400000,FUND=8*HOUR;
const API='https://api.bybit.com/v5/market/';
const NOW=Date.parse('2026-10-04T12:02:30Z'),LISTED=Date.parse('2026-06-01T00:00:00Z');
const BASE=Object.freeze({BTC:60000,ETH:3000,SOL:150,XRP:.6,DOGE:.2,SHIB:.000012,PEPE:.00001});
const INTERVAL=Object.freeze({'1':MIN,'5':STEP,'15':15*MIN,'60':HOUR,'240':4*HOUR,'D':DAY});
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps*Math.abs(b),a+' vs '+b);
const continuous=(bars,ms)=>bars.every((b,i)=>!i||b.t-bars[i-1].t===ms);
const memoryStorage=()=>{const m=new Map();return {get length(){return m.size;},key:i=>[...m.keys()][i]??null,getItem:k=>m.has(k)?m.get(k):null,
  setItem(k,v){m.set(k,String(v));},removeItem(k){m.delete(k);}};};

// Token prices move smoothly with time, so every page of every request is reproducible.
const price=(symbol,t)=>BASE[symbol]*Math.exp(.03*Math.sin(t/9e6)+.01*Math.sin(t/1.3e6));
const rate=t=>Math.round(1e4*Math.sin(t/1e8))/1e8;
// The forming candle closes at the current price; a closed one at the price at its close time.
function candle(symbol,t,ms,now,mark=1){
  const o=price(symbol,t)*mark,c=price(symbol,Math.min(t+ms,now))*mark;
  return {t,o,h:Math.max(o,c)*1.0015,l:Math.min(o,c)*.9985,c,v:1e6+(t/ms%13)*1e4};
}
const requests=[];
/**
 * Bybit V5 public market endpoints: lists newest first, numbers as strings,
 * result.category/symbol and top-level `time`. clock: {now, server?, fail?}.
 * holes: 'interval:t' candles Bybit does not have ('last:interval:t' or 'mark:interval:t' for one price only);
 * overrides: 'interval:t' → changed values.
 */
function exchange(clock,{listed=LISTED,ignoreEnd=false}={}){
  const calls=[],holes=new Set(),overrides=new Map();
  const page=(symbol,interval,limit,end,mark)=>{
    const ms=INTERVAL[interval],now=clock.now,out=[];
    assert.ok(ms,'interval '+interval);
    for(let t=Math.floor(Math.min(now,end??Infinity)/ms)*ms;t>=listed&&out.length<limit;t-=ms){
      if(holes.has(interval+':'+t)||holes.has((mark===1?'last:':'mark:')+interval+':'+t))continue;
      out.push({...candle(symbol,t,ms,now,mark),...overrides.get(interval+':'+t)});
    }
    return out;
  };
  async function grab(url,options){
    const u=new URL(url),q=Object.fromEntries(u.searchParams),path=u.pathname.replace('/v5/market/',''),time=clock.server??clock.now;
    calls.push({url,path,q,options});requests.push({url,q,options});
    if(clock.fail)throw Error(clock.fail);
    const symbol=Object.keys(CONTRACTS).find(s=>CONTRACTS[s]===q.symbol);
    if(!symbol||q.category!=='linear')return {retCode:10001,retMsg:'params error',result:{},retExtInfo:{},time};
    const scale=CONTRACT_UNITS[symbol],px=x=>String(x*scale),limit=q.limit===undefined?200:+q.limit;
    const end=ignoreEnd||q.end===undefined?null:+q.end,ok=result=>({retCode:0,retMsg:'OK',result,retExtInfo:{},time});
    if(path==='kline')return ok({category:'linear',symbol:q.symbol,list:page(symbol,q.interval,limit,end,1).map(b=>[b.t,px(b.o),px(b.h),px(b.l),px(b.c),b.v/b.c,b.v].map(String))});
    if(path==='mark-price-kline')return ok({category:'linear',symbol:q.symbol,list:page(symbol,q.interval,limit,end,.9998).map(b=>[b.t,px(b.o),px(b.h),px(b.l),px(b.c)].map(String))});
    if(path==='tickers')return ok({category:'linear',list:[{symbol:q.symbol,lastPrice:px(price(symbol,clock.now)),markPrice:px(price(symbol,clock.now)*.9998),
      nextFundingTime:String((Math.floor(clock.now/FUND)+1)*FUND)}]});
    if(path==='instruments-info')return ok({category:'linear',list:[{symbol:q.symbol,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',
      quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'100',leverageStep:'0.01'}}]});
    if(path==='funding/history'){
      const endTime=q.endTime===undefined?clock.now:+q.endTime,list=[];
      for(let t=Math.floor(Math.min(endTime,clock.now)/FUND)*FUND;t>=listed&&list.length<limit;t-=FUND)
        list.push({symbol:q.symbol,fundingRate:String(rate(t)),fundingRateTimestamp:String(t)});
      return ok({category:'linear',list});
    }
    throw Error('Unexpected request '+url);
  }
  return {grab,calls,holes,overrides,klines:()=>calls.filter(c=>c.path==='kline')};
}
const row=(t,o,h,l,c,volume=1000,turnover=5e6)=>[t,o,h,l,c,volume,turnover].map(String);
const answer=(list,{symbol='BTCUSDT',time=NOW,category='linear',retCode=0}={})=>({retCode,retMsg:'OK',result:{category,symbol,list},retExtInfo:{},time});

test('parseKlines turns a Bybit page (newest first, strings) into ascending candles with turnover as volume',()=>{
  const t=Math.floor(NOW/HOUR)*HOUR;
  const {bars,serverTime}=parseKlines(answer([row(t,101,103,100,102,7,700),row(t-HOUR,100,101.5,99,101,5,500)]),'BTC','1h',NOW);
  assert.equal(serverTime,NOW);
  assert.deepEqual(bars,[{t:t-HOUR,o:100,h:101.5,l:99,c:101,v:500},{t,o:101,h:103,l:100,c:102,v:700}]);
  // `now` may also be a clock function, and an empty list is a valid answer.
  assert.deepEqual(parseKlines(answer([]),'BTC','1h',()=>NOW),{bars:[],serverTime:NOW});
  assert.deepEqual([POLL_MS,STALE.delayed,STALE.stale,MAX_SKEW],[5000,15000,60000,120000]);
  assert.ok(Object.isFrozen(STALE));
});

test('parseKlines refuses answers that are not fresh linear prices for the coin asked',()=>{
  const good=[row(Math.floor(NOW/HOUR)*HOUR,1,1,1,1)];
  for(const json of [null,{},answer(good,{retCode:10001}),answer(good,{category:'spot'}),answer(good,{symbol:'ETHUSDT'}),
    {...answer(good),time:undefined},{...answer(good),time:String(NOW)},{...answer(good),time:NOW-MAX_SKEW-1},{...answer(good),time:NOW+MAX_SKEW+1},
    {retCode:0,result:{category:'linear',symbol:'BTCUSDT'},time:NOW}])
    assert.throws(()=>parseKlines(json,'BTC','1h',NOW),{message:'Färska priser saknas för BTC'},JSON.stringify(json));
  assert.throws(()=>parseKlines(answer([]),'BTC','2h',NOW),{message:'Okänd tidsram'});
  assert.throws(()=>parseKlines(answer([]),'ADA','1h',NOW),{message:'Okänt perpetualkontrakt'});
});

test('parseKlines rejects malformed, misaligned, impossible or future candles',()=>{
  const t=Math.floor(NOW/HOUR)*HOUR-HOUR;
  for(const r of [row(t,'x',1,1,1),row(t,1,1,1,0),row(t,-1,1,-1,1),row(t,1,.9,.8,1),row(t,1,1.1,1.05,1),row(t,1,1,1.2,1),row(t+MIN,1,1,1,1),
    row(t+2*HOUR,1,1,1,1),row(t,'',1,1,1),row(t,1,1,1,1,-1),row(t,1,1,1,1,1,''),row(t,1,1,1,1,1,'-5'),row(t+.5,1,1,1,1),
    [String(t),'1','1','1','1','1'],'garbage',null])
    assert.throws(()=>parseKlines(answer([r]),'BTC','1h',NOW),{message:'Ogiltig candle för BTC'},JSON.stringify(r));
  assert.throws(()=>parseKlines(answer([row(t,1,1,1,1),row(t,1,1,1,1)]),'BTC','1h',NOW),{message:'Ogiltig candle för BTC'});
});

test('a candle opening a moment after Bybit\'s stamped time is kept out of both closed and forming',()=>{
  const next=Math.floor(NOW/HOUR)*HOUR+HOUR,time=next-500;
  const {bars,serverTime}=parseKlines(answer([row(next,1,1,1,1),row(next-HOUR,1,1,1,1)],{time}),'BTC','1h',time);
  assert.equal(bars.length,2);
  assert.deepEqual(splitForming(bars,'1h',serverTime),{closed:[],forming:bars[0]});
  assert.throws(()=>parseKlines(answer([row(next,1,1,1,1)],{time:next-1001}),'BTC','1h',next-1001),{message:'Ogiltig candle för BTC'});
});

test('SHIB and PEPE contracts quote 1000 tokens: prices are divided back, turnover stays in USDT',()=>{
  const t=Math.floor(NOW/HOUR)*HOUR-HOUR;
  const shib=parseKlines(answer([row(t,'0.0125','0.0127','0.0124','0.0126','1000000','12600')],{symbol:'SHIB1000USDT'}),'SHIB','1h',NOW).bars[0];
  near(shib.o,.0000125);near(shib.h,.0000127);near(shib.l,.0000124);near(shib.c,.0000126);assert.equal(shib.v,12600);
  const pepe=parseKlines(answer([row(t,'0.0098','0.0099','0.0097','0.0098','5','49')],{symbol:'1000PEPEUSDT'}),'PEPE','1h',NOW).bars[0];
  near(pepe.c,.0000098);assert.equal(pepe.v,49);
  const btc=parseKlines(answer([row(t,'0.0125','0.0127','0.0124','0.0126')]),'BTC','1h',NOW).bars[0];
  assert.equal(btc.c,.0126);
  // A spot or wrong-size SHIB answer is refused.
  assert.throws(()=>parseKlines(answer([],{symbol:'SHIBUSDT'}),'SHIB','1h',NOW),{message:'Färska priser saknas för SHIB'});
});

test('candle times must sit on the timeframe grid; weekly candles open on Monday 00:00 UTC',()=>{
  const monday=Date.parse('2026-09-28T00:00:00Z'),thursdayGrid=Math.floor(monday/(7*DAY))*7*DAY;
  assert.equal(new Date(monday).getUTCDay(),1);assert.notEqual(thursdayGrid,monday);
  assert.equal(parseKlines(answer([row(monday,1,1,1,1)]),'BTC','1w',NOW).bars[0].t,monday);
  assert.throws(()=>parseKlines(answer([row(thursdayGrid,1,1,1,1)]),'BTC','1w',NOW),{message:'Ogiltig candle för BTC'});
  for(const tf of CHART_TFS){
    const ms=TF[tf].ms,t=Math.floor((NOW-2*ms)/ms)*ms;
    assert.equal(parseKlines(answer([row(t,1,1,1,1)]),'BTC',tf,NOW).bars[0].t,t);
    assert.throws(()=>parseKlines(answer([row(t+MIN,1,1,1,1)]),'BTC',tf,NOW),{message:'Ogiltig candle för BTC'},tf);
  }
});

test('fetchKlines asks for the linear perpetual through grab, with limit and end',async()=>{
  const clock={now:NOW},ex=exchange(clock);
  const {bars,serverTime}=await fetchKlines(ex.grab,'SHIB','15m',{limit:5,end:NOW-HOUR,now:()=>clock.now});
  assert.deepEqual(ex.calls.map(c=>c.q),[{category:'linear',symbol:'SHIB1000USDT',interval:'15',limit:'5',end:String(NOW-HOUR)}]);
  assert.deepEqual(ex.calls[0].options,{json:true,timeout:8000});
  assert.equal(bars.length,5);assert.equal(serverTime,NOW);assert.ok(continuous(bars,15*MIN));
  assert.equal(bars.at(-1).t,Math.floor((NOW-HOUR)/(15*MIN))*15*MIN);
  near(bars.at(-1).o,price('SHIB',bars.at(-1).t));assert.ok(bars.every(b=>b.c<.001),'SHIB prices are per token');
  for(const limit of [0,1001,2.5])await assert.rejects(fetchKlines(ex.grab,'BTC','1h',{limit,now:NOW}),{message:'Ogiltig candlebegäran'});
  await assert.rejects(fetchKlines(ex.grab,'BTC','1h',{end:'x',now:NOW}),{message:'Ogiltig candlebegäran'});
  await assert.rejects(fetchKlines(ex.grab,'DOT','1h',{now:NOW}),{message:'Okänt perpetualkontrakt'});
  assert.equal(ex.calls.length,1);
});

test('fetchHistory pages backwards with end = oldest − 1 and includes the forming candle',async()=>{
  const clock={now:NOW},ex=exchange(clock);
  const {bars,serverTime}=await fetchHistory(ex.grab,'BTC','5m',{count:2300,now:()=>clock.now});
  const k=ex.klines();
  assert.deepEqual(k.map(c=>[c.q.limit,c.q.end]),[['1000',undefined],['1000',String(bars[1300].t-1)],['300',String(bars[300].t-1)]]);
  assert.equal(bars.length,2300);assert.equal(serverTime,NOW);assert.ok(continuous(bars,STEP));
  assert.equal(bars.at(-1).t,Math.floor(NOW/STEP)*STEP,'the forming candle is included');
  assert.deepEqual(splitForming(bars,'5m',serverTime).forming,bars.at(-1));
});

test('fetchHistory keeps the server time of the page that held the newest candle',async()=>{
  // Time passes between pages and the 12:00 candle closes during the third request. Its data was
  // read at 12:02:30, so it must stay forming: calling it closed would trade on a partial candle.
  const clock={now:NOW},ex=exchange(clock),ticking=async(url,o)=>{const j=await ex.grab(url,o);clock.now+=90000;return j;};
  const {bars,serverTime}=await fetchHistory(ticking,'BTC','5m',{count:2500,now:()=>clock.now});
  assert.equal(ex.klines().length,3);assert.ok(clock.now>Math.floor(NOW/STEP)*STEP+STEP+90000);
  assert.equal(serverTime,NOW);
  const {forming}=splitForming(bars,'5m',serverTime);
  assert.equal(forming.t,Math.floor(NOW/STEP)*STEP);assert.equal(forming.c,price('BTC',NOW));
});

test('fetchHistory stops at the listing start and never repeats a candle',async()=>{
  const listed=Date.parse('2026-10-03T07:00:00Z');
  for(const ignoreEnd of [false,true]){
    // ignoreEnd: a source that answers every page with the newest candles.
    const clock={now:NOW},ex=exchange(clock,{listed,ignoreEnd});
    const {bars}=await fetchHistory(ex.grab,'ETH','1h',{count:2000,now:()=>clock.now});
    assert.equal(bars.length,30);assert.equal(bars[0].t,listed);assert.ok(continuous(bars,HOUR));
    assert.deepEqual(ex.klines().map(c=>c.q.limit),['1000','1000']);
  }
  await assert.rejects(fetchHistory(async()=>answer([]),'BTC','1h',{count:0,now:NOW}),{message:'Ogiltig candlebegäran'});
});

test('splitForming closes a candle exactly when its close time has passed on Bybit\'s clock',()=>{
  const bars=[0,1,2].map(i=>({t:T(i),o:1,h:1,l:1,c:1,v:0}));
  function T(i){return Date.parse('2026-10-04T00:00:00Z')+i*HOUR;}
  assert.deepEqual(splitForming(bars,'1h',T(2)+5000),{closed:bars.slice(0,2),forming:bars[2]});
  assert.deepEqual(splitForming(bars,'1h',T(3)-1),{closed:bars.slice(0,2),forming:bars[2]});
  assert.deepEqual(splitForming(bars,'1h',T(3)),{closed:bars,forming:null});
  assert.deepEqual(splitForming([],'1h',T(3)),{closed:[],forming:null});
  assert.throws(()=>splitForming(bars,'1h',undefined),{message:'Servertid saknas'});
});

test('findGaps reports how many candles are missing after which candle',()=>{
  const q=15*MIN,at=[0,1,2,5,6,9,10].map(i=>({t:i*q}));
  assert.deepEqual(findGaps(at,'15m'),[{after:2*q,missing:2},{after:6*q,missing:2}]);
  assert.deepEqual(findGaps(at.slice(0,3),'15m'),[]);assert.deepEqual(findGaps([],'1d'),[]);
});

test('mergeBars adds closed candles, keeps unchanged ones and reports closed candles Bybit changed',()=>{
  const t0=Date.parse('2026-10-04T00:00:00Z'),b=(i,c=100+i,v=10)=>({t:t0+i*HOUR,o:100,h:Math.max(100,c)+1,l:Math.min(100,c)-1,c,v});
  const base=Object.freeze([b(0),b(1),b(2)].map(Object.freeze)),serverTime=t0+4*HOUR+MIN;
  const r=mergeBars(base,[b(2,150),b(3),b(4)],'1h',serverTime);
  assert.deepEqual(r,{bars:[b(0),b(1),b(2,150),b(3),b(4)],closedNew:[b(3)],revised:[t0+2*HOUR]});
  assert.equal(base[2].c,102,'the input is not changed');
  const same=mergeBars(base,[b(1),b(2)],'1h',serverTime);
  assert.equal(same.bars[1],base[1]);assert.deepEqual(same.revised,[]);assert.deepEqual(same.closedNew,[]);
  // A turnover change on a closed candle is a revision too.
  assert.deepEqual(mergeBars(base,[b(2,102,11)],'1h',serverTime).revised,[t0+2*HOUR]);
  // A still-forming candle is replaced by each newer snapshot and is never a revision.
  const forming=mergeBars([...base,b(3),b(4,104)],[b(4,108)],'1h',serverTime);
  assert.deepEqual(forming.bars.at(-1),b(4,108));assert.deepEqual(forming.revised,[]);assert.deepEqual(forming.closedNew,[]);
  // Gap candles arriving later are new closed candles, in time order.
  assert.deepEqual(mergeBars([b(0),b(3)],[b(2),b(1)],'1h',serverTime).closedNew,[b(1),b(2)]);
});

test('a live series loads closed candles and the forming one, then polls the newest three',async()=>{
  const clock={now:NOW},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'BTC',tf:'1h',now:()=>clock.now,count:500});
  const hour=Math.floor(NOW/HOUR)*HOUR,st=await s.load();
  assert.equal(st.forming.t,hour);assert.equal(st.bars.at(-1).t,hour-HOUR);assert.equal(st.bars.length,499);assert.ok(continuous(st.bars,HOUR));
  assert.deepEqual([st.serverTime,st.lastOk,st.lastError,st.gaps,st.revised,st.loading],[NOW,NOW,null,[],[],false]);
  assert.ok(Object.isFrozen(st.bars[0])&&Object.isFrozen(st.forming));
  assert.deepEqual(ex.klines().map(c=>c.q.limit),['500']);
  // Same hour: only the forming candle moves.
  clock.now+=POLL_MS;
  assert.deepEqual(await s.poll(),{closedNew:[],revised:[]});
  const k=ex.klines().at(-1);assert.equal(k.q.limit,'3');assert.equal(k.q.end,undefined);assert.equal(k.options.timeout,4000);
  assert.equal(s.state().forming.c,price('BTC',clock.now));assert.equal(s.state().lastOk,clock.now);assert.equal(s.state().bars.length,499);
  // The hour closes: one new closed candle with its final close.
  clock.now=hour+HOUR+2000;
  const r=await s.poll();
  assert.deepEqual(r.closedNew.map(b=>b.t),[hour]);assert.equal(r.closedNew[0].c,price('BTC',hour+HOUR));
  assert.equal(s.state().forming.t,hour+HOUR);assert.equal(s.state().bars.length,500);
  // The window stays at `count` candles.
  clock.now+=HOUR;await s.poll();
  assert.equal(s.state().bars.length,500);assert.equal(s.state().bars.at(-1).t,hour+HOUR);
  // state() hands out copies: changing them does not reach the series.
  s.state().bars.length=0;assert.equal(s.state().bars.length,500);
  assert.equal(s.symbol,'BTC');assert.equal(s.tf,'1h');
});

test('candles missed while away are fetched once by range and arrive as new closed candles',async()=>{
  const clock={now:NOW},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'SOL',tf:'1h',now:()=>clock.now,count:300});
  await s.load();const last=s.state().bars.at(-1).t;
  clock.now+=6*HOUR;
  const before=ex.klines().length,r=await s.poll(),k=ex.klines().slice(before);
  assert.deepEqual(k.map(c=>[c.q.limit,c.q.end]),[['3',undefined],['4',String(last+4*HOUR)]]);
  assert.deepEqual(r.closedNew.map(b=>(b.t-last)/HOUR),[1,2,3,4,5,6]);
  const st=s.state();
  assert.deepEqual(st.gaps,[]);assert.ok(continuous(st.bars,HOUR));assert.equal(st.forming.t,last+7*HOUR);
  assert.equal(dataStatus(st,clock.now,'1h',{lookback:200}).state,'live');
});

test('a candle Bybit does not have stays reported as a gap after one refetch',async()=>{
  const q=15*MIN,clock={now:NOW},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'XRP',tf:'15m',now:()=>clock.now,count:300});
  await s.load();const last=s.state().bars.at(-1).t;
  ex.holes.add('15:'+(last+2*q));
  clock.now+=5*q;
  const before=ex.klines().length,r=await s.poll();
  assert.deepEqual(ex.klines().slice(before).map(c=>[c.q.limit,c.q.end]),[['3',undefined],['3',String(last+3*q)]]);
  assert.deepEqual(r.closedNew.map(b=>(b.t-last)/q),[1,3,4,5]);
  const st=s.state();assert.deepEqual(st.gaps,[{after:last+q,missing:1}]);
  assert.deepEqual(dataStatus(st,clock.now,'15m',{lookback:200}),{state:'gap',reliable:false,text:'Lucka i datan (1 candle saknas) — nya demoaffärer pausade',ageMs:0});
  // No second refetch of the same gap.
  clock.now+=POLL_MS;const n=ex.klines().length;await s.poll();
  assert.equal(ex.klines().length,n+1);assert.deepEqual(s.state().gaps,[{after:last+q,missing:1}]);
  // Once the gap is older than the lookback window, the data is reliable again.
  assert.equal(dataStatus(s.state(),clock.now,'15m',{lookback:4}).state,'gap');
  assert.equal(dataStatus(s.state(),clock.now,'15m',{lookback:3}).state,'live');
});

test('a closed candle Bybit changes afterwards takes the new values and is reported as revised',async()=>{
  const clock={now:NOW},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'DOGE',tf:'1h',now:()=>clock.now,count:200});
  await s.load();const old=s.state().bars.at(-1),t=old.t;
  ex.overrides.set('60:'+t,{c:old.c*1.01,h:old.h*1.02});
  clock.now+=HOUR;
  const r=await s.poll();
  assert.deepEqual(r.revised,[t]);assert.deepEqual(r.closedNew.map(b=>b.t),[t+HOUR]);
  const now=s.state().bars.find(b=>b.t===t);
  assert.equal(now.c,old.c*1.01);assert.equal(now.h,old.h*1.02);assert.equal(now.o,old.o);
  assert.deepEqual(s.state().revised,[t]);
  // Reported once; the next poll sees nothing new.
  clock.now+=POLL_MS;assert.deepEqual((await s.poll()).revised,[]);assert.deepEqual(s.state().revised,[t]);
});

test('an answer that is not newer than the last one is not a fresh read',async()=>{
  const clock={now:NOW},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'ETH',tf:'5m',now:()=>clock.now,count:100});
  await s.load();
  // A cached proxy answer: Bybit's time has not moved.
  clock.server=NOW;clock.now=NOW+POLL_MS;
  assert.deepEqual(await s.poll(),{closedNew:[],revised:[]});
  assert.equal(s.state().lastOk,NOW);
  clock.now=NOW+16000;await s.poll();
  assert.deepEqual(dataStatus(s.state(),clock.now,'5m',{lookback:50}),{state:'delayed',reliable:false,text:'Fördröjd data (16 s) — nya demoaffärer pausade',ageMs:16000});
  delete clock.server;clock.now+=POLL_MS;await s.poll();
  assert.equal(dataStatus(s.state(),clock.now,'5m',{lookback:50}).state,'live');
});

test('a failed poll is kept in lastError and reads as missing data once the last good read is old',async()=>{
  const clock={now:NOW},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'BTC',tf:'1h',now:()=>clock.now,count:200});
  await s.load();
  clock.fail='nätverk otillgängligt';clock.now=NOW+POLL_MS;
  const r=await s.poll();
  assert.deepEqual(r,{closedNew:[],revised:[],error:'nätverk otillgängligt'});
  assert.deepEqual(s.state().lastError,{at:NOW+POLL_MS,message:'nätverk otillgängligt'});assert.equal(s.state().lastOk,NOW);
  // One miss five seconds after a good read is still live.
  assert.equal(dataStatus(s.state(),clock.now,'1h',{lookback:100}).state,'live');
  clock.now=NOW+16000;await s.poll();
  assert.deepEqual(dataStatus(s.state(),clock.now,'1h',{lookback:100}),{state:'error',reliable:false,text:'Data saknas — nya demoaffärer pausade',ageMs:16000});
  // Bybit answering with an error is the same as no answer.
  clock.fail=null;clock.server=NOW-3*MAX_SKEW;clock.now+=POLL_MS;
  assert.equal((await s.poll()).error,'Färska priser saknas för BTC');
  delete clock.server;clock.now+=POLL_MS;await s.poll();
  assert.equal(s.state().lastError,null);assert.equal(dataStatus(s.state(),clock.now,'1h',{lookback:100}).state,'live');
});

test('a series loads on its first poll; a failed first load reads as missing data',async()=>{
  const clock={now:NOW,fail:'HTTP 403'},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'ETH',tf:'4h',now:()=>clock.now,count:100});
  assert.deepEqual(dataStatus(s.state(),clock.now,'4h'),{state:'loading',reliable:false,text:'Hämtar data…',ageMs:null});
  const st=await s.load();
  assert.equal(st.loading,false);assert.deepEqual(st.lastError,{at:NOW,message:'HTTP 403'});assert.deepEqual(st.bars,[]);
  assert.deepEqual(dataStatus(st,clock.now,'4h'),{state:'error',reliable:false,text:'Data saknas — nya demoaffärer pausade',ageMs:null});
  assert.deepEqual(await s.poll(),{closedNew:[],revised:[],error:'HTTP 403'});
  clock.fail=null;
  assert.deepEqual(await s.poll(),{closedNew:[],revised:[]});
  assert.equal(s.state().bars.length,99);assert.equal(s.state().forming.t,Math.floor(NOW/(4*HOUR))*4*HOUR);
  assert.equal(ex.klines().at(-1).q.limit,'100');
  assert.throws(()=>createLiveSeries({grab:ex.grab,symbol:'BTC',tf:'3h'}),{message:'Okänd tidsram'});
  assert.throws(()=>createLiveSeries({grab:ex.grab,symbol:'ADA',tf:'1h'}),{message:'Okänt perpetualkontrakt'});
});

test('calls never overlap: loading shows as loading, and a poll during it is skipped',async()=>{
  let release;const gate=new Promise(r=>{release=r;});
  const clock={now:NOW},ex=exchange(clock),slow=async(url,o)=>{await gate;return ex.grab(url,o);};
  const s=createLiveSeries({grab:slow,symbol:'BTC',tf:'5m',now:()=>clock.now,count:50});
  const loading=s.load();
  await new Promise(r=>setTimeout(r,0));
  assert.equal(s.state().loading,true);assert.equal(dataStatus(s.state(),clock.now,'5m').state,'loading');
  const polled=s.poll();release();
  assert.deepEqual(await polled,{closedNew:[],revised:[],skipped:true});
  await loading;
  assert.equal(ex.klines().length,1);assert.equal(s.state().loading,false);
});

test('after an absence longer than the window the whole window is reloaded, without a gap',async()=>{
  const clock={now:NOW},ex=exchange(clock),s=createLiveSeries({grab:ex.grab,symbol:'BTC',tf:'5m',now:()=>clock.now,count:100});
  await s.load();clock.now+=DAY;
  const before=ex.klines().length,r=await s.poll();
  assert.deepEqual(ex.klines().slice(before).map(c=>c.q.limit),['3','100']);
  const st=s.state();
  assert.equal(st.bars.length,99);assert.ok(continuous(st.bars,STEP));assert.deepEqual(st.gaps,[]);
  assert.equal(st.forming.t,Math.floor(clock.now/STEP)*STEP);
  assert.deepEqual(r.closedNew.map(b=>b.t),st.bars.map(b=>b.t));
  assert.equal(dataStatus(st,clock.now,'5m',{lookback:90}).state,'live');
});

// A healthy state read at `at`: closed candles up to the previous period and the current forming one.
function healthy(tf='1h',n=500,at=NOW){
  const ms=TF[tf].ms,current=Math.floor(at/ms)*ms,bar=t=>({t,o:1,h:1,l:1,c:1,v:1});
  return {bars:Array.from({length:n},(_,i)=>bar(current-(n-i)*ms)),forming:bar(current),serverTime:at,lastOk:at,lastError:null,gaps:[],revised:[],loading:false};
}
test('dataStatus is live only when the data is fresh, complete and current',()=>{
  const s=healthy();
  assert.deepEqual(dataStatus(s,NOW+3000,'1h',{lookback:400}),{state:'live',reliable:true,text:'Live · uppdaterad 3 s sedan',ageMs:3000});
  assert.equal(dataStatus(s,()=>NOW+3000,'1h').state,'live');
  for(const tf of CHART_TFS)assert.equal(dataStatus(healthy(tf),NOW+1000,tf).state,'live',tf);
  assert.deepEqual(dataStatus(s,NOW+21000,'1h'),{state:'delayed',reliable:false,text:'Fördröjd data (21 s) — nya demoaffärer pausade',ageMs:21000});
  assert.deepEqual(dataStatus(s,NOW+180000,'1h'),{state:'stale',reliable:false,text:'Inaktuell data (3 min) — nya demoaffärer pausade',ageMs:180000});
  assert.equal(dataStatus(s,NOW+STALE.delayed,'1h').state,'live');assert.equal(dataStatus(s,NOW+STALE.stale+1,'1h').state,'stale');
  // Missing candles inside the lookback window, or between the last closed candle and the forming one.
  const holed={...s,bars:s.bars.filter((b,i)=>i!==480&&i!==481)};
  assert.deepEqual(dataStatus(holed,NOW+3000,'1h'),{state:'gap',reliable:false,text:'Lucka i datan (2 candles saknas) — nya demoaffärer pausade',ageMs:3000});
  assert.equal(dataStatus({...s,bars:s.bars.slice(0,-1)},NOW+3000,'1h').state,'gap');
  // A gap older than the lookback window does not matter.
  assert.equal(dataStatus({...s,bars:s.bars.filter((b,i)=>i!==20)},NOW+3000,'1h',{lookback:400}).state,'live');
  assert.equal(dataStatus(s,NOW+3000,'1h',{lookback:600}).text,'För kort historik (500 av 600 candles) — nya demoaffärer pausade');
  // The period turned since the last read: the forming candle is the previous one.
  const late=healthy('1h',500,Math.floor(NOW/HOUR)*HOUR+HOUR-2000);
  assert.deepEqual(dataStatus(late,late.lastOk+3000,'1h'),{state:'delayed',reliable:false,text:'Väntar på ny candle — nya demoaffärer pausade',ageMs:3000});
  assert.equal(dataStatus({...s,forming:null},NOW+3000,'1h').state,'delayed');
  // Bybit's clock and ours disagree by more than MAX_SKEW.
  const skewed={...s,lastOk:NOW-MAX_SKEW-5000};
  assert.deepEqual(dataStatus(skewed,skewed.lastOk+1000,'1h'),{state:'error',reliable:false,text:'Datorns klocka skiljer sig från Bybit (2 min) — nya demoaffärer pausade',ageMs:1000});
  // A failure after the last good read counts once that read is old; an older failure does not.
  assert.deepEqual(dataStatus({...s,lastError:{at:NOW+10000,message:'x'}},NOW+16000,'1h'),{state:'error',reliable:false,text:'Data saknas — nya demoaffärer pausade',ageMs:16000});
  assert.equal(dataStatus({...s,lastError:{at:NOW-1000,message:'x'}},NOW+16000,'1h').state,'delayed');
  assert.equal(dataStatus({...s,lastError:{at:NOW+1000,message:'x'}},NOW+90000,'1h').state,'error');
  assert.deepEqual(dataStatus(null,NOW,'1h'),{state:'loading',reliable:false,text:'Hämtar data…',ageMs:null});
  assert.equal(dataStatus({...s,serverTime:null},NOW+1000,'1h').text,'Servertid saknas — nya demoaffärer pausade');
  assert.throws(()=>dataStatus(s,NOW,'2h'),{message:'Okänd tidsram'});
});

test('a PC clock set back after the last read never makes old candles look live',async()=>{
  // Bybit keeps its own time; the PC clock jumps back an hour, so every answer now fails the
  // freshness check and the failures are stamped earlier than the last good read.
  const bybit={now:NOW},ex=exchange(bybit),pc={now:NOW},s=createLiveSeries({grab:ex.grab,symbol:'BTC',tf:'1h',now:()=>pc.now,count:300});
  await s.load();
  assert.equal(dataStatus(s.state(),pc.now,'1h',{lookback:200}).state,'live');
  // Right after the jump, before any poll: an hour back reads as a clock problem, not as fresh data.
  pc.now=NOW-HOUR+2000;
  assert.deepEqual(dataStatus(s.state(),pc.now,'1h',{lookback:200}),{state:'error',reliable:false,text:'Datorns klocka skiljer sig från Bybit (60 min) — nya demoaffärer pausade',ageMs:null});
  // Polls fail all the way until the PC clock is back at (and past) the time of the last good read.
  for(let i=1;i<=62;i++){pc.now=NOW-HOUR+i*MIN;bybit.now=NOW+i*MIN;await s.poll();
    const st=s.state(),d=dataStatus(st,pc.now,'1h',{lookback:200});
    assert.equal(st.lastError.message,'Färska priser saknas för BTC');assert.equal(st.forming.t,Math.floor(NOW/HOUR)*HOUR);
    assert.equal(d.reliable,false,'minute '+i);assert.deepEqual(d,{state:'error',reliable:false,text:'Data saknas — nya demoaffärer pausade',ageMs:null});
  }
  assert.equal(s.state().lastOk,null);
  // The clock is corrected: the next good read is live again.
  pc.now=bybit.now;assert.deepEqual(await s.poll(),{closedNew:[{...candle('BTC',Math.floor(NOW/HOUR)*HOUR,HOUR,bybit.now)}],revised:[]});
  assert.equal(s.state().lastOk,pc.now);assert.equal(dataStatus(s.state(),pc.now,'1h',{lookback:200}).state,'live');
  // (A failure with the clock running forward keeps the last good read: see 'a failed poll is kept in lastError'.)
  // A hand-built state read with a clock that is far behind its last good read:
  assert.deepEqual(dataStatus(healthy(),NOW-HOUR,'1h'),{state:'error',reliable:false,text:'Datorns klocka skiljer sig från Bybit (60 min) — nya demoaffärer pausade',ageMs:null});
  // A `now` read a little before the last poll finished is not a clock problem.
  assert.equal(dataStatus(healthy(),NOW-30000,'1h').state,'live');
  assert.equal(dataStatus(healthy(),NOW-MAX_SKEW,'1h').state,'live');
  assert.equal(dataStatus(healthy(),NOW-MAX_SKEW-1,'1h').state,'error');
});

test('fetchFunding pages backwards 200 rates at a time by endTime and returns them ascending',async()=>{
  const clock={now:NOW},ex=exchange(clock);
  const from=Date.parse('2026-06-10T00:00:00Z'),to=Date.parse('2026-10-01T12:00:00Z');
  const rows=await fetchFunding(ex.grab,'PEPE',{from,to,now:()=>clock.now});
  const expected=[];for(let t=Math.ceil(from/FUND)*FUND;t<=to;t+=FUND)expected.push({t,rate:rate(t)});
  assert.equal(expected.length,341);assert.deepEqual(rows,expected);
  const calls=ex.calls.filter(c=>c.path==='funding/history'),newest=Math.floor(to/FUND)*FUND;
  assert.deepEqual(calls.map(c=>c.q),[{category:'linear',symbol:'1000PEPEUSDT',endTime:String(to),limit:'200'},
    {category:'linear',symbol:'1000PEPEUSDT',endTime:String(newest-199*FUND-1),limit:'200'}]);
  // Before the listing there is nothing: an empty page ends the history.
  const early=exchange(clock,{listed:Date.parse('2026-09-01T00:00:00Z')});
  const first=await fetchFunding(early.grab,'BTC',{from:Date.parse('2026-08-01T00:00:00Z'),to:Date.parse('2026-09-03T00:00:00Z'),now:NOW});
  assert.equal(first.length,7);assert.equal(first[0].t,Date.parse('2026-09-01T00:00:00Z'));assert.equal(early.calls.length,2);
  await assert.rejects(fetchFunding(ex.grab,'BTC',{from:to,to:from,now:NOW}),{message:'Ogiltigt fundingintervall'});
  await assert.rejects(fetchFunding(async()=>({retCode:10006,retMsg:'Too many visits',time:NOW}),'BTC',{from,to,now:NOW}),{message:'Färsk fundinghistorik saknas för BTC'});
  await assert.rejects(fetchFunding(async()=>({retCode:0,result:{category:'linear',list:[{symbol:'ETHUSDT',fundingRate:'0.0001',fundingRateTimestamp:String(newest)}]},time:NOW}),'BTC',{from,to,now:NOW}),
    {message:'Ogiltig funding för BTC'});
});

test('fetchPositionRisk adds paged last-price candles since nextBar to mark prices and funding',async()=>{
  const clock={now:NOW},ex=exchange(clock),current=Math.floor(NOW/STEP)*STEP;
  const position={nextBar:Date.parse('2026-09-30T03:05:00Z'),fundingThrough:Date.parse('2026-09-30T01:10:00Z')};
  const risk=await fetchPositionRisk(ex.grab,'BTC',position,()=>clock.now);
  assert.deepEqual(Object.keys(risk).sort(),['at','funding','fundingThrough','historyFrom','lastBars','mark','markBars','minuteLasts','minuteMarks','price']);
  // Long past the step it opened in: no 1-minute candles are read.
  assert.deepEqual([risk.minuteMarks,risk.minuteLasts],[[],[]]);
  assert.equal(risk.lastBars[0].t,position.nextBar);assert.equal(risk.lastBars.at(-1).t,current);
  assert.equal(risk.lastBars.length,(current-position.nextBar)/STEP+1);assert.ok(continuous(risk.lastBars,STEP));
  assert.deepEqual(risk.lastBars[0],{...candle('BTC',position.nextBar,STEP,NOW)});
  assert.equal(risk.historyFrom,position.fundingThrough);
  assert.equal(risk.markBars[0].t,risk.historyFrom);assert.equal(risk.markBars.at(-1).t,current);assert.ok(continuous(risk.markBars,STEP));
  const funding=[];for(let t=Math.ceil(position.fundingThrough/FUND)*FUND;t<=NOW;t+=FUND)funding.push({t,rate:rate(t)});
  assert.equal(funding.length,13);assert.deepEqual(risk.funding,funding);
  assert.equal(risk.fundingThrough,NOW);assert.equal(risk.at,NOW);
  near(risk.price,price('BTC',NOW));near(risk.mark,price('BTC',NOW)*.9998);
  const k=ex.klines();
  assert.equal(k.length,2);assert.ok(k.every(c=>c.q.interval==='5'&&c.q.symbol==='BTCUSDT'&&c.q.end!==undefined));
  assert.equal(ex.calls.filter(c=>c.path==='mark-price-kline').length,2);
  // SHIB: last and mark prices per token; `now` may be a plain number.
  const shib=await fetchPositionRisk(ex.grab,'SHIB',position,NOW);
  near(shib.price,price('SHIB',NOW));near(shib.lastBars[0].o,price('SHIB',position.nextBar));near(shib.markBars[0].o,price('SHIB',position.fundingThrough)*.9998);
  assert.ok([...shib.lastBars,...shib.markBars].every(b=>b.c>0&&b.c<.001));
});

test('fetchPositionRisk for a position opened this step has no last-price candles yet',async()=>{
  const clock={now:NOW},ex=exchange(clock),current=Math.floor(NOW/STEP)*STEP;
  const risk=await fetchPositionRisk(ex.grab,'ETH',{nextBar:current+STEP,fundingThrough:NOW-MIN},()=>clock.now);
  assert.deepEqual(risk.lastBars,[]);assert.deepEqual(risk.markBars.map(b=>b.t),[current]);assert.deepEqual(risk.funding,[]);
  assert.equal(ex.klines().length,0);
  for(const p of [null,{},{nextBar:current+1,fundingThrough:NOW},{nextBar:current,fundingThrough:'x'}])
    await assert.rejects(fetchPositionRisk(ex.grab,'ETH',p,NOW),{message:'Ogiltig position'});
  // A missing last-price or mark-price candle is not papered over.
  ex.holes.add('last:5:'+(current-STEP));
  await assert.rejects(fetchPositionRisk(ex.grab,'ETH',{nextBar:current-3*STEP,fundingThrough:NOW-MIN},NOW),{message:'Lucka i senaste priser för ETH'});
  ex.holes.clear();ex.holes.add('mark:5:'+(current-2*STEP));
  await assert.rejects(fetchPositionRisk(ex.grab,'ETH',{nextBar:current-3*STEP,fundingThrough:NOW-MIN},NOW),{message:'Lucka i markpriser för ETH'});
});

test('fetchPositionRisk adds the 1-minute candles of the step the position opened in, from the minute after the open',async()=>{
  const clock={now:NOW},ex=exchange(clock),step=Math.floor(NOW/STEP)*STEP;
  // Opened at 11:55:20; the clock is at 12:02:30 and the first full 5-minute candle (12:00) is not settled yet.
  const opened=step-STEP+20000,position={nextBar:step,fundingThrough:opened,openedAt:opened};
  const risk=await fetchPositionRisk(ex.grab,'BTC',position,()=>clock.now);
  assert.deepEqual(risk.minuteLasts.map(b=>b.t),[1,2,3,4].map(k=>step-STEP+k*MIN));
  assert.deepEqual(risk.minuteMarks.map(b=>b.t),risk.minuteLasts.map(b=>b.t));
  assert.deepEqual(risk.minuteLasts[0],(({t,o,h,l,c})=>({t,o,h,l,c}))(candle('BTC',step-STEP+MIN,MIN,NOW)));
  near(risk.minuteMarks[0].o,price('BTC',step-STEP+MIN)*.9998);
  const minutes=ex.calls.filter(c=>c.q.interval==='1');
  assert.deepEqual(minutes.map(c=>[c.path,c.q.limit,c.q.end]).sort(),[['kline','4',String(step-1)],['mark-price-kline','4',String(step-1)]]);
  // Still inside that step: the minutes so far, the forming one included; Bybit's gaps are left for settlePosition to judge.
  clock.now=opened+150000;ex.holes.add('last:1:'+(step-STEP+MIN));
  const inside=await fetchPositionRisk(ex.grab,'BTC',position,()=>clock.now);
  assert.deepEqual([inside.minuteLasts.map(b=>b.t),inside.minuteMarks.map(b=>b.t)],[[step-STEP+2*MIN],[step-STEP+MIN,step-STEP+2*MIN]]);
  // Settled past it: none read.
  ex.calls.length=0;clock.now=NOW;
  const after=await fetchPositionRisk(ex.grab,'BTC',{...position,nextBar:step+STEP,fundingThrough:NOW-MIN},()=>clock.now);
  assert.deepEqual([after.minuteMarks,after.minuteLasts,ex.calls.filter(c=>c.q.interval==='1')],[[],[],[]]);
  // An answer with a minute off the grid is refused.
  const bad=async(url,o)=>{const j=await ex.grab(url,o);if(new URL(url).searchParams.get('interval')==='1'&&j.result.list[0])j.result.list[0][0]=String(+j.result.list[0][0]+1);return j;};
  await assert.rejects(fetchPositionRisk(bad,'BTC',position,()=>clock.now),{message:'Ogiltig 1-minuterscandle för BTC'});
});

test('fetchPositionRisk accepts Bybit\'s change of funding interval during a position, but not a hole or a late funding',async()=>{
  // SOL as Bybit has it: funding every 8 hours through 10 November 2022 08:00 UTC, then every 2 hours from 10:00.
  const SWITCH=Date.UTC(2022,10,10,8),times=[],gone=new Set(),clock={now:SWITCH+HOUR+MIN},ex=exchange(clock,{listed:SWITCH-3*DAY});
  for(let t=SWITCH-6*FUND;t<=SWITCH;t+=FUND)times.push(t);
  for(let t=SWITCH+2*HOUR;t<=SWITCH+2*DAY;t+=2*HOUR)times.push(t);
  const ok=result=>({retCode:0,retMsg:'OK',result,retExtInfo:{},time:clock.now});
  let reported=null;
  const grab=async(url,o)=>{
    const u=new URL(url),q=Object.fromEntries(u.searchParams),path=u.pathname.replace('/v5/market/','');
    if(path==='tickers')return ok({category:'linear',list:[{symbol:'SOLUSDT',lastPrice:String(price('SOL',clock.now)),markPrice:String(price('SOL',clock.now)),
      nextFundingTime:String(times.find(t=>t>clock.now))}]});
    if(path==='instruments-info')return ok({category:'linear',list:[{symbol:'SOLUSDT',fundingInterval:reported??(clock.now>=SWITCH?'120':'480')}]});
    if(path==='funding/history')return ok({category:'linear',list:times.filter(t=>t<=Math.min(+q.endTime,clock.now)&&!gone.has(t)).reverse().slice(0,+q.limit)
      .map(t=>({symbol:'SOLUSDT',fundingRate:String(rate(t)),fundingRateTimestamp:String(t)}))});
    return ex.grab(url,o);
  };
  // Held since 05:00, before the last 8-hour funding: an hour after the change the 08:00 funding is due.
  const position={nextBar:SWITCH-3*HOUR,fundingThrough:SWITCH-3*HOUR},at=t=>({t,rate:rate(t)});
  const first=await fetchPositionRisk(grab,'SOL',position,()=>clock.now);
  assert.deepEqual([first.funding,first.fundingThrough],[[at(SWITCH)],clock.now]);
  // crypto-momentum-market.js's fetchDerivatives, which AI-momentum keeps, refuses this for good: 08:00 lies 8 hours
  // after 00:00 while the interval is 2 hours now.
  await assert.rejects(fetchDerivatives(grab,'SOL',position,()=>clock.now,{limits:false}),{message:'Fundinghistoriken är ännu inte komplett'});
  clock.now=SWITCH+30*HOUR;
  assert.deepEqual((await fetchPositionRisk(grab,'SOL',position,()=>clock.now)).funding,times.filter(t=>t>position.fundingThrough&&t<=clock.now).map(at));
  // Settled after the change: only the 2-hour times since then.
  assert.deepEqual((await fetchPositionRisk(grab,'SOL',{nextBar:SWITCH+5*HOUR,fundingThrough:SWITCH+5*HOUR},()=>clock.now)).funding.map(f=>f.t),
    Array.from({length:13},(_,k)=>SWITCH+6*HOUR+2*k*HOUR));
  // More than 8 hours without a funding time is a hole, not a schedule; a newest time older than one current interval
  // before Bybit's next is a funding Bybit has not published yet.
  const refused={message:'Fundinghistoriken är ännu inte komplett för SOL'};
  clock.now=SWITCH+6*HOUR+MIN;gone.add(SWITCH);gone.add(SWITCH+2*HOUR);
  await assert.rejects(fetchPositionRisk(grab,'SOL',position,()=>clock.now),refused);
  gone.clear();gone.add(SWITCH+6*HOUR);
  await assert.rejects(fetchPositionRisk(grab,'SOL',position,()=>clock.now),refused);
  // No funding time within 8 hours before the last settlement: the one before it is missing.
  gone.clear();gone.add(SWITCH-FUND);
  await assert.rejects(fetchPositionRisk(grab,'SOL',position,()=>clock.now),refused);
  gone.clear();
  assert.equal((await fetchPositionRisk(grab,'SOL',position,()=>clock.now)).funding.length,4);
  // An interval that Bybit's next funding time does not follow yet is a change in progress: wait for it.
  reported='60';
  await assert.rejects(fetchPositionRisk(grab,'SOL',position,()=>clock.now),{message:'Fundingintervall saknas eller håller på att växla för SOL'});
});

test('fetchPositionRisk waits for a funding time missing from a steady 1-, 2- or 4-hour schedule, never for a change of interval, and settles a gap Bybit keeps for 8 hours',async()=>{
  const D0=Date.UTC(2026,9,1),at=h=>D0+h*HOUR,clock={now:0},refused={message:'Fundinghistoriken är ännu inte komplett för SOL'};
  // Funding times on [from, to, every] pieces (hours from D0), Bybit's interval for the time now, and the times it lacks.
  function bybit(pieces,gone=[]){
    const times=[...new Set(pieces.flatMap(([from,to,every])=>{const out=[];for(let h=from;h<=to;h+=every)out.push(at(h));return out;}))].sort((a,b)=>a-b);
    const ex=exchange(clock,{listed:D0-2*DAY}),lacks=new Set(gone.map(at)),ok=result=>({retCode:0,retMsg:'OK',result,retExtInfo:{},time:clock.now});
    const interval=()=>{const k=times.findIndex(t=>t>clock.now);return times[k]-times[k-1];};
    return async(url,o)=>{
      const u=new URL(url),q=Object.fromEntries(u.searchParams),path=u.pathname.replace('/v5/market/','');
      if(path==='tickers')return ok({category:'linear',list:[{symbol:'SOLUSDT',lastPrice:String(price('SOL',clock.now)),markPrice:String(price('SOL',clock.now)),
        nextFundingTime:String(times.find(t=>t>clock.now))}]});
      if(path==='instruments-info')return ok({category:'linear',list:[{symbol:'SOLUSDT',fundingInterval:String(interval()/MIN)}]});
      if(path==='funding/history')return ok({category:'linear',list:times.filter(t=>t<=Math.min(+q.endTime,clock.now)&&!lacks.has(t)).reverse().slice(0,+q.limit)
        .map(t=>({symbol:'SOLUSDT',fundingRate:String(rate(t)),fundingRateTimestamp:String(t)}))});
      return ex.grab(url,o);
    };
  }
  // Held since 09:05 (05:05 for the 8-hour schedules), not settled since.
  const read=(grab,now,from=9)=>{clock.now=at(now);const p=at(from)+5*MIN;return fetchPositionRisk(grab,'SOL',{nextBar:p,fundingThrough:p},()=>clock.now);};
  const hours=risk=>risk.funding.map(f=>(f.t-D0)/HOUR);
  // One missing time doubles a gap of a steady schedule: 12:00 of a 2-hour one, 11:00–13:00 of an hourly one, 12:00 of a 4-hour one.
  const two=bybit([[-24,48,2]],[12]),one=bybit([[-24,48,1]],[11,12,13]),four=bybit([[-24,48,4]],[12]);
  await assert.rejects(read(two,14.5),refused);await assert.rejects(read(one,14.5),refused);await assert.rejects(read(four,16.5),refused);
  // Published within the 8 hours: charged after all.
  assert.deepEqual(hours(await read(bybit([[-24,48,2]]),14.5)),[10,12,14]);
  // Still missing 8 hours after the funding that follows it, it is Bybit's own record: settled without it.
  await assert.rejects(read(two,21.99),refused);
  assert.deepEqual(hours(await read(two,22.01)),[10,14,16,18,20,22]);
  assert.deepEqual(hours(await read(one,22.01)),[10,14,15,16,17,18,19,20,21,22]);
  // The same for a gap longer than 8 hours: 16:00 of an 8-hour schedule missing, waited for until the next funding
  // (00:00 the day after) is 8 hours old.
  const eight=bybit([[-24,48,8]],[16]);
  await assert.rejects(read(eight,24.5,5),refused);await assert.rejects(read(eight,31.9,5),refused);
  assert.deepEqual(hours(await read(eight,32.1,5)),[8,24,32]);
  // Bybit's changes of interval, aligned or not, settle at once: 2 → 8 h at 08:00 or after 10:00, 1 → 8 h, 8 → 1 h, 4 → 2 h, 2 → 1 h, 1 → 2 h.
  for(const [pieces,now,from,want] of [
    [[[-24,8,2],[16,48,8]],16.5,5,[6,8,16]],[[[-24,10,2],[16,48,8]],16.5,9,[10,16]],[[[-24,10,1],[16,48,8]],16.5,9,[10,16]],
    [[[-24,8,8],[9,48,1]],10.5,5,[8,9,10]],[[[-24,8,4],[10,48,2]],12.5,5,[8,10,12]],[[[-24,10,2],[11,48,1]],12.5,9,[10,11,12]],
    [[[-24,10,1],[12,48,2]],14.5,9,[10,12,14]]])
    assert.deepEqual(hours(await read(bybit(pieces),now,from)),want,JSON.stringify(pieces));
  // An interval kept for a single funding (1 h → 8 h → 1 h) looks like missing times until that funding is 8 hours old.
  const toggle=bybit([[-24,10,1],[16,16,8],[17,48,1]]);
  await assert.rejects(read(toggle,17.5),refused);
  assert.deepEqual(hours(await read(toggle,24.01)),[10,16,17,18,19,20,21,22,23,24]);
});

// A stand-in with forecastAt's shape (the model is built elsewhere): it reads only the 20 candles up to the cutoff.
function standIn(bars,c,H=5){
  const win=bars.slice(c-19,c+1),t0=bars[c].t,base=bars[c].c,unit=win.reduce((s,b)=>s+(b.h-b.l)/b.c,0)/win.length,drift=Math.log(base/win[0].c)/19;
  const candles=[],bands=[];let prev=base;
  for(let h=1;h<=H;h++){
    const close=base*Math.exp(drift*h),w=unit*Math.sqrt(h);
    candles.push({t:t0+h*HOUR,o:prev,h:Math.max(prev,close)*(1+unit/4),l:Math.min(prev,close)*(1-unit/4),c:close});prev=close;
    bands.push({t:t0+h*HOUR,q10:close*Math.exp(-1.28*w),q25:close*Math.exp(-.67*w),q50:close,q75:close*Math.exp(.67*w),q90:close*Math.exp(1.28*w)});
  }
  return {ok:true,model:MODEL.forecast,cutoff:t0,base,unit,horizon:H,k:20,candles,bands,medoid:{t:win[0].t,d:0},analogs:win.slice(0,3).map(b=>b.t),train:{from:win[0].t,to:t0,n:20}};
}
test('scenario: a stored forecast stays byte-identical while new candles arrive and later forecasts are stored',async()=>{
  const clock={now:NOW},ex=exchange(clock),storage=memoryStorage(),store=createForecastStore(localStorageBackend(storage));
  const series=createLiveSeries({grab:ex.grab,symbol:'ETH',tf:'1h',now:()=>clock.now,count:300});
  await series.load();
  const putLatest=async origin=>{
    const {bars}=series.state(),r=forecastRecord('u1','ETH','1h',standIn(bars,bars.length-1),{createdAt:clock.now,origin,tfMs:TF['1h'].ms});
    return {r,result:await store.putForecast(r)};
  };
  const {r:first,result}=await putLatest('live');
  assert.deepEqual(result,{stored:true});
  const snapshot=JSON.stringify(first),copy=JSON.parse(snapshot),ids=[first.id];
  for(let i=1;i<=5;i++){
    clock.now+=HOUR;
    const {closedNew}=await series.poll();assert.equal(closedNew.length,1);
    const {r,result}=await putLatest('live');
    assert.deepEqual(result,{stored:true});assert.equal(r.cutoff,first.cutoff+i*HOUR);ids.push(r.id);
    const back=await store.get(first.id);
    assert.deepEqual(back,copy);assert.equal(back.hash,first.hash);assert.equal(hashOf({...back,hash:undefined}),first.hash);
    assert.equal(JSON.stringify(back),snapshot);assert.ok(verifyRecord(back));
  }
  assert.equal(new Set(ids).size,6);
  // The first cutoff recomputed later, from the longer series: the same forecast (only candles up to
  // the cutoff are used) is recognised as identical, and the stored record keeps its own creation time.
  const bars=series.state().bars,c=bars.findIndex(b=>b.t===first.cutoff);
  const again=forecastRecord('u1','ETH','1h',standIn(bars,c),{createdAt:clock.now,origin:'backfill',tfMs:HOUR});
  assert.deepEqual(again.forecast,first.forecast);assert.equal(again.id,first.id);assert.equal(again.contentHash,first.contentHash);
  const clash=await store.putForecast(again);
  assert.equal(clash.identical,true);assert.equal(clash.stored,false);assert.equal(JSON.stringify(clash.existing),snapshot);
  assert.equal(storage.getItem('riptide.forecast.records.v1:record:'+first.id),snapshot);
  const listed=await store.listForecasts('u1','ETH','1h');
  assert.deepEqual(listed.records.map(r=>r.id),ids);assert.deepEqual(listed.corrupt,[]);
  assert.equal(JSON.stringify(listed.records[0]),snapshot);
});

test('every request in this file was a public V5 market GET for a linear contract',()=>{
  assert.ok(requests.length>50);
  for(const {url,q,options} of requests){
    assert.ok(url.startsWith(API),url);
    assert.ok(['kline','mark-price-kline','tickers','instruments-info','funding/history'].includes(new URL(url).pathname.replace('/v5/market/','')),url);
    assert.equal(q.category,'linear',url);assert.ok(Object.values(CONTRACTS).includes(q.symbol),url);assert.equal(options?.json,true);
  }
});
