import test from 'node:test';
import assert from 'node:assert/strict';
import {FLOOR,ROOMS,newFirm,validateFirm,readFirm,upgradeStoredFirm,isLegacyFirm,firmKey,equityKey,needsHourly,advanceFirm,advanceFirmRisk,closeFirmDesk,setFirmPaused,heldSymbols,firmLive,firmStats,sampleEquity,readEquity,riskRows,floorNarrative,traderNames,dayStart} from '../trading-floor.js';
import {TREND,trendCount,trendLiquidation} from '../floor-trend.js';
import {clearTrendCache} from '../floor-trend-market.js';
import {AISLES,ROOM_GEOMETRY,DESK_GEOMETRY,FIKA,allLocations,onNetwork,routeBetween,routeTo,createAgents,stepAgents,REGIONS,hitAt,project,SCREENS,deskCelebration,celebrationPose,deskTradeLabel} from '../trading-floor-scene.js';
import {mountFloor} from '../trading-floor-ui.js';
import {TIME,HOUR,unitBars,extendUnit,trendSnapshot,withRisk,riskSnapshot,fakeBybit,coinBars} from './floor-fixtures.mjs';

const near=(a,b,eps=1e-7)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const seeded=()=>{let seed=7;return ()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};};
const UNIT=unitBars(TIME),SLIDE=unitBars(TIME,{rally:false});
// A reset firm switches every trend off at TIME; the rally's next close above every channel buys all six desks.
const BUY=TIME+HOUR,UP=extendUnit(UNIT,1.001);
const armed=()=>advanceFirm(newFirm(TIME),trendSnapshot(TIME,UNIT),TIME);
const holding=()=>advanceFirm(armed(),trendSnapshot(BUY,UP),BUY);
// A 28 % crash is far below every trend stop, so at 150× it liquidates every desk.
const CRASH=.72;
// The hour after the buy, with the latest close moved by `factor` for every coin.
const nextHour=(firm,factor,time=BUY+HOUR)=>withRisk(firm,trendSnapshot(time,extendUnit(UP,factor)),time);

test('a new firm has six trend desks with 100 dollars each and trading enabled',()=>{
  const firm=newFirm(TIME);
  assert.deepEqual([...FLOOR.desks],['BTC','ETH','SOL','XRP','DOGE','SHIB']);assert.deepEqual(Object.keys(firm.desks),[...FLOOR.desks]);
  for(const s of FLOOR.desks){const d=firm.desks[s];assert.equal(d.enabled,true);assert.equal(d.cash,100);assert.equal(d.position,null);assert.equal(d.version,TREND.version);assert.equal(d.signal.through,null);}
  assert.equal(firm.paused,false);assert.equal(validateFirm(firm),firm);
  assert.deepEqual(readFirm({getItem:()=>null},'k',TIME),firm);
  assert.throws(()=>validateFirm({...firm,version:'x'}),/Ogiltig/);
  assert.throws(()=>validateFirm({...firm,version:'trading-floor-v4'}),/Golvet har uppdaterats \(trading-floor-v4\)\. Ladda om sidan/);
  assert.throws(()=>validateFirm({...firm,desks:{...firm.desks,BTC:{...firm.desks.BTC,enabled:false}}}),/handelsläge/);
  assert.throws(()=>newFirm(0));
  assert.equal(firmKey('a b'),'riptide.floor.v1:a%20b');assert.equal(equityKey('a'),'riptide.floor.v1:a:equity');
});

test('older firms are archived with their curve and replaced by fresh desks whose trends start off',()=>{
  for(const [version,tag,paused] of [['trading-floor-v1','before-trend',false],['trading-floor-v2','before-max',true]]){
    const m=new Map(),s={getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)},legacy=JSON.stringify({version,createdAt:TIME-1e6,paused,desks:{}});
    m.set('k',legacy);m.set('k:equity','[{"t":1,"v":600}]');
    assert.equal(isLegacyFirm(JSON.parse(legacy)),true);
    assert.equal(readFirm(s,'k',TIME).version,FLOOR.version,'a legacy firm reads as a fresh firm');
    assert.equal(upgradeStoredFirm(s,'k','k:equity',TIME),true);
    assert.equal(m.get('k:'+tag+':'+TIME),legacy);assert.equal(m.get('k:equity:'+tag+':'+TIME),'[{"t":1,"v":600}]');
    const fresh=readFirm(s,'k',TIME);
    assert.equal(m.get('k:equity'),'[]');assert.equal(fresh.paused,paused,'the pause carries over');
    assert.ok(FLOOR.desks.every(x=>fresh.desks[x].cash===100&&fresh.desks[x].signal.through===null&&fresh.desks[x].position===null));
    assert.equal(upgradeStoredFirm(s,'k','k:equity',TIME+1),false,'only once');
  }
  assert.equal(upgradeStoredFirm({getItem:()=>null},'k','k:equity',TIME),false);
});

