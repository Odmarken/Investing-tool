/**
 * Riptide — träning och mätning av den lärda modellen.
 *
 *   node trana.mjs            (eller: npm run trana)
 *
 * Vad den gör:
 *   1. Hämtar 5-minutersstaplar för MNQ från Yahoo och lägger dem till
 *      .staplar-cache.json. Cachen växer: Yahoo ger bara 60 dagar bakåt, men
 *      det som redan hämtats sparas, så historiken blir längre för varje gång
 *      riggen körs. Det är den billigaste vägen till mer data.
 *   2. Glider ett fönster genom historiken och låter samma motor som sidan
 *      använder generera setups. Varje setup sparas en gång, med den dragvektor
 *      motorn själv räknade fram.
 *   3. Låter varje setup gå framåt i tiden med realistiska fyllningar och
 *      kostnader: en limitorder måste handlas igenom, inte bara nuddas, och en
 *      stopporder blir en marknadsorder när nivån nås. Spread, courtage och
 *      slippage dras från utfallet.
 *   4. Tränar en ridge-regression som förutsäger utfallet i R, och testar den
 *      rullande på hela handelsdagar: en dag i testet ser aldrig sin egen
 *      framtid, och delningen går vid ett dygnsskifte i stället för mitt i en
 *      session.
 *   5. Jämför alltihop mot ett nolltest — samma geometri, slumpad riktning.
 *      Utan den referenspunkten går det inte att skilja "modellen fungerar"
 *      från "marknaden gick upp i juli".
 *
 * Att förutsäga R direkt i stället för sannolikheten är avsiktligt. En modell
 * som bara gissar träffprocent älskar snäva mål, och då blir sorteringen bara
 * ett omvänt mått på hur långt målet ligger.
 *
 * Slutsatsen skrivs till modell.js tillsammans med testsiffrorna. Duger inte
 * modellen skrivs den ändå — men med `duger: false`, och då rör den inte
 * signalerna.
 *
 * OMÄTT: nyhetsspärren. Skarpt läge låter dagens rubriker stänga av ena hållet
 * (MOTORCFG.nyhetsSparr i motor.js), men historiska rubriker finns inte sparade,
 * så uppspelningen kör med bias 0 och båda hållen öppna. Vad spärren gör med
 * utfallet vet vi alltså inte — därför rapporteras long och short var för sig
 * längst ned, som den närmaste uppskattning som går att göra.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { INSTR, buildContext, generateSignals, DRAG_NAMN } from './motor.js';

const CACHE   = '.staplar-cache.json';
const FONSTER = 1100;     // lika många staplar som sidan räknar på — fyra dygn, så att
                          // brusbandet har färdiga sessioner att skatta ur
const STEG    = 3;        // hur ofta vi frågar motorn (3 = var femtonde minut)
const VANTA   = 60;       // staplar entryn får på sig att fyllas
const LOPP    = 300;      // staplar affären får på sig att nå mål eller stopp
const TESTDEL = 0.35;     // sista 35 procenten av handelsdagarna är testperiod
const MINNE   = 6000;     // hur många färska setups den rullande träningen ser
const OMTRAN  = 150;      // träna om var 150:e testsetup
const LAMBDA  = 3;        // hur hårt vikterna hålls tillbaka
const HORISONT = 12;      // staplar framåt i riktningstestet

/* ------------------------------------------------------------- kostnader
   MNQ: en tick är 0,25 punkter och 0,50 dollar. Spreaden är normalt en tick,
   courtaget kring 1,20 dollar tur och retur per kontrakt, och en stopporder —
   både entryn i brott- och momentfamiljen och varje utstoppning — fylls sällan
   exakt på nivån. Räknat i punkter blir det knappt en punkt per affär. Det är
   inte det som avgör om motorn har en edge, men när man jagar 0,05 R äter det
   en tredjedel, och då ska det stå i siffran. */
const TICK     = INSTR.NQ.tick;                 // 0,25 punkter
const SPREAD   = 1 * TICK;                      // en tick tur och retur
const COURTAGE = 1.24 / INSTR.NQ.ptValue;       // dollar → punkter
const SLIPP    = 1 * TICK;                      // per stopporder som tas ut
const GENOM    = 1 * TICK;                      // så långt en limit måste handlas igenom

