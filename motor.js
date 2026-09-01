/**
 * Riptide — signalmotorn.
 *
 * Ren logik utan DOM: indikatorer, de fyra strategifamiljerna, ICT-modellen,
 * graderingen A/B/C och statusen på en affär. Samma fil körs på två ställen —
 * i webbläsaren av index.html och i Cloudflare-workern av dess cron — så att
 * sidan och det automatiska kontot alltid räknar exakt likadant.
 */

/* ---------- inställningar motorn läser (sätts av den som använder den) ---------- */
export const MOTORCFG = { minPts: 50, maxPts: 400, risk: 'normal' };

/* ---------- små hjälpare ---------- */
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const last  = a => a[a.length-1];
const nz    = v => (typeof v === 'number' && isFinite(v));

function fmt(n, d=2){
  if(!nz(n)) return '–';
  return n.toLocaleString('sv-SE',{minimumFractionDigits:d, maximumFractionDigits:d});
}
function fmtSigned(n, d=2){ if(!nz(n)) return '–'; return (n>0?'+':'') + fmt(n,d); }
function pct(n, d=2){ if(!nz(n)) return '–'; return (n>0?'+':'') + n.toFixed(d) + '%'; }

function timeIn(tz, opts){
  return new Intl.DateTimeFormat('sv-SE', Object.assign({timeZone:tz, hour12:false}, opts)).format(new Date());
}
function nyParts(nar){
  const p = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,
    weekday:'short',hour:'2-digit',minute:'2-digit'}).formatToParts(nar ? new Date(nar) : new Date());
  const o={}; p.forEach(x=>o[x.type]=x.value);
  return { wd:o.weekday, h:+o.hour%24, m:+o.minute };
}
function sessionState(nar){
  const {wd,h,m} = nyParts(nar);
  const mins = h*60+m;
  const weekend = (wd==='Sat') || (wd==='Sun' && mins < 18*60);
  if(weekend) return {k:'closed', t:'Marknaden stängd', cls:''};
  if(mins >= 9*60+30 && mins < 16*60)  return {k:'rth',   t:'RTH — kassan öppen', cls:'rth'};
  if(mins >= 4*60    && mins < 9*60+30) return {k:'pre',   t:'Förhandel', cls:'pre'};
  if(mins >= 16*60   && mins < 20*60)  return {k:'post',  t:'Efterhandel', cls:'pre'};
  return {k:'globex', t:'Globex — nattsession', cls:''};
}

/* ---------- den lärda modellen ---------- */
import { MODELL } from './modell.js';

/* ---------- instrument ---------- */
const INSTR = {
  // Nyckeln heter NQ eftersom det är den koden feeden och nyhetsanalysen använder,
  // men instrumentet som handlas och ritas är mikroterminen MNQ: samma index och
  // samma tick, en tiondel av kontraktsvärdet ($2 per punkt mot $20).
  NQ: { key:'NQ', yahoo:'MNQ=F', alt:['NQ=F','^NDX','QQQ'], label:'MNQ · Micro Nasdaq-100', unit:'p',
        kort:'MNQ', tick:0.25, dec:2, ptValue:2, base:23150, vol:0.0022 },
  // Guld är pausat. Lägg tillbaka raden nedan så följer resten av sidan med av sig själv:
  // GC: { key:'GC', yahoo:'GC=F', alt:['XAUUSD=X','GLD'], label:'GC · Guld', unit:'$',
  //       tick:0.1, dec:1, ptValue:100, base:3385, vol:0.0016 }
};
const SYMS = Object.keys(INSTR);          // enda stället som avgör vilka instrument som körs

/* ---------- positionsstorlek ----------
   Förlusten är det som hålls fast: en stoppad affär kostar MAX_RISK dollar,
   inte mer. Antalet kontrakt räknas därför ut från hur långt stoppen faktiskt
   sitter — ligger den bakom ett stöd en bra bit bort blir kontrakten färre,
   ligger den tätt under swinglowen blir de fler. Vinsten får bli vad R:R ger.
   Ett kontrakt är golvet: är stoppen så vid att ens ett MNQ riskerar mer än
   taket flaggas det i stället för att affären räknas bort. */
const MAX_RISK = 750;

function positionsStorlek(inst, riskPunkter, malPunkter, maxRisk = MAX_RISK){
  const pt = (INSTR[inst] && INSTR[inst].ptValue) || 2;
  const perKontrakt = Math.abs(riskPunkter) * pt;
  const kontrakt = perKontrakt > 0 ? Math.max(1, Math.floor(maxRisk / perKontrakt)) : 1;
  return {
    kontrakt,
    perKontrakt,                              // dollar per kontrakt om stoppen tas
    riskUsd: perKontrakt * kontrakt,          // hela affärens förlust vid stopp
    malUsd: Math.abs(malPunkter) * pt * kontrakt,
    overRisk: perKontrakt > maxRisk           // ett enda kontrakt spränger redan taket
  };
}

/* ==========================================================================
   4. INDIKATORER
   ========================================================================== */
function ema(vals, p){
  const k = 2/(p+1); const out = new Array(vals.length).fill(null);
  let e = vals.slice(0,p).reduce((a,b)=>a+b,0)/p;
  out[p-1] = e;
  for(let i=p;i<vals.length;i++){ e = vals[i]*k + e*(1-k); out[i] = e; }
  return out;
}
function rsi(vals, p=14){
  const out = new Array(vals.length).fill(null);
  if(vals.length <= p) return out;
  let g=0, l=0;
  for(let i=1;i<=p;i++){ const d=vals[i]-vals[i-1]; d>=0 ? g+=d : l-=d; }
  g/=p; l/=p;
  out[p] = l===0 ? 100 : 100 - 100/(1+g/l);
  for(let i=p+1;i<vals.length;i++){
    const d = vals[i]-vals[i-1];
    g = (g*(p-1) + (d>0? d:0))/p;
    l = (l*(p-1) + (d<0?-d:0))/p;
    out[i] = l===0 ? 100 : 100 - 100/(1+g/l);
  }
  return out;
}
function atr(bars, p=14){
  const out = new Array(bars.length).fill(null);
  const tr = bars.map((b,i)=> i===0 ? b.h-b.l
    : Math.max(b.h-b.l, Math.abs(b.h-bars[i-1].c), Math.abs(b.l-bars[i-1].c)));
  let a = tr.slice(0,p).reduce((x,y)=>x+y,0)/p; out[p-1]=a;
  for(let i=p;i<bars.length;i++){ a = (a*(p-1)+tr[i])/p; out[i]=a; }
  return out;
}
/* Tidsomräkningarna är dyra och samma stapel slås upp om och om igen när
   fönstret glider framåt, så svaren sparas. Taket håller minnet i schack. */
const TIDCACHE = new Map();
function tidNY(ms){
  let v = TIDCACHE.get(ms);
  if(v) return v;
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat('en-CA',{ timeZone:'America/New_York', hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', weekday:'short'
  }).formatToParts(d);
  const o = {}; p.forEach(x => o[x.type] = x.value);
  v = { dag: o.year + '-' + o.month + '-' + o.day, min: (+o.hour%24)*60 + (+o.minute), vd: o.weekday };
  if(TIDCACHE.size > 60000) TIDCACHE.clear();
  TIDCACHE.set(ms, v);
  return v;
}
function dayKeyNY(ms){ return tidNY(ms).dag; }
function minutesNY(ms){ return tidNY(ms).min; }
function weekdayNY(ms){ return tidNY(ms).vd; }

/* ADX — hur riktad marknaden är. Forskningen på VWAP-återgång är tydlig med
   att det är regimen som avgör: hög ADX = trend, och då fungerar återgång
   dåligt. Den får därför vara ett eget drag till modellen. */
function adx(bars, p=14){
  const out = new Array(bars.length).fill(null);
  if(bars.length < p*2) return out;
  let tr=0, dp=0, dm=0;
  const trs=[], dps=[], dms=[];
  for(let i=1;i<bars.length;i++){
    const upp = bars[i].h - bars[i-1].h, ned = bars[i-1].l - bars[i].l;
    trs.push(Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-bars[i-1].c), Math.abs(bars[i].l-bars[i-1].c)));
    dps.push(upp > ned && upp > 0 ? upp : 0);
    dms.push(ned > upp && ned > 0 ? ned : 0);
  }
  let dx = null, adxV = null;
  for(let i=0;i<trs.length;i++){
    if(i < p){ tr+=trs[i]; dp+=dps[i]; dm+=dms[i]; if(i<p-1) continue; }
    else { tr = tr - tr/p + trs[i]; dp = dp - dp/p + dps[i]; dm = dm - dm/p + dms[i]; }
    if(!(tr > 0)) continue;
    const pdi = 100*dp/tr, mdi = 100*dm/tr, summa = pdi+mdi;
    dx = summa ? 100*Math.abs(pdi-mdi)/summa : 0;
    adxV = adxV === null ? dx : (adxV*(p-1)+dx)/p;
    out[i+1] = adxV;
  }
  return out;
}
function sessionVWAP(bars){
  const out = new Array(bars.length).fill(null);
  let pv=0, vv=0, key=null;
  for(let i=0;i<bars.length;i++){
    const b = bars[i], k = dayKeyNY(b.t);
    if(k !== key){ key = k; pv=0; vv=0; }
    const tp = (b.h+b.l+b.c)/3;
    const v  = b.v>0 ? b.v : 1;
    pv += tp*v; vv += v;
    out[i] = pv/vv;
  }
  return out;
}
function swings(bars, w=3){
  const hi=[], lo=[];
  for(let i=w;i<bars.length-w;i++){
    let ih=true, il=true;
    for(let j=i-w;j<=i+w;j++){
      if(j===i) continue;
      if(bars[j].h >= bars[i].h) ih=false;
      if(bars[j].l <= bars[i].l) il=false;
    }
    if(ih) hi.push({i, p:bars[i].h, t:bars[i].t});
    if(il) lo.push({i, p:bars[i].l, t:bars[i].t});
  }
  return {hi, lo};
}

