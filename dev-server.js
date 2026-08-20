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
 *   /ai            (POST)  Miguel — strategichatten, till Claude eller via OpenRouter
 *   /ai/models     (GET)   vilka modeller som går att välja i chatten
 *
 * Hemlig nyckel: FEED_KEY i miljön, annars "dev".
 * Staplarna sparas i .dev-bars.json så de överlever en omstart.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import worker from './worker.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
let anthropic = null, anthropicFel = null;      // Anthropic-klienten, nollställs när nyckeln byts
const INDEX = 'index.html';

/* Nycklar får ligga i .dev.vars (KEY=VÄRDE per rad) i stället för i miljön.
   Filen läses om när den ändras, så du slipper starta om servern när du lägger in en nyckel. */
const ENV_VID_START = Object.assign({}, process.env);
let devVarsTid = -1;
function laddaDevVars(){
  try{
    const fil = join(ROOT, '.dev.vars');
    if(!existsSync(fil)){ devVarsTid = -1; return; }
    const tid = statSync(fil).mtimeMs;
    if(tid === devVarsTid) return;
    devVarsTid = tid;
    readFileSync(fil, 'utf8').split(/\r?\n/).forEach(rad => {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(rad);
      if(!m || ENV_VID_START[m[1]]) return;          // en satt miljövariabel vinner
      const varde = m[2].trim().replace(/^["']|["']$/g, '');
      if(!varde || varde.includes('...')) return;    // mallens platshållare räknas som tom
      if(process.env[m[1]] !== varde){
        process.env[m[1]] = varde;
        if(m[1] === 'ANTHROPIC_API_KEY') anthropic = null;   // tvinga fram en ny klient
      }
    });
  }catch{ /* struntsak — kör vidare utan filen */ }
}
laddaDevVars();

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
const MAX_BODY = 8 * 1024 * 1024;

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
      headers: { 'user-agent': UA, 'accept': '*/*', 'accept-language': 'en-US,en;q=0.9,sv;q=0.8' },
      signal: AbortSignal.timeout(15000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if(buf.length > MAX_BODY) throw new Error('svaret är för stort');
    res.writeHead(r.status, Object.assign({'content-type': r.headers.get('content-type') || 'text/plain; charset=utf-8'}, head)).end(buf);
  }catch(e){
    res.writeHead(502, Object.assign({'content-type':'text/plain; charset=utf-8'}, head)).end('502 — ' + (e.message || 'kunde inte hämta'));
  }
}

/* ---------- Miguel: strategichatten ---------- */
const MIGUEL_MODELL = 'claude-opus-5';
const MIGUEL_SYSTEM = `Du är Miguel, en erfaren och skeptisk handlare som granskar en annan persons
signalmotor för Nasdaq-terminen (NQ, 5-minutersgraf). Du talar svenska, rakt och kortfattat.

Ditt jobb är att granska strategierna, inte att heja på dem:
- Peka på svagheter i reglerna, i logiken och i hur de mäts. Var konkret.
- Ifrågasätt urval och statistik: för få affärer, överanpassning, look-ahead, survivorship, kostnader.
- Säg tydligt när underlaget är för tunt för en slutsats i stället för att gissa.
- Föreslå vad som konkret kan testas eller ändras, gärna en sak i taget.

Regler du måste följa:
- Använd bara siffror som finns i dataunderlaget nedan. Hitta aldrig på nivåer, utfall eller statistik.
- Saknas något du behöver: säg vad som saknas.
- Du ger ingen personlig finansiell rådgivning och lovar inga resultat. Ingen brasklapp i varje svar,
  men var ärlig när något är osäkert.
- Svara i löpande text med korta stycken. Punktlistor bara när de verkligen hjälper. Inga rubriker
  om svaret är kort. Håll dig under 250 ord om inte frågan kräver mer.`;

function miguelKlient(){
  if(anthropic) return anthropic;
  // SDK:t hittar nyckeln i ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN eller en profil från `ant auth login`.
  try{ anthropic = new Anthropic(); }
  catch(e){ anthropicFel = e && e.message; anthropic = null; }
  return anthropic;
}

/* ---------- OpenRouter: samma chatt, valfri modell ---------- */
const OR_BAS = 'https://openrouter.ai/api/v1';
const OR_LEVERANTORER = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'meta-llama', 'mistralai', 'qwen'];
const OR_PER_LEVERANTOR = 8;
let orCache = { tid: 0, lista: [] };

