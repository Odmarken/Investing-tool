# Momentum: resultat av sex ändringar

Körd 2026-09-11T12:46:13.732Z. **Flera momentumhorisonter gav ett bättre resultat under 2025–2026, men hade större nedgång under 2023–2024. Den i förväg valda kandidaten med dagliga beslut misslyckades i den senare perioden. Ingen generell förbättring eller maximal möjlig avkastning har bevisats.**

Original och sex ändringar kördes var för sig enligt ett dokumenterat protokoll, utan parameteroptimering. BTC/ETH/SOL spot, ingen hävstång, startkapital 100 dollar. Avgift 0,10 % och slippage 0,05 % per sida ingår. Stress dubblar slippage. Vinster återinvesteras inom kapitaldelarna.

## Vad som ändrades

- Dagliga beslut: samma 28-dagarssignal, men utvärdering varje dag.
- Buffert: köp över +2 % momentum, sälj under −2 %.
- Trendfilter: positivt momentum och pris över 84-dagarsmedelvärdet.
- Flera horisonter: medelvärdet av prisavkastning över 14, 28 och 56 dygn; håll när detta är positivt, annars kontanter. Fortsatt veckokontroll.
- Volatilitetsbegränsat inträde: investera en mindre del vid hög uppmätt volatilitet, enligt den fasta formeln i protokollet.
- Två starkaste: upp till två positiva coins i två separata kapitaldelar, med 50 % var vid start. Ingen löpande likaviktsåterställning.

## Tidig period och låst urval: 2023–2024

| Ändring | Netto | Max daglig nedgång | Stressnetto | Stressnedgång | Innehav |
|---|---:|---:|---:|---:|---:|
| Original 28 dagar | 322.9 % | 45.5 % | 318.5 % | 45.7 % | 33 |
| Dagliga beslut | 517.1 % | 40.3 % | 503.9 % | 40.6 % | 84 |
| Buffert ±2 % | 273.1 % | 49.2 % | 269.7 % | 49.4 % | 29 |
| Trendfilter 84 dagar | 144.0 % | 41.3 % | 141.2 % | 41.4 % | 34 |
| Momentum 14/28/56 | 119.8 % | 56.8 % | 117.5 % | 57.0 % | 32 |
| Volatilitetsbegränsat inträde | 216.0 % | 28.4 % | 213.5 % | 28.5 % | 33 |
| Två starkaste | 279.4 % | 41.7 % | 272.3 % | 41.8 % | 37 |

Avkastningskandidat, vald på högst positiv stressavkastning: **Dagliga beslut**. Balanserad kandidat, vald på stressavkastning/nedgång bland varianter med högst originalets nedgång: **Dagliga beslut**. Båda besluten låstes innan senare simuleringar kördes. Kraven och dataperioderna skiljer sig från det gamla 35 %-testet; det gamla testets underkännande kvarstår.

## Senare period: 1 januari 2025–9 september 2026

Alla ändringar visas. Perioden är redan använd i projektets forskning; en vinnare som upptäcks här är en utvecklingskandidat, inte ett oberoende validerat system.

| Ändring | Netto | Max daglig nedgång | Stressnetto | Innehav | Genomsnittlig exponering | Omsättning/startkapital |
|---|---:|---:|---:|---:|---:|---:|
| Original 28 dagar | 28.5 % | 31.9 % | 27.1 % | 34 | 48.0 % | 25.8× |
| Dagliga beslut | -1.6 % | 33.7 % | -4.5 % | 89 | 48.0 % | 57.0× |
| Buffert ±2 % | 26.5 % | 32.0 % | 25.6 % | 26 | 48.9 % | 18.4× |
| Trendfilter 84 dagar | 5.3 % | 27.5 % | 4.5 % | 23 | 31.2 % | 15.3× |
| Momentum 14/28/56 | 44.7 % | 25.2 % | 43.7 % | 25 | 45.1 % | 17.3× |
| Volatilitetsbegränsat inträde | 16.7 % | 25.0 % | 15.7 % | 34 | 36.0 % | 18.7× |
| Två starkaste | 35.1 % | 35.0 % | 33.1 % | 32 | 55.7 % | 34.0× |

Den låsta kandidaten **dagliga beslut** gav −1,6 % i denna period, −4,5 % vid stress och endast 2 av 9 positiva tolvmånadersfönster. Den klarade alltså inte den senare kontrollen trots starkast utvecklingsresultat.

## Känslighet för startdatum

Samtliga nio fullständiga tolvmånadersfönster med månatlig start från januari 2025. Varje fönster börjar om med kontanter. De överlappar och är inte oberoende försök.

