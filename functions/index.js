/**
 * Riptide — serverdelen på Firebase.
 *
 *  kontoCron   var femte minut: hämtar staplar, bygger setups, öppnar A- och
 *              B-affärer och stänger dem som nått stopp eller mål. Skriver till
 *              Firestore, så sidan uppdateras direkt på alla enheter.
 *  api         HTTP: /proxy (marknadsdata åt sidan), /ingest (TradingView),
 *              /tick (kör ett varv på studs), /konto (läsning utan Firestore).
 *
 * Signalmotorn är samma fil som sidan använder — motor.js kopieras hit vid
 * utrullning av kopiera-motor.js, så molnet och skärmen räknar aldrig olika.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import {
  INSTR, buildContext, generateSignals, assignStatus, LIVE, SEDD, GRADE_RANK
} from './motor.js';

initializeApp();
const db = getFirestore();
const REGION = 'europe-north1';        // api: närmast Sverige
const CRON_REGION = 'europe-west1';    // Cloud Scheduler finns inte i europe-north1
const FEED_KEY = defineSecret('FEED_KEY');

const KONTO_DOK = () => db.doc('riptide/konto');
const FEED_DOK  = () => db.doc('riptide/feed');

const START_KAPITAL = 50000;
const KONTRAKT = 5;
const MARGINAL_PER_KONTRAKT = 100;
const INST = INSTR.NQ;
const PUNKTVARDE = INST.ptValue;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/* Proxyn är öppen för alla som hittar adressen — bara marknads- och nyhetskällor. */
const PROXY_VARDAR = [
  'finance.yahoo.com', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
  'news.google.com', 'investing.com', 'financialjuice.com', 'fxstreet.com',
  'cnbc.com', 'dowjones.io', 'marketwatch.com', 'reuters.com', 'kitco.com',
  'di.se', 'dn.se', 'svt.se', 'omni.se', 'placera.se',
  'economic-calendar.tradingview.com'
];

/* Några källor kräver att anropet ser ut att komma från deras egen sida. */
const EXTRA_HUVUDEN = {
  'economic-calendar.tradingview.com': {
    origin: 'https://www.tradingview.com',
    referer: 'https://www.tradingview.com/economic-calendar/'
  }
};

const proxyOK = host => PROXY_VARDAR.some(v => host === v || host.endsWith('.' + v));

export function tomtKonto(){
  return {
    start: START_KAPITAL, kontrakt: KONTRAKT, punktVarde: PUNKTVARDE,
    marginalPerKontrakt: MARGINAL_PER_KONTRAKT,
    kapital: START_KAPITAL, startad: Date.now(), uppdaterad: 0, pris: null,
    oppna: {}, affarer: [], live: {}, sedd: {}, setups: []
  };
}

async function lasKonto(){
  const snap = await KONTO_DOK().get();
  return snap.exists ? Object.assign(tomtKonto(), snap.data()) : tomtKonto();
}

async function skrivKonto(konto){
  konto.affarer = (konto.affarer || []).slice(-300);
  await KONTO_DOK().set(konto);
}

/* ---------- staplar: TradingView-feeden först, annars Yahoo ---------- */
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

async function hamtaStaplar(){
  let yahoo = [];
  try{
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(INST.yahoo) + '?interval=5m&range=5d&includePrePost=true',
      { headers: { 'user-agent': UA } });
    if(r.ok) yahoo = parseYahoo(await r.json());
  }catch(e){ /* faller tillbaka på feeden */ }

  let feed = [];
  try{
    const snap = await FEED_DOK().get();
    feed = (snap.exists && snap.data().NQ) || [];
  }catch(e){ feed = []; }

  if(!feed.length) return yahoo;
  const karta = new Map(yahoo.map(b => [b.t, b]));
  feed.forEach(b => {
    const t = +b.t, o = +b.o, h = +b.h, l = +b.l, c = +b.c;
    if([t,o,h,l,c].every(v => isFinite(v))) karta.set(t, { t, o, h, l, c, v: +b.v || 0 });
  });
  return [...karta.values()].sort((a,b) => a.t - b.t);
}

