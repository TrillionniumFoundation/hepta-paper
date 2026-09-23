import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { assertWorkspaceReleaseReady } from '../src/release-state-repository.mjs';
import {
  buildAndSealImmutableReleaseDeploymentClosure,
} from '../../paper-adapters/runtime/immutable-release-deployment-closure-repository.mjs';
import {
  cleanupImmutableReleaseCandidateForPlan,
  materializeImmutableReleaseCandidate,
  publishSealedImmutableReleaseCandidate,
} from '../../paper-adapters/runtime/immutable-release-candidate-repository.mjs';
import {
  buildReleaseDependencyTreeContract,
} from '../../paper-adapters/runtime/release-dependency-tree.mjs';
import {
  buildImmutableReleaseDeploymentPlan,
  IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
  IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS,
  IMMUTABLE_RELEASE_LIVE_ROOT,
  IMMUTABLE_RELEASE_MOUNT_UNIT,
  IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (value) => hashRecord('ImmutableReleaseCandidateRepositoryTest', value);

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

function makeWritable(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(root, stat.mode | 0o700);
    for (const name of fs.readdirSync(root)) makeWritable(path.join(root, name));
  } else fs.chmodSync(root, stat.mode | 0o600);
}

function submodule(root, identity) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'IDENTITY.txt'), `${identity}\n`);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'candidate@example.invalid');
  git(root, 'config', 'user.name', 'Candidate Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', identity);
}

function sealPredecessor(root) {
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(candidate)) visit(path.join(candidate, name));
      fs.chmodSync(candidate, 0o555);
    } else fs.chmodSync(candidate, (stat.mode & 0o111) === 0 ? 0o444 : 0o555);
  };
  visit(root);
}

function productionProvenance(root) {
  return Object.freeze({
    ...currentCodeProvenance({
      workspaceRoot: root,
      allowReleaseCommitEnvironment: false,
      ignoreSubmoduleWorktreeStatus: true,
    }),
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
  });
}

function fixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-candidate-repository-'));
  const candidate = path.join(fixtureRoot, 'candidate');
  const sources = path.join(fixtureRoot, 'sources');
  const store = path.join(fixtureRoot, 'release-store');
  fs.mkdirSync(path.join(candidate, 'paper-core', 'docs'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'paper-core', 'config'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'node_modules', 'fixture'), { recursive: true });
  fs.mkdirSync(store, { mode: 0o755 });
  fs.writeFileSync(path.join(candidate, '.gitignore'), '/node_modules/\n');
  fs.writeFileSync(path.join(candidate, 'package.json'), `${JSON.stringify({
    name: 'hepta-paper-workspace', version: '0.21.0',
    engines: { node: '>=22.23.1 <23' }, packageManager: 'npm@10.9.8',
  })}\n`);
  fs.writeFileSync(path.join(candidate, 'package-lock.json'), `${JSON.stringify({
    name: 'hepta-paper-workspace', version: '0.21.0',
    packages: { '': { name: 'hepta-paper-workspace', version: '0.21.0' } },
  })}\n`);
  fs.writeFileSync(path.join(candidate, 'paper-core', 'docs', 'CURRENT_STATUS.md'),
    'Release state: finalized v0.21.0 source.\n');
  fs.writeFileSync(path.join(candidate, 'RELEASE.md'),
    'Version 0.21.0 is finalized from this exact source commit.\n');
  fs.writeFileSync(path.join(candidate, 'CHANGELOG.md'),
    '## 0.21.0 (finalized source)\n');
  fs.writeFileSync(path.join(candidate, 'node_modules', 'fixture', 'index.mjs'),
    'export const fixture = true;\n');
  const dependencyContract = buildReleaseDependencyTreeContract({
    workspaceRoot: candidate,
    generatedAt: '2030-01-01T00:00:00.000Z',
  });
  fs.writeFileSync(
    path.join(candidate, 'paper-core', 'config', 'release-dependency-tree.v1.json'),
    `${JSON.stringify(dependencyContract, null, 2)}\n`,
  );
  git(candidate, 'init', '-q');
  git(candidate, 'config', 'user.email', 'candidate@example.invalid');
  git(candidate, 'config', 'user.name', 'Candidate Test');
  git(candidate, 'add', '.');
  git(candidate, 'commit', '-qm', 'candidate base');
  submodule(path.join(sources, 'core'), 'core');
  submodule(path.join(sources, 'source-cas'), 'source-cas');
  git(candidate, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q',
    `file://${path.join(sources, 'core')}`, 'core');
  git(candidate, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q',
    `file://${path.join(sources, 'source-cas')}`,
    'runtime-images/r-scientific/source-cas');
  git(candidate, 'add', '.');
  git(candidate, 'commit', '-qm', 'pin submodules');
  const commit = git(candidate, 'rev-parse', 'HEAD');
  const predecessorCommit = 'b'.repeat(40);
  const predecessor = path.join(store, predecessorCommit);
  fs.mkdirSync(path.join(predecessor, 'elan', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(predecessor, 'codex-cli-0.144.1', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(predecessor, 'elan', 'bin', 'lake'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(predecessor, 'codex-cli-0.144.1', 'bin', 'codex'),
    '#!/bin/sh\n', { mode: 0o755 });
  sealPredecessor(predecessor);
  const codeProvenance = productionProvenance(candidate);
  const releaseStateSnapshot = assertWorkspaceReleaseReady({ workspaceRoot: candidate });
  const predecessorClosureHash = H('predecessor-closure');
  const inspection = {
    version: 1,
    codeProvenance,
    releaseStateSnapshot,
    deploymentLock: { path: IMMUTABLE_RELEASE_DEPLOYMENT_LOCK, identityHash: H('lock') },
    predecessorClosureHash,
    mount: {
      liveRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
      unit: IMMUTABLE_RELEASE_MOUNT_UNIT,
      releasePath: predecessor,
      sourceCommit: predecessorCommit,
      identityHash: H('mount'),
    },
    configIdentityHash: H('config'),
    recoveryGateIdentityHash: IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH,
    units: IMMUTABLE_RELEASE_CONSUMER_UNITS.map((name) => ({
      name, activeState: 'inactive', enablement: 'disabled',
    })),
    installedArtifacts: IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS.map((artifact) => ({
      path: artifact, present: false, identityHash: null,
    })),
  };
  const plan = buildImmutableReleaseDeploymentPlan({
    inspection,
    releaseStoreRoot: store,
    testOnlyAllowUnpinnedReleaseStore: true,
  });
  assert.equal(plan.commit, commit);
  t.after(() => {
    makeWritable(fixtureRoot);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  return { fixtureRoot, candidate, store, predecessor, predecessorClosureHash, plan };
}

test('candidate materialization copies full closure without hardlinks and publishes atomically', (t) => {
  const sample = fixture(t);
  const prepared = materializeImmutableReleaseCandidate({
    plan: sample.plan,
    candidateWorkspaceRoot: sample.candidate,
    inspectReleaseState: ({ workspaceRoot, expectedSnapshotHash }) =>
      assertWorkspaceReleaseReady({ workspaceRoot, expectedSnapshotHash }),
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  });
  assert.equal(prepared.status, 'immutable_release_candidate_materialized');
  assert.equal(prepared.submoduleMaterialization.status,
    'immutable_release_submodules_materialized');
  const sourceDependency = fs.statSync(path.join(
    sample.candidate, 'node_modules', 'fixture', 'index.mjs',
  ));
  const copiedDependency = fs.statSync(path.join(
    prepared.releaseRoot, 'node_modules', 'fixture', 'index.mjs',
  ));
  assert.notDeepEqual(
    [sourceDependency.dev, sourceDependency.ino],
    [copiedDependency.dev, copiedDependency.ino],
  );
  const closure = buildAndSealImmutableReleaseDeploymentClosure({
    workspaceRoot: prepared.releaseRoot,
    inheritedFromClosureHash: sample.predecessorClosureHash,
    approvedPredecessorClosureHashes: [sample.predecessorClosureHash],
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowNonRoot: true,
  });
  assert.equal(closure.status, 'immutable_release_deployment_closure_verified');
  let publication;
  try {
    publication = publishSealedImmutableReleaseCandidate({ plan: sample.plan, prepared });
  } catch (error) {
    assert.fail(JSON.stringify({
      code: error.code,
      moveStatus: error.moveStatus,
      moveSignal: error.moveSignal,
      moveError: error.moveError,
      moveStdout: error.moveStdout,
      moveStderr: error.moveStderr,
      sourceRemains: error.sourceRemains,
      targetExists: error.targetExists,
      sourceParent: error.sourceParent,
      targetParent: error.targetParent,
    }));
  }
  assert.equal(publication.status, 'immutable_release_candidate_published');
  assert.equal(publication.releasePath, sample.plan.target.releasePath);
  assert.equal(fs.existsSync(prepared.stagingContainer), false);
  assert.equal(fs.statSync(publication.releasePath).mode & 0o7777, 0o555);
  const cleanup = cleanupImmutableReleaseCandidateForPlan({
    plan: sample.plan,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    removePublishedTarget: true,
    expectedPublicationIdentityHash: publication.publicationIdentityHash,
  });
  assert.equal(cleanup.publishedCleaned, true);
  assert.equal(fs.existsSync(publication.releasePath), false);
});

test('an existing commit target fails before staging or copy', (t) => {
  const sample = fixture(t);
  fs.mkdirSync(sample.plan.target.releasePath);
  assert.throws(() => materializeImmutableReleaseCandidate({
    plan: sample.plan,
    candidateWorkspaceRoot: sample.candidate,
    inspectReleaseState: ({ workspaceRoot, expectedSnapshotHash }) =>
      assertWorkspaceReleaseReady({ workspaceRoot, expectedSnapshotHash }),
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  }), /immutable_release_candidate_target_exists/u);
  assert.deepEqual(
    fs.readdirSync(sample.store).sort(),
    [path.basename(sample.predecessor), sample.plan.commit].sort(),
  );
});
