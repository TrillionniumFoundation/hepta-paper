import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CODE_PROVENANCE_KEYS = Object.freeze([
  'commit', 'commitTree', 'evidenceClass', 'evidenceEnvironment', 'indexStateHash', 'kind',
  'packageVersion', 'repositoryContentHash', 'repositoryEntryCount', 'tags', 'treeDirty',
  'version', 'worktreeStateHash',
]);
const RELEASE_SNAPSHOT_KEYS = Object.freeze([
  'allTags', 'documentHashes', 'headCommit', 'headTags', 'kind', 'releaseState', 'status',
  'version', 'workspaceReleaseStateSnapshotHash',
]);
const RELEASE_STATE_KEYS = Object.freeze([
  'contractVersion', 'documentationProfile', 'errors', 'kind', 'ok', 'state', 'version',
]);
const RELEASE_DOCUMENT_KEYS = Object.freeze([
  'changelog', 'currentStatus', 'packageJson', 'packageLock', 'releaseDocument',
]);

export const IMMUTABLE_RELEASE_DEPLOYMENT_VERSION = 1;
export const IMMUTABLE_RELEASE_DEPLOYMENT_LOCK =
  '/run/hepta-paper-deployment/deployment.lock';
export const IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_ROOT =
  '/var/lib/hepta-paper-deployment';
export const IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const IMMUTABLE_RELEASE_LIVE_ROOT = '/opt/hepta-paper';
export const IMMUTABLE_RELEASE_STORE_ROOT = '/opt/hepta-paper-releases';
export const IMMUTABLE_RELEASE_MOUNT_UNIT = 'opt-hepta\\x2dpaper.mount';
export const IMMUTABLE_RELEASE_RECOVERY_UNIT =
  'hepta-immutable-release-recovery.service';

export const IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS = Object.freeze([
  Object.freeze({
    key: 'recoveryGate',
    installedPath: '/etc/systemd/system/hepta-immutable-release-recovery.service',
    installedMode: 0o644,
  }),
  Object.freeze({
    key: 'launcher',
    installedPath: '/usr/libexec/hepta-paper/hepta-immutable-release-deploy',
    installedMode: 0o755,
  }),
]);

// Deployment never grants mutation authority from values discovered on the
// host. Only stable states which this transaction knows how to reproduce are
// accepted into a reviewed plan or rollback snapshot.
export const IMMUTABLE_RELEASE_UNIT_ACTIVE_STATES = Object.freeze([
  'active',
  'inactive',
]);
export const IMMUTABLE_RELEASE_UNIT_ENABLEMENT_STATES = Object.freeze([
  'alias',
  'disabled',
  'enabled',
  'enabled-runtime',
  'generated',
  'indirect',
  'masked',
  'masked-runtime',
  'not-found',
  'static',
]);

// The current predecessor predates this exact reviewed unit. Its unit file has
// no [Install] section, so the no-systemctl installer must make the target
// state static/inactive while rollback must restore not-found/inactive.
export const IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT = Object.freeze({
  'strict-full-auto-runtime-adoption.service': 'static',
});

// Activators are stopped before services. The allowlist is deliberately exact:
// discovery alone cannot grant a deployment permission to a new host unit.
export const IMMUTABLE_RELEASE_ACTIVATOR_UNITS = Object.freeze([
  'autonomous-submission-handoff-layout-provision.path',
  'autonomous-research-state-backup-renew.timer',
  'strict-full-auto-acceptance.timer',
]);

export const IMMUTABLE_RELEASE_CONSUMER_SERVICE_UNITS = Object.freeze([
  'autonomous-research-state-backup-renew.service',
  'autonomous-research-supervisor.service',
  'autonomous-submission-dispatcher.service',
  'autonomous-submission-handoff-layout-provision.service',
  'hepta-paper-host-bootstrap.service',
  'hepta-paper-release-attestor-probe.service',
  'hepta-paper-release-attestor.service',
  'hepta-paper-state-authority.service',
  'strict-full-auto-runtime-adoption.service',
  'strict-full-auto-acceptance.service',
]);

