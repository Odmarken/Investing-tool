import {AI_FEATURES,predictR,newShadow,settleShadow,AI_STEP,AI_HORIZON} from '../crypto-ai.js';
import {CRYPTO_RULES} from '../crypto-quality.js';
export const PROFILES=['original','wide24','wide6'];
export const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

// Shallow gradient boosted regression trees. Split candidates use train X only.
export function fitTrees(rows,{trees=60,rate=.05,minLeaf=80,bins=16}={}){
  if(rows.length<2*minLeaf||rows.some(r=>r.x.length!==AI_FEATURES.length||!r.x.every(Number.isFinite)||!Number.isFinite(r.y)))throw Error('Insufficient finite training samples');
  const cuts=AI_FEATURES.map((_,j)=>{const sorted=rows.map(r=>r.x[j]).sort((a,b)=>a-b);
    return [...new Set(Array.from({length:bins},(_,k)=>sorted[Math.floor(sorted.length*(k+1)/(bins+1))]))];});
  const bias=mean(rows.map(r=>r.y)),predictions=rows.map(()=>bias),forest=[];
  const grow=(indices,residual,depth)=>{
    const sum=indices.reduce((s,i)=>s+residual[i],0),value=sum/indices.length;
    if(!depth||indices.length<2*minLeaf)return {value};
    let best=null,gain=0;
    for(let j=0;j<cuts.length;j++)for(const cut of cuts[j]){
      let n=0,leftSum=0;
      for(const i of indices)if(rows[i].x[j]<=cut){n++;leftSum+=residual[i];}
      if(n<minLeaf||indices.length-n<minLeaf)continue;
      const g=leftSum**2/n+(sum-leftSum)**2/(indices.length-n)-sum**2/indices.length;
      if(g>gain+1e-12){gain=g;best={feature:j,cut};}
    }
    if(!best)return {value};
    const left=[],right=[];
    for(const i of indices)(rows[i].x[best.feature]<=best.cut?left:right).push(i);
    return {...best,left:grow(left,residual,depth-1),right:grow(right,residual,depth-1)};
  };
  for(let k=0;k<trees;k++){
    const residual=rows.map((r,i)=>r.y-predictions[i]),tree=grow(rows.map((_,i)=>i),residual,2);
    forest.push(tree);for(let i=0;i<rows.length;i++)predictions[i]+=rate*treeValue(tree,rows[i].x);
  }
  return {kind:'trees',features:AI_FEATURES,bias,rate,forest,settings:{trees,rate,minLeaf,bins}};
}
export function treeValue(tree,x){return 'value' in tree?tree.value:treeValue(x[tree.feature]<=tree.cut?tree.left:tree.right,x);}
export const predict=(model,x)=>model.kind==='trees'?model.bias+model.rate*model.forest.reduce((s,t)=>s+treeValue(t,x),0):predictR(model,x);

export function variant(row,profile,slippage=.0005){
  const dir=row.side==='long'?1:-1,px=row.rawEntry??row.entry/(1+dir*row.slippage);
  const atr=row.atr??row.features[3]*px/100;
  const distance=profile==='original'?dir*(px-row.sl):Math.max(2*atr,.006*px);
  const sl=px-dir*distance,tp=profile==='original'?row.tp:px+dir*3*distance;
  const signal={id:row.signalId,inst:row.inst,side:row.side,sl,tp,oppnad:row.signalOpened};
  const out=newShadow(signal,{px},row.at,{},'v2');
  out.slippage=slippage;out.entry=px*(1+dir*slippage);
  const stop=sl*(1-dir*slippage),target=tp*(1-dir*slippage);
  out.risk=dir*(out.entry-stop)+out.fee*(out.entry+stop);
  out.deadline=out.nextBar+(profile==='wide6'?6*3600000:AI_HORIZON);
  const netRR=(dir*(target-out.entry)-out.fee*(out.entry+target))/out.risk;
  const x=[...row.features];x[4]=clamp(distance/atr,0,30);x[5]=clamp(dir*(tp-px)/atr,0,50);x[6]=clamp(netRR,-3,20);
  const basic=row.checks.filter(c=>['data','age','chase'].includes(c.key)).every(c=>c.ok);
  const liquidation=out.entry*(1+dir*(-1/CRYPTO_RULES.leverage+CRYPTO_RULES.maintenance));
  const eligible=basic&&dir*(sl-liquidation)>0&&dir*(out.entry-sl)>0&&dir*(tp-out.entry)>0&&netRR>=1.5;
  return {...out,x,eligible,profile,px,atr,fam:row.fam??row.signalId.split('|')[1],selective:row.selective};
}

