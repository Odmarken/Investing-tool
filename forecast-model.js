// AI Forecast model: windowed indicators, the regime and breakout rules of
// af-signal-v1 and the af-forecast-v1 analog forecast. The forecast is a
// k-nearest-neighbour statistical baseline over the coin's own history, not a
// neural network or a language model. Everything here is pure and
// deterministic. Every value at bar i comes from a fixed-length window of
// closed bars ending at i, and the EMA/RSI/ATR/ADX recursions are re-seeded
// inside that window, so later bars cannot change it (no look-ahead) and
// neither can where a reload starts the history (no repaint).
import {MODEL,TF,SIGNAL_PARAMS,FORECAST_PARAMS} from './forecast-config.js';
export * from './forecast-config.js';

const DAY=86400000,WEEK=7*DAY,NBSP='\u00a0',MINUS='\u2212';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const badBar=b=>!b||!finite(b.t)||!positive(b.o)||!positive(b.h)||!positive(b.l)||!positive(b.c);
const tfOf=key=>{if(typeof key!=='string'||!Object.hasOwn(TF,key))throw Error('Okänd tidsram');return TF[key];};
const deepFreeze=x=>{if(x&&typeof x==='object'){for(const k of Object.keys(x))deepFreeze(x[k]);Object.freeze(x);}return x;};
function checkBars(bars){
  if(!Array.isArray(bars))throw Error('Candles saknas');
  if(bars.some(badBar))throw Error('Ogiltig candle');
  return bars;
}
const WINDOWS=['emaFast','emaSlow','emaWindow','slopeBars','adxPeriod','adxWindow','rsiPeriod','rsiWindow','rocPeriod','breakout',
  'volMedian','atrPeriod','atrWindow','volRankWindow','htfEma','htfWindow'];
function checkParams(p){
  if(!p||typeof p!=='object'||WINDOWS.some(k=>!Number.isInteger(p[k])||p[k]<1)||!Number.isInteger(p.cooldown)||p.cooldown<0||
    p.adxWindow<3*p.adxPeriod||![p.adxTrend,p.adxRange,p.volMin,p.volRankMin,p.volRankMax].every(finite)||p.adxRange>p.adxTrend||
    !positive(p.slAtr)||!positive(p.tpR)||![p.rsiLong,p.rsiShort].every(r=>Array.isArray(r)&&r.length===2&&r.every(finite)))
    throw Error('Ogiltiga signalparametrar');
  return p;
}
function checkForecastParams(p){
  const q=p?.quantiles;
  if(!p||![p.horizon,p.k,p.train,p.minCandidates].every(x=>Number.isInteger(x)&&x>=1)||p.train<p.horizon||!Array.isArray(q)||
    q.length!==5||q.some((x,i)=>!(x>0&&x<1)||i&&x<=q[i-1])||q[2]!==.5)throw Error('Ogiltiga prognosparametrar');
  return p;
}

// ---- Time buckets ----------------------------------------------------------
export function bucketStart(t,tfKey){
  const {ms}=tfOf(tfKey);
  if(!finite(t))throw Error('Ogiltig tid');
  // Weeks start Monday 00:00 UTC like Bybit's weekly candles; 1970-01-05 was a Monday.
  return tfKey==='1w'?Math.floor((t-4*DAY)/WEEK)*WEEK+4*DAY:Math.floor(t/ms)*ms;
}
// Higher-timeframe bars from base bars. A bucket counts only when it holds every
// base bar and had closed by cutoffClose, so neither a forming bucket nor one cut
// short at the start of the loaded history is ever used.
export function aggregateClosed(bars,baseTf,htfKey,cutoffClose){
  const base=tfOf(baseTf),htf=tfOf(htfKey),n=htf.ms/base.ms;
  if(!Number.isInteger(n)||n<1)throw Error('Ogiltig högre tidsram');
  if(!Array.isArray(bars))throw Error('Candles saknas');
  if(cutoffClose!=null&&(typeof cutoffClose!=='number'||Number.isNaN(cutoffClose)))throw Error('Ogiltig brytpunkt');
  const cut=cutoffClose??(bars.length?bars.at(-1).t+base.ms:-Infinity),out=[];
  for(let i=0;i<bars.length;){
    const s=bucketStart(bars[i].t,htfKey),end=s+htf.ms;let j=i+1;
    while(j<bars.length&&bars[j].t>=s&&bars[j].t<end)j++;
    if(j-i===n&&end<=cut&&!(out.length&&out.at(-1).t>=s)&&bars.slice(i,j).every((b,k)=>b.t===s+k*base.ms)){
      let h=-Infinity,l=Infinity,v=0;
      for(let k=i;k<j;k++){h=Math.max(h,bars[k].h);l=Math.min(l,bars[k].l);v+=bars[k].v;}
      out.push({t:s,o:bars[i].o,h,l,c:bars[j-1].c,v:finite(v)?v:null});
    }
    i=j;
  }
  return out;
}

