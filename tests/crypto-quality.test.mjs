import test from 'node:test';
import assert from 'node:assert/strict';
import {cryptoContext,reviewCrypto,CRYPTO_RULES} from '../crypto-quality.js';
const STEP=300000;
function fixture(dir=1){
  const bars=Array.from({length:1008},(_,i)=>{const c=100+dir*i*.02;return {t:i*STEP,o:c-dir*.08,h:c+(dir>0?.01:.1),l:c-(dir>0?.1:.01),c,v:10};});
  bars.at(-1).v=20;
  const now=bars.length*STEP,px=bars.at(-1).c;
  return {now,ctx:{bars,px,simulated:false},s:{status:'ACTIVE',side:dir>0?'long':'short',entry:px,sl:px-dir*px*.02,tp:px+dir*px*.06,oppnad:now-STEP}};
}
test('both long and short setups can satisfy all checks with a closed trigger',()=>{
  for(const dir of [1,-1]){const {ctx,s,now}=fixture(dir),r=reviewCrypto(s,ctx,now);assert.equal(r.pass,true,JSON.stringify(r.failed));assert.equal(r.trend,dir);assert.ok(r.netRR>2);}
});
test('future and unfinished candles do not change closed indicators',()=>{
  const {ctx,now}=fixture(),before=cryptoContext(ctx.bars,now);
  const more=cryptoContext([...ctx.bars,{...ctx.bars.at(-1),t:now,c:999,h:1000,v:100000}],now);
  for(const key of ['trend','atr','relativeVolume','last','prev'])assert.deepEqual(more[key],before[key]);
  const past=now-6*STEP;
  assert.deepEqual(cryptoContext(ctx.bars,past).last,cryptoContext(ctx.bars.filter(b=>b.t+STEP<=past),past).last);
});
test('missing, gapped, stale, future-dated and synthetic data fail closed',()=>{
  const {ctx,s,now}=fixture();
  const cases=[undefined,{...ctx,simulated:true},{...ctx,bars:[]},{...ctx,bars:ctx.bars.filter((_,i)=>i!==990)},
    {...ctx,bars:ctx.bars.map((b,i)=>i===1007?{...b,t:now+STEP}:b)}, {...ctx,px:NaN}];
  for(const c of cases)assert.ok(reviewCrypto(s,c,now).failed.some(x=>x.key==='data'));
  assert.ok(reviewCrypto(s,ctx,now+11*60000).failed.some(x=>x.key==='data'));
});
test('tight stops can pass without a cost-share cap, but net RR still includes costs',()=>{
  for(const dir of [1,-1]){
    const {ctx,s,now}=fixture(dir);s.sl=ctx.px*(1-dir*.001);s.tp=ctx.px*(1+dir*.03);
    const r=reviewCrypto(s,ctx,now);assert.ok(r.netRR>1.5);assert.equal(r.pass,true);
    assert.equal(r.checks.length,8);
    s.tp=ctx.px*(1+dir*.003);
    const smallTarget=reviewCrypto(s,ctx,now);
    assert.equal(smallTarget.pass,false);assert.ok(smallTarget.failed.some(x=>x.key==='net'));
  }
});
test('net RR independently reconciles long/short fees and adverse fills',()=>{
  for(const dir of [1,-1]){const {ctx,s,now}=fixture(dir),r=reviewCrypto(s,ctx,now),{fee,slippage}=CRYPTO_RULES;
    const entry=ctx.px*(1+dir*slippage),stop=s.sl*(1-dir*slippage),target=s.tp*(1-dir*slippage);
    const expected=(dir*(target-entry)-fee*(entry+target))/(dir*(entry-stop)+fee*(entry+stop));
    assert.equal(r.netRR,expected);assert.ok(r.netRR<3);
  }
});
test('old signals, missing activation time and chasing reject new entries',()=>{
  const {ctx,s,now}=fixture();
  for(const oppnad of [undefined,now-31*60000,now+1])assert.ok(reviewCrypto({...s,oppnad},ctx,now).failed.some(x=>x.key==='age'));
  assert.ok(reviewCrypto({...s,entry:s.entry-2},ctx,now).failed.some(x=>x.key==='chase'));
  const waiting=reviewCrypto({...s,status:'VÄNTAR',oppnad:undefined},ctx,now);assert.equal(waiting.basis,'planerad entry');assert.ok(!waiting.failed.some(x=>x.key==='age'));
});
test('stop beyond liquidation is rejected even when RR is attractive',()=>{
  const {ctx,s,now}=fixture();s.sl=ctx.px*.94;s.tp=ctx.px*1.2;
  assert.ok(reviewCrypto(s,ctx,now).failed.some(x=>x.key==='geometry'));
});
test('volume and closed candle confirmation are independent requirements',()=>{
  const {ctx,s,now}=fixture();ctx.bars.at(-1).v=1;
  assert.ok(reviewCrypto(s,ctx,now).failed.some(x=>x.key==='volume'));
  ctx.bars.at(-1).v=20;ctx.bars.at(-1).o=ctx.bars.at(-1).c+.02;ctx.bars.at(-1).h=ctx.bars.at(-1).o+.01;
  assert.ok(reviewCrypto(s,ctx,now).failed.some(x=>x.key==='trigger'));
});
