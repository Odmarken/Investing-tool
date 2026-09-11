# Account summary

Kryptolägets **Summary**-knapp bredvid Uppdatera öppnar `#summary` som en separat vy. Samma sidprocess och prisuppdateringar fortsätter; navigeringen stoppar inte demokontots logik. Tillbaka-länken och webbläsarens bakåtknapp återgår till signalerna.

Vyn visar realiserat saldo, netto i den sparade historiken, antal avslut, saldo som återstår till 10 000 dollar, vinst/förlust-ring och en saldokurva. Affärstabellen visar öppnings-/stängningstid, coin, strategi, long/short, entry/exit, saldo före, nettoresultat, avgift och saldo efter. Filtrering och sidindelning (50 per sida) omfattar hela den tillgängliga historiken. CSV-exporten innehåller alla sparade avslut, oavsett valt filter.

Nya positioner sparar `kapitalFore` vid öppning, och både automatiska och manuella avslut behåller värdet. För äldre affärer härleds saldot före i första hand från `kapitalEfter - pnl`, alternativt sparad marginal. Saknade värden visas som okända; historik som inte stämmer med realiserat saldo markeras som ofullständig eller med externa saldoändringar.

## Historikens omfattning

Tidigare sparades högst 300 avslut. Den lokala sparningen behåller nu hela tillgängliga historiken för det aktuella kontot. En inkommande molnuppdatering för samma kontoperiod slås ihop med lokal historik utan dubletter; den ersätter inte äldre lokala avslut. En ny kontoperiod efter nollställning hålls separat från den föregående.

Molnets befintliga kontodokument fortsätter att innehålla de senaste 300 avsluten. En annan webbläsare kan därför ha kortare historik. En separat molnarkivering skulle kräva nya Firestore-behörigheter; den delen publicerades inte eftersom automatisk godkännandegranskning avvisade den utökade åtkomsten. Inga Firestore-regler ändrades. Äldre affärer som redan försvunnit ur all sparning kan inte återskapas. CSV ger användaren en egen kopia; vid lokal lagringsbrist visas ett felmeddelande.

## Uppskattning till 10 000 dollar

Målet använder realiserat saldo. Öppen P/L ingår inte. En linjär uppskattning beräknas från nettovinsten per kalenderdag under högst de senaste 30 dagarna med tillgänglig historik. Den kräver minst 20 avslut och sju kalenderdagar. Vid noll/negativ takt visas ingen måldag; mer än tio år visas utan exakt datum. Ingen ränta-på-ränta eller antagen förbättring av strategin läggs till. Detta är ett historiskt räkneexempel, inte ett löfte om framtida avkastning.

Tester täcker saldon, long/short-resultat, ofullständig historik, nollresultat, negativa/otillräckliga prognoser, sidindelning/filter, CSV samt lokal historik över 300 avslut. Visuell kontroll i webbläsare var inte möjlig i arbetsmiljön.
