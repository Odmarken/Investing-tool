# Fryst protokoll: AI Forecast — signalregler, prognosmodell och demokonto

Fryst 2026-10-04 före första resultaträkning. Ingen data för detta protokoll är hämtad och inga resultat är beräknade eller lästa.

## Syfte och evidensgräns

AI Forecast består av två separata delar som utvärderas var för sig:

1. **Signalreglerna `af-signal-v1`**: trendföljande utbrott på stängda candles som kräver trend (EMA20/EMA50, EMA50:s lutning, ADX), samma riktning på högre tidsram (bara stängda candles), momentum (RSI, ROC), volym (relativ volym) och normal volatilitet (ATR-percentil). Sidledes marknad ger ingen signal. Stopp och mål sätts med ATR.
2. **Prognosmodellen `af-forecast-v1`**: en statistisk analogmodell (k närmaste grannar). Den letar upp de 30 historiska lägen som mest liknar det senaste (avkastningsmönster, avstånd till EMA20, RSI och volatilitetsnivå, allt mätt i ATR) bland de 1 500 candles som föregår prognosen, och ritar ett av deras faktiska förlopp, skalat till dagens pris och volatilitet, med ett osäkerhetsband av alla 30. Det är ingen språkmodell eller neuralt nät, och den används inte av signalreglerna.

Idéerna är standardmetoder (Donchian-utbrott med trend- och volymfilter, ADX enligt Wilder, analogprognoser/k-NN). Parametrarna nedan bestämdes före datan. Valideringsperioden okt 2025–sep 2026 har inte använts för något val i detta protokoll, men delar av den har setts i projektets tidigare forskning om andra strategier. Valideringen är därför retrospektiv, inte ett orört framtidstest. Inga regler läggs till eller ändras efter att resultat har räknats.

## Data

- Bybit USDT-perpetuals (`category=linear`), timcandles och fundinghistorik: BTC, ETH, SOL, XRP, DOGE, SHIB (SHIB1000USDT) och PEPE (1000PEPEUSDT), priser normaliserade till en token. Från 2022-01-01 00:00 UTC eller noteringen om den är senare, till 2026-10-01 00:00 UTC (slut exklusivt).
- Volym = omsättning i USDT. Saknade timmar fylls med en platt candle på föregående stängning och noll volym och redovisas per coin.
- Bybits hävstångs- och risknivåer hämtas en gång vid körningen och används för hela historiken (historiska nivåer finns inte publicerade).
- Rådatahashar och fullständiga resultat sparas lokalt i `.matning/ai-forecast/`.

## Perioder

- Uppvärmning: historik före periodstart får användas till indikatorer och prognosbibliotek, aldrig till affärer.
- **Utveckling och urval: 2022-01-01 till 2025-10-01.**
- **Validering: 2025-10-01 till 2026-10-01**, redovisad i fyra kvartal (walk-forward-fönster) och sammantaget.
- Varje period startar om med 100 $ och inga positioner.

## Utförande och kostnader

- Beslut när en timcandle stängt. Order fylls på nästa candles öppning med slippage, aldrig på signalcandlen.
- Avgift 0,055 % per sida. Slippage 0,05 % per sida; stress 0,10 % per sida.
- Stopp och mål prövas på timcandlens högsta och lägsta från candlen efter signalen. Likvidation prövas först, sedan stopp, sedan mål. Öppnar candlen bortom stoppet fylls stoppet på öppningen.
- Likvidation (isolerad marginal, Bybits nivå för positionens storlek) prövas på candlens ogynnsammaste pris, vilket är strängare än Bybits markpris. Vid likvidation förloras positionens marginal.
- Funding vid varje publicerad tidpunkt på positionens antal × candlens öppningspris; lång betalar positiv funding, kort får den.
- Tidsstopp efter 20 candles. Motsatt signal stänger på nästa öppning. Högst 3 öppna positioner, högst en per coin, coinen prövas i ordningen BTC, ETH, SOL, XRP, DOGE, SHIB, PEPE.
- Positioner som är öppna vid periodslut stängs på sista stängningen med avgift och slippage.

