import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createLinuxImmutableReleaseHostAdapter,
  IMMUTABLE_RELEASE_BOOTSTRAP_CANDIDATE_RELATIVE_PATHS,
  immutableReleaseDeploymentCleanEnvironment,
  immutableReleaseInstallerInvocation,
  immutableReleaseMountUnit,
  immutableReleaseSystemctlJobInspectionInvocation,
  immutableReleaseSystemctlInvocation,
  immutableReleaseTargetUnitStates,
  inspectImmutableReleaseProcessReferences,
} from '../../paper-adapters/runtime/immutable-release-linux-host-repository.mjs';
import {
  assertSafeArtifactParent,
  existsNoFollow,
  immutableReleasePathWithinOrSame,
  regularFileSnapshot,
  writeArtifactAtomically,
} from '../../paper-adapters/runtime/immutable-release-host-artifact-repository.mjs';
import {
  IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT,
  IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS,
  IMMUTABLE_RELEASE_RECOVERY_UNIT,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import {
  immutableReleaseDeploymentPlanFixture,
  immutableReleaseHostSnapshotFixture,
  immutableReleaseFixtureHash,
} from './support/immutable-release-deployment-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function gatedSystemdRunner(plan, {
  missingRequiresFor = null,
  gateActive = 'active',
  bootQueuedStarts = false,
  wrongQueuedJobFor = null,
} = {}) {
  const unitStates = new Map(plan.unitStates.map((unit) => [unit.name, unit]));
  const queuedJobs = new Map(plan.unitStates
    .filter(({ activeState }) => bootQueuedStarts && activeState === 'active')
    .map((unit, index) => [String(index + 1), unit.name]));
  return (_executable, argumentsList) => {
    const property = argumentsList.find((argument) => argument.startsWith('--property='))
      ?.slice('--property='.length);
    const unitName = argumentsList.at(-1);
    if (/^[1-9][0-9]*$/u.test(unitName)) {
      const queuedUnit = queuedJobs.get(unitName);
      const values = {
        JobType: queuedUnit === wrongQueuedJobFor ? 'stop' : 'start',
        Unit: queuedUnit || '',
      };
      return { status: 0, stdout: `${values[property] ?? ''}\n`, stderr: '' };
    }
    if (unitName === IMMUTABLE_RELEASE_RECOVERY_UNIT) {
      const values = {
        LoadState: 'loaded',
        ActiveState: gateActive,
        UnitFileState: 'enabled',
        FragmentPath: `/etc/systemd/system/${IMMUTABLE_RELEASE_RECOVERY_UNIT}`,
        DropInPaths: '',
        NeedDaemonReload: 'no',
      };
      return { status: 0, stdout: `${values[property] ?? ''}\n`, stderr: '' };
    }
    const unit = unitStates.get(unitName);
    const values = {
      LoadState: unit?.enablement === 'not-found' ? 'not-found' : 'loaded',
      ActiveState: bootQueuedStarts && unit?.activeState === 'active'
        ? 'inactive' : (unit?.activeState || 'inactive'),
      UnitFileState: unit?.enablement || 'disabled',
      Requires: unitName === missingRequiresFor ? '' : IMMUTABLE_RELEASE_RECOVERY_UNIT,
      After: IMMUTABLE_RELEASE_RECOVERY_UNIT,
      FragmentPath: `/etc/systemd/system/${unitName}`,
      DropInPaths: '',
      NeedDaemonReload: 'no',
      Job: [...queuedJobs.entries()].find(([, queuedUnit]) => queuedUnit === unitName)?.[0] || '',
    };
    return { status: 0, stdout: `${values[property] ?? ''}\n`, stderr: '' };
  };
}

