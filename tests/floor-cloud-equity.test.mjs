import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {FLOOR,newFirm,validateFirm} from '../trading-floor.js';

// Execute the actual cloud-function orchestration without credentials or network.
const source=readFileSync(new URL('../functions/index.js',import.meta.url),'utf8');
const runSource=source.match(/export async function molnKor\([^]*?\n\}/)[0].replace('export ','');
for(const race of ['none','reset','newer curve','newer account'])test('cloud equity sampling preserves '+race,async()=>{
  const start=Date.now()-60000,firm=newFirm(start),docs=new Map();let revision=0;
  const put=(path,data)=>docs.set(path,{data:structuredClone(data),rev:++revision});
  put('floor/one',{version:firm.version,createdAt:start,paused:false,updatedAt:start});
  for(const s of FLOOR.desks)put('floor/one/desks/'+s,{account:firm.desks[s]});
  put('floor/one/data/equity',{points:[{t:start,v:600}],updatedAt:start});
  const snap=ref=>{
    const row=docs.get(ref.path),rev=row?.rev;
    return {exists:!!row,id:ref.path.split('/').at(-1),data:()=>structuredClone(row?.data),updateTime:{rev,isEqual:other=>other.rev===rev}};
  };
  const db={doc:path=>({path,get:async()=>snap({path})}),getAll:async(...refs)=>refs.map(snap),
    runTransaction:async fn=>fn({getAll:async(...refs)=>refs.map(snap),set:(ref,data)=>put(ref.path,data)})};
  const ctx=vm.createContext({db,FLOOR,Date,bybit:async()=>{},rent:structuredClone,lasMomentum:()=>null,
    lasFloor:(meta,desks)=>validateFirm({...meta,desks:Object.fromEntries(desks.map(s=>[s.id,s.data().account]))}),
    fetchPlan:async()=>({mode:'idle'}),applyPlan:(_,momentum,firm)=>({momentum:{account:momentum},firm:{firm}}),
    sampleFirmEquity:async(_,now,firm,points)=>{
      if(race==='reset'){
        put('floor/one',{...docs.get('floor/one').data,createdAt:start+1,updatedAt:start+1});
        put('floor/one/data/equity',{points:[],updatedAt:start+1});
      }
      if(race==='newer curve')put('floor/one/data/equity',{points:[{t:start+1,v:610}],updatedAt:start+1});
      if(race==='newer account')put('floor/one',{...docs.get('floor/one').data,updatedAt:start+1});
      return [...points,{t:now(),v:605}];
    }
  });
  vm.runInContext(runSource,ctx);await ctx.molnKor('one');
  const values=docs.get('floor/one/data/equity').data.points.map(p=>p.v);
  assert.deepEqual(values,race==='none'?[600,605]:race==='reset'?[]:race==='newer curve'?[610]:[600]);
});
