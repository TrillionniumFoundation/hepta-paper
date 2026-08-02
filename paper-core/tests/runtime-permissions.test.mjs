import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  auditRuntimePermissions,
  RUNTIME_PERMISSION_POLICY,
  RUNTIME_PERMISSION_SCAN_LIMITS,
} from '../../paper-adapters/runtime/runtime-permission-repository.mjs';
import {
  executeLockedRuntimePermissionPlan,
  rollbackRuntimePermissionRows,
} from '../../paper-adapters/runtime/runtime-permission-execution-lock.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function mode(candidate) {
  return fs.lstatSync(candidate).mode & 0o777;
}

function fixtureModes(sample) {
  return Object.fromEntries(
    Object.entries(sample).map(([name, candidate]) => [name, mode(candidate)]),
  );
}

function assertReceiptHash(report) {
  const { runtimePermissionReceiptHash, ...payload } = report;
  assert.equal(
    runtimePermissionReceiptHash,
    hashRecord('RuntimePermissionHygieneReceipt', payload),
  );
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'automation-workspaces');
  const plain = path.join(workspace, 'draft.tex');
  const executable = path.join(workspace, 'run-analysis.sh');
  const readOnlyEvidence = path.join(workspace, 'receipt.json');
  const readOnlyExecutable = path.join(workspace, 'replay.sh');
  fs.mkdirSync(workspace);
  fs.writeFileSync(plain, 'private draft\n');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(readOnlyEvidence, '{"status":"verified"}\n');
  fs.writeFileSync(readOnlyExecutable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(root, 0o775);
  fs.chmodSync(workspace, 0o775);
  fs.chmodSync(plain, 0o664);
  fs.chmodSync(executable, 0o755);
  fs.chmodSync(readOnlyEvidence, 0o444);
  fs.chmodSync(readOnlyExecutable, 0o555);
  return { root, workspace, plain, executable, readOnlyEvidence, readOnlyExecutable };
}

test('runtime permission maintenance is read-only by default and execute converges idempotently', (t) => {
  const sample = fixture(t);
  const before = Object.fromEntries(Object.entries(sample).map(([name, candidate]) => [name, mode(candidate)]));

  const planned = auditRuntimePermissions({ runtimeRoot: sample.root });
  assert.equal(planned.status, 'runtime_permissions_changes_planned');
  assert.equal(planned.execute, false);
  assert.equal(planned.summary.plannedCount, 6);
  assert.equal(planned.summary.appliedCount, 0);
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(
    Object.fromEntries(Object.entries(sample).map(([name, candidate]) => [name, mode(candidate)])),
    before,
  );
  assert.equal(planned.policy, RUNTIME_PERMISSION_POLICY);
  assert.match(planned.initialInventoryHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(planned.postconditionInventoryHash, null);
  assertReceiptHash(planned);

  const applied = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });
  assert.equal(applied.status, 'runtime_permissions_hardened');
  assert.equal(applied.summary.plannedCount, 6);
  assert.equal(applied.summary.appliedCount, 6);
  assert.deepEqual(applied.blockers, []);
  assert.match(applied.postconditionInventoryHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(mode(sample.root), 0o700);
  assert.equal(mode(sample.workspace), 0o700);
  assert.equal(mode(sample.plain), 0o600);
  assert.equal(mode(sample.executable), 0o700);
  assert.equal(mode(sample.readOnlyEvidence), 0o400);
  assert.equal(mode(sample.readOnlyExecutable), 0o500);
  assertReceiptHash(applied);

  const repeated = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });
  assert.equal(repeated.status, 'runtime_permissions_already_compliant');
  assert.equal(repeated.summary.plannedCount, 0);
  assert.equal(repeated.summary.appliedCount, 0);
  assert.equal(repeated.summary.skippedCount, 6);
  assert.deepEqual(repeated.blockers, []);
  assertReceiptHash(repeated);
});

