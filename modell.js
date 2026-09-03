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
  tranad: "2026-09-03",
  duger: false,
  drag: ["lang","trend","svep","brott","ict","orb","trendriktning","rsiriktning","relvolym","atrprocent","avstand","rr","medhall","mothall","vwapriktning","daglage","daglageriktning","orlage","orbredd","orriktning","orklar","adx","rth","ytterhandel","globex","rthandel","mandag","tisdag","onsdag","torsdag","fredag","killzone","stopporder","konfidens"],
  medel: [0.506461,0.474243,0.342539,0.017525,0.100018,0.006904,0.192792,0.045768,-0.206685,0.10885,0.647573,1.876942,0.385998,0.24553,0.255888,0.531521,0.083357,0.060723,3.655313,0.015578,0.576031,0.501429,0.3282,0.384139,0.287662,0.168112,0.220216,0.212427,0.208355,0.188883,0.135953,0.383785,0.083201,0.677008],
  skala: [0.499958,0.499336,0.474559,0.131218,0.300024,0.082802,0.869413,0.247519,0.743332,0.051038,0.615915,0.603766,0.328227,0.298125,2.943179,0.33246,0.662679,1.457629,3.306642,0.514558,0.494185,0.20358,0.469558,0.486391,0.452672,0.289921,0.414392,0.409025,0.406132,0.391416,0.342739,0.486307,0.276185,0.268447],
  vikter: [-0.098367,-0.044575,0.044066,-0.031305,0.023328,0.015308,-0.061942,-0.007838,0.018008,-0.044859,0.018748,-0.085402,-0.076455,0.065873,-0.161668,0.017499,0.27873,-0.013032,-0.098061,0.007761,0.090959,-0.00125,-0.016643,-0.009689,0.027674,0.019006,0.064048,0.065728,0.03831,0.026562,0.016519,0.007463,-0.020468,0.153652],
  bias: -0.057581,
  test: {"n":1924,"fran":"2026-08-11","till":"2026-09-03","dagar":21,"snittR":-0.104,"topp25":-0.123,"botten25":-0.206,"traffTopp25":33,"lyft":-0.019,"nolltest":-0.099,"kostnadPunkter":0.87}
};
