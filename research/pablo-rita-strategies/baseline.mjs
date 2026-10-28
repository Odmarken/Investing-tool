// Today's ✦ Rita: the app's own system prompt, question and reader, unchanged.
import {appPrompt} from '../pablo-rita-sim.mjs';

export default {
  name: 'baseline',
  description: 'Appens nuvarande Rita: samma systemprompt, fråga och läsare som i grafen.',
  prompt: appPrompt
};
