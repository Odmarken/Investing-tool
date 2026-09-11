import test from 'node:test';
import assert from 'node:assert/strict';
import { trainingCuts, scoreDiagnostics } from '../research/crypto-ai-ranking.mjs';

test('ranking boundaries use training only and keep tied scores in one group', () => {
  const cuts = trainingCuts([1, 1, 1, 1, 1]);
  const result = scoreDiagnostics([{ score: 1, netR: -1, stressR: -2 }, { score: 1, netR: 1, stressR: 0 }], 0, cuts);
  assert.deepEqual(result.bins.map(b => b.n), [2, 0, 0, 0, 0]);
  assert.deepEqual(cuts, [1, 1, 1, 1]);
  assert.equal(result.bins[4].meanR, null);
});

test('constant baseline and model errors are computed from held-out outcomes', () => {
  const cuts = trainingCuts([-5, -4, -3, -2, -1]);
  const result = scoreDiagnostics([{ score: 2, netR: 3, stressR: 2 }], 1, cuts);
  assert.equal(result.modelMSE, 1);
  assert.equal(result.baselineMSE, 4);
  assert.equal(result.bins[4].n, 1);
  assert.equal(result.aboveExistingThreshold.n, 1);
  assert.throws(() => trainingCuts([NaN, 1, 2, 3, 4]));
  assert.throws(() => scoreDiagnostics([{ score: NaN, netR: 1 }], 0, cuts));
});