test('host command builders pin absolute binaries, exact allowlists, and no-systemctl installer', () => {
  const plan = immutableReleaseDeploymentPlanFixture();
  assert.deepEqual(immutableReleaseInstallerInvocation({ plan }), {
    executable: '/usr/bin/dash',
    arguments: [
      `${plan.target.releasePath}/paper-core/deploy/install-hepta-paper-systemd-host.sh`,
      '--root', '/', '--no-systemctl', '--preserve-deployment-bootstrap',
    ],
  });
  assert.deepEqual(immutableReleaseSystemctlInvocation({
    operation: 'stop', units: [IMMUTABLE_RELEASE_CONSUMER_UNITS[0]],
  }), {
    executable: '/usr/bin/systemctl',
    arguments: ['stop', '--', IMMUTABLE_RELEASE_CONSUMER_UNITS[0]],
  });
  assert.deepEqual(immutableReleaseSystemctlInvocation({
    operation: 'start', units: [IMMUTABLE_RELEASE_CONSUMER_UNITS[0]], noBlock: true,
  }).arguments, ['start', '--no-block', '--', IMMUTABLE_RELEASE_CONSUMER_UNITS[0]]);
  assert.deepEqual(immutableReleaseSystemctlInvocation({
    operation: 'show', units: [IMMUTABLE_RELEASE_RECOVERY_UNIT], property: 'ActiveState',
  }).arguments, ['show', '--property=ActiveState', '--value', '--', IMMUTABLE_RELEASE_RECOVERY_UNIT]);
  assert.throws(() => immutableReleaseSystemctlInvocation({
    operation: 'stop', units: [IMMUTABLE_RELEASE_RECOVERY_UNIT],
  }), /immutable_release_systemctl_invocation_invalid/u);
  assert.deepEqual(immutableReleaseSystemctlJobInspectionInvocation({
    jobId: '42', property: 'JobType',
  }), {
    executable: '/usr/bin/systemctl',
    arguments: ['show', '--property=JobType', '--value', '--', '42'],
  });
  assert.throws(() => immutableReleaseSystemctlJobInspectionInvocation({
    jobId: '../42', property: 'JobType',
  }), /immutable_release_systemctl_job_inspection_invalid/u);
  assert.throws(() => immutableReleaseSystemctlInvocation({
    operation: 'start', units: ['attacker.service'],
  }), /immutable_release_systemctl_invocation_invalid/u);
  assert.throws(() => immutableReleaseInstallerInvocation({ plan, installRoot: '/tmp/root' }),
    /immutable_release_installer_root_unpinned/u);
  assert.deepEqual(Object.keys(immutableReleaseDeploymentCleanEnvironment()).sort(), [
    'HOME', 'LANG', 'LC_ALL', 'PATH', 'SYSTEMD_COLORS', 'SYSTEMD_PAGER',
  ]);
  assert.match(immutableReleaseMountUnit({ releasePath: plan.target.releasePath }),
    new RegExp(`^What=${plan.target.releasePath}$`, 'mu'));
  assert.match(immutableReleaseMountUnit({ releasePath: plan.target.releasePath }),
    /^Options=bind,ro,nosuid,nodev$/mu);
});

test('bootstrap launcher and boot recovery gate must pre-exist byte-identically', (t) => {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-host-root-'));
  const candidateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-candidate-root-'));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(candidateRoot, { recursive: true, force: true }));
  for (const [index, artifact] of IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS.entries()) {
    const installed = path.join(hostRoot, artifact.installedPath.slice(1));
    const candidateRelativePath =
      IMMUTABLE_RELEASE_BOOTSTRAP_CANDIDATE_RELATIVE_PATHS[artifact.key];
    const candidate = path.join(candidateRoot, candidateRelativePath);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(installed, `bootstrap:${index}\n`, { mode: artifact.installedMode });
    fs.writeFileSync(candidate, `bootstrap:${index}\n`, { mode: 0o644 });
    fs.chmodSync(installed, artifact.installedMode);
  }
  const adapter = createLinuxImmutableReleaseHostAdapter({
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowNonRoot: true,
    testOnlyHostRoot: hostRoot,
    testOnlySkipExecutableTrust: true,
    inspectMount: () => { throw new Error('not used'); },
    inspectConfigurationIdentity: () => { throw new Error('not used'); },
    inspectReferences: () => [],
  });
  assert.equal(adapter.assertDeploymentBootstrapCompatible({ candidateRoot }).artifactCount, 2);
  assert.throws(() => adapter.assertDeploymentBootstrapCompatible({
    candidateRoot, sealedCandidate: true,
  }), /immutable_release_deployment_bootstrap_migration_required/u);
  for (const artifact of IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS) {
    fs.chmodSync(path.join(candidateRoot,
      IMMUTABLE_RELEASE_BOOTSTRAP_CANDIDATE_RELATIVE_PATHS[artifact.key]), 0o444);
  }
  assert.equal(adapter.assertDeploymentBootstrapCompatible({
    candidateRoot, sealedCandidate: true,
  }).status, 'immutable_release_deployment_bootstrap_compatible');
  fs.chmodSync(path.join(candidateRoot,
    IMMUTABLE_RELEASE_BOOTSTRAP_CANDIDATE_RELATIVE_PATHS[
      IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS[0].key
    ]), 0o644);
  fs.appendFileSync(path.join(candidateRoot,
    IMMUTABLE_RELEASE_BOOTSTRAP_CANDIDATE_RELATIVE_PATHS[
      IMMUTABLE_RELEASE_DEPLOYMENT_BOOTSTRAP_ARTIFACTS[0].key
    ]), 'poison\n');
  assert.throws(() => adapter.assertDeploymentBootstrapCompatible({ candidateRoot }),
    /immutable_release_deployment_bootstrap_migration_required/u);
});

