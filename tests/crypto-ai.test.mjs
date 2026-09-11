import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_FEATURES,AI_STEP,aiFeatures,predictR,assessAI,newShadow,settleShadow,shadowStats,shadowKey} from '../crypto-ai.js';
import {fitRidge} from '../crypto-ai-fit.js';
import {readAILog,mountCryptoAI,researchHTML} from '../crypto-ai-ui.js';
import {CRYPTO_AI_RESEARCH} from '../crypto-ai-research.js';
import {CRYPTO_AI_MODEL} from '../crypto-ai-model.js';

function fixture(side='long'){
  const dir=side==='long'?1:-1;
  const bars=Array.from({length:1008},(_,i)=>{const c=100+dir*i*.02;return {t:i*AI_STEP,o:c-dir*.08,h:c+.1,l:c-.1,c,v:10};});
  const now=bars.length*AI_STEP,px=bars.at(-1).c;
  return {now,ctx:{px,bars,simulated:false},s:{id:'signal',inst:'BTC',grade:'A',side,status:'ACTIVE',entry:px,sl:px-dir*px*.02,tp:px+dir*px*.06,oppnad:now}};
}
const stubModel=now=>({features:AI_FEATURES,mean:AI_FEATURES.map(()=>0),scale:AI_FEATURES.map(()=>1),
  weights:AI_FEATURES.map(()=>0),bias:.5,version:'test',threshold:.1,symbols:['BTC'],trainEnd:0,dataEnd:now});

test('failed research is shown separately without suggesting automatic trading is enabled',()=>{
  const html=researchHTML(CRYPTO_AI_RESEARCH);
  assert.equal(CRYPTO_AI_RESEARCH.readyForDemo,false);
  assert.equal(CRYPTO_AI_RESEARCH.finalEvaluated,false);
  assert.match(html,/ingen godkänd modell/);assert.match(html,/aktiverades inte/);
  assert.equal(CRYPTO_AI_RESEARCH.trials.length,6);
  assert.ok(CRYPTO_AI_RESEARCH.trials.every(t=>t.selectedN===0&&!t.pass));
  assert.doesNotMatch(researchHTML({...CRYPTO_AI_RESEARCH,conclusion:'<script>bad</script>'}),/<script>/);
});

test('features and prediction do not read unfinished or future OHLCV',()=>{
  const {s,ctx,now}=fixture(),f=aiFeatures(s,ctx,now);
  assert.ok(f);
  const extra={...ctx,bars:[...ctx.bars,{t:now,o:1,h:9999,l:1,c:9999,v:1e12}]};
  assert.deepEqual(aiFeatures(s,extra,now).x,f.x);
  assert.equal(predictR(stubModel(now),f.x),.5);
  assert.equal(assessAI(s,{...ctx,simulated:true},now,stubModel(now)),null);
  assert.equal(assessAI(s,{...ctx,px:NaN},now,stubModel(now)),null);
  assert.equal(assessAI(s,{...ctx,bars:ctx.bars.filter((_,i)=>i!==999)},now,stubModel(now)),null);
});

test('model schema, stale model, unsupported instruments and old signals fail closed',()=>{
  const {s,ctx,now}=fixture(),m=stubModel(now),f=aiFeatures(s,ctx,now);
  assert.equal(predictR({...m,features:['wrong']},f.x),null);
  assert.equal(predictR({...m,bias:NaN},f.x),null);
  assert.equal(predictR({...m,scale:m.scale.map(()=>0)},f.x),null);
  assert.equal(assessAI({...s,inst:'NQ'},ctx,now,m),null);
  assert.equal(assessAI(s,ctx,now,{...m,dataEnd:now-31*86400000}),null);
  assert.equal(assessAI({...s,oppnad:now-31*60000},ctx,now,m).accepted,false);
  assert.notEqual(shadowKey(s,'v1'),shadowKey(s,'v2'));
});

test('both directions reconcile fills and fees; decision-bar extremes are ignored',()=>{
  for(const side of ['long','short']){
    const {s,ctx,now}=fixture(side),a=assessAI(s,ctx,now,stubModel(now));
    const r=newShadow(s,ctx,now,a,'test'),dir=side==='long'?1:-1;
    const before={t:now,o:ctx.px,h:ctx.px*2,l:ctx.px/2,c:ctx.px};
    assert.equal(settleShadow(r,[before],now+AI_STEP),r);
    const both={t:r.nextBar,o:ctx.px,h:Math.max(s.sl,s.tp)+1,l:Math.min(s.sl,s.tp)-1,c:ctx.px};
    const done=settleShadow(r,[both],r.nextBar+AI_STEP);
    assert.equal(done.reasonOutcome,'SL');assert.ok(Math.abs(done.netR+1)<1e-10);
    const gap={...both,o:s.sl-dir*1,h:Math.max(s.sl,s.tp)+1,l:Math.min(s.sl,s.tp)-1};
    assert.ok(settleShadow(r,[gap],r.nextBar+AI_STEP).netR < -1);
    assert.equal(r.status,'pending');assert.equal(settleShadow(done,[both],now+10*AI_STEP),done);
  }
});

