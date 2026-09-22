import test from 'node:test';
import assert from 'node:assert/strict';
import {FLOOR,ROOMS,newFirm,validateFirm,readFirm,firmKey,equityKey,firmPositions,deskSnapshot,advanceFirm,advanceFirmRisk,setFirmPaused,heldSymbols,firmLive,firmStats,sampleEquity,readEquity,riskRows,floorNarrative,traderNames,dayStart} from '../trading-floor.js';
import {ACTIVE} from '../crypto-momentum-active.js';
import {LEVERAGE} from '../crypto-leverage.js';
import {CONTRACTS} from '../bybit-contracts.js';
import {AISLES,ROOM_GEOMETRY,DESK_GEOMETRY,FIKA,allLocations,onNetwork,routeBetween,routeTo,createAgents,stepAgents,REGIONS,hitAt,project,SCREENS,deskCelebration,celebrationPose} from '../trading-floor-scene.js';
import {mountFloor} from '../trading-floor-ui.js';

const TIME=Date.parse('2026-09-22T12:00:00Z'),HOUR=3600000,STEP=LEVERAGE.step;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const cash=desk=>desk.sleeves.reduce((sum,s)=>sum+s.cash,0);
const held=desk=>desk.sleeves.find(s=>s.position)?.position??null;
const contract=(symbol,at)=>({symbol,contract:CONTRACTS[symbol],at,min:1,max:150,step:.01,tiers:[{id:1,cap:1e7,max:150,maintenance:.005,deduction:0}]});
function snapshot(time=TIME,scores={}){
  const hour=Math.floor(time/HOUR)*HOUR;
  return {hour,market:Object.fromEntries(ACTIVE.symbols.map(symbol=>[symbol,{at:time,price:100,mark:100,contract:contract(symbol,time),
    signal:{symbol,at:hour,score:scores[symbol]??.1,reference:100,slDistance:2,rewardMultiple:2,maxHoldMs:12*HOUR},
    historyFrom:TIME-STEP,fundingThrough:time,funding:[],
    markBars:Array.from({length:Math.floor((time-TIME)/STEP)+2},(_,i)=>({t:TIME-STEP+i*STEP,o:100,h:100,l:100,c:100}))}]))};
}
const seeded=()=>{let seed=7;return ()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};};

test('a new firm has six desks in universe order with 100 dollars each and trading enabled',()=>{
  const firm=newFirm(TIME);
  assert.deepEqual([...FLOOR.desks],ACTIVE.symbols.slice(0,6));assert.deepEqual(Object.keys(firm.desks),[...FLOOR.desks]);
  for(const s of FLOOR.desks){assert.equal(firm.desks[s].enabled,true);near(cash(firm.desks[s]),100);assert.equal(held(firm.desks[s]),null);}
  assert.equal(firm.paused,false);assert.equal(validateFirm(firm),firm);
  assert.deepEqual(readFirm({getItem:()=>null},'k',TIME),firm);
  assert.throws(()=>validateFirm({...firm,version:'x'}),/Ogiltig/);
  assert.throws(()=>validateFirm({...firm,desks:{...firm.desks,BTC:{...firm.desks.BTC,enabled:false}}}),/handelsläge/);
  assert.throws(()=>newFirm(0));
  assert.equal(firmKey('a b'),'riptide.floor.v1:a%20b');assert.equal(equityKey('a'),'riptide.floor.v1:a:equity');
});

