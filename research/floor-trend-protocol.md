# Fryst protokoll: trendstrategi för trading floor-borden

Fryst 2026-09-23 före första resultaträkning. Data är hämtad men inga strategiresultat har beräknats eller lästs.

## Syfte och evidensgräns

Borden kör i dag `pulse12`: timmomentum över 14/28/56 **timmar**, fast SL/TP och 12 timmars maxtid. Den profilen klarade inte utvecklingskraven i [det tidigare testet](crypto-momentum-active-results.md). Här jämförs några förbestämda trendregler på **dygns- och veckohorisont** med längre historik och fler marknadsfaser (tjurmarknad 2021, björnmarknad 2022, återhämtning 2023, 2024–2025 och 2026).

Idéerna kommer från publicerad forskning, inte från sökning i denna data: en ensemble av Donchian-kanaler med nio horisonter, efterföljande stopp vid kanalens mittpunkt och volatilitetsstyrd storlek ([Zarattini, Pagani & Barbon 2025](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907)), tidsseriemomentum ([Moskowitz, Ooi & Pedersen 2012](https://doi.org/10.1016/j.jfineco.2011.11.003)) och [kryptomomentum](https://www.nber.org/papers/w24877). Kombinationen 14/28/56 **dygn** var det mest lovande spåret i [de tidigare momentumändringarna](crypto-momentum-tweaks-results.md). Perioderna är historiska och delvis sedda i tidigare arbete i projektet; valideringen är därför retrospektiv, inte ett orört test. Inga regler läggs till eller ändras efter att resultat har räknats.

## Data

- Binance USDT-M perpetuals, timstaplar och fundinghistorik, från notering till 2026-09-23 00:00 UTC (slut exklusivt): BTC (2019-09), ETH (2019-11), XRP (2020-01), DOGE (2020-07), SOL (2020-09), 1000SHIB (2021-05, normaliserat till en token). Binance används för att få längre sammanhängande historik än Bybit.
- Bybits egna kontrakt för samma coins hämtas som kontroll av handelsplats; de används inte för urvalet.
- Staplar som saknas fylls med platt stapel på föregående stängning och redovisas. Signaler använder bara avslutade staplar.

## Perioder

- Uppvärmning: all historik före periodstart får användas till signaler, aldrig till affärer.
- **Utveckling och urval: 2021-06-01 till 2024-01-01.**
- **Validering: 2024-01-01 till 2026-09-23.** Redovisas även per kalenderår.
- Beskrivande tidig period: 2020-10-01 till 2021-06-01 (fem coins, SHIB saknas). Påverkar inget val.
- Varje period startar om: sex bord med 100 dollar var, inga positioner. Firmans kapital är summan av borden utan ombalansering mellan bord, som på storskärmen.

## Utförande och kostnader

- Beslut vid stängning av en timstapel (dygnsbeslut: 23:00-stapeln, dvs. dygnets UTC-stängning). Order fylls på nästa stapels öppning med slippage.
- Avgift 0,055 % per sida. Slippage 0,05 % per sida; stress 0,10 % per sida.
- Funding vid varje publicerad tidpunkt på den position som fanns före ordern i samma timme, med timmens öppningspris: lång betalar positiv funding, kort får den.
- Linjär perpetual-bokföring per bord: kontanter plus antal × pris. Likvidation om kapitalet vid stapelns ogynnsammaste pris (lägsta för lång, högsta för kort) understiger 1 % av positionens värde; då förloras hela bordets kapital och bordet slutar handla.
- Öppna positioner vid periodslut värderas med beräknad avgift och slippage för stängning.

## Storlek (gemensam för jämförelsen)

- Volatilitet σ: standardavvikelsen för de senaste 90 dagliga logavkastningarna (UTC-stängningar) × √365, räknad på avslutade dygn. Minst 30 dygnsavkastningar krävs innan bordet får handla.
- Målexponering = signal s ∈ [−1, 1] × min(Lmax, σ\*/σ), med σ\* = 25 % per år och Lmax = 1 i signaljämförelsen (publicerade inställningar).
- Ombalansering bara vid strategins beslutstider: alltid när signalen ändras, annars när |mål − nuvarande exponering| > 25 % av max(|mål|, |nuvarande|).

## Kandidater

Varje bord handlar bara sitt eget coin.

| Kod | Signal | Beslut | Riktning |
|---|---|---|---|
| `pulse12` | Nuvarande bordsregel via `activeSignal`, SL/TP/12 h/karens som live, 2 % risk vid SL, högst 3× exponering | Varje timme | Lång |
| `ens9-d-L` | Donchian-ensemble på dygnsstängningar, horisonter 5, 10, 20, 30, 60, 90, 150, 250, 360 dygn | Dygn | Lång |
| `ens9-d-LS` | Samma, symmetrisk kort sida | Dygn | Lång/kort |
| `ens9-h-L` | Samma horisonter i timmar (n × 24 timstängningar) | Varje timme | Lång |
| `ens9-h-LS` | Samma, symmetrisk kort sida | Varje timme | Lång/kort |
| `tsm3-w-L` | Lång om medel av 14-, 28- och 56-dygnsavkastning > 0 | Måndag 00 UTC | Lång |
| `tsm3-w-LS` | Tecknet på samma medelvärde | Måndag 00 UTC | Lång/kort |
| `ema3-d-LS` | Medel av tecknet på EMA(8)−EMA(32), EMA(16)−EMA(64), EMA(32)−EMA(128) på dygnsstängningar | Dygn | Lång/kort |

**Donchian-ensemblen**, per horisont n och beslutstid k (stängningar c): kanalen över de n föregående stängningarna har max U, min L. Utan position: lång om c\_k > U; kort (LS-varianter) om c\_k < L. Stoppet sätts till mittpunkten av de n senaste stängningarna inklusive c\_k. I lång position: först avslut om c\_k < föregående stopp, annars stopp = max(stopp, ny mittpunkt). Kort speglat. Ett avslut ger ingen ny inträdesprövning samma beslutstid. Signal s = (antal långa − antal korta horisonter) / 9.

`pulse12` är referens och kan inte väljas. Den använder projektets `activeSignal`, SL = inträdets öppningspris − stoppavståndet, TP = +2 × stoppavståndet, netto-R:R ≥ 1,5, högst ett halvt stoppavstånds avvikelse från signalpriset, SL före TP i samma stapel, gap fylls på sämre öppning, maxtid 12 timmar till första öppning efter gränsen och en timmes karens.

## Urval och validering

Behörighet på utvecklingsperioden: positivt nettoresultat vid normal och stressad slippage samt minst 20 avslutade rundturer (från ingen position till ingen position) i firman. Bland behöriga väljs högst Sharpe (dagliga avkastningar för firmans kapital, × √365) vid normal kostnad; lika värden avgörs av lägre maxnedgång. Om ingen är behörig väljs ingen.

Valideringen godkänns om den valda kandidaten har positivt netto och positiv Sharpe vid både normal och stressad slippage. Ett underkännande står kvar; ingen annan kandidat väljs efteråt. Alla kandidater redovisas för öppenhet.

## Risknivå för demot

Efter urvalet körs den valda kandidaten med σ\* = 25, 50, 75 och 100 % och Lmax = σ\*/25 %. Förvald nivå för demot: högst utvecklings-CAGR bland nivåer med utvecklingsnedgång ≤ 40 % och utan likvidation. Valideringsutfallet redovisas för alla nivåer men ändrar inte valet.

## Rapport

Firmans slutkapital, netto, CAGR, Sharpe, maxnedgång (timstängningar), rundturer, order, avgifter, nettofunding, genomsnittlig exponering, tid i marknad, andel kort, år för år, bidrag per coin och köp-och-behåll (1× lång perpetual med funding, samma sex bord) som referens. Känslighet för den valda kandidaten, endast beskrivande: Bybit-data, volatilitetsfönster 60/120 dygn, ombalanseringströskel 10/50 %, slippage 0,20 %. Rådatahashar och fullständiga resultat sparas lokalt i `.matning/floor-trend/`.
