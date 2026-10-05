# AI Forecast: resultat

Omkörd 2026-10-05 efter en rättelse av storleksregeln: risken per affär kunde överskridas när likvidationen låg före stoppet eller mindre än 1 % bortom det. Första körningen gjordes samma dag, och [Omkörning](#omkörning-efter-rättelsen-av-storleksregeln) nedan säger vad som ändrades. [Protokollet](ai-forecast-protocol.md) frystes före första resultaträkningen och har inte ändrats, och urvalslåset är oförändrat i sak: samma regel och samma urval, ingen behörig kandidat. Utvecklingens urval skrevs till `selection-lock.json` innan någon valideringssiffra räknades. Allt räknades med AI Forecast-modulerna själva (`forecast-model.js`, `forecast-account.js` och `forecast-backtest.js`): samma signalregler, storleksregel, avgifter, likvidationsnivåer och händelseordning inom candlen som demokontot använder.

**Ingen kandidat blev behörig.** Alla åtta förlorade pengar på utvecklingsperioden med referensstorleken, vid både normal och stressad slippage (netto −96,6 % till −43,3 %). Enligt protokollet väljs då ingen: standardinställningen `b20-s1.5-t2` behålls och signalreglerna `af-signal-v1` redovisas som **ej validerade**. Inga parametrar ändras.

**Prognosmodellen `af-forecast-v1` slog inte en oförändrad-prognos** på någon horisont (skill −3,3 %, −4,0 % och −6,4 % på 5, 10 och 20 candles) och redovisas därför som en ren osäkerhetsillustration. Banden låg däremot nära sina nominella nivåer: 75–78 % av de verkliga stängningarna låg inom 80 %-bandet.

**Kontots standard tömde kontot.** Med Bybits maxhävstång, 25 % marginal och 10 % risk per affär likviderades 83 av 95 affärer på valideringsåret, och kapitalet var under 1 $ efter 22 dagar. Med referensstorleken förlorade samma regler 35,2 % på samma år.

Resultaten är historiska och retrospektiva; de visar inte framtida avkastning.

## Omkörning efter rättelsen av storleksregeln

Rättelsen har två delar. Första körningen räknade förlusten vid stoppet som min(1, L × (stoppavståndet + 0,21 %)) av marginalen. Med Bybits maxhävstång ligger likvidationsnivån ofta före stoppet, och då tar en rörelse till stoppet hela marginalen plus öppningsavgiften. Med DOGE på 75× och ett stopp 0,56 % från ingången, där likvidationen låg 0,53 % bort, gav regeln 17,32 $ i marginal och en förlust på 18,03 $ i stället för 10 $ av 100 $; även när andelen var 1 kom öppningsavgiften ovanpå (8,25 % av marginalen vid 150×). Nu räknas förlusten i det fallet som marginalen plus öppningsavgiften, 1 + L × 0,055 % av marginalen.

Det andra fallet är en likvidation strax bortom stoppet. Funding som positionen betalar medan den är öppen dras från marginalen och flyttar likvidationen närmare, och en candle som når stoppet går ofta förbi det. Med BTC på 150× och ett stopp 0,28 % från ingången låg likvidationen 0,283 % bort, alltså bortom stoppet, och regeln gav 13,61 $ i marginal. En vanlig funding på 0,01 % flyttade likvidationen till 0,273 %, före stoppet, och en rörelse till stoppet tog då hela marginalen plus 1,12 $ i öppningsavgift: 14,73 $ i stället för 10 $. I första körningens affärer hade 136 storlek efter stoppet fast likvidationen låg mindre än 1 % av priset bortom det; av de 80 som slutade i stopp eller likvidation likviderades 64. Med likvidationen mer än 1 % bortom stoppet likviderades 182 av 19 376. Nu räknas stoppet som först bara när likvidationen ligger mer än 1 % av ingångspriset bortom det; annars räknas förlusten som marginalen plus öppningsavgiften. Den procenten täcker Bybits vanliga funding (0,01 % per 8 timmar) under den längsta hålltiden, 20 dygn på dygnscandles. Förlusten vid stoppet, eller vid en likvidation före det, är därmed högst risken per affär.

Allt räknades om 2026-10-05 med samma data och samma protokoll. `forecast-account.js` och `forecast-market.js` har fler ändringar sedan första körningen, men de gäller demokontots skydd av öppna positioner i webbläsaren, som backtesten inte använder; för forskningen är storleksregeln den enda ändringen. **Inga slutsatser ändrades:** ingen kandidat blev behörig, ingen valdes, valideringen godkändes inte och prognosmåtten är identiska, eftersom storleken inte påverkar dem. Med referensstorleken (10×) gäller rättelsen bara affärer vars stopp låg bortom, vid eller mindre än 1 % före likvidationsnivån, och genom kapitalet affärerna efter dem: kandidaternas netto flyttade sig högst 0,15 procentenheter på utvecklingsperioden och 0,01 på valideringsåret, där standardinställningen `b20-s1.5-t2` gav exakt samma resultat. Kontots standard ändrades mer: 83 av 95 affärer likviderades i stället för 83 av 99, nettot blev −99,91 % i stället för −99,94 % och kapitalet var under 1 $ efter 22 dagar i stället för 20. Med stressad slippage likviderades 79 av 89 affärer i stället för 72 av 82, och nettot blev −99,92 % i stället för −99,94 %.

## Data

Bybit USDT-perpetuals (`category=linear`), timcandles från 2022-01-01 00:00 UTC (PEPE från Bybits första timcandle för kontraktet, 2023-05-03 11:00) till 2026-10-01 00:00 UTC (slut exklusivt), hämtade 2026-10-04 med sidans egna tolkare i `forecast-market.js`. Priser per token (SHIB och PEPE delade med 1 000) och volym som omsättning i USDT. Fundinghistoriken går till och med 2026-10-01 00:00, så att en position som är öppen vid periodslut betalar den sista fundingen likadant i båda perioderna. Bybits hävstångs- och risknivåer hämtades en gång (2026-10-04 19:34 UTC) och används för hela historiken.

| Coin | Kontrakt | Första timme | Timcandles | Fyllda timmar | Candles med noll volym | Fundingposter | Maxhävstång idag |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| BTC | `BTCUSDT` | 2022-01-01 00:00 | 41 616 | 0 | 0 | 5 203 | 150× |
| ETH | `ETHUSDT` | 2022-01-01 00:00 | 41 616 | 0 | 0 | 5 203 | 150× |
| SOL | `SOLUSDT` | 2022-01-01 00:00 | 41 616 | 0 | 0 | 5 563 | 100× |
| XRP | `XRPUSDT` | 2022-01-01 00:00 | 41 616 | 0 | 0 | 5 203 | 100× |
| DOGE | `DOGEUSDT` | 2022-01-01 00:00 | 41 616 | 0 | 0 | 5 203 | 75× |
| SHIB | `SHIB1000USDT` | 2022-01-01 00:00 | 41 616 | 0 | 0 | 5 203 | 50× |
| PEPE | `1000PEPEUSDT` | 2023-05-03 11:00 | 29 917 | 0 | 0 | 3 741 | 50× |

Bybit saknade ingen timme för något coin, så protokollets platta utfyllnad behövde aldrig användas, och ingen candle hade noll volym. Alla fundingtidpunkter låg på hela timmar med högst 8 timmar emellan, så med timcandles dras funding exakt vid sin tidpunkt.

## Utveckling: 2022-01-01 till 2025-10-01

Referensstorlek: 1 % av kapitalet i förlust vid stopp (avgifter och slippage inräknade), marginal högst 25 % av kapitalet, 10× hävstång (Bybits gräns var högre för alla coin) och högst 3 positioner, en per coin. Storleken räknas med demokontots egen regel, som lägger avgift och 0,05 % slippage för båda sidor ovanpå ingångens redan försämrade pris; förlusten vid ett stopp blir därför något under 1 % av kapitalet vid normal kostnad och omkring 1 % vid stressad slippage, där samma storleksregel möter sämre fyllningar. Ligger likvidationsnivån före stoppet, eller mindre än 1 % av priset bortom det, räknas förlusten som hela marginalen plus öppningsavgiften, och den blir då precis 1 %. Varje körning startar med 100 $, så netto i procent är också netto i dollar. Max nedgång räknas på kapitalet med öppna positioner värderade till stängningen, Sharpe på dagliga avkastningar × √365. Avgifter och funding i dollar; funding är kostnad (+) eller intäkt (−). Utvecklingskörningarna fick ingen candle från valideringsåret.

### Normal kostnad: avgift 0,055 % och slippage 0,05 % per sida

| Kandidat | Affärer | Vinstandel | Netto | Vinstfaktor | Max nedgång | Sharpe | Avgifter | Funding | Likvidationer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `b20-s1.5-t2` | 2 333 | 36,5 % | −89,0 % | 0,86 | 91,0 % | −1,41 | 62,91 $ | +0,27 $ | 13 |
| `b20-s1.5-t3` | 2 222 | 33,9 % | −73,5 % | 0,91 | 80,3 % | −0,64 | 78,82 $ | +1,03 $ | 12 |
| `b20-s2.5-t2` | 2 055 | 41,0 % | −68,5 % | 0,88 | 73,6 % | −0,81 | 48,60 $ | +1,05 $ | 30 |
| `b20-s2.5-t3` | 2 011 | 40,1 % | −54,3 % | 0,91 | 63,8 % | −0,45 | 51,22 $ | +1,43 $ | 30 |
| `b40-s1.5-t2` | 2 039 | 36,6 % | −84,6 % | 0,87 | 87,3 % | −1,25 | 65,98 $ | +0,41 $ | 13 |
| `b40-s1.5-t3` | 1 953 | 33,8 % | −69,1 % | 0,91 | 77,1 % | −0,60 | 74,23 $ | +1,06 $ | 13 |
| `b40-s2.5-t2` | 1 818 | 40,9 % | −64,9 % | 0,88 | 69,4 % | −0,77 | 43,57 $ | +1,11 $ | 31 |
| `b40-s2.5-t3` | 1 779 | 40,2 % | −43,3 % | 0,93 | 56,4 % | −0,31 | 49,87 $ | +1,70 $ | 31 |

### Stressad slippage: 0,10 % per sida

| Kandidat | Affärer | Vinstandel | Netto | Vinstfaktor | Max nedgång | Sharpe | Avgifter | Funding | Likvidationer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `b20-s1.5-t2` | 2 333 | 36,0 % | −96,6 % | 0,79 | 97,1 % | −2,34 | 43,70 $ | +0,01 $ | 14 |
| `b20-s1.5-t3` | 2 222 | 33,3 % | −91,5 % | 0,84 | 93,3 % | −1,41 | 51,93 $ | +0,37 $ | 13 |
| `b20-s2.5-t2` | 2 055 | 40,0 % | −84,1 % | 0,82 | 86,2 % | −1,41 | 36,95 $ | +0,63 $ | 30 |
| `b20-s2.5-t3` | 2 011 | 39,1 % | −76,7 % | 0,85 | 79,7 % | −1,01 | 38,40 $ | +0,87 $ | 30 |
| `b40-s1.5-t2` | 2 039 | 36,0 % | −94,4 % | 0,81 | 95,1 % | −2,09 | 46,65 $ | +0,09 $ | 14 |
| `b40-s1.5-t3` | 1 953 | 33,2 % | −88,5 % | 0,84 | 90,8 % | −1,31 | 51,07 $ | +0,45 $ | 14 |
| `b40-s2.5-t2` | 1 818 | 39,8 % | −80,7 % | 0,82 | 82,6 % | −1,32 | 33,98 $ | +0,72 $ | 31 |
| `b40-s2.5-t3` | 1 779 | 39,1 % | −68,7 % | 0,86 | 72,8 % | −0,82 | 38,24 $ | +1,11 $ | 31 |

Behörighet kräver minst 150 affärer och positivt netto vid både normal och stressad slippage. Alla kandidater hade minst 1 779 affärer, men ingen hade positivt netto vid någon av kostnaderna. **Ingen kandidat valdes**, så urvalsregeln (högst Sharpe) behövde aldrig användas.

Likvidationer med 10×: likvidationsnivån ligger då i median 9,4 % från ingången. På volatila coin låg ett stopp på 2,5 × ATR ibland ännu längre bort, och då kommer likvidationen alltid först: 13 av 30–31 likvidationer för de kandidaterna, mot 1 av 12–13 med 1,5 × ATR. I övriga fall passerade priset både stoppet och likvidationsnivån inom samma timme, och protokollet prövar likvidation först. En likvidation tar hela positionens marginal i stället för förlusten vid stoppet.

## Validering: 2025-10-01 till 2026-10-01

Eftersom ingen kandidat valdes finns det inget att godkänna. Tabellerna beskriver standardinställningen `b20-s1.5-t2`, som behålls, med referensstorlek: en sammanhängande körning från 100 $ utan positioner från utvecklingen, redovisad per kalenderkvartal. En affär räknas i kvartalet den öppnades; nedgång och Sharpe kommer från kapitalkurvan inom kvartalet och netto i procent är av kvartalets startkapital. Godkännandekravet hade inte heller uppfyllts: netto −35,2 % och vinstfaktor 0,85 vid normal kostnad, −54,6 % och 0,75 vid stressad.

### Normal kostnad

| Kvartal | Affärer | Vinstandel | Netto | Netto av startkapital | Vinstfaktor | Max nedgång | Sharpe | Kapital vid start | Kapital vid slut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| okt–dec 2025 | 162 | 29,6 % | −37,33 $ | −37,3 % | 0,57 | 41,3 % | −5,29 | 100,00 $ | 62,67 $ |
| jan–mar 2026 | 132 | 52,3 % | +23,06 $ | +36,8 % | 1,50 | 11,5 % | 3,13 | 62,67 $ | 85,73 $ |
| apr–jun 2026 | 149 | 32,2 % | −25,08 $ | −29,3 % | 0,58 | 36,6 % | −4,14 | 85,73 $ | 60,66 $ |
| jul–sep 2026 | 152 | 44,7 % | +4,19 $ | +6,9 % | 1,09 | 14,9 % | 0,90 | 60,66 $ | 64,85 $ |
| **Hela året** | 595 | 39,2 % | −35,15 $ | −35,2 % | 0,85 | 49,0 % | −0,98 | 100,00 $ | 64,85 $ |

### Stressad slippage

| Kvartal | Affärer | Vinstandel | Netto | Netto av startkapital | Vinstfaktor | Max nedgång | Sharpe | Kapital vid start | Kapital vid slut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| okt–dec 2025 | 162 | 29,0 % | −41,83 $ | −41,8 % | 0,52 | 45,1 % | −6,24 | 100,00 $ | 58,17 $ |
| jan–mar 2026 | 132 | 52,3 % | +14,63 $ | +25,2 % | 1,35 | 11,8 % | 2,39 | 58,17 $ | 72,80 $ |
| apr–jun 2026 | 149 | 31,5 % | −25,67 $ | −35,3 % | 0,50 | 40,5 % | −5,39 | 72,80 $ | 47,12 $ |
| jul–sep 2026 | 152 | 42,1 % | −1,72 $ | −3,6 % | 0,95 | 18,9 % | −0,25 | 47,12 $ | 45,41 $ |
| **Hela året** | 595 | 38,2 % | −54,59 $ | −54,6 % | 0,75 | 61,2 % | −2,02 | 100,00 $ | 45,41 $ |

Två av fyra kvartal var lönsamma vid normal kostnad (jan–mar 2026 och jul–sep 2026), men förlusterna i de andra var större. Ingen av affärerna likviderades.

### Per coin (normal kostnad)

Bidrag till samma konto på 100 $. Kursändringen är priset från första timmens öppning till sista stängningen, utan avgifter och funding.

| Coin | Affärer | Vinstandel | Netto | Vinstfaktor | Avgifter | Funding | Kursändring |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BTC | 113 | 35,4 % | −14,85 $ | 0,66 | 7,56 $ | +0,02 $ | −27 % |
| ETH | 74 | 37,8 % | −5,57 $ | 0,82 | 3,83 $ | +0,11 $ | −35 % |
| SOL | 95 | 43,2 % | +0,01 $ | 1,00 | 4,41 $ | +0,23 $ | −43 % |
| XRP | 101 | 35,6 % | −10,42 $ | 0,76 | 5,08 $ | +0,12 $ | −48 % |
| DOGE | 72 | 45,8 % | +0,06 $ | 1,00 | 3,17 $ | +0,11 $ | −59 % |
| SHIB | 75 | 38,7 % | −2,39 $ | 0,92 | 3,41 $ | +0,23 $ | −51 % |
| PEPE | 65 | 40,0 % | −2,00 $ | 0,92 | 2,35 $ | +0,12 $ | −54 % |

Alla sju coin föll under valideringsåret (−59 % till −27 %). Reglerna handlar både långt och kort, men inget coin gav mer än +0,06 $ (DOGE).

### Alla kandidater på valideringsåret

Räknade efter låset, bara för öppenhet; de påverkar inget val.

| Kandidat | Affärer | Netto | Vinstfaktor | Max nedgång | Sharpe | Netto, stress | Vinstfaktor, stress |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`b20-s1.5-t2`** | 595 | −35,2 % | 0,85 | 49,0 % | −0,98 | −54,6 % | 0,75 |
| `b20-s1.5-t3` | 562 | −26,6 % | 0,89 | 47,6 % | −0,46 | −47,7 % | 0,79 |
| `b20-s2.5-t2` | 523 | −7,1 % | 0,96 | 36,1 % | −0,04 | −25,1 % | 0,87 |
| `b20-s2.5-t3` | 509 | −4,5 % | 0,98 | 39,6 % | 0,05 | −22,7 % | 0,88 |
| `b40-s1.5-t2` | 522 | −22,3 % | 0,90 | 44,7 % | −0,53 | −43,0 % | 0,79 |
| `b40-s1.5-t3` | 498 | −10,7 % | 0,96 | 41,0 % | −0,05 | −33,8 % | 0,85 |
| `b40-s2.5-t2` | 469 | +1,2 % | 1,01 | 32,4 % | 0,20 | −16,4 % | 0,91 |
| `b40-s2.5-t3` | 456 | +2,4 % | 1,01 | 33,8 % | 0,24 | −15,0 % | 0,92 |

`b40-s2.5-t2` och `b40-s2.5-t3` var svagt positiva vid normal kostnad (+1,2 % och +2,4 %) men förlorade vid stressad slippage. Ingen kandidat hade positivt netto vid stressad slippage på valideringsåret heller.

## Samma år med kontots standard

Beskrivande, påverkar inget val. Demokontot startar med Bybits maxhävstång för coinet och storleken, marginal högst 25 % av kapitalet, risk 10 % per affär och högst 3 positioner. Här samma regler (`b20-s1.5-t2`), samma år och samma kostnader, en sammanhängande körning från 100 $.

| Kostnad | Affärer | Vinstandel | Netto | Vinstfaktor | Max nedgång | Likvidationer | Snitthävstång | Kapital vid slut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Normal | 95 | 12,6 % | −99,91 % | 0,33 | 99,93 % | 83 | 101× | 0,09 $ |
| Stressad slippage | 89 | 11,2 % | −99,92 % | 0,31 | 99,93 % | 79 | 99× | 0,08 $ |

| Kvartal (normal) | Affärer | Likvidationer | Kapital vid start | Kapital vid slut |
| --- | ---: | ---: | ---: | ---: |
| okt–dec 2025 | 95 | 83 | 100,00 $ | 0,09 $ |
| jan–mar 2026 | 0 | 0 | 0,09 $ | 0,09 $ |
| apr–jun 2026 | 0 | 0 | 0,09 $ | 0,09 $ |
| jul–sep 2026 | 0 | 0 | 0,09 $ | 0,09 $ |

Med maxhävstång (i snitt 101×, upp till 150× för BTC och ETH) låg likvidationsnivån i median 0,45 % från ingångspriset (0,25–0,96 %), medan stoppet låg 1,67 % bort. En timcandle spände i median 0,79 % mellan högsta och lägsta på valideringsåret, och 82 % av timmarna spände mer än 0,45 %. Likvidationsnivån låg närmare än stoppet i 95 av 95 affärer, och ingen affär nådde stoppet: 83 likviderades, 10 nådde målet och 2 stängdes på tid. Marginalen var i median 9,5 % av kapitalet vid ingången (9,2–9,8 %). Med likvidationen före stoppet var marginalen högst 10 % / (1 + L × 0,055 %) av kapitalet, så att en likvidation tog högst 10 % med öppningsavgiften. Vid dygnets slut (UTC) var kapitalet under 50 $ den 2025-10-05, under 10 $ den 2025-10-09 och under 1 $ den 2025-10-22; därefter var 641 signaler för små för att handlas (marginal under 0,01 $). Med referensstorleken (10×, 1 % risk) förlorade samma regler 35,2 % på samma år, utan likvidationer.

## Prognosmodellen `af-forecast-v1`

Analogmodellen (k = 30 närmaste lägen, bibliotek 1 500 timmar, horisont upp till 20) fick i varje kvartal bara de 1 500 timmar som slutade före kvartalet, och analogernas utfall låg också före kvartalet. Prognoser gjordes var fjärde timme per coin: 15 330 prognospunkter, och ingen saknade tillräcklig historik. De sista punkterna före 2026-10-01 saknar utfall på längre horisonter och räknas inte.

Fel räknas i procent av priset vid prognosen. Skill = 1 − (medianbanans medelfel / medelfelet för ett oförändrat pris); positiv skill betyder att medianen slog ett oförändrat pris. Riktning räknas när medianen pekar upp eller ned, och en oförändrad verklig stängning räknas som fel. Scenariot är det ritade gråa förloppet (en enskild analog). Coinen vägs ihop med summor, så volatila coin väger mer.

| Horisont | Kvartal | Prognoser | Medianens fel | Oförändrat pris, fel | Skill | Rätt riktning | Inom 50 %-bandet | Inom 80 %-bandet | Scenariots fel |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | okt–dec 2025 | 3 864 | 1,28 % | 1,25 % | −2,3 % | 51,4 % | 50,3 % | 74,4 % | 1,34 % |
| 5 | jan–mar 2026 | 3 780 | 1,30 % | 1,25 % | −3,7 % | 48,2 % | 46,8 % | 73,7 % | 1,36 % |
| 5 | apr–jun 2026 | 3 822 | 0,96 % | 0,92 % | −3,8 % | 49,7 % | 50,7 % | 77,6 % | 1,03 % |
| 5 | jul–sep 2026 | 3 857 | 1,00 % | 0,97 % | −3,4 % | 50,1 % | 49,3 % | 75,6 % | 1,06 % |
| **5** | **Hela året** | 15 323 | 1,13 % | 1,10 % | **−3,3 %** | 49,9 % | 49,3 % | 75,3 % | 1,20 % |
| 10 | okt–dec 2025 | 3 864 | 1,89 % | 1,83 % | −3,3 % | 52,0 % | 50,7 % | 74,0 % | 1,95 % |
| 10 | jan–mar 2026 | 3 780 | 1,91 % | 1,85 % | −3,6 % | 50,0 % | 49,4 % | 75,6 % | 1,94 % |
| 10 | apr–jun 2026 | 3 822 | 1,39 % | 1,32 % | −4,8 % | 50,3 % | 54,9 % | 80,4 % | 1,42 % |
| 10 | jul–sep 2026 | 3 850 | 1,45 % | 1,38 % | −4,9 % | 50,9 % | 52,4 % | 75,7 % | 1,48 % |
| **10** | **Hela året** | 15 316 | 1,66 % | 1,59 % | **−4,0 %** | 50,8 % | 51,8 % | 76,4 % | 1,70 % |
| 20 | okt–dec 2025 | 3 864 | 2,78 % | 2,61 % | −6,4 % | 49,5 % | 52,9 % | 76,1 % | 2,84 % |
| 20 | jan–mar 2026 | 3 780 | 2,77 % | 2,68 % | −3,6 % | 52,4 % | 52,4 % | 74,9 % | 2,83 % |
| 20 | apr–jun 2026 | 3 822 | 1,94 % | 1,79 % | −8,5 % | 50,8 % | 60,9 % | 84,3 % | 2,03 % |
| 20 | jul–sep 2026 | 3 829 | 2,21 % | 2,04 % | −8,4 % | 48,5 % | 52,6 % | 75,3 % | 2,27 % |
| **20** | **Hela året** | 15 295 | 2,43 % | 2,28 % | **−6,4 %** | 50,3 % | 54,7 % | 77,6 % | 2,49 % |

Skill var negativ i alla fyra kvartal, på alla tre horisonterna och för vart och ett av de sju coinen (tabellen nedan): medianbanan missade mer än ett oförändrat pris. Andelen rätt riktning låg mellan 48,2 % och 52,4 % per kvartal och horisont och mellan 47,8 % och 52,8 % per coin och horisont, alltså på slumpens nivå. Scenariot hade större fel än medianen i varje kvartal, för varje coin och över året. Banden var ungefär kalibrerade: över året innehöll 50 %-bandet 49–55 % och 80 %-bandet 75–78 % av de verkliga stängningarna. **Modellen redovisas därför som en ren osäkerhetsillustration**, inte som en prognos med träffsäkerhet.

| Coin | Skill 5 | Skill 10 | Skill 20 | Rätt riktning (20) | Inom 80 % (20) |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTC | −2,7 % | −4,0 % | −6,7 % | 48,1 % | 74,6 % |
| ETH | −2,0 % | −4,3 % | −7,6 % | 49,6 % | 76,8 % |
| SOL | −2,5 % | −3,5 % | −8,0 % | 49,0 % | 78,4 % |
| XRP | −2,5 % | −3,9 % | −5,2 % | 52,3 % | 78,5 % |
| DOGE | −4,6 % | −4,2 % | −8,4 % | 49,5 % | 78,4 % |
| SHIB | −3,5 % | −3,5 % | −5,4 % | 52,8 % | 79,0 % |
| PEPE | −4,4 % | −4,6 % | −4,5 % | 50,9 % | 77,8 % |

Kontroll: motorns egen `walkForward` delar året i fyra lika långa fönster på 2 190 timmar i stället för kalenderkvartal. Den ger samma handel för året och skill −3,2 %, −4,2 % och −6,2 %.

## Beskrivande tillägg efter resultaten: före och efter kostnader

Räknat efter resultaten för att förstå förlusterna; det används inte för något val. R är en affärs resultat i enheter av det planerade stoppavståndet (från ingångscandlens öppning till stoppet). Före kostnader är prisrörelsen från öppningen till utgångsnivån utan slippage; efter kostnader är affärens nettoresultat med avgifter, slippage och funding. Normal kostnad, referensstorlek.

| Kandidat | Snittstopp utv. | Utv. före kostnader | Utv. efter kostnader | Snittstopp val. | Val. före kostnader | Val. efter kostnader |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `b20-s1.5-t2` | 1,92 % | 0,041 R | −0,098 R | 1,46 % | 0,093 R | −0,080 R |
| `b20-s1.5-t3` | 1,91 % | 0,089 R | −0,052 R | 1,46 % | 0,123 R | −0,050 R |
| `b20-s2.5-t2` | 3,18 % | 0,034 R | −0,052 R | 2,41 % | 0,101 R | −0,004 R |
| `b20-s2.5-t3` | 3,18 % | 0,056 R | −0,030 R | 2,41 % | 0,111 R | 0,005 R |
| `b40-s1.5-t2` | 1,94 % | 0,044 R | −0,095 R | 1,46 % | 0,115 R | −0,055 R |
| `b40-s1.5-t3` | 1,93 % | 0,088 R | −0,052 R | 1,47 % | 0,155 R | −0,016 R |
| `b40-s2.5-t2` | 3,22 % | 0,033 R | −0,053 R | 2,42 % | 0,119 R | 0,015 R |
| `b40-s2.5-t3` | 3,21 % | 0,064 R | −0,022 R | 2,43 % | 0,123 R | 0,019 R |

Före kostnader var genomsnittsaffären svagt positiv för varje kandidat (0,033 till 0,155 R per affär). En rundtur kostar 0,21 % av priset (avgift och slippage på båda sidor), vilket är 0,07–0,14 R med stopp 1,5–3,2 % bort. Kostnaderna var större än det genomsnittet för alla åtta kandidater på utvecklingsperioden och för fem av åtta på valideringsåret, och med omkring 622 affärer per år (`b20-s1.5-t2`) blir det stora förluster. Längre utbrottsfönster, bredare stopp och mål längre bort minskade förlusten på utvecklingsperioden i varje jämförbart par, men vände den inte.

## Slutsats

- **Signalreglerna har ingen visad fördel efter kostnader.** Ingen kandidat klarade utvecklingskravet, och på valideringsåret hade ingen positivt netto vid stressad slippage. Före kostnader var genomsnittsaffären svagt positiv, men timhandel med stopp 1,5–3,2 % bort betalar mer i avgifter och slippage än så. Signalerna kan fortfarande visas och förklaras i grafen, men de är inte en lönsam strategi enligt detta test.
- **Inga parametrar ändras.** `SIGNAL_PARAMS` behåller standardinställningen `b20-s1.5-t2` (utbrott 20 candles, stopp 1,5 × ATR, mål 2 × stoppavståndet), och strategin är ej validerad.
- **Kontots standardinställning tömde kontot på dessa regler.** Med Bybits maxhävstång låg likvidationen närmare än stoppet i 95 av 95 affärer; 83 likviderades och kapitalet gick från 100 $ till under 1 $ på 22 dagar. Samma regler med 10× och 1 % risk förlorade 35,2 % på samma år. Det är skillnaden mellan en förlorande strategi och ett tömt konto.
- **Prognosen visar spridningen, inte riktningen.** Medianbanan var sämre än ett oförändrat pris på alla horisonter och riktningen träffade som slumpen. Bandet är ungefär rätt brett och är den användbara delen: det visar hur mycket priset brukar röra sig, inte vart det går.

## Begränsningar

- **Retrospektivt.** Valideringsåret har delvis setts i projektets tidigare forskning om andra strategier, och de sju coinen är dagens noterade kontrakt, valda i efterhand.
- **Bybits nuvarande hävstångs- och risknivåer** används för hela historiken; historiska nivåer är inte publicerade. Med referensstorleken begränsade de aldrig hävstången (alla affärer fick 10×), men dagens underhållsmarginal bestämmer var likvidationen ligger. Med kontots standard avgör nivåerna dessutom hävstången.
- **Likvidation** prövas mot candlens sämsta pris i senaste handel, vilket är strängare än Bybits markpris; historiska markpriser användes inte. Med maxhävstång låg likvidationsnivån i median 0,45 % från ingången, medan en timcandle i median spände 0,79 % mellan högsta och lägsta.
- **Timupplösning.** Beslut, fyllning, stopp och mål prövas på timcandles. En candle som når både stopp och mål räknas som stopp. Ingen orderbok, minsta orderstorlek eller orderavrundning.
- **Väntetid.** De 5 candlerna räknas, som i motorn, från varje candle där alla villkor uppfylldes åt samma håll, även en candle som själv låg i väntetid. En utdragen trend ger därför något färre nya signaler än om bara utlösta signaler räknades.
- **Funding** dras exakt vid sina tidpunkter men var liten (under 2 $ per kandidat på utvecklingsperioden), eftersom affärerna var korta och både långa och korta. Kostnaderna kommer nästan helt från avgifter och slippage.
- **Kalenderkvartal.** Protokollets fyra kvartal räknades som kalenderkvartal ur den sammanhängande körningen med motorns `metricsOf` och `forecastErrors`; motorns `walkForward` använder fyra lika långa fönster. Handeln för året är densamma och prognosmåtten skiljer sig obetydligt (se kontrollen ovan).

## Reproduktion

Kör `node research/ai-forecast-data.mjs --download`, `node research/ai-forecast-run.mjs` och `node research/ai-forecast-report.mjs`. Rådata, Bybits gränser, urvalslåset, sammanfattningen (`results.json`) och varje affär och signalbeslut (`runs.json`) sparas lokalt i `.matning/ai-forecast/`, som git ignorerar. Körskriptet kontrollerar att utvecklingsresultatet för `b20-s1.5-t2` blir identiskt när valideringsårets data finns med (inget framtidsläckage) och att kvartalen summerar till året. En andra körning gav identiska resultat. Hasharna räknas på filernas text med LF-radslut, så en Windows-utcheckning med CRLF ger samma värden.

| Fil | SHA-256 |
| --- | --- |
| Protokoll (`ai-forecast-protocol.md`) | 73edd23f4003f5c51b8c97f7e848df31179f49ba8625cc1795676bbc5648d69f |
| Körskript (`ai-forecast-run.mjs`) | 7dd9cd440b938e0d61f5fcae897de39936b37ba76229573c041e5d49dc192ff9 |
| `forecast-config.js` | 3b5bfcd1d1d7d4d0777d491d9ca4531a1b47edf821df7032fdcc9b74a91b2cb4 |
| `forecast-model.js` | 09c44b2b41e57e334a2555de9e10ce299a0e5a687944fbe49588c4e01d416d62 |
| `forecast-account.js` | dfce8bcc260b5a4753c24c35a0378e3735bb5263de2052711b86405ded23bf73 |
| `forecast-backtest.js` | 4c01a661ed16a3ba16eebd04830ffaf8b4284d0631773a8a7702b2669ef77f67 |
| `forecast-market.js` | 7f2fef17f1a4e47416aeb2bf61f6b7ce82f68d3ae588668f606e6473fe1d8897 |
| `bybit-contracts.js` | 867c8c788f046ea62cb39d9fcd2c1e89fcdae2e460ac3f7ea7f20b6cb2478fac |
| Bybit BTC (`bybit-BTC.json`) | 7b3cc96e51cb3feb00523b627994008e1e68c8a99b035880b2994b76e728e666 |
| Bybit ETH (`bybit-ETH.json`) | 8b9fd4a3184e8870ee7b25bf8412e2a168e2e72324010eea6a62f68e6434bfbd |
| Bybit SOL (`bybit-SOL.json`) | 323b841bb588050f1e1820827aca99b2360acab53cd76abc6c61214122b0c1b0 |
| Bybit XRP (`bybit-XRP.json`) | fcd5cca0519ec127c4dcca6b4c50a9d78919d756cab7c63f0d39ee7429f3224a |
| Bybit DOGE (`bybit-DOGE.json`) | 78ca4cbcdc2a80d4e328a5dc0b74f4787b4f088bc755af9411597bb6e52d6945 |
| Bybit SHIB (`bybit-SHIB.json`) | 146e7bbd933822c3157f6def4a3ddce629e1f535965c5429e7a74fc1e79a096d |
| Bybit PEPE (`bybit-PEPE.json`) | 988e6fb00e4a6aa7d188083d3fba2ab17a9e932f0eb9638bb1fc7f3f3f38620f |
| Bybits gränser (`contracts.json`) | e5305b13075d21a4eb38162c65b0b9b70f387fdbc408f5adb49c843086a42bcf |

Källor: [Bybit kline](https://bybit-exchange.github.io/docs/v5/market/kline), [Bybit funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate), [Bybit risknivåer](https://bybit-exchange.github.io/docs/v5/market/risk-limit), [Bybit instrument](https://bybit-exchange.github.io/docs/v5/market/instrument). ADX och ATR enligt J. Welles Wilder, *New Concepts in Technical Trading Systems* (1978).