test('a symlink escape blocks the entire execute plan without touching either side', (t) => {
  const sample = fixture(t);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-external-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const external = path.join(externalRoot, 'unpublished.txt');
  fs.writeFileSync(external, 'external private material\n');
  fs.chmodSync(external, 0o664);
  fs.symlinkSync(external, path.join(sample.workspace, 'escape'));

  const report = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });
  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.summary.appliedCount, 0);
  assert.ok(report.blockers.some((row) => (
    row.relativePath === 'automation-workspaces/escape'
      && row.reason === 'runtime_permission_symbolic_link_forbidden'
      && row.phase === 'initial_scan'
  )));
  assert.equal(mode(sample.root), 0o775);
  assert.equal(mode(sample.plain), 0o664);
  assert.equal(mode(external), 0o664);
  assertReceiptHash(report);
});

test('a multiply linked file is blocked because chmod would affect an external name', (t) => {
  const sample = fixture(t);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-hardlink-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const external = path.join(externalRoot, 'shared.txt');
  fs.writeFileSync(external, 'shared inode\n');
  fs.chmodSync(external, 0o664);
  fs.linkSync(external, path.join(sample.workspace, 'shared.txt'));

  const report = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });
  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.summary.appliedCount, 0);
  assert.ok(report.blockers.some((row) => (
    row.relativePath === 'automation-workspaces/shared.txt'
      && row.reason === 'runtime_permission_multiply_linked_file_forbidden'
  )));
  assert.equal(mode(external), 0o664);
  assert.equal(mode(sample.plain), 0o664);
});

test('runtime permission v3 uses constant defaults and rejects every invalid or over-hard-cap limit', (t) => {
  const sample = fixture(t);
  const report = auditRuntimePermissions({ runtimeRoot: sample.root });
  assert.deepEqual(report.limits, {
    maximumEntries: RUNTIME_PERMISSION_SCAN_LIMITS.defaultMaximumEntries,
    maximumDirectoryEntries:
      RUNTIME_PERMISSION_SCAN_LIMITS.defaultMaximumDirectoryEntries,
    maximumDepth: RUNTIME_PERMISSION_SCAN_LIMITS.defaultMaximumDepth,
    reportLimit: RUNTIME_PERMISSION_SCAN_LIMITS.defaultReportLimit,
    maximumExecutePlanEntries:
      RUNTIME_PERMISSION_SCAN_LIMITS.defaultMaximumExecutePlanEntries,
  });
  for (const [option, value, reason] of [
    ['maximumEntries', 0, 'runtime_permission_maximum_entries_invalid'],
    [
      'maximumEntries',
      RUNTIME_PERMISSION_SCAN_LIMITS.hardMaximumEntries + 1,
      'runtime_permission_maximum_entries_invalid',
    ],
    [
      'maximumDirectoryEntries',
      0,
      'runtime_permission_maximum_directory_entries_invalid',
    ],
    [
      'maximumDirectoryEntries',
      RUNTIME_PERMISSION_SCAN_LIMITS.hardMaximumDirectoryEntries + 1,
      'runtime_permission_maximum_directory_entries_invalid',
    ],
    ['maximumDepth', -1, 'runtime_permission_maximum_depth_invalid'],
    [
      'maximumDepth',
      RUNTIME_PERMISSION_SCAN_LIMITS.hardMaximumDepth + 1,
      'runtime_permission_maximum_depth_invalid',
    ],
    ['reportLimit', 0, 'runtime_permission_report_limit_invalid'],
    [
      'reportLimit',
      RUNTIME_PERMISSION_SCAN_LIMITS.hardReportLimit + 1,
      'runtime_permission_report_limit_invalid',
    ],
    [
      'maximumExecutePlanEntries',
      0,
      'runtime_permission_maximum_execute_plan_entries_invalid',
    ],
    [
      'maximumExecutePlanEntries',
      RUNTIME_PERMISSION_SCAN_LIMITS.hardMaximumExecutePlanEntries + 1,
      'runtime_permission_maximum_execute_plan_entries_invalid',
    ],
  ]) {
    assert.throws(
      () => auditRuntimePermissions({
        runtimeRoot: sample.root,
        [option]: value,
      }),
      new RegExp(reason),
    );
  }
});

