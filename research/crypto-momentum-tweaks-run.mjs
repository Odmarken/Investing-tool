import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { simulate } from './crypto-slow-core.mjs';
import { TWEAKS, policy } from './crypto-momentum-policies.mjs';
import { readData, SYMBOLS, ROOT, END } from './crypto-slow-data.mjs';
import { monthlyWindows, summarizeWindows, continuousYears, concentration } from './crypto-slow-robustness.mjs';

const sources = Object.fromEntries(SYMBOLS.map(s => [s, readData(s)]));
const data = Object.fromEntries(SYMBOLS.map(s => [s, sources[s].bars]));
const start = Date.parse('2023-01-01T00:00:00Z'), split = Date.parse('2025-01-01T00:00:00Z');
let audits = 0;
function audit(book) {
  assert.ok(Number.isFinite(book.balance) && book.balance >= 0);
  assert.ok(Math.abs(book.balance - 100 - book.trades.reduce((sum, t) => sum + t.pnl, 0)) < 1e-8);
  assert.ok(Math.abs(book.fees - book.trades.reduce((sum, t) => sum + t.fees, 0)) < 1e-8);
  assert.ok(book.daily.every(d => Number.isFinite(d.equity) && d.equity > 0 && d.exposure >= 0 && d.exposure <= 1 + 1e-12));
  assert.ok(book.trades.every(t => t.opened >= book.from && t.closed <= book.to && t.closed > t.opened));
  if (book.tweak !== 'daily' && book.variant !== 'buyhold') assert.ok(book.trades.every(t => new Date(t.opened).getUTCDay() === 1));
  audits++;
  return book;
}
const run = (id, from, to, slip = .0005) => audit({ ...simulate('momentum28', data, from, to, slip, .001, policy(id)), tweak: id });
const compact = b => ({ returnPct: b.returnPct, maxDDPct: b.maxDDPct, n: b.n, fees: b.fees, turnoverTimes: b.turnoverTimes, exposurePct: b.exposurePct });
const development = TWEAKS.map(t => ({ id: t.id, base: run(t.id, start, split), stress: run(t.id, start, split, .001) }));
const original = development.find(t => t.id === 'original');
const eligible = development.filter(t => t.base.returnPct > 0 && t.stress.returnPct > 0 && t.base.n >= 10);
const returnCandidate = [...eligible].sort((a, b) => b.stress.returnPct - a.stress.returnPct)[0]?.id ?? null;
const balancedCandidate = eligible.filter(t => t.base.maxDDPct <= original.base.maxDDPct && t.stress.maxDDPct <= original.stress.maxDDPct)
  .sort((a, b) => b.stress.returnPct / Math.max(b.stress.maxDDPct, .01) - a.stress.returnPct / Math.max(a.stress.maxDDPct, .01))[0]?.id ?? null;
// Both selection decisions are fixed here, before any later simulations.
const selection = { returnCandidate, balancedCandidate, selectedFrom: '2023–2024 only' };
console.log('Locked selection: ' + JSON.stringify(selection));
const later = TWEAKS.map(t => ({ id: t.id, base: run(t.id, split, END), stress: run(t.id, split, END, .001),
  restart2026: run(t.id, Date.parse('2026-01-01T00:00:00Z'), END) }));
// Default behavior must still exactly reproduce the previously saved baseline.
const old = JSON.parse(readFileSync(new URL('results.json', ROOT), 'utf8'));
for (const [current, saved] of [[original.base, old.development.find(t => t.base.variant === 'momentum28').base],
  [later[0].base, old.later.find(t => t.base.variant === 'momentum28').base]]) {
  assert.equal(current.balance, saved.balance);
  assert.deepEqual(current.trades, saved.trades);
  assert.deepEqual(current.daily, saved.daily);
}
const windows = monthlyWindows(split, END, 12);
const passive = windows.map(w => audit(simulate('buyhold', data, w.from, w.to)));
const rolling = TWEAKS.map(t => {
  const rows = windows.map((w, i) => ({ ...w, base: compact(run(t.id, w.from, w.to)),
    stress: compact(run(t.id, w.from, w.to, .001)), buyhold: compact(passive[i]) }));
  return { id: t.id, summary: summarizeWindows(rows), rows };
});
const result = { createdAt: new Date().toISOString(), selection, validated: false, retrospective: true, audits,
  development, later, rolling,
  byYear: later.map(t => ({ id: t.id, years: continuousYears(t.base), concentration: concentration(t.base) })),
  dataHashes: Object.fromEntries(SYMBOLS.map(s => [s, sources[s].checksum])),
  protocolHash: createHash('sha256').update(readFileSync(new URL('crypto-momentum-tweaks-protocol.md', import.meta.url))).digest('hex') };
writeFileSync(new URL('tweaks.json', ROOT), JSON.stringify(result));
console.log(JSON.stringify({ audits, development: development.map(t => ({ id: t.id, ...compact(t.base), stressReturn: t.stress.returnPct })),
  later: later.map(t => ({ id: t.id, ...compact(t.base), stressReturn: t.stress.returnPct, restart2026: t.restart2026.returnPct })),
  rolling: rolling.map(t => ({ id: t.id, ...t.summary })) }, null, 2));
