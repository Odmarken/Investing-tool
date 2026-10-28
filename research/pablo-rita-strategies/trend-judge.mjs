// Trendföljning med Pablos eget omdöme: samma uträknade trendmått som trend-rules men utan röster,
// etikett eller färdig slutzon. Pablo bedömer själv trenden (struktur, EMA, högre tidsram), kräver att
// den högre tidsramen håller med, ritar rekylen först och förlänger bara lite (högst en halv ATR).
import {appPrompt} from '../pablo-rita-sim.mjs';
import {trendFeatures} from './trend-rules.mjs';

function facts(m,f){
  const p=x=>x.toFixed(m.dec),pct=x=>(x*100).toFixed(2).replace('.',',')+' %',sgn=x=>x>0?'upp':x<0?'ned':'neutral';
  const half=0.5*f.A,small=0.15*f.A;
  return [
    'Trendmått (uträknade från candlarna):',
    `- Pris ${p(m.base)} · EMA20 ${p(f.e20)} · EMA50 ${p(f.e50)}; avstånd till EMA20 ${f.dist20.toFixed(1).replace('.',',')} ATR.`,
    `- EMA20 lutar ${pct(f.slope20)} per candle; avkastning 10 candles ${pct(f.ret10)}, 30 candles ${pct(f.ret30)}.`,
    `- Effektivitet senaste 20 candles ${f.er20.toFixed(2).replace('.',',')} (1 = rak linje, 0 = bara brus).`,
    `- Svängstruktur senaste 60 candles: ${f.st>0?'högre toppar och högre bottnar':f.st<0?'lägre toppar och lägre bottnar':'blandad'}.`,
    `- Högre tidsram (${m.tf==='1h'?'4h':'1D'}): ${sgn(f.htf)}.`,
    `- ATR14 ${p(f.A)} (${pct(f.atrPct)}); typisk candle high–low senaste 20: ${p(f.range)}.`,
    `- Storleksgränser för slutstängningen (candle ${m.n}): tydlig trend högst ±${p(half)} från ${p(m.base)} (en halv ATR); annars högst ±${p(small)}.`
  ].join('\n');
}

const RULES=[
  'Du är en försiktig trendföljare. Gör så här i huvudet innan du ritar:',
  '1. Läs själv av trenden i candlarna: högre toppar/bottnar eller lägre toppar/bottnar, var priset ligger mot EMA20/EMA50 och åt vilket håll de lutar.',
  '2. Kalla det en tydlig trend bara om strukturen, EMA:erna OCH den högre tidsramen pekar åt samma håll och rörelsen är riktad (effektivitet över ungefär 0,3). Allt annat är ingen trend.',
  '3. Tydlig trend: rita först en rekyl mot trenden (mot EMA20, 2–4 candles), sedan en lugn fortsättning i trendens riktning. Slutstängningen får ligga högst en halv ATR från senaste priset — förläng aldrig hela den senaste rörelsen.',
  '4. Ingen trend: rita ett platt, pendlande förlopp där slutstängningen ligger mycket nära senaste priset (inom gränsen ovan).',
  '5. Candlarna ska ha realistisk storlek: high–low ungefär som den typiska candlen, med veker på båda sidor.'
].join('\n');

export default {
  name:'trend-judge',
  description:'Trendföljning med eget omdöme: trendmått utan etikett, krav på samstämmig högre tidsram, rekyl först, högst ½ ATR i trendens riktning.',
  prompt(m){
    const f=trendFeatures(m);
    return appPrompt(m).replace(/\n\nRita din bästa gissning/,'\n\n'+facts(m,f)+'\n\n'+RULES+'\n\nRita din bästa gissning');
  }
};
