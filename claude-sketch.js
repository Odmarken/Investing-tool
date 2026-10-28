/* Claude ritar: en gissning på de kommande candlarna i AI Forecast-grafen.
   Frågan går till Claude Code i desktop-appen (window.riptideDesktop.claude.sketch)
   — en snabb fråga utan verktyg och utan minne — med grafens underlag. Svaret är
   en mening och sedan en candle per rad; candlarna läses medan svaret strömmar in,
   så grafen kan rita dem en i taget.

   Strategin kommer ur simuleringen i research/pablo-rita-sim.mjs (okt 2026). Pablo
   får en ren graf utan appens prognos och signalregel och läser den som en daytrader
   — det slog den gamla frågan. Dessutom studsläget: efter ett kraftigt ras mitt i en
   stark nedtrend ritar han en studs uppåt. Den regeln stämde 77 % av gångerna på 31
   ras i jul–sep 2026, men bara 57 % på 957 ras 2022–2025.

   bounceSignal(bars) → {on, r3, trend, atr} — studsläget på de stängda candlarna
   ritaPrompt({bars, symbol, tf, tfMs, n, price, dec, from, start, question}) → frågan till Claude
   createSketchReader({base, start, tfMs, n}) → {feed(text), end(), candles, note}
   sketchGuess(candles, base) → {side: 'long'|'kort'|'platt', pct, text} | null — Pablos gissning ur ritningen
   connectSketch(api) → run(prompt, onDelta) → {done: Promise<text>, cancel()} | null utan appen */

export const BOUNCE = Object.freeze({ drop3: -1.25, trend: -1.34, target: 0.3, hit: '77 % av 31 ras jul–sep 2026, 57 % av 957 ras 2022–2025' });
const DAY = 86400000;
const WD = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];
const time = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const pct = (a, b) => (a / b - 1) * 100;
const sgn = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

/* Studsläget: de tre senaste candlarna föll mer än 1,25 ATR(14) och EMA20 ligger mer än 1,34 ATR under EMA50.
   EMA:erna räknas från första candlen, så ge hela historiken (minst ett par hundra candles). */
export function bounceSignal(bars){
  const c = (bars || []).map(b => b.c), i = c.length - 1;
  if(i < 60) return { on: false, r3: NaN, trend: NaN, atr: NaN };
  const ema = k => { const a = 2 / (k + 1); let e = c[0]; for(let j = 1; j <= i; j++) e += a * (c[j] - e); return e; };
  let tr = 0;
  for(let j = i - 13; j <= i; j++){ const b = bars[j], p = bars[j - 1].c; tr += Math.max(b.h - b.l, Math.abs(b.h - p), Math.abs(b.l - p)); }
  const atr = tr / 14;
  if(!(atr > 0)) return { on: false, r3: NaN, trend: NaN, atr };
  const r3 = (c[i] - c[i - 3]) / atr, trend = (ema(20) - ema(50)) / atr;
  return { on: r3 < BOUNCE.drop3 && trend < BOUNCE.trend, r3, trend, atr };
}

