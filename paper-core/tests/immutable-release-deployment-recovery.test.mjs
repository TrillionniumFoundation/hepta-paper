import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  recoverImmutableReleaseDeploymentIntent,
} from '../../paper-application/orchestration/immutable-release-deployment-recovery.mjs';
import {
  createImmutableReleaseDeploymentIntentRepository,
  IMMUTABLE_RELEASE_DEPLOYMENT_PHASES,
} from '../../paper-adapters/runtime/immutable-release-deployment-intent-repository.mjs';
import {
  acquireExclusiveImmutableReleaseDeploymentLock,
  inspectImmutableReleaseDeploymentLock,
} from '../../paper-adapters/runtime/immutable-release-deployment-lock-repository.mjs';
import {
  buildImmutableReleaseDeploymentPlan,
  IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import {
  immutableReleaseDeploymentInspectionFixture,
  immutableReleaseDeploymentPlanFixture,
  immutableReleaseHostSnapshotFixture,
  immutableReleaseFixtureHash,
} from './support/immutable-release-deployment-fixture.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-recovery-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createImmutableReleaseDeploymentIntentRepository({
    root,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowUnpinnedRoot: true,
  });
  const plan = immutableReleaseDeploymentPlanFixture();
  return { repository, plan };
}

function advanceTo(repository, plan, targetPhase) {
  let intent = repository.begin({ plan });
  for (const phase of IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.slice(1)) {
    if (['rollback_attempted', 'rollback_verified'].includes(phase)) continue;
    const options = { expectedIntentHash: intent.intentHash, phase };
    if (phase === 'closure_verified') {
      options.progress = { closureHash: immutableReleaseFixtureHash('recovery-closure') };
    }
    if (phase === 'published') {
      options.progress = { publicationIdentityHash: immutableReleaseFixtureHash('publication') };
    }
    if (phase === 'snapshot_persisted') {
      options.hostSnapshot = immutableReleaseHostSnapshotFixture(plan);
    }
    if (phase === 'postverify_completed') {
      options.progress = { postverificationHash: immutableReleaseFixtureHash('postverify') };
    }
    if (phase === 'install_completed') {
      options.progress = {
        installedArtifactIdentityHash: immutableReleaseFixtureHash('installed-artifacts'),
      };
    }
    intent = repository.advance(options);
    if (phase === targetPhase) return intent;
  }
  throw new Error(`unknown recovery fixture phase: ${targetPhase}`);
}

function fakeOperations(repository, { failArtifactRestore = false } = {}) {
  const calls = [];
  let failRestore = failArtifactRestore;
  const record = (name, result) => async () => {
    calls.push(name);
    assert.ok(['rollback_attempted', 'rollback_verified', 'committed']
      .includes(repository.read()?.phase));
    if (name === 'rollbackHostArtifacts' && failRestore) {
      failRestore = false;
      throw new Error('injected_recovery_artifact_restore_failure');
    }
    return typeof result === 'function' ? result() : result;
  };
  return {
    calls,
    operations: {
      assertLockHeld: async () => true,
      quiesceConsumers: record('quiesceConsumers'),
      assertReleaseUnreferenced: record('assertReleaseUnreferenced', {
        status: 'immutable_release_release_unreferenced',
      }),
      rollbackHostArtifacts: record('rollbackHostArtifacts'),
      rollbackMount: record('rollbackMount'),
      restoreUnitStates: record('restoreUnitStates'),
      verifyRollback: record('verifyRollback', () => ({
        status: 'immutable_release_deployment_rollback_verified',
        configIdentityHash: repository.read().plan.configIdentityHash,
      })),
      verifyPostconditions: record('verifyPostconditions', () => ({
        status: 'immutable_release_deployment_postconditions_verified',
        configIdentityHash: repository.read().plan.configIdentityHash,
      })),
      cleanupCandidate: record('cleanupCandidate'),
    },
  };
}

async function recover(sample, operations) {
  return recoverImmutableReleaseDeploymentIntent({
    intentRepository: sample.repository,
    operations,
    lock: Object.freeze({ fixture: true }),
    expectedLockIdentityHash: sample.plan.deploymentLock.identityHash,
  });
}

test('pre-snapshot publish ambiguity is durably marked and removes staging/published target', async (t) => {
  const sample = fixture(t);
  advanceTo(sample.repository, sample.plan, 'publish_attempted');
  const fake = fakeOperations(sample.repository);
  const result = await recover(sample, fake.operations);
  assert.equal(result.disposition, 'rollback_verified');
  assert.deepEqual(fake.calls, ['assertReleaseUnreferenced', 'cleanupCandidate']);
  assert.equal(sample.repository.read(), null);
});

