import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../forecast-config.js';
import * as M from '../forecast-model.js';

const {MODEL,TF,SIGNAL_PARAMS:P,FORECAST_PARAMS:FP,bucketStart,aggregateClosed,computeIndicators,requiredLookback,evaluateBar,
  signalsInRange,forecastFeatures,forecastAt}=M;
const HOUR=3600000,DAY=86400000,WEEK=7*DAY,NBSP='\u00a0';
// A Monday, so the first 4h, day and week buckets all start with the data.
const T0=Date.UTC(2024,0,1);
const KEYS=['emaFast','emaSlow','slope','rsi','atr','atrPct','adx','roc','relVol','volRank','donHigh','donLow'];
const CHECKS=['trend','htf','trigger','momentum','volume','volatility','cooldown'];
const CONFIDENCE=/confiden|probab|likelihood|chance|certain|konfidens|sannolik|säker|chans|trolig|garant/i;
const ENGLISH=/\b(the|and|above|below|rising|falling|up|down|breakout|volume|volatility|no signal|insufficient|history|wait)\b/i;

function rng(seed){let x=seed;return ()=>(x=(x*48271)%2147483647)/2147483647;}
// Seeded random walk with wicks, volume and slowly changing volatility; each open is the previous close
// unless an opening gap is asked for.
function walk(n,{seed=7,tf='1h',t0=T0,drift=0,vol=.01,gap=0}={}){
  const r=rng(seed),ms=TF[tf].ms,bars=[];let c=100;
  for(let i=0;i<n;i++){
    const o=gap?c*Math.exp(gap*(r()-.5)):c;c=o*Math.exp(drift+(r()-.5)*2*vol*(.5+Math.sin(i/37)**2));
    bars.push({t:t0+i*ms,o,h:Math.max(o,c)*(1+r()*vol*.6),l:Math.min(o,c)*(1-r()*vol*.6),c,v:1000*(.5+r())});
  }
  return bars;
}
// Zigzag trend in log price: an up bar of about +1 %, then a down bar of about -0,6 %, small wicks and steady
// volume except 2,5x spikes at the given bars. sign -1 is the exact mirror (every price p becomes 10000/p);
// a function of the bar index switches direction along the way.
function zigzag(n,{sign=1,spikes=[],seed=3,tf='1h',t0=T0}={}){
  const r=rng(seed),ms=TF[tf].ms,out=[];let x=0;
  for(let i=0;i<n;i++){
    const s=typeof sign==='function'?sign(i):sign,o=x;
    x+=s*(i%2===0?.010+.002*(r()-.5):-.006+.002*(r()-.5));
    const w1=.0005+.001*r(),w2=.0005+.001*r(),h=Math.max(o,x)+(s>0?w1:w2),l=Math.min(o,x)-(s>0?w2:w1);
    const v=spikes.includes(i)?250:100*(1+.04*(r()-.5));
    out.push({t:t0+i*ms,o:100*Math.exp(o),h:100*Math.exp(h),l:100*Math.exp(l),c:100*Math.exp(x),v});
  }
  return out;
}
// Sideways: opens and closes wander inside a fixed 99-101 range, so no bar extends the previous high or low.
function sideways(n,{seed=5,tf='1h',t0=T0}={}){
  const r=rng(seed),ms=TF[tf].ms;
  return Array.from({length:n},(_,i)=>({t:t0+i*ms,o:100+(r()-.5),h:101,l:99,c:100+(r()-.5),v:100*(1+.04*(r()-.5))}));
}
const near=(a,b,eps=1e-9,msg='')=>assert.ok(Math.abs(a-b)<=eps*Math.max(1,Math.abs(a),Math.abs(b)),`${msg} ${a} vs ${b}`);
const ix=(bars,t)=>bars.findIndex(b=>b.t===t);
const frozenDeep=x=>!x||typeof x!=='object'||Object.isFrozen(x)&&Object.values(x).every(frozenDeep);

