# Aktivt momentum: retrospektiv SL/TP-jämförelse

Körd 2026-09-11T19:53:48.781Z. Protokollet låstes före resultatsökning. **Ingen av de tre profilerna klarade utvecklingskraven; ingen lönsam kandidat valdes.**

Resultaten använder 0,5 % risk vid vanlig SL inklusive antagna kostnader, högst 2× exponering och 100 dollar per separat period. De motsvarar inte användarens 50 % risk. Den kronologiska valideringen är retrospektiv: samma datum har tidigare studerats på spotdata. Ingen profil ändrades eller valdes om efter valideringen.

## Resultat

| Period | Profil | Slippage/sida | Avslut | Netto | Netto-R/affär | PF | Max nedgång | Hålltid median / p90 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| development | pulse12 | 0.05 % | 182 | -13.95 % | -0.16 | 0.64 | 15.62 % | 12.00 / 12.00 h |
| development | pulse12 | 0.10 % | 151 | -7.73 % | -0.10 | 0.74 | 9.38 % | 12.00 / 12.00 h |
| development | pulse24 | 0.05 % | 132 | -10.54 % | -0.17 | 0.71 | 12.91 % | 12.25 / 24.00 h |
| development | pulse24 | 0.10 % | 111 | -5.27 % | -0.09 | 0.82 | 7.59 % | 13.75 / 24.00 h |
| development | trend24 | 0.05 % | 95 | -6.00 % | -0.13 | 0.77 | 9.10 % | 17.50 / 24.00 h |
| development | trend24 | 0.10 % | 95 | -8.09 % | -0.17 | 0.69 | 10.89 % | 17.50 / 24.00 h |
| validation | pulse12 | 0.05 % | 114 | +0.16 % | 0.00 | 1.01 | 5.57 % | 12.00 / 12.00 h |
| validation | pulse12 | 0.10 % | 84 | +2.00 % | 0.05 | 1.14 | 3.59 % | 12.00 / 12.00 h |
| validation | pulse24 | 0.05 % | 80 | +1.89 % | 0.05 | 1.10 | 5.47 % | 13.63 / 24.00 h |
| validation | pulse24 | 0.10 % | 63 | +3.04 % | 0.10 | 1.22 | 3.34 % | 14.75 / 24.00 h |
| validation | trend24 | 0.05 % | 62 | +4.75 % | 0.15 | 1.35 | 4.36 % | 18.38 / 24.00 h |
| validation | trend24 | 0.10 % | 61 | +3.34 % | 0.11 | 1.25 | 4.57 % | 20.00 / 24.00 h |
| recent | pulse12 | 0.05 % | 17 | -0.31 % | -0.04 | 0.88 | 1.39 % | 12.00 / 12.00 h |
| recent | pulse12 | 0.10 % | 18 | -0.15 % | -0.02 | 0.95 | 1.43 % | 12.00 / 12.00 h |
| recent | pulse24 | 0.05 % | 11 | -1.91 % | -0.35 | 0.36 | 2.41 % | 23.75 / 24.00 h |
| recent | pulse24 | 0.10 % | 11 | -1.30 % | -0.24 | 0.49 | 2.25 % | 24.00 / 24.00 h |
| recent | trend24 | 0.05 % | 10 | -0.48 % | -0.09 | 0.81 | 1.77 % | 15.63 / 24.00 h |
| recent | trend24 | 0.10 % | 10 | -0.70 % | -0.14 | 0.72 | 1.74 % | 15.63 / 24.00 h |

Utveckling: 14 mars–30 juni. Validering: 1 juli–31 augusti. Recent: 1–9 september, endast beskrivande. Varje delperiod startar från 100 dollar. PF baseras på nettotraders vinster/förluster.

## Coinbidrag vid normal slippage

| Period | Profil | BTC | ETH | SOL | XRP | DOGE | SHIB | PEPE |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| development | pulse12 | -0.32 $ (17) | -4.63 $ (23) | +1.45 $ (43) | -3.17 $ (19) | -3.06 $ (29) | -0.42 $ (20) | -3.81 $ (31) |
| development | pulse24 | -0.98 $ (11) | -3.96 $ (18) | +4.57 $ (27) | -2.77 $ (10) | -1.52 $ (25) | -0.67 $ (17) | -5.21 $ (24) |
| development | trend24 | -0.31 $ (16) | -0.29 $ (11) | +1.60 $ (16) | -0.69 $ (5) | -0.24 $ (13) | -4.68 $ (21) | -1.39 $ (13) |
| validation | pulse12 | +0.65 $ (8) | -0.10 $ (17) | +1.86 $ (21) | -0.62 $ (11) | -0.51 $ (5) | +0.07 $ (21) | -1.18 $ (31) |
| validation | pulse24 | -0.04 $ (4) | +0.92 $ (14) | +2.22 $ (16) | -0.05 $ (8) | -0.25 $ (3) | -0.22 $ (13) | -0.69 $ (22) |
| validation | trend24 | -1.63 $ (10) | +2.92 $ (15) | +2.97 $ (7) | -0.05 $ (4) | -2.50 $ (9) | +2.58 $ (9) | +0.46 $ (8) |
| recent | pulse12 | -0.29 $ (1) | +0.00 $ (0) | -0.23 $ (1) | +0.11 $ (2) | -0.60 $ (3) | +1.73 $ (6) | -1.03 $ (4) |
| recent | pulse24 | -0.50 $ (1) | +0.00 $ (0) | -0.50 $ (1) | -0.18 $ (2) | +0.07 $ (1) | +0.20 $ (4) | -1.00 $ (2) |
| recent | trend24 | -0.51 $ (1) | +0.00 $ (0) | +0.00 $ (0) | -0.42 $ (2) | -0.47 $ (2) | +0.92 $ (5) | +0.00 $ (0) |

