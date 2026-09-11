# Automatisk momentumdemo med Bybit max

I Crypto finns panelen **Kryptokonton** ovanför signalerna. Flikarna **Vanliga kontot**, **AI-momentum** och **Regler & inställningar** växlar mellan kontovyer och regler. AI-momentum visar saldorutor, öppna positioner med nettoresultat och avslutade affärer. Där finns kryssrutan **AI-momentum · automatisk demo med Bybit max**. Den är avmarkerad första gången och sparas separat för varje inloggning i denna webbläsare. Att byta vy eller fälla ihop panelen påverkar inte handeln; vyvalet sparas i webbläsaren. Beskrivningar, historiska tester och den tidigare AI-loggen ligger i regelfliken.

Ibockad körs 14/28/56-momentum med Bybits maxhävstång per coin och positionsstorlek i ett eget demokonto med 100 dollar vid start. Universum är BTC, ETH, SOL, XRP, DOGE, SHIB och PEPE. Högst en position får vara öppen och hela det lediga saldot används som isolerad marginal inklusive köpavgiften. Inga order skickas till börsen. Det vanliga kryptodemokontot är separat och använder också API-gränserna för nya affärer.

Med öppen position visar både saldorutan och positionskortet **Livesaldo · netto**, alltså hela kontots beräknade värde vid stängning. Kortet visar också öppet nettoresultat i dollar och procent av marginalbudgeten. Fria kontanter, köpavgift, bokförd funding samt uppskattad säljavgift och slippage ingår; kostnaderna dras inte en gång till. Priset hämtas från det öppna perpetualkontraktets senaste avslut var femte sekund, även när strategins köp och sälj är pausade. Markpriset visas separat. Senaste pristid visas och priser äldre än 15 sekunder ersätts med ett vänteläge.

Den snabba prisuppdateringen i `crypto-momentum-live.js` läser endast data och ändrar varken positioner, historik eller sparat saldo. Veckobeslut, funding och likvidation hanteras fortfarande i kontouppdateringen ungefär varje minut. Om den bokförda risk-/fundingobservationen är äldre än två minuter visas inget livesaldo, även om tickern fungerar. Försenade svar efter återställning, kontobyte eller utloggning får inte återföra gamla innehav. Webbläsaren kan strypa uppdateringarna när sidan ligger i bakgrunden.

## Beslut och körning

Signalen är medelvärdet av prisavkastningen över 14, 28 och 56 dygn på Bybit spot, fram till söndagens avslutade dygn. När kontot är ledigt väljs coin med högst positivt momentum. Lika värden avgörs av universums ordning ovan. En öppen position behålls så länge dess momentum är positivt, även om en annan coin rankas högre. Vid noll eller negativt värde stängs positionen och kontot kan köpa den starkaste positiva coin vid samma beslut. Om ingen är positiv behålls kontanter. Beslut tas första gången funktionen aktiveras och därefter en gång per UTC-vecka från måndag 00:00. Fyllningen använder det aktuella perpetualpriset vid observationen med antagen slippage. En missad vecka leder inte till efterhandskonstruerade historiska affärer.

**SL och TP:** strategin använder ingen fast stop loss eller take profit. Den normala exiten sker enligt veckosignalen ovan. Simulerad likvidation övervakas även mellan veckobesluten och är inte en stop loss. Kontovyn visar att fasta SL-/TP-nivåer saknas samt den beräknade likvidationsnivån.

Automatiken körs när kryptosidan är öppen och användaren är inloggad. Dolda flikar kan strypas av webbläsaren; det finns ingen servercron för momentum. När sidan återkommer återställs öppna positioners markpris-/fundingförlopp före nya veckobeslut. Om nödvändig historik saknas eller inte hinner hämtas stannar uppdateringen med ett synligt fel. Framåtriktad demo är inte identisk med testets antagna fyllning vid måndagsöppningen.

Avmarkering pausar strategins köp och sälj. Öppna innehav ligger kvar och deras funding och likvidation fortsätter följas när sidan körs. Därmed fryser en paus inte marknadsrisken. Vid likvidation av en position med hela saldot blir kontot tomt och kan inte köpa igen utan återställning.

## Maxhävstång, kostnader och likvidation

- Marginalbudget inkluderar entréavgiften: antal enheter = budget / (entry × (1/hävstång + 0,00055)). Vid ett nytt köp används summan av allt ledigt kapital; inga parallella kapitaldelar reserveras per coin.
- Avgift antas 0,055 % och slippage 0,05 % per sida. Funding hämtas från Bybits historik och bokförs med markprisets öppning vid fundingtid för redan öppna positioner. Positiv funding kostar för lång; negativ ger intäkt.
- Likvidationsgränsen använder underhållsmarginal och marginalavdrag från Bybits risknivå vid inträde samt uppskattad slutavgift. Nivån låses för affären: senare förändringar av risknivå eller börsvillkor modelleras inte. Det är en förenklad modell, inte börsens exakta likvidationsmotor. Vid simulerad likvidation förloras konservativt hela positionens marginalbudget.
- Markprisstaplar på fem minuter och aktuellt markpris används för att upptäcka likvidation. Första delvis observerade inträdesstapelns extrempriser ignoreras eftersom de kan ha inträffat före köpet. Detta kan missa en snabb likvidation mellan observationerna. Senare markprisstaplar måste vara sammanhängande.
- Fundinghistoriken måste nå tillbaka till senaste bokförda observation, innehålla den senast förväntade betalningen och sakna luckor längre än instrumentets aktuella fundingintervall. Det hanterar även kontrakt med kortare intervall än åtta timmar. Ett historiskt byte från längre till kortare intervall kan konservativt pausa beräkningen eftersom tidigare intervall inte rekonstrueras. Vid otillräckligt svar väntar beräkningen.
- Nettoförsäljningsvärdet i rutan inkluderar bokförd funding och antagna säljkostnader. Saknade eller gamla priser ger okänt värde, inte en frusen siffra som presenteras som aktuell.

