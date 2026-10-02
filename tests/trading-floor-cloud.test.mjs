import test from 'node:test';
import assert from 'node:assert/strict';
import {createFloorCloud} from '../trading-floor-cloud.js';
import {FLOOR,newFirm,setFirmPaused,validateFirm,advanceFirm,heldSymbols} from '../trading-floor.js';
import {TIME,HOUR,unitBars,extendUnit,trendSnapshot,riskSnapshot} from './floor-fixtures.mjs';

// A transactional document store with conflict retries, atomic commits and
// individually delivered snapshot callbacks, matching the adapter's SDK surface.
function fixture(clock=()=>TIME+60000){
  const data=new Map(),listeners=new Map();let sync,serial=0,version=0,interleave=null,fail=false;
  const snapshot=path=>({exists:()=>data.has(path),data:()=>structuredClone(data.get(path)),id:path.split('/').at(-1)});
  const fs={
    doc:(base,...parts)=>[base,...(parts.length?parts:['auto'+(++serial)])].filter(Boolean).join('/'),
    collection:(base,...parts)=>[base,...parts].filter(Boolean).join('/'),
    onSnapshot:(path,cb)=>{listeners.set(path,cb);return ()=>listeners.delete(path);},
    onSnapshotsInSync:(_,cb)=>{sync=cb;return ()=>{sync=null;};},
    async runTransaction(_,fn){
      for(let attempt=0;attempt<4;attempt++){
        const revision=version,writes=[];
        await fn({
          get:async path=>{assert.equal(writes.length,0,'reads precede writes');return snapshot(path);},
          set:(path,value)=>writes.push([path,structuredClone(value),false]),
          update:(path,value)=>writes.push([path,structuredClone(value),true])
        });
        if(interleave){const action=interleave;interleave=null;action();version++;}
        if(revision!==version)continue;
        if(fail)throw Error('commit failed');
        for(const [path,value,update] of writes){
          if(!update){data.set(path,value);continue;}
          const next=structuredClone(data.get(path));
          for(const [key,v] of Object.entries(value)){
            const keys=key.split('.');let obj=next;for(const key of keys.slice(0,-1))obj=obj[key];obj[keys.at(-1)]=v;
          }
          data.set(path,next);
        }
        version++;return;
      }
      throw Error('conflict');
    }
  };
  const cloud=createFloorCloud({getContext:()=>({db:'',fs}),available:()=>true,now:clock});
  return {cloud,data,listeners,conflict:fn=>{interleave=fn;},fail:()=>{fail=true;},
    emit(path){const cb=listeners.get(path);if(path.endsWith('/desks'))cb({forEach:fn=>FLOOR.desks.forEach(s=>fn(snapshot(path+'/'+s)))});else cb(snapshot(path));},
    flush:()=>sync?.(),firm:()=>validateFirm({...data.get('floor/one'),desks:Object.fromEntries(FLOOR.desks.map(s=>[s,data.get('floor/one/desks/'+s).account]))})};
}

test('migration is create-only even when another device creates the firm during the transaction',async()=>{
  const f=fixture(),other=setFirmPaused(newFirm(TIME+1),true);
  f.conflict(()=>{
    f.data.set('floor/one',{version:other.version,createdAt:other.createdAt,paused:true});
    FLOOR.desks.forEach(s=>f.data.set('floor/one/desks/'+s,{account:other.desks[s]}));
    f.data.set('floor/one/data/equity',{points:[{t:TIME,v:590}]});
  });
  await f.cloud.initialize('one',{firm:newFirm(TIME),equity:[]});
  assert.equal(f.firm().createdAt,TIME+1);assert.equal(f.firm().paused,true);
  assert.deepEqual(f.data.get('floor/one/data/equity').points,[{t:TIME,v:590}]);
});

test('pause retries a concurrent runner update and preserves its account data',async()=>{
  const f=fixture();await f.cloud.initialize('one',{firm:newFirm(TIME),equity:[]});
  f.conflict(()=>{f.data.get('floor/one/desks/BTC').account.waitReason='New server decision';});
  await f.cloud.togglePause('one');
  assert.equal(f.firm().paused,true);assert.equal(f.firm().desks.BTC.waitReason,'New server decision');
  assert.ok(FLOOR.desks.every(s=>!f.firm().desks[s].enabled));
  await f.cloud.togglePause('one');assert.equal(f.firm().paused,false);
});

