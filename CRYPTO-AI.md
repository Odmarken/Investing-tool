# AI-bedömning för krypto (experiment)

**Ny koppling:** huvudrutan AI-experiment kan nu köra [automatisk momentumdemo med 20×](CRYPTO-MOMENTUM.md) på användarens begäran. Den använder ett eget lokalt demokonto och en egen kryssruta. Den tidigare AI-modellens logg finns kvar under **Tidigare AI-modell · signalbedömningar**; beskrivningen nedan gäller den loggen. Historiska resultat utan hävstång gäller inte 20×-versionen.

Fortsättning 2026-09-11: [gemensam bedömning av momentum och kort AI](research/crypto-next-step.md). Nya kontroller undersöker momentumets startdatum och vinstkoncentration samt AI-modellernas rangordning på valideringsdata. Modell- och kontoreglerna är oförändrade.

Senaste uppföljning: [AI v2 – bredare träning och förbättringstest](research/crypto-ai-v2-results.md). Sex kandidater tränades på den bredare kandidatinsamlingen; ingen klarade valideringen. Därför ersattes inte den nuvarande modellen och ingen automatisk AI-demohandel aktiverades. Resultatsammanfattningen finns under **Senaste förbättringstest** i AI-rutan.

Kryptosidan har en separat, initialt påslagen ruta **AI-bedömning · experiment** under Kryptofilter. Den ändrar inte `krTagbar`, Selektiv, order, saldo, hävstång eller exits. Kryssrutan pausar nya observationer; redan loggade observationer följs fortfarande när kryptosidan uppdateras. Nasdaq-modellen används inte.

## Vad loggen betyder

Vid första giltiga observationen av en aktiv A-signal sparas modellversion, instrument, riktning, tid, aktuellt inträdespris med antagen slippage, stopp, mål, modellens uppskattade netto-R, indata, kontrollresultat, AI:s beslut och om Selektiv samtidigt godkände signalen. Bedömningen ändras inte i efterhand. Även signaler som AI avstår från loggas. En ny modellversion får en separat observation; resultatvyn jämför endast den aktuella versionen.

Exempel: AI uppskattar −0,20 R och skulle avstå från XRP short. Senare når den hypotetiska positionen målet. Loggen visar båda uppgifterna, även när modellen hade fel. Detta är en separat signalutvärdering, inte bokföring av en utförd kontoaffär.

Varje observation följs oberoende av övriga signaler. Den stängs vid låst SL/TP eller efter 24 timmar, räknat från nästa femminutersstapel. Endast avslutade staplar används. Hela beslutsstapeln ignoreras eftersom dess extrema priser kan ha inträffat före observationen. Detta kan missa ett snabbt stopp eller mål och är en uttrycklig begränsning. Om både SL och TP träffas i en stapel räknas SL först; gap genom stopp fylls till sämre öppningspris. Gap till mål ger bara målpriset. Luckor eller ogiltiga utfallsdata blir **okänt**, aldrig en påhittad vinst/förlust. Senare tillgänglig sammanhängande historik kan följas efter en omladdning; saknas den nödvändiga historiken går resultatet inte att återställa.

R = nettoresultat per enhet / beräknad nettoförlust vid ursprungligt stopp. Båda sidor räknar 0,055 % avgift och 0,05 % slippage. Funding och likvidation simuleras inte. AI:s grundkrav inkluderar att stoppet ligger före beräknad likvidation vid standardvärdet 20×, men utfallsloggen modellerar ingen hävstång eller marginal. Dessa antaganden är låsta för experimentet och ändras inte med kontoinställningar. Därför är signalernas genomsnittliga R **inte kontots avkastning**. Överlappande och korrelerade signaler är inte oberoende stickprov.

Jämförelsen visar Alla, Selektiv, AI skulle ta samt AI + Selektiv på samma observerade kandidater. Okända och väntande utfall ingår inte i vinstandel eller snitt-R. Vyn visar senaste 20 rader; JSON-exporten innehåller samtliga lokala rader och aktuell modellmetadata. Loggen är begränsad till 5 000 rader; vid gränsen stannar nya observationer utan att gamla raderas. Lagringsfel visas och export fungerar även för observationer som bara finns kvar i flikens minne.

