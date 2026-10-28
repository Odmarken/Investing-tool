import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildSources, sourceName, tagHeadline, mergeItems, headlineBrief, ago, overview, summaryPrompt, localSummary, connectSummary } from '../news-crawler-core.js';
import { readHeadline } from '../news-desk.js';
import { equityPoints } from '../account-panel.js';
import { renderMarkdown } from '../claude-chat.js';
import { windowNumber, readLayout, DOUBLE } from '../multiview.js';
import { readLine, findClaude, createClaudeBridge } from '../electron/claude-bridge.js';
import { createSketchReader, sketchPrompt } from '../claude-sketch.js';

const T = Date.parse('2026-10-23T12:00:00Z');

test('buildSources keeps the order krypto, intl, se and drops duplicates and non-http urls', () => {
  const s = buildSources({ krypto: ['https://cointelegraph.com/rss', 'ftp://x'], feeds: ['https://cointelegraph.com/rss', 'https://www.cnbc.com/id/1/rss.html'], feedsSe: ['https://www.di.se/rss'] });
  assert.deepEqual(s.map(x => [x.group, x.name]), [['krypto', 'Cointelegraph'], ['intl', 'Cnbc'], ['se', 'Di']]);
  assert.deepEqual(s.map(x => x.id), ['src0', 'src1', 'src2']);
});

test('sourceName tells Google News searches and Investing feeds apart', () => {
  assert.equal(sourceName('https://news.google.com/rss/search?q=(bitcoin+OR+ethereum)+when:1d&hl=en-US'), 'Google · bitcoin');
  assert.equal(sourceName('https://www.investing.com/rss/news_25.rss'), 'Investing');
  assert.equal(sourceName('https://www.investing.com/rss/commodities.rss'), 'Investing · commodities');
  assert.equal(sourceName('https://feeds.content.dowjones.io/public/rss/mw_topstories'), 'MarketWatch');
  assert.equal(sourceName('not a url'), 'Källa');
});

test('tagHeadline finds coins, macro words and the tone of the title', () => {
  assert.deepEqual(tagHeadline('Bitcoin surges past record as ETF inflows climb'), { coins: ['BTC'], macro: [], tone: 1 });
  assert.deepEqual(tagHeadline('Solana and XRP plunge after exchange hack'), { coins: ['SOL', 'XRP'], macro: [], tone: -1 });
  assert.deepEqual(tagHeadline('Fed holds rates; stocks mixed'), { coins: [], macro: ['FED', 'NQ'], tone: 0 });
  // Both kinds of words: neutral, not a guess.
  assert.equal(tagHeadline('Ether rises while Bitcoin falls').tone, 0);
  assert.equal(tagHeadline('Börsen rasar efter räntebeskedet').tone, -1);
});

test('mergeItems adds only unseen titles, stamps them and sorts newest first', () => {
  const src = { name: 'Coindesk', group: 'krypto' };
  const a = mergeItems([], [{ title: 'Bitcoin climbs above 120k', ts: T - 60000, link: 'https://a' }, { title: 'short' }], { now: T, source: src });
  assert.equal(a.added, 1);
  assert.equal(a.items[0].src, 'Coindesk');
  assert.equal(a.items[0].found, T);
  assert.deepEqual(a.items[0].coins, ['BTC']);
  const b = mergeItems(a.items, [{ title: 'BITCOIN climbs above 120k!', ts: T }, { title: 'Ethereum slides as ETF outflows grow', ts: T + 999999 }], { now: T + 5000, source: src });
  assert.equal(b.added, 1);
  assert.equal(b.items.length, 2);
  assert.equal(b.items[0].title, 'Ethereum slides as ETF outflows grow');
  assert.equal(b.items[0].ts, T + 5000, 'a future timestamp is clamped to now');
  assert.equal(b.items[1].found, T, 'an old find keeps its first stamp');
  const many = Array.from({ length: 30 }, (_, i) => ({ title: 'Headline number ' + i, ts: T - i }));
  assert.equal(mergeItems([], many, { now: T, max: 10 }).items.length, 10);
});

