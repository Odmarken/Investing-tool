# Trendstrategi för trading floor: resultat

Körd 2026-09-23T16:55:29.059Z. [Protokollet](floor-trend-protocol.md) låstes före första resultaträkningen. Urvalet skrevs till `selection-lock.json` innan valideringen räknades.

**Vald kandidat: `ens9-h-L`** (Donchian-ensemble på timstängningar, nio horisonter 5–360 dygn, bara lång). Valideringen **godkändes**: positivt netto och positiv Sharpe vid både normal och stressad slippage. Förvald risknivå enligt protokollet: **σ\* = 100 %** per år med högst 4× exponering.

Bordens nuvarande regel `pulse12` förlorade kraftigt i båda perioderna även vid 2 % risk per affär. Resultaten är historiska och retrospektiva; de visar inte framtida avkastning.

## Utveckling: 2021-06-01 till 2024-01-01

| Strategi | Netto | Stress | CAGR | Sharpe | Max nedgång | Rundturer | Avgifter | Nettofunding | Snittexponering | Tid i marknad | Andel kort |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ens9-d-L | 19,3 % | 18,7 % | 7,1 % | 0,98 | 8,8 % | 244 | 3,87 $ | +18,92 $ | 0,09 | 62 % | 0 % |
| ens9-d-LS | 11,4 % | 10,1 % | 4,3 % | 0,45 | 18,9 % | 270 | 8,06 $ | +19,69 $ | 0,14 | 94 % | 62 % |
| **ens9-h-L** | 20,0 % | 19,2 % | 7,3 % | 1,03 | 7,1 % | 287 | 4,64 $ | +17,59 $ | 0,08 | 55 % | 0 % |
| ens9-h-LS | 13,2 % | 11,6 % | 4,9 % | 0,50 | 17,1 % | 381 | 10,12 $ | +22,36 $ | 0,14 | 92 % | 64 % |
| tsm3-w-L | 27,7 % | 27,2 % | 9,9 % | 0,72 | 20,7 % | 67 | 2,85 $ | +27,79 $ | 0,16 | 46 % | 0 % |
| tsm3-w-LS | 23,0 % | 22,0 % | 8,3 % | 0,55 | 35,0 % | 137 | 6,48 $ | +17,49 $ | 0,32 | 99 % | 53 % |
| ema3-d-LS | 10,3 % | 9,6 % | 3,9 % | 0,33 | 28,7 % | 105 | 4,46 $ | +27,42 $ | 0,25 | 98 % | 60 % |
| pulse12 | −88,7 % | −89,8 % | −57,0 % | −2,82 | 90,2 % | 7240 | 237,47 $ | +27,72 $ | 0,38 | 48 % | 0 % |
| köp och behåll 1× | −52,3 % | −52,4 % | −24,9 % | 0,19 | 92,3 % | 1 | 0,33 $ | +154,63 $ | 1,28 | 93 % | 0 % |

Behöriga: `ens9-d-L`, `ens9-d-LS`, `ens9-h-L`, `ens9-h-LS`, `tsm3-w-L`, `tsm3-w-LS`, `ema3-d-LS`. Högst Sharpe: `ens9-h-L`. `pulse12` och köp och behåll är referenser och kunde inte väljas.

## Validering: 2024-01-01 till 2026-09-23

| Strategi | Netto | Stress | CAGR | Sharpe | Max nedgång | Rundturer | Avgifter | Nettofunding | Snittexponering | Tid i marknad | Andel kort |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ens9-d-L | 26,6 % | 25,7 % | 9,0 % | 0,92 | 12,7 % | 243 | 5,66 $ | +26,24 $ | 0,11 | 66 % | 0 % |
| ens9-d-LS | 18,5 % | 16,7 % | 6,4 % | 0,55 | 12,4 % | 299 | 11,22 $ | +19,21 $ | 0,18 | 94 % | 58 % |
| **ens9-h-L** | 27,7 % | 26,6 % | 9,4 % | 1,02 | 11,5 % | 314 | 6,58 $ | +23,78 $ | 0,10 | 59 % | 0 % |
| ens9-h-LS | 16,7 % | 14,6 % | 5,8 % | 0,53 | 12,9 % | 388 | 13,63 $ | +18,51 $ | 0,17 | 93 % | 60 % |
| tsm3-w-L | 35,5 % | 34,8 % | 11,8 % | 0,80 | 18,7 % | 75 | 4,15 $ | +36,61 $ | 0,18 | 46 % | 0 % |
| tsm3-w-LS | 30,9 % | 29,6 % | 10,4 % | 0,60 | 25,2 % | 151 | 7,83 $ | +22,40 $ | 0,37 | 100 % | 54 % |
| ema3-d-LS | 27,0 % | 25,9 % | 9,2 % | 0,59 | 20,6 % | 110 | 6,22 $ | +25,35 $ | 0,29 | 100 % | 56 % |
| pulse12 | −90,2 % | −89,8 % | −57,3 % | −2,63 | 91,5 % | 7642 | 320,32 $ | +33,81 $ | 0,43 | 48 % | 0 % |
| köp och behåll 1× | 12,6 % | 12,5 % | 4,5 % | 0,44 | 79,3 % | 0 | 0,33 $ | +189,61 $ | 1,24 | 100 % | 0 % |

