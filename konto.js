/**
 * Riptide — demokontot på serversidan.
 *
 * Samma motor som sidan (motor.js) körs här av workerns cron var femte minut:
 * staplar hämtas, setups byggs, A- och B-setups öppnas som positioner och de
 * stängs när stoppen eller målet nås. Kontot ligger i KV, så datorn och
 * telefonen ser samma siffror och räkningen fortsätter även när allt är stängt.
 */
import { INSTR, MOTORCFG, buildContext, generateSignals, assignStatus, LIVE, SEDD, GRADE_RANK, FAM_HANDLAS, handlasGrad } from './motor.js';

export const KONTO_NYCKEL = 'konto';
export const START_KAPITAL = 50000;
export const KONTRAKT = 0;                    // 0 = storleken räknas per affär ur MAX_RISK i motor.js
export const MARGINAL_PER_KONTRAKT = 100;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const INST = INSTR.NQ;
const PUNKTVARDE = INST.ptValue;

export function tomtKonto(){
  return {
    start: START_KAPITAL, kontrakt: KONTRAKT, kapital: START_KAPITAL,
    startad: Date.now(), uppdaterad: 0, pris: null,
    oppna: {}, affarer: [], live: {}, sedd: {}
  };
}

export async function lasKonto(env){
  try{
    const rå = await env.BARS.get(KONTO_NYCKEL);
    if(rå){
      const k = JSON.parse(rå);
      return Object.assign(tomtKonto(), k);
    }
  }catch(e){ /* trasig post — börja om */ }
  return tomtKonto();
}

export async function skrivKonto(env, k){
  k.affarer = k.affarer.slice(-300);
  await env.BARS.put(KONTO_NYCKEL, JSON.stringify(k));
}

/* ---------- staplar: feeden först, annars Yahoo ---------- */
function parseYahoo(j){
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if(!r || !r.timestamp) throw new Error('felaktigt chart-svar');
  const q = r.indicators.quote[0], ut = [];
  for(let i = 0; i < r.timestamp.length; i++){
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if(![o,h,l,c].every(v => typeof v === 'number' && isFinite(v))) continue;
    ut.push({ t: r.timestamp[i]*1000, o, h, l, c, v: q.volume[i] || 0 });
  }
  return ut;
}

export async function hamtaStaplar(env){
  let yahoo = [];
  try{
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(INST.yahoo) + '?interval=5m&range=5d&includePrePost=true',
      { headers: { 'user-agent': UA }, cf: { cacheTtl: 60 } });
    if(r.ok) yahoo = parseYahoo(await r.json());
  }catch(e){ /* faller tillbaka på feeden */ }

  let feed = [];
  try{ feed = JSON.parse((await env.BARS.get('NQ')) || '[]'); }catch(e){ feed = []; }

  if(!feed.length) return yahoo;
  const karta = new Map(yahoo.map(b => [b.t, b]));
  feed.forEach(b => {
    const t = +b.t, o = +b.o, h = +b.h, l = +b.l, c = +b.c;
    if([t,o,h,l,c].every(v => isFinite(v))) karta.set(t, { t, o, h, l, c, v: +b.v || 0 });
  });
  return [...karta.values()].sort((a,b) => a.t - b.t);
}