test('bounded report pages preserve exact counts and complete hashes bind omitted rows', (t) => {
  const sample = fixture(t);
  const first = auditRuntimePermissions({
    runtimeRoot: sample.root,
    reportLimit: 1,
  });
  const repeated = auditRuntimePermissions({
    runtimeRoot: sample.root,
    reportLimit: 1,
  });
  assert.equal(first.summary.plannedCount, 6);
  assert.equal(first.planned.length, 1);
  assert.deepEqual(first.reportPages.planned, {
    limit: 1,
    totalCount: 6,
    reportedCount: 1,
    omittedCount: 5,
    truncated: true,
  });
  assert.equal(first.initialInventoryHash, repeated.initialInventoryHash);
  assert.equal(
    first.initialInventory.plannedRowsHash,
    repeated.initialInventory.plannedRowsHash,
  );
  assert.deepEqual(first.planned, repeated.planned);

  fs.appendFileSync(sample.plain, 'hash-bound omitted content\n');
  const changed = auditRuntimePermissions({
    runtimeRoot: sample.root,
    reportLimit: 1,
  });
  assert.equal(changed.summary.plannedCount, 6);
  assert.deepEqual(changed.planned, first.planned);
  assert.notEqual(changed.initialInventoryHash, first.initialInventoryHash);
  assert.notEqual(
    changed.initialInventory.plannedRowsHash,
    first.initialInventory.plannedRowsHash,
  );
  assertReceiptHash(first);
  assertReceiptHash(changed);
});

test('bounded applied and skipped pages retain exact full counts across idempotent execution', (t) => {
  const sample = fixture(t);
  const applied = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
    reportLimit: 2,
  });
  assert.equal(applied.status, 'runtime_permissions_hardened');
  assert.equal(applied.summary.appliedCount, 6);
  assert.equal(applied.applied.length, 2);
  assert.deepEqual(applied.reportPages.applied, {
    limit: 2,
    totalCount: 6,
    reportedCount: 2,
    omittedCount: 4,
    truncated: true,
  });
  const repeated = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
    reportLimit: 2,
  });
  assert.equal(repeated.status, 'runtime_permissions_already_compliant');
  assert.equal(repeated.summary.skippedCount, 6);
  assert.equal(repeated.skipped.length, 2);
  assert.equal(repeated.reportPages.skipped.omittedCount, 4);
  assert.deepEqual(repeated.blockers, []);
});

test('a race discovered after the first chmod rolls the batch back and commits no applied rows', (t) => {
  const sample = fixture(t);
  const before = fixtureModes(sample);
  const originalFchmodSync = fs.fchmodSync;
  let mutationCalls = 0;
  fs.fchmodSync = (descriptor, selectedMode) => {
    originalFchmodSync(descriptor, selectedMode);
    mutationCalls += 1;
    if (mutationCalls === 1) {
      fs.appendFileSync(sample.plain, 'concurrent non-cooperating writer\n');
    }
  };
  t.after(() => { fs.fchmodSync = originalFchmodSync; });

  const report = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });

  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.summary.appliedCount, 0);
  assert.equal(report.summary.mutationAttemptCount, 2);
  assert.equal(report.summary.rolledBackCount, 2);
  assert.equal(report.summary.rollbackIncomplete, false);
  assert.equal(report.applied.length, 0);
  assert.ok(report.blockers.some((row) => (
    row.relativePath === 'automation-workspaces/draft.tex'
      && row.reason === 'runtime_permission_entry_identity_changed'
      && row.phase === 'apply'
  )));
  assert.deepEqual(fixtureModes(sample), before);
  assert.equal(report.postconditionInventory.plannedCount, 6);
  assertReceiptHash(report);
});

test('rollback failures stream exact evidence while bounding the returned page', (t) => {
  const sample = fixture(t);
  const originalFchmodSync = fs.fchmodSync;
  fs.fchmodSync = () => {
    const error = new Error('injected_rollback_failure');
    error.code = 'EIO';
    throw error;
  };
  t.after(() => { fs.fchmodSync = originalFchmodSync; });
  const streamed = [];
  const rows = Object.freeze(['one', 'two', 'three'].map((relativePath) => Object.freeze({
    relativePath,
    currentMode: '0600',
    identity: Object.freeze({}),
  })));

  const rollback = rollbackRuntimePermissionRows({
    root: Object.freeze({}),
    rows,
    reportLimit: 1,
    openEntry: () => Object.freeze({
      descriptor: fs.openSync(sample.plain, fs.constants.O_RDONLY),
      close: true,
    }),
    sameIdentity: () => true,
    recordBlocker: (row) => streamed.push(row),
  });

  assert.equal(rollback.rollbackIncomplete, true);
  assert.equal(rollback.rolledBackCount, 0);
  assert.equal(rollback.blockerCount, 3);
  assert.equal(rollback.blockers.length, 1);
  assert.deepEqual(rollback.blockerPage, {
    limit: 1, totalCount: 3, reportedCount: 1, omittedCount: 2, truncated: true,
  });
  assert.equal(streamed.length, 3);
  assert.match(rollback.blockerRowsHash, /^sha256:[0-9a-f]{64}$/);
});

