https://odmarken.github.io/Investing-tool/

# Riptide Investments Panel

En handelspanel för mikroterminen på Nasdaq (**MNQ**) som körs helt i webbläsaren, plus en
TradingView-feed som gör att signalmotorn räknar på dina realtidsstaplar i stället
för Yahoos fördröjda data.

> **Signaler och graf går på MNQ**, mikroterminen: samma index och samma tick som NQ,
> men $2 per punkt i stället för $20. Nyhetsanalysen och nyhetsbiasen räknas fortfarande
> på NQ/Nasdaq-100 — det är samma marknad, och rubrikerna handlar om indexet. Korten visar
> antal kontrakt, risk och mål i dollar för hela affären, räknat på mikrokontraktets värde.
>
> **Guld är pausat.** Dashboarden kör bara NQ. Workern och Pine-skriptet klarar
> fortfarande `GC`, så för att ta tillbaka guld räcker det att avkommentera
> `GC`-raden i `INSTR` i html-filen — resten av sidan följer med av sig själv.

| Fil | Vad den gör |
|---|---|
| `index.html` | Dashboarden — grafer, kort, nyheter, demokonto |
| `motor.js` | Signalmotorn: indikatorer, de fyra familjerna, ICT, gradering. Delas av sidan och workern |
| `konto.js` | Demokontot i Cloudflare-workern — öppnar, stänger och sparar i KV |
| `functions/index.js` | Samma sak på Firebase: cron var 5:e minut, proxy, ingest och Firestore |
| `firebase-config.js` | Projektets publika nycklar — tomt projectId stänger av Firebase |
| `firebase.json`, `firestore.rules`, `.firebaserc` | Hosting, regler och projekt |
| `dev-server.js` | Lokal server: serverar sidan, en CORS-proxy och en kopia av workern |
| `worker.js` | Cloudflare Worker som tar emot TradingView-alerts och serverar staplarna |
| `wrangler.toml` | Inställningar för utrullning av workern |
| `riptide-feed.pine` | Pine-skriptet som skickar staplarna från TradingView |
| `trana.mjs` | Mätriggen: spelar upp historiken genom motorn och tränar modellen |
| `modell.js` | Vikterna mätriggen kom fram till, plus testsiffrorna |
| `package.json` | Startkommandon (`npm start`, `npm run demo`, …) |

---

## Firebase — kontot live dygnet runt

**Utrullat och igång:**

| | |
|---|---|
| Sidan | https://riptide-investing-tool.web.app |
| API | `https://europe-north1-riptide-investing-tool.cloudfunctions.net/api` — eller `/api/…` på sidans egen adress |
| Cron | `kontoCron` i `europe-west1`, var femte minut, tidszon Europe/Stockholm |
| Databas | Firestore `eur3`, dokumentet `riptide/konto` |
| TradingView-webhook | `https://riptide-investing-tool.web.app/api/ingest` |

Cloud Scheduler finns inte i `europe-north1`, så cronen ligger i `europe-west1` medan
API-funktionen ligger närmare Sverige. Det märks inte i användningen.


Det här är vägen som gör kontot gemensamt för alla enheter och som räknar vidare
när allt är stängt. Molnfunktionen kör signalmotorn var femte minut och skriver till
Firestore; sidan lyssnar på dokumentet och uppdateras **direkt** när något händer,
utan att fråga om och om igen.

### En gång

1. Skapa projektet på console.firebase.google.com och klistra in webbkonfigurationen
   i `firebase-config.js` (den ligger redan ifylld för `riptide-investing-tool`).
2. Skapa databasen: **Firestore Database → Skapa databas → produktionsläge**, plats
   `eur3` eller `europe-north1`.
3. Uppgradera till **Blaze**. Funktioner kräver det, och på gratisplanen får de inte
   ens ringa ut till Yahoo. Kostnaden landar ändå kring noll: 2 miljoner anrop ingår
   per månad och cronen använder cirka 8 600.