const orNyckel = () => process.env.OPENROUTER_API_KEY || '';

async function orModeller(){
  if(orCache.lista.length && Date.now() - orCache.tid < 600000) return orCache.lista;   // 10 min
  const r = await fetch(OR_BAS + '/models', { signal: AbortSignal.timeout(15000) });
  if(!r.ok) throw new Error('OpenRouter svarade ' + r.status);
  const alla = (await r.json()).data || [];
  const perLev = {};
  const lista = [];
  alla
    .filter(m => {
      if(!m || !m.id || m.id.includes(':batch')) return false;
      if(!OR_LEVERANTORER.includes(m.id.split('/')[0])) return false;
      const ut = (m.architecture && m.architecture.output_modalities) || ['text'];
      return ut.length === 1 && ut[0] === 'text';        // chatten vill ha text ut, inte bild eller ljud
    })
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .forEach(m => {
      const lev = m.id.split('/')[0];
      const pris = p2 => { const v = Number(p2) * 1e6; return isFinite(v) ? Math.round(v * 100) / 100 : null; };
      const gratis = Number(m.pricing && m.pricing.prompt) === 0 && Number(m.pricing && m.pricing.completion) === 0;
      if(!gratis){                                  // gratismodeller kommer alltid med
        perLev[lev] = (perLev[lev] || 0) + 1;
        if(perLev[lev] > OR_PER_LEVERANTOR) return;
      }
      lista.push({
        id: m.id, lev, gratis,
        namn: String(m.name || m.id).replace(/^[^:]+:\s*/, ''),
        ctx: m.context_length || null,
        in: pris(m.pricing && m.pricing.prompt),
        ut: pris(m.pricing && m.pricing.completion)
      });
    });
  lista.sort((a, b) => OR_LEVERANTORER.indexOf(a.lev) - OR_LEVERANTORER.indexOf(b.lev)
                    || (a.gratis === b.gratis ? 0 : (a.gratis ? 1 : -1))
                    || a.namn.localeCompare(b.namn, 'sv'));
  orCache = { tid: Date.now(), lista };
  return lista;
}