export const IMMUTABLE_RELEASE_CONSUMER_UNITS = Object.freeze([
  ...IMMUTABLE_RELEASE_ACTIVATOR_UNITS,
  ...IMMUTABLE_RELEASE_CONSUMER_SERVICE_UNITS,
]);

export const IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH = hashRecord(
  'ImmutableReleaseDeploymentRecoveryGatePolicy',
  {
    version: 1,
    recoveryUnit: IMMUTABLE_RELEASE_RECOVERY_UNIT,
    consumerUnits: IMMUTABLE_RELEASE_CONSUMER_UNITS,
    requirements: Object.freeze({
      directRequires: true,
      directAfter: true,
      canonicalFragments: true,
      dropInsForbidden: true,
      daemonReloadCurrent: true,
    }),
  },
);

export const IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS = Object.freeze([
  '/etc/systemd/system/autonomous-research-state-backup-renew.service',
  '/etc/systemd/system/autonomous-research-state-backup-renew.timer',
  '/etc/systemd/system/autonomous-research-supervisor.service',
  '/etc/systemd/system/autonomous-submission-dispatcher.service',
  '/etc/systemd/system/autonomous-submission-handoff-layout-provision.path',
  '/etc/systemd/system/autonomous-submission-handoff-layout-provision.service',
  '/etc/systemd/system/hepta-immutable-release-recovery.service',
  '/etc/systemd/system/hepta-paper-host-bootstrap.service',
  '/etc/systemd/system/hepta-paper-release-attestor-probe.service',
  '/etc/systemd/system/hepta-paper-release-attestor.service',
  '/etc/systemd/system/hepta-paper-state-authority.service',
  '/etc/systemd/system/opt-hepta\\x2dpaper.mount',
  '/etc/systemd/system/strict-full-auto-acceptance.service',
  '/etc/systemd/system/strict-full-auto-acceptance.timer',
  '/etc/systemd/system/strict-full-auto-runtime-adoption.service',
  '/usr/lib/sysusers.d/hepta-paper.conf',
  '/usr/lib/tmpfiles.d/hepta-paper.conf',
  '/usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision',
  '/usr/libexec/hepta-paper/codex-openclaw-managed',
  '/usr/libexec/hepta-paper/hepta-immutable-release-deploy',
  '/usr/libexec/hepta-paper/hepta-package-recovery-readiness',
  '/usr/libexec/hepta-paper/hepta-paper-release-attestor-client',
  '/usr/libexec/hepta-paper/hepta-paper-release-env',
  '/usr/libexec/hepta-paper/hepta-paper-state-authority-client',
  '/usr/share/hepta-paper/deploy/autonomous-submission-handoff-layout-provision.build-receipt',
  '/usr/share/hepta-paper/deploy/autonomous-submission-handoff-layout-provision.c',
  '/usr/share/hepta-paper/deploy/hepta-paper-systemd-host.manifest.sha256',
  '/usr/share/hepta-paper/deploy/install-hepta-paper-systemd-host.sh',
  '/usr/share/hepta-paper/deploy/local-release-attestor-daemon.schema.json',
  '/usr/share/hepta-paper/deploy/local-release-attestor-probe.config.example.json',
  '/usr/share/hepta-paper/deploy/local-release-attestor-signer.config.example.json',
]);

export const IMMUTABLE_RELEASE_DEPLOYMENT_STAGES = Object.freeze([
  'lock_acquired',
  'preflight_reverified',
  'candidate_materialized',
  'closure_verified',
  'candidate_published',
  'host_snapshot_captured',
  'consumers_quiesced',
  'old_release_unreferenced',
  'mount_cutover',
  'host_artifacts_installed',
  'postverify_completed',
  'unit_states_restored',
  'postconditions_verified',
]);

function deploymentError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sortedUnique(values) {
  return Array.isArray(values)
    && values.every((value) => typeof value === 'string' && value.length > 0)
    && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort());
}

function immutableCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, immutableCopy(child)]),
    ));
  }
  return value;
}