test('a reset firm starts with every trend off, then each desk buys its own coin at Bybit\'s maximum on the next breakout',()=>{
  const firm=newFirm(TIME),copy=structuredClone(firm);
  assert.equal(needsHourly(firm,TIME),true);
  const start=armed();
  assert.deepEqual(firm,copy,'advancing never mutates the input');
  assert.equal(heldSymbols(start).length,0);assert.equal(needsHourly(start,TIME+1000),false);assert.equal(needsHourly(start,BUY),true);
  assert.ok(FLOOR.desks.every(s=>start.desks[s].decisions[0].action==='start'&&trendCount(start.desks[s].signal)===0));
  const next=holding();
  assert.deepEqual(heldSymbols(next),[...FLOOR.desks]);assert.equal(needsHourly(next,BUY+1000),false);
  for(const s of FLOOR.desks){
    const d=next.desks[s];
    assert.equal(trendCount(d.signal),TREND.lookbacks.length,s+' sees every horizon break out');
    assert.equal(d.decisions.length,2);assert.equal(d.decisions[1].action,'köp');assert.equal(d.decisions[1].leverage,150);
    assert.equal(d.position.leverage,150);assert.equal(d.position.maintenance,.005);assert.ok(d.position.peakExposure>130);
    near(d.position.equityAtOpen,100);
  }
  assert.equal(validateFirm(next),next);
  const again=advanceFirm(next,withRisk(next,trendSnapshot(BUY+1000,UP),BUY+1000),BUY+1000);
  for(const s of FLOOR.desks){assert.equal(again.desks[s].decisions.length,2,'no second decision in the same hour');assert.equal(again.desks[s].position.units,next.desks[s].position.units);assert.equal(again.desks[s].position.fundingThrough,BUY+1000);}
  // A sliding coin makes no new high after the reset.
  const slide=advanceFirm(newFirm(TIME),trendSnapshot(TIME,SLIDE),TIME),flat=advanceFirm(slide,trendSnapshot(BUY,extendUnit(SLIDE,.999)),BUY);
  assert.equal(heldSymbols(flat).length,0);assert.ok(FLOOR.desks.every(s=>flat.desks[s].decisions[1].action==='avvakta'));
  assert.throws(()=>advanceFirm(newFirm(TIME),{hour:TIME,market:{BTC:trendSnapshot().market.BTC}},TIME),/Timpriser saknas för ETH/);
  const swapped={...next,desks:{...next.desks,BTC:next.desks.ETH}};
  assert.throws(()=>validateFirm(swapped),/Bord BTC håller fel coin/);
});