function buildContext(inst, bars){
  const closes = bars.map(b=>b.c);
  const e9 = ema(closes,9), e21 = ema(closes,21), e50 = ema(closes,50), e200 = ema(closes, Math.min(200, Math.floor(bars.length/2)));
  const r  = rsi(closes,14), a = atr(bars,14), vw = sessionVWAP(bars);
  const i  = bars.length-1;
  const px = closes[i];
  const A  = nz(a[i]) ? a[i] : px*0.0015;

  // sessioner
  const todayKey = dayKeyNY(bars[i].t);
  const days = {};
  bars.forEach((b,ix)=>{ const k=dayKeyNY(b.t); (days[k] = days[k]||[]).push(ix); });
  const keys = Object.keys(days).sort();
  const prevKey = keys[keys.indexOf(todayKey)-1];

  const range = ixs => {
    if(!ixs || !ixs.length) return null;
    let h=-Infinity,l=Infinity,vol=0;
    ixs.forEach(ix=>{ h=Math.max(h,bars[ix].h); l=Math.min(l,bars[ix].l); vol+=bars[ix].v; });
    return {h,l,vol,mid:(h+l)/2};
  };
  const today = range(days[todayKey]);
  const prev  = prevKey ? range(days[prevKey]) : null;
  const vardag = weekdayNY(bars[i].t);

  // RTH och opening range (första 30 min = 6 st 5m-staplar)
  const rthIx = (days[todayKey]||[]).filter(ix => { const m=minutesNY(bars[ix].t); return m>=570 && m<960; });
  const orIx  = rthIx.slice(0,6);                 // 09:30–10:00 = de sex första 5m-staplarna
  const or    = range(orIx);
  const rth   = range(rthIx);
  if(or){
    // Öppningsrangens egen riktning: stänger den i övre halvan är utbrottet uppåt
    // klart mer sannolikt (mätt på 6 000+ dagar i ES och NQ).
    or.klar = orIx.length >= 6;
    or.o = bars[orIx[0]].o;
    or.c = bars[orIx[orIx.length-1]].c;
    or.riktning = (or.h > or.l) ? (or.c - or.mid)/((or.h - or.l)/2) : 0;   // −1..1
    or.bredd = or.h - or.l;
  }

  // volym
  const vols = bars.slice(-60).map(b=>b.v).filter(v=>v>0);
  const avgVol = vols.length ? vols.reduce((x,y)=>x+y,0)/vols.length : 0;
  const relVol = avgVol ? (bars[i].v / avgVol) : 1;

  const sw = swings(bars, 3);
  const recentHi = sw.hi.slice(-4);
  const recentLo = sw.lo.slice(-4);

  // trendpoäng −100..100
  let trend = 0;
  if(nz(e9[i]) && nz(e21[i])) trend += (e9[i] > e21[i] ? 26 : -26);
  if(nz(e21[i]) && nz(e50[i])) trend += (e21[i] > e50[i] ? 22 : -22);
  if(nz(e50[i]) && nz(e50[i-10])) trend += (e50[i] > e50[i-10] ? 16 : -16);
  if(nz(vw[i])) trend += (px > vw[i] ? 20 : -20);
  if(nz(e200[i])) trend += (px > e200[i] ? 16 : -16);
  trend = clamp(trend, -100, 100);

  const ad = adx(bars, 14);
  const momo = nz(r[i]) ? r[i] : 50;
  const chgPct = (px - bars[Math.max(0,i-12)].c) / bars[Math.max(0,i-12)].c * 100;

  return {
    inst, bars, i, px, atr:A, e9:e9[i], e21:e21[i], e50:e50[i], e200:e200[i],
    rsi:momo, vwap:vw[i], vwapArr:vw, e9a:e9, e21a:e21, e50a:e50,
    today, prev, or, rth, relVol, trend, chgPct, vardag,
    adx: nz(ad[i]) ? ad[i] : 20, minNY: minutesNY(bars[i].t),
    recentHi, recentLo, atrPct:A/px*100
  };
}

/* ==========================================================================
   4b. DRAG TILL MODELLEN
   Samma funktion körs när sidan räknar och när träningen spelar upp historiken,
   så en vikt betyder alltid samma sak. Ordningen är låst: läggs ett drag till
   måste modellen tränas om, och tills dess vägrar aiSannolikhet svara.
   ========================================================================== */
const DRAG_NAMN = [
  'lang', 'trend', 'svep', 'brott', 'ict', 'orb',
  'trendriktning', 'rsiriktning', 'relvolym', 'atrprocent',
  'avstand', 'rr', 'medhall', 'mothall',
  'vwapriktning', 'daglage', 'daglageriktning',
  'orlage', 'orbredd', 'orriktning', 'orklar',
  'adx', 'rth', 'ytterhandel', 'globex', 'rthandel',
  'mandag', 'tisdag', 'onsdag', 'torsdag', 'fredag',
  'killzone', 'stopporder'
];

function drag(ctx, o, rr, dist, G){
  const dir = o.side === 'long' ? 1 : -1;
  const A = ctx.atr || 1, px = ctx.px;
  const vw = nz(ctx.vwap) ? ctx.vwap : px;
  const T = ctx.today, OR = ctx.or;
  const dagLage = (T && T.h > T.l) ? clamp((px - T.l)/(T.h - T.l), 0, 1) : 0.5;
  const m = ctx.minNY, iRth = (m >= 570 && m < 960);
  const yttre = (m >= 240 && m < 570) || (m >= 960 && m < 1200);
  const vd = ctx.vardag;
  return [
    dir > 0 ? 1 : 0,
    o.fam === 'trend' ? 1 : 0, o.fam === 'svep' ? 1 : 0,
    o.fam === 'brott' ? 1 : 0, o.fam === 'ict' ? 1 : 0, o.fam === 'orb' ? 1 : 0,
    clamp(ctx.trend/100, -1, 1) * dir,
    clamp((ctx.rsi - 50)/50, -1, 1) * dir,
    Math.log(clamp(ctx.relVol || 1, 0.1, 6)),
    clamp(ctx.atrPct, 0, 1),
    clamp(dist/A, 0, 4),
    clamp(rr, 0, 6),
    (G ? G.n : 0)/4,
    (G ? G.against.length : 0)/4,
    clamp((px - vw)/A, -4, 4) * dir,
    dagLage,
    (dagLage - 0.5)*2*dir,
    OR ? clamp((px - OR.mid)/((OR.bredd/2) || A), -4, 4) * dir : 0,
    OR ? clamp(OR.bredd/A, 0, 8) : 0,
    OR ? OR.riktning * dir : 0,
    (OR && OR.klar) ? 1 : 0,
    clamp(ctx.adx, 0, 60)/50,
    iRth ? 1 : 0,
    yttre ? 1 : 0,
    (!iRth && !yttre) ? 1 : 0,
    iRth ? clamp((m - 570)/390, 0, 1) : 0,
    vd === 'Mon' ? 1 : 0, vd === 'Tue' ? 1 : 0, vd === 'Wed' ? 1 : 0,
    vd === 'Thu' ? 1 : 0, vd === 'Fri' ? 1 : 0,
    ictKillzone(ctx.bars[ctx.i].t) ? 1 : 0,
    o.trigger === 'stop' ? 1 : 0
  ];
}

/* Sannolikheten att setupen når målet före stoppen, enligt de tränade vikterna.
   Saknas modell — eller har draglistan ändrats sedan träningen — svarar den
   null, och resten av sidan använder den handsatta konfidensen som förut. */
function aiSannolikhet(x){
  const M = MODELL;
  if(!M || !M.vikter || M.vikter.length !== x.length) return null;
  if(M.drag && M.drag.length && M.drag.join(',') !== DRAG_NAMN.join(',')) return null;
  let z = M.bias || 0;
  for(let i=0;i<x.length;i++){
    const sk = (M.skala && M.skala[i]) ? M.skala[i] : 1;
    z += M.vikter[i] * ((x[i] - ((M.medel && M.medel[i]) || 0)) / sk);
  }
  return 1/(1 + Math.exp(-clamp(z, -18, 18)));
}


/* ==========================================================================
   4c. NYHETSTOLKNING
   Reglerna bodde i sidan, men molnet behöver samma bedömning: biasen styr
   numera vilket håll signaler ges åt, och skärmen och kontot får inte tycka
   olika. Därför ligger de här, i den fil båda delar.
   ========================================================================== */
