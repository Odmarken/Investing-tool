# Fryst jämförelse: 1× och 20× momentum

2026-09-11, före körningen. Användaren begärde 20× i experimentrutan och därefter en historisk simulering. Inga ändringar av signalerna eller parameteroptimering.

- Samma långa veckosignal: genomsnitt av 14-, 28- och 56-dagars spotavkastning för BTC/ETH/SOL. Endast avslutade dygn. Beslut måndag UTC; inträde/utträde vid aktuell perpetualstapels öppning.
- 100 dollar startkapital, tre separata kapitaldelar. Varje positiv signal använder sin kapitaldel med 1× respektive 20×; entréavgift ryms i marginalbudgeten. Vid försäljning återinvesteras återstoden inom delen, ingen överföring mellan coins.
- Befintliga verifierade Bybit USDT-perpetualpriser och funding för 2025. Hämta riktiga markpriser med 15-minutersupplösning för samma period. Signalerna har verifierad tidigare spothistorik som uppvärmning.
- Kör hela 2025 och en separat omstart 1 juli–31 december 2025. Perioderna är överlappande retrospektiv diagnostik, inte nya oberoende valideringar. Datumvalet följer tillgängliga fullständiga kontraktsdata, inte observerade resultat.
- Jämför 1× och 20× på exakt samma instrument, signaler och perioder. Båda använder perpetuals och historisk funding; 1×-resultatet är därför inte exakt samma produkt som det tidigare spotexperimentet.
- Avgift 0,055 % och slippage 0,05 % per sida, stress med 0,10 % slippage. Antagen underhållsmarginal 0,5 % plus uppskattad slutavgift. Detta är en förenklad isolerad marginalmodell, inte börsens risktrappor.
- Likvidation bedöms på markprisernas lågpunkt och innebär konservativ förlust av hela den positionens marginaldel. Funding betalas eller erhålls vid observerad fundingtid om positionen redan fanns före den tiden; för ny entry vid samma tid tas ingen tidigare funding. Markprisets öppning används för fundingnotional. Kontot kan inte gå under noll och en tömd kapitaldel återstartar inte utan ny insättning.
- Gamla positioner kontrolleras mot marköppning före veckans frivilliga stängning, därefter hanteras veckobeslut och hela stapelns marklågpunkt. Ingen marklågpunkt efter en redan utförd stängning får likvidera den stängda positionen.
- Alla kvarvarande innehav avslutas vid periodslut med kostnad. Redovisa avkastning, slutkapital, likvidationer, nedgång, avgifter, funding och kapital per coin. Kontrollera saldo, kostnader och tidsordning.

Samma funktioner för inträde, marginal, fundingpåverkad likvidationsnivå och stängning används i live-demot och simuleringen. Live-demot använder femminutersmarkpriser och aktuell observation; historiken här använder 15-minutersstaplar och antagen fyllning vid öppning. Orderbok, delavslut, börsens exakta mark-/riskmodell och latens saknas. Resultaten visar inte att verklig exekvering kan reproduceras exakt.
