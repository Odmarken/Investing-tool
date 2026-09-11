# Nätgranskning och nytt kryptotest

Genomförd 2026-09-11T11:14:04.187Z. **Långsammare momentum gav positiva historiska totalresultat i två av tre varianter, men ingen klarade den förutbestämda riskgränsen i utvecklingsperioden. Ingen strategi aktiverades.**

## Vad granskningen av den befintliga motorn visade

1. I `motor.js:moveBounds` används Nasdaq-inställningarna 50–400 dividerat med referenspriset 23 150 även för krypto. Med standardvärden blir kryptomålens tillåtna avstånd cirka 0,216–1,728 % av aktuellt pris. Det är ett ärvt antagande, inte en uppmätt kryptoregel.
2. `makeSignal` flyttar strategins ursprungliga stopp så att avståndet ligger inom 0,55–3,2 ATR. Ett reproducerat anrop med entry 100, begärt stopp 98 och ATR 0,1 returnerade stopp **99,68**. En beskrivning om stopp bortom en svepnivå kan därför avvika från de nivåer som faktiskt handlas. Detta motiverar särskild kontroll av strukturstoppar; det bevisar inte att borttagen begränsning skapar vinst.
3. `gradeFor` sätter A när minst tre familjer röstar åt samma håll. Familjerna använder delvis samma prisinformation; detta är inget bevis för tre oberoende signaler eller högre uppmätt vinstchans.
4. Den tidigare forskningen utvärderade huvudsakligen aktiva A-signaler och en intradagsmotor med snäva prisrörelser. Negativa utfall där gäller denna implementation och testmetod. De bevisar inte att alla former av trendföljning eller hela begreppet ICT saknar användning.

Jag bedömer därför att signalernas konstruktion, tidshorisont och exekvering måste prövas separat. Att lägga ännu en AI ovanpå samma kandidater löser inte dessa frågor.

## Vad relevanta primärkällor faktiskt säger

