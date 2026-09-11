# Automatisk momentumdemo 20×

I Crypto → AI-experiment finns kryssrutan **AI-experiment · automatisk momentumdemo 20×**. Den är avmarkerad första gången och sparas separat för varje inloggning i denna webbläsare. Den tidigare AI-loggningens kryssruta ligger kvar i en egen öppningsbar sektion och aktiverar inte handel.

Ibockad körs 14/28/56-momentum med 20× isolerad marginal i ett eget demokonto med 100 dollar vid start. BTC, ETH och SOL får en tredjedel av startkapitalet var. Varje kapitaldel återinvesteras separat. Inga order skickas till börsen. Det vanliga kryptodemokontot ändras inte.

## Beslut och körning

Signalen är medelvärdet av prisavkastningen över 14, 28 och 56 dygn på Bybit spot, fram till söndagens avslutade dygn. Positivt värde betyder lång position, annars kontanter. Beslut tas första gången funktionen aktiveras och därefter en gång per UTC-vecka från måndag 00:00. Fyllningen använder det aktuella perpetualpriset vid observationen med antagen slippage. En missad vecka leder inte till efterhandskonstruerade historiska affärer.

Automatiken körs när kryptosidan är öppen och användaren är inloggad. Dolda flikar kan strypas av webbläsaren; det finns ingen servercron för momentum. När sidan återkommer återställs öppna positioners markpris-/fundingförlopp före nya veckobeslut. Om nödvändig historik saknas eller inte hinner hämtas stannar uppdateringen med ett synligt fel. Framåtriktad demo är inte identisk med testets antagna fyllning vid måndagsöppningen.

Avmarkering pausar strategins köp och sälj. Öppna innehav ligger kvar och deras funding och likvidation fortsätter följas när sidan körs. Därmed fryser en paus inte marknadsrisken. En likviderad kapitaldel har noll saldo och börjar inte handla igen med pengar från ett annat coin.

## 20×, kostnader och likvidation

- Marginalbudget inkluderar entréavgiften: antal enheter = budget / (entry × (1/20 + 0,00055)). Ingen belåning över marginaldelen eller överföring mellan coins.
- Avgift antas 0,055 % och slippage 0,05 % per sida. Funding hämtas från Bybits historik och bokförs med markprisets öppning vid fundingtid för redan öppna positioner. Positiv funding kostar för lång; negativ ger intäkt.
- Likvidationsgränsen använder fast underhållsmarginal 0,5 % och uppskattad slutavgift. Det är en förenklad modell; risktrappor, marginalavdrag och börsens exakta avgifter modelleras inte. Vid simulerad likvidation förloras konservativt hela positionens marginalbudget.
- Markprisstaplar på fem minuter och aktuellt markpris används för att upptäcka likvidation. Första delvis observerade inträdesstapelns extrempriser ignoreras eftersom de kan ha inträffat före köpet. Detta kan missa en snabb likvidation mellan observationerna. Senare markprisstaplar måste vara sammanhängande.
- Fundinghistoriken måste nå tillbaka till senaste bokförda observation, innehålla den senast förväntade betalningen enligt aktuellt instrumentintervall och sakna luckor över åtta timmar för detta universum. Vid otillräckligt svar väntar beräkningen.
- Nettoförsäljningsvärdet i rutan inkluderar bokförd funding och antagna säljkostnader. Saknade eller gamla priser ger okänt värde, inte en frusen siffra som presenteras som aktuell.

## Lagring och dubbla flikar

Kontot använder `riptide.momentum.20x.v1:<Firebase uid>` i localStorage. Kontot är lokalt, separat från det gemensamma kryptokontot och från den tidigare AI-loggen. Att rensa webbläsardata kan radera det. Exportknappen sparar regler, hela beslutshistoriken, innehav och avslut som JSON.

Web Locks serialiserar läsning, beslut och skrivning mellan flikar på samma origin. Den aktuella kontoversionen läses om under låset före varje uppdatering. Beslut identifieras per vecka. En misslyckad skrivning får inte synas som en sparad affär. Utloggning, byte av användare eller avmarkering under en prishämtning stoppar det försenade anropet. Webbläsare som saknar låsstöd kan inte starta automatiken.

## Simulering och validering

20× lades till på användarens begäran och är inte en validerad förbättring. Den tidigare siffran +44,7 % gäller spot utan hävstång. [Den separata 20×-simuleringen](research/crypto-momentum-20x-results.md) visar båda förutbestämda startperioderna: 2025 års start förlorade hela kapitalet, medan en separat omstart i juli gav stor vinst och stor nedgång.

`npm test` kontrollerar bland annat överensstämmelse med forskningssignalen, verklig observationstid, framtidsdata, veckoidempotens, parallella flikar, paus, utloggning, lagringsfel, avgifter, funding och likvidation. Gemensam beräkningskod ligger i `crypto-leverage.js`.

API-källor: [spotdygn](https://bybit-exchange.github.io/docs/v5/market/kline), [perpetualtickers](https://bybit-exchange.github.io/docs/v5/market/tickers), [markpriser](https://bybit-exchange.github.io/docs/v5/market/mark-kline), [funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).
