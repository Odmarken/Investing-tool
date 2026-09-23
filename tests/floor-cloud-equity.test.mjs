import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {FLOOR,newFirm,validateFirm,isLegacyFirm,setFirmPaused} from '../trading-floor.js';

// Execute the actual cloud-function orchestration without credentials or network.
const source=readFileSync(new URL('../functions/index.js',import.meta.url),'utf8');
const extract=name=>source.match(new RegExp('(?:export )?async function '+name+'\\([^]*?\\n\\}'))[0].replace('export ','');
const runSource=extract('molnKor'),upgradeSource=extract('uppgraderaFloor');
const idlePlan=async()=>({momentum:{mode:'idle'},floor:{mode:'idle'}});
function fakeDb(){
  const docs=new Map();let revision=0,auto=0;
  const put=(path,data)=>docs.set(path,{data:structuredClone(data),rev:++revision});
  const snap=ref=>{
    const row=docs.get(ref.path),rev=row?.rev;
    return {exists:!!row,id:ref.path.split('/').at(-1),data:()=>structuredClone(row?.data),updateTime:{rev,isEqual:other=>other.rev===rev}};
  };
  const ref=path=>({path,get:async()=>snap({path}),collection:name=>collection(path+'/'+name)});
  const collection=path=>({doc:(id='auto'+(++auto))=>ref(path+'/'+id)});
  const db={doc:ref,collection,getAll:async(...refs)=>refs.map(snap),
    runTransaction:async fn=>fn({getAll:async(...refs)=>refs.map(snap),set:(r,data)=>put(r.path,data)})};
  return {db,docs,put};
}
const context=(db,extra={})=>vm.createContext({db,FLOOR,Date,bybit:async()=>{},rent:structuredClone,lasMomentum:()=>null,isLegacyFirm,newFirm,setFirmPaused,
  lasFloor:(meta,desks)=>validateFirm({...meta,desks:Object.fromEntries(desks.map(s=>[s.id,s.data().account]))}),
  fetchPlan:idlePlan,applyPlan:(_,momentum,firm)=>({momentum:{account:momentum},firm:{firm}}),sampleFirmEquity:async(_,now,firm,points)=>points,...extra});

for(const race of ['none','reset','newer curve','newer account'])test('cloud equity sampling preserves '+race,async()=>{
  const start=Date.now()-60000,firm=newFirm(start),{db,docs,put}=fakeDb();
  put('floor/one',{version:firm.version,createdAt:start,paused:false,updatedAt:start});
  for(const s of FLOOR.desks)put('floor/one/desks/'+s,{account:firm.desks[s]});
  put('floor/one/data/equity',{points:[{t:start,v:600}],updatedAt:start});
  const ctx=context(db,{
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

test('the cloud archives an old SL/TP firm once, keeps its pause and runs fresh trend desks',async()=>{
  const start=Date.now()-86400000,{db,docs,put}=fakeDb(),plans=[];
  put('floor/one',{version:FLOOR.legacy,createdAt:start,paused:true,updatedAt:start,lastRun:start});
  for(const s of FLOOR.desks)put('floor/one/desks/'+s,{account:{version:'momentum-hourly-sl-tp-v4',symbol:s,cash:90}});
  put('floor/one/data/equity',{points:[{t:start,v:600},{t:start+60000,v:540}],updatedAt:start});
  const ctx=context(db,{fetchPlan:async(_,now,momentum,firm)=>{plans.push(firm);return idlePlan();}});
  vm.runInContext(upgradeSource,ctx);vm.runInContext(runSource,ctx);
  const result=await ctx.molnKor('one');
  const meta=docs.get('floor/one').data;
  assert.equal(meta.version,FLOOR.version);assert.equal(meta.paused,true);assert.ok(meta.createdAt>start);
  for(const s of FLOOR.desks){const d=docs.get('floor/one/desks/'+s).data.account;assert.equal(d.cash,100);assert.equal(d.enabled,false);assert.equal(d.signal.through,null);}
  assert.deepEqual(docs.get('floor/one/data/equity').data.points,[]);
  const archives=[...docs.keys()].filter(k=>/^floor\/one\/archive\/[^/]+$/.test(k));
  assert.equal(archives.length,1);
  const archived=docs.get(archives[0]).data;
  assert.equal(archived.version,FLOOR.legacy);assert.equal(archived.reason,'strategy-change');assert.equal(archived.equity.length,2);
  assert.equal(docs.get(archives[0]+'/desks/BTC').data.account.cash,90);
  assert.equal(plans[0].version,FLOOR.version,'the same run already plans with the new desks');assert.equal(result.floor,true);
  // A second run finds nothing to upgrade.
  await ctx.molnKor('one');
  assert.equal([...docs.keys()].filter(k=>/^floor\/one\/archive\/[^/]+$/.test(k)).length,1);
});