- Liu, Tsyvinski och Wu finner historiska momentumfaktorer i kryptons tvärsnitt. Deras arbetsrapport diskuterar portföljer på veckohorisonter och en bred myntpopulation. Den ger inte stöd för att vår femminutersstrategi eller dagens tre största valda coins ska ge samma resultat. [NBER, publicerad version i Journal of Finance 2022](https://www.nber.org/papers/w25882).
- Bysik och Ślepaczuks förpublicering från 2026 undersöker timvisa BTC-prognoser med 27 tidsordnade testfönster. Enkla täta signalbyten försämras kraftigt av kostnader; färre kostnadsmotiverade byten förbättrar vissa konfigurationer. Författarna visar inte säker statistisk överlägsenhet mot köp och behåll, och resultaten varierar mellan marknadslägen. Det är en hypoteskälla, inte ett färdigtestat handelssystem. [Förpubliceringen](https://arxiv.org/html/2606.00060v1).
- En studie av 69 tekniska regler på dygns- och minutdata visar att slutsatser påverkas av kostnader och bubbelperioder. Det talar för att mäta realistisk omsättning och olika regimer. [Studien i Journal of International Financial Markets, Institutions and Money](https://www.sciencedirect.com/science/article/pii/S1042443122000816).
- Bailey m.fl. behandlar risken att strategin med bäst historisk kurva bara är resultatet av många försök. Därför låstes tre varianter före testet, och en variant som misslyckas med utvecklingskraven ersätts inte med en senare vinnare. [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

## Eget test: ett tydligt byte av tidshorisont

Tre fasta varianter: 28 dagars momentum, 84 dagars momentum och veckovis rotation till starkaste positiva 28-dagarscoin. Beslut tas måndag 00:00 UTC på färdiga dygnsdata och utförs till nästa öppning med slippage. BTC/ETH/SOL, spot, endast lång/kontanter, ingen belåning. Denna förenklade strategi är vår egen hypotes, ingen direkt reproduktion av någon artikel. Den håller positioner i veckor snarare än minuter.

Avgift 0,10 % och slippage 0,05 % per sida; stress fördubblar slippage. Köp och behåll använder samma coins, startfördelning och kostnader. Inga passiva ränteintäkter antas. Avgiften är ett antagande utifrån [Bybits publicerade grundtabell](https://www.bybit.com/en/help-center/article/Trading-Fee-Structure), inte en avläsning av användarens konto.

### Utveckling och urval: 2023–2024

| Variant | Nettoavkastning | Max daglig nedgång | Avslutade innehav |
|---|---:|---:|---:|
| 28 dagars momentum | 322.9 % | 45.5 % | 33 |
| 84 dagars momentum | 80.3 % | 36.1 % | 30 |
| Rotation, 28 dagar | 519.4 % | 59.4 % | 27 |
| Köp och behåll | 811.1 % | 36.2 % | 3 |

Förutbestämd gräns var högst 35 % maximal daglig nedgång, positiv avkastning även under stress och minst tio innehav. **Ingen kandidat kvalificerade sig.** Regeln ändrades inte efteråt.

### Senare period: 1 januari 2025–9 september 2026

Detta är diagnostik av samtliga varianter, inte ett sluttest av en godkänd kandidat eftersom urvalet ovan blev tomt. Perioden överlappar också tidigare forskning i projektet.

| Variant | Nettoavkastning | Max daglig nedgång | Innehav | Stressavkastning | Genomsnittlig innehavstid |
|---|---:|---:|---:|---:|---:|
| 28 dagars momentum | 28.5 % | 31.9 % | 34 | 27.1 % | 25.6 dygn |
| 84 dagars momentum | -24.9 % | 44.9 % | 17 | -25.3 % | 43.8 dygn |
| Rotation, 28 dagar | 30.1 % | 39.7 % | 21 | 27.4 % | 17.5 dygn |
| Köp och behåll | -29.8 % | 63.4 % | 3 | -29.9 % | 617.0 dygn |

### Årsvisa kontrollkörningar

Varje år startar här med nytt kapital och inga innehav. De årsvisa procentsatserna ska därför inte multipliceras för att återskapa den sammanhängande portföljen ovan; portföljvikter och ingångsläge skiljer sig. 2026 slutar 9 september.

| År | 28 dagar | 84 dagar | Rotation | Köp och behåll |
|---|---:|---:|---:|---:|
| 2023 | 191.3 % | 30.1 % | 617.5 % | 387.1 % |
| 2024 | 46.7 % | 35.4 % | -13.9 % | 84.0 % |
| 2025 | 30.3 % | 2.0 % | 33.7 % | -17.4 % |
| 2026 | -5.9 % | -26.6 % | -2.7 % | -15.6 % |

### Coinbidrag i den senare sammanhängande perioden

| Variant | Coin | Bidrag i dollar, startkonto 100 dollar | Innehav |
|---|---|---:|---:|
| 28 dagars momentum | BTC | -0.96 | 15 |
| 28 dagars momentum | ETH | 36.69 | 9 |
| 28 dagars momentum | SOL | -7.28 | 10 |
| 84 dagars momentum | BTC | -5.61 | 5 |
| 84 dagars momentum | ETH | -4.89 | 4 |
| 84 dagars momentum | SOL | -14.42 | 8 |
| Rotation, 28 dagar | BTC | -4.12 | 6 |
| Rotation, 28 dagar | ETH | 61.42 | 7 |
| Rotation, 28 dagar | SOL | -27.22 | 8 |
| Köp och behåll | BTC | -5.52 | 1 |
| Köp och behåll | ETH | -8.76 | 1 |
| Köp och behåll | SOL | -15.50 | 1 |

## Slutsats för fortsatt utveckling

Det finns mer stöd för att utveckla en separat strategi som fångar större rörelser och handlar mer sällan än för att fortsätta lägga filter på den nuvarande intradagsmotorn. Detta är en slutsats från koden, källorna och vårt experiment tillsammans. Positiva historiska resultat räcker fortfarande inte: nedgångarna är stora, 2026-kontrollen är negativ för samtliga aktiva varianter, universum är bara tre överlevande coins och ingen variant klarade urvalsreglerna. Nästa forskningsfråga är en i förväg bestämd riskstyrning med lägre exponering och tydliga kriterier för framåtriktad demo, samt separat kontroll av strukturstopparna. Att efteråt sänka risken bara tills just detta test passerar skulle vara ytterligare anpassning till historiken.

## Granskning och reproduktion

31 simulerade portföljer kontrollerades för saldo = startkapital + summa realiserad P/L, full avgiftsavstämning, giltiga handelstider och exponering utan belåning. Tester verifierar att framtida stängningspriser inte påverkar tidigare beslut och att oförändrade positioner inte belastas med nya handelsavgifter varje vecka. Alla tre prisfiler innehåller 1 440 sammanhängande dygnsstaplar och SHA-256. Nedgång mäts på dygnsstängningar och kan underskatta intradagsrisk. Minsta orderstorlekar, delavslut och individuella kontofees simuleras inte.

- [Förutbestämt protokoll](crypto-slow-protocol.md).
- Data: [Bybits offentliga Kline API](https://bybit-exchange.github.io/docs/v5/market/kline).
- Kör `node research/crypto-slow-data.mjs --download`, `node research/crypto-slow-run.mjs`, `node research/crypto-slow-report.mjs`.
- Fullständiga transaktioner och daglig kapitalserie: `.matning/crypto-slow/results.json`. Ingen konto- eller signallogik på sidan ändras av dessa kommandon.
