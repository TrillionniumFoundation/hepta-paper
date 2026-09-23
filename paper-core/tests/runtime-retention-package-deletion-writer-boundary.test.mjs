import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createRuntimeRetentionPackageDeletionFenceRepository }
  from '../../paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs';
import {
  createRuntimeRetentionPackageDeletionWriterBoundary,
  createRuntimeRetentionPackageDeletionWriterScope,
}
  from '../../paper-adapters/automation/runtime-retention-package-deletion-writer-boundary.mjs';
import { createRuntimeRetentionPackageDeletionWriterStore }
  from '../../paper-adapters/persistence/runtime-retention-package-deletion-writer-store.mjs';
import { createSqliteReceiptLedger }
  from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  composeFoundationServices,
  exposeScopedFoundationServices,
} from '../../paper-composition/bootstrap/context-foundation-composition.mjs';
import {
  assertArtifactRepositoryFactoryPort,
  bindArtifactRepositoryFactoryPackageDeletionWriterScope,
  packageDeletionWriterScopeForArtifactRepositoryFactory,
} from '../../paper-ports/execution-service-ports.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const TOKEN = 'opaque-writer-boundary-deletion-token-000000000000001';
const TIMES = Object.freeze({
  prepared: '2026-08-20T06:00:00.000Z',
  deleting: '2026-08-20T06:01:00.000Z',
  aborted: '2026-08-20T06:02:00.000Z',
  preparedAgain: '2026-08-20T06:03:00.000Z',
  deletingAgain: '2026-08-20T06:04:00.000Z',
  deleted: '2026-08-20T06:05:00.000Z',
});

const REPOSITORY_URL = pathToFileURL(path.resolve(
  'paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs',
)).href;
const BOUNDARY_URL = pathToFileURL(path.resolve(
  'paper-adapters/automation/runtime-retention-package-deletion-writer-boundary.mjs',
)).href;

function h(label) {
  return hashRecord('RuntimeRetentionPackageDeletionWriterBoundaryTest', { label });
}