// ---- Windowed indicators ----------------------------------------------------
// EMA over the W values ending at i, seeded with the SMA of the window's first p.
function emaAt(x,i,p,W){
  const s=i-W+1;if(s<0)return null;
  let e=0;for(let k=s;k<s+p;k++)e+=x[k];e/=p;
  const a=2/(p+1);for(let k=s+p;k<=i;k++)e+=a*(x[k]-e);
  return e;
}
// Wilder RSI over the W closes ending at i: W-1 changes, seeded with the mean of the first p.
function rsiAt(c,i,p,W){
  const s=i-W+1;if(s<0)return null;
  let g=0,l=0;
  for(let k=s+1;k<=s+p;k++){const d=c[k]-c[k-1];if(d>0)g+=d;else l-=d;}
  g/=p;l/=p;
  for(let k=s+p+1;k<=i;k++){const d=c[k]-c[k-1];g=(g*(p-1)+(d>0?d:0))/p;l=(l*(p-1)+(d<0?-d:0))/p;}
  return l===0?(g===0?50:100):100-100/(1+g/l);
}
// Wilder average of per-bar values x[s+1..i] for the W bars ending at i (x[k] needs bar k-1).
function wilderAt(x,i,p,W){
  const s=i-W+1;if(s<0)return null;
  let a=0;for(let k=s+1;k<=s+p;k++)a+=x[k];a/=p;
  for(let k=s+p+1;k<=i;k++)a=(a*(p-1)+x[k])/p;
  return a;
}
const dxOf=(t,u,d)=>{if(!(t>0))return 0;const a=100*u/t,b=100*d/t;return a+b>0?100*Math.abs(a-b)/(a+b):0;};
// Wilder ADX from scratch over the W bars ending at i.
function adxAt(tr,up,dn,i,p,W){
  const s=i-W+1;if(s<0)return null;
  let t=0,u=0,d=0,n=0,sum=0,adx=null;
  const push=x=>{if(n<p){sum+=x;if(++n===p)adx=sum/p;}else adx=(adx*(p-1)+x)/p;};
  for(let k=s+1;k<=s+p;k++){t+=tr[k];u+=up[k];d+=dn[k];}
  t/=p;u/=p;d/=p;push(dxOf(t,u,d));
  for(let k=s+p+1;k<=i;k++){t=(t*(p-1)+tr[k])/p;u=(u*(p-1)+up[k])/p;d=(d*(p-1)+dn[k])/p;push(dxOf(t,u,d));}
  return adx;
}
// True range and Wilder's directional moves of bar k against bar k-1 (pure per bar pair).
function moves(bars){
  const N=bars.length,tr=new Float64Array(N),up=new Float64Array(N),dn=new Float64Array(N);
  for(let k=1;k<N;k++){
    const b=bars[k],a=bars[k-1],u=b.h-a.h,d=a.l-b.l;
    tr[k]=Math.max(b.h-b.l,Math.abs(b.h-a.c),Math.abs(b.l-a.c));
    up[k]=u>d&&u>0?u:0;dn[k]=d>u&&d>0?d:0;
  }
  return {tr,up,dn};
}
function median(a){
  if(!a.length||a.some(x=>!(x>=0)&&!(x<0)))return NaN;
  const s=Float64Array.from(a).sort(),m=s.length>>1;
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
const series=(N,f)=>Array.from({length:N},(_,i)=>f(i));

export function computeIndicators(bars,params=SIGNAL_PARAMS){
  checkBars(bars);
  const p=checkParams(params),N=bars.length,c=bars.map(b=>b.c),{tr,up,dn}=moves(bars),vol=bars.map(b=>finite(b.v)&&b.v>=0?b.v:NaN);
  const emaFast=series(N,i=>emaAt(c,i,p.emaFast,p.emaWindow*p.emaFast)),emaSlow=series(N,i=>emaAt(c,i,p.emaSlow,p.emaWindow*p.emaSlow));
  const slope=series(N,i=>i>=p.slopeBars&&emaSlow[i]!==null&&emaSlow[i-p.slopeBars]!==null?emaSlow[i]-emaSlow[i-p.slopeBars]:null);
  const atr=series(N,i=>wilderAt(tr,i,p.atrPeriod,p.atrWindow*p.atrPeriod+1)),atrPct=atr.map((a,i)=>a===null?null:a/c[i]);
  const R=p.volRankWindow,B=p.breakout;
  return {emaFast,emaSlow,slope,
    rsi:series(N,i=>rsiAt(c,i,p.rsiPeriod,p.rsiWindow*p.rsiPeriod+1)),
    atr,atrPct,
    adx:series(N,i=>adxAt(tr,up,dn,i,p.adxPeriod,p.adxWindow)),
    roc:series(N,i=>i>=p.rocPeriod?c[i]/c[i-p.rocPeriod]-1:null),
    relVol:series(N,i=>{
      if(i<p.volMedian||!(vol[i]>=0))return null;
      const m=median(vol.slice(i-p.volMedian,i));return m>0?vol[i]/m:null;
    }),
    volRank:series(N,i=>{
      if(i-R+1<0||atrPct[i]===null)return null;
      let n=0;for(let j=i-R+1;j<=i;j++){const x=atrPct[j];if(x===null)return null;if(x<=atrPct[i])n++;}
      return n/R;
    }),
    donHigh:series(N,i=>{if(i<B)return null;let m=-Infinity;for(let j=i-B;j<i;j++)m=Math.max(m,bars[j].h);return m;}),
    donLow:series(N,i=>{if(i<B)return null;let m=Infinity;for(let j=i-B;j<i;j++)m=Math.min(m,bars[j].l);return m;})};
}

// Bars needed before bar i for a final evaluation: the longest indicator window,
// or the higher timeframe's htfWindow*htfEma+1 complete buckets plus a partial
// bucket and alignment slack, and then the cooldown look-back on top.
export function requiredLookback(tfKey,params=SIGNAL_PARAMS){
  const T=tfOf(tfKey),p=checkParams(params);
  let need=Math.max(p.emaWindow*p.emaSlow+p.slopeBars,p.emaWindow*p.emaFast,p.atrWindow*p.atrPeriod+p.volRankWindow,p.adxWindow,
    p.rsiWindow*p.rsiPeriod+1,p.volMedian+1,p.breakout+1,p.rocPeriod+1);
  if(T.htf)need=Math.max(need,(p.htfWindow*p.htfEma+2)*(TF[T.htf].ms/T.ms)+7);
  return need+p.cooldown;
}

// ---- Swedish number text --------------------------------------------------
// Written out instead of Intl so a stored explanation is byte-identical in every
// browser (it is part of the record hash); matches sv-SE: 85 230 · 2,1 · −0,4 %.
function num(x,dec=0){
  const s=Math.abs(x).toFixed(dec),[int,frac]=s.split('.');
  return (x<0&&/[1-9]/.test(s)?MINUS:'')+int.replace(/\B(?=(\d{3})+(?!\d))/g,NBSP)+(frac?','+frac:'');
}
const plain=x=>{let d=0;while(d<6&&Math.abs(x*10**d-Math.round(x*10**d))>1e-9)d++;return num(x,d);};
const signed=(x,dec)=>(x>0&&/[1-9]/.test(x.toFixed(dec))?'+':'')+num(x,dec);
const pctText=(x,dec)=>num(x*100,dec)+NBSP+'%';
const signedPct=(x,dec)=>signed(x*100,dec)+NBSP+'%';
// A failing value never reads as the limit it missed: ADX 17,96 under 18 shows as 17,9, not 18.
function below(x,limit,dec){
  if(+x.toFixed(dec)<limit)return num(x,dec);
  for(let d=dec+1;d<=dec+4;d++){const f=10**d,y=Math.floor(x*f)/f;if(y<limit)return num(y,d);}
  return num(x,dec+4);
}
function above(x,limit,dec){
  if(+x.toFixed(dec)>limit)return num(x,dec);
  for(let d=dec+1;d<=dec+4;d++){const f=10**d,y=Math.ceil(x*f)/f;if(y>limit)return num(y,d);}
  return num(x,dec+4);
}
const priceDec=x=>Math.min(10,Math.max(0,4-Math.floor(Math.log10(x))));
// Close and channel level with enough decimals to tell them apart.
function pricePair(a,b){
  let d=priceDec(Math.max(a,b));
  while(d<10&&a!==b&&num(a,d)===num(b,d))d++;
  return [num(a,d),num(b,d)];
}

// ---- Regime and signal ------------------------------------------------------
// The latest higher-timeframe bar that had closed when the bar closing at closeT
// closed, with its windowed EMA. Up needs a close over a rising EMA.
function htfTrend(htfBars,closeT,htfKey,p){
  if(!htfKey||!Array.isArray(htfBars))return null;
  const ms=TF[htfKey].ms,target=bucketStart(closeT,htfKey)-ms,W=p.htfWindow*p.htfEma;
  let lo=0,hi=htfBars.length-1,m=-1;
  while(lo<=hi){const mid=(lo+hi)>>1,t=htfBars[mid].t;if(t===target){m=mid;break;}if(t<target)lo=mid+1;else hi=mid-1;}
  // W+1 consecutive buckets: the EMA window plus the bucket before it for the EMA's direction.
  if(m<W||htfBars[m].t-htfBars[m-W].t!==W*ms)return null;
  const cl=htfBars.slice(m-W,m+1).map(b=>b.c),ema=emaAt(cl,W,p.htfEma,W),prev=emaAt(cl,W-1,p.htfEma,W),close=cl[W];
  if(![ema,prev,close].every(finite))return null;
  return {dir:close>ema&&ema>prev?1:close<ema&&ema<prev?-1:0,close,ema,t:target};
}
const KEYS=['adx','rsi','roc','relVol','volRank','atrPct','emaFast','emaSlow','slope','donHigh','donLow'];
// Rule state at bar j relative to the EMA lean; raw is the side whose every
// entry condition holds at j (cooldown aside), else 0.
function assess(bars,j,T,p,ind,htfBars){
  const v={};for(const k of KEYS){const x=ind[k]?.[j];v[k]=finite(x)?x:null;}
  const close=bars[j].c,htf=htfTrend(htfBars,bars[j].t+T.ms,T.htf,p);
  // Volume can be missing for data reasons; every other value only needs history.
  const ready=KEYS.every(k=>k==='relVol'||v[k]!==null)&&finite(ind.atr?.[j]);
  const dir=v.emaFast===null||v.emaSlow===null?0:v.emaFast>v.emaSlow?1:v.emaFast<v.emaSlow?-1:0;
  let regime='insufficient';
  if(ready){
    const up=v.emaFast>v.emaSlow&&v.slope>0,down=v.emaFast<v.emaSlow&&v.slope<0;
    regime=v.adx<p.adxRange?'range':v.adx>=p.adxTrend?(up?'trend-up':down?'trend-down':'weak'):'weak';
  }
  const [lo,hi]=dir>0?p.rsiLong:p.rsiShort;
  const ok={
    trend:ready&&dir!==0&&regime===(dir>0?'trend-up':'trend-down'),
    htf:htf!==null&&dir!==0&&htf.dir===dir,
    trigger:ready&&(dir>0?close>v.donHigh:dir<0&&close<v.donLow),
    momentum:ready&&dir!==0&&lo<=v.rsi&&v.rsi<=hi&&(dir>0?v.roc>0:v.roc<0),
    volume:v.relVol!==null&&v.relVol>=p.volMin,
    volatility:ready&&p.volRankMin<=v.volRank&&v.volRank<=p.volRankMax
  };
  const raw=ok.trend&&ok.htf&&ok.trigger&&ok.momentum&&ok.volume&&ok.volatility?dir:0;
  return {v,close,htf,ready,dir,regime,ok,raw};
}
// The values that have limits, written once so the reason and the explanation
// lines show the same number (never 'Låg volym (1,09× median)' next to 'Volym 1,1× median').
function shown(a,p){
  const {v,dir}=a,[lo,hi]=dir>0?p.rsiLong:p.rsiShort;
  return {
    adx:v.adx<p.adxRange?below(v.adx,p.adxRange,0):v.adx<p.adxTrend?below(v.adx,p.adxTrend,0):num(v.adx),
    rsi:dir!==0&&v.rsi>hi?above(v.rsi,hi,0):dir!==0&&v.rsi<lo?below(v.rsi,lo,0):num(v.rsi),
    relVol:v.relVol===null?null:v.relVol<p.volMin?below(v.relVol,p.volMin,1):num(v.relVol,1),
    volRank:v.volRank>p.volRankMax?above(v.volRank*100,p.volRankMax*100,0):
      v.volRank<p.volRankMin?below(v.volRank*100,p.volRankMin*100,0):num(v.volRank*100)
  };
}
function reasonOf(key,a,p){
  const {v,dir,regime}=a,s=shown(a,p);
  switch(key){
    case 'trend':
      if(regime==='range')return `Sidledes marknad (ADX ${s.adx} < ${plain(p.adxRange)})`;
      return v.adx<p.adxTrend?`Svag trend (ADX ${s.adx})`:`Otydlig trendriktning (ADX ${s.adx})`;
    case 'htf':return a.htf?'Trenden och högre tidsram går isär':'Högre tidsram saknas';
    case 'trigger':return 'Inget utbrott';
    case 'momentum':{
      const [lo,hi]=dir>0?p.rsiLong:p.rsiShort;
      if(v.rsi>hi)return (dir>0?'Överköpt':'Momentum saknas')+` (RSI ${s.rsi})`;
      if(v.rsi<lo)return (dir<0?'Översåld':'Momentum saknas')+` (RSI ${s.rsi})`;
      return `Momentum saknas (ROC(${p.rocPeriod}) ${signedPct(v.roc,1)})`;
    }
    case 'volume':return v.relVol===null?'Volymdata saknas':`Låg volym (${s.relVol}× median)`;
    case 'volatility':return v.volRank>p.volRankMax?`Extrem volatilitet (percentil ${s.volRank})`:`Låg volatilitet (percentil ${s.volRank})`;
    default:return `Signal nyligen (väntetid ${p.cooldown} candles)`;
  }
}
function explain(a,p,T,side,reason,need){
  if(a.regime==='insufficient'||reason==='För kort historik')
    return ['Ingen signal: För kort historik',`Regeln behöver ${num(need)} stängda candles före bedömningen`,'Indikatorerna räknas bara på fulla fönster'];
  const {v,htf,dir,close}=a,F=p.emaFast,S=p.emaSlow,H=T.htf?TF[T.htf].label:null,s=shown(a,p);
  const trend=a.regime==='trend-up'?`Trend upp: EMA${F} över EMA${S} och EMA${S} stiger · ADX ${s.adx}`:
    a.regime==='trend-down'?`Trend ned: EMA${F} under EMA${S} och EMA${S} faller · ADX ${s.adx}`:
    `EMA${F} ${dir>0?'över':dir<0?'under':'lika med'} EMA${S} · EMA${S} ${v.slope>0?'stiger':v.slope<0?'faller':'planar ut'} · ADX ${s.adx}`;
  const higher=!htf?(H?`Högre tidsram (${H}) saknas`:'Högre tidsram saknas'):
    `${H}-trenden ${htf.dir>0?'uppåt':htf.dir<0?'nedåt':'neutral'} (stängning ${htf.close>htf.ema?'över':htf.close<htf.ema?'under':'på'} EMA${p.htfEma})`;
  const momentum=`Momentum: RSI ${s.rsi} · ROC(${p.rocPeriod}) ${signedPct(v.roc,1)}`;
  const volume=v.relVol===null?'Volymdata saknas':`Volym ${s.relVol}× median`;
  const volatility=`Volatilitet: ATR ${pctText(v.atrPct,2)} (percentil ${s.volRank})`;
  if(!side)return [`Ingen signal: ${reason}`,trend,higher,momentum,volume,volatility];
  const [cTxt,lTxt]=pricePair(close,dir>0?v.donHigh:v.donLow);
  const breakout=dir>0?`Utbrott: stängning ${cTxt} över ${p.breakout}-candle-högsta ${lTxt}`:`Utbrott: stängning ${cTxt} under ${p.breakout}-candle-lägsta ${lTxt}`;
  return [trend,higher,breakout,momentum,volume,volatility];
}
function evaluate(bars,i,T,p,ind,htfBars,need){
  const a=assess(bars,i,T,p,ind,htfBars),{v,htf,dir,close}=a;
  // Short of the full lookback the cooldown and higher timeframe could still
  // change with more history, so such a bar is never final.
  const insufficient=!a.ready||i<need;
  let since=null;
  if(!insufficient&&dir!==0)for(let k=1;k<=p.cooldown&&i-k>=0;k++)if(assess(bars,i-k,T,p,ind,htfBars).raw===dir){since=k;break;}
  const H=T.htf?TF[T.htf].label:null;
  const checks=[
    ['trend','Trend',a.ok.trend,v.adx],
    ['htf',H?`Högre tidsram (${H})`:'Högre tidsram',a.ok.htf,htf?htf.dir:null],
    ['trigger','Utbrott',a.ok.trigger,dir>0?v.donHigh:dir<0?v.donLow:null],
    ['momentum','Momentum',a.ok.momentum,v.rsi],
    ['volume','Volym',a.ok.volume,v.relVol],
    ['volatility','Volatilitet',a.ok.volatility,v.volRank],
    ['cooldown','Väntetid',since===null,since]
  ].map(([key,label,ok,value])=>({key,label,ok:!insufficient&&ok,value:insufficient?null:value}));
  const failing=checks.find(x=>!x.ok),side=insufficient||failing?null:dir>0?'long':'short';
  const reason=side?'':insufficient?'För kort historik':reasonOf(failing.key,a,p);
  let entry=null,sl=null,tp=null,atr=null;
  if(side){
    atr=ind.atr[i];entry=close;
    sl=dir>0?close-p.slAtr*atr:close+p.slAtr*atr;
    tp=dir>0?close+p.tpR*(close-sl):close-p.tpR*(sl-close);
  }
  const features={};for(const k of KEYS)features[k]=v[k];
  features.htf=htf&&{dir:htf.dir,close:htf.close,ema:htf.ema,t:htf.t};
  return deepFreeze({t:bars[i].t,close,regime:insufficient?'insufficient':a.regime,side,entry,sl,tp,atr,checks,reason,
    explanation:explain(insufficient?{...a,regime:'insufficient'}:a,p,T,side,reason,need),features});
}
const htfOf=(bars,T)=>T.htf&&bars.length?aggregateClosed(bars,T.key,T.htf,bars.at(-1).t+T.ms):[];

export function evaluateBar(bars,i,ctx={}){
  const T=tfOf(ctx?.tf),p=checkParams(ctx.params??SIGNAL_PARAMS),need=requiredLookback(T.key,p);
  if(!Array.isArray(bars)||!Number.isInteger(i)||i<0||i>=bars.length)throw Error('Ogiltig candle för bedömning');
  if(ctx.ind)return evaluate(bars,i,T,p,ctx.ind,ctx.htfBars??htfOf(bars,T),need);
  // Only the fixed lookback before i can matter, so the slice gives the identical result with far less work.
  const s=Math.max(0,i-need),sub=bars.slice(s,i+1);
  return evaluate(sub,i-s,T,p,computeIndicators(sub,p),ctx.htfBars??htfOf(sub,T),need);
}
export function signalsInRange(bars,from,to,ctx={}){
  const T=tfOf(ctx?.tf),p=checkParams(ctx.params??SIGNAL_PARAMS),need=requiredLookback(T.key,p);
  if(!Number.isInteger(from)||!Number.isInteger(to))throw Error('Ogiltigt intervall');
  const ind=ctx.ind??computeIndicators(bars,p),htfBars=ctx.htfBars??htfOf(bars,T),out=[];
  // Most bars do not trigger; only those get the full evaluation, identical to evaluateBar's.
  for(let i=Math.max(0,from,need);i<=Math.min(to,bars.length-1);i++)
    if(assess(bars,i,T,p,ind,htfBars).raw!==0){const e=evaluate(bars,i,T,p,ind,htfBars,need);if(e.side)out.push(e);}
  return out;
}

// ---- Statistical forecast (af-forecast-v1) ----------------------------------
// Feature windows belong to the forecast model version, not to SIGNAL_PARAMS,
// so re-freezing the signal rules never changes a forecast.
const FEATURE=Object.freeze({atr:14,ema:20,rsi:14,window:4,vr:100});
export function forecastFeatures(bars){
  checkBars(bars);
  const f=FEATURE,N=bars.length,c=bars.map(b=>b.c),{tr}=moves(bars),S3=Math.sqrt(3),S10=Math.sqrt(10);
  const u=series(N,i=>{const a=wilderAt(tr,i,f.atr,f.window*f.atr+1);return a===null?null:a/c[i];});
  return series(N,i=>{
    const ui=u[i];
    if(!(ui>0)||i<10||i-f.vr+1<0)return null;
    const win=u.slice(i-f.vr+1,i+1);if(!win.every(x=>x>0))return null;
    const e=emaAt(c,i,f.ema,f.window*f.ema),r=rsiAt(c,i,f.rsi,f.window*f.rsi+1);
    if(e===null||r===null)return null;
    return {u:ui,r1:Math.log(c[i]/c[i-1])/ui,r3:Math.log(c[i]/c[i-3])/(ui*S3),r10:Math.log(c[i]/c[i-10])/(ui*S10),
      d20:(c[i]-e)/(ui*c[i]),rsi:(r-50)/25,vr:Math.log(ui/median(win))};
  });
}
// Type 7 quantile (linear interpolation) of ascending values.
function quantile(s,q){
  const pos=(s.length-1)*q,lo=Math.floor(pos),f=pos-lo;
  return lo+1<s.length?s[lo]+f*(s[lo+1]-s[lo]):s[lo];
}
// The K nearest by a bounded max-heap: smallest distance, and on a tie the later bar.
function nearest(items,K){
  const h=[],worse=(a,b)=>a.d>b.d||a.d===b.d&&a.j<b.j,swap=(x,y)=>{const t=h[x];h[x]=h[y];h[y]=t;};
  for(const it of items){
    if(h.length<K){
      h.push(it);let k=h.length-1;
      while(k>0){const q=(k-1)>>1;if(!worse(h[k],h[q]))break;swap(k,q);k=q;}
    }else if(worse(h[0],it)){
      h[0]=it;let k=0;
      for(;;){const l=2*k+1,r=l+1;let m=k;if(l<h.length&&worse(h[l],h[m]))m=l;if(r<h.length&&worse(h[r],h[m]))m=r;if(m===k)break;swap(k,m);k=m;}
    }
  }
  return h.sort((a,b)=>a.d-b.d||b.j-a.j);
}
const vec=(f,out,o)=>{out[o]=f.u;out[o+1]=f.r1;out[o+2]=f.r3;out[o+3]=f.r10;out[o+4]=f.d20;out[o+5]=f.rsi;out[o+6]=f.vr;};

export function forecastAt(bars,c,{tf,params=FORECAST_PARAMS,features,library}={}){
  const T=tfOf(tf),p=checkForecastParams(params),H=p.horizon;
  if(!Array.isArray(bars)||!Number.isInteger(c)||c<0||c>=bars.length)throw Error('Ogiltig prognospunkt');
  if(features!=null&&(!Array.isArray(features)||features.length<=c))throw Error('Ogiltiga prognosegenskaper');
  if(library!=null&&(!Number.isInteger(library.from)||!Number.isInteger(library.to)))throw Error('Ogiltigt prognosbibliotek');
  // Only bars[0..c] are read: given features are read up to c, own features see only that prefix.
  const F=features??forecastFeatures(bars.slice(0,c+1)),fc=F[c],tooShort=()=>Object.freeze({ok:false,reason:'För kort historik för prognos'});
  if(!fc)return tooShort();
  let lo=Math.max(0,c-p.train),hi=c-H;
  if(library!=null){lo=Math.max(lo,library.from);hi=Math.min(hi,library.to-H);}
  const cand=[];for(let j=lo;j<=hi;j++)if(F[j])cand.push(j);
  if(cand.length<p.minCandidates)return tooShort();
  for(let k=cand[0];k<=c;k++)if(badBar(bars[k]))throw Error('Ogiltig candle');
  // z-scores with the candidate set's mean and standard deviation, then Euclidean distance to the cutoff.
  const n=cand.length,D=7,X=new Float64Array(n*D),mean=new Float64Array(D),sd=new Float64Array(D),z=new Float64Array(D);
  cand.forEach((j,r)=>vec(F[j],X,r*D));
  for(let r=0;r<n;r++)for(let d=0;d<D;d++)mean[d]+=X[r*D+d];
  for(let d=0;d<D;d++)mean[d]/=n;
  for(let r=0;r<n;r++)for(let d=0;d<D;d++){const x=X[r*D+d]-mean[d];sd[d]+=x*x;}
  for(let d=0;d<D;d++){const s=Math.sqrt(sd[d]/n);sd[d]=s>0?s:1;}
  vec(fc,z,0);for(let d=0;d<D;d++)z[d]=(z[d]-mean[d])/sd[d];
  const items=new Array(n);
  for(let r=0;r<n;r++){let s=0;for(let d=0;d<D;d++){const x=(X[r*D+d]-mean[d])/sd[d]-z[d];s+=x*x;}items[r]={j:cand[r],d:Math.sqrt(s)};}
  const near=nearest(items,Math.min(p.k,n)),base=bars[c].c,unit=fc.u;
  // Each analog's next H bars in its own ATR units: close path, opening gaps and wicks.
  const outs=near.map(({j,d})=>{
    const u=F[j].u,cj=bars[j].c,R=[],G=[],U=[],L=[];
    for(let h=1;h<=H;h++){
      const b=bars[j+h],top=Math.max(b.o,b.c),bot=Math.min(b.o,b.c);
      R.push(Math.log(b.c/cj)/u);G.push(Math.log(b.o/bars[j+h-1].c)/u);
      // A malformed wick (high under the body) is clamped to none so a candle stays valid.
      U.push(Math.max(0,Math.log(b.h/top))/u);L.push(Math.max(0,Math.log(bot/b.l))/u);
    }
    return {j,d,R,G,U,L};
  });
  // Bands: type 7 quantiles of the analog closes per horizon. Widening: each
  // half-width (lower/upper of the 50 % and 80 % bands), in log space around
  // that horizon's median, is the running maximum over h, so a band never
  // narrows further out just because a few analogs happened to bunch up there.
  const t0=bars[c].t,qs=p.quantiles,w=[0,0,0,0],bands=[],med=[];
  for(let h=0;h<H;h++){
    const xs=Float64Array.from(outs,o=>base*Math.exp(o.R[h]*unit)).sort(),q=qs.map(x=>quantile(xs,x)),mid=q[2];
    med.push(quantile(Float64Array.from(outs,o=>o.R[h]).sort(),.5));
    w[0]=Math.max(w[0],Math.log(mid/q[0]));w[1]=Math.max(w[1],Math.log(mid/q[1]));
    w[2]=Math.max(w[2],Math.log(q[3]/mid));w[3]=Math.max(w[3],Math.log(q[4]/mid));
    w[0]=Math.max(w[0],w[1]);w[3]=Math.max(w[3],w[2]);
    const q25=Math.min(mid,mid*Math.exp(-w[1])),q10=Math.min(q25,mid*Math.exp(-w[0]));
    const q75=Math.max(mid,mid*Math.exp(w[2])),q90=Math.max(q75,mid*Math.exp(w[3]));
    bands.push({t:t0+(h+1)*T.ms,q10,q25,q50:mid,q75,q90});
  }
  // Scenario: the medoid analog, closest to the per-horizon median path.
  let m=null,best=Infinity;
  for(const o of outs){
    let s=0;for(let h=0;h<H;h++)s+=Math.abs(o.R[h]-med[h]);
    if(m===null||s<best||s===best&&(o.d<m.d||o.d===m.d&&o.j>m.j)){m=o;best=s;}
  }
  const candles=[];let prev=base;
  for(let h=0;h<H;h++){
    const o=prev*Math.exp(m.G[h]*unit),cl=base*Math.exp(m.R[h]*unit);
    candles.push({t:t0+(h+1)*T.ms,o,h:Math.max(o,cl)*Math.exp(m.U[h]*unit),l:Math.min(o,cl)*Math.exp(-m.L[h]*unit),c:cl});
    prev=cl;
  }
  return deepFreeze({ok:true,model:MODEL.forecast,cutoff:t0,base,unit,horizon:H,k:near.length,candles,bands,
    medoid:{t:bars[m.j].t,d:m.d},analogs:near.map(x=>bars[x.j].t),train:{from:bars[cand[0]].t,to:bars[cand.at(-1)+H].t,n}});
}
