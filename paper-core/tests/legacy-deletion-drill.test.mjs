import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  attestLegacyDeletionDrill,
  captureLegacyDeletionDrillDependencies,
  classifyLegacyDeletionDrill,
  createLegacyDeletionDrillTemporaryDirectory,
  isExactLegacyDeletionDrillCommandResult,
  parseLegacyDeletionDrillArguments,
  runLegacyDeletionDrillCommand,
} from '../bin/legacy-deletion-drill.mjs';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const COMMIT = 'c'.repeat(40);

function temporaryRoot(t, prefix = 'hepta-deletion-drill-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function commandResult(overrides = {}) {
  return Object.freeze({
    version: 1,
    kind: 'LegacyDeletionDrillCommandResult',
    executable: process.execPath,
    args: Object.freeze(['fixture.mjs']),
    exitCode: 0,
    signal: null,
    errorCode: null,
    timedOut: false,
    stdoutHash: SHA_A,
    stderrHash: SHA_B,
    ...overrides,
  });
}

function passingClassification(overrides = {}) {
  return classifyLegacyDeletionDrill({
    checks: [commandResult()],
    policyChecks: [commandResult()],
    sqliteQuickCheck: 'ok',
    minimalDifferentialFixture: { status: 'legacy_differential_reference_verified' },
    archiveImmutable: true,
    ownerAccepted: 2,
    ownerAcceptanceRequired: 2,
    operationallyProven: 2,
    operationalProofRequired: 2,
    ...overrides,
  });
}

function fakeProvenance() {
  return Object.freeze({
    version: 2,
    kind: 'CodeProvenance',
    commit: COMMIT,
    commitTree: 'd'.repeat(40),
    indexStateHash: SHA_A,
    repositoryContentHash: SHA_B,
    worktreeStateHash: `sha256:${'e'.repeat(64)}`,
    repositoryEntryCount: 1,
    tags: Object.freeze([]),
    packageVersion: '1.0.0',
    evidenceEnvironment: 'administrative',
    evidenceClass: 'release_attestation',
    treeDirty: false,
  });
}

function dependencySnapshot(hash = SHA_A) {
  return Object.freeze({
    version: 1,
    kind: 'LegacyDeletionDrillDependencySnapshot',
    archive: Object.freeze({
      archivePath: '/fixture/archive.tar.gz',
      archiveHash: SHA_A,
      archiveDevice: '1',
      archiveInode: '2',
      archiveSize: 10,
      archiveMode: 0o400,
      archiveImmutable: true,
    }),
    matrixHash: SHA_B,
    ownerAccepted: 1,
    ownerAcceptanceRequired: 1,
    operationallyProven: 1,
    operationalProofRequired: 1,
    dependencySnapshotHash: hash,
  });
}

function fakeVerification(dependencies = dependencySnapshot()) {
  return Object.freeze({
    status: 'legacy_reference_restore_drill_verification_passed',
    technicalReleaseReady: true,
    physicalDeletionEligible: true,
    dependencySnapshotHash: dependencies.dependencySnapshotHash,
    archivePath: dependencies.archive.archivePath,
    archiveHash: dependencies.archive.archiveHash,
    checks: [commandResult()],
    policyChecks: [commandResult()],
    sqliteQuickCheck: 'ok',
    minimalDifferentialFixture: { status: 'legacy_differential_reference_verified' },
    archiveImmutable: true,
    ownerAccepted: 1,
    ownerAcceptanceRequired: 1,
    operationallyProven: 1,
    operationalProofRequired: 1,
    blockers: [],
    destructiveDeletionPerformed: false,
    liveLegacyRootPresent: true,
    restoredFromReferenceArchive: true,
  });
}

test('command results require the exact non-ambiguous execution contract', () => {
  assert.equal(isExactLegacyDeletionDrillCommandResult(commandResult()), true);
  assert.equal(isExactLegacyDeletionDrillCommandResult({
    ...commandResult(),
    stderr: 'unbound raw diagnostic',
  }), false);
  assert.equal(isExactLegacyDeletionDrillCommandResult(commandResult({ exitCode: undefined })), false);
  const failed = passingClassification({
    checks: [commandResult({ exitCode: null, errorCode: 'ETIMEDOUT', timedOut: true })],
  });
  assert.equal(failed.technicalReleaseReady, false);
  assert.deepEqual(failed.technicalBlockers, ['legacy_reference_differential_replay_failed']);
});

