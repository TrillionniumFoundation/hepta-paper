import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFilesystemArtifactRepository,
  createPackageDeletionWriterScopedFilesystemArtifactRepositoryFactory,
}
  from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createRuntimeRetentionPackageDeletionFenceRepository }
  from '../../paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs';
import { createRuntimeRetentionPackageDeletionWriterBoundary }
  from '../../paper-adapters/automation/runtime-retention-package-deletion-writer-boundary.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const TOKEN = 'opaque-artifact-writer-deletion-token-0000000000000001';

function h(label) {
  return hashRecord('RuntimeRetentionPackageDeletionWriterArtifactTest', { label });
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath || entry.path, entry.name))
    .sort();
}

function assertNoArtifactWriteResidue({ casRoot, receipts, target }) {
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(filesUnder(path.join(casRoot, 'objects')), []);
  assert.deepEqual(filesUnder(path.join(casRoot, 'manifests')), []);
  assert.deepEqual(receipts, []);
}

function fixture(t) {
  const runtimeRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(
    os.tmpdir(), 'hepta-package-writer-artifacts-',
  )));
  const packagePath = path.join(runtimeRoot, 'packages', 'paper-package');
  const casRoot = path.join(runtimeRoot, 'artifact-cas');
  const operationId = 'artifact-writer:test-process';
  fs.mkdirSync(packagePath, { recursive: true });
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const receipts = [];
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({ runtimeRoot });
  const receiptLedger = Object.freeze({
    record(receipt, context) {
      return boundary.run({ operationId }, () => {
        receipts.push({ receipt, context });
        return Object.freeze({ receiptId: `receipt-${receipts.length}` });
      });
    },
  });
  const clock = Object.freeze({
    now: () => new Date('2026-08-20T08:00:00.000Z'),
    nowIso: () => '2026-08-20T08:00:00.000Z',
  });
  const repositoryFactory =
    createPackageDeletionWriterScopedFilesystemArtifactRepositoryFactory({
      casRoot,
      receiptLedger,
      clock,
      runtimeRoot,
      packageDeletionWriterBoundary: boundary,
      packageDeletionWriterOperationId: operationId,
    });
  const repository = createFilesystemArtifactRepository({
    scopeRoot: packagePath,
    casRoot,
    receiptLedger,
    clock,
    runtimeRoot,
    packageDeletionWriterBoundary: boundary,
    packageDeletionWriterSelector: Object.freeze({ packagePath, operationId }),
    packageDeletionWriterOperationId: operationId,
  });
  const fence = createRuntimeRetentionPackageDeletionFenceRepository({
    runtimeRoot,
    randomToken: () => TOKEN,
  });
  const request = Object.freeze({
    packageLifecycleReceiptHash: h('lifecycle'),
    packagePath,
    packageContentHash: h('content'),
    deletionIntentHash: h('intent'),
    recoveryBindingHash: h('recovery'),
    authoritySnapshotHash: h('authority'),
    operationId: 'retention:artifact-writer',
    transitionId: h('prepare'),
    preparedAt: '2026-08-20T08:01:00.000Z',
    expectedPreviousFenceHash: null,
    fenceToken: TOKEN,
  });
  return {
    boundary, casRoot, fence, operationId, packagePath, receipts, repository,
    repositoryFactory, request, runtimeRoot,
  };
}

function transition(fence, current, status, transitionedAt, label, extra = {}) {
  return fence.transition(current.handle, {
    expectedRecordHash: current.record.runtimeRetentionPackageDeletionFenceHash,
    status,
    transitionedAt,
    transitionId: h(label),
    ...extra,
  });
}

test('artifact write nests under the package writer scope and records object, manifest, target, and receipt', async (t) => {
  const {
    boundary, operationId, packagePath, receipts, repository,
  } = fixture(t);
  const target = path.join(packagePath, 'nested.json');
  const result = await boundary.runAsync({ packagePath, operationId }, async () =>
    repository.writeJson(target, { guarded: true }, { role: 'guarded-test' }));
  assert.equal(result.kind, 'ArtifactWriteReceipt');
  assert.equal(fs.existsSync(target), true);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].context.stream, 'artifact-writes');
});

