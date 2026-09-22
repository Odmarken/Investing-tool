import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMomentum} from '../crypto-momentum-ui.js';
import {mountFloor} from '../trading-floor-ui.js';
import {newActiveAccount,readActiveAccount} from '../crypto-momentum-active.js';
import {FLOOR,readFirm,firmKey,equityKey,heldSymbols,newFirm,setFirmPaused} from '../trading-floor.js';
import {createCamera,CANVAS} from '../trading-floor-scene.js';

const TIME=Date.parse('2026-09-22T12:00:00Z');
const dailyBars=(time,step)=>Array.from({length:100},(_,i)=>{const t=Math.floor(time/step)*step-(99-i)*step,c=100+i;return {t,o:c,h:c+1,l:c-1,c,v:1};});
const fakeGrab=runtime=>async url=>{
  const u=new URL(url),symbol=u.searchParams.get('symbol'),time=runtime.at;runtime.urls.push(u);
  if(u.pathname.endsWith('/tickers'))return {retCode:0,time,result:{category:'linear',list:[{symbol,lastPrice:'199',markPrice:'199',nextFundingTime:String((Math.floor(time/28800000)+1)*28800000)}]}};
  if(u.pathname.endsWith('/instruments-info'))return {retCode:0,time,result:{category:'linear',list:[{symbol,fundingInterval:'480',status:'Trading',contractType:'LinearPerpetual',quoteCoin:'USDT',settleCoin:'USDT',leverageFilter:{minLeverage:'1',maxLeverage:'150',leverageStep:'.01'}}]}};
  if(u.pathname.endsWith('/risk-limit'))return {retCode:0,time,result:{category:'linear',list:[{id:1,symbol,riskLimitValue:'10000000',maxLeverage:'150',maintenanceMargin:'.005',mmDeduction:''}]}};
  if(u.pathname.endsWith('/funding/history'))return {retCode:0,time,result:{category:'linear',list:Array.from({length:10},(_,i)=>({symbol,fundingRate:'0',fundingRateTimestamp:String(Math.floor(time/28800000)*28800000-i*28800000)}))}};
  if(u.pathname.endsWith('/mark-price-kline'))return {retCode:0,time,result:{category:'linear',symbol,list:Array.from({length:1000},(_,i)=>[Math.floor(time/300000)*300000-i*300000,199,199,199,199].map(String))}};
  if(u.searchParams.get('interval')==='60')return {retCode:0,time,result:{category:'linear',symbol,list:dailyBars(time,3600000).reverse().map(b=>[b.t,b.o,b.h,b.l,b.c,b.v].map(String))}};
  throw Error('Unexpected request '+url);
};
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),map:m};};
const locks=()=>({request:(_,fn)=>Promise.resolve(fn())});
const root=()=>{const nodes=new Map();return {innerHTML:'',querySelector:k=>{if(!nodes.has(k))nodes.set(k,{classList:{add(){},remove(){}},style:{}});return nodes.get(k);}};};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
const kinds=urls=>[...new Set(urls.map(u=>u.pathname.replace('/v5/market/','')+(u.searchParams.get('interval')==='60'?':hourly':'')))].sort();
// A cloud store like the Firestore adapters: subscribe, save (upload), archive.
function fakeCloud(){
  const store={doc:null,subs:[],saves:[],archives:[],available:true};
  const state=()=>store.doc?{...store.doc}:{missing:true};
  const emit=()=>{for(const cb of store.subs)cb(state());};
  return {store,emit,available:()=>store.available,
    subscribe(uid,cb){store.subs.push(cb);queueMicrotask(()=>{if(store.subs.includes(cb))cb(state());});return ()=>{store.subs=store.subs.filter(s=>s!==cb);};},
    async save(uid,payload){
      store.saves.push(payload);
      const prev=store.doc||{};
      store.doc=payload.sleeves?{...prev,account:payload}:{...prev,firm:payload.firm??prev.firm,equity:payload.equity??prev.equity??[]};
      store.doc.lastRun=prev.lastRun??null;store.doc.lastError=null;emit();
    },
    async initialize(uid,payload){if(!store.doc)await this.save(uid,payload);},
    async togglePause(uid){await this.save(uid,{firm:setFirmPaused(store.doc.firm,!store.doc.firm.paused)});},
    async reset(uid){await this.archive(uid,store.doc.firm,store.doc.equity);await this.save(uid,{firm:newFirm(TIME),equity:[]});},
    async archive(uid,...args){store.archives.push(args);}};
}