/* ---------------------------------------------------------------- staplar
   Cachen växer i stället för att skrivas över. Yahoo ger 60 dagar bakåt; körs
   riggen en gång i månaden finns det ett år om ett år. Det är den enda
   gratisvägen förbi att 60 dagar bara är ett enda marknadsklimat. */
async function staplar(){
  let gamla = [];
  if(existsSync(CACHE)){
    const c = JSON.parse(readFileSync(CACHE, 'utf8'));
    gamla = c.bars || [];
    if(Date.now() - c.hamtad < 12*3600e3){
      console.log('staplar ur cachen: ' + gamla.length);
      return gamla;
    }
  }
  let nya = [];
  try{
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/MNQ=F?range=60d&interval=5m';
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const j = await r.json();
    const res = j.chart.result[0], q = res.indicators.quote[0];
    nya = res.timestamp.map((t,i) => ({
      t: t*1000, o:q.open[i], h:q.high[i], l:q.low[i], c:q.close[i], v:q.volume[i] || 0
    })).filter(b => [b.o,b.h,b.l,b.c].every(x => typeof x === 'number' && isFinite(x)));
  }catch(e){
    console.log('Yahoo svarade inte (' + e.message + ') — kör vidare på cachen.');
    if(!gamla.length) throw e;
  }
  const karta = new Map(gamla.map(b => [b.t, b]));
  let tillagda = 0;
  for(const b of nya) if(!karta.has(b.t)){ karta.set(b.t, b); tillagda++; }
  const bars = [...karta.values()].sort((a,b) => a.t - b.t);
  writeFileSync(CACHE, JSON.stringify({ hamtad: Date.now(), bars }));
  console.log('staplar: ' + bars.length + ' (' + tillagda + ' nya från Yahoo — cachen växer)');
  return bars;
}

