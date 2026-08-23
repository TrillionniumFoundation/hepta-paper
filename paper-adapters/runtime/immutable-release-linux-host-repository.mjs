import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertImmutableReleaseDeploymentPlan,
  assertImmutableReleaseHostSnapshot,
  IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT,
  IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS,
  IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
  IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES,
  IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS,
  IMMUTABLE_RELEASE_LIVE_ROOT,
  IMMUTABLE_RELEASE_MOUNT_UNIT,
  IMMUTABLE_RELEASE_RECOVERY_UNIT,
  IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH,
  IMMUTABLE_RELEASE_STORE_ROOT,
  IMMUTABLE_RELEASE_UNIT_ACTIVE_STATES,
  IMMUTABLE_RELEASE_UNIT_ENABLEMENT_STATES,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import {
  assertTrustedImmutableReleaseHostExecutable,
  executeImmutableReleaseHostCommand,
  IMMUTABLE_RELEASE_HOST_EXECUTABLES,
  immutableReleaseInstallerInvocation,
  immutableReleaseMountUnit,
  immutableReleaseSystemctlInvocation,
  immutableReleaseSystemctlJobInspectionInvocation,
  immutableReleaseTargetUnitStates,
} from './immutable-release-linux-host-systemd.mjs';
import {
  assertSafeArtifactParent,
  existsNoFollow,
  fsyncDirectory,
  immutableReleasePathWithinOrSame,
  regularFileSnapshot,
  writeArtifactAtomically,
} from './immutable-release-host-artifact-repository.mjs';
import {
  defaultImmutableReleaseProcessReferenceInspection,
} from './immutable-release-process-reference-inspection.mjs';

export {
  IMMUTABLE_RELEASE_HOST_EXECUTABLES,
  immutableReleaseDeploymentCleanEnvironment,
  immutableReleaseInstallerInvocation,
  immutableReleaseMountUnit,
  immutableReleaseSystemctlInvocation,
  immutableReleaseSystemctlJobInspectionInvocation,
  immutableReleaseTargetUnitStates,
} from './immutable-release-linux-host-systemd.mjs';
export {
  inspectImmutableReleaseProcessReferences,
} from './immutable-release-process-reference-inspection.mjs';

// Bound each read as well as the aggregate JSON/base64 journal footprint. This
// prevents the host snapshot collector from materializing the allowlist's
// theoretical per-file maxima before the durable contract can reject it.
const HOST_SNAPSHOT_NON_ARTIFACT_RESERVE_BYTES = 1024 * 1024;
const MAXIMUM_CONFIGURATION_ENTRIES = 100_000;
const MAXIMUM_CONFIGURATION_BYTES = 512 * 1024 * 1024;
const MOUNT_UNIT_PATH = '/etc/systemd/system/opt-hepta\\x2dpaper.mount';
export const IMMUTABLE_RELEASE_BOOTSTRAP_CANDIDATE_RELATIVE_PATHS = Object.freeze({
  recoveryGate: 'paper-core/deploy/hepta-immutable-release-recovery.service',
  launcher: 'paper-core/deploy/hepta-immutable-release-deploy',
});

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function decodeMountPath(value) {
  return String(value).replace(/\\([0-7]{3})/gu, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function parseMountInfo(text) {
  return String(text).trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4) {
      throw codedError('immutable_release_mountinfo_invalid');
    }
    return Object.freeze({
      mountId: fields[0],
      parentMountId: fields[1],
      root: decodeMountPath(fields[3]),
      mountPoint: decodeMountPath(fields[4]),
      mountOptions: Object.freeze(fields[5].split(',')),
      filesystemType: fields[separator + 1],
      source: decodeMountPath(fields[separator + 2]),
      superOptions: Object.freeze(fields[separator + 3].split(',')),
    });
  });
}