async function serveAIModels(req, res){
  laddaDevVars();
  const head = { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
  const svar = {
    direkt: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    direktModell: MIGUEL_MODELL,
    openrouter: !!orNyckel(),
    modeller: []
  };
  if(svar.openrouter){
    try{ svar.modeller = await orModeller(); }
    catch(e){ svar.fel = 'Kunde inte hämta modellistan: ' + (e.message || e); }
  }
  res.writeHead(200, head).end(JSON.stringify(svar));
}

/* OpenRouter strömmar OpenAI-format: rader med "data: {...}" och till sist "data: [DONE]". */
async function orStrom(modell, system, meddelanden, skriv, maxTokens){
  const tak = maxTokens || Number(process.env.MIGUEL_MAX_TOKENS) || 4000;
  const r = await fetch(OR_BAS + '/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + orNyckel(),
      'content-type': 'application/json',
      'http-referer': 'http://localhost:' + PORT,
      'x-title': 'Riptide Investments Panel'
    },
    body: JSON.stringify({
      model: modell,
      max_tokens: tak,
      stream: true,
      messages: [{ role: 'system', content: system }].concat(meddelanden)
    }),
    signal: AbortSignal.timeout(180000)
  });

  if(!r.ok || !r.body){
    let detalj = '';
    try{ detalj = (await r.text()).slice(0, 400); }catch{ /* strunt */ }
    // 402: saldot räcker inte för så många tokens — ta det som går i stället för att falla
    const rad = /can only afford (\d+)/i.exec(detalj);
    if(r.status === 402 && rad && !maxTokens){
      const gar = Math.max(200, Number(rad[1]) - 50);
      skriv('info', 'Saldot räcker till ' + gar + ' tokens — kortar svaret.');
      return orStrom(modell, system, meddelanden, skriv, gar);
    }
    if(r.status === 402){
      throw new Error('OpenRouter: krediten räcker inte. Fyll på på openrouter.ai/settings/credits.');
    }
    throw new Error('OpenRouter ' + r.status + (detalj ? ': ' + detalj : ''));
  }

  let buf = '', fick = false;
  for await (const bit of r.body){
    buf += Buffer.from(bit).toString('utf8');
    let ix;
    while((ix = buf.indexOf('\n')) >= 0){
      const rad = buf.slice(0, ix).trim(); buf = buf.slice(ix + 1);
      if(!rad || rad.startsWith(':')) continue;                 // kommentarer är keep-alive
      if(!rad.startsWith('data:')) continue;
      const nyttolast = rad.slice(5).trim();
      if(nyttolast === '[DONE]') return fick;
      let o; try{ o = JSON.parse(nyttolast); }catch{ continue; }
      if(o.error) throw new Error(o.error.message || 'okänt fel från OpenRouter');
      const d = o.choices && o.choices[0] && o.choices[0].delta;
      if(d && typeof d.content === 'string' && d.content){ fick = true; skriv('delta', d.content); }
    }
  }
  return fick;
}

