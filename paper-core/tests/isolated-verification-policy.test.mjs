import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectIsolatedVerificationPreflight } from '../src/isolated-verification-policy.mjs';

test('release verification requires an explicitly clean worktree', () => {
  const dirty = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: { treeDirty: true },
  });
  assert.equal(dirty.status, 'isolated_verification_preflight_blocked');
  assert.deepEqual(dirty.blockers, ['release_verification_clean_worktree_required']);

  const missing = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: {},
  });
  assert.deepEqual(missing.blockers, ['release_verification_clean_worktree_required']);

  const clean = inspectIsolatedVerificationPreflight({
    mode: 'release',
    codeProvenance: { treeDirty: false },
  });
  assert.equal(clean.status, 'isolated_verification_preflight_ready');
  assert.deepEqual(clean.blockers, []);
});

test('development test and CI verification may diagnose a dirty worktree', () => {
  for (const mode of ['test', 'ci']) {
    const report = inspectIsolatedVerificationPreflight({
      mode,
      codeProvenance: { treeDirty: true },
    });
    assert.equal(report.status, 'isolated_verification_preflight_ready');
    assert.deepEqual(report.blockers, []);
  }
});

test('isolated verification rejects unsupported modes before execution', () => {
  const report = inspectIsolatedVerificationPreflight({
    mode: 'unknown',
    codeProvenance: { treeDirty: false },
  });
  assert.equal(report.status, 'isolated_verification_preflight_blocked');
  assert.deepEqual(report.blockers, ['isolated_verification_mode_unsupported:unknown']);
});