const RULES = [
  // --- Inflation ---
  {k:/\b(cpi|inflation)\b.*\b(hotter|higher|beats|above|rises|jump|accelerat)/i, nq:-3, gc:-1, c:'macro', sv:'Hetare inflation än väntat → högre räntebana och press på tillväxtaktier. Tyngst i de längsta techcaseen.'},
  {k:/\b(cpi|inflation)\b.*\b(cool|softer|lower|below|eases|slow|miss)/i, nq:3, gc:2, c:'macro', sv:'Svalare inflation → marknaden prisar in mjukare Fed. Lägre realräntor lyfter värderingen på tillväxtbolag, alltså medvind för NQ.'},
  {k:/\b(cpi|ppi|pce|core inflation)\b/i, nq:0, gc:0, c:'macro', sv:'Inflationsdata i fokus — direkt input till Fed-banan och därmed till hela värderingen av NQ.'},
  // --- Fed / räntor ---
  {k:/\b(rate cut|cuts rates|dovish|easing cycle|lower rates)\b/i, nq:3, gc:3, c:'macro', sv:'Duvaktig Fed-signal → lägre realräntor. Historiskt bränsle för Nasdaq, ofta med snabb reaktion i 5m-grafen.'},
  {k:/\b(rate hike|hawkish|higher for longer|tighten)/i, nq:-3, gc:-2, c:'macro', sv:'Hökaktig ton → högre diskonteringsränta. Negativt för Nasdaq, och dollarn brukar stärkas samtidigt.'},
  {k:/\b(fomc|federal reserve|the fed)\b/i, nq:0, gc:0, c:'macro', sv:'Fed-relaterat — den enskilt viktigaste drivkraften för indexet just nu.'},
  {k:/\bpowell\b/i, nq:0, gc:0, c:'macro', sv:'Powell-uttalande. Tonläget flyttar räntekurvan direkt; vänta ut första reaktionen innan entry.'},
  {k:/\b(yields?)\b.*\b(rise|surge|jump|higher|climb)/i, nq:-2, gc:-2, c:'macro', sv:'Stigande obligationsräntor → tryck på högt värderade techbolag, som diskonteras hårdare.'},
  {k:/\b(yields?)\b.*\b(fall|drop|slide|lower|decline)/i, nq:2, gc:2, c:'macro', sv:'Fallande räntor → lättnad för Nasdaq-värderingar, särskilt i de längsta tillväxtcaseen.'},
  // --- Dollar ---
  {k:/\b(dollar|dxy|greenback)\b.*\b(surge|strength|stronger|rally|higher)/i, nq:-1, gc:-3, c:'macro', sv:'Starkare dollar pressar amerikanska bolags utlandsvinster — mild motvind för NQ, och en riskaversionssignal.'},
  {k:/\b(dollar|dxy|greenback)\b.*\b(weak|falls|slide|lower|drops)/i, nq:1, gc:3, c:'macro', sv:'Svagare dollar → stödjande för amerikanska storbolagsvinster och brukar följas av riskaptit.'},
  // --- Arbetsmarknad ---
  {k:/\b(nonfarm|nfp|payrolls|jobs report)\b/i, nq:0, gc:0, c:'macro', sv:'Arbetsmarknadsdata — hög volatilitet i 5m-grafen kring släppet. Undvik entries de första staplarna.'},
  {k:/\b(jobless claims|unemployment)\b.*\b(rise|higher|surge|increase)/i, nq:-1, gc:2, c:'macro', sv:'Svagare arbetsmarknad → recessionsoro, men också ökad chans till räntesänkning. Dragkamp i indexet.'},
  {k:/\b(recession|hard landing|slowdown|contraction)\b/i, nq:-3, gc:2, c:'macro', sv:'Recessionsoro → riskaversion. Nasdaq säljs först och hårdast av riskbarometrarna.'},
  {k:/\b(soft landing|resilient economy|robust growth)\b/i, nq:2, gc:-1, c:'macro', sv:'Mjuklandningsnarrativ → riskaptit upp, gynnsamt för indexet.'},
  // --- Tech / Nasdaq ---
  {k:/\b(nvidia|nvda)\b/i, nq:2, gc:0, c:'nq', sv:'Nvidia är den tyngsta enskilda drivaren i Nasdaq-100 — rörelser här slår igenom direkt i NQ.'},
  {k:/\b(apple|microsoft|amazon|alphabet|google|meta|tesla|broadcom|aapl|msft|amzn|googl|tsla|avgo)\b/i, nq:1, gc:0, c:'nq', sv:'Megacap-nyhet. Dessa bolag väger tungt i indexet — kolla om rörelsen är bolagsspecifik eller bred.'},
  {k:/\b(ai|artificial intelligence|data ?cent|chips?|semiconductor)\b/i, nq:2, gc:0, c:'nq', sv:'AI-/halvledartemat är motorn i Nasdaq-rallyt. Positiva nyheter här lyfter hela indexet.'},
  {k:/\b(earnings)\b.*\b(beat|top|surpass|strong)/i, nq:2, gc:0, c:'nq', sv:'Starkare rapport än väntat → stöd för indexet, särskilt om guidningen höjs.'},
  {k:/\b(earnings)\b.*\b(miss|disappoint|weak|cut guidance|warns)/i, nq:-3, gc:0, c:'nq', sv:'Rapportbesvikelse → risk för sektorbred nedgång i tech.'},
  {k:/\b(nasdaq|ndx|qqq|tech stocks)\b.*\b(rally|surge|jump|record|higher|gains)/i, nq:2, gc:0, c:'nq', sv:'Nasdaq i styrka — bekräftar köparkontroll, prioritera long-setups i NQ.'},
  {k:/\b(nasdaq|ndx|qqq|tech stocks)\b.*\b(slide|fall|drop|selloff|tumble|lower)/i, nq:-2, gc:0, c:'nq', sv:'Nasdaq under press — prioritera short-setups tills strukturen vänder.'},
  {k:/\b(nasdaq|ndx|qqq|s&p|wall street|stock market|futures)\b/i, nq:0, gc:0, c:'nq', sv:'Direkt indexrelaterat — läs mot 5m-strukturen innan du agerar.'},
  // --- Guld ---
  {k:/\bgold\b.*\b(record|all-time high|surge|rally|jump|climbs?|higher)/i, nq:0, gc:3, c:'gold', sv:'Guld i styrka — läs det som en signal om realräntor och riskaptit. Guld handlas inte i den här panelen.'},
  {k:/\bgold\b.*\b(falls?|slide|drop|tumble|lower|retreat|profit-taking)/i, nq:0, gc:-3, c:'gold', sv:'Guld under press — oftast starkare dollar eller stigande realräntor. Läs det som dollarsignal, inte som en affär.'},
  {k:/\b(central bank).*(gold|bullion)|gold.*(central bank buying|reserves)/i, nq:0, gc:3, c:'gold', sv:'Centralbanksköp av guld — strukturell efterfrågan och en fingervisning om synen på dollarn.'},
  {k:/\b(etf).*(gold|bullion|inflow|outflow)/i, nq:0, gc:2, c:'gold', sv:'ETF-flöden i guld visar hur institutionellt kapital positionerar sig mellan risk och skydd.'},
  {k:/\b(gold|xau|bullion|silver|precious metal)/i, nq:0, gc:1, c:'gold', sv:'Guldrelaterat — mest intressant som avläsning av dollarn och realräntorna.'},
  // --- Geopolitik / risk ---
  {k:/\b(war|attack|strike|missile|invasion|conflict|escalat)/i, nq:-2, gc:3, c:'macro', sv:'Geopolitisk eskalering → flykt till säkerhet, index ned. Rörelserna är snabba och ofta kortlivade.'},
  {k:/\b(ceasefire|peace deal|de-escalat|truce)\b/i, nq:2, gc:-2, c:'macro', sv:'Nedtrappning → riskpremien faller tillbaka och risktillgångar lyfter.'},
  {k:/\b(tariff|trade war|sanction|export control)/i, nq:-2, gc:2, c:'macro', sv:'Handelspolitisk friktion → osäkerhet kring marginaler och leveranskedjor i tech.'},
  {k:/\b(shutdown|debt ceiling|default)\b/i, nq:-2, gc:2, c:'macro', sv:'Politisk osäkerhet i USA → riskpremie upp och tunnare likviditet i indexet.'},
  // --- Övrigt makro ---
  {k:/\b(pmi|ism)\b/i, nq:0, gc:0, c:'macro', sv:'Konjunkturbarometer — påverkar tillväxtförväntningarna och därmed indexriktningen.'},
  {k:/\b(gdp)\b/i, nq:0, gc:0, c:'macro', sv:'BNP-data. Starkt = riskaptit men högre räntor; svagt = tvärtom.'},
  {k:/\b(oil|crude|wti|brent|opec)\b/i, nq:-1, gc:1, c:'macro', sv:'Oljepriset styr inflationsförväntningarna — högre olja pressar tech via räntebanan.'},
  {k:/\b(china|beijing|pboc)\b/i, nq:0, gc:1, c:'macro', sv:'Kina-nyhet — påverkar global tillväxt och halvledarkedjan, alltså tungt i Nasdaq-100.'},
  {k:/\b(ecb|boj|bank of japan|bank of england)\b/i, nq:0, gc:1, c:'macro', sv:'Annan centralbank i rörelse — slår mot dollarn och därmed indirekt mot amerikanska tillgångar.'},
  {k:/\b(bitcoin|crypto)\b/i, nq:1, gc:0, c:'macro', sv:'Krypto rör sig ofta i takt med Nasdaq som riskbarometer.'},
  {k:/\b(vix|volatility)\b.*\b(spike|surge|jump)/i, nq:-2, gc:1, c:'macro', sv:'Volatilitetsspik → minska storlek, bredda stopp. Rörelserna på 5m blir betydligt större.'}
];

const RISK_EVENTS = [
  {k:/\b(cpi|inflation report)\b/i, n:'CPI / inflationsdata', imp:'HÖG'},
  {k:/\b(fomc|rate decision|fed meeting)\b/i, n:'FOMC-besked', imp:'HÖG'},
  {k:/\bpowell\b/i, n:'Powell talar', imp:'HÖG'},
  {k:/\b(nonfarm|payrolls|jobs report|nfp)\b/i, n:'Arbetsmarknadsrapport', imp:'HÖG'},
  {k:/\b(ppi)\b/i, n:'PPI', imp:'MEDEL'},
  {k:/\b(pce)\b/i, n:'PCE-inflation', imp:'HÖG'},
  {k:/\b(jobless claims)\b/i, n:'Nyanmälda arbetslösa', imp:'MEDEL'},
  {k:/\b(ism|pmi)\b/i, n:'ISM / PMI', imp:'MEDEL'},
  {k:/\b(earnings|results)\b.*\b(nvidia|apple|microsoft|tesla|amazon|meta|alphabet)/i, n:'Megacap-rapport', imp:'HÖG'},
  {k:/\b(opec)\b/i, n:'OPEC-möte', imp:'MEDEL'},
  {k:/\b(ecb|boj)\b.*\b(decision|meeting|policy)/i, n:'ECB/BoJ-besked', imp:'MEDEL'}
];

function analyseHeadline(title, summary){
  const txt = (title + ' ' + (summary||'')).replace(/\s+/g,' ');
  let nq=0, gc=0, cats=new Set(), svs=[];
  for(const r of RULES){
    if(r.k.test(txt)){
      nq += r.nq; gc += r.gc; cats.add(r.c);
      if(svs.length < 2 && r.sv) svs.push(r.sv);
    }
  }
  nq = clamp(nq,-6,6); gc = clamp(gc,-6,6);
  if(!svs.length) svs.push('Allmän marknadsnyhet utan tydlig riktningseffekt på NQ.');
  return { nq, gc, cats:[...cats], sv:svs, hot: Math.abs(nq)>=3 || Math.abs(gc)>=3 };
}

function computeNewsBias(items){
  let nq=0, gc=0, wsum=0;
  const now = Date.now();
  items.slice(0,45).forEach(it=>{
    const a = it.an || analyseHeadline(it.title, it.desc);
    it.an = a;
    const ageH = (now - it.ts)/3.6e6;
    const w = Math.exp(-ageH/7);              // halveringstid ~5h
    nq += a.nq*w; gc += a.gc*w; wsum += w;
  });
  const norm = v => wsum ? clamp(v/wsum*33, -100, 100) : 0;
  return { nq: norm(nq), gc: norm(gc) };
}

/* Vilket håll nyhetsflödet lutar åt, och hur starkt. Under tröskeln är svaret
   neutralt — då spärras ingenting. */
const BIAS_TROSKEL = 10;          // under detta är flödet inte riktat nog
const BIAS_FULLT   = 45;          // här räknas biasen som helt utslagen

function biasLage(poang){
  const p = nz(poang) ? poang : 0;
  const styrka = Math.round(clamp(Math.abs(p)/BIAS_FULLT, 0, 1) * 100);
  const riktning = p >= BIAS_TROSKEL ? 1 : p <= -BIAS_TROSKEL ? -1 : 0;
  return {
    poang: p,
    riktning,                                     // 1 = bara long, −1 = bara short, 0 = båda
    styrka,                                       // 0–100 %
    text: riktning > 0 ? 'LONG' : riktning < 0 ? 'SHORT' : 'NEUTRAL'
  };
}

