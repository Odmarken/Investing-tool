# Trading floor

Trading floor är en visuell helskärmsvy i kryptoläget, öppnad med knappen **▦ Trading floor** uppe till höger (adress `#floor`). Kontoret fyller allt under topplisten: dra för att panorera, scrolla eller nyp för att zooma, dubbelklicka (eller ⌂-knappen) för att återställa vyn; piltangenter, plus, minus och 0 gör samma sak från tangentbordet. Rubrik, status och knapparna ligger ovanpå bilden, och detaljpanelen öppnas nere till höger. Den ritar ett isometriskt kontor: fyra rum längs vänsterväggen för **Elias (VD)**, **Pablo (Analys)**, **Manuel (Risk)** och **Miguel (Makro & nyheter)**, ett öppet golv med **sex handelsbord** med fyra traders vardera, en **storskärm** med firmans kapital och kapitalkurva, en **nyhetsskärm** med rullande rubriker om världen och krypto, samt ett fikarum och en vattenautomat.

Kontoret är ett spel att titta på, men siffrorna är riktiga: borden är demokonton med Bybits riktiga perpetualpriser. Inga order, stopp eller kontoändringar skickas till Bybit.

## Borden

Varje bord startar med **100 $** och handlar **ett coin**: BTC, ETH, SOL, XRP, DOGE och SHIB, i samma ordning som AI-momentums universum (PEPE, det sjunde coinet, har inget bord). Bordet kör **exakt samma regler som AI-momentum** (`crypto-momentum-active.js` återanvänds oförändrad): timsignal på medelavkastningen över 14, 28 och 56 avslutade timmar, fast SL och TP, högst 50 % marginal och 50 % planerad SL-risk, högst en position, tolv timmars maxtid och en timmes karens efter avslut. Skillnaden är att bordet bara får se sitt eget coins signal; de andra coinens priser används enbart för kontrollerna. AI-momentumkontot rörs inte och delar ingen lagring med borden.

Storskärmen visar summan av bordens livesaldon (netto efter köpavgift, bokförd funding och beräknade stängningskostnader) mot **600 $** insatta, samt en kapitalkurva av minutprover över det senaste dygnet. Klicka på skärmen för en större vy med hela den sparade kurvan (högst 1 440 prover) och en tabell per bord. Klicka på ett bord för saldo, resultat sedan start, ledigt kapital, öppen position med entry, markpris, SL, TP, likvidation och tidsgräns, samt de senaste avsluten.

## Rummen och figurerna

Traders sitter vid sitt bord när bordet är i affär. Utan öppen affär rör de sig fritt: fikarummet, soffan, kaffemaskinen, vattenautomaten, storskärmen, nyhetsskärmen eller en pratstund i gången. När bordets köp går igenom skyndar alla fyra tillbaka. Rummens figurer gör egna utflykter: Elias går ut och tittar på bord i affär, Pablo står vid storskärmen, Manuel går till bordet som ligger närmast sitt SL och Miguel står vid nyhetsskärmen.

Klicka på ett rum för personens dossier: Elias visar firmans sammanfattning, Pablo skriver en läsning av golvet i samma stil som Pablo i signalkorten (lokalt, ingen API), Manuel visar marginal, planerad SL-förlust och avstånd till SL, TP och likvidation per bord, och Miguel visar kryptobiasen i nyhetsflödet och rubrikerna som sticker ut.

Nyhetsskärmen visar sidans vanliga kryptoflöde. Rubriker om världen hämtas från dina vanliga RSS-källor var tionde minut medan golvet är öppet. Klicka på skärmen för hela listan med länkar.

## Moln: Firestore och molnkörning