test('the momentum account uploads itself once, stops trading locally and toggles and resets through the cloud',async()=>{
  const s=storage(),runtime={at:TIME,user:'one',active:true,urls:[]},key='riptide.momentum.20x.v1:one';
  const local={...newActiveAccount(),enabled:true};s.setItem(key,JSON.stringify(local));
  const cloud=fakeCloud(),r=root();
  const ui=mountMomentum(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,grab:fakeGrab(runtime),storage:s,locks:locks(),now:()=>runtime.at,cloud});
  await ui.refresh(true);await settle();await settle();
  assert.equal(cloud.store.saves.length,1);assert.deepEqual(cloud.store.saves[0],local);
  assert.equal(runtime.urls.length,0,'cloud mode fetches no hourly data in the page');
  assert.equal(s.getItem(key),JSON.stringify(local),'the local copy is left as it was');
  assert.match(r.querySelector('[data-momentum-status]').textContent,/Automatik på/);
  assert.match(r.querySelector('[data-momentum-status]').textContent,/väntar på första molnvarvet/);
  cloud.store.doc.lastRun=TIME-30000;cloud.emit();await settle();
  assert.match(r.querySelector('[data-momentum-status]').textContent,/Körs i molnet · senaste varv/);
  cloud.store.doc.lastRun=TIME-600000;cloud.store.doc.lastError='Färska timpriser saknas för BTC';cloud.emit();await settle();
  assert.match(r.querySelector('[data-momentum-status]').textContent,/har inte kört på 10 min · molnfel: Färska timpriser saknas för BTC/);
  const toggle=r.querySelector('[data-momentum-toggle]');toggle.checked=false;await toggle.onchange();await settle();
  assert.equal(cloud.store.saves.length,2);assert.equal(cloud.store.saves[1].enabled,false);assert.equal(cloud.store.doc.account.enabled,false);
  assert.match(r.querySelector('[data-momentum-status]').textContent,/Nya köp pausade/);
  await ui.reset();await settle();
  assert.equal(cloud.store.archives.length,1);assert.deepEqual(cloud.store.archives[0][0],{...local,enabled:false});
  assert.deepEqual(cloud.store.saves[2],newActiveAccount());
  runtime.at=TIME+6000;await ui.refreshLive();assert.equal(runtime.urls.length,0,'no position, no quotes');
  cloud.store.available=false;runtime.urls.length=0;await ui.refresh(true);
  assert.ok(runtime.urls.some(u=>u.searchParams.get('interval')==='60'),'without the cloud the page trades its local copy again');
  assert.match(r.querySelector('[data-momentum-status]').textContent,/Automatik på/);
  assert.equal(readActiveAccount(s,key).enabled,true);
});

test('the momentum page in cloud mode only fetches tickers for a held position',async()=>{
  const runtime={at:TIME,user:'one',active:true,urls:[]},cloud=fakeCloud(),held={...newActiveAccount(),enabled:true};
  // Let the local engine open a position, then hand that account to the cloud store.
  const s=storage();
  const local=mountMomentum(root(),{getUser:()=>'one',isActive:()=>true,grab:fakeGrab(runtime),storage:s,locks:locks(),now:()=>runtime.at});
  s.setItem('riptide.momentum.20x.v1:one',JSON.stringify(held));await local.refresh(true);
  const opened=readActiveAccount(s,'riptide.momentum.20x.v1:one');assert.equal(opened.sleeves.filter(x=>x.position).length,1);
  cloud.store.doc={account:opened,lastRun:TIME,lastError:null};
  const r=root(),ui=mountMomentum(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,grab:fakeGrab(runtime),storage:storage(),locks:locks(),now:()=>runtime.at,cloud});
  await ui.refresh(true);await settle();
  assert.equal(cloud.store.saves.length,0,'an existing cloud account is not overwritten by the page');
  runtime.urls.length=0;runtime.at=TIME+6000;await ui.refreshLive();
  assert.deepEqual(kinds(runtime.urls),['tickers']);
  assert.match(r.querySelector('[data-momentum-balance]').innerHTML,/Livesaldo/);
});

