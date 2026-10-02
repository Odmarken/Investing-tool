# Trading floor

Trading floor är en visuell helskärmsvy i kryptoläget, öppnad med knappen **▦ Trading floor** uppe till höger (adress `#floor`). Kontoret fyller allt under topplisten: dra för att panorera, scrolla eller nyp för att zooma, dubbelklicka (eller ⌂-knappen) för att återställa vyn; piltangenter, plus, minus och 0 gör samma sak från tangentbordet. Rubrik, status och knapparna ligger ovanpå bilden, och detaljpanelen öppnas nere till höger. Den ritar ett isometriskt kontor: fyra rum längs vänsterväggen för **Elias (VD)**, **Pablo (Analys)**, **Manuel (Makro & nyheter)** och **Miguel (Risk)**, ett öppet golv med **sex handelsbord** med fyra traders vardera, en **storskärm** med firmans kapital och kapitalkurva, en **nyhetsskärm** med rullande rubriker om världen och krypto, samt ett fikarum och en vattenautomat.

Kontoret är ett spel att titta på, men siffrorna är riktiga: borden är demokonton med Bybits riktiga perpetualpriser och hävstångsgränser. Inga order, stopp eller kontoändringar skickas till Bybit.

## Borden: nio trender per coin, Bybits maxhävstång

Varje bord startar med **100 $** och handlar **ett coin**: BTC, ETH, SOL, XRP, DOGE och SHIB (Bybits USDT-perpetuals, SHIB normaliserad till en token). Borden följer trendsignalen i `floor-trend.js`, som valdes i [forskningen om bordens strategi](research/floor-trend-results.md). De handlar däremot med Bybits maxhävstång i stället för forskningens volatilitetsstorlek:

- **Nio horisonter**: 5, 10, 20, 30, 60, 90, 150, 250 och 360 dygn, räknade på timstängningar. En horisont slår på när en timstängning är högre än alla stängningar de senaste n dygnen. Dess stopp ligger på mittpunkten mellan högsta och lägsta stängningen de senaste n dygnen och flyttas bara uppåt. En timstängning under stoppet slår av horisonten.
- **Start från noll**: ett nytt bord, efter en återställning eller ett versionsbyte, slår av alla nio horisonter vid sitt första timbeslut. Bara stängningar efter starten kan slå på en horisont.
- **Köp**: när bordet saknar position och en ny horisont slår på köper det en lång position. Hela saldot blir marginal, köpavgiften inräknad, med den högsta hävstång Bybits offentliga gränser tillåter för coinet och positionens storlek. Gränserna hämtas från Bybit vid beslutet med `maxLeverageFor` i `bybit-contracts.js`, samma funktion som kryptokontot använder. För ett bord på 100 $ var det den 2 oktober 2026 150× för BTC och ETH, 100× för SOL och XRP, 75× för DOGE och 50× för SHIB. Hävstång, underhållsmarginal och risknivå låses för affären. Saknas gränserna lämnar bordet timmen obeslutad med en väntetext, och nästa varv försöker igen.
- **Under affären** ändras inte storleken. Bordet säljer allt när alla nio horisonter slagit av, när du trycker **Stäng trade** eller vid likvidation. Bara långa positioner. Ett beslut per timme.
- **Stäng trade** finns i bordets panel när bordet är i affär. Efter en bekräftelse bokförs funding och kontrolleras likvidation fram till nu på markprishistorik, och sedan säljs hela positionen till marknadspris med avgift och slippage. Bordet köper igen först när en ny horisont slår på efter stängningen.
- **Konto och risk**: linjär perpetual per bord (kontanter + antal × pris); hela bordets kapital är marginal. Likvidation sker när kapitalet efter stängningsavgiften, vid markpriset, når den låsta underhållsmarginalen (Bybits isolerade nivå). Då förloras bordets kapital, och ett likviderat bord står still tills firman återställs. Avgift 0,055 % och slippage 0,05 % per sida; funding bokförs från Bybits historik.

**Vad maxhävstång betyder.** Likvidationen ligger 0,2–1 % under köppriset: drygt 0,2 % för BTC och ETH vid 150×, knappt 1 % för SHIB vid 50×. Köp plus försäljning kostar 10–30 % av bordets kapital i avgifter och slippage, så ett bord står runt −29 % direkt efter ett köp vid 150×. Trendstoppen gäller timstängningar och ligger flera procent bort, så likvidationen kommer nästan alltid först.