test('headlineBrief writes one line per headline with source, age and tags', () => {
  const { items } = mergeItems([], [{ title: 'Bitcoin climbs above 120k', ts: T - 3 * 60000 }], { now: T, source: { name: 'Coindesk' } });
  assert.equal(headlineBrief(items, { now: T }), '- [Coindesk, 3 min, BTC] Bitcoin climbs above 120k');
  assert.equal(ago(20000), 'nyss');
  assert.equal(ago(3 * 3600000), '3 h');
  assert.equal(ago(72 * 3600000), '3 d');
});

test('renderMarkdown escapes html and renders the small markdown subset', () => {
  assert.equal(renderMarkdown('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(renderMarkdown('**BTC** `1h`'), '<b>BTC</b> <code>1h</code>');
  assert.equal(renderMarkdown('[a](https://x.se)'), '<a href="https://x.se" target="_blank" rel="noopener noreferrer">a</a>');
  assert.equal(renderMarkdown('[a](javascript:alert(1))'), '[a](javascript:alert(1))');
  assert.equal(renderMarkdown('- one\n- two'), '<span class="ch-li">one</span><span class="ch-li">two</span>');
  assert.equal(renderMarkdown('- one\n\n- two\n\nslut'), '<span class="ch-li">one</span><span class="ch-li">two</span><br><br>slut');
  assert.equal(renderMarkdown('```js\n<x>\n```'), '<pre><code>&lt;x&gt;</code></pre>');
});

test('windowNumber and readLayout', () => {
  assert.equal(windowNumber(''), 1);
  assert.equal(windowNumber('?w=2'), 2);
  assert.equal(windowNumber('?w=1'), 1);
  assert.equal(windowNumber('?w=abc'), 1);
  // The main window starts with AI Forecast and the spider; an extra window with the account and the news.
  assert.deepEqual(readLayout(null), { forecast: true, konto: false, nyheter: false, crawler: true, part: 'all' });
  assert.deepEqual(readLayout(null, 2), { forecast: false, konto: true, nyheter: true, crawler: false, part: 'all' });
  assert.deepEqual(readLayout({ forecast: false, crawler: 'yes' }), { forecast: false, konto: false, nyheter: false, crawler: true, part: 'all' });
  const none = { forecast: false, konto: false, nyheter: false, crawler: false };
  assert.equal(readLayout(none).forecast, true, 'never an empty window');
  assert.equal(readLayout(none, 3).konto, true);
  // Dubbelfönster: the chart alone in one window, the spider and all the info in the other.
  assert.deepEqual(readLayout(DOUBLE.chart), { ...DOUBLE.chart });
  assert.deepEqual(readLayout({ ...DOUBLE.info, with: 1 }, 2), { ...DOUBLE.info, with: 1 });
  assert.equal(readLayout({ ...DOUBLE.info, with: 2 }, 2).with, undefined, 'never follows itself');
  assert.equal(readLayout({ part: 'graf' }).part, 'all');
});

test('readLine turns Claude Code stream-json into deltas, tool use, results and errors', () => {
  const ev = event => JSON.stringify({ type: 'stream_event', event });
  assert.deepEqual(readLine(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hej' } })), { delta: 'Hej' });
  assert.equal(readLine(ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } })), null);
  assert.deepEqual(readLine(ev({ type: 'content_block_start', content_block: { type: 'server_tool_use', name: 'WebSearch' } })), { tool: 'WebSearch' });
  assert.deepEqual(readLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hej' })), { done: 'Hej' });
  assert.deepEqual(readLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' })), { error: 'Not logged in' });
  assert.equal(readLine('not json'), null);
});

test('findClaude prefers RIPTIDE_CLAUDE and returns null when nothing exists', () => {
  assert.equal(findClaude({ PATH: '' }, 'Z:\\ingen-hemkatalog'), null);
  assert.equal(findClaude({ RIPTIDE_CLAUDE: process.execPath, PATH: '' }, 'Z:\\ingen-hemkatalog'), process.execPath);
});

// A stand-in for child_process.spawn that answers with the given stream-json lines.
function fakeSpawn(lines, calls, code = 0){
  return (bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { end: text => { child.prompt = text; setImmediate(() => {
      for(const l of lines) child.stdout.emit('data', l + '\n');
      child.emit('close', code);
    }); } };
    child.kill = () => {};
    return child;
  };
}

test('the bridge streams text, starts a session once and then resumes it', async () => {
  const calls = [], events = [];
  const ok = [JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hej' } } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hej' })];
  const bridge = createClaudeBridge({ workDir: process.cwd(), find: () => 'claude.exe', run: fakeSpawn(ok, calls) });
  const sid = '13ead7a5-081a-4b83-a5c8-374b662111a4';
  assert.deepEqual(await bridge.ask({ id: 'a', prompt: 'hej', sessionId: sid }, e => events.push(e)), { text: 'Hej' });
  assert.deepEqual(events, [{ delta: 'Hej' }]);
  await bridge.ask({ id: 'b', prompt: 'igen', sessionId: sid }, () => {});
  assert.ok(calls[0].includes('--session-id') && !calls[0].includes('--resume'));
  assert.ok(calls[1].includes('--resume') && !calls[1].includes('--session-id'));
  // Only web search: no file or shell tools.
  assert.equal(calls[0][calls[0].indexOf('--tools') + 1], 'WebSearch');
  // Always Opus 5.5, also when the session resumes.
  assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(calls[1][calls[1].indexOf('--model') + 1], 'claude-opus-5-5');
  await assert.rejects(bridge.ask({ id: 'c', prompt: 'x', sessionId: 'nope' }, () => {}), /sessions-id/);
  await assert.rejects(bridge.ask({ id: 'd', prompt: '  ', sessionId: sid }, () => {}), /tom fråga/);
});

test('the bridge reports a Claude error and retries a session that already exists', async () => {
  const calls = [];
  const fail = [JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })];
  const bridge = createClaudeBridge({ workDir: process.cwd(), find: () => 'claude.exe', run: fakeSpawn(fail, calls, 1) });
  await assert.rejects(bridge.ask({ id: 'a', prompt: 'hej', sessionId: '23ead7a5-081a-4b83-a5c8-374b662111a4' }, () => {}), /Not logged in/);

  const used = [], seen = [];
  let first = true;
  const run = (bin, args) => {
    seen.push(args);
    const lines = first ? [JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Session ID 33ead7a5 is already in use.' })]
      : [JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })];
    first = false;
    return fakeSpawn(lines, used, 0)(bin, args);
  };
  const again = createClaudeBridge({ workDir: process.cwd(), find: () => 'claude.exe', run });
  assert.deepEqual(await again.ask({ id: 'b', prompt: 'hej', sessionId: '33ead7a5-081a-4b83-a5c8-374b662111a4' }, () => {}), { text: 'ok' });
  assert.ok(seen[1].includes('--resume'));
});

