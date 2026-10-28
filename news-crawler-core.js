/* Pablo scannings logik, utan DOM: vilka sidor orben åker till, vilka mynt och
   vilken ton en rubrik har, hur nya fynd läggs ihop med de gamla och hur en sida
   summeras. Tonen är en enkel ordräkning (stiger/faller-ord), inte en modell. */

export const COINS = Object.freeze([
  ['BTC', /\b(btc|bitcoin)\b/i],
  ['ETH', /\b(eth|ether|ethereum)\b/i],
  ['SOL', /\b(sol|solana)\b/i],
  ['XRP', /\b(xrp|ripple)\b/i],
  ['DOGE', /\b(doge|dogecoin)\b/i],
  ['SHIB', /\b(shib|shiba)\b/i],
  ['PEPE', /\bpepe\b/i]
]);
export const MACRO = Object.freeze([
  ['FED', /\b(fed|fomc|powell|riksbank\w*|ecb|interest rates?|räntan?)\b/i],
  ['INFL', /\b(cpi|inflation|inflationen|pce)\b/i],
  ['NQ', /\b(nasdaq|s&p ?500|wall street|stocks?|börsen)\b/i]
]);

const UP = /\b(surges?|soars?|rall(y|ies)|jumps?|climbs?|gains?|rises?|rebounds?|record high|all-time high|bullish|inflows?|approv\w*|breaks? out|stiger|rusar|lyfter|ökar|rekord)\b/i;
const DOWN = /\b(plunges?|crash(es)?|drops?|falls?|slumps?|tumbles?|sinks?|slides?|hack(ed|s)?|exploit|lawsuit|sues?|bans?|outflows?|bearish|sell-?off|liquidat\w*|fears?|faller|rasar|sjunker|minskar|oro)\b/i;

/* Från inställningarnas listor till orbens sidor: {id, url, name, group}, utan dubbletter. */
export function buildSources({ krypto = [], feeds = [], feedsSe = [] } = {}){
  const out = [], seen = new Set();
  for(const [group, list] of [['krypto', krypto], ['intl', feeds], ['se', feedsSe]]){
    for(const raw of list || []){
      const url = String(raw || '').trim();
      if(!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ id: 'src' + out.length, url, name: sourceName(url), group });
    }
  }
  return out;
}