test('an unexpected postcondition scan failure preserves mutation counts and invokes rollback', (t) => {
  const sample = fixture(t);
  const locked = Object.freeze({
    inventoryHash: 'sha256:locked',
    inventoryEvidence: Object.freeze({ inventoryHash: 'sha256:locked' }),
  });
  const applied = Object.freeze({
    applied: Object.freeze([{ relativePath: '.', currentMode: '0775', targetMode: '0700' }]),
    appliedCount: 6,
    appliedRowsHash: hashRecord('RuntimePermissionAppliedRows', ['committed']),
    appliedPage: Object.freeze({
      limit: 10, totalCount: 6, reportedCount: 1, omittedCount: 5, truncated: true,
    }),
    blockers: Object.freeze([]),
    blockerCount: 0,
    blockerRowsHash: hashRecord('RuntimePermissionApplyBlockerRows', []),
    mutationAttemptCount: 6,
    rolledBackCount: 0,
    rollbackIncomplete: false,
  });
  let scanCalls = 0;
  let rollbackCalls = 0;
  const scan = () => {
    scanCalls += 1;
    if (scanCalls === 1) return locked;
    if (scanCalls === 2) {
      const error = new Error('injected_postcondition_scan_failure');
      error.code = 'EIO';
      throw error;
    }
    return Object.freeze({
      plannedCount: 6,
      blockerCount: 0,
      inventoryEvidence: Object.freeze({ inventoryHash: 'sha256:rolled-back' }),
    });
  };
  const rollback = () => {
    rollbackCalls += 1;
    return Object.freeze({
      blockers: Object.freeze([]),
      rolledBackCount: 6,
      rollbackIncomplete: false,
    });
  };

  const result = executeLockedRuntimePermissionPlan({
    runtimeRoot: sample.root,
    execute: true,
    limits: Object.freeze({ reportLimit: 10 }),
    initial: Object.freeze({ blockerCount: 0, inventoryHash: 'sha256:locked' }),
    writerQuiescenceConfirmed: true,
    scan,
    apply: () => applied,
    rollback,
    empty: () => { throw new Error('unexpected_empty_result'); },
  });

  assert.equal(rollbackCalls, 1);
  assert.equal(result.applied.appliedCount, 0);
  assert.equal(result.applied.mutationAttemptCount, 6);
  assert.equal(result.applied.rolledBackCount, 6);
  assert.equal(result.applied.rollbackIncomplete, false);
  assert.ok(result.applied.blockers.some((row) => (
    row.reason === 'runtime_permission_postcondition_scan_failed'
      && row.phase === 'postcondition'
  )));
  assert.equal(result.postcondition.plannedCount, 6);
});

test('a noncompliant postcondition rolls the complete batch back', (t) => {
  const sample = fixture(t);
  const before = fixtureModes(sample);
  const emptyAppliedHash = auditRuntimePermissions({
    runtimeRoot: sample.root,
  }).appliedRowsHash;
  const originalFchmodSync = fs.fchmodSync;
  let mutationCalls = 0;
  fs.fchmodSync = (descriptor, selectedMode) => {
    originalFchmodSync(descriptor, selectedMode);
    mutationCalls += 1;
    if (mutationCalls === 6) fs.chmodSync(sample.plain, 0o664);
  };
  t.after(() => { fs.fchmodSync = originalFchmodSync; });

  const report = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });

  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.summary.appliedCount, 0);
  assert.equal(report.summary.mutationAttemptCount, 6);
  assert.equal(report.summary.rolledBackCount, 6);
  assert.equal(report.summary.rollbackIncomplete, false);
  assert.equal(report.appliedRowsHash, emptyAppliedHash);
  assert.ok(report.blockers.some((row) => (
    row.reason === 'runtime_permission_postcondition_not_compliant'
      && row.phase === 'postcondition'
  )));
  assert.deepEqual(fixtureModes(sample), before);
  assertReceiptHash(report);
});

