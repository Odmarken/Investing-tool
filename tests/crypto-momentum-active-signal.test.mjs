import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_PROFILES, activeSignal, chooseActiveSignal } from '../crypto-momentum-active-signal.js';

const HOUR = 3_600_000;
const start = Date.UTC(2026, 0, 1);
const rising = (length = 80, price = 100, step = 1, range = 1) => Array.from({length}, (_, i) => {
  const c = price + step * i;
  return {t: start + i * HOUR, o: c, h: c + range, l: c - range, c, v: 100};
});
const after = bars => bars.at(-1).t + HOUR;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('uses 14/28/56 hourly returns and the shared frozen profile definitions', () => {
  const bars = rising();
  for (const [profile, hours, reward] of [['pulse12', 12, 2], ['pulse24', 24, 2], ['trend24', 24, 3]]) {
    // A clear close above the preceding six highs also qualifies trend24.
    const source = bars.map(b => ({...b, h: b.c + 0.25, l: b.c - 0.25}));
    const signal = activeSignal('SOL', source, after(source), profile);
    assert.ok(signal);
    near(signal.score, (179 / 165 - 1 + 179 / 151 - 1 + 179 / 123 - 1) / 3);
    assert.equal(signal.at, after(source));
    assert.equal(signal.reference, 179);
    assert.equal(signal.maxHoldMs, hours * HOUR);
    assert.equal(signal.rewardMultiple, reward);
    assert.equal(signal.maxHoldMs, ACTIVE_PROFILES[profile].maxHoldMs);
  }
  assert.equal(activeSignal('SOL', bars, after(bars), 'unknown'), null);
  assert.equal(activeSignal('SOL', bars, after(bars), '__proto__'), null);
});

test('calculates Wilder ATR, including decay after a wide hourly candle', () => {
  const bars = rising();
  bars[70] = {...bars[70], h: bars[70].c + 5, l: bars[70].c - 5};
  const signal = activeSignal('BTC', bars, after(bars));
  const expected = 2 + 8 / 14 * (13 / 14) ** 9;
  near(signal.atr, expected);
  near(signal.slDistance, expected * 2);
});

test('applies the 0.5% price-distance floor to low-volatility observations', () => {
  const bars = rising(80, 1000, 0.001, 0.01);
  const signal = activeSignal('BTC', bars, after(bars));
  near(signal.atr, 0.02);
  near(signal.slDistance, signal.reference * 0.005);
});

test('open and future candles cannot change a signal or its decision timestamp', () => {
  const bars = rising();
  const now = after(bars) + HOUR / 2;
  const expected = activeSignal('ETH', bars, now);
  const future = [{t: after(bars), o: 1e10, h: 1e10, l: 1, c: 1},
    {t: after(bars) + HOUR, o: -1, h: Infinity, l: -1, c: NaN}];
  assert.deepEqual(activeSignal('ETH', [...bars, ...future], now), expected);
  assert.deepEqual(activeSignal('ETH', [...bars].reverse(), now), expected);
  assert.equal(activeSignal('ETH', bars, after(bars) - 1), null);
  assert.deepEqual(bars, rising());
});

test('requires 80 valid, contiguous, aligned and current completed hourly candles', () => {
  const bars = rising();
  const now = after(bars);
  assert.equal(activeSignal('BTC', bars.slice(1), now), null);
  assert.equal(activeSignal('BTC', bars.filter((_, i) => i !== 40), now), null);
  assert.equal(activeSignal('BTC', [...bars, {...bars[40]}], now), null);
  assert.equal(activeSignal('BTC', bars, now + HOUR), null);
  for (const bad of [{t: bars[40].t + 1}, {o: 0}, {c: NaN}, {l: bars[40].h + 1}, {h: bars[40].l - 1}]) {
    assert.equal(activeSignal('BTC', bars.map((b, i) => i === 40 ? {...b, ...bad} : b), now), null);
  }
  assert.equal(activeSignal('BTC', null, now), null);
  assert.equal(activeSignal('BTC', bars, NaN), null);
});

test('a fixed 80-candle ATR warm-up gives the same result with extra older history', () => {
  const bars = rising(160);
  bars[90] = {...bars[90], h: bars[90].h + 30};
  const expected = activeSignal('DOGE', bars.slice(-80), after(bars));
  assert.deepEqual(activeSignal('DOGE', bars, after(bars)), expected);
  assert.deepEqual(activeSignal('DOGE', bars.map((b, i) => i < 80 ? {...b, c: 1e12} : b), after(bars)), expected);
});

test('flat or negative average momentum is ineligible', () => {
  for (const bars of [rising(80, 100, 0), rising(80, 200, -1)]) {
    assert.equal(activeSignal('BTC', bars, after(bars)), null);
  }
});

test('trend24 requires a strict close above all of the preceding six highs', () => {
  const bars = rising(80, 100, 1, 0.25);
  assert.ok(activeSignal('XRP', bars, after(bars), 'trend24'));
  for (const i of [73, 74, 75, 76, 77, 78]) {
    const blocked = bars.map((b, j) => j === i ? {...b, h: bars.at(-1).c} : b);
    assert.ok(activeSignal('XRP', blocked, after(bars), 'pulse24'));
    assert.equal(activeSignal('XRP', blocked, after(bars), 'trend24'), null);
  }
  const olderSpike = bars.map((b, i) => i === 72 ? {...b, h: 1000} : b);
  assert.ok(activeSignal('XRP', olderSpike, after(bars), 'trend24'));
});

test('selects strongest positive momentum and uses a deterministic seven-coin tie-break', () => {
  const tied = ['PEPE', 'SHIB', 'DOGE', 'XRP', 'SOL', 'ETH', 'BTC'].map(symbol => ({symbol, score: 0.2}));
  for (let end = tied.length; end > 0; end--) assert.equal(chooseActiveSignal(tied.slice(0, end)), tied[end - 1]);
  const strongest = {symbol: 'SHIB', score: 0.3};
  assert.equal(chooseActiveSignal([...tied, strongest, {symbol: 'UNKNOWN', score: 9}, {symbol: 'BTC', score: Infinity}]), strongest);
  assert.equal(chooseActiveSignal([null, {symbol: 'BTC', score: 0}, {symbol: 'SOL', score: -1}]), null);
  assert.equal(chooseActiveSignal(null), null);
});