test('technical readiness and physical deletion authorization are independent', () => {
  const complete = passingClassification();
  assert.equal(complete.technicalReleaseReady, true);
  assert.equal(complete.physicalDeletionAuthorized, true);

  const missingAuthority = passingClassification({
    ownerAccepted: 0,
    ownerAcceptanceRequired: 0,
    operationallyProven: 0,
    operationalProofRequired: 0,
  });
  assert.equal(missingAuthority.technicalReleaseReady, true);
  assert.equal(missingAuthority.physicalDeletionAuthorized, false);
  assert.deepEqual(missingAuthority.authorizationBlockers, [
    'owner_acceptance_required_count_invalid',
    'operational_proof_required_count_invalid',
  ]);

  const policyFailure = passingClassification({
    policyChecks: [commandResult({ exitCode: 1 })],
  });
  assert.equal(policyFailure.technicalReleaseReady, false);
  assert.equal(policyFailure.physicalDeletionAuthorized, false);
  assert.deepEqual(policyFailure.technicalBlockers, ['legacy_matrix_policy_check_failed']);
});

test('archive dependency capture binds hash, inode, path and current immutable state', (t) => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'reference.tar.gz');
  fs.writeFileSync(archivePath, 'immutable archive fixture\n');
  const result = captureLegacyDeletionDrillDependencies({
    runtimeRoot: path.join(root, 'runtime'),
    archivePath,
    spawnSyncImpl(command, args) {
      assert.equal(command, 'lsattr');
      assert.deepEqual(args, ['-d', '--', archivePath]);
      return { status: 0, stdout: `----i----------------- ${archivePath}\n` };
    },
    buildMatrix() {
      return {
        version: 3,
        summary: {
          ownerAccepted: 2,
          entryCount: 2,
          operationallyProven: 1,
          operationallyNotProven: 1,
        },
        entries: [],
      };
    },
  });
  const stat = fs.statSync(archivePath);
  assert.equal(result.archive.archivePath, archivePath);
  assert.equal(result.archive.archiveDevice, String(stat.dev));
  assert.equal(result.archive.archiveInode, String(stat.ino));
  assert.equal(result.archive.archiveImmutable, true);
  assert.match(result.archive.archiveHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.dependencySnapshotHash, /^sha256:[a-f0-9]{64}$/u);
});

test('archive capture rejects symlinks, hardlinks and path substitution races', (t) => {
  const root = temporaryRoot(t);
  const source = path.join(root, 'source.tar.gz');
  const hardlink = path.join(root, 'hardlink.tar.gz');
  const symlink = path.join(root, 'symlink.tar.gz');
  fs.writeFileSync(source, 'source bytes\n');
  fs.linkSync(source, hardlink);
  fs.symlinkSync(source, symlink);
  const options = {
    runtimeRoot: root,
    spawnSyncImpl: () => ({ status: 0, stdout: '----i----------------- fixture\n' }),
    buildMatrix: () => ({
      summary: {
        ownerAccepted: 1,
        entryCount: 1,
        operationallyProven: 1,
        operationallyNotProven: 0,
      },
    }),
  };
  assert.throws(() => captureLegacyDeletionDrillDependencies({
    ...options,
    archivePath: hardlink,
  }), /legacy_immutable_snapshot_archive_unsafe/u);
  assert.throws(() => captureLegacyDeletionDrillDependencies({
    ...options,
    archivePath: symlink,
  }));

  fs.unlinkSync(hardlink);
  const saved = path.join(root, 'saved.tar.gz');
  assert.throws(() => captureLegacyDeletionDrillDependencies({
    ...options,
    archivePath: source,
    spawnSyncImpl() {
      fs.renameSync(source, saved);
      fs.writeFileSync(source, 'replacement bytes\n');
      return { status: 0, stdout: '----i----------------- fixture\n' };
    },
  }), /legacy_immutable_snapshot_archive_changed_during_inspection/u);
  assert.equal(fs.readFileSync(source, 'utf8'), 'replacement bytes\n');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'source bytes\n');
});

