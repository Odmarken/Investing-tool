import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const r=JSON.parse(readFileSync(new URL('../.matning/crypto-slow/results.json',import.meta.url),'utf8'));
const books=[r.developmentBenchmark,...r.development.flatMap(x=>[x.base,x.stress]),...r.later.flatMap(x=>[x.base,x.stress]),...r.years.flatMap(y=>y.results)];
for(const b of books){
  assert.ok(Number.isFinite(b.balance)&&Number.isFinite(b.maxDDPct)&&b.balance>=0);
  assert.ok(Math.abs(100+b.trades.reduce((s,t)=>s+t.pnl,0)-b.balance)<1e-8);
  assert.ok(Math.abs(b.trades.reduce((s,t)=>s+t.fees,0)-b.fees)<1e-8);
  assert.ok(b.daily.every(d=>Number.isFinite(d.equity)&&d.exposure>=0&&d.exposure<=1+1e-12));
  for(const t of b.trades){
    assert.ok(t.opened>=b.from&&t.closed<=b.to&&t.closed>t.opened);
    if(b.variant!=='buyhold')assert.equal(new Date(t.opened).getUTCDay(),1);
  }
}
const names={momentum28:'28 dagars momentum',momentum84:'84 dagars momentum',rotation28:'Rotation, 28 dagar',buyhold:'Köp och behåll'};
const f=(x,n=1)=>Number.isFinite(x)?x.toFixed(n):'–';
let text=`# Nätgranskning och nytt kryptotest\n\nGenomförd ${r.createdAt}. **Långsammare momentum gav positiva historiska totalresultat i två av tre varianter, men ingen klarade den förutbestämda riskgränsen i utvecklingsperioden. Ingen strategi aktiverades.**\n\n`+
  `## Vad granskningen av den befintliga motorn visade\n\n`+
  `1. I \`motor.js:moveBounds\` används Nasdaq-inställningarna 50–400 dividerat med referenspriset 23 150 även för krypto. Med standardvärden blir kryptomålens tillåtna avstånd cirka 0,216–1,728 % av aktuellt pris. Det är ett ärvt antagande, inte en uppmätt kryptoregel.\n`+
  `2. \`makeSignal\` flyttar strategins ursprungliga stopp så att avståndet ligger inom 0,55–3,2 ATR. Ett reproducerat anrop med entry 100, begärt stopp 98 och ATR 0,1 returnerade stopp **99,68**. En beskrivning om stopp bortom en svepnivå kan därför avvika från de nivåer som faktiskt handlas. Detta motiverar särskild kontroll av strukturstoppar; det bevisar inte att borttagen begränsning skapar vinst.\n`+
  `3. \`gradeFor\` sätter A när minst tre familjer röstar åt samma håll. Familjerna använder delvis samma prisinformation; detta är inget bevis för tre oberoende signaler eller högre uppmätt vinstchans.\n`+
  `4. Den tidigare forskningen utvärderade huvudsakligen aktiva A-signaler och en intradagsmotor med snäva prisrörelser. Negativa utfall där gäller denna implementation och testmetod. De bevisar inte att alla former av trendföljning eller hela begreppet ICT saknar användning.\n\n`+
  `Jag bedömer därför att signalernas konstruktion, tidshorisont och exekvering måste prövas separat. Att lägga ännu en AI ovanpå samma kandidater löser inte dessa frågor.\n\n`+
  `## Vad relevanta primärkällor faktiskt säger\n\n`+
  `- Liu, Tsyvinski och Wu finner historiska momentumfaktorer i kryptons tvärsnitt. Deras arbetsrapport diskuterar portföljer på veckohorisonter och en bred myntpopulation. Den ger inte stöd för att vår femminutersstrategi eller dagens tre största valda coins ska ge samma resultat. [NBER, publicerad version i Journal of Finance 2022](https://www.nber.org/papers/w25882).\n`+
  `- Bysik och Ślepaczuks förpublicering från 2026 undersöker timvisa BTC-prognoser med 27 tidsordnade testfönster. Enkla täta signalbyten försämras kraftigt av kostnader; färre kostnadsmotiverade byten förbättrar vissa konfigurationer. Författarna visar inte säker statistisk överlägsenhet mot köp och behåll, och resultaten varierar mellan marknadslägen. Det är en hypoteskälla, inte ett färdigtestat handelssystem. [Förpubliceringen](https://arxiv.org/html/2606.00060v1).\n`+
  `- En studie av 69 tekniska regler på dygns- och minutdata visar att slutsatser påverkas av kostnader och bubbelperioder. Det talar för att mäta realistisk omsättning och olika regimer. [Studien i Journal of International Financial Markets, Institutions and Money](https://www.sciencedirect.com/science/article/pii/S1042443122000816).\n`+
  `- Bailey m.fl. behandlar risken att strategin med bäst historisk kurva bara är resultatet av många försök. Därför låstes tre varianter före testet, och en variant som misslyckas med utvecklingskraven ersätts inte med en senare vinnare. [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).\n\n`+
  `## Eget test: ett tydligt byte av tidshorisont\n\nTre fasta varianter: 28 dagars momentum, 84 dagars momentum och veckovis rotation till starkaste positiva 28-dagarscoin. Beslut tas måndag 00:00 UTC på färdiga dygnsdata och utförs till nästa öppning med slippage. BTC/ETH/SOL, spot, endast lång/kontanter, ingen belåning. `+
  `Denna förenklade strategi är vår egen hypotes, ingen direkt reproduktion av någon artikel. Den håller positioner i veckor snarare än minuter.\n\n`+
  `Avgift 0,10 % och slippage 0,05 % per sida; stress fördubblar slippage. Köp och behåll använder samma coins, startfördelning och kostnader. Inga passiva ränteintäkter antas. Avgiften är ett antagande utifrån [Bybits publicerade grundtabell](https://www.bybit.com/en/help-center/article/Trading-Fee-Structure), inte en avläsning av användarens konto.\n\n`+
  `### Utveckling och urval: 2023–2024\n\n| Variant | Nettoavkastning | Max daglig nedgång | Avslutade innehav |\n|---|---:|---:|---:|\n`+
  [...r.development.map(x=>x.base),r.developmentBenchmark].map(b=>`| ${names[b.variant]} | ${f(b.returnPct)} % | ${f(b.maxDDPct)} % | ${b.n} |`).join('\n')+'\n\n'+
  `Förutbestämd gräns var högst 35 % maximal daglig nedgång, positiv avkastning även under stress och minst tio innehav. **Ingen kandidat kvalificerade sig.** Regeln ändrades inte efteråt.\n\n`+
  `### Senare period: 1 januari 2025–9 september 2026\n\nDetta är diagnostik av samtliga varianter, inte ett sluttest av en godkänd kandidat eftersom urvalet ovan blev tomt. Perioden överlappar också tidigare forskning i projektet.\n\n`+
  `| Variant | Nettoavkastning | Max daglig nedgång | Innehav | Stressavkastning | Genomsnittlig innehavstid |\n|---|---:|---:|---:|---:|---:|\n`+
  r.later.map(({base:b,stress})=>`| ${names[b.variant]} | ${f(b.returnPct)} % | ${f(b.maxDDPct)} % | ${b.n} | ${f(stress.returnPct)} % | ${f(b.meanHoldingDays)} dygn |`).join('\n')+'\n\n'+
  `### Årsvisa kontrollkörningar\n\nVarje år startar här med nytt kapital och inga innehav. De årsvisa procentsatserna ska därför inte multipliceras för att återskapa den sammanhängande portföljen ovan; portföljvikter och ingångsläge skiljer sig. 2026 slutar 9 september.\n\n`+
  `| År | 28 dagar | 84 dagar | Rotation | Köp och behåll |\n|---|---:|---:|---:|---:|\n`+
  r.years.map(y=>`| ${y.year} | ${y.results.map(b=>f(b.returnPct)+' %').join(' | ')} |`).join('\n')+'\n\n'+
  `### Coinbidrag i den senare sammanhängande perioden\n\n| Variant | Coin | Bidrag i dollar, startkonto 100 dollar | Innehav |\n|---|---|---:|---:|\n`+
  r.later.flatMap(({base:b})=>b.byCoin.map(c=>`| ${names[b.variant]} | ${c.symbol} | ${f(c.pnl,2)} | ${c.n} |`)).join('\n')+'\n\n'+
  `## Slutsats för fortsatt utveckling\n\nDet finns mer stöd för att utveckla en separat strategi som fångar större rörelser och handlar mer sällan än för att fortsätta lägga filter på den nuvarande intradagsmotorn. Detta är en slutsats från koden, källorna och vårt experiment tillsammans. `+
  `Positiva historiska resultat räcker fortfarande inte: nedgångarna är stora, 2026-kontrollen är negativ för samtliga aktiva varianter, universum är bara tre överlevande coins och ingen variant klarade urvalsreglerna. `+
  `Nästa forskningsfråga är en i förväg bestämd riskstyrning med lägre exponering och tydliga kriterier för framåtriktad demo, samt separat kontroll av strukturstopparna. Att efteråt sänka risken bara tills just detta test passerar skulle vara ytterligare anpassning till historiken.\n\n`+
  `## Granskning och reproduktion\n\n${books.length} simulerade portföljer kontrollerades för saldo = startkapital + summa realiserad P/L, full avgiftsavstämning, giltiga handelstider och exponering utan belåning. Tester verifierar att framtida stängningspriser inte påverkar tidigare beslut och att oförändrade positioner inte belastas med nya handelsavgifter varje vecka. `+
  `Alla tre prisfiler innehåller 1 440 sammanhängande dygnsstaplar och SHA-256. Nedgång mäts på dygnsstängningar och kan underskatta intradagsrisk. Minsta orderstorlekar, delavslut och individuella kontofees simuleras inte.\n\n`+
  `- [Förutbestämt protokoll](crypto-slow-protocol.md).\n- Data: [Bybits offentliga Kline API](https://bybit-exchange.github.io/docs/v5/market/kline).\n`+
  `- Kör \`node research/crypto-slow-data.mjs --download\`, \`node research/crypto-slow-run.mjs\`, \`node research/crypto-slow-report.mjs\`.\n`+
  `- Fullständiga transaktioner och daglig kapitalserie: \`.matning/crypto-slow/results.json\`. Ingen konto- eller signallogik på sidan ändras av dessa kommandon.\n`;
writeFileSync(new URL('crypto-network-review.md',import.meta.url),text);
console.log(JSON.stringify({audit:'passed',portfolios:books.length,selected:r.selected}));