async function serveAI(req, res){
  laddaDevVars();
  const head = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if(req.method === 'OPTIONS'){ res.writeHead(204, {...head, 'access-control-allow-headers':'*'}).end(); return; }
  if(req.method !== 'POST'){ res.writeHead(405, head).end(); return; }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let kropp = {};
  try{ kropp = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }catch{ kropp = {}; }

  const skriv = (t, v) => res.write(JSON.stringify({ t, v }) + '\n');
  res.writeHead(200, { ...head, 'content-type': 'application/x-ndjson; charset=utf-8' });

  const valdModell = typeof kropp.model === 'string' ? kropp.model.trim() : '';
  const viaOR = valdModell && valdModell !== 'direkt' && valdModell !== MIGUEL_MODELL;

  if(viaOR && !orNyckel()){
    skriv('error', 'Ingen OpenRouter-nyckel. Lägg OPENROUTER_API_KEY=sk-or-... i .dev.vars och starta om servern.');
    res.end(); return;
  }

  const klient = viaOR ? true : miguelKlient();
  if(!klient){
    skriv('error', 'Ingen API-nyckel hittad' + (anthropicFel ? ' (' + anthropicFel + ')' : '') +
      '. Lägg ANTHROPIC_API_KEY=sk-... i filen .dev.vars bredvid dev-server.js, eller sätt den i miljön, och starta om servern.');
    res.end(); return;
  }

  const meddelanden = (Array.isArray(kropp.messages) ? kropp.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-120)
    .map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
  if(!meddelanden.length){ skriv('error', 'Tomt meddelande.'); res.end(); return; }

  const underlag = 'DATAUNDERLAG FRÅN DASHBOARDEN JUST NU:\n' +
                   String(kropp.context || '(inget underlag skickades)').slice(0, 20000);
  const system = [
    { type: 'text', text: MIGUEL_SYSTEM },
    { type: 'text', text: underlag }
  ];

  if(viaOR){                                        // samma Miguel, annan modell
    try{
      const fick = await orStrom(valdModell, MIGUEL_SYSTEM + '\n\n' + underlag, meddelanden, skriv);
      if(!fick) skriv('error', 'Tomt svar från ' + valdModell + '.');
    }catch(e){
      skriv('error', (e && e.name === 'TimeoutError') ? 'Tidsgränsen gick ut mot OpenRouter.' : ('Fel: ' + (e && e.message || e)));
    }
    skriv('done', '');
    res.end(); return;
  }

  const params = {
    model: MIGUEL_MODELL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system,
    messages: meddelanden
  };

  try{
    let stream;
    try{
      // Server-side fallback: refuserar modellen körs frågan om på en annan modell i samma anrop.
      stream = klient.beta.messages.stream({
        ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'
      });
    }catch(e){
      stream = klient.messages.stream(params);
    }

    let fickText = false;
    try{
      for await (const ev of stream){
        if(ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta'){
          fickText = true;
          skriv('delta', ev.delta.text);
        }
      }
    }catch(e){
      if(!fickText && (e instanceof Anthropic.BadRequestError)){
        const s2 = klient.messages.stream(params);          // utan beta-flaggan
        for await (const ev of s2){
          if(ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta'){
            fickText = true; skriv('delta', ev.delta.text);
          }
        }
        const slut2 = await s2.finalMessage();
        if(slut2.stop_reason === 'refusal') skriv('error', 'Miguel avböjde att svara på den frågan.');
        skriv('done', ''); res.end(); return;
      }
      throw e;
    }

    const slut = await stream.finalMessage();
    if(slut.stop_reason === 'refusal') skriv('error', 'Miguel avböjde att svara på den frågan.');
    else if(!fickText) skriv('error', 'Tomt svar från modellen.');
    skriv('done', '');
  }catch(e){
    const meddelande = (e && e.message) || String(e);
    const txt = /resolve authentication|api[_ -]?key/i.test(meddelande) && !(e instanceof Anthropic.APIError)
                                                         ? 'Ingen API-nyckel hittad. Lägg ANTHROPIC_API_KEY=sk-... i filen .dev.vars bredvid dev-server.js (eller sätt den i miljön) och starta om servern.'
              : e instanceof Anthropic.AuthenticationError ? 'Nyckeln godtogs inte (401). Kontrollera ANTHROPIC_API_KEY.'
              : e instanceof Anthropic.RateLimitError     ? 'Rate limit — vänta en stund och försök igen.'
              : e instanceof Anthropic.APIError           ? ('API-fel ' + e.status + ': ' + meddelande)
              : ('Fel: ' + meddelande);
    skriv('error', txt);
  }
  res.end();
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

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const p = path === '/feed' ? '/' : path.startsWith('/feed/') ? path.slice(5) : null;
  const job = path === '/proxy' ? serveProxy(req, res)
            : path === '/ai/models' ? serveAIModels(req, res)
            : path === '/ai' ? serveAI(req, res)
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

server.listen(PORT, HOST, async () => {
  console.log(`\nRiptide kör:     http://localhost:${PORT}/`);
  console.log(`Lokal proxy:     http://localhost:${PORT}/proxy?url=…   (sidan använder den av sig själv)`);
  console.log(`Lokal feed:      http://localhost:${PORT}/feed/status`);
  console.log(`FEED_KEY:        ${FEED_KEY}${process.env.FEED_KEY ? '' : '  (standard — sätt FEED_KEY för eget värde)'}`);
  const harNyckel = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  console.log(`Miguel (chatt):  ${harNyckel ? 'Anthropic-nyckel hittad · ' + MIGUEL_MODELL : 'ingen ANTHROPIC_API_KEY'}`);
  console.log(`OpenRouter:      ${orNyckel() ? 'nyckel hittad — modellväljaren i chatten är påslagen' : 'ingen OPENROUTER_API_KEY'}`);
  if(!harNyckel && !orNyckel()) console.log('                 (lägg minst en av nycklarna i .dev.vars, annars svarar chatten inte)');
  if(DEMO_MODE){
    console.log('');
    console.log('  ⚠ DEMOFLÖDE: staplarna nedan är påhittade, inte marknadsdata.');
    await seedDemo();
    console.log('  Lägg in http://localhost:' + PORT + '/feed under ⚙ Inställningar för att se hela kedjan.');
  }
  console.log('Avsluta med Ctrl+C.\n');
});