/* ---------- ett varv på kontot ---------- */
export async function kontoVarv(logg = () => {}){
  const konto = await lasKonto();
  const bars = await hamtaStaplar();
  if(bars.length < 120){ logg('för få staplar: ' + bars.length); return konto; }

  LIVE.clear(); SEDD.clear();
  Object.entries(konto.live || {}).forEach(([k,v]) => LIVE.set(k, v));
  Object.entries(konto.sedd || {}).forEach(([k,v]) => SEDD.set(k, v));

  const ctx = buildContext(INST, bars.slice(-420));
  const px = ctx.px;
  const sigs = assignStatus(
    generateSignals(ctx).sort((a,b) => (GRADE_RANK[a.grade]-GRADE_RANK[b.grade]) || (b.conf-a.conf)),
    { NQ: px }
  );

  sigs.forEach(s => {
    if(s.status !== 'ACTIVE') return;
    if(s.grade !== 'A' && s.grade !== 'B') return;
    if(konto.oppna[s.id] || konto.affarer.some(a => a.id === s.id)) return;
    konto.oppna[s.id] = {
      id: s.id, side: s.side, grade: s.grade, namn: s.name,
      entry: s.entryFyllt || s.entry, sl: s.sl, tp: s.tp, risk: s.risk,
      kontrakt: konto.kontrakt, oppnad: s.oppnad || Date.now(),
      kollad: bars[bars.length - 1].t,
      marginal: konto.kontrakt*MARGINAL_PER_KONTRAKT
    };
    logg('öppnar ' + s.grade + ' ' + s.side + ' @ ' + s.entry.toFixed(2));
  });

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
    if(exit === null) return;

    const punkter = dir*(exit - pos.entry);
    const dollar = punkter*pos.kontrakt*PUNKTVARDE;
    konto.kapital += dollar;
    konto.affarer.push({
      id: pos.id, inst: 'NQ', side: pos.side, grade: pos.grade, namn: pos.namn,
      entry: pos.entry, exit, hur, punkter, dollar, kontrakt: pos.kontrakt,
      oppnad: pos.oppnad, stangd: nar, R: pos.risk ? punkter/pos.risk : null,
      kapitalEfter: konto.kapital
    });
    delete konto.oppna[id];
    logg('stänger ' + pos.grade + ' på ' + hur + ' · ' + Math.round(dollar) + ' $');
  });

  const live = {}, sedd = {};
  const oppnaIdn = new Set(Object.keys(konto.oppna));
  const dygn = 86400000;
  LIVE.forEach((v, k) => {
    const fardig = v.slutAt && Date.now() - v.slutAt > dygn;
    const gammal = !v.slutAt && v.at && Date.now() - v.at > dygn;
    if(oppnaIdn.has(k) || (!fardig && !gammal)) live[k] = v;
  });
  let n = 0;
  SEDD.forEach((v, k) => { if(n++ < 400) sedd[k] = v; });

  konto.live = live;
  konto.sedd = sedd;
  konto.pris = px;
  konto.uppdaterad = Date.now();
  konto.orealiserat = Object.values(konto.oppna).reduce((sum, p) => {
    const dir = p.side === 'long' ? 1 : -1;
    return sum + dir*(px - p.entry)*p.kontrakt*PUNKTVARDE;
  }, 0);
  konto.setups = sigs.slice(0, 6).map(s => ({
    grade: s.grade, side: s.side, status: s.status, entry: s.entry, sl: s.sl, tp: s.tp,
    conf: s.conf, rr: s.rr, namn: s.name, fam: s.fam, backN: s.backN
  }));

  await skrivKonto(konto);
  return konto;
}

