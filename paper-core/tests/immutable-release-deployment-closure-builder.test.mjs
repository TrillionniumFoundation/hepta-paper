import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildAndSealImmutableReleaseDeploymentClosure,
} from '../../paper-adapters/runtime/immutable-release-deployment-closure-repository.mjs';
import {
  buildReleaseDependencyTreeContract,
} from '../../paper-adapters/runtime/release-dependency-tree.mjs';
import {
  inspectSealedDeploymentClosure,
} from '../../paper-adapters/runtime/release-environment-deployment-closure.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PREDECESSOR = hashRecord('ImmutableReleaseClosureBuilderTest', 'predecessor');

function git(root, ...args) {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function removeSealed(root) {
  if (!fs.existsSync(root)) return;
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(candidate, stat.mode | 0o700);
      for (const name of fs.readdirSync(candidate)) visit(path.join(candidate, name));
    } else fs.chmodSync(candidate, stat.mode | 0o600);
  };
  visit(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function submoduleSource(root, identity) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'IDENTITY.txt'), `${identity}\n`);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'release-closure@example.invalid');
  git(root, 'config', 'user.name', 'Release Closure Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', identity);
}

function fixture(t, { externalToolSymlink = false } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-closure-builder-'));
  const root = path.join(fixtureRoot, 'release');
  const sources = path.join(fixtureRoot, 'sources');
  fs.mkdirSync(path.join(root, 'paper-core', 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'fixture'), { recursive: true });
  fs.mkdirSync(path.join(root, 'elan', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'codex-cli-0.144.1', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '/node_modules/\n');
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'immutable-release-closure-fixture', version: '0.21.0',
  })}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'immutable-release-closure-fixture', version: '0.21.0', packages: {},
  })}\n`);
  fs.writeFileSync(path.join(root, 'node_modules', 'fixture', 'index.mjs'),
    'export const fixture = true;\n');
  fs.writeFileSync(path.join(root, 'elan', 'bin', 'lake'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'codex-cli-0.144.1', 'bin', 'codex'),
    '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'codex-cli-0.144.1', 'README'), 'codex fixture\n');
  if (externalToolSymlink) {
    fs.symlinkSync('/etc/passwd', path.join(root, 'elan', 'external'));
  } else {
    fs.symlinkSync('lake', path.join(root, 'elan', 'bin', 'lake-current'));
  }
  const dependencyContract = buildReleaseDependencyTreeContract({
    workspaceRoot: root,
    generatedAt: '2030-01-01T00:00:00.000Z',
  });
  fs.writeFileSync(
    path.join(root, 'paper-core', 'config', 'release-dependency-tree.v1.json'),
    `${JSON.stringify(dependencyContract, null, 2)}\n`,
  );
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'release-closure@example.invalid');
  git(root, 'config', 'user.name', 'Release Closure Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'release fixture base');
  submoduleSource(path.join(sources, 'core'), 'core');
  submoduleSource(path.join(sources, 'source-cas'), 'source-cas');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q',
    `file://${path.join(sources, 'core')}`, 'core');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q',
    `file://${path.join(sources, 'source-cas')}`,
    'runtime-images/r-scientific/source-cas');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'pin submodules');
  fs.chmodSync(root, 0o700);
  t.after(() => removeSealed(fixtureRoot));
  return root;
}

test('v2 closure generation seals and re-verifies the complete tool/submodule closure', (t) => {
  const root = fixture(t);
  const result = buildAndSealImmutableReleaseDeploymentClosure({
    workspaceRoot: root,
    inheritedFromClosureHash: PREDECESSOR,
    approvedPredecessorClosureHashes: [PREDECESSOR],
    testOnlyAllowNonRoot: true,
  });
  assert.equal(result.status, 'immutable_release_deployment_closure_verified');
  assert.equal(result.inheritedFromClosureHash, PREDECESSOR);
  assert.match(result.closureHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.dependencyInspection.readOnly, true);
  assert.equal(fs.statSync(root).mode & 0o7777, 0o555);
  assert.equal(fs.statSync(path.join(root, 'deployment-closure')).mode & 0o7777, 0o555);
  assert.equal(fs.statSync(
    path.join(root, 'deployment-closure', 'TOOL-CLOSURE.json'),
  ).mode & 0o7777, 0o444);
  assert.equal(fs.statSync(path.join(root, 'elan', 'bin', 'lake')).mode & 0o7777, 0o555);
  const closure = JSON.parse(fs.readFileSync(
    path.join(root, 'deployment-closure', 'TOOL-CLOSURE.json'),
    'utf8',
  ));
  assert.equal(closure.version, 2);
  assert.equal(closure.closureHash, result.closureHash);
  assert.equal(closure.submodules.core.path, 'core');
  assert.equal(closure.submodules.rScientificSourceCas.path,
    'runtime-images/r-scientific/source-cas');
  assert.throws(() => fs.writeFileSync(
    path.join(root, 'codex-cli-0.144.1', 'README'),
    'tamper\n',
  ), /EACCES|EPERM/u);
});

test('unapproved lineage and external tool symlinks fail closed', (t) => {
  const lineageRoot = fixture(t);
  assert.throws(() => buildAndSealImmutableReleaseDeploymentClosure({
    workspaceRoot: lineageRoot,
    inheritedFromClosureHash: PREDECESSOR,
    approvedPredecessorClosureHashes: [hashRecord('Other', 'lineage')],
    testOnlyAllowNonRoot: true,
  }), /immutable_release_deployment_closure_options_invalid/u);

  const symlinkRoot = fixture(t, { externalToolSymlink: true });
  assert.throws(() => buildAndSealImmutableReleaseDeploymentClosure({
    workspaceRoot: symlinkRoot,
    inheritedFromClosureHash: PREDECESSOR,
    approvedPredecessorClosureHashes: [PREDECESSOR],
    testOnlyAllowNonRoot: true,
  }), /immutable_release_deployment_external_symlink_forbidden/u);
  assert.equal(fs.readFileSync('/etc/passwd', 'utf8').length > 0, true);
});

test('two consecutive v2 generations self-anchor the exact sealed live closure', (t) => {
  const firstRoot = fixture(t);
  const first = buildAndSealImmutableReleaseDeploymentClosure({
    workspaceRoot: firstRoot,
    inheritedFromClosureHash: PREDECESSOR,
    approvedPredecessorClosureHashes: [PREDECESSOR],
    testOnlyAllowNonRoot: true,
  });
  const inspectedFirst = inspectSealedDeploymentClosure({
    workspaceRoot: firstRoot,
    provenance: first.provenance,
    dependencyInspection: first.dependencyInspection,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    expectedClosureHash: first.closureHash,
  });
  assert.equal(inspectedFirst.closureHash, first.closureHash);

  const secondRoot = fixture(t);
  const second = buildAndSealImmutableReleaseDeploymentClosure({
    workspaceRoot: secondRoot,
    inheritedFromClosureHash: inspectedFirst.closureHash,
    approvedPredecessorClosureHashes: [inspectedFirst.closureHash],
    testOnlyAllowNonRoot: true,
  });
  const inspectedSecond = inspectSealedDeploymentClosure({
    workspaceRoot: secondRoot,
    provenance: second.provenance,
    dependencyInspection: second.dependencyInspection,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    expectedClosureHash: second.closureHash,
  });
  assert.equal(inspectedSecond.inheritedFromClosureHash, first.closureHash);
  assert.equal(inspectedSecond.closureHash, second.closureHash);
});
