import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_FEATURES,AI_STEP as STEP} from '../crypto-ai.js';
import {variant,label,fitTrees,predict,portfolio,gate,metrics} from '../research/crypto-ai-v2-core.mjs';

const base={side:'long',inst:'BTC',signalId:'BTC|trend|long@0',signalOpened:0,at:0,entry:100.05,rawEntry:100,
  sl:99,tp:103,slippage:.0005,atr:.1,features:AI_FEATURES.map((_,i)=>i===3?.1:0),
  checks:['data','geometry','net','age','chase'].map(key=>({key,ok:true}))};
const bar=(t,c=100)=>({t,o:c,h:c+.05,l:c-.05,c,v:1});

test('wider stop and time limit are deterministic and unrelated to future candles',()=>{
  const a=variant(base,'wide24'),b=variant(base,'wide6');
  assert.equal(a.sl,99.4);assert.equal(a.tp,101.8);assert.equal(a.eligible,true);
  assert.equal(a.deadline-a.nextBar,24*3600000);assert.equal(b.deadline-b.nextBar,6*3600000);
  assert.ok(Math.abs(a.x[4]-6)<1e-10);assert.ok(a.x[6]>1.5);
  assert.equal(variant({...base,checks:[...base.checks,{key:'age',ok:false}]},'wide24').eligible,false);
});

test('labels exclude boundary-crossing outcomes and debit only funding while held',()=>{
  const row=variant(base,'original'),bars=Array.from({length:300},(_,i)=>bar(i*STEP));
  bars[3]={t:3*STEP,o:100,h:104,l:99.5,c:103,v:1};
  const f=[{t:0,rate:.5},{t:2*STEP,rate:.001},{t:8*STEP,rate:.5}];
  const done=label(row,bars,f,10*STEP);
  assert.equal(done.reasonOutcome,'TP');assert.ok(Math.abs(done.fundingR-.1/row.risk)<1e-12);
  assert.equal(label(row,bars,f,done.closed),null);
  assert.equal(label(row,bars,f,done.closed-1),null);
  const future=[...bars];future[9]={...bar(9*STEP),h:10000};
  assert.deepEqual(label(row,future,f,10*STEP),done);
});

test('short funding sign and gap stop losses reconcile independently',()=>{
  const row=variant({...base,side:'short',entry:99.95,sl:101,tp:97},'original');
  const bars=Array.from({length:300},(_,i)=>bar(i*STEP));
  bars[3]={t:3*STEP,o:102,h:103,l:101,c:102,v:1};
  const done=label(row,bars,[{t:2*STEP,rate:.001}],10*STEP);
  assert.equal(done.reasonOutcome,'SL');assert.ok(done.fundingR<0);assert.ok(done.netR<-1);
  const expected=(row.entry-done.exit-row.fee*(row.entry+done.exit)+.1)/row.risk;
  assert.ok(Math.abs(expected-done.netR)<1e-12);
});

test('trees learn a nonlinear relation without fitting to test labels',()=>{
  const rows=Array.from({length:400},(_,i)=>{const x=AI_FEATURES.map(()=>0);x[0]=(i%100)/50-1;return {x,y:Math.abs(x[0])>.5?1:-1};});
  const model=fitTrees(rows,{trees:30,minLeaf:20,rate:.1,bins:16});
  const x=AI_FEATURES.map(()=>0),outer=[...x];outer[0]=.9;
  assert.ok(predict(model,outer)>.5);assert.ok(predict(model,x)<-.5);
  const snapshot=JSON.stringify(model);rows[0].y=1000;assert.equal(JSON.stringify(model),snapshot);
});

test('portfolio enforces one position, 0.5% stop risk and 2x cap',()=>{
  const row=variant(base,'original'),bars=Array.from({length:30},(_,i)=>bar(i*STEP));
  const d={BTC:{bars,fundingMap:new Map()}},trade={...row,closed:4*STEP,netR:-1};
  const result=portfolio([trade,{...trade,at:STEP,signalId:'overlap'}],d);
  assert.equal(result.n,1);assert.ok(Math.abs(result.balance-99.5)<1e-10);
  const tight={...trade,risk:.0001};const capped=portfolio([tight],d);
  assert.ok(Math.abs(capped.balance-(100-200/row.entry*.0001))<1e-10);
});

test('zero trades and cost-fragile positive trades cannot qualify for demo',()=>{
  const emptyBook={n:0,maxDDPct:0,returnPct:0};assert.equal(gate([],metrics([]),emptyBook,emptyBook).pass,false);
  const rows=Array.from({length:60},(_,i)=>({inst:['BTC','ETH','SOL'][i%3],netR:i%5===0?-1:1,stressR:-.1}));
  const book={n:30,maxDDPct:2,returnPct:5};const result=gate(rows,metrics(rows),book,book);
  assert.equal(result.pass,false);assert.ok(result.failures.includes('kostnadsstress inte positiv'));
  rows.forEach(r=>r.stressR=.1);assert.equal(gate(rows,metrics(rows),book,book).pass,true);
});