test('a lock release failure preserves committed mutation evidence and blocks the receipt', (t) => {
  const sample = fixture(t);
  const before = fixtureModes(sample);
  const lockPath = path.join(
    path.dirname(sample.root),
    `.${path.basename(sample.root)}.hepta-runtime-permissions.lock`,
  );
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (selectedPath) => {
    if (path.resolve(selectedPath) === path.resolve(lockPath)) {
      const error = new Error('injected_lock_release_failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlinkSync(selectedPath);
  };
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
    if (fs.existsSync(lockPath)) originalUnlinkSync(lockPath);
  });

  const report = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });

  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.summary.appliedCount, 6);
  assert.equal(report.summary.mutationAttemptCount, 6);
  assert.equal(report.summary.rolledBackCount, 0);
  assert.equal(report.summary.rollbackIncomplete, false);
  assert.ok(report.blockers.some((row) => (
    row.reason === 'runtime_permission_execution_lock_release_failed'
      && row.phase === 'execution_lock_release'
  )));
  assert.notDeepEqual(fixtureModes(sample), before);
  assert.equal(report.postconditionInventory.plannedCount, 0);
  assertReceiptHash(report);
});

test('the execution lock re-scan rejects a plan changed after lock acquisition before chmod', (t) => {
  const sample = fixture(t);
  const before = fixtureModes(sample);
  const originalFsyncSync = fs.fsyncSync;
  let syncCalls = 0;
  fs.fsyncSync = (descriptor) => {
    originalFsyncSync(descriptor);
    syncCalls += 1;
    if (syncCalls === 1) fs.appendFileSync(sample.plain, 'changed after lock acquisition\n');
  };
  t.after(() => { fs.fsyncSync = originalFsyncSync; });

  const report = auditRuntimePermissions({
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
  });

  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.summary.appliedCount, 0);
  assert.equal(report.summary.mutationAttemptCount, 0);
  assert.ok(report.blockers.some((row) => (
    row.reason === 'runtime_permission_locked_inventory_changed'
      && row.phase === 'locked_plan_validation'
  )));
  assert.match(report.executionLock.executionLockHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(report.lockedInventory.inventoryHash, report.initialInventoryHash);
  assert.deepEqual(fixtureModes(sample), before);
  assertReceiptHash(report);
});

test('total-entry and execute-plan limits each add one global blocker before any chmod', async (t) => {
  await t.test('total entry limit', (context) => {
    const sample = fixture(context);
    const before = fixtureModes(sample);
    const report = auditRuntimePermissions({
      runtimeRoot: sample.root,
      execute: true,
      writerQuiescenceConfirmed: true,
      maximumEntries: 2,
      reportLimit: 1,
    });
    const entryBlockers = report.blockers.filter(
      (row) => row.reason === 'runtime_permission_entry_limit_exceeded',
    );
    assert.equal(report.status, 'runtime_permissions_blocked');
    assert.equal(report.summary.entriesSeen, 2);
    assert.equal(report.summary.inventoryComplete, false);
    assert.equal(report.summary.appliedCount, 0);
    assert.equal(report.summary.blockerCount, 1);
    assert.equal(entryBlockers.length, 1);
    assert.equal(entryBlockers[0].relativePath, '.');
    assert.equal(entryBlockers[0].phase, 'initial_scan');
    assert.deepEqual(fixtureModes(sample), before);
  });

  await t.test('execute plan limit', (context) => {
    const sample = fixture(context);
    const before = fixtureModes(sample);
    const report = auditRuntimePermissions({
      runtimeRoot: sample.root,
      execute: true,
      writerQuiescenceConfirmed: true,
      maximumExecutePlanEntries: 2,
      reportLimit: 1,
    });
    assert.equal(report.status, 'runtime_permissions_blocked');
    assert.equal(report.summary.plannedCount, 6);
    assert.equal(report.summary.inventoryComplete, true);
    assert.equal(report.summary.executionPlanComplete, false);
    assert.equal(report.summary.appliedCount, 0);
    assert.equal(report.summary.blockerCount, 1);
    assert.equal(
      report.blockers[0].reason,
      'runtime_permission_execute_plan_limit_exceeded',
    );
    assert.equal(report.blockers[0].relativePath, '.');
    assert.deepEqual(fixtureModes(sample), before);
  });
});

