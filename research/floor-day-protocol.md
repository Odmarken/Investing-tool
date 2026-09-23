# Fryst protokoll: dagshandel för trading floor-borden

Fryst 2026-09-23 före första resultaträkning. Data är hämtad men inga resultat för dessa regler har beräknats.

## Syfte och evidensgräns

Användaren vill ha en dagshandelsvariant av bordens trendstrategi: affärer på helst ett dygn, högst tre. Kandidaterna bygger på samma typ av regel som bordens [trendensemble](floor-trend-results.md): utbrott ur en priskanal och ett efterföljande stopp i kanalens mittpunkt, nu på timhorisont och med den stora trenden som filter. Dessutom ska den gamla hävstångsregeln köras med Bybits verkliga kontraktsgränser.

Korta horisonter misslyckades i projektets tidigare test ([`pulse12`](crypto-momentum-active-results.md) förlorade kraftigt efter kostnader). Det här testet kan mycket väl sluta utan någon godkänd regel. Perioderna är desamma som i trendtestet och därmed redan sedda i projektet; valideringen är retrospektiv. Inga regler ändras efter att resultat har räknats.

## Data och perioder

- Samma Binance USDT-M perpetual-data som [trendprotokollet](floor-trend-protocol.md): timstaplar och fundinghistorik för BTC, ETH, SOL, XRP, DOGE och 1000SHIB till 2026-09-23 00:00 UTC.
- **Utveckling och urval: 2021-06-01 till 2024-01-01. Validering: 2024-01-01 till 2026-09-23.** Sex bord med 100 dollar var, ny start i varje period.
- Bybits egna kontrakt används som kontroll för den valda kandidaten.
- Bybits offentliga kontraktsgränser och risknivåer hämtas 2026-09-23 för hävstångsscenariot. Det är dagens gränser på historiska priser, inte historiska gränser.

## Gemensamma regler

- **Trendfilter**: bordens nio horisonter (5–360 dygn) på timstängningar, exakt som i livemotorn. "Uppåt" betyder minst 5 av 9 horisonter på vid beslutets timstängning.
- **Kanal på N timmar**: tidigare högsta = högsta av de N föregående timstängningarna; mittpunkt = (högsta + lägsta) / 2 av de N timstängningarna till och med nu.
- Bara lång, högst en position per bord. Beslut vid timstängning; inträde på nästa timmes öppning med slippage.
- **Stopp** är en stopporder: om en timstapels lägsta når stoppet avslutas affären vid stoppet, vid gap under stoppet på öppningen. Stoppet flyttas bara uppåt, vid timstängningar enligt kandidatens regel. Stoppavståndet är minst 0,5 % av referenspriset (beslutets stängning).
- **Tidsgräns**: avslut på första timöppningen efter maxtiden.
- Avgift 0,055 % per sida, slippage 0,05 % per sida (stress 0,10 %), historisk funding på positionen vid varje publicerad tidpunkt.

## Kandidater

| Kod | Inträde | Stopp | Maxtid |
|---|---|---|---|
| `b24-f-72` | Timstängning över 24-timmarshögsta och trendfilter uppåt | 24-timmarskanalens mittpunkt, sedan max(stopp, ny mittpunkt) varje timme | 72 h |
| `b24-f-24` | Samma | Samma | 24 h |
| `b48-f-72` | Timstängning över 48-timmarshögsta och trendfilter uppåt | 48-timmarskanalens mittpunkt, stiger med den | 72 h |
| `b24-n-72` | Timstängning över 24-timmarshögsta, inget trendfilter | Som `b24-f-72` | 72 h |
| `vb-f-1d` | Volatilitetsutbrott: timstängning över dagens öppning + 0,5 × gårdagens spann (högsta − lägsta) och trendfilter uppåt; högst ett inträde per UTC-dygn, inte vid dygnets sista timstängning | Dagens öppning, fast | Till nästa UTC-dygns öppning |

Referenser som inte kan väljas: bordens nuvarande trendensemble (σ\* = 100 %, från trendtestet) och gamla `pulse12`.

## Storlek i urvalet

1 % av kapitalet i planerad förlust vid stoppet inklusive avgifter och slippage, högst 5× exponering, bordets hela kapital som marginal, likvidation vid 1 % underhållsmarginal.

## Urval och validering

Behörighet på utvecklingsperioden: positivt netto vid normal och stressad slippage, minst 200 avslutade affärer i firman och median hålltid ≤ 72 timmar. Bland behöriga väljs högst Sharpe (dagliga avkastningar för firmans kapital, × √365); lika värden avgörs av lägre maxnedgång. Valideringen godkänns om den valda kandidaten har positivt netto och positiv Sharpe vid både normal och stressad slippage. Ett underkännande står kvar. Bästa kandidat med maxtid ≤ 24 timmar redovisas också separat, eftersom användaren helst vill ha endagsaffärer.

## Gamla hävstångsregeln på Bybit (scenario, påverkar inget val)

Varje kandidat och `pulse12` körs också med de gamla bordens storleksfunktion `openActivePosition` oförändrad: högst 50 % av saldot som isolerad marginal inklusive köpavgift, högst 50 % planerad förlust vid stoppet, och högsta hävstång inom Bybits kontraktsgräns, hävstångssteg och risknivå där beräknad likvidation ligger minst 25 % av stoppavståndet under stoppet. Marginal, funding och likvidation följer `crypto-leverage.js` (isolerad marginal, underhållsmarginal enligt risknivån inklusive avdrag och stängningsavgift). Vid likvidation förloras positionens marginal; fria kontanter ligger kvar. Positionen stängs om likvidationspriset når stoppet. Kandidaterna saknar vinstmål, så funktionens vinstmål sätts utom räckhåll.

## Risknivåer (beskrivande)

Den valda kandidaten körs med 0,5, 1, 2, 3, 5 och 10 % risk per affär (högst 20× exponering) i båda perioderna.

## Rapport

Per kandidat och period: netto, CAGR, Sharpe, maxnedgång, avslutade affärer, vinstandel, genomsnittligt R, median och 90:e percentil av hålltid, avslut per orsak, avgifter, funding och tid i marknad. För hävstångsscenariot även hävstång (lägsta, median, högsta), median planerad risk och likvidationer. Jämförelse med bordens nuvarande trendensemble. Rådata, urvalslås och affärer sparas lokalt i `.matning/floor-day/`.
