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
  tranad: "2026-09-10",
  duger: false,
  drag: ["lang","trend","svep","brott","ict","orb","trendriktning","rsiriktning","relvolym","atrprocent","avstand","rr","medhall","mothall","vwapriktning","daglage","daglageriktning","orlage","orbredd","orriktning","orklar","adx","rth","ytterhandel","globex","rthandel","mandag","tisdag","onsdag","torsdag","fredag","killzone","stopporder","konfidens"],
  medel: [0.497211,0.400797,0.344223,0.020186,0.106507,0.016202,0.163506,0.052455,0.009992,0.11686,0.694879,1.862067,0.441899,0.27012,0.33061,0.529866,0.089706,0.143451,2.742625,0.038424,0.484728,0.531399,0.508101,0.374502,0.117397,0.254864,0.194157,0.208765,0.19761,0.211687,0.187782,0.579017,0.148473,0.679307],
  skala: [0.499992,0.49006,0.475114,0.140636,0.308486,0.126251,0.905357,0.263711,0.666518,0.054631,0.660473,0.541567,0.367271,0.333066,2.863723,0.342691,0.682107,1.220728,2.963827,0.481833,0.499767,0.211509,0.499934,0.483994,0.321893,0.320595,0.39555,0.406426,0.398196,0.408504,0.390538,0.493717,0.355568,0.281885],
  vikter: [-0.062467,-0.041941,0.046094,-0.039907,-0.001436,-0.025705,-0.117136,0.021695,-0.020876,-0.103975,0.056828,-0.092576,-0.036521,0.082353,-0.217682,0.031313,0.268144,-0.120374,-0.133944,0.021921,0.088608,0.028533,0.045525,-0.012201,-0.05236,-0.00396,0.01774,-0.001388,-0.009017,0.011976,-0.019857,0.040716,-0.002542,0.233899],
  bias: -0.032688,
  traff: {"trend|B":{"n":460,"traff":35,"R":-0.092},"ict|C":{"n":86,"traff":37,"R":-0.133},"ict|B":{"n":207,"traff":40,"R":0.096},"svep|C":{"n":1263,"traff":43,"R":0.064},"trend|C":{"n":370,"traff":38,"R":0.016},"trend|A":{"n":679,"traff":38,"R":-0.073},"brott|A":{"n":37,"traff":35,"R":-0.326},"moment|A":{"n":356,"traff":37,"R":-0.18},"ict|A":{"n":108,"traff":36,"R":-0.015},"orb|C":{"n":3,"traff":33,"R":-0.427},"svep|B":{"n":32,"traff":50,"R":0.127},"orb|A":{"n":25,"traff":28,"R":-0.479},"brott|B":{"n":27,"traff":33,"R":-0.313},"brott|C":{"n":12,"traff":50,"R":0.125},"orb|B":{"n":33,"traff":33,"R":-0.193},"moment|B":{"n":47,"traff":32,"R":-0.301},"moment|C":{"n":19,"traff":11,"R":-0.568},"svep|A":{"n":1,"traff":0,"R":-1.024}},
  test: {"n":1250,"fran":"2026-08-14","till":"2026-09-10","dagar":19,"snittR":-0.02,"topp25":0.005,"botten25":-0.197,"traffTopp25":41,"lyft":0.025,"nolltest":-0.077,"kostnadPunkter":0.87}
};