function absoluteCanonical(candidate) {
  return typeof candidate === 'string' && candidate.startsWith('/')
    && candidate !== '/' && !candidate.endsWith('/') && !candidate.includes('//')
    && !candidate.split('/').some((segment) => segment === '.' || segment === '..');
}

function childPath(parent, child) {
  if (!absoluteCanonical(parent) || typeof child !== 'string' || !child
    || child.includes('/') || child === '.' || child === '..') {
    throw deploymentError('immutable_release_deployment_root_invalid');
  }
  return `${parent}/${child}`;
}

function parentPath(candidate) {
  const index = candidate.lastIndexOf('/');
  return index <= 0 ? '/' : candidate.slice(0, index);
}

function validateCodeIdentity(value) {
  return exactKeys(value, CODE_PROVENANCE_KEYS)
    && value?.version === 2 && value?.kind === 'CodeProvenance'
    && COMMIT.test(String(value.commit || ''))
    && COMMIT.test(String(value.commitTree || ''))
    && value.treeDirty === false
    && sortedUnique(value.tags)
    && SHA256.test(String(value.indexStateHash || ''))
    && SHA256.test(String(value.repositoryContentHash || ''))
    && SHA256.test(String(value.worktreeStateHash || ''))
    && typeof value.packageVersion === 'string' && value.packageVersion.length > 0
    && Number.isSafeInteger(value.repositoryEntryCount) && value.repositoryEntryCount > 0
    && typeof value.evidenceEnvironment === 'string' && value.evidenceEnvironment.length > 0
    && typeof value.evidenceClass === 'string' && value.evidenceClass.length > 0;
}

function validateReleaseState(value, code) {
  const version = String(value?.releaseState?.version || '');
  const releaseTag = `v${version}`;
  const snapshotPayload = value && typeof value === 'object' ? {
    version: value.version,
    kind: value.kind,
    status: value.status,
    headCommit: value.headCommit,
    headTags: value.headTags,
    allTags: value.allTags,
    documentHashes: value.documentHashes,
    releaseState: value.releaseState,
  } : null;
  if (!exactKeys(value, RELEASE_SNAPSHOT_KEYS)
    || value?.version !== 2 || value?.kind !== 'WorkspaceReleaseStateSnapshot'
    || value?.status !== 'workspace_release_state_release_ready'
    || value?.releaseState?.state !== 'release_ready'
    || value?.releaseState?.ok !== true
    || !COMMIT.test(String(value.headCommit || ''))
    || !sortedUnique(value.headTags) || !sortedUnique(value.allTags)
    || !SHA256.test(String(value.workspaceReleaseStateSnapshotHash || ''))
    || !exactKeys(value.releaseState, RELEASE_STATE_KEYS)
    || value.releaseState.contractVersion !== 2
    || value.releaseState.kind !== 'ReleaseStateConsistency'
    || value.releaseState.documentationProfile !== 'finalized'
    || !Array.isArray(value.releaseState.errors) || value.releaseState.errors.length !== 0
    || !exactKeys(value.documentHashes, RELEASE_DOCUMENT_KEYS)
    || !Object.values(value.documentHashes).every((document) => (
      exactKeys(document, ['path', 'sha256'])
      && typeof document.path === 'string' && document.path.length > 0
      && !document.path.startsWith('/') && !document.path.endsWith('/')
      && !document.path.includes('//')
      && !document.path.split('/').some((segment) => segment === '.' || segment === '..')
      && SHA256.test(String(document.sha256 || ''))
    ))
    || new Set(Object.values(value.documentHashes).map(({ path }) => path)).size
      !== RELEASE_DOCUMENT_KEYS.length
    || hashBytes(JSON.stringify(snapshotPayload))
      !== value.workspaceReleaseStateSnapshotHash
    || !version || value.headTags.includes(releaseTag) || value.allTags.includes(releaseTag)) {
    throw deploymentError(code);
  }
}

