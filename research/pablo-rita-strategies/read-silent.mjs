// Structured chart reading, silent: a clean, readable chart (percent changes, volume
// relative to normal, a higher-timeframe summary and key levels built from m.history),
// without the app's statistical forecast and signal rule (both measured as no better
// than chance). Pablo walks a day trader's checklist in his head and answers in the
// app's format: one sentence, then exactly ten candles. The app's reader works unchanged.
const DAY = 86400000;
const WD = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];
const time = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const pct = (a, b) => (a / b - 1) * 100;
const sgn = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

/* Candles of the history merged into a higher timeframe, aligned to UTC (4h or 1 day). Only whole groups. */
function merge(bars, ms, tfMs){
  const per = ms / tfMs, out = [];
  let cur = null;
  for(const b of bars){
    const t = Math.floor(b.t / ms) * ms;
    if(!cur || cur.t !== t){ if(cur) out.push(cur); cur = {t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, k: 0}; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; }
    cur.k++;
  }
  if(cur) out.push(cur);
  return out.filter(x => x.k === per);
}

function session(t){
  const d = new Date(t), h = d.getUTCHours(), wd = d.getUTCDay();
  const s = h < 7 ? 'Asien' : h < 13 ? 'Europa' : h < 21 ? 'USA (överlapp Europa till ~16)' : 'sen USA/tidig Asien';
  return `${WD[wd]} ${String(h).padStart(2, '0')}:00 UTC, ${s}${wd === 0 || wd === 6 ? ', helg (oftast tunnare volym)' : ''}`;
}

/* The chart as a trader reads it: everything relative, volume against its own normal. */
export function cleanChart(m, {rows = 40} = {}){
  const {history: H, dec, tfLabel, tfMs} = m, p = x => x.toFixed(dec);
  const last = H.at(-1), vAvg = i => { const w = H.slice(Math.max(0, i - 20), i); return w.reduce((s, b) => s + (b.v || 0), 0) / (w.length || 1); };
  const rng = b => pct(b.h, b.l);
  const ranges = H.slice(-50).map(rng).sort((a, b) => a - b), medRange = ranges[Math.floor(ranges.length / 2)];
  const L = [];
  L.push(`${m.symbol}USDT perpetual på Bybit, tidsram ${tfLabel}. Senaste stängda candle startade ${time(last.t)} UTC; nästa candle börjar ${m.from} UTC (${session(m.start)}). Senaste pris ${p(last.c)}.`);

  // Change over a few horizons and where the price sits in its ranges.
  const chg = k => H.length > k ? `${sgn(pct(last.c, H.at(-1 - k).c))} %` : '–';
  L.push(`Förändring: ${[5, 10, 20, 50, 100].filter(k => H.length > k).map(k => `${k} candles ${chg(k)}`).join(', ')}, hela historiken (${H.length} candles) ${sgn(pct(last.c, H[0].c))} %.`);
  for(const k of [20, 60, H.length]){
    const w = H.slice(-k), hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
    const iHi = w.findIndex(b => b.h === hi), iLo = w.findIndex(b => b.l === lo);
    L.push(`Senaste ${w.length} candles: högsta ${p(hi)} (${w.length - 1 - iHi} candles sedan), lägsta ${p(lo)} (${w.length - 1 - iLo} candles sedan); priset ligger ${(100 * (last.c - lo) / ((hi - lo) || 1)).toFixed(0)} % upp i spannet.`);
  }
  L.push(`Normal candlestorlek (median high–low senaste 50): ${medRange.toFixed(2)} % ≈ ${p(last.c * medRange / 100)}. Rörelse senaste 10 candles: summan av |Δ| ${H.slice(-10).reduce((s, b, i, a) => s + Math.abs(pct(b.c, i ? a[i - 1].c : H.at(-11).c)), 0).toFixed(2)} %.`);

  // Higher timeframe built from the same history.
  const htfMs = tfMs === 3600000 ? 4 * 3600000 : DAY, htfLabel = htfMs === DAY ? '1D' : '4h';
  const htf = merge(H, htfMs, tfMs).slice(-20);
  if(htf.length >= 3){
    L.push(`Högre tidsram ${htfLabel} (byggd ur samma historik, ${htf.length} hela candles; start UTC, close, Δ %, spann %):`);
    htf.forEach((b, i) => L.push(`${time(b.t)}  ${p(b.c)}  ${i ? sgn(pct(b.c, htf[i - 1].c)) : sgn(pct(b.c, b.o))}  ${rng(b).toFixed(2)}`));
  }

  // The recent candles, readable.
  const k = Math.min(rows, H.length - 1), from = H.length - k;
  L.push(`Senaste ${k} candles på ${tfLabel} (start UTC | open high low close | Δ close % | spann % | volym × snitt 20):`);
  for(let i = from; i < H.length; i++){
    const b = H[i], va = vAvg(i);
    L.push(`${time(b.t)} | ${p(b.o)} ${p(b.h)} ${p(b.l)} ${p(b.c)} | ${sgn(pct(b.c, H[i - 1].c))} | ${rng(b).toFixed(2)} | ${va ? ((b.v || 0) / va).toFixed(1) : '–'}`);
  }
  return L.join('\n');
}

