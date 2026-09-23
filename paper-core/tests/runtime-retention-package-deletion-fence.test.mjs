import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  packageDeletionFenceTokenHash,
  transitionPackageDeletionFence,
  verifyRuntimeRetentionPackageDeletionFence,
} from '../../paper-adapters/automation/runtime-retention-package-deletion-fence-contract.mjs';
import { createRuntimeRetentionPackageDeletionFenceRepository }
  from '../../paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const TOKEN = 'opaque-package-deletion-fence-token-0000000000000001';
const TIMES = Object.freeze({
  prepared: '2026-08-20T05:00:00.000Z',
  deleting: '2026-08-20T05:01:00.000Z',
  deleted: '2026-08-20T05:02:00.000Z',
  aborted: '2026-08-20T05:03:00.000Z',
  preparedAgain: '2026-08-20T05:04:00.000Z',
});

function h(label) {
  return hashRecord('RuntimeRetentionPackageDeletionFenceTest', { label });
}

function fixture(t, label = 'base') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    os.tmpdir(),
    `hepta-package-deletion-fence-${label}-`,
  )));
  fs.mkdirSync(path.join(root, 'packages'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lifecycleHash = h(`${label}:lifecycle`);
  const request = Object.freeze({
    packageLifecycleReceiptHash: lifecycleHash,
    packagePath: path.join(root, 'packages', `${label}-package`),
    packageContentHash: h(`${label}:content`),
    deletionIntentHash: h(`${label}:intent`),
    recoveryBindingHash: h(`${label}:recovery-binding`),
    authoritySnapshotHash: h(`${label}:authority-snapshot`),
    operationId: `retention:${label}`,
    transitionId: h(`${label}:prepare-transition`),
    preparedAt: TIMES.prepared,
    expectedPreviousFenceHash: null,
    fenceToken: TOKEN,
  });
  return Object.freeze({ root, lifecycleHash, request });
}

function repository(root, token = TOKEN) {
  return createRuntimeRetentionPackageDeletionFenceRepository({
    runtimeRoot: root,
    randomToken: () => token,
  });
}

function transition(repo, prepared, status, transitionedAt, extra = {}) {
  return repo.transition(prepared.handle, {
    expectedRecordHash: prepared.record.runtimeRetentionPackageDeletionFenceHash,
    status,
    transitionedAt,
    transitionId: h(`${prepared.record.operationId}:${status}`),
    ...extra,
  });
}

test('contract seals exact prepared/deleting/deleted records and rejects tampering', (t) => {
  const { root, request } = fixture(t, 'contract');
  const prepared = repository(root).prepare(request);
  assert.equal(verifyRuntimeRetentionPackageDeletionFence(prepared.record).valid, true);
  assert.equal(prepared.record.status, 'prepared');
  assert.equal(prepared.record.generation, 1);
  assert.equal(prepared.record.revision, 1);
  assert.equal(prepared.record.fenceTokenHash, packageDeletionFenceTokenHash(TOKEN));

  const deleting = transitionPackageDeletionFence(prepared.record, {
    status: 'deleting',
    transitionedAt: TIMES.deleting,
    transitionId: h('contract:deleting'),
  });
  const deleted = transitionPackageDeletionFence(deleting, {
    status: 'deleted',
    transitionedAt: TIMES.deleted,
    transitionId: h('contract:deleted'),
  });
  assert.equal(verifyRuntimeRetentionPackageDeletionFence(deleting).valid, true);
  assert.equal(verifyRuntimeRetentionPackageDeletionFence(deleted).valid, true);
  assert.equal(deleted.revision, 3);
  assert.equal(deleted.previousFenceHash, deleting.runtimeRetentionPackageDeletionFenceHash);

  assert.equal(verifyRuntimeRetentionPackageDeletionFence({
    ...deleted,
    packageContentHash: h('tampered-content'),
  }).valid, false);
  assert.throws(() => transitionPackageDeletionFence(deleted, {
    status: 'aborted',
    transitionedAt: TIMES.aborted,
    transitionId: h('contract:late-abort'),
    abortReasonHash: h('contract:reason'),
  }), /transition_invalid/);
});

test('repository persists a prepared fence across restart and requires exact compare token', (t) => {
  const { root, lifecycleHash, request } = fixture(t, 'restart');
  const firstRepository = repository(root);
  const prepared = firstRepository.prepare(request);
  const restarted = repository(root, 'different-generated-token-0000000000000000000001');
  assert.deepEqual(restarted.inspect(lifecycleHash), prepared.record);
  assert.deepEqual(restarted.list(), [prepared.record]);
  assert.equal(restarted.assertHeld(prepared.handle).status, 'prepared');

  assert.throws(() => restarted.transition({
    ...prepared.handle,
    fenceToken: 'wrong-opaque-token-00000000000000000000000001',
  }, {
    expectedRecordHash: prepared.record.runtimeRetentionPackageDeletionFenceHash,
    status: 'deleting',
    transitionedAt: TIMES.deleting,
    transitionId: h('restart:deleting'),
  }), /compare_failed/);
  assert.throws(() => restarted.transition(prepared.handle, {
    expectedRecordHash: h('stale-record'),
    status: 'deleting',
    transitionedAt: TIMES.deleting,
    transitionId: h('restart:deleting'),
  }), /compare_failed/);
});

test('compare-and-transition supports exact idempotent replay and rejects stale generations', (t) => {
  const { root, request } = fixture(t, 'compare');
  const repo = repository(root);
  const prepared = repo.prepare(request);
  const deletingRequest = {
    expectedRecordHash: prepared.record.runtimeRetentionPackageDeletionFenceHash,
    status: 'deleting',
    transitionedAt: TIMES.deleting,
    transitionId: h('compare:deleting'),
  };
  const deleting = repo.transition(prepared.handle, deletingRequest);
  assert.deepEqual(repo.prepare(request).record, deleting.record);
  assert.deepEqual(repo.resume(request), deleting);
  const replay = repo.transition(prepared.handle, deletingRequest);
  assert.deepEqual(replay.record, deleting.record);
  assert.deepEqual(replay.handle, deleting.handle);
  assert.throws(() => repo.assertHeld(prepared.handle), /compare_failed/);

  const deleted = repo.transition(deleting.handle, {
    expectedRecordHash: deleting.record.runtimeRetentionPackageDeletionFenceHash,
    status: 'deleted',
    transitionedAt: TIMES.deleted,
    transitionId: h('compare:deleted'),
  });
  assert.equal(deleted.record.status, 'deleted');
  assert.throws(() => repo.prepare({
    ...request,
    transitionId: h('compare:prepare-again'),
    preparedAt: TIMES.preparedAgain,
    expectedPreviousFenceHash: deleted.record.runtimeRetentionPackageDeletionFenceHash,
  }), /package_deleted/);
});

test('abort is durable and a fresh prepare advances generation with linked lineage', (t) => {
  const { root, request } = fixture(t, 'abort');
  const repo = repository(root);
  const prepared = repo.prepare(request);
  const aborted = repo.transition(prepared.handle, {
    expectedRecordHash: prepared.record.runtimeRetentionPackageDeletionFenceHash,
    status: 'aborted',
    transitionedAt: TIMES.aborted,
    transitionId: h('abort:transition'),
    abortReasonHash: h('abort:rollback-verified'),
  });
  assert.equal(aborted.record.status, 'aborted');

  const preparedAgain = repo.prepare({
    ...request,
    transitionId: h('abort:prepare-again'),
    preparedAt: TIMES.preparedAgain,
    expectedPreviousFenceHash: aborted.record.runtimeRetentionPackageDeletionFenceHash,
    fenceToken: 'new-opaque-package-deletion-token-00000000000002',
  });
  assert.equal(preparedAgain.record.generation, 2);
  assert.equal(preparedAgain.record.revision, 1);
  assert.equal(
    preparedAgain.record.previousFenceHash,
    aborted.record.runtimeRetentionPackageDeletionFenceHash,
  );
});

test('active fence globally blocks writers while reader checks remain target-specific', (t) => {
  const { root, lifecycleHash, request } = fixture(t, 'access');
  const repo = repository(root);
  const selector = { packageLifecycleReceiptHash: lifecycleHash };
  assert.equal(repo.inspectWriterAuthority(selector).allowed, true);
  const prepared = repo.prepare(request);

  const unrelated = { packageLifecycleReceiptHash: h('unrelated-lifecycle') };
  assert.equal(repo.inspectReaderAuthority(unrelated).allowed, true);
  assert.deepEqual(repo.inspectReaderAuthority(selector).blockers, [
    'runtime_retention_package_deletion_fence_read_blocked',
  ]);
  assert.deepEqual(repo.inspectWriterAuthority(unrelated).blockers, [
    'runtime_retention_package_deletion_fence_reachability_mutation_blocked',
  ]);
  assert.throws(() => repo.withWriterGuard(unrelated, () => true),
    /reachability_mutation_blocked/);

  const deleted = transition(repo, transition(repo, prepared, 'deleting', TIMES.deleting),
    'deleted', TIMES.deleted);
  assert.deepEqual(repo.inspectReaderAuthority(selector).blockers, [
    'runtime_retention_package_deletion_fence_package_deleted',
  ]);
  assert.deepEqual(repo.inspectWriterAuthority(selector).blockers, [
    'runtime_retention_package_deletion_fence_package_deleted',
  ]);
  assert.deepEqual(repo.inspectWriterAuthority({
    packageLifecycleReceiptHash: lifecycleHash,
    packageContentHash: h('selector-padding-must-not-bypass'),
  }).blockers, [
    'runtime_retention_package_deletion_fence_package_deleted',
  ]);
  assert.throws(() => repo.inspectWriterAuthority({
    packagePath: `${root}/packages/../packages/access-package`,
  }), /selector_invalid/);
  assert.equal(repo.assertHeld(deleted.handle, { statuses: ['deleted'] }).status, 'deleted');
});

test('writer guard holds the process-shared repository lock through its callback', (t) => {
  const { root, lifecycleHash } = fixture(t, 'process-lock');
  const repo = repository(root);
  const moduleUrl = pathToFileURL(path.resolve(
    'paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs',
  )).href;
  repo.withWriterGuard({ packageLifecycleReceiptHash: lifecycleHash }, ({ assertHeld }) => {
    assert.equal(assertHeld(), true);
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { createRuntimeRetentionPackageDeletionFenceRepository } from ${JSON.stringify(moduleUrl)};
      try {
        createRuntimeRetentionPackageDeletionFenceRepository({
          runtimeRoot: ${JSON.stringify(root)},
        }).inspect(${JSON.stringify(lifecycleHash)});
        process.exit(9);
      } catch (error) {
        if (!String(error?.message || error).includes('lock_unavailable')) process.exit(8);
      }
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(assertHeld(), true);
  });
});

test('deletion guard holds the shared lock across the exact destructive callback', (t) => {
  const { root, lifecycleHash, request } = fixture(t, 'deletion-lock');
  const repo = repository(root);
  const prepared = repo.prepare(request);
  const deleting = transition(repo, prepared, 'deleting', TIMES.deleting);
  let called = 0;
  const observed = repo.withDeletionGuard(deleting.handle, ({ record, assertHeld }) => {
    called += 1;
    assert.equal(record.status, 'deleting');
    assert.equal(assertHeld().runtimeRetentionPackageDeletionFenceHash,
      deleting.record.runtimeRetentionPackageDeletionFenceHash);
    assert.throws(() => repo.withWriterGuard({
      packageLifecycleReceiptHash: lifecycleHash,
    }, () => true), /lock_unavailable/);
    return 'removed';
  });
  assert.equal(observed, 'removed');
  assert.equal(called, 1);
  assert.throws(() => repo.withDeletionGuard(prepared.handle, () => true),
    /compare_failed/);
  assert.throws(() => repo.withDeletionGuard(deleting.handle, () => Promise.resolve()),
    /async_guard_forbidden/);
});

test('unsafe records and unknown inventory residue fail closed', (t) => {
  const { root, lifecycleHash, request } = fixture(t, 'tamper');
  const repo = repository(root);
  repo.prepare(request);
  const repositoryRoot = path.join(root, '.hepta-package-deletion-fences');
  const recordPath = path.join(repositoryRoot, `${lifecycleHash.slice(7)}.json`);
  fs.chmodSync(recordPath, 0o644);
  assert.throws(() => repo.inspect(lifecycleHash), /record_invalid/);
  fs.chmodSync(recordPath, 0o600);
  fs.writeFileSync(path.join(repositoryRoot, 'unexpected-residue'), 'unsafe\n', {
    mode: 0o600,
  });
  assert.throws(() => repo.list(), /inventory_invalid/);
});

test('inventory cleanup resumes safely after an interrupted atomic record write', (t) => {
  const { root } = fixture(t, 'temporary-recovery');
  const repo = repository(root);
  assert.deepEqual(repo.list(), []);
  const repositoryRoot = path.join(root, '.hepta-package-deletion-fences');
  const safeTemporary = path.join(repositoryRoot, '.fence-tmp-crash-residue');
  fs.writeFileSync(safeTemporary, '{"partial":true}\n', { mode: 0o600 });

  assert.deepEqual(repo.list(), []);
  assert.equal(fs.existsSync(safeTemporary), false);

  const unsafeTemporary = path.join(repositoryRoot, '.fence-tmp-unsafe-residue');
  fs.mkdirSync(unsafeTemporary, { mode: 0o700 });
  assert.throws(() => repo.list(), /temporary_invalid/);
});
