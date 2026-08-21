/**
 * Kopierar signalmotorn till functions/ inför utrullning.
 * motor.js finns bara i ett exemplar i roten — Firebase laddar bara upp
 * functions-mappen, så filen måste ligga där när `firebase deploy` kör.
 */
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rot = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(rot, 'motor.js'), join(rot, 'functions', 'motor.js'));
console.log('motor.js kopierad till functions/');
