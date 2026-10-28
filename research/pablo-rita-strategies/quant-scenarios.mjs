// Quant, variant 2: the same measured statistics as quant-median, but Pablo states bull/base/bear probabilities
// on line 1 and the drift follows from them by a fixed rule: 10th close = last + (P(upp) − P(ned)) · σ10, capped
// at ±0.5·σ10. Closes follow a smooth path; candles keep the measured size.
import {appPrompt} from '../pablo-rita-sim.mjs';
import {quantStats} from './quant-median.mjs';

export default {
  name: 'quant-scenarios',
  description: 'Uppmätt statistik + uttalade sannolikheter upp/bas/ned på rad 1; slutet = senaste + (P(upp)−P(ned))·σ10 (tak ±0,5·σ10), jämn bana, candlar i verklig storlek.',
  prompt(m){
    const S=quantStats(m),{p}=S,base=m.base,s10=base*S.s10;
    const lines=S.lines.filter(l=>!l.startsWith('- Räcke'));
    const method=[
      'Metod: detta är en sannolikhetsprognos. Ett oförändrat pris är svårt att slå: över '+m.n+' candles är riktningen nästan slumpmässig, så banan ska vara medianen av utfallen, inte det mest spännande scenariot.',
      `1) Bedöm tre scenarier för de ${m.n} candlarna: upp (slutar runt ${p(base+s10)}), bas (sidledes kring ${p(base)}) och ned (runt ${p(base-s10)}). Ge dem sannolikheter som summerar till 100 % utifrån trend, nivåer, momentum och statistiken ovan. Var kalibrerad: utan tydliga, samstämmiga tecken ligger upp och ned nära varandra.`,
      `2) 10:e stängningen = ${p(base)} + (P(upp) − P(ned)) × ${p(s10)}. Exempel: upp 45 %, bas 35 %, ned 20 % ger ${p(base+.25*s10)}. Aldrig utanför ${p(base-.5*s10)}–${p(base+.5*s10)}.`,
      '3) Stängningarna följer en jämn bana från senaste priset till den 10:e stängningen (ingen V-form, inga utbrott); de får pendla lite kring banan men inte vandra iväg.',
      `4) Candlar i verklig storlek: high−low runt ${p(S.rng20)}, kroppar runt ${p(S.body)}, vekar runt ${p(S.up)} upp och ${p(S.dn)} ned. Låt kropparna växla upp och ned kring banan. Inga platta streck.`
    ].join('\n');
    const app=appPrompt(m).replace('Rad 1: en kort mening på svenska om vad du ser och varför (högst 200 tecken).',
      'Rad 1: en kort mening på svenska som börjar med sannolikheterna, t.ex. "Upp 40 % · bas 35 % · ned 25 %: …", och sedan varför (högst 200 tecken).');
    const k=app.indexOf('Svara exakt så här');
    return app.slice(0,k)+lines.join('\n')+'\n\n'+method+'\n\n'+app.slice(k);
  }
};
