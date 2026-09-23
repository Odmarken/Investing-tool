# Trading floor

Trading floor är en visuell helskärmsvy i kryptoläget, öppnad med knappen **▦ Trading floor** uppe till höger (adress `#floor`). Kontoret fyller allt under topplisten: dra för att panorera, scrolla eller nyp för att zooma, dubbelklicka (eller ⌂-knappen) för att återställa vyn; piltangenter, plus, minus och 0 gör samma sak från tangentbordet. Rubrik, status och knapparna ligger ovanpå bilden, och detaljpanelen öppnas nere till höger. Den ritar ett isometriskt kontor: fyra rum längs vänsterväggen för **Elias (VD)**, **Pablo (Analys)**, **Manuel (Makro & nyheter)** och **Miguel (Risk)**, ett öppet golv med **sex handelsbord** med fyra traders vardera, en **storskärm** med firmans kapital och kapitalkurva, en **nyhetsskärm** med rullande rubriker om världen och krypto, samt ett fikarum och en vattenautomat.

Kontoret är ett spel att titta på, men siffrorna är riktiga: borden är demokonton med Bybits riktiga perpetualpriser. Inga order, stopp eller kontoändringar skickas till Bybit.

## Borden: nio trender per coin

Varje bord startar med **100 $** och handlar **ett coin**: BTC, ETH, SOL, XRP, DOGE och SHIB (Bybits USDT-perpetuals, SHIB normaliserad till en token). Borden kör trendstrategin i `floor-trend.js`, som valdes och validerades i [forskningen om bordens strategi](research/floor-trend-results.md):

- **Nio horisonter**: 5, 10, 20, 30, 60, 90, 150, 250 och 360 dygn, räknade på timstängningar. En horisont slår på när en timstängning är högre än alla stängningar de senaste n dygnen. Dess stopp ligger på mittpunkten mellan högsta och lägsta stängningen de senaste n dygnen och flyttas bara uppåt. En timstängning under stoppet slår av horisonten.
- **Storlek**: positionens värde = (antal horisonter på / 9) × min(4, 100 % / σ) × bordets kapital, där σ är årsvolatiliteten av de senaste 90 dagliga avkastningarna (UTC-stängningar). Ett lugnt coin får större position än ett vilt, och helt mål är högst 4× kapitalet.
- **Ett beslut per timme.** Bordet köper, ökar, minskar eller säljer när antalet horisonter ändras, eller när volatiliteten flyttar målet mer än en fjärdedel. När alla horisonter slagit av säljs allt och affären bokförs. Bara långa positioner.
- **Konto och risk**: linjär perpetual per bord (kontanter + antal × pris); hela bordets kapital är marginal. Likvidation om kapitalet vid markpriset faller till 1 % av positionens värde, och då förloras bordets kapital. Avgift 0,055 % och slippage 0,05 % per sida; funding bokförs från Bybits historik.

I det historiska testet 2021–2026 (Binance-perpetuals, sex bord, alla kostnader) blev det ungefär **38 % per år i utvecklingen och 31 % per år i valideringen**, med **30–41 % största nedgång för firman** och upp till 57 % för ett enskilt bord. Bara 12–13 % av affärerna var vinster, och några få långa trender stod för det mesta av vinsten. 2022 och 2025 slutade med förlust. Detta är historik, inte ett löfte. Nivån 100 % årsvolatilitet är protokollets förval för demot. Högre nivåer gav inte mer i valideringen, bara större ras. Nivån ändras med `volTarget` och `maxLeverage` i `TREND`.

Ett nytt bord räknar fram sina nio trendlägen från två års timhistorik. Det gav exakt samma lägen som hela historiken i alla 378 kontroller 2025–2026. AI-momentumkontot rörs inte: det kör fortfarande sina timregler med SL och TP, och det delar ingen lagring med borden.

Storskärmen visar summan av bordens livesaldon (netto efter avgifter, bokförd funding och beräknade stängningskostnader) mot **600 $** insatta, samt en kapitalkurva av minutprover över det senaste dygnet. Klicka på skärmen för en större vy med hela den sparade kurvan (högst 1 440 prover) och en tabell per bord. Klicka på ett bord för saldo, resultat sedan start, **trendlampor** för de nio horisonterna, öppen position med exponering, snittpris, markpris, första och sista trendstopp och likvidation, samt de senaste avsluten.

## Rummen och figurerna

Traders sitter vid sitt bord när bordet är i affär. Utan öppen affär rör de sig fritt: fikarummet, soffan, kaffemaskinen, vattenautomaten, storskärmen, nyhetsskärmen eller en pratstund i gången. När bordets köp går igenom skyndar alla fyra tillbaka. Rummens figurer gör egna utflykter: Elias går ut och tittar på bord i affär, Pablo står vid storskärmen, Miguel går till bordet vars första trendstopp ligger närmast och Manuel står vid nyhetsskärmen.

Bordets etikett visar den pågående affärens öppna nettovinst i procent av bordets kapital när affären öppnades. Vid +20 % blir det pengapistoler, vid +50 % cigarrer och pengasäckar; firandet upphör under gränsen, vid avslut eller när färska priser saknas.

Klicka på ett rum för personens dossier: Elias visar firmans sammanfattning, Pablo skriver en läsning av golvet (lokalt, ingen API), Miguel visar positionernas värde, exponering och avstånd till första och sista trendstopp och till likvidation per bord, och Manuel visar kryptobiasen i nyhetsflödet och rubrikerna som sticker ut.

Nyhetsskärmen visar sidans vanliga kryptoflöde. Rubriker om världen hämtas från dina vanliga RSS-källor var tionde minut medan golvet är öppet. Klicka på skärmen för hela listan med länkar.