export function label(row,bars,funding,limit){
  const i=Math.round((row.at-bars[0].t)/AI_STEP),tail=bars.slice(i+1,i+290);
  const done=settleShadow(row,tail,Math.min(limit,row.deadline+AI_STEP));
  if(done.status!=='closed'||done.closed>=limit)return null;
  const dir=row.side==='long'?1:-1;
  let fundingCost=0;
  for(const f of funding)if(f.t>row.at&&f.t<done.closed){
    const b=bars[(f.t-bars[0].t)/AI_STEP];if(!b)throw Error('Missing funding mark');fundingCost+=dir*f.rate*b.o;
  }
  const before=bars.slice(i+1,(done.closed-AI_STEP-bars[0].t)/AI_STEP);
  const favorable=before.length?Math.max(0,...before.map(b=>dir>0?b.h-row.entry:row.entry-b.l)):0;
  const adverse=before.length?Math.max(0,...before.map(b=>dir>0?row.entry-b.l:b.h-row.entry)):0;
  return {...done,netBeforeFunding:done.netR,netR:done.netR-fundingCost/row.risk,fundingR:fundingCost/row.risk,
    mfeR:favorable/row.risk,maeR:adverse/row.risk,holdingHours:(done.closed-row.at)/3600000};
}

export function metrics(rows){
  const gains=rows.filter(r=>r.netR>0).reduce((s,r)=>s+r.netR,0),losses=-rows.filter(r=>r.netR<0).reduce((s,r)=>s+r.netR,0);
  return {n:rows.length,meanR:mean(rows.map(r=>r.netR)),winRate:rows.length?rows.filter(r=>r.netR>0).length/rows.length:null,
    pf:losses?gains/losses:gains?Infinity:null,stressR:mean(rows.map(r=>r.stressR).filter(Number.isFinite))};
}

// One position, no borrowed risk budget. Drawdown includes 5m mark-to-market.
export function portfolio(rows,data,stress=false){
  const candidates=[...rows].sort((a,b)=>a.at-b.at||a.signalId.localeCompare(b.signalId));
  let balance=100,peak=100,maxDD=0,until=0;const trades=[];
  for(const r of candidates){
    if(r.at<until)continue;
    const p=stress?r.stress:r;
    if(!p||!Number.isFinite(p.netR))continue;
    const units=Math.min(balance*.005/p.risk,balance*2/p.entry),net=units*p.netR*p.risk;
    const bars=data[r.inst].bars,dir=r.side==='long'?1:-1;
    let funds=0;
    for(const b of bars.slice(Math.ceil((r.at-bars[0].t)/AI_STEP),(r.closed-bars[0].t)/AI_STEP-1)){
      const rate=data[r.inst].fundingMap.get(b.t)||0;if(b.t>r.at)funds+=dir*rate*b.o;
      const equity=balance+units*(dir*(b.c-p.entry)-p.fee*(p.entry+b.c)-funds);
      peak=Math.max(peak,equity);maxDD=Math.max(maxDD,1-equity/peak);
    }
    balance+=net;peak=Math.max(peak,balance);maxDD=Math.max(maxDD,1-balance/peak);
    trades.push({at:r.at,closed:r.closed,inst:r.inst,pnl:net,balance});until=r.closed;
  }
  return {n:trades.length,balance,returnPct:balance-100,maxDDPct:100*maxDD,trades};
}

export function gate(sample,summary,book,stressBook,minimum=50){
  const symbols=[...new Set(sample.map(r=>r.inst))];
  const positiveCoins=symbols.filter(s=>{const m=metrics(sample.filter(r=>r.inst===s));return m.n>=10&&m.meanR>0;});
  const failures=[];
  if(summary.n<minimum)failures.push('för få valda signaler');
  if(!(summary.meanR>0))failures.push('negativt eller saknat snitt-R');
  if(!(summary.stressR>0))failures.push('kostnadsstress inte positiv');
  if(!(summary.pf>=1.15))failures.push('profit factor under 1,15');
  if(positiveCoins.length<3)failures.push('för få positiva coins');
  if(!(book.maxDDPct<=10&&stressBook.maxDDPct<=10))failures.push('för stor nedgång');
  if(!(book.returnPct>0&&stressBook.returnPct>0))failures.push('portfölj inte positiv efter kostnader');
  if(book.n<minimum*.4||stressBook.n<minimum*.4)failures.push('för få separata portföljtrades');
  return {pass:!failures.length,failures,positiveCoins};
}
