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
  medel: [0.500797,0.471322,0.318906,0.016994,0.094264,0.010356,0.203983,0.042252,0.001738,0.117394,0.652459,1.861885,0.432621,0.269583,0.407964,0.536251,0.106522,0.147413,2.706493,0.037011,0.477695,0.517264,0.501859,0.383165,0.114976,0.255641,0.211896,0.212693,0.198354,0.194371,0.182687,0.57966,0.115507,0.690799],
  skala: [0.499999,0.499177,0.466053,0.129249,0.292196,0.101235,0.885408,0.254741,0.660899,0.05466,0.637772,0.529824,0.358389,0.325596,2.786298,0.333605,0.662629,1.184726,2.953904,0.472289,0.499502,0.208737,0.499997,0.486158,0.318993,0.323989,0.408651,0.409212,0.39876,0.395715,0.38641,0.493613,0.319633,0.276958],
  vikter: [-0.067971,-0.063365,0.056417,-0.063465,-0.006577,-0.017369,-0.052754,0.069618,-0.007417,-0.104998,0.074811,-0.094845,-0.03429,0.076176,-0.163607,0.04818,0.160487,-0.115897,-0.177829,0.001771,0.081072,0.029481,0.067249,-0.03766,-0.048013,0.009584,0.016934,-0.003523,-0.004749,0.017178,-0.02687,0.033857,0.022709,0.195282],
  bias: -0.061519,
  test: {"n":1289,"fran":"2026-08-11","till":"2026-09-03","dagar":18,"snittR":-0.082,"topp25":-0.116,"botten25":-0.179,"traffTopp25":35,"lyft":-0.034,"nolltest":-0.081,"kostnadPunkter":0.87}
};