/* ---------- ett varv: öppna det som gått aktivt, stäng det som nått nivå ---------- */
export async function kontoTick(env, loggRad){
  const logg = loggRad || (() => {});
  const konto = await lasKonto(env);
  const bars = await hamtaStaplar(env);
  if(bars.length < 120){ logg('för få staplar (' + bars.length + ')'); return konto; }

  // motorns minne av vad som fyllts ligger i kontot mellan körningarna
  LIVE.clear(); SEDD.clear();
  Object.entries(konto.live || {}).forEach(([k,v]) => LIVE.set(k, v));
  Object.entries(konto.sedd || {}).forEach(([k,v]) => SEDD.set(k, v));

  const ctx = buildContext(INST, bars.slice(-420));
  const px = ctx.px;
  const sigs = assignStatus(
    generateSignals(ctx).sort((a,b) => (GRADE_RANK[a.grade]-GRADE_RANK[b.grade]) || (b.conf-a.conf)),
    { NQ: px }
  );

  // öppna
  sigs.forEach(s => {
    if(s.status !== 'ACTIVE') return;
    if(!handlasGrad(s.grade)) return;
    if(FAM_HANDLAS[s.fam] === false) return;               // mätt förlustbringande familj
    if(konto.oppna[s.id] || konto.affarer.some(a => a.id === s.id)) return;
    konto.oppna[s.id] = {
      id: s.id, inst: 'NQ', side: s.side, grade: s.grade, namn: s.name,
      entry: s.entryFyllt || s.entry, sl: s.sl, tp: s.tp, risk: s.risk,
      kontrakt: s.kontrakt || konto.kontrakt || 1, oppnad: s.oppnad || Date.now(),
      kollad: bars[bars.length - 1].t,
      nyckel: s.nyckel, stangVid: s.stangVid || null,
      marginal: (s.kontrakt || konto.kontrakt || 1)*MARGINAL_PER_KONTRAKT
    };
    logg('öppnar ' + s.grade + ' ' + s.side + ' @ ' + s.entry.toFixed(2));
  });

  // stäng
  Object.keys(konto.oppna).forEach(id => {
    const pos = konto.oppna[id];
    const dir = pos.side === 'long' ? 1 : -1;
    const nya = bars.filter(b => b.t > (pos.kollad || pos.oppnad));
    pos.kollad = bars[bars.length - 1].t;

    let exit = null, hur = null, nar = Date.now();
    for(const b of nya){
      if(dir > 0 ? b.l <= pos.sl : b.h >= pos.sl){ exit = pos.sl; hur = 'stopp'; nar = b.t; break; }
      if(dir > 0 ? b.h >= pos.tp : b.l <= pos.tp){ exit = pos.tp; hur = 'mål';   nar = b.t; break; }
    }
    if(exit === null){
      if(dir > 0 ? px <= pos.sl : px >= pos.sl){ exit = pos.sl; hur = 'stopp'; }
      else if(dir > 0 ? px >= pos.tp : px <= pos.tp){ exit = pos.tp; hur = 'mål'; }
    }
    if(exit === null && pos.stangVid && Date.now() >= pos.stangVid){ exit = px; hur = 'tid'; }   // dagens slut
    if(exit === null) return;

    const punkter = dir*(exit - pos.entry);
    const dollar = punkter*pos.kontrakt*PUNKTVARDE;
    konto.kapital += dollar;
    konto.affarer.push({
      id: pos.id, inst: 'NQ', side: pos.side, grade: pos.grade, namn: pos.namn,
      entry: pos.entry, exit, hur, punkter, dollar, kontrakt: pos.kontrakt,
      oppnad: pos.oppnad, stangd: nar,
      R: pos.risk ? punkter/pos.risk : null,
      kapitalEfter: konto.kapital
    });
    delete konto.oppna[id];
    logg('stänger ' + pos.grade + ' ' + pos.side + ' på ' + hur + ' · ' + Math.round(dollar) + ' $');
  });

  // minnet tillbaka till kontot, beskuret så det inte växer i evighet
  const live = {}, sedd = {};
  const oppnaIdn = new Set(Object.keys(konto.oppna));
  LIVE.forEach((v, k) => {
    if(oppnaIdn.has(k) || (v.slutAt && Date.now() - v.slutAt < 86400000) || (!v.slutAt && v.at && Date.now() - v.at < 86400000)){
      live[k] = v;
    }
  });
  SEDD.forEach((v, k) => { if(Object.keys(sedd).length < 400) sedd[k] = v; });
  konto.live = live;
  konto.sedd = sedd;
  konto.pris = px;
  konto.uppdaterad = Date.now();
  konto.setups = sigs.slice(0, 6).map(s => ({
    grade: s.grade, side: s.side, status: s.status, entry: s.entry, sl: s.sl, tp: s.tp,
    conf: s.conf, rr: s.rr, namn: s.name, fam: s.fam, backN: s.backN
  }));

  await skrivKonto(env, konto);
  return konto;
}

/* ---------- vad sidan får se ---------- */
export function kontoUtsida(konto){
  const orealiserat = Object.values(konto.oppna || {}).reduce((sum, p) => {
    if(!konto.pris) return sum;
    const dir = p.side === 'long' ? 1 : -1;
    return sum + dir*(konto.pris - p.entry)*p.kontrakt*PUNKTVARDE;
  }, 0);
  return {
    start: konto.start, kontrakt: konto.kontrakt, punktVarde: PUNKTVARDE,
    marginalPerKontrakt: MARGINAL_PER_KONTRAKT,
    kapital: konto.kapital, orealiserat, eget: konto.kapital + orealiserat,
    startad: konto.startad, uppdaterad: konto.uppdaterad, pris: konto.pris,
    oppna: konto.oppna, affarer: (konto.affarer || []).slice(-120),
    antalAffarer: (konto.affarer || []).length,
    setups: konto.setups || []
  };
}
