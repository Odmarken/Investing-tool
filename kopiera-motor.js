/**
 * Kopierar signalmotorn till functions/ inför utrullning.
 * motor.js finns bara i ett exemplar i roten — Firebase laddar bara upp
 * functions-mappen, så filen måste ligga där när `firebase deploy` kör.
 */
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rot = dirname(fileURLToPath(import.meta.url));
for(const fil of ['motor.js', 'modell.js']){
  copyFileSync(join(rot, fil), join(rot, 'functions', fil));
}
console.log('motor.js och modell.js kopierade till functions/');
