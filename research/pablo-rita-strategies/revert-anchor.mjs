// Mean reversion with a computed anchor: the same level sheet as revert-levels, plus a reversion target worked out
// in code (fade a quarter of the last 5 candles' move and lean a fifth of the way to EMA20). Pablo draws a smooth,
// small path that ends near the anchor and lets the levels shape the way there (stall under resistance, hold
// above support). Same answer format as the app.
import {appPrompt} from '../pablo-rita-sim.mjs';
import {features} from './revert-levels.mjs';

function anchor(m){
  const c=m.history.map(b=>b.c),k=2/21;let e=c[0];for(const x of c)e+=k*(x-e);
  return m.base-0.25*(m.base-c.at(-6))+0.2*(e-m.base);
}

export default {
  name: 'revert-anchor',
  description: 'Medelåtergång med beräknat ankare: nivåanalysen från revert-levels plus ett återgångsmål (tona 25 % av senaste 5 candles rörelse, 20 % mot EMA20) som Pablo ritar en mjuk, liten bana mot, formad av stöd och motstånd.',
  prompt(m){
    const q=appPrompt(m),{text,atr,medRange}=features(m),f=x=>x.toFixed(m.dec),a=anchor(m);
    const lean=a>m.base?'uppåt':a<m.base?'nedåt':'oförändrat';
    const rules=[
      `Återgångsmål (beräknat av appen): ${f(a)}, alltså ${((a-m.base)/atr).toFixed(2)} ATR ${lean} från senaste priset. Det tonar en del av den senaste korta rörelsen och lutar svagt mot EMA20; i appens mätningar har utdragna trendrörelser och stora vändningar i ritningen gett större fel än ett oförändrat pris.`,
      'Rita så här:',
      `1. Låt den 10:e stängningen hamna nära återgångsmålet (inom ±0,3 ATR, alltså ${f(a-0.3*atr)}–${f(a+0.3*atr)}). Flytta den bara om ett stöd eller motstånd med flera träffar ligger i vägen; stanna då strax före nivån.`,
      '2. Låt stängningarna gå mjukt från senaste priset mot målet, ungefär två tredjedelar av vägen under de första fem candlarna och resten lugnt efter det, utan sicksack och utan att skjuta över målet.',
      '3. Vid ett nära motstånd (inom 0,5 ATR) ska veken nå mot nivån men stängningen ligga under den; vid ett nära stöd tvärtom.',
      `4. Gör varje candle ungefär ${f(medRange)} stor (high−low), mediancandlen senaste 20, så att candlarna ser ut som riktiga candles för tidsramen.`,
      'Meningen på rad 1 ska säga vilken nivå eller översträckning du tonar.'
    ].join('\n');
    const i=q.indexOf('\n\nRita din bästa gissning');
    return q.slice(0,i)+'\n\n'+text+'\n\n'+rules+q.slice(i);
  }
};