test('overview counts headlines per coin and macro word with their tone and the last hour', () => {
  const items = [{ ts: T - 60000, coins: ['BTC'], macro: [], tone: 1 }, { ts: T - 2 * 3600000, coins: ['BTC', 'ETH'], macro: ['FED'], tone: -1 }, { ts: T, coins: [], macro: [], tone: 0 }];
  const o = overview(items, { now: T });
  assert.equal(o.total, 3);
  assert.equal(o.hour, 2);
  assert.deepEqual(o.rows, [{ k: 'BTC', n: 2, up: 1, down: 1, hour: 1 }, { k: 'ETH', n: 1, up: 0, down: 1, hour: 0 }, { k: 'FED', n: 1, up: 0, down: 1, hour: 0 }]);
  const { items: merged } = mergeItems([], [{ title: 'Bitcoin climbs above 120k', desc: '<p>Spot   ETF</p>', ts: T }], { now: T });
  assert.equal(merged[0].desc, 'Spot ETF', 'the feed text is kept without markup for the news panel');
});

test('readHeadline gives the engine reading of a headline in words for BTC', () => {
  const r = readHeadline({ title: 'Bitcoin surges as ETF inflows hit record', desc: '' });
  assert.ok(r.btc > 0);
  assert.match(r.effect, /positiv \(\+\d av ±6\)$/);
  assert.ok(r.cats.includes('Krypto'));
  assert.ok(r.sv.length >= 1);
  assert.equal(readHeadline({ title: 'Local weather is mild today', desc: '' }).effect, 'neutral');
});