Sex bord med 100 dollar var, σ\* = 25 % och högst 1× exponering för alla trendkandidater. `pulse12` använder 2 % risk vid SL och högst 3×. Nettofunding är kostnad (+) eller intäkt (−) i dollar. Snittexponering är positionens värde delat med bordets kapital, i snitt över all tid inklusive tid utan position.

## År för år (normal kostnad)

| Strategi | 2021 (jun–dec) | 2022 | 2023 | 2024 | 2025 | 2026 (t.o.m. 22 sep) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ens9-d-L | 7,1 % | −3,2 % | 15,1 % | 30,1 % | −3,3 % | 0,7 % |
| ens9-d-LS | 3,9 % | 6,8 % | 0,5 % | 21,2 % | −3,2 % | 1,0 % |
| ens9-h-L | 7,1 % | −2,4 % | 14,8 % | 27,2 % | −2,5 % | 3,0 % |
| ens9-h-LS | 2,7 % | 8,4 % | 1,7 % | 18,6 % | −5,3 % | 3,9 % |
| tsm3-w-L | 18,2 % | −11,1 % | 21,5 % | 29,5 % | 2,9 % | 1,7 % |
| tsm3-w-LS | 20,3 % | 0,8 % | 1,4 % | 10,9 % | 18,7 % | −0,5 % |
| ema3-d-LS | 1,4 % | 5,9 % | 2,7 % | 16,3 % | 4,1 % | 5,0 % |
| pulse12 | −32,0 % | −68,7 % | −47,1 % | −49,6 % | −61,6 % | −49,1 % |
| köp och behåll 1× | 93,0 % | −87,0 % | 90,1 % | 118,9 % | −41,2 % | −12,5 % |

2023 och 2024 finns i olika perioder; 2023 hör till utvecklingen.

## Risknivå för den valda kandidaten

| σ\* | Lmax | Utv. netto | Utv. CAGR | Utv. nedgång | Val. netto | Val. CAGR | Val. nedgång | Val. stress | Val. Sharpe | Sämsta bord, nedgång | Likvidationer |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 25 % | 1× | 20,0 % | 7,3 % | 7,1 % | 27,7 % | 9,4 % | 11,5 % | 26,6 % | 1,02 | 18,0 % | 0 |
| 50 % | 2× | 45,0 % | 15,5 % | 14,4 % | 58,7 % | 18,5 % | 22,2 % | 56,0 % | 1,00 | 33,4 % | 0 |
| 75 % | 3× | 81,2 % | 25,9 % | 22,6 % | 87,8 % | 26,0 % | 32,2 % | 83,0 % | 0,95 | 46,5 % | 0 |
| **100 %** | 4× | 131,5 % | 38,4 % | 30,4 % | 110,8 % | 31,5 % | 41,4 % | 103,5 % | 0,91 | 57,4 % | 0 |

Förvald nivå är högst utvecklings-CAGR med utvecklingsnedgång ≤ 40 % och ingen likvidation. I valideringen blev nedgången 41,4 %, alltså över den gräns som användes för valet. Valet ändras inte av det, men nivån är ett aggressivt demoval, inte en säker nivå.

### Beskrivande tillägg efter resultaten: högre nivåer

Dessa nivåer låg inte i protokollet och räknades efter att resultaten ovan var kända. De visar hur mer risk påverkar; de används inte för något val.

