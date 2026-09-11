# Fryst krypto-AI: utökad historisk uppspelning

Körd 2026-09-11T10:28:10.889Z. Modell: `crypto-ridge-v1-d3bd0b4a77ae`. Ingen omträning, tröskeländring eller ändring av sidans handel.

## Resultat

12 juli–9 september 2026, sju coins. 4017 unika observerade A-signaler, även när en annan position hade varit öppen. AI skulle ta 0; 0 har bedömbart utfall inom perioden.

| Urval | Observerade | Avslutade | Positiva | Snitt netto-R | Dubbel slippage, R | 95 % veckoblocksintervall |
|---|---:|---:|---:|---:|---:|---|
| Alla | 4017 | 4014 | 31.9 % | -0.419 | -0.497 | -0.483 till -0.357 |
| Selektiv | 15 | 15 | 26.7 % | -0.091 | -0.227 | För få utfall |
| AI skulle ta | 0 | 0 | – % | – | – | För få utfall |
| AI + Selektiv | 0 | 0 | – % | – | – | För få utfall |

R är utfall relativt beräknad nettoförlust vid stopp. Avgift 0,055 % och slippage 0,05 % per sida; stress använder 0,10 % slippage och normaliserar med sin egen stopprisk. Funding ingår inte. Väntande och okända utfall räknas inte som förluster. Signalutfallen kan överlappa och är **inte kontots avkastning**.

## Varför AI avstår

Prognoser: lägst -1.063 R, median -0.345 R, högst 0.473 R. 33 prognoser når den frysta tröskeln +0.10 R före grundkraven. 0 klarar också grundkraven.

Av prognoserna över tröskeln saknar 33 netto-R:R ≥1,5. Efterhandskontroll av dessa 33 avslutade hypotetiska observationer ger -0.414 R i snitt. Det visar inte att borttagna grundkrav skulle göra modellen lönsam. Inga krav ändrades.

Underkända kontrollpunkter (samma signal kan sakna flera):

| Kontroll | Antal |
|---|---:|
| net | 3187 |
| trigger | 3019 |
| volume | 2400 |
| trend | 2091 |
| chase | 221 |

## Rangordning som diagnostik

Fem lika stora grupper efter modellens prognos, lägst till högst. Detta är efterhandsdiagnostik; grupperna användes inte för att välja en ny modell eller tröskel.

| Grupp | Avslutade | Prognos R | Utfall R | 95 % veckoblocksintervall |
|---|---:|---:|---:|---|
| 1 | 802 | -0.591 | -0.654 | -0.760 till -0.511 |
| 2 | 803 | -0.428 | -0.433 | -0.508 till -0.368 |
| 3 | 803 | -0.344 | -0.399 | -0.449 till -0.348 |
| 4 | 803 | -0.260 | -0.306 | -0.383 till -0.234 |
| 5 | 803 | -0.115 | -0.304 | -0.382 till -0.231 |

## Per coin

| Coin | Urval | Avslutade | Snitt netto-R |
|---|---|---:|---:|
| BTC | Alla | 634 | -0.460 |
| BTC | Selektiv | 0 | – |
| BTC | AI skulle ta | 0 | – |
| BTC | AI + Selektiv | 0 | – |
| ETH | Alla | 731 | -0.430 |
| ETH | Selektiv | 2 | -1.000 |
| ETH | AI skulle ta | 0 | – |
| ETH | AI + Selektiv | 0 | – |
| SOL | Alla | 668 | -0.337 |
| SOL | Selektiv | 3 | 1.440 |
| SOL | AI skulle ta | 0 | – |
| SOL | AI + Selektiv | 0 | – |
| XRP | Alla | 699 | -0.452 |
| XRP | Selektiv | 3 | -1.000 |
| XRP | AI skulle ta | 0 | – |
| XRP | AI + Selektiv | 0 | – |
| DOGE | Alla | 694 | -0.477 |
| DOGE | Selektiv | 5 | -0.303 |
| DOGE | AI skulle ta | 0 | – |
| DOGE | AI + Selektiv | 0 | – |
| SHIB | Alla | 325 | -0.421 |
| SHIB | Selektiv | 1 | -1.000 |
| SHIB | AI skulle ta | 0 | – |
| SHIB | AI + Selektiv | 0 | – |
| PEPE | Alla | 263 | -0.254 |
| PEPE | Selektiv | 1 | 1.836 |
| PEPE | AI skulle ta | 0 | – |
| PEPE | AI + Selektiv | 0 | – |

## Tolkning och begränsningar

AI undvek att handla i denna uppspelning. Det kan skydda mot förluster i signalurvalet men visar ingen förmåga att tjäna pengar. Det går inte att beräkna en vinstprocent för noll trades.

Den publicerade modellen tränades på 843 kandidater från basportföljen före 12 juli. Detta bredare urval av alla observerade A-signaler är nytt för denna uppspelning, men prisperioden har tidigare granskats. Resultatet är retrospektivt, inte ett nytt orört sluttest.

Modell och signaler får endast prisdata till observationstidpunkten. Framtida staplar används därefter för facit, aldrig för urval eller omträning. Uppspelningen beräknar orderstatus en gång per avslutad femminutersstapel med standardinställningar och neutrala nyheter. Den reproducerar inte alla intrabar-signaler eller personliga inställningar i den öppna webbläsaren. Precis som sidans AI-logg ignoreras beslutsstapeln och stoppen/målet följs i högst 24 h; snabba intrabarträffar kan därför missas. Spotpriser, ingen funding, orderbok eller faktisk perpetual-exekvering. Veckoblocksintervallen är ungefärliga och baseras på få veckor.

## Kontroller och reproduktion

Alla 4017 rader har kontrollerats för unik nyckel, fryst modellbeslut, kontrollresultat och tidsgränser. Samtliga avslutade netto-R har räknats om från entry, exit och avgifter. Prisfilernas SHA-256 stämde med modellens träningsproveniens före körning; modellfilens hash är oförändrad efter körning.

- [Förutbestämt protokoll](crypto-ai-replay-protocol.md)
- Kör `node research/crypto-ai-replay.mjs` och `node research/crypto-ai-replay-report.mjs`. Befintlig lokal cache krävs.
- Fullständiga observationer: `.matning/crypto/ai-replay.json`.