test('equityPoints draws the start, each close and the live equity', () => {
  assert.deepEqual(equityPoints(null), []);
  assert.deepEqual(equityPoints({ start: 100, trades: [] }), []);
  const a = { start: 100, trades: [{ openedAt: T - 5000, closedAt: T - 4000, equityAfter: 110 }, { openedAt: T - 3000, closedAt: T - 2000, equityAfter: 95 }] };
  assert.deepEqual(equityPoints(a, { equity: 97 }, T), [{ t: T - 5000, v: 100 }, { t: T - 4000, v: 110 }, { t: T - 2000, v: 95 }, { t: T, v: 97 }]);
  assert.equal(equityPoints(a, { equity: null }, T).length, 3);
});

test('wrapText breaks the page text into lines and ends a cut text with an ellipsis', async () => {
  const { wrapText } = await import('../crawler-advanced.js');
  const m = s => s.length * 10;                       // tio pixlar per tecken
  assert.deepEqual(wrapText(m, 'aa bb cc dd', 50), ['aa bb', 'cc dd']);
  assert.deepEqual(wrapText(m, '  aa   bb  ', 200), ['aa bb']);
  assert.deepEqual(wrapText(m, 'aa bb cc dd ee ff', 50, 2), ['aa bb', 'cc d…']);
  assert.deepEqual(wrapText(m, 'ettväldigtlångtord kort', 50), ['ettväldigtlångtord', 'kort'], 'a word longer than the line gets its own line');
  assert.deepEqual(wrapText(m, '', 50), []);
});

test('the bridge sketch is a question to Opus 5.5 with no tools, no session and no settings', async () => {
  const calls = [], events = [];
  const ok = [JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Upp.\n1 2 0.5 1.5' } } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Upp.\n1 2 0.5 1.5' })];
  const bridge = createClaudeBridge({ workDir: process.cwd(), find: () => 'claude.exe', run: fakeSpawn(ok, calls) });
  assert.deepEqual(await bridge.sketch({ id: 's', prompt: 'rita' }, e => events.push(e)), { text: 'Upp.\n1 2 0.5 1.5' });
  assert.deepEqual(events, [{ delta: 'Upp.\n1 2 0.5 1.5' }]);
  const a = calls[0];
  assert.equal(a[a.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(a.includes('--no-session-persistence') && !a.includes('--resume') && !a.includes('--session-id'));
  await assert.rejects(bridge.sketch({ id: 't', prompt: ' ' }, () => {}), /tom fråga/);
});

test('the bridge summary is its own question to Opus 5.5 with no tools and the summary system prompt', async () => {
  const calls = [];
  const ok = [JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'BTC stiger.' })];
  const bridge = createClaudeBridge({ workDir: process.cwd(), find: () => 'claude.exe', run: fakeSpawn(ok, calls) });
  assert.deepEqual(await bridge.summarize({ id: 'u', prompt: 'summera' }, () => {}), { text: 'BTC stiger.' });
  const a = calls[0];
  assert.equal(a[a.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.match(a[a.indexOf('--system-prompt') + 1], /summerar nya rubriker/);
  assert.ok(a.includes('--no-session-persistence') && !a.includes('--session-id'));
});