test('each desk buys only its own coin even when another coin has the stronger signal',()=>{
  const firm=newFirm(TIME),copy=structuredClone(firm),next=advanceFirm(firm,snapshot(TIME,{PEPE:.9,ETH:.5}),TIME);
  assert.deepEqual(firm,copy);assert.deepEqual(heldSymbols(next),[...FLOOR.desks]);
  for(const s of FLOOR.desks){
    const sleeve=next.desks[s].sleeves.find(x=>x.position);
    assert.equal(sleeve.symbol,s);assert.ok(sleeve.position.budget<=50+1e-7);near(cash(next.desks[s])+sleeve.position.budget,100);
    assert.equal(next.desks[s].activeDecisions.length,1);assert.equal(next.desks[s].activeDecisions[0].symbol,s);
  }
  assert.equal(validateFirm(next),next);
  const again=advanceFirm(next,snapshot(TIME+1000,{PEPE:.9}),TIME+1000);
  assert.deepEqual(heldSymbols(again),[...FLOOR.desks]);for(const s of FLOOR.desks)assert.equal(again.desks[s].activeDecisions.length,1);
  const cashOnly=advanceFirm(newFirm(TIME),snapshot(TIME,{BTC:-.2}),TIME);
  assert.equal(heldSymbols(cashOnly).includes('BTC'),false);assert.equal(cashOnly.desks.BTC.activeDecisions[0].action,'kontanter');assert.equal(heldSymbols(cashOnly).length,5);
  assert.throws(()=>validateFirm({...next,desks:{...next.desks,BTC:next.desks.ETH}}),/fel coin/);
  assert.equal(advanceFirm(newFirm(TIME),{hour:snapshot().hour,market:Object.fromEntries(Object.entries(snapshot().market).map(([s,m])=>[s,{...m,signal:null}]))},TIME).desks.BTC.activeDecisions.length,1);
});

test('the shared market fetch carries every desk position and each desk sees only its own signal',()=>{
  const firm=advanceFirm(newFirm(TIME),snapshot(),TIME),merged=firmPositions(firm);
  assert.equal(merged.profile,'pulse12');assert.equal(merged.sleeves.length,ACTIVE.symbols.length);
  for(const s of FLOOR.desks)assert.deepEqual(merged.sleeves.find(x=>x.symbol===s).position,held(firm.desks[s]));
  assert.equal(merged.sleeves.find(x=>x.symbol==='PEPE').position,null);
  const q=deskSnapshot(snapshot(),'ETH');
  assert.equal(q.hour,snapshot().hour);assert.ok(q.market.ETH.signal);
  for(const s of ACTIVE.symbols)if(s!=='ETH')assert.equal(q.market[s].signal,null);
});

test('pausing stops new entries while SL and TP still close open positions',()=>{
  const paused=setFirmPaused(newFirm(TIME),true);
  assert.ok(FLOOR.desks.every(s=>paused.desks[s].enabled===false));
  assert.equal(heldSymbols(advanceFirm(paused,snapshot(),TIME)).length,0);
  const open=advanceFirm(newFirm(TIME),snapshot(),TIME),stopped=setFirmPaused(open,true),time=TIME+2*STEP,p=held(stopped.desks.SOL),q=snapshot(time);
  q.market.SOL.markBars=q.market.SOL.markBars.map(b=>b.t===TIME+STEP?{...b,l:p.sl-.01,c:p.sl}:b);
  const one=advanceFirmRisk(stopped,'SOL',{market:{SOL:q.market.SOL}},time);
  assert.equal(one.desks.SOL.trades.length,1);assert.equal(one.desks.SOL.trades[0].reason,'SL');assert.equal(one.desks.SOL.trades[0].symbol,'SOL');
  for(const s of FLOOR.desks)if(s!=='SOL')assert.deepEqual(one.desks[s],stopped.desks[s]);
  assert.equal(one.paused,true);assert.equal(advanceFirmRisk(one,'SOL',{market:{}},time+1000),one);
  const all=advanceFirm(stopped,q,time);
  assert.equal(all.desks.SOL.trades.length,1);assert.equal(heldSymbols(all).length,5);
  const resumed=setFirmPaused(all,false);assert.ok(FLOOR.desks.every(s=>resumed.desks[s].enabled));
  assert.throws(()=>advanceFirmRisk(one,'PEPE',{market:{}},time),/Okänt bord/);
});

test('the big screen total sums six live desk balances and waits when a held desk lacks a fresh price',()=>{
  const fresh=firmLive(newFirm(TIME),{},TIME);
  near(fresh.total,600);near(fresh.net,0);assert.deepEqual(fresh.waiting,[]);assert.equal(fresh.start,600);
  const firm=advanceFirm(newFirm(TIME),snapshot(),TIME),quotes=Object.fromEntries(FLOOR.desks.map(s=>[s,{price:101,mark:100.99,at:TIME+5000}]));
  const all=firmLive(firm,quotes,TIME+5000);
  assert.deepEqual(all.waiting,[]);near(all.total,FLOOR.desks.reduce((sum,s)=>sum+all.desks[s].balance,0));assert.ok(all.total>600);
  assert.ok(all.desks.BTC.openNet>0);assert.equal(all.desks.BTC.quote.mark,100.99);
  delete quotes.XRP;const partial=firmLive(firm,quotes,TIME+5000);
  assert.equal(partial.total,null);assert.equal(partial.net,null);assert.deepEqual(partial.waiting,['XRP']);assert.ok(partial.desks.BTC.balance>0);assert.equal(partial.desks.XRP.balance,null);
  const rows=riskRows(firm,all);assert.equal(rows.length,6);assert.ok(rows.every(r=>r.toSl>0&&r.toTp>0&&r.toLiq>r.toSl));
});

