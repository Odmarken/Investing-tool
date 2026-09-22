# Bedömning: nya kryptostrategier

Fyra frysta regelverk har byggts och testats. **Ingen kvalificerade sig som en robust lönsam kandidat.** Sidans strategi och konto har därför inte ändrats.

Testet använder BTC, ETH och SOL på Bybits USDT-perpetuals under 2025. Första halvåret användes för urval och andra för validering. Affärerna simuleras med avgifter, slippage och historisk funding. Beräknad risk inklusive stoppkostnad är 0,5 % av kontot per affär, exponeringen högst 2×.

| Strategi | Första halvåret | Andra halvåret | Affärer andra halvåret |
|---|---:|---:|---:|
| Trendutbrott med volymkrav och flyttad stopp | −0,84 % | +1,43 % | 87 |
| Rekyl i bekräftad trend | −4,88 % | −11,30 % | 113 |
| Återgång mot medelpris i sidledes marknad | −0,03 % | +0,26 % | 2 |
| Fast kombination för trend/sidledes marknad | −0,20 % | +1,13 % | 57 |

Trendutbrott och kombinationen gav positiva utfall under valideringen, men:

- Ingen valdes av de förutbestämda kraven på första halvåret.
- Vid dubblerad slippage blev valideringsavkastningen −0,01 % respektive −0,14 %.
- Endast ETH bidrog positivt i valideringen; BTC och SOL bidrog negativt. På utvecklingsdata var ETH i stället negativt, vilket talar emot att välja enbart ETH i efterhand.
- Utan de fem största vinnarna var realiserad P/L negativ.
- Osäkerhetsintervallen för netto-R omfattade noll.
- Varianten för sidledes marknad gav bara två affärer under respektive halvår, vilket är för lite underlag.

Detta är inte direkt jämförbart med tidigare −94,9 %: period, instrumenturval, signaler, kontraktsdata och riskstorlek skiljer sig. Lägre förlust eller nedgång bevisar inte bättre signaler när risken samtidigt sänkts.

## Vad arbetet faktiskt ger

En separat reproducerbar testmotor med kryptospecifika regler, stängda tim-/fyratimmarsstaplar, kostnadsmedvetet inträdesfilter, riskberäknad positionsstorlek, tidsutträden och stresstest. Den kan användas för fortsatt utveckling utan att skriva till användarens pågående positioner.

Nästa meningsfulla experiment behöver en ny motiverad hypotes och ny reserverad valideringsdata eller framåtriktad pappershandel. Att ändra parametrarna tills samma 2025-historik blir grön skulle inte ge oberoende belägg. Eventuell framtida aktivering bör tydligt märkas experimentell tills verkligt framåtriktad exekvering har utvärderats.

## Kontroller och begränsningar

25 automatiska tester passerade. Den nya testmotorn kontrolleras bland annat mot framtidsläckage, ofullständiga tidsstaplar, avgifter/funding för long och short, stopp/target-kollisioner, gap, karens och flyttad stopp. Alla 16 portföljhistoriker stämdes av mot affärernas kassaflöden och tidsordning. För få affärer ger inget redovisat bootstrapintervall.

Historiken är ny för detta experiment, men 2025-valideringen är retrospektiv eftersom idéerna skapades senare. Modellen saknar orderbok, ticksekvens, minsta orderstorlek och exakt markpris-/likvidationsmodell. Historisk simulerad vinst är inte bevis för framtida lönsamhet.

Se [fullständig rapport](crypto-v2-results.md) och [fryst protokoll](crypto-v2-protocol.md). Datakällor: [Bybit candles](https://bybit-exchange.github.io/docs/v5/market/kline) och [funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).
