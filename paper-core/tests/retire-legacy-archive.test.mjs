import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  inspectLegacyArchiveRetirement,
  parseRetireLegacyArchiveArguments,
} from '../bin/retire-legacy-archive.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const commandPath = path.join(workspaceRoot, 'paper-core', 'bin', 'retire-legacy-archive.mjs');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'),
).version;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function treeSnapshot(root) {
  const rows = [];
  function walk(candidate, relative) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      rows.push({ relative, kind: 'symlink', target: fs.readlinkSync(candidate) });
      return;
    }
    if (stat.isDirectory()) {
      rows.push({ relative, kind: 'directory', mode: stat.mode & 0o7777 });
      for (const name of fs.readdirSync(candidate).sort()) {
        walk(path.join(candidate, name), path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      const bytes = fs.readFileSync(candidate);
      rows.push({
        relative,
        kind: 'file',
        mode: stat.mode & 0o7777,
        bytes: stat.size,
        sha256: sha256(bytes),
      });
      return;
    }
    rows.push({ relative, kind: 'other', mode: stat.mode & 0o7777 });
  }
  walk(root, '.');
  return rows;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retire-legacy-safe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyRoot = path.join(root, 'legacy');
  const runtimeRoot = path.join(root, 'runtime');
  const assetRoot = path.join(root, 'assets');
  fs.mkdirSync(path.join(legacyRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'bin', 'paperctl'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(legacyRoot, 'paper_factory.sqlite'), 'fixture sqlite bytes\n', {
    mode: 0o640,
  });
  const archiveRoot = path.join(root, 'hepta-paper-legacy-reference', packageVersion);
  const archivePath = path.join(archiveRoot, 'paper-factory-control-plane-reference.tar.gz');
  return { root, legacyRoot, runtimeRoot, assetRoot, archiveRoot, archivePath };
}

function runCli(selected, args = []) {
  return spawnSync(process.execPath, [commandPath, ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PAPER_FACTORY_LEGACY_ROOT: selected.legacyRoot,
      HEPTA_PAPER_RUNTIME_ROOT: selected.runtimeRoot,
      HEPTA_PAPER_ASSET_ROOT: selected.assetRoot,
    },
  });
}

test('retire legacy archive parser accepts only status, help, or the explicit execute flag', () => {
  assert.deepEqual(parseRetireLegacyArchiveArguments([]), {
    command: 'status',
    executeRequested: false,
  });
  assert.deepEqual(parseRetireLegacyArchiveArguments(['status']), {
    command: 'status',
    executeRequested: false,
  });
  assert.deepEqual(parseRetireLegacyArchiveArguments(['--help']), {
    command: 'help',
    executeRequested: false,
  });
  assert.deepEqual(parseRetireLegacyArchiveArguments(['--execute']), {
    command: 'execute',
    executeRequested: true,
  });
  for (const argv of [['--bogus'], ['status', '--execute'], ['--execute=true'], ['help']]) {
    assert.throws(
      () => parseRetireLegacyArchiveArguments(argv),
      /legacy_archive_retirement_unknown_arguments/,
    );
  }
});

test('default, help, unknown arguments, and module import perform zero writes', async (t) => {
  const selected = fixture(t);
  const before = treeSnapshot(selected.root);
  const cases = [
    { label: 'default status', args: [], status: 0 },
    { label: 'explicit status', args: ['status'], status: 0 },
    { label: 'help', args: ['--help'], status: 0 },
    { label: 'unknown', args: ['--bogus'], status: 2 },
  ];
  for (const item of cases) await t.test(item.label, () => {
    const result = runCli(selected, item.args);
    assert.equal(result.status, item.status, result.stderr);
    assert.deepEqual(treeSnapshot(selected.root), before);
  });
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./paper-core/bin/retire-legacy-archive.mjs')"],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PAPER_FACTORY_LEGACY_ROOT: selected.legacyRoot,
        HEPTA_PAPER_RUNTIME_ROOT: selected.runtimeRoot,
        HEPTA_PAPER_ASSET_ROOT: selected.assetRoot,
      },
    },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.deepEqual(treeSnapshot(selected.root), before);
  assert.equal(fs.existsSync(selected.archiveRoot), false);
  assert.equal(fs.existsSync(selected.runtimeRoot), false);
});

test('explicit execute fails closed without archiving, chmod, signing, or receipt writes', (t) => {
  const selected = fixture(t);
  const before = treeSnapshot(selected.root);
  const result = runCli(selected, ['--execute']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'legacy_archive_retirement_execute_blocked');
  assert.equal(report.executeRequested, true);
  assert.equal(report.executeSupported, false);
  assert.equal(report.externalActionPerformed, false);
  assert.ok(report.blockers.includes(
    'legacy_archive_retirement_execute_disabled_pending_identity_bound_transaction',
  ));
  assert.deepEqual(treeSnapshot(selected.root), before);
  assert.equal(fs.statSync(path.join(selected.legacyRoot, 'bin', 'paperctl')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(selected.legacyRoot, 'paper_factory.sqlite')).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(selected.archiveRoot), false);
  assert.equal(fs.existsSync(path.join(selected.runtimeRoot, 'release-signing')), false);
});

test('read-only status hashes a stable archive without changing its mode', (t) => {
  const selected = fixture(t);
  fs.mkdirSync(selected.archiveRoot, { recursive: true });
  const archiveBytes = Buffer.from('existing archive bytes\n');
  fs.writeFileSync(selected.archivePath, archiveBytes, { mode: 0o640 });
  const before = treeSnapshot(selected.root);
  const result = runCli(selected, ['status']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'legacy_archive_retirement_read_only');
  assert.equal(report.archive.safeRegularFile, true);
  assert.equal(report.archive.sha256, sha256(archiveBytes));
  assert.equal(report.archive.mode, 0o640);
  assert.deepEqual(treeSnapshot(selected.root), before);
  const direct = inspectLegacyArchiveRetirement({
    legacyRoot: selected.legacyRoot,
    runtimeRoot: selected.runtimeRoot,
    assetRoot: selected.assetRoot,
    version: packageVersion,
  });
  assert.equal(direct.archive.sha256, sha256(archiveBytes));
  assert.deepEqual(treeSnapshot(selected.root), before);
});

test('a symlink archive is reported unsafe and its target is never changed', (t) => {
  const selected = fixture(t);
  fs.mkdirSync(selected.archiveRoot, { recursive: true });
  const external = path.join(selected.root, 'external-archive');
  fs.writeFileSync(external, 'preserve me\n', { mode: 0o600 });
  fs.symlinkSync(external, selected.archivePath);
  const before = treeSnapshot(selected.root);
  for (const args of [['status'], ['--execute']]) {
    const result = runCli(selected, args);
    assert.equal(result.status, args[0] === '--execute' ? 1 : 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.archive.safeRegularFile, false);
    assert.equal(report.archive.blocker, 'legacy_archive_retirement_archive_symlink');
    assert.deepEqual(treeSnapshot(selected.root), before);
  }
  assert.equal(fs.readFileSync(external, 'utf8'), 'preserve me\n');
  assert.equal(fs.statSync(external).mode & 0o777, 0o600);
});