test('equity samples are at most one per minute, capped and validated on read',()=>{
  let points=[];
  points=sampleEquity(points,TIME,600);points=sampleEquity(points,TIME+30000,601);assert.equal(points.length,1);
  points=sampleEquity(points,TIME+60000,602);assert.equal(points.length,2);assert.equal(sampleEquity(points,TIME+120000,NaN),points);
  let many=[];for(let i=0;i<FLOOR.equityLimit+50;i++)many=sampleEquity(many,TIME+i*60000,600+i);
  assert.equal(many.length,FLOOR.equityLimit);assert.equal(many.at(-1).v,600+FLOOR.equityLimit+49);
  assert.deepEqual(readEquity({getItem:()=>JSON.stringify(points)},'k'),points);
  assert.throws(()=>readEquity({getItem:()=>JSON.stringify([{t:2,v:1},{t:1,v:1}])},'k'));
  assert.deepEqual(readEquity({getItem:()=>null},'k'),[]);
});

test('firm statistics separate today from all time using Stockholm midnight',()=>{
  const firm=advanceFirm(newFirm(TIME),snapshot(),TIME),time=TIME+2*STEP,p=held(firm.desks.BTC),q=snapshot(time);
  q.market.BTC.markBars=q.market.BTC.markBars.map(b=>b.t===TIME+STEP?{...b,h:p.tp+.01,c:p.tp}:b);
  const done=advanceFirmRisk(firm,'BTC',{market:{BTC:q.market.BTC}},time),stats=firmStats(done,time);
  assert.equal(stats.trades,1);assert.equal(stats.wins,1);assert.ok(stats.realized>0);near(stats.today,stats.realized);
  assert.equal(stats.desks.BTC.status,'cooldown');assert.equal(stats.desks.ETH.status,'trade');assert.equal(stats.inTrade,5);
  assert.equal(firmStats(setFirmPaused(done,true),time+2*HOUR).desks.BTC.status,'paused');assert.equal(firmStats(done,time+2*HOUR).desks.BTC.status,'waiting');
  const tomorrow=dayStart(time)+86400000+3600000;
  assert.equal(firmStats(done,tomorrow).today,0);assert.equal(dayStart(tomorrow)%1000,0);
  assert.ok(time-dayStart(time)<86400000&&time-dayStart(time)>=0);
  const text=floorNarrative(done,firmLive(done,Object.fromEntries(FLOOR.desks.map(s=>[s,{price:100,mark:100,at:time}])),time),stats,time);
  assert.match(text,/5 av 6 bord sitter i affär/);assert.match(text,/Karens efter avslut: BTC/);assert.match(text,/1 avslut sedan start: 1 vinster/);
});

test('Stockholm midnight stays correct across both daylight saving changes',()=>{
  for(const [time,start] of [
    ['2026-03-29T00:30:00Z','2026-03-28T23:00:00Z'],
    ['2026-03-29T12:00:00Z','2026-03-28T23:00:00Z'],
    ['2026-10-25T00:30:00Z','2026-10-24T22:00:00Z'],
    ['2026-10-25T12:00:00Z','2026-10-24T22:00:00Z']
  ])assert.equal(dayStart(Date.parse(time)),Date.parse(start),time);
});

test('firm quote timestamp is the oldest held quote, not the render time',()=>{
  const firm=advanceFirm(newFirm(TIME),snapshot(),TIME);
  const quotes=Object.fromEntries(FLOOR.desks.map((s,i)=>[s,{price:101,mark:101,at:TIME+i*1000}]));
  assert.equal(firmLive(firm,quotes,TIME+10000).at,TIME);
  delete quotes.BTC;assert.equal(firmLive(firm,quotes,TIME+10000).at,null);
});

