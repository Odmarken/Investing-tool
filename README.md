# Signaldesk — NQ & Guld

En signaldesk för Nasdaq-terminen och guld som körs helt i webbläsaren, plus en
TradingView-feed som gör att signalmotorn räknar på dina realtidsstaplar i stället
för Yahoos fördröjda data.

| Fil | Vad den gör |
|---|---|
| `nq-guld-signaldesk_4.html` | Hela dashboarden — grafer, signalmotor, nyhetsflöden |
| `dev-server.js` | Lokal server: serverar sidan, en CORS-proxy och en kopia av workern |
| `worker.js` | Cloudflare Worker som tar emot TradingView-alerts och serverar staplarna |
| `wrangler.toml` | Inställningar för utrullning av workern |
| `signaldesk-feed.pine` | Pine-skriptet som skickar staplarna från TradingView |
| `package.json` | Startkommandon (`npm start`, `npm run demo`, …) |

---

## 1. Kör lokalt

```bash
npm start
```

Öppna sedan **http://localhost:8080/**. Ingen installation behövs — servern använder
bara Node (18 eller senare).

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

Du får en URL av typen `https://signaldesk-feed.dittnamn.workers.dev`.
Testa den: `https://.../status` ska svara med `{"NQ":{"bars":0,...}}`.

## 3. Lägg in URL:en i dashboarden

Öppna sidan → **⚙ Inställningar** → *TradingView-feed — Cloudflare Worker-URL*
→ klistra in URL:en (utan avslutande snedstreck) → **Spara & uppdatera**.

## 4. Lägg Pine-skriptet på grafen

Öppna `CME_MINI:NQ1!` i **5-minutersintervall** på TradingView.
Pine Editor → klistra in `signaldesk-feed.pine` → *Add to chart*.
Sätt **Hemlig nyckel** till samma värde som `FEED_KEY`, och **Symbolkod** till `NQ`.

## 5. Skapa alertet

Högerklicka i grafen → *Add alert*.

| Fält | Värde |
|---|---|
| Condition | Signaldesk feed |
| — | **Any alert() function call** |
| Trigger | Once per bar close |
| Expiration | så långt fram som ditt abonnemang tillåter |
| Notifications → Webhook URL | `https://.../ingest` |

Skapa alertet. Upprepa steg 4–5 för `COMEX:GC1!` med symbolkoden `GC`.

## 6. Kontrollera

Efter första stapelstängningen ska `https://.../status` visa `bars: 1`,
och dashboarden ska få en grön **TradingView live**-bricka uppe till höger.
Fottexten byter till *"TradingView realtid via egen webhook"*.

Säger brickan **TV-feed nås inte** stämmer inte URL:en, och **TV-feed tyst** betyder
att workern svarar men att ingen ny stapel kommit på ett tag — då är det alertet
som slutat skicka.

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
* **Utan lokal server** fungerar sidan fortfarande — då används de publika
  proxyerna i proxylistan, men de är trögare och faller ofta bort. Går ingen
  fram visas simulerad data med en tydlig varningsbanner.
