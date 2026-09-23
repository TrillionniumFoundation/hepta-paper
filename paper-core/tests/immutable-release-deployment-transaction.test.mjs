import assert from 'node:assert/strict';
import test from 'node:test';

import { ImmutableReleaseDeploymentTransaction } from '../../paper-application/orchestration/immutable-release-deployment-transaction.mjs';
import {
  assertImmutableReleaseHostSnapshot,
  immutableReleaseDeploymentReceipt,
  buildImmutableReleaseDeploymentPlan,
  assertImmutableReleaseDeploymentPlan,
  assertImmutableReleaseDeploymentInspection,
  IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
  IMMUTABLE_RELEASE_DEPLOYMENT_STAGES,
  IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS,
  IMMUTABLE_RELEASE_LIVE_ROOT,
  IMMUTABLE_RELEASE_MOUNT_UNIT,
  IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const COMMIT = 'a'.repeat(40);
const PREDECESSOR_COMMIT = 'b'.repeat(40);
const H = (value) => hashRecord('ImmutableReleaseDeploymentTest', value);

function inspection(overrides = {}) {
  const releaseStateSnapshotPayload = {
    version: 2,
    kind: 'WorkspaceReleaseStateSnapshot',
    status: 'workspace_release_state_release_ready',
    headCommit: COMMIT,
    headTags: ['candidate-anchor'],
    allTags: ['candidate-anchor'],
    documentHashes: {
      packageJson: { path: 'package.json', sha256: H('document:packageJson') },
      packageLock: { path: 'package-lock.json', sha256: H('document:packageLock') },
      currentStatus: {
        path: 'paper-core/docs/CURRENT_STATUS.md', sha256: H('document:currentStatus'),
      },
      releaseDocument: { path: 'RELEASE.md', sha256: H('document:releaseDocument') },
      changelog: { path: 'CHANGELOG.md', sha256: H('document:changelog') },
    },
    releaseState: {
      version: '0.21.0',
      kind: 'ReleaseStateConsistency',
      contractVersion: 2,
      documentationProfile: 'finalized',
      state: 'release_ready',
      ok: true,
      errors: [],
    },
  };
  const base = {
    version: 1,
    codeProvenance: {
      version: 2,
      kind: 'CodeProvenance',
      packageVersion: '0.21.0',
      commit: COMMIT,
      commitTree: 'c'.repeat(40),
      tags: ['candidate-anchor'],
      treeDirty: false,
      indexStateHash: H('index'),
      repositoryEntryCount: 100,
      repositoryContentHash: H('content'),
      worktreeStateHash: H('worktree'),
      evidenceEnvironment: 'verification',
      evidenceClass: 'technical_conformance',
    },
    releaseStateSnapshot: {
      ...releaseStateSnapshotPayload,
      workspaceReleaseStateSnapshotHash:
        hashBytes(JSON.stringify(releaseStateSnapshotPayload)),
    },
    deploymentLock: {
      path: IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
      identityHash: H('deployment-lock'),
    },
    predecessorClosureHash: H('predecessor-closure'),
    mount: {
      liveRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
      unit: IMMUTABLE_RELEASE_MOUNT_UNIT,
      releasePath: `/opt/hepta-paper-releases/${PREDECESSOR_COMMIT}`,
      sourceCommit: PREDECESSOR_COMMIT,
      identityHash: H('mount'),
    },
    configIdentityHash: H('config'),
    recoveryGateIdentityHash: IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH,
    units: IMMUTABLE_RELEASE_CONSUMER_UNITS.map((name) => ({
      name,
      activeState: name.endsWith('.timer') || name.endsWith('.path') ? 'active' : 'inactive',
      enablement: name.endsWith('.timer') || name.endsWith('.path') ? 'enabled' : 'disabled',
    })),
    installedArtifacts: IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS.map((artifact) => ({
      path: artifact,
      present: true,
      identityHash: H(`artifact:${artifact}`),
    })),
  };
  return { ...base, ...overrides };
}

function hostSnapshot(plan) {
  const payload = {
    version: 1,
    kind: 'ImmutableReleaseHostSnapshot',
    status: 'immutable_release_host_snapshot_captured',
    configIdentityHash: plan.configIdentityHash,
    mountIdentityHash: plan.predecessor.mountIdentityHash,
    recoveryGateIdentityHash: plan.recoveryGateIdentityHash,
    unitStates: plan.unitStates,
    artifactBackups: plan.installedArtifacts.map((artifact) => ({
      path: artifact,
      present: true,
      contentBase64: Buffer.from(`old:${artifact}`).toString('base64'),
      contentHash: hashBytes(Buffer.from(`old:${artifact}`)),
      uid: 0,
      gid: 0,
      mode: 0o644,
    })),
  };
  return Object.freeze({
    ...payload,
    hostSnapshotHash: hashRecord('ImmutableReleaseHostSnapshot', payload),
  });
}

function fakePort({
  failRollback = false,
  malformedSnapshot = false,
  partialMaterializeFailure = false,
  partialPublishFailure = false,
  partialCutoverFailure = false,
  partialInstallFailure = false,
  partialUnitRestoreFailure = false,
} = {}) {
  const calls = [];
  const state = {
    locked: false,
    mount: 'old',
    artifacts: 'old',
    units: 'original',
    config: 'original',
    cleanupCalls: 0,
    cleanupOptions: null,
  };
  const record = (name, operation = () => undefined) => async (options = {}) => {
    calls.push(name);
    return operation(options);
  };
  const port = {
    inspectDeployment: record('inspectDeployment', () => inspection()),
    recoverUnfinishedDeployment: record('recoverUnfinishedDeployment', () => ({
      status: 'immutable_release_deployment_recovery_not_required',
    })),
    beginDeploymentIntent: record('beginDeploymentIntent', ({ plan }) => ({
      phase: 'prepared', planHash: plan.planHash, intentHash: H('intent:prepared'),
    })),
    recordDeploymentIntentPhase: record('recordDeploymentIntentPhase', ({ intent, phase }) => ({
      ...intent, phase, intentHash: H(`intent:${phase}`),
    })),
    completeDeploymentIntent: record('completeDeploymentIntent', () => true),
    acquireExclusiveDeploymentLock: record('acquireExclusiveDeploymentLock', () => {
      state.locked = true;
      return {
        release: async () => {
          calls.push('releaseLock');
          state.locked = false;
        },
      };
    }),
    assertLockHeld: record('assertLockHeld', () => {
      assert.equal(state.locked, true);
    }),
    materializeCandidate: record('materializeCandidate', () => {
      if (partialMaterializeFailure) throw new Error('partial_materialize_failure');
      return {
        status: 'immutable_release_candidate_materialized',
        stagingPath: '/opt/hepta-paper-releases/.staging-test',
      };
    }),
    generateAndVerifyClosure: record('generateAndVerifyClosure', ({
      inheritedFromClosureHash,
    }) => ({
      status: 'immutable_release_deployment_closure_verified',
      closureHash: H('new-closure'),
      inheritedFromClosureHash,
    })),
    sealAndPublishCandidate: record('sealAndPublishCandidate', ({ plan }) => {
      if (partialPublishFailure) throw new Error('partial_publish_failure');
      return {
        status: 'immutable_release_candidate_published',
        releasePath: plan.target.releasePath,
        publicationIdentityHash: H('publication'),
      };
    }),
    captureHostSnapshot: record('captureHostSnapshot', ({ plan }) => {
      const snapshot = hostSnapshot(plan);
      if (!malformedSnapshot) return snapshot;
      const { hostSnapshotHash, ...payload } = snapshot;
      const malformedPayload = { ...payload, artifactBackups: [] };
      return {
        ...malformedPayload,
        hostSnapshotHash: hashRecord('ImmutableReleaseHostSnapshot', malformedPayload),
      };
    }),
    quiesceConsumers: record('quiesceConsumers', () => {
      state.units = 'stopped';
    }),
    assertReleaseUnreferenced: record('assertReleaseUnreferenced', () => ({
      status: 'immutable_release_release_unreferenced',
    })),
    cutoverMount: record('cutoverMount', () => {
      state.mount = 'new';
      if (partialCutoverFailure) throw new Error('partial_cutover_failure');
    }),
    installHostArtifacts: record('installHostArtifacts', () => {
      state.artifacts = 'new';
      if (partialInstallFailure) throw new Error('partial_install_failure');
      return { installedArtifactIdentityHash: H('target-installed-artifacts') };
    }),
    postverifyRelease: record('postverifyRelease', () => ({
      status: 'immutable_release_deployment_postverified',
      postverificationHash: H('postverify'),
    })),
    restoreUnitStates: record('restoreUnitStates', ({ phase }) => {
      state.units = phase === 'commit' ? 'original-on-new-release' : 'original';
      if (phase === 'commit' && partialUnitRestoreFailure) {
        throw new Error('partial_unit_restore_failure');
      }
    }),
    verifyPostconditions: record('verifyPostconditions', ({ plan }) => ({
      status: 'immutable_release_deployment_postconditions_verified',
      configIdentityHash: plan.configIdentityHash,
    })),
    rollbackHostArtifacts: record('rollbackHostArtifacts', () => {
      state.artifacts = 'old';
    }),
    rollbackMount: record('rollbackMount', () => {
      state.mount = 'old';
    }),
    verifyRollback: record('verifyRollback', ({ plan }) => {
      if (failRollback) throw new Error('injected_rollback_failure');
      assert.equal(state.mount, 'old');
      assert.equal(state.artifacts, 'old');
      assert.equal(state.units, 'original');
      assert.equal(state.config, 'original');
      return {
        status: 'immutable_release_deployment_rollback_verified',
        configIdentityHash: plan.configIdentityHash,
      };
    }),
    cleanupCandidate: record('cleanupCandidate', (options) => {
      state.cleanupCalls += 1;
      state.cleanupOptions = options;
    }),
  };
  return { port, calls, state };
}

test('deployment plan is deterministic, commit-bound, tag-neutral, and mutation-free', async () => {
  const fake = fakePort();
  const transaction = new ImmutableReleaseDeploymentTransaction({ port: fake.port });
  const first = await transaction.plan();
  const second = await transaction.plan();
  assert.deepEqual(first, second);
  assert.equal(first.plan.commit, COMMIT);
  assert.equal(first.plan.target.releasePath, `/opt/hepta-paper-releases/${COMMIT}`);
  assert.equal(first.receipt.status, 'immutable_release_deployment_planned');
  assert.deepEqual(fake.calls, ['inspectDeployment', 'inspectDeployment']);

  const tagged = inspection();
  tagged.releaseStateSnapshot.allTags = ['candidate-anchor', 'v0.21.0'];
  assert.throws(() => buildImmutableReleaseDeploymentPlan({ inspection: tagged }),
    /immutable_release_deployment_release_ready_required/u);
  const dirty = inspection();
  dirty.codeProvenance = { ...dirty.codeProvenance, treeDirty: true };
  assert.throws(() => buildImmutableReleaseDeploymentPlan({ inspection: dirty }),
    /immutable_release_deployment_inspection_invalid/u);
});

test('plans pin the release store and reject predecessor-target identity', () => {
  assert.throws(() => buildImmutableReleaseDeploymentPlan({
    inspection: inspection(),
    releaseStoreRoot: '/srv/attacker-releases',
  }), /immutable_release_deployment_root_invalid/u);
  const sameCommit = inspection({
    mount: {
      ...inspection().mount,
      releasePath: `/opt/hepta-paper-releases/${COMMIT}`,
      sourceCommit: COMMIT,
    },
  });
  assert.throws(() => buildImmutableReleaseDeploymentPlan({ inspection: sameCommit }),
    /immutable_release_deployment_inspection_invalid/u);
});

test('host snapshot binds each base64 payload to its declared byte hash', () => {
  const plan = buildImmutableReleaseDeploymentPlan({ inspection: inspection() });
  const snapshot = hostSnapshot(plan);
  const payload = {
    ...snapshot,
    artifactBackups: snapshot.artifactBackups.map((backup, index) => index === 0
      ? { ...backup, contentBase64: Buffer.from('tampered').toString('base64') }
      : backup),
  };
  delete payload.hostSnapshotHash;
  const tampered = {
    ...payload,
    hostSnapshotHash: hashRecord('ImmutableReleaseHostSnapshot', payload),
  };
  assert.throws(() => assertImmutableReleaseHostSnapshot(tampered, { plan }),
    /immutable_release_deployment_host_snapshot_invalid/u);
});

test('deployment contract rejects malformed boundary shapes without widening authority', () => {
  const plan = buildImmutableReleaseDeploymentPlan({ inspection: inspection() });

  // Exercise the plan verifier's ordered, fail-closed checks individually.
  // Each candidate is rehashed so the selected field—not the outer hash—is
  // the reason for rejection.
  const rehashPlan = (mutate) => {
    const { planHash: _discarded, ...payload } = structuredClone(plan);
    mutate(payload);
    return {
      ...payload,
      planHash: hashRecord('ImmutableReleaseDeploymentPlan', payload),
    };
  };
  const malformedPlans = [
    ['missing plan', null],
    ['invalid plan hash', { ...plan, planHash: 'invalid' }],
    ['wrong version', rehashPlan((value) => { value.version = 2; })],
    ['wrong kind', rehashPlan((value) => { value.kind = 'WrongPlan'; })],
    ['wrong strategy', rehashPlan((value) => { value.strategy = 'mutable'; })],
    ['invalid commit', rehashPlan((value) => { value.commit = 'invalid'; })],
    ['invalid commit tree', rehashPlan((value) => { value.commitTree = 'invalid'; })],
    ['invalid code provenance', rehashPlan((value) => {
      value.codeProvenance = { ...value.codeProvenance, treeDirty: true };
    })],
    ['provenance commit mismatch', rehashPlan((value) => {
      value.codeProvenance = { ...value.codeProvenance, commit: PREDECESSOR_COMMIT };
    })],
    ['provenance tree mismatch', rehashPlan((value) => {
      value.codeProvenance = { ...value.codeProvenance, commitTree: 'd'.repeat(40) };
    })],
    ['package version mismatch', rehashPlan((value) => { value.packageVersion = '9.9.9'; })],
    ['provenance hash mismatch', rehashPlan((value) => {
      value.codeProvenanceHash = H('wrong-provenance');
    })],
    ['release snapshot hash mismatch', rehashPlan((value) => {
      value.releaseStateSnapshotHash = H('wrong-release-snapshot');
    })],
    ['release head commit mismatch', rehashPlan((value) => {
      value.releaseStateSnapshot = {
        ...value.releaseStateSnapshot,
        headCommit: PREDECESSOR_COMMIT,
      };
    })],
    ['release version mismatch', rehashPlan((value) => {
      value.releaseStateSnapshot = {
        ...value.releaseStateSnapshot,
        releaseState: { ...value.releaseStateSnapshot.releaseState, version: '9.9.9' },
      };
    })],
    ['release snapshot hash format', rehashPlan((value) => {
      value.releaseStateSnapshotHash = 'invalid';
    })],
    ['deployment lock shape', rehashPlan((value) => {
      value.deploymentLock = { path: IMMUTABLE_RELEASE_DEPLOYMENT_LOCK };
    })],
    ['deployment lock path', rehashPlan((value) => {
      value.deploymentLock = {
        ...value.deploymentLock,
        path: '/tmp/attacker.lock',
      };
    })],
  ];
  for (const [name, candidate] of malformedPlans) {
    assert.throws(
      () => assertImmutableReleaseDeploymentPlan(candidate),
      /immutable_release_deployment_plan_invalid/u,
      name,
    );
  }

  // `childPath` is reached only after the parent root has passed its canonical
  // check.  A coercible, non-string commit therefore exercises the final
  // child-component guard without weakening the commit regex in the
  // inspection contract.
  const coercibleCommit = {
    toString: () => COMMIT,
    valueOf: () => COMMIT,
  };
  const malformedInspection = inspection();
  malformedInspection.codeProvenance = {
    ...malformedInspection.codeProvenance,
    commit: coercibleCommit,
  };
  const malformedSnapshotPayload = {
    ...malformedInspection.releaseStateSnapshot,
    headCommit: coercibleCommit,
  };
  delete malformedSnapshotPayload.workspaceReleaseStateSnapshotHash;
  malformedInspection.releaseStateSnapshot = {
    ...malformedSnapshotPayload,
    workspaceReleaseStateSnapshotHash: hashBytes(JSON.stringify(malformedSnapshotPayload)),
  };
  assert.throws(
    () => buildImmutableReleaseDeploymentPlan({ inspection: malformedInspection }),
    /immutable_release_deployment_root_invalid/u,
  );

  // A not-found unit is valid only for the explicitly allowlisted predecessor
  // unit, and it must be inactive.  Both the accepted and rejected shapes are
  // checked here because this is a host-state trust boundary.
  const baseUnitSnapshot = hostSnapshot(plan);
  const absentUnitSnapshot = {
    ...baseUnitSnapshot,
    unitStates: baseUnitSnapshot.unitStates.map((unit) => (
    unit.name === 'strict-full-auto-runtime-adoption.service'
      ? { ...unit, activeState: 'inactive', enablement: 'not-found' }
      : unit
    )),
  };
  absentUnitSnapshot.hostSnapshotHash = hashRecord(
    'ImmutableReleaseHostSnapshot',
    Object.fromEntries(Object.entries(absentUnitSnapshot)
      .filter(([key]) => key !== 'hostSnapshotHash')),
  );
  assert.doesNotThrow(() => assertImmutableReleaseHostSnapshot(absentUnitSnapshot));
  const unsafeAbsentUnitSnapshot = {
    ...absentUnitSnapshot,
    unitStates: absentUnitSnapshot.unitStates.map((unit) => (
      unit.name === 'strict-full-auto-runtime-adoption.service'
        ? { ...unit, activeState: 'active' }
        : unit
    )),
  };
  unsafeAbsentUnitSnapshot.hostSnapshotHash = hashRecord(
    'ImmutableReleaseHostSnapshot',
    Object.fromEntries(Object.entries(unsafeAbsentUnitSnapshot)
      .filter(([key]) => key !== 'hostSnapshotHash')),
  );
  assert.throws(
    () => assertImmutableReleaseHostSnapshot(unsafeAbsentUnitSnapshot),
    /immutable_release_deployment_host_snapshot_invalid/u,
  );

  // A missing artifact is represented by the complete null tuple.  A present
  // artifact still needs a canonical base64 payload, hash, and metadata.
  const baseAbsentArtifactSnapshot = hostSnapshot(plan);
  const absentArtifactBackups = [...baseAbsentArtifactSnapshot.artifactBackups];
  absentArtifactBackups[0] = {
    ...absentArtifactBackups[0],
    present: false,
    contentBase64: null,
    contentHash: null,
    uid: null,
    gid: null,
    mode: null,
  };
  const absentArtifactSnapshot = {
    ...baseAbsentArtifactSnapshot,
    artifactBackups: absentArtifactBackups,
  };
  absentArtifactSnapshot.hostSnapshotHash = hashRecord(
    'ImmutableReleaseHostSnapshot',
    Object.fromEntries(Object.entries(absentArtifactSnapshot)
      .filter(([key]) => key !== 'hostSnapshotHash')),
  );
  assert.doesNotThrow(() => assertImmutableReleaseHostSnapshot(absentArtifactSnapshot, { plan }));

  const baseMalformedArtifactSnapshot = hostSnapshot(plan);
  const malformedArtifactBackups = [...baseMalformedArtifactSnapshot.artifactBackups];
  malformedArtifactBackups[0] = {
    ...malformedArtifactBackups[0],
    contentHash: 'not-a-sha256',
  };
  const malformedArtifactSnapshot = {
    ...baseMalformedArtifactSnapshot,
    artifactBackups: malformedArtifactBackups,
  };
  malformedArtifactSnapshot.hostSnapshotHash = hashRecord(
    'ImmutableReleaseHostSnapshot',
    Object.fromEntries(Object.entries(malformedArtifactSnapshot)
      .filter(([key]) => key !== 'hostSnapshotHash')),
  );
  assert.throws(
    () => assertImmutableReleaseHostSnapshot(malformedArtifactSnapshot, { plan }),
    /immutable_release_deployment_host_snapshot_invalid/u,
  );

  // JSON serialization itself is part of the bounded host-snapshot input.
  const cyclicSnapshot = { ...hostSnapshot(plan) };
  cyclicSnapshot.cycle = cyclicSnapshot;
  assert.throws(
    () => assertImmutableReleaseHostSnapshot(cyclicSnapshot, { plan }),
    /immutable_release_deployment_host_snapshot_invalid/u,
  );

  // A self-consistent snapshot must still match the inspected plan identities.
  const planMismatchSnapshot = {
    ...hostSnapshot(plan),
  };
  planMismatchSnapshot.configIdentityHash = H('different-config');
  planMismatchSnapshot.hostSnapshotHash = hashRecord(
    'ImmutableReleaseHostSnapshot',
    Object.fromEntries(Object.entries(planMismatchSnapshot)
      .filter(([key]) => key !== 'hostSnapshotHash')),
  );
  assert.throws(
    () => assertImmutableReleaseHostSnapshot(planMismatchSnapshot, { plan }),
    /immutable_release_deployment_host_snapshot_invalid/u,
  );

  assert.throws(
    () => immutableReleaseDeploymentReceipt({
      plan,
      status: 'not-a-deployment-status',
      completedStages: [],
    }),
    /immutable_release_deployment_receipt_invalid/u,
  );

  // Keep the inspection assertion itself exercised with a malformed release
  // state, rather than relying only on plan construction's wrapper.
  const badInspection = inspection({
    releaseStateSnapshot: {
      ...inspection().releaseStateSnapshot,
      status: 'workspace_release_state_development',
    },
  });
  assert.throws(
    () => assertImmutableReleaseDeploymentInspection(badInspection),
    /immutable_release_deployment_release_ready_required/u,
  );
});

test('execute requires the reviewed plan hash and holds one exclusive lock through verify', async () => {
  const fake = fakePort();
  const transaction = new ImmutableReleaseDeploymentTransaction({ port: fake.port });
  const { plan } = await transaction.plan();
  await assert.rejects(
    transaction.execute({ plan, expectedPlanHash: H('wrong') }),
    /immutable_release_deployment_plan_hash_confirmation_required/u,
  );
  const receipt = await transaction.execute({ plan, expectedPlanHash: plan.planHash });
  assert.equal(receipt.status, 'immutable_release_deployment_completed');
  assert.deepEqual(receipt.completedStages, IMMUTABLE_RELEASE_DEPLOYMENT_STAGES);
  assert.equal(receipt.closureHash, H('new-closure'));
  assert.equal(fake.state.locked, false);
  assert.equal(fake.state.mount, 'new');
  assert.equal(fake.state.artifacts, 'new');
  assert.equal(fake.state.units, 'original-on-new-release');
  assert.ok(fake.calls.indexOf('assertReleaseUnreferenced')
    < fake.calls.indexOf('cutoverMount'));
  assert.ok(fake.calls.lastIndexOf('assertLockHeld') < fake.calls.indexOf('releaseLock'));
});

test('a rehashed plan with a forged deployment lock path is rejected before any port call', async () => {
  const valid = buildImmutableReleaseDeploymentPlan({ inspection: inspection() });
  const { planHash, ...payload } = valid;
  const forgedPayload = {
    ...payload,
    deploymentLock: { ...payload.deploymentLock, path: '/tmp/attacker.lock' },
  };
  const forged = {
    ...forgedPayload,
    planHash: hashRecord('ImmutableReleaseDeploymentPlan', forgedPayload),
  };
  const fake = fakePort();
  const transaction = new ImmutableReleaseDeploymentTransaction({ port: fake.port });
  await assert.rejects(
    transaction.execute({ plan: forged, expectedPlanHash: forged.planHash }),
    /immutable_release_deployment_plan_invalid/u,
  );
  assert.deepEqual(fake.calls, []);
});

test('a hash-consistent malformed host snapshot never authorizes host rollback mutation', async () => {
  const fake = fakePort({ malformedSnapshot: true });
  const transaction = new ImmutableReleaseDeploymentTransaction({ port: fake.port });
  const { plan } = await transaction.plan();
  await assert.rejects(
    transaction.execute({ plan, expectedPlanHash: plan.planHash }),
    /immutable_release_deployment_failed_rolled_back/u,
  );
  assert.equal(fake.calls.includes('quiesceConsumers'), false);
  assert.equal(fake.calls.includes('rollbackHostArtifacts'), false);
  assert.equal(fake.calls.includes('rollbackMount'), false);
  assert.equal(fake.calls.includes('restoreUnitStates'), false);
  assert.equal(fake.state.cleanupCalls, 1);
});

test('partial materialize and publish failures retain plan-bound cleanup authority', async (t) => {
  for (const option of ['partialMaterializeFailure', 'partialPublishFailure']) {
    await t.test(option, async () => {
      const fake = fakePort({ [option]: true });
      const transaction = new ImmutableReleaseDeploymentTransaction({ port: fake.port });
      const { plan } = await transaction.plan();
      await assert.rejects(
        transaction.execute({ plan, expectedPlanHash: plan.planHash }),
        /immutable_release_deployment_failed_rolled_back/u,
      );
      assert.equal(fake.state.cleanupCalls, 1);
      assert.equal(fake.state.cleanupOptions.plan.planHash, plan.planHash);
      assert.equal(fake.state.cleanupOptions.materializeAttempted, true);
      assert.equal(fake.state.cleanupOptions.publishAttempted,
        option === 'partialPublishFailure');
      assert.equal(fake.calls.includes('rollbackMount'), false);
      assert.equal(fake.calls.includes('rollbackHostArtifacts'), false);
    });
  }
});

test('every failpoint after host snapshot restores mount, artifacts, units, and config', async (t) => {
  for (const injectedStage of IMMUTABLE_RELEASE_DEPLOYMENT_STAGES) {
    await t.test(injectedStage, async () => {
      const fake = fakePort();
      const transaction = new ImmutableReleaseDeploymentTransaction({
        port: fake.port,
        failpoint({ stage }) {
          if (stage === injectedStage) throw new Error(`failpoint:${stage}`);
        },
      });
      const { plan } = await transaction.plan();
      let failure;
      try {
        await transaction.execute({ plan, expectedPlanHash: plan.planHash });
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.code, 'immutable_release_deployment_failed_rolled_back');
      assert.equal(failure.receipt.blocker, `failpoint:${injectedStage}`);
      assert.equal(failure.receipt.completedStages.at(-1), injectedStage);
      assert.equal(fake.state.locked, false);
      assert.equal(fake.state.config, 'original');
      if (IMMUTABLE_RELEASE_DEPLOYMENT_STAGES.indexOf(injectedStage)
        >= IMMUTABLE_RELEASE_DEPLOYMENT_STAGES.indexOf('host_snapshot_captured')) {
        assert.equal(fake.state.mount, 'old');
        assert.equal(fake.state.artifacts, 'old');
        assert.equal(fake.state.units, 'original');
        assert.equal(failure.receipt.rollback.status,
          'immutable_release_deployment_rollback_verified');
      }
    });
  }
});

test('rollback failure is explicit and never reported as a successful rollback', async () => {
  const fake = fakePort({ failRollback: true });
  const transaction = new ImmutableReleaseDeploymentTransaction({
    port: fake.port,
    failpoint({ stage }) {
      if (stage === 'postverify_completed') throw new Error('fail-after-postverify');
    },
  });
  const { plan } = await transaction.plan();
  await assert.rejects(
    transaction.execute({ plan, expectedPlanHash: plan.planHash }),
    (error) => {
      assert.equal(error.code, 'immutable_release_deployment_failed_rollback_incomplete');
      assert.equal(error.receipt.status, 'immutable_release_deployment_rollback_incomplete');
      assert.equal(error.receipt.rollback.status,
        'immutable_release_deployment_rollback_incomplete');
      return true;
    },
  );
});

test('partial cutover, install, and unit-restore throws still force the full rollback', async (t) => {
  for (const option of [
    'partialCutoverFailure',
    'partialInstallFailure',
    'partialUnitRestoreFailure',
  ]) {
    await t.test(option, async () => {
      const fake = fakePort({ [option]: true });
      const transaction = new ImmutableReleaseDeploymentTransaction({ port: fake.port });
      const { plan } = await transaction.plan();
      await assert.rejects(
        transaction.execute({ plan, expectedPlanHash: plan.planHash }),
        (error) => {
          assert.equal(error.code, 'immutable_release_deployment_failed_rolled_back');
          return true;
        },
      );
      assert.equal(fake.state.mount, 'old');
      assert.equal(fake.state.artifacts, 'old');
      assert.equal(fake.state.units, 'original');
      const rollbackQuiesce = fake.calls.lastIndexOf('quiesceConsumers');
      const rollbackReferenceScan = fake.calls.lastIndexOf('assertReleaseUnreferenced');
      assert.ok(rollbackQuiesce < rollbackReferenceScan);
      assert.ok(rollbackReferenceScan < fake.calls.lastIndexOf('rollbackHostArtifacts'));
      assert.ok(rollbackReferenceScan < fake.calls.lastIndexOf('rollbackMount'));
    });
  }
});

test('post-restore failure re-quiesces consumers before mount or artifact rollback', async () => {
  const fake = fakePort();
  const transaction = new ImmutableReleaseDeploymentTransaction({
    port: fake.port,
    failpoint({ stage }) {
      if (stage === 'postconditions_verified') throw new Error('postcondition-failpoint');
    },
  });
  const { plan } = await transaction.plan();
  await assert.rejects(
    transaction.execute({ plan, expectedPlanHash: plan.planHash }),
    /immutable_release_deployment_failed_rolled_back/u,
  );
  const commitRestore = fake.calls.indexOf('restoreUnitStates');
  const rollbackQuiesce = fake.calls.lastIndexOf('quiesceConsumers');
  const rollbackReferenceScan = fake.calls.lastIndexOf('assertReleaseUnreferenced');
  assert.ok(commitRestore < rollbackQuiesce);
  assert.ok(rollbackQuiesce < rollbackReferenceScan);
  assert.ok(rollbackReferenceScan < fake.calls.lastIndexOf('rollbackHostArtifacts'));
  assert.ok(rollbackReferenceScan < fake.calls.lastIndexOf('rollbackMount'));
});