test('pausing blocks new buys while liquidation still closes positions',()=>{
  const paused=setFirmPaused(armed(),true);
  assert.ok(FLOOR.desks.every(s=>paused.desks[s].enabled===false));
  const idle=advanceFirm(paused,trendSnapshot(BUY,UP),BUY);
  assert.equal(heldSymbols(idle).length,0);assert.ok(FLOOR.desks.every(s=>idle.desks[s].decisions.at(-1).action==='pausad'));
  assert.ok(FLOOR.desks.every(s=>trendCount(idle.desks[s].signal)===TREND.lookbacks.length),'trend states keep updating while paused');
  // Held and paused: a crash closes every desk, and at 150× the liquidation comes long before the trend stops.
  const stopped=setFirmPaused(holding(),true),out=advanceFirm(stopped,nextHour(stopped,CRASH),BUY+HOUR);
  for(const s of FLOOR.desks){
    const d=out.desks[s];assert.equal(d.position,null);assert.equal(d.trades.length,1);assert.equal(d.trades[0].reason,'likvidation');assert.equal(d.trades[0].leverage,150);
    assert.equal(d.cash,0);assert.equal(d.trades[0].pnl,-100);assert.ok(trendLiquidation(stopped.desks[s])>Math.max(...stopped.desks[s].signal.stops));
  }
  assert.equal(out.paused,true);
  // A mark wick through one desk's liquidation price closes only that desk.
  const risk=riskSnapshot(stopped,BUY+10*60000),liq=trendLiquidation(stopped.desks.SOL);
  risk.market.SOL.markBars=risk.market.SOL.markBars.map((b,i)=>i===1?{...b,l:liq*.999}:b);
  const one=advanceFirmRisk(stopped,'SOL',risk,BUY+10*60000);
  assert.equal(one.desks.SOL.trades[0].reason,'likvidation');assert.equal(one.desks.SOL.cash,0);
  for(const s of FLOOR.desks)if(s!=='SOL')assert.deepEqual(one.desks[s],stopped.desks[s]);
  assert.equal(advanceFirmRisk(one,'SOL',{market:{}},BUY+11*60000),one,'a flat desk needs no risk data');
  assert.throws(()=>advanceFirmRisk(one,'PEPE',{market:{}},BUY),/Okänt bord/);
  const resumed=setFirmPaused(out,false);assert.ok(FLOOR.desks.every(s=>resumed.desks[s].enabled));
});

test('the close button sells only the clicked desk and refuses a trade that is already closed',()=>{
  const firm=holding(),at=BUY+20*60000,p=firm.desks.ETH.position,risk=riskSnapshot(firm,at);
  const closed=closeFirmDesk(firm,'ETH',risk,at,p.openedAt);
  assert.equal(closed.desks.ETH.position,null);assert.equal(closed.desks.ETH.trades[0].reason,'manuell');
  assert.deepEqual(heldSymbols(closed),FLOOR.desks.filter(s=>s!=='ETH'));
  for(const s of FLOOR.desks)if(s!=='ETH')assert.equal(closed.desks[s],firm.desks[s]);
  assert.throws(()=>closeFirmDesk(closed,'ETH',risk,at,p.openedAt),/redan stängd/);
  assert.throws(()=>closeFirmDesk(firm,'ETH',risk,at,p.openedAt+1),/redan stängd/);
  assert.throws(()=>closeFirmDesk(firm,'PEPE',risk,at,p.openedAt),/Okänt bord/);
  assert.equal(firmStats(closed,at).desks.ETH.status,'waiting');assert.equal(firmStats(closed,at).desks.ETH.trades,1);
});

