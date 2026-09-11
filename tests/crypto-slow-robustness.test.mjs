import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyWindows, summarizeWindows, concentration, continuousYears } from '../research/crypto-slow-robustness.mjs';

test('monthly diagnostics include only complete windows, including leap years', () => {
  const rows = monthlyWindows(Date.parse('2024-01-01Z'), Date.parse('2024-09-10Z'), 6);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].from, Date.parse('2024-02-01Z'));
  assert.equal(rows.at(-1).to, Date.parse('2024-09-01Z'));
  assert.throws(() => monthlyWindows(Date.parse('2024-01-02Z'), Date.parse('2025-01-01Z'), 6));
});

test('window summary keeps negative, zero and positive returns in the denominator', () => {
  const rows = [-5, 0, 2, 10].map(value => ({ base: { returnPct: value }, stress: { returnPct: value - 3 }, buyhold: { returnPct: 1 } }));
  assert.deepEqual(summarizeWindows(rows), { n: 4, positive: 2, stressPositive: 1, beatBuyhold: 2, medianReturnPct: 1, worstReturnPct: -5, bestReturnPct: 10 });
  assert.equal(summarizeWindows([]).medianReturnPct, null);
});

test('winner concentration uses positive gross profit and does not mutate trades', () => {
  const book = { trades: [{ pnl: -8 }, { pnl: 3 }, { pnl: 10 }] };
  const before = structuredClone(book);
  const result = concentration(book);
  assert.equal(result.netPnl, 5);
  assert.equal(result.netPnlLessLargestWinner, -5);
  assert.equal(result.netPnlLessTop5Winners, -8);
  assert.equal(result.top5ShareOfGrossProfit, 1);
  assert.equal(concentration({ trades: [{ pnl: -1 }] }).top5ShareOfGrossProfit, null);
  assert.deepEqual(book, before);
});

test('continuous years assign midnight to prior trading day and compound to total', () => {
  const years = continuousYears({ daily: [
    { t: Date.parse('2025-01-01Z'), equity: 120 },
    { t: Date.parse('2025-01-02Z'), equity: 90 },
    { t: Date.parse('2026-01-01Z'), equity: 108 },
  ] });
  assert.deepEqual(years.map(y => y.year), [2024, 2025]);
  assert.equal(years[1].openingEquity, 120);
  const compounded = years.reduce((equity, y) => equity * (1 + y.returnPct / 100), 100);
  assert.ok(Math.abs(compounded - 108) < 1e-10);
});