export function inspectImmutableReleaseMount({
  mountInfoText = fs.readFileSync('/proc/self/mountinfo', 'utf8'),
  expectedReleasePath = null,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  const mounts = parseMountInfo(mountInfoText);
  const selected = mounts.filter(({ mountPoint }) => mountPoint === IMMUTABLE_RELEASE_LIVE_ROOT);
  if (selected.length !== 1) throw codedError('immutable_release_exact_mount_required');
  const mount = selected[0];
  if (!['ro', 'nosuid', 'nodev'].every((option) => mount.mountOptions.includes(option))) {
    throw codedError('immutable_release_mount_options_invalid');
  }
  if (mounts.some(({ mountPoint }) => mountPoint !== IMMUTABLE_RELEASE_LIVE_ROOT
    && immutableReleasePathWithinOrSame(IMMUTABLE_RELEASE_LIVE_ROOT, mountPoint))) {
    throw codedError('immutable_release_nested_mount_forbidden');
  }
  const releasePath = mount.root;
  const sourceCommit = path.basename(releasePath);
  if (path.dirname(releasePath) !== IMMUTABLE_RELEASE_STORE_ROOT
    || !/^[0-9a-f]{40}$/u.test(sourceCommit)
    || (expectedReleasePath !== null && releasePath !== expectedReleasePath)) {
    throw codedError('immutable_release_mount_source_invalid');
  }
  const store = fs.lstatSync(IMMUTABLE_RELEASE_STORE_ROOT, { bigint: true });
  const source = fs.lstatSync(releasePath, { bigint: true });
  const live = fs.lstatSync(IMMUTABLE_RELEASE_LIVE_ROOT, { bigint: true });
  if (fs.realpathSync(IMMUTABLE_RELEASE_STORE_ROOT) !== IMMUTABLE_RELEASE_STORE_ROOT
    || fs.realpathSync(releasePath) !== releasePath
    || store.isSymbolicLink() || !store.isDirectory()
    || source.isSymbolicLink() || !source.isDirectory()
    || live.isSymbolicLink() || !live.isDirectory()
    || Number(store.uid) !== expectedUid || Number(store.gid) !== expectedGid
    || (Number(store.mode) & 0o7777) !== 0o755
    || Number(source.uid) !== expectedUid || Number(source.gid) !== expectedGid
    || (Number(source.mode) & 0o7777) !== 0o555
    || source.dev !== live.dev || source.ino !== live.ino) {
    throw codedError('immutable_release_mount_identity_invalid');
  }
  const identity = Object.freeze({
    liveRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
    releasePath,
    sourceCommit,
    sourceDevice: String(source.dev),
    sourceInode: String(source.ino),
    mountOptions: Object.freeze([...mount.mountOptions].sort()),
  });
  return Object.freeze({
    liveRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
    unit: IMMUTABLE_RELEASE_MOUNT_UNIT,
    releasePath,
    sourceCommit,
    identityHash: hashRecord('ImmutableReleaseMountIdentity', identity),
  });
}

function configurationTreeIdentity(configurationRoot = '/etc/hepta-paper') {
  const root = fs.realpathSync(configurationRoot);
  const initial = fs.lstatSync(root, { bigint: true });
  if (root !== configurationRoot || initial.isSymbolicLink() || !initial.isDirectory()) {
    throw codedError('immutable_release_configuration_root_invalid');
  }
  const records = [];
  let bytes = 0;
  const pending = [{ file: root, relative: '.' }];
  while (pending.length > 0) {
    const { file, relative } = pending.pop();
    if (records.length >= MAXIMUM_CONFIGURATION_ENTRIES) {
      throw codedError('immutable_release_configuration_budget_exceeded');
    }
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink()) throw codedError('immutable_release_configuration_symlink_forbidden');
    if (stat.isDirectory()) {
      records.push({ relative, kind: 'directory', mode: Number(stat.mode) & 0o7777,
        uid: Number(stat.uid), gid: Number(stat.gid) });
      for (const name of fs.readdirSync(file).sort().reverse()) {
        pending.push({ file: path.join(file, name), relative: relative === '.' ? name : `${relative}/${name}` });
      }
    } else if (stat.isFile()) {
      const snapshot = regularFileSnapshot(file, { includeContent: false });
      bytes += Number(stat.size);
      if (bytes > MAXIMUM_CONFIGURATION_BYTES) {
        throw codedError('immutable_release_configuration_budget_exceeded');
      }
      records.push({ relative, kind: 'file', ...snapshot });
    } else throw codedError('immutable_release_configuration_special_file_forbidden');
  }
  const completed = fs.lstatSync(root, { bigint: true });
  if (initial.dev !== completed.dev || initial.ino !== completed.ino
    || initial.mtimeNs !== completed.mtimeNs || initial.ctimeNs !== completed.ctimeNs) {
    throw codedError('immutable_release_configuration_changed');
  }
  return hashRecord('ImmutableReleaseConfigurationIdentity', records);
}

