https://odmarken.github.io/Investing-tool/

# Riptide Investments Panel

En handelspanel för Nasdaq-terminen som körs helt i webbläsaren, plus en
TradingView-feed som gör att signalmotorn räknar på dina realtidsstaplar i stället
för Yahoos fördröjda data.

> **Guld är pausat.** Dashboarden kör bara NQ. Workern och Pine-skriptet klarar
> fortfarande `GC`, så för att ta tillbaka guld räcker det att avkommentera
> `GC`-raden i `INSTR` i html-filen — resten av sidan följer med av sig själv.

| Fil | Vad den gör |
|---|---|
| `index.html` | Hela dashboarden — grafer, signalmotor, nyhetsflöden |
| `dev-server.js` | Lokal server: serverar sidan, en CORS-proxy och en kopia av workern |
| `worker.js` | Cloudflare Worker som tar emot TradingView-alerts och serverar staplarna |
| `wrangler.toml` | Inställningar för utrullning av workern |
| `riptide-feed.pine` | Pine-skriptet som skickar staplarna från TradingView |
| `package.json` | Startkommandon (`npm start`, `npm run demo`, …) |

---

## 1. Kör lokalt

```bash
npm start
```

Öppna sedan **http://localhost:8080/**. Ingen installation behövs — servern använder
bara Node (18 eller senare) utan ett enda beroende.

Servern ger dig tre saker:

* **Sidan** på `/`.
* **En CORS-proxy** på `/proxy?url=…`. Yahoo och de flesta RSS-flöden blockerar
  anrop direkt från webbläsaren, och de publika proxyerna är opålitliga. Den lokala
  proxyn hämtar via din egen uppkoppling, och sidan fyller i den åt dig första
  gången du öppnar den från `localhost` — du ser den under ⚙ Inställningar.
* **Workern** på `/feed` — samma `worker.js` som körs i Cloudflare, men med
  staplarna i `.dev-bars.json` i stället för KV. Alltså `/feed/ingest`,
  `/feed/bars?s=NQ` och `/feed/status`.

Inställningarna du gör i ⚙-rutan sparas i webbläsaren och gäller nästa gång också.

Andra flaggor:

```bash
node dev-server.js --port 9000     # annan port
node dev-server.js --host 0.0.0.0  # nå sidan från andra datorer (proxyn blir då öppen)
npm run demo                       # fyller feeden med PÅHITTADE staplar
```

`npm run demo` är till för att prova kedjan innan TradingView är på plats: den
lägger in 120 låtsasstaplar per symbol via `/feed/ingest` och en ny vid varje
stapelstängning. Lägg in `http://localhost:8080/feed` under ⚙ Inställningar så
tänds den gröna **TradingView live**-brickan. Priserna är påhittade — kör aldrig
demoläget när du tittar på riktiga nivåer. Låtsasstaplarna hamnar i en egen fil
(`.dev-bars.demo.json`) och blandas aldrig med riktiga.

---

## 2. Rulla ut workern till Cloudflare

Flödet i skarpt läge: TradingView-alert → webhook → din Cloudflare Worker → dashboarden.

```bash
npm install -g wrangler
wrangler login

wrangler kv namespace create BARS
# klistra in id:t som skrivs ut i wrangler.toml

wrangler secret put FEED_KEY
# hitta på ett långt lösenord — samma värde ska in i Pine-skriptet

wrangler deploy
```

Du får en URL av typen `https://riptide-feed.dittnamn.workers.dev`.
Testa den: `https://.../status` ska svara med `{"NQ":{"bars":0,...}}`.

## 3. Lägg in URL:en i dashboarden

Öppna sidan → **⚙ Inställningar** → *TradingView-feed — Cloudflare Worker-URL*
→ klistra in URL:en (utan avslutande snedstreck) → **Spara & uppdatera**.

## 4. Lägg Pine-skriptet på grafen

Öppna `CME_MINI:NQ1!` i **5-minutersintervall** på TradingView.
Pine Editor → klistra in `riptide-feed.pine` → *Add to chart*.
Sätt **Hemlig nyckel** till samma värde som `FEED_KEY`, och **Symbolkod** till `NQ`.

## 5. Skapa alertet

Högerklicka i grafen → *Add alert*.

| Fält | Värde |
|---|---|
| Condition | Riptide feed |
| — | **Any alert() function call** |
| Trigger | Once per bar close |
| Expiration | så långt fram som ditt abonnemang tillåter |
| Notifications → Webhook URL | `https://.../ingest` |

Ett alert per instrument. Guld är pausat i dashboarden, så `NQ` räcker.

## 6. Kontrollera

Efter första stapelstängningen ska `https://.../status` visa `bars: 1`,
och dashboarden ska få en grön **TradingView live**-bricka uppe till höger.
Fottexten byter till *"TradingView realtid via egen webhook"*.

Säger brickan **TV-feed nås inte** stämmer inte URL:en, och **TV-feed tyst** betyder
att workern svarar men att ingen ny stapel kommit på ett tag — då är det alertet
som slutat skicka.

---

## Så graderas setuperna

Motorn kör fyra strategifamiljer parallellt och väger ihop dem till en grad per setup.
Graden säger hur mycket av marknaden som talar för riktningen just nu:

| Familj | Röstar för riktningen när … |
|---|---|
| **Trendfortsättning** | EMA-stacken pekar åt hållet (trendpoäng över ±12) och priset ligger på rätt sida VWAP |
| **Likviditetssvep** | en tidigare extrempunkt har svepts de senaste 16 staplarna och priset tagit tillbaka nivån |
| **Range-brott** | en konsolidering på 0,8–2,6 ATR har brutits med minst 0,25 ATR, färskt och med volym bakom |
| **ICT-modell** | ett svep av stopparna följs av en market structure shift åt andra hållet |

