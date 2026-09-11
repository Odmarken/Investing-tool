# Experimentellt kryptofilter

Det här är ett gransknings- och inträdesfilter ovanpå den befintliga signalmotorn. Det skapar inte nya strategier och är inte validerat som lönsamt. Tidigare backtestresultat gäller inte automatiskt för det nya filtret.

I kryptoläget visas ett val ovanför signalkorten:

- **Granska signalerna** är standard. Korten visar bedömningen; kontot fortsätter följa tidigare inträdesregler.
- **Selektivt · nya demoaffärer** kräver samtliga filter vid ett nytt inträde. Inställningen sparas i denna webbläsare. Andra enheter kan ha en annan inställning när de tar över det delade demokontot.

En redan öppen position behåller entry, stopp, mål och ordinarie utträdeshantering. Kontot använder fortfarande hela saldot som marginal och sin befintliga hävstång. Filtret ändrar inte positionsstorleken.

## Krav

1. Riktiga, färska priser och sammanhängande historik. Minst 50 fullständiga timstaplar; endast avslutade 5m-staplar används till indikatorer.
2. Giltig entry mellan stopp och mål, med stopp före kontomodellens uppskattade likvidationspris.
3. Minst 1,5:1 kvar efter kontoavgiften och antagen slippage 0,05 % per sida. Funding ingår inte i denna framåtriktade beräkning.
4. Avslutad timtrend stödjer riktningen: EMA20/EMA50 och timstängning relativt EMA50.
5. Volymen i senaste avslutade 5m-stapel är minst medelvärdet för de föregående 20.
6. Avslutad 5m-stapel stänger i riktningen mot både öppningen och föregående stängning, i översta/nedersta tredjedelen av sitt spann.
7. Aktiv entry är högst 0,75 ATR sämre än signalens ursprungliga fyllning eller planerade entry. ATR14 beräknas från avslutade 5m-staplar.
8. En aktiv signal får vara högst 30 minuter gammal.

Det finns inget separat tak för kostnadernas andel av stoppavståndet. Avgifter och antagen slippage ingår fortfarande i netto-R:R enligt krav 3.

Väntande kort bedöms vid planerad entry och prövas på nytt vid faktiskt marknadspris när en demoaffär kan öppnas. Markeringen **Klarar kryptofiltret** betyder endast att dessa regler är uppfyllda just nu. Det är inte samma sak som en aktiv signal, en kontofyllning eller en uppmätt vinstchans.

Korten prioriterar godkända filter inom befintliga statusgrupper; stjärnmarkeringar behåller företräde. Kontot fortsätter välja äldsta handlingsbara aktiva signal. Inga extra poäng ger automatiskt högre uppmätt sannolikhet. Kryptokorten visar därför regelpoäng av 100, och återanvänder inte Nasdaq-modellens träffstatistik eller sannolikhet.

## Kontroll

`npm.cmd test` kontrollerar bland annat avgiftsmatematik för long/short, framtidsläckage, datagap, signalålder, prisjakt, likvidationsgräns och selektivt inträde med oförändrad hantering av redan öppna positioner. Dessa funktionstester bevisar inte lönsamhet. Någon ny resultatoptimering eller bakåttestning har inte gjorts för de här gränsvärdena.
