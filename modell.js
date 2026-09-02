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
  tranad: "2026-09-02",
  duger: false,
  drag: ["lang","trend","svep","brott","ict","orb","trendriktning","rsiriktning","relvolym","atrprocent","avstand","rr","medhall","mothall","vwapriktning","daglage","daglageriktning","orlage","orbredd","orriktning","orklar","adx","rth","ytterhandel","globex","rthandel","mandag","tisdag","onsdag","torsdag","fredag","killzone","stopporder","konfidens"],
  medel: [0.509221,0.418648,0.257172,0.039139,0.1625,0.017213,0.342959,0.114019,-0.1573,0.112573,0.774086,1.872061,0.481199,0.186168,0.767836,0.528272,0.210421,0.225575,3.50978,0.056565,0.563934,0.501694,0.359016,0.354303,0.28668,0.176434,0.219672,0.204918,0.207377,0.18668,0.144057,0.40082,0.16168,0.722609],
  skala: [0.499915,0.493337,0.437075,0.193926,0.368909,0.130065,0.832145,0.236426,0.730513,0.053078,0.64285,0.609595,0.338061,0.276094,2.7921,0.337584,0.644028,1.411554,3.261126,0.514288,0.495896,0.202771,0.479712,0.478302,0.452211,0.289401,0.414024,0.403642,0.405428,0.389655,0.351148,0.490065,0.368157,0.25325],
  vikter: [-0.113112,0.000599,0.006421,-0.00904,0.023153,0.008665,-0.114088,-0.035288,0.024507,-0.045767,0.042287,-0.068116,-0.098478,0.121529,-0.120497,0.05212,0.199334,-0.005706,-0.093189,0.043729,0.094468,0.010149,-0.041119,-0.002813,0.046595,0.05117,0.082603,0.077702,0.063465,0.071473,0.018921,-0.000795,-0.031626,0.236348],
  bias: -0.051853,
  test: {"n":1715,"fran":"2026-08-10","till":"2026-09-02","dagar":21,"snittR":-0.092,"topp25":-0.071,"botten25":-0.177,"traffTopp25":34,"lyft":0.021,"nolltest":-0.072,"kostnadPunkter":0.87}
};