## Bybits offentliga gränser

`bybit-contracts.js` hämtar `instruments-info` och `risk-limit` för aktiva linjära USDT-perpetualkontrakt. Högsta möjliga hävstång väljs inom kontraktsgränsen, hävstångssteget och den risknivå där hela positionen ryms. Momentum tar hänsyn till entréavgift och aktuellt markpris vid storleksvalet. Saknade eller mer än tio minuter gamla gränser blockerar nya köp; befintliga innehav fortsätter följas när markpris- och fundingdata finns. Ett veckobeslut med saknade köpgränser väntar och försöks igen.

AI-momentum använder BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT, SHIB1000USDT och 1000PEPEUSDT. De två sista kontrakten noteras per 1 000 tokens. Deras ticker- och markpriser normaliseras till pris per token, så antal enheter, resultat, funding och likvidation använder samma enhet som spot. Små priser visas med upp till tio decimaler i kontovyn.

Det vanliga kontot cachar gränser i tio minuter för BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT, SHIB1000USDT och 1000PEPEUSDT. Dess signaler och fyllningar använder fortfarande spotdata och saknar funding. Hävstången sparas på både öppna och avslutade affärer. Personliga Bybit-kontogränser eller öppna order på börsen läses inte. Inga kontoändringar görs via Bybit.

## Lagring och dubbla flikar

**Återställ till 100 $** i AI-momentum börjar om med 100 dollar, inga öppna positioner, tom aktiv historik och pausad automatik. Det tidigare kontot sparas först under `riptide.momentum.20x.v1:<uid>:before-reset:<tid>` i samma webbläsare. Om lagringen misslyckas behålls det aktiva kontot. Återställningen använder samma fliklås som handeln och stoppar pågående prishämtningar från att återinföra gamla affärer. Andra användares momentumkonton och det vanliga kryptokontot påverkas inte.

Kontot behåller lagringsnyckeln `riptide.momentum.20x.v1:<Firebase uid>` i localStorage för att bevara befintligt saldo och inställning. Versionen uppgraderas från tidigare 20×-/Bybit-maxversion till `momentum-14-28-56-single-v3`. Historik, avgifter, funding och befintliga positionsvillkor bevaras. Om flera äldre positioner är öppna stängs övriga till aktuella observerade priser vid nästa kompletta uppdatering, även om automatiken är pausad. Den befintliga position som har högst positivt momentum behålls; om ingen är positiv stängs alla. Avsluten bokförs med kostnader och orsaken `single-position`. Fram till dess visas att anpassningen väntar. Den kvarvarande positionen förstoras inte: allt ledigt kapital går in först vid nästa nya köp. Kontot är lokalt, separat från det gemensamma kryptokontot och från den tidigare AI-loggen. Att rensa webbläsardata kan radera det. Exportknappen sparar regler, hela beslutshistoriken, innehav och avslut som JSON.

Web Locks serialiserar läsning, beslut och skrivning mellan flikar på samma origin. Den aktuella kontoversionen läses om under låset före varje uppdatering. Beslut identifieras per vecka. En misslyckad skrivning får inte synas som en sparad affär. Utloggning, byte av användare eller avmarkering under en prishämtning stoppar det försenade anropet. Webbläsare som saknar låsstöd kan inte starta automatiken.

## Simulering och validering

Maxhävstång lades till på användarens begäran och är inte en validerad förbättring. Det historiska testet gäller BTC, ETH och SOL med separata kapitaldelar och fast 20×, inte den nya versionen med sju coins, en position och maxhävstång. Den tidigare siffran +44,7 % gäller spot utan hävstång. [Den separata 20×-simuleringen](research/crypto-momentum-20x-results.md) visar båda förutbestämda startperioderna: 2025 års start förlorade hela kapitalet, medan en separat omstart i juli gav stor vinst och stor nedgång.

`npm test` kontrollerar bland annat överensstämmelse med forskningssignalen, verklig observationstid, framtidsdata, veckoidempotens, parallella flikar, paus, utloggning, lagringsfel, avgifter, funding och likvidation. Gemensam beräkningskod ligger i `crypto-leverage.js`.

API-källor: [spotdygn](https://bybit-exchange.github.io/docs/v5/market/kline), [perpetualtickers](https://bybit-exchange.github.io/docs/v5/market/tickers), [markpriser](https://bybit-exchange.github.io/docs/v5/market/mark-kline), [funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).

Kontraktsgränser: [instrumentinformation](https://bybit-exchange.github.io/docs/v5/market/instrument), [risknivåer](https://bybit-exchange.github.io/docs/v5/market/risk-limit).