/* ==========================================================================
   5. SIGNALMOTOR
   Tre strategifamiljer — trendfortsättning, likviditetssvep och range-brott —
   vägs ihop till en kvalitetsgrad per setup:
     A = alla tre familjerna talar för riktningen (mest potential)
     B = två familjer
     C = en familj eller ingen
   ========================================================================== */
const RISK_MULT = { tight:0.95, normal:1.30, wide:1.75 };
const FAM = { trend:'Trendfortsättning', svep:'Likviditetssvep', brott:'Range-brott', ict:'ICT-modell',
              orb:'Öppningsrange', moment:'Intradagsmomentum' };
const FAM_KORT = { trend:'TREND', svep:'SVEP', brott:'BROTT', ict:'ICT', orb:'ORB', moment:'MOMENT' };
const FAM_KEY = k => Object.keys(FAM).find(x => FAM[x] === k) || '';

/* Vilka familjer som får öppna affärer i demokontot.

   Först var trend och brott spärrade. Underlaget var mätningen av *alla*
   setups, där trend låg på −0,128 R över 9 905 fall och förlorade i alla fyra
   tidsblocken. Det såg entydigt ut.

   Det höll inte vid kontrollräkning. Kontot handlar bara grad A och B, och på
   just den delmängden krymper skillnaderna till brus (60 dagar, fyllda A/B):

     familj   per dag   träff   snitt R
     trend      47,8     34 %   −0,062
     brott      21,1     32 %   −0,081
     ict        13,1     35 %   −0,001
     svep        2,4     30 %   −0,117
     orb         2,0     31 %   −0,030

   Svep, som var tillåten, är alltså sämst av alla. Spärren stängde ute 80 % av
   affärerna utan att det den skyddade mot var mätbart sämre än det den släppte
   fram — och den hann tacka nej till en trendaffär som nådde sitt mål.

   Ingen familj har positiv förväntan i historiken. Skillnaderna mellan dem är
   för små för att sortera på. Därför handlas allt igen: det är låtsaspengar,
   och framåtriktad data på riktiga fyllningar är värd mer än en gissning
   byggd på 60 dagars backspegel. Sätt en familj till false här om den visar
   sig förlora på riktigt — då finns det något att luta sig mot. */
/* Vilka familjer som får öppna affärer i demokontot.

   Läxan från förra spärren står kvar: mät på den delmängd som faktiskt handlas
   (grad A och B), inte på allt motorn genererar. Siffrorna nedan är snitt-R per
   setup på A/B, 60 dagars MNQ delat i fyra lika långa tidsblock:

     familj   totalt   block 1   block 2   block 3   block 4      n
     svep     +0,095    +0,257    −0,438    +0,265    +0,513      88
     orb      +0,042    +0,291    −0,037    −0,553    +0,504      56
     ict      +0,020    −0,002    +0,001    +0,036    +0,042     635
     trend    −0,048    −0,151    −0,077    +0,208    −0,159   1 929
     brott    −0,136    −0,202    −0,081    −0,037    −0,241     909
     moment   −0,162    −0,047    −0,496    +0,211    −0,332     405

   Range-brott är negativ i alla fyra blocken, i båda mätningarna som gjorts, på
   nio hundra affärer. Det är det enda som varit stabilt över huvud taget, och
   familjen stängs därför av. Intradagsmomentum är ny och mäter träff 40 % — bäst
   av alla — men negativ R: tidsutgången klipper vinnarna medan förlorarna tar hela
   stoppen. Den visas som signal men handlas inte förrän den mäter positivt. */
/* Alla familjer påslagna: kontot ska ta varje aktiv signal panelen visar.
   Det är ett medvetet val framför mätningen ovan — spärrarna byggde på 60 dagars
   uppspelning, och kontot är nu i stället ett framåtriktat test av alla sex
   familjerna på samma villkor. Sätt en familj till false när kontots egen
   historik motiverar det. */
const FAM_HANDLAS = { trend:true, svep:true, brott:true, ict:true, orb:true, moment:true };
const FAM_N = Object.keys(FAM).length;
const GRADE_RANK = { A:0, B:1, C:2 };

/* Rangen som ett brott mäts mot: öppningsrangen om den finns, annars en box
   av de senaste staplarna utan de allra färskaste — annars syns aldrig brottet. */
function rangeBox(ctx){
  if(ctx.or) return { h:ctx.or.h, l:ctx.or.l, or:true };
  const b = ctx.bars.slice(-30, -3);
  if(!b.length) return { h:ctx.px + ctx.atr, l:ctx.px - ctx.atr, or:false };
  return { h:Math.max(...b.map(x=>x.h)), l:Math.min(...b.map(x=>x.l)), or:false };
}

/* --------------------------------------------------------------------------
   ICT — likviditetssvep, market structure shift och entry i FVG eller OTE.

   Kedjan som letas: priset tar ut en tidigare swingnivå (stopparna), stänger
   tillbaka innanför, och bryter sedan strukturen åt andra hållet. Rörelsen som
   bryter strukturen lämnar oftast en obalans (fair value gap) efter sig — den
   är entryn. Saknas gapet används 70,5 %-retracementet av benet (OTE).
   Stoppen ligger bortom svepet, målet vid nästa likviditetsklump.
   -------------------------------------------------------------------------- */
function ictKillzone(ms){
  const m = minutesNY(ms);
  if(m >= 510 && m <= 660) return 'New York AM';        // 08:30–11:00
  if(m >= 120 && m <= 300) return 'London';             // 02:00–05:00
  if(m >= 810 && m <= 960) return 'New York PM';        // 13:30–16:00
  return null;
}

function ictState(ctx){
  const bars = ctx.bars, n = bars.length, A = ctx.atr, px = ctx.px;
  if(n < 70 || !(A > 0)) return null;
  const sw = swings(bars, 2);
  const LOOK = 30;                                      // svepet ska vara färskt

  const trySide = dir => {
    const pool = dir > 0 ? sw.lo : sw.hi;               // likviditeten som ska tas
    const opp  = dir > 0 ? sw.hi : sw.lo;               // strukturen som ska brytas

    // 1. svep: en stapel tar ut senaste swingnivån och stänger tillbaka innanför
    let sweepIx = -1, lvl = null;
    for(let i = n - 2; i >= n - LOOK; i--){
      const prior = pool.filter(x => x.i <= i - 2 && x.i >= i - 60).slice(-1)[0];
      if(!prior) continue;
      const b = bars[i];
      const took = dir > 0 ? b.l < prior.p : b.h > prior.p;
      const back = dir > 0 ? b.c > prior.p : b.c < prior.p;
      if(took && back){ sweepIx = i; lvl = prior.p; break; }
    }
    if(sweepIx < 0) return null;

    // 2. market structure shift: stängning bortom senaste motsatta swingpunkt
    const oppPrior = opp.filter(x => x.i < sweepIx && x.i >= sweepIx - 40).slice(-1)[0];
    if(!oppPrior) return null;
    let mssIx = -1;
    for(let j = sweepIx + 1; j < n; j++){
      if(dir > 0 ? bars[j].c > oppPrior.p : bars[j].c < oppPrior.p){ mssIx = j; break; }
    }
    if(mssIx < 0) return null;

    // 3. benet som bröt strukturen
    const leg = bars.slice(sweepIx, n);
    const legLo = Math.min.apply(null, leg.map(b => b.l));
    const legHi = Math.max.apply(null, leg.map(b => b.h));
    if(legHi - legLo < 0.8*A) return null;              // för litet ben för att handla
    const eq = (legHi + legLo)/2;                       // jämvikt: premium över, discount under

    // 4. senaste ofyllda fair value gap i benet
    let fvg = null;
    for(let k = n - 2; k > sweepIx; k--){
      const a = bars[k-1], c = bars[k+1];
      if(!a || !c) continue;
      const z = dir > 0 ? (a.h < c.l ? {lo:a.h, hi:c.l} : null)
                        : (a.l > c.h ? {lo:c.h, hi:a.l} : null);
      if(!z || z.hi - z.lo < 0.10*A) continue;
      const filled = bars.slice(k + 2).some(b => dir > 0 ? b.l <= z.lo : b.h >= z.hi);
      if(filled) continue;
      const bortom = dir > 0 ? px > z.lo : px < z.hi;   // gapet ska ligga bakom priset
      if(!bortom) continue;
      fvg = z; break;
    }

    // 5. entry: gapets mitt, annars OTE 70,5 % av benet
    const ote = dir > 0 ? legHi - 0.705*(legHi - legLo) : legLo + 0.705*(legHi - legLo);
    const entry = fvg ? (fvg.lo + fvg.hi)/2 : ote;
    if(dir > 0 ? entry >= px + 0.15*A : entry <= px - 0.15*A) return null;   // hann redan förbi

    // 6. stopp bortom svepet, mål vid nästa likviditetsklump
    const sl = dir > 0 ? Math.min(legLo, lvl) - 0.15*A : Math.max(legHi, lvl) + 0.15*A;
    const liqPool = (dir > 0 ? sw.hi : sw.lo).filter(x => dir > 0 ? x.p > px : x.p < px);
    let liq = liqPool.length ? (dir > 0 ? Math.min.apply(null, liqPool.map(x => x.p))
                                        : Math.max.apply(null, liqPool.map(x => x.p)))
                             : (dir > 0 ? legHi + (legHi - legLo) : legLo - (legHi - legLo));
    if(ctx.prev) liq = dir > 0 ? Math.max(liq, Math.min(ctx.prev.h, px + 3*A))
                               : Math.min(liq, Math.max(ctx.prev.l, px - 3*A));

    return {
      dir, entry, sl, liq, fvg, ote, eq,
      discount: dir > 0 ? entry < eq : entry > eq,
      kz: ictKillzone(bars[n-1].t),
      svept: lvl, mssNiva: oppPrior.p, sweepIx,
      alder: n - 1 - sweepIx
    };
  };

  return trySide(1) || trySide(-1);
}

/* Rangen som låg före rörelsen: väx bakåt från stapel `slut` så länge boxen
   håller sig under 2,2 ATR. Ger en riktig konsolidering i stället för ett
   godtyckligt antal staplar — ett trendben faller bort av sig självt. */
function tightRange(bars, slut, A){
  if(slut < 8) return null;
  let hi = -Infinity, lo = Infinity, i = slut, n = 0;
  for(; i >= 0 && n < 60; i--, n++){
    const h = Math.max(hi, bars[i].h), l = Math.min(lo, bars[i].l);
    if(n >= 6 && (h - l) > 2.2*A) break;
    hi = h; lo = l;
  }
  return n >= 8 ? { h:hi, l:lo, from:i + 1, to:slut, n } : null;
}

