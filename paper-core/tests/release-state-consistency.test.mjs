import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectReleaseState } from '../src/release-state-contract.mjs';
import {
  assertWorkspaceReleaseReady,
  inspectWorkspaceReleaseState,
} from '../src/release-state-repository.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package-lock.json'), 'utf8'));

const documents = (version, state = 'development') => {
  if (state === 'development') {
    return {
      currentStatus: `This is the normative status for the unreleased v${version} development candidate.`,
      releaseDocument: `Version ${version} is an unreleased automation-first research-production candidate.`,
      changelog: `## Unreleased (${version} development)`,
    };
  }
  if (state === 'finalized') {
    return {
      currentStatus: `Release state: finalized v${version} source.`,
      releaseDocument: `Version ${version} is finalized from this exact source commit.`,
      changelog: `## ${version} (finalized source)`,
    };
  }
  return {
    currentStatus: `This is the normative status for the v${version} architecture release.`,
    releaseDocument: `Version ${version} is the current release.`,
    changelog: `## ${version}`,
  };
};

const input = ({
  version = '0.21.0',
  state = 'development',
  headTags = [],
  allTags = [],
} = {}) => ({
  packageJson: {
    name: 'hepta-paper-workspace',
    version,
    engines: { node: '>=22.23.1 <23' },
    packageManager: 'npm@10.9.8',
  },
  packageLock: {
    name: 'hepta-paper-workspace',
    version,
    packages: { '': { name: 'hepta-paper-workspace', version } },
  },
  ...documents(version, state),
  headTags,
  allTags,
});

function runGit(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function createReleaseStateRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'paper-core', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'hepta-paper-workspace',
    version: '0.21.0',
    engines: { node: '>=22.23.1 <23' },
    packageManager: 'npm@10.9.8',
  }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'hepta-paper-workspace',
    version: '0.21.0',
    packages: { '': { name: 'hepta-paper-workspace', version: '0.21.0' } },
  }));
  const finalized = documents('0.21.0', 'finalized');
  fs.writeFileSync(path.join(root, 'paper-core', 'docs', 'CURRENT_STATUS.md'), `${finalized.currentStatus}\n`);
  fs.writeFileSync(path.join(root, 'RELEASE.md'), `${finalized.releaseDocument}\n`);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `${finalized.changelog}\n`);
  runGit(root, 'init', '-q');
  runGit(root, 'config', 'user.email', 'hepta-test@example.invalid');
  runGit(root, 'config', 'user.name', 'Hepta Test');
  runGit(root, 'add', '.');
  runGit(root, 'commit', '-qm', 'release-state fixture');
  return root;
}

test('development candidate is consistent only before its version is tagged', () => {
  const candidate = inspectReleaseState(input({ allTags: ['v0.20.4'] }));
  assert.equal(candidate.ok, true);
  assert.equal(candidate.contractVersion, 2);
  assert.equal(candidate.state, 'development');
  assert.equal(candidate.documentationProfile, 'development');

  const reused = inspectReleaseState(input({ allTags: ['v0.21.0'] }));
  assert.deepEqual(reused.errors, ['development_version_tag_already_exists']);
  const tagged = inspectReleaseState(input({
    headTags: ['v0.21.0'],
    allTags: ['v0.21.0'],
  }));
  assert.deepEqual(tagged.errors, ['development_documentation_cannot_be_tagged']);
});

test('one tag-neutral finalized source transitions from release_ready to released', () => {
  const finalizedDocuments = documents('0.21.0', 'finalized');
  const ready = inspectReleaseState(input({ state: 'finalized' }));
  assert.equal(ready.ok, true);
  assert.equal(ready.state, 'release_ready');
  assert.equal(ready.documentationProfile, 'finalized');

  const released = inspectReleaseState(input({
    state: 'finalized',
    headTags: ['v0.21.0'],
    allTags: ['v0.21.0'],
  }));
  assert.equal(released.ok, true);
  assert.equal(released.state, 'released');
  assert.deepEqual(documents('0.21.0', 'finalized'), finalizedDocuments);
});