`research/floor-max-check.mjs` kör livemotorn på Bybits egna timstaplar och funding med nollställda signaler och dagens gränser. Ett nytt bord per coin startar vid varje månadsskifte, från april 2021 för BTC och 2022 för övriga coin (360 dygns historik behövs först) till september 2026. Det blir totalt 318 bord som körs i 30 dagar var. **98 % likviderades inom 30 dagar, 309 av 314 redan på sin första affär och 72 % inom första timmen efter köpet.** Sex bord klarade sig: fyra satt kvar i affär efter 30 dagar och två SHIB-bord slutade på cirka 240 $. Timmens lägsta pris räknades som markpris, så testet är något strängare än Bybits markpris. Trendregeln valdes i forskningen med högst 4× hävstång och gav där ungefär 31–38 % per år ([resultat](research/floor-trend-results.md)). Den siffran gäller inte maxhävstång. Detta är ett demospel, inte ett löfte.

AI-momentumkontot rörs inte: det kör fortfarande sina timregler med SL och TP, och det delar ingen lagring med borden.

Storskärmen visar summan av bordens livesaldon (netto efter avgifter, bokförd funding och beräknade stängningskostnader) mot **600 $** insatta, samt en kapitalkurva av minutprover över det senaste dygnet. Klicka på skärmen för en större vy med hela den sparade kurvan (högst 1 440 prover) och en tabell per bord. Klicka på ett bord för saldo, resultat sedan start och **trendlampor** för de nio horisonterna. Panelen visar också den öppna positionen med hävstång, värde, exponering, snittpris, markpris, likvidation och avstånd dit, första och sista trendstopp, underhållsmarginal och risknivå, knappen **Stäng trade** och de senaste avsluten med hävstång.

## Rummen och figurerna

Traders sitter vid sitt bord när bordet är i affär. Utan öppen affär rör de sig fritt: fikarummet, soffan, kaffemaskinen, vattenautomaten, storskärmen, nyhetsskärmen eller en pratstund i gången. När bordets köp går igenom skyndar alla fyra tillbaka. Rummens figurer gör egna utflykter: Elias går ut och tittar på bord i affär, Pablo står vid storskärmen, Miguel går till bordet som ligger närmast likvidation och Manuel står vid nyhetsskärmen.

Bordets etikett visar den pågående affärens öppna nettovinst i procent av bordets kapital när affären öppnades, eller "likviderad" för ett bord utan kapital. Vid +20 % blir det pengapistoler, vid +50 % cigarrer och pengasäckar; firandet upphör under gränsen, vid avslut eller när färska priser saknas.

Klicka på ett rum för personens dossier. Elias visar firmans sammanfattning och Pablo skriver en läsning av golvet (lokalt, ingen API). Miguel visar positionernas värde och, per bord, hävstång, exponering och avstånd till likvidation och till sista trendstoppet. Manuel visar kryptobiasen i nyhetsflödet och rubrikerna som sticker ut.

Nyhetsskärmen visar sidans vanliga kryptoflöde. Rubriker om världen hämtas från dina vanliga RSS-källor var tionde minut medan golvet är öppet. Klicka på skärmen för hela listan med länkar.

## Moln: Firestore och molnkörning

När sidan har Firestore (Firebase Hosting, eller lokalt med `apiBas` i `firebase-config.js`) ligger firman i molnet och delas mellan enheter: `floor/<uid>` (version, start, paus, senaste molnvarv och molnfel), `floor/<uid>/desks/<coin>` (ett dokument per bord) och `floor/<uid>/data/equity` (kapitalkurvan). Första gången laddar sidan upp sin lokala firma med kurvan, så inget går förlorat. Molnfunktionen **`molnCron`** i `functions/index.js` kör därefter varje minut, även när ingen sida är öppen. Den har två oberoende planer, så att ett fel i den ena inte stoppar den andra: AI-momentumkontot (`momentum/<uid>`) och borden. Borden fattar ett beslut per bord när timmen är ny. Timstaplarna hämtas då från Bybit och cachas i minnet, så att en varm instans bara hämtar den senaste sidan, och bord utan position får Bybits hävstångsgränser. Annars görs bara skyddskontrollen (funding och likvidation på markprishistorik) för bord i affär. Kapitalkurvan tar ett prov per minut med färska tickers.

**Byte från tidigare versioner.** Firmor från den första versionen av golvet (timmomentum med SL och TP, `trading-floor-v1`) och från trendborden med volatilitetsstorlek och högst 4× (`trading-floor-v2`) arkiveras en gång under `floor/<uid>/archive/<id>` med orsaken `strategy-change`, med alla bord och kurvan. Sedan startar sex nya bord på 100 $ med avslagna trender, och pausläget följer med. Det gör molnet vid nästa varv, eller sidan först om den är öppen. Positioner flyttas inte över.

