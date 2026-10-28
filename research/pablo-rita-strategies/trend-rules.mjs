// Trendföljning: Pablo får en uträknad trendanalys (EMA-läge och lutning, högre toppar/bottnar,
// effektivitet, högre tidsram, ATR) och regler för att förlänga en tydlig trend dämpat med rekyler,
// och att ligga nära oförändrat pris när trenden är otydlig.
import {appPrompt} from '../pablo-rita-sim.mjs';

const ema=(xs,p)=>{const k=2/(p+1),out=[];let e=xs[0];for(const x of xs){e=x*k+e*(1-k);out.push(e);}return out;};
const atr=(bars,p=14)=>{const tr=bars.slice(1).map((b,i)=>Math.max(b.h-b.l,Math.abs(b.h-bars[i].c),Math.abs(b.l-bars[i].c)));const s=tr.slice(-p);return s.reduce((a,x)=>a+x,0)/s.length;};
const median=xs=>{const v=[...xs].sort((a,b)=>a-b);return v[Math.floor(v.length/2)];};

/* Svängtoppar och svängbottnar (pivot med k candles på varje sida) bland de senaste bars. */
function swings(bars,k=3){
  const hi=[],lo=[];
  for(let i=k;i<bars.length-k;i++){
    const w=bars.slice(i-k,i+k+1);
    if(bars[i].h===Math.max(...w.map(b=>b.h)))hi.push(bars[i].h);
    if(bars[i].l===Math.min(...w.map(b=>b.l)))lo.push(bars[i].l);
  }
  return {hi:hi.slice(-3),lo:lo.slice(-3)};
}
function structure({hi,lo}){
  const up=a=>a.length>=2&&a.every((x,i)=>i===0||x>a[i-1]),dn=a=>a.length>=2&&a.every((x,i)=>i===0||x<a[i-1]);
  if(up(hi)&&up(lo))return 1;
  if(dn(hi)&&dn(lo))return -1;
  return 0;
}
/* Högre tidsram: 4 timcandles → 4h, 6 fyratimmarscandles → 1D. */
function higher(bars,g){
  const out=[];
  for(let i=bars.length%g;i+g<=bars.length;i+=g){const w=bars.slice(i,i+g);out.push({o:w[0].o,h:Math.max(...w.map(b=>b.h)),l:Math.min(...w.map(b=>b.l)),c:w.at(-1).c});}
  return out;
}

export function trendFeatures(m){
  const h=m.history,c=h.map(b=>b.c),base=m.base;
  const e20=ema(c,20),e50=ema(c,50);
  const A=atr(h),atrPct=A/base;
  const slope20=(e20.at(-1)-e20.at(-6))/5/base;              // per candle, andel av priset
  const ret=k=>(c.at(-1)-c.at(-1-k))/c.at(-1-k);
  const path=k=>c.slice(-k-1).reduce((s,x,i,a)=>i?s+Math.abs(x-a[i-1]):0,0);
  const er20=Math.abs(c.at(-1)-c.at(-21))/path(20);
  const st=structure(swings(h.slice(-60)));
  const H=higher(h,m.tf==='1h'?4:6),hc=H.map(b=>b.c),he20=ema(hc,20),he50=ema(hc,Math.min(50,Math.max(10,Math.floor(hc.length/2))));
  const htf=Math.sign(he20.at(-1)-he50.at(-1))===Math.sign(he20.at(-1)-he20.at(-4))?Math.sign(he20.at(-1)-he50.at(-1)):0;
  const votes=[Math.sign(base-e20.at(-1)),Math.sign(e20.at(-1)-e50.at(-1)),Math.abs(slope20)>0.05*atrPct?Math.sign(slope20):0,st,htf];
  const score=votes.reduce((a,x)=>a+x,0);
  const dir=score>=3&&er20>=0.2?1:score<=-3&&er20>=0.2?-1:0;
  const strong=dir!==0&&Math.abs(score)>=4&&er20>=0.3;
  const range=median(h.slice(-20).map(b=>b.h-b.l));
  return {e20:e20.at(-1),e50:e50.at(-1),A,atrPct,slope20,ret10:ret(10),ret30:ret(30),er20,st,htf,votes,score,dir,strong,range,
    dist20:(base-e20.at(-1))/A};
}