4. Logga in och rulla ut:

```bash
npx firebase login
npx firebase functions:secrets:set FEED_KEY     # samma nyckel som TradingView-alertet
npx firebase deploy
```

`deploy` tar med tre saker: funktionerna (`kontoCron` + `api`), Firestore-reglerna och
sidan på Firebase Hosting. `motor.js` kopieras automatiskt in i `functions/` först, så
molnet och skärmen kör exakt samma signalmotor.

### Vad du får

| | |
|---|---|
| `kontoCron` | Var femte minut: hämtar staplar, bygger setups, öppnar A- och B-affärer och stänger dem som nått stopp eller mål |
| `GET /api/proxy?url=…` | Marknadsdata och RSS åt sidan, med en lista över tillåtna värdar |
| `POST /api/ingest` | TradingView-alertets webhook, samma format som workern |
| `GET /api/bars?s=NQ` | Staplarna som kommit in därifrån — sidan lägger dem över Yahoo |
| `GET /api/live` | Det femminutersfack som just nu byggs, för den som inte lyssnar på Firestore |
| `GET /api/tick?k=FEED_KEY` | Kör ett varv på studs |
| `GET /api/konto` | Kontot som JSON, för den som inte vill prata Firestore |

Sidan kan ligga var som helst — Firebase Hosting, GitHub Pages eller `npm start`.
`apiBas` i `firebase-config.js` pekar på funktionens fulla adress, så proxyn och kontot
fungerar från alla tre.

Kontot nollställs med `npx firebase firestore:delete riptide/konto` eller från konsolen.

## Publik adress (GitHub Pages)

Sidan fungerar lika bra utlagd publikt — men bara om workern är utrullad och dess adress
är inlagd under ⚙ Inställningar. Då hämtas marknadsdata genom workerns proxy i stället för
de opålitliga publika proxyerna, och demokontot läses från KV. Utan worker-URL på en publik
adress får du de publika proxyerna, och de faller ofta bort: räkna med simulerad data.

Adressen sparas per webbläsare, så den ska in en gång på datorn och en gång på telefonen.
Sedan visar båda samma konto, samma affärer och samma siffror.

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

> **Kör du Firebase — som det här projektet gör — hoppar du över steg 2 och 3.**
> Webhooken går rakt på `https://riptide-investing-tool.web.app/api/ingest`, staplarna
> hamnar i Firestore och sidan hämtar dem själv från `/api/bars`. Ingen worker-URL
> behöver fyllas i under ⚙. Nyckeln i Pine-skriptet ska vara samma värde som
> hemligheten `FEED_KEY` i Firebase. Fortsätt på steg 4.

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

Öppna `CME_MINI:MNQ1!` i **5-minutersintervall** på TradingView.
Pine Editor → klistra in `riptide-feed.pine` → *Add to chart*.
Sätt **Hemlig nyckel** till samma värde som `FEED_KEY`, och **Symbolkod** till `NQ` —
koden är feedens nyckel och ska stå kvar som `NQ` även när skriptet ligger på MNQ-grafen.

## 5. Skapa alertet

Högerklicka i grafen → *Add alert*.

| Fält | Värde |
|---|---|
| Condition | Riptide feed |
| — | **Any alert() function call** |
| Trigger | Once per bar close |
| Expiration | så långt fram som ditt abonnemang tillåter |
| Notifications → Webhook URL | Firebase: `https://riptide-investing-tool.web.app/api/ingest` · worker: `https://.../ingest` |

Ett alert per instrument. Guld är pausat i dashboarden, så `NQ` räcker.

## 6. Kontrollera

Efter första stapelstängningen ska `https://riptide-investing-tool.web.app/api/bars?s=NQ`
(eller workerns `https://.../status`) visa en stapel, och dashboarden ska få en grön
**TradingView live**-bricka uppe till höger. Innan dess står det **TV-feed tom**.
Fottexten byter till *"TradingView realtid via egen webhook"*.