/* +1 = familjen talar för uppgång, -1 för nedgång, 0 = neutral just nu. */
/* Var står priset mot öppningsrangen, och har brottet bekräftats av en
   stängd stapel? Returnerar null utanför RTH, innan rangen är klar, eller
   när priset fortfarande ligger inne i den. */
function orbLage(ctx){
  const OR = ctx.or;
  if(!OR || !OR.klar || !(OR.bredd > 0)) return null;
  const m = ctx.minNY;
  if(m < 600 || m >= 950) return null;              // först efter 10:00, och inte i stängningen
  const bars = ctx.bars, n = bars.length;
  const sista = bars[n-1];

  // Bekräftelsen: senaste stängda stapeln ska ha stängt utanför kanten.
  let dir = 0;
  if(sista.c > OR.h) dir = 1;
  else if(sista.c < OR.l) dir = -1;
  if(!dir) return null;

  // Hur länge sedan brottet skedde — ett färskt brott är något annat än ett
  // pris som legat utanför i två timmar.
  let sedan = 0;
  for(let i = n-1; i >= Math.max(0, n-40); i--){
    const c = bars[i].c;
    if(dir > 0 ? c > OR.h : c < OR.l) sedan++;
    else break;
  }

  // Dubbelbrott: har priset varit utanför åt andra hållet tidigare idag är
  // dagen hackig. NQ dubbelbryter 30-minutersrangen 39 procent av dagarna.
  let dubbel = false;
  for(let i = Math.max(0, n-80); i < n; i++){
    const c = bars[i].c;
    if(dir > 0 ? c < OR.l : c > OR.h){ dubbel = true; break; }
  }

  return { dir, sedan, dubbel, niva: dir > 0 ? OR.h : OR.l, bredd: OR.bredd, riktning: OR.riktning };
}

/* --------------------------------------------------------------------------
   Brusbandet — hur långt priset normalt hinner från dagens öppning.

   Idén kommer från den publicerade intradagsmomentum-strategin på ES och NQ
   (38 % träff, utdelningskvot 2,25, Sharpe 1,67 på 2010–2026). Den mäter hur
   stor dagens rörelse brukar vara vid den här tiden på dygnet, drar ett band
   runt öppningskursen, och tar rörelsen först när priset lämnar bandet — då
   är det inte längre brus utan obalans mellan köpare och säljare.

   Originalet använder fjorton dagars historik per klockslag. Vi har sällan mer
   än ett par sessioner i fönstret, så bandet skattas i stället ur de senaste
   fullständiga sessionernas storlek och skalas med roten ur tiden, vilket är
   den vanliga approximationen: rörelsen växer med √t, inte linjärt.
   -------------------------------------------------------------------------- */
const RTH_START = 570, RTH_SLUT = 960;         // 09:30 och 16:00 New York-tid

function brusband(ctx){
  const bars = ctx.bars, n = bars.length;
  if(n < 80) return null;

  // Dela upp i sessioner: RTH-staplar per handelsdag.
  const dagar = new Map();
  for(let i = 0; i < n; i++){
    const m = minutesNY(bars[i].t);
    if(m < RTH_START || m >= RTH_SLUT) continue;
    const d = dayKeyNY(bars[i].t);
    if(!dagar.has(d)) dagar.set(d, []);
    dagar.get(d).push(bars[i]);
  }
  const nycklar = [...dagar.keys()].sort();
  if(!nycklar.length) return null;

  const idag = nycklar[nycklar.length - 1];
  const iRth = dagar.get(idag);
  if(!iRth || iRth.length < 3) return null;                 // vänta in de första staplarna

  // Så stor brukar en hel session vara, mätt som |stängning/öppning − 1|.
  const fardiga = nycklar.slice(0, -1).slice(-4)
    .map(k => dagar.get(k))
    .filter(d => d.length >= 40);                           // halva sessioner duger inte
  let sigma;
  if(fardiga.length >= 2){
    sigma = fardiga.reduce((s2, d) => s2 + Math.abs(d[d.length-1].c/d[0].o - 1), 0) / fardiga.length;
  }else{
    sigma = (ctx.atr * 9) / ctx.px;                         // grov reserv när historiken är tunn
  }
  sigma = clamp(sigma, 0.0015, 0.05);

  const oppning = iRth[0].o;
  const minuter = minutesNY(bars[n-1].t) - RTH_START;
  const andel = clamp(minuter/(RTH_SLUT - RTH_START), 0.02, 1);
  const bredd = oppning * sigma * Math.sqrt(andel);

  return {
    oppning, sigma, minuter,
    ovre: oppning + bredd,
    undre: oppning - bredd,
    bredd,
    slutTid: bars[n-1].t + (RTH_SLUT - minutesNY(bars[n-1].t))*60000   // när sessionen stänger
  };
}

/* Läget mot bandet: utanför = momentum, innanför = brus. */
function momentLage(ctx){
  const m = ctx.minNY;
  if(m < RTH_START + 45 || m > RTH_SLUT - 15) return null;   // inte i öppningsröran, inte i slutminuterna
  const b = brusband(ctx);
  if(!b || !(b.bredd > 0)) return null;
  const px = ctx.px;
  const dir = px > b.ovre ? 1 : px < b.undre ? -1 : 0;
  if(!dir) return null;
  const over = dir > 0 ? (px - b.ovre)/b.bredd : (b.undre - px)/b.bredd;
  return { ...b, dir, over };
}

function familyVotes(ctx){
  const px = ctx.px, A = ctx.atr;
  const vw = nz(ctx.vwap) ? ctx.vwap : px;
  const v = { trend:0, svep:0, brott:0, ict:0, orb:0, moment:0 };
  const ict = ctx.ict !== undefined ? ctx.ict : (ctx.ict = ictState(ctx));

  // 1. Trendfortsättning — EMA-stacken och läget mot VWAP
  if(ctx.trend > 12 && px > vw) v.trend = 1;
  else if(ctx.trend < -12 && px < vw) v.trend = -1;

  // 2. Likviditetssvep — en tidigare extrempunkt har svepts och tagits tillbaka
  const recent = ctx.bars.slice(-16), before = ctx.bars.slice(-40, -16);
  if(recent.length && before.length){
    const priorLo = Math.min(...before.map(b=>b.l)), priorHi = Math.max(...before.map(b=>b.h));
    const recLo   = Math.min(...recent.map(b=>b.l)), recHi   = Math.max(...recent.map(b=>b.h));
    if(recLo < priorLo && px > priorLo + 0.25*A) v.svep = 1;        // svept och tagit tillbaka nivån
    else if(recHi > priorHi && px < priorHi - 0.25*A) v.svep = -1;
  }

  // 3. Range-brott — kanten bruten och volymen med på noterna.
  // Den pågående stapeln är halvfärdig, så volymen mäts på de tre senaste.
  const vols = ctx.bars.slice(-60).map(b=>b.v).filter(x=>x>0);
  const avgV = vols.length ? vols.reduce((a,b)=>a+b,0)/vols.length : 0;
  const last3 = ctx.bars.slice(-3).map(b=>b.v).filter(x=>x>0);
  const relV3 = (avgV && last3.length) ? (last3.reduce((a,b)=>a+b,0)/last3.length)/avgV : 1;
  // Rangen mäts fram till strax före brottet, och brottet ska vara färskt.
  const n = ctx.bars.length;
  const boxes = [];
  [4, 8, 14, 20].forEach(back => {                // olika startpunkter — rörelsen kan vara olika gammal
    const r = tightRange(ctx.bars, n - 1 - back, A);
    if(r) boxes.push(r);
  });
  if(ict){                                        // har ett svep skett är rangen den som låg före svepet
    const r = tightRange(ctx.bars, ict.sweepIx - 1, A);
    if(r) boxes.push(r);
  }
  if(ctx.or) boxes.push({ h:ctx.or.h, l:ctx.or.l });
  const c20 = ctx.bars.slice(-20).map(b=>b.c);
  if(relV3 >= 0.95 || ctx.relVol >= 1.2){
    for(const bx of boxes){
      const hgt = bx.h - bx.l;
      if(hgt < 0.8*A || hgt > 2.6*A) continue;      // smalare = brus, bredare = trendben
      if(px > bx.h + 0.25*A && c20.some(c => c <= bx.h)){ v.brott = 1; break; }
      if(px < bx.l - 0.25*A && c20.some(c => c >= bx.l)){ v.brott = -1; break; }
    }
  }

  // 4. ICT — svep av likviditet följt av strukturbrott åt andra hållet
  if(ict) v.ict = ict.dir;

  // 5. Öppningsrange — den enda familjen med publicerad statistik bakom sig.
  // Mätt på 6 142 ES- och NQ-dagar fortsätter ett brott av 30-minutersrangen
  // i brottets riktning i drygt 70 procent av fallen när bekräftelsen är en
  // stängd 5-minutersstapel utanför kanten, mot 67 procent på bara en wick.
  // Vi kräver därför stängning, och bara medan RTH pågår.
  const orb = orbLage(ctx);
  if(orb) v.orb = orb.dir;

  // 6. Intradagsmomentum — priset har lämnat dagens brusband
  const mo = momentLage(ctx);
  if(mo) v.moment = mo.dir;

  return v;
}

function gradeFor(ctx, side){
  const dir = side === 'long' ? 1 : -1;
  const v = ctx.votes || familyVotes(ctx);
  const backers = Object.keys(FAM).filter(k => v[k] === dir);
  const against = Object.keys(FAM).filter(k => v[k] === -dir);
  return {
    grade: backers.length >= 3 ? 'A' : backers.length === 2 ? 'B' : 'C',   // 3–4 = A, 2 = B, annars C
    backers, against, n: backers.length
  };
}
const LIVE = new Map();   // id -> {triggered, hitTp, hitSl, at, entryPx, sig}
const SEDD = new Map();   // id -> låg priset före entryn förra gången vi tittade?

function moveBounds(ctx){
  if(ctx.inst.key === 'NQ') return { min: MOTORCFG.minPts, max: MOTORCFG.maxPts };
  const lo = MOTORCFG.minPts/23150, hi = MOTORCFG.maxPts/23150;   // samma % som NQ-spannet
  return { min: ctx.px*lo, max: ctx.px*hi };
}