test('old hourly decisions are trimmed so six desks stay small in storage',()=>{
  const firm=newFirm(TIME),desk=firm.desks.BTC,n=FLOOR.decisionLimit+20;
  desk.activeDecisions=Array.from({length:n},(_,i)=>({hour:TIME-(n-i)*HOUR,at:TIME-(n-i)*HOUR+1000,action:'kontanter',symbol:null,score:null}));
  desk.lastSignalAt=desk.activeDecisions.at(-1).hour;
  validateFirm(firm);
  const next=advanceFirm(firm,snapshot(),TIME);
  assert.equal(next.desks.BTC.activeDecisions.length,FLOOR.decisionLimit);assert.equal(next.desks.BTC.activeDecisions.at(-1).hour,snapshot().hour);
  assert.equal(validateFirm(next),next);
});

test('every desk has four unique traders and the four rooms have their people',()=>{
  const all=FLOOR.desks.flatMap(traderNames);assert.equal(all.length,24);assert.equal(new Set(all).size,24);
  assert.deepEqual(ROOMS.map(r=>r.name),['Elias','Pablo','Manuel','Miguel']);assert.deepEqual(traderNames('PEPE'),[]);
  assert.deepEqual(DESK_GEOMETRY.map(d=>d.symbol),[...FLOOR.desks]);assert.ok(DESK_GEOMETRY.every(d=>d.seats.length===4&&d.names.length===4));
});

test('every seat and spot connects to the aisle network and routes never cut through furniture or walls',()=>{
  const locations=allLocations(),eq=(a,b)=>Math.abs(a-b)<1e-6;
  assert.ok(locations.length>=56);
  for(const l of locations)assert.ok(onNetwork(l.aisle),l.key+' aisle off network');
  const keys=locations.map(l=>l.key);assert.equal(new Set(keys).size,keys.length);
  const onLine=(a,b)=>eq(a.x,b.x)&&AISLES.vertical.some(x=>eq(x,a.x))||eq(a.y,b.y)&&AISLES.horizontal.some(y=>eq(y,a.y));
  const blocks=[...DESK_GEOMETRY.map(d=>[d.x0,d.y0,d.x1,d.y1]),...ROOM_GEOMETRY.map(r=>[r.desk.x0,r.desk.y0,r.desk.x1,r.desk.y1]),
    [FIKA.table.x-FIKA.table.r,FIKA.table.y-FIKA.table.r,FIKA.table.x+FIKA.table.r,FIKA.table.y+FIKA.table.r]];
  // The sofa is a seat, not an obstacle, but nobody walks along it.
  for(const s of locations.filter(l=>l.kind!=='sofa'))assert.ok(!(s.x>FIKA.sofa.x0&&s.x<FIKA.sofa.x1&&s.y>FIKA.sofa.y0&&s.y<FIKA.sofa.y1),s.key+' stands on the sofa');
  // Sampled: the short legs into the coffee corner are deliberately diagonal.
  const crosses=(a,b,[x0,y0,x1,y1])=>{
    for(let k=0;k<=40;k++){const x=a.x+(b.x-a.x)*k/40,y=a.y+(b.y-a.y)*k/40;if(x>x0+1e-9&&x<x1-1e-9&&y>y0+1e-9&&y<y1-1e-9)return true;}
    return false;
  };
  const throughWall=(a,b)=>{
    if(eq(a.y,b.y)&&Math.min(a.x,b.x)<4.5&&Math.max(a.x,b.x)>4.5)return !ROOM_GEOMETRY.some(r=>a.y>r.door.y0&&a.y<r.door.y1);
    if(eq(a.x,b.x)&&a.x<4.5)return ROOM_GEOMETRY.some(r=>r.y0>0&&Math.min(a.y,b.y)<r.y0&&Math.max(a.y,b.y)>r.y0||Math.min(a.y,b.y)<r.y1&&Math.max(a.y,b.y)>r.y1);
    return false;
  };
  let routes=0;
  for(const from of locations)for(const to of locations){
    if(from===to)continue;
    const path=routeTo(from,to);assert.ok(path.length);assert.equal(path.at(-1).x,to.x);assert.equal(path.at(-1).y,to.y);
    const nodes=[from.aisle,...routeBetween(from.aisle,to.aisle)];
    for(let i=1;i<nodes.length;i++)assert.ok(onLine(nodes[i-1],nodes[i]),`${from.key}->${to.key} leaves the aisles`);
    const full=[{x:from.x,y:from.y},...path];
    for(let i=1;i<full.length;i++){
      for(const b of blocks)assert.ok(!crosses(full[i-1],full[i],b),`${from.key}->${to.key} walks through furniture`);
      assert.ok(!throughWall(full[i-1],full[i]),`${from.key}->${to.key} walks through a wall`);
    }
    routes++;
  }
  assert.ok(routes>3000);
  assert.throws(()=>routeBetween({x:9,y:9},{x:6.5,y:8}),/gångnätet/);
});

