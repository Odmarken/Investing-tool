/**
 * Riptide — den lärda modellen.
 *
 * Genererad av trana.mjs. Rör inte för hand: kör `npm run trana` i stället, så
 * spelas historiken upp genom motor.js igen och vikterna räknas om. Dragen och
 * deras ordning kommer från DRAG_NAMN i motor.js plus konfidensen sist — ändras
 * den listan slutar modellen gälla, och motorn faller tillbaka på de handsatta
 * poängen tills du tränat om.
 *
 * Modellen förutsäger setupens utfall i R. Den är testad rullande: varje
 * bedömd setup i testperioden fick en modell som bara sett affärer som var
 * avgjorda innan setupen fanns.
 *
 * duger = false betyder att den inte slog dagens poängsättning på testdata.
 * Då används den inte till annat än att visas.
 */
export const MODELL = {
  version: 2,
  tranad: "2026-08-25",
  duger: false,
  drag: ["lang","trend","svep","brott","ict","orb","trendriktning","rsiriktning","relvolym","atrprocent","avstand","rr","medhall","mothall","vwapriktning","daglage","daglageriktning","orlage","orbredd","orriktning","orklar","adx","rth","ytterhandel","globex","rthandel","mandag","tisdag","onsdag","torsdag","fredag","killzone","stopporder","konfidens"],
  medel: [0.489,0.547833,0.249333,0.136333,0.058167,0.008333,-0.126353,-0.018876,-0.196775,0.092423,0.635343,1.943345,0.25125,0.300167,-0.52706,0.545698,-0.102842,-0.221518,3.358432,-0.030122,0.490833,0.469782,0.281167,0.386333,0.3325,0.136688,0.226167,0.170333,0.147333,0.227833,0.173333,0.379833,0.144667,0.526265],
  skala: [0.499879,0.497707,0.432627,0.343142,0.234058,0.090906,0.854681,0.238455,0.755583,0.042901,0.599914,0.663582,0.272065,0.278807,2.658329,0.316966,0.632177,1.258509,3.499173,0.475698,0.499916,0.199763,0.449569,0.486909,0.471109,0.268567,0.418348,0.375925,0.354438,0.419435,0.378535,0.485345,0.351764,0.301557],
  vikter: [0.022969,-0.022661,0.057023,-0.031563,-0.004904,-0.015541,0.010359,0.034621,-0.032924,-0.022222,0.04041,-0.060488,-0.125137,0.026137,-0.218051,-0.025655,0.285479,0.118542,-0.002952,-0.01371,-0.033998,0.013206,0.038021,-0.023983,-0.011496,-0.026215,0.033395,0.048222,0.044594,0.034656,0.073292,0.016611,-0.034805,0.213518],
  bias: -0.104061,
  test: {"n":6028,"fran":"2026-07-30","till":"2026-08-25","snittR":-0.103,"topp25":-0.235,"botten25":-0.11,"traffTopp25":27,"lyft":-0.133}
};
