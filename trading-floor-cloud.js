import {FLOOR,newFirm,validateFirm,setFirmPaused} from './trading-floor.js';

const clean=value=>JSON.parse(JSON.stringify(value));

// Inject the SDK so this adapter can be exercised without a real account.
export function createFloorCloud({getContext,available,now=Date.now}){
  const refs=(db,fs,uid)=>({meta:fs.doc(db,'floor',uid),
    desks:FLOOR.desks.map(s=>fs.doc(db,'floor',uid,'desks',s)),equity:fs.doc(db,'floor',uid,'data','equity')});
  const readFirm=(meta,desks)=>validateFirm({version:meta.version,createdAt:meta.createdAt,paused:meta.paused,
    desks:Object.fromEntries(FLOOR.desks.map((s,i)=>[s,desks[i].data()?.account]))});
  function writeFirm(tx,r,firm,t){
    tx.set(r.meta,{version:firm.version,createdAt:firm.createdAt,paused:firm.paused,updatedAt:t,lastRun:null,lastError:null});
    FLOOR.desks.forEach((s,i)=>tx.set(r.desks[i],{account:clean(firm.desks[s]),updatedAt:t}));
  }
  return {
    available,
    subscribe(uid,onState){
      const {db,fs}=getContext(),r=refs(db,fs,uid);
      let meta=null,desks=null,equity=[],dirty=false;
      const seen=new Set(),fail=e=>onState({error:e.message||String(e)});
      const stops=[
        fs.onSnapshot(r.meta,s=>{meta=s.exists()?s.data():null;seen.add('meta');dirty=true;},fail),
        fs.onSnapshot(fs.collection(db,'floor',uid,'desks'),s=>{desks={};s.forEach(d=>{desks[d.id]=d.data().account;});seen.add('desks');dirty=true;},fail),
        fs.onSnapshot(r.equity,s=>{equity=s.exists()?(s.data().points||[]):[];seen.add('equity');dirty=true;},fail),
        // A batch fires several listeners. Publish after all affected listeners
        // catch up so paused and desk.enabled belong to the same update.
        fs.onSnapshotsInSync(db,()=>{
          if(!dirty||seen.size!==3)return;dirty=false;
          if(!meta){onState({missing:true});return;}
          onState({firm:{version:meta.version,createdAt:meta.createdAt,paused:meta.paused,desks},equity,
            lastRun:meta.lastRun??null,lastError:meta.lastError??null});
        })
      ];
      return ()=>stops.forEach(stop=>stop());
    },
    async initialize(uid,{firm,equity}){
      validateFirm(firm);
      const {db,fs}=getContext(),r=refs(db,fs,uid),t=now();
      await fs.runTransaction(db,async tx=>{
        // Two devices may both see missing. Only the first creates the firm.
        if((await tx.get(r.meta)).exists())return;
        writeFirm(tx,r,firm,t);tx.set(r.equity,{points:clean(equity),updatedAt:t});
      });
    },
    async togglePause(uid){
      const {db,fs}=getContext(),r=refs(db,fs,uid);
      await fs.runTransaction(db,async tx=>{
        const snapshots=await Promise.all([tx.get(r.meta),...r.desks.map(ref=>tx.get(ref))]);
        if(!snapshots[0].exists())throw Error('Firman saknas i molnet');
        const current=readFirm(snapshots[0].data(),snapshots.slice(1)),next=setFirmPaused(current,!current.paused),t=now();
        tx.update(r.meta,{paused:next.paused,updatedAt:t});
        FLOOR.desks.forEach((s,i)=>tx.update(r.desks[i],{'account.enabled':!next.paused,updatedAt:t}));
      });
    },
    async reset(uid){
      const {db,fs}=getContext(),r=refs(db,fs,uid);
      const archive=fs.doc(fs.collection(db,'floor',uid,'archive'));
      await fs.runTransaction(db,async tx=>{
        const snaps=await Promise.all([tx.get(r.meta),...r.desks.map(ref=>tx.get(ref)),tx.get(r.equity)]);
        if(!snaps[0].exists())throw Error('Firman saknas i molnet');
        const firm=readFirm(snaps[0].data(),snaps.slice(1,1+FLOOR.desks.length)),t=now();
        tx.set(archive,{version:firm.version,createdAt:firm.createdAt,paused:firm.paused,archivedAt:t,equity:clean(snaps.at(-1).data()?.points||[])});
        FLOOR.desks.forEach(s=>tx.set(fs.doc(archive,'desks',s),{account:clean(firm.desks[s])}));
        writeFirm(tx,r,newFirm(Math.max(t,firm.createdAt+1)),t);
        tx.set(r.equity,{points:[],updatedAt:t});
      });
    }
  };
}