| Ändring | Positiva fönster | Positiva vid stress | Median | Sämst | Bäst |
|---|---:|---:|---:|---:|---:|
| Original 28 dagar | 6/9 | 6/9 | 20.1 % | -13.6 % | 30.3 % |
| Dagliga beslut | 2/9 | 2/9 | -3.6 % | -21.3 % | 7.1 % |
| Buffert ±2 % | 5/9 | 5/9 | 18.9 % | -17.8 % | 30.0 % |
| Trendfilter 84 dagar | 6/9 | 6/9 | 7.9 % | -12.1 % | 9.9 % |
| Momentum 14/28/56 | 7/9 | 7/9 | 29.8 % | -7.5 % | 41.5 % |
| Volatilitetsbegränsat inträde | 6/9 | 6/9 | 8.3 % | -10.1 % | 18.8 % |
| Två starkaste | 7/9 | 7/9 | 20.2 % | -8.8 % | 29.4 % |

## 2026 med och utan omstart

Den sammanhängande årssiffran behåller innehav och kapital från 2025. Omstarten börjar med 100 dollar och tomma innehav den 1 januari 2026. Alla siffror slutar 9 september.

| Ändring | 2025, sammanhängande konto | 2026, samma konto | 2026, nytt konto |
|---|---:|---:|---:|
| Original 28 dagar | 30.3 % | -1.4 % | -5.9 % |
| Dagliga beslut | 7.1 % | -8.2 % | -9.8 % |
| Buffert ±2 % | 30.1 % | -2.8 % | -14.3 % |
| Trendfilter 84 dagar | 7.9 % | -2.4 % | -3.3 % |
| Momentum 14/28/56 | 29.8 % | 11.5 % | 6.6 % |
| Volatilitetsbegränsat inträde | 18.8 % | -1.8 % | -3.9 % |
| Två starkaste | 28.8 % | 4.9 % | -1.7 % |

## Bidrag och koncentration under 2025–2026

Bidragen gäller startkapital 100 dollar och är inte resultatet av att köra varje coin med hela kontot.

| Ändring | BTC, dollar | ETH, dollar | SOL, dollar | Fem största vinnarnas andel av vinstaffärers P/L |
|---|---:|---:|---:|---:|
| Original 28 dagar | -0.96 | 36.69 | -7.28 | 88.9 % |
| Dagliga beslut | -3.53 | 14.17 | -12.27 | 63.9 % |
| Buffert ±2 % | -6.46 | 48.03 | -15.03 | 91.8 % |
| Trendfilter 84 dagar | 0.71 | 12.87 | -8.29 | 91.1 % |
| Momentum 14/28/56 | -5.62 | 50.95 | -0.60 | 92.9 % |
| Volatilitetsbegränsat inträde | -1.70 | 22.90 | -4.55 | 86.9 % |
| Två starkaste | 9.75 | 49.84 | -24.52 | 83.5 % |

## Bedömning

**Flera horisonter är det tydligaste nya uppslaget för fortsatt demo**, eftersom det gav högre senare avkastning, lägre senare nedgång, lägre omsättning och fler positiva startfönster än originalet. Det separata 2026-testet blev också positivt. Men utvecklingsperioden gav bara +119,8 % mot originalets +322,9 %, och nedgången var 56,8 % mot 45,5 %. Den valdes inte före den senare kontrollen. Vi kan därför inte kalla detta en bekräftad uppgradering eller byta strategi i efterhand och räkna samma historik som nytt bevis.

Volatilitetsbegränsningen minskade nedgången i båda perioderna men minskade också avkastningen. Den är en tydligare avvägning mellan risk och avkastning än ett sätt att maximera båda. Två starkaste ökade senare avkastning men ökade också senare nedgång. Bufferten gav färre affärer utan högre senare totalavkastning. Trendfiltret sänkte både exponering och senare avkastning.

Nästa steg som kan ge ny evidens är att frysa originalet och 14/28/56-varianten sida vid sida i framåtriktad demo. Kombinera inte automatiskt de historiskt bästa ändringarna och höj inte hävstången för att kalla resultatet bättre. Det kräver ett eget mätt experiment.

## Källor och granskning

