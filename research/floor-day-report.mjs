// Writes floor-day-results.md from .matning/floor-day/results.json.
import {readFile,writeFile} from 'node:fs/promises';
import {DAY_DIR} from './floor-day-run.mjs';

const r=JSON.parse(await readFile(new URL('results.json',DAY_DIR),'utf8'));
const pct=(x,d=1)=>x==null?'–':(x>=0?'':'−')+Math.abs(x*100).toFixed(d).replace('.',',')+' %';
const num=(x,d=2)=>x==null?'–':(x<0?'−':'')+Math.abs(x).toFixed(d).replace('.',',');
const hours=x=>x==null?'–':num(x,0)+' h';
const row=cells=>'| '+cells.join(' | ')+' |';
const names=Object.keys(r.development),sel=r.selected,focus=r.focus,lines=[],out=s=>lines.push(s);
const label=n=>n==='pulse12'?'pulse12 (gamla borden)':n;

out('# Dagshandel för trading floor: resultat');
out('');
out(`Körd ${r.generatedAt}. [Protokollet](floor-day-protocol.md) låstes före första resultaträkningen. Urvalet skrevs till \`selection-lock.json\` innan valideringen räknades.`);
out('');
out(sel?`**Vald kandidat: \`${sel}\`** (48-timmarsutbrott när minst 5 av bordens 9 trender pekar uppåt, stopp i 48-timmarskanalens mittpunkt som följer med uppåt, högst 72 timmar). Valideringen ${r.validated?'**godkändes**':'**underkändes**'}. Bästa endagsvariant: \`${r.shortest}\`.`:'**Ingen kandidat var behörig.**');
out('');
out('Den valda dagsregeln tjänar pengar men mycket mindre än bordens nuvarande trendstrategi. Med de gamla bordens hävstångsregel på Bybit förlorade varje kandidat stort i valideringen, och `pulse12` gick till noll i båda perioderna.');
out('');
const table=(period,title)=>{
  out(`## ${title}`);out('');
  out(row(['Regel','Netto','Stress','CAGR','Sharpe','Max nedgång','Affärer','Vinstandel','Snitt-R','Hålltid median / p90','Tid i marknad']));
  out(row(['---','---:','---:','---:','---:','---:','---:','---:','---:','---:','---:']));
  for(const n of names){
    const m=r[period][n].normal,s=r[period][n].stress;
    out(row([(n===sel?'**':'')+label(n)+(n===sel?'**':''),pct(m.net),pct(s.net),pct(m.cagr),num(m.sharpe),pct(m.maxDD),m.stats.closed,pct(m.stats.winShare,0),num(m.stats.meanR,3),hours(m.stats.medianHours)+' / '+hours(m.stats.p90Hours),pct(m.timeInMarket,1)]));
  }
  const t=r.trendDesks[period];
  out(row(['Bordens trendstrategi (referens, σ\\* = 100 %)',pct(t.net),'',pct(t.cagr),num(t.sharpe),pct(t.maxDD),t.roundTrips,'','','','']));
  out('');
};
table('development','Utveckling 2021-06-01 till 2024-01-01 (1 % risk per affär)');
out(`Behöriga: ${r.eligible.map(n=>'`'+n+'`').join(', ')||'inga'}. De övriga saknade positivt netto vid stressad slippage eller tillräckligt många affärer.`);
out('');
table('validation','Validering 2024-01-01 till 2026-09-23 (1 % risk per affär)');
out('Dagsreglerna räknas med 1 % risk per affär och trendstrategin med sin egen storlek (σ\\* = 100 %). Jämför därför Sharpe, som inte beror på storleken, och tabellen över risknivåer nedan.');
out('');

out(`## Risknivåer för \`${focus}\``);out('');
out(row(['Risk per affär','Utv. netto','Utv. CAGR','Utv. nedgång','Val. netto','Val. CAGR','Val. nedgång','Likvidationer']));
out(row(['---:','---:','---:','---:','---:','---:','---:','---:']));
for(const [k,v] of Object.entries(r.risk).sort((a,b)=>+a[0]-+b[0]))out(row([pct(+k,1),pct(v.development.net),pct(v.development.cagr),pct(v.development.maxDD),pct(v.validation.net),pct(v.validation.cagr),pct(v.validation.maxDD),v.development.liquidations+v.validation.liquidations]));
out('');
const t=r.trendDesks.validation;
out(`I valideringen planade avkastningen ut runt 5 % risk (cirka ${pct(r.risk['0.05'].validation.cagr,0)} per år med ${pct(r.risk['0.05'].validation.maxDD,0)} nedgång). Bordens trendstrategi gav ${pct(t.cagr,0)} per år med ${pct(t.maxDD,0)} nedgång i samma period, och cirka 18 % per år med 22 % nedgång på halva sin risknivå.`);
out('');

