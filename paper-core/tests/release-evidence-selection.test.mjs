import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { releaseAttestationCodeProvenance, retirementLifecycleStatus, selectCurrentReleaseVerificationReceipt } from '../bin/release-evidence-lib.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

test('code provenance binds both the commit tree and exact worktree state', (t) => {
  const releaseCommit = process.env.HEPTA_RELEASE_COMMIT;
  process.env.HEPTA_RELEASE_COMMIT = 'f'.repeat(40);
  t.after(() => {
    if (releaseCommit === undefined) delete process.env.HEPTA_RELEASE_COMMIT;
    else process.env.HEPTA_RELEASE_COMMIT = releaseCommit;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-code-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 1;\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'hepta-test@example.invalid');
  git(root, 'config', 'user.name', 'Hepta Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const clean = currentCodeProvenance({ workspaceRoot: root });
  assert.equal(clean.version, 2);
  assert.equal(clean.treeDirty, false);
  assert.equal(clean.commitTree, git(root, 'rev-parse', 'HEAD^{tree}'));
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 2;\n');
  const dirty = currentCodeProvenance({ workspaceRoot: root });
  assert.equal(dirty.commit, clean.commit);
  assert.equal(dirty.commitTree, clean.commitTree);
  assert.equal(dirty.treeDirty, true);
  assert.notEqual(dirty.worktreeStateHash, clean.worktreeStateHash);
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 3;\n');
  const dirtyAgain = currentCodeProvenance({ workspaceRoot: root });
  assert.notEqual(dirtyAgain.repositoryContentHash, dirty.repositoryContentHash);
  assert.notEqual(dirtyAgain.worktreeStateHash, dirty.worktreeStateHash);
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'first\n');
  const untracked = currentCodeProvenance({ workspaceRoot: root });
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'second\n');
  const changedUntracked = currentCodeProvenance({ workspaceRoot: root });
  assert.notEqual(changedUntracked.worktreeStateHash, untracked.worktreeStateHash);
});

test('release attestation is administrative evidence rather than production runtime evidence', () => {
  const provenance = releaseAttestationCodeProvenance({
    packageVersion: '0.20.2',
    commit: 'current-commit',
    treeDirty: false,
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
  });
  assert.equal(provenance.evidenceEnvironment, 'administrative');
  assert.equal(provenance.evidenceClass, 'release_attestation');
  assert.equal(provenance.commit, 'current-commit');
});

test('retirement lifecycle reports observed deletion instead of hard-coded non-deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retirement-lifecycle-'));
  fs.rmSync(root, { recursive: true, force: true });
  const status = retirementLifecycleStatus({
    legacyRoot: root,
    deletionDrill: { status: 'legacy_reference_restore_drill_passed_deletion_blocked', physicalDeletionAllowed: false },
    immutableReceipt: { status: 'legacy_reference_ext4_inode_immutable', immutableContentObjectClaimed: true },
  });
  assert.equal(status.liveLegacyRootPresent, false);
  assert.equal(status.physicalDeletionObserved, true);
  assert.equal(status.destructiveDeletionPerformed, true);
  assert.equal(status.deletionLifecycleStatus, 'legacy_root_deleted_under_prior_authorization_current_gate_blocked');
});

test('release evidence invalidates a stale pass when the latest exact-identity receipt is blocked', (t) => {
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-receipt-'));
  t.after(() => fs.rmSync(verificationRoot, { recursive: true, force: true }));
  const codeProvenance = { packageVersion: '0.15.0', commit: 'current-commit' };
  const write = (name, overrides = {}) => fs.writeFileSync(path.join(verificationRoot, name), JSON.stringify({
    version: 1,
    kind: 'IsolatedVerificationReceipt',
    status: 'isolated_verification_passed',
    mode: 'release',
    completedAt: '2026-07-11T00:00:00.000Z',
    codeProvenance: { ...codeProvenance, treeDirty: false },
    marker: name,
    ...overrides,
  }));
  write('zz-lexically-last-old-commit.json', { codeProvenance: { packageVersion: '0.15.0', commit: 'old-commit', treeDirty: false }, completedAt: '2026-07-11T23:59:00.000Z' });
  write('current-earlier.json', { completedAt: '2026-07-11T01:00:00.000Z' });
  write('current-latest.json', { completedAt: '2026-07-11T02:00:00.000Z' });
  write('current-blocked.json', { status: 'isolated_verification_blocked', completedAt: '2026-07-11T03:00:00.000Z' });
  fs.writeFileSync(path.join(verificationRoot, 'malformed.json'), '{');
  const selected = selectCurrentReleaseVerificationReceipt({ verificationRoot, codeProvenance });
  assert.equal(selected, null);
});

test('release evidence selection fails closed without an exact current receipt', (t) => {
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-receipt-empty-'));
  t.after(() => fs.rmSync(verificationRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(verificationRoot, 'old.json'), JSON.stringify({
    kind: 'IsolatedVerificationReceipt',
    status: 'isolated_verification_passed',
    mode: 'release',
    codeProvenance: { packageVersion: '0.14.0', commit: 'old-commit', treeDirty: false },
  }));
  assert.equal(selectCurrentReleaseVerificationReceipt({
    verificationRoot,
    codeProvenance: { packageVersion: '0.15.0', commit: 'current-commit' },
  }), null);
});

test('release evidence selection rejects a same-commit receipt from a different dirty worktree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-worktree-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = {
    version: 2,
    packageVersion: '0.15.0',
    commit: 'same-commit',
    commitTree: 'same-tree',
    indexStateHash: `sha256:${'1'.repeat(64)}`,
    repositoryContentHash: `sha256:${'2'.repeat(64)}`,
    worktreeStateHash: `sha256:${'3'.repeat(64)}`,
  };
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({
    kind: 'IsolatedVerificationReceipt',
    mode: 'release',
    status: 'isolated_verification_passed',
    completedAt: '2026-07-15T00:00:00.000Z',
    codeProvenance: {
      ...current,
      repositoryContentHash: `sha256:${'4'.repeat(64)}`,
      treeDirty: false,
    },
  }));
  assert.equal(selectCurrentReleaseVerificationReceipt({ verificationRoot: root, codeProvenance: current }), null);
});