test('traders sit at their desk during a trade and roam the office when the desk is idle',()=>{
  const rnd=seeded(),agents=createAgents(rnd),idle={inTrade:Object.fromEntries(FLOOR.desks.map(s=>[s,false])),riskDesk:null,reduced:false};
  assert.equal(agents.length,28);assert.equal(agents.filter(a=>a.kind==='staff').length,4);
  let t=TIME;for(let i=0;i<20*60*10;i++){t+=100;stepAgents(agents,idle,t,0.1,rnd);}
  const traders=agents.filter(a=>a.kind==='trader');
  assert.ok(traders.some(a=>a.at!==a.home),'someone should have left the desk');
  assert.ok(agents.filter(a=>a.kind==='staff').some(a=>a.at!==a.home||a.activity!=='office'),'staff should make outings');
  const targets=agents.map(a=>a.target?.key).filter(k=>k&&!k.startsWith('seat:')&&!k.startsWith('office:'));
  assert.equal(new Set(targets).size,targets.length,'no spot is double-booked');
  const busy={...idle,inTrade:{...idle.inTrade,BTC:true,DOGE:true},riskDesk:'DOGE'};
  for(let i=0;i<3*60*10;i++){t+=100;stepAgents(agents,busy,t,0.1,rnd);}
  for(const a of traders.filter(a=>a.desk==='BTC'||a.desk==='DOGE')){assert.equal(a.at,a.home);assert.equal(a.state,'seated');assert.deepEqual(a.pos,{x:a.home.x,y:a.home.y});}
  for(const a of agents)assert.ok(a.pos.x>=0&&a.pos.x<=24&&a.pos.y>=0&&a.pos.y<=18,a.id+' left the office');
  const quick=createAgents(rnd);stepAgents(quick,{...idle,reduced:true},TIME+1e9,0.1,rnd);assert.ok(quick.every(a=>a.state!=='walking'));
  stepAgents(quick,{...idle,reduced:true},TIME+2e9,0.1,rnd);assert.ok(quick.every(a=>a.state!=='walking'));
});

test('clickable regions cover the desks, rooms, screens and the coffee corner',()=>{
  const regions=REGIONS();
  for(const d of DESK_GEOMETRY){const p=project(d.x0+0.75,d.y0+2,10),hit=hitAt(p.x,p.y,regions);assert.equal(hit?.kind,'desk');assert.equal(hit.id,d.symbol);}
  for(const r of ROOM_GEOMETRY){const p=project(2,r.y0+2,30),hit=hitAt(p.x,p.y,regions);assert.equal(hit?.kind,'room');assert.equal(hit.id,r.id);}
  for(const [id,s] of Object.entries(SCREENS)){const p=project((s.x0+s.x1)/2,0,(s.top+s.bottom)/2);assert.equal(hitAt(p.x,p.y,regions)?.id,id);}
  const f=project(FIKA.table.x,FIKA.table.y,5);assert.equal(hitAt(f.x,f.y,regions)?.kind,'fika');
  assert.equal(hitAt(5,5,regions),null);
});