function validateUnitInspection(units) {
  if (!Array.isArray(units)
    || JSON.stringify(units.map(({ name }) => name))
      !== JSON.stringify(IMMUTABLE_RELEASE_CONSUMER_UNITS)) return false;
  return units.every((unit) => exactKeys(unit, ['activeState', 'enablement', 'name'])
    && IMMUTABLE_RELEASE_UNIT_ACTIVE_STATES.includes(unit.activeState)
    && IMMUTABLE_RELEASE_UNIT_ENABLEMENT_STATES.includes(unit.enablement)
    && (unit.enablement !== 'not-found' || (
      unit.activeState === 'inactive'
      && Object.hasOwn(IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT, unit.name)
    )));
}

function validArtifactBackup(backup) {
  if (!exactKeys(backup, [
    'contentBase64', 'contentHash', 'gid', 'mode', 'path', 'present', 'uid',
  ]) || typeof backup.present !== 'boolean') return false;
  if (!backup.present) {
    return backup.contentBase64 === null && backup.contentHash === null
      && backup.uid === null && backup.gid === null && backup.mode === null;
  }
  if (typeof backup.contentBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(backup.contentBase64)
    || !SHA256.test(String(backup.contentHash || ''))
    || !Number.isSafeInteger(backup.uid) || backup.uid < 0
    || !Number.isSafeInteger(backup.gid) || backup.gid < 0
    || !Number.isSafeInteger(backup.mode) || backup.mode < 0 || backup.mode > 0o7777) {
    return false;
  }
  const content = Buffer.from(backup.contentBase64, 'base64');
  return content.toString('base64') === backup.contentBase64
    && hashBytes(content) === backup.contentHash;
}

function validateArtifactBackups(backups) {
  if (!Array.isArray(backups)
    || JSON.stringify(backups.map(({ path: artifact }) => artifact))
      !== JSON.stringify(IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS)) return false;
  return backups.every(validArtifactBackup);
}

export function assertImmutableReleaseHostSnapshot(snapshot, { plan = null } = {}) {
  let serializedBytes;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  } catch (error) {
    throw deploymentError('immutable_release_deployment_host_snapshot_invalid', { cause: error });
  }
  if (serializedBytes > IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES
    || !exactKeys(snapshot, [
    'artifactBackups', 'configIdentityHash', 'hostSnapshotHash', 'kind',
    'mountIdentityHash', 'recoveryGateIdentityHash', 'status', 'unitStates', 'version',
  ]) || snapshot.version !== 1 || snapshot.kind !== 'ImmutableReleaseHostSnapshot'
    || snapshot.status !== 'immutable_release_host_snapshot_captured'
    || !SHA256.test(String(snapshot.hostSnapshotHash || ''))
    || !SHA256.test(String(snapshot.configIdentityHash || ''))
    || !SHA256.test(String(snapshot.mountIdentityHash || ''))
    || snapshot.recoveryGateIdentityHash !== IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH
    || !validateArtifactBackups(snapshot.artifactBackups)
    || !validateUnitInspection(snapshot.unitStates)) {
    throw deploymentError('immutable_release_deployment_host_snapshot_invalid');
  }
  const { hostSnapshotHash, ...payload } = snapshot;
  if (hashRecord('ImmutableReleaseHostSnapshot', payload) !== hostSnapshotHash
    || (plan !== null && (
      snapshot.configIdentityHash !== plan.configIdentityHash
      || snapshot.mountIdentityHash !== plan.predecessor.mountIdentityHash
      || snapshot.recoveryGateIdentityHash !== plan.recoveryGateIdentityHash
      || JSON.stringify(snapshot.unitStates) !== JSON.stringify(plan.unitStates)
    ))) {
    throw deploymentError('immutable_release_deployment_host_snapshot_invalid');
  }
  return snapshot;
}

