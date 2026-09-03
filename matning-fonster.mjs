/**
 * Riptide — mätning av kontots faktiska beteende.
 *
 *   node matning-fonster.mjs                  standardkonfigurationen i motor.js
 *   KARENS=36 MALR=1 node matning-fonster.mjs  prova andra värden utan att röra motorn
 *
 * trana.mjs mäter hela populationen av kandidater: varje setup på varje nivå,
 * alla grader, oavsett om kontot någonsin skulle ta den. Det här skriptet
 * mäter det kontot faktiskt gör: samma loop som cronen, en affär per idé,
 * bara A och B, fyllning mot ordern som låg ute, karens, tidsstängning.
 * Det är den siffra som betyder något för demokontot.
 *
 * Utfallen räknas netto: 0,87 punkter spread och courtage, en tick slippage
 * på varje stopporder, och stoppen före målet om båda nås i samma stapel.
 * Resultatet per fönster skrivs till .matning/ (gitignorerad) för vidare
 * analys, och en rad per fönster till skärmen.
 *
 * Läxan som skrev det här skriptet: den första versionen av fyllningen prövade
 * stapelns spann mot en nivå räknad på samma stapels stängning. Det gav
 * +0,15 R och t = 2,8 — och var look-ahead rakt igenom. Mät alltid mot ordern
 * som låg ute, aldrig mot den som just räknades fram.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const bars = JSON.parse(readFileSync('.staplar-cache.json','utf8')).bars;
import { mkdirSync } from 'node:fs';
mkdirSync('.matning', { recursive: true });
const UT = '.matning/fonster-';
const dagNY=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const FONSTER = [
  ['24h',   null],
  ['08-22', { fran: 8*60,  sistaEntry: 22*60, till: 22*60+40 }],
  ['14-22', { fran: 14*60, sistaEntry: 22*60, till: 22*60+40 }],
];
for(const [namn, F] of FONSTER){
  const m = await import('./motor.js?' + namn + Date.now());   // färsk modulinstans: PABRADET och ROSTMINNE nollade
  m.MOTORCFG.fonster = F;
  if(process.env.MALR !== undefined) m.MOTORCFG.malR = process.env.MALR === 'null' ? null : +process.env.MALR;
  if(process.env.KARENS !== undefined) m.MOTORCFG.karens = +process.env.KARENS;
  m.LIVE.clear(); m.SEDD.clear();
  const fyll = [];
  for(let i = 1100; i < bars.length; i++){
    /* Ingen egen städning av LIVE: motorn dömer affären själv på stapelns spann,
       och det är dess karens som ska avgöra när idén får fyllas igen. */
    const ctx = m.buildContext(m.INSTR.NQ, bars.slice(i-1100, i)); ctx.newsBias = 0; ctx.biasRiktning = 0;
    m.assignStatus(m.generateSignals(ctx), { NQ: ctx.px });
    for(const [nyckel, st] of m.LIVE){
      if(!st.sig || fyll.some(f => f.handelsId === st.handelsId)) continue;
      const g = st.sig, dir = g.side === 'long' ? 1 : -1, risk = Math.abs(g.entry - g.sl);
      let R = null, hur = null, exitIx = i;
      for(let k = i-1; k < Math.min(bars.length, i+300); k++){ const b = bars[k];
        if(dir > 0 ? b.l <= g.sl : b.h >= g.sl){ R = -1 - 1.37/risk; hur = 'stopp'; exitIx = k+1; break; }
        if(dir > 0 ? b.h >= g.tp : b.l <= g.tp){ R = (g.tp - g.entry)*dir/risk - 0.87/risk; hur = 'mål'; exitIx = k+1; break; }
        if(g.stangVid && b.t >= g.stangVid){ R = dir*(b.c - g.entry)/risk - 1.12/risk; hur = 'tid'; exitIx = k+1; break; } }
      if(R === null){ R = dir*(bars[Math.min(bars.length-1, i+299)].c - g.entry)/risk - 1.12/risk; hur = 'slut'; exitIx = i+300; }
      const rad = { handelsId: st.handelsId, nyckel, fam: g.fam, side: g.side, grade: g.grade, trigger: g.trigger,
                    entry: g.entry, sl: g.sl, tp: g.tp, stangVid: g.stangVid || null, risk, kontrakt: g.kontrakt, i, dag: dagNY(bars[i-1].t), R, hur, exitIx };
      fyll.push(rad);
    }
  }
  writeFileSync(UT + namn + '.json', JSON.stringify(fyll));
  const R = a => a.reduce((s,x)=>s+x.R,0)/a.length;
  const pd = {}; for(const f of fyll)(pd[f.dag]=pd[f.dag]||[]).push(f.R);
  const dR = Object.values(pd).map(v=>v.reduce((s,x)=>s+x,0)/v.length); const mu = dR.reduce((s,x)=>s+x,0)/dR.length;
  const se = Math.sqrt(dR.reduce((s,x)=>s+(x-mu)**2,0)/dR.length)/Math.sqrt(dR.length);
  console.log(('mål ' + (m.MOTORCFG.malR === null ? 'tekniska' : m.MOTORCFG.malR + 'R') + ' · karens ' + m.MOTORCFG.karens).padEnd(26) + namn.padEnd(7) + ' affärer ' + String(fyll.length).padStart(4) + ' · ' + (fyll.length/dR.length).toFixed(1) + '/dag · träff ' +
    (fyll.filter(f=>f.R>0).length/fyll.length*100).toFixed(0) + '% · snitt ' + R(fyll).toFixed(3) + ' R ±' + se.toFixed(3) + ' t=' + (R(fyll)/se).toFixed(2) +
    ' · tidsstängda ' + fyll.filter(f=>f.hur==='tid').length + ' · plusdagar ' + dR.filter(x=>x>0).length + '/' + dR.length);
}
