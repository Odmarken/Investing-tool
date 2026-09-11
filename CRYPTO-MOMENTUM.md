# AI-momentum med SL och TP

AI-momentum är ett separat lokalt demokonto med 100 dollar vid start. Den aktiva versionen är ett **förvalt, ej lönsamhetsvaliderat 12-timmarsexperiment**. Ingen av de tre testade profilerna klarade utvecklingskraven. Namnet AI-momentum är kontots etikett; den nya signalen är regelbaserad och använder ingen tränad AI-modell.

I Crypto ligger **Kryptokonton** ovanför signalerna. Flikarna **Vanliga kontot**, **AI-momentum** och **Regler & inställningar** växlar visning. Att byta kontovy eller fälla ihop panelen ändrar inte handeln. Det vanliga kryptokontot är separat.

Kryssrutan **AI-momentum · aktiv demo med SL / TP** tillåter nya köp. Den är avmarkerad för nya konton och vid övergång från äldre momentumversioner. Avmarkering stoppar nya köp; SL, TP, tidsgräns, funding och likvidation fortsätter följas när kryptosidan körs. Inga order, stopp eller kontoändringar skickas till Bybit.

## Inträde och avslut

- BTC, ETH, SOL, XRP, DOGE, SHIB och PEPE ingår. Högst en lång position åt gången.
- Signalen är medelavkastningen över **14, 28 och 56 avslutade timmar** på Bybits USDT-perpetualkontrakt. Den tidigare strategins dygn och veckobeslut används inte av den nya versionen.
- När kontot är ledigt väljs coin med starkast positivt momentum. Lika värden avgörs av universums ordning. Saknas positiv signal blir det inget köp. En öppen position ersätts inte bara för att en annan coin rankas högre.
- Varje UTC-timme ger högst ett nytt beslut. Ordinarie uppdatering anropas ungefär var 30:e sekund och hämtningen begränsas till en gång per minut. Missade inträden återskapas inte: köp använder aktuellt observerat pris.
- SL-avståndet är det större av **2 × ATR14 på timstaplar** och **0,5 % av signalens referenspris**. ATR använder de senaste 80 sammanhängande, avslutade timstaplarna. Öppna och framtida staplar påverkar inte signalen.
- Förvalt `pulse12` sätter SL vid observerat köppris före slippage minus SL-avståndet, och TP vid samma pris plus **2 × SL-avståndet**. Nivåerna är fasta. Netto-R:R blir lägre än prisavståndsförhållandet efter kostnader.
- Köp kräver netto-R:R minst 1,5 efter beräknade avgifter/slippage, högst ett halvt SL-avstånds avvikelse från signalpriset och markpris mellan SL och TP.
- Maxtiden är **12 timmar**, avrundad nedåt till en femminutersgräns. SL, TP, tidsgräns, förbrukad likvidationsbuffert eller likvidation kan avsluta positionen. Efter avslut gäller minst **en timmes karens** före nästa köp med giltig timsignal.

`pulse24` och `trend24` finns som frysta forskningsprofiler. Kontot använder `pulse12` som förvalt experiment eftersom ingen vinnare kunde väljas; det är inte ett val baserat på bäst valideringsresultat.

## Risk, hävstång och kostnader

Användarens gräns är **högst 50 % av kontot i planerad vanlig SL-risk**, inklusive köp-/säljavgifter och antagen slippage. Samtidigt används **högst 50 % av saldot som isolerad marginalbudget inklusive köpavgiften**. Vid 100 dollar ligger därför minst 50 dollar kvar som fria kontanter efter köp. Faktisk planerad SL-risk kan vara lägre och visas i positionskortet.

Hävstången anpassas inom Bybits offentliga kontraktsgräns, hävstångssteg och positionens risknivå. Vid köp ska beräknad likvidation ligga minst 25 % av avståndet mellan entry och SL nedanför SL. Det konservativa storleksvalet använder därför normalt lägre hävstång än coinens absoluta max. Ingen extra isolerad marginal läggs till efter köp.

Antal enheter = marginalbudget / (entry × (1/hävstång + avgift)). Avgiften antas vara **0,055 % per sida** och slippage **0,05 % per sida**. Funding hämtas från Bybits historik och bokförs en gång med markpris vid betalningstidpunkten för redan öppna positioner. Positiv funding kostar för lång position; negativ ger intäkt.

Planerad SL-risk räknas vid inträde. Senare funding, gap eller större slippage kan öka förlusten. Risknivå, underhållsmarginal och marginalavdrag låses för affären; detta är inte Bybits exakta likvidationsmotor. Simulerad likvidation förbrukar positionens marginalbudget, medan fria kontanter ligger kvar. Upprepade förluster kan ändå förbruka nästan hela kontot.

Kontrakten är BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT, SHIB1000USDT och 1000PEPEUSDT. SHIB- och PEPE-priser normaliseras från 1 000 tokens till en token. Kontraktsgränser cachas i tio minuter. Saknade eller gamla gränser stoppar nya köp och kan prövas igen samma timme. Befintliga positioners skyddskontroll behöver inte nya hävstångsgränser eller de andra coinens signaldata.

Mängder är kontinuerliga i demot: minsta order, ordersteg, marknadsdjup och verklig orderbok modelleras inte. Personliga kontogränser och öppna order på Bybit läses inte.

## Livesaldo och skyddskontroll

