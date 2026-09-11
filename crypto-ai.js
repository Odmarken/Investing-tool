// Shared by offline training and browser inference. No network or account writes.
import { cryptoContext, reviewCrypto, CRYPTO_RULES } from './crypto-quality.js';

export const AI_STEP = 300000;
export const AI_HORIZON = 24 * 3600000;
export const AI_FEATURES = ['direction','hourTrend','relativeVolume','atrPct','stopATR','targetATR','netRR','bodyATR','return1hATR','closeLocation','trigger'];
const finite = Number.isFinite;
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));

export function aiFeatures(signal,ctx,now,snapshot){
  const market = snapshot || cryptoContext(ctx?.bars,now);
  const review = reviewCrypto(signal,ctx,now,CRYPTO_RULES,market);
  if(signal.status !== 'ACTIVE' || !market.valid || !review.checks.find(c=>c.key==='data')?.ok ||
    !review.checks.find(c=>c.key==='geometry')?.ok) return null;
  const dir = signal.side === 'long' ? 1 : -1, px = ctx.px, a = market.atr;
  const bars = ctx.bars.filter(b=>b.t+AI_STEP<=now), last=market.last, prevHour=bars.at(-13);
  if(!prevHour || !(a>0) || !finite(market.relativeVolume) || !finite(review.netRR)) return null;
  const x = [dir,dir*market.trend,clamp(market.relativeVolume,0,10),100*a/px,
    clamp(dir*(px-signal.sl)/a,0,30),clamp(dir*(signal.tp-px)/a,0,50),clamp(review.netRR,-3,20),
    clamp(dir*(last.c-last.o)/a,-5,5),clamp(dir*(last.c-prevHour.c)/a,-20,20),
    last.h>last.l?(dir>0?last.c-last.l:last.h-last.c)/(last.h-last.l):.5,
    Number(review.checks.find(c=>c.key==='trigger').ok)];
  return x.every(finite)?{x,review}:null;
}

export function predictR(model,x){
  if(model?.features?.join('|')!==AI_FEATURES.join('|') || !x || x.length!==AI_FEATURES.length ||
    !x.every(finite) || !finite(model.bias) || !['mean','scale','weights'].every(k=>
      Array.isArray(model[k])&&model[k].length===x.length&&model[k].every(finite)) || model.scale.some(s=>s<=0)) return null;
  const r=model.bias+x.reduce((s,v,i)=>s+clamp((v-model.mean[i])/model.scale[i],-5,5)*model.weights[i],0);
  return finite(r)?r:null;
}

export function assessAI(signal,ctx,now,model,snapshot){
  if(!model?.symbols?.includes(signal.inst)) return null;
  const f=aiFeatures(signal,ctx,now,snapshot);
  if(!f) return null;
  const expectedR=predictR(model,f.x);
  if(expectedR===null || now<model.trainEnd || now>model.dataEnd+30*86400000) return null;
  const hardKeys=['data','geometry','net','age','chase'];
  const safe=f.review.checks.filter(c=>hardKeys.includes(c.key)).every(c=>c.ok);
  return {expectedR,accepted:safe&&expectedR>=model.threshold,selective:f.review.pass,
    reason:!safe?'Grundkrav saknas':expectedR>=model.threshold?'Modellen skulle ta':'Modellen skulle avstå',
    features:f.x,checks:f.review.checks.map(c=>({key:c.key,ok:c.ok}))};
}

export function shadowKey(signal,version){
  return JSON.stringify([version,signal.inst,signal.id,signal.side,signal.oppnad]);
}

export function newShadow(signal,ctx,now,assessment,version){
  if(!assessment || !finite(signal.oppnad)) return null;
  const dir=signal.side==='long'?1:-1,entry=ctx.px*(1+dir*CRYPTO_RULES.slippage);
  const stopFill=signal.sl*(1-dir*CRYPTO_RULES.slippage);
  const risk=dir*(entry-stopFill)+CRYPTO_RULES.fee*(entry+stopFill);
  if(!(risk>0)) return null;
  // Ignore the decision candle's extremes: some occurred before the decision.
  const nextBar=Math.floor(now/AI_STEP)*AI_STEP+AI_STEP;
  return {key:shadowKey(signal,version),version,inst:signal.inst,side:signal.side,
    signalId:signal.id,signalOpened:signal.oppnad,at:now,entry,sl:signal.sl,tp:signal.tp,risk,
    nextBar,deadline:nextBar+AI_HORIZON,fee:CRYPTO_RULES.fee,slippage:CRYPTO_RULES.slippage,
    ...assessment,status:'pending'};
}

// Frozen SL/TP, stop first on ambiguous bars, adverse stop gaps. No funding.
// Returns a new record only on a cursor advance or a final/unknown outcome.
export function settleShadow(row,bars=[],now=Date.now()){
  if(row.status!=='pending') return row;
  const closed=bars.filter(b=>b.t>=row.nextBar&&b.t+AI_STEP<=now);
  if(!closed.length) return now>row.deadline+AI_STEP?{...row,status:'unknown',reasonOutcome:'Prisdata saknas'}:row;
  let expected=row.nextBar;
  for(const b of closed){
    if(b.t!==expected || ![b.o,b.h,b.l,b.c].every(v=>finite(v)&&v>0) ||
      b.h<Math.max(b.o,b.c,b.l) || b.l>Math.min(b.o,b.c))
      return {...row,status:'unknown',reasonOutcome:'Lucka eller fel i prisdata'};
    const dir=row.side==='long'?1:-1;
    const stop=dir>0?b.l<=row.sl:b.h>=row.sl, target=dir>0?b.h>=row.tp:b.l<=row.tp;
    const timeout=b.t+AI_STEP>=row.deadline;
    if(stop||target||timeout){
      const raw=stop?(dir>0?Math.min(b.o,row.sl):Math.max(b.o,row.sl)):target?row.tp:b.c;
      const exit=raw*(1-dir*row.slippage);
      const net=dir*(exit-row.entry)-row.fee*(row.entry+exit);
      return {...row,status:'closed',closed:b.t+AI_STEP,exit,netR:net/row.risk,
        reasonOutcome:stop?'SL':target?'TP':'24 h'};
    }
    expected+=AI_STEP;
  }
  return expected!==row.nextBar?{...row,nextBar:expected}:row;
}

export function shadowStats(rows){
  return [['Alla',()=>true],['Selektiv',r=>r.selective],['AI skulle ta',r=>r.accepted],
    ['AI + Selektiv',r=>r.accepted&&r.selective]].map(([label,keep])=>{
      const selected=rows.filter(keep),done=selected.filter(r=>r.status==='closed'&&finite(r.netR));
      return {label,n:selected.length,closed:done.length,unknown:selected.filter(r=>r.status==='unknown').length,
        meanR:done.length?done.reduce((s,r)=>s+r.netR,0)/done.length:null,
        winRate:done.length?done.filter(r=>r.netR>0).length/done.length:null};
    });
}