Sidan handlar inte själv i molnläge, utom när du trycker **Stäng trade**. Då hämtar sidan bordets markpris- och fundinghistorik och stänger i en transaktion som läser om firman först. En affär som molnet redan har stängt skrivs därför aldrig över. Hinner molnet bokföra bordet mellan hämtningen och skrivningen hämtar sidan historiken igen. I övrigt hämtar sidan femsekunderspriser för livesiffrorna, visar senaste molnvarv i statusraden (och säger ifrån om molnet inte kört på tre minuter eller rapporterar ett fel), pausar och återställer. Molnfunktionen läser om dokumenten i en transaktion innan den skriver, så en paus, återställning eller stängning från sidan skrivs inte över av ett pågående varv. Firestore-reglerna ger bara den inloggade användaren tillgång till sina egna dokument; funktionen går via admin-SDK:t. Utrullning: `npm run fb:deploy` kopierar modulerna till `functions/` (`kopiera-motor.js`), lägger upp funktionen, reglerna och sidan. `GET /api/moln/tick?k=FEED_KEY` kör ett varv på studs.

## Utan moln: lokal drift, lagring och återställning

Utan Firestore handlar borden så länge sidan är inloggad och i kryptoläge, även när golvet inte är framme. En gång per timme hämtar sidan timstaplar, och Bybits gränser för bord utan position, och fattar bordens beslut. Efter en omladdning är det cirka nio sidor per coin via proxyn, därefter en sida per timme. Var femte sekund hämtas tickers för bord i affär, och **skyddskontrollen** (funding och likvidation på markprishistorik) görs för ett bord i taget i turordning. Webbläsaren kan strypa bakgrundsflikar.

**Pausa nya köp** stoppar nya köp på alla bord. Borden fortsätter att räkna sina trender och säljer när alla trender slagit av, likvidation kontrolleras och **Stäng trade** fungerar. **Återställ firman** arkiverar firman (lokalt under `riptide.floor.v1:<uid>:before-reset:<tid>`, i molnet under `floor/<uid>/archive/<id>`) och startar sex nya bord på 100 $ med avslagna trender. En firma från en äldre version arkiveras lokalt under `…:before-trend:<tid>` (v1) eller `…:before-max:<tid>` (v2). Den lokala lagringsnyckeln är `riptide.floor.v1:<kodad Firebase uid>`, kapitalkurvan ligger under `…:equity`. Web Locks serialiserar skrivningar mellan flikar. Bordens timbeslut sparas upp till 500 per bord; avsluten sparas alla.

## Filer och tester

| Fil | Vad den gör |
|---|---|
| `floor-trend.js` | Bordets regler: de nio trendlägena, start från noll, köp med Bybits maxhävstång, försäljning när alla trender slagit av, Stäng trade, funding och likvidation på den låsta risknivån, livevärdet |
| `floor-trend-market.js` | Timstaplar från Bybit med minnescache, Bybits gränser för bord utan position, marknadshämtning för timbeslut och skyddskontroll |
| `trading-floor.js` | Firman: sex bord, uppgradering från äldre versioner, paus, stängning per bord, livesumma, statistik, risktabell, kapitalkurva, Pablos text |
| `trading-floor-scene.js` | Layouten, gångnätet, figurernas beteende och canvasritningen |
| `trading-floor-ui.js` | Sidan: kamera (zoom och panorering), hämtningsloopar eller molnläge, paneler med Stäng trade, storskärmarnas modaler, paus och återställning |
| `trading-floor-cloud.js` | Firestore-adaptern: uppladdning, paus, återställning, uppgradering och stängning i transaktioner |
| `trading-floor.css` | Utseendet på helskärmsvyn |
| `cloud-runner.js` | Molnkörningen: två oberoende planer (AI-momentum och borden), beslut eller skyddskontroll, kapitalprov |
| `research/floor-trend-*` | [Protokoll](research/floor-trend-protocol.md), data, simulator, körning och [resultat](research/floor-trend-results.md) för valet av trendregeln |
| `research/floor-max-check.mjs` | Beskrivande kontroll av livemotorn med maxhävstång på Bybits historik (`node research/floor-max-check.mjs`); väljer inget |
| `tests/floor-trend.test.mjs` | Livemotorn: samma trendlägen timme för timme som forskningen, start från noll, köp till Bybits max med låst risknivå, likvidation på Bybits isolerade nivå, Stäng trade, saknade gränser, funding och sidhämtning av timstaplar |
| `tests/trading-floor.test.mjs` | Ett coin per bord, uppgradering från v1 och v2, paus, stängning per bord, livesumma, kapitalprover, dagsstatistik, gångnät, figurernas beteende, klickytor och den monterade sidan mot Bybit-formade svar, med Stäng trade-knappen |
| `tests/cloud-runner.test.mjs`, `tests/cloud-sync.test.mjs`, `tests/trading-floor-cloud.test.mjs`, `tests/floor-cloud-equity.test.mjs` | Molnplanerna, felhantering per konto, kapitalprov, sidornas molnläge, uppgradering och stängning i molnet och i sidans adapter, och kameran |