/* ---- Målsökning: tekniska nivåer viktade mot makroläget ---- */
function sessionReachFactor(){
  const {wd,h,m} = nyParts();
  const mins = h*60+m;
  if(wd==='Sat' || wd==='Sun') return 0.75;
  if(mins >= 570 && mins < 960){                 // RTH
    const left = 960 - mins;
    if(left < 30) return 0.42;
    if(left < 60) return 0.60;
    if(left < 120) return 0.80;
    return 1.0;
  }
  if(mins >= 240 && mins < 570) return 0.88;     // förhandel
  return 0.72;                                   // globex/efterhandel
}

function targetCandidates(ctx){
  const c = [], px = ctx.px;
  const add = (p,w,n)=>{ if(nz(p) && p>0) c.push({p,w,n}); };
  if(ctx.prev){
    add(ctx.prev.h, 1.00, 'Gårdagens högsta (PDH)');
    add(ctx.prev.l, 1.00, 'Gårdagens lägsta (PDL)');
    add(ctx.prev.mid, 0.55, 'Gårdagens mittpunkt');
  }
  if(ctx.today){
    add(ctx.today.h, 0.92, 'Dagens högsta');
    add(ctx.today.l, 0.92, 'Dagens lägsta');
  }
  if(ctx.or){
    const h = ctx.or.h - ctx.or.l;
    add(ctx.or.h, 0.82, 'Öppningsrangens tak');
    add(ctx.or.l, 0.82, 'Öppningsrangens golv');
    add(ctx.or.h + h, 0.72, 'ORB mätt rörelse uppåt');
    add(ctx.or.l - h, 0.72, 'ORB mätt rörelse nedåt');
  }
  add(ctx.vwap, 0.86, 'VWAP');
  add(ctx.e50,  0.58, 'EMA 50');
  add(ctx.e200, 0.66, 'EMA 200');
  ctx.recentHi.forEach(s=> add(s.p, 0.72, 'Swinghögsta'));
  ctx.recentLo.forEach(s=> add(s.p, 0.72, 'Swinglägsta'));
  const step = ctx.inst.key==='NQ' ? 50 : 10;
  const anchor = Math.round(px/step)*step;
  for(let k=-9;k<=9;k++){
    const q = anchor + k*step;
    const major = ctx.inst.key==='NQ' ? (q % 100 === 0) : (q % 50 === 0);
    add(q, major ? 0.62 : 0.40, major ? 'Stor rund nivå' : 'Rund nivå');
  }
  return c;
}

function pickTarget(ctx, side, entry, sl, o){
  const dir = side==='long' ? 1 : -1;
  const A = ctx.atr, b = moveBounds(ctx);
  const risk = Math.abs(entry - sl);

  // 1. Teknisk grundräckvidd
  let reach = Math.max(2.2*A, risk*1.8);

  // 2. Makro: nyhetsbias + trendstruktur sträcker ut eller drar in målet
  const align = clamp(((ctx.newsBias||0)/100*0.55 + ctx.trend/100*0.45) * dir, -1, 1);
  reach *= (1 + align*0.40);

  // 3. Hur mycket tid är kvar av sessionen
  const tf = sessionReachFactor();
  reach *= tf;
  reach = clamp(reach, b.min, b.max);

  const cands = ctx._tc || (ctx._tc = targetCandidates(ctx));
  let best = null;
  for(const cd of cands){
    const d = dir*(cd.p - entry);
    if(d < b.min*0.95 || d > b.max) continue;

    let conf = 0;                                   // konfluens: nivåer som klumpar ihop sig
    for(const o2 of cands){
      if(o2 !== cd && Math.abs(o2.p - cd.p) < 0.35*A) conf += o2.w*0.45;
    }
    const rr = d/risk;
    let sc = cd.w + Math.min(conf, 1.2);
    sc *= Math.exp(-Math.pow((d - reach)/(reach*0.62), 2));   // närmast rimlig räckvidd vinner
    if(rr < 1.2) sc *= 0.35; else if(rr >= 2) sc *= 1.15;
    if(o && nz(o.preferPrice) && Math.abs(cd.p - o.preferPrice) < 0.35*A) sc *= 1.7;
    if(!best || sc > best.sc) best = {sc, p:cd.p, n:cd.n, d, rr, conf};
  }

  const macroTxt = align > 0.30 ? 'makro och struktur i medvind — målet sträcks ut'
                 : align < -0.30 ? 'makro emot riktningen — målet dras in'
                 : 'makro neutralt — målet sätts på ren teknik';
  const timeTxt  = tf < 0.65 ? ' Sent på sessionen, så räckvidden är nedskalad.' : '';

  if(!best){
    const d = clamp(reach, b.min, b.max);
    return { tp: entry + dir*d, basis:'ATR-projektion — ingen tydlig nivå inom räckhåll',
             macro:macroTxt + '.' + timeTxt, align, conf:false };
  }
  const tp = best.p - dir*Math.min(0.15*A, best.d*0.08);   // lägg målet strax innanför nivån
  return {
    tp,
    basis: best.n + ' vid ' + fmt(best.p, ctx.inst.dec),
    macro: macroTxt + '.' + timeTxt,
    align, conf: best.conf > 0.45
  };
}

function makeSignal(ctx, o){
  const b = moveBounds(ctx);
  const dir = o.side === 'long' ? 1 : -1;
  let entry = o.entry, sl = o.sl;

  let risk = Math.abs(entry - sl);
  risk = clamp(risk, ctx.atr*0.55, ctx.atr*3.2);
  sl = entry - dir*risk;

  // ---- ETT mål, valt ur tekniska nivåer och viktat mot makroläget ----
  const T = pickTarget(ctx, o.side, entry, sl, o);
  let t = clamp(Math.abs(T.tp - entry), b.min, b.max);
  const tp = entry + dir*t;

  const id = ctx.inst.key + '-' + o.fam + '-' + o.side + '-' + Math.round(entry*10);
  const trigger = o.trigger || 'limit';
  const reachSign = (trigger === 'stop') ? dir : -dir;
  const reached = reachSign*(ctx.px - entry) >= 0;
  const gap = Math.abs(ctx.px - entry);

  const invalid = (dir*(ctx.px - sl) <= 0)
               || (dir*(ctx.px - tp) >= 0)
               || (reached && gap > 0.75*ctx.atr && !LIVE.has(id));

  const rr = t/risk;
  const dist = gap;
  const storlek = positionsStorlek(ctx.inst.key, risk, t);

  // ---- konfidens ----
  let c = 44;
  const aligned = (o.side==='long' && ctx.trend>0) || (o.side==='short' && ctx.trend<0);
  c += aligned ? Math.abs(ctx.trend)*0.22 : -Math.abs(ctx.trend)*0.13;
  if(o.side==='long'  && ctx.rsi>=42 && ctx.rsi<=68) c += 7;
  if(o.side==='short' && ctx.rsi>=32 && ctx.rsi<=58) c += 7;
  if(o.fam==='svep'){
    if(o.side==='long'  && ctx.rsi < 36) c += 11;
    if(o.side==='short' && ctx.rsi > 66) c += 11;
  }
  if(ctx.relVol > 1.25) c += 6; else if(ctx.relVol < 0.6) c -= 5;
  if(rr >= 2) c += 7; else if(rr < 1.3) c -= 8;
  if(dist < ctx.atr*0.5) c += 6;
  if(dist > ctx.atr*3)   c -= 9;
  if(T.conf) c += 5;                       // målet ligger i en konfluenszon
  c += Math.round(T.align*7);              // makro drar konfidensen med sig
  const nb = (ctx.newsBias||0);
  if(nb !== 0) c += ((o.side==='long') === (nb>0) ? 1 : -1) * Math.min(12, Math.abs(nb)*0.12);
  c += (o.bonus||0);
  // graden väger tyngst: en A-setup har alla tre familjerna bakom sig
  const G = gradeFor(ctx, o.side);
  c += G.grade==='A' ? 15 : G.grade==='B' ? 7 : (G.n ? 0 : -6);
  c -= G.against.length * 4;
  c = clamp(Math.round(c), 12, 93);

  // Dragen och modellens svar. p = sannolikhet att målet nås före stoppen,
  // ev = förväntat utfall i R om affären tas (p*rr − (1−p)*1).
  const x = drag(ctx, o, rr, dist, G);
  const p = aiSannolikhet(x);
  const ev = p === null ? null : p*rr - (1-p);

  return {
    id, trigger, reachSign, inst:ctx.inst.key, instLabel:ctx.inst.label,
    x, ai: p === null ? null : Math.round(p*100), ev,
    dec:ctx.inst.dec, unit:ctx.inst.unit,
    fam:o.fam, famName:FAM[o.fam]||'', grade:G.grade, backers:G.backers, backN:G.n, against:G.against,
    side:o.side, name:o.name, entry, sl, tp,
    risk, ptsTp:t, rr, conf:c, why:o.why||[], invalid,
    stangVid: o.stangVid || null,                  // tidsutgång: stäng här oavsett pris
    kontrakt:storlek.kontrakt, riskUsd:storlek.riskUsd, malUsd:storlek.malUsd,
    riskPerKontrakt:storlek.perKontrakt, overRisk:storlek.overRisk,
    tpBasis:T.basis, tpMacro:T.macro, tpAlign:T.align,
    dist, atr:ctx.atr, bars:ctx.bars, ctxPx:ctx.px, status:'VÄNTAR'
  };
}