test('the big screen total sums six live desk balances and waits when a held desk lacks a fresh price',()=>{
  const fresh=firmLive(newFirm(TIME),{},TIME);
  near(fresh.total,600);near(fresh.net,0);assert.deepEqual(fresh.waiting,[]);assert.equal(fresh.start,600);
  const firm=holding(),at=BUY+5000,quotes=Object.fromEntries(FLOOR.desks.map(s=>{const p=firm.desks[s].position.entry*1.05;return [s,{price:p,mark:p,at}];}));
  const all=firmLive(firm,quotes,at);
  assert.deepEqual(all.waiting,[]);near(all.total,FLOOR.desks.reduce((sum,s)=>sum+all.desks[s].balance,0));assert.ok(all.total>600);
  assert.ok(all.desks.BTC.openNet>0);near(all.desks.BTC.openReturn,all.desks.BTC.openNet/100);assert.ok(all.desks.BTC.exposure>0);
  delete quotes.XRP;const partial=firmLive(firm,quotes,at);
  assert.equal(partial.total,null);assert.equal(partial.net,null);assert.deepEqual(partial.waiting,['XRP']);assert.ok(partial.desks.BTC.balance>0);assert.equal(partial.desks.XRP.balance,null);
  const rows=riskRows(firm,all);assert.equal(rows.length,6);
  assert.ok(rows.every(r=>r.count===TREND.lookbacks.length&&r.leverage===150&&r.toLiq>0&&r.toLiq<r.toFirst&&r.toFirst<=r.toLast),'at maximum leverage liquidation sits closer than any trend stop');
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
  const firm=holding(),time=BUY+HOUR,done=advanceFirm(firm,nextHour(firm,CRASH,time),time),stats=firmStats(done,time);
  assert.equal(stats.trades,6);assert.equal(stats.losses,6);assert.equal(stats.liquidations,6);assert.ok(stats.realized<0);near(stats.today,stats.realized);
  assert.equal(stats.desks.BTC.status,'liquidated');assert.equal(stats.inTrade,0);assert.equal(stats.desks.BTC.count,0);
  assert.equal(firmStats(setFirmPaused(done,true),time).desks.BTC.status,'liquidated','a liquidated desk stays liquidated when paused');
  assert.equal(firmStats(armed(),TIME).desks.BTC.status,'waiting');assert.equal(firmStats(setFirmPaused(armed(),true),TIME).desks.BTC.status,'paused');
  assert.equal(firmStats(firm,BUY).desks.ETH.status,'trade');assert.ok(firmStats(firm,BUY).desks.ETH.stops.first>0);
  const tomorrow=dayStart(time)+86400000+3600000;
  assert.equal(firmStats(done,tomorrow).today,0);assert.equal(dayStart(tomorrow)%1000,0);
  assert.ok(time-dayStart(time)<86400000&&time-dayStart(time)>=0);
  const text=floorNarrative(done,firmLive(done,{},time),stats,time);
  assert.match(text,/Inga bord är i affär just nu/);assert.match(text,/6 avslutade affärer sedan start: 0 vinster, 6 förluster, 6 likvidationer/);assert.match(text,/nio trender/);
  assert.match(text,/Likviderade: BTC, ETH, SOL, XRP, DOGE, SHIB\./);assert.match(text,/Bybits maxhävstång/);
  const quotes=Object.fromEntries(FLOOR.desks.map(s=>{const p=firm.desks[s].position.entry;return [s,{price:p,mark:p,at:BUY}];}));
  assert.match(floorNarrative(firm,firmLive(firm,quotes,BUY),firmStats(firm,BUY),BUY),/6 av 6 bord sitter i affär: BTC .*9 av 9 trender, 150× hävstång, 0,\d % till likvidation/);
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
  const firm=holding();
  const quotes=Object.fromEntries(FLOOR.desks.map((s,i)=>{const p=firm.desks[s].position.entry;return [s,{price:p,mark:p,at:BUY+i*1000}];}));
  assert.equal(firmLive(firm,quotes,BUY+10000).at,BUY);
  delete quotes.BTC;assert.equal(firmLive(firm,quotes,BUY+10000).at,null);
});

test('old hourly decisions are trimmed so six desks stay small in storage',()=>{
  let firm=holding();const desk=firm.desks.BTC,n=FLOOR.decisionLimit+20,last=desk.decisions.at(-1);
  desk.decisions=[...Array.from({length:n-1},(_,i)=>({...last,hour:BUY-(n-1-i)*HOUR,at:BUY-(n-1-i)*HOUR+1000})),last];
  validateFirm(firm);
  const next=advanceFirm(firm,nextHour(firm,1.001),BUY+HOUR);
  assert.equal(next.desks.BTC.decisions.length,FLOOR.decisionLimit);assert.equal(next.desks.BTC.decisions.at(-1).hour,BUY+HOUR);
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

test('Manuel follows the news while Miguel visits the desk at risk',()=>{
  const staff=createAgents(seeded()).filter(a=>a.room==='manuel'||a.room==='miguel');
  stepAgents(staff,{inTrade:{BTC:true},riskDesk:'BTC',reduced:true},TIME,.1,()=>.5);
  const manuel=staff.find(a=>a.room==='manuel'),miguel=staff.find(a=>a.room==='miguel');
  assert.equal(ROOMS.find(r=>r.id==='manuel').role,'Makro & nyheter');
  assert.equal(ROOMS.find(r=>r.id==='miguel').role,'Risk');
  assert.equal(manuel.activity,'news');assert.equal(manuel.at.kind,'news');
  assert.equal(miguel.activity,'visit');assert.equal(miguel.at.key,'visit:BTC');
});

test('clickable regions cover the desks, rooms, screens and the coffee corner',()=>{
  const regions=REGIONS();
  for(const d of DESK_GEOMETRY){const p=project(d.x0+0.75,d.y0+2,10),hit=hitAt(p.x,p.y,regions);assert.equal(hit?.kind,'desk');assert.equal(hit.id,d.symbol);}
  for(const r of ROOM_GEOMETRY){const p=project(2,r.y0+2,30),hit=hitAt(p.x,p.y,regions);assert.equal(hit?.kind,'room');assert.equal(hit.id,r.id);}
  for(const [id,s] of Object.entries(SCREENS)){const p=project((s.x0+s.x1)/2,0,(s.top+s.bottom)/2);assert.equal(hitAt(p.x,p.y,regions)?.id,id);}
  const f=project(FIKA.table.x,FIKA.table.y,5);assert.equal(hitAt(f.x,f.y,regions)?.kind,'fika');
  assert.equal(hitAt(5,5,regions),null);
});

const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),map:m};};
const locks=()=>{let chain=Promise.resolve();return {request:(key,fn)=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;}};};
const root=()=>{const nodes=new Map();return {innerHTML:'',querySelector:k=>{if(!nodes.has(k))nodes.set(k,{classList:{add(){},remove(){}},style:{}});return nodes.get(k);}};};
const bybit=runtime=>{const grab=fakeBybit(runtime);return async(url,o)=>{if(runtime.fail)throw Error('offline');return grab(url,o);};};

