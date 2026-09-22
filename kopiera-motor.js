/**
 * Kopierar signalmotorn till functions/ inför utrullning.
 * motor.js finns bara i ett exemplar i roten — Firebase laddar bara upp
 * functions-mappen, så filen måste ligga där när `firebase deploy` kör.
 */
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rot = dirname(fileURLToPath(import.meta.url));
/* Momentumkontot och trading floor körs också i molnet: samma moduler som
   sidan importerar, kopierade rakt av så att reglerna är identiska. */
export const MOLN_MODULER = ['cloud-runner.js', 'trading-floor.js', 'crypto-momentum-active.js', 'crypto-momentum-active-execution.js',
  'crypto-momentum-active-market.js', 'crypto-momentum-active-signal.js', 'crypto-momentum-market.js', 'crypto-momentum-live.js',
  'crypto-momentum.js', 'crypto-leverage.js', 'bybit-contracts.js'];
for(const fil of ['motor.js', 'modell.js', ...MOLN_MODULER]){
  copyFileSync(join(rot, fil), join(rot, 'functions', fil));
}
console.log('motor.js, modell.js och ' + MOLN_MODULER.length + ' momentum-/floor-moduler kopierade till functions/');