export function assertImmutableReleaseDeploymentInspection(inspection, {
  testOnlyAllowUnpinnedReleaseStore = false,
} = {}) {
  if (!exactKeys(inspection, [
    'codeProvenance', 'configIdentityHash', 'deploymentLock', 'installedArtifacts',
    'mount', 'predecessorClosureHash', 'recoveryGateIdentityHash',
    'releaseStateSnapshot', 'units', 'version',
  ]) || inspection.version !== 1
    || !validateCodeIdentity(inspection.codeProvenance)
    || inspection.releaseStateSnapshot?.headCommit !== inspection.codeProvenance.commit
    || inspection.releaseStateSnapshot?.releaseState?.version
      !== inspection.codeProvenance.packageVersion
    || !SHA256.test(String(inspection.configIdentityHash || ''))
    || inspection.recoveryGateIdentityHash !== IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH
    || !SHA256.test(String(inspection.predecessorClosureHash || ''))
    || !exactKeys(inspection.deploymentLock, ['identityHash', 'path'])
    || inspection.deploymentLock.path !== IMMUTABLE_RELEASE_DEPLOYMENT_LOCK
    || !SHA256.test(String(inspection.deploymentLock.identityHash || ''))
    || !exactKeys(inspection.mount, [
      'identityHash', 'liveRoot', 'releasePath', 'sourceCommit', 'unit',
    ])
    || inspection.mount.liveRoot !== IMMUTABLE_RELEASE_LIVE_ROOT
    || inspection.mount.unit !== IMMUTABLE_RELEASE_MOUNT_UNIT
    || !absoluteCanonical(inspection.mount.releasePath)
    || !COMMIT.test(String(inspection.mount.sourceCommit || ''))
    || !inspection.mount.releasePath.endsWith(`/${inspection.mount.sourceCommit}`)
    || inspection.mount.sourceCommit === inspection.codeProvenance.commit
    || (!testOnlyAllowUnpinnedReleaseStore
      && parentPath(inspection.mount.releasePath) !== IMMUTABLE_RELEASE_STORE_ROOT)
    || !SHA256.test(String(inspection.mount.identityHash || ''))
    || !validateUnitInspection(inspection.units)
    || !Array.isArray(inspection.installedArtifacts)
    || JSON.stringify(inspection.installedArtifacts.map(({ path: artifact }) => artifact))
      !== JSON.stringify(IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS)
    || !inspection.installedArtifacts.every((artifact) => exactKeys(artifact, [
      'identityHash', 'path', 'present',
    ]) && typeof artifact.present === 'boolean'
      && (artifact.present ? SHA256.test(String(artifact.identityHash || ''))
        : artifact.identityHash === null))) {
    throw deploymentError('immutable_release_deployment_inspection_invalid');
  }
  validateReleaseState(
    inspection.releaseStateSnapshot,
    'immutable_release_deployment_release_ready_required',
  );
  return inspection;
}

export function buildImmutableReleaseDeploymentPlan({
  inspection,
  releaseStoreRoot = IMMUTABLE_RELEASE_STORE_ROOT,
  liveRoot = IMMUTABLE_RELEASE_LIVE_ROOT,
  testOnlyAllowUnpinnedReleaseStore = false,
} = {}) {
  assertImmutableReleaseDeploymentInspection(inspection, {
    testOnlyAllowUnpinnedReleaseStore,
  });
  if (!absoluteCanonical(releaseStoreRoot) || !absoluteCanonical(liveRoot)
    || liveRoot !== inspection.mount.liveRoot
    || liveRoot !== IMMUTABLE_RELEASE_LIVE_ROOT
    || (!testOnlyAllowUnpinnedReleaseStore
      && releaseStoreRoot !== IMMUTABLE_RELEASE_STORE_ROOT)) {
    throw deploymentError('immutable_release_deployment_root_invalid');
  }
  const commit = inspection.codeProvenance.commit;
  const releasePath = childPath(releaseStoreRoot, commit);
  const payload = Object.freeze({
    version: IMMUTABLE_RELEASE_DEPLOYMENT_VERSION,
    kind: 'ImmutableReleaseDeploymentPlan',
    strategy: 'fail_closed_immutable_release_v1',
    commit,
    commitTree: inspection.codeProvenance.commitTree,
    packageVersion: inspection.codeProvenance.packageVersion,
    codeProvenance: immutableCopy(inspection.codeProvenance),
    codeProvenanceHash: hashRecord(
      'ImmutableReleaseDeploymentCodeProvenance',
      inspection.codeProvenance,
    ),
    releaseStateSnapshot: immutableCopy(inspection.releaseStateSnapshot),
    releaseStateSnapshotHash:
      inspection.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    deploymentLock: Object.freeze({ ...inspection.deploymentLock }),
    predecessor: Object.freeze({
      closureHash: inspection.predecessorClosureHash,
      mountIdentityHash: inspection.mount.identityHash,
      releasePath: inspection.mount.releasePath,
      sourceCommit: inspection.mount.sourceCommit,
    }),
    target: Object.freeze({ liveRoot, releasePath }),
    configIdentityHash: inspection.configIdentityHash,
    recoveryGateIdentityHash: inspection.recoveryGateIdentityHash,
    installedArtifactIdentityHash: hashRecord(
      'ImmutableReleaseInstalledArtifactInspection',
      inspection.installedArtifacts,
    ),
    installedArtifactInspection: immutableCopy(inspection.installedArtifacts),
    unitStateHash: hashRecord('ImmutableReleaseUnitStateInspection', inspection.units),
    unitStates: immutableCopy(inspection.units),
    consumerUnits: IMMUTABLE_RELEASE_CONSUMER_UNITS,
    installedArtifacts: IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS,
    stages: IMMUTABLE_RELEASE_DEPLOYMENT_STAGES,
  });
  return Object.freeze({
    ...payload,
    planHash: hashRecord('ImmutableReleaseDeploymentPlan', payload),
  });
}

