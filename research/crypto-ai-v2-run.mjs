import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fitRidge} from '../crypto-ai-fit.js';
import {PROFILES,variant,label,fitTrees,predict,metrics,portfolio,mean,gate} from './crypto-ai-v2-core.mjs';
const root=new URL('../.matning/crypto/',import.meta.url);
const read=name=>JSON.parse(readFileSync(new URL(name,root),'utf8'));
const development=read('ai-candidates-development.json');
if(!development.complete)throw Error('Development replay incomplete');
const TRAIN_END=Date.parse('2026-06-12T00:00:00Z'),VALID_END=Date.parse('2026-07-12T00:00:00Z'),END=Date.parse('2026-09-10T00:00:00Z');
const symbols=['BTC','ETH','SOL','XRP','DOGE','SHIB','PEPE'];
const data=Object.fromEntries(symbols.map(s=>{const d=read(s+'.json');return [s,{...d,fundingMap:new Map(d.funding.map(f=>[f.t,f.rate]))}];}));
for(const s of symbols){
  const f=data[s].funding;
  if(!f.length||f[0].t>development.from+8*3600000||f.at(-1).t<END-8*3600000||
    f.some((x,i)=>!Number.isFinite(x.rate)||!Number.isFinite(x.t)||i&&(x.t<=f[i-1].t||x.t-f[i-1].t>8*3600000)))throw Error('Incomplete funding '+s);
}
function labeled(raw,profile,end){
  const out=[];
  for(const row of raw){
    const candidate=variant(row,profile),d=data[row.inst];
    const done=label(candidate,d.bars,d.funding,end);if(!done)continue;
    const stress=label(variant(row,profile,.001),d.bars,d.funding,end);if(!stress)throw Error('Stress outcome missing');
    out.push({...done,stress,stressR:stress.netR});
  }return out;
}
function evaluate(model,rows){
  const eligible=rows.filter(r=>r.eligible),scores=eligible.map(r=>predict(model,r.x));
  if(scores.some(x=>!Number.isFinite(x)))throw Error('Invalid model prediction');
  const selected=eligible.filter((r,i)=>scores[i]>=.1),m=metrics(selected),book=portfolio(selected,data),stressBook=portfolio(selected,data,true);
  return {metrics:m,eligible:metrics(eligible),all:metrics(rows),scores:{min:Math.min(...scores),max:Math.max(...scores),mean:mean(scores)},
    portfolio:book,stressPortfolio:stressBook,gate:gate(selected,m,book,stressBook),selected};
}
function groups(rows,key){return [...new Set(rows.map(key))].map(k=>({group:k,...metrics(rows.filter(r=>key(r)===k))}));}
const trials=[],analysis={},profileValidation={};
for(const profile of PROFILES){
  console.log('Preparing '+profile);
  const training=labeled(development.rows.filter(r=>r.at<TRAIN_END),profile,TRAIN_END);
  const validation=labeled(development.rows.filter(r=>r.at>=TRAIN_END&&r.at<VALID_END),profile,VALID_END);
  profileValidation[profile]=new Map(validation.map(r=>[r.signalId+'|'+r.at,r]));
  if(profile==='original'){
    const losers=training.filter(r=>r.netR<0);
    analysis.training={...metrics(training),byFamily:groups(training,r=>r.fam),byCoin:groups(training,r=>r.inst),
      byTrend:groups(training,r=>r.x[1]===1?'med timtrend':r.x[1]===-1?'mot timtrend':'neutral'),
      byNetRR:groups(training,r=>r.x[6]<1?'under 1':r.x[6]<1.5?'1–1,5':r.x[6]<2?'1,5–2':'över 2'),
      byStop:groups(training,r=>r.risk/r.entry<.003?'under 0,3 %':r.risk/r.entry<.006?'0,3–0,6 %':r.risk/r.entry<.012?'0,6–1,2 %':'över 1,2 %'),
      lossesAfterPositiveExcursion:losers.filter(r=>r.mfeR>=.5).length,losses:losers.length,
      meanHoldingHours:mean(training.map(r=>r.holdingHours)),withoutFunding:mean(training.map(r=>r.netBeforeFunding))};
  }
  const eligible=training.filter(r=>r.eligible).map(r=>({x:r.x,y:r.netR}));
  for(const kind of ['ridge','trees']){
    console.log('Training '+profile+' '+kind+' on '+eligible.length+' eligible candidates');
    const model=kind==='ridge'?{...fitRidge(eligible),kind}:fitTrees(eligible);
    const validationResult=evaluate(model,validation);
    const trial={id:profile+'-'+kind,profile,kind,trainN:eligible.length,trainAllN:training.length,
      trainLastOutcome:Math.max(...training.filter(r=>r.eligible).map(r=>r.closed)),model,validation:validationResult};
    trials.push(trial);console.log(JSON.stringify({id:trial.id,validation:validationResult.metrics,gate:validationResult.gate}));
  }
}
const common=[...profileValidation.original.keys()].filter(k=>PROFILES.every(p=>profileValidation[p].get(k)?.eligible));
analysis.pairedValidation=PROFILES.map(profile=>({profile,...metrics(common.map(k=>profileValidation[profile].get(k)))}));
const qualified=trials.filter(t=>t.validation.gate.pass).sort((a,b)=>b.validation.metrics.stressR-a.validation.metrics.stressR);
const selected=qualified[0]??null;
let final=null;
function ci(rows){
  const blocks=new Map();for(const r of rows){const k=Math.floor((r.at-VALID_END)/(7*86400000));if(!blocks.has(k))blocks.set(k,[]);blocks.get(k).push(r.netR);}
  if(rows.length<100||blocks.size<3)return null;
  let seed=1729;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const all=[...blocks.values()],means=[];
  for(let i=0;i<2000;i++){const values=[];for(let j=0;j<all.length;j++)values.push(...all[Math.floor(random()*all.length)]);means.push(mean(values));}
  means.sort((a,b)=>a-b);return {low:means[49],high:means[1949],blocks:all.length};
}
if(selected){
  const later=read('ai-replay.json');if(!later.complete)throw Error('Later replay incomplete');
  const rows=labeled(later.rows,selected.profile,END),e=evaluate(selected.model,rows);
  e.gate=gate(e.selected,e.metrics,e.portfolio,e.stressPortfolio,100);e.ci=ci(e.selected);
  if(!e.ci||e.ci.low<=0){e.gate.pass=false;e.gate.failures.push('osäkert positivt netto-R');}
  final=e;
}
const result={createdAt:new Date().toISOString(),periods:{trainEnd:TRAIN_END,validationEnd:VALID_END,end:END},
  developmentCandidates:development.rows.length,analysis,trials,selected:selected?.id??null,final,
  readyForDemo:!!final?.gate.pass,protocolHash:createHash('sha256').update(readFileSync(new URL('crypto-ai-v2-protocol.md',import.meta.url))).digest('hex')};
writeFileSync(new URL('ai-v2-benchmark.json',root),JSON.stringify(result));
console.log(JSON.stringify({selected:result.selected,readyForDemo:result.readyForDemo,analysis},null,2));
