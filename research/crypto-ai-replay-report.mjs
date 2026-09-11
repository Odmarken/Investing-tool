import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CRYPTO_AI_MODEL as model} from '../crypto-ai-model.js';
const r=JSON.parse(readFileSync(new URL('../.matning/crypto/ai-replay.json',import.meta.url),'utf8'));
assert.equal(r.complete,true);
assert.equal(r.modelVersion,model.version);
assert.equal(r.modelHash,createHash('sha256').update(readFileSync(new URL('../crypto-ai-model.js',import.meta.url))).digest('hex'));
assert.equal(new Set(r.rows.map(x=>x.key)).size,r.rows.length);
const hardKeys=['data','geometry','net','age','chase'];
for(const row of r.rows){
  assert.ok(row.at>=model.trainEnd&&row.at<r.to);
  assert.ok(Number.isFinite(row.expectedR));
  assert.equal(row.accepted,row.expectedR>=model.threshold&&row.checks.filter(c=>hardKeys.includes(c.key)).every(c=>c.ok));
  assert.equal(row.selective,row.checks.every(c=>c.ok));
  if(row.status==='closed'){
    assert.ok(row.closed<=r.to&&row.closed>row.at&&row.closed<=row.deadline);
    const dir=row.side==='long'?1:-1;
    const net=dir*(row.exit-row.entry)-row.fee*(row.entry+row.exit);
    assert.ok(Math.abs(net/row.risk-row.netR)<1e-10);
    assert.ok(Number.isFinite(row.stressR));
  }
}
const f=(x,n=3)=>Number.isFinite(x)?x.toFixed(n):'–';
const line=s=>`| ${s.label} | ${s.n} | ${s.closed} | ${f(s.winRate===null?null:s.winRate*100,1)} % | ${f(s.meanR)} | ${f(s.stressMeanR)} | ${s.ci?f(s.ci.low)+' till '+f(s.ci.high):'För få utfall'} |`;
const ai=r.stats.find(s=>s.label==='AI skulle ta');
const positive=r.rows.filter(x=>x.expectedR>=model.threshold),positiveDone=positive.filter(x=>x.status==='closed');
const positiveMean=positiveDone.length?positiveDone.reduce((s,x)=>s+x.netR,0)/positiveDone.length:null;
const positiveNetFailures=positive.filter(x=>x.checks.some(c=>c.key==='net'&&!c.ok)).length;
let report=`# Fryst krypto-AI: utökad historisk uppspelning\n\nKörd ${r.createdAt}. Modell: \`${r.modelVersion}\`. Ingen omträning, tröskeländring eller ändring av sidans handel.\n\n`+
  `## Resultat\n\n12 juli–9 september 2026, sju coins. ${r.rows.length} unika observerade A-signaler, även när en annan position hade varit öppen. `+
  `AI skulle ta ${ai.n}; ${ai.closed} har bedömbart utfall inom perioden.\n\n`+
  `| Urval | Observerade | Avslutade | Positiva | Snitt netto-R | Dubbel slippage, R | 95 % veckoblocksintervall |\n|---|---:|---:|---:|---:|---:|---|\n`+
  r.stats.map(line).join('\n')+'\n\n'+
  `R är utfall relativt beräknad nettoförlust vid stopp. Avgift 0,055 % och slippage 0,05 % per sida; stress använder 0,10 % slippage och normaliserar med sin egen stopprisk. Funding ingår inte. Väntande och okända utfall räknas inte som förluster. Signalutfallen kan överlappa och är **inte kontots avkastning**.\n\n`+
  `## Varför AI avstår\n\nPrognoser: lägst ${f(r.diagnostics.prediction.min)} R, median ${f(r.diagnostics.prediction.median)} R, högst ${f(r.diagnostics.prediction.max)} R. `+
  `${r.diagnostics.aboveThreshold} prognoser når den frysta tröskeln +${f(model.threshold,2)} R före grundkraven. ${ai.n} klarar också grundkraven.\n\n`+
  `Av prognoserna över tröskeln saknar ${positiveNetFailures} netto-R:R ≥1,5. Efterhandskontroll av dessa ${positiveDone.length} avslutade hypotetiska observationer ger ${f(positiveMean)} R i snitt. Det visar inte att borttagna grundkrav skulle göra modellen lönsam. Inga krav ändrades.\n\n`+
  `Underkända kontrollpunkter (samma signal kan sakna flera):\n\n| Kontroll | Antal |\n|---|---:|\n`+
  Object.entries(r.diagnostics.failures).map(([k,n])=>`| ${k} | ${n} |`).join('\n')+'\n\n'+
  `## Rangordning som diagnostik\n\nFem lika stora grupper efter modellens prognos, lägst till högst. Detta är efterhandsdiagnostik; grupperna användes inte för att välja en ny modell eller tröskel.\n\n`+
  `| Grupp | Avslutade | Prognos R | Utfall R | 95 % veckoblocksintervall |\n|---|---:|---:|---:|---|\n`+
  r.diagnostics.quintiles.map(q=>`| ${q.quintile} | ${q.n} | ${f(q.predicted)} | ${f(q.actual)} | ${q.ci?f(q.ci.low)+' till '+f(q.ci.high):'För få utfall'} |`).join('\n')+'\n\n'+
  `## Per coin\n\n| Coin | Urval | Avslutade | Snitt netto-R |\n|---|---|---:|---:|\n`+
  r.bySymbol.flatMap(c=>c.stats.map(s=>`| ${c.symbol} | ${s.label} | ${s.closed} | ${f(s.meanR)} |`)).join('\n')+'\n\n'+
  `## Tolkning och begränsningar\n\n`+
  (ai.n===0?'AI undvek att handla i denna uppspelning. Det kan skydda mot förluster i signalurvalet men visar ingen förmåga att tjäna pengar. Det går inte att beräkna en vinstprocent för noll trades.':'AI:s faktiska antal, osäkerhet och kostnadsstress måste bedömas tillsammans; enstaka vinster visar ingen stabil fördel.')+
  `\n\nDen publicerade modellen tränades på 843 kandidater från basportföljen före 12 juli. Detta bredare urval av alla observerade A-signaler är nytt för denna uppspelning, men prisperioden har tidigare granskats. Resultatet är retrospektivt, inte ett nytt orört sluttest.\n\n`+
  `Modell och signaler får endast prisdata till observationstidpunkten. Framtida staplar används därefter för facit, aldrig för urval eller omträning. `+
  `Uppspelningen beräknar orderstatus en gång per avslutad femminutersstapel med standardinställningar och neutrala nyheter. Den reproducerar inte alla intrabar-signaler eller personliga inställningar i den öppna webbläsaren. `+
  `Precis som sidans AI-logg ignoreras beslutsstapeln och stoppen/målet följs i högst 24 h; snabba intrabarträffar kan därför missas. `+
  `Spotpriser, ingen funding, orderbok eller faktisk perpetual-exekvering. Veckoblocksintervallen är ungefärliga och baseras på få veckor.\n\n`+
  `## Kontroller och reproduktion\n\nAlla ${r.rows.length} rader har kontrollerats för unik nyckel, fryst modellbeslut, kontrollresultat och tidsgränser. Samtliga avslutade netto-R har räknats om från entry, exit och avgifter. `+
  `Prisfilernas SHA-256 stämde med modellens träningsproveniens före körning; modellfilens hash är oförändrad efter körning.\n\n`+
  `- [Förutbestämt protokoll](crypto-ai-replay-protocol.md)\n- Kör \`node research/crypto-ai-replay.mjs\` och \`node research/crypto-ai-replay-report.mjs\`. Befintlig lokal cache krävs.\n- Fullständiga observationer: \`.matning/crypto/ai-replay.json\`.\n`;
writeFileSync(new URL('crypto-ai-replay-results.md',import.meta.url),report);
console.log(JSON.stringify({audit:'passed',observations:r.rows.length,stats:r.stats,diagnostics:r.diagnostics},null,2));