const dailyBars=(time,step)=>Array.from({length:100},(_,i)=>{const t=Math.floor(time/step)*step-(99-i)*step,c=100+i;return {t,o:c,h:c+1,l:c-1,c,v:1};});
const reply=(symbol,at,last=199)=>({retCode:0,time:at,result:{category:'linear',list:[{symbol,lastPrice:String(last),markPrice:String(last),nextFundingTime:String((Math.floor(at/28800000)+1)*28800000)}]}});
const fakeGrab=runtime=>async url=>{
  const u=new URL(url),symbol=u.searchParams.get('symbol'),time=runtime.at;runtime.urls?.push(u);
  if(runtime.fail)throw Error('offline');
  if(u.pathname.endsWith('/tickers'))return reply(symbol,time);
  if(u.pathname.endsWith('/instruments-info'))return {retCode:0,time,result:{category:'linear',list:[{symbol,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'150',leverageStep:'.01'}}]}};
  if(u.pathname.endsWith('/risk-limit'))return {retCode:0,time,result:{category:'linear',list:[{id:1,symbol,riskLimitValue:'10000000',maxLeverage:'150',maintenanceMargin:'.005',mmDeduction:''}]}};
  if(u.pathname.endsWith('/funding/history'))return {retCode:0,time,result:{category:'linear',list:Array.from({length:10},(_,i)=>({symbol,fundingRate:'0',fundingRateTimestamp:String(Math.floor(time/28800000)*28800000-i*28800000)}))}};
  if(u.pathname.endsWith('/mark-price-kline'))return {retCode:0,time,result:{category:'linear',symbol,list:Array.from({length:1000},(_,i)=>[Math.floor(time/300000)*300000-i*300000,199,199,199,199].map(String))}};
  if(u.searchParams.get('interval')==='60')return {retCode:0,time,result:{category:'linear',symbol,list:dailyBars(time,3600000).reverse().map(b=>[b.t,b.o,b.h,b.l,b.c,b.v].map(String))}};
  throw Error('Unexpected request '+url);
};
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),map:m};};
const locks=()=>{let chain=Promise.resolve();return {request:(key,fn)=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;}};};
const root=()=>{const nodes=new Map();return {innerHTML:'',querySelector:k=>{if(!nodes.has(k))nodes.set(k,{classList:{add(){},remove(){}},style:{}});return nodes.get(k);}};};

test('the mounted floor opens one position per desk from Bybit-shaped data, pauses, settles risk in turns and resets with an archive',async()=>{
  const s=storage(),r=root(),runtime={at:TIME,user:'one',active:true,urls:[]};
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,isVisible:()=>false,grab:fakeGrab(runtime),storage:s,locks:locks(),now:()=>runtime.at,confirm:()=>true});
  await ui.refresh();
  const firm=readFirm(s,firmKey('one'),TIME);
  assert.deepEqual(heldSymbols(firm),[...FLOOR.desks]);
  for(const symbol of FLOOR.desks)assert.equal(firm.desks[symbol].sleeves.find(x=>x.position).symbol,symbol);
  assert.match(r.querySelector('[data-floor-status]').textContent,/Firman handlar · 6 av 6 bord i affär/);
  assert.equal(readEquity(s,equityKey('one')).length,1);
  await ui.togglePause();
  assert.equal(readFirm(s,firmKey('one'),TIME).paused,true);assert.match(r.querySelector('[data-floor-pause]').textContent,/Återuppta/);
  assert.match(r.querySelector('[data-floor-status]').textContent,/Nya köp pausade/);
  runtime.at=TIME+6000;runtime.urls.length=0;await ui.refreshLive();
  const riskCalls=runtime.urls.filter(u=>u.pathname.endsWith('/mark-price-kline'));
  assert.equal(riskCalls.length,1,'one desk is settled per live cycle');
  assert.equal(runtime.urls.filter(u=>u.pathname.endsWith('/tickers')).length,7);
  runtime.at=TIME+12000;runtime.urls.length=0;await ui.refreshLive();
  assert.notEqual(runtime.urls.find(u=>u.pathname.endsWith('/mark-price-kline')).searchParams.get('symbol'),riskCalls[0].searchParams.get('symbol'));
  ui.pick({kind:'desk',id:'BTC'});
  assert.match(r.querySelector('[data-floor-panel]').innerHTML,/LONG/);assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Lucas · Leo · Mateo · Vincent/);
  ui.pick({kind:'room',id:'manuel'});assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Risk/);
  ui.pick({kind:'screen',id:'equity'});assert.match(r.querySelector('[data-floor-modal-body]').innerHTML,/Kapital · live/);
  const before=s.getItem(firmKey('one'));
  await ui.reset();
  const fresh=readFirm(s,firmKey('one'),TIME);
  assert.equal(heldSymbols(fresh).length,0);assert.equal(fresh.paused,false);
  assert.equal(s.getItem(firmKey('one')+':before-reset:'+runtime.at),before);assert.equal(s.getItem(equityKey('one')),'[]');
  runtime.user=null;await ui.refreshLive();assert.match(r.querySelector('[data-floor-status]').textContent,/Logga in/);
});

