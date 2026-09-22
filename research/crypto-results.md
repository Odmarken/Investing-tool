# Kryptostrategier — historiskt test

Genererad 2026-09-10T21:22:22.306Z. Ingen strategi eller kontoinställning har ändrats på sidan.

## Bedömning

Ingen av de sex varianterna gav positiv nettoavkastning i testperioden med de låsta antagandena. De nya rekylstrategierna förlorade mindre än nuvarande modell, men det motiverar inte att installera dem som lönsamma strategier. Nettofiltret, timfiltret och ATR-målgränserna förbättrade inte resultatet för den befintliga signalmotorn i denna jämförelse.

Varianten med delvinst och flyttad stopp valdes på utvecklingsdata. Den gav −40,9 % i testperioden vid 1 % ursprunglig stopprisk per affär. Rekyl med fast mål gav −34,6 %, men det är en efterhandsjämförelse på testdata och gör den inte till en ny validerad vinnare. Båda rekylvarianternas osäkerhetsintervall för genomsnittligt netto-R omfattar noll. Ingen coin gav positiv total R inom någon av de sex portföljerna.

Med sidans hela-saldot/20×-modell nådde samtliga varianter testets stoppgräns under 1 dollar från 100 dollars start. Det skedde genom ackumulerade förluster och kostnader, inte genom registrerade likvidationer i denna testperiod. De exakta procenttalen gäller simuleringen och ska inte läsas som uppmätt avkastning i användarens livekonto.

Validering: 16 automatiska tester passerar. Samtliga 48 portföljhistoriker har även kontrollerats för ändliga utfall, tidsordning, överlappande positioner och avstämning av saldo mot varje affär.

## Metod

Se [låst protokoll](crypto-protocol.md). Sju coins, Bybit spot, 5 minuter, 2 000 staplars indikatorfönster. Avgift 0,055 % och slippage 0,05 % per sida, plus historisk funding värderad med spotpris. En position i taget; 1 % av aktuellt kapital i ursprunglig stopprisk, maximalt 20× exponering. Separat 20×-konto och dubbel slippage finns nedan.

Nyhetsfilter avstängt eftersom historiska rubriker saknas. Femminutersapproximation av livekontot; ingen intrabar-tickhistorik, perpetual-pris- eller orderboksmodell. Avkastning är simulerad, inte ett löfte eller en exakt reproduktion av sidans faktiska historik. Urvalet är dagens sju coins och prövar inte avnoterade coins.

## Utveckling: 14 mars–11 juli 2026

| Variant | Affärer | Träff | Netto-R/affär | Profit factor | Avkastning | Max nedgång |
|---|---:|---:|---:|---:|---:|---:|
| Nuvarande | 843 | 30.2 % | -0.534 | 0.36 | -99.0 % | 99.0 % |
| Nettofilter | 399 | 10.5 % | -1.133 | 0.23 | -99.0 % | 99.0 % |
| Netto + 1h | 450 | 12.0 % | -0.998 | 0.27 | -99.0 % | 99.0 % |
| ATR + netto + 1h | 430 | 12.3 % | -1.049 | 0.29 | -99.0 % | 99.0 % |
| Kryptorekyl fast | 315 | 22.5 % | -0.367 | 0.57 | -69.8 % | 70.0 % |
| Kryptorekyl runner | 367 | 29.2 % | -0.352 | 0.57 | -73.5 % | 73.9 % |

Förregistrerat urval på enbart utvecklingsdata: **Kryptorekyl runner**. Ingen ändring av reglerna efter resultaten.

## Orört test: 12 juli–9 september 2026

| Variant | Affärer | Träff | Netto-R/affär | Profit factor | Avkastning | Max nedgång |
|---|---:|---:|---:|---:|---:|---:|
| Nuvarande | 425 | 28.2 % | -0.688 | 0.28 | -94.9 % | 95.2 % |
| Nettofilter | 396 | 11.6 % | -1.142 | 0.20 | -99.0 % | 99.0 % |
| Netto + 1h | 380 | 10.0 % | -1.193 | 0.21 | -99.0 % | 99.0 % |
| ATR + netto + 1h | 378 | 11.6 % | -1.103 | 0.22 | -98.6 % | 98.6 % |
| Kryptorekyl fast | 164 | 25.0 % | -0.245 | 0.71 | -34.6 % | 38.0 % |
| Kryptorekyl runner | 177 | 28.8 % | -0.286 | 0.66 | -40.9 % | 43.5 % |

## Osäkerhet och kostnadsstress, testperiod

| Variant | 95 % block-bootstrap för netto-R | Netto-R med 0,10 % slippage/sida | 20× avkastning | 20× max nedgång |
|---|---:|---:|---:|---:|
| Nuvarande | -0.862 till -0.513 (9 veckoblock) | -0.837 (445 affärer) | -99.0 % | 99.1 % |
| Nettofilter | -1.485 till -0.858 (8 veckoblock) | -1.089 (398 affärer) | -99.1 % | 99.1 % |
| Netto + 1h | -1.444 till -0.897 (9 veckoblock) | -1.320 (344 affärer) | -99.0 % | 99.1 % |
| ATR + netto + 1h | -1.400 till -0.689 (9 veckoblock) | -1.249 (331 affärer) | -99.0 % | 99.0 % |
| Kryptorekyl fast | -0.580 till 0.117 (9 veckoblock) | -0.168 (74 affärer) | -99.1 % | 99.3 % |
| Kryptorekyl runner | -0.577 till 0.133 (9 veckoblock) | -0.087 (82 affärer) | -99.1 % | 99.3 % |