test('preflight holds unless every installed consumer has direct recovery ordering', () => {
  const plan = immutableReleaseDeploymentPlanFixture();
  const options = {
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowNonRoot: true,
    testOnlySkipExecutableTrust: true,
    inspectMount: () => { throw new Error('not used'); },
    inspectConfigurationIdentity: () => { throw new Error('not used'); },
    inspectReferences: () => [],
  };
  const ready = createLinuxImmutableReleaseHostAdapter({
    ...options,
    runner: gatedSystemdRunner(plan),
  }).inspectRecoveryGate();
  assert.equal(ready.status, 'immutable_release_deployment_recovery_gate_ready');
  assert.match(ready.identityHash, /^sha256:[0-9a-f]{64}$/u);

  const missingUnit = IMMUTABLE_RELEASE_CONSUMER_UNITS[0];
  const incomplete = createLinuxImmutableReleaseHostAdapter({
    ...options,
    runner: gatedSystemdRunner(plan, { missingRequiresFor: missingUnit }),
  });
  assert.throws(() => incomplete.inspectRecoveryGate(), (error) => (
    error?.code === 'immutable_release_deployment_consumer_recovery_gate_missing'
      && error?.unit === missingUnit
  ));
});

test('host snapshot collector enforces the aggregate journal budget incrementally', async (t) => {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-budget-root-'));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  const plan = immutableReleaseDeploymentPlanFixture();
  for (const artifact of plan.installedArtifacts.slice(0, 2)) {
    const selected = path.join(hostRoot, artifact.slice(1));
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    fs.writeFileSync(selected, Buffer.alloc(6 * 1024 * 1024, 0x61), { mode: 0o644 });
  }
  const originalReadFile = fs.readFileSync;
  let descriptorReads = 0;
  fs.readFileSync = function countedReadFile(candidate, ...remaining) {
    if (typeof candidate === 'number') descriptorReads += 1;
    return originalReadFile.call(this, candidate, ...remaining);
  };
  t.after(() => { fs.readFileSync = originalReadFile; });
  const runner = gatedSystemdRunner(plan);
  const adapter = createLinuxImmutableReleaseHostAdapter({
    runner,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowNonRoot: true,
    testOnlyHostRoot: hostRoot,
    testOnlySkipExecutableTrust: true,
    inspectMount: () => ({ identityHash: plan.predecessor.mountIdentityHash }),
    inspectConfigurationIdentity: () => plan.configIdentityHash,
    inspectReferences: () => [],
  });
  const lock = Object.freeze({
    identityHash: plan.deploymentLock.identityHash,
    assertHeld: () => true,
  });
  adapter.bindLock(lock);
  await assert.rejects(adapter.captureHostSnapshot({ plan, lock }),
    /immutable_release_host_snapshot_budget_exceeded/u);
  assert.equal(descriptorReads, 1,
    'the second artifact must be rejected from fstat before reading/base64 encoding');
});