/* ---------- cron ---------- */
export const kontoCron = onSchedule(
  { schedule: 'every 5 minutes', region: CRON_REGION, timeZone: 'Europe/Stockholm', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const rader = [];
    await kontoVarv(r => rader.push(r));
    if(rader.length) console.log('konto: ' + rader.join(' | '));
  }
);

/* ---------- HTTP ---------- */
const cors = res => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Cache-Control', 'no-store');
};

export const api = onRequest(
  { region: REGION, secrets: [FEED_KEY], timeoutSeconds: 120, memory: '256MiB', cors: true },
  async (req, res) => {
    cors(res);
    if(req.method === 'OPTIONS'){ res.status(204).end(); return; }

    const vag = (req.path || '/').replace(/^\/api/, '') || '/';
    const nyckel = FEED_KEY.value();

    /* marknadsdata åt sidan */
    if(vag === '/proxy'){
      let u = null;
      try{ u = new URL(req.query.url); }catch{ u = null; }
      if(!u || !/^https?:$/.test(u.protocol)){ res.status(400).json({ error: 'ange ?url=https://...' }); return; }
      if(!proxyOK(u.hostname)){ res.status(403).json({ error: 'värden är inte tillåten här', host: u.hostname }); return; }
      try{
        const r = await fetch(u, { redirect: 'follow',
          headers: Object.assign({ 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9,sv;q=0.8' },
                                 EXTRA_HUVUDEN[u.hostname] || {}) });
        const txt = await r.text();
        res.status(r.status);
        res.set('Content-Type', r.headers.get('content-type') || 'text/plain; charset=utf-8');
        res.send(txt);
      }catch(e){ res.status(502).json({ error: 'kunde inte hämta', detalj: String(e.message || e) }); }
      return;
    }

    /* TradingView-alert */
    if(vag === '/ingest' && req.method === 'POST'){
      let b = req.body;
      if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch{ b = {}; } }
      b = b || {};
      if(!nyckel || b.k !== nyckel){ res.status(401).json({ error: 'fel nyckel' }); return; }
      const num = v => { const n2 = Number(v); return isFinite(n2) ? n2 : null; };
      let t = num(b.t);
      if(t === null){ res.status(400).json({ error: 'saknar tid' }); return; }
      if(t < 1e12) t *= 1000;
      t = Math.floor(t/300000)*300000;
      const stapel = { t, o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: num(b.v) || 0 };
      if([stapel.o, stapel.h, stapel.l, stapel.c].some(v => v === null)){
        res.status(400).json({ error: 'ofullständig stapel' }); return;
      }
      const snap = await FEED_DOK().get();
      const nu = (snap.exists && snap.data().NQ) || [];
      const ix = nu.findIndex(x => x.t === t);
      if(ix >= 0) nu[ix] = stapel; else nu.push(stapel);
      nu.sort((a,b2) => a.t - b2.t);
      await FEED_DOK().set({ NQ: nu.slice(-400), uppdaterad: FieldValue.serverTimestamp() }, { merge: true });
      res.json({ ok: true, staplar: Math.min(nu.length, 400), t });
      return;
    }

    /* ett varv på studs */
    if(vag === '/tick'){
      if(!nyckel || req.query.k !== nyckel){ res.status(401).json({ error: 'fel nyckel' }); return; }
      const rader = [];
      const konto = await kontoVarv(r => rader.push(r));
      res.json({ ok: true, handelser: rader, kapital: konto.kapital, pris: konto.pris,
                 oppna: Object.keys(konto.oppna).length, affarer: konto.affarer.length });
      return;
    }

    /* läsning utan Firestore-klient */
    if(vag === '/konto'){
      const k = await lasKonto();
      delete k.live; delete k.sedd;
      res.json(k);
      return;
    }

    res.json({ tjanst: 'riptide', vagar: ['/api/proxy?url=…', '/api/ingest (POST)', '/api/tick?k=…', '/api/konto'] });
  }
);