/* Kort namn på en sida. Google News-sökningar får sitt första sökord, annars heter alla likadant. */
export function sourceName(url){
  let u;
  try{ u = new URL(url); }catch{ return 'Källa'; }
  const host = u.hostname.replace(/^www\./, '');
  if(host.includes('google')){
    const q = (u.searchParams.get('q') || '').replace(/\bwhen:\S+/g, '').replace(/[()"+]/g, ' ').trim();
    const word = q.split(/\s+|\bOR\b/).find(w => w && w !== 'OR') || '';
    return word ? 'Google · ' + word.slice(0, 14) : 'Google News';
  }
  if(host.includes('dowjones')) return 'MarketWatch';
  if(host.includes('investing.com')){
    const part = u.pathname.split('/').pop().replace(/\.rss$/, '').replace(/_\d+$/, '').replace(/_/g, ' ');
    return 'Investing' + (part && part !== 'news' ? ' · ' + part.slice(0, 12) : '');
  }
  const name = host.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/* Mynt, makroord och ton för en rubrik. tone: 1 upp, -1 ner, 0 neutral. */
export function tagHeadline(title, desc = ''){
  const text = String(title || '') + ' ' + String(desc || '').slice(0, 200);
  const coins = COINS.filter(([, re]) => re.test(text)).map(([k]) => k);
  const macro = MACRO.filter(([, re]) => re.test(text)).map(([k]) => k);
  const up = UP.test(title), down = DOWN.test(title);
  return { coins, macro, tone: up === down ? 0 : up ? 1 : -1 };
}

const keyOf = title => String(title || '').toLowerCase().replace(/[^a-z0-9åäö ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);

/* Lägger nya fynd till de gamla. Rubriker orben inte sett förut får
   och found=now; allt sorteras nyast först och kapas vid max. */
export function mergeItems(prev, incoming, { now = Date.now(), max = 240, source = null } = {}){
  const byKey = new Map();
  for(const it of prev || []) byKey.set(keyOf(it.title), it);
  let added = 0;
  for(const it of incoming || []){
    const k = keyOf(it.title);
    if(!k || k.length < 8 || byKey.has(k)) continue;
    const ts = Number.isFinite(it.ts) ? Math.min(it.ts, now) : now;
    const desc = String(it.desc || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    byKey.set(k, { title: String(it.title), link: String(it.link || ''), src: String(it.src || source?.name || 'Källa'), desc,
      group: source?.group || it.group || 'intl', ts, found: now, ...tagHeadline(it.title, it.desc) });
    added++;
  }
  const items = [...byKey.values()].sort((a, b) => b.ts - a.ts).slice(0, max);
  return { items, added };
}

/* Orbens fynd som underlag till Claude: nyast först, en rad per rubrik. */
export function headlineBrief(items, { now = Date.now(), limit = 25 } = {}){
  return (items || []).slice(0, limit).map(it => {
    const tags = [...(it.coins || []), ...(it.macro || [])].join(',');
    return `- [${it.src}, ${ago(now - it.ts)}${tags ? ', ' + tags : ''}] ${it.title}`;
  }).join('\n');
}

/* Frågan till Pablo om en sidas nya rubriker (högst tolv, med ingressen avkortad). */
export function summaryPrompt(name, items){
  const list = (items || []).slice(0, 12).map(it => {
    const desc = String(it.desc || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    return `- ${it.title}${desc ? ' — ' + desc : ''}`;
  });
  return [
    `Pablo scanning har just läst ${name} och hittat ${(items || []).length} nya rubriker:`,
    list.join('\n'),
    'Skriv en summering på svenska i högst tre korta meningar (högst 400 tecken): vad som är nytt och vad det kan betyda för krypto och marknaden. Nämn mynt och makro om de finns. Ingen rubrik, inga punktlistor, inga råd.'
  ].join('\n\n');
}

/* Summeringen utan Claude: antalet, mynten och makroorden med antal, tonen och den senaste rubriken. */
export function localSummary(items){
  const list = items || [];
  if(!list.length) return 'Inga nya rubriker.';
  const tags = new Map();
  let up = 0, down = 0;
  for(const it of list){
    for(const k of [...(it.coins || []), ...(it.macro || [])]) tags.set(k, (tags.get(k) || 0) + 1);
    if(it.tone > 0) up++; else if(it.tone < 0) down++;
  }
  const named = [...tags].sort((a, b) => b[1] - a[1]).map(([k, n]) => n > 1 ? `${k} ×${n}` : k).join(', ');
  const tone = up || down ? `▲${up} ▼${down}` : 'neutral ton';
  const last = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  return `${list.length} ${list.length === 1 ? 'ny rubrik' : 'nya rubriker'}${named ? ' om ' + named : ''} · ${tone}. Senaste: ${last.title}`;
}

/* Pablos summering via desktop-appen (window.riptideDesktop.claude.summary).
   connectSummary(api) → run(prompt, onDelta) → {done: Promise<text>, cancel()} | null utan appen */
let seq = 0;
export function connectSummary(api = globalThis.riptideDesktop?.claude){
  if(typeof api?.summary !== 'function') return null;
  return (prompt, onDelta) => {
    const id = 'summary-' + Date.now().toString(36) + '-' + (++seq);
    const off = api.onEvent?.(ev => { if(ev?.id === id && ev.delta) onDelta(ev.delta); });
    const done = Promise.resolve(api.summary({ id, prompt })).then(r => r?.text ?? '').finally(() => off?.());
    return { done, cancel: () => { void api.cancel?.(id); } };
  };
}

export function ago(ms){
  const m = Math.max(0, Math.round(ms / 60000));
  if(m < 1) return 'nyss';
  if(m < 60) return m + ' min';
  const h = Math.round(m / 60);
  return h < 48 ? h + ' h' : Math.round(h / 24) + ' d';
}

/* Översikten i nyhetspanelen: per mynt och makroord hur många rubriker som
   nämner det, hur många med stiger- respektive faller-ord, och hur många som
   kommit den senaste timmen. Bara det som nämns minst en gång tas med. */
export function overview(items, { now = Date.now() } = {}){
  const rows = new Map([...COINS, ...MACRO].map(([k]) => [k, { k, n: 0, up: 0, down: 0, hour: 0 }]));
  let hour = 0;
  for(const it of items || []){
    const recent = now - it.ts <= 3600000;
    if(recent) hour++;
    for(const k of [...(it.coins || []), ...(it.macro || [])]){
      const r = rows.get(k);
      if(!r) continue;
      r.n++; if(it.tone > 0) r.up++; else if(it.tone < 0) r.down++;
      if(recent) r.hour++;
    }
  }
  return { total: (items || []).length, hour, rows: [...rows.values()].filter(r => r.n) };
}