Säger brickan **TV-feed nås inte** stämmer inte URL:en, och **TV-feed tyst** betyder
att servern svarar men att ingen ny stapel kommit på ett tag — då är det alertet
som slutat skicka. Så länge feeden lever slutar grafen på den senaste stängda
TradingView-stapeln; Yahoos pågående stapel kastas, eftersom den är fördröjd.

Siffrorna blir förstås inte mer exakta än datan i din TradingView: står det **D**
för delayed i symbolfältet skickar alertet fördröjda priser, bara med annan
fördröjning än Yahoo. Realtid kräver CME-abonnemanget hos TradingView, och
webhooks kräver ett betalt TradingView-konto.

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
| **C** | en eller ingen — lägst potential, handlas inte |

C-setups visas i listan som analys men går aldrig till aktiv och tas aldrig av demokontot.

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

## Signalkärnan och demokontot

Längst ned på sidan sitter två sektioner.

**Signalkärnan** sitter överst i mittenkolumnen och är en levande bild av vad motorn
matas med. Varje gång något faktiskt händer — Yahoo svarar, TradingView-feeden levererar
en stapel, ett RSS-flöde landar, indikatorerna räknas om, nyhetsbiasen vägs, setuperna
byggs — skickas ett datapaket in mot kärnan, med tecken som flimrar på vägen, och en
chockvåg går ut när det landar. Radarsvepet och aktivitetsmätaren går fortare ju mer som
strömmar in. Längst ned i rutan skriver kärnan ut vad den just läste, rad för rad och
tecken för tecken: staplar från Yahoo, EMA/ATR/RSI/VWAP-värden, rubriker, nyhetsbias,
hur de fyra familjerna röstar, ICT-kedjan (svep → MSS → FVG) och vilken setup som är bäst
just nu. Kärnan lyser grönt när det samlade läget är positivt och rött när det är negativt.
I mitten sitter en HUD-kärna märkt **P** — segmentringar som roterar åt olika håll,
skalstreck runt kanten och en svepande linje i den inre skivan. Två noder märkta **M**
matar in i den ovanifrån och en nod märkt **E** tar emot under; de står stilla, det är
bara kärnan som rör sig. Animationen pausar när fliken inte syns.

Varje signalkort visar dessutom vilken familj setupen kommer från — **TREND**, **SVEP**,
**BROTT** eller **ICT** — bredvid gradbrickan. Är två familjer sammanslagna till ett kort
står den andra som `+ SVEP` efter.

**Demokontot** längst ned är pappershandel i realtid — inga riktiga pengar, men det
beter sig som ett terminskonto:

* Startkapital **50 000 USD** och **högst 750 $ i förlust per affär** (`MAX_RISK` i
  `motor.js`). Antalet MNQ-kontrakt räknas ut per setup: `golv(750 / (stopp i punkter × 2 $))`,
  minst ett. Sitter stoppen långt bort — bakom ett stöd eller en swinglow — blir kontrakten
  färre, sitter den tätt blir de fler, men en stoppad affär kostar ungefär lika mycket varje
  gång. Vinsten får bli vad R:R ger. Samma tal används av signalkorten, molnfunktionen och
  kontot, så alla tre visar samma storlek.
* När en setup går aktiv läggs hela braketten automatiskt: fyllning, stopp och mål.
  Positionen hålls tills ett av dem nås.
* **Bara A och B handlas.** C-setups är för svaga och går inte ens till aktiv längre.
* Panelen visar kapital, realiserat och öppet resultat, marginal (100 $ per kontrakt,
  ett antagande om dagmarginal), fri marginal, exponering och hävstång, plus
  träffsäkerhet, snitt per affär, bästa och sämsta, största nedgång, en kapitalkurva,
  utfall per grad och de åtta senaste affärerna.