test('every ambiguous host attempted phase retries the complete idempotent restore', async (t) => {
  for (const phase of [
    'quiesce_attempted',
    'cutover_attempted',
    'install_attempted',
    'unit_restore_attempted',
  ]) {
    await t.test(phase, async (subtest) => {
      const sample = fixture(subtest);
      advanceTo(sample.repository, sample.plan, phase);
      const fake = fakeOperations(sample.repository);
      await recover(sample, fake.operations);
      assert.deepEqual(fake.calls, [
        'quiesceConsumers',
        'assertReleaseUnreferenced',
        'rollbackHostArtifacts',
        'rollbackMount',
        'restoreUnitStates',
        'verifyRollback',
        'cleanupCandidate',
      ]);
      assert.equal(sample.repository.read(), null);
    });
  }
});

test('a recovery crash leaves rollback_attempted durable and the next process retries', async (t) => {
  const sample = fixture(t);
  advanceTo(sample.repository, sample.plan, 'install_attempted');
  const fake = fakeOperations(sample.repository, { failArtifactRestore: true });
  await assert.rejects(recover(sample, fake.operations),
    /injected_recovery_artifact_restore_failure/u);
  assert.equal(sample.repository.read().phase, 'rollback_attempted');
  const completed = await recover(sample, fake.operations);
  assert.equal(completed.disposition, 'rollback_verified');
  assert.equal(sample.repository.read(), null);
  assert.equal(fake.calls.filter((call) => call === 'quiesceConsumers').length, 2);
});

test('attempted-phase recovery remains available after the candidate checkout is deleted', async (t) => {
  const sample = fixture(t);
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-deployment-candidate-'));
  fs.writeFileSync(path.join(candidate, 'marker'), 'candidate data only\n');
  advanceTo(sample.repository, sample.plan, 'cutover_attempted');
  fs.rmSync(candidate, { recursive: true, force: false });
  assert.equal(fs.existsSync(candidate), false);
  const fake = fakeOperations(sample.repository);
  const result = await recover(sample, fake.operations);
  assert.equal(result.disposition, 'rollback_verified');
  assert.equal(sample.repository.read(), null);
});

test('committed marker is verified and removed without rolling back the target', async (t) => {
  const sample = fixture(t);
  advanceTo(sample.repository, sample.plan, 'committed');
  const fake = fakeOperations(sample.repository);
  let restoreOptions;
  let verificationOptions;
  const restore = fake.operations.restoreUnitStates;
  const verify = fake.operations.verifyPostconditions;
  fake.operations.restoreUnitStates = async (options) => {
    restoreOptions = options;
    return restore(options);
  };
  fake.operations.verifyPostconditions = async (options) => {
    verificationOptions = options;
    return verify(options);
  };
  const result = await recover(sample, fake.operations);
  assert.equal(result.disposition, 'committed');
  assert.deepEqual(fake.calls, ['restoreUnitStates', 'verifyPostconditions']);
  assert.equal(restoreOptions.recovery, true);
  assert.equal(restoreOptions.phase, 'commit');
  assert.equal(verificationOptions.phase, 'recovery');
  assert.equal(verificationOptions.installedArtifactIdentityHash,
    immutableReleaseFixtureHash('installed-artifacts'));
  assert.equal(sample.repository.read(), null);
});

test('durable intent recovers after reboot recreates the volatile lock inode', async (t) => {
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-reboot-lock-'));
  fs.chmodSync(lockRoot, 0o711);
  t.after(() => fs.rmSync(lockRoot, { recursive: true, force: true }));
  const lockPath = path.join(lockRoot, 'deployment.lock');
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  const lockOptions = {
    lockPath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  };
  const beforeReboot = inspectImmutableReleaseDeploymentLock(lockOptions);
  const plan = buildImmutableReleaseDeploymentPlan({
    inspection: immutableReleaseDeploymentInspectionFixture({
      deploymentLock: {
        path: IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
        identityHash: beforeReboot.identityHash,
      },
    }),
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-reboot-intent-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createImmutableReleaseDeploymentIntentRepository({
    root,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowUnpinnedRoot: true,
  });
  repository.begin({ plan });

  fs.renameSync(lockPath, `${lockPath}.pre-reboot`);
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  const afterReboot = inspectImmutableReleaseDeploymentLock(lockOptions);
  assert.equal(afterReboot.identityHash, beforeReboot.identityHash);
  const lock = acquireExclusiveImmutableReleaseDeploymentLock({
    ...lockOptions,
    expectedIdentityHash: plan.deploymentLock.identityHash,
  });
  const fake = fakeOperations(repository);
  fake.operations.assertLockHeld = async ({ expectedIdentityHash }) => {
    assert.equal(expectedIdentityHash, plan.deploymentLock.identityHash);
    return lock.assertHeld();
  };
  try {
    const result = await recoverImmutableReleaseDeploymentIntent({
      intentRepository: repository,
      operations: fake.operations,
      lock,
      expectedLockIdentityHash: plan.deploymentLock.identityHash,
    });
    assert.equal(result.disposition, 'rollback_verified');
    assert.equal(repository.read(), null);
  } finally {
    lock.release();
  }
});