test('committed boot verification accepts only exact queued start jobs', async (t) => {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-committed-root-'));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  const plan = immutableReleaseDeploymentPlanFixture();
  const snapshot = immutableReleaseHostSnapshotFixture(plan);
  for (const artifact of plan.installedArtifacts) {
    const selected = path.join(hostRoot, artifact.slice(1));
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    fs.writeFileSync(selected, `target:${artifact}\n`, { mode: 0o644 });
  }
  const adapterOptions = (runner) => ({
    runner,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowNonRoot: true,
    testOnlyHostRoot: hostRoot,
    testOnlySkipExecutableTrust: true,
    inspectMount: () => ({ identityHash: immutableReleaseFixtureHash('target-mount') }),
    inspectConfigurationIdentity: () => plan.configIdentityHash,
    inspectReferences: () => [],
    verifyPublishedRelease: async () => ({
      closureHash: immutableReleaseFixtureHash('committed-closure'),
      commit: plan.commit,
      releaseStateSnapshotHash: plan.releaseStateSnapshotHash,
    }),
  });
  const verify = async (runner) => {
    const adapter = createLinuxImmutableReleaseHostAdapter(adapterOptions(runner));
    const lock = Object.freeze({
      identityHash: plan.deploymentLock.identityHash,
      assertHeld: () => true,
    });
    adapter.bindLock(lock);
    const installedArtifactIdentityHash = hashRecord(
      'ImmutableReleaseInstalledArtifactInspection',
      adapter.inspectInstalledArtifacts(),
    );
    return adapter.verifyPostconditions({
      plan,
      lock,
      snapshot,
      closureHash: immutableReleaseFixtureHash('committed-closure'),
      postverificationHash: immutableReleaseFixtureHash('committed-postverify'),
      installedArtifactIdentityHash,
      phase: 'recovery',
    });
  };
  const runner = gatedSystemdRunner(plan, { bootQueuedStarts: true });
  assert.equal((await verify(runner)).status,
    'immutable_release_deployment_postconditions_verified');

  const wrongQueuedJobFor = plan.unitStates.find(({ activeState }) => activeState === 'active').name;
  await assert.rejects(verify(gatedSystemdRunner(plan, {
    bootQueuedStarts: true,
    wrongQueuedJobFor,
  })), /immutable_release_postcondition_state_mismatch/u);
});