/* Candlarna sammanslagna till en högre tidsram i UTC (4h eller 1 dag); bara hela grupper. */
function merge(bars, ms, tfMs){
  const per = ms / tfMs, out = [];
  let cur = null;
  for(const b of bars){
    const t = Math.floor(b.t / ms) * ms;
    if(!cur || cur.t !== t){ if(cur) out.push(cur); cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, k: 0 }; }
    else{ cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; }
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

/* Grafen som en trader läser den: allt relativt, volymen mot sitt eget snitt. H: de senaste stängda candlarna. */
function cleanChart({ H, symbol, tf, tfMs, dec, from, start }, rows = 40){
  const p = x => x.toFixed(dec), last = H.at(-1);
  const vAvg = i => { const w = H.slice(Math.max(0, i - 20), i); return w.reduce((s, b) => s + (b.v || 0), 0) / (w.length || 1); };
  const rng = b => pct(b.h, b.l);
  const ranges = H.slice(-50).map(rng).sort((a, b) => a - b), medRange = ranges[Math.floor(ranges.length / 2)];
  const L = [];
  L.push(`${symbol}USDT perpetual på Bybit, tidsram ${tf}. Senaste stängda candle startade ${time(last.t)} UTC; nästa candle att rita börjar ${from} UTC (${session(start)}). Senaste pris ${p(last.c)}.`);
  const chg = k => H.length > k ? `${sgn(pct(last.c, H.at(-1 - k).c))} %` : '–';
  L.push(`Förändring: ${[5, 10, 20, 50, 100].filter(k => H.length > k).map(k => `${k} candles ${chg(k)}`).join(', ')}, hela historiken (${H.length} candles) ${sgn(pct(last.c, H[0].c))} %.`);
  for(const k of [20, 60, H.length]){
    const w = H.slice(-k), hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
    const iHi = w.findIndex(b => b.h === hi), iLo = w.findIndex(b => b.l === lo);
    L.push(`Senaste ${w.length} candles: högsta ${p(hi)} (${w.length - 1 - iHi} candles sedan), lägsta ${p(lo)} (${w.length - 1 - iLo} candles sedan); priset ligger ${(100 * (last.c - lo) / ((hi - lo) || 1)).toFixed(0)} % upp i spannet.`);
  }
  L.push(`Normal candlestorlek (median high–low senaste 50): ${medRange.toFixed(2)} % ≈ ${p(last.c * medRange / 100)}. Rörelse senaste 10 candles: summan av |Δ| ${H.slice(-10).reduce((s, b, i, a) => s + Math.abs(pct(b.c, i ? a[i - 1].c : H.at(-11).c)), 0).toFixed(2)} %.`);
  const htfMs = tfMs < 3600000 ? 3600000 : tfMs === 3600000 ? 4 * 3600000 : tfMs < DAY ? DAY : 7 * DAY;
  const htfLabel = htfMs === 3600000 ? '1h' : htfMs === 4 * 3600000 ? '4h' : htfMs === DAY ? '1D' : '1W';
  const htf = merge(H, htfMs, tfMs).slice(-20);
  if(htf.length >= 3){
    L.push(`Högre tidsram ${htfLabel} (byggd ur samma historik, ${htf.length} hela candles; start UTC, close, Δ %, spann %):`);
    htf.forEach((b, i) => L.push(`${time(b.t)}  ${p(b.c)}  ${i ? sgn(pct(b.c, htf[i - 1].c)) : sgn(pct(b.c, b.o))}  ${rng(b).toFixed(2)}`));
  }
  const k = Math.min(rows, H.length - 1), first = H.length - k;
  L.push(`Senaste ${k} candles på ${tf} (start UTC | open high low close | Δ close % | spann % | volym × snitt 20):`);
  for(let i = first; i < H.length; i++){
    const b = H[i], va = vAvg(i);
    L.push(`${time(b.t)} | ${p(b.o)} ${p(b.h)} ${p(b.l)} ${p(b.c)} | ${sgn(pct(b.c, H[i - 1].c))} | ${rng(b).toFixed(2)} | ${va ? ((b.v || 0) / va).toFixed(1) : '–'}`);
  }
  return L.join('\n');
}

const CHECKLIST = [
  '1. Marknadsstruktur: högre toppar/bottnar, lägre, eller ett intervall? Var är senaste swing high och swing low?',
  '2. Trend på den här tidsramen och på den högre: samma håll eller emot varandra?',
  '3. Nyckelnivåer nära priset: stöd, motstånd, intervallets kanter, runda tal. Hur långt bort ligger de i procent?',
  '4. Volym: kom de senaste rörelserna på stigande eller fallande volym? Är det kapitulation, utbrott eller bara drift?',
  '5. De sista candlarna: veke-avvisningar, engulfing, inside bars, utmattning efter en lång rad åt samma håll?',
  '6. Momentum: byggs det upp eller klingar det av?',
  '7. Tid: vilken session och veckodag börjar nästa candle i, och vad brukar det betyda för volatiliteten i krypto?',
  '8. Scenario: vilket förlopp är mest sannolikt, och hur säker är du? Ett tydligt läge får en tydlig rörelse; ett oklart läge ritas som pendling nära priset med en svag lutning.'
].join('\n');

/* Ritas fråga. bars: grafens stängda candles, äldst först (hela historiken, för studslägets EMA:er).
   price: priset ritningen börjar från (den pågående candlen); start/from: första ritade candlens start. */
export function ritaPrompt({ bars = [], symbol = '', tf = '', tfMs = 3600000, n = 10, price = null, dec = 2, from = '', start = 0, question = '' } = {}){
  const H = bars.slice(-300), ask = String(question || '').trim(), sig = bounceSignal(bars);
  const p = x => x.toFixed(dec);
  const parts = [
    `Grafen:\n${cleanChart({ H, symbol, tf, tfMs, dec, from, start })}`,
    `Läs grafen som en erfaren daytrader innan du ritar. Gå igenom checklistan:\n${CHECKLIST}`
  ];
  if(sig.on){
    const base = Number.isFinite(price) ? price : H.at(-1).c, target = base + BOUNCE.target * sig.atr;
    parts.push([
      `STUDSLÄGE: de tre senaste candlarna föll ${(-sig.r3).toFixed(2)} ATR och EMA20 ligger ${(-sig.trend).toFixed(2)} ATR under EMA50 — ett kraftigt ras mitt i en stark nedtrend.`,
      `Efter just det läget har priset studsat upp över de kommande ${n} candlarna i ${BOUNCE.hit}. Den typiska studsen är liten: median +${BOUNCE.target} ATR vid den ${n}:e candlen, med stor spridning.`,
      `Rita därför en studs uppåt: gärna ett sista test nedåt i början, sedan uppåt, och låt den ${n}:e stängningen hamna runt ${p(target)} (ATR ${p(sig.atr)}), i alla fall över ${p(base)}. Börja rad 1 med "Studsläge:".`
    ].join('\n'));
  }
  parts.push(`Rita sedan din bästa gissning på de ${n} kommande candlarna för ${symbol}USDT på ${tf}` +
    (Number.isFinite(price) ? `, från senaste priset ${p(price)}` : '') + `. Den första börjar ${from} UTC.`);
  if(ask) parts.push(`Användarens fråga: ${ask}`);
  parts.push([
    'Gör checklistan tyst i huvudet — skriv den inte. Svara exakt så här och inget annat:',
    'Rad 1: en kort mening på svenska om ditt scenario och varför (högst 200 tecken).',
    `Rad 2–${n + 1}: en candle per rad i tidsordning: open high low close, med punkt som decimaltecken och utan tusentalsavgränsare.`
  ].join('\n'));
  return parts.join('\n\n');
}

const NUM = /[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

/* Läser svaret rad för rad. En rad med minst fyra tal är en candle (de fyra sista: ett radnummer först gör inget);
   text före första candlen är meningen. Varje candle öppnar där den förra stängde (den första på base), high och
   low täcker open och close (även om de kom i fel ordning), och en candle mer än 50 % från base hoppas över. */
export function createSketchReader({ base, start, tfMs, n = 10 }){
  let buf = '', note = '';
  const candles = [];
  function line(raw){
    const text = raw.replace(/[`*]/g, '').trim();
    if(!text || candles.length >= n) return;
    const nums = (text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(NUM) || []).map(Number);
    if(nums.length >= 4 && /^[\s\d.,:;)(+\-#|e]*$/i.test(text.replace(/^(?:candle|rad)\s*/i, ''))){
      const [, h, l, c] = nums.slice(-4);
      const o = candles.length ? candles.at(-1).c : base;
      if(![h, l, c].every(x => x > base * .5 && x < base * 1.5)) return;
      candles.push({ t: start + candles.length * tfMs, o, h: Math.max(h, l, o, c), l: Math.min(h, l, o, c), c });
    }else if(!candles.length) note = (note ? note + ' ' : '') + text.replace(/^rad\s*1\s*[:.]\s*/i, '');
  }
  return {
    feed(text){
      buf += text;
      let i;
      while((i = buf.indexOf('\n')) >= 0){ line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    end(){ if(buf){ line(buf); buf = ''; } },
    candles,
    get note(){ return note.slice(0, 300); }
  };
}

/* Pablos gissning ur ritningen: long när sista ritade stängningen ligger över priset han utgick från, kort när den
   ligger under, platt när den är samma. pct är rörelsen i procent och text det som visas, t.ex. "Long ▲ +0,42 %". */
export function sketchGuess(candles, base){
  const last = candles?.at?.(-1)?.c;
  if(!(base > 0) || !Number.isFinite(last)) return null;
  const move = pct(last, base), side = move > 0 ? 'long' : move < 0 ? 'kort' : 'platt';
  const size = (move > 0 ? '+' : move < 0 ? '−' : '') + Math.abs(move).toFixed(2).replace('.', ',') + ' %';
  return { side, pct: move, text: { long: 'Long ▲ ', kort: 'Kort ▼ ', platt: 'Platt ▬ ' }[side] + size };
}

let seq = 0;
export function connectSketch(api = globalThis.riptideDesktop?.claude){
  if(typeof api?.sketch !== 'function') return null;
  return (prompt, onDelta) => {
    const id = 'sketch-' + Date.now().toString(36) + '-' + (++seq);
    const off = api.onEvent?.(ev => { if(ev?.id === id && ev.delta) onDelta(ev.delta); });
    const done = Promise.resolve(api.sketch({ id, prompt })).then(r => r?.text ?? '').finally(() => off?.());
    return { done, cancel: () => { void api.cancel?.(id); } };
  };
}
