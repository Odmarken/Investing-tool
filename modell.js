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
  tranad: "2026-08-31",
  duger: false,
  drag: ["lang","trend","svep","brott","ict","orb","trendriktning","rsiriktning","relvolym","atrprocent","avstand","rr","medhall","mothall","vwapriktning","daglage","daglageriktning","orlage","orbredd","orriktning","orklar","adx","rth","ytterhandel","globex","rthandel","mandag","tisdag","onsdag","torsdag","fredag","killzone","stopporder","konfidens"],
  medel: [0.485833,0.537667,0.224167,0.132833,0.0665,0.0045,-0.075747,-0.007106,-0.218978,0.096009,0.618861,1.838582,0.283,0.300083,-0.379048,0.543621,-0.068554,-0.161675,3.352781,-0.014269,0.506833,0.472627,0.292667,0.379333,0.328,0.142556,0.198667,0.1765,0.2045,0.2125,0.155167,0.3765,0.171667,0.534363],
  skala: [0.499799,0.498579,0.417032,0.339395,0.249154,0.066931,0.856218,0.237704,0.758632,0.047731,0.593343,0.663374,0.306415,0.300784,2.637199,0.308985,0.620321,1.269492,3.420745,0.470267,0.499953,0.199876,0.454987,0.485221,0.469485,0.272253,0.398997,0.381245,0.403336,0.409077,0.362063,0.484508,0.37709,0.305486],
  vikter: [0.014014,-0.003849,0.049112,0.01364,0.014801,0.010794,-0.079863,0.053941,0.013947,-0.00313,0.004396,-0.014261,-0.093897,0.031371,-0.231736,0.006438,0.200471,0.108565,-0.001211,0.043396,-0.018281,-0.011385,0.002191,-0.010736,0.008973,0.015162,-0.018559,0.034956,0.007315,-0.007089,-0.0161,0.010082,-0.059005,0.214408],
  bias: -0.075585,
  test: {"n":4159,"fran":"2026-08-06","till":"2026-08-31","snittR":-0.066,"topp25":-0.055,"botten25":-0.091,"traffTopp25":33,"lyft":0.011}
};