* Utfallet avgörs på 5-minutersstaplarnas högsta och lägsta. Alla staplar som passerat
  sedan förra kollen gås igenom, så en position som stod öppen medan sidan var stängd
  får rätt utfall och rätt tidpunkt när du kommer tillbaka. Nås både stopp och mål inom
  samma stapel räknas stoppen. Inga avgifter eller slippage är avdragna.

### Två lägen: lokalt eller i workern

Kontot kan ligga på två ställen, och sidan väljer själv:

**Utan Worker-URL — lokalt.** Kontot sparas i webbläsaren (`localStorage`). Det överlever
att du stänger fliken och datorn, och när du kommer tillbaka spelas de staplar som
passerat upp så att affärer får rätt utfall. Men det tickar bara när sidan är öppen, och
telefonen får ett eget konto — `localhost` och GitHub Pages räknas som olika platser.

**Med Worker-URL — i molnet.** Lägg in workerns adress under ⚙ Inställningar, så tar
servern över: kontot ligger i KV och workerns cron räknar om det **var femte minut, dygnet
runt, utan att någon sida är öppen**. Datorn och telefonen ser exakt samma siffror, och
sidan blir bara en skärm mot kontot. Rutan säger *"igång sedan … · servern · uppdaterad …"*
när det läget är på.

Det som gör det möjligt är att signalmotorn ligger i en egen fil, `motor.js`, som både
sidan och workern importerar. Samma indikatorer, samma fyra familjer, samma ICT-kedja och
samma gradering räknas alltså på båda ställena — kontot i molnet kan inte glida isär från
det du ser på skärmen.

Workerns kontoslutpunkter:

| | |
|---|---|
| `GET /proxy?url=…` | hämtar Yahoo och RSS åt sidan, så en publik adress får live-data |
| `GET /konto` | kapital, öppna positioner, affärer och de senaste setuperna |
| `GET /konto/tick?k=FEED_KEY` | kör ett varv på studs, för felsökning |
| `POST /konto/nollstall` med `{"k":"FEED_KEY"}` | börja om från 50 000 |

Proxyn släpper bara igenom marknads- och nyhetskällor (Yahoo, Google News, CNBC,
Investing, FinancialJuice, FXStreet, MarketWatch, DI, DN, SVT med flera) — annars vore
workern en öppen proxy för vem som helst som hittar adressen.

Cron-schemat står i `wrangler.toml` (`crons = ["*/5 * * * *"]`) och följer med vid
`wrangler deploy`. Lokalt gör `npm start` samma sak: dev-servern kör ett varv vid start
och sedan var femte minut, så du kan prova hela kedjan innan du rullar ut.

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
* **Telefonvänlig.** Under 1240 px lägger sig kolumnerna på rad, under 680 px byter
  toppbaren till två rader, knapparna blir fingerstora, korten smalnar av och graferna
  blir lägre. Signalkärnan ritar kortare nodetiketter och en lägre ruta på smal skärm,
  och avläsningsloggen kapas efter kanten. Inställningsrutan blir helskärm, och fälten
  får 16 px text på pekskärm så att iOS inte zoomar in när du klickar i dem. Mätt i
  webbläsaren vid 390 px: sidans bredd är 382 px, alltså inget vågrätt skrollande —
  utom tickerbandet, som ska skrollas.
* **ACTIVE betyder att affären är igång.** En setup blir aktiv först när priset
  faktiskt träffar entrynivån — att ligga nära räcker inte, och en omladdning fyller
  inte gamla nivåer. Därefter står den kvar som aktiv tills målet eller stoppen nås,
  även om motorn slutar föreslå den och även om priset går långt ifrån entryn.
  Pågående affärer ligger överst i listan, och kortets motivering byter innehåll:
  i stället för villkoret visas när den fylldes, hur den ligger i R, hur långt det är
  kvar till mål och stopp, och varför setupen är bra. Avslutade affärer ligger kvar
  i en halvtimme så att du ser utfallet.
