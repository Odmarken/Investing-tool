# Dagshandel för trading floor: resultat

Körd 2026-09-23T19:34:27.477Z. [Protokollet](floor-day-protocol.md) låstes före första resultaträkningen. Urvalet skrevs till `selection-lock.json` innan valideringen räknades.

**Vald kandidat: `b48-f-72`** (48-timmarsutbrott när minst 5 av bordens 9 trender pekar uppåt, stopp i 48-timmarskanalens mittpunkt som följer med uppåt, högst 72 timmar). Valideringen **godkändes**. Bästa endagsvariant: `b24-f-24`.

Den valda dagsregeln tjänar pengar men mycket mindre än bordens nuvarande trendstrategi. Med de gamla bordens hävstångsregel på Bybit förlorade varje kandidat stort i valideringen, och `pulse12` gick till noll i båda perioderna.

## Utveckling 2021-06-01 till 2024-01-01 (1 % risk per affär)

| Regel | Netto | Stress | CAGR | Sharpe | Max nedgång | Affärer | Vinstandel | Snitt-R | Hålltid median / p90 | Tid i marknad |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| b24-f-72 | 4,5 % | −0,5 % | 1,7 % | 0,35 | 9,8 % | 594 | 29 % | 0,035 | 9 h / 27 h | 5,3 % |
| b24-f-24 | 4,3 % | −0,8 % | 1,7 % | 0,36 | 9,1 % | 637 | 29 % | 0,031 | 9 h / 24 h | 5,1 % |
| **b48-f-72** | 8,2 % | 5,8 % | 3,1 % | 0,77 | 6,2 % | 351 | 30 % | 0,115 | 20 h / 52 h | 6,1 % |
| b24-n-72 | −24,0 % | −41,5 % | −10,1 % | −0,57 | 36,1 % | 3038 | 26 % | −0,056 | 9 h / 26 h | 25,2 % |
| vb-f-1d | 0,4 % | −1,5 % | 0,1 % | 0,08 | 3,9 % | 398 | 43 % | 0,010 | 8 h / 19 h | 2,8 % |
| pulse12 (gamla borden) | −68,1 % | −69,2 % | −35,7 % | −3,14 | 68,9 % | 7240 | 40 % | −0,098 | 12 h / 12 h | 47,7 % |
| Bordens trendstrategi (referens, σ\* = 100 %) | 131,5 % |  | 38,4 % | 1,22 | 30,4 % | 287 |  |  |  |  |

Behöriga: `b48-f-72`. De övriga saknade positivt netto vid stressad slippage eller tillräckligt många affärer.

## Validering 2024-01-01 till 2026-09-23 (1 % risk per affär)

| Regel | Netto | Stress | CAGR | Sharpe | Max nedgång | Affärer | Vinstandel | Snitt-R | Hålltid median / p90 | Tid i marknad |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| b24-f-72 | −0,2 % | −5,9 % | −0,1 % | 0,01 | 9,7 % | 755 | 29 % | 0,003 | 9 h / 30 h | 6,7 % |
| b24-f-24 | −4,6 % | −10,2 % | −1,7 % | −0,32 | 12,6 % | 821 | 30 % | −0,030 | 9 h / 24 h | 6,3 % |
| **b48-f-72** | 8,3 % | 5,1 % | 3,0 % | 0,66 | 4,9 % | 417 | 32 % | 0,121 | 21 h / 61 h | 7,5 % |
| b24-n-72 | −11,9 % | −36,8 % | −4,5 % | −0,13 | 40,4 % | 3346 | 27 % | −0,016 | 9 h / 27 h | 27,4 % |
| vb-f-1d | −2,2 % | −4,7 % | −0,8 % | −0,31 | 5,1 % | 475 | 45 % | −0,025 | 9 h / 19 h | 3,2 % |
| pulse12 (gamla borden) | −68,1 % | −69,0 % | −34,3 % | −2,69 | 70,4 % | 7642 | 41 % | −0,088 | 12 h / 12 h | 47,7 % |
| Bordens trendstrategi (referens, σ\* = 100 %) | 110,8 % |  | 31,5 % | 0,91 | 41,4 % | 314 |  |  |  |  |

Dagsreglerna räknas med 1 % risk per affär och trendstrategin med sin egen storlek (σ\* = 100 %). Jämför därför Sharpe, som inte beror på storleken, och tabellen över risknivåer nedan.

## Risknivåer för `b48-f-72`