Bootstrapintervallen är ungefärliga, baserade på få veckoblock och inte korrigerade för flera strategijämförelser. Ändrade slippageantaganden ändrar också vilka affärer som passerar nettofiltret. 20×-kontot stannar när saldot understiger 1 dollar från startens 100 dollar. Max nedgång mäts vid 5m-stängningar och efter avslut, inte på varje intrabar-pris.

## Resultat per coin, testperiod (1 % risk)

| Variant | Coin | Affärer | Netto-R/affär |
|---|---|---:|---:|
| Nuvarande | BTC | 94 | -1.000 |
| Nuvarande | ETH | 100 | -0.424 |
| Nuvarande | SOL | 64 | -0.560 |
| Nuvarande | XRP | 63 | -0.937 |
| Nuvarande | DOGE | 67 | -0.699 |
| Nuvarande | SHIB | 18 | -0.637 |
| Nuvarande | PEPE | 19 | -0.140 |
| Nettofilter | BTC | 61 | -1.257 |
| Nettofilter | ETH | 70 | -1.174 |
| Nettofilter | SOL | 63 | -1.310 |
| Nettofilter | XRP | 61 | -1.268 |
| Nettofilter | DOGE | 86 | -1.220 |
| Nettofilter | SHIB | 34 | -0.696 |
| Nettofilter | PEPE | 21 | -0.239 |
| Netto + 1h | BTC | 69 | -1.351 |
| Netto + 1h | ETH | 75 | -0.924 |
| Netto + 1h | SOL | 56 | -1.437 |
| Netto + 1h | XRP | 52 | -1.126 |
| Netto + 1h | DOGE | 80 | -1.378 |
| Netto + 1h | SHIB | 26 | -1.139 |
| Netto + 1h | PEPE | 22 | -0.549 |
| ATR + netto + 1h | BTC | 56 | -1.106 |
| ATR + netto + 1h | ETH | 74 | -1.094 |
| ATR + netto + 1h | SOL | 60 | -1.212 |
| ATR + netto + 1h | XRP | 59 | -0.857 |
| ATR + netto + 1h | DOGE | 69 | -1.200 |
| ATR + netto + 1h | SHIB | 38 | -1.185 |
| ATR + netto + 1h | PEPE | 22 | -1.048 |
| Kryptorekyl fast | BTC | 3 | -1.221 |
| Kryptorekyl fast | ETH | 13 | -0.046 |
| Kryptorekyl fast | SOL | 24 | -0.245 |
| Kryptorekyl fast | XRP | 20 | -0.223 |
| Kryptorekyl fast | DOGE | 14 | -0.124 |
| Kryptorekyl fast | SHIB | 36 | -0.112 |
| Kryptorekyl fast | PEPE | 54 | -0.368 |
| Kryptorekyl runner | BTC | 3 | -1.221 |
| Kryptorekyl runner | ETH | 12 | -0.167 |
| Kryptorekyl runner | SOL | 26 | -0.347 |
| Kryptorekyl runner | XRP | 23 | -0.102 |
| Kryptorekyl runner | DOGE | 12 | -0.683 |
| Kryptorekyl runner | SHIB | 42 | -0.118 |
| Kryptorekyl runner | PEPE | 59 | -0.347 |

## Datakällor och reproduktion

- [Bybit Kline API](https://bybit-exchange.github.io/docs/v5/market/kline)
- [Bybit Funding History](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate)
- [Bybit avgifter](https://www.bybit.com/en/help-center/article/Trading-Fee-Structure)

Kör `node research/crypto-data.mjs --download` och `node research/crypto-backtest.mjs`. Rådata, enskilda affärer och daglig equity sparas lokalt i `.matning/crypto/`; SHA-256 för varje prisserie och signalmotorn finns i `results.json`.

## Kontroll av resultatspridning

| Variant | Coins med positiv total R | Veckor med positiv total R | Netto-R/affär utan fem bästa affärerna |
|---|---:|---:|---:|
| Nuvarande | 0/7 | 0/9 | -0.760 |
| Nettofilter | 0/7 | 0/8 | -1.231 |
| Netto + 1h | 0/7 | 0/9 | -1.291 |
| ATR + netto + 1h | 0/7 | 1/9 | -1.213 |
| Kryptorekyl fast | 0/7 | 2/9 | -0.340 |
| Kryptorekyl runner | 0/7 | 2/9 | -0.389 |

Summorna här räknas i R för att inte låta varierande kontostorlek dominera. De är efterhandsdiagnostik, inte nya urvalsregler.

Utvecklingsvinnaren **Kryptorekyl runner** mot nuvarande modell: 95 % parat veckobootstrapintervall för skillnaden i netto-R/affär **0.059 till 0.798**. Samma veckor återprovas i båda strategierna. Ett positivt intervall betyder möjlig relativ förbättring; det visar inte i sig positiv absolut avkastning.

Fullständiga affärer, equity, koncentrationskontroller och checksummor för koden och hela rådatafilerna finns i `.matning/crypto/results.json` och `.matning/crypto/analysis.json`. Kör `node research/crypto-analysis.mjs` efter backtestet för denna komplettering.