function assertFactoryOptions({
  expectedUid,
  expectedGid,
  testOnlyAllowNonRoot,
  testOnlyHostRoot,
  testOnlySkipExecutableTrust,
}) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0
    || !Number.isSafeInteger(expectedGid) || expectedGid < 0
    || ((expectedUid !== 0 || expectedGid !== 0 || process.geteuid?.() !== 0)
      && testOnlyAllowNonRoot !== true)
    || ((testOnlyHostRoot !== null || testOnlySkipExecutableTrust)
      && testOnlyAllowNonRoot !== true)) {
    throw codedError('immutable_release_linux_host_root_required');
  }
}

export function createLinuxImmutableReleaseHostAdapter({
  runner = spawnSync,
  expectedUid = 0,
  expectedGid = 0,
  testOnlyAllowNonRoot = false,
  testOnlyHostRoot = null,
  testOnlySkipExecutableTrust = false,
  inspectMount = inspectImmutableReleaseMount,
  inspectConfigurationIdentity = configurationTreeIdentity,
  inspectReferences = defaultImmutableReleaseProcessReferenceInspection,
  verifyPublishedRelease = null,
} = {}) {
  assertFactoryOptions({
    expectedUid, expectedGid, testOnlyAllowNonRoot, testOnlyHostRoot,
    testOnlySkipExecutableTrust,
  });
  if (typeof runner !== 'function' || typeof inspectMount !== 'function'
    || typeof inspectConfigurationIdentity !== 'function'
    || typeof inspectReferences !== 'function') {
    throw codedError('immutable_release_linux_host_option_invalid');
  }
  if (!testOnlySkipExecutableTrust) {
    for (const executable of Object.values(IMMUTABLE_RELEASE_HOST_EXECUTABLES)) {
      assertTrustedImmutableReleaseHostExecutable(executable);
    }
  }
  let activeLock = null;
  const selectedHostPath = (canonical) => testOnlyHostRoot === null
    ? canonical : path.join(testOnlyHostRoot, canonical.slice(1));
  const artifactInspection = ({ includeContent }) => {
    const records = [];
    let serializedBackupBytes = 0;
    for (const artifact of IMMUTABLE_RELEASE_INSTALLED_ARTIFACTS) {
      const selected = selectedHostPath(artifact);
      let record;
      if (!existsNoFollow(selected)) record = includeContent
        ? Object.freeze({ path: artifact, present: false, contentBase64: null,
          contentHash: null, uid: null, gid: null, mode: null })
        : Object.freeze({ path: artifact, present: false, identityHash: null });
      else {
        const material = regularFileSnapshot(selected, {
          includeContent,
          ...(includeContent ? {
            // Leave conservative space for this record's path/hash/metadata;
            // the exact serialized size is checked again after encoding.
            maximumContentBase64Bytes:
              IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES
              - HOST_SNAPSHOT_NON_ARTIFACT_RESERVE_BYTES
              - serializedBackupBytes
              - 1024,
          } : {}),
        });
        record = includeContent
          ? Object.freeze({ path: artifact, present: true, ...material })
          : Object.freeze({
            path: artifact,
            present: true,
            identityHash: hashRecord('ImmutableReleaseInstalledArtifactIdentity', {
              path: artifact, ...material,
            }),
          });
      }
      if (includeContent) {
        serializedBackupBytes += Buffer.byteLength(JSON.stringify(record));
        if (serializedBackupBytes
          > IMMUTABLE_RELEASE_HOST_SNAPSHOT_MAXIMUM_BYTES
            - HOST_SNAPSHOT_NON_ARTIFACT_RESERVE_BYTES) {
          throw codedError('immutable_release_host_snapshot_budget_exceeded');
        }
      }
      records.push(record);
    }
    return records;
  };
  const assertDeploymentBootstrapCompatible = ({ candidateRoot, sealedCandidate = false } = {}) => {
    if (typeof candidateRoot !== 'string' || !path.isAbsolute(candidateRoot)
      || path.resolve(candidateRoot) !== candidateRoot || fs.realpathSync(candidateRoot) !== candidateRoot) {
      throw codedError('immutable_release_deployment_bootstrap_candidate_invalid');
    }
    try {
      for (const bootstrap of IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS) {
        const installed = regularFileSnapshot(selectedHostPath(bootstrap.installedPath), {
          includeContent: false,
        });
        const candidate = regularFileSnapshot(
          path.join(candidateRoot,
            ...IMMUTABLE_RELEASE_BOOTSTRAP_CANDIDATE_RELATIVE_PATHS[bootstrap.key].split('/')),
          { includeContent: false },
        );
        if (installed.contentHash !== candidate.contentHash
          || installed.uid !== expectedUid || installed.gid !== expectedGid
          || installed.mode !== bootstrap.installedMode
          || (sealedCandidate && (
            candidate.uid !== expectedUid || candidate.gid !== expectedGid
            || ![0o444, 0o555].includes(candidate.mode)
          ))) {
          throw codedError('immutable_release_deployment_bootstrap_migration_required');
        }
      }
    } catch (error) {
      if (error?.code?.startsWith?.('immutable_release_')) throw error;
      throw codedError('immutable_release_deployment_bootstrap_migration_required', { cause: error });
    }
    return Object.freeze({
      status: 'immutable_release_deployment_bootstrap_compatible',
      artifactCount: IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS.length,
    });
  };
  const systemctl = (operation, units = [], options = {}) => executeImmutableReleaseHostCommand(runner,
    immutableReleaseSystemctlInvocation({ operation, units, ...options }));
  const queuedUnitJob = (unit) => {
    const jobId = systemctl('show', [unit], { property: 'Job' });
    if (jobId === '' || jobId === '0' || jobId === '[not set]') return null;
    if (!/^[1-9][0-9]*$/u.test(jobId)) {
      throw codedError('immutable_release_systemctl_queued_job_invalid');
    }
    const inspectJob = (property) => executeImmutableReleaseHostCommand(runner,
      immutableReleaseSystemctlJobInspectionInvocation({ jobId, property }));
    return Object.freeze({
      jobId,
      type: inspectJob('JobType'),
      unit: inspectJob('Unit'),
    });
  };
  const recoveryUnitStateMatches = (actual, expected) => {
    if (actual.name !== expected.name || actual.enablement !== expected.enablement) return false;
    const queued = queuedUnitJob(actual.name);
    if (actual.activeState === expected.activeState) return queued === null;
    const expectedJobType = expected.activeState === 'active' ? 'start' : 'stop';
    return queued?.unit === actual.name && queued?.type === expectedJobType;
  };
  const inspectRecoveryGate = ({ requireActive = true } = {}) => {
    const loadState = systemctl('show', [IMMUTABLE_RELEASE_RECOVERY_UNIT], {
      property: 'LoadState',
    });
    const activeState = systemctl('show', [IMMUTABLE_RELEASE_RECOVERY_UNIT], {
      property: 'ActiveState',
    });
    const enablement = systemctl('show', [IMMUTABLE_RELEASE_RECOVERY_UNIT], {
      property: 'UnitFileState',
    });
    const gateFragment = systemctl('show', [IMMUTABLE_RELEASE_RECOVERY_UNIT], {
      property: 'FragmentPath',
    });
    const gateDropIns = systemctl('show', [IMMUTABLE_RELEASE_RECOVERY_UNIT], {
      property: 'DropInPaths',
    });
    const gateNeedsReload = systemctl('show', [IMMUTABLE_RELEASE_RECOVERY_UNIT], {
      property: 'NeedDaemonReload',
    });
    if (loadState !== 'loaded'
      || (requireActive ? activeState !== 'active'
        : !['active', 'activating'].includes(activeState))
      || enablement !== 'enabled'
      || gateFragment !== `/etc/systemd/system/${IMMUTABLE_RELEASE_RECOVERY_UNIT}`
      || gateDropIns !== '' || gateNeedsReload !== 'no') {
      throw codedError('immutable_release_deployment_recovery_gate_not_ready');
    }
    for (const unit of IMMUTABLE_RELEASE_CONSUMER_UNITS) {
      const consumerLoadState = systemctl('show', [unit], { property: 'LoadState' });
      if (consumerLoadState === 'not-found'
        && Object.hasOwn(IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT, unit)) continue;
      const requires = new Set(systemctl('show', [unit], { property: 'Requires' })
        .split(/\s+/u).filter(Boolean));
      const after = new Set(systemctl('show', [unit], { property: 'After' })
        .split(/\s+/u).filter(Boolean));
      const fragment = systemctl('show', [unit], { property: 'FragmentPath' });
      const dropIns = systemctl('show', [unit], { property: 'DropInPaths' });
      const needsReload = systemctl('show', [unit], { property: 'NeedDaemonReload' });
      if (consumerLoadState !== 'loaded'
        || !requires.has(IMMUTABLE_RELEASE_RECOVERY_UNIT)
        || !after.has(IMMUTABLE_RELEASE_RECOVERY_UNIT)
        || fragment !== `/etc/systemd/system/${unit}`
        || dropIns !== '' || needsReload !== 'no') {
        throw codedError('immutable_release_deployment_consumer_recovery_gate_missing', { unit });
      }
    }
    return Object.freeze({
      status: 'immutable_release_deployment_recovery_gate_ready',
      unit: IMMUTABLE_RELEASE_RECOVERY_UNIT,
      identityHash: IMMUTABLE_RELEASE_RECOVERY_GATE_POLICY_HASH,
    });
  };
  const unitInspection = () => IMMUTABLE_RELEASE_CONSUMER_UNITS.map((name) => {
    const loadState = systemctl('show', [name], { property: 'LoadState' });
    const activeState = loadState === 'not-found'
      ? 'inactive' : systemctl('show', [name], { property: 'ActiveState' });
    const enablement = loadState === 'not-found'
      ? 'not-found' : systemctl('show', [name], { property: 'UnitFileState' });
    if (!IMMUTABLE_RELEASE_UNIT_ACTIVE_STATES.includes(activeState)
      || !IMMUTABLE_RELEASE_UNIT_ENABLEMENT_STATES.includes(enablement)) {
      throw codedError('immutable_release_unit_state_unsupported');
    }
    return Object.freeze({ name, activeState, enablement });
  });
  const assertLockHeld = async ({ lock, expectedIdentityHash }) => {
    if (lock !== activeLock || lock?.identityHash !== expectedIdentityHash
      || lock?.assertHeld?.() !== true) throw codedError('immutable_release_deployment_lock_not_held');
    return true;
  };
  const restoreEnablement = (unit) => {
    if (unit.enablement === 'enabled') systemctl('enable', [unit.name]);
    else if (unit.enablement === 'enabled-runtime') {
      systemctl('enable', [unit.name], { runtime: true });
    } else if (unit.enablement === 'disabled') systemctl('disable', [unit.name]);
    else if (unit.enablement === 'masked') systemctl('mask', [unit.name]);
    else if (unit.enablement === 'masked-runtime') {
      systemctl('mask', [unit.name], { runtime: true });
    }
  };
  const operations = {
    bindLock(lock) {
      if (activeLock !== null) throw codedError('immutable_release_deployment_lock_already_bound');
      activeLock = lock;
      return lock;
    },
    unbindLock(lock) {
      if (lock !== activeLock) throw codedError('immutable_release_deployment_lock_binding_invalid');
      activeLock = null;
    },
    assertLockHeld,
    inspectMount,
    inspectConfigurationIdentity,
    inspectUnits: unitInspection,
    inspectRecoveryGate,
    assertDeploymentBootstrapCompatible,
    inspectInstalledArtifacts() { return Object.freeze(artifactInspection({ includeContent: false })); },
    async captureHostSnapshot({ plan, lock }) {
      assertImmutableReleaseDeploymentPlan(plan);
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      const currentMount = inspectMount({ expectedReleasePath: plan.predecessor.releasePath });
      const recoveryGate = inspectRecoveryGate({ requireActive: false });
      const payload = Object.freeze({
        version: 1,
        kind: 'ImmutableReleaseHostSnapshot',
        status: 'immutable_release_host_snapshot_captured',
        configIdentityHash: inspectConfigurationIdentity(),
        mountIdentityHash: currentMount.identityHash,
        recoveryGateIdentityHash: recoveryGate.identityHash,
        unitStates: Object.freeze(unitInspection()),
        artifactBackups: Object.freeze(artifactInspection({ includeContent: true })),
      });
      return Object.freeze({
        ...payload,
        hostSnapshotHash: hashRecord('ImmutableReleaseHostSnapshot', payload),
      });
    },
    async quiesceConsumers({ plan, lock }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      const presentUnits = unitInspection().filter(({ enablement }) => enablement !== 'not-found')
        .map(({ name }) => name);
      if (presentUnits.length > 0) systemctl('stop', presentUnits);
    },
    async assertReleaseUnreferenced({ plan, lock, releasePath }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      if (![plan.predecessor.releasePath, plan.target.releasePath].includes(releasePath)) {
        throw codedError('immutable_release_reference_scan_path_forbidden');
      }
      if (!existsNoFollow(releasePath)) {
        return Object.freeze({ status: 'immutable_release_release_unreferenced', referenceCount: 0 });
      }
      const references = inspectReferences(releasePath);
      if (!Array.isArray(references)) throw codedError('immutable_release_reference_scan_invalid');
      return Object.freeze({
        status: references.length === 0
          ? 'immutable_release_release_unreferenced'
          : 'immutable_release_release_referenced',
        referenceCount: references.length,
        referenceHash: hashRecord('ImmutableReleaseProcessReferences', references),
      });
    },
    async cutoverMount({ plan, lock }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      const destination = selectedHostPath(MOUNT_UNIT_PATH);
      writeArtifactAtomically(destination, Buffer.from(immutableReleaseMountUnit({
        releasePath: plan.target.releasePath,
      })), {
        uid: expectedUid, gid: expectedGid, mode: 0o644, expectedUid, expectedGid,
        boundary: testOnlyHostRoot || '/',
      });
      systemctl('daemon-reload');
      systemctl('restart', [IMMUTABLE_RELEASE_MOUNT_UNIT]);
      inspectMount({ expectedReleasePath: plan.target.releasePath });
    },
    async installHostArtifacts({ plan, lock }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      if (testOnlyHostRoot !== null) {
        throw codedError('immutable_release_installer_test_root_execution_forbidden');
      }
      assertDeploymentBootstrapCompatible({
        candidateRoot: plan.target.releasePath,
        sealedCandidate: true,
      });
      const command = immutableReleaseInstallerInvocation({ plan });
      assertTrustedImmutableReleaseHostExecutable(command.arguments[0]);
      executeImmutableReleaseHostCommand(runner, command, { maxBuffer: 16 * 1024 * 1024 });
      systemctl('daemon-reload');
      const artifacts = artifactInspection({ includeContent: false });
      const recoveryGate = inspectRecoveryGate({ requireActive: false });
      if (recoveryGate.identityHash !== plan.recoveryGateIdentityHash) {
        throw codedError('immutable_release_deployment_target_recovery_gate_invalid');
      }
      return Object.freeze({
        status: 'immutable_release_host_artifacts_installed',
        installedArtifactIdentityHash: hashRecord(
          'ImmutableReleaseInstalledArtifactInspection',
          artifacts,
        ),
      });
    },
    async postverifyRelease({ plan, lock, closureHash }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      if (typeof verifyPublishedRelease !== 'function') {
        throw codedError('immutable_release_postverify_adapter_required');
      }
      const verification = await verifyPublishedRelease({ plan, closureHash });
      if (verification?.closureHash !== closureHash
        || verification?.commit !== plan.commit
        || verification?.releaseStateSnapshotHash !== plan.releaseStateSnapshotHash) {
        throw codedError('immutable_release_postverify_release_invalid');
      }
      const payload = Object.freeze({
        version: 1,
        kind: 'ImmutableReleaseDeploymentPostverification',
        planHash: plan.planHash,
        closureHash,
        verification,
      });
      return Object.freeze({
        status: 'immutable_release_deployment_postverified',
        postverificationHash: hashRecord('ImmutableReleaseDeploymentPostverification', payload),
      });
    },
    async restoreUnitStates({ plan, lock, snapshot, phase, recovery = false }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      assertImmutableReleaseHostSnapshot(snapshot, { plan });
      systemctl('daemon-reload');
      // not-found has an exact target policy but requires no systemctl
      // enablement mutation: the reviewed unit is static after installation.
      for (const unit of snapshot.unitStates) {
        if (unit.enablement !== 'not-found') restoreEnablement(unit, phase);
      }
      const inactive = snapshot.unitStates.filter(({ activeState, enablement }) => (
        activeState === 'inactive' && !(enablement === 'not-found' && phase !== 'commit')
      ))
        .map(({ name }) => name);
      const active = snapshot.unitStates.filter(({ activeState }) => activeState === 'active')
        .map(({ name }) => name);
      // During boot recovery every consumer is ordered After the recovery
      // oneshot. Waiting synchronously for those starts would wait for this
      // very process to exit. Queue the exact restore jobs and prove their
      // presence in verifyRollback; normal execute/rollback stays synchronous.
      if (inactive.length > 0) systemctl('stop', inactive, { noBlock: recovery });
      if (active.length > 0) systemctl('start', active, { noBlock: recovery });
    },
    async rollbackHostArtifacts({ plan, lock, snapshot }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      assertImmutableReleaseHostSnapshot(snapshot, { plan });
      for (const backup of snapshot.artifactBackups) {
        const destination = selectedHostPath(backup.path);
        const parent = assertSafeArtifactParent(destination, {
          expectedUid, expectedGid, boundary: testOnlyHostRoot || '/',
        });
        if (!backup.present) {
          if (existsNoFollow(destination)) {
            const current = fs.lstatSync(destination, { bigint: true });
            if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n) {
              throw codedError('immutable_release_host_artifact_destination_invalid');
            }
            fs.unlinkSync(destination);
            fsyncDirectory(parent);
          }
        } else {
          writeArtifactAtomically(destination, Buffer.from(backup.contentBase64, 'base64'), {
            uid: backup.uid, gid: backup.gid, mode: backup.mode, expectedUid, expectedGid,
            boundary: testOnlyHostRoot || '/',
          });
        }
      }
      systemctl('daemon-reload');
    },
    async rollbackMount({ plan, lock }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      systemctl('daemon-reload');
      systemctl('restart', [IMMUTABLE_RELEASE_MOUNT_UNIT]);
      inspectMount({ expectedReleasePath: plan.predecessor.releasePath });
    },
    async verifyRollback({ plan, lock, snapshot, phase = 'rollback' }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      assertImmutableReleaseHostSnapshot(snapshot, { plan });
      const mount = inspectMount({ expectedReleasePath: plan.predecessor.releasePath });
      const units = unitInspection();
      const artifacts = artifactInspection({ includeContent: false });
      const configIdentityHash = inspectConfigurationIdentity();
      const recoveryGateIdentityHash = inspectRecoveryGate({ requireActive: false }).identityHash;
      const unitStatesMatch = phase === 'recovery_rollback'
        ? units.every((unit, index) => recoveryUnitStateMatches(
          unit,
          snapshot.unitStates[index],
        ))
        : JSON.stringify(units) === JSON.stringify(snapshot.unitStates);
      if (mount.identityHash !== snapshot.mountIdentityHash
        || configIdentityHash !== snapshot.configIdentityHash
        || recoveryGateIdentityHash !== snapshot.recoveryGateIdentityHash
        || !unitStatesMatch
        || hashRecord('ImmutableReleaseInstalledArtifactInspection', artifacts)
          !== plan.installedArtifactIdentityHash) {
        throw codedError('immutable_release_rollback_state_mismatch');
      }
      return Object.freeze({
        status: 'immutable_release_deployment_rollback_verified',
        configIdentityHash,
      });
    },
    async verifyPostconditions({
      plan, lock, snapshot, closureHash, postverificationHash,
      installedArtifactIdentityHash, phase = 'commit',
    }) {
      await assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      assertImmutableReleaseHostSnapshot(snapshot, { plan });
      const mount = inspectMount({ expectedReleasePath: plan.target.releasePath });
      const units = unitInspection();
      const configIdentityHash = inspectConfigurationIdentity();
      const recoveryGateIdentityHash = inspectRecoveryGate({ requireActive: false }).identityHash;
      const artifacts = artifactInspection({ includeContent: false });
      const expectedUnits = immutableReleaseTargetUnitStates(snapshot.unitStates);
      const unitStatesMatch = phase === 'recovery'
        ? units.every((unit, index) => recoveryUnitStateMatches(unit, expectedUnits[index]))
        : JSON.stringify(units) === JSON.stringify(expectedUnits);
      const artifactIdentityHash = hashRecord(
        'ImmutableReleaseInstalledArtifactInspection',
        artifacts,
      );
      if (phase === 'recovery') {
        if (typeof verifyPublishedRelease !== 'function') {
          throw codedError('immutable_release_postverify_adapter_required');
        }
        const verification = await verifyPublishedRelease({ plan, closureHash });
        if (verification?.closureHash !== closureHash || verification?.commit !== plan.commit
          || verification?.releaseStateSnapshotHash !== plan.releaseStateSnapshotHash) {
          throw codedError('immutable_release_committed_recovery_target_invalid');
        }
      }
      if (configIdentityHash !== plan.configIdentityHash
        || recoveryGateIdentityHash !== plan.recoveryGateIdentityHash
        || !unitStatesMatch
        || artifacts.some(({ present }) => !present)
        || !/^sha256:[0-9a-f]{64}$/u.test(String(installedArtifactIdentityHash || ''))
        || artifactIdentityHash !== installedArtifactIdentityHash
        || !/^sha256:[0-9a-f]{64}$/u.test(String(closureHash || ''))
        || !/^sha256:[0-9a-f]{64}$/u.test(String(postverificationHash || ''))) {
        throw codedError('immutable_release_postcondition_state_mismatch');
      }
      return Object.freeze({
        status: 'immutable_release_deployment_postconditions_verified',
        configIdentityHash,
        mountIdentityHash: mount.identityHash,
      });
    },
  };
  return Object.freeze(operations);
}

export function immutableReleaseHostConfigurationIdentity(options = {}) {
  return configurationTreeIdentity(options.configurationRoot);
}

export const IMMUTABLE_RELEASE_MOUNT_UNIT_PATH = MOUNT_UNIT_PATH;
export const IMMUTABLE_RELEASE_LOCK_PATH = IMMUTABLE_RELEASE_DEPLOYMENT_LOCK;