| Grad | Betyder |
|---|---|
| **A** | minst tre av fyra familjer pekar åt samma håll — mest potential |
| **B** | två av fyra |
| **C** | en eller ingen — lägst potential |

**ICT-familjen** letar hela kedjan: priset tar ut en tidigare swingnivå och stänger
tillbaka innanför (stopparna är inhämtade), bryter sedan strukturen åt andra hållet
(*market structure shift*). Rörelsen som bryter strukturen lämnar oftast en obalans
efter sig — ett *fair value gap* — och entryn läggs mitt i det gapet. Finns inget gap
kvar används 70,5 %-retracementet av benet (*OTE*). Stoppen ligger bortom svepet och
målet vid nästa likviditetsklump. Setupen väger tyngre om nivån ligger i rätt halva
av benet (*discount* för köp, *premium* för sälj) och om den formades i en killzone
(London 02–05, New York AM 08:30–11:00, New York PM 13:30–16:00, New York-tid).

Rangen som ett brott mäts mot letas fram genom att växa bakåt från flera startpunkter
så länge boxen håller sig under 2,2 ATR. Ett trendben faller därmed bort av sig självt,
och ett svep som spikar ur boxen förstör inte mätningen.

Graden styr både ordningen i listan och konfidensen (A ger +15, B +7, och varje familj
som pekar åt *motsatt* håll drar av 4). Två setups som vill in på samma nivå åt samma
håll slås ihop till ett kort, med båda motiveringarna kvar.

Överst i signallistan står strategiläget — pilarna visar vad varje familj röstar på
just nu, så det syns direkt varför ingen A-setup finns. Knapparna **A** och **B** i
panelhuvudet filtrerar listan.

---

## Signalkärnan och backtestet

Längst ned på sidan sitter två sektioner.

**Signalkärnan** sitter överst i mittenkolumnen och är en levande bild av vad motorn
matas med. Varje gång något faktiskt händer — Yahoo svarar, TradingView-feeden levererar
en stapel, ett RSS-flöde landar, indikatorerna räknas om, nyhetsbiasen vägs, setuperna
byggs — skickas ett datapaket in mot kärnan, med tecken som flimrar på vägen, och en
chockvåg går ut när det landar. Radarsvepet och aktivitetsmätaren går fortare ju mer som
strömmar in. Längst ned i rutan skriver kärnan ut vad den just läste, rad för rad och
tecken för tecken: staplar från Yahoo, EMA/ATR/RSI/VWAP-värden, rubriker, nyhetsbias,
hur de fyra familjerna röstar, ICT-kedjan (svep → MSS → FVG) och vilken setup som är bäst
just nu. Kärnan lyser grönt när det samlade läget är positivt och rött när det är negativt,
och siffran i mitten är antalet setups. Animationen pausar när fliken inte syns.

Varje signalkort visar dessutom vilken familj setupen kommer från — **TREND**, **SVEP**,
**BROTT** eller **ICT** — bredvid gradbrickan. Är två familjer sammanslagna till ett kort
står den andra som `+ SVEP` efter.

**Backtestet** kör exakt samma regler stapel för stapel på ungefär en månads
femminutershistorik för NQ:

* Kontot startar på **50 000 USD** och riskerar **1 % av rådande kapital** per affär,
  så vinsterna räknas på växande insats.
* Entry, stopp och mål tas från signalen. Nås både stopp och mål inom samma stapel
  räknas stoppen — det är den försiktiga tolkningen.
* En tick slippage in och en ut är avdragen.
* Positionen stängs efter 78 staplar om varken stopp eller mål nåtts.
* Kontot håller **en position i taget** och tar alltid den högst graderade setupen.

Korten per grad räknar i stället **varje enskild setup** var för sig. Annars går
graderna inte att jämföra, eftersom kontot nästan alltid tar A eller B och de lägre
graderna aldrig får visa vad de gick för.

Backtestet körs om var femtonde minut i bakgrunden, med pauser så att sidan inte
hakar upp sig. Kurvan visar vad reglerna faktiskt gav — den kan falla.

---

## Att veta

* **Uppvärmning.** Alerts skickar bara framåt i tiden, aldrig historik.
  Därför hämtas ~260 staplar från Yahoo som grund, och TradingViews staplar
  läggs ovanpå. EMA 50/200 och ATR är alltså uppvärmda från start,
  medan de senaste staplarna är dina realtidsdata.
* **Stängda staplar.** TradingView skickar vid stapelstängning, så serien
  slutar på senast stängda 5-minutersstapel. Den pågående stapeln finns inte
  med — vilket är rätt, eftersom signalmotorn ändå bara räknar på stängda staplar.
* **KV-kvoten.** Gratisnivån tillåter 1 000 skrivningar per dygn. Två symboler
  i 5-minutersintervall dygnet runt ger 576. Lägger du till fler instrument
  eller kortare intervall spränger du taket.
* **Alerts löper ut.** TradingView-alerts har ett utgångsdatum. Sätt det så
  långt fram ditt abonnemang tillåter och lägg en påminnelse om att förnya.
* **Realtid kräver CME-tillägget.** Utan det skickar alertet fördröjda priser,
  och då är hela kedjan ingen förbättring mot Yahoo.
* **Nya symboler** läggs till på tre ställen som måste stämma överens:
  `SYMBOLS` i `worker.js`, `options` i Pine-skriptet och `INSTR` i html-filen.
  `SYMS` i html-filen härleds ur `INSTR`, så resten av sidan följer med.
* **Utan lokal server** fungerar sidan fortfarande — då används de publika
  proxyerna i proxylistan, men de är trögare och faller ofta bort. Går ingen
  fram visas simulerad data med en tydlig varningsbanner.
