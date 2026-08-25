/**
 * Riptide — träning av den lärda modellen.
 *
 *   node trana.mjs            (eller: npm run trana)
 *
 * Vad den gör:
 *   1. Hämtar 60 dagars 5-minutersstaplar för MNQ från Yahoo och sparar dem i
 *      .staplar-cache.json så att omkörningar går på sekunder.
 *   2. Glider ett 420-staplars fönster genom historiken och låter samma motor
 *      som sidan använder generera setups. Varje setup sparas en gång, med den
 *      dragvektor motorn själv räknade fram.
 *   3. Låter varje setup gå framåt i tiden: fylls entryn, och nås målet före
 *      stoppen? Facit blir utfallet i R — plus rr vid vinst, −1 vid stopp.
 *   4. Tränar en ridge-regression som förutsäger just det utfallet, och testar
 *      den rullande: för varje testdag används bara setups som var färdiga
 *      innan dagen började. Ingen dag får se sin egen framtid.
 *
 * Att förutsäga R direkt i stället för sannolikheten är avsiktligt. En modell
 * som bara gissar träffprocent älskar snäva mål, och då blir sorteringen bara
 * ett omvänt mått på hur långt målet ligger.
 *
 * Slutsatsen skrivs till modell.js tillsammans med testsiffrorna. Duger inte
 * modellen skrivs den ändå — men med `duger: false`, och då rör den inte
 * signalerna.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { INSTR, buildContext, generateSignals, DRAG_NAMN } from './motor.js';

const CACHE   = '.staplar-cache.json';
const FONSTER = 420;      // lika många staplar som sidan räknar på
const STEG    = 2;        // hur ofta vi frågar motorn (2 = var tionde minut)
const VANTA   = 60;       // staplar entryn får på sig att fyllas
const LOPP    = 300;      // staplar affären får på sig att nå mål eller stopp
const TESTDEL = 0.35;     // sista 35 procenten av tiden är testperiod
const MINNE   = 6000;     // hur många färska setups den rullande träningen ser
const OMTRAN  = 150;      // träna om var 150:e testsetup
const LAMBDA  = 3;        // hur hårt vikterna hålls tillbaka

/* ---------------------------------------------------------------- staplar */
async function staplar(){
  if(existsSync(CACHE)){
    const c = JSON.parse(readFileSync(CACHE, 'utf8'));
    if(Date.now() - c.hamtad < 12*3600e3){
      console.log('staplar ur cachen: ' + c.bars.length);
      return c.bars;
    }
  }
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/MNQ=F?range=60d&interval=5m';
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const res = j.chart.result[0], q = res.indicators.quote[0];
  const bars = res.timestamp.map((t,i) => ({
    t: t*1000, o:q.open[i], h:q.high[i], l:q.low[i], c:q.close[i], v:q.volume[i] || 0
  })).filter(b => [b.o,b.h,b.l,b.c].every(x => typeof x === 'number' && isFinite(x)));
  writeFileSync(CACHE, JSON.stringify({ hamtad: Date.now(), bars }));
  console.log('staplar från Yahoo: ' + bars.length);
  return bars;
}

/* ------------------------------------------------------------- uppspelning */
function samlaSetups(bars){
  const sedda = new Map();
  for(let i = FONSTER; i < bars.length; i += STEG){
    const ctx = buildContext(INSTR.NQ, bars.slice(i - FONSTER, i));
    let sigs;
    try{ sigs = generateSignals(ctx); }catch(e){ continue; }
    for(const s of sigs){
      if(s.invalid || sedda.has(s.id)) continue;
      sedda.set(s.id, {
        x: s.x.concat([s.conf/100]),          // den handsatta konfidensen är ett drag som alla andra
        fran: i, side: s.side, fam: s.fam, trigger: s.trigger,
        entry: s.entry, sl: s.sl, tp: s.tp, rr: s.rr, grade: s.grade, conf: s.conf
      });
    }
    if(i % 2000 < STEG) process.stdout.write('\r  spelar upp ' + Math.round((i/bars.length)*100) + '%   ');
  }
  process.stdout.write('\r');
  return [...sedda.values()];
}

/* Facit. Nås både stopp och mål inom samma stapel räknas stoppen — samma
   pessimistiska regel som demokontot använder. */
function faciter(setups, bars){
  const ut = [];
  for(const s of setups){
    const dir = s.side === 'long' ? 1 : -1;
    let fylld = -1, vinst = null;
    for(let i = s.fran; i < Math.min(bars.length, s.fran + VANTA + LOPP); i++){
      const b = bars[i];
      if(fylld < 0){
        if(i - s.fran > VANTA) break;
        const traff = s.trigger === 'stop'
          ? (dir > 0 ? b.h >= s.entry : b.l <= s.entry)
          : (dir > 0 ? b.l <= s.entry : b.h >= s.entry);
        if(!traff) continue;
        fylld = i;
      }
      if(dir > 0 ? b.l <= s.sl : b.h >= s.sl){ vinst = 0; break; }
      if(dir > 0 ? b.h >= s.tp : b.l <= s.tp){ vinst = 1; break; }
      if(i - fylld > LOPP) break;
    }
    if(fylld < 0 || vinst === null) continue;
    ut.push({ ...s, y: vinst, R: vinst ? s.rr : -1, slut: fylld });
  }
  return ut;
}

