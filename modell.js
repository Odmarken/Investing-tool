/**
 * Riptide — den lärda modellen.
 *
 * Genererad av trana.mjs. Rör inte för hand: kör `npm run trana` i stället, så
 * spelas historiken upp genom motor.js igen och vikterna räknas om. Dragen och
 * deras ordning kommer från DRAG_NAMN i motor.js plus konfidensen sist — ändras
 * den listan slutar modellen gälla, och motorn faller tillbaka på de handsatta
 * poängen tills du tränat om.
 *
 * Modellen förutsäger setupens utfall i R, netto efter spread, courtage och
 * slippage. Den är testad rullande på hela handelsdagar: varje bedömd setup i
 * testperioden fick en modell som bara sett affärer från tidigare dagar.
 *
 * test.nolltest är samma geometri med slumpad riktning. Ligger snittR inte
 * tydligt över den siffran mäter modellen marknadens drift, inte en edge.
 *
 * duger = false betyder att den inte slog dagens poängsättning på testdata.
 * Då används den inte till annat än att visas.
 */
export const MODELL = {
  version: 3,
  tranad: "2026-09-04",
  duger: false,
  drag: ["lang","trend","svep","brott","ict","orb","trendriktning","rsiriktning","relvolym","atrprocent","avstand","rr","medhall","mothall","vwapriktning","daglage","daglageriktning","orlage","orbredd","orriktning","orklar","adx","rth","ytterhandel","globex","rthandel","mandag","tisdag","onsdag","torsdag","fredag","killzone","stopporder","konfidens"],
  medel: [0.501807,0.471089,0.319308,0.01652,0.09396,0.010067,0.205307,0.043026,-0.004745,0.116379,0.65786,1.869413,0.433789,0.27078,0.417656,0.54259,0.109495,0.148428,2.718753,0.037354,0.478317,0.521257,0.502065,0.384099,0.113836,0.256222,0.205731,0.206247,0.192824,0.20857,0.186629,0.5746,0.115643,0.691069],
  skala: [0.499997,0.499163,0.466209,0.127466,0.291773,0.099829,0.88559,0.255009,0.66095,0.054612,0.642521,0.535733,0.358364,0.327083,2.79217,0.333332,0.663104,1.206719,2.966241,0.470575,0.49953,0.208092,0.499996,0.486382,0.317612,0.32424,0.404234,0.40461,0.394516,0.406286,0.389613,0.494404,0.319796,0.276767],
  vikter: [-0.053688,-0.066625,0.063319,-0.062418,-0.009811,-0.018152,-0.082848,0.061387,-0.015156,-0.102342,0.074074,-0.10312,-0.036714,0.072834,-0.211977,0.042454,0.216548,-0.113347,-0.175362,0.003977,0.069245,0.029804,0.074436,-0.039401,-0.056843,0.003722,0.01914,-0.003119,-0.00471,0.015985,-0.028519,0.034673,0.020636,0.229303],
  bias: -0.060036,
  traff: {"trend|B":{"n":535,"traff":35,"R":-0.105},"ict|C":{"n":78,"traff":33,"R":-0.227},"ict|B":{"n":186,"traff":41,"R":0.107},"svep|C":{"n":1208,"traff":42,"R":0.054},"trend|C":{"n":574,"traff":34,"R":-0.126},"trend|A":{"n":716,"traff":36,"R":-0.113},"brott|A":{"n":34,"traff":32,"R":-0.408},"moment|A":{"n":297,"traff":41,"R":-0.123},"ict|A":{"n":100,"traff":36,"R":-0.023},"orb|C":{"n":3,"traff":33,"R":-0.427},"svep|B":{"n":28,"traff":43,"R":-0.002},"orb|A":{"n":20,"traff":25,"R":-0.387},"brott|B":{"n":19,"traff":21,"R":-0.626},"brott|C":{"n":11,"traff":45,"R":0.033},"orb|B":{"n":16,"traff":31,"R":-0.02},"moment|B":{"n":32,"traff":41,"R":-0.101},"moment|C":{"n":16,"traff":6,"R":-0.822},"svep|A":{"n":1,"traff":0,"R":-1.024}},
  test: {"n":1315,"fran":"2026-08-12","till":"2026-09-04","dagar":18,"snittR":-0.084,"topp25":-0.064,"botten25":-0.231,"traffTopp25":38,"lyft":0.02,"nolltest":-0.064,"kostnadPunkter":0.87}
};
