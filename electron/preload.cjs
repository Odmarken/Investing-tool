/* Det sidan får se av desktop-appen: window.riptideDesktop. Finns inte i
   webbläsaren, så sidan vet därigenom om den körs som exe. */
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('claude:event', (_e, msg) => { for(const fn of listeners) fn(msg); });

// ipcRenderer.invoke slår in fel i "Error invoking remote method …"; sidan vill bara ha själva felet.
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(e => {
  throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
});

contextBridge.exposeInMainWorld('riptideDesktop', {
  nextWindow: () => call('desktop:next-window'),
  claude: {
    status: () => call('claude:status'),
    ask: req => call('claude:ask', req),
    sketch: req => call('claude:sketch', req),
    summary: req => call('claude:summary', req),
    cancel: id => call('claude:cancel', id),
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); }
  }
});
