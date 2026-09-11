# Fryst protokoll: aktivt momentum med SL och TP

Fryst 2026-09-11 19:43 UTC, före hämtning och resultat för denna jämförelse.

## Syfte och evidensgräns

Jämför tre förbestämda kortare varianter av momentumstrategin. Detta är retrospektiv forskning. Dagarna har förekommit i tidigare forskning på spotpriser; den kronologiska valideringen är därför **inte ett orört test**. Resultaten kan inte visa att strategin är bäst eller garantera framtida vinst. Inga profiler läggs till eller ändras efter resultatsökning.

## Data och perioder

- Coins: BTC, ETH, SOL, XRP, DOGE, SHIB och PEPE. Bybits offentliga USDT-perpetualkontrakt enligt `bybit-contracts.js`; SHIB1000USDT och 1000PEPEUSDT normaliseras till en underliggande token.
- Källor: Bybit V5 `market/kline`, `market/mark-price-kline`, `market/funding/history` med 15-minutersstaplar för affärspris och markpris.
- Hämtning: 2026-03-06 00:00 UTC till 2026-09-10 00:00 UTC, slut exklusivt.
- Uppvärmning: 6–13 mars. Utveckling/urval: 14 mars–30 juni. Kronologisk validering: 1 juli–31 augusti. 1–9 september redovisas beskrivande och får inte ändra kandidatvalet.
- Endast kompletta timstaplar används i signaler. Beslut och inträde sker tidigast vid nästa timmes öppning efter signalens sista stängda stapel.
- Saknade, ogiltiga eller icke sammanhängande 15-minuters- och markstaplar stoppar jämförelsen. Fundinghändelser kontrolleras för unika tider och rimliga intervall. Historiska förändringar i fundingintervall är en databegränsning.

## Frysta signalprofiler

Lång position när snittet av 14-, 28- och 56-timmars avkastning är positivt; välj den kvalificerade coin med högst momentum. Endast en position åt gången. Profilerna definieras gemensamt i `crypto-momentum-active-signal.js`.

| Profil | Stop loss-avstånd | Vinstmål | Max hålltid | Ytterligare villkor |
|---|---|---|---|---|
| pulse12 | max(2 × ATR14, 0,5 % av priset) | 2 R | 12 timmar | Inget |
| pulse24 | max(2 × ATR14, 0,5 % av priset) | 2 R | 24 timmar | Inget |
| trend24 | max(2 × ATR14, 0,5 % av priset) | 3 R | 24 timmar | Stängning över föregående sex timmars högsta |

Fasta SL och TP från signal/inträde; ingen efterhandsoptimering eller trailing stop. Tidsutgång vid första observerbara 15-minutersöppning då maxtiden passerats. Nästa köp tidigast vid nästa timbeslut som ligger minst en timme efter senaste avslut. Existerande position överlever skiftet mellan utveckling och validering inte: varje delperiod börjar med 100 dollar och inga positioner.

## Utförande och jämförbar risk

- Forskningsrisk är högst 0,5 % av dåvarande kontovärde vid normal SL inklusive båda avgifterna och antagen slippage, med högst 2 × kontoexponering. Detta jämför signalkvalitet och är **inte** användarens valda 50-procentiga risk. Resultat med 50 % måste redovisas separat och får inte väljas genom dessa perioder.
- Marknadsavgift 0,055 % per sida. Grundantagande slippage 0,05 % per sida; stresskörning 0,10 % per sida. Samma signalprofiler i båda.
- Inträdesslippage läggs på observerad öppning. Fast stopp och mål bygger på det faktiskt simulerade inträdet och signalens frysta stoppavstånd. Storlek avrundas inte till kontraktets ordersteg i denna signaljämförelse.
- Funding tas från publicerad historik med markprisets 15-minutersöppning vid betalning. Endast position som fanns före betalningstidpunkten betalar eller får funding; inträde på samma tidsstämpel betalar inte.
- Stop loss först om både SL och TP träffas i samma 15-minutersstapel. Gap genom stop fylls till sämre öppningspris, därefter slippage; TP fylls konservativt vid mål, därefter slippage, utan positiv gapbonus.
- Nettovärde inkluderar bokförd funding och avgifter samt beräknad avslutsavgift/slippage på öppna innehav. Maxnedgång mäts på 15-minutersstängningar; extrema rörelser inom stapeln kan därför underskattas. Kvarvarande position stängs på delperiodens sista stängning.

