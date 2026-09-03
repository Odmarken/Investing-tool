/**
 * Riptide — serverdelen på Firebase.
 *
 *  kontoCron   var femte minut: hämtar staplar, bygger setups, öppnar A- och
 *              B-affärer och stänger dem som nått stopp eller mål. Skriver till
 *              Firestore, så sidan uppdateras direkt på alla enheter.
 *  api         HTTP: /proxy (marknadsdata åt sidan), /ingest (TradingView),
 *              /bars (staplarna därifrån), /tick (kör ett varv på studs),
 *              /konto (läsning utan Firestore).
 *
 * Signalmotorn är samma fil som sidan använder — motor.js kopieras hit vid
 * utrullning av kopiera-motor.js, så molnet och skärmen räknar aldrig olika.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

import {
  INSTR, buildContext, generateSignals, assignStatus, LIVE, SEDD, GRADE_RANK, FAM_HANDLAS,
  computeNewsBias, biasLage
} from './motor.js';

initializeApp();
const db = getFirestore();
const REGION = 'europe-north1';        // api: närmast Sverige
const CRON_REGION = 'europe-west1';    // Cloud Scheduler finns inte i europe-north1
const FEED_KEY = defineSecret('FEED_KEY');

const KONTO_DOK = () => db.doc('riptide/konto');
const FEED_DOK  = () => db.doc('riptide/feed');
const LIVE_DOK  = () => db.doc('riptide/live');     // den pågående stapeln, ett par hundra byte

const START_KAPITAL = 50000;
const KONTRAKT = 0;                    // 0 = storleken räknas per affär ur MAX_RISK
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

/* Nyhetsbias. Skärmen visar den och den avgör vilket håll signaler ges åt, så
   kontot måste räkna samma sak — annars skulle molnet kunna öppna en affär åt
   ett håll som panelen inte ens visar. Google News räcker: reglerna i motorn
   läser rubriker, och rubriker är vad ett RSS-flöde ger. */
/* Samma två breda Google-flöden som panelen läser. En smalare sökning —
   "nvidia", "inflation" — väljer sina egna rubriker och gav +71 av 100 när de
   breda gav +13. Frågan måste vara neutral, annars mäter man sin egen sökning. */
const NYHETS_URLAR = [
  'https://news.google.com/rss/search?q=(futures+OR+%22stock+market%22+OR+Fed)+when:1d&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=(Nasdaq+OR+%22Nasdaq+100%22+OR+gold+OR+XAUUSD+OR+Fed)+when:1d&hl=en-US&gl=US&ceid=US:en'
];
let biasCache = null;

function rssPoster(xml){
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const bit = m[1];
    const rubrik = ((bit.match(/<title>([\s\S]*?)<\/title>/) || [,''])[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').trim();
    const nar = (bit.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [,''])[1];
    return { title: rubrik, desc: '', ts: Date.parse(nar) || Date.now() };
  }).filter(x => x.title);
}

async function nyhetsbias(){
  if(biasCache && Date.now() - biasCache.nar < 4*60000) return biasCache.varde;
  let varde = { poang: 0, n: 0, nar: Date.now() };
  try{
    const svar = await Promise.all(NYHETS_URLAR.map(u =>
      fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(9000) })
        .then(r => r.ok ? r.text() : '')
        .catch(() => '')));
    const sedda = new Set();
    const poster = svar.flatMap(rssPoster)
      .filter(x => { if(sedda.has(x.title)) return false; sedda.add(x.title); return true; })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 45);
    if(poster.length){
      const b = computeNewsBias(poster);
      varde = { poang: Math.round(b.nq*10)/10, n: poster.length, nar: Date.now() };
    }
  }catch(e){ /* utan nyheter blir biasen neutral, och då spärras ingenting */ }
  biasCache = { nar: Date.now(), varde };
  return varde;
}