test('identity-bound cleanup never deletes a root replacement', (t) => {
  const parent = temporaryRoot(t, 'hepta-deletion-drill-cleanup-');
  const selected = createLegacyDeletionDrillTemporaryDirectory({ temporaryParent: parent });
  fs.writeFileSync(path.join(selected.root, 'owned'), 'owned bytes\n');
  assert.throws(() => selected.cleanup({
    faultInjector({ stage, tempRoot }) {
      if (stage !== 'after_temp_root_quarantined') return;
      fs.mkdirSync(tempRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(tempRoot, 'replacement'), 'must survive\n');
    },
  }), /immutable_release_workspace_source_reappeared_after_quarantine/u);
  assert.equal(fs.readFileSync(path.join(selected.root, 'replacement'), 'utf8'), 'must survive\n');
});

test('CLI help, invalid arguments and missing execute authority are zero-action', async () => {
  let verifyCalls = 0;
  let attestCalls = 0;
  const options = {
    verifyDrill: async () => { verifyCalls += 1; },
    attestDrill: async () => { attestCalls += 1; },
  };
  const help = await runLegacyDeletionDrillCommand({ argv: ['--help'], ...options });
  assert.match(help, /--attest --execute/u);
  await assert.rejects(
    runLegacyDeletionDrillCommand({ argv: ['--bogus'], ...options }),
  );
  await assert.rejects(
    runLegacyDeletionDrillCommand({
      argv: ['--attest'],
      environment: {},
      ...options,
    }),
    /legacy_deletion_drill_attestation_execute_required/u,
  );
  await assert.rejects(
    runLegacyDeletionDrillCommand({ argv: ['--execute'], ...options }),
    /legacy_deletion_drill_attest_required_for_execute/u,
  );
  await assert.rejects(runLegacyDeletionDrillCommand({
    argv: ['--attest'],
    environment: { HEPTA_PAPER_RUNTIME_ISOLATED: '1' },
    ...options,
  }), /legacy_deletion_drill_attestation_forbidden_in_isolated_runtime/u);
  assert.equal(verifyCalls, 0);
  assert.equal(attestCalls, 0);
  assert.deepEqual(parseLegacyDeletionDrillArguments([]), { mode: 'verify', execute: false });
});

test('CLI calls attestation only with explicit execute authority', async () => {
  let calls = 0;
  const receipt = { kind: 'LegacyPhysicalDeletionAndRestoreDrillReceipt', status: 'fixture' };
  const result = await runLegacyDeletionDrillCommand({
    argv: ['--attest', '--execute'],
    environment: {},
    verifyDrill: async () => assert.fail('verification facade must not be selected'),
    attestDrill: async () => {
      calls += 1;
      return { receipt };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result, receipt);
});

test('attestation rolls back publication when dependencies change after publication', async () => {
  const baseline = dependencySnapshot();
  const changed = dependencySnapshot(SHA_B);
  let captures = 0;
  let published = false;
  let rolledBack = false;
  const releaseState = {
    headCommit: COMMIT,
    workspaceReleaseStateSnapshotHash: SHA_A,
  };
  await assert.rejects(attestLegacyDeletionDrill({
    workspaceRoot: '/fixture/workspace',
    runtimeRoot: '/fixture/runtime',
    legacyRoot: '/fixture/legacy',
    archivePath: baseline.archive.archivePath,
    environment: {},
    now: new Date('2026-01-01T00:00:00.000Z'),
    captureReleaseState: () => releaseState,
    captureCodeProvenance: fakeProvenance,
    captureDependencies: () => {
      captures += 1;
      return captures === 5 ? changed : baseline;
    },
    verifyDrill: async () => fakeVerification(baseline),
    signPayload: () => ({ kind: 'fixture-signature' }),
    ensureOutputRoot: () => {},
    publishReceipt: (receiptPath) => {
      published = true;
      return { path: receiptPath, dev: '1', ino: '2' };
    },
    rollbackPublication: () => {
      rolledBack = true;
      return true;
    },
  }), /legacy_deletion_drill_inputs_changed_after_publication/u);
  assert.equal(published, true);
  assert.equal(rolledBack, true);
  assert.equal(captures, 5);
});
