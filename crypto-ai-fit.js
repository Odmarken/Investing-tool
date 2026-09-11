// Small ridge regression; standardisation is fitted on training rows only.
import { AI_FEATURES } from './crypto-ai.js';
export function fitRidge(rows,lambda=30){
  if(rows.length<100 || rows.some(r=>r.x.length!==AI_FEATURES.length || !r.x.every(Number.isFinite)||!Number.isFinite(r.y)))
    throw Error('At least 100 finite training samples required');
  const n=rows.length,p=AI_FEATURES.length;
  const mean=Array.from({length:p},(_,j)=>rows.reduce((s,r)=>s+r.x[j],0)/n);
  const scale=mean.map((m,j)=>Math.sqrt(rows.reduce((s,r)=>s+(r.x[j]-m)**2,0)/n)||1);
  const matrix=Array.from({length:p+1},()=>Array(p+2).fill(0));
  for(const r of rows){
    const x=[1,...r.x.map((v,j)=>Math.max(-5,Math.min(5,(v-mean[j])/scale[j])))];
    for(let j=0;j<=p;j++){
      for(let k=0;k<=p;k++)matrix[j][k]+=x[j]*x[k];
      matrix[j][p+1]+=x[j]*r.y;
    }
  }
  for(let j=1;j<=p;j++)matrix[j][j]+=lambda;
  for(let j=0;j<=p;j++){
    let pivot=j;
    for(let k=j+1;k<=p;k++)if(Math.abs(matrix[k][j])>Math.abs(matrix[pivot][j]))pivot=k;
    [matrix[j],matrix[pivot]]=[matrix[pivot],matrix[j]];
    const div=matrix[j][j];if(Math.abs(div)<1e-12)throw Error('Singular fit');
    for(let k=j;k<=p+1;k++)matrix[j][k]/=div;
    for(let i=0;i<=p;i++)if(i!==j){const factor=matrix[i][j];for(let k=j;k<=p+1;k++)matrix[i][k]-=factor*matrix[j][k];}
  }
  return {features:AI_FEATURES,mean,scale,bias:matrix[0][p+1],weights:matrix.slice(1).map(r=>r[p+1])};
}
