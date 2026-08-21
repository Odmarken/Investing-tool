/**
 * Riptide feed — Cloudflare Worker
 * Tar emot 5-minutersstaplar från TradingView-alerts och serverar dem till dashboarden.
 *
 *  POST /ingest   {"k":"HEMLIG","s":"NQ","t":1755700200000,"o":..,"h":..,"l":..,"c":..,"v":..}
 *  GET  /bars?s=NQ   ->  [{t,o,h,l,c,v}, ...]  (CORS öppet)
 *  GET  /status      ->  antal staplar och ålder per symbol
 *
 * Kräver: KV-namespace bundet som BARS, samt hemligheten FEED_KEY.
 * Cron (se [triggers] i wrangler.toml) kör demokontot var femte minut: stänger
 * positioner som nått stopp eller mål och öppnar nya A- och B-setups, helt utan
 * att någon sida är öppen.
 */
import { kontoTick, lasKonto, skrivKonto, tomtKonto, kontoUtsida } from './konto.js';

const SYMBOLS = ['NQ', 'GC'];
const KEEP = 400;                       // ~33 h av 5-minutersstaplar

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*'
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    /* ---------- TradingView postar hit ---------- */
    if (url.pathname === '/ingest' && req.method === 'POST') {
      const raw = await req.text();
      let b;
      try { b = JSON.parse(raw); }
      catch { return json({ error: 'ogiltig JSON', got: raw.slice(0, 120) }, 400); }

      if (!env.FEED_KEY || b.k !== env.FEED_KEY) return json({ error: 'fel nyckel' }, 401);

      const sym = String(b.s || '').toUpperCase();
      if (!SYMBOLS.includes(sym)) return json({ error: 'okänd symbol', sym }, 400);

      const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      let t = num(b.t);
      if (t === null) return json({ error: 'saknar tid' }, 400);
      if (t < 1e12) t *= 1000;                        // sekunder -> millisekunder
      t = Math.floor(t / 300000) * 300000;            // snäpp till 5-minutersgräns

      const bar = { t, o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: num(b.v) || 0 };
      if ([bar.o, bar.h, bar.l, bar.c].some(v => v === null)) return json({ error: 'ofullständig stapel' }, 400);

      const bars = JSON.parse((await env.BARS.get(sym)) || '[]');
      const ix = bars.findIndex(x => x.t === t);
      if (ix >= 0) bars[ix] = bar; else bars.push(bar);   // samma stapel skrivs över
      bars.sort((x, y) => x.t - y.t);

      const kept = bars.slice(-KEEP);
      await env.BARS.put(sym, JSON.stringify(kept));
      return json({ ok: true, sym, bars: kept.length, t });
    }

    /* ---------- dashboarden hämtar härifrån ---------- */
    if (url.pathname === '/bars') {
      const sym = String(url.searchParams.get('s') || 'NQ').toUpperCase();
      if (!SYMBOLS.includes(sym)) return json([], 200);
      return json(JSON.parse((await env.BARS.get(sym)) || '[]'));
    }

    /* ---------- demokontot ---------- */
    if(url.pathname === '/konto' && req.method === 'GET'){
      return json(kontoUtsida(await lasKonto(env)));
    }

    if(url.pathname === '/konto/tick'){
      if(!env.FEED_KEY || url.searchParams.get('k') !== env.FEED_KEY) return json({ error: 'fel nyckel' }, 401);
      const rader = [];
      const konto = await kontoTick(env, r => rader.push(r));
      return json({ ok: true, handelser: rader, konto: kontoUtsida(konto) });
    }

    if(url.pathname === '/konto/nollstall' && req.method === 'POST'){
      let b = {};
      try{ b = JSON.parse(await req.text() || '{}'); }catch{ b = {}; }
      if(!env.FEED_KEY || b.k !== env.FEED_KEY) return json({ error: 'fel nyckel' }, 401);
      const nytt = tomtKonto();
      await skrivKonto(env, nytt);
      return json({ ok: true, konto: kontoUtsida(nytt) });
    }

    if (url.pathname === '/status') {
      const out = {};
      for (const sym of SYMBOLS) {
        const bars = JSON.parse((await env.BARS.get(sym)) || '[]');
        const newest = bars.length ? bars[bars.length - 1].t : null;
        out[sym] = {
          bars: bars.length,
          senaste: newest ? new Date(newest).toISOString() : null,
          alderMin: newest ? Math.round((Date.now() - newest) / 60000) : null
        };
      }
      return json(out);
    }

    return json({ tjanst: 'riptide-feed',
      endpoints: ['/ingest (POST)', '/bars?s=NQ', '/status', '/konto', '/konto/tick?k=…', '/konto/nollstall (POST)'] });
  },

  /* Cron: ett varv på demokontot. Körs även när ingen sida är öppen. */
  async scheduled(event, env, ctx){
    ctx.waitUntil(kontoTick(env).catch(e => console.log('kontoTick fel: ' + (e && e.message))));
  }
};
