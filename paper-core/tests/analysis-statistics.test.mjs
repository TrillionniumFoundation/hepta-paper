import assert from 'node:assert/strict';
import test from 'node:test';

import {
  arithmeticMean,
  compensatedSum,
  deterministicPairedBootstrap,
  deterministicSignFlipInference,
  deterministicSignFlipPValue,
  sampleStandardDeviation,
} from '../../paper-domain/automation/analysis-statistics.mjs';

test('analysis statistics use compensated sums and stable online variance', () => {
  assert.equal(compensatedSum([1e16, 1, -1e16]), 1);
  assert.equal(arithmeticMean([1e16, 1, -1e16]), 1 / 3);
  assert.equal(Number.isNaN(arithmeticMean([])), true);

  const shifted = [1e12 + 1, 1e12 + 2, 1e12 + 3, 1e12 + 4, 1e12 + 5];
  assert.ok(Math.abs(sampleStandardDeviation(shifted) - Math.sqrt(2.5)) < 1e-12);
});

test('resampling remains deterministic and finite for cancellation-prone values', () => {
  const values = [1e16, 1, -1e16, 2, -2];
  const options = {
    confidenceLevel: 0.95,
    resamples: 256,
    seed: 'stable-statistics-test',
    salt: 'paired',
  };
  const first = deterministicPairedBootstrap(values, options);
  const second = deterministicPairedBootstrap(values, options);
  assert.deepEqual(first, second);
  assert.equal(Number.isFinite(first.lower), true);
  assert.equal(Number.isFinite(first.upper), true);

  const pValue = deterministicSignFlipPValue(values, {
    draws: 512,
    seed: 'stable-statistics-test',
    salt: 'sign-flip',
  });
  assert.equal(Number.isFinite(pValue), true);
  assert.ok(pValue > 0 && pValue <= 1);

  const exact = deterministicSignFlipInference([1, 2, 3], {
    draws: 1000,
    seed: 'ignored-for-exact',
    salt: 'exact',
  });
  assert.equal(exact.method, 'exact-paired-sign-flip-enumeration-v1');
  assert.equal(exact.draws, 8);
  assert.equal(exact.monteCarloStandardError, 0);
  assert.equal(exact.pValue, 1 / 8);

  const monteCarlo = deterministicSignFlipInference(Array.from({ length: 17 }, () => 1), {
    draws: 2048,
    seed: 'stable-statistics-test',
    salt: 'monte-carlo',
  });
  assert.equal(monteCarlo.method, 'deterministic-monte-carlo-sign-flip-v1');
  assert.equal(monteCarlo.draws, 2048);
  assert.ok(monteCarlo.monteCarloStandardError >= 0);
});