/* Föreslagen slutzon efter n candles: i trendens riktning, dämpad, i ATR. */
export function targetZone(f,m,{weak=0.4,strongK=0.8,flat=0.25}={}){
  const k=f.dir===0?0:f.strong?strongK:weak;
  const mid=m.base+f.dir*k*f.A,w=(f.dir===0?flat:0.5)*f.A;
  return {mid,lo:mid-w,hi:mid+w};
}

export function trendBlock(m,f,z){
  const p=x=>x.toFixed(m.dec),pct=x=>(x*100).toFixed(2).replace('.',',')+' %';
  const sgn=x=>x>0?'upp':x<0?'ned':'neutral';
  const label=f.dir===0?'INGEN TYDLIG TREND':(f.strong?'TYDLIG ':'MÅTTLIG ')+(f.dir>0?'UPPTREND':'NEDTREND');
  return [
    'Trendanalys (uträknad från candlarna):',
    `- Pris ${p(m.base)} · EMA20 ${p(f.e20)} · EMA50 ${p(f.e50)}; priset ligger ${f.dist20>=0?'över':'under'} EMA20 med ${Math.abs(f.dist20).toFixed(1).replace('.',',')} ATR.`,
    `- EMA20 lutar ${pct(f.slope20)} per candle; avkastning senaste 10 candles ${pct(f.ret10)}, senaste 30 ${pct(f.ret30)}.`,
    `- Effektivitet (rak rörelse/total väg) senaste 20 candles: ${f.er20.toFixed(2).replace('.',',')} (över 0,3 = riktad, under 0,2 = brus).`,
    `- Svängstruktur senaste 60 candles: ${f.st>0?'högre toppar och högre bottnar':f.st<0?'lägre toppar och lägre bottnar':'blandad'}.`,
    `- Högre tidsram (${m.tf==='1h'?'4h':'1D'}): ${sgn(f.htf)}.`,
    `- ATR14 ${p(f.A)} (${pct(f.atrPct)}); typisk candle high–low senaste 20: ${p(f.range)}.`,
    `- Röster (pris/EMA20, EMA20/EMA50, lutning, struktur, högre tidsram): ${f.votes.map(sgn).join(', ')} → ${label}.`,
    `- Föreslagen zon för stängningen på candle ${m.n}: ${p(z.lo)}–${p(z.hi)} (mitt ${p(z.mid)}).`
  ].join('\n');
}

const RULES=[
  'Arbeta som en disciplinerad trendföljare:',
  '1. Utgå från trendanalysen. Vid TYDLIG eller MÅTTLIG trend: förläng trenden i samma riktning, men dämpat — trender saktar in, så rita en lugn lutning och lägg in en realistisk rekyl (1–3 candles mot trenden, högst ungefär en halv ATR) innan trenden tar vid igen. Den sista stängningen ska hamna i den föreslagna zonen.',
  '2. Vid INGEN TYDLIG TREND: rita ett nästan platt förlopp som pendlar kring senaste priset; den sista stängningen ska ligga i den föreslagna zonen nära senaste priset. Gissa inte på utbrott.',
  '3. Om priset ligger långt från EMA20 (mer än ~2 ATR) i trendens riktning: räkna med en paus eller liten rekyl först.',
  '4. Ge candlarna realistisk storlek: high–low ungefär som den typiska candlen ovan, med veker på båda sidor.'
].join('\n');

export default {
  name:'trend-rules',
  description:'Trendföljning: uträknad trendanalys med röster och en dämpad slutzon (0,4/0,8 ATR i trendens riktning, platt utan trend).',
  prompt(m){
    const f=trendFeatures(m),z=targetZone(f,m);
    return [appPrompt(m).replace(/\n\nRita din bästa gissning/,'\n\n'+trendBlock(m,f,z)+'\n\n'+RULES+'\n\nRita din bästa gissning')].join('');
  }
};