| Risk per affär | Utv. netto | Utv. CAGR | Utv. nedgång | Val. netto | Val. CAGR | Val. nedgång | Likvidationer |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0,5 % | 3,7 % | 1,4 % | 3,1 % | 4,3 % | 1,6 % | 2,4 % | 0 |
| 1,0 % | 8,2 % | 3,1 % | 6,2 % | 8,3 % | 3,0 % | 4,9 % | 0 |
| 2,0 % | 19,7 % | 7,2 % | 11,8 % | 15,3 % | 5,3 % | 9,6 % | 0 |
| 3,0 % | 35,4 % | 12,4 % | 17,0 % | 20,8 % | 7,2 % | 14,6 % | 0 |
| 5,0 % | 81,2 % | 25,9 % | 26,0 % | 27,5 % | 9,3 % | 24,6 % | 0 |
| 10,0 % | 277,3 % | 67,2 % | 43,5 % | 23,3 % | 8,0 % | 47,1 % | 0 |

I valideringen planade avkastningen ut runt 5 % risk (cirka 9 % per år med 25 % nedgång). Bordens trendstrategi gav 31 % per år med 41 % nedgång i samma period, och cirka 18 % per år med 22 % nedgång på halva sin risknivå.

## Gamla bordens hävstångsregel på Bybit (scenario)

De gamla bordens storleksfunktion `openActivePosition` oförändrad: högst 50 % av saldot som isolerad marginal, högst 50 % planerad förlust vid stoppet och högsta hävstång inom Bybits kontraktsgräns och risknivåer (hämtade 2026-09-23T19:31:20.818Z) med likvidationen minst 25 % av stoppavståndet under stoppet. Dagens gränser på historiska priser.

| Regel | Utv. netto | Utv. nedgång | Val. netto | Val. nedgång | Hävstång median (högsta) | Median planerad risk | Likvidationer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| b24-f-72 | −46,3 % | 87,1 % | −98,8 % | 99,4 % | 38× (94×) | 35 % | 0 |
| b24-f-24 | −41,0 % | 84,7 % | −99,2 % | 99,6 % | 38× (94×) | 35 % | 0 |
| b48-f-72 | 63,8 % | 91,8 % | −87,8 % | 97,7 % | 27× (94×) | 36 % | 0 |
| b24-n-72 | −100,0 % | 100,0 % | −100,0 % | 100,0 % | 40× (94×) | 33 % | 0 |
| vb-f-1d | −89,0 % | 92,9 % | −91,9 % | 93,7 % | 23× (94×) | 37 % | 0 |
| pulse12 (gamla borden) | −100,0 % | 100,0 % | −100,0 % | 100,0 % | 31× (57×) | 35 % | 0 |

Ingen position likviderades: stoppet ligger alltid före likvidationen. Förlusterna kommer från vanliga stopp med över en tredjedel av bordet i spel per affär. Med 30–45 % vinnande affärer räcker några förluster i rad för att nästan tömma ett bord, även när regeln har ett litet övertag. Det är samma matematik som tömde de gamla borden.

## Den valda regeln i detalj

- Hålltid: median 21 h, 90:e percentil 61 h. Borden var i marknaden 7,5 % av tiden i valideringen, ungefär 25 affärer per bord och år.
- År för år (1 % risk): 2021 8,0 %, 2022 0,4 %, 2023 −0,3 %, 2024 8,4 %, 2025 0,3 %, 2026 −0,4 %. Regeln tjänar i tydliga trendår och står still annars.
- På Bybits egna kontrakt i valideringen: 7,3 % netto, Sharpe 0,59.
- Utan trendfiltret (`b24-n-72`) förlorade samma typ av utbrott i båda perioderna. Filtret från bordens trendstrategi är det som gör regeln användbar.

## Begränsningar

- Retrospektivt: perioderna användes redan när trendstrategin valdes, och fem kandidater jämfördes. De sex coinen är dagens överlevare.
- Timstaplar: stoppet fylls vid stoppnivån om stapelns lägsta når den, vid gap på öppningen. Verklig fyllning och slippage vid snabba rörelser kan bli sämre. Ingen orderbok eller minsta orderstorlek.
- Hävstångsscenariot använder dagens Bybit-gränser på historiska priser och de gamla bordens egen, förenklade likvidationsmodell.

## Reproduktion

Kör `node research/floor-trend-data.mjs --download --bybit` (samma data som trendtestet), hämta kontraktsgränser till `.matning/floor-day/contracts.json`, kör sedan `node research/floor-day-run.mjs` och `node research/floor-day-report.mjs`.

| Fil | SHA-256 |
| --- | --- |
| Protokoll | 6c861d7928452845c4ec218f7ea324a298a75df5024af69f8c914a2e6e5cc2de |
| Motor (`floor-day-core.mjs`) | a3dbd70c2e97be7cc74589fde31ed68022e1e414e44e55b9e629974c0b9e730f |
| Bybit-gränser | d806f79a6cb3bd47dfae67854cba7eb4b028a96e4b768af544226219922a9977 |