/* Hämtas en gång och ligger kvar så länge instansen lever. */
const INIT_URL = 'https://riptide-investing-tool.web.app/__/firebase/init.json';
let konfigCache = null;
async function webbkonfig(){
  if(konfigCache && Date.now() - konfigCache.nar < 6*3600e3) return konfigCache.data;
  const r = await fetch(INIT_URL);
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  konfigCache = { nar: Date.now(), data };
  return data;
}

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
  /* Biasen läggs i live-dokumentet, som är öppet för läsning — då kan panelen
     filtrera på exakt samma siffra som kontot handlar på, utan inloggning. */
  try{
    await LIVE_DOK().set({ bias: konto.nyhetsbias }, { merge: true });
  }catch(e){ /* biasen är en bonus, inte ett krav */ }
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

  let live = null;
  try{
    const lsnap = await LIVE_DOK().get();
    live = lsnap.exists ? lsnap.data().NQ : null;
  }catch(e){ live = null; }
  if(live && isFinite(live.t)) feed = feed.concat([live]);   // pågående facket räknas med
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

  const ctx = buildContext(INST, bars.slice(-1100));   // fyra dygn: brusbandet behöver färdiga sessioner
  const nb = await nyhetsbias();
  const lage = biasLage(nb.poang);
  ctx.newsBias = nb.poang;
  ctx.biasRiktning = lage.riktning;          // samma spärr som panelen visar
  const px = ctx.px;
  const sigs = assignStatus(
    generateSignals(ctx).sort((a,b) => (GRADE_RANK[a.grade]-GRADE_RANK[b.grade]) || (b.conf-a.conf)),
    { NQ: px }
  );

  /* Kallstart: ett nyss nollställt konto har inget minne av vilka setups som
     redan är igång, och eftersom ACTIVE kräver att motorn *sett* fyllningen ske
     skulle kontot stå tomt tills nästa gång priset råkar nudda en entrynivå —
     ibland timmar. Har kontot varken affärer, positioner eller minne adopteras
     därför de setups som är igång just nu: priset ligger på fyllningssidan och
     högst en ATR förbi nivån, alltså en affär som faktiskt löper. Längre bort
     än så har tåget gått, och den lämnas. */
  /* Bara pågående poster som motorn fortfarande känns vid räknas som minne.

     En avslutad affär ligger kvar en stund i LIVE. Efter en motorändring kan
     där dessutom ligga föräldralösa poster: id:t följer entrynivån, så en
     ombyggd familj ger nya id:n och den gamla posten hör inte ihop med någon
     signal längre. assignStatus sveper en sådan post efter mål och stopp men
     lägger aldrig tillbaka den i listan, så kontot kan varken öppna eller
     stänga den — och ändå räckte den förut för att slå av kallstarten. Ett
     nyss nollställt konto stod då stilla i upp till ett dygn, tills posten
     åldrades bort av gallringen längre ned. */
  const iListan = new Set(sigs.map(s => s.nyckel));
  const pagaende = [...LIVE.entries()].filter(([, st]) => st && st.sig && !st.hitTp && !st.hitSl);
  const nagotIgang = pagaende.some(([id]) => iListan.has(id));
  const foraldralosa = pagaende.length - pagaende.filter(([id]) => iListan.has(id)).length;
  const kallstart = !konto.affarer.length && !Object.keys(konto.oppna).length && !nagotIgang;
  if(kallstart && foraldralosa) logg('bortser från ' + foraldralosa + ' föräldralös post utan signal');
  if(kallstart){
    sigs.forEach(s => {
      if(s.status === 'ACTIVE' || s.grade === 'C') return;
      if(FAM_HANDLAS[s.fam] === false) return;
      const dir = s.side === 'long' ? 1 : -1;
      const fylld = s.reachSign*(px - s.entry) >= 0;
      if(!fylld || Math.abs(px - s.entry) > s.atr) return;
      if(dir*(px - s.sl) <= 0 || dir*(px - s.tp) >= 0) return;   // redan förbi stopp eller mål
      const at = Date.now();
      const handelsId = s.nyckel + '@' + at;
      const frusen = Object.assign({}, s, { id: handelsId, oppnad: at, entryFyllt: s.entry });
      delete frusen.bars;                                   // 84 kB staplar hör inte hemma i Firestore
      LIVE.set(s.nyckel, { triggered:true, at, handelsId, entryPx: s.entry, sig: frusen });
      s.id = handelsId;
      s.status = 'ACTIVE'; s.statusTxt = 'ACTIVE';
      s.oppnad = at; s.entryFyllt = s.entry;
      logg('adopterar pågående ' + s.grade + ' ' + s.fam + ' ' + s.side);
    });
  }

  sigs.forEach(s => {
    if(s.status !== 'ACTIVE') return;
    if(s.grade !== 'A' && s.grade !== 'B') return;
    if(FAM_HANDLAS[s.fam] === false) return;               // mätt förlustbringande familj
    if(konto.oppna[s.id] || konto.affarer.some(a => a.id === s.id)) return;
    konto.oppna[s.id] = {
      id: s.id, inst: INST.key, side: s.side, grade: s.grade, namn: s.name,
      entry: s.entryFyllt || s.entry, sl: s.sl, tp: s.tp, risk: s.risk,
      kontrakt: s.kontrakt || konto.kontrakt || 1, oppnad: s.oppnad || Date.now(),
      kollad: bars[bars.length - 1].t,
      marginal: (s.kontrakt || konto.kontrakt || 1)*MARGINAL_PER_KONTRAKT
    };
    logg('öppnar ' + s.grade + ' ' + s.side + ' × ' + (s.kontrakt || 1) + ' @ ' + s.entry.toFixed(2));
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
    /* Motorns egen minnespost ska också veta att affären är slut. Annars
       ligger den kvar som pågående, och sidor som läser kontot skulle visa
       ett kort som ACTIVE i evighet. */
    const st = LIVE.get(id);
    if(st && !st.hitTp && !st.hitSl){
      if(hur === 'mål') st.hitTp = true; else st.hitSl = true;
      st.slutAt = nar;
      LIVE.set(id, st);
    }
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

  /* Gallring: en fyllning som varken nått mål eller stopp på ett dygn är inte
     pågående längre, den är bortglömd. Utan det växer dokumentet i all evighet. */
  const nu = Date.now();
  Object.entries(live).forEach(([id, st]) => {
    const gammal = st.slutAt ? (nu - st.slutAt > 6*3600e3) : (nu - (st.at || nu) > 24*3600e3);
    if(gammal) delete live[id];
  });

  konto.nyhetsbias = { poang: nb.poang, n: nb.n, nar: nb.nar, riktning: lage.riktning, styrka: lage.styrka };
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
      const inne = { t, o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: num(b.v) || 0 };
      if([inne.o, inne.h, inne.l, inne.c].some(v => v === null)){
        res.status(400).json({ error: 'ofullständig stapel' }); return;
      }

      /* Skickar TradingView oftare än var femte minut — 5-sekundersgrafen, eller
         1-minutersgrafen — hör flera anrop till samma femminutersfack. De vägs
         ihop i stället för att skriva över varandra: öppningen är den första vi
         såg, högsta och lägsta rullar, stängningen är den senaste. Facket ligger
         i ett eget litet dokument som sidan lyssnar på, så en uppdatering kostar
         ett par hundra byte i stället för hela historiken. */
      const lsnap = await LIVE_DOK().get();
      const forra = lsnap.exists ? lsnap.data().NQ : null;
      let live;
      if(forra && forra.t === t){
        live = { t,
          o: forra.o,
          h: Math.max(forra.h, inne.h),
          l: Math.min(forra.l, inne.l),
          c: inne.c,
          v: Math.max(forra.v || 0, inne.v || 0),
          delar: (forra.delar || 1) + 1 };
      }else{
        live = { ...inne, delar: 1 };
      }
      await LIVE_DOK().set({ NQ: live, uppdaterad: FieldValue.serverTimestamp() });

      /* Facket är slut när ett nytt börjar. Då — och bara då — skrivs den
         färdiga stapeln in i historiken, alltså högst var femte minut. */
      let historik = null;
      if(forra && forra.t !== t){
        const snap = await FEED_DOK().get();
        const nu = (snap.exists && snap.data().NQ) || [];
        const klar = { t: forra.t, o: forra.o, h: forra.h, l: forra.l, c: forra.c, v: forra.v || 0 };
        const ix = nu.findIndex(x => x.t === klar.t);
        if(ix >= 0) nu[ix] = klar; else nu.push(klar);
        nu.sort((a,b2) => a.t - b2.t);
        historik = nu.slice(-400);
        await FEED_DOK().set({ NQ: historik, uppdaterad: FieldValue.serverTimestamp() }, { merge: true });
      }
      res.json({ ok: true, t, delar: live.delar, staplar: historik ? historik.length : null });
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
    /* Staplarna som TradingView-alertet skickat in. Sidan lägger dem över
       Yahoos fördröjda serie, så grafen och signalerna räknar på dina egna
       priser. Öppen läsning precis som kontot — det är samma data som redan
       ritas på skärmen. */
    if(vag === '/bars'){
      const snap = await FEED_DOK().get();
      const alla = (snap.exists && snap.data()) || {};
      const s = String(req.query.s || 'NQ').toUpperCase();
      res.set('cache-control', 'public, max-age=15');
      res.json(alla[s] || []);
      return;
    }

    /* Den pågående stapeln. Sidan lyssnar hellre på Firestore direkt, men den
       här vägen finns för localhost och allt som inte pratar Firestore. */
    /* Firebase-konfigurationen för webbklienten. Hosting serverar den själv på
       /__/firebase/init.json, men sidan ligger också på GitHub Pages och på
       localhost, och där finns ingen sådan fil. Nycklarna ska inte ligga i
       repot, så funktionen hämtar dem från hostingen och lämnar dem vidare.
       De är publika av design och låsta till våra adresser i Google Cloud. */
    if(vag === '/webbkonfig'){
      try{
        const k = await webbkonfig();
        res.set('cache-control', 'public, max-age=600');
        res.json(k);
      }catch(e){
        res.status(502).json({ error: 'nådde inte hostingens konfiguration' });
      }
      return;
    }

    if(vag === '/live'){
      const snap = await LIVE_DOK().get();
      const d = snap.exists ? snap.data() : null;
      res.set('cache-control', 'no-store');
      res.json(d ? { NQ: d.NQ || null, bias: d.bias || null } : null);
      return;
    }

    /* Kontot kräver inloggning, precis som Firestore-reglerna. Sidan skickar
       sin id-token; utan giltig token finns inget att hämta här. */
    /* Nollställning. Pengarna och historiken går tillbaka till start, men
       motorns minne av vilka setups som är igång behålls — annars vet kontot
       inte vad som löper och står tomt tills nästa fyllning råkar inträffa. */
    if(vag === '/konto/nollstall' && req.method === 'POST'){
      let b = req.body;
      if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch{ b = {}; } }
      const nyckelIn = (b && b.k) || req.query.k;
      if(!nyckel || nyckelIn !== nyckel){ res.status(401).json({ error: 'fel nyckel' }); return; }
      const gammalt = await lasKonto();
      const nytt = tomtKonto();
      nytt.live = gammalt.live || {};
      nytt.sedd = gammalt.sedd || {};
      nytt.pris = gammalt.pris || null;
      await skrivKonto(nytt);
      res.json({ ok: true, kapital: nytt.kapital, behallna: Object.keys(nytt.live).length });
      return;
    }

    if(vag === '/konto'){
      const huvud = String(req.get('authorization') || '');
      const token = huvud.startsWith('Bearer ') ? huvud.slice(7) : '';
      if(!token){ res.status(401).json({ error: 'inloggning krävs' }); return; }
      try{
        await getAuth().verifyIdToken(token);
      }catch(e){
        res.status(401).json({ error: 'ogiltig inloggning' }); return;
      }
      const k = await lasKonto();
      delete k.live; delete k.sedd;
      res.json(k);
      return;
    }

    res.json({ tjanst: 'riptide', vagar: ['/api/proxy?url=…', '/api/ingest (POST)', '/api/bars?s=NQ', '/api/live', '/api/webbkonfig', '/api/tick?k=…', '/api/konto', '/api/konto/nollstall (POST)'] });
  }
);