* **Grafen går att zooma och dra.** Dra i grafen för att panorera bakåt i historiken.
  **Dra i tidsaxeln längst ned** (eller i prisaxeln till höger) för att sträcka ut
  staplarna — åt höger blir de bredare och färre, åt vänster smalare och fler. Scrolla
  eller nyp zoomar också, dubbelklick eller *Återställ* tar dig tillbaka till de senaste
  staplarna, och knapparna **−**/**+** gör samma sak. Pekaren byter form när du är över
  axeln så du ser vilket läge du är i.
* **Fyra nivåer, räknade på 15-minutersstaplar.** Grafen visar 5m, men stöd och motstånd
  räknas på 15m — 5-minutersstaplarna i det synliga fönstret plus 180 staplar historik
  slås ihop till kvartsstaplar, svängpunkterna klustras till zoner inom 0,35 ATR och
  poängsätts på antal träffar, färskhet och närhet till priset. De två starkaste över
  priset ritas som **R1/R2** i gult och de två under som **S1/S2** i turkost, och de
  räknas om varje gång du zoomar, drar eller får ny data.
  TradingView-widgeten är borttagen — grafen är helt egen.
* **Kommande händelser** ligger överst i nyhetsflödet: nästa fem inplanerade
  makrosläpp med klockslag, nedräkning, prognos och föregående värde, hämtade från
  TradingViews publika kalender. Tunga släpp markeras rött, och är ett sådant inom
  45 minuter skriver sammanfattningen ut en varning om att vänta ut de första
  staplarna. Nedräkningen tickar varje halvminut, listan hämtas om var tjugonde varv.
* **Dra i prisaxeln** till höger för att sträcka priset i höjdled, som i TradingView —
  uppåt gör staplarna högre, nedåt plattar ut dem. Dubbelklick eller *Återställ* ger
  normal skala igen.
* **Klicka på en rubrik** i nyhetsflödet så fälls en flik ned med hela analysen:
  källa, publiceringstid, kategori, hur hårt nyheten väger på NQ (skala ±6), alla
  slutsatser regelmotorn drog, flödets egen text och en länk till källan. Ett kort
  i taget är öppet, och det förblir öppet när listan uppdateras. Samma sak i den
  svenska panelen, fast med flödestexten i stället för analysen.
* **Utan lokal server** fungerar sidan fortfarande — då används de publika
  proxyerna i proxylistan, men de är trögare och faller ofta bort. Går ingen
  fram visas simulerad data med en tydlig varningsbanner.


---

## Mätriggen och den lärda modellen

```bash
npm run trana
```

Riggen hämtar 5-minutersstaplar för MNQ, glider ett 1 100-staplars fönster genom
dem och låter **samma motor som sidan använder** generera setups. Varje setup
följs framåt i tiden med de fyllningar man faktiskt får, och kostnaderna dras av.

Staplarna cachas i `.staplar-cache.json` och **cachen växer**: Yahoo ger bara
60 dagar bakåt, men det som redan hämtats sparas. Kör riggen en gång i månaden
så finns det ett år om ett år — det är den enda gratisvägen förbi att 60 dagar
bara är ett enda marknadsklimat. Datasetet cachas i `.setups-cache.json` och
slängs automatiskt så snart `motor.js` ändras, för gamla setups är då en mätning
av en motor som inte finns längre. Båda filerna är gitignorerade.

### Vad riggen räknar med

| | |
|---|---|
| Limitorder | Nivån måste **handlas igenom**, inte bara nuddas. En limit som berörs med en tick hamnar längst bak i kön och fylls sällan. |
| Stopporder | Blir marknadsorder när nivån nås. Öppnar stapeln redan bortom nivån är det öppningskursen som gäller, plus en tick slippage. Det gäller ORB, brott, moment och varje utstoppning. |
| Kostnad | Spread (en tick) + courtage (1,24 $ tur och retur) ≈ 0,87 punkter per affär. |
| R | Räknas mot den risk affären dimensionerades på. En sämre fyllning än nivån syns som förlorad R, vilket är precis vad den kostar — kontrakten är redan köpta på det gamla stoppavståndet. |
| Testdelning | Vid ett **dygnsskifte**, inte mitt i en session. Sista 35 procenten av handelsdagarna är test, och varje testsetup bedöms av en modell som bara sett affärer från tidigare dagar. |
| Standardfel | Räknas på antalet **handelsdagar**, inte på antalet setups. Tusentals överlappande fönster ur samma stapelserie är inte tusentals oberoende observationer, och det är där de flesta backtester ljuger. |

### Nolltestet

Varje körning jämför motorn mot samma geometri med **slumpad riktning**: samma
stapel, samma riskavstånd, samma R:R, men entry vid stängning och myntkast om
hållet. Utan den referenspunkten går det inte att skilja "modellen fungerar"
från "marknaden gick upp i juli".

Ligger motorn inte tydligt över nolltestet mäter den marknadens drift, inte en
edge — och då är all finjustering av poäng och mål brus ovanpå ingenting.
Siffran sparas i `modell.js` som `test.nolltest`.

### Riktningen ensam

Målsökningen är motorns egen kod, och `rr` är både ett drag i modellen och en
produkt av den. Riggen mäter därför också riktningen utan någon exitlogik alls:
hur långt gick priset åt det håll signalen pekade, mätt i riskavstånd, tolv
staplar framåt? Jämförelsen är samma setups med riktningarna omkastade, plus en
driftkontroll ("alltid long" / "alltid short") så att en fallande period inte
förväxlas med information.

Mätningen görs från **fyllningsstapeln**, inte signalstapeln. En limitorder
fylls bara när priset går emot den, och eftersom bara fyllda setups har facit
skulle den senare referensen ge varje long en inbyggd nackdel som inte har med
riktningsvalet att göra.

Bär riktningen ingen information hjälper ingen måljustering i världen.

### Vad mätningen visar just nu

62 handelsdagar, 4 880 avgjorda setups, netto efter kostnader:

| | n | träff | snitt R |
|---|---|---|---|
| slumpad riktning (nolltest) | 4 844 | 35 % | −0,072 |
| **motorn som den är** | 4 880 | 37 % | **−0,052** |

Motorn ligger marginellt över nolltestet. Med ett standardfel på ±0,05 R per dag
och 21 dagar i testperioden är det inte en edge — det är ett oavgjort.

Per familj: trend −0,021 · ict −0,021 · svep −0,027 · orb −0,120 ·
brott −0,179 · moment −0,225. De tre översta går inte att skilja från varandra
eller från noll.

Graderingen sorterar fortfarande inte: **A −0,131, B +0,003, C −0,023**. Antalet
familjer som röstar åt samma håll säger ingenting om utfallet, vilket är väntat —
sex familjer som alla läser samma EMA-stack och samma VWAP är inte sex oberoende
röster, det är en röst räknad sex gånger.

Riktningen ensam: motorn +0,037 mot omkastad +0,033. Skillnaden är +0,004 med
t ≈ 0,02. Riktningsvalet bär alltså **noll** information över nästa timme.

Modellen **underkänns av sitt eget test** och `modell.js` skrivs med
`duger: false`. Då rör den ingenting: sidan använder de handsatta poängen precis
som förut.

**Kör om mätningen efter varje ändring i motorn.** Siffrorna gäller den motor som
fanns när de mättes, och riggen slänger datasetet själv när `motor.js` ändras.

### Det motorn inte ger signal på

Familjerna trend, svep och brott lade tidigare in **båda hållen varje stapel** och
lät en minuspoäng sköta urvalet. Resultatet var 272 setups per handelsdag, jämnt
fördelade över alla 24 timmar, där trendfamiljen ensam stod för 55 procent av allt
och för den sämsta avkastningen. Numera lägger varje familj bara det håll den
faktiskt röstat på, och range-brottet mäts mot den box rösten hittade i stället
för mot en box ingen kontrollerat. Det ger 83 setups per dag i stället, och
*ingen setup alls* är nu ett giltigt svar — panelen visar "Inga giltiga setups
just nu" och det är meningen.

Limitordrar måste dessutom ha kvar minst `MOTORCFG.minPullback` ATR att gå
(0,25 som standard). Förr fylldes 64 procent av alla setups redan på nästa
stapel: korten lovade en pullback till EMA21 och la i praktiken en marknadsorder.
Kravet gäller bara limits — en stopporder *ska* fyllas när nivån bryts, och
ärligheten ligger där i fyllningen i stället.

### Det som fortfarande inte är mätt

**Nyhetsspärren.** Skarpt läge låter dagens rubriker stänga av ena hållet
(`MOTORCFG.nyhetsSparr`), men historiska rubriker finns inte sparade, så
uppspelningen kör med bias 0 och båda hållen öppna. Riggen rapporterar long och
short var för sig som det närmaste vi kommer. Sätt `nyhetsSparr: false` för att
köra motorn utan en spärr som aldrig testats mot facit.

**Den halvfärdiga stapeln.** Skarpt läge räknar på det femminutersfack som just
byggs; uppspelningen räknar på stängda staplar. Det är en skillnad mellan träning
och verklighet som inte går att mäta bort med den här riggen.

### ORB — familjen med publicerad statistik bakom sig

Femte familjen är öppningsrangen 09:30–10:00 New York-tid, byggd på en studie av
6 142 ES- och NQ-dagar:

* bekräftelse är en **stängd** 5-minutersstapel utanför kanten (71,5 % fortsättning
  på NQ mot 67 % på bara en wick)
* stoppen ligger **inne i rangen**, vid mitten — uppmätt maximal motrörelse är
  ungefär 30–40 % av dagens ATR
* målet är en hel rangebredd bortom kanten
* vikten justeras för dubbelbrott (hackig dag), hur färskt brottet är, om rangen
  är vid eller hopklämd, och för att uppåtbrott historiskt är 8–10 procentenheter
  starkare än nedåtbrott

Den har bara 84 avgjorda setups på 62 dagar och är därför inte dömd åt något håll
ännu — men den mäts automatiskt vid varje `npm run trana`. Det är också den enda
familjen med ett dokumenterat underliggande fenomen bakom sig, vilket gör den
till den rimligaste kandidaten att få bära ensam om man vill ha en familj över
noll innan man lägger till nästa.

---

## Snabbare feed: var femte sekund i stället för var femte minut

`/api/ingest` väger ihop allt som kommer in i samma femminutersfack: öppningen är
den första observationen, högsta och lägsta rullar, stängningen är den senaste.
Det pågående facket ligger i `riptide/live` — ett dokument på ett par hundra byte
— och skrivs över till historiken först när facket är slut. Sidan lyssnar på det
med `onSnapshot`, så priset, grafens sista stapel, signalstatusarna och demokontot
uppdateras i samma ögonblick som molnet tagit emot stapeln. Utan Firestore
(localhost, GitHub Pages) frågar sidan efter `/api/live` var femte sekund i stället.

Så här väljer du takt i TradingView — samma skript, bara ett annat grafintervall:

| Grafintervall | Uppdatering | Anrop per dygn | Kommentar |
|---|---|---|---|
| 5 minuter | var 5:e minut | ~280 | dagens läge, räcker gott |
| 1 minut | varje minut | ~1 400 | säker och billig kompromiss |
| 5 sekunder | var 5:e sekund | ~17 000 | kräver Premium; nära TradingViews takgränser |

Kostnaden i Firestore är ungefär en dollar i månaden på 5-sekundersnivån och
försumbar på 1-minutersnivån. Börja på 1 minut — hoppet från fem minuter till en
minut är det som märks mest, och det belastar varken abonnemanget eller kontot.
