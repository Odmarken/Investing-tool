# Momentum: sex avgränsade ändringar

Låst 2026-09-11 före första körningen av dessa ändringar. Målet är högre nettoavkastning och synlig avvägning mot nedgång. Detta är fortsatt retrospektiv utveckling på redan använd historik, inte ny oberoende validering. Ingen belåning, ingen utökning till efterhandsvalda coins och ingen kombination av vinnande ändringar i denna körning.

Original: positivt 28-dagarsmomentum, kontroll måndag UTC, tre separata kapitaldelar för BTC/ETH/SOL. Behåll originalets kostnader och exekvering. Priser: verifierad befintlig Bybit spot-cache. Avgift 0,10 % och slippage 0,05 % per sida, stress 0,10 % slippage. Beslut använder bara färdiga dygn och utförs vid nästa öppning. Avsluta innehav vid periodslut med kostnad.

Sex ändringar, var och en för sig:

1. **Dagliga beslut:** samma 28-dagarssignal, kontrollerad varje dag. Hypotes: tidigare utträden kan begränsa tapp; kostnaden kan bli fler falska byten.
2. **Buffert ±2 %:** köp först över +2 % 28-dagarsmomentum, behåll tills momentum är under −2 %. Kontrollen är veckovis. Hypotes: mindre handel kring noll. Tröskeln är ett fast försök, inte optimerad.
3. **Trendfilter 84 dagar:** originalets positiva momentum och senaste stängning över medelvärdet av de senaste 84 avslutade dygnens stängningar. Sälj om något villkor inte uppfylls vid veckokontrollen. Hypotes: färre köp under långvarig nedtrend.
4. **Flera horisonter:** ersätt 28-dagarsmomentum med aritmetiskt medel av 14-, 28- och 56-dagars prisavkastning. Köp/håll när medelvärdet är positivt. Hypotes: mindre beroende av en enda horisont.
5. **Volatilitetsbegränsat inträde:** originalets signal, men investera högst min(1, 0,40 / annualiserad 28-dagarsvolatilitet) av respektive kapitaldel vid nytt köp. Volatilitet = stickprovsstandardavvikelse för 28 logavkastningar × sqrt(365); noll volatilitet ger fullt innehav. Övrigt ligger i kontanter. Ändra inte storleken under pågående innehav. 40 % är ett förutbestämt försök, inte en garanterad portföljvolatilitet. Hypotes: dämpa risk när rörelserna är stora utan ombalanseringskostnad varje vecka.
6. **Två starkaste:** två separata kapitaldelar med 50 % var vid start. Håll upp till två coins med högst positivt 28-dagarsmomentum. Behåll samma kapitaldel för ett coin som ligger kvar bland de två. En tom plats ligger i kontanter. Vinster återinvesteras inom respektive del, ingen veckovis likaviktsåterställning. Hypotes: fördela mer kapital till starkare signaler utan en enda 100 %-position.

## Urval och redovisning

- Kör 2023–2024 först. Lås kandidaten med högst stressad nettoavkastning bland varianter med positiv bas- och stressavkastning och minst tio avslutade innehav. Originalet ingår och kan vinna. Detta är en **avkastningskandidat**, ingen riskgodkänd strategi.
- Lås separat en **balanserad kandidat** med högsta stressavkastning/max(stressnedgång, 0,01), endast bland varianter med positiv bas/stressavkastning, minst tio innehav och bas/stressnedgång högst originalets motsvarande nedgång. Originalet kan vinna. Måttet är inte annualiserat. Den gamla riskgränsen 35 % ändras inte retroaktivt; detta är två nya jämförelsefrågor enligt användarens önskan om förbättring.
- Lås båda innan senare resultat räknas. Redovisa därefter alla varianter 2025-01-01–före 2026-09-10, kostnadsstress, nedgång, exponering, omsättning och coinbidrag. Ingen senare vinnare får ersätta de låsta kandidaterna och kallas validerad.
- Alla kompletta 12-månadersfönster med månatlig start från januari 2025 redovisas för samtliga varianter. De överlappar och är inte oberoende försök. Redovisa även separat omstart 2026 och årsutfall i det sammanhängande kontot.
- Visa samtliga sex ändringar även om de misslyckas. Ingen parameteroptimering eller ny kombination efter att resultaten setts. Automatiska kontot på sidan berörs inte.

## Motiv och begränsningar

Kryptomomentum har historiskt studerats av [Liu och Tsyvinski](https://www.nber.org/papers/w24877) samt [Liu, Tsyvinski och Wu](https://www.nber.org/papers/w25882). [Moreira och Muir](https://www.nber.org/papers/w22208) motiverar att undersöka mindre risk vid hög volatilitet i andra marknader. Dessa källor bevisar inte våra exakta regler; våra sex ändringar är egna testhypoteser, inte reproduktioner av artiklarna.

Endast tre idag valda coins, dygnsdata och begränsat antal marknadsregimer. Öppningen efter signal kan vara optimistisk vid verklig fördröjning; slippage är ett antagande. Daglig nedgång underskattar möjlig intradagsnedgång. Minsta orderstorlekar och orderbok saknas. Ett nytt bästa historiskt resultat bevisar inte ett verkligt optimum.