## Urval och rapport

Kandidat väljs enbart på utvecklingsperioden. Behörighet kräver minst 30 avslut, positivt netto vid normal slippage och positivt netto vid stress. Av behöriga väljs högst normalt netto; lika resultat bryts med lägre maxnedgång och därefter profilordningen pulse12, pulse24, trend24. Om ingen klarar kraven väljs ingen kandidat. Efter utvecklingsvalet fryses kandidaten innan valideringsresultat räknas eller visas.

Valideringsgränsen kräver minst 20 avslut samt positivt netto i både normal- och stresskörningen på juli–augusti. Ett misslyckande innebär `validated: false`; ingen annan kandidat väljs efteråt. September kan inte upphäva ett misslyckande.

Rapportera antal avslut, netto, netto-R per affär, profit factor (nettotrades), maxnedgång, median och 90:e percentil av hålltid, coinbidrag samt stressutfall. Spara rådatahashar, körinställningar och maskinläsbara resultat för reproducerbarhet.

API-dokumentation: [Kline](https://bybit-exchange.github.io/docs/v5/market/kline), [Mark price kline](https://bybit-exchange.github.io/docs/v5/market/mark-kline), [Funding history](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).

## Tillägg låst 2026-09-11 19:48 UTC, före första resultaträkning

Datahämtningen är klar men inga profilresultat har beräknats eller lästs. Följande geometri och utlösningsregler ersätter motsvarande formuleringar ovan för överensstämmelse med demots gemensamma exekveringsmodul:

- SL och TP läggs vid observerat inträdespris **före slippage** minus stoppavstånd respektive plus målmultiple gånger stoppavstånd. Nettorisken omfattar därefter entryslippage, exitslippage och båda avgifterna.
- Inträde nekas om öppningspriset avviker mer än halva stoppavståndet från signalens referenspris, om aktuellt markpris redan ligger utanför SL/TP, eller om beräknad netto-R:R efter avgifter och slippage är under 1,5.
- Historiska **markprisstaplar** utlöser SL och TP och ger konservativa simulerade avslutspriser. Öppning för nya positioner använder affärsprisstapeln. Värdering använder markpris. Gap-SL använder sämre marköppning och avdrag för slippage. Tidsutgång använder marköppning.
- Föregående 0,5 % risk / högst 2× exponering används fortsatt för urvalet, som jämförelse av signaler med tillräcklig kontotäckning. Den jämförelsen antar inte att historiska maximala Bybit-hävstänger är kända.
- En separat 50-procentig riskscenarioanalys får använda `openActivePosition` med dagens offentliga kontraktsgränser, högst 50 % isolerad marginal och likvidationsbuffert 25 % av stoppavståndet. Den är **dagens villkor applicerade på historiska priser**, inte rekonstruktion av historisk maxhävstång, och får inte påverka kandidatvalet. Finansiering kan förbruka stoppbufferten och ge tidigare riskavslut. Gap förbi likvidationsnivån förlorar hela positionens kvarvarande isolerade marginal. Om både SL och lägre likvidation ryms i en markstapel med öppning ovanför likvidation prioriteras SL; gapöppning förbi likvidation prioriteras likvidation.
- Exaktheten i markpris som historiskt fyllnadspris är en ytterligare begränsning; verkliga marknadsorder fylls i orderboken, inte nödvändigtvis vid markpris.