test('gaps become unknown, pending outcomes survive reload and expire at 24h',()=>{
  const {s,ctx,now}=fixture(),r=newShadow(s,ctx,now,assessAI(s,ctx,now,stubModel(now)),'test');
  const bar=t=>({t,o:ctx.px,h:ctx.px+.1,l:ctx.px-.1,c:ctx.px});
  assert.equal(settleShadow(r,[bar(r.nextBar+AI_STEP)],r.nextBar+2*AI_STEP).status,'unknown');
  const pending=settleShadow(r,[bar(r.nextBar)],r.nextBar+AI_STEP);
  const reloaded=JSON.parse(JSON.stringify(pending));
  assert.equal(reloaded.nextBar,r.nextBar+AI_STEP);
  const rest=Array.from({length:287},(_,i)=>bar(reloaded.nextBar+i*AI_STEP));
  const done=settleShadow(reloaded,rest,r.deadline);
  assert.equal(done.status,'closed');assert.equal(done.reasonOutcome,'24 h');assert.ok(done.netR<0);
  assert.equal(settleShadow(r,[],r.deadline+2*AI_STEP).status,'unknown');
});

test('ridge learns from supplied training labels; generated artifact has a purged time split',()=>{
  const rows=Array.from({length:200},(_,i)=>({x:AI_FEATURES.map((_,j)=>j===0?(i-100)/100:0),y:2*(i-100)/100-.3}));
  const m=fitRidge(rows,1);
  assert.ok(predictR(m,rows.at(-1).x)>1.6);assert.ok(predictR(m,rows[0].x)<-2.2);
  assert.ok(CRYPTO_AI_MODEL.training.lastOutcome<CRYPTO_AI_MODEL.evaluation.from);
  assert.equal(CRYPTO_AI_MODEL.validated,false);
  assert.equal(CRYPTO_AI_MODEL.evaluation.kind,'retrospective');
});

test('summary excludes unknown and unresolved results instead of counting them as losses',()=>{
  const stats=shadowStats([{status:'closed',netR:2,accepted:true,selective:false},{status:'closed',netR:-1,accepted:false,selective:true},
    {status:'unknown',accepted:true},{status:'pending',accepted:true}]);
  assert.equal(stats[0].meanR,.5);assert.equal(stats[0].winRate,.5);
  assert.equal(stats[2].n,3);assert.equal(stats[2].closed,1);assert.equal(stats[2].unknown,1);assert.equal(stats[2].meanR,2);
  assert.equal(stats[3].meanR,null);
  assert.throws(()=>readAILog({getItem:()=>'{bad'},'key'));
});

test('UI freezes first judgement, scopes logs to login and retries failed storage',()=>{
  const {s,ctx,now}=fixture(),model={...stubModel(now),training:{n:100},evaluation:{stats:[{label:'Alla',n:20,meanR:-.2},{label:'AI skulle ta',n:0}]}};
  const nodes=new Map(),root={innerHTML:'',querySelector:key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);}};
  const values=new Map();let fail=true,writes=0;
  const previous=globalThis.window;
  globalThis.window={localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>{writes++;if(fail)throw Error('full');values.set(k,v);}}};
  try{
    const ui=mountCryptoAI(root,model,()=>true,()=>{});
    const args={userId:'one',signals:[s],contexts:{BTC:ctx},now,snapshots:new Map()};
    ui.update(args);assert.match(nodes.get('[data-ai-state]').textContent,/lagringen misslyckades/);
    fail=false;ui.update(args);assert.equal(writes,2);
    const key='riptide.crypto-ai.v1:one',first=JSON.parse(values.get(key));assert.equal(first.length,1);
    ui.update({...args,contexts:{BTC:{...ctx,px:ctx.px+.1}},now:now+1000});
    assert.equal(JSON.parse(values.get(key))[0].entry,first[0].entry);
    ui.update({...args,userId:'two',signals:[]});assert.doesNotMatch(nodes.get('[data-ai-rows]').innerHTML,/BTC/);
    assert.equal(values.has('riptide.crypto-ai.v1:two'),false);
  }finally{globalThis.window=previous;}
});