test('legacy released markers remain audit-compatible only at their exact tag', () => {
  const historic = inspectReleaseState(input({
    state: 'legacy_released',
    headTags: ['v0.21.0'],
    allTags: ['v0.21.0'],
  }));
  assert.equal(historic.ok, true);
  assert.equal(historic.state, 'released');
  assert.equal(historic.documentationProfile, 'legacy_released');

  const untagged = inspectReleaseState(input({ state: 'legacy_released' }));
  assert.deepEqual(untagged.errors, ['legacy_released_documentation_requires_head_tag']);
  assert.equal(untagged.state, null);
});

test('release documentation markers are whole-line, complete, unique, and unmixed', () => {
  const partial = input({ state: 'finalized' });
  partial.changelog = '# no finalized marker';
  assert.deepEqual(inspectReleaseState(partial).errors, [
    'release_documentation_state_partial:finalized',
  ]);

  const mixed = input({ state: 'finalized' });
  mixed.currentStatus += '\nThis is the normative status for the unreleased v0.21.0 development candidate.';
  assert.deepEqual(inspectReleaseState(mixed).errors, ['release_documentation_state_mixed']);

  const duplicate = input({ state: 'finalized' });
  duplicate.changelog += '\n## 0.21.0 (finalized source)';
  assert.deepEqual(inspectReleaseState(duplicate).errors, [
    'release_documentation_marker_duplicate:finalized',
  ]);

  const spoofed = input({ state: 'finalized' });
  spoofed.currentStatus = `prefix ${spoofed.currentStatus}`;
  spoofed.releaseDocument = `${spoofed.releaseDocument} suffix`;
  spoofed.changelog = `prefix ${spoofed.changelog}`;
  assert.deepEqual(inspectReleaseState(spoofed).errors, [
    'release_documentation_state_unrecognized',
  ]);
});

test('tag snapshots must be internally consistent and point only at this package version', () => {
  const inconsistent = inspectReleaseState(input({
    state: 'finalized',
    headTags: ['v0.21.0', 'v0.20.4', 'v0.21.0'],
    allTags: ['v0.21.0', 'v0.21.0'],
  }));
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.state, 'released');
  assert.deepEqual(inconsistent.errors, [
    'head_tag_snapshot_duplicate:v0.21.0',
    'repository_tag_snapshot_duplicate:v0.21.0',
    'head_tag_missing_from_repository_snapshot:v0.20.4',
    'head_release_tag_version_mismatch:v0.20.4',
  ]);
});

test('version, package-manager, documentation and newer-tag drift are reported together', () => {
  const candidate = input({ allTags: ['v0.22.0'] });
  candidate.packageLock.version = '0.20.4';
  candidate.packageJson.packageManager = 'npm@latest';
  candidate.currentStatus = 'stale';
  assert.deepEqual(inspectReleaseState(candidate).errors, [
    'package_lock_version_mismatch',
    'package_manager_policy_mismatch',
    'release_documentation_state_partial:development',
    'repository_tag_newer_than_package:v0.22.0',
  ]);
});