test('summaryPrompt lists at most twelve new headlines with a shortened lead', () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ title: 'Rubrik ' + i, desc: i === 0 ? 'x'.repeat(300) : '' }));
  const p = summaryPrompt('Coindesk', items);
  assert.match(p, /läst Coindesk och hittat 14 nya rubriker/);
  assert.ok(p.includes('- Rubrik 11') && !p.includes('- Rubrik 12'));
  assert.ok(p.includes('- Rubrik 0 — ' + 'x'.repeat(240) + '\n'));
  assert.match(p, /högst tre korta meningar/);
});

test('localSummary counts coins and macro words, the tone and names the newest headline', () => {
  const items = [
    { title: 'Bitcoin jumps', coins: ['BTC'], macro: [], tone: 1, ts: T - 60000 },
    { title: 'Fed holds, bitcoin slides', coins: ['BTC'], macro: ['FED'], tone: -1, ts: T },
    { title: 'Ether quiet', coins: ['ETH'], macro: [], tone: 0, ts: T - 120000 }
  ];
  assert.equal(localSummary(items), '3 nya rubriker om BTC ×2, FED, ETH · ▲1 ▼1. Senaste: Fed holds, bitcoin slides');
  assert.equal(localSummary([{ title: 'Lugnt', ts: T }]), '1 ny rubrik · neutral ton. Senaste: Lugnt');
  assert.equal(localSummary([]), 'Inga nya rubriker.');
});

test('connectSummary streams only its own deltas and is null without the desktop app', async () => {
  assert.equal(connectSummary(null), null);
  assert.equal(connectSummary({ ask() {} }), null);
  let fire = null;
  const api = {
    onEvent(fn){ fire = fn; return () => { fire = null; }; },
    async summary({ id }){ fire({ id: 'annan', delta: 'X' }); fire({ id, delta: 'Hej' }); return { text: 'Hej' }; },
    cancel(){}
  };
  const got = [];
  const run = connectSummary(api)('fråga', d => got.push(d));
  assert.equal(await run.done, 'Hej');
  assert.deepEqual(got, ['Hej']);
  assert.equal(fire, null, 'the listener is removed when the answer is done');
});

test('the sketch reader takes candles line by line as they stream, chained from the last price', () => {
  const r = createSketchReader({ base: 100, start: 1000, tfMs: 10, n: 3 });
  r.feed('Svagt uppåt: 100, 101, 99 och 102 är nivåerna.\n1: 100 10');
  assert.equal(r.candles.length, 0, 'a reason with numbers in it is no candle');
  r.feed('2 99.5 101.5\n');
  assert.deepEqual(r.candles, [{ t: 1000, o: 100, h: 102, l: 99.5, c: 101.5 }]);
  r.feed('101 101 103 104\n500 600 400 550\n');
  assert.deepEqual(r.candles[1], { t: 1010, o: 101.5, h: 104, l: 101, c: 104 }, 'high and low cover open and close');
  assert.equal(r.candles.length, 2, 'a candle far from the price is skipped');
  r.feed('104 105 103 103.5\n105 106 104 105');
  assert.equal(r.candles.length, 3);
  r.end();
  assert.equal(r.candles.length, 3, 'no more than n');
  assert.equal(r.note, 'Svagt uppåt: 100, 101, 99 och 102 är nivåerna.');
  const p = sketchPrompt({ context: 'X', n: 5, symbol: 'BTC', tf: '1h', price: 100, question: 'bryter den?', from: '2026-10-26 12:00' });
  assert.match(p, /de 5 kommande candlarna för BTCUSDT på 1h, från senaste priset 100\. Den första börjar 2026-10-26 12:00 UTC/);
  assert.match(p, /Användarens fråga: bryter den\?/);
  assert.match(p, /Rad 2–6: en candle per rad/);
});