export const CHECKLIST = [
  '1. Marknadsstruktur: högre toppar/bottnar, lägre, eller ett intervall? Var är senaste swing high och swing low?',
  '2. Trend på den här tidsramen och på den högre: samma håll eller emot varandra?',
  '3. Nyckelnivåer nära priset: stöd, motstånd, intervallets kanter, runda tal. Hur långt bort ligger de i procent?',
  '4. Volym: kom de senaste rörelserna på stigande eller fallande volym? Är det kapitulation, utbrott eller bara drift?',
  '5. De sista candlarna: veke-avvisningar, engulfing, inside bars, utmattning efter en lång rad åt samma håll?',
  '6. Momentum: byggs det upp eller klingar det av?',
  '7. Tid: vilken session och veckodag börjar nästa candle i, och vad brukar det betyda för volatiliteten i krypto?',
  '8. Scenario: vilket förlopp är mest sannolikt, och hur säker är du? Ett tydligt läge får en tydlig rörelse; ett oklart läge ritas som pendling nära priset med en svag lutning.'
].join('\n');

export const SYSTEM = [
  'Du är Pablo, en erfaren daytrader i kryptoperpetuals, inbyggd i Riptide: användarens privata hobbyapp med demokonton.',
  'Du läser en graf som en diskretionär trader och ritar ditt bästa förlopp för de kommande candlarna.',
  'Ritningen bedöms på hur nära stängningarna hamnar det som verkligen händer, så rita det mest sannolika förloppet — inte det mest spännande.',
  'Håll candlarnas storlek realistisk för tidsramen och följ svarsformatet exakt — appen ritar raderna direkt.'
].join(' ');

export function question(m, tail){
  return [
    `Grafen:\n${cleanChart(m)}`,
    `Läs grafen som en erfaren daytrader innan du ritar. Gå igenom checklistan:\n${CHECKLIST}`,
    `Rita sedan din bästa gissning på de ${m.n} kommande candlarna för ${m.symbol}USDT på ${m.tfLabel}, från senaste priset ${m.price}. Den första börjar ${m.from} UTC.`,
    tail
  ].join('\n\n');
}

export default {
  name: 'read-silent',
  description: 'Strukturerad grafläsning i huvudet: ren graf (procent, volym mot snitt, högre tidsram, nivåer), utan prognos och signalregel; appens svarsformat.',
  system: SYSTEM,
  prompt: m => question(m, [
    'Gör checklistan tyst i huvudet — skriv den inte. Svara exakt så här och inget annat:',
    'Rad 1: en kort mening på svenska om ditt scenario och varför (högst 200 tecken).',
    `Rad 2–${m.n + 1}: en candle per rad i tidsordning: open high low close, med punkt som decimaltecken och utan tusentalsavgränsare.`
  ].join('\n'))
};