test('the floor uploads the local firm once, then only quotes, pauses and resets through the cloud',async()=>{
  const s=storage(),runtime={at:TIME,user:'one',active:true,urls:[]};
  const local=mountFloor(root(),{getUser:()=>'one',isActive:()=>true,isVisible:()=>false,grab:fakeGrab(runtime),storage:s,locks:locks(),now:()=>runtime.at});
  await local.refresh();
  const firm=readFirm(s,firmKey('one'),TIME);assert.equal(heldSymbols(firm).length,6);
  const cloud=fakeCloud(),r=root();runtime.urls.length=0;
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,isVisible:()=>false,grab:fakeGrab(runtime),storage:s,locks:locks(),now:()=>runtime.at,cloud,confirm:()=>true});
  await ui.refresh();await settle();await settle();
  assert.equal(cloud.store.saves.length,1);assert.deepEqual(cloud.store.saves[0].firm,firm);assert.equal(cloud.store.saves[0].equity.length,1);
  assert.equal(runtime.urls.length,0,'cloud mode fetches nothing on refresh');
  const status=()=>r.querySelector('[data-floor-status]').textContent;
  assert.match(status(),/Firman handlar · 6 av 6 bord i affär/);assert.match(status(),/väntar på första molnvarvet/);
  runtime.at=TIME+6000;await ui.refreshLive();
  assert.deepEqual(kinds(runtime.urls),['tickers']);assert.equal(runtime.urls.length,6);
  assert.equal(JSON.parse(s.getItem(equityKey('one'))).length,1,'the page does not sample equity in cloud mode');
  cloud.store.doc.lastRun=TIME;cloud.emit();await settle();assert.match(status(),/molnet körde/);
  await ui.togglePause();await settle();
  assert.equal(cloud.store.saves.length,2);assert.equal(cloud.store.saves[1].firm.paused,true);assert.match(status(),/Nya köp pausade/);
  assert.match(r.querySelector('[data-floor-pause]').textContent,/Återuppta/);
  await ui.reset();await settle();
  assert.equal(cloud.store.archives.length,1);assert.equal(heldSymbols(cloud.store.archives[0][0]).length,6);assert.equal(cloud.store.archives[0][1].length,1,'the equity curve is archived too');
  assert.equal(heldSymbols(cloud.store.saves[2].firm).length,0);assert.deepEqual(cloud.store.saves[2].equity,[]);
  assert.equal(heldSymbols(readFirm(s,firmKey('one'),TIME)).length,6,'the local copy is left untouched');
  cloud.store.doc.lastRun=TIME-900000;cloud.emit();await settle();assert.match(status(),/har inte kört på/);
  runtime.user=null;await ui.refreshLive();assert.match(status(),/Logga in/);
});

test('a cloud error is shown instead of silently trading locally',async()=>{
  const runtime={at:TIME,user:'one',active:true,urls:[]},r=root();
  const cloud={available:()=>true,subscribe:(uid,cb)=>{queueMicrotask(()=>cb({error:'Missing or insufficient permissions'}));return ()=>{};},save:async()=>{},archive:async()=>{}};
  const ui=mountFloor(r,{getUser:()=>runtime.user,isActive:()=>runtime.active,isVisible:()=>false,grab:fakeGrab(runtime),storage:storage(),locks:locks(),now:()=>runtime.at,cloud});
  await ui.refresh();await settle();
  assert.match(r.querySelector('[data-floor-status]').textContent,/Molnet: Missing or insufficient permissions/);
  assert.equal(runtime.urls.length,0);
  const m=root(),mui=mountMomentum(m,{getUser:()=>'one',isActive:()=>true,grab:fakeGrab(runtime),storage:storage(),locks:locks(),now:()=>runtime.at,cloud});
  await mui.refresh(true);await settle();
  assert.match(m.querySelector('[data-momentum-status]').textContent,/Molnet: Missing/);assert.equal(runtime.urls.length,0);
});

test('the camera fits the office, zooms around the cursor and never loses the world',()=>{
  const cam=createCamera(CANVAS);
  cam.fit(1400,900);
  const c=cam.toScreen(CANVAS.w/2,CANVAS.h/2);
  assert.ok(Math.abs(c.x-700)<1e-9&&Math.abs(c.y-450)<1e-9,'world centre sits in the viewport centre');
  assert.ok(cam.state().zoom>0&&cam.state().zoom*CANVAS.w<=1400&&cam.state().zoom*CANVAS.h<=900);
  const before=cam.toWorld(300,200);cam.zoomAt(300,200,1.5);const after=cam.toWorld(300,200);
  assert.ok(Math.abs(before.x-after.x)<1e-9&&Math.abs(before.y-after.y)<1e-9,'the point under the cursor stays put');
  const z=cam.state().zoom;cam.zoomAt(300,200,1000);assert.ok(cam.state().zoom>z&&cam.state().zoom<=Math.max(cam.state().fitZoom*6,4));
  cam.zoomAt(300,200,1e-6);assert.ok(cam.state().zoom>=cam.state().fitZoom*.5-1e-12);
  cam.fit(1400,900);cam.panBy(1e6,1e6);
  const s=cam.state();assert.ok(s.x<1400&&s.y<900,'part of the world stays visible after a huge pan');
  cam.panBy(-1e7,-1e7);const s2=cam.state();assert.ok(s2.x+CANVAS.w*s2.zoom>0&&s2.y+CANVAS.h*s2.zoom>0);
  cam.zoomAt(0,0,NaN);assert.equal(cam.state().zoom,s2.zoom);
  const w=cam.toWorld(10,20),back=cam.toScreen(w.x,w.y);assert.ok(Math.abs(back.x-10)<1e-9&&Math.abs(back.y-20)<1e-9);
});