function generateSignals(ctx){
  const S = [], rm = RISK_MULT[MOTORCFG.risk] || 1.3, A = ctx.atr, px = ctx.px;
  ctx.votes = familyVotes(ctx);                    // vad de tre familjerna säger just nu
  const up = ctx.trend > 12, dn = ctx.trend < -12;
  const swLo = ctx.recentLo.length ? last(ctx.recentLo).p : (ctx.today ? ctx.today.l : px - 3*A);
  const swHi = ctx.recentHi.length ? last(ctx.recentHi).p : (ctx.today ? ctx.today.h : px + 3*A);
  const vw = nz(ctx.vwap) ? ctx.vwap : px;
  const e21 = nz(ctx.e21) ? ctx.e21 : px;
  const T = ctx.today, P = ctx.prev, OR = ctx.or;

  /* ---------- FAMILJ 1 · TRENDFORTSÄTTNING ---------- */
  {
    const entry = clamp(Math.max(e21, vw - 0.2*A), px - 1.8*A, px + 0.35*A);
    S.push(makeSignal(ctx, {
      fam:'trend', trigger:'limit', side:'long', name:'Trendfortsättning — pullback till EMA21 / VWAP',
      entry, sl: Math.min(entry - rm*A, swLo - 0.25*A),
      bonus: up ? 8 : -12,
      why:[
        up ? 'EMA-stacken är positiv (9 > 21 > 50) och priset handlas över VWAP — köparna har kontrollen.'
           : 'Strukturen är inte renodlat positiv — detta är en motrörelse-setup med lägre vikt.',
        'Köpet läggs i pullbacken mot EMA21/VWAP i stället för att jaga rörelsen.',
        'Stoppen sitter under senaste swinglow så att setupen är tekniskt falsifierbar.'
      ]
    }));
  }
  {
    const entry = clamp(Math.min(e21, vw + 0.2*A), px - 0.35*A, px + 1.8*A);
    S.push(makeSignal(ctx, {
      fam:'trend', trigger:'limit', side:'short', name:'Trendfortsättning — studs upp till EMA21 / VWAP',
      entry, sl: Math.max(entry + rm*A, swHi + 0.25*A),
      bonus: dn ? 8 : -12,
      why:[
        dn ? 'EMA-stacken är negativ och priset ligger under VWAP — säljarna styr.'
           : 'Trenden stödjer inte fullt ut; behandla som avlastningsaffär mot motstånd.',
        'Säljet tas i studsen mot EMA21/VWAP där utbudet historiskt kommit in.',
        'Stoppen ligger ovanför senaste swinghigh.'
      ]
    }));
  }

  /* ---------- FAMILJ 2 · LIKVIDITETSSVEP / VÄNDNING ---------- */
  const lowRef  = P ? Math.min(P.l, T?T.l:P.l) : (T?T.l:px-4*A);
  const highRef = P ? Math.max(P.h, T?T.h:P.h) : (T?T.h:px+4*A);
  {
    const entry = lowRef + 0.30*A;
    S.push(makeSignal(ctx, {
      fam:'svep', trigger:'limit', side:'long', name:'Likviditetssvep under dagslägsta + reclaim',
      entry, sl: lowRef - rm*0.85*A, preferPrice: vw,
      bonus: ctx.rsi < 40 ? 6 : 0,
      why:[
        'Under förra sessionens/dagens lägsta ligger en klump stopporder — ett svep dit hämtar likviditet.',
        'Signalen aktiveras först när priset återtar nivån (reclaim), inte på själva svepet.',
        'VWAP är den naturliga magneten efter ett falskt utbrott nedåt.'
      ]
    }));
  }
  {
    const entry = highRef - 0.30*A;
    S.push(makeSignal(ctx, {
      fam:'svep', trigger:'limit', side:'short', name:'Likviditetssvep över dagshögsta + avvisning',
      entry, sl: highRef + rm*0.85*A, preferPrice: vw,
      bonus: ctx.rsi > 62 ? 6 : 0,
      why:[
        'Stopparna över dagshögsta är målet — svep följt av avvisning är en klassisk fälla.',
        'Kräver att 5m-stapeln stänger tillbaka under nivån innan entry.',
        'VWAP är första riktiga stödet på vägen ned.'
      ]
    }));
  }

  /* ---------- FAMILJ 6 · INTRADAGSMOMENTUM ----------
     Priset har lämnat det spann dagen brukar hålla sig inom. Stoppen läggs
     tillbaka vid bandkanten eller VWAP — vänder priset in i bandet igen var
     rörelsen brus. Affären har dessutom en tidsutgång: den stängs när
     sessionen stänger, för det är så strategin är mätt. */
  const mo = momentLage(ctx);
  if(mo){
    const upp = mo.dir > 0;
    const kant = upp ? mo.ovre : mo.undre;
    const entry = px + (upp ? 0.05*A : -0.05*A);
    const vwStop = upp ? Math.min(vw, kant) : Math.max(vw, kant);
    const sl = upp ? Math.min(kant, vwStop) : Math.max(kant, vwStop);
    let bonus = 0;
    if(mo.over > 0.5) bonus += 6;                     // rejält utanför bandet
    if(mo.over < 0.12) bonus -= 5;                    // knappt utanför, lätt att falla tillbaka
    if((upp && ctx.trend > 20) || (!upp && ctx.trend < -20)) bonus += 5;
    if(ctx.relVol > 1.2) bonus += 4;
    S.push(makeSignal(ctx, {
      fam:'moment', trigger:'stop', side: upp ? 'long' : 'short',
      name: upp ? 'Intradagsmomentum — ut ur brusbandet uppåt'
                : 'Intradagsmomentum — ut ur brusbandet nedåt',
      entry, sl,
      preferPrice: kant + (upp ? mo.bredd : -mo.bredd),
      stangVid: mo.slutTid,
      bonus,
      why:[
        'Dagens brusband ligger mellan ' + fmt(mo.undre, ctx.inst.dec) + ' och ' + fmt(mo.ovre, ctx.inst.dec) +
          ' — det spann marknaden brukar hålla sig inom så här långt in på sessionen.',
        'Priset är ' + (mo.over*100).toFixed(0) + ' % av en bandbredd utanför kanten, vilket är obalans snarare än brus.',
        'Stoppen ligger tillbaka vid kanten eller VWAP, och affären stängs vid sessionens slut oavsett var priset står.'
      ]
    }));
  }

  /* ---------- FAMILJ 5 · ÖPPNINGSRANGE (ORB) ----------
     Reglerna kommer från statistiken, inte från magkänsla:
       · bekräftelse = stängd 5m-stapel utanför kanten (71,5 % fortsättning på NQ
         mot 67 % på wick)
       · stoppen läggs inne i rangen, vid mitten — mätt maximal motrörelse är
         omkring 30–40 % av dagens ATR, alltså långt innanför andra kanten
       · målet är en hel rangebredd bortom kanten (1,0× extension nås i 64 % av
         fallen på 5-minutersrangen)
       · uppåtbrott är historiskt 8–10 procentenheter starkare än nedåt, och en
         öppningsrange som stänger i sin övre halva pekar oftast ut riktningen */
  const orb = orbLage(ctx);
  if(orb && OR){
    const upp = orb.dir > 0;
    const entry = orb.niva + (upp ? 0.05*A : -0.05*A);
    const mitt  = OR.mid;
    const sl    = upp ? Math.max(mitt, entry - 1.7*A) : Math.min(mitt, entry + 1.7*A);
    let bonus = 0;
    if(orb.dubbel) bonus -= 10;                       // hackig dag, båda sidor testade
    if(orb.sedan > 8) bonus -= 6;                     // brottet är gammalt
    if(orb.sedan <= 2) bonus += 5;                    // färskt
    if(upp) bonus += 4;                               // uppåtasymmetrin
    if((upp && orb.riktning > 0.2) || (!upp && orb.riktning < -0.2)) bonus += 6;
    if(orb.bredd > 2.2*A) bonus += 5;                 // vid range = starkare fortsättning
    if(orb.bredd < 0.9*A) bonus -= 6;                 // hopklämd öppning = brus
    S.push(makeSignal(ctx, {
      fam:'orb', trigger:'stop', side: upp ? 'long' : 'short',
      name: upp ? 'Öppningsrangen bruten uppåt (ORB)' : 'Öppningsrangen bruten nedåt (ORB)',
      entry, sl, preferPrice: orb.niva + (upp ? orb.bredd : -orb.bredd),
      bonus,
      why:[
        'Öppningsrangen 09:30–10:00 är ' + fmt(orb.bredd, ctx.inst.dec) + ' punkter bred och ' +
          (upp ? 'högsta' : 'lägsta') + ' är bruten med en stängd 5-minutersstapel.',
        orb.dubbel ? 'Båda kanterna har testats idag — dubbelbrott betyder hackig dag och sänkt vikt.'
                   : 'Bara den här kanten har brutits idag, vilket historiskt är det renare fallet.',
        'Stoppen ligger inne i rangen vid mitten, målet en hel rangebredd bortom kanten.'
      ]
    }));
  }

  /* ---------- FAMILJ 3 · RANGE-BROTT / MOMENTUM ---------- */
  const box = rangeBox(ctx);
  const boxH = box.h, boxL = box.l;
  {
    const entry = boxH + 0.12*A;
    S.push(makeSignal(ctx, {
      fam:'brott', trigger:'stop', side:'long', name: OR ? 'Brott av öppningsrange (ORB) uppåt' : 'Brott av konsolideringsbox uppåt',
      entry, sl: Math.max(boxL - 0.15*A, entry - rm*1.5*A),
      preferPrice: boxH + (boxH-boxL),
      bonus: (ctx.relVol > 1.2 ? 6 : -2) + (up ? 4 : 0),
      why:[
        OR ? 'Öppningsrangen (första 30 min RTH) är dagens viktigaste referens — brott uppåt ger ofta trenddag.'
           : 'Priset har komprimerats i en box; ett brott uppåt frigör riktningsenergi.',
        'Kräver volymexpansion — brott på tunn volym är oftast falska.',
        'Målet söks i boxens mätta rörelse eller närmaste strukturnivå ovanför.'
      ]
    }));
  }
  {
    const entry = boxL - 0.12*A;
    S.push(makeSignal(ctx, {
      fam:'brott', trigger:'stop', side:'short', name: OR ? 'Brott av öppningsrange (ORB) nedåt' : 'Brott av konsolideringsbox nedåt',
      entry, sl: Math.min(boxH + 0.15*A, entry + rm*1.5*A),
      preferPrice: boxL - (boxH-boxL),
      bonus: (ctx.relVol > 1.2 ? 6 : -2) + (dn ? 4 : 0),
      why:[
        'Brott under rangens golv öppnar för fortsatt distribution.',
        'Undvik om VWAP ligger tätt under — då är risken hög för snabb reclaim.',
        'Målet söks i boxens mätta rörelse eller närmaste strukturnivå under.'
      ]
    }));
  }

  /* ---------- FAMILJ 4 · ICT — svep, MSS och entry i FVG/OTE ---------- */
  const ict = ctx.ict !== undefined ? ctx.ict : (ctx.ict = ictState(ctx));
  if(ict){
    const lang = ict.dir > 0;
    S.push(makeSignal(ctx, {
      fam:'ict', trigger:'limit', side: lang ? 'long' : 'short',
      name: (ict.fvg ? 'ICT — svep, MSS och entry i FVG' : 'ICT — svep, MSS och entry i OTE')
            + (ict.kz ? ' · ' + ict.kz : ''),
      entry: ict.entry, sl: ict.sl, preferPrice: ict.liq,
      bonus: (ict.kz ? 6 : 0) + (ict.discount ? 4 : -3) + (ict.fvg ? 3 : 0) + (ict.alder <= 12 ? 3 : 0),
      why:[
        'Priset tog ut ' + (lang ? 'stopparna under ' : 'stopparna över ') + fmt(ict.svept, ctx.inst.dec) +
          ' och stängde tillbaka innanför — likviditeten är inhämtad.',
        'Därefter bröt priset strukturen ' + (lang ? 'över ' : 'under ') + fmt(ict.mssNiva, ctx.inst.dec) +
          ' (market structure shift), vilket är själva riktningsbeskedet.',
        ict.fvg
          ? ('Entryn ligger mitt i den obalans rörelsen lämnade (' + fmt(ict.fvg.lo, ctx.inst.dec) + '–' +
             fmt(ict.fvg.hi, ctx.inst.dec) + ') — dit brukar priset återvända innan nästa ben.')
          : ('Ingen obalans finns kvar, så entryn tas i 70,5 %-retracementet av benet (OTE).'),
        (ict.discount ? (lang ? 'Nivån ligger i discount, under benets jämvikt — rätt halva att köpa i.'
                              : 'Nivån ligger i premium, över benets jämvikt — rätt halva att sälja i.')
                      : 'Varning: entryn ligger på fel sida jämvikten, vilket sänker kvaliteten.') +
        (ict.kz ? ' Setupen formades i ' + ict.kz + '-killzonen.' : ' Utanför killzonerna — lägre vikt.'),
        'Stoppen ligger bortom svepet och målet vid nästa likviditetsklump på ' + fmt(ict.liq, ctx.inst.dec) + '.'
      ]
    }));
  }

  /* ---------- Extra · VWAP-återgång (räknas till svepfamiljen) ---------- */
  if(Math.abs(px - vw) > 1.9*A){
    const long = px < vw;
    const entry = px + (long ? -0.25*A : 0.25*A);
    S.push(makeSignal(ctx, {
      fam:'svep', trigger:'limit', side: long?'long':'short', name:'Återgång till VWAP — priset är utsträckt',
      entry, sl: long ? entry - rm*1.15*A : entry + rm*1.15*A,
      preferPrice: vw, bonus: 3,
      why:[
        'Avståndet till VWAP är över 1,9 ATR — statistiskt sträckt läge på 5m.',
        'Setupen handlar om återgång till medelvärdet, inte om trendriktning.',
        'VWAP är målet; detta är en snabb affär, inte en swing.'
      ]
    }));
  }

  let ok = S.filter(s => !s.invalid && s.rr >= 0.9 && isFinite(s.entry) && isFinite(s.sl));

  /* Nyhetsflödet bestämmer vilket håll som får handlas. Lutar dagen positivt
     ges bara långa setups, lutar den negativt bara korta, och är den neutral
     ges båda. Redan påbörjade affärer sparas undan oavsett håll — de ska få
     nå sitt mål eller sitt stopp, inte försvinna för att nyheterna vände. */
  const bias = nz(ctx.biasRiktning) ? ctx.biasRiktning : 0;
  if(bias !== 0){
    const onskad = bias > 0 ? 'long' : 'short';
    ok = ok.filter(s => s.side === onskad || LIVE.has(s.id));
  }

  const near = ok.filter(s => s.dist <= 5*A);        // entry inom rimligt avstånd
  return combine(near.length >= 3 ? near : ok.filter(s => s.dist <= 9*A), A);
}