function fixture(t, label) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    os.tmpdir(),
    `hepta-package-deletion-writer-boundary-${label}-`,
  )));
  fs.mkdirSync(path.join(root, 'packages'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lifecycleHash = h(`${label}:lifecycle`);
  const packagePath = path.join(root, 'packages', `${label}-package`);
  const request = Object.freeze({
    packageLifecycleReceiptHash: lifecycleHash,
    packagePath,
    packageContentHash: h(`${label}:content`),
    deletionIntentHash: h(`${label}:intent`),
    recoveryBindingHash: h(`${label}:recovery`),
    authoritySnapshotHash: h(`${label}:authority`),
    operationId: `retention:${label}`,
    transitionId: h(`${label}:prepare`),
    preparedAt: TIMES.prepared,
    expectedPreviousFenceHash: null,
    fenceToken: TOKEN,
  });
  return Object.freeze({ lifecycleHash, packagePath, request, root });
}

function repository(root, token = TOKEN) {
  return createRuntimeRetentionPackageDeletionFenceRepository({
    runtimeRoot: root,
    randomToken: () => token,
  });
}

function transition(repo, current, status, transitionedAt, label, extra = {}) {
  return repo.transition(current.handle, {
    expectedRecordHash: current.record.runtimeRetentionPackageDeletionFenceHash,
    status,
    transitionedAt,
    transitionId: h(label),
    ...extra,
  });
}

function childResult(source) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('writer boundary exposes separate synchronous and asynchronous capabilities', async (t) => {
  const { root, lifecycleHash } = fixture(t, 'surface');
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  assert.deepEqual(Object.keys(boundary), ['run', 'runAsync']);
  assert.equal(Object.isFrozen(boundary), true);
  assert.throws(() => boundary.run({ packageLifecycleReceiptHash: lifecycleHash }),
    /operation_invalid/);

  let asyncCalled = false;
  assert.throws(() => boundary.run({ packageLifecycleReceiptHash: lifecycleHash },
    async () => { asyncCalled = true; }), /operation_invalid/);
  assert.equal(asyncCalled, false);
  assert.throws(() => boundary.run({ packageLifecycleReceiptHash: lifecycleHash },
    () => Promise.resolve('deferred')), /async_forbidden/);
  assert.throws(() => boundary.runAsync({ packageLifecycleReceiptHash: lifecycleHash },
    () => 'not-a-promise'), /native_promise_required/);
  assert.throws(() => boundary.runAsync({ packageLifecycleReceiptHash: lifecycleHash },
    () => ({ then() {} })), /native_promise_required/);
  class DerivedPromise extends Promise {}
  assert.throws(() => boundary.runAsync({ packageLifecycleReceiptHash: lifecycleHash },
    () => new DerivedPromise(() => {})), /native_promise_required/);
  assert.equal(await boundary.runAsync({ packageLifecycleReceiptHash: lifecycleHash },
    async () => 'asynchronous'), 'asynchronous');
});

test('nested calls reuse one held writer lock and may only narrow its selector', (t) => {
  const { root, lifecycleHash, packagePath } = fixture(t, 'nested');
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  const repo = repository(root);
  const calls = [];
  const observed = boundary.run({
    packageLifecycleReceiptHash: lifecycleHash,
    packagePath,
    operationId: 'package:nested',
  }, (...args) => {
    assert.deepEqual(args, []);
    calls.push('outer');
    return boundary.run({ operationId: 'package:nested' }, () => {
      calls.push('nested');
      assert.throws(() => repo.list(), /lock_unavailable/);
      assert.throws(() => boundary.run({
        packageLifecycleReceiptHash: h('nested:other-lifecycle'),
      }, () => true), /selector_not_held/);
      return 'written';
    });
  });
  assert.equal(observed, 'written');
  assert.deepEqual(calls, ['outer', 'nested']);
  assert.deepEqual(repo.list(), []);
});

test('async scope holds flock through await, permits nested sync/async, and expires stale context', async (t) => {
  const { root, lifecycleHash, packagePath, request } = fixture(t, 'async');
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({ runtimeRoot: root });
  const repo = repository(root);
  let release;
  let staleResult;
  const gate = new Promise((resolve) => { release = resolve; });
  const stale = new Promise((resolve) => { staleResult = resolve; });
  const pending = boundary.runAsync({
    packageLifecycleReceiptHash: lifecycleHash,
    packagePath,
    operationId: 'package:async',
  }, async () => {
    assert.equal(boundary.run({ operationId: 'package:async' }, () => 'sync'), 'sync');
    assert.equal(await boundary.runAsync({ packagePath }, async () => 'nested'), 'nested');
    setTimeout(() => {
      try {
        boundary.run({ packagePath }, () => true);
        staleResult(null);
      } catch (error) {
        staleResult(error);
      }
    }, 20);
    await gate;
    return 'released';
  });

  const child = childResult(`
    import { createRuntimeRetentionPackageDeletionFenceRepository } from ${JSON.stringify(REPOSITORY_URL)};
    try {
      createRuntimeRetentionPackageDeletionFenceRepository({
        runtimeRoot: ${JSON.stringify(root)},
      }).prepare(${JSON.stringify(request)});
      process.exit(9);
    } catch (error) {
      if (!String(error?.message || error).includes('lock_unavailable')) process.exit(8);
    }
  `);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  release();
  assert.equal(await pending, 'released');
  assert.match((await stale)?.message || '', /capability_expired/);
  assert.deepEqual(repo.list(), []);

  await assert.rejects(boundary.runAsync({ packagePath }, async () => {
    throw new Error('async-writer-rejected');
  }), /async-writer-rejected/);
  assert.deepEqual(repo.list(), []);
  boundary.run({ packagePath }, () => {
    assert.throws(() => boundary.runAsync({ packagePath }, async () => true),
      /async_scope_required/);
  });
});

test('writer and deletion guards contend on the same cross-process lock', (t) => {
  const { root, lifecycleHash, request } = fixture(t, 'cross-process');
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  boundary.run({ packageLifecycleReceiptHash: lifecycleHash }, () => {
    const child = childResult(`
      import { createRuntimeRetentionPackageDeletionFenceRepository } from ${JSON.stringify(REPOSITORY_URL)};
      try {
        createRuntimeRetentionPackageDeletionFenceRepository({
          runtimeRoot: ${JSON.stringify(root)},
        }).prepare(${JSON.stringify(request)});
        process.exit(9);
      } catch (error) {
        if (!String(error?.message || error).includes('lock_unavailable')) process.exit(8);
      }
    `);
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  const repo = repository(root);
  const prepared = repo.prepare(request);
  const deleting = transition(
    repo,
    prepared,
    'deleting',
    TIMES.deleting,
    'cross-process:deleting',
  );
  repo.withDeletionGuard(deleting.handle, () => {
    const child = childResult(`
      import { createRuntimeRetentionPackageDeletionWriterBoundary } from ${JSON.stringify(BOUNDARY_URL)};
      try {
        createRuntimeRetentionPackageDeletionWriterBoundary({
          runtimeRoot: ${JSON.stringify(root)},
        }).run({ packageLifecycleReceiptHash: ${JSON.stringify(lifecycleHash)} }, () => true);
        process.exit(9);
      } catch (error) {
        if (!String(error?.message || error).includes('lock_unavailable')) process.exit(8);
      }
    `);
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
});

test('active fences block writers, abort restores access, and deleted is target-specific', (t) => {
  const { root, lifecycleHash, packagePath, request } = fixture(t, 'states');
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  const repo = repository(root);
  const prepared = repo.prepare(request);
  assert.throws(() => boundary.run({ operationId: 'writer:unrelated' }, () => true),
    /reachability_mutation_blocked/);

  const aborted = transition(repo, prepared, 'aborted', TIMES.aborted,
    'states:aborted', { abortReasonHash: h('states:rollback-verified') });
  assert.equal(boundary.run({ operationId: 'writer:after-abort' }, () => 'allowed'),
    'allowed');

  const preparedAgain = repo.prepare({
    ...request,
    fenceToken: 'fresh-writer-boundary-deletion-token-00000000000002',
    preparedAt: TIMES.preparedAgain,
    transitionId: h('states:prepare-again'),
    expectedPreviousFenceHash:
      aborted.record.runtimeRetentionPackageDeletionFenceHash,
  });
  const deleting = transition(repo, preparedAgain, 'deleting', TIMES.deletingAgain,
    'states:deleting-again');
  transition(repo, deleting, 'deleted', TIMES.deleted, 'states:deleted');

  assert.throws(() => boundary.run({ packagePath }, () => true), /package_deleted/);
  assert.throws(() => boundary.run({
    packageLifecycleReceiptHash: lifecycleHash,
    operationId: 'writer:selector-padding',
  }, () => true), /package_deleted/);
  assert.equal(boundary.run({ operationId: 'writer:different-target' }, () => 'allowed'),
    'allowed');
});

test('writer StorePort holds one reentrant guard across nested execute and mutate', (t) => {
  const { root } = fixture(t, 'store-nested');
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  const repo = repository(root);
  const calls = [];
  let guardedStore;
  const rawStore = Object.freeze({
    version: 3,
    kind: 'WriterStoreFixture',
    readOnly: false,
    query: () => ({ ok: true, rows: [] }),
    execute(sql) {
      calls.push(`execute:${sql}`);
      return guardedStore.mutate({
        operationId: 'fixture:nested',
        mutate() {
          calls.push('mutate');
          assert.throws(() => repo.list(), /lock_unavailable/);
          return 'nested-written';
        },
      });
    },
    mutate({ mutate }) { return mutate(); },
  });
  guardedStore = createRuntimeRetentionPackageDeletionWriterStore({
    store: rawStore,
    writerBoundary: boundary,
    operationId: 'store:nested',
  });

  assert.equal(guardedStore.execute('outer'), 'nested-written');
  assert.deepEqual(calls, ['execute:outer', 'mutate']);
  assert.equal(Object.hasOwn(guardedStore, 'writerBoundary'), false);
  assert.equal(Object.getPrototypeOf(guardedStore), Object.prototype);
});

test('writer StorePort rejects active and matching deleted fences before callbacks', (t) => {
  const { root, request } = fixture(t, 'store-states');
  const operationId = 'store:state-guard';
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  const calls = [];
  const rawStore = Object.freeze({
    version: 3,
    kind: 'WriterStoreStateFixture',
    readOnly: false,
    query() { calls.push('query'); return { ok: true, rows: [] }; },
    execute() { calls.push('execute'); return { ok: true }; },
    mutate({ mutate }) { calls.push('mutate'); return mutate(); },
  });
  const guardedStore = createRuntimeRetentionPackageDeletionWriterStore({
    store: rawStore,
    writerBoundary: boundary,
    operationId,
  });
  const repo = repository(root);
  const prepared = repo.prepare({ ...request, operationId });

  assert.deepEqual(guardedStore.query('SELECT 1'), { ok: true, rows: [] });
  assert.throws(() => guardedStore.execute('UPDATE fixture'),
    /reachability_mutation_blocked/);
  assert.throws(() => guardedStore.mutate({
    operationId: 'fixture:not-reached',
    mutate() { calls.push('callback'); },
  }), /reachability_mutation_blocked/);
  assert.deepEqual(calls, ['query']);

  const aborted = transition(repo, prepared, 'aborted', TIMES.aborted,
    'store-states:aborted', { abortReasonHash: h('store-states:restored') });
  assert.deepEqual(guardedStore.execute('UPDATE fixture'), { ok: true });
  const preparedAgain = repo.prepare({
    ...request,
    operationId,
    fenceToken: 'fresh-store-state-guard-token-00000000000000000001',
    preparedAt: TIMES.preparedAgain,
    transitionId: h('store-states:prepare-again'),
    expectedPreviousFenceHash:
      aborted.record.runtimeRetentionPackageDeletionFenceHash,
  });
  const deleting = transition(repo, preparedAgain, 'deleting',
    TIMES.deletingAgain, 'store-states:deleting');
  transition(repo, deleting, 'deleted', TIMES.deleted, 'store-states:deleted');
  assert.throws(() => guardedStore.execute('UPDATE stale_package'),
    /package_deleted/);
  assert.deepEqual(calls, ['query', 'execute']);
});

test('targeted StorePort mutations keep active global and deleted package-specific', (t) => {
  const { root, lifecycleHash, packagePath, request } = fixture(
    t,
    'store-targeted-states',
  );
  const otherPackagePath = path.join(root, 'packages', 'unrelated-package');
  const operationId = 'store:targeted-state-guard';
  const heldBoundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  const selectors = [];
  const boundary = Object.freeze({
    run(selector, operation) {
      selectors.push(selector);
      return heldBoundary.run(selector, operation);
    },
  });
  const calls = [];
  const executeCalls = [];
  const residue = [];
  const rawStore = Object.freeze({
    version: 3,
    kind: 'TargetedWriterStoreFixture',
    readOnly: false,
    query: () => ({ ok: true, rows: [] }),
    execute(sql) {
      executeCalls.push(sql);
      residue.push(sql);
      return { ok: true };
    },
    mutate(input) {
      calls.push(input.operationId);
      assert.equal(Object.hasOwn(input, 'packageDeletionWriterSelector'), false);
      return input.mutate(Object.freeze({
        run() {
          residue.push(input.operationId);
          return Object.freeze({ changes: 1 });
        },
      }));
    },
  });
  const guardedStore = createRuntimeRetentionPackageDeletionWriterStore({
    store: rawStore,
    writerBoundary: boundary,
    operationId,
  });
  const repo = repository(root);
  const prepared = repo.prepare(request);
  const unrelatedMutation = () => guardedStore.mutate({
    operationId: 'fixture:unrelated-package-write',
    packageDeletionWriterSelector: Object.freeze({
      packagePath: otherPackagePath,
    }),
    mutate: (transaction) => transaction.run('insert-unrelated').changes,
  });

  assert.throws(unrelatedMutation, /reachability_mutation_blocked/);
  assert.deepEqual(calls, []);
  assert.deepEqual(executeCalls, []);
  assert.deepEqual(residue, []);

  const deleting = transition(
    repo,
    prepared,
    'deleting',
    TIMES.deleting,
    'store-targeted-states:deleting',
  );
  transition(
    repo,
    deleting,
    'deleted',
    TIMES.deleted,
    'store-targeted-states:deleted',
  );

  assert.throws(() => guardedStore.mutate({
    operationId: 'fixture:stale-package-write',
    packageDeletionWriterSelector: Object.freeze({
      packageLifecycleReceiptHash: lifecycleHash,
      packagePath,
    }),
    mutate: (transaction) => transaction.run('insert-stale').changes,
  }), /package_deleted/);
  assert.deepEqual(calls, []);
  assert.deepEqual(executeCalls, []);
  assert.deepEqual(residue, []);

  assert.throws(() => guardedStore.execute('insert-stale', {
    packageDeletionWriterSelector: Object.freeze({ packagePath }),
  }), /package_deleted/);
  assert.deepEqual(executeCalls, []);
  assert.deepEqual(residue, []);

  assert.deepEqual(guardedStore.execute('insert-unrelated', {
    packageDeletionWriterSelector: Object.freeze({
      packagePath: otherPackagePath,
    }),
  }), { ok: true });

  assert.equal(unrelatedMutation(), 1);
  assert.deepEqual(calls, ['fixture:unrelated-package-write']);
  assert.deepEqual(executeCalls, ['insert-unrelated']);
  assert.deepEqual(residue, [
    'insert-unrelated',
    'fixture:unrelated-package-write',
  ]);
  assert.equal(selectors.length, 5);
  assert.ok(selectors.every((selector) => selector.operationId === operationId));
  assert.deepEqual(selectors[0], {
    operationId,
    packagePath: otherPackagePath,
  });
  assert.deepEqual(selectors[1], {
    operationId,
    packageLifecycleReceiptHash: lifecycleHash,
    packagePath,
  });
});

test('lifecycle, recovery, and legal-hold ledger writes select their package', (t) => {
  const { root, lifecycleHash, packagePath, request } = fixture(
    t,
    'receipt-targeted-states',
  );
  const repo = repository(root);
  const prepared = repo.prepare(request);
  const deleting = transition(
    repo,
    prepared,
    'deleting',
    TIMES.deleting,
    'receipt-targeted-states:deleting',
  );
  transition(
    repo,
    deleting,
    'deleted',
    TIMES.deleted,
    'receipt-targeted-states:deleted',
  );

  const callbacks = [];
  const rows = [];
  const rawStore = Object.freeze({
    version: 3,
    kind: 'TargetedReceiptLedgerStoreFixture',
    readOnly: false,
    query: () => ({ ok: true, rows: [] }),
    execute: () => ({ ok: true }),
    mutate({ operationId, mutate }) {
      callbacks.push(operationId);
      const value = mutate(Object.freeze({
        run(_statementId, ...parameters) {
          rows.push(JSON.parse(parameters[5]));
          return Object.freeze({ changes: 1 });
        },
      }));
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_finalized',
        value,
      });
    },
  });
  const guardedStore = createRuntimeRetentionPackageDeletionWriterStore({
    store: rawStore,
    writerBoundary: createRuntimeRetentionPackageDeletionWriterBoundary({
      runtimeRoot: root,
    }),
    operationId: 'store:targeted-receipt-ledger',
  });
  const ledger = createSqliteReceiptLedger({
    store: guardedStore,
    clock: Object.freeze({ nowIso: () => TIMES.deleted }),
    writerIdentity: Object.freeze({ writerId: 'targeted-receipt-test' }),
  });
  const targetedReceipts = [
    Object.freeze({
      kind: 'PackageLifecycleReceipt',
      status: 'package_lifecycle_current_release_recorded',
      packagePath,
      packageLifecycleReceiptHash: lifecycleHash,
    }),
    Object.freeze({
      kind: 'PackageRetentionRecoveryReceipt',
      status: 'package_retention_recovery_verified',
      packagePath,
      packageLifecycleReceiptHash: lifecycleHash,
      packageRetentionRecoveryReceiptHash: h('receipt-targeted:recovery'),
    }),
    Object.freeze({
      kind: 'PackageRetentionLegalHoldReceipt',
      status: 'package_retention_legal_hold_active',
      packagePath,
      packageLifecycleReceiptHash: lifecycleHash,
      packageRetentionLegalHoldReceiptHash: h('receipt-targeted:legal-hold'),
    }),
  ];
  for (const receipt of targetedReceipts) {
    assert.throws(() => ledger.record(receipt, {
      stream: 'package-lifecycle',
    }), /package_deleted/);
  }
  assert.deepEqual(callbacks, []);
  assert.deepEqual(rows, []);

  const unrelated = Object.freeze({
    kind: 'PackageLifecycleReceipt',
    status: 'package_lifecycle_current_release_recorded',
    packagePath: path.join(root, 'packages', 'unrelated-receipt-package'),
    packageLifecycleReceiptHash: h('receipt-targeted:unrelated-lifecycle'),
  });
  assert.equal(ledger.record(unrelated, {
    stream: 'package-lifecycle',
  }).receiptHash, unrelated.packageLifecycleReceiptHash);
  assert.deepEqual(callbacks, ['native-store.receipt-ledger.record.v1']);
  assert.deepEqual(rows, [unrelated]);
});

test('artifact factory validation preserves only its writer scope capability', async (t) => {
  const { root, packagePath } = fixture(t, 'artifact-factory-scope');
  const operationId = 'store:artifact-factory-scope';
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({
    runtimeRoot: root,
  });
  const writerScope = createRuntimeRetentionPackageDeletionWriterScope({
    writerBoundary: boundary,
    operationId,
  });
  const artifactRepository = Object.freeze(Object.fromEntries([
    'writeBytes', 'writeText', 'writeJson', 'readManifest', 'garbageCollect',
  ].map((name) => [name, () => name])));
  const boundFactory = bindArtifactRepositoryFactoryPackageDeletionWriterScope(
    () => artifactRepository,
    writerScope,
  );
  const validatedFactory = assertArtifactRepositoryFactoryPort(boundFactory);
  const preservedScope =
    packageDeletionWriterScopeForArtifactRepositoryFactory(validatedFactory);

  assert.deepEqual(Object.keys(boundFactory), []);
  assert.deepEqual(Object.keys(preservedScope), ['version', 'kind', 'runAsync']);
  assert.equal(validatedFactory('/fixture'), artifactRepository);
  assert.equal(await preservedScope.runAsync({ packagePath }, async () =>
    boundary.run({ operationId }, () => 'same-writer-scope')), 'same-writer-scope');
  assert.throws(() => preservedScope.runAsync({
    packagePath,
    operationId: 'store:different-scope',
  }, async () => true), /writer_scope_selector_invalid/);
  assert.throws(() => createRuntimeRetentionPackageDeletionWriterScope(),
    /writer_scope_invalid/);
  assert.throws(() => bindArtifactRepositoryFactoryPackageDeletionWriterScope(
    {},
    writerScope,
  ), /ArtifactRepositoryFactoryPort must be a function/);
  assert.throws(() => bindArtifactRepositoryFactoryPackageDeletionWriterScope(
    () => artifactRepository,
    Object.freeze({ version: 1, kind: 'WrongWriterScope', runAsync() {} }),
  ), /writer scope is invalid/);
});

test('foundation owns one writer boundary and never exposes its internal capability', (t) => {
  const { root, request } = fixture(t, 'foundation');
  const assetRoot = `${root}-assets`;
  fs.mkdirSync(assetRoot);
  t.after(() => fs.rmSync(assetRoot, { recursive: true, force: true }));
  let executeCalls = 0;
  const rawStore = Object.freeze({
    version: 3,
    kind: 'FoundationWriterStoreFixture',
    readOnly: false,
    query: () => ({ ok: true, rows: [] }),
    execute() { executeCalls += 1; return { ok: true }; },
  });
  const foundation = composeFoundationServices({
    root: assetRoot,
    runtimeRoot: root,
    readOnly: false,
    serviceOverrides: { store: rawStore },
    writerId: 'foundation-test',
  });
  assert.equal(foundation.store.kind,
    'RuntimeRetentionPackageDeletionWriterStoreAdapter');
  assert.deepEqual(Object.keys(foundation.packageDeletionWriterBoundary), [
    'run',
    'runAsync',
  ]);
  assert.equal(foundation.packageDeletionWriterOperationId,
    'store:foundation-test');
  const exposed = exposeScopedFoundationServices(foundation, {
    schemaVersion: Object.freeze({ status: 'test' }),
  });
  assert.equal(Object.hasOwn(exposed, 'store'), false);
  assert.equal(Object.hasOwn(exposed, 'packageDeletionWriterBoundary'), false);
  assert.equal(Object.hasOwn(exposed, 'packageDeletionWriterOperationId'), false);

  const repo = repository(root);
  repo.prepare({ ...request, operationId: 'store:foundation-test' });
  assert.throws(() => foundation.store.execute('UPDATE fixture'),
    /reachability_mutation_blocked/);
  assert.equal(executeCalls, 0);
  assert.throws(() => composeFoundationServices({
    root: assetRoot,
    runtimeRoot: root,
    readOnly: false,
    serviceOverrides: { store: rawStore, receiptLedger: {} },
    writerId: 'foundation-override-test',
  }), /foundation_mutable_receiptLedger_override_forbidden/);
});
