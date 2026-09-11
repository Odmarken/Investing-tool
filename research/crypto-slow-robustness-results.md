# Fortsättning: stabilitet i 28-dagars momentum

Körd 2026-09-11T12:35:08.704Z. Samma veckoregel och kostnader som tidigare, utan parameterändringar. Detta är en fortsatt granskning av den kandidat som diskuterades med användaren, inte ett nytt AI-modelltest.

## Olika startdatum

Varje körning startar med 100 dollar i kontanter och samma fördelning BTC/ETH/SOL. Köp och behåll startar samtidigt. Bara fullständiga 6- och 12-månadersfönster från januari 2025 används.

| Längd | Fönster | Positiva | Positiva med dubbel slippage | Bättre än köp och behåll | Median | Sämst | Bäst |
|---|---:|---:|---:|---:|---:|---:|---:|
| 6 månader | 15 | 8/15 | 8/15 | 12/15 | 4.4 % | -27.6 % | 59.4 % |
| 12 månader | 9 | 6/9 | 6/9 | 9/9 | 20.1 % | -13.6 % | 30.3 % |

Fönstren överlappar kraftigt. Andelen positiva fönster är beskrivande statistik, inte sannolikheten för framtida vinst eller oberoende testresultat.

## Beroende av stora vinnare

För den sammanhängande perioden 2025-01-01 till före 2026-09-10, med startkapital 100 dollar:

- Nettoresultat: 28.45 dollar.
- Största vinnaren: 29.13 dollar.
- Fem största vinnarnas andel av samtliga vinstaffärers P/L: 88.9 %.
- Netto-P/L minus största vinnarens bokförda bidrag: -0.68 dollar.
- Netto-P/L minus fem största vinnarnas bokförda bidrag: -43.77 dollar.

Subtraktionerna är en bidragsanalys. De simulerar inte hur kapital, senare positioner eller avkastning hade ändrats om affärerna saknats. Trendföljning kan vara beroende av få stora vinnare; siffrorna beskriver detta beroende.

| Coin | Bidrag, dollar | Innehav |
|---|---:|---:|
| BTC | -0.96 | 15 |
| ETH | 36.69 | 9 |
| SOL | -7.28 | 10 |

## Årsutfall i samma konto

Positioner och kapital följer med över årsskiftet. Dessa årsavkastningar kan kedjas till den sammanhängande totalen. De tidigare årsvisa omstarterna besvarar en annan fråga. 2026 slutar 9 september.

| År | Ingående kapital | Utgående kapital | Avkastning |
|---|---:|---:|---:|
| 2025 | 100.00 | 130.34 | 30.3 % |
| 2026 | 130.34 | 128.45 | -1.4 % |

## Alla startfönster

| Månader | Start | Slut, exklusive | Netto | Stress | Köp och behåll | Max daglig nedgång |
|---|---|---|---:|---:|---:|---:|
| 6 | 2025-01-01 | 2025-07-01 | 5.6 % | 5.2 % | -10.0 % | 13.8 % |
| 6 | 2025-02-01 | 2025-08-01 | 37.2 % | 36.8 % | -0.5 % | 14.1 % |
| 6 | 2025-03-01 | 2025-09-01 | 57.1 % | 56.7 % | 52.9 % | 14.1 % |
| 6 | 2025-04-01 | 2025-10-01 | 59.4 % | 58.9 % | 77.2 % | 14.1 % |
| 6 | 2025-05-01 | 2025-11-01 | 38.4 % | 37.9 % | 52.1 % | 19.3 % |
| 6 | 2025-06-01 | 2025-12-01 | 14.8 % | 14.4 % | -3.6 % | 19.1 % |
| 6 | 2025-07-01 | 2026-01-01 | 21.7 % | 21.3 % | -6.3 % | 19.3 % |
| 6 | 2025-08-01 | 2026-02-01 | -3.0 % | -3.4 % | -35.0 % | 24.0 % |
| 6 | 2025-09-01 | 2026-03-01 | -16.1 % | -16.4 % | -50.6 % | 23.3 % |
| 6 | 2025-10-01 | 2026-04-01 | -27.6 % | -27.9 % | -50.0 % | 31.1 % |
| 6 | 2025-11-01 | 2026-05-01 | -14.3 % | -14.6 % | -42.6 % | 24.0 % |
| 6 | 2025-12-01 | 2026-06-01 | -15.0 % | -15.3 % | -30.1 % | 24.0 % |
| 6 | 2026-01-01 | 2026-07-01 | -14.1 % | -14.3 % | -40.5 % | 23.9 % |
| 6 | 2026-02-01 | 2026-08-01 | -8.3 % | -8.6 % | -25.3 % | 14.3 % |
| 6 | 2026-03-01 | 2026-09-01 | 4.4 % | 4.0 % | 21.3 % | 14.3 % |
| 12 | 2025-01-01 | 2026-01-01 | 30.3 % | 29.6 % | -17.4 % | 19.0 % |
| 12 | 2025-02-01 | 2026-02-01 | 27.1 % | 26.3 % | -34.6 % | 24.5 % |
| 12 | 2025-03-01 | 2026-03-01 | 30.1 % | 29.3 % | -25.5 % | 24.6 % |
| 12 | 2025-04-01 | 2026-04-01 | 20.7 % | 19.9 % | -11.9 % | 32.2 % |
| 12 | 2025-05-01 | 2026-05-01 | 20.1 % | 19.2 % | -12.5 % | 32.1 % |
| 12 | 2025-06-01 | 2026-06-01 | -3.0 % | -3.7 % | -32.7 % | 31.8 % |
| 12 | 2025-07-01 | 2026-07-01 | 3.9 % | 3.3 % | -45.0 % | 32.1 % |
| 12 | 2025-08-01 | 2026-08-01 | -11.8 % | -12.5 % | -51.2 % | 31.8 % |
| 12 | 2025-09-01 | 2026-09-01 | -13.6 % | -14.2 % | -40.1 % | 31.1 % |

## Tolkning och nästa steg

Det positiva totalresultatet gäller ett visst startdatum och innehåller både positiva och negativa delperioder. Detta test visar hur känsligt resultatet är för startdatum och vinnarnas bidrag. Det ändrar inte det tidigare urvalsbeslutet eller gör historiken orörd. Användarens acceptans för större nedgång motiverar fortsatt experiment, men är ingen uppmätt framtida riskgräns.

Nästa genomförandesteg är att låsa denna exakta regel och samla framåtriktade demobeslut med tidsstämpel, kostnader och egen resultathistorik. Ingen parameter valdes om i denna granskning och ingen automatisk handelsbehörighet ges av rapporten.

## Reproduktion

Kör `node research/crypto-slow-robustness.mjs`. Kräver befintlig verifierad dygnscache i `.matning/crypto-slow`. Fullständiga siffror och data-/protokollhashar sparas i `.matning/crypto-slow/robustness.json`. [Protokoll](crypto-slow-robustness-protocol.md).
