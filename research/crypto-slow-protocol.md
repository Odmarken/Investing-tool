# Ny inriktning: långsammare kryptomomentum

Fryst före datahämtning/test 2026-09-11. Motiv: Liu, Tsyvinski & Wu beskriver momentum på vecko-horisonter, inte ett belägg för vår femminutersmotor (https://www.nber.org/papers/w25882). Bysik & Ślepaczuks förpublicering visar betydelsen av kostnadsmedveten exekvering och lägre omsättning men ingen säker överlägsenhet mot passivt innehav (https://arxiv.org/html/2606.00060v1). Detta är egna förenklade hypoteser, ingen direkt reproduktion av artiklarna.

Tre förutbestämda varianter, utan parameteroptimering:

1. Momentum 28 dagar: varje coin får högst en tredjedel av startkapitalet; köp/håll när senaste avslutade dygnets pris är över priset 28 dygn tidigare, annars kontanter.
2. Momentum 84 dagar: samma regel med 84 dygn.
3. Rotation 28 dagar: håll den starkaste av BTC/ETH/SOL efter 28 dygns avkastning, endast om avkastningen är positiv; annars kontanter.

Signal kontrolleras en gång i veckan, måndag 00:00 UTC. Den använder endast färdig dygnshistorik, och handel sker till den nya dagens öppningspris plus slippage. Inga framtida stopp eller dagsintervall används. Oförändrad position hålls utan ombalansering; för rotation byts coin när rankingen byts. Kontanter ger ingen ränta. Lång endast, spot, ingen belåning eller funding. Vinster/förluster återinvesteras inom respektive tredjedelsportfölj; inga överföringar mellan tredjedelarna. Därmed blir likaviktningen ursprunglig, inte dagligen återställd.

Universum BTC, ETH, SOL är valt idag och innebär överlevnads-/urvalsbias. Prisdata: Bybit spot dygnsstaplar, 2022-10-01 till före 2026-09-10. Utvecklings-/urvalsperiod: 2023–2024. Senare kontroll: 2025-01-01 till 2026-09-09. Prisperioden överlappar tidigare forskning; kalla den inte ett helt orört prospektivt sluttest.

Avgift 0,10 % per köp/sälj samt 0,05 % slippage per sida, stress 0,10 % slippage. Detta är testantaganden; verklig avgift beror på kontot (https://www.bybit.com/en/help-center/article/Trading-Fee-Structure). Alla portföljer avslutas vid periodens sista stängning och belastas med säljkostnad. Jämför med kontanter och köp-och-behåll i samma tre coins, med samma initiala fördelning och handelskostnader.

Välj kandidat enbart i utvecklingsperioden: positiv nettoavkastning även under stress, max daglig nedgång högst 35 %, minst 10 avslutade innehav. Bland kvalificerade väljs högst nettoavkastning / max daglig nedgång (Calmar-liknande mått utan annualisering). Om ingen klarar detta väljs ingen. Senare period redovisas för förutvalt namn, övriga varianter är diagnostik och får inte bli ersättare efteråt. Redovisa per år, per coin, avkastning, största dagliga nedgång, exponeringstid, omsättning och antal affärer. Dagsstängningar kan underskatta intradag-nedgång.

Detta test ger aldrig automatisk handelsbehörighet. Positiv avkastning ensam visar inte alpha: passivt innehav kan vara bättre, antalet marknadsregimer litet och utfallet beroende av få coins. Ingen nuvarande konto-/signallogik ändras av körningen.
