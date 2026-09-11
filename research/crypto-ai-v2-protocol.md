# AI v2: låst undersökning och beslut om demo

Protokoll fastställt före läsning av det nya utvecklingsunderlaget och modellträning. Alla signaler samlas med samma motor som förra uppspelningen; inga nya pris-API:er eller betalda AI-tjänster används.

- Träning: 14 mars–11 juni 2026. Kandidaters utfall måste vara färdiga före 12 juni.
- Validering för val av kandidat: 12 juni–11 juli. Utfall måste vara färdiga före 12 juli.
- Senare kontroll: 12 juli–9 september. Denna prisperiod har granskats tidigare och är därför **retrospektiv**, inte ett orört sluttest. Den används inte för att välja om parametrarna.
- Alla observerade A-signaler, även när portföljen var upptagen. Träning och urval använder endast kandidater som klarar samma grundkrav; avböjda kandidater ingår fortfarande i förlustanalysen.

Tre förutbestämda utföranden, utan ändrad signalriktning eller tidigarelagd entry:

1. Originalets frysta stopp, mål och 24 h utvärdering.
2. Stoppavstånd max(2 × ATR, 0,6 % av entry), mål 3 gånger detta avstånd, högst 24 h.
3. Samma bredare stopp/mål som 2, men högst 6 h.

Det bredare stoppet prövar hypotesen att mycket snäva stopp ger oproportionerliga kostnader. Det är en separat forskningsvariant, ingen återinförd global kostnadsspärr. Samma grundkrav för geometri, netto-R:R ≥1,5, signalålder och jagad entry behålls.

Två modeller per utförande: ridge med regularisering 30; gradientförstärkta regressionsträd med djup 2, 60 träd, inlärningstakt 0,05, minst 80 observationer per löv och 16 möjliga kvantilgränser per indata. Trädens delningsgränser och båda modellernas parametrar beräknas bara på träningen. Totalt sex kandidater. Prognoströskel +0,10 netto-R, inga efterhandsjusteringar.

Avgift 0,055 % och slippage 0,05 % per sida, plus historisk funding med spotmarkpris som approximation. Stress använder 0,10 % slippage. Utfall använder samma konservativa SL/TP-regler och utelämnade beslutsstapel som AI-loggen. MFE/MAE mäts på staplar före avslutsstapeln; intrabarordningen är okänd.

Valideringskrav: minst 50 avslutade valda signaler, positivt netto-R och positivt stressresultat, profit factor ≥1,15, minst tre coins med positiva genomsnitt och minst tio valda observationer per sådan coin. En simulerad portfölj får ha högst en position, 0,5 % av kapitalet i beräknad stopprisk, högst 2× exponering, och max nedgång ≤10 %. Portföljen måste vara positiv även under kostnadsstress och innehålla minst 20 separata trades (40 i den senare kontrollen). Av kandidater som klarar samtliga krav väljs högst genomsnittligt stress-R. Ingen kandidat väljs om ingen klarar kraven.

Den valda kandidaten kontrolleras sedan på den senare perioden med samma krav, men minst 100 avslutade valda signaler och ett positivt nedre 95 %-veckoblocksintervall för netto-R. Portföljen måste ha positiv avkastning även under kostnadsstress. Modellen tränas inte om på valideringen inför denna kontroll.

Endast en kandidat som klarar båda kontrollerna får förberedas för automatisk demo med dessa riskgränser. Annars stannar modellen i forskning/observationsläge. Att alla avstår eller att färre trades förlorar räcker inte som godkännande. Inga befintliga kontoaffärer, saldon eller inställningar får skrivas om av forskningskörningen.