## Moln: Firestore och molnkörning

När sidan har Firestore (Firebase Hosting, eller lokalt med `apiBas` i `firebase-config.js`) ligger firman i molnet och delas mellan enheter: `floor/<uid>` (version, start, paus, senaste molnvarv och molnfel), `floor/<uid>/desks/<coin>` (ett dokument per bord) och `floor/<uid>/data/equity` (kapitalkurvan). Första gången laddar sidan upp sin lokala firma med kurvan, så inget går förlorat. Molnfunktionen **`molnCron`** i `functions/index.js` kör därefter varje minut, även när ingen sida är öppen. Den har två oberoende planer, så att ett fel i den ena inte stoppar den andra: AI-momentumkontot (`momentum/<uid>`) och borden. Borden fattar ett beslut per bord när timmen är ny. Timstaplarna hämtas då från Bybit och cachas i minnet, så att en varm instans bara hämtar den senaste sidan. Annars görs bara skyddskontrollen (funding och likvidation på markprishistorik) för bord i affär. Kapitalkurvan tar ett prov per minut med färska tickers.

**Byte från den första versionen.** Firmor från den första versionen av golvet (timmomentum med SL och TP, `trading-floor-v1`) arkiveras en gång under `floor/<uid>/archive/<id>` med orsaken `strategy-change`, med alla bord och kurvan. Sedan startar sex nya trendbord på 100 $, och pausläget följer med. Det gör molnet vid nästa varv, eller sidan först om den är öppen. Positioner flyttas inte över.

Sidan handlar inte själv i molnläge. Den hämtar femsekunderspriser för livesiffrorna, visar senaste molnvarv i statusraden (och säger ifrån om molnet inte kört på tre minuter eller rapporterar ett fel), pausar och återställer. Molnfunktionen läser om dokumenten i en transaktion innan den skriver, så en paus eller återställning från sidan skrivs inte över av ett pågående varv. Firestore-reglerna ger bara den inloggade användaren tillgång till sina egna dokument; funktionen går via admin-SDK:t. Utrullning: `npm run fb:deploy` kopierar modulerna till `functions/` (`kopiera-motor.js`), lägger upp funktionen, reglerna och sidan. `GET /api/moln/tick?k=FEED_KEY` kör ett varv på studs.

## Utan moln: lokal drift, lagring och återställning

Utan Firestore handlar borden så länge sidan är inloggad och i kryptoläge, även när golvet inte är framme. En gång per timme hämtar sidan timstaplar och fattar bordens beslut. Efter en omladdning är det cirka nio sidor per coin via proxyn, därefter en sida per timme. Var femte sekund hämtas tickers för bord i affär, och **skyddskontrollen** (funding och likvidation på markprishistorik) görs för ett bord i taget i turordning. Webbläsaren kan strypa bakgrundsflikar.

**Pausa nya köp** stoppar nya köp och ökningar på alla bord. Borden fortsätter att räkna sina trender, minskar och säljer när trender vänder, och likvidation kontrolleras. **Återställ firman** arkiverar firman (lokalt under `riptide.floor.v1:<uid>:before-reset:<tid>`, i molnet under `floor/<uid>/archive/<id>`) och startar sex nya bord på 100 $. En firma från den första versionen arkiveras lokalt under `…:before-trend:<tid>`. Den lokala lagringsnyckeln är `riptide.floor.v1:<kodad Firebase uid>`, kapitalkurvan ligger under `…:equity`. Web Locks serialiserar skrivningar mellan flikar. Bordens timbeslut sparas upp till 500 per bord; avsluten sparas alla.

## Filer och tester

| Fil | Vad den gör |
|---|---|
| `floor-trend.js` | Bordets regler: de nio trendlägena, volatiliteten, målstorleken, kontot med köp/ökning/minskning/sälj, funding och likvidation, livevärdet |
| `floor-trend-market.js` | Timstaplar från Bybit med minnescache, marknadshämtning för timbeslut och skyddskontroll |
| `trading-floor.js` | Firman: sex bord, uppgradering från första versionen, paus, livesumma, statistik, risktabell, kapitalkurva, Pablos text |
| `trading-floor-scene.js` | Layouten, gångnätet, figurernas beteende och canvasritningen |
| `trading-floor-ui.js` | Sidan: kamera (zoom och panorering), hämtningsloopar eller molnläge, paneler, storskärmarnas modaler, paus och återställning |
| `trading-floor.css` | Utseendet på helskärmsvyn |
| `cloud-runner.js` | Molnkörningen: två oberoende planer (AI-momentum och borden), beslut eller skyddskontroll, kapitalprov |
| `research/floor-trend-*` | [Protokoll](research/floor-trend-protocol.md), data, simulator, körning och [resultat](research/floor-trend-results.md) för valet av strategi |
| `tests/floor-trend.test.mjs` | Livemotorn mot forskningen: samma trendlägen timme för timme, samma volatilitet och samma slutsaldo som forskningssimulatorn; köp, ökning, sälj, paus, funding, likvidation och sidhämtning av timstaplar |
| `tests/trading-floor.test.mjs` | Ett coin per bord, uppgradering från första versionen, paus med fortsatta avslut, livesumma, kapitalprover, dagsstatistik, gångnät, figurernas beteende, klickytor och den monterade sidan mot Bybit-formade svar |
| `tests/cloud-runner.test.mjs`, `tests/cloud-sync.test.mjs`, `tests/trading-floor-cloud.test.mjs`, `tests/floor-cloud-equity.test.mjs` | Molnplanerna, felhantering per konto, kapitalprov, sidornas molnläge, uppgradering i molnet och i sidans adapter, och kameran |