test('the mounted floor buys on every desk from Bybit-shaped data, pauses, settles risk in turns and resets with an archive',async()=>{
  clearTrendCache();
  const s=storage(),r=root(),runtime={at:TIME,user:'one',active:true,urls:[],unit:UNIT};
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,isVisible:()=>false,grab:bybit(runtime),storage:s,locks:locks(),now:()=>runtime.at,confirm:()=>true});
  await ui.refresh();
  let firm=readFirm(s,firmKey('one'),TIME);
  assert.equal(heldSymbols(firm).length,0);assert.ok(FLOOR.desks.every(x=>firm.desks[x].decisions[0].action==='start'));
  assert.match(r.querySelector('[data-floor-status]').textContent,/Firman handlar · 0 av 6 bord i affär/);
  // Next hour the rally makes a new high: every desk buys with Bybit's limits from the API.
  runtime.at=BUY;runtime.unit=UP;await ui.refresh();
  firm=readFirm(s,firmKey('one'),BUY);
  assert.deepEqual(heldSymbols(firm),[...FLOOR.desks]);assert.ok(FLOOR.desks.every(x=>firm.desks[x].position.leverage===150));
  assert.ok(runtime.urls.some(u=>u.pathname.endsWith('/risk-limit')),'a flat desk loads its limits before the decision');
  assert.match(r.querySelector('[data-floor-status]').textContent,/Firman handlar · 6 av 6 bord i affär/);
  assert.equal(readEquity(s,equityKey('one')).length,2);
  // Decided for this hour: another refresh a minute later fetches no candles.
  runtime.urls.length=0;runtime.at=BUY+61000;await ui.refresh();
  assert.equal(runtime.urls.filter(u=>u.pathname.endsWith('/kline')).length,0);
  await ui.togglePause();
  assert.equal(readFirm(s,firmKey('one'),BUY).paused,true);assert.match(r.querySelector('[data-floor-pause]').textContent,/Återuppta/);
  assert.match(r.querySelector('[data-floor-status]').textContent,/Nya köp pausade/);
  runtime.at=BUY+66000;runtime.urls.length=0;await ui.refreshLive();
  const riskCalls=runtime.urls.filter(u=>u.pathname.endsWith('/mark-price-kline'));
  assert.equal(riskCalls.length,1,'one desk is settled per live cycle');
  assert.equal(runtime.urls.filter(u=>u.pathname.endsWith('/tickers')).length,7);
  runtime.at=BUY+72000;runtime.urls.length=0;await ui.refreshLive();
  assert.notEqual(runtime.urls.find(u=>u.pathname.endsWith('/mark-price-kline')).searchParams.get('symbol'),riskCalls[0].searchParams.get('symbol'));
  ui.pick({kind:'desk',id:'BTC'});
  const desk=r.querySelector('[data-floor-panel]').innerHTML;
  assert.match(desk,/LONG · 150× hävstång/);assert.match(desk,/Lucas · Leo · Mateo · Vincent/);assert.match(desk,/Trender · 9 av 9 uppåt/);assert.match(desk,/class="on"[^>]*>360d/);
  assert.match(desk,/Till likvidation/);assert.match(desk,/data-floor-close="BTC"/);assert.match(desk,/>Stäng trade</);
  ui.pick({kind:'room',id:'miguel'});assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Miguel · Risk/);assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Närmast likvidation/);
  ui.pick({kind:'room',id:'manuel'});assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Manuel · Makro & nyheter/);assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Kryptobias i flödet/);
  ui.pick({kind:'room',id:'pablo'});assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Pablo · Analys/);
  ui.pick({kind:'screen',id:'equity'});assert.match(r.querySelector('[data-floor-modal-body]').innerHTML,/Kapital · live/);
  const before=s.getItem(firmKey('one'));
  await ui.reset();
  const fresh=readFirm(s,firmKey('one'),TIME);
  assert.equal(heldSymbols(fresh).length,0);assert.equal(fresh.paused,false);
  assert.equal(s.getItem(firmKey('one')+':before-reset:'+runtime.at),before);assert.equal(s.getItem(equityKey('one')),'[]');
  runtime.user=null;await ui.refreshLive();assert.match(r.querySelector('[data-floor-status]').textContent,/Logga in/);
});

