/**
 * Lokal utvecklingsserver för Riptide Investments Panel.
 *
 *   node dev-server.js [--port 8080] [--demo]
 *
 * Serverar dashboarden på  http://localhost:8080/
 * och kör exakt samma kod som Cloudflare-workern på  http://localhost:8080/feed
 * (worker.js importeras rakt av, med ett filbaserat KV-substitut).
 *
 *   /feed/ingest  (POST)   samma format som TradingView-alertet skickar
 *   /feed/bars?s=NQ        dashboardens hämtning
 *   /feed/status           antal staplar och ålder per symbol
 *   /proxy?url=...         hämtar Yahoo och RSS åt sidan (löser CORS lokalt)
 *
 * Hemlig nyckel: FEED_KEY i miljön, annars "dev".
 * Staplarna sparas i .dev-bars.json så de överlever en omstart.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const INDEX = 'index.html';

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = +(opt('--port', process.env.PORT || 8080));
const HOST = opt('--host', '127.0.0.1');            // bara den här datorn — proxyn är öppen
const FEED_KEY = process.env.FEED_KEY || 'dev';

const DEMO_MODE = flag('--demo');
// låtsasstaplarna hålls isär från riktiga TradingView-staplar
const STORE = join(ROOT, DEMO_MODE ? '.dev-bars.demo.json' : '.dev-bars.json');

/* ---------- KV-substitut: samma get/put-yta som Cloudflare KV ---------- */
const mem = new Map(existsSync(STORE) ? Object.entries(JSON.parse(readFileSync(STORE, 'utf8'))) : []);
let flushTimer = null;
const flush = () => {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    writeFile(STORE, JSON.stringify(Object.fromEntries(mem)), 'utf8').catch(() => {});
  }, 250);
};
const env = {
  FEED_KEY,
  BARS: {
    async get(k){ return mem.has(k) ? mem.get(k) : null; },
    async put(k, v){ mem.set(k, v); flush(); },
    async delete(k){ mem.delete(k); flush(); }
  }
};

/* ---------- statiska filer ---------- */
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.md':'text/markdown; charset=utf-8', '.pine':'text/plain; charset=utf-8',
  '.toml':'text/plain; charset=utf-8'
};

async function serveStatic(req, res){
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if(rel === '/' || rel === '') rel = '/' + INDEX;
  const file = normalize(join(ROOT, rel));
  if(!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)){   // ingen katalogklättring
    res.writeHead(403).end('403');
    return;
  }
  try{
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    }).end(body);
  }catch{
    res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}).end('404 — hittar inte ' + rel);
  }
}

/* ---------- CORS-proxy: sidan får hämta Yahoo och RSS via oss ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/* Firebase Hosting serverar sin konfiguration på /__/firebase/init.json. Lokalt
   finns ingen sådan fil, och nycklarna ligger med flit inte i repot — så vi
   hämtar den från den publicerade sidan i stället. Då fungerar inloggning och
   realtidskonto även på localhost. Nyckeln är låst till bland annat
   localhost:8080 i Google Cloud, så den duger bara härifrån. */
const INIT_URL = 'https://riptide-investing-tool.web.app/__/firebase/init.json';
let initCache = null;
async function firebaseInit(){
  if(initCache && Date.now() - initCache.nar < 3600e3) return initCache.text;
  const r = await fetch(INIT_URL, { signal: AbortSignal.timeout(8000) });
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  initCache = { nar: Date.now(), text };
  return text;
}
const MAX_BODY = 8 * 1024 * 1024;

/* Några källor kräver att anropet ser ut att komma från deras egen sida. */
const EXTRA_HUVUDEN = {
  'economic-calendar.tradingview.com': {
    origin: 'https://www.tradingview.com',
    referer: 'https://www.tradingview.com/economic-calendar/'
  }
};


async function serveProxy(req, res){
  const head = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if(req.method === 'OPTIONS'){ res.writeHead(204, Object.assign({'access-control-allow-headers':'*'}, head)).end(); return; }
  const target = new URL(req.url, 'http://x').searchParams.get('url');
  let u = null;
  try{ u = new URL(target); }catch{ u = null; }
  if(!u || (u.protocol !== 'http:' && u.protocol !== 'https:')){
    res.writeHead(400, Object.assign({'content-type':'text/plain; charset=utf-8'}, head)).end('400 — ange ?url=https://...');
    return;
  }
  try{
    const r = await fetch(u, {
      redirect: 'follow',
      headers: Object.assign({ 'user-agent': UA, 'accept': '*/*', 'accept-language': 'en-US,en;q=0.9,sv;q=0.8' },
                             EXTRA_HUVUDEN[u.hostname] || {}),
      signal: AbortSignal.timeout(15000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if(buf.length > MAX_BODY) throw new Error('svaret är för stort');
    res.writeHead(r.status, Object.assign({'content-type': r.headers.get('content-type') || 'text/plain; charset=utf-8'}, head)).end(buf);
  }catch(e){
    res.writeHead(502, Object.assign({'content-type':'text/plain; charset=utf-8'}, head)).end('502 — ' + (e.message || 'kunde inte hämta'));
  }
}

/* ---------- workern, lokalt ---------- */
async function serveWorker(req, res, path){
  const url = new URL(path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), 'http://localhost:' + PORT);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const skip = new Set(['host','connection','keep-alive','transfer-encoding','upgrade','content-length']);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !skip.has(k)));
  const init = { method: req.method, headers };
  if(!['GET','HEAD'].includes(req.method) && chunks.length) init.body = Buffer.concat(chunks);
  const out = await worker.fetch(new Request(url, init), env);
  res.writeHead(out.status, Object.fromEntries(out.headers)).end(Buffer.from(await out.arrayBuffer()));
}

