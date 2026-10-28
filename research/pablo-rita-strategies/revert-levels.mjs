// Mean reversion and levels: the app's question plus a computed level sheet (swing highs/lows, range edges,
// round numbers, distance to EMA20/EMA50 in ATR, z-score, RSI, recent stretch) and rules for drawing price that
// respects them: fade a stretched move part of the way back toward the mean, bounce at support, stall at resistance.
// Same answer format as the app, so the app's reader works unchanged.
import {appPrompt} from '../pablo-rita-sim.mjs';

export function features(m){
  const h=m.history,c=h.map(b=>b.c),last=h.at(-1),p=m.base,dec=m.dec,f=x=>x.toFixed(dec);
  const ema=(n)=>{const k=2/(n+1);let e=c[0];for(const x of c)e+=k*(x-e);return e;};
  const tr=h.slice(1).map((b,i)=>Math.max(b.h-b.l,Math.abs(b.h-h[i].c),Math.abs(b.l-h[i].c)));
  const atr=tr.slice(-14).reduce((s,x)=>s+x,0)/14;
  const ranges=h.slice(-20).map(b=>b.h-b.l).sort((a,b)=>a-b),medRange=ranges[10];
  const c20=c.slice(-20),sma20=c20.reduce((s,x)=>s+x,0)/20,sd20=Math.sqrt(c20.reduce((s,x)=>s+(x-sma20)**2,0)/20)||1e-12;
  const e20=ema(20),e50=ema(50);
  let up=0,dn=0;for(let i=c.length-14;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)up+=d;else dn-=d;}
  const rsi=dn?100-100/(1+up/dn):100;
  const r48=h.slice(-48),hi48=Math.max(...r48.map(b=>b.h)),lo48=Math.min(...r48.map(b=>b.l));
  const pos48=(p-lo48)/((hi48-lo48)||1e-12)*100;
  const inAtr=x=>(x/atr).toFixed(1);
  // Swing levels: a high/low that is the extreme of 3 candles on each side, in the last 150 candles.
  const piv=[],k=3,from=Math.max(k,h.length-150);
  for(let i=from;i<h.length-k;i++){
    const w=h.slice(i-k,i+k+1);
    if(h[i].h===Math.max(...w.map(b=>b.h)))piv.push({x:h[i].h,kind:'topp',age:h.length-1-i});
    if(h[i].l===Math.min(...w.map(b=>b.l)))piv.push({x:h[i].l,kind:'botten',age:h.length-1-i});
  }
  // Merge nearby pivots (within 0.4 ATR) into levels with a touch count.
  const levels=[];
  for(const q of piv.sort((a,b)=>a.x-b.x)){
    const L=levels.at(-1);
    if(L&&q.x-L.hi<=0.4*atr){L.hi=q.x;L.n++;L.sum+=q.x;L.age=Math.min(L.age,q.age);}
    else levels.push({lo:q.x,hi:q.x,n:1,sum:q.x,age:q.age});
  }
  const lv=levels.map(L=>({x:L.sum/L.n,n:L.n,age:L.age}));
  const above=lv.filter(L=>L.x>p).sort((a,b)=>a.x-b.x).slice(0,3);
  const below=lv.filter(L=>L.x<p).sort((a,b)=>b.x-a.x).slice(0,3);
  const lvText=L=>`${f(L.x)} (${inAtr(Math.abs(L.x-p))} ATR bort, ${L.n} ${L.n>1?'träffar':'träff'}, senast för ${L.age} candles sedan)`;
  const step=10**(Math.floor(Math.log10(p))-1),half=step/2;
  const rUp=Math.ceil(p/half)*half,rDn=Math.floor(p/half)*half;
  const ret5=p-c.at(-6),ret10=p-c.at(-11),ret20=p-c.at(-21);
  const z=(p-sma20)/sd20,d20=(p-e20)/atr,d50=(p-e50)/atr;
  let state='inte översträckt';
  if(z>1.8||d20>1.8||ret5/atr>2.5)state='ÖVERSTRÄCKT UPPÅT';
  else if(z<-1.8||d20<-1.8||ret5/atr<-2.5)state='ÖVERSTRÄCKT NEDÅT';
  else if(z>1||d20>1)state='något sträckt uppåt';
  else if(z<-1||d20<-1)state='något sträckt nedåt';
  const lines=[
    `Nivåanalys (beräknad av appen på de stängda candlarna, senaste pris ${f(p)}):`,
    `- ATR14 ${f(atr)} (${(atr/p*100).toFixed(2)} %), median candlestorlek (high−low) senaste 20: ${f(medRange)}.`,
    `- EMA20 ${f(e20)} (priset ${inAtr(p-e20)} ATR från den), EMA50 ${f(e50)} (${inAtr(p-e50)} ATR), SMA20 ${f(sma20)}, z-värde mot 20 candles ${z.toFixed(2)}, RSI14 ${rsi.toFixed(0)}.`,
    `- Rörelse senaste 5/10/20 candles: ${inAtr(ret5)} / ${inAtr(ret10)} / ${inAtr(ret20)} ATR.`,
    `- Spann senaste 48 candles: ${f(lo48)}–${f(hi48)}, priset ligger på ${pos48.toFixed(0)} % av spannet.`,
    `- Motstånd ovanför (swingtoppar/-bottnar): ${above.length?above.map(lvText).join('; '):'inga nära'}.`,
    `- Stöd nedanför: ${below.length?below.map(lvText).join('; '):'inga nära'}.`,
    `- Runda tal: ${f(rUp)} ovanför, ${f(rDn)} nedanför.`,
    `- Läge: ${state}.`
  ];
  return {text:lines.join('\n'),atr,medRange};
}

const RULES=[
  'Rita med medelåtergång och nivåer som grund:',
  '1. Utgå från senaste priset. Det mest sannolika är att priset stannar nära där det är; rita inga stora trendrörelser.',
  '2. Om läget är översträckt (stort avstånd till EMA20, högt |z-värde| eller en snabb rörelse senaste 5 candles): rita en delvis återgång, ungefär en tredjedel till hälften av vägen mot EMA20, inte hela vägen.',
  '3. Ligger priset nära ett stöd (inom ~0,5 ATR): rita en studs eller att nivån håller. Nära ett motstånd: rita att priset stannar under det. Bryt en nivå bara om den redan har brutits tydligt.',
  '4. Utan översträckning och utan nära nivå: rita en lugn pendling runt senaste priset med en svag lutning mot EMA20.',
  '5. Slutpriset efter 10 candles bör normalt ligga högst ~1 ATR från senaste priset (högst ~1,5 ATR vid tydlig översträckning). Låt stängningarna röra sig mjukt, utan sicksack.',
  '6. Gör varje candle ungefär lika stor (high−low) som mediancandlen ovan, med veken som når mot närmaste nivå.'
].join('\n');

export default {
  name: 'revert-levels',
  description: 'Medelåtergång och nivåer: appens fråga plus en beräknad nivåanalys (swingnivåer, spann, runda tal, EMA-avstånd i ATR, z-värde) och regler för att tona översträckning, studsa på stöd och stanna vid motstånd.',
  prompt(m){
    const q=appPrompt(m),{text}=features(m);
    const i=q.indexOf('\n\nRita din bästa gissning');
    return q.slice(0,i)+'\n\n'+text+'\n\n'+RULES+q.slice(i);
  }
};