## Avslut och kostnader vid normal slippage

| Period | Profil | SL / gap-SL | TP | Tid | Periodslut | Avgifter | Fundingkostnad |
|---|---|---:|---:|---:|---:|---:|---:|
| development | pulse12 | 67 / 0 | 14 | 100 | 1 | 4.66 $ | +0.14 $ |
| development | pulse24 | 74 / 0 | 26 | 31 | 1 | 3.36 $ | +0.16 $ |
| development | trend24 | 47 / 0 | 8 | 39 | 1 | 2.85 $ | +0.18 $ |
| validation | pulse12 | 27 / 0 | 16 | 70 | 1 | 2.96 $ | +0.15 $ |
| validation | pulse24 | 30 / 0 | 20 | 29 | 1 | 2.07 $ | +0.15 $ |
| validation | trend24 | 23 / 0 | 10 | 28 | 1 | 2.18 $ | +0.21 $ |
| recent | pulse12 | 3 / 0 | 2 | 12 | 0 | 0.39 $ | +0.03 $ |
| recent | pulse24 | 5 / 0 | 1 | 5 | 0 | 0.25 $ | +0.02 $ |
| recent | trend24 | 5 / 0 | 1 | 4 | 0 | 0.29 $ | +0.02 $ |

## Begränsningar och reproduktion

- 15-minutersstaplar visar inte ordningen mellan alla intrastapelrörelser. SL prioriteras vid tvetydighet. Exekvering vid historiska öppningar kan vara bättre än verklig browserfördröjning.
- Markpris utlöser SL och TP, värderar innehav och används för funding. Historisk fyllning vid markpris ersätter inte verklig orderbok. Ingen historisk orderbok, marknadsdjup, orderkvantitetsavrundning eller exakta historiska risktrappor ingår i denna låga exponeringsjämförelse.
- Funding täcker varje coin med högst åtta timmar mellan observationerna. Offentlig historik anger inte alltid varför betalningsintervall ändrats.
- Fast SL begränsar planerad förlust, inte garanterad förlust vid gap, större slippage eller saknade prisuppdateringar. Maxnedgång mäts vid 15-minutersstängning och kan underskatta rörelser inom stapeln.
- Historisk ranking är inte en tränad AI-modell. Tre fasta hypoteser jämfördes och inga nya regler söktes efter resultat.

Kör `node research/crypto-momentum-active-data.mjs --download` och därefter `node research/crypto-momentum-active-run.mjs`. Rådata, utvecklingslås och fullständiga affärsloggar sparas lokalt i `.matning/crypto-active/`; den kompakta exporten finns i `crypto-momentum-active-research.js`.

### Datahashar

| Coin | Pris/markstaplar vardera | Fundinghändelser | SHA-256 |
|---|---:|---:|---|
| BTC | 18048 | 564 | 4a3ab4f2de437a74f8adae8343c774c2df143d1d4549287aadb4529b4f669f6c |
| ETH | 18048 | 564 | 447f68bbfc8fb79960802bbd041b66370525b66f02629858ad5399266f31b8a4 |
| SOL | 18048 | 564 | 2ef5508b930ed3a5548a7164e14b916c09728189fa355e9ca4e33353e1694acf |
| XRP | 18048 | 564 | 4ff45f4cc4f64d761f86dcaf81f4380e3d1d7dae28f08cade3920b720aaa6e46 |
| DOGE | 18048 | 564 | 198d1118b1b0acf02edae04fdd0280ca197fc85022a7ba4bde47d588c22b28e5 |
| SHIB | 18048 | 564 | a5d00c863539dc5e383ae7ce3bf03de07b158087158a9031c10f046cd8bdd947 |
| PEPE | 18048 | 564 | 1ecf51342c89fb6e94f1cf4610d4ffef4a3134096765e8f772fdc790266694db |