Motiv till hypoteserna finns i forskning om [kryptomomentum](https://www.nber.org/papers/w24877), [kryptons riskfaktorer](https://www.nber.org/papers/w25882) och [volatilitetsstyrda portföljer i andra marknader](https://www.nber.org/papers/w22208). Artiklarna testar inte våra exakta regler.

170 portföljkörningar stämdes av för kapital, avgifter, handelstider och exponering utan belåning. Originalets affärer, dagliga kapitalserie och slutkapital matchar exakt de tidigare sparade resultaten för båda huvudperioderna. Tester täcker framtidsdata, buffertregler, tidpunkt för köp, stabila kapitaldelar, volatilitet och kvarvarande kontanter.

Nedgång mäts på dygnsstängningar. Begränsat universum, antagen slippage och avsaknad av intradagsexekvering begränsar vad siffrorna säger om verklig handel. Ingen kontologik eller modell på sidan har ändrats.

Kör `node research/crypto-momentum-tweaks-run.mjs` och `node research/crypto-momentum-tweaks-report.mjs`. Det kräver befintlig verifierad cache och tidigare basresultat. Fullständiga affärer, kapitalserier, datahashar och låst urval: `.matning/crypto-slow/tweaks.json`. [Protokoll före körning](crypto-momentum-tweaks-protocol.md).

## Alla tolvmånadersfönster

| Ändring | Start | Slut, exklusive | Netto | Stressnetto | Max daglig nedgång |
|---|---|---|---:|---:|---:|
| Original 28 dagar | 2025-01-01 | 2026-01-01 | 30.3 % | 29.6 % | 19.0 % |
| Original 28 dagar | 2025-02-01 | 2026-02-01 | 27.1 % | 26.3 % | 24.5 % |
| Original 28 dagar | 2025-03-01 | 2026-03-01 | 30.1 % | 29.3 % | 24.6 % |
| Original 28 dagar | 2025-04-01 | 2026-04-01 | 20.7 % | 19.9 % | 32.2 % |
| Original 28 dagar | 2025-05-01 | 2026-05-01 | 20.1 % | 19.2 % | 32.1 % |
| Original 28 dagar | 2025-06-01 | 2026-06-01 | -3.0 % | -3.7 % | 31.8 % |
| Original 28 dagar | 2025-07-01 | 2026-07-01 | 3.9 % | 3.3 % | 32.1 % |
| Original 28 dagar | 2025-08-01 | 2026-08-01 | -11.8 % | -12.5 % | 31.8 % |
| Original 28 dagar | 2025-09-01 | 2026-09-01 | -13.6 % | -14.2 % | 31.1 % |
| Dagliga beslut | 2025-01-01 | 2026-01-01 | 7.1 % | 5.5 % | 16.4 % |
| Dagliga beslut | 2025-02-01 | 2026-02-01 | -2.8 % | -4.5 % | 26.6 % |
| Dagliga beslut | 2025-03-01 | 2026-03-01 | 2.2 % | 0.5 % | 26.4 % |
| Dagliga beslut | 2025-04-01 | 2026-04-01 | -3.6 % | -5.4 % | 33.4 % |
| Dagliga beslut | 2025-05-01 | 2026-05-01 | -1.2 % | -3.1 % | 33.4 % |
| Dagliga beslut | 2025-06-01 | 2026-06-01 | -17.0 % | -18.6 % | 33.0 % |
| Dagliga beslut | 2025-07-01 | 2026-07-01 | -11.3 % | -12.9 % | 33.1 % |
| Dagliga beslut | 2025-08-01 | 2026-08-01 | -21.3 % | -22.7 % | 32.9 % |
| Dagliga beslut | 2025-09-01 | 2026-09-01 | -16.1 % | -17.6 % | 31.2 % |
| Buffert ±2 % | 2025-01-01 | 2026-01-01 | 30.0 % | 29.4 % | 18.7 % |
| Buffert ±2 % | 2025-02-01 | 2026-02-01 | 25.6 % | 25.0 % | 23.4 % |
| Buffert ±2 % | 2025-03-01 | 2026-03-01 | 27.5 % | 27.0 % | 23.9 % |
| Buffert ±2 % | 2025-04-01 | 2026-04-01 | 18.9 % | 18.3 % | 31.5 % |
| Buffert ±2 % | 2025-05-01 | 2026-05-01 | 21.9 % | 21.2 % | 31.4 % |
| Buffert ±2 % | 2025-06-01 | 2026-06-01 | -4.4 % | -4.9 % | 32.1 % |
| Buffert ±2 % | 2025-07-01 | 2026-07-01 | -1.8 % | -2.3 % | 33.7 % |
| Buffert ±2 % | 2025-08-01 | 2026-08-01 | -17.8 % | -18.3 % | 36.0 % |
| Buffert ±2 % | 2025-09-01 | 2026-09-01 | -17.8 % | -18.3 % | 36.0 % |
| Trendfilter 84 dagar | 2025-01-01 | 2026-01-01 | 7.9 % | 7.4 % | 20.7 % |
| Trendfilter 84 dagar | 2025-02-01 | 2026-02-01 | 9.9 % | 9.4 % | 21.0 % |
| Trendfilter 84 dagar | 2025-03-01 | 2026-03-01 | 9.9 % | 9.4 % | 21.0 % |
| Trendfilter 84 dagar | 2025-04-01 | 2026-04-01 | 9.9 % | 9.4 % | 21.0 % |
| Trendfilter 84 dagar | 2025-05-01 | 2026-05-01 | 9.8 % | 9.2 % | 21.1 % |
| Trendfilter 84 dagar | 2025-06-01 | 2026-06-01 | -3.0 % | -3.5 % | 25.7 % |
| Trendfilter 84 dagar | 2025-07-01 | 2026-07-01 | 3.9 % | 3.5 % | 26.1 % |
| Trendfilter 84 dagar | 2025-08-01 | 2026-08-01 | -12.1 % | -12.5 % | 27.9 % |
| Trendfilter 84 dagar | 2025-09-01 | 2026-09-01 | -10.5 % | -11.0 % | 27.3 % |
| Momentum 14/28/56 | 2025-01-01 | 2026-01-01 | 29.8 % | 29.4 % | 20.5 % |
| Momentum 14/28/56 | 2025-02-01 | 2026-02-01 | 37.6 % | 37.2 % | 24.4 % |
| Momentum 14/28/56 | 2025-03-01 | 2026-03-01 | 37.6 % | 37.2 % | 24.4 % |
| Momentum 14/28/56 | 2025-04-01 | 2026-04-01 | 37.6 % | 37.2 % | 24.4 % |
| Momentum 14/28/56 | 2025-05-01 | 2026-05-01 | 41.5 % | 40.9 % | 24.5 % |
| Momentum 14/28/56 | 2025-06-01 | 2026-06-01 | 10.8 % | 10.3 % | 24.9 % |
| Momentum 14/28/56 | 2025-07-01 | 2026-07-01 | 13.0 % | 12.5 % | 25.0 % |
| Momentum 14/28/56 | 2025-08-01 | 2026-08-01 | -7.5 % | -7.9 % | 27.7 % |
| Momentum 14/28/56 | 2025-09-01 | 2026-09-01 | -1.8 % | -2.3 % | 27.8 % |
| Volatilitetsbegränsat inträde | 2025-01-01 | 2026-01-01 | 18.8 % | 18.3 % | 14.7 % |
| Volatilitetsbegränsat inträde | 2025-02-01 | 2026-02-01 | 12.5 % | 11.9 % | 19.7 % |
| Volatilitetsbegränsat inträde | 2025-03-01 | 2026-03-01 | 13.6 % | 13.1 % | 19.7 % |
| Volatilitetsbegränsat inträde | 2025-04-01 | 2026-04-01 | 8.3 % | 7.7 % | 25.0 % |
| Volatilitetsbegränsat inträde | 2025-05-01 | 2026-05-01 | 9.3 % | 8.7 % | 25.0 % |
| Volatilitetsbegränsat inträde | 2025-06-01 | 2026-06-01 | -3.2 % | -3.7 % | 25.0 % |
| Volatilitetsbegränsat inträde | 2025-07-01 | 2026-07-01 | 0.9 % | 0.4 % | 25.0 % |
| Volatilitetsbegränsat inträde | 2025-08-01 | 2026-08-01 | -10.1 % | -10.6 % | 24.9 % |
| Volatilitetsbegränsat inträde | 2025-09-01 | 2026-09-01 | -9.3 % | -9.8 % | 23.9 % |
| Två starkaste | 2025-01-01 | 2026-01-01 | 28.8 % | 27.6 % | 17.8 % |
| Två starkaste | 2025-02-01 | 2026-02-01 | 25.6 % | 24.4 % | 27.5 % |
| Två starkaste | 2025-03-01 | 2026-03-01 | 29.4 % | 28.2 % | 27.6 % |
| Två starkaste | 2025-04-01 | 2026-04-01 | 20.2 % | 19.0 % | 35.4 % |
| Två starkaste | 2025-05-01 | 2026-05-01 | 21.5 % | 20.2 % | 35.3 % |
| Två starkaste | 2025-06-01 | 2026-06-01 | 7.8 % | 6.7 % | 35.3 % |
| Två starkaste | 2025-07-01 | 2026-07-01 | 14.1 % | 13.1 % | 35.5 % |
| Två starkaste | 2025-08-01 | 2026-08-01 | -5.1 % | -6.0 % | 36.1 % |
| Två starkaste | 2025-09-01 | 2026-09-01 | -8.8 % | -9.7 % | 36.1 % |