test('systemd execution uses only the clean environment and ignores absent reviewed units', async () => {
  const calls = [];
  const runner = (executable, argumentsList, options) => {
    calls.push({ executable, argumentsList, options });
    if (argumentsList.includes('--property=LoadState')) {
      const unit = argumentsList.at(-1);
      return { status: 0, stdout: unit === 'strict-full-auto-runtime-adoption.service'
        ? 'not-found\n' : 'loaded\n', stderr: '' };
    }
    if (argumentsList.includes('--property=ActiveState')) {
      return { status: 0, stdout: 'inactive\n', stderr: '' };
    }
    if (argumentsList.includes('--property=UnitFileState')) {
      return { status: 0, stdout: 'disabled\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const adapter = createLinuxImmutableReleaseHostAdapter({
    runner,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowNonRoot: true,
    testOnlySkipExecutableTrust: true,
    inspectMount: () => { throw new Error('not used'); },
    inspectConfigurationIdentity: () => { throw new Error('not used'); },
    inspectReferences: () => [],
  });
  const plan = immutableReleaseDeploymentPlanFixture();
  const lock = Object.freeze({
    identityHash: plan.deploymentLock.identityHash,
    assertHeld: () => true,
  });
  adapter.bindLock(lock);
  const inspected = adapter.inspectUnits();
  const absent = inspected.find(({ name }) => name === 'strict-full-auto-runtime-adoption.service');
  assert.deepEqual(absent, {
    name: 'strict-full-auto-runtime-adoption.service',
    activeState: 'inactive',
    enablement: 'not-found',
  });
  const target = immutableReleaseTargetUnitStates(inspected)
    .find(({ name }) => name === absent.name);
  assert.equal(target.enablement,
    IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT[absent.name]);
  await adapter.quiesceConsumers({ plan, lock });
  const stop = calls.find(({ argumentsList }) => argumentsList[0] === 'stop');
  assert.ok(stop);
  assert.equal(stop.argumentsList.includes(absent.name), false);
  for (const call of calls) {
    assert.equal(call.executable, '/usr/bin/systemctl');
    assert.deepEqual(call.options.env, immutableReleaseDeploymentCleanEnvironment());
    assert.equal(call.options.shell, false);
  }
});

function procFixture(t, releasePath, {
  mountInfoNode = 'file',
  privateMountNamespace = true,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-proc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRoot = path.join(root, '123');
  fs.mkdirSync(path.join(processRoot, 'fd'), { recursive: true });
  fs.mkdirSync(path.join(processRoot, 'ns'));
  fs.mkdirSync(path.join(root, 'self', 'ns'), { recursive: true });
  fs.symlinkSync('mnt:[1]', path.join(root, 'self', 'ns', 'mnt'));
  fs.symlinkSync(privateMountNamespace ? 'mnt:[2]' : 'mnt:[1]',
    path.join(processRoot, 'ns', 'mnt'));
  fs.symlinkSync('/tmp', path.join(processRoot, 'cwd'));
  fs.symlinkSync('/usr/bin/node', path.join(processRoot, 'exe'));
  fs.symlinkSync('/', path.join(processRoot, 'root'));
  fs.writeFileSync(path.join(processRoot, 'maps'), '');
  const mountInfo = path.join(processRoot, 'mountinfo');
  if (mountInfoNode === 'directory') fs.mkdirSync(mountInfo);
  else fs.writeFileSync(mountInfo,
    `36 25 0:32 ${releasePath} /private/hepta ro,nosuid,nodev - ext4 /dev/root ro\n`);
  return root;
}

test('reference proof detects a release retained only by a private mount namespace', (t) => {
  const releasePath = immutableReleaseDeploymentPlanFixture().target.releasePath;
  const procRoot = procFixture(t, releasePath);
  assert.deepEqual(inspectImmutableReleaseProcessReferences({ releasePath, procRoot }), [
    '123:mountinfo:root',
  ]);
});

test('canonical live mount in the deployment mount namespace is not a process reference', (t) => {
  const releasePath = immutableReleaseDeploymentPlanFixture().target.releasePath;
  const procRoot = procFixture(t, releasePath, { privateMountNamespace: false });
  const mountInfo = path.join(procRoot, '123', 'mountinfo');
  fs.writeFileSync(mountInfo,
    `36 25 0:32 ${releasePath} /opt/hepta-paper ro,nosuid,nodev - ext4 /dev/root ro\n`);
  assert.deepEqual(inspectImmutableReleaseProcessReferences({ releasePath, procRoot }), []);
});

test('live-root fd and native map references are never hidden by the canonical mount exception', (t) => {
  const releasePath = immutableReleaseDeploymentPlanFixture().target.releasePath;
  const procRoot = procFixture(t, releasePath, { privateMountNamespace: false });
  fs.writeFileSync(path.join(procRoot, '123', 'mountinfo'),
    `36 25 0:32 ${releasePath} /opt/hepta-paper ro,nosuid,nodev - ext4 /dev/root ro\n`);
  fs.symlinkSync('/opt/hepta-paper/paper-core/bin/resident.mjs',
    path.join(procRoot, '123', 'fd', '7'));
  fs.writeFileSync(path.join(procRoot, '123', 'maps'),
    '7f000000-7f001000 r-xp 00000000 00:00 0 /opt/hepta-paper/native/resident.node\n');
  fs.writeFileSync(path.join(procRoot, '123', 'cmdline'), Buffer.from(
    '/usr/bin/node\0/opt/hepta-paper/paper-core/bin/unmanaged-resident.mjs\0',
  ));
  assert.deepEqual(inspectImmutableReleaseProcessReferences({ releasePath, procRoot }), [
    '123:cmdline',
    '123:fd:7',
    '123:maps',
  ]);
});

test('process cmdline evidence requires a NUL terminator and valid UTF-8', (t) => {
  const releasePath = immutableReleaseDeploymentPlanFixture().target.releasePath;
  const procRoot = procFixture(t, releasePath, { privateMountNamespace: false });
  const commandLinePath = path.join(procRoot, '123', 'cmdline');
  fs.writeFileSync(commandLinePath, Buffer.from('/usr/bin/node'));
  assert.throws(
    () => inspectImmutableReleaseProcessReferences({ releasePath, procRoot }),
    (error) => error?.code === 'immutable_release_proc_cmdline_invalid'
      && error?.reason === 'missing_nul_terminator',
  );
  fs.writeFileSync(commandLinePath, Buffer.from([0xc3, 0x28, 0]));
  assert.throws(
    () => inspectImmutableReleaseProcessReferences({ releasePath, procRoot }),
    (error) => error?.code === 'immutable_release_proc_cmdline_invalid'
      && error?.reason === 'invalid_utf8',
  );
});

test('mount namespace change around mountinfo is a fail-closed TOCTOU blocker', (t) => {
  const releasePath = immutableReleaseDeploymentPlanFixture().target.releasePath;
  const procRoot = procFixture(t, releasePath, { privateMountNamespace: false });
  fs.writeFileSync(path.join(procRoot, '123', 'mountinfo'),
    `36 25 0:32 ${releasePath} /opt/hepta-paper ro,nosuid,nodev - ext4 /dev/root ro\n`);
  const originalReadlink = fs.readlinkSync;
  let namespaceReads = 0;
  fs.readlinkSync = function readlinkWithNamespaceRace(candidate, ...remaining) {
    if (candidate === path.join(procRoot, '123', 'ns', 'mnt')) {
      namespaceReads += 1;
      return namespaceReads === 1 ? 'mnt:[1]' : 'mnt:[2]';
    }
    return originalReadlink.call(this, candidate, ...remaining);
  };
  t.after(() => { fs.readlinkSync = originalReadlink; });
  assert.throws(() => inspectImmutableReleaseProcessReferences({ releasePath, procRoot }),
    /immutable_release_proc_mount_namespace_changed:123/u);
});

test('unreadable or malformed proc evidence fails closed instead of being skipped', (t) => {
  const releasePath = immutableReleaseDeploymentPlanFixture().target.releasePath;
  const procRoot = procFixture(t, releasePath, { mountInfoNode: 'directory' });
  assert.throws(() => inspectImmutableReleaseProcessReferences({ releasePath, procRoot }),
    /immutable_release_proc_inspection_failed:123:mountinfo/u);
});

test('host artifact repository pins containment, metadata, snapshots, and atomic replacement', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-artifact-repository-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid();
  const gid = process.getgid();
  const file = path.join(root, 'artifact.txt');
  assert.equal(immutableReleasePathWithinOrSame(root, root), true);
  assert.equal(immutableReleasePathWithinOrSame(root, file), true);
  assert.equal(immutableReleasePathWithinOrSame(root, path.join(root, '..', 'escape')), false);
  assert.equal(existsNoFollow(path.join(root, 'missing')), false);
  fs.writeFileSync(file, 'before\n', { mode: 0o644 });
  const before = regularFileSnapshot(file, { includeContent: true });
  assert.equal(before.contentBase64, Buffer.from('before\n').toString('base64'));
  assert.throws(() => regularFileSnapshot(root, { includeContent: false }),
    /immutable_release_host_artifact_invalid/u);
  assert.equal(assertSafeArtifactParent(file, {
    expectedUid: uid, expectedGid: gid, boundary: root,
  }), root);
  assert.throws(() => assertSafeArtifactParent('relative.txt', {
    expectedUid: uid, expectedGid: gid, boundary: root,
  }), /immutable_release_host_artifact_path_invalid/u);

  writeArtifactAtomically(file, Buffer.from('after\n'), {
    uid, gid, mode: 0o640, expectedUid: uid, expectedGid: gid, boundary: root,
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'after\n');
  assert.equal(regularFileSnapshot(file, { includeContent: false }).mode & 0o777, 0o640);

  const destination = path.join(root, 'destination.txt');
  fs.symlinkSync(file, destination);
  assert.throws(() => writeArtifactAtomically(destination, Buffer.from('nope'), {
    uid, gid, mode: 0o640, expectedUid: uid, expectedGid: gid, boundary: root,
  }), /immutable_release_host_artifact_destination_invalid/u);

  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('synthetic_atomic_rename_failure'); };
  try {
    assert.throws(() => writeArtifactAtomically(path.join(root, 'failure.txt'), Buffer.from('x'), {
      uid, gid, mode: 0o640, expectedUid: uid, expectedGid: gid, boundary: root,
    }), /synthetic_atomic_rename_failure/u);
  } finally {
    fs.renameSync = originalRename;
  }
});

test('host adapter exercises fail-closed option, gate, restore, and cutover paths', async (t) => {
  const plan = immutableReleaseDeploymentPlanFixture();
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-host-paths-'));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(hostRoot, 'etc', 'systemd', 'system'), { recursive: true });
  for (const directory of [
    path.join(hostRoot, 'etc'),
    path.join(hostRoot, 'etc', 'systemd'),
    path.join(hostRoot, 'etc', 'systemd', 'system'),
  ]) fs.chmodSync(directory, 0o700);
  const baseOptions = {
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    testOnlyAllowNonRoot: true,
    testOnlyHostRoot: hostRoot,
    testOnlySkipExecutableTrust: true,
    inspectMount: () => ({ identityHash: plan.predecessor.mountIdentityHash }),
    inspectConfigurationIdentity: () => plan.configIdentityHash,
    inspectReferences: () => [],
  };
  assert.throws(() => createLinuxImmutableReleaseHostAdapter({
    ...baseOptions, runner: null,
  }), /immutable_release_linux_host_option_invalid/u);
  assert.throws(() => createLinuxImmutableReleaseHostAdapter({
    ...baseOptions, expectedUid: -1,
  }), /immutable_release_linux_host_root_required/u);
  const runner = gatedSystemdRunner(plan);
  const adapter = createLinuxImmutableReleaseHostAdapter({ ...baseOptions, runner });
  const lock = Object.freeze({
    identityHash: plan.deploymentLock.identityHash,
    assertHeld: () => true,
  });
  await assert.rejects(adapter.assertLockHeld({ lock: null,
    expectedIdentityHash: plan.deploymentLock.identityHash }),
  /immutable_release_deployment_lock_not_held/u);
  adapter.bindLock(lock);
  assert.throws(() => adapter.bindLock(lock), /immutable_release_deployment_lock_already_bound/u);
  assert.throws(() => adapter.assertDeploymentBootstrapCompatible({ candidateRoot: 'relative' }),
    /immutable_release_deployment_bootstrap_candidate_invalid/u);
  await assert.rejects(adapter.installHostArtifacts({ plan, lock }),
    /immutable_release_installer_test_root_execution_forbidden/u);
  await assert.rejects(adapter.postverifyRelease({
    plan, lock, closureHash: immutableReleaseFixtureHash('closure'),
  }), /immutable_release_postverify_adapter_required/u);
  await assert.rejects(adapter.assertReleaseUnreferenced({
    plan, lock, releasePath: '/tmp/forbidden-release',
  }), /immutable_release_reference_scan_path_forbidden/u);
  await adapter.cutoverMount({ plan, lock });
  await adapter.rollbackMount({ plan, lock });

  const notReady = createLinuxImmutableReleaseHostAdapter({
    ...baseOptions,
    runner: gatedSystemdRunner(plan, { gateActive: 'inactive' }),
  });
  assert.throws(() => notReady.inspectRecoveryGate(),
    /immutable_release_deployment_recovery_gate_not_ready/u);
  const unsupportedState = createLinuxImmutableReleaseHostAdapter({
    ...baseOptions,
    runner: (_executable, argumentsList) => {
      const property = argumentsList.find((argument) => argument.startsWith('--property='))
        ?.slice('--property='.length);
      if (property === 'LoadState') return { status: 0, stdout: 'loaded\n', stderr: '' };
      if (property === 'ActiveState') return { status: 0, stdout: 'bogus\n', stderr: '' };
      return { status: 0, stdout: 'disabled\n', stderr: '' };
    },
  });
  assert.throws(() => unsupportedState.inspectUnits(),
    /immutable_release_unit_state_unsupported/u);
  adapter.unbindLock(lock);
});
