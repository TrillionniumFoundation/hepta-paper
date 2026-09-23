import {
  buildImmutableReleaseDeploymentPlan,
  IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
  IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS,
  IMMUTABLE_RELEASE_LIVE_ROOT,
  IMMUTABLE_RELEASE_MOUNT_UNIT,
  IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH,
} from '../../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';

export const IMMUTABLE_RELEASE_FIXTURE_COMMIT = 'a'.repeat(40);
export const IMMUTABLE_RELEASE_FIXTURE_PREDECESSOR_COMMIT = 'b'.repeat(40);
export const immutableReleaseFixtureHash = (value) =>
  hashRecord('ImmutableReleaseDeploymentFixture', value);

export function immutableReleaseDeploymentInspectionFixture(overrides = {}) {
  const H = immutableReleaseFixtureHash;
  const releaseStateSnapshotPayload = {
    version: 2,
    kind: 'WorkspaceReleaseStateSnapshot',
    status: 'workspace_release_state_release_ready',
    headCommit: IMMUTABLE_RELEASE_FIXTURE_COMMIT,
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
      commit: IMMUTABLE_RELEASE_FIXTURE_COMMIT,
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
      releasePath:
        `/opt/hepta-paper-releases/${IMMUTABLE_RELEASE_FIXTURE_PREDECESSOR_COMMIT}`,
      sourceCommit: IMMUTABLE_RELEASE_FIXTURE_PREDECESSOR_COMMIT,
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

export function immutableReleaseDeploymentPlanFixture() {
  return buildImmutableReleaseDeploymentPlan({
    inspection: immutableReleaseDeploymentInspectionFixture(),
  });
}

export function immutableReleaseHostSnapshotFixture(plan) {
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