test('Stäng trade in the desk panel sells that desk at the market price after a confirm',async()=>{
  clearTrendCache();
  const s=storage(),r=root(),runtime={at:TIME,user:'one',active:true,urls:[],unit:UNIT},asked=[];let answer=true;
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>true,isVisible:()=>false,grab:bybit(runtime),storage:s,locks:locks(),now:()=>runtime.at,confirm:m=>{asked.push(m);return answer;}});
  await ui.refresh();runtime.at=BUY;runtime.unit=UP;await ui.refresh();
  let firm=readFirm(s,firmKey('one'),BUY);const p=firm.desks.BTC.position;
  ui.pick({kind:'desk',id:'BTC'});
  assert.match(r.querySelector('[data-floor-panel]').innerHTML,new RegExp('data-floor-close="BTC" data-floor-opened="'+p.openedAt+'"'));
  // Twenty minutes later the price is 0.2 % above the buy's quote.
  runtime.at=BUY+20*60000;runtime.price={BTC:p.entry/(1+TREND.slip)*1.002};
  answer=false;await ui.closeTrade('BTC',p.openedAt);
  assert.ok(readFirm(s,firmKey('one'),runtime.at).desks.BTC.position,'a cancelled confirm keeps the trade');
  answer=true;await ui.closeTrade('BTC',p.openedAt);
  firm=readFirm(s,firmKey('one'),runtime.at);
  assert.match(asked[0],/Stäng BTC-traden till marknadspris/);
  const trade=firm.desks.BTC.trades.at(-1);
  assert.equal(firm.desks.BTC.position,null);assert.equal(trade.reason,'manuell');near(trade.exit,runtime.price.BTC*(1-TREND.slip),1e-6);
  assert.deepEqual(heldSymbols(firm),FLOOR.desks.filter(x=>x!=='BTC'),'only the clicked desk closes');
  const panel=r.querySelector('[data-floor-panel]').innerHTML;
  assert.match(panel,/BTC stängd/);assert.match(panel,/Stängd manuellt/);assert.doesNotMatch(panel,/data-floor-close/);
  // A second click on the closed trade does nothing.
  const before=s.getItem(firmKey('one'));await ui.closeTrade('BTC',p.openedAt);assert.equal(s.getItem(firmKey('one')),before);
});

test('an older firm in this browser is archived and replaced before the first decision',async()=>{
  clearTrendCache();
  const s=storage(),r=root(),runtime={at:TIME,user:'one',active:true,urls:[],unit:UNIT},legacy=JSON.stringify({version:'trading-floor-v2',createdAt:TIME-1e6,paused:false,desks:{}});
  s.setItem(firmKey('one'),legacy);s.setItem(equityKey('one'),'[{"t":1,"v":590}]');
  const ui=mountFloor(r,{getUser:()=>'one',isActive:()=>true,isVisible:()=>false,grab:bybit(runtime),storage:s,locks:locks(),now:()=>runtime.at});
  await ui.refresh();
  assert.equal(s.getItem(firmKey('one')+':before-max:'+TIME),legacy);assert.equal(s.getItem(equityKey('one')+':before-max:'+TIME),'[{"t":1,"v":590}]');
  const fresh=readFirm(s,firmKey('one'),TIME);
  assert.equal(heldSymbols(fresh).length,0);assert.ok(FLOOR.desks.every(x=>fresh.desks[x].decisions[0].action==='start'),'the new desks start with every trend off');
});

