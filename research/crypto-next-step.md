# Fortsättning av båda kryptospåren

Senare uppföljning: [sex testade ändringar av momentum](crypto-momentum-tweaks-results.md). Kombinationen 14/28/56 dagar förbättrade senare resultat men gav större tidigare nedgång; den i förväg valda kandidaten med dagliga beslut misslyckades i senare kontroll.

Uppdaterad 2026-09-11. Användaren bad att fortsätta både den långsammare strategin och AI för korta trades. Två reproducerbara granskningar är nu genomförda med befintliga data och frysta strategier.

## Långsammare momentum

28-dagars momentum med veckovisa beslut är fortsatt det mer lovande spåret för ett separat framåtriktat demoexperiment. Det är en regelstyrd strategi; ingen AI har tränats för detta spår.

- 6 av 9 fullständiga tolvmånadersfönster gick plus; samtliga nio slog köp och behåll i samma tre coins. Medianen var +20,1 %, sämsta fönstret −13,6 %.
- 8 av 15 sexmånadersfönster gick plus. Sämsta fönstret gav −27,6 %. Antalet positiva fönster var oförändrat med dubbel slippage.
- Fönstren överlappar och ger inte nio eller femton oberoende bevis eller någon framtida vinstsannolikhet.
- Den sammanhängande vinsten var 28,45 dollar per 100 dollar startkapital. Största vinnaren bidrog 29,13 dollar; fem största vinnarna stod för 88,9 % av samtliga vinstaffärers P/L. ETH stod för hela det positiva nettobidraget, medan BTC och SOL var negativa.
- Samma konto gav +30,34 % under 2025 och −1,45 % under 2026 fram till 9 september. Den tidigare siffran −5,9 % avser ett nytt konto med start 2026; det är en annan körning, inte ett räknefel.

Användaren accepterar att undersöka en strategi med cirka 31,9 % uppmätt nedgång. Det gör fortsatt demo intressant, men granskningen visar också förlustperioder och koncentration till ett fåtal vinster. Den ursprungliga utvecklingsperiodens nedgång på 45,5 % kvarstår. Inga riskgränser ändrades för att få testet godkänt.

Nästa genomförandesteg för detta spår: separat demologg med den exakta veckoregeln, stängd dygnshistorik, låsta beslut och egen bokföring av köp/sälj och kostnader. Historikens bästa startdatum eller enbart ETH får inte väljas i efterhand och presenteras som en validerad förbättring.

[Fullständiga startfönster och bidragsanalys](crypto-slow-robustness-results.md).

## AI för korta trades

De sex tidigare tränade modellerna granskades på samma tidigare valideringsmånad. Fem prognosgrupper bestämdes från träningen och applicerades sedan oförändrade på valideringen. Detta undersöker om modellerna rangordnar bättre och sämre kandidater, även när samtliga prognoser ligger under handelströskeln.

Det tydligaste positiva fyndet är originalsignalerna med trädmodellen:

| Grupp | Signaler | Netto-R i snitt | Vid dubbel slippage |
|---|---:|---:|---:|
| Lägst rankad | 96 | −0,550 | −0,655 |
| Högst rankad | 80 | +0,075 | −0,053 |

Den högsta gruppen definierades med träningsprognoserna, men dess utfall har nu granskats. Att byta till den gruppgränsen som handelsregel kräver därför ett nytt utvecklingsprotokoll och senare oberoende uppföljning. Den är inte en redan godkänd strategi. Gruppens genomsnittliga prognos var −0,350 R; modellen underskattade utfallet i just denna grupp och månad. Det visar inte att prognoserna kan justeras upp lika mycket framöver.

De bredare stoppen gav ingen tydlig förbättring av modellernas prognosfel jämfört med att alltid förutsäga träningsmedelvärdet. Deras högst rankade grupper gick också minus. Därför motiverar resultatet inte mer modellkomplexitet eller en allmän sänkning av köpkraven.

Nästa forskningsfråga för detta spår: går det att behålla rangordningen med mätbart lägre kostnader per signal? Ett sådant experiment behöver separera exekvering från modellurval, låsa ett fåtal utföranderegler före körning och räkna uteblivna fyllningar. Att bara anta lägre slippage eller gratis limitfyllningar skulle inte besvara frågan. Bevara originalmodellen och det kostnadsstressade resultatet som referens.

[Fullständig rangordnings- och prognosanalys](crypto-ai-ranking-results.md).

## Levererat och verifierat

Två nya körbara analysmoduler, en före körningen dokumenterad momentumdiagnostik, genererade rapporter och sex nya tester. Hela testsviten passerar: 69 tester. Resultatfilerna i lokal cache innehåller indatahashar för reproduktion. AI-granskningen öppnar inte juli–september-perioden som tidigare reserverades för en kandidat som klarat valideringen.

Arbetet är lokalt. Ingen ny modell, kontoändring, automatisk demohandel eller publicering har gjorts i denna fortsättning.