| σ\* | Utv. CAGR | Utv. nedgång | Val. CAGR | Val. nedgång | Sämsta bord, nedgång | Högsta exponering |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 25 % | 7,3 % | 7,1 % | 9,4 % | 11,5 % | 18,0 % | 0,9× |
| 50 % | 15,5 % | 14,4 % | 18,5 % | 22,2 % | 33,4 % | 1,8× |
| 75 % | 25,9 % | 22,6 % | 26,0 % | 32,2 % | 46,5 % | 2,7× |
| 100 % | 38,4 % | 30,4 % | 31,5 % | 41,4 % | 57,4 % | 3,7× |
| 125 % | 51,8 % | 38,3 % | 36,1 % | 49,8 % | 66,4 % | 4,8× |
| 150 % | 68,1 % | 45,3 % | 35,4 % | 57,7 % | 74,3 % | 6,0× |
| 200 % | 104,5 % | 58,5 % | 37,0 % | 71,4 % | 86,0 % | 8,5× |
| 300 % | 144,4 % | 78,1 % | 12,4 % | 88,1 % | 96,9 % | 14,9× |

I utvecklingen steg avkastningen med varje nivå. I valideringen planade den ut över cirka 100 % medan nedgången fortsatte att växa, och vid 300 % föll avkastningen tydligt. Det är det väntade mönstret när hävstången passerar det som strategins verkliga kvalitet bär.

## Affärernas form vid σ\* = 100 %

| Period | Rundturer | Per bord och år | Vinnande rundturer | Median hålltid | 90:e percentil | Tid i marknad | Fem största vinsternas andel av all vinst |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Utveckling | 287 | 18,5 | 13 % | 2,7 dygn | 25,9 dygn | 55 % | 75 % |
| Validering | 314 | 19,2 | 12 % | 2,6 dygn | 18,0 dygn | 59 % | 72 % |

En rundtur går från ingen position till ingen position, med del-köp och del-sälj emellan. De flesta rundturer är små förluster när en kort horisont slås ut. Resultatet kommer från ett fåtal långa trender. Det är typiskt för trendföljning och betyder att långa förlustserier är normala.

## Bidrag per coin för den valda kandidaten (σ\* = 25 %)

| Period | BTC | ETH | SOL | XRP | DOGE | SHIB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Utveckling | +16,06 $ | +2,85 $ | +81,44 $ | +1,90 $ | −3,00 $ | +20,90 $ |
| Validering | +26,91 $ | +22,59 $ | +9,52 $ | +52,47 $ | +28,19 $ | +26,47 $ |
| Prisförändring utv. | 14 % | −16 % | 211 % | −41 % | −72 % | 12 % |
| Prisförändring val. | 104 % | 21 % | 16 % | 155 % | 12 % | −41 % |

Prisförändringen är ren kursändring utan avgifter eller funding. Köp och behåll i tabellerna ovan är en 1× lång perpetual som betalar funding; i utvecklingen betalade SOL-bordet 45,60 dollar i funding under 2021 och likviderades sedan i fallet 2022.

## Känslighet för den valda kandidaten (σ\* = 25 %, beskrivande)

| Ändring | Utv. netto | Utv. Sharpe | Val. netto | Val. Sharpe | Val. nedgång |
| --- | ---: | ---: | ---: | ---: | ---: |
| Protokollets inställning | 20,0 % | 1,03 | 27,7 % | 1,02 | 11,5 % |
| Bybit-data i stället för Binance |  |  | 27,1 % | 1,00 | 11,7 % |
| Volatilitet 60 dygn | 23,0 % | 1,12 | 29,0 % | 1,04 | 11,6 % |
| Volatilitet 120 dygn | 18,6 % | 1,00 | 27,0 % | 0,99 | 11,6 % |
| Ombalansering vid 10 % | 19,4 % | 1,01 | 26,5 % | 1,01 | 11,2 % |
| Ombalansering vid 50 % | 21,3 % | 1,07 | 31,4 % | 1,09 | 11,4 % |
| Slippage 0,20 % per sida | 17,7 % | 0,92 | 24,5 % | 0,91 | 12,7 % |

Bybit-kontrollen använder bordens egna kontrakt och deras funding; utvecklingsperioden saknas där eftersom Bybit noterade SOL och SHIB först i oktober 2021.

## Tidig period 2020-10-01 till 2021-06-01 (beskrivande, fem coins)

| Strategi | Netto | Sharpe | Max nedgång |
| --- | ---: | ---: | ---: |
| ens9-d-L | 50,0 % | 3,78 | 5,9 % |
| ens9-d-LS | 39,3 % | 3,40 | 5,9 % |
| ens9-h-L | 40,4 % | 3,49 | 5,4 % |
| ens9-h-LS | 33,6 % | 3,09 | 5,3 % |
| tsm3-w-L | 88,0 % | 3,50 | 15,4 % |
| tsm3-w-LS | 78,1 % | 3,26 | 16,5 % |
| ema3-d-LS | 70,2 % | 3,57 | 7,1 % |
| pulse12 | 16,1 % | 0,91 | 16,4 % |
| köp och behåll 1× | 2595,9 % | 3,09 | 64,8 % |