export function assertImmutableReleaseDeploymentPlan(plan) {
  const { planHash, ...payload } = plan || {};
  if (!exactKeys(plan, [
    'codeProvenance', 'codeProvenanceHash', 'commit', 'commitTree', 'configIdentityHash',
    'consumerUnits', 'deploymentLock', 'installedArtifactIdentityHash',
    'installedArtifactInspection', 'installedArtifacts', 'kind', 'packageVersion', 'planHash',
    'predecessor', 'recoveryGateIdentityHash', 'releaseStateSnapshot',
    'releaseStateSnapshotHash', 'stages', 'strategy', 'target', 'unitStateHash',
    'unitStates', 'version',
  ]) || !SHA256.test(String(planHash || ''))
    || hashRecord('ImmutableReleaseDeploymentPlan', payload) !== planHash
    || plan?.version !== IMMUTABLE_RELEASE_DEPLOYMENT_VERSION
    || plan?.kind !== 'ImmutableReleaseDeploymentPlan'
    || plan?.strategy !== 'fail_closed_immutable_release_v1'
    || !COMMIT.test(String(plan?.commit || ''))
    || !COMMIT.test(String(plan?.commitTree || ''))
    || !validateCodeIdentity(plan?.codeProvenance)
    || plan.codeProvenance.commit !== plan.commit
    || plan.codeProvenance.commitTree !== plan.commitTree
    || plan.packageVersion !== plan.codeProvenance.packageVersion
    || hashRecord('ImmutableReleaseDeploymentCodeProvenance', plan.codeProvenance)
      !== plan.codeProvenanceHash
    || plan.releaseStateSnapshot?.workspaceReleaseStateSnapshotHash
      !== plan.releaseStateSnapshotHash
    || plan.releaseStateSnapshot?.headCommit !== plan.commit
    || plan.releaseStateSnapshot?.releaseState?.version !== plan.packageVersion
    || !SHA256.test(String(plan?.releaseStateSnapshotHash || ''))
    || !exactKeys(plan?.deploymentLock, ['identityHash', 'path'])
    || plan.deploymentLock.path !== IMMUTABLE_RELEASE_DEPLOYMENT_LOCK
    || !SHA256.test(String(plan.deploymentLock.identityHash || ''))
    || !exactKeys(plan?.predecessor, [
      'closureHash', 'mountIdentityHash', 'releasePath', 'sourceCommit',
    ])
    || !SHA256.test(String(plan?.predecessor?.closureHash || ''))
    || !SHA256.test(String(plan?.predecessor?.mountIdentityHash || ''))
    || !COMMIT.test(String(plan?.predecessor?.sourceCommit || ''))
    || !absoluteCanonical(plan?.predecessor?.releasePath)
    || !plan.predecessor.releasePath.endsWith(`/${plan.predecessor.sourceCommit}`)
    || plan.predecessor.sourceCommit === plan.commit
    || parentPath(plan.predecessor.releasePath) !== IMMUTABLE_RELEASE_STORE_ROOT
    || !exactKeys(plan?.target, ['liveRoot', 'releasePath'])
    || plan.target.liveRoot !== IMMUTABLE_RELEASE_LIVE_ROOT
    || !absoluteCanonical(plan?.target?.releasePath)
    || !plan.target.releasePath.endsWith(`/${plan.commit}`)
    || parentPath(plan.target.releasePath) !== IMMUTABLE_RELEASE_STORE_ROOT
    || plan.target.releasePath === plan.predecessor.releasePath
    || parentPath(plan.target.releasePath) !== parentPath(plan.predecessor.releasePath)
    || !SHA256.test(String(plan.configIdentityHash || ''))
    || plan.recoveryGateIdentityHash !== IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH
    || !validateUnitInspection(plan.unitStates)
    || !SHA256.test(String(plan.unitStateHash || ''))
    || hashRecord('ImmutableReleaseUnitStateInspection', plan.unitStates) !== plan.unitStateHash
    || !Array.isArray(plan.installedArtifactInspection)
    || JSON.stringify(plan.installedArtifactInspection.map(({ path: artifact }) => artifact))
      !== JSON.stringify(IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS)
    || !plan.installedArtifactInspection.every((artifact) => exactKeys(artifact, [
      'identityHash', 'path', 'present',
    ]) && typeof artifact.present === 'boolean'
      && (artifact.present ? SHA256.test(String(artifact.identityHash || ''))
        : artifact.identityHash === null))
    || !SHA256.test(String(plan.installedArtifactIdentityHash || ''))
    || hashRecord(
      'ImmutableReleaseInstalledArtifactInspection',
      plan.installedArtifactInspection,
    ) !== plan.installedArtifactIdentityHash
    || JSON.stringify(plan.consumerUnits) !== JSON.stringify(IMMUTABLE_RELEASE_CONSUMER_UNITS)
    || JSON.stringify(plan.installedArtifacts)
      !== JSON.stringify(IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS)
    || JSON.stringify(plan.stages) !== JSON.stringify(IMMUTABLE_RELEASE_DEPLOYMENT_STAGES)) {
    throw deploymentError('immutable_release_deployment_plan_invalid');
  }
  validateReleaseState(plan.releaseStateSnapshot, 'immutable_release_deployment_plan_invalid');
  return plan;
}

