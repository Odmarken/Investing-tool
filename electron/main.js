/**
 * Riptide som desktop-app (exe). Startar den lokala servern från dev-server.js
 * inuti appen och visar sidan i ett eget fönster, precis som `npm start` gör i
 * webbläsaren — med samma proxy för marknadsdata och RSS.
 *
 * Porten är 8080 med flit: Firebase-nyckeln är låst till localhost:8080, så
 * inloggningen fungerar bara därifrån. Kör `npm start` redan på 8080 används
 * den servern i stället.
 *
 * Extra i appen jämfört med webbläsaren (via preload.cjs):
 *   – Claude-chatten, som kör Claude Code med din egen inloggning
 *   – Dubbelfönster: ett andra Multiview-fönster, på den andra skärmen om du har två,
 *     öppnat från det första så att inloggningen följer med
 */
import { app, BrowserWindow, ipcMain, shell, screen, dialog, Menu } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '../dev-server.js';
import { createClaudeBridge } from './claude-bridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8080;
const BASE = `http://localhost:${PORT}/`;
const ORIGIN = new URL(BASE).origin;
const ICON = join(HERE, '..', 'build', 'icon.png');

const windows = new Map();            // fönsternummer → BrowserWindow
let bridge = null;

if(!app.requestSingleInstanceLock()) app.quit();
else{
  app.on('second-instance', () => {
    const w = windows.get(1) || [...windows.values()][0];
    if(w){ if(w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(start);
}

async function start(){
  Menu.setApplicationMenu(null);
  try{
    await startDevServer({ port: PORT, cron: false, quiet: true });
  }catch(e){
    if(e?.code !== 'EADDRINUSE' || !(await riptideAlreadyThere())){
      dialog.showErrorBox('Riptide kunde inte starta',
        `Port ${PORT} är upptagen av ett annat program.\n\nInloggningen fungerar bara på localhost:${PORT}, så stäng det programmet och starta Riptide igen.`);
      app.quit();
      return;
    }
  }
  bridge = createClaudeBridge({ workDir: join(app.getPath('userData'), 'claude-chat') });
  wireIpc();
  openWindow(1);
}

/* Kör `npm start` redan på samma port är det samma sida — den går bra att använda. */
async function riptideAlreadyThere(){
  try{
    const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
    return r.ok && (await r.text()).includes('RIPTIDE');
  }catch{ return false; }
}

const fromApp = e => { try{ return new URL(e.senderFrame.url).origin === ORIGIN; }catch{ return false; } };

function wireIpc(){
  /* Numret till nästa extra fönster. Sidan öppnar sedan fönstret själv med
     window.open(…, 'riptide-w' + n): då får det en kopia av sessionStorage, där
     inloggningen ligger när "Kom ihåg mig" är av — annars vore det utloggat. */
  ipcMain.handle('desktop:next-window', e => {
    if(!fromApp(e)) throw new Error('nekad');
    let n = 2;
    while(windows.has(n) || reserved.has(n)) n++;
    reserved.add(n);
    setTimeout(() => reserved.delete(n), 15000).unref?.();
    return n;
  });
  ipcMain.handle('claude:status', e => {
    if(!fromApp(e)) throw new Error('nekad');
    return bridge.status();
  });
  ipcMain.handle('claude:ask', (e, req) => {
    if(!fromApp(e)) throw new Error('nekad');
    const id = String(req?.id || '');
    return bridge.ask({ id, prompt: req?.prompt, sessionId: req?.sessionId }, ev => {
      if(!e.sender.isDestroyed()) e.sender.send('claude:event', { id, ...ev });
    });
  });
  ipcMain.handle('claude:sketch', (e, req) => {
    if(!fromApp(e)) throw new Error('nekad');
    const id = String(req?.id || '');
    return bridge.sketch({ id, prompt: req?.prompt }, ev => {
      if(!e.sender.isDestroyed()) e.sender.send('claude:event', { id, ...ev });
    });
  });
  ipcMain.handle('claude:summary', (e, req) => {
    if(!fromApp(e)) throw new Error('nekad');
    const id = String(req?.id || '');
    return bridge.summarize({ id, prompt: req?.prompt }, ev => {
      if(!e.sender.isDestroyed()) e.sender.send('claude:event', { id, ...ev });
    });
  });
  ipcMain.handle('claude:cancel', (e, id) => {
    if(!fromApp(e)) throw new Error('nekad');
    bridge.cancel(String(id || ''));
  });
}

const reserved = new Set();         // fönsternummer som sidan fått men inte öppnat än

function options(n, area){
  return {
    x: area.x + 40, y: area.y + 40,
    width: Math.min(1600, area.width - 80), height: Math.min(1000, area.height - 80),
    minWidth: 760, minHeight: 520,
    backgroundColor: '#03090c',
    title: n === 1 ? 'Riptide' : `Riptide · Multiview ${n}`,
    icon: existsSync(ICON) ? ICON : undefined,
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  };
}

/* Fönster 1 öppnar startsidan. Fönster 2, 3 … öppnas av sidan (window.open) och
   visar Multiview, helst på en annan skärm än fönstret man klickade i. */
function openWindow(n, opener = null){
  const win = new BrowserWindow(options(n, pickDisplay(opener).workArea));
  setup(win, n);
  void win.loadURL(n === 1 ? BASE : `${BASE}?w=${n}#multiview`);
  return win;
}

function setup(win, n){
  windows.set(n, win);
  reserved.delete(n);
  let shown = false;
  const reveal = () => { if(shown || win.isDestroyed()) return; shown = true; win.maximize(); win.show(); };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 4000).unref?.();
  win.on('closed', () => {
    windows.delete(n);
    if(n === 1) for(const w of windows.values()) w.close();   // huvudfönstret stänger hela appen
  });

  const wc = win.webContents;
  // Sidans egna fönster öppnas här, på den andra skärmen; länkar till andra sidor
  // (nyheter, Bybit …) öppnas i din vanliga webbläsare.
  wc.setWindowOpenHandler(({ url, frameName }) => {
    if(sameOrigin(url)){
      const m = /^riptide-w(\d+)$/.exec(frameName || '');
      const k = m ? Number(m[1]) : nextFree();
      return { action: 'allow', overrideBrowserWindowOptions: options(k, pickDisplay(win).workArea) };
    }
    if(/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child, { url }) => {
    let k = NaN;
    try{ k = Number(new URL(url).searchParams.get('w')); }catch{ /* ingen adress */ }
    setup(child, Number.isInteger(k) && k >= 2 && !windows.has(k) ? k : nextFree());
  });
  wc.on('will-navigate', (e, url) => {
    if(sameOrigin(url)) return;
    e.preventDefault();
    if(/^https?:/i.test(url)) void shell.openExternal(url);
  });
  // Utan meny: F5/Ctrl+R laddar om, F11 helskärm, F12/Ctrl+Shift+I utvecklarverktyg.
  wc.on('before-input-event', (e, input) => {
    if(input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if(key === 'f5' || (input.control && key === 'r')){ e.preventDefault(); wc.reload(); }
    else if(key === 'f11'){ e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if(key === 'f12' || (input.control && input.shift && key === 'i')){ e.preventDefault(); wc.toggleDevTools(); }
  });
}

function nextFree(){
  let n = 2;
  while(windows.has(n)) n++;
  return n;
}

function sameOrigin(url){
  try{ return new URL(url).origin === ORIGIN; }catch{ return false; }
}

function pickDisplay(opener){
  const all = screen.getAllDisplays();
  if(!opener) return screen.getPrimaryDisplay();
  const here = screen.getDisplayMatching(opener.getBounds());
  return all.find(d => d.id !== here.id) || here;
}

app.on('window-all-closed', () => {
  bridge?.stopAll();
  app.quit();
});