/* ------------------------------------------------------------- uppspelning */
const dagNY = t => new Intl.DateTimeFormat('en-CA',
  { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(t));

function samlaSetups(bars){
  const sedda = new Map();
  for(let i = FONSTER; i < bars.length; i += STEG){
    const ctx = buildContext(INSTR.NQ, bars.slice(i - FONSTER, i));
    /* Uppspelningen har inga rubriker. Nollan sätts uttryckligen så att det
       syns i koden att skarpt läge räknar med något mätningen saknar. */
    ctx.newsBias = 0;
    ctx.biasRiktning = 0;
    let sigs;
    try{ sigs = generateSignals(ctx); }catch(e){ continue; }
    for(const s of sigs){
      /* Motorns id är numera stabilt per familj och håll — det är hela poängen
         med det. Här behövs motsatsen: varje distinkt kandidat ska mätas, och
         samma idé med entryn på en ny nivå är en ny kandidat. Därför nyckeln
         plus nivån, alltså precis det motorns id brukade vara. */
      const prov = s.nyckel + '@' + Math.round(s.entry*10);
      if(s.invalid || sedda.has(prov)) continue;
      sedda.set(prov, {
        x: s.x.concat([s.conf/100]),          // den handsatta konfidensen är ett drag som alla andra
        fran: i, side: s.side, fam: s.fam, trigger: s.trigger,
        entry: s.entry, sl: s.sl, tp: s.tp, rr: s.rr, grade: s.grade, conf: s.conf,
        backN: s.backN, stangVid: s.stangVid || null
      });
    }
    if(i % 2000 < STEG) process.stdout.write('\r  spelar upp ' + Math.round((i/bars.length)*100) + '%   ');
  }
  process.stdout.write('\r');
  return [...sedda.values()];
}

/* Facit, med de fyllningar man faktiskt får:
     · limitorder — nivån måste handlas igenom, inte bara nuddas. En limit som
       berörs med en tick hamnar längst bak i kön och fylls sällan.
     · stopporder — blir marknadsorder när nivån nås, så öppnar stapeln redan
       bortom nivån är det öppningskursen som gäller, plus slippage.
     · nås både stopp och mål inom samma stapel räknas stoppen.
   R räknas mot den risk affären dimensionerades på, alltså |entry − sl|. En
   sämre fyllning än nivån syns då som förlorad R, vilket är precis vad den
   kostar: kontrakten är redan köpta på det gamla stoppavståndet. */
function faciter(setups, bars){
  const ut = [];
  for(const s of setups){
    const dir = s.side === 'long' ? 1 : -1;
    const risk = Math.abs(s.entry - s.sl);
    if(!(risk > 0)) continue;
    let fylld = -1, fillPx = 0, exitPx = null, viaStopp = false;
    for(let i = s.fran; i < Math.min(bars.length, s.fran + VANTA + LOPP); i++){
      const b = bars[i];
      if(fylld < 0){
        if(i - s.fran > VANTA) break;
        if(s.trigger === 'stop'){
          if(!(dir > 0 ? b.h >= s.entry : b.l <= s.entry)) continue;
          fillPx = (dir > 0 ? Math.max(s.entry, b.o) : Math.min(s.entry, b.o)) + dir*SLIPP;
        }else{
          if(!(dir > 0 ? b.l <= s.entry - GENOM : b.h >= s.entry + GENOM)) continue;
          fillPx = s.entry;
        }
        fylld = i;
      }
      if(dir > 0 ? b.l <= s.sl : b.h >= s.sl){ exitPx = s.sl - dir*SLIPP; viaStopp = true; break; }
      if(dir > 0 ? b.h >= s.tp : b.l <= s.tp){ exitPx = s.tp; break; }
      /* Tidsutgång: momentumaffärerna stängs när sessionen stänger, oavsett var
         priset står. Utfallet blir då delvis — något mellan −1 och rr. */
      if(s.stangVid && b.t >= s.stangVid){ exitPx = b.c; break; }
      if(i - fylld > LOPP) break;
    }
    if(fylld < 0 || exitPx === null) continue;
    const R = (dir*(exitPx - fillPx) - SPREAD - COURTAGE) / risk;
    ut.push({ ...s, y: R > 0 ? 1 : 0, R, viaStopp, slut: fylld, dag: dagNY(bars[s.fran].t) });
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
const alladagar = new Set(bars.map(b => dagNY(b.t)));
console.log('period: ' + dagNY(bars[0].t) + ' → ' + dagNY(bars[bars.length-1].t) +
            ' · ' + alladagar.size + ' handelsdagar');

/* Datasetet cachas bara så länge motorn *och riggen* är oförändrade. Byggs en
   familj om, ändras en spärr eller flyttas en entry är gamla setups en mätning
   av en motor som inte finns längre — och ändras riggens egen urvals- eller
   facitlogik mäter de gamla raderna något annat än de nya. Båda filerna går
   därför in i summan. */
const MOTORSUM = createHash('sha1')
  .update(readFileSync('motor.js')).update(readFileSync('trana.mjs')).digest('hex').slice(0,12);
const DATACACHE = '.setups-cache.json';
let data;
if(existsSync(DATACACHE)){
  const c = JSON.parse(readFileSync(DATACACHE, 'utf8'));
  if(c.staplar === bars.length && c.drag === DRAG_NAMN.length + 1 && c.motor === MOTORSUM){
    data = c.data;
    console.log('datasetet ur cachen: ' + data.length + ' avgjorda setups');
  }else if(c.motor !== MOTORSUM){
    console.log('motorn har ändrats sedan förra körningen — spelar upp historiken igen.');
  }
}
if(!data){
  const setups = samlaSetups(bars);
  console.log('setups: ' + setups.length);
  data = faciter(setups, bars).sort((a,b)=>a.fran-b.fran);
  writeFileSync(DATACACHE, JSON.stringify({ staplar: bars.length, drag: DRAG_NAMN.length + 1, motor: MOTORSUM, data }));
}
if(!data.length){ console.log('Inga avgjorda setups — motorn ger inga signaler på den här historiken.'); process.exit(1); }

const dagar = [...new Set(data.map(d=>d.dag))].sort();
console.log('avgjorda med facit: ' + data.length +
            ' · träff ' + Math.round(data.filter(d=>d.y).length/data.length*100) +
            '% · snitt ' + (data.reduce((s,d)=>s+d.R,0)/data.length).toFixed(3) + ' R' +
            ' · ' + (data.length/dagar.length).toFixed(1) + ' setups per handelsdag');

const snittR = a => a.length ? a.reduce((s,o)=>s+o.R,0)/a.length : 0;
const traff  = a => a.length ? Math.round(a.filter(o=>o.y).length/a.length*100) : 0;
const rad = (namn, a) => console.log('  ' + namn.padEnd(26) + String(a.length).padStart(6) +
  '   ' + String(traff(a)+'%').padStart(5) + '   ' + snittR(a).toFixed(3).padStart(7));
const rubrik = t => console.log('\n' + t + '\n  ' + ''.padEnd(26) + '     n    träff   snitt R');

/* ------------------------------------------------------------- nolltestet
   Samma stapel, samma riskavstånd och samma R:R som motorn valde — men slumpad
   riktning och entry vid stängning. Ligger motorn inte tydligt över det här har
   den ingen edge, och då är all finjustering av poäng och mål brus ovanpå
   ingenting. Slumpen är avsiktligt deterministisk så att två körningar går att
   jämföra rakt av. */
function nolltest(data, bars, valjRiktning){
  let fro = 20260902;
  const slump = () => (fro = (fro*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ut = [];
  for(const s of data){
    const r = slump();
    const dir = valjRiktning ? valjRiktning(s) : (r < 0.5 ? 1 : -1);
    const i = s.fran;
    if(i < 1 || i >= bars.length) continue;
    const entry = bars[i-1].c, risk = Math.abs(s.entry - s.sl);
    if(!(risk > 0)) continue;
    const tp = entry + dir*risk*s.rr, sl = entry - dir*risk;
    for(let k=i;k<Math.min(bars.length, i+LOPP);k++){
      const b = bars[k];
      if(dir>0 ? b.l<=sl : b.h>=sl){ ut.push({ R:(-risk - SLIPP - SPREAD - COURTAGE)/risk, y:0 }); break; }
      if(dir>0 ? b.h>=tp : b.l<=tp){ ut.push({ R:(risk*s.rr - SPREAD - COURTAGE)/risk, y:1 }); break; }
    }
  }
  return ut;
}

rubrik('NOLLTEST — samma geometri, ingen motorkunskap');
rad('slumpad riktning', nolltest(data, bars, null));
rad('motorns riktning, marknad', nolltest(data, bars, s => s.side === 'long' ? 1 : -1));
rad('motorn som den är', data);

/* --------------------------------------------------- var utfallet sitter */
rubrik('PER FAMILJ');
for(const f of [...new Set(data.map(d=>d.fam))].sort()) rad(f, data.filter(d=>d.fam===f));
rubrik('PER GRAD — A ska ligga över C, annars sorterar graderingen inte');
for(const g of ['A','B','C']) rad('grade ' + g, data.filter(d=>d.grade===g));
rubrik('PER HÅLL — nyhetsspärren är omätt, det här är det närmaste vi kommer');
rad('long', data.filter(d=>d.side==='long'));
rad('short', data.filter(d=>d.side==='short'));

/* ------------------------------------------------------- riktningen ensam
   Målsökningen är motorns egen kod, och rr är både ett drag i modellen och en
   produkt av den. Det här måttet kringgår hela exitlogiken: hur långt gick
   priset åt det håll signalen pekade, mätt i riskavstånd, över en fast
   horisont? Jämförelsen är samma setups med riktningarna omkastade. Är de två
   lika ligger informationen inte i riktningsvalet — och då hjälper ingen
   måljustering i världen. */
{
  const framat = [], skuggan = [], drift = [];
  let fro = 7654321;
  const slump = () => (fro = (fro*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for(const s of data){
    /* Mätt från stapeln affären fylldes på, inte från stapeln signalen kom på.
       En limitorder fylls bara när priset går emot den, och eftersom bara
       fyllda setups har facit skulle den senare referensen ge varje long en
       inbyggd nackdel som inte har med riktningsvalet att göra. */
    const i = s.slut, j = i + HORISONT;
    if(i < 1 || j >= bars.length) continue;
    const risk = Math.abs(s.entry - s.sl);
    if(!(risk > 0)) continue;
    const ror = (bars[j].c - bars[i].c) / risk;
    framat.push((s.side === 'long' ? 1 : -1) * ror);
    skuggan.push((slump() < 0.5 ? 1 : -1) * ror);
    drift.push(ror);
  }
  if(framat.length){
    const m = a => a.reduce((x,y)=>x+y,0)/a.length;
    const sd = a => { const u = m(a); return Math.sqrt(a.reduce((x,y)=>x+(y-u)**2,0)/a.length); };
    /* Standardfelet räknas på antalet handelsdagar, inte på antalet setups.
       Tusentals överlappande fönster ur samma stapelserie är inte tusentals
       oberoende observationer, och det är där de flesta backtester ljuger. */
    const t = (m(framat) - m(skuggan)) / (sd(framat)/Math.sqrt(dagar.length));
    console.log('\nRIKTNINGEN ENSAM — ' + HORISONT + ' staplar framåt, i riskavstånd, utan exitlogik');
    console.log('  motorns riktning : ' + m(framat).toFixed(4));
    console.log('  omkastad         : ' + m(skuggan).toFixed(4));
    /* Driftkontroll. Föll marknaden under perioden ser varje long dålig ut och
       varje short bra, alldeles oavsett om valet bar någon information. Står
       motorns siffra mellan "alltid long" och "alltid short" har den bara ärvt
       periodens riktning. */
    console.log('  alltid long      : ' + m(drift).toFixed(4) + '   (marknadens egen drift)');
    console.log('  alltid short     : ' + (-m(drift)).toFixed(4));
    console.log('  skillnad mot slump: ' + (m(framat)-m(skuggan)).toFixed(4) +
                '   (t ≈ ' + t.toFixed(2) + ' räknat på ' + dagar.length + ' oberoende dagar)');
  }
}

/* -------------------------------------------------- rullande test per dag
   Delningen går vid ett dygnsskifte, inte mitt i en session, och varje
   testsetup bedöms av en modell som bara sett affärer från tidigare dagar. */
const brytDag = dagar[Math.floor(dagar.length*(1-TESTDEL))];
const test = data.filter(d => d.dag >= brytDag);
console.log('\ntestperiod från ' + brytDag + ' · ' + test.length + ' setups · ' +
            [...new Set(test.map(d=>d.dag))].length + ' handelsdagar');

let modell = null, sedanOmtran = 1e9;
const bedomda = [];
for(const t of test){
  if(sedanOmtran >= OMTRAN){
    const historik = data.filter(d => d.dag < t.dag).slice(-MINNE);
    if(historik.length >= 800){ modell = passa(historik); sedanOmtran = 0; }
  }
  sedanOmtran++;
  if(!modell) continue;
  bedomda.push({ ...t, gissad: gissa(t.x, modell) });
}
console.log('bedömda med rullande modell: ' + bedomda.length);

const sorterat = bedomda.slice().sort((a,b)=>b.gissad-a.gissad);
const del = (a, fran, till) => a.slice(Math.round(a.length*fran), Math.round(a.length*till));

rubrik('I TESTPERIODEN');
rad('allt', bedomda);
rad('dagens A + B', bedomda.filter(o=>o.grade!=='C'));
rad('dagens konf ≥ 70', bedomda.filter(o=>o.conf>=70));
rad('modellen bästa 10%', del(sorterat, 0, 0.10));
rad('modellen bästa 25%', del(sorterat, 0, 0.25));
rad('modellen bästa 50%', del(sorterat, 0, 0.50));
rad('modellen sämsta 25%', del(sorterat, 0.75, 1));
rad('modellen: gissad > 0', bedomda.filter(o=>o.gissad>0));

/* Spridningen mellan dagar. Ett snitt räknat på tusentals överlappande setups
   ur samma stapelserie ser stabilare ut än det är — det som avgör är hur många
   av dagarna som faktiskt bar, och hur brett standardfelet är. */
const perDag = {};
for(const o of bedomda) (perDag[o.dag] = perDag[o.dag] || []).push(o);
const dagsR = Object.keys(perDag).sort().map(d => snittR(perDag[d]));
const basR = snittR(bedomda);
if(dagsR.length){
  const sorterade = dagsR.slice().sort((a,b)=>a-b);
  const median = sorterade[Math.floor(sorterade.length/2)];
  const plus = dagsR.filter(r=>r>0).length;
  const sd = Math.sqrt(dagsR.reduce((s,r)=>s+(r-basR)**2,0)/dagsR.length);
  console.log('\nper handelsdag: ' + dagsR.length + ' dagar · median ' + median.toFixed(3) +
              ' R · ' + plus + ' plusdagar (' + Math.round(plus/dagsR.length*100) + ' %)' +
              ' · standardfel på snittet ±' + (sd/Math.sqrt(dagsR.length)).toFixed(3) + ' R');
}

const topp25 = del(sorterat, 0, 0.25);
const botten = del(sorterat, 0.75, 1);
const lyft   = snittR(topp25) - basR;
const spridning = snittR(topp25) - snittR(botten);
const nollR  = snittR(nolltest(data, bars, null));
const duger  = snittR(topp25) > 0 && lyft > 0.08 && spridning > 0.12;

console.log('\nlyft i bästa fjärdedelen: ' + lyft.toFixed(3) + ' R · spridning topp−botten: ' +
            spridning.toFixed(3) + ' R · nolltestet: ' + nollR.toFixed(3) + ' R');
console.log(duger ? 'MODELLEN DUGER — den får styra sorteringen.'
                  : 'MODELLEN DUGER INTE — den skrivs med duger:false och rör inte signalerna.');

/* Träff per familj och grad, netto, ur hela populationen. Det här är vad kortet
   visar i stället för konf: konf var en checklista som toppade på 93 för 40 %
   av alla setups och pekade åt fel håll (92–99: 36 % träff, 0–54: 42 %). En
   uppmätt träffprocent med antalet bredvid är det ärligaste som går att säga
   om en setup innan den tas. Räknas på allt, inte bara testperioden — det är
   en beskrivning av historiken, inte en prediktion som ska valideras. */
const traffTabell = {};
for(const o of data){
  const k = o.fam + '|' + o.grade;
  const t = traffTabell[k] || (traffTabell[k] = { n: 0, vinst: 0, R: 0 });
  t.n++; if(o.y) t.vinst++; t.R += o.R;
}
for(const k in traffTabell){ const t = traffTabell[k]; traffTabell[k] = { n: t.n, traff: Math.round(t.vinst/t.n*100), R: +(t.R/t.n).toFixed(3) }; }

/* Slutmodellen tränas på allt, men betygsätts av testet ovan. */
const slutlig = passa(data.slice(-MINNE));
const test_ = {
  n: bedomda.length,
  fran: brytDag,
  till: dagar[dagar.length-1],
  dagar: dagsR.length,
  snittR: +basR.toFixed(3),
  topp25: +snittR(topp25).toFixed(3),
  botten25: +snittR(botten).toFixed(3),
  traffTopp25: traff(topp25),
  lyft: +lyft.toFixed(3),
  nolltest: +nollR.toFixed(3),
  kostnadPunkter: +(SPREAD + COURTAGE).toFixed(2)
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
 * Modellen förutsäger setupens utfall i R, netto efter spread, courtage och
 * slippage. Den är testad rullande på hela handelsdagar: varje bedömd setup i
 * testperioden fick en modell som bara sett affärer från tidigare dagar.
 *
 * test.nolltest är samma geometri med slumpad riktning. Ligger snittR inte
 * tydligt över den siffran mäter modellen marknadens drift, inte en edge.
 *
 * duger = false betyder att den inte slog dagens poängsättning på testdata.
 * Då används den inte till annat än att visas.
 */
export const MODELL = {
  version: 3,
  tranad: ${JSON.stringify(new Date().toISOString().slice(0,10))},
  duger: ${duger},
  drag: ${JSON.stringify(DRAG_NAMN.concat(['konfidens']))},
  medel: ${JSON.stringify(slutlig.medel.map(v => +v.toFixed(6)))},
  skala: ${JSON.stringify(slutlig.skala.map(v => +v.toFixed(6)))},
  vikter: ${JSON.stringify(slutlig.vikter.map(v => +v.toFixed(6)))},
  bias: ${+slutlig.bias.toFixed(6)},
  traff: ${JSON.stringify(traffTabell)},
  test: ${JSON.stringify(test_)}
};
`;
writeFileSync('modell.js', fil);
console.log('\nmodell.js skriven · ' + slutlig.vikter.length + ' drag');

const namn = DRAG_NAMN.concat(['konfidens']);
console.log('\ntyngst vägande drag i slutmodellen:');
namn.map((n,i)=>({n, w:slutlig.vikter[i]})).sort((a,b)=>Math.abs(b.w)-Math.abs(a.w))
  .slice(0,10).forEach(o => console.log('  ' + o.n.padEnd(16) + (o.w>0?'+':'') + o.w.toFixed(3)));
