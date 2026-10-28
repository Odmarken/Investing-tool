// Structured chart reading, written out: the same clean chart and checklist as
// read-silent, but Pablo writes a short analysis (one line per checklist point)
// before his scenario sentence and the ten candles. Our parse keeps only the
// "Slutsats:" line as the note; the app's reader would read the candles unchanged
// but show the analysis as the note.
import {readCandles} from '../pablo-rita-sim.mjs';
import {SYSTEM, question} from './read-silent.mjs';

export default {
  name: 'read-notes',
  description: 'Strukturerad grafläsning nedskriven: ren graf utan prognos och signalregel, en kort analys per checklistpunkt, sedan en slutsats och tio candles.',
  system: SYSTEM,
  prompt: m => question(m, [
    'Svara exakt så här och inget annat:',
    'Först 8 korta rader, en per checklistpunkt, som börjar med punktens nummer och ett ord (t.ex. "1. Struktur: …"). Varje rad måste innehålla ord, inte bara tal, och högst 160 tecken.',
    'Sedan en rad som börjar med "Slutsats:" och en kort mening på svenska om ditt scenario (högst 200 tecken).',
    `Sedan ${m.n} rader, en candle per rad i tidsordning: open high low close, med punkt som decimaltecken och utan tusentalsavgränsare. Inget efter candlarna.`
  ].join('\n')),
  parse(text, m){
    const {candles} = readCandles(text, m);
    const line = String(text || '').split('\n').find(l => /^\s*[*_]*slutsats\s*:/i.test(l)) || '';
    return {candles, note: line.replace(/^\s*[*_]*slutsats\s*:\s*[*_]*/i, '').trim().slice(0, 300)};
  }
};