Lagringen använder `riptide.crypto-ai.v1:<Firebase uid>` i denna webbläsares localStorage. Ingen serverarkivering, API-nyckel eller AI-tjänst behövs. Inloggning och kryptosidan med aktuella prisdata behövs för att logga nya observationer. Loggen delas inte mellan enheter och kan försvinna om webbläsardata rensas. Kontots Firestore-regler är oförändrade.

## Modellen och första testet

Det är en tränad ridge-regression, inte en språkmodell eller ett manuellt regelpoäng som döpts om till AI. Elva indata beskriver riktning, avslutad timtrend, relativ volym, ATR i procent, stopp- och målavstånd i ATR, netto-R:R, avslutad stapelkropp, entimmesrörelse, stängningsläge och riktningstrigger. Medelvärden, standardavvikelser och vikter beräknas enbart på träningsdelen. Standardiserade indata begränsas till ±5. Regularisering 30 och beslutströskel +0,10 R valdes före första körningen och ändrades inte efter testresultatet. AI skulle ta kräver också färsk riktig data, giltig geometri, netto-R:R ≥1,5, högst 30 min signalålder och högst 0,75 ATR jagad entry. Volym/trend/trigger är modellindata; de måste inte samtidigt klara Selektivs fasta krav.

Träningsunderlaget kommer från den tidigare basstrategins historiskt simulerade kandidater, Bybit spot för BTC, ETH, SOL, XRP, DOGE, SHIB och PEPE. Det är **inte användarens kontoaffärer**. Kandidaternas utfall beräknas på nytt med exakt samma loggfunktion och 24-timmarshorisont som i webbläsaren. Kandidaterna är ett begränsat urval som basportföljen tog när saldot var ledigt, inte samtliga möjliga signaler. I historiken saknas första liveobservationens ålder och ursprungliga signalentry; kandidaterna bedöms därför som nyaktiverade vid sitt historiska inträde. Detta gör jämförelsen med dagens filter preliminär.

- Träning: 843 exempel före 12 juli 2026. Även utfallet måste ligga strikt före tidsgränsen.
- Senare retrospektiv utvärdering: 424 exempel från 12 juli till före 10 september 2026.
- Alla: −0,408 R per exempel, 28,3 % positiva utfall.
- Selektiv: 4 exempel, −0,292 R per exempel; för få för slutsatser.
- AI skulle ta: **0 exempel**. Ingen positiv eller lönsam AI-strategi har demonstrerats.

Den senare perioden har redan granskats i tidigare strategiforskning och är inte ett orört sluttest. Inga hyperparametrar justerades för att tvinga fram godkända trades. Modellen är märkt `validated:false` och får ingen handelsbehörighet. Nya framåtriktade observationer blir ytterligare evidens; de gör inte tidigare data orörda. Modellens tal är uppskattat R, aldrig en kalibrerad vinstsannolikhet.

Modellen är fryst och tränar inte om sig på enskilda nya vinster/förluster. Nya bedömningar stoppas när dataperiodens slut ligger mer än 30 dagar tillbaka; äldre observationer följs fortfarande. En ny träning och utvärdering krävs då.

## Reproduktion och kontroll

`node scripts/train-crypto-ai.mjs` läser den befintliga lokala forskningscachen `.matning/crypto/results.json` och respektive symbols JSON med femminutersstaplar. Den behöver inga nätverksanrop och skriver `crypto-ai-model.js`. Cachen är git-ignorerad och följer inte med en ny klon; utan den avslutas träningen med tydligt fel utan att skriva en modell. Den genererade modellen följer med sidan och kan användas direkt. SHA-256 för underlaget finns i modellens `provenance`.

`npm test` omfattar bland annat skydd mot framtida indikatorer, felaktig data/modellschema, gamla modeller, long/short-avgifter, samtidiga SL/TP, gap, tidsstängning, omladdning, låsta bedömningar, kontoseparerad lokal logg, lagringsfel och tidsgränsen mellan träning/test. Ingen automatisk order skickas av dessa moduler.