Tjurmarknaden 2020–2021 gav enorma uppgångar. Trendföljning med 25 % volatilitetsmål tar bara en liten del av en sådan uppgång, i utbyte mot mycket mindre nedgång.

## Begränsningar

- **Retrospektivt.** Perioderna har delvis använts i tidigare forskning i projektet, och de sex coinen är dagens överlevare, valda i efterhand. Idén kommer från publicerad forskning och ingen parameter söktes fram här, men sju kandidater jämfördes; den bästa av sju är något för optimistiskt vald.
- **Timupplösning.** Beslut och fyllning sker på timstaplar. Ingen orderbok, inget marknadsdjup, minsta orderstorlek eller orderavrundning. Mängderna är kontinuerliga som i demot.
- **Likvidation** är förenklad: bordets hela kapital är marginal och underhållsmarginalen är 1 %. Verkliga risknivåer, isolerad marginal och Bybits likvidationsmotor modelleras inte. Ingen likvidation inträffade i någon period.
- **Funding** är en stor kostnad för långa positioner i tjurmarknader. Vid 100 % volatilitetsmål betalade firman cirka 144 dollar i funding under valideringen, mer än avgifterna.
- **Beroende av få trender.** Fem vinnande rundturer står för ungefär tre fjärdedelar av all vinst. Ett år utan tydliga trender (som 2022 och 2025) ger minus.
- **pulse12** simuleras här på timstaplar med SL före TP i tvetydiga staplar, vilket är något strängare än det tidigare 15-minuterstestet. Förlusten beror dock på omsättning och negativ förväntan per affär, vilket det tidigare testet också visade.

## Reproduktion

Kör `node research/floor-trend-data.mjs --download --bybit`, `node research/floor-trend-run.mjs` och `node research/floor-trend-report.mjs`. Rådata, urvalslås och alla affärer sparas lokalt i `.matning/floor-trend/`.

| Fil | SHA-256 |
| --- | --- |
| Protokoll | 049db86afa8d712b7612451d749a26c3096c78c510d30b14f1fc724efd8a1cf4 |
| Motor (`floor-trend-core.mjs`) | a308e2748ebc8c2126415c547b09577b7453e5f9f8bd6d9bc3409e22c99dffdb |
| Binance BTC | 6b78a6ea30a93508778b5353be5800427de8cff141cd7fc89a39c47f0a75d90c |
| Binance ETH | 7b05f2ed8a8e060dd30404fe810e633eb45fdf1144eb7ca11dbff5d84a9b6f7b |
| Binance SOL | 399f29a3ef97c534a3924a69d76d00042ed5b581fd9c615513edb9fa44323095 |
| Binance XRP | 794fe05755126fe3682f08e0cb41e43e4d9eb3a590754faeea0c745b66838f21 |
| Binance DOGE | de854ca53ea8cfddaec76019e88f9dacd1e44d2f04bd76e3851b7ce9e3f2dff3 |
| Binance SHIB | 8e16c5d1c80dde638a4330d4b8b28c48e1d995f724d14f0af4a4db6ac402d414 |
| Bybit BTC | a836b59592b51314413fc802cd400cd2ce1677ceda103e900b2c5f4f44e5a01f |
| Bybit ETH | 245b6c4b2283998c77cdbe0e08784194efe05385e045eadc1c2fa7988d5fec72 |
| Bybit SOL | 40a37b86f973e5a07836adfb3003e6a2ff22f7779cd8950abc0449e287132323 |
| Bybit XRP | 876dbc3c90a657356ec67fbf1216a14f96bdfe8d8743dcd7724df2584e187ac0 |
| Bybit DOGE | e313306476b8e051481f531823d5a2503a67e47c3b882d0d6cd237c1f9d70f65 |
| Bybit SHIB | e06c69931d2e998c23e9d062099deee8e1c81c3c047793bdc7454f712f0179cd |

Källor: [Zarattini, Pagani & Barbon (2025), Catching Crypto Trends](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907), [Moskowitz, Ooi & Pedersen (2012), Time series momentum](https://doi.org/10.1016/j.jfineco.2011.11.003), [Binance USDT-M klines](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data), [Binance funding](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History), [Bybit kline](https://bybit-exchange.github.io/docs/v5/market/kline), [Bybit funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).
