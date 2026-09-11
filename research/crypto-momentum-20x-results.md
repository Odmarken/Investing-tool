# Momentum med 20×: historisk simulering

Körd 2026-09-11T16:02:48.339Z. **Med start januari blev 20×-resultatet −100 %. Med en separat start juli blev resultatet +540,5 %, med 63,4 % maximal nedgång. Startdatumet förändrade utfallet radikalt.**

Samma signal 14/28/56 dagar på BTC/ETH/SOL, med veckobeslut och tre separata marginaldelar. Båda hävstångsnivåerna använder verkliga USDT-perpetualpriser, historisk funding och separat markprishistorik under 2025.

## Resultat

Startkapital 100 dollar. Netto inkluderar avgift 0,055 % och slippage enligt tabellen per sida, funding och simulerad likvidation.

| Period | Hävstång | Slippage/sida | Slutkapital | Netto | Max nedgång vid 15-minutersstängning | Likvidationer | Avslut |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2025-01-01–2025-12-31 | 1× | 0.05 % | 127.23 $ | 27.23 % | 24.15 % | 0 | 13 |
| 2025-01-01–2025-12-31 | 1× | 0.10 % | 126.77 $ | 26.77 % | 24.19 % | 0 | 13 |
| 2025-01-01–2025-12-31 | 20× | 0.05 % | 0.00 $ | -100.00 % | 100.00 % | 3 | 3 |
| 2025-01-01–2025-12-31 | 20× | 0.10 % | 0.00 $ | -100.00 % | 100.00 % | 3 | 3 |
| 2025-07-01–2025-12-31 | 1× | 0.05 % | 123.56 $ | 23.56 % | 24.60 % | 0 | 6 |
| 2025-07-01–2025-12-31 | 1× | 0.10 % | 123.35 $ | 23.35 % | 24.62 % | 0 | 6 |
| 2025-07-01–2025-12-31 | 20× | 0.05 % | 640.47 $ | 540.47 % | 63.37 % | 1 | 4 |
| 2025-07-01–2025-12-31 | 20× | 0.10 % | 638.56 $ | 538.56 % | 63.38 % | 1 | 4 |

## Kostnader och likvidation

| Periodstart | Hävstång | Slippage | Bokförda avgifter | Fundingkostnad, negativ = intäkt | Alla kapitaldelar tömda |
|---|---:|---:|---:|---:|---|
| 2025-01-01 | 1× | 0.05 % | 0.46 $ | 3.02 $ | Nej |
| 2025-01-01 | 1× | 0.10 % | 0.45 $ | 3.01 $ | Nej |
| 2025-01-01 | 20× | 0.05 % | 2.13 $ | 0.93 $ | 2025-01-08T17:15:00.000Z |
| 2025-01-01 | 20× | 0.10 % | 2.13 $ | 0.93 $ | 2025-01-08T17:15:00.000Z |
| 2025-07-01 | 1× | 0.05 % | 0.23 $ | 1.81 $ | Nej |
| 2025-07-01 | 1× | 0.10 % | 0.23 $ | 1.81 $ | Nej |
| 2025-07-01 | 20× | 0.05 % | 3.57 $ | 34.46 $ | Nej |
| 2025-07-01 | 20× | 0.10 % | 3.56 $ | 34.42 $ | Nej |

## Kapital per coin, normal slippage

| Periodstart | Hävstång | Coin | Slutkapital | Likvidationer |
|---|---:|---|---:|---:|
| 2025-01-01 | 1× | BTC | 27.56 $ | 0 |
| 2025-01-01 | 1× | ETH | 66.81 $ | 0 |
| 2025-01-01 | 1× | SOL | 32.87 $ | 0 |
| 2025-01-01 | 20× | BTC | 0.00 $ | 1 |
| 2025-01-01 | 20× | ETH | 0.00 $ | 1 |
| 2025-01-01 | 20× | SOL | 0.00 $ | 1 |
| 2025-07-01 | 1× | BTC | 27.90 $ | 0 |
| 2025-07-01 | 1× | ETH | 52.78 $ | 0 |
| 2025-07-01 | 1× | SOL | 42.88 $ | 0 |
| 2025-07-01 | 20× | BTC | 0.00 $ | 1 |
| 2025-07-01 | 20× | ETH | 418.15 $ | 0 |
| 2025-07-01 | 20× | SOL | 222.32 $ | 0 |

## Tolkning och begränsningar

20× förstärker både rörelser och kostnader i förhållande till marginalen. En tömd kapitaldel återstartar inte med pengar från ett annat coin. Därför motsvarar utfallet inte spotavkastning multiplicerad med tjugo.

Detta test använder fast antagen underhållsmarginal 0,5 % och reserverar uppskattad slutavgift vid beräkning av likvidationsnivån. Vid likvidation räknas konservativt hela den positionens marginaldel som förlorad. Det är en förenklad isolerad marginalmodell, inte börsens exakta risktrappor eller försäkrings-/likvidationsavgifter. Vid en öppning exakt på fundingtid betalar den nya positionen ingen tidigare funding; redan öppna positioner belastas före veckans beslut.

Historiken har 15-minutersmarkpriser. En likvidation inträffar inom en stapel; redovisad tid är stapelns slut om den utlöstes av lägstanoteringen, eller dess början vid ett öppningsgap. Live-demot använder femminutersmarkpriser och aktuell observation. Historiska entryfyllningar vid stapelöppning kan vara optimistiska jämfört med fördröjd faktisk exekvering. 1× här är också perpetualhandel med funding och ska inte blandas ihop med tidigare spotresultat. Det senare halvåret överlappar helårstestet.

Ingen parameter ändrades efter körningen. 20× är användarens begärda experimentversion, inte en lönsamhetsvaliderad förbättring.

## Reproduktion

Åtta portföljer kontrollerades för saldo, avgifter, funding, tidsordning och icke-negativt kapital. Data har kontrollerats för sammanhängande tidsstaplar och SHA-256.

Kör `node research/crypto-momentum-20x-data.mjs --download` och `node research/crypto-momentum-20x-run.mjs`. Befintlig verifierad spot- och perpetualcache krävs. Fullständiga kapitalserier och affärer finns i `.matning/crypto-momentum20/results.json`. [Protokoll](crypto-momentum-20x-protocol.md).

Källor: [Bybit markprisstaplar](https://bybit-exchange.github.io/docs/v5/market/mark-kline), [fundinghistorik](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate) och [isolerad marginal](https://www.bybit.com/en/help-center/article/Liquidation-Price-Calculation-under-Isolated-Mode-Unified-Trading-Account).