out('## Gamla bordens hävstångsregel på Bybit (scenario)');out('');
out(`De gamla bordens storleksfunktion \`openActivePosition\` oförändrad: högst 50 % av saldot som isolerad marginal, högst 50 % planerad förlust vid stoppet och högsta hävstång inom Bybits kontraktsgräns och risknivåer (hämtade ${r.contractsFetchedAt}) med likvidationen minst 25 % av stoppavståndet under stoppet. Dagens gränser på historiska priser.`);
out('');
out(row(['Regel','Utv. netto','Utv. nedgång','Val. netto','Val. nedgång','Hävstång median (högsta)','Median planerad risk','Likvidationer']));
out(row(['---','---:','---:','---:','---:','---:','---:','---:']));
for(const n of names){
  const d=r.bybit[n].development,v=r.bybit[n].validation,l=v.stats.leverage;
  out(row([label(n),pct(d.net),pct(d.maxDD),pct(v.net),pct(v.maxDD),l?num(l.median,0)+'× ('+num(l.max,0)+'×)':'–',pct(v.stats.medianRiskPct,0),d.liquidations+v.liquidations]));
}
out('');
out('Ingen position likviderades: stoppet ligger alltid före likvidationen. Förlusterna kommer från vanliga stopp med över en tredjedel av bordet i spel per affär. Med 30–45 % vinnande affärer räcker några förluster i rad för att nästan tömma ett bord, även när regeln har ett litet övertag. Det är samma matematik som tömde de gamla borden.');
out('');

const f=r.validation[focus].normal;
out(`## Den valda regeln i detalj`);out('');
out(`- Hålltid: median ${hours(f.stats.medianHours)}, 90:e percentil ${hours(f.stats.p90Hours)}. Borden var i marknaden ${pct(f.timeInMarket,1)} av tiden i valideringen, ungefär ${num(f.stats.closed/6/2.73,0)} affärer per bord och år.`);
out(`- År för år (1 % risk): ${[...Object.entries(r.development[focus].normal.years),...Object.entries(f.years)].map(([y,v])=>y+' '+pct(v)).join(', ')}. Regeln tjänar i tydliga trendår och står still annars.`);
out(`- På Bybits egna kontrakt i valideringen: ${pct(r.venue.net)} netto, Sharpe ${num(r.venue.sharpe)}.`);
out(`- Utan trendfiltret (\`b24-n-72\`) förlorade samma typ av utbrott i båda perioderna. Filtret från bordens trendstrategi är det som gör regeln användbar.`);
out('');
out('## Begränsningar');out('');
out('- Retrospektivt: perioderna användes redan när trendstrategin valdes, och fem kandidater jämfördes. De sex coinen är dagens överlevare.');
out('- Timstaplar: stoppet fylls vid stoppnivån om stapelns lägsta når den, vid gap på öppningen. Verklig fyllning och slippage vid snabba rörelser kan bli sämre. Ingen orderbok eller minsta orderstorlek.');
out('- Hävstångsscenariot använder dagens Bybit-gränser på historiska priser och de gamla bordens egen, förenklade likvidationsmodell.');
out('');
out('## Reproduktion');out('');
out('Kör `node research/floor-trend-data.mjs --download --bybit` (samma data som trendtestet), hämta kontraktsgränser till `.matning/floor-day/contracts.json`, kör sedan `node research/floor-day-run.mjs` och `node research/floor-day-report.mjs`.');
out('');
out(row(['Fil','SHA-256']));out(row(['---','---']));
out(row(['Protokoll',r.hashes.protocol]));out(row(['Motor (`floor-day-core.mjs`)',r.hashes.core]));out(row(['Bybit-gränser',r.hashes.contracts]));
await writeFile(new URL('floor-day-results.md',import.meta.url),lines.join('\n')+'\n');
console.log('wrote research/floor-day-results.md');