test('changing users hides the previous desk and modal and news links reject scripts',async()=>{
  clearTrendCache();
  const r=root(),s=storage(),runtime={at:TIME,user:'one',active:true,urls:[],unit:UNIT},shown=new Set();
  r.querySelector('[data-floor-modal]').classList={add:x=>shown.add(x),remove:x=>shown.delete(x)};
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>true,storage:s,locks:locks(),now:()=>runtime.at,
    grab:bybit(runtime),getNews:()=>({items:[{title:'Unsafe',ts:TIME,link:'javascript:alert(1)'},{title:'Safe',ts:TIME,link:'https://example.com/news'}]})});
  await ui.refresh();ui.pick({kind:'desk',id:'BTC'});ui.pick({kind:'screen',id:'news'});
  assert.equal(r.querySelector('[data-floor-panel]').hidden,false);assert.ok(shown.has('show'));
  assert.doesNotMatch(r.querySelector('[data-floor-modal-body]').innerHTML,/javascript:/);
  assert.match(r.querySelector('[data-floor-modal-body]').innerHTML,/https:\/\/example.com\/news/);
  runtime.user='two';await ui.refreshLive();
  assert.equal(r.querySelector('[data-floor-panel]').hidden,true);assert.equal(shown.has('show'),false);
});

test('a failed firm write leaves no in-memory trade and the status says why',async()=>{
  clearTrendCache();
  const s=storage(),r=root(),runtime={at:TIME,user:'one',active:true,urls:[],unit:UNIT};
  const save=s.setItem;s.setItem=(k,v)=>{if(k===firmKey('one'))throw Error('storage full');save(k,v);};
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,isVisible:()=>false,grab:bybit(runtime),storage:s,locks:locks(),now:()=>runtime.at});
  await ui.refresh();
  assert.equal(s.getItem(firmKey('one')),null);assert.equal(r.querySelector('[data-floor-status]').textContent,'Handeln väntar: storage full');
  ui.pick({kind:'desk',id:'SHIB'});assert.match(r.querySelector('[data-floor-panel]').innerHTML,/Väntar på att en ny trend ska slå på/);assert.doesNotMatch(r.querySelector('[data-floor-panel]').innerHTML,/LONG/);
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

test('celebrations follow current trade return thresholds, downgrade and stop on close or stale quotes',()=>{
  const desk={status:'trade',pnl:1000,openReturn:.1999,celebrationUntil:TIME+15000};
  assert.equal(deskCelebration({...desk,pnl:1000,openReturn:.1},TIME),null,'previous wins must not trigger a celebration at 10% on the current trade');
  for(const [value,mode] of [[.1999,null],[.2,'money'],[.4999,'money'],[.5,'lounge'],[.8,'lounge'],[.3,'money'],[.19,null],[-.2,null],[null,null],[NaN,null],[Infinity,null]]){
    assert.equal(deskCelebration({...desk,openReturn:value},TIME),mode);
  }
  assert.equal(deskCelebration({...desk,openReturn:1,status:'waiting'},TIME),null);
  assert.equal(deskCelebration({...desk,openReturn:1},TIME+15001),null);
  assert.equal(deskCelebration({...desk,openReturn:1},TIME+15000),'lounge');
  assert.equal(deskCelebration({...desk,openReturn:1,celebrationUntil:undefined},TIME),null);
});