test('reset archives the latest firm and curve atomically and clears old runner status',async()=>{
  const f=fixture();await f.cloud.initialize('one',{firm:newFirm(TIME),equity:[{t:TIME,v:600}]});
  f.conflict(()=>{f.data.get('floor/one/desks/ETH').account.waitReason='Latest';f.data.get('floor/one/data/equity').points.push({t:TIME+60000,v:601});});
  await f.cloud.reset('one');
  assert.equal(f.firm().createdAt,TIME+60000);assert.equal(f.data.get('floor/one').lastRun,null);
  assert.deepEqual(f.data.get('floor/one/data/equity').points,[]);
  assert.equal(f.data.get('floor/one/archive/auto1/desks/ETH').account.waitReason,'Latest');
  assert.equal(f.data.get('floor/one/archive/auto1').equity.length,2);
  const before=structuredClone(f.data);f.fail();await assert.rejects(f.cloud.reset('one'),/commit failed/);
  assert.deepEqual(f.data,before,'a failed archive leaves the live firm intact');
});

test('listeners do not expose half of a multi-document pause and stop on unsubscribe',async()=>{
  const f=fixture();await f.cloud.initialize('one',{firm:newFirm(TIME),equity:[]});
  const states=[],stop=f.cloud.subscribe('one',s=>states.push(s));
  for(const path of f.listeners.keys())f.emit(path);f.flush();assert.equal(states.length,1);
  await f.cloud.togglePause('one');f.emit('floor/one');assert.equal(states.length,1);
  f.emit('floor/one/desks');f.flush();assert.equal(states.length,2);validateFirm(states[1].firm);
  assert.equal(states[1].firm.paused,true);stop();assert.equal(f.listeners.size,0);
});

for(const [version,account] of [['trading-floor-v1',{version:'momentum-hourly-sl-tp-v4',cash:88}],['trading-floor-v2',{version:'floor-trend-v1',cash:88}]])
test('upgrade archives a '+version+' firm once, keeps its pause and writes fresh desks with every trend off',async()=>{
  const f=fixture();
  f.data.set('floor/one',{version,createdAt:TIME-1e6,paused:true,updatedAt:TIME-1e6,lastRun:TIME-1000,lastError:null});
  for(const s of FLOOR.desks)f.data.set('floor/one/desks/'+s,{account:{...account,symbol:s}});
  f.data.set('floor/one/data/equity',{points:[{t:TIME-1e6,v:600}]});
  const states=[],stop=f.cloud.subscribe('one',s=>states.push(s));
  for(const path of f.listeners.keys())f.emit(path);f.flush();
  assert.deepEqual(states,[{legacy:true}]);
  await f.cloud.upgrade('one');
  const firm=f.firm();
  assert.equal(firm.version,FLOOR.version);assert.equal(firm.paused,true);
  assert.ok(FLOOR.desks.every(s=>firm.desks[s].cash===100&&!firm.desks[s].enabled&&firm.desks[s].signal.through===null));
  assert.equal(f.data.get('floor/one/archive/auto1').reason,'strategy-change');assert.equal(f.data.get('floor/one/archive/auto1').version,version);
  assert.equal(f.data.get('floor/one/archive/auto1').equity.length,1);
  assert.equal(f.data.get('floor/one/archive/auto1/desks/BTC').account.cash,88);
  assert.deepEqual(f.data.get('floor/one/data/equity').points,[]);assert.equal(f.data.get('floor/one').lastRun,null);
  const after=structuredClone(f.data);await f.cloud.upgrade('one');assert.deepEqual(f.data,after,'a second upgrade does nothing');
  stop();
});

test('Stäng trade closes the clicked desk in a transaction and never a trade the runner already closed',async()=>{
  const buy=TIME+HOUR,at=buy+20*60000,unit=unitBars(TIME);
  const held=advanceFirm(advanceFirm(newFirm(TIME),trendSnapshot(TIME,unit),TIME),trendSnapshot(buy,extendUnit(unit,1.001)),buy);
  const f=fixture(()=>at);await f.cloud.initialize('one',{firm:held,equity:[]});
  const snapshot=riskSnapshot(held,at),btc=held.desks.BTC.position.openedAt;
  const result=await f.cloud.closeTrade('one','BTC',btc,snapshot);
  assert.equal(result.desks.BTC.position,null);assert.equal(f.firm().desks.BTC.trades.at(-1).reason,'manuell');
  assert.deepEqual(heldSymbols(f.firm()),FLOOR.desks.filter(s=>s!=='BTC'),'only that desk is written');
  assert.equal(f.data.get('floor/one').updatedAt,at,'a newer revision keeps an older equity sample out');
  const before=structuredClone(f.data);
  await assert.rejects(f.cloud.closeTrade('one','BTC',btc,snapshot),/redan stängd/);
  assert.deepEqual(f.data,before,'a second click writes nothing');
  await assert.rejects(f.cloud.closeTrade('one','PEPE',btc,snapshot),/Okänt bord/);
  // A runner write during the transaction is re-read before the close is applied.
  f.conflict(()=>{f.data.get('floor/one/desks/ETH').account.waitReason='Runner';});
  await f.cloud.closeTrade('one','ETH',held.desks.ETH.position.openedAt,snapshot);
  assert.equal(f.firm().desks.ETH.position,null);assert.equal(f.firm().desks.ETH.waitReason,'Runner');
});
