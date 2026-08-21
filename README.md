https://odmarken.github.io/Investing-tool/

# Riptide Investments Panel

En handelspanel för mikroterminen på Nasdaq (**MNQ**) som körs helt i webbläsaren, plus en
TradingView-feed som gör att signalmotorn räknar på dina realtidsstaplar i stället
för Yahoos fördröjda data.

> **Signaler och graf går på MNQ**, mikroterminen: samma index och samma tick som NQ,
> men $2 per punkt i stället för $20. Nyhetsanalysen och nyhetsbiasen räknas fortfarande
> på NQ/Nasdaq-100 — det är samma marknad, och rubrikerna handlar om indexet. Korten visar
> risk och mål i dollar per kontrakt, räknat på mikrokontraktets värde.
>
> **Guld är pausat.** Dashboarden kör bara NQ. Workern och Pine-skriptet klarar
> fortfarande `GC`, så för att ta tillbaka guld räcker det att avkommentera
> `GC`-raden i `INSTR` i html-filen — resten av sidan följer med av sig själv.

| Fil | Vad den gör |
|---|---|
| `index.html` | Dashboarden — grafer, kort, nyheter, demokonto |
| `motor.js` | Signalmotorn: indikatorer, de fyra familjerna, ICT, gradering. Delas av sidan och workern |
| `konto.js` | Demokontot på serversidan — öppnar, stänger och sparar i KV |
| `dev-server.js` | Lokal server: serverar sidan, en CORS-proxy och en kopia av workern |
| `worker.js` | Cloudflare Worker som tar emot TradingView-alerts och serverar staplarna |
| `wrangler.toml` | Inställningar för utrullning av workern |
| `riptide-feed.pine` | Pine-skriptet som skickar staplarna från TradingView |
| `package.json` | Startkommandon (`npm start`, `npm run demo`, …) |

---

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

* Startkapital **50 000 USD**, **5 MNQ-kontrakt** per affär, 2 $ per punkt.
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
* **Klicka på en rubrik** i nyhetsflödet så fälls en flik ned med hela analysen:
  källa, publiceringstid, kategori, hur hårt nyheten väger på NQ (skala ±6), alla
  slutsatser regelmotorn drog, flödets egen text och en länk till källan. Ett kort
  i taget är öppet, och det förblir öppet när listan uppdateras. Samma sak i den
  svenska panelen, fast med flödestexten i stället för analysen.
* **Utan lokal server** fungerar sidan fortfarande — då används de publika
  proxyerna i proxylistan, men de är trögare och faller ofta bort. Går ingen
  fram visas simulerad data med en tydlig varningsbanner.
