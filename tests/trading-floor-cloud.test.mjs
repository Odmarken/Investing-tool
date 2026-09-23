import test from 'node:test';
import assert from 'node:assert/strict';
import {createFloorCloud} from '../trading-floor-cloud.js';
import {FLOOR,newFirm,setFirmPaused,validateFirm} from '../trading-floor.js';

const TIME=Date.parse('2026-09-22T12:00:00Z');
// A transactional document store with conflict retries, atomic commits and
// individually delivered snapshot callbacks, matching the adapter's SDK surface.
function fixture(){
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
  const cloud=createFloorCloud({getContext:()=>({db:'',fs}),available:()=>true,now:()=>TIME+60000});
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

test('upgrade archives an old SL/TP firm once, keeps its pause and writes fresh trend desks',async()=>{
  const f=fixture();
  f.data.set('floor/one',{version:FLOOR.legacy,createdAt:TIME-1e6,paused:true,updatedAt:TIME-1e6,lastRun:TIME-1000,lastError:null});
  for(const s of FLOOR.desks)f.data.set('floor/one/desks/'+s,{account:{version:'momentum-hourly-sl-tp-v4',symbol:s,cash:88}});
  f.data.set('floor/one/data/equity',{points:[{t:TIME-1e6,v:600}]});
  const states=[],stop=f.cloud.subscribe('one',s=>states.push(s));
  for(const path of f.listeners.keys())f.emit(path);f.flush();
  assert.deepEqual(states,[{legacy:true}]);
  await f.cloud.upgrade('one');
  const firm=f.firm();
  assert.equal(firm.version,FLOOR.version);assert.equal(firm.paused,true);assert.ok(FLOOR.desks.every(s=>firm.desks[s].cash===100&&!firm.desks[s].enabled));
  assert.equal(f.data.get('floor/one/archive/auto1').reason,'strategy-change');assert.equal(f.data.get('floor/one/archive/auto1').equity.length,1);
  assert.equal(f.data.get('floor/one/archive/auto1/desks/BTC').account.cash,88);
  assert.deepEqual(f.data.get('floor/one/data/equity').points,[]);assert.equal(f.data.get('floor/one').lastRun,null);
  const after=structuredClone(f.data);await f.cloud.upgrade('one');assert.deepEqual(f.data,after,'a second upgrade does nothing');
  stop();
});
