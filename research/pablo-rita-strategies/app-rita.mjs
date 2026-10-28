// The ✦ Rita that ships in the app (claude-sketch.js ritaPrompt and the bridge's SKETCH_SYSTEM): the clean chart
// read like a day trader, plus the bounce after a sharp drop in a strong downtrend.
import {ritaPrompt} from '../../claude-sketch.js';
import {SKETCH_SYSTEM} from '../../electron/claude-bridge.js';

export default {
  name: 'app-rita',
  description: 'Appens Rita: ren graf, tyst checklista och studsläget.',
  system: SKETCH_SYSTEM,
  prompt: m => ritaPrompt({bars: m.history, symbol: m.symbol, tf: m.tfLabel, tfMs: m.tfMs, n: m.n, price: m.base, dec: m.dec, from: m.from, start: m.start})
};