test('operationId-only writer context derives the target package and leaves no blocked residue', async (t) => {
  const {
    casRoot, fence, operationId, packagePath, receipts, repositoryFactory, request,
  } = fixture(t);
  const prepared = fence.prepare(request);
  const deleting = transition(fence, prepared, 'deleting',
    '2026-08-20T08:02:00.000Z', 'operation-only-deleting');
  transition(fence, deleting, 'deleted',
    '2026-08-20T08:03:00.000Z', 'operation-only-deleted');
  const target = path.join(packagePath, 'operation-only', 'blocked.json');
  const suppliedSelector = { operationId };
  const writerContext = { packageDeletionWriterSelector: suppliedSelector };
  const repository = repositoryFactory(packagePath, writerContext);
  suppliedSelector.packagePath = path.join(path.dirname(packagePath), 'different-package');
  delete suppliedSelector.operationId;
  writerContext.packageDeletionWriterSelector = null;

  await assert.rejects(repository.writeJson(target, { blocked: true }, {
    role: 'operation-only-blocked-write',
  }), /package_deleted/);
  assertNoArtifactWriteResidue({ casRoot, receipts, target });
});

test('writer context cannot rewrite the candidate package identity before artifact writes', async (t) => {
  const {
    casRoot, operationId, packagePath, receipts, repositoryFactory, runtimeRoot,
  } = fixture(t);
  const target = path.join(packagePath, 'mismatched', 'blocked.json');
  const repository = repositoryFactory(packagePath, {
    packageDeletionWriterSelector: Object.freeze({
      operationId,
      packagePath: path.join(runtimeRoot, 'packages', 'different-package'),
    }),
  });

  await assert.rejects(repository.writeJson(target, { blocked: true }, {
    role: 'mismatched-package-write',
  }), /artifact_repository_writer_selector_target_mismatch/);
  assertNoArtifactWriteResidue({ casRoot, receipts, target });

  const accessorContext = {};
  Object.defineProperty(accessorContext, 'packageDeletionWriterSelector', {
    enumerable: true,
    get: () => Object.freeze({ operationId }),
  });
  assert.throws(
    () => repositoryFactory(packagePath, accessorContext),
    /artifact_repository_factory_writer_context_invalid/,
  );
  assert.throws(
    () => repositoryFactory(packagePath, {
      packageDeletionWriterSelector: Object.freeze({ operationId }),
      packagePath,
    }),
    /artifact_repository_factory_writer_context_invalid/,
  );
  assertNoArtifactWriteResidue({ casRoot, receipts, target });
});

test('active and deleted fences reject artifact writes and non-dry GC without residue', async (t) => {
  const { casRoot, fence, packagePath, receipts, repository, request } = fixture(t);
  const prepared = fence.prepare(request);
  const blockedTarget = path.join(packagePath, 'blocked.txt');
  const orphan = path.join(casRoot, 'objects', 'sha256', 'aa', '0'.repeat(62));
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, 'orphan');
  fs.utimesSync(orphan, new Date(0), new Date(0));

  await assert.rejects(async () => repository.writeText(blockedTarget, 'blocked', {
    role: 'blocked-write',
  }), /reachability_mutation_blocked/);
  await assert.rejects(async () => repository.garbageCollect({ dryRun: false, minimumAgeMs: 0 }),
    /reachability_mutation_blocked/);
  assert.equal(fs.existsSync(blockedTarget), false);
  assert.equal(fs.existsSync(orphan), true);
  assert.equal(receipts.length, 0);

  const aborted = transition(fence, prepared, 'aborted',
    '2026-08-20T08:02:00.000Z', 'abort', { abortReasonHash: h('rollback') });
  await repository.writeText(path.join(packagePath, 'after-abort.txt'), 'allowed', {
    role: 'after-abort',
  });
  assert.equal(receipts.length, 1);

  const preparedAgain = fence.prepare({
    ...request,
    fenceToken: 'opaque-artifact-writer-deletion-token-0000000000000002',
    transitionId: h('prepare-again'),
    preparedAt: '2026-08-20T08:03:00.000Z',
    expectedPreviousFenceHash: aborted.record.runtimeRetentionPackageDeletionFenceHash,
  });
  const deleting = transition(fence, preparedAgain, 'deleting',
    '2026-08-20T08:04:00.000Z', 'deleting');
  transition(fence, deleting, 'deleted', '2026-08-20T08:05:00.000Z', 'deleted');
  const deletedTarget = path.join(packagePath, 'deleted.txt');
  await assert.rejects(async () => repository.writeText(deletedTarget, 'blocked', {
    role: 'deleted-write',
  }), /package_deleted/);
  assert.equal(fs.existsSync(deletedTarget), false);
  assert.equal(receipts.length, 1);
});