Protokoll SHA-256: bd2f271ac03c96bd4a089a1cba91aac3f460da31b81b477f012f0b69f9287f01.
Signal SHA-256: 1945c01c9f9963765d4248e7d1187f94e40d89b16bf40d872f2a2583b4096d5d.
Simulator SHA-256: 79535f568e990fddb90068a6303c6387fa427e0480791e01d3f6a5f77e20995b.

Officiella källor: [Bybit Kline](https://bybit-exchange.github.io/docs/v5/market/kline), [markpriser](https://bybit-exchange.github.io/docs/v5/market/mark-kline), [fundinghistorik](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).

## Separat scenario: användarens 50 % riskgräns

Detta använder dagens Bybit-risktrappor från 2026-09-11T19:53:41.967Z på historiska priser och den gemensamma `openActivePosition`-funktionen. Högst 50 % av kontot får användas som isolerad marginal och högst 50 % planerad SL-risk inklusive kostnader; verklig planerad risk blir ofta lägre på grund av marginaltaket och likvidationsbufferten. Det är inte historiskt korrekta maxhävstänger och inte underlag för profilurvalet.

| Period | Profil | Slip/sida | Avslut | Slutkapital | Netto | Max nedgång | Likvidationer | Hävstång min–max | Median planerad SL-risk |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| development | pulse12 | 0.05 % | 182 | 0.00 $ | -100.00 % | 100.00 % | 0 | 13.72–56.57× | 34.12 % |
| development | pulse12 | 0.10 % | 151 | 0.00 $ | -100.00 % | 100.00 % | 0 | 13.61–39.59× | 35.00 % |
| development | pulse24 | 0.05 % | 132 | 0.00 $ | -100.00 % | 100.00 % | 0 | 15.10–56.57× | 33.91 % |
| development | pulse24 | 0.10 % | 111 | 0.00 $ | -100.00 % | 100.00 % | 0 | 14.97–39.59× | 34.58 % |
| development | trend24 | 0.05 % | 95 | 0.00 $ | -100.00 % | 100.00 % | 0 | 19.40–82.18× | 33.12 % |
| development | trend24 | 0.10 % | 95 | 0.00 $ | -100.00 % | 100.00 % | 0 | 19.18–78.21× | 34.13 % |
| validation | pulse12 | 0.05 % | 114 | 1.01 $ | -98.99 % | 99.88 % | 0 | 7.59–56.81× | 33.84 % |
| validation | pulse12 | 0.10 % | 84 | 11.67 $ | -88.33 % | 98.73 % | 0 | 7.56–40.33× | 34.92 % |
| validation | pulse24 | 0.05 % | 80 | 2.84 $ | -97.16 % | 99.59 % | 0 | 7.59–56.81× | 33.60 % |
| validation | pulse24 | 0.10 % | 63 | 15.12 $ | -84.88 % | 98.11 % | 0 | 7.56–39.65× | 34.01 % |
| validation | trend24 | 0.05 % | 62 | 37.27 $ | -62.73 % | 97.74 % | 0 | 9.07–93.50× | 33.27 % |
| validation | trend24 | 0.10 % | 61 | 15.53 $ | -84.47 % | 98.18 % | 0 | 9.02–81.91× | 34.84 % |
| recent | pulse12 | 0.05 % | 17 | 43.20 $ | -56.80 % | 67.03 % | 0 | 17.57–50.82× | 32.99 % |
| recent | pulse12 | 0.10 % | 18 | 48.12 $ | -51.88 % | 70.68 % | 0 | 17.39–32.82× | 33.47 % |
| recent | pulse24 | 0.05 % | 11 | 15.88 $ | -84.12 % | 89.11 % | 0 | 17.57–50.82× | 33.69 % |
| recent | pulse24 | 0.10 % | 11 | 26.50 $ | -73.50 % | 84.28 % | 0 | 17.39–32.82× | 34.38 % |
| recent | trend24 | 0.05 % | 10 | 36.22 $ | -63.78 % | 74.61 % | 0 | 24.63–81.95× | 31.99 % |
| recent | trend24 | 0.10 % | 10 | 30.95 $ | -69.05 % | 77.89 % | 0 | 24.27–78.00× | 32.96 % |

Även med SL och skyddad ledig marginal kan många förluster i rad förbruka nästan hela kontot. Noll dollar med två decimaler kan betyda ett positivt belopp under ett halvt cent. Kontot har inte fyllts på mellan affärerna. Historiken innehåller inga likvidationer i denna scenariomodell om tabellen visar noll; det betyder inte att likvidation kan uteslutas i andra marknadsförlopp.

Stresskörningen räknar om inträdeskravet netto-R:R ≥ 1,5 vid den högre slippagen. Den kan därför hoppa över affärer och ibland ge bättre netto; den är inte en identisk affärslista med bara större kostnader.

Reproducera tillägget med `node research/crypto-momentum-active-data.mjs --contracts` och `node research/crypto-momentum-active-run.mjs --scenario`. Metadata och samtliga affärer finns i `.matning/crypto-active/user-risk-scenario.json`.