Saldorutan och positionskortet visar hela kontots **Livesaldo · netto** med fria kontanter, öppet resultat, köpavgift, bokförd funding och uppskattade stängningskostnader. Kostnader dras inte dubbelt. Kortet visar också nettoresultat i dollar och procent av marginalbudgeten, entry, markpris, likvidation, SL, TP, tidsgräns och planerad SL-förlust.

Var femte sekund försöker sidan hämta den öppna positionens pris, markprishistorik och funding. Den snabba uppdateringen **bokför funding och skyddsavslut**, men öppnar inga nya affärer. Detta ersätter den äldre versionens rent läsande snabbuppdatering. Kontovärdet använder senaste avslutspris; **markpris utlöser SL, TP och likvidation**.

Pris äldre än 15 sekunder eller risk-/fundingobservation äldre än två minuter ger vänteläge. Ett misslyckat skrivförsök får inte visas som en sparad affär.

Historiska femminutersstaplar behandlas kronologiskt tillsammans med funding. Vid tvetydig stapel räknas SL före TP och före en lägre likvidationsnivå. Gapöppning förbi likvidationsgränsen räknas som likvidation; gap genom SL använder sämre öppningspris. Extrempriser från den delvis observerade inträdesstapeln hoppas över eftersom de kan ha inträffat före köpet. Aktuellt markpris kontrolleras ändå. Det kan missa en snabb rörelse mellan observationer.

Körningen kräver **inloggning och öppen kryptosida**. Webbläsaren kan strypa bakgrundsflikar; det finns ingen serverloop eller riktiga stopporder för detta konto. Efter frånvaro återställs historiska exits innan nya köp tillåts. Saknas sammanhängande markpris- eller fundinghistorik väntar beräkningen. Historiska ändringar i fundingintervall kan också orsaka vänteläge. Historiska fyllningar är en förenkling och garanterar inte verklig exekvering.

## Övergång, lagring och återställning

Lagringsnyckeln är fortsatt `riptide.momentum.20x.v1:<kodad Firebase uid>`. Versionen blir `momentum-hourly-sl-tp-v4`. Vid läsning av äldre 20×-/Bybit-max-/veckokonton **pausas nya köp**. Gamla positioner avslutas vid nästa kompletta skyddskontroll till aktuellt observerat pris med bokförda kostnader, eller som historisk likvidation om sådan redan inträffat. Avslutsorsaken är `strategy-change`. Kontot nollställs inte; saldo, tidigare avgifter, funding och historik bevaras. Kryssrutan kan därefter starta det nya experimentet.

**Återställ till 100 $** arkiverar först det tidigare kontot under `riptide.momentum.20x.v1:<uid>:before-reset:<tid>`, och skapar sedan ett nytt pausat konto utan positioner eller aktiv historik. Misslyckad arkivering eller skrivning lämnar det sparade aktiva kontot kvar. Exportknappen sparar regler, positioner och hela historiken som JSON.

Web Locks serialiserar läsning och skrivning mellan flikar på samma origin. Timvisa beslut och funding får inte dubbleras. Sena hämtningar efter reset, kontobyte eller utloggning får inte återinföra gamla positioner. Kontot är lokalt per inloggning och webbläsare; det synkas inte mellan enheter. Rensad webbläsardata kan radera det. Det vanliga kryptokontot påverkas inte.

## Testresultat

[Det frysta protokollet](research/crypto-momentum-active-protocol.md) och [hela resultatrapporten](research/crypto-momentum-active-results.md) beskriver tre förbestämda profiler. Utveckling var 14 mars–30 juni 2026; juli–augusti var en senare kontrollperiod. Perioderna är retrospektiva och inte orörda testdata.

Vid jämförbar **0,5 % SL-risk och högst 2× exponering** gav `pulse12` **−13,95 %** under utvecklingen. Ingen av de tre profilerna klarade utvecklingskraven; ingen validerad kandidat valdes.

I ett separat scenario med användarens **50 % riskgräns och 50 % marginaltak** blev 100 dollar cirka **1,01 dollar under juli–augusti** med `pulse12` (**−98,99 %**). Dagens Bybit-risktrappor applicerades på historiska priser; det är inte en rekonstruktion av historiskt korrekt hävstång. SL och kortare hålltid gör inte i sig strategin lönsam. Profilerna ändrades inte efter dessa resultat.

[Det tidigare 20×-testet](research/crypto-momentum-20x-results.md) gäller den äldre veckostrategin med BTC, ETH och SOL och separata kapitaldelar. Dess resultat och gamla spotresultat gäller inte denna timstrategi.

`npm test` kontrollerar signaler utan framtidsdata, SL/TP-geometri, risk/marginal, avgifter, funding, gap, likvidation, maxtid, karens, en position, migration, parallella flikar, paus, reset och lagringsfel. Browser- och API-kontroller kompletterar testerna.

API-källor: [timstaplar](https://bybit-exchange.github.io/docs/v5/market/kline), [tickers](https://bybit-exchange.github.io/docs/v5/market/tickers), [markpriser](https://bybit-exchange.github.io/docs/v5/market/mark-kline), [fundinghistorik](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate), [instrumentinformation](https://bybit-exchange.github.io/docs/v5/market/instrument), [risknivåer](https://bybit-exchange.github.io/docs/v5/market/risk-limit).