async function serveInit(req, res){
  try{
    const text = await firebaseInit();
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
    res.end(text);
  }catch(e){
    res.writeHead(502, { 'content-type':'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'nådde inte hostingens init.json: ' + e.message }));
  }
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const p = path === '/feed' ? '/' : path.startsWith('/feed/') ? path.slice(5) : null;
  const job = path === '/proxy' ? serveProxy(req, res)
            : path === '/__/firebase/init.json' ? serveInit(req, res)
            : p !== null ? serveWorker(req, res, p)
            : serveStatic(req, res);
  job.catch(e => { if(!res.headersSent) res.writeHead(500, {'content-type':'text/plain; charset=utf-8'}); res.end('500 — ' + e.message); });
});

/* ---------- demoflöde: låtsas-TradingView så hela kedjan går att prova ---------- */
const DEMO = { NQ: { px: 23150, vol: 0.0022 }, GC: { px: 3385, vol: 0.0016 } };
const STEP = 300000;

function makeBar(sym, t){
  const d = DEMO[sym];
  const sigma = d.px * d.vol;
  const o = d.px;
  const c = o + (Math.random() - 0.5) * sigma * 2;
  const h = Math.max(o, c) + Math.random() * sigma * 0.8;
  const l = Math.min(o, c) - Math.random() * sigma * 0.8;
  d.px = c;
  return { k: FEED_KEY, s: sym, t, o:+o.toFixed(2), h:+h.toFixed(2), l:+l.toFixed(2), c:+c.toFixed(2), v: Math.round(500 + Math.random() * 3000) };
}

async function post(bar){
  const r = await worker.fetch(new Request('http://localhost:' + PORT + '/ingest', {
    method:'POST', body: JSON.stringify(bar)
  }), env);
  return r.json();
}

async function seedDemo(n = 120){
  for(const sym of Object.keys(DEMO)){
    const now = Math.floor(Date.now() / STEP) * STEP;
    for(let i = n; i >= 1; i--) await post(makeBar(sym, now - i * STEP));
  }
  console.log(`  demoflöde: ${n} staplar per symbol inlagda via /feed/ingest`);
  const nextClose = () => {                       // vakna strax efter varje stapelstängning
    const wait = Math.ceil((Date.now() + 1) / STEP) * STEP + 2000 - Date.now();
    setTimeout(async () => {
      const t = Math.floor(Date.now() / STEP) * STEP - STEP;
      for(const sym of Object.keys(DEMO)) await post(makeBar(sym, t));
      console.log('  demoflöde: ny stapel ' + new Date(t).toLocaleTimeString('sv-SE'));
      nextClose();
    }, wait).unref?.();
  };
  nextClose();
}

/* Samma varv som Cloudflares cron kör i molnet — här lokalt var femte minut. */
async function lokalCron(){
  try{
    await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *' }, env, { waitUntil: p => p });
  }catch(e){ console.log('  demokonto: fel — ' + (e && e.message)); }
}

server.listen(PORT, HOST, async () => {
  console.log(`\nRiptide kör:     http://localhost:${PORT}/`);
  console.log(`Lokal proxy:     http://localhost:${PORT}/proxy?url=…   (sidan använder den av sig själv)`);
  console.log(`Lokal feed:      http://localhost:${PORT}/feed/status`);
  console.log(`FEED_KEY:        ${FEED_KEY}${process.env.FEED_KEY ? '' : '  (standard — sätt FEED_KEY för eget värde)'}`);
  if(DEMO_MODE){
    console.log('');
    console.log('  ⚠ DEMOFLÖDE: staplarna nedan är påhittade, inte marknadsdata.');
    await seedDemo();
    console.log('  Lägg in http://localhost:' + PORT + '/feed under ⚙ Inställningar för att se hela kedjan.');
  }
  console.log('Demokonto:       http://localhost:' + PORT + '/feed/konto   (räknas om var 5:e minut)');
  console.log('Avsluta med Ctrl+C.\n');
  lokalCron();
  setInterval(lokalCron, 300000).unref?.();
});
