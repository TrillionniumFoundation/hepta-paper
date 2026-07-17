import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  auditRuntimePermissions,
  RUNTIME_PERMISSION_POLICY,
} from '../../paper-adapters/runtime/runtime-permission-repository.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function mode(candidate) {
  return fs.lstatSync(candidate).mode & 0o777;
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

  const applied = auditRuntimePermissions({ runtimeRoot: sample.root, execute: true });
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

  const repeated = auditRuntimePermissions({ runtimeRoot: sample.root, execute: true });
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

  const report = auditRuntimePermissions({ runtimeRoot: sample.root, execute: true });
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

  const report = auditRuntimePermissions({ runtimeRoot: sample.root, execute: true });
  assert.equal(report.status, 'runtime_permissions_blocked');
  assert.equal(report.summary.appliedCount, 0);
  assert.ok(report.blockers.some((row) => (
    row.relativePath === 'automation-workspaces/shared.txt'
      && row.reason === 'runtime_permission_multiply_linked_file_forbidden'
  )));
  assert.equal(mode(external), 0o664);
  assert.equal(mode(sample.plain), 0o664);
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

  const execute = run('--execute');
  assert.equal(execute.status, 0, execute.stderr);
  assert.equal(JSON.parse(execute.stdout).status, 'runtime_permissions_hardened');
  assert.equal(mode(sample.root), 0o700);
  assert.equal(mode(sample.plain), 0o600);

  const repeated = run('--execute');
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
