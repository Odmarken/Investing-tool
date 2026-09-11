# Fortsättning: kan korta AI-modeller rangordna signaler?

Körd 2026-09-11T12:36:51.824Z. De sex redan tränade modellerna granskas utan omträning eller ändrad handelströskel. Träning slutar före 12 juni 2026; valideringen är 12 juni–före 12 juli. Den senare juli–september-perioden öppnas inte av denna körning.

## Metod

Fem prognosgrupper avgränsas med 20:e, 40:e, 60:e och 80:e percentilen av respektive modells träningsprognoser. Samma fasta gränser används på valideringsdata. Därför behöver grupperna där inte vara lika stora. Lika prognoser hålls tillsammans. Endast kandidater som klarar respektive utförandes tidigare grundkrav tas med. Utfall som korsar tidsgränsen utesluts.

En konstant prognos, träningsdelens medelutfall, används som referens. MSE är genomsnittligt kvadrerat prognosfel; lägre är bättre. Bra MSE är inte samma sak som lönsam handel. Avgifter, slippage och funding följer tidigare test; stress dubblar slippage.

## Validering jämfört med konstant prognos

| Modell | Kandidater | Prognos snitt R | Utfall snitt R | Modell MSE | Konstant MSE | Prognos ≥ +0,10 R |
|---|---:|---:|---:|---:|---:|---:|
| original-ridge | 390 | -0.539 | -0.347 | 2.300 | 2.301 | 0 |
| original-trees | 390 | -0.544 | -0.347 | 2.272 | 2.301 | 0 |
| wide24-ridge | 1732 | -0.273 | -0.239 | 1.663 | 1.656 | 0 |
| wide24-trees | 1732 | -0.268 | -0.239 | 1.664 | 1.656 | 0 |
| wide6-ridge | 1734 | -0.263 | -0.298 | 1.135 | 1.134 | 0 |
| wide6-trees | 1734 | -0.262 | -0.298 | 1.140 | 1.134 | 0 |

## original-ridge

Träningsbaslinje -0.531 R. Fasta gruppgränser: -0.659, -0.558, -0.485, -0.400 R. Grupp 5 kräver prognos strikt över den högsta gränsen.

| Grupp, lägst till högst prognos | Kandidater | Prognos R | Utfall R | Stress R |
|---|---:|---:|---:|---:|
| 1 | 88 | -0.763 | -0.603 | -0.707 |
| 2 | 82 | -0.607 | -0.307 | -0.455 |
| 3 | 65 | -0.523 | -0.312 | -0.413 |
| 4 | 74 | -0.445 | -0.374 | -0.459 |
| 5 | 81 | -0.324 | -0.114 | -0.210 |

## original-trees

Träningsbaslinje -0.531 R. Fasta gruppgränser: -0.672, -0.550, -0.467, -0.403 R. Grupp 5 kräver prognos strikt över den högsta gränsen.

| Grupp, lägst till högst prognos | Kandidater | Prognos R | Utfall R | Stress R |
|---|---:|---:|---:|---:|
| 1 | 96 | -0.770 | -0.550 | -0.655 |
| 2 | 68 | -0.607 | -0.469 | -0.590 |
| 3 | 75 | -0.507 | -0.595 | -0.655 |
| 4 | 71 | -0.436 | -0.170 | -0.296 |
| 5 | 80 | -0.350 | 0.075 | -0.053 |

## wide24-ridge

Träningsbaslinje -0.268 R. Fasta gruppgränser: -0.321, -0.288, -0.257, -0.219 R. Grupp 5 kräver prognos strikt över den högsta gränsen.

| Grupp, lägst till högst prognos | Kandidater | Prognos R | Utfall R | Stress R |
|---|---:|---:|---:|---:|
| 1 | 375 | -0.354 | -0.137 | -0.231 |
| 2 | 314 | -0.304 | -0.424 | -0.485 |
| 3 | 381 | -0.273 | -0.128 | -0.217 |
| 4 | 342 | -0.238 | -0.348 | -0.413 |
| 5 | 320 | -0.185 | -0.195 | -0.272 |

## wide24-trees

Träningsbaslinje -0.268 R. Fasta gruppgränser: -0.317, -0.282, -0.258, -0.220 R. Grupp 5 kräver prognos strikt över den högsta gränsen.

| Grupp, lägst till högst prognos | Kandidater | Prognos R | Utfall R | Stress R |
|---|---:|---:|---:|---:|
| 1 | 352 | -0.356 | -0.143 | -0.233 |
| 2 | 322 | -0.297 | -0.359 | -0.424 |
| 3 | 340 | -0.270 | -0.199 | -0.279 |
| 4 | 366 | -0.240 | -0.201 | -0.286 |
| 5 | 352 | -0.182 | -0.305 | -0.375 |

## wide6-ridge

Träningsbaslinje -0.262 R. Fasta gruppgränser: -0.304, -0.275, -0.250, -0.220 R. Grupp 5 kräver prognos strikt över den högsta gränsen.

| Grupp, lägst till högst prognos | Kandidater | Prognos R | Utfall R | Stress R |
|---|---:|---:|---:|---:|
| 1 | 374 | -0.331 | -0.281 | -0.358 |
| 2 | 347 | -0.289 | -0.356 | -0.424 |
| 3 | 312 | -0.262 | -0.346 | -0.413 |
| 4 | 352 | -0.236 | -0.322 | -0.392 |
| 5 | 349 | -0.195 | -0.194 | -0.275 |

## wide6-trees

Träningsbaslinje -0.262 R. Fasta gruppgränser: -0.303, -0.273, -0.252, -0.226 R. Grupp 5 kräver prognos strikt över den högsta gränsen.

| Grupp, lägst till högst prognos | Kandidater | Prognos R | Utfall R | Stress R |
|---|---:|---:|---:|---:|
| 1 | 341 | -0.330 | -0.202 | -0.281 |
| 2 | 394 | -0.286 | -0.390 | -0.456 |
| 3 | 325 | -0.263 | -0.243 | -0.325 |
| 4 | 311 | -0.240 | -0.316 | -0.387 |
| 5 | 363 | -0.189 | -0.325 | -0.392 |

## Hur resultatet får användas

Grupperna är diagnostik, inga nya handelsregler. En eventuell positiv grupp är ett uppslag för fortsatt utveckling, inte en efterhandsvald godkänd strategi. Jämförelser mellan utföranden har olika kandidatpopulationer; använd den tidigare parade analysen för att bedöma stoppändringen på samma signaler. Korrelerade och överlappande signaler är inte oberoende trades.

Modellerna och perioderna är redan granskade. Rapporten ändrar därför varken modellens valideringsstatus, tröskeln +0,10 R eller kontots handelsregler. Detta är ett mätt nästa steg för att skilja prognosförmåga från problem i signalunderlaget.

## Reproduktion

Kör `node research/crypto-ai-ranking.mjs` med befintlig kandidat-, pris- och modellcache. Resultat och SHA-256 sparas i `.matning/crypto/ai-ranking.json`. Träningsantal och sista träningsutfall kontrolleras mot den sparade modellen.