test('repository release-state command verifies development but release gate requires release_ready', () => {
  const development = spawnSync(process.execPath, ['paper-core/bin/release-state-check.mjs'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  assert.equal(development.status, 0, development.stderr || development.stdout);
  const receipt = JSON.parse(development.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.state, 'development');
  assert.equal(receipt.version, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);

  const releaseGate = spawnSync(process.execPath, [
    'paper-core/bin/release-state-check.mjs',
    '--require-state',
    'release_ready',
  ], { cwd: workspaceRoot, encoding: 'utf8' });
  assert.equal(releaseGate.status, 1);
  assert.deepEqual(JSON.parse(releaseGate.stdout).errors, [
    'required_release_state_mismatch:release_ready:development',
  ]);
});

test('operator-facing capability counts are derived from the live catalog size', () => {
  const count = Object.keys(CAPABILITY_CATALOG).length;
  const currentStatus = fs.readFileSync(
    path.join(workspaceRoot, 'paper-core', 'docs', 'CURRENT_STATUS.md'),
    'utf8',
  );
  const readme = fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf8');
  for (const document of [currentStatus, readme]) {
    assert.match(document, new RegExp(`${count}/${count}`));
    assert.match(document, new RegExp(`0/${count}`));
  }
});

test('release-state CLI rejects unknown, missing, duplicate, and override arguments', () => {
  for (const [argv, error] of [
    [['--unknown'], 'unknown_cli_option:--unknown'],
    [['--require-state'], 'missing_cli_option_value:--require-state'],
    [[
      '--require-state',
      'release_ready',
      '--require-state',
      'release_ready',
    ], 'duplicate_cli_option:--require-state'],
    [[
      '--require-state',
      'development',
    ], 'release_state_requirement_override_forbidden:development'],
    [['--require-state=release_ready'], 'unknown_cli_option:--require-state=release_ready'],
  ]) {
    const result = spawnSync(process.execPath, [
      'paper-core/bin/release-state-check.mjs',
      ...argv,
    ], { cwd: workspaceRoot, encoding: 'utf8' });
    assert.equal(result.status, 2, `${argv.join(' ')}\n${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stderr).error, error);
  }
});

test('repository inspection returns a stable hash-bound release_ready snapshot', (t) => {
  const root = createReleaseStateRepository(t);
  const ready = inspectWorkspaceReleaseState({ workspaceRoot: root });
  assert.equal(ready.version, 2);
  assert.equal(ready.kind, 'WorkspaceReleaseStateSnapshot');
  assert.equal(ready.status, 'workspace_release_state_release_ready');
  assert.equal(ready.releaseState.state, 'release_ready');
  assert.match(ready.workspaceReleaseStateSnapshotHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    assertWorkspaceReleaseReady({
      workspaceRoot: root,
      expectedSnapshotHash: ready.workspaceReleaseStateSnapshotHash,
    }).workspaceReleaseStateSnapshotHash,
    ready.workspaceReleaseStateSnapshotHash,
  );
  assert.throws(() => assertWorkspaceReleaseReady({
    workspaceRoot: root,
    expectedSnapshotHash: `sha256:${'0'.repeat(64)}`,
  }), /workspace_release_state_snapshot_changed/u);

  runGit(root, 'tag', 'v0.21.0');
  const released = inspectWorkspaceReleaseState({ workspaceRoot: root });
  assert.equal(released.releaseState.state, 'released');
  assert.notEqual(released.workspaceReleaseStateSnapshotHash, ready.workspaceReleaseStateSnapshotHash);
  assert.throws(() => assertWorkspaceReleaseReady({ workspaceRoot: root }),
    /workspace_release_state_not_ready:released/u);
});

test('repository inspection fails closed outside Git and on symlinked release documents', (t) => {
  const notRepository = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-state-no-git-'));
  t.after(() => fs.rmSync(notRepository, { recursive: true, force: true }));
  assert.throws(() => inspectWorkspaceReleaseState({ workspaceRoot: notRepository }),
    /release_state_git_query_failed:rev-parse/u);

  const root = createReleaseStateRepository(t);
  const statusPath = path.join(root, 'paper-core', 'docs', 'CURRENT_STATUS.md');
  const targetPath = path.join(root, 'status-target.md');
  fs.renameSync(statusPath, targetPath);
  fs.symlinkSync(targetPath, statusPath);
  assert.throws(() => inspectWorkspaceReleaseState({ workspaceRoot: root }),
    /release_state_document_symlink_forbidden/u);

  const parentSymlinkRoot = createReleaseStateRepository(t);
  const docsPath = path.join(parentSymlinkRoot, 'paper-core', 'docs');
  const docsTarget = path.join(parentSymlinkRoot, 'paper-core', 'docs-target');
  fs.renameSync(docsPath, docsTarget);
  fs.symlinkSync(docsTarget, docsPath);
  assert.throws(() => inspectWorkspaceReleaseState({ workspaceRoot: parentSymlinkRoot }),
    /release_state_document_symlink_forbidden/u);
});