/* ------------------------------------------------------- ridge-regression */
function losOut(A, b){                     // Gauss med partiell pivotering
  const n = b.length;
  const M = A.map((r,i) => r.concat([b[i]]));
  for(let k=0;k<n;k++){
    let p = k;
    for(let i=k+1;i<n;i++) if(Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    if(Math.abs(M[k][k]) < 1e-12) M[k][k] = 1e-12;
    for(let i=k+1;i<n;i++){
      const f = M[i][k]/M[k][k];
      for(let j=k;j<=n;j++) M[i][j] -= f*M[k][j];
    }
  }
  const x = new Array(n).fill(0);
  for(let i=n-1;i>=0;i--){
    let s = M[i][n];
    for(let j=i+1;j<n;j++) s -= M[i][j]*x[j];
    x[i] = s/M[i][i];
  }
  return x;
}

function passa(rader){
  const d = rader[0].x.length, n = rader.length;
  const medel = new Array(d).fill(0), skala = new Array(d).fill(1);
  for(let j=0;j<d;j++){
    let m=0; for(const r of rader) m += r.x[j];
    m/=n;
    let v=0; for(const r of rader) v += (r.x[j]-m)**2;
    medel[j]=m; skala[j] = Math.sqrt(v/n) > 1e-9 ? Math.sqrt(v/n) : 1;
  }
  const rMedel = rader.reduce((s,r)=>s+r.R,0)/n;
  const XtX = Array.from({length:d}, ()=> new Array(d).fill(0));
  const Xty = new Array(d).fill(0);
  for(const r of rader){
    const z = r.x.map((v,j)=>(v-medel[j])/skala[j]);
    const dy = r.R - rMedel;
    for(let a=0;a<d;a++){
      Xty[a] += z[a]*dy;
      for(let b2=a;b2<d;b2++) XtX[a][b2] += z[a]*z[b2];
    }
  }
  for(let a=0;a<d;a++){ for(let b2=0;b2<a;b2++) XtX[a][b2] = XtX[b2][a]; XtX[a][a] += LAMBDA; }
  const w = losOut(XtX, Xty);
  return { medel, skala, vikter: w, bias: rMedel };
}

const gissa = (x, M) => x.reduce((s,v,j)=> s + M.vikter[j]*((v-M.medel[j])/M.skala[j]), M.bias);

/* ------------------------------------------------------------------- kör */
const bars = await staplar();
console.log('period: ' + new Date(bars[0].t).toISOString().slice(0,10) +
            ' → ' + new Date(bars[bars.length-1].t).toISOString().slice(0,10));

const DATACACHE = '.setups-cache.json';
let data;
if(existsSync(DATACACHE)){
  const c = JSON.parse(readFileSync(DATACACHE, 'utf8'));
  if(c.staplar === bars.length && c.drag === DRAG_NAMN.length + 1){
    data = c.data;
    console.log('datasetet ur cachen: ' + data.length + ' avgjorda setups');
  }
}
if(!data){
  const setups = samlaSetups(bars);
  console.log('setups: ' + setups.length);
  data = faciter(setups, bars).sort((a,b)=>a.fran-b.fran);
  writeFileSync(DATACACHE, JSON.stringify({ staplar: bars.length, drag: DRAG_NAMN.length + 1, data }));
}
console.log('avgjorda med facit: ' + data.length +
            ' · träff ' + Math.round(data.filter(d=>d.y).length/data.length*100) +
            '% · snitt ' + (data.reduce((s,d)=>s+d.R,0)/data.length).toFixed(3) + ' R');

const brytIx = Math.floor(data.length*(1-TESTDEL));
const brytBar = data[brytIx].fran;
const test = data.filter(d => d.fran >= brytBar);
console.log('testperiod från ' + new Date(bars[brytBar].t).toISOString().slice(0,10) +
            ' · ' + test.length + ' setups');

/* Rullande: varje testsetup bedöms av en modell som bara sett affärer som var
   färdiga innan setupen ens fanns. */
let modell = null, sedanOmtran = 1e9;
const bedomda = [];
for(const t of test){
  if(sedanOmtran >= OMTRAN){
    const historik = data.filter(d => d.slut < t.fran).slice(-MINNE);
    if(historik.length >= 800){ modell = passa(historik); sedanOmtran = 0; }
  }
  sedanOmtran++;
  if(!modell) continue;
  bedomda.push({ ...t, gissad: gissa(t.x, modell) });
}
console.log('bedömda med rullande modell: ' + bedomda.length);

const snittR = a => a.length ? a.reduce((s,o)=>s+o.R,0)/a.length : 0;
const traff  = a => a.length ? Math.round(a.filter(o=>o.y).length/a.length*100) : 0;
const sorterat = bedomda.slice().sort((a,b)=>b.gissad-a.gissad);
const del = (a, fran, till) => a.slice(Math.round(a.length*fran), Math.round(a.length*till));

console.log('');
console.log('                          n    träff   snitt R');
const rad = (namn, a) => console.log(namn.padEnd(24) + String(a.length).padStart(5) +
  '   ' + String(traff(a)+'%').padStart(5) + '   ' + snittR(a).toFixed(3).padStart(7));
rad('allt i testperioden', bedomda);
rad('dagens A + B', bedomda.filter(o=>o.grade!=='C'));
rad('dagens konf ≥ 70', bedomda.filter(o=>o.conf>=70));
rad('modellen bästa 10%', del(sorterat, 0, 0.10));
rad('modellen bästa 25%', del(sorterat, 0, 0.25));
rad('modellen bästa 50%', del(sorterat, 0, 0.50));
rad('modellen sämsta 25%', del(sorterat, 0.75, 1));
rad('modellen: gissad > 0', bedomda.filter(o=>o.gissad>0));

const basR   = snittR(bedomda);
const topp25 = del(sorterat, 0, 0.25);
const botten = del(sorterat, 0.75, 1);
const lyft   = snittR(topp25) - basR;
const spridning = snittR(topp25) - snittR(botten);
const duger = snittR(topp25) > 0 && lyft > 0.08 && spridning > 0.12;

console.log('');
console.log('lyft i bästa fjärdedelen: ' + lyft.toFixed(3) + ' R · spridning topp−botten: ' + spridning.toFixed(3) + ' R');
console.log(duger ? 'MODELLEN DUGER — den får styra sorteringen.'
                  : 'MODELLEN DUGER INTE — den skrivs med duger:false och rör inte signalerna.');

/* Slutmodellen tränas på allt, men betygsätts av testet ovan. */
const slutlig = passa(data.slice(-MINNE));
const test_ = {
  n: bedomda.length,
  fran: new Date(bars[brytBar].t).toISOString().slice(0,10),
  till: new Date(bars[bars.length-1].t).toISOString().slice(0,10),
  snittR: +basR.toFixed(3),
  topp25: +snittR(topp25).toFixed(3),
  botten25: +snittR(botten).toFixed(3),
  traffTopp25: traff(topp25),
  lyft: +lyft.toFixed(3)
};

const fil = `/**
 * Riptide — den lärda modellen.
 *
 * Genererad av trana.mjs. Rör inte för hand: kör \`npm run trana\` i stället, så
 * spelas historiken upp genom motor.js igen och vikterna räknas om. Dragen och
 * deras ordning kommer från DRAG_NAMN i motor.js plus konfidensen sist — ändras
 * den listan slutar modellen gälla, och motorn faller tillbaka på de handsatta
 * poängen tills du tränat om.
 *
 * Modellen förutsäger setupens utfall i R. Den är testad rullande: varje
 * bedömd setup i testperioden fick en modell som bara sett affärer som var
 * avgjorda innan setupen fanns.
 *
 * duger = false betyder att den inte slog dagens poängsättning på testdata.
 * Då används den inte till annat än att visas.
 */
export const MODELL = {
  version: 2,
  tranad: ${JSON.stringify(new Date().toISOString().slice(0,10))},
  duger: ${duger},
  drag: ${JSON.stringify(DRAG_NAMN.concat(['konfidens']))},
  medel: ${JSON.stringify(slutlig.medel.map(v => +v.toFixed(6)))},
  skala: ${JSON.stringify(slutlig.skala.map(v => +v.toFixed(6)))},
  vikter: ${JSON.stringify(slutlig.vikter.map(v => +v.toFixed(6)))},
  bias: ${+slutlig.bias.toFixed(6)},
  test: ${JSON.stringify(test_)}
};
`;
writeFileSync('modell.js', fil);
console.log('');
console.log('modell.js skriven · ' + slutlig.vikter.length + ' drag');

const namn = DRAG_NAMN.concat(['konfidens']);
console.log('');
console.log('tyngst vägande drag i slutmodellen:');
namn.map((n,i)=>({n, w:slutlig.vikter[i]})).sort((a,b)=>Math.abs(b.w)-Math.abs(a.w))
  .slice(0,10).forEach(o => console.log('  ' + o.n.padEnd(16) + (o.w>0?'+':'') + o.w.toFixed(3)));