När sidan har Firestore (Firebase Hosting, eller lokalt med `apiBas` i `firebase-config.js`) ligger firman i molnet och delas mellan enheter: `floor/<uid>` (version, start, paus, senaste molnvarv och molnfel), `floor/<uid>/desks/<coin>` (ett dokument per bord) och `floor/<uid>/data/equity` (kapitalkurvan). Första gången laddar sidan upp sin lokala firma med kurvan, så inget går förlorat. Molnfunktionen **`molnCron`** i `functions/index.js` kör därefter varje minut, även när ingen sida är öppen: en marknadshämtning per inloggning driver både AI-momentumkontot (`momentum/<uid>`) och de sex borden med samma frysta regler som sidan använder (`cloud-runner.js`). Timkandelaber hämtas bara när något konto är ledigt och timmen är ny; annars görs bara skyddskontrollen på markprishistorik och funding för öppna positioner. Kapitalkurvan tar ett prov per minut med färska tickers.

Sidan handlar inte själv i molnläge. Den hämtar femsekunderspriser för livesiffrorna, visar senaste molnvarv i statusraden (och säger ifrån om molnet inte kört på tre minuter eller rapporterar ett fel), pausar och återställer. Molnfunktionen läser om dokumenten i en transaktion innan den skriver, så en paus eller återställning från sidan skrivs inte över av ett pågående varv. Firestore-reglerna ger bara den inloggade användaren tillgång till sina egna dokument; funktionen går via admin-SDK:t. Utrullning: `npm run fb:deploy` kopierar modulerna till `functions/` (`kopiera-motor.js`), lägger upp funktionen, reglerna och sidan. `GET /api/moln/tick?k=FEED_KEY` kör ett varv på studs.

## Utan moln: lokal drift, lagring och återställning

Utan Firestore handlar borden så länge sidan är inloggad och i kryptoläge, även när golvet inte är framme. Timbeslut hämtas ungefär varje minut (förskjutet mot AI-momentums hämtning). Var femte sekund hämtas tickers för bord i affär, och **skyddskontrollen** (SL, TP, funding, marginalskydd, likvidation på markprishistorik) görs för ett bord i taget i turordning, så varje bord kontrolleras var 5–30:e sekund beroende på hur många som är i affär. Timhämtningen kontrollerar dessutom alla bord. Webbläsaren kan strypa bakgrundsflikar.

**Pausa nya köp** stoppar nya inträden på alla bord; öppna positioner följer fortfarande SL, TP, tidsgräns och likvidation. **Återställ firman** arkiverar firman (lokalt under `riptide.floor.v1:<uid>:before-reset:<tid>`, i molnet under `floor/<uid>/archive/<tid>`) och startar sex nya bord på 100 $. Den lokala lagringsnyckeln är `riptide.floor.v1:<kodad Firebase uid>`, kapitalkurvan ligger under `…:equity`. Web Locks serialiserar skrivningar mellan flikar. Bordens timbeslut sparas upp till 500 per bord; avsluten sparas alla.

Ingen av AI-momentums profiler klarade utvecklingskraven (se [CRYPTO-MOMENTUM.md](CRYPTO-MOMENTUM.md)). Trading floor är därför ett demospel med riktiga priser, inte en validerad strategi.

## Filer och tester

| Fil | Vad den gör |
|---|---|
| `trading-floor.js` | Firman: sex bordkonton, snapshot per bord, paus, livesumma, statistik, kapitalkurva, Pablos text |
| `trading-floor-scene.js` | Layouten, gångnätet, figurernas beteende och canvasritningen |
| `trading-floor-ui.js` | Sidan: kamera (zoom och panorering), hämtningsloopar eller molnläge, paneler, storskärmarnas modaler, paus och återställning |
| `trading-floor.css` | Utseendet på helskärmsvyn |
| `cloud-runner.js` | Molnkörningen: vilka konton som är aktiva, en gemensam marknadshämtning, beslut eller skyddskontroll, kapitalprov |
| `tests/trading-floor.test.mjs` | Ett coin per bord, paus med fortsatt SL/TP, livesumma, kapitalprover, dagsstatistik, gångnät utan väggar och möbler, figurernas beteende, klickytor och den monterade sidan mot Bybit-formade svar |
| `tests/cloud-runner.test.mjs`, `tests/cloud-sync.test.mjs` | Molnplanen (kandelaber bara vid beslut, markhistorik bara för öppna kontrakt), felhantering per konto, kapitalprov, sidornas molnläge (uppladdning en gång, bara tickers, paus och återställning via molnet) och kameran |
