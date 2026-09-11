import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import * as motor from '../motor.js';
import {CRYPTO_AI_MODEL as model} from '../crypto-ai-model.js';
import {cryptoContext} from '../crypto-quality.js';
import {assessAI,aiFeatures,newShadow,settleShadow,shadowKey,shadowStats,AI_STEP as STEP} from '../crypto-ai.js';
import {readData,SYMBOLS,ROOT,SPLIT,END as DATA_END,START as DATA_START,DAY} from './crypto-data.mjs';
const training=process.argv.includes('--training')||process.env.AI_REPLAY_TRAINING==='1';
const START=training?DATA_START:SPLIT,END=training?SPLIT:DATA_END;

const data=Object.fromEntries(SYMBOLS.map(s=>[s,readData(s).bars]));
const seen=new Set(),rows=[];
const realNow=Date.now,started=performance.now();let now=START;
motor.MOTORCFG.nyhetsSparr=false;motor.MOTORCFG.formandeStapel=false;
const first=(START-data.BTC[0].t)/STEP;
const maxSteps=Number(process.env.AI_REPLAY_STEPS)||Infinity;
let invalid=0,activeObservations=0;
try{
  Date.now=()=>now;
  for(let i=first-1;i<data.BTC.length&&i<first+maxSteps;i++){
    now=data.BTC[i].t+STEP;
    const contexts={},all=[];
    for(const symbol of SYMBOLS){
      const ctx=motor.buildContext(motor.INSTR[symbol],data[symbol].slice(i-1999,i+1));
      ctx.simulated=false;ctx.newsBias=0;ctx.biasRiktning=0;contexts[symbol]=ctx;
      all.push(...motor.generateSignals(ctx));
    }
    all.sort((a,b)=>motor.GRADE_RANK[a.grade]-motor.GRADE_RANK[b.grade]||b.conf-a.conf);
    const running=all.filter(s=>motor.LIVE.has(s.nyckel)),waiting=all.filter(s=>!motor.LIVE.has(s.nyckel));
    const selected=running.concat(waiting.slice(0,Math.max(3,14-running.length)));
    const keys=new Set(selected.map(s=>s.nyckel));
    for(const [key,st] of motor.LIVE){
      if(!st.sig||keys.has(key))continue;
      if(st.slutAt&&now-st.slutAt>1800000||!st.slutAt&&now-(st.at||0)>36*3600000){motor.LIVE.delete(key);continue;}
      const ctx=contexts[st.sig.inst];
      selected.push({...st.sig,bars:ctx.bars,ctxPx:ctx.px,atr:ctx.atr||st.sig.atr});keys.add(key);
    }
    const signals=motor.assignStatus(selected,Object.fromEntries(SYMBOLS.map(s=>[s,contexts[s].px])));
    if(now>=END)break;
    const snapshots=new Map();
    for(const s of signals){
      if(s.status!=='ACTIVE'||s.grade!=='A')continue;
      activeObservations++;
      const key=shadowKey(s,model.version);if(seen.has(key))continue;
      if(!snapshots.has(s.inst))snapshots.set(s.inst,cryptoContext(contexts[s.inst].bars,now));
      const f=training?aiFeatures(s,contexts[s.inst],now,snapshots.get(s.inst)):null;
      const assessment=training?(f?{expectedR:0,accepted:false,selective:f.review.pass,
        features:f.x,checks:f.review.checks.map(c=>({key:c.key,ok:c.ok}))}:null)
        :assessAI(s,contexts[s.inst],now,model,snapshots.get(s.inst));
      if(!assessment){invalid++;continue;}
      const row=newShadow(s,contexts[s.inst],now,assessment,model.version);
      if(!row)throw Error('Unexpected invalid row');
      seen.add(key);
      // Future data is used ONLY for labels, after freezing the assessment.
      // No label or outcome is ever returned to the signal engine or model.
      const future=data[s.inst].slice(i+2,i+291);
      const done=settleShadow(row,future,Math.min(END,row.deadline+STEP));
      const dir=s.side==='long'?1:-1,slippage=.001;
      const stressed={...row,slippage,entry:contexts[s.inst].px*(1+dir*slippage)};
      const stopFill=stressed.sl*(1-dir*slippage);
      stressed.risk=dir*(stressed.entry-stopFill)+stressed.fee*(stressed.entry+stopFill);
      const stress=settleShadow(stressed,future,Math.min(END,stressed.deadline+STEP));
      rows.push({...done,fam:s.fam,rawEntry:contexts[s.inst].px,signalEntry:s.entryFyllt??s.entry,
        atr:snapshots.get(s.inst).atr,stressR:stress.status==='closed'?stress.netR:null});
    }
    if((i-first+1)%(5*288)===0){
      console.log(JSON.stringify({through:new Date(now).toISOString().slice(0,10),percent:Math.round((now-START)/(END-START)*100),
        candidates:rows.length,ai:rows.filter(r=>r.accepted).length,seconds:Math.round((performance.now()-started)/1000)}));
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
}finally{Date.now=realNow;}

const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const q=(a,p)=>a.length?a[Math.floor((a.length-1)*p)]:null;
function ci(sample){
  const done=sample.filter(r=>r.status==='closed'),blocks=new Map();
  for(const r of done){const k=Math.floor((r.at-START)/(7*DAY));if(!blocks.has(k))blocks.set(k,[]);blocks.get(k).push(r.netR);}
  if(done.length<30||blocks.size<3)return null;
  let seed=1729;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const buckets=[...blocks.values()],samples=[];
  for(let i=0;i<2000;i++){const res=[];for(let j=0;j<buckets.length;j++)res.push(...buckets[Math.floor(rand()*buckets.length)]);samples.push(mean(res));}
  samples.sort((a,b)=>a-b);return {low:q(samples,.025),high:q(samples,.975),blocks:blocks.size};
}
const filters=[()=>true,r=>r.selective,r=>r.accepted,r=>r.selective&&r.accepted];
const stats=shadowStats(rows).map((s,i)=>({...s,ci:ci(rows.filter(filters[i])),stressMeanR:mean(rows.filter(filters[i]).map(r=>r.stressR).filter(Number.isFinite))}));
const predictions=rows.map(r=>r.expectedR).sort((a,b)=>a-b);
const failures={};for(const r of rows)for(const c of r.checks)if(!c.ok)failures[c.key]=(failures[c.key]||0)+1;
const ranked=rows.filter(r=>r.status==='closed').sort((a,b)=>a.expectedR-b.expectedR);
const quintiles=Array.from({length:5},(_,i)=>{const group=ranked.slice(Math.floor(ranked.length*i/5),Math.floor(ranked.length*(i+1)/5));
  return {quintile:i+1,n:group.length,predicted:mean(group.map(r=>r.expectedR)),actual:mean(group.map(r=>r.netR)),ci:ci(group)};});
const bySymbol=SYMBOLS.map(symbol=>({symbol,stats:shadowStats(rows.filter(r=>r.inst===symbol))}));
const result={createdAt:new Date().toISOString(),modelVersion:model.version,modelHash:createHash('sha256').update(readFileSync(new URL('../crypto-ai-model.js',import.meta.url))).digest('hex'),
  motorHash:createHash('sha256').update(readFileSync(new URL('../motor.js',import.meta.url))).digest('hex'),from:START,to:Math.min(now,END),complete:now>=END,
  stats,diagnostics:{activeObservations,invalid,prediction:{min:q(predictions,0),median:q(predictions,.5),max:q(predictions,1)},
    aboveThreshold:rows.filter(r=>r.expectedR>=model.threshold).length,failures,quintiles},bySymbol,rows};
const name=result.complete?(training?'ai-candidates-development':'ai-replay'):'ai-replay-smoke';
writeFileSync(new URL(name+'.json',ROOT),JSON.stringify(result));
console.log(JSON.stringify({complete:result.complete,stats,diagnostics:result.diagnostics},null,2));