test('the desk label shows current trade percent and shares freshness and thresholds with celebrations',()=>{
  const desk={status:'trade',pnl:1000,openReturn:.1,celebrationUntil:TIME+15000};
  assert.equal(deskTradeLabel(desk,TIME),'+10,00 % nu');assert.equal(deskCelebration(desk,TIME),null);
  assert.equal(deskTradeLabel({...desk,openReturn:.19999},TIME),'+19,99 % nu');
  assert.equal(deskTradeLabel({...desk,openReturn:.5},TIME),'+50,00 % nu');
  assert.equal(deskTradeLabel({...desk,openReturn:-.1},TIME),'-10,00 % nu');
  assert.equal(deskTradeLabel(desk,TIME+15001),'väntar på pris');
  assert.equal(deskTradeLabel({...desk,status:'waiting'},TIME),'väntar trend');assert.equal(deskTradeLabel({...desk,status:'loading'},TIME),'laddar…');assert.equal(deskTradeLabel({...desk,status:'paused'},TIME),'pausad');
  assert.equal(deskTradeLabel({...desk,status:'liquidated'},TIME),'likviderad');
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
  clearTrendCache();
  const s=storage(),runtime={at:TIME,user:'one',active:true,urls:[],unit:UNIT};
  const local=mountFloor(root(),{getUser:()=>runtime.user,isActive:()=>true,grab:bybit(runtime),storage:s,locks:locks(),now:()=>runtime.at});
  await local.refresh();runtime.at=BUY;runtime.unit=UP;await local.refresh();let firm=readFirm(s,firmKey('one'),BUY),emit;
  assert.deepEqual(heldSymbols(firm),[...FLOOR.desks]);
  const r=root(),frames=[],paint=[];
  const ctx={measureText:s=>({width:String(s).length*6}),createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}})};
  for(const method of ['beginPath','moveTo','lineTo','closePath','fill','stroke','fillRect','roundRect','arc','ellipse','fillText','setLineDash','save','restore','rect','clip','strokeRect','setTransform','transform']){
    ctx[method]=(...args)=>{for(const arg of args)if(typeof arg==='number')assert.ok(Number.isFinite(arg),method);if(method==='fill')paint.push(ctx.fillStyle);};
  }
  Object.assign(r.querySelector('[data-floor-canvas]'),{clientWidth:1440,clientHeight:900,getContext:()=>ctx});
  // Price factors on the entry that give each desk's open trade +30 % or +80 % of its starting capital
  // after closing costs; every desk bought the same 150× notional, so one factor fits all six.
  const p=firm.desks.BTC.position,cash=firm.desks.BTC.cash,quote={factor:1};
  const move=gain=>(p.equityAtOpen*(1+gain)-cash)/(p.units*p.entry*(1-TREND.slip)*(1-TREND.fee));
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>true,isVisible:()=>true,now:()=>runtime.at,raf:fn=>frames.push(fn),storage:s,
    cloud:{available:()=>true,subscribe:(_,cb)=>{emit=()=>cb({firm,equity:[]});queueMicrotask(emit);return ()=>{};}},
    grab:async(url,o)=>{runtime.price=Object.fromEntries(FLOOR.desks.map(d=>[d,firm.desks[d].position?firm.desks[d].position.entry*quote.factor:1]));return fakeBybit(runtime)(url,o);}});
  ui.show();await Promise.resolve();
  const draw=()=>{paint.length=0;frames.shift()();return {guns:paint.filter(c=>c==='#d8b35d').length,bags:paint.filter(c=>c==='#b49455').length};};
  const expect=async(factor,mode)=>{
    quote.factor=factor;runtime.at+=6000;
    // The cloud keeps each desk's funding check current; mirror that for the live value.
    firm={...firm,desks:Object.fromEntries(FLOOR.desks.map(d=>[d,firm.desks[d].position?{...firm.desks[d],position:{...firm.desks[d].position,fundingThrough:runtime.at}}:firm.desks[d]]))};emit();
    await ui.refreshLive();const p=draw();
    assert.equal(p.guns,mode==='money'?24:0,'guns at '+factor);assert.equal(p.bags,mode==='lounge'?24:0,'bags at '+factor);
  };
  await expect(1,null);await expect(move(.3),'money');await expect(move(.8),'lounge');await expect(move(.3),'money');await expect(1,null);
  await expect(move(.8),'lounge');runtime.at+=15001;assert.deepEqual(draw(),{guns:0,bags:0});
  await expect(move(.3),'money');firm=newFirm(runtime.at);emit();assert.deepEqual(draw(),{guns:0,bags:0});
  ui.hide();
});
