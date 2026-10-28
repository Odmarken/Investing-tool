// Quant / calibrated median path: Pablo gets measured statistics (volatility, ATR, candle bodies and wicks,
// the 10-candle return distribution, continuation vs reversal) and draws the probability-weighted median path
// inside a numeric drift guardrail, with candles sized like the real ones.
import {appPrompt} from '../pablo-rita-sim.mjs';

const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const std=a=>{const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/Math.max(1,a.length-1));};
const q=(a,p)=>{const v=[...a].sort((x,y)=>x-y);const i=(v.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return v[lo]+(v[hi]-v[lo])*(i-lo);};
const pct=(x,d=2)=>(x*100).toFixed(d).replace('-','−')+' %';
const sgn=x=>(x>0?'+':'')+pct(x);

export function quantStats(m){
  const h=m.history,n=m.n,base=m.base,p=x=>x.toFixed(m.dec);
  const r=h.slice(1).map((b,i)=>Math.log(b.c/h[i].c));
  const s100=std(r.slice(-100)),s20=std(r.slice(-20)),s1=(s100+s20)/2,s10=s1*Math.sqrt(n);
  const tr=h.slice(1).map((b,i)=>Math.max(b.h-b.l,Math.abs(b.h-h[i].c),Math.abs(b.l-h[i].c)));
  const atr14=mean(tr.slice(-14)),rng20=mean(h.slice(-20).map(b=>b.h-b.l));
  const last100=h.slice(-100);
  const body=q(last100.map(b=>Math.abs(b.c-b.o)),.5),up=q(last100.map(b=>b.h-Math.max(b.o,b.c)),.5),dn=q(last100.map(b=>Math.min(b.o,b.c)-b.l),.5);
  const rangeMed=q(last100.map(b=>b.h-b.l),.5);
  const fwd=[];for(let i=0;i+n<h.length;i++)fwd.push(h[i+n].c/h[i].c-1);
  let same=0,tot=0;for(let i=n;i+n<h.length;i+=2){const a=h[i].c-h[i-n].c,b=h[i+n].c-h[i].c;if(a&&b){tot++;if(Math.sign(a)===Math.sign(b))same++;}}
  const ac1=(()=>{const x=r.slice(-150),mu=mean(x);let num=0,den=0;for(let i=1;i<x.length;i++)num+=(x[i]-mu)*(x[i-1]-mu);for(const v of x)den+=(v-mu)**2;return den?num/den:0;})();
  const ret10=base/h.at(-1-n).c-1,ret20=base/h.at(-21).c-1;
  const w50=h.slice(-50),hi50=Math.max(...w50.map(b=>b.h)),lo50=Math.min(...w50.map(b=>b.l));
  const posi=hi50>lo50?(base-lo50)/(hi50-lo50):.5;
  const f=m.forecast?.bands?.[n-1];
  const g1=0.25*s10,g2=0.5*s10;
  return {s1,s10,atr14,rng20,rangeMed,body,up,dn,fwd,same,tot,ac1,ret10,ret20,hi50,lo50,posi,f,g1,g2,p,
    lines:[
      `Uppmätt statistik för ${m.symbol} ${m.tfLabel} (beräknad av appen ur de senaste ${h.length} stängda candlarna; priser i USDT):`,
      `- Volatilitet per candle (logavkastning, std): ${pct(s1,3)} (senaste 20: ${pct(s20,3)}, senaste 100: ${pct(s100,3)}). Över ${n} candles: σ10 ≈ ${pct(s10)} ≈ ${p(base*s10)}.`,
      `- ATR(14) ${p(atr14)} (${pct(atr14/base,3)}). Snittspann high−low senaste 20: ${p(rng20)}; median senaste 100: ${p(rangeMed)}.`,
      `- Typisk candle (median senaste 100): kropp |close−open| ${p(body)}, övre veke ${p(up)}, nedre veke ${p(dn)}.`,
      `- Avkastning över ${n} candles i historiken (${fwd.length} fönster): 10 % ${sgn(q(fwd,.1))}, 25 % ${sgn(q(fwd,.25))}, median ${sgn(q(fwd,.5))}, 75 % ${sgn(q(fwd,.75))}, 90 % ${sgn(q(fwd,.9))}.`,
      `- Fortsätter eller vänder: efter en ${n}-candlesrörelse gick nästa ${n} candles åt samma håll i ${tot?Math.round(100*same/tot):'–'} % av ${tot} fall. Autokorrelation candle-till-candle: ${ac1.toFixed(2)}.`,
      `- Senaste rörelsen: ${sgn(ret10)} över ${n} candles (${(ret10/s10).toFixed(2)} σ10), ${sgn(ret20)} över 20. Priset ligger på ${Math.round(posi*100)} % av spannet ${p(lo50)}–${p(hi50)} (50 candles).`,
      f?`- Statistiska modellens candle ${n}: median ${p(f.q50)} (${sgn(f.q50/base-1)}), 25–75 % ${p(f.q25)}–${p(f.q75)}, 10–90 % ${p(f.q10)}–${p(f.q90)}.`:'',
      `- Räcke för 10:e stängningen: normalt ${p(base*(1-g1))}–${p(base*(1+g1))} (±0,25·σ10), med starkt stöd högst ${p(base*(1-g2))}–${p(base*(1+g2))} (±0,5·σ10).`
    ].filter(Boolean)};
}

export function quantMethod(m,S){
  const {p}=S;
  return [
    'Metod: rita en kalibrerad medianbana, inte ett äventyr. Ett oförändrat pris är svårt att slå: över '+m.n+' candles är rörelsen i snitt stor men riktningen nästan slumpmässig, och varje procent fel drift kostar mer än den vinner.',
    'Gör så här i huvudet (skriv inte ut stegen): 1) Väg tre scenarier — upp, bas, ned — med sannolikheter och slutpris utifrån trend, nivåer, statistiken ovan och modellens median. 2) Den sannolikhetsvägda medianen är banan för stängningarna. Luta bara när flera oberoende tecken pekar samma håll; annars nära oförändrat. 3) Håll 10:e stängningen inom det normala räcket ovan och aldrig utanför det yttre. Banan ska vara jämn: ingen V-form, inga utbrott.',
    `4) Rita candlarna i verklig storlek: high−low runt ${p(S.rng20)} (som ATR), kroppar runt ${p(S.body)}, vekar runt ${p(S.up)} upp och ${p(S.dn)} ned. Låt kropparna växla mellan upp och ned så att stängningarna pendlar tätt kring banan i stället för att vandra iväg. Inga platta streck.`
  ].join('\n');
}

export default {
  name: 'quant-median',
  description: 'Uppmätt statistik (σ, ATR, kropp/veke, 10-candlesfördelning, fortsätter/vänder) + tre scenarier → sannolikhetsvägd medianbana inom ±0,25·σ10, candlar i verklig storlek som pendlar kring banan.',
  prompt(m){
    const S=quantStats(m),app=appPrompt(m),k=app.indexOf('Svara exakt så här');
    return app.slice(0,k)+S.lines.join('\n')+'\n\n'+quantMethod(m,S)+'\n\n'+app.slice(k);
  }
};