/* Två familjer som vill in på samma nivå åt samma håll är en setup, inte två.
   Den starkaste får kortet och de andras motivering läggs till. */
function combine(list, A){
  const out = [];
  list.slice().sort((a,b)=> b.conf - a.conf).forEach(s=>{
    const host = out.find(h => h.side === s.side && Math.abs(h.entry - s.entry) <= 0.55*A);
    if(!host){ out.push(s); return; }
    if(host.fam !== s.fam){
      host.also = host.also || [];
      if(!host.also.includes(s.famName)){
        host.also.push(s.famName);
        host.why = host.why.concat(s.why.slice(0,1));
        host.conf = clamp(host.conf + 3, 12, 93);    // två idéer på samma nivå väger tyngre
      }
    }
  });
  return out;
}

/* ---- status: en ACTIVE, resten väntar ---- */
/* ACTIVE betyder att affären är påbörjad. Den ligger kvar som ACTIVE tills
   målet eller stoppen nås — inte bara medan priset råkar stå i entryzonen. */
/* Finns redan en påbörjad affär i samma familj åt samma håll på samma
   instrument? Då är platsen upptagen tills den nått mål eller stopp. */
function upptagenAv(s){
  for(const st of LIVE.values()){
    if(!st || !st.sig || st.hitTp || st.hitSl) continue;
    const g = st.sig;
    if(g.inst === s.inst && g.fam === s.fam && g.side === s.side) return true;
  }
  return false;
}

/* Städar bort dubbletter som redan hunnit uppstå: av flera pågående affärer i
   samma familj åt samma håll behålls den som triggade först. */
function rensaDubbletter(){
  const behall = new Map();
  const bort = [];
  for(const [id, st] of LIVE){
    if(!st || !st.sig || st.hitTp || st.hitSl) continue;
    const nyckel = st.sig.inst + '|' + st.sig.fam + '|' + st.sig.side;
    const forra = behall.get(nyckel);
    if(!forra){ behall.set(nyckel, [id, st]); continue; }
    if((st.at || 0) < (forra[1].at || 0)){ bort.push(forra[0]); behall.set(nyckel, [id, st]); }
    else bort.push(id);
  }
  bort.forEach(id => LIVE.delete(id));
  return bort.length;
}

function assignStatus(sigs, pxByInst){
  rensaDubbletter();

  /* En fylld setup som motorn slutat föreslå — priset har dragit iög eller
     strukturen har ändrats — försvinner ur listan nedan och skulle då aldrig
     få sitt slut. Den här svepningen prövar alla påbörjade affärer mot samma
     mål och stopp som när de togs, precis som kontot gör med sina positioner. */
  const iListan = new Set(sigs.map(s => s.id));
  LIVE.forEach((st, id) => {
    if(iListan.has(id) || !st || !st.sig || st.hitTp || st.hitSl) return;
    const g = st.sig, px = pxByInst[g.inst];
    if(!nz(px)) return;
    const dir = g.side === 'long' ? 1 : -1;
    if(dir*(px - g.tp) >= 0){ st.hitTp = true; st.slutAt = Date.now(); }
    else if(dir*(px - g.sl) <= 0){ st.hitSl = true; st.slutAt = Date.now(); }
  });

  sigs.forEach(s=>{
    const px = pxByInst[s.inst];
    const dir = s.side==='long' ? 1 : -1;
    const zone = s.atr*0.30;
    let st = LIVE.get(s.id);

    const inZone = Math.abs(px - s.entry) <= zone;
    const traff  = Math.abs(px - s.entry) <= s.atr*0.05;  // priset står i praktiken på nivån
    const fylld  = s.reachSign*(px - s.entry) >= 0;       // priset ligger på fyllningssidan
    const foreDetta = SEDD.get(s.id);

    // Eftersom en fylld affär låses som ACTIVE tills mål eller stopp krävs en riktig
    // träff: priset står på nivån, eller har gått igenom den medan vi tittade.
    // Att bara ligga nära räcker inte, och en omladdning fyller inte gamla nivåer.
    // C-setups får aldrig gå aktiva — de är för svaga för att handlas.
    const fargodkand = s.grade === 'A' || s.grade === 'B';
    if(!st && fargodkand && (traff || (fylld && foreDetta === false))){
      // En setup i taget per familj och riktning. Id:t följer entrynivån, så samma
      // idé får ett nytt id när priset flyttar sig — utan spärren staplades tre
      // nästan identiska svep-shorts på varandra, både som kort och som positioner,
      // och risken blev tredubbel på samma tanke.
      const upptagen = upptagenAv(s);
      if(!upptagen){
        st = { triggered:true, at:Date.now(), entryPx:s.entry, sig:Object.assign({}, s) };
      }
    }
    if(!st) SEDD.set(s.id, fylld);
    if(st){
      LIVE.set(s.id, st);
      if(!st.hitTp && !st.hitSl){
        if(dir*(px - s.tp) >= 0){ st.hitTp = true; st.slutAt = Date.now(); }
        else if(dir*(px - s.sl) <= 0){ st.hitSl = true; st.slutAt = Date.now(); }
      }
    }

    if(st && st.hitTp)       { s.status='TP'; s.statusTxt='MÅL NÅTT'; }
    else if(st && st.hitSl)  { s.status='SL'; s.statusTxt='STOPP UT'; }
    else if(st)              { s.status='ACTIVE'; s.statusTxt='ACTIVE'; }   // ligger kvar tills mål eller stopp
    else if(Math.abs(px - s.entry) <= s.atr*1.0) { s.status='NÄRA'; s.statusTxt='NÄRA'; }
    else                     { s.status='VÄNTAR'; s.statusTxt='VÄNTAR'; }

    s.needTxt = s.trigger==='stop'
      ? (s.side==='long' ? 'bryter upp genom' : 'bryter ned genom')
      : (s.side==='long' ? 'faller tillbaka till' : 'stiger tillbaka till');

    s.oppnad     = st ? st.at : null;
    s.entryFyllt = st ? st.entryPx : null;
    s.openPnl    = (st && s.status === 'ACTIVE') ? dir*(px - s.entry) : null;
    s.kvarMal    = Math.abs(s.tp - px);
    s.kvarStopp  = Math.abs(px - s.sl);
    s.restRR     = s.kvarStopp > 0 ? s.kvarMal/s.kvarStopp : null;
  });
  return sigs;
}


/* ---------- vad som delas ut ---------- */
export {
  SYMS, clamp, last, nz, fmt, fmtSigned, pct, timeIn, nyParts, sessionState,
  ema, rsi, atr, dayKeyNY, minutesNY, sessionVWAP, swings, buildContext,
  INSTR, RISK_MULT, MAX_RISK, positionsStorlek, FAM, FAM_KORT, FAM_KEY, FAM_N, FAM_HANDLAS, GRADE_RANK,
  adx, DRAG_NAMN, drag, aiSannolikhet, MODELL, orbLage, rensaDubbletter, brusband, momentLage,
  RULES, RISK_EVENTS, analyseHeadline, computeNewsBias, biasLage, BIAS_TROSKEL, BIAS_FULLT,
  rangeBox, tightRange, ictKillzone, ictState, familyVotes, gradeFor,
  moveBounds, sessionReachFactor, targetCandidates, pickTarget,
  makeSignal, generateSignals, combine, assignStatus, LIVE, SEDD
};