test('changing users hides the previous desk and modal and news links reject scripts',async()=>{
  const r=root(),s=storage(),runtime={at:TIME,user:'one',active:true},shown=new Set();
  r.querySelector('[data-floor-modal]').classList={add:x=>shown.add(x),remove:x=>shown.delete(x)};
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>true,storage:s,locks:locks(),now:()=>runtime.at,
    grab:fakeGrab(runtime),getNews:()=>({items:[{title:'Unsafe',ts:TIME,link:'javascript:alert(1)'},{title:'Safe',ts:TIME,link:'https://example.com/news'}]})});
  await ui.refresh();ui.pick({kind:'desk',id:'BTC'});ui.pick({kind:'screen',id:'news'});
  assert.equal(r.querySelector('[data-floor-panel]').hidden,false);assert.ok(shown.has('show'));
  assert.doesNotMatch(r.querySelector('[data-floor-modal-body]').innerHTML,/javascript:/);
  assert.match(r.querySelector('[data-floor-modal-body]').innerHTML,/https:\/\/example.com\/news/);
  runtime.user='two';await ui.refreshLive();
  assert.equal(r.querySelector('[data-floor-panel]').hidden,true);assert.equal(shown.has('show'),false);
});

test('a failed firm write leaves no in-memory trade and the status says why',async()=>{
  const s=storage(),r=root(),runtime={at:TIME,user:'one',active:true};
  const save=s.setItem;s.setItem=(k,v)=>{if(k===firmKey('one'))throw Error('storage full');save(k,v);};
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,isVisible:()=>false,grab:fakeGrab(runtime),storage:s,locks:locks(),now:()=>runtime.at});
  await ui.refresh();
  assert.equal(s.getItem(firmKey('one')),null);assert.equal(r.querySelector('[data-floor-status]').textContent,'Handeln väntar: storage full');
  ui.pick({kind:'desk',id:'SHIB'});assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Väntar på timsignal/);assert.doesNotMatch(r.querySelector('[data-floor-panel]').innerHTML,/LONG/);
  runtime.active=false;s.setItem=save;runtime.at=TIME+70000;await ui.refresh();
  assert.equal(s.getItem(firmKey('one')),null,'inactive pages fetch nothing');
});

test('the office renderer runs on desktop and mobile and reopening cannot double the animation loop',()=>{
  const r=root(),frames=[],canvas=r.querySelector('[data-floor-canvas]');let draws=0;
  const ctx={measureText:s=>({width:String(s).length*6}),
    createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}})};
  for(const method of ['beginPath','moveTo','lineTo','closePath','fill','stroke','fillRect','roundRect','arc','ellipse','fillText','setLineDash','save','restore','rect','clip','strokeRect','setTransform','transform']){
    ctx[method]=(...args)=>{for(const arg of args)if(typeof arg==='number')assert.ok(Number.isFinite(arg),method+' has a finite coordinate');if(method==='setTransform')draws++;};
  }
  Object.assign(canvas,{clientWidth:1440,clientHeight:900,getContext:()=>ctx});
  const ui=mountFloor(r,{getUser:()=> 'one',isActive:()=>false,isVisible:()=>true,grab:async()=>{},storage:storage(),now:()=>TIME,raf:fn=>frames.push(fn)});
  ui.show();ui.hide();ui.show();assert.equal(frames.length,2);
  frames.shift()();assert.equal(frames.length,1,'old callback cannot schedule a second loop');assert.equal(draws,0);
  frames.shift()();assert.equal(frames.length,1);assert.ok(draws>0);
  canvas.clientWidth=390;canvas.clientHeight=700;frames.shift()();assert.equal(frames.length,1);
  assert.equal(canvas.width,390);assert.equal(canvas.height,700);
  ui.hide();frames.shift()();assert.equal(frames.length,0);
});

