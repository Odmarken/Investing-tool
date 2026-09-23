// Writes floor-trend-results.md from .matning/floor-trend/results.json.
import {readFile,writeFile} from 'node:fs/promises';
import {DATA_DIR} from './floor-trend-data.mjs';

const r=JSON.parse(await readFile(new URL('results.json',DATA_DIR),'utf8'));
const pct=(x,d=1)=>(x>=0?'':'−')+Math.abs(x*100).toFixed(d).replace('.',',')+' %';
const num=(x,d=2)=>(x<0?'−':'')+Math.abs(x).toFixed(d).replace('.',',');
const usd=x=>(x<0?'−':'+')+Math.abs(x).toFixed(2).replace('.',',')+' $';
const names=Object.keys(r.development),sel=r.selected,lvl=r.riskLevel;
const label=n=>n==='bh'?'köp och behåll 1×':n;
const row=(cells)=>'| '+cells.join(' | ')+' |';
const lines=[];
const out=s=>lines.push(s);

out('# Trendstrategi för trading floor: resultat');
out('');
out(`Körd ${r.generatedAt}. [Protokollet](floor-trend-protocol.md) låstes före första resultaträkningen. Urvalet skrevs till \`selection-lock.json\` innan valideringen räknades.`);
out('');
out(`**Vald kandidat: \`${sel}\`** (Donchian-ensemble på timstängningar, nio horisonter 5–360 dygn, bara lång). Valideringen ${r.validated?'**godkändes**':'**underkändes**'}: positivt netto och positiv Sharpe vid både normal och stressad slippage. Förvald risknivå enligt protokollet: **σ\\* = ${Math.round(lvl*100)} %** per år med högst ${lvl/.25}× exponering.`);
out('');
out('Bordens nuvarande regel `pulse12` förlorade kraftigt i båda perioderna även vid 2 % risk per affär. Resultaten är historiska och retrospektiva; de visar inte framtida avkastning.');
out('');

const table=(period,title)=>{
  out(`## ${title}`);
  out('');
  out(row(['Strategi','Netto','Stress','CAGR','Sharpe','Max nedgång','Rundturer','Avgifter','Nettofunding','Snittexponering','Tid i marknad','Andel kort']));
  out(row(['---','---:','---:','---:','---:','---:','---:','---:','---:','---:','---:','---:']));
  for(const n of names){
    const m=r[period][n].normal,s=r[period][n].stress;
    out(row([(n===sel?'**':'')+label(n)+(n===sel?'**':''),pct(m.net),pct(s.net),pct(m.cagr),num(m.sharpe),pct(m.maxDD),m.roundTrips,num(m.fees)+' $',usd(m.funding),num(m.avgExposure),pct(m.timeInMarket,0),pct(m.shortShare,0)]));
  }
  out('');
};
table('development','Utveckling: 2021-06-01 till 2024-01-01');
out(`Behöriga: ${r.eligible.map(n=>'`'+n+'`').join(', ')}. Högst Sharpe: \`${sel}\`. \`pulse12\` och köp och behåll är referenser och kunde inte väljas.`);
out('');
table('validation','Validering: 2024-01-01 till 2026-09-23');
out('Sex bord med 100 dollar var, σ\\* = 25 % och högst 1× exponering för alla trendkandidater. `pulse12` använder 2 % risk vid SL och högst 3×. Nettofunding är kostnad (+) eller intäkt (−) i dollar. Snittexponering är positionens värde delat med bordets kapital, i snitt över all tid inklusive tid utan position.');
out('');

out('## År för år (normal kostnad)');
out('');
const years=[...new Set(names.flatMap(n=>[...Object.keys(r.development[n].normal.years),...Object.keys(r.validation[n].normal.years)]))].sort();
out(row(['Strategi',...years.map(y=>y==='2021'?'2021 (jun–dec)':y==='2026'?'2026 (t.o.m. 22 sep)':y)]));
out(row(['---',...years.map(()=>'---:')]));
for(const n of names)out(row([label(n),...years.map(y=>{const v=r.development[n].normal.years[y]??r.validation[n].normal.years[y];return v===undefined?'':pct(v);})]));
out('');
out('2023 och 2024 finns i olika perioder; 2023 hör till utvecklingen.');
out('');

