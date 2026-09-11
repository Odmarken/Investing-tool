# AI v2: förlustanalys, bredare träning och förbättringstest

Körd 2026-09-11T11:03:56.850Z. **Ingen kandidat klarade valideringen. Automatisk AI-demohandel aktiverades inte. Nuvarande AI-logg fortsätter separat.**

## Genomfört

7831 kandidater samlades från 14 mars–11 juli 2026. Av dem fick 5975 originalobservationer ett avslutat träningsutfall före 12 juni. Utfall som korsar tidsgränser utesluts. Samtliga kandidater används i analysen; modellträningen använder dem som klarar samma grundkrav som modellens möjliga inträden. Valideringen ligger 12 juni–11 juli. Den senare juli–september-kontrollen körs endast för en kandidat som först klarar valideringen.

Två modelltyper × tre utföranden testades, med fasta inställningar: ridge och gradientförstärkta regressionsträd; original, bredare stopp med 24 h samt samma stopp med 6 h. Inga trösklar justerades efter resultaten.

## Förlustanalys på träningsperioden

Originalets genomsnitt var -0.371 R efter avgifter, slippage och funding; utan funding -0.371 R. 918 av 3922 förlustsignaler hade först rört sig minst +0,5 R på en tidigare stapel. Detta garanterar inte att en tidigare exit hade varit möjlig på samtliga trades; avslutsstapelns intrabarordning är okänd.

### Strategifamilj

| Grupp | Utfall | Snitt R | Stress R |
|---|---:|---:|---:|
| ict | 1038 | -0.370 | -0.457 |
| trend | 2179 | -0.444 | -0.523 |
| svep | 115 | -0.558 | -0.636 |
| brott | 1104 | -0.340 | -0.423 |
| orb | 561 | -0.298 | -0.393 |
| moment | 978 | -0.264 | -0.339 |

### Timtrend

| Grupp | Utfall | Snitt R | Stress R |
|---|---:|---:|---:|
| neutral | 921 | -0.299 | -0.388 |
| med timtrend | 2993 | -0.383 | -0.461 |
| mot timtrend | 2061 | -0.386 | -0.469 |

### Netto-R:R vid inträde

| Grupp | Utfall | Snitt R | Stress R |
|---|---:|---:|---:|
| under 1 | 3610 | -0.335 | -0.418 |
| över 2 | 853 | -0.550 | -0.629 |
| 1–1,5 | 1098 | -0.305 | -0.389 |
| 1,5–2 | 414 | -0.494 | -0.565 |

### Stopprisk inklusive kostnader / entry

| Grupp | Utfall | Snitt R | Stress R |
|---|---:|---:|---:|
| 0,3–0,6 % | 2467 | -0.462 | -0.558 |
| under 0,3 % | 269 | -0.787 | -0.844 |
| 0,6–1,2 % | 2596 | -0.287 | -0.365 |
| över 1,2 % | 643 | -0.189 | -0.240 |

### Coin

| Grupp | Utfall | Snitt R | Stress R |
|---|---:|---:|---:|
| DOGE | 951 | -0.393 | -0.466 |
| ETH | 1062 | -0.400 | -0.483 |
| BTC | 1009 | -0.366 | -0.460 |
| SHIB | 503 | -0.401 | -0.476 |
| SOL | 999 | -0.318 | -0.401 |
| PEPE | 479 | -0.338 | -0.404 |
| XRP | 972 | -0.379 | -0.463 |

## Ändrade stopp och tid: samma kandidater

Endast de 390 valideringskandidater som har avslutade utfall och klarar grundkraven i alla tre utföranden jämförs här. Detta undviker att tillskriva olika urval en effekt av själva stoppändringen. R normaliseras med respektive utförandes beräknade nettoförlust vid stopp. Detta är signalutfall, inte kontoavkastning.

| Utförande | Utfall | Snitt R | Dubbel slippage, R |
|---|---:|---:|---:|
| Nuvarande stopp/mål | 390 | -0.347 | -0.455 |
| Bredare stopp · 24 h | 390 | -0.098 | -0.192 |
| Bredare stopp · 6 h | 390 | -0.255 | -0.332 |

## AI-modellernas validering

| Kandidat | Träningsexempel efter grundkrav | AI skulle ta | Snitt R för valda | Högsta prognos R | Godkänd |
|---|---:|---:|---:|---:|---|
| Nuvarande stopp/mål + linjär modell | 1267 | 0 | – | 0.007 | Nej |
| Nuvarande stopp/mål + regressionsträd | 1267 | 0 | – | -0.199 | Nej |
| Bredare stopp · 24 h + linjär modell | 5613 | 0 | – | -0.041 | Nej |
| Bredare stopp · 24 h + regressionsträd | 5613 | 0 | – | -0.032 | Nej |
| Bredare stopp · 6 h + linjär modell | 5616 | 0 | – | -0.124 | Nej |
| Bredare stopp · 6 h + regressionsträd | 5616 | 0 | – | -0.045 | Nej |

Beslutströskeln är +0,10 R. Noll trades är inte ett godkänt resultat. Avsaknad av trades visar att modellerna inte hittar tillräckligt bra kandidater under dessa regler. Eftersom ingen kandidat valdes gick ingen vidare till den senare kontrollen eller automatisk demo. Det går inte att redovisa en uppnådd portföljvinst för dessa modeller.

## Risk, verifiering och begränsningar

Riskmotorn är implementerad och testad för en position åt gången, 0,5 % av kapitalet i stopprisk och högst 2× exponering. Dessa är forskningsgränser; kontots befintliga inställningar skrevs inte om. Simuleringen inkluderar avgift 0,055 %, slippage 0,05 % per sida, historisk funding med spotmarkpris, och stress med dubbel slippage. Fundinghistorikens tidsluckor kontrolleras. Gap kan ge större faktisk förlust än beräknad stopprisk. Nedgång mäts vid femminutersstängningar och avslut, inte på varje tick.

Tränings-/valideringsgränser, urvalsbeslut, portföljens saldoavstämning och uteblivna överlapp har kontrollerats. Separata tester täcker nonlinearitet, framtidsdata, utfall över tidsgräns, fundingriktning, gap, tidsstängning, exponering och spärr mot att godkänna noll trades. Prisperioderna har redan använts i projektets forskning. Det är retrospektiv utveckling, inte ett nytt orört sluttest. Spotmarknaden, femminutersupplösningen och utebliven intrabarordning begränsar överföringen till verklig handel.

## Reproduktion

1. Befintlig pris-cache krävs; vid behov hämtas den med `node research/crypto-data.mjs --download`.
2. `node research/crypto-ai-replay.mjs --training` samlar tidigare kandidater.
3. `node research/crypto-ai-replay.mjs` skapar den senare kandidatfilen för villkorad slutkontroll.
4. `node research/crypto-ai-v2-run.mjs` tränar och väljer enligt protokollet.
5. `node research/crypto-ai-v2-report.mjs` granskar resultat och skriver rapporten samt sidans sammanfattning.

Fullständiga modeller, valda signaler och riskresultat sparas lokalt i `.matning/crypto/ai-v2-benchmark.json`. [Låst protokoll](crypto-ai-v2-protocol.md).