test('celebrations follow open return thresholds, downgrade and stop on close or stale quotes',()=>{
  const desk={status:'trade',pnl:1000,openReturn:.1999,celebrationUntil:TIME+15000};
  for(const [value,mode] of [[.1999,null],[.2,'money'],[.4999,'money'],[.5,'lounge'],[.8,'lounge'],[.3,'money'],[.19,null],[-.2,null],[null,null],[NaN,null],[Infinity,null]]){
    assert.equal(deskCelebration({...desk,openReturn:value},TIME),mode);
  }
  assert.equal(deskCelebration({...desk,openReturn:1,status:'waiting'},TIME),null);
  assert.equal(deskCelebration({...desk,openReturn:1},TIME+15001),null);
  assert.equal(deskCelebration({...desk,openReturn:1},TIME+15000),'lounge');
  assert.equal(deskCelebration({...desk,openReturn:1,celebrationUntil:undefined},TIME),null);
});

test('all four traders jump on their own table and recline without changing simulation state',()=>{
  const agents=createAgents(seeded()),before=structuredClone(agents);
  for(const a of agents){
    const pose=celebrationPose(a,'money',TIME);
    if(a.kind==='staff'){assert.equal(pose,null);continue;}
    const d=DESK_GEOMETRY.find(d=>d.symbol===a.desk);
    assert.ok(pose.x>d.x0&&pose.x<d.x1&&pose.y>d.y0&&pose.y<d.y1);assert.ok(pose.z>=24&&pose.z<=34);
    const lounge=celebrationPose(a,'lounge',TIME);
    assert.equal(lounge.x,a.home.x);assert.equal(lounge.y,a.home.y);assert.ok(Math.abs(lounge.lean)>.2);
    assert.equal(celebrationPose(a,null,TIME),null);
    assert.deepEqual(celebrationPose(a,'money',TIME,true),celebrationPose(a,'money',TIME+1234,true));
  }
  assert.deepEqual(agents,before);
});

test('live quotes drive cash guns and bags, then remove them on falling profit, stale prices and trade close',async()=>{
  const s=storage(),runtime={at:TIME,user:'one',active:true};
  const local=mountFloor(root(),{getUser:()=>runtime.user,isActive:()=>true,grab:fakeGrab(runtime),storage:s,locks:locks(),now:()=>runtime.at});
  await local.refresh();let firm=readFirm(s,firmKey('one'),TIME),emit;
  const r=root(),frames=[],paint=[];
  const ctx={measureText:s=>({width:String(s).length*6}),createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}})};
  for(const method of ['beginPath','moveTo','lineTo','closePath','fill','stroke','fillRect','roundRect','arc','ellipse','fillText','setLineDash','save','restore','rect','clip','strokeRect','setTransform','transform']){
    ctx[method]=(...args)=>{for(const arg of args)if(typeof arg==='number')assert.ok(Number.isFinite(arg),method);if(method==='fill')paint.push(ctx.fillStyle);};
  }
  Object.assign(r.querySelector('[data-floor-canvas]'),{clientWidth:1440,clientHeight:900,getContext:()=>ctx});
  let quote=199;
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>true,isVisible:()=>true,now:()=>runtime.at,raf:fn=>frames.push(fn),storage:s,
    cloud:{available:()=>true,subscribe:(_,cb)=>{emit=()=>cb({firm,equity:[]});queueMicrotask(emit);return ()=>{};}},
    grab:async url=>reply(new URL(url).searchParams.get('symbol'),runtime.at,quote)});
  ui.show();await Promise.resolve();
  const draw=()=>{paint.length=0;frames.shift()();return {guns:paint.filter(c=>c==='#d8b35d').length,bags:paint.filter(c=>c==='#b49455').length};};
  const expect=async(price,mode)=>{quote=price;runtime.at+=6000;await ui.refreshLive();const p=draw();assert.equal(p.guns,mode==='money'?24:0);assert.equal(p.bags,mode==='lounge'?24:0);};
  await expect(199,null);await expect(201,'money');await expect(205,'lounge');await expect(201,'money');await expect(199,null);
  await expect(205,'lounge');runtime.at+=15001;assert.deepEqual(draw(),{guns:0,bags:0});
  await expect(201,'money');firm=newFirm(runtime.at);emit();assert.deepEqual(draw(),{guns:0,bags:0});
  ui.hide();
});
