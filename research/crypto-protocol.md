# Kryptotest: låst protokoll

Fastställt före hämtning och resultatanalys, 2026-09-10.

- Instrument: BTC, ETH, SOL, XRP, DOGE, SHIB, PEPE, samma sju som i sidan.
- Källa: Bybit spot, femminuters OHLCV, 2026-03-14–2026-09-10 UTC (slut exklusivt). Åtta dygn före start används endast för uppvärmning; 2 000 staplars indikatorfönster, som sidans två Bybit-anrop. Förtydligat vid kontroll av inläsningen, före någon resultaträkning.
- Utvecklingsperiod: 2026-03-14–2026-07-12. Orörd testperiod: 2026-07-12–2026-09-10. Konton börjar om vid delningen; endast indikatorhistorik får följa med.
- Inga parameterförsök eller ändrade urval efter testresultatet. Samtliga nedanstående varianter redovisas. Eventuell vinnare väljs endast på utvecklingsperiodens genomsnittliga netto-R, minst 30 affärer.
- Nuvarande signalmotor återspelas på avslutade femminutersstaplar. Kontot går in till nästa stapels öppning, med prisprövning även då. Detta är en femminutersapproximation av sidans femsekunderspuls, inte en exakt reproduktion av livekontot.
- Historiska nyheter saknas: nyhetsbias sätts till noll för samtliga varianter. Standardinställningar, grad A för befintliga motorvarianter.
- Samma kapitalmodell: en position i taget över samtliga sju coins; äldsta aktiva signal först, sedan konfidens och fast symbolordning vid lika tid. Separata engine-instanser per instrument undviker korskoppling av staplar i motorns orphan-hantering.
- Inträde vid nästa öppning, aldrig på signalstapelns tidigare pris. Stoppen före målet om båda träffas inom samma stapel; gap genom stopp fylls vid sämre öppningspris. Ingen mål-fyllning med prisförbättring. Trailing uppdateras först efter avslutad stapel och gäller från nästa stapel.
- Avgift 0,055 % per sida. Slippage 5 baspunkter per sida; känslighetsanalys 10 baspunkter. Historisk funding från motsvarande Bybit USDT-perpetual används om den kan hämtas, annars redovisas begränsningen uttryckligen. Spotpris används som approximation vid fundingvärdering.
- Rapportera affärer, träff, genomsnittligt netto-R, profit factor, avkastning och maximal nedgång vid 1 % risk per affär (max 20× notional), samt separat kontosimulering med sidans hela-saldot/20×. R definieras mot ursprungligt avstånd till stopp, före kostnader. Mark-to-market ingår i nedgången. Periodslut stänger öppna affärer.
- Spotdata är inte perpetual- eller markprisdata. Likvidation vid 20× är en approximation enligt sidans fasta 0,5 % underhållsmarginal. Ingen orderboks-, kö- eller verklig orderexekveringsmodell.

## Förregistrerade varianter

1. **Nuvarande**: oförändrad signalmotor; kontot kräver minst 1:1 brutto vid inträde.
2. **Nettofilter**: samma aktiva signaler, men minst 2:1 efter avgifter och antagen slippage.
3. **Netto + 1h**: som 2, dessutom riktning från senaste avslutade timmen: close över EMA50 och EMA20 över EMA50 för long, spegelvänt för short.
4. **ATR-gränser + netto + 1h**: befintlig motor men målgränser 1,5–6 ATR i stället för skalning från Nasdaq. Samma netto- och timfilter. Övrig sessionslogik behålls: isolerar målgränsernas bidrag.
5. **Kryptorekyl fast**: ovanstående 1h-riktning; avslutad 5m-stapel har nuddat EMA21 och stänger tillbaka på trendsidan, dessutom stänger högre än föregående close för long (lägre för short). Entry nästa öppning. Stopp bortom senaste sex staplars extrem med 0,1 ATR buffert, avstånd 1–3 ATR. Fast mål 3R brutto; minst 2:1 netto vid inträde. Ingen A-gradering eller New York-session i denna nya strategi. Sex staplars karens per coin efter exit.
6. **Kryptorekyl runner**: samma inträden som 5; halva positionen stängs vid 2R brutto, resten följer en 2 ATR stopp efter delmålet. Startnivå för flyttad stopp får inte vara sämre än ursprunglig stopp; ingen automatisk break-even. Samma nettofilter räknat mot 3R-referensmålet vid inträde. Ingen framtida stapel får flytta stoppen bakåt i tiden.

## Bedömning

Ingen variant installeras på sidan av detta test. En förbättring behöver bära efter kostnader även på testperioden och får inte förklaras enbart av en enskild coin, vecka eller ett fåtal extrema vinster. Osäkerhet bedöms via block-bootstrap på veckor; få observationer anges som otillräckligt underlag.