test('per-directory and depth limits fail closed without mutating the bounded prefix', async (t) => {
  for (const [name, options, reason] of [
    [
      'per-directory entry limit',
      { maximumDirectoryEntries: 2 },
      'runtime_permission_directory_entry_limit_exceeded',
    ],
    [
      'depth limit',
      { maximumDepth: 0 },
      'runtime_permission_depth_limit_exceeded',
    ],
  ]) {
    await t.test(name, (context) => {
      const sample = fixture(context);
      const before = fixtureModes(sample);
      const report = auditRuntimePermissions({
        runtimeRoot: sample.root,
        execute: true,
        writerQuiescenceConfirmed: true,
        ...options,
      });
      assert.equal(report.status, 'runtime_permissions_blocked');
      assert.equal(report.summary.inventoryComplete, false);
      assert.equal(report.summary.appliedCount, 0);
      assert.ok(report.blockers.some((row) => row.reason === reason));
      assert.deepEqual(fixtureModes(sample), before);
    });
  }
});

test('blocker pages are bounded while full blocker counts and hashes remain deterministic', (t) => {
  const sample = fixture(t);
  for (let index = 0; index < 5; index += 1) {
    fs.symlinkSync(
      `/forbidden-runtime-target-${index}`,
      path.join(sample.workspace, `escape-${index}`),
    );
  }
  const before = fixtureModes(sample);
  const options = {
    runtimeRoot: sample.root,
    execute: true,
    writerQuiescenceConfirmed: true,
    reportLimit: 2,
  };
  const report = auditRuntimePermissions(options);
  const repeated = auditRuntimePermissions(options);
  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.blockers.length, 2);
  assert.equal(report.summary.blockerCount, 5);
  assert.deepEqual(report.reportPages.blockers, {
    limit: 2,
    totalCount: 5,
    reportedCount: 2,
    omittedCount: 3,
    truncated: true,
  });
  assert.equal(report.blockerRowsHash, repeated.blockerRowsHash);
  assert.equal(report.initialInventoryHash, repeated.initialInventoryHash);
  assert.equal(report.summary.appliedCount, 0);
  assert.deepEqual(fixtureModes(sample), before);
});

test('runtime permission CLI is dry-run by default and requires explicit execute', (t) => {
  const sample = fixture(t);
  const environment = { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: sample.root };
  const run = (...args) => spawnSync(process.execPath, [
    'paper-core/bin/runtime-permissions.mjs',
    ...args,
  ], {
    cwd: workspaceRoot,
    env: environment,
    encoding: 'utf8',
  });

  const dryRun = run();
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).status, 'runtime_permissions_changes_planned');
  assert.equal(mode(sample.root), 0o775);
  assert.equal(mode(sample.plain), 0o664);

  const unfencedExecute = run('--execute');
  assert.equal(unfencedExecute.status, 2, unfencedExecute.stderr);
  assert.equal(
    JSON.parse(unfencedExecute.stdout).blockers[0].reason,
    'runtime_permission_writer_quiescence_confirmation_required',
  );
  assert.equal(mode(sample.root), 0o775);
  assert.equal(mode(sample.plain), 0o664);

  const execute = run('--execute', '--writer-quiesced');
  assert.equal(execute.status, 0, execute.stderr);
  assert.equal(JSON.parse(execute.stdout).status, 'runtime_permissions_hardened');
  assert.equal(mode(sample.root), 0o700);
  assert.equal(mode(sample.plain), 0o600);

  const repeated = run('--execute', '--writer-quiesced');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, 'runtime_permissions_already_compliant');

  const unknown = run('--root', sample.root);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown_cli_option:--root/);

  const dangerousRoot = spawnSync(process.execPath, ['paper-core/bin/runtime-permissions.mjs'], {
    cwd: workspaceRoot,
    env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: path.parse(workspaceRoot).root },
    encoding: 'utf8',
  });
  assert.notEqual(dangerousRoot.status, 0);
  assert.match(dangerousRoot.stderr, /runtime_permission_root_conflicts_with_non_runtime_root/);
});
