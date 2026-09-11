import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, DAY } from '../research/crypto-slow-core.mjs';
import { TWEAKS, policy, volatility } from '../research/crypto-momentum-policies.mjs';

const start = Date.parse('2023-01-02T00:00:00Z');
const bars = Array.from({ length: 160 }, (_, i) => ({ t: start + (i - 100) * DAY, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 }));
const data = { BTC: bars, ETH: bars, SOL: bars };

test('original policy exactly reproduces the original engine including costs', () => {
  assert.deepEqual(simulate('momentum28', data, start, start + 28 * DAY, .0005, .001, policy('original')),
    simulate('momentum28', data, start, start + 28 * DAY));
});

test('every tweak ignores decision-day close and all future prices', () => {
  const changed = Object.fromEntries(Object.entries(data).map(([s, b]) => [s, b.map((x, i) => i >= 100 ? { ...x, c: 1e9 } : x)]));
  for (const t of TWEAKS) {
    const p = policy(t.id), held = Array(p.sleeveCount ?? 3).fill(null);
    assert.deepEqual(p.wanted(data, 100, held), p.wanted(changed, 100, held), t.id);
    assert.equal(p.fraction(bars, 100), p.fraction(changed.BTC, 100), t.id);
  }
});

test('buffer holds through small negative momentum but requires positive entry buffer', () => {
  const b = bars.map(x => ({ ...x, c: 100 }));
  b[99].c = 99;
  const p = policy('buffer');
  assert.deepEqual(p.wanted({ BTC: b }, 100, [null]), [null]);
  assert.deepEqual(p.wanted({ BTC: b }, 100, ['BTC']), ['BTC']);
  b[99].c = 97;
  assert.deepEqual(p.wanted({ BTC: b }, 100, ['BTC']), [null]);
  b[99].c = 103;
  assert.deepEqual(p.wanted({ BTC: b }, 100, [null]), ['BTC']);
});

test('top two preserves sleeves when rankings swap and keeps unused capital in cash', () => {
  const p = policy('top2');
  assert.deepEqual(p.wanted(data, 100, ['ETH', 'BTC']), ['ETH', 'BTC']);
  const down = bars.map((b, i) => ({ ...b, c: 400 - i, o: 400 - i }));
  const book = simulate('momentum28', { BTC: bars, ETH: down, SOL: down }, start, start + 14 * DAY, .0005, .001, p);
  const one = simulate('momentum28', { BTC: bars }, start, start + 14 * DAY);
  assert.equal(book.n, 1);
  assert.ok(Math.abs(book.balance - (50 + one.balance / 2)) < 1e-10);
});

test('partial entry keeps cash and reconciles fees and P/L on final liquidation', () => {
  const p = { ...policy('original'), fraction: () => .4 };
  const book = simulate('momentum28', { BTC: bars }, start, start + 14 * DAY, .0005, .001, p);
  const full = simulate('momentum28', { BTC: bars }, start, start + 14 * DAY);
  assert.equal(book.n, 1);
  assert.ok(Math.abs(book.balance - (60 + .4 * full.balance)) < 1e-10);
  assert.ok(Math.abs(book.fees - .4 * full.fees) < 1e-10);
  assert.ok(Math.abs(book.balance - 100 - book.trades[0].pnl) < 1e-10);
  assert.throws(() => simulate('momentum28', data, start, start + DAY, .0005, .001, { ...p, fraction: () => 2 }));
});

test('volatility cap reduces investment for volatile history and is bounded without leverage', () => {
  const noisy = bars.map((b, i) => ({ ...b, c: i % 2 ? 120 : 80 }));
  const p = policy('vol40');
  assert.ok(volatility(noisy, 100) > .4);
  assert.ok(p.fraction(noisy, 100) < 1);
  assert.equal(p.fraction(bars.map(b => ({ ...b, c: 100 })), 100), 1);
});

test('daily timing can enter on Tuesday while weekly timing waits until Monday', () => {
  const tuesday = start + DAY;
  const daily = simulate('momentum28', data, tuesday, tuesday + 7 * DAY, .0005, .001, policy('daily'));
  const weekly = simulate('momentum28', data, tuesday, tuesday + 7 * DAY);
  assert.equal(daily.trades[0].opened, tuesday);
  assert.equal(weekly.trades[0].opened, start + 7 * DAY);
  assert.equal(daily.n, 3); // unchanged positions incur no daily turnover
});

test('multiple horizons can retain a positive combined trend when 28 days alone is negative', () => {
  const b = bars.map(x => ({ ...x, c: 100 }));
  b[99].c = 100; b[85].c = 80; b[71].c = 110; b[43].c = 90;
  assert.deepEqual(policy('original').wanted({ BTC: b }, 100, [null]), [null]);
  assert.deepEqual(policy('multi').wanted({ BTC: b }, 100, [null]), ['BTC']);
});

test('84-day filter can reject a positive short rebound below the long average', () => {
  const b = bars.map(x => ({ ...x, c: 200 }));
  b[99].c = 110; b[71].c = 100;
  assert.deepEqual(policy('original').wanted({ BTC: b }, 100, [null]), ['BTC']);
  assert.deepEqual(policy('trend84').wanted({ BTC: b }, 100, [null]), [null]);
});