## Storlek

- **Referensstorlek (används för urval och godkännande):** 1 % av kapitalet i förlust vid stopp (avgifter och slippage inräknade), marginal högst 25 % av kapitalet, hävstång 10× (lägre om Bybits gräns är lägre).
- **Kontots standard (beskrivande, påverkar inget val):** marginal högst 25 % av kapitalet, risk 10 % per affär, högst 3 positioner, Bybits maxhävstång för coinet och storleken, precis som demokontot startar.

## Kandidater

Fasta i alla kandidater: EMA 20/50 (fönster 4 × period), EMA50-lutning över 10 candles, ADX(14) ≥ 22 för trend och < 18 för sidledes, RSI(14) 50–75 för köp och 25–50 för sälj, ROC(10) åt samma håll, relativ volym ≥ 1,1 × medianen av de 20 föregående, ATR-percentil 10–95 över 200 candles, högre tidsram 4h (EMA20 över 60 stängda 4h-candles, stängning och lutning åt samma håll), 5 candles väntetid efter en signal åt samma håll.

| Kod | Utbrott (candles) | Stopp (× ATR) | Mål (× stoppavstånd) |
|---|---|---|---|
| `b20-s1.5-t2` | 20 | 1,5 | 2 |
| `b20-s1.5-t3` | 20 | 1,5 | 3 |
| `b20-s2.5-t2` | 20 | 2,5 | 2 |
| `b20-s2.5-t3` | 20 | 2,5 | 3 |
| `b40-s1.5-t2` | 40 | 1,5 | 2 |
| `b40-s1.5-t3` | 40 | 1,5 | 3 |
| `b40-s2.5-t2` | 40 | 2,5 | 2 |
| `b40-s2.5-t3` | 40 | 2,5 | 3 |

`b20-s1.5-t2` är standardinställningen som koden startade med.

## Urval och validering

Behörighet på utvecklingsperioden med referensstorlek: minst 150 affärer, positivt netto vid både normal och stressad slippage. Bland behöriga väljs högst Sharpe (dagliga avkastningar för kontots kapital, × √365) vid normal kostnad; lika värden avgörs av lägre maxnedgång. Om ingen är behörig väljs ingen: standardinställningen behålls och strategin redovisas som ej validerad.

Valideringen godkänns om den valda kandidaten har positivt netto och vinstfaktor över 1 vid både normal och stressad slippage med referensstorlek. Ett underkännande står kvar; ingen annan kandidat väljs efteråt. Alla kandidater redovisas för öppenhet.

## Prognosmodellen

Inga prognosparametrar väljs på datan: k = 30, bibliotek 1 500 candles, horisont upp till 20. I varje valideringskvartal tränas biblioteket bara på de 1 500 timmar som slutar före kvartalet (analogernas utfall måste också ligga före kvartalet). Prognoser görs var fjärde timme per coin. Mått per horisont 5, 10 och 20 candles: medelfel för medianbanans stängning mot verklig stängning (i % av priset vid prognosen) jämfört med en oförändrad-prognos (skill = 1 − modellfel/naivt fel), andel rätt riktning när medianen pekar upp eller ned, andel verkliga stängningar inom 50 %- och 80 %-bandet, samt scenariots (de ritade gråa candlernas) stängningsfel. Modellen godkänns som mer än dekoration bara om skill > 0 på alla tre horisonterna; annars redovisas den som en ren osäkerhetsillustration.

## Rapport

Per kandidat på utvecklingsperioden: affärer, vinstandel, netto, vinstfaktor, maxnedgång, Sharpe, avgifter och funding, normal och stressad kostnad. För den valda: valideringen per kvartal och sammantaget, per coin, och samma period med kontots standard (inklusive antal likvidationer). Prognosmåtten per horisont och kvartal.