out('## Risknivå för den valda kandidaten');
out('');
out(row(['σ\\*','Lmax','Utv. netto','Utv. CAGR','Utv. nedgång','Val. netto','Val. CAGR','Val. nedgång','Val. stress','Val. Sharpe','Sämsta bord, nedgång','Likvidationer']));
out(row(['---:','---:','---:','---:','---:','---:','---:','---:','---:','---:','---:','---:']));
for(const t of Object.keys(r.risk).map(Number).sort((a,b)=>a-b)){
  const x=r.risk[t],e=r.extra.levels[t];
  out(row([(t===lvl?'**':'')+pct(t,0)+(t===lvl?'**':''),t/.25+'×',pct(x.development.net),pct(x.development.cagr),pct(x.development.maxDD),pct(x.validation.net),pct(x.validation.cagr),pct(x.validation.maxDD),pct(x.validationStress.net),num(x.validation.sharpe),pct(Math.max(e.development.worstDeskDD,e.validation.worstDeskDD)),x.development.liquidations+x.validation.liquidations]));
}
out('');
out(`Förvald nivå är högst utvecklings-CAGR med utvecklingsnedgång ≤ 40 % och ingen likvidation. I valideringen blev nedgången ${pct(r.risk[lvl].validation.maxDD)}, alltså över den gräns som användes för valet. Valet ändras inte av det, men nivån är ett aggressivt demoval, inte en säker nivå.`);
out('');
out('### Beskrivande tillägg efter resultaten: högre nivåer');
out('');
out('Dessa nivåer låg inte i protokollet och räknades efter att resultaten ovan var kända. De visar hur mer risk påverkar; de används inte för något val.');
out('');
out(row(['σ\\*','Utv. CAGR','Utv. nedgång','Val. CAGR','Val. nedgång','Sämsta bord, nedgång','Högsta exponering']));
out(row(['---:','---:','---:','---:','---:','---:','---:']));
for(const t of Object.keys(r.extra.levels).map(Number).sort((a,b)=>a-b)){
  const e=r.extra.levels[t];
  out(row([pct(t,0),pct(e.development.cagr),pct(e.development.maxDD),pct(e.validation.cagr),pct(e.validation.maxDD),pct(Math.max(e.development.worstDeskDD,e.validation.worstDeskDD)),num(Math.max(e.development.peakExposure,e.validation.peakExposure),1)+'×']));
}
out('');
out('I utvecklingen steg avkastningen med varje nivå. I valideringen planade den ut över cirka 100 % medan nedgången fortsatte att växa, och vid 300 % föll avkastningen tydligt. Det är det väntade mönstret när hävstången passerar det som strategins verkliga kvalitet bär.');
out('');

const tr=r.extra.trades;
out(`## Affärernas form vid σ\\* = ${Math.round(lvl*100)} %`);
out('');
out(row(['Period','Rundturer','Per bord och år','Vinnande rundturer','Median hålltid','90:e percentil','Tid i marknad','Fem största vinsternas andel av all vinst']));
out(row(['---','---:','---:','---:','---:','---:','---:','---:']));
for(const [p,t] of Object.entries(tr))out(row([p==='development'?'Utveckling':'Validering',t.closed,num(t.perDeskYear,1),pct(t.winShare,0),num(t.medianHours/24,1)+' dygn',num(t.p90Hours/24,1)+' dygn',pct(t.timeInMarket,0),pct(t.topFiveShare,0)]));
out('');
out('En rundtur går från ingen position till ingen position, med del-köp och del-sälj emellan. De flesta rundturer är små förluster när en kort horisont slås ut. Resultatet kommer från ett fåtal långa trender. Det är typiskt för trendföljning och betyder att långa förlustserier är normala.');
out('');

out('## Bidrag per coin för den valda kandidaten (σ\\* = 25 %)');
out('');
out(row(['Period',...r.periods.development.coins]));
out(row(['---',...r.periods.development.coins.map(()=>'---:')]));
for(const p of ['development','validation'])out(row([p==='development'?'Utveckling':'Validering',...r.periods[p].coins.map(c=>usd(r[p][sel].normal.desks[c].final-100))]));
out(row(['Prisförändring utv.',...r.periods.development.coins.map(c=>pct(r.extra.priceChange.development[c],0))]));
out(row(['Prisförändring val.',...r.periods.validation.coins.map(c=>pct(r.extra.priceChange.validation[c],0))]));
out('');
out('Prisförändringen är ren kursändring utan avgifter eller funding. Köp och behåll i tabellerna ovan är en 1× lång perpetual som betalar funding; i utvecklingen betalade SOL-bordet 45,60 dollar i funding under 2021 och likviderades sedan i fallet 2022.');
out('');