export function immutableReleaseDeploymentReceipt({
  plan,
  status,
  completedStages,
  closureHash = null,
  hostSnapshotHash = null,
  postverificationHash = null,
  rollback = null,
  blocker = null,
} = {}) {
  assertImmutableReleaseDeploymentPlan(plan);
  const allowedStatuses = new Set([
    'immutable_release_deployment_planned',
    'immutable_release_deployment_completed',
    'immutable_release_deployment_rolled_back',
    'immutable_release_deployment_rollback_incomplete',
  ]);
  if (!allowedStatuses.has(status) || !Array.isArray(completedStages)
    || !completedStages.every((stage, index) => stage === plan.stages[index])
    || ![closureHash, hostSnapshotHash, postverificationHash]
      .every((value) => value === null || SHA256.test(String(value)))
    || (blocker !== null && (typeof blocker !== 'string' || !blocker))) {
    throw deploymentError('immutable_release_deployment_receipt_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'ImmutableReleaseDeploymentReceipt',
    status,
    planHash: plan.planHash,
    commit: plan.commit,
    completedStages: Object.freeze([...completedStages]),
    closureHash,
    hostSnapshotHash,
    postverificationHash,
    rollback,
    blocker,
  });
  return Object.freeze({
    ...payload,
    receiptHash: hashRecord('ImmutableReleaseDeploymentReceipt', payload),
  });
}