// Straightforward references: each recomputes its whole window from scratch.
function refEma(c,i,p,W){
  if(i-W+1<0)return null;
  const w=c.slice(i-W+1,i+1);let e=w.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(const x of w.slice(p))e=e+(2/(p+1))*(x-e);
  return e;
}
function refRsi(c,i,p,W){
  if(i-W+1<0)return null;
  const w=c.slice(i-W+1,i+1),d=w.slice(1).map((x,k)=>x-w[k]);
  let g=d.slice(0,p).reduce((a,x)=>a+Math.max(x,0),0)/p,l=d.slice(0,p).reduce((a,x)=>a+Math.max(-x,0),0)/p;
  for(const x of d.slice(p)){g=(g*(p-1)+Math.max(x,0))/p;l=(l*(p-1)+Math.max(-x,0))/p;}
  return l===0?(g===0?50:100):100-100/(1+g/l);
}
const refTr=(bars,k)=>{const b=bars[k],pc=bars[k-1].c;return Math.max(b.h-b.l,Math.abs(b.h-pc),Math.abs(b.l-pc));};
function refAtr(bars,i,p,W){
  if(i-W+1<0)return null;
  const trs=[];for(let k=i-W+2;k<=i;k++)trs.push(refTr(bars,k));
  let a=trs.slice(0,p).reduce((s,x)=>s+x,0)/p;
  for(const x of trs.slice(p))a=(a*(p-1)+x)/p;
  return a;
}
// Wilder's own formulation with running sums (TR14 = TR14 - TR14/14 + TR).
function refAdx(bars,i,p,W){
  if(i-W+1<0)return null;
  let tr=0,pdm=0,mdm=0;const dx=[];
  for(let k=i-W+2,n=0;k<=i;k++,n++){
    const b=bars[k],a=bars[k-1],up=b.h-a.h,down=a.l-b.l,t=refTr(bars,k),pd=up>down&&up>0?up:0,md=down>up&&down>0?down:0;
    if(n<p){tr+=t;pdm+=pd;mdm+=md;}else{tr=tr-tr/p+t;pdm=pdm-pdm/p+pd;mdm=mdm-mdm/p+md;}
    if(n>=p-1){const a1=100*pdm/tr,a2=100*mdm/tr;dx.push(a1+a2>0?100*Math.abs(a1-a2)/(a1+a2):0);}
  }
  let adx=dx.slice(0,p).reduce((s,x)=>s+x,0)/p;
  for(const x of dx.slice(p))adx=(adx*(p-1)+x)/p;
  return adx;
}
const refMedian=a=>{const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
function refQuantile(a,q){
  const s=[...a].sort((x,y)=>x-y),pos=(s.length-1)*q,lo=Math.floor(pos);
  return lo+1<s.length?s[lo]+(pos-lo)*(s[lo+1]-s[lo]):s[lo];
}

test('the model re-exports every shared forecast constant',()=>{
  for(const [k,v] of Object.entries(config))assert.equal(M[k],v,k);
  assert.equal(refQuantile([4,1,3,2],.25),1.75);
});

test('every windowed indicator matches a from-scratch reference over its own window',()=>{
  const bars=walk(700),c=bars.map(b=>b.c),ind=computeIndicators(bars);
  for(const k of KEYS)assert.equal(ind[k].length,bars.length,k);
  const check=(key,i,ref,exact)=>{
    const got=ind[key][i];
    if(ref===null)return assert.equal(got,null,`${key}[${i}] should be null`);
    assert.equal(typeof got,'number',`${key}[${i}]`);
    exact?assert.equal(got,ref,`${key}[${i}]`):near(got,ref,1e-9,`${key}[${i}]`);
  };
  for(let i=0;i<bars.length;i++){
    const slow=refEma(c,i,P.emaSlow,P.emaWindow*P.emaSlow),before=i>=P.slopeBars?refEma(c,i-P.slopeBars,P.emaSlow,P.emaWindow*P.emaSlow):null;
    const atr=refAtr(bars,i,P.atrPeriod,P.atrWindow*P.atrPeriod+1);
    check('emaFast',i,refEma(c,i,P.emaFast,P.emaWindow*P.emaFast));
    check('emaSlow',i,slow);
    check('slope',i,slow===null||before===null?null:slow-before);
    check('rsi',i,refRsi(c,i,P.rsiPeriod,P.rsiWindow*P.rsiPeriod+1));
    check('atr',i,atr);
    check('atrPct',i,atr===null?null:atr/c[i]);
    check('adx',i,refAdx(bars,i,P.adxPeriod,P.adxWindow));
    check('roc',i,i>=P.rocPeriod?c[i]/c[i-P.rocPeriod]-1:null,true);
    check('relVol',i,i>=P.volMedian?bars[i].v/refMedian(bars.slice(i-P.volMedian,i).map(b=>b.v)):null,true);
    const win=i-P.volRankWindow+1>=0?ind.atrPct.slice(i-P.volRankWindow+1,i+1):null;
    check('volRank',i,win&&win.every(x=>x!==null)?win.filter(x=>x<=ind.atrPct[i]).length/P.volRankWindow:null,true);
    check('donHigh',i,i>=P.breakout?Math.max(...bars.slice(i-P.breakout,i).map(b=>b.h)):null,true);
    check('donLow',i,i>=P.breakout?Math.min(...bars.slice(i-P.breakout,i).map(b=>b.l)):null,true);
  }
  // Each value starts exactly where its fixed window first fits.
  const first=k=>ind[k].findIndex(x=>x!==null);
  assert.equal(first('emaSlow'),P.emaWindow*P.emaSlow-1);
  assert.equal(first('slope'),P.emaWindow*P.emaSlow-1+P.slopeBars);
  assert.equal(first('atr'),P.atrWindow*P.atrPeriod);
  assert.equal(first('volRank'),P.atrWindow*P.atrPeriod+P.volRankWindow-1);
  assert.equal(first('adx'),P.adxWindow-1);
  // A zero median volume has no relative volume; invalid candles are refused in Swedish.
  const quiet=bars.map((b,i)=>i>=100&&i<130?{...b,v:0}:b);
  assert.equal(computeIndicators(quiet).relVol[125],null);
  assert.throws(()=>computeIndicators([{t:T0,o:1,h:1,l:1,c:NaN}]),/Ogiltig candle/);
  assert.throws(()=>computeIndicators(bars,{...P,adxWindow:2*P.adxPeriod}),/Ogiltiga signalparametrar/);
});

test('indicators on 4000 bars and a thousand forecasts on precomputed features stay fast',()=>{
  const bars=walk(4000);
  let t=performance.now();computeIndicators(bars);const ms=performance.now()-t;
  assert.ok(ms<1500,`computeIndicators took ${ms} ms`);
  const F=forecastFeatures(bars);t=performance.now();
  for(let c=3000;c<4000;c++)assert.equal(forecastAt(bars,c,{tf:'1h',features:F}).ok,true);
  const fms=performance.now()-t;
  assert.ok(fms<6000,`1000 forecasts took ${fms} ms`);
});

test('no look-ahead: a value or evaluation at bar i ignores every later bar',()=>{
  const S=350,z=zigzag(600,{spikes:[S,S+2,S+8]}),ind=computeIndicators(z),htf=aggregateClosed(z,'1h','4h',z.at(-1).t+HOUR);
  for(const i of [100,258,requiredLookback('1h'),301,S,S+1,S+2,S+8,421,599]){
    const prefix=z.slice(0,i+1),pind=computeIndicators(prefix);
    for(const k of KEYS)assert.equal(pind[k][i],ind[k][i],`${k}[${i}]`);
    const full=evaluateBar(z,i,{tf:'1h',ind,htfBars:htf});
    assert.deepEqual(evaluateBar(prefix,i,{tf:'1h'}),full,'prefix '+i);
    assert.deepEqual(evaluateBar(prefix,i,{tf:'1h',ind:pind}),full);
    assert.deepEqual(evaluateBar(z,i,{tf:'1h'}),full);
    // Rewrite every later bar, including the rest of bar i's still-forming 4h bucket.
    const changed=z.map((b,k)=>k>i?{...b,o:b.o*1.7,h:b.h*1.9,l:b.l*1.5,c:b.c*1.6,v:b.v*9}:b),cind=computeIndicators(changed);
    for(const k of KEYS)assert.equal(cind[k][i],ind[k][i],`${k}[${i}] after a later change`);
    assert.deepEqual(evaluateBar(changed,i,{tf:'1h',ind:cind,htfBars:aggregateClosed(changed,'1h','4h',changed.at(-1).t+HOUR)}),full);
    // Later bars are not even read.
    assert.deepEqual(evaluateBar(z.map((b,k)=>k>i?{t:b.t,o:NaN,h:NaN,l:NaN,c:NaN,v:NaN}:b),i,{tf:'1h'}),full);
  }
  assert.equal(evaluateBar(z,S,{tf:'1h',ind,htfBars:htf}).side,'long');
});

test('no repaint: a later history start gives the identical values and evaluation at the same bar',()=>{
  const S=350,z=zigzag(600,{spikes:[S,S+2,S+8]});
  const cases=[[z,'1h',S],[z,'1h',S+2],[walk(420),'1h',419],[walk(800,{tf:'5m',seed:11}),'5m',799],[walk(500,{tf:'1d',seed:13,vol:.03}),'1d',499]];
  for(const [bars,tf,i] of cases){
    const L=requiredLookback(tf),full=computeIndicators(bars),ref=evaluateBar(bars,i,{tf,ind:full});
    assert.notEqual(ref.regime,'insufficient');
    assert.notEqual(ref.features.htf,null,`${tf} uses its higher timeframe`);
    for(let k=0;k<=i-L;k++){
      const part=bars.slice(k),pind=computeIndicators(part);
      for(const key of KEYS)assert.equal(pind[key][i-k],full[key][i],`${tf} ${key} k=${k}`);
      assert.deepEqual(evaluateBar(part,i-k,{tf,ind:pind}),ref,`${tf} i=${i} k=${k}`);
      assert.deepEqual(evaluateBar(part,i-k,{tf}),ref);
    }
  }
  // Short of the lookback the bar is never final: it says so instead of guessing.
  assert.equal(evaluateBar(z.slice(S-requiredLookback('1h')+1),requiredLookback('1h')-1,{tf:'1h'}).regime,'insufficient');
});

test('the lookback covers the higher timeframe of every bar the cooldown reads, at the worst bucket alignment',()=>{
  for(const tf of config.CHART_TFS){
    const L=requiredLookback(tf),n=TF[TF[tf].htf].ms/TF[tf].ms;
    // A spike on an up bar that is the second-to-last of its higher-timeframe bucket: that bar's trend needs the
    // most base bars, and the cooldown still reads it P.cooldown bars later.
    let S=L+P.cooldown,z=null;
    for(;S<L+400;S++){if(S%2||S%n!==n-2)continue;z=zigzag(S+P.cooldown+1,{tf,spikes:[S]});if(evaluateBar(z,S,{tf}).side==='long')break;}
    assert.ok(S<L+400,tf+' has a long signal to wait after');
    const ind=computeIndicators(z);
    for(let i=S+1;i<=S+P.cooldown;i++){
      const full=evaluateBar(z,i,{tf,ind});
      assert.deepEqual(full.checks.at(-1),{key:'cooldown',label:'Väntetid',ok:false,value:i-S},`${tf} i=${i}`);
      assert.deepEqual(evaluateBar(z.slice(i-L),L,{tf}),full,`${tf} i=${i} from the shortest history`);
    }
  }
});

test('weeks start Monday 00:00 UTC and other buckets on a multiple of their length',()=>{
  const mon=Date.UTC(2024,0,1);
  assert.equal(bucketStart(Date.UTC(2024,0,3,15,30),'1w'),mon);
  assert.equal(bucketStart(Date.UTC(2024,0,7,23,59,59,999),'1w'),mon);
  assert.equal(bucketStart(Date.UTC(2024,0,8),'1w'),Date.UTC(2024,0,8));
  assert.equal(bucketStart(Date.UTC(1969,11,31,12),'1w'),Date.UTC(1969,11,29));
  assert.equal(bucketStart(Date.UTC(2024,0,1,5,30),'4h'),Date.UTC(2024,0,1,4));
  const r=rng(17);
  for(let n=0;n<500;n++){
    const t=Math.floor(Date.UTC(2020,0,1)+r()*2e11),w=bucketStart(t,'1w');
    assert.equal(new Date(w).getUTCDay(),1);assert.equal(w%DAY,0);assert.ok(w<=t&&t<w+WEEK);
    for(const tf of config.CHART_TFS){const s=bucketStart(t,tf);assert.ok(s%TF[tf].ms===0&&s<=t&&t<s+TF[tf].ms,tf);}
  }
  assert.throws(()=>bucketStart(T0,'2h'),/Okänd tidsram/);
});

test('higher-timeframe bars come only from complete buckets that have closed',()=>{
  // Daily bars from Wednesday 3 January to Friday 2 February 2024.
  const days=walk(31,{tf:'1d',t0:Date.UTC(2024,0,3),seed:21,vol:.03});
  const weeks=aggregateClosed(days,'1d','1w',days.at(-1).t+DAY);
  assert.deepEqual(weeks.map(w=>new Date(w.t).toISOString().slice(0,10)),['2024-01-08','2024-01-15','2024-01-22']);
  for(const w of weeks){
    const part=days.filter(d=>d.t>=w.t&&d.t<w.t+WEEK);
    assert.equal(part.length,7);
    assert.deepEqual(w,{t:w.t,o:part[0].o,h:Math.max(...part.map(d=>d.h)),l:Math.min(...part.map(d=>d.l)),c:part[6].c,v:part.reduce((s,d)=>s+d.v,0)});
  }
  // A missing day removes its week, wherever in the week it is; a week that has not closed by the cutoff is left out.
  for(const missing of [Date.UTC(2024,0,15),Date.UTC(2024,0,17),Date.UTC(2024,0,21)]){
    const gap=days.filter(d=>d.t!==missing);
    assert.deepEqual(aggregateClosed(gap,'1d','1w',gap.at(-1).t+DAY).map(w=>w.t),[Date.UTC(2024,0,8),Date.UTC(2024,0,22)]);
  }
  assert.deepEqual(aggregateClosed(days,'1d','1w',Date.UTC(2024,0,29)-1).map(w=>w.t),[Date.UTC(2024,0,8),Date.UTC(2024,0,15)]);
  assert.equal(aggregateClosed(days,'1d','1w',Date.UTC(2024,0,29)).at(-1).t,Date.UTC(2024,0,22));
  // Hourly bars from 02:00: the first 4h bucket is partial, and with the server clock inside the last bucket it is still forming.
  const hours=walk(30,{t0:Date.UTC(2024,0,1,2),seed:5});
  assert.deepEqual(aggregateClosed(hours,'1h','4h',hours.at(-1).t+HOUR).map(b=>b.t),[4,8,12,16,20,24,28].map(h=>Date.UTC(2024,0,1,h)));
  assert.equal(aggregateClosed(hours,'1h','4h',Date.UTC(2024,0,2,7,30)).at(-1).t,Date.UTC(2024,0,2,0));
});

test('the higher-timeframe trend at bar i comes from the latest bucket closed when bar i closed',()=>{
  const bars=walk(600,{seed:9,drift:.0004}),ind=computeIndicators(bars),htf=aggregateClosed(bars,'1h','4h',bars.at(-1).t+HOUR);
  const W=P.htfWindow*P.htfEma,hc=htf.map(b=>b.c);let edges=0;
  for(let i=requiredLookback('1h');i<bars.length;i++){
    const e=evaluateBar(bars,i,{tf:'1h',ind,htfBars:htf}),h=e.features.htf,close=bars[i].t+HOUR;
    assert.ok(h,'trend available at '+i);
    assert.ok(h.t+4*HOUR<=close,'never a bucket that closes after bar '+i);
    assert.equal(h.t,bucketStart(close,'4h')-4*HOUR);
    if(close%(4*HOUR)===0){edges++;assert.equal(h.t+4*HOUR,close,'a bucket closing with the bar is already usable');}
    const m=ix(htf,h.t),ema=refEma(hc,m,P.htfEma,W),prev=refEma(hc,m-1,P.htfEma,W);
    near(h.ema,ema);assert.equal(h.close,htf[m].c);
    assert.equal(h.dir,h.close>ema&&ema>prev?1:h.close<ema&&ema<prev?-1:0);
    // Only the buckets visible at that close give the same trend.
    assert.deepEqual(evaluateBar(bars,i,{tf:'1h',ind,htfBars:aggregateClosed(bars.slice(0,i+1),'1h','4h',close)}).features.htf,h);
  }
  assert.ok(edges>0);
  // Daily bars read the Monday-to-Sunday week that had closed by the bar's close.
  const days=walk(520,{tf:'1d',seed:13,vol:.03});
  for(const i of [470,471,472,473,474,475,476,519]){
    const h=evaluateBar(days,i,{tf:'1d'}).features.htf;
    assert.equal(new Date(h.t).getUTCDay(),1);
    assert.ok(h.t+WEEK<=days[i].t+DAY);
    assert.equal(h.t,bucketStart(days[i].t+DAY,'1w')-WEEK);
  }
});

test('a constructed uptrend breakout gives a long signal with stop and target from the frozen rules',()=>{
  const S=350,z=zigzag(600,{spikes:[S,S+2,S+8]}),ind=computeIndicators(z),e=evaluateBar(z,S,{tf:'1h'});
  assert.equal(e.side,'long');assert.equal(e.regime,'trend-up');assert.equal(e.reason,'');
  assert.deepEqual(e.checks.map(c=>c.key),CHECKS);
  assert.ok(e.checks.every(c=>c.ok&&typeof c.label==='string'&&c.label));
  const close=z[S].c,atr=ind.atr[S];
  assert.equal(e.t,z[S].t);assert.equal(e.close,close);assert.equal(e.entry,close);assert.equal(e.atr,atr);
  assert.equal(e.sl,close-P.slAtr*atr);
  assert.equal(e.tp,close+P.tpR*(close-e.sl));
  assert.ok(e.sl<close&&close<e.tp);
  near((e.tp-close)/(close-e.sl),P.tpR);
  const f=e.features;
  assert.ok(f.emaFast>f.emaSlow&&f.slope>0&&f.adx>=P.adxTrend&&f.htf.dir===1&&close>f.donHigh&&f.roc>0);
  assert.ok(P.rsiLong[0]<=f.rsi&&f.rsi<=P.rsiLong[1]&&f.relVol>=P.volMin&&P.volRankMin<=f.volRank&&f.volRank<=P.volRankMax);
  for(const k of KEYS.filter(k=>k!=='atr'))assert.equal(f[k],ind[k][S],k);
  // Neighbours: a quiet up bar lacks volume, a down bar breaks nothing.
  assert.match(evaluateBar(z,S+4,{tf:'1h'}).reason,/^Låg volym \(\d+,\d+× median\)$/);
  assert.equal(evaluateBar(z,S+1,{tf:'1h'}).reason,'Inget utbrott');
});

test('the mirrored downtrend gives the mirrored short signal',()=>{
  const S=350,z=zigzag(600,{sign:-1,spikes:[S,S+2,S+8]}),ind=computeIndicators(z),e=evaluateBar(z,S,{tf:'1h'});
  assert.equal(e.side,'short');assert.equal(e.regime,'trend-down');assert.equal(e.reason,'');
  assert.ok(e.checks.every(c=>c.ok));
  const close=z[S].c,atr=ind.atr[S];
  assert.equal(e.entry,close);assert.equal(e.atr,atr);
  assert.equal(e.sl,close+P.slAtr*atr);
  assert.equal(e.tp,close-P.tpR*(e.sl-close));
  assert.ok(e.tp<close&&close<e.sl);
  const f=e.features;
  assert.ok(f.emaFast<f.emaSlow&&f.slope<0&&f.adx>=P.adxTrend&&f.htf.dir===-1&&close<f.donLow&&f.roc<0);
  assert.ok(P.rsiShort[0]<=f.rsi&&f.rsi<=P.rsiShort[1]);
  assert.equal(e.checks.find(c=>c.key==='trigger').value,f.donLow);
});

test('a repeat trigger inside the cooldown is not a new signal',()=>{
  const S=350;
  for(const sign of [1,-1]){
    const z=zigzag(600,{sign,spikes:[S,S+2,S+8]}),side=sign>0?'long':'short',e=evaluateBar(z,S+2,{tf:'1h'});
    assert.equal(e.side,null);assert.equal(e.entry,null);assert.equal(e.sl,null);assert.equal(e.tp,null);assert.equal(e.atr,null);
    assert.equal(e.reason,`Signal nyligen (väntetid ${P.cooldown} candles)`);
    assert.deepEqual(e.checks.filter(c=>!c.ok).map(c=>[c.key,c.value]),[['cooldown',2]]);
    // The cooldown alone holds it back: without one the same bar signals.
    assert.equal(evaluateBar(z,S+2,{tf:'1h',params:{...P,cooldown:0}}).side,side);
    // Six bars after the repeat the next trigger signals again.
    const found=signalsInRange(z,0,z.length-1,{tf:'1h'});
    assert.deepEqual(found.map(x=>x.t),[z[S].t,z[S+8].t]);
    for(const x of found)assert.deepEqual(x,evaluateBar(z,ix(z,x.t),{tf:'1h'}));
    assert.deepEqual(signalsInRange(z,S+1,S+7,{tf:'1h'}),[]);
  }
});

test('the cooldown only waits after a trigger on the same side',()=>{
  const S=350,z=zigzag(600,{spikes:[S]}),ind=computeIndicators(z),htf=aggregateClosed(z,'1h','4h',z.at(-1).t+HOUR);
  const long=evaluateBar(z,S,{tf:'1h',ind,htfBars:htf});
  assert.equal(long.side,'long');
  // The latest earlier bar that reads an older 4h bucket becomes a short trigger: that bucket's close dips so the
  // 4h trend there points down, and the bar's own values mirror a breakdown.
  let j=S-1;while(evaluateBar(z,j,{tf:'1h',ind,htfBars:htf}).features.htf.t===long.features.htf.t)j--;
  const m=ix(htf,evaluateBar(z,j,{tf:'1h',ind,htfBars:htf}).features.htf.t),htfBars=htf.map((b,k)=>k===m?{...b,c:b.c*.5}:b);
  const copy={...ind},set=(k,v)=>{copy[k]=[...ind[k]];copy[k][j]=v;};
  set('emaFast',ind.emaSlow[j]*.99);set('slope',-Math.abs(ind.slope[j]));set('adx',P.adxTrend+5);set('donLow',z[j].c*1.01);
  set('rsi',(P.rsiShort[0]+P.rsiShort[1])/2);set('roc',-.01);set('relVol',P.volMin*2);set('volRank',(P.volRankMin+P.volRankMax)/2);
  const ctx={tf:'1h',params:{...P,cooldown:Math.max(P.cooldown,S-j)},ind:copy,htfBars};
  assert.equal(evaluateBar(z,j,ctx).side,'short');
  const e=evaluateBar(z,S,ctx);
  assert.equal(e.side,'long');assert.equal(e.features.htf.dir,1);
  assert.deepEqual(e.checks.at(-1),{key:'cooldown',label:'Väntetid',ok:true,value:null});
  assert.deepEqual(signalsInRange(z,j,S,ctx).map(x=>[x.t,x.side]),[[z[j].t,'short'],[z[S].t,'long']]);
});

test('each rule fails on its own with its own Swedish reason',()=>{
  const S=350,z=zigzag(600,{spikes:[S]}),ind=computeIndicators(z),htfBars=aggregateClosed(z,'1h','4h',z.at(-1).t+HOUR);
  // The same bar with one indicator value replaced.
  const at=patch=>{
    const copy={...ind};
    for(const [k,v] of Object.entries(patch)){copy[k]=[...ind[k]];copy[k][S]=v;}
    return evaluateBar(z,S,{tf:'1h',ind:copy,htfBars});
  };
  const shown=(reason,re)=>{const m=reason.match(re);assert.ok(m,reason);return Number(m[1].replace(',','.'));};
  assert.equal(at({}).side,'long');
  const cases=[
    [{adx:Math.floor(P.adxRange)-1},'range','trend',r=>assert.ok(shown(r,/^Sidledes marknad \(ADX (\d+) < [\d,]+\)$/)<P.adxRange)],
    // Just under the limit it shows a decimal instead of rounding onto the limit.
    [{adx:P.adxRange-.04},'range','trend',r=>assert.ok(shown(r,/^Sidledes marknad \(ADX ([\d,]+) < [\d,]+\)$/)<P.adxRange)],
    [{adx:(P.adxRange+P.adxTrend)/2},'weak','trend',r=>assert.ok(shown(r,/^Svag trend \(ADX ([\d,]+)\)$/)<P.adxTrend)],
    [{slope:-Math.abs(ind.slope[S])},'weak','trend',r=>assert.match(r,/^Otydlig trendriktning \(ADX \d+\)$/)],
    [{donHigh:z[S].c*1.001},'trend-up','trigger',r=>assert.equal(r,'Inget utbrott')],
    [{rsi:P.rsiLong[0]-2},'trend-up','momentum',r=>assert.ok(shown(r,/^Momentum saknas \(RSI (\d+)\)$/)<P.rsiLong[0])],
    [{rsi:P.rsiLong[1]+5},'trend-up','momentum',r=>assert.ok(shown(r,/^Överköpt \(RSI (\d+)\)$/)>P.rsiLong[1])],
    [{roc:-.004},'trend-up','momentum',r=>assert.equal(r,`Momentum saknas (ROC(${P.rocPeriod}) \u22120,4${NBSP}%)`)],
    [{relVol:P.volMin*.7},'trend-up','volume',r=>assert.ok(shown(r,/^Låg volym \(([\d,]+)× median\)$/)<P.volMin)],
    [{relVol:null},'trend-up','volume',r=>assert.equal(r,'Volymdata saknas')],
    [{volRank:(1+P.volRankMax)/2},'trend-up','volatility',r=>assert.ok(shown(r,/^Extrem volatilitet \(percentil ([\d,]+)\)$/)>P.volRankMax*100)],
    [{volRank:P.volRankMin/2},'trend-up','volatility',r=>assert.ok(shown(r,/^Låg volatilitet \(percentil ([\d,]+)\)$/)<P.volRankMin*100)]
  ];
  for(const [patch,regime,key,reason] of cases){
    const e=at(patch);
    assert.equal(e.side,null,JSON.stringify(patch));assert.equal(e.regime,regime);
    assert.deepEqual(e.checks.filter(c=>!c.ok).map(c=>c.key),[key],JSON.stringify(patch));
    reason(e.reason);
    assert.equal(e.explanation[0],'Ingen signal: '+e.reason);
  }
});

test('every rule limit is inclusive or strict exactly as frozen',()=>{
  const S=350,eps=1e-9;
  for(const sign of [1,-1]){
    const z=zigzag(600,{sign,spikes:[S]}),ind=computeIndicators(z),htfBars=aggregateClosed(z,'1h','4h',z.at(-1).t+HOUR);
    const side=sign>0?'long':'short',[lo,hi]=sign>0?P.rsiLong:P.rsiShort;
    const at=patch=>{
      const copy={...ind};
      for(const [k,v] of Object.entries(patch)){copy[k]=[...ind[k]];copy[k][S]=v;}
      return evaluateBar(z,S,{tf:'1h',ind:copy,htfBars});
    };
    assert.equal(at({}).side,side);
    // Exactly on a limit passes: ADX >= trend level, lo <= RSI <= hi, relative volume >= minimum, min <= percentile <= max.
    for(const patch of [{adx:P.adxTrend},{rsi:lo},{rsi:hi},{relVol:P.volMin},{volRank:P.volRankMin},{volRank:P.volRankMax}])
      assert.equal(at(patch).side,side,`${side} ${JSON.stringify(patch)}`);
    // A hair past a limit fails that rule alone.
    for(const [patch,key] of [[{adx:P.adxTrend-eps},'trend'],[{rsi:lo-eps},'momentum'],[{rsi:hi+eps},'momentum'],
      [{relVol:P.volMin-eps},'volume'],[{volRank:P.volRankMin-eps},'volatility'],[{volRank:P.volRankMax+eps},'volatility']])
      assert.deepEqual(at(patch).checks.filter(c=>!c.ok).map(c=>c.key),[key],`${side} ${JSON.stringify(patch)}`);
    // ADX exactly on the range level is a weak trend, just under it a sideways market.
    if(P.adxRange<P.adxTrend){const e=at({adx:P.adxRange});assert.equal(e.regime,'weak');assert.match(e.reason,/^Svag trend \(ADX [\d,]+\)$/);}
    assert.equal(at({adx:P.adxRange-eps}).regime,'range');
  }
});

test('a value near its limit reads the same in the reason and in the explanation lines',()=>{
  const S=350,z=zigzag(600,{spikes:[S]}),ind=computeIndicators(z),htfBars=aggregateClosed(z,'1h','4h',z.at(-1).t+HOUR);
  const at=patch=>{
    const copy={...ind};
    for(const [k,v] of Object.entries(patch)){copy[k]=[...ind[k]];copy[k][S]=v;}
    return evaluateBar(z,S,{tf:'1h',ind:copy,htfBars});
  };
  // Each value misses its limit by so little that plain rounding would print the limit itself
  // (e.g. 'Låg volym (1,09× median)' next to 'Volym 1,1× median'); the line naming it must show the reason's number.
  const cases=[
    [{adx:P.adxTrend-.04},/\(ADX ([\d,]+)\)$/,x=>l=>l.endsWith(` · ADX ${x}`)],
    [{adx:P.adxRange-.04},/\(ADX ([\d,]+) < /,x=>l=>l.endsWith(` · ADX ${x}`)],
    [{rsi:P.rsiLong[1]+.3},/\(RSI ([\d,]+)\)$/,x=>l=>l.startsWith(`Momentum: RSI ${x} · `)],
    [{rsi:P.rsiLong[0]-.3},/\(RSI ([\d,]+)\)$/,x=>l=>l.startsWith(`Momentum: RSI ${x} · `)],
    [{relVol:P.volMin-.004},/\(([\d,]+)× median\)$/,x=>l=>l===`Volym ${x}× median`],
    [{volRank:P.volRankMin-.001},/\(percentil ([\d,]+)\)$/,x=>l=>l.startsWith('Volatilitet: ')&&l.endsWith(`(percentil ${x})`)],
    [{volRank:P.volRankMax+.001},/\(percentil ([\d,]+)\)$/,x=>l=>l.startsWith('Volatilitet: ')&&l.endsWith(`(percentil ${x})`)]
  ];
  for(const [patch,re,line] of cases){
    const e=at(patch),value=e.reason.match(re)?.[1];
    assert.ok(value,e.reason);
    assert.equal(e.explanation.slice(1).filter(line(value)).length,1,`${e.reason} | ${e.explanation.join(' / ')}`);
  }
});

test('the higher timeframe needs a close beyond a windowed EMA moving its way, over consecutive buckets',()=>{
  const S=350,z=zigzag(600,{spikes:[S]}),ind=computeIndicators(z),htf=aggregateClosed(z,'1h','4h',z.at(-1).t+HOUR);
  const ok=evaluateBar(z,S,{tf:'1h',ind,htfBars:htf}),m=ix(htf,ok.features.htf.t),W=P.htfWindow*P.htfEma;
  assert.equal(ok.side,'long');
  // A huge close just leaving the EMA window: the EMA falls although the close is above it.
  const e=evaluateBar(z,S,{tf:'1h',ind,htfBars:htf.map((b,k)=>k===m-W?{...b,c:b.c*1e4}:b)});
  assert.ok(e.features.htf.close>e.features.htf.ema);
  assert.equal(e.features.htf.dir,0);
  assert.equal(e.side,null);assert.equal(e.reason,'Trenden och högre tidsram går isär');
  // One bucket older than the window changes nothing; a missing bucket inside it leaves no trend at all.
  assert.deepEqual(evaluateBar(z,S,{tf:'1h',ind,htfBars:htf.map((b,k)=>k===m-W-1?{...b,c:b.c*1e4}:b)}),ok);
  const g=evaluateBar(z,S,{tf:'1h',ind,htfBars:htf.filter((_,k)=>k!==m-5)});
  assert.equal(g.features.htf,null);assert.equal(g.reason,'Högre tidsram saknas');
});

test('a sideways market is a range regime with a Swedish reason and never signals',()=>{
  const bars=sideways(500),ind=computeIndicators(bars);
  for(let i=requiredLookback('1h');i<bars.length;i++){
    const e=evaluateBar(bars,i,{tf:'1h',ind});
    assert.equal(e.regime,'range');assert.equal(e.side,null);
    assert.match(e.reason,new RegExp(`^Sidledes marknad \\(ADX \\d+(,\\d+)? < ${P.adxRange}\\)$`));
    assert.equal(e.explanation[0],'Ingen signal: '+e.reason);
  }
  assert.deepEqual(signalsInRange(bars,0,bars.length-1,{tf:'1h'}),[]);
});

test('a fresh uptrend against a falling higher timeframe is held back',()=>{
  const v=zigzag(700,{sign:i=>i<420?-1:1}),ind=computeIndicators(v),htf=aggregateClosed(v,'1h','4h',v.at(-1).t+HOUR),split=[];
  for(let i=requiredLookback('1h');i<v.length;i++){
    const e=evaluateBar(v,i,{tf:'1h',ind,htfBars:htf});
    if(e.regime==='trend-up'&&e.features.htf.dir!==1){
      split.push(i);
      assert.equal(e.side,null);assert.equal(e.reason,'Trenden och högre tidsram går isär');
    }
  }
  assert.ok(split.length>0);
});

test('too little history or a missing higher timeframe is reported, never guessed',()=>{
  const S=350,z=zigzag(600,{spikes:[S]}),L=requiredLookback('1h');
  for(const i of [0,50,L-1]){
    const e=evaluateBar(z,i,{tf:'1h'});
    assert.equal(e.regime,'insufficient');assert.equal(e.side,null);assert.equal(e.reason,'För kort historik');
    assert.ok(e.checks.every(c=>!c.ok&&c.value===null));
    assert.deepEqual([e.entry,e.sl,e.tp,e.atr],[null,null,null,null]);
    assert.equal(e.explanation.length,3);
  }
  assert.equal(evaluateBar(z,L,{tf:'1h'}).regime,'trend-up');
  const e=evaluateBar(z,S,{tf:'1h',htfBars:[]});
  assert.equal(e.side,null);assert.equal(e.reason,'Högre tidsram saknas');assert.equal(e.features.htf,null);
  assert.equal(e.checks.find(c=>c.key==='htf').ok,false);
  assert.throws(()=>evaluateBar(z,600,{tf:'1h'}),/Ogiltig candle/);
  assert.throws(()=>evaluateBar(z,S,{tf:'2h'}),/Okänd tidsram/);
});

test('evaluations are frozen, JSON-safe and explained in Swedish without any confidence wording',()=>{
  const S=350,up=zigzag(600,{spikes:[S,S+2,S+8]}),down=zigzag(600,{sign:-1,spikes:[S]});
  const long=evaluateBar(up,S,{tf:'1h'}),short=evaluateBar(down,S,{tf:'1h'});
  const pct=`${NBSP}%`,num='\\d{1,3}(?:\\u00a0\\d{3})*(?:,\\d+)?';
  const expected=(e,dir)=>[
    new RegExp(`^Trend ${dir>0?'upp':'ned'}: EMA${P.emaFast} ${dir>0?'över':'under'} EMA${P.emaSlow} och EMA${P.emaSlow} ${dir>0?'stiger':'faller'} · ADX \\d+$`),
    new RegExp(`^4h-trenden ${dir>0?'uppåt':'nedåt'} \\(stängning ${dir>0?'över':'under'} EMA${P.htfEma}\\)$`),
    new RegExp(`^Utbrott: stängning ${num} ${dir>0?'över':'under'} ${P.breakout}-candle-${dir>0?'högsta':'lägsta'} ${num}$`),
    new RegExp(`^Momentum: RSI \\d+ · ROC\\(${P.rocPeriod}\\) ${dir>0?'\\+':'\u2212'}\\d+,\\d${pct}$`),
    /^Volym \d+,\d× median$/,
    new RegExp(`^Volatilitet: ATR \\d+,\\d\\d${pct} \\(percentil \\d+\\)$`)
  ].forEach((re,k)=>assert.match(e.explanation[k],re));
  expected(long,1);expected(short,-1);
  assert.equal(long.explanation.length,6);
  // Every evaluation of all three series: 3-6 Swedish lines, decimal commas, no confidence or probability.
  for(const bars of [up,down,sideways(320)]){
    const ind=computeIndicators(bars);
    for(let i=0;i<bars.length;i+=3){
      const e=evaluateBar(bars,i,{tf:'1h',ind});
      assert.ok(e.explanation.length>=3&&e.explanation.length<=6);
      for(const line of [...e.explanation,e.reason]){
        assert.equal(typeof line,'string');
        assert.doesNotMatch(line,CONFIDENCE);assert.doesNotMatch(line,ENGLISH);assert.doesNotMatch(line,/\d\.\d/);
      }
      if(!e.side)assert.equal(e.explanation[0],'Ingen signal: '+e.reason);
      assert.ok(frozenDeep(e),'deep-frozen');
      assert.deepEqual(JSON.parse(JSON.stringify(e)),e);
      assert.deepEqual(Object.keys(e),['t','close','regime','side','entry','sl','tp','atr','checks','reason','explanation','features']);
      assert.deepEqual(Object.keys(e.features),['adx','rsi','roc','relVol','volRank','atrPct','emaFast','emaSlow','slope','donHigh','donLow','htf']);
    }
  }
  assert.doesNotMatch(JSON.stringify(long),CONFIDENCE);
});

// ---- Forecast ---------------------------------------------------------------
const H=FP.horizon;
const series=walk(2000,{seed:31,gap:.002}),feats=forecastFeatures(series),C=1990;
// The analog selection redone by brute force: z-scores over the candidates, every distance, full sort.
function refNearest(F,c,lo,hi,K){
  const dims=['u','r1','r3','r10','d20','rsi','vr'],cand=[];for(let j=lo;j<=hi;j++)if(F[j])cand.push(j);
  const mean=dims.map(k=>cand.reduce((s,j)=>s+F[j][k],0)/cand.length);
  const sd=dims.map((k,d)=>Math.sqrt(cand.reduce((s,j)=>s+(F[j][k]-mean[d])*(F[j][k]-mean[d]),0)/cand.length)||1);
  const z=f=>dims.map((k,d)=>(f[k]-mean[d])/sd[d]),zc=z(F[c]);
  return {cand,best:cand.map(j=>({j,d:Math.sqrt(z(F[j]).reduce((s,x,d)=>s+(x-zc[d])*(x-zc[d]),0))})).sort((a,b)=>a.d-b.d||b.j-a.j).slice(0,K)};
}

// Re-derives a forecast from the model definition: the K nearest of the training window by brute force,
// outcomes ending by the cutoff, the medoid scenario and the widened type 7 bands. Returns whether the
// medoid is also the nearest analog.
function matchesReference(f,c){
  const ms=TF['1h'].ms,lo=c-FP.train,{cand,best}=refNearest(feats,c,lo,c-H,FP.k),an=f.analogs.map(t=>ix(series,t));
  assert.deepEqual(an,best.map(x=>x.j));
  assert.ok(an.every(j=>j>=lo&&j+H<=c&&series[j].t+H*ms<=f.cutoff));
  assert.deepEqual(f.train,{from:series[cand[0]].t,to:series[cand.at(-1)+H].t,n:cand.length});
  assert.ok(f.train.to<=f.cutoff);
  const R=an.map(j=>Array.from({length:H},(_,h)=>Math.log(series[j+h+1].c/series[j].c)/feats[j].u));
  const med=Array.from({length:H},(_,h)=>refQuantile(R.map(r=>r[h]),.5));
  const cost=R.map(r=>r.reduce((s,x,h)=>s+Math.abs(x-med[h]),0)),m=cost.indexOf(Math.min(...cost)),j=an[m];
  assert.deepEqual(f.medoid,{t:series[j].t,d:best[m].d});
  let w=[0,0,0,0];
  for(let h=0;h<H;h++){
    const b=series[j+h+1],u=feats[j].u,k=f.candles[h];
    near(k.c,f.base*Math.exp(Math.log(b.c/series[j].c)/u*f.unit));
    near(k.o,(h?f.candles[h-1].c:f.base)*Math.exp(Math.log(b.o/series[j+h].c)/u*f.unit));
    near(k.h,Math.max(k.o,k.c)*Math.exp(Math.log(b.h/Math.max(b.o,b.c))/u*f.unit));
    near(k.l,Math.min(k.o,k.c)*Math.exp(-Math.log(Math.min(b.o,b.c)/b.l)/u*f.unit));
    const closes=R.map(r=>f.base*Math.exp(r[h]*f.unit)),q=FP.quantiles.map(x=>refQuantile(closes,x)),mid=q[2];
    w=[Math.max(w[0],Math.log(mid/q[0]),Math.log(mid/q[1])),Math.max(w[1],Math.log(mid/q[1])),Math.max(w[2],Math.log(q[3]/mid)),Math.max(w[3],Math.log(q[4]/mid),Math.log(q[3]/mid))];
    near(f.bands[h].q50,mid);near(f.bands[h].q10,mid*Math.exp(-w[0]));near(f.bands[h].q25,mid*Math.exp(-w[1]));
    near(f.bands[h].q75,mid*Math.exp(w[2]));near(f.bands[h].q90,mid*Math.exp(w[3]));
  }
  return m===0;
}

test('features are windowed: the same at a bar whatever comes after it or where the history starts',()=>{
  const first=feats.findIndex(Boolean);
  assert.ok(first>0&&feats.slice(first).every(Boolean));
  for(const i of [first,500,1200,1999]){
    assert.deepEqual(forecastFeatures(series.slice(0,i+1))[i],feats[i]);
    assert.deepEqual(forecastFeatures(series.slice(i-first))[first],feats[i]);
  }
  const f=feats[1200],b=series,c=b.map(x=>x.c);
  near(f.r1,Math.log(c[1200]/c[1199])/f.u);near(f.r10,Math.log(c[1200]/c[1190])/(f.u*Math.sqrt(10)));
  near(f.u,refAtr(b,1200,14,57)/c[1200]);near(f.rsi,(refRsi(c,1200,14,57)-50)/25);
  near(f.d20,(c[1200]-refEma(c,1200,20,80))/(f.u*c[1200]));
  near(f.vr,Math.log(f.u/refMedian(b.slice(1101,1201).map((_,k)=>refAtr(b,1101+k,14,57)/c[1101+k]))));
});

test('the forecast is deterministic, starts at the cutoff and is a valid candle scenario inside widening bands',()=>{
  const f=forecastAt(series,C,{tf:'1h'}),ms=TF['1h'].ms;
  assert.equal(f.ok,true);assert.equal(f.model,MODEL.forecast);assert.equal(f.cutoff,series[C].t);
  assert.equal(f.base,series[C].c);assert.equal(f.unit,feats[C].u);assert.equal(f.horizon,H);assert.equal(f.k,FP.k);
  assert.deepEqual(forecastAt(series,C,{tf:'1h'}),f);
  assert.deepEqual(forecastAt(series,C,{tf:'1h',features:feats}),f);
  assert.ok(frozenDeep(f));assert.deepEqual(JSON.parse(JSON.stringify(f)),f);
  assert.doesNotMatch(JSON.stringify(f),CONFIDENCE);
  assert.equal(f.candles.length,H);assert.equal(f.bands.length,H);
  f.candles.forEach((k,h)=>{
    assert.equal(k.t,f.cutoff+(h+1)*ms);
    assert.ok([k.o,k.h,k.l,k.c].every(x=>Number.isFinite(x)&&x>0));
    assert.ok(k.l<=Math.min(k.o,k.c)&&Math.max(k.o,k.c)<=k.h,'valid OHLC');
    assert.ok(k.o!==k.c&&k.h>Math.max(k.o,k.c)&&k.l<Math.min(k.o,k.c),'a body and both wicks');
  });
  let prev=[0,0,0,0];
  f.bands.forEach((b,h)=>{
    assert.equal(b.t,f.cutoff+(h+1)*ms);
    assert.ok(b.q10<=b.q25&&b.q25<=b.q50&&b.q50<=b.q75&&b.q75<=b.q90);
    const w=[Math.log(b.q50/b.q10),Math.log(b.q50/b.q25),Math.log(b.q75/b.q50),Math.log(b.q90/b.q50)];
    w.forEach((x,k)=>assert.ok(x>=prev[k]-1e-12,`half-width ${k} narrows at h=${h+1}`));
    prev=w;
  });
  assert.ok(prev[0]>0&&prev[3]>0);
  // Several cutoffs, so the scenario cannot match the reference by coincidence (e.g. the nearest analog being the medoid).
  const medoidIsNearest=[C,1900,1777,1650].map(c=>matchesReference(c===C?f:forecastAt(series,c,{tf:'1h',features:feats}),c));
  assert.ok(medoidIsNearest.includes(false));
});

test('a forecast never reads past its cutoff and survives a reload with a later history start',()=>{
  const f=forecastAt(series,C,{tf:'1h'});
  const changed=series.map((b,k)=>k>C?{...b,o:b.o*3,h:b.h*4,l:b.l*2,c:b.c*3.5,v:1}:b);
  assert.deepEqual(forecastAt(changed,C,{tf:'1h'}),f);
  assert.deepEqual(forecastAt(changed,C,{tf:'1h',features:forecastFeatures(changed)}),f);
  assert.deepEqual(forecastAt(series.slice(0,C+1),C,{tf:'1h'}),f);
  assert.deepEqual(forecastAt(series.map((b,k)=>k>C?{t:b.t,o:NaN,h:NaN,l:NaN,c:NaN}:b),C,{tf:'1h'}),f,'later bars are not even read');
  // Same result from any start that still holds the training window and its features' own windows.
  const first=feats.findIndex(Boolean),kMax=C-FP.train-first;
  for(const k of [1,100,kMax])assert.deepEqual(forecastAt(series.slice(k),C-k,{tf:'1h'}),f,'start '+k);
  assert.notDeepEqual(forecastAt(series.slice(kMax+1),C-kMax-1,{tf:'1h'}),f);
});

test('a walk-forward library restricts the analogs and too little history is refused in Swedish',()=>{
  const library={from:400,to:1300},f=forecastAt(series,C,{tf:'1h',features:feats,library});
  assert.equal(f.ok,true);
  const an=f.analogs.map(t=>ix(series,t)),{cand,best}=refNearest(feats,C,Math.max(C-FP.train,library.from),library.to-H,FP.k);
  assert.ok(an.every(j=>j>=library.from&&j+H<=library.to));
  assert.deepEqual(an,best.map(x=>x.j));
  assert.deepEqual(f.train,{from:series[cand[0]].t,to:series[cand.at(-1)+H].t,n:cand.length});
  assert.ok(f.train.to<=series[library.to].t);
  const refused={ok:false,reason:'För kort historik för prognos'};
  assert.deepEqual(forecastAt(series,C,{tf:'1h',features:feats,library:{from:1000,to:1100}}),refused);
  assert.deepEqual(forecastAt(series.slice(0,300),299,{tf:'1h'}),refused);
  assert.deepEqual(forecastAt(series,100,{tf:'1h',features:feats}),refused);
  assert.throws(()=>forecastAt(series,C,{tf:'2h'}),/Okänd tidsram/);
  assert.throws(()=>forecastAt(series,series.length,{tf:'1h'}),/Ogiltig prognospunkt/);
});

test('equally near analogs are broken in favour of the later bar',()=>{
  // Hand-made features: only r1 differs, cycling through ten values, so whole groups tie on distance.
  const bars=series.slice(0,400),F=bars.map((_,j)=>j<20?null:{u:.01,r1:(j%10)/10,r3:0,r10:0,d20:0,rsi:0,vr:0});
  const params={...FP,k:10,train:300,minCandidates:50},c=393,f=forecastAt(bars,c,{tf:'1h',features:F,params});
  const lo=c-params.train,hi=c-H,same=[];for(let j=hi;j>=lo&&same.length<10;j--)if(j%10===c%10)same.push(j);
  assert.deepEqual(f.analogs,same.map(j=>bars[j].t));
  assert.equal(f.k,10);
});