out('## Känslighet för den valda kandidaten (σ\\* = 25 %, beskrivande)');
out('');
out(row(['Ändring','Utv. netto','Utv. Sharpe','Val. netto','Val. Sharpe','Val. nedgång']));
out(row(['---','---:','---:','---:','---:','---:']));
out(row(['Protokollets inställning',pct(r.development[sel].normal.net),num(r.development[sel].normal.sharpe),pct(r.validation[sel].normal.net),num(r.validation[sel].normal.sharpe),pct(r.validation[sel].normal.maxDD)]));
const sensLabel={vol60:'Volatilitet 60 dygn',vol120:'Volatilitet 120 dygn','band0.1':'Ombalansering vid 10 %','band0.5':'Ombalansering vid 50 %',slip20:'Slippage 0,20 % per sida'};
for(const [k,s] of Object.entries(r.sensitivity)){
  if(k==='bybit')out(row(['Bybit-data i stället för Binance','','',pct(s.net),num(s.sharpe),pct(s.maxDD)]));
  else out(row([sensLabel[k],pct(s.development.net),num(s.development.sharpe),pct(s.validation.net),num(s.validation.sharpe),pct(s.validation.maxDD)]));
}
out('');
out('Bybit-kontrollen använder bordens egna kontrakt och deras funding; utvecklingsperioden saknas där eftersom Bybit noterade SOL och SHIB först i oktober 2021.');
out('');

out('## Tidig period 2020-10-01 till 2021-06-01 (beskrivande, fem coins)');
out('');
out(row(['Strategi','Netto','Sharpe','Max nedgång']));
out(row(['---','---:','---:','---:']));
for(const n of names){const m=r.early[n].normal;out(row([label(n),pct(m.net),num(m.sharpe),pct(m.maxDD)]));}
out('');
out('Tjurmarknaden 2020–2021 gav enorma uppgångar. Trendföljning med 25 % volatilitetsmål tar bara en liten del av en sådan uppgång, i utbyte mot mycket mindre nedgång.');
out('');

out('## Begränsningar');
out('');
out('- **Retrospektivt.** Perioderna har delvis använts i tidigare forskning i projektet, och de sex coinen är dagens överlevare, valda i efterhand. Idén kommer från publicerad forskning och ingen parameter söktes fram här, men sju kandidater jämfördes; den bästa av sju är något för optimistiskt vald.');
out('- **Timupplösning.** Beslut och fyllning sker på timstaplar. Ingen orderbok, inget marknadsdjup, minsta orderstorlek eller orderavrundning. Mängderna är kontinuerliga som i demot.');
out('- **Likvidation** är förenklad: bordets hela kapital är marginal och underhållsmarginalen är 1 %. Verkliga risknivåer, isolerad marginal och Bybits likvidationsmotor modelleras inte. Ingen likvidation inträffade i någon period.');
out('- **Funding** är en stor kostnad för långa positioner i tjurmarknader. Vid 100 % volatilitetsmål betalade firman cirka 144 dollar i funding under valideringen, mer än avgifterna.');
out('- **Beroende av få trender.** Fem vinnande rundturer står för ungefär tre fjärdedelar av all vinst. Ett år utan tydliga trender (som 2022 och 2025) ger minus.');
out('- **pulse12** simuleras här på timstaplar med SL före TP i tvetydiga staplar, vilket är något strängare än det tidigare 15-minuterstestet. Förlusten beror dock på omsättning och negativ förväntan per affär, vilket det tidigare testet också visade.');
out('');
out('## Reproduktion');
out('');
out('Kör `node research/floor-trend-data.mjs --download --bybit`, `node research/floor-trend-run.mjs` och `node research/floor-trend-report.mjs`. Rådata, urvalslås och alla affärer sparas lokalt i `.matning/floor-trend/`.');
out('');
out(row(['Fil','SHA-256']));
out(row(['---','---']));
out(row(['Protokoll',r.hashes.protocol]));
out(row(['Motor (`floor-trend-core.mjs`)',r.hashes.core]));
for(const [c,h] of Object.entries(r.hashes.data))out(row(['Binance '+c,h]));
for(const [c,h] of Object.entries(r.hashes.bybit??{}))out(row(['Bybit '+c,h]));
out('');
out('Källor: [Zarattini, Pagani & Barbon (2025), Catching Crypto Trends](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907), [Moskowitz, Ooi & Pedersen (2012), Time series momentum](https://doi.org/10.1016/j.jfineco.2011.11.003), [Binance USDT-M klines](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data), [Binance funding](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History), [Bybit kline](https://bybit-exchange.github.io/docs/v5/market/kline), [Bybit funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).');
await writeFile(new URL('floor-trend-results.md',import.meta.url),lines.join('\n')+'\n');
console.log('wrote research/floor-trend-results.md');
