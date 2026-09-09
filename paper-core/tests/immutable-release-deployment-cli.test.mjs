import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectImmutableReleaseDeploymentExecutorBoundary,
} from '../bin/immutable-release-deploy.mjs';
import {
  inspectImmutableReleaseDeploymentExecutorBoundary as inspectStandaloneExecutorBoundary,
  inspectSealedExecutorClosure,
  inspectSealedExecutorTree,
} from '../bin/immutable-release-deploy-validation.mjs';
import {
  assertImmutableReleaseDeploymentPort,
  createUnsupportedImmutableReleaseDeploymentPort,
} from '../../paper-ports/immutable-release-deployment-port.mjs';
import {
  immutableReleaseDeploymentUsage,
  parseImmutableReleaseDeploymentArguments,
  runImmutableReleaseDeploymentCli,
} from '../../paper-composition/bootstrap/immutable-release-deployment-cli.mjs';
import {
  createProductionImmutableReleaseDeployment,
} from '../../paper-composition/bootstrap/immutable-release-deployment-composition.mjs';
import {
  IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_RECOVERY_UNIT,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import {
  immutableReleaseDeploymentPlanFixture,
  immutableReleaseHostSnapshotFixture,
} from './support/immutable-release-deployment-fixture.mjs';
import {
  inspectImmutableReleaseDeploymentLock,
} from '../../paper-adapters/runtime/immutable-release-deployment-lock-repository.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = path.join(workspaceRoot, 'paper-core', 'bin', 'immutable-release-deploy.mjs');
const SHA256 = (digit = 'a') => `sha256:${digit.repeat(64)}`;

function productionProvenanceFixture(root) {
  return {
    ...currentCodeProvenance({
      workspaceRoot: root,
      allowReleaseCommitEnvironment: false,
      ignoreSubmoduleWorktreeStatus: true,
    }),
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
  };
}

function runGit(root, ...args) {
  const result = spawnSync('/usr/bin/git', ['-c', `safe.directory=${root}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function temporaryCandidate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-composition-candidate-'));
  fs.mkdirSync(path.join(root, 'paper-core', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"composition-fixture","version":"0.21.0"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'),
    '{"name":"composition-fixture","version":"0.21.0","packages":{}}\n');
  fs.writeFileSync(path.join(root, 'paper-core', 'config', 'release-dependency-tree.v1.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'paper-core', 'deploy'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'paper-core', 'deploy', 'hepta-immutable-release-recovery.service'),
    'bootstrap:paper-core/deploy/hepta-immutable-release-recovery.service\n',
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(root, 'paper-core', 'deploy', 'hepta-immutable-release-deploy'),
    'bootstrap:paper-core/deploy/hepta-immutable-release-deploy\n',
    { mode: 0o755 },
  );
  runGit(root, 'init', '-q');
  runGit(root, 'config', 'user.email', 'composition-fixture@example.invalid');
  runGit(root, 'config', 'user.name', 'Composition Fixture');
  runGit(root, 'add', '.');
  runGit(root, 'commit', '-qm', 'composition fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function hostSystemdRunner(planUnits = IMMUTABLE_RELEASE_CONSUMER_UNITS) {
  const units = new Map(planUnits.map((unit) => [unit.name || unit, unit]));
  return (_executable, args) => {
    const property = args.find((value) => value.startsWith('--property='))
      ?.slice('--property='.length);
    const unitName = args.at(-1);
    if (unitName === IMMUTABLE_RELEASE_RECOVERY_UNIT) {
      const values = {
        LoadState: 'loaded',
        ActiveState: 'active',
        UnitFileState: 'enabled',
        FragmentPath: `/etc/systemd/system/${IMMUTABLE_RELEASE_RECOVERY_UNIT}`,
        DropInPaths: '',
        NeedDaemonReload: 'no',
      };
      return { status: 0, stdout: `${values[property] ?? ''}\n`, stderr: '' };
    }
    const unit = units.get(unitName);
    const values = {
      LoadState: unit?.enablement === 'not-found' ? 'not-found' : 'loaded',
      ActiveState: unit?.activeState || 'inactive',
      UnitFileState: unit?.enablement || 'disabled',
      Requires: IMMUTABLE_RELEASE_RECOVERY_UNIT,
      After: IMMUTABLE_RELEASE_RECOVERY_UNIT,
      FragmentPath: `/etc/systemd/system/${unitName}`,
      DropInPaths: '',
      NeedDaemonReload: 'no',
      Job: '',
    };
    return { status: 0, stdout: `${values[property] ?? ''}\n`, stderr: '' };
  };
}

function writeBootstrapFixture(root, candidateRoot) {
  const files = [
    [
      '/etc/systemd/system/hepta-immutable-release-recovery.service',
      'paper-core/deploy/hepta-immutable-release-recovery.service',
      0o644,
    ],
    [
      '/usr/libexec/hepta-paper/hepta-immutable-release-deploy',
      'paper-core/deploy/hepta-immutable-release-deploy',
      0o755,
    ],
  ];
  for (const [installedPath, candidatePath, mode] of files) {
    const installed = path.join(root, installedPath.slice(1));
    const candidate = path.join(candidateRoot, candidatePath);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(installed, `bootstrap:${candidatePath}\n`, { mode });
    fs.writeFileSync(candidate, `bootstrap:${candidatePath}\n`, { mode });
    fs.chmodSync(installed, mode);
    fs.chmodSync(candidate, mode);
  }
}

function rootOwnedTemporaryLock(t) {
  if (process.geteuid?.() !== 0) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-composition-lock-'));
  fs.chmodSync(root, 0o711);
  const lockPath = path.join(root, 'deployment.lock');
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  const descriptor = fs.openSync(lockPath, fs.constants.O_RDWR);
  const acquired = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
    stdio: ['ignore', 'pipe', 'pipe', descriptor],
  });
  assert.equal(acquired.status, 0, acquired.stderr);
  const inspected = inspectImmutableReleaseDeploymentLock({
    lockPath,
    expectedUid: 0,
    expectedGid: 0,
  });
  t.after(() => {
    try { fs.closeSync(descriptor); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { lockPath, descriptor, identityHash: inspected.identityHash };
}

test('CLI exposes only plan, confirmed execute, and recovery with absolute inputs', () => {
  assert.deepEqual(parseImmutableReleaseDeploymentArguments([
    'plan', '--workspace', workspaceRoot,
  ]), {
    help: false,
    command: 'plan',
    workspaceRoot,
    planFile: null,
    expectedPlanHash: null,
  });
  assert.deepEqual(parseImmutableReleaseDeploymentArguments(['recover']), {
    help: false,
    command: 'recover',
    workspaceRoot: null,
    planFile: null,
    expectedPlanHash: null,
  });
  assert.throws(() => parseImmutableReleaseDeploymentArguments([
    'recover', '--workspace', workspaceRoot,
  ]), /immutable_release_deployment_recovery_workspace_forbidden/u);
  assert.throws(() => parseImmutableReleaseDeploymentArguments([
    'execute', '--workspace', workspaceRoot, '--plan-file', '/tmp/plan.json',
  ]), /immutable_release_deployment_plan_hash_confirmation_required/u);
  assert.throws(() => parseImmutableReleaseDeploymentArguments([
    'plan', '--workspace', 'relative',
  ]), /immutable_release_deployment_workspace_absolute_path_required/u);
  assert.equal(JSON.stringify(immutableReleaseDeploymentUsage()).includes('provider'), true);
});

test('direct Node execution fails before deployment imports without the installed launcher', () => {
  const result = spawnSync('/usr/bin/node', [entrypoint, '--help'], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp',
      NODE_PATH: '/tmp/attacker',
    },
    shell: false,
  });
  assert.equal(result.status, 126);
  assert.match(result.stderr, /immutable_release_deployment_installed_launcher_required/u);
  assert.equal(result.stdout, '');
});

test('a spoofed launcher marker cannot authorize a writable candidate executor', (t) => {
  t.mock.method(fs, 'realpathSync', () => assert.fail('reject noncanonical input before filesystem reads'));
  assert.throws(() => inspectImmutableReleaseDeploymentExecutorBoundary({
    entrypointPath: entrypoint,
    launcherMarker: 'sealed-v1',
    effectiveUid: 0,
    mountInfoText: '1 0 0:1 / / rw - ext4 /dev/root rw\n',
  }), /immutable_release_deployment_executor_not_sealed/u);
});

test('executor boundary rejects launcher, root, store and sealed-path drift before filesystem trust', () => {
  assert.throws(() => inspectImmutableReleaseDeploymentExecutorBoundary({
    launcherMarker: null,
    effectiveUid: 0,
  }), /immutable_release_deployment_installed_launcher_required/u);
  assert.throws(() => inspectImmutableReleaseDeploymentExecutorBoundary({
    launcherMarker: 'sealed-v1',
    effectiveUid: process.geteuid(),
  }), /immutable_release_deployment_root_required/u);
  assert.throws(() => inspectImmutableReleaseDeploymentExecutorBoundary({
    launcherMarker: 'sealed-v1',
    effectiveUid: 0,
    executorRoot: '/tmp/untrusted-executor',
  }), /immutable_release_deployment_executor_root_invalid/u);
  const releaseHash = '1'.repeat(40);
  const executorRoot = `/opt/hepta-paper-releases/${releaseHash}`;
  assert.throws(() => inspectImmutableReleaseDeploymentExecutorBoundary({
    launcherMarker: 'sealed-v1',
    effectiveUid: 0,
    executorRoot,
    entrypointPath: `${executorRoot}/paper-core/bin/immutable-release-deploy.mjs`,
  }), /immutable_release_deployment_executor_missing/u);
});

test('installed launcher clears the environment and selects only the durable predecessor executor', () => {
  const launcher = fs.readFileSync(path.join(
    workspaceRoot, 'paper-core', 'deploy', 'hepta-immutable-release-deploy',
  ), 'utf8');
  assert.match(launcher, /exec \/usr\/bin\/env -i/u);
  assert.match(launcher, /intent\?\.plan\?\.predecessor\?\.releasePath/u);
  assert.doesNotMatch(launcher, /intent\?\.plan\?\.target\?\.releasePath/u);
  assert.match(launcher,
    /executor=\$executor_root\/paper-core\/bin\/immutable-release-deploy\.mjs/u);
  assert.match(launcher, /HEPTA_IMMUTABLE_DEPLOY_EXECUTOR_ROOT="\$executor_root"/u);
  assert.match(launcher, /"\$executor" "\$@"/u);
  assert.doesNotMatch(launcher, /NODE_OPTIONS|NODE_PATH|\$PATH/u);
});

test('injected CLI composition remains testable without touching the host', async () => {
  let created = null;
  let output = '';
  const status = await runImmutableReleaseDeploymentCli({
    argv: ['plan', '--workspace', workspaceRoot],
    stdout: { write(value) { output += value; } },
    stderr: { write() { assert.fail('unexpected stderr'); } },
    releaseStateAdapters: {
      inspectReleaseState() {},
      assertReleaseReady() {},
    },
    createDeployment(options) {
      created = options;
      return { transaction: { async plan() { return { fixture: true }; } } };
    },
  });
  assert.equal(status, 0);
  assert.equal(created.candidateWorkspaceRoot, workspaceRoot);
  assert.equal(created.trustedPredecessorClosureHash, null);
  assert.deepEqual(JSON.parse(output), { fixture: true });
});

test('deployment port rejects incomplete adapters and exposes explicit unsupported operations', () => {
  assert.throws(() => assertImmutableReleaseDeploymentPort(null),
    /immutable_release_deployment_port_required/u);
  assert.throws(() => assertImmutableReleaseDeploymentPort({}), (error) => (
    error?.message === 'immutable_release_deployment_port_incomplete'
      && error.missingMethods.length > 10
  ));
  assert.throws(() => createUnsupportedImmutableReleaseDeploymentPort(),
    /immutable_release_deployment_inspector_required/u);
  const unsupported = createUnsupportedImmutableReleaseDeploymentPort({
    inspectDeployment: () => ({ status: 'inspection-only' }),
  });
  assert.equal(assertImmutableReleaseDeploymentPort(unsupported), unsupported);
  assert.deepEqual(unsupported.inspectDeployment(), { status: 'inspection-only' });
  for (const [name, operation] of Object.entries(unsupported)) {
    if (name === 'inspectDeployment' || name === 'cleanupCandidate') continue;
    assert.throws(() => operation(), new RegExp(
      `immutable_release_deployment_host_operation_unsupported:${name}`, 'u',
    ));
  }
  assert.doesNotThrow(() => unsupported.cleanupCandidate());
});

test('sealed executor validators cover tree ownership, symlinks, modes, and closure hashing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-executor-validator-'));
  t.after(() => {
    try { fs.chmodSync(path.join(root, 'nested'), 0o755); } catch {}
    try { fs.chmodSync(path.join(root, 'deployment-closure'), 0o755); } catch {}
    try { fs.chmodSync(root, 0o755); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'nested'), { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'entry.mjs'), 'export default 1;\n', { mode: 0o444 });
  fs.chmodSync(path.join(root, 'entry.mjs'), 0o444);
  fs.writeFileSync(path.join(root, 'nested', 'tool'), '#!/bin/sh\n', { mode: 0o555 });
  fs.chmodSync(path.join(root, 'nested', 'tool'), 0o555);
  fs.chmodSync(path.join(root, 'nested'), 0o555);
  fs.chmodSync(root, 0o555);
  assert.equal(inspectSealedExecutorTree(root, {
    expectedUid: process.getuid(), expectedGid: process.getgid(),
  }), 4);
  fs.chmodSync(path.join(root, 'nested'), 0o755);
  fs.symlinkSync('../entry.mjs', path.join(root, 'nested', 'inside-link'));
  fs.chmodSync(path.join(root, 'nested'), 0o555);
  assert.equal(inspectSealedExecutorTree(root, {
    expectedUid: process.getuid(), expectedGid: process.getgid(),
  }), 5);
  fs.chmodSync(path.join(root, 'nested'), 0o755);
  fs.chmodSync(path.join(root, 'nested'), 0o755);
  fs.unlinkSync(path.join(root, 'nested', 'inside-link'));
  fs.symlinkSync('/tmp', path.join(root, 'nested', 'outside-link'));
  fs.chmodSync(path.join(root, 'nested'), 0o555);
  assert.throws(() => inspectSealedExecutorTree(root, {
    expectedUid: process.getuid(), expectedGid: process.getgid(),
  }), /immutable_release_deployment_executor_external_symlink_forbidden/u);
  fs.chmodSync(path.join(root, 'nested'), 0o755);
  fs.unlinkSync(path.join(root, 'nested', 'outside-link'));
  fs.chmodSync(path.join(root, 'nested'), 0o555);
  fs.chmodSync(path.join(root, 'entry.mjs'), 0o644);
  assert.throws(() => inspectSealedExecutorTree(root, {
    expectedUid: process.getuid(), expectedGid: process.getgid(),
  }), /immutable_release_deployment_executor_file_mode_invalid/u);
  fs.chmodSync(path.join(root, 'entry.mjs'), 0o444);

  const closureRoot = path.join(root, 'deployment-closure');
  fs.chmodSync(root, 0o755);
  fs.mkdirSync(closureRoot, { mode: 0o755 });
  const payload = { version: 1, kind: 'ToolClosureFixture' };
  const closureHash = `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(payload)).digest('hex')}`;
  const closurePath = path.join(closureRoot, 'TOOL-CLOSURE.json');
  fs.writeFileSync(closurePath, `${JSON.stringify({ ...payload, closureHash })}\n`, {
    mode: 0o644,
  });
  fs.chmodSync(closurePath, 0o444);
  fs.chmodSync(closureRoot, 0o555);
  fs.chmodSync(root, 0o555);
  assert.equal(inspectSealedExecutorClosure(root, {
    expectedUid: process.getuid(), expectedGid: process.getgid(),
  }), closureHash);
  fs.chmodSync(closurePath, 0o644);
  assert.throws(() => inspectSealedExecutorClosure(root, {
    expectedUid: process.getuid(), expectedGid: process.getgid(),
  }), /immutable_release_deployment_executor_closure_invalid/u);
});

test('production deployment composition wires guarded adapters without touching a host', async (t) => {
  assert.throws(() => createProductionImmutableReleaseDeployment(),
    /immutable_release_deployment_release_state_adapter_required/u);
  assert.throws(() => createProductionImmutableReleaseDeployment({
    candidateWorkspaceRoot: 'relative',
    inspectReleaseState() {},
    assertReleaseReady() {},
  }), /immutable_release_deployment_candidate_workspace_invalid/u);
  const invalidCandidateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-invalid-candidate-'));
  const invalidCandidateFile = path.join(invalidCandidateRoot, 'file');
  const invalidCandidateLink = path.join(invalidCandidateRoot, 'link');
  fs.writeFileSync(invalidCandidateFile, 'not-a-directory\n');
  fs.symlinkSync(invalidCandidateFile, invalidCandidateLink);
  t.after(() => fs.rmSync(invalidCandidateRoot, { recursive: true, force: true }));
  assert.throws(() => createProductionImmutableReleaseDeployment({
    candidateWorkspaceRoot: invalidCandidateFile,
    inspectReleaseState() {},
    assertReleaseReady() {},
  }), /immutable_release_deployment_candidate_workspace_invalid/u);
  assert.throws(() => createProductionImmutableReleaseDeployment({
    candidateWorkspaceRoot: invalidCandidateLink,
    inspectReleaseState() {},
    assertReleaseReady() {},
  }), /immutable_release_deployment_candidate_workspace_invalid/u);
  const intentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-intent-root-'));
  fs.chmodSync(intentRoot, 0o700);
  t.after(() => fs.rmSync(intentRoot, { recursive: true, force: true }));
  const deployment = createProductionImmutableReleaseDeployment({
    candidateWorkspaceRoot: null,
    inspectReleaseState() {},
    assertReleaseReady() {},
    hostAdapterOptions: {
      testOnlyAllowNonRoot: true,
      testOnlySkipExecutableTrust: true,
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
      inspectMount: () => ({ identityHash: 'sha256:fixture-mount' }),
      inspectConfigurationIdentity: () => 'sha256:fixture-config',
      inspectReferences: () => [],
    },
    intentRepositoryOptions: {
      root: intentRoot,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      testOnlyAllowUnpinnedRoot: true,
    },
  });
  assert.ok(deployment.transaction);
  const calls = [
    ['inspectDeployment', undefined],
    ['materializeCandidate', { plan: {} }],
    ['generateAndVerifyClosure', { prepared: {} }],
    ['sealAndPublishCandidate', { plan: {}, prepared: {} }],
    ['captureHostSnapshot', { plan: {}, lock: {} }],
    ['quiesceConsumers', { plan: {}, lock: {} }],
    ['assertReleaseUnreferenced', { plan: {}, lock: {}, releasePath: '/tmp/x' }],
    ['cutoverMount', { plan: {}, lock: {} }],
    ['installHostArtifacts', { plan: {}, lock: {} }],
    ['postverifyRelease', { plan: {}, lock: {}, closureHash: 'sha256:fixture' }],
    ['restoreUnitStates', { plan: {}, lock: {}, snapshot: {} }],
    ['verifyPostconditions', { plan: {}, lock: {}, snapshot: {} }],
    ['rollbackHostArtifacts', { plan: {}, lock: {}, snapshot: {} }],
    ['rollbackMount', { plan: {}, lock: {} }],
    ['verifyRollback', { plan: {}, lock: {}, snapshot: {} }],
    ['cleanupCandidate', { plan: {} }],
  ];
  for (const [name, options] of calls) {
    const operation = deployment.port[name];
    assert.equal(typeof operation, 'function', name);
    await assert.rejects(Promise.resolve().then(() => operation(options)),
      /(?:immutable_release_|paths\[0\]|Cannot read properties)/u,
      name);
  }
  await assert.rejects(deployment.port.acquireExclusiveDeploymentLock({
    lockPath: '/run/hepta-paper-deployment/deployment.lock', expectedIdentityHash: 'bad',
  }), /immutable_release_/u);
  await assert.rejects(deployment.recover(), /(?:immutable_release_|EACCES)/u);
});

test('production composition preflight binds a temporary candidate and fails closed on stale lineage', async (t) => {
  if (!fs.existsSync('/opt/hepta-paper')
    || !fs.existsSync('/run/hepta-paper-deployment/deployment.lock')) {
    t.skip('production live-root and lock fixtures are unavailable');
    return;
  }
  const candidateRoot = temporaryCandidate(t);
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-composition-host-'));
  const intentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-composition-intent-'));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(intentRoot, { recursive: true, force: true }));
  writeBootstrapFixture(hostRoot, candidateRoot);

  const liveCommit = runGit('/opt/hepta-paper', 'rev-parse', 'HEAD');
  const mount = {
    liveRoot: '/opt/hepta-paper',
    unit: 'opt-hepta\\x2dpaper.mount',
    releasePath: `/opt/hepta-paper-releases/${liveCommit}`,
    sourceCommit: liveCommit,
    identityHash: SHA256('b'),
  };
  const baseOptions = {
    candidateWorkspaceRoot: candidateRoot,
    trustedPredecessorClosureHash: SHA256(),
    inspectReleaseState: () => ({ status: 'fixture-release-state' }),
    assertReleaseReady: () => ({ workspaceReleaseStateSnapshotHash: SHA256() }),
    hostAdapterOptions: {
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      testOnlyAllowNonRoot: true,
      testOnlyHostRoot: hostRoot,
      testOnlySkipExecutableTrust: true,
      runner: hostSystemdRunner(),
      inspectMount: () => mount,
      inspectConfigurationIdentity: () => SHA256('c'),
      inspectReferences: () => [],
    },
    intentRepositoryOptions: {
      root: intentRoot,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      testOnlyAllowUnpinnedRoot: true,
    },
  };

  const invalidPredecessor = createProductionImmutableReleaseDeployment({
    ...baseOptions,
    trustedPredecessorClosureHash: 'not-a-hash',
  });
  await assert.rejects(invalidPredecessor.port.inspectDeployment(),
    /immutable_release_deployment_trusted_predecessor_closure_required/u);

  const inspected = createProductionImmutableReleaseDeployment(baseOptions);
  await assert.rejects(inspected.port.inspectDeployment(),
    /release_environment_deployment_(?:lineage_mismatch|expected_closure_mismatch|closure_invalid)/u);
  await assert.rejects(inspected.port.materializeCandidate({
    plan: immutableReleaseDeploymentPlanFixture(),
  }), /(?:immutable_release_candidate_(?:predecessor_invalid|source_provenance_mismatch|store_invalid)|ENOENT)/u);

  const mountDrift = createProductionImmutableReleaseDeployment({
    ...baseOptions,
    hostAdapterOptions: {
      ...baseOptions.hostAdapterOptions,
      inspectMount: () => ({ ...mount, sourceCommit: '0'.repeat(40) }),
    },
  });
  await assert.rejects(mountDrift.port.inspectDeployment(),
    /immutable_release_predecessor_mount_commit_mismatch/u);
});

test('production composition exposes durable intent and guarded candidate operations', async (t) => {
  const intentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-composition-intent-'));
  t.after(() => fs.rmSync(intentRoot, { recursive: true, force: true }));
  const deployment = createProductionImmutableReleaseDeployment({
    candidateWorkspaceRoot: null,
    inspectReleaseState() {},
    assertReleaseReady() {},
    hostAdapterOptions: {
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      testOnlyAllowNonRoot: true,
      testOnlySkipExecutableTrust: true,
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
      inspectMount: () => ({ identityHash: SHA256('d') }),
      inspectConfigurationIdentity: () => SHA256('e'),
      inspectReferences: () => [],
    },
    intentRepositoryOptions: {
      root: intentRoot,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
      testOnlyAllowUnpinnedRoot: true,
    },
  });
  const plan = immutableReleaseDeploymentPlanFixture();
  const intent = deployment.port.beginDeploymentIntent({ plan });
  assert.equal(intent.phase, 'prepared');
  const attempted = deployment.port.recordDeploymentIntentPhase({
    intent,
    phase: 'materialize_attempted',
  });
  assert.equal(attempted.phase, 'materialize_attempted');
  assert.throws(() => deployment.port.completeDeploymentIntent({
    intent: attempted,
    disposition: 'committed',
  }), /immutable_release_deployment_intent_disposition_invalid/u);

  const snapshot = immutableReleaseHostSnapshotFixture(plan);
  let committed = attempted;
  const transitions = [
    ['materialized'],
    ['closure_verified', { closureHash: SHA256('1') }],
    ['publish_attempted'],
    ['published', { publicationIdentityHash: SHA256('2') }],
    ['snapshot_persisted', {}, snapshot],
    ['quiesce_attempted'],
    ['quiesced'],
    ['cutover_attempted'],
    ['cutover_completed'],
    ['install_attempted'],
    ['install_completed', { installedArtifactIdentityHash: SHA256('3') }],
    ['postverify_completed', { postverificationHash: SHA256('4') }],
    ['unit_restore_attempted'],
    ['unit_restore_completed'],
    ['committed'],
  ];
  for (const [phase, progress = {}, hostSnapshot] of transitions) {
    committed = deployment.port.recordDeploymentIntentPhase({
      intent: committed,
      phase,
      progress,
      ...(hostSnapshot === undefined ? {} : { hostSnapshot }),
    });
  }
  assert.equal(committed.phase, 'committed');
  assert.equal(deployment.port.completeDeploymentIntent({
    intent: committed,
    disposition: 'committed',
  }), true);

  await assert.rejects(deployment.port.materializeCandidate({ plan }),
    /immutable_release_deployment_candidate_workspace_required/u);
  await assert.rejects(deployment.port.generateAndVerifyClosure({
    prepared: {}, inheritedFromClosureHash: plan.predecessor.closureHash,
  }), /(?:immutable_release_|Cannot read properties|paths\[0\])/u);
  await assert.rejects(deployment.port.sealAndPublishCandidate({ plan, prepared: {} }),
    /(?:immutable_release_|Cannot read properties|paths\[0\]|path.*must be (?:a string|of type string))/u);
  // A portable test must not clean a real host release store, even when present.
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === path.dirname(plan.target.releasePath)) {
      throw Object.assign(new Error('fixture store unavailable'), { code: 'ENOENT' });
    }
    return lstat(file, ...args);
  });
  await assert.rejects(deployment.port.cleanupCandidate({
    plan,
    rollbackComplete: false,
    publishAttempted: false,
  }), { code: 'immutable_release_candidate_cleanup_store_invalid' });
  t.mock.restoreAll();
  await assert.rejects(deployment.port.cleanupCandidate({
    plan,
    lock: { identityHash: plan.deploymentLock.identityHash },
    rollbackComplete: true,
    publishAttempted: true,
  }), /immutable_release_deployment_lock_not_held/u);
  await assert.rejects(deployment.port.recoverUnfinishedDeployment({
    lock: { identityHash: plan.deploymentLock.identityHash },
  }), /immutable_release_deployment_lock_not_held/u);
});

test('production composition adopts an inherited lock and post-verifies through the real closure readers',
  { skip: process.geteuid?.() !== 0 ? 'root-owned lock policy is unavailable' : false },
  async (t) => {
    const lockFixture = rootOwnedTemporaryLock(t);
    assert.ok(lockFixture);
    const intentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-composition-intent-'));
    t.after(() => fs.rmSync(intentRoot, { recursive: true, force: true }));
    const common = {
      candidateWorkspaceRoot: null,
      inspectReleaseState() {},
      assertReleaseReady: ({ expectedSnapshotHash }) => ({
        workspaceReleaseStateSnapshotHash: expectedSnapshotHash,
      }),
      hostAdapterOptions: {
        expectedUid: 0,
        expectedGid: 0,
        testOnlyAllowNonRoot: true,
        testOnlySkipExecutableTrust: true,
        runner: () => ({ status: 0, stdout: '', stderr: '' }),
        inspectMount: () => ({ identityHash: SHA256('f') }),
        inspectConfigurationIdentity: () => SHA256('0'),
        inspectReferences: () => [],
      },
      intentRepositoryOptions: {
        root: intentRoot,
        expectedUid: process.getuid(),
        expectedGid: process.getgid(),
        testOnlyAllowUnpinnedRoot: true,
      },
      inheritedLockFd: lockFixture.descriptor,
    };
    const inherited = createProductionImmutableReleaseDeployment(common);
    const lock = await inherited.port.acquireExclusiveDeploymentLock({
      lockPath: lockFixture.lockPath,
      expectedIdentityHash: lockFixture.identityHash,
    });
    assert.equal(lock.identityHash, lockFixture.identityHash);
    assert.equal(lock.assertHeld(), true);
    assert.equal(lock.release(), true);
    assert.equal(lock.release(), false);

    const acquired = createProductionImmutableReleaseDeployment({
      ...common,
      inheritedLockFd: null,
    });
    const exclusive = await acquired.port.acquireExclusiveDeploymentLock({
      lockPath: lockFixture.lockPath,
      expectedIdentityHash: lockFixture.identityHash,
    });
    const plan = immutableReleaseDeploymentPlanFixture();
    const { planHash: _ignoredPlanHash, ...planPayload } = plan;
    const rebound = {
      ...planPayload,
      deploymentLock: {
        ...plan.deploymentLock,
        identityHash: lockFixture.identityHash,
      },
    };
    const lockBoundPlan = {
      ...rebound,
      planHash: hashRecord('ImmutableReleaseDeploymentPlan', rebound),
    };
    await assert.rejects(acquired.port.postverifyRelease({
      plan: lockBoundPlan,
      lock: exclusive,
      closureHash: SHA256('1'),
    }), /immutable_release_postverify_provenance_mismatch|release_environment_deployment_/u);

    const liveProvenance = productionProvenanceFixture('/opt/hepta-paper');
    const liveSnapshotPayload = {
      ...lockBoundPlan.releaseStateSnapshot,
      headCommit: liveProvenance.commit,
      releaseState: {
        ...lockBoundPlan.releaseStateSnapshot.releaseState,
        version: liveProvenance.packageVersion,
      },
    };
    const liveSnapshot = {
      ...liveSnapshotPayload,
      workspaceReleaseStateSnapshotHash: hashBytes(JSON.stringify(liveSnapshotPayload)),
    };
    const livePlanPayload = {
      ...lockBoundPlan,
      commit: liveProvenance.commit,
      commitTree: liveProvenance.commitTree,
      packageVersion: liveProvenance.packageVersion,
      codeProvenance: liveProvenance,
      codeProvenanceHash: hashRecord(
        'ImmutableReleaseDeploymentCodeProvenance', liveProvenance,
      ),
      releaseStateSnapshot: liveSnapshot,
      releaseStateSnapshotHash: liveSnapshot.workspaceReleaseStateSnapshotHash,
      target: {
        ...lockBoundPlan.target,
        releasePath: `/opt/hepta-paper-releases/${liveProvenance.commit}`,
      },
    };
    const livePlan = {
      ...livePlanPayload,
      planHash: hashRecord('ImmutableReleaseDeploymentPlan', livePlanPayload),
    };
    await assert.rejects(acquired.port.postverifyRelease({
      plan: livePlan,
      lock: exclusive,
      closureHash: SHA256('1'),
    }), /release_environment_deployment_/u);
    const recovery = await acquired.port.recoverUnfinishedDeployment({ lock: exclusive });
    assert.equal(recovery.status, 'immutable_release_deployment_recovery_not_required');
    const cleaned = await acquired.port.cleanupCandidate({
      plan: lockBoundPlan,
      lock: exclusive,
      rollbackComplete: true,
      publishAttempted: true,
      published: { publicationIdentityHash: null },
    });
    assert.equal(cleaned.publishedCleaned, false);
    assert.equal(exclusive.release(), true);
  });

test('standalone executor boundary validator proves a temporary sealed release and inherited lock',
  (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-boundary-validator-'));
    const releaseStore = path.join(base, 'releases');
    const sealedRoot = path.join(base, 'sealed');
    const selectedRoot = path.join(releaseStore, '2'.repeat(40));
    const entrypointPath = path.join(selectedRoot,
      'paper-core', 'bin', 'immutable-release-deploy.mjs');
    const closureRoot = path.join(selectedRoot, 'deployment-closure');
    const lockRoot = path.join(base, 'lock');
    const lockPath = path.join(lockRoot, 'deployment.lock');
    fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
    fs.mkdirSync(closureRoot, { recursive: true });
    fs.mkdirSync(lockRoot, { recursive: true });
    fs.writeFileSync(entrypointPath, '#!/usr/bin/env node\n', { mode: 0o644 });
    fs.chmodSync(entrypointPath, 0o444);
    const payload = { version: 1, kind: 'BoundaryClosureFixture' };
    const closureHash = `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(payload)).digest('hex')}`;
    const closurePath = path.join(closureRoot, 'TOOL-CLOSURE.json');
    fs.writeFileSync(closurePath, `${JSON.stringify({ ...payload, closureHash })}\n`, {
      mode: 0o644,
    });
    fs.chmodSync(closurePath, 0o444);
    for (const directory of [
      selectedRoot,
      path.join(selectedRoot, 'paper-core'),
      path.join(selectedRoot, 'paper-core', 'bin'),
      closureRoot,
    ]) fs.chmodSync(directory, 0o555);
    fs.chmodSync(releaseStore, 0o755);
    fs.writeFileSync(lockPath, '', { mode: 0o600 });
    fs.chmodSync(lockPath, 0o600);
    const descriptor = fs.openSync(lockPath, fs.constants.O_RDWR);
    t.after(() => {
      try { fs.closeSync(descriptor); } catch {}
      for (const file of [entrypointPath, closurePath, lockPath]) {
        try { fs.chmodSync(file, 0o644); } catch {}
      }
      for (const directory of [
        closureRoot,
        path.join(selectedRoot, 'paper-core', 'bin'),
        path.join(selectedRoot, 'paper-core'),
        selectedRoot,
        releaseStore,
        lockRoot,
        base,
      ]) {
        try { fs.chmodSync(directory, 0o755); } catch {}
      }
      fs.rmSync(base, { recursive: true, force: true });
    });
    const result = inspectStandaloneExecutorBoundary({
      entrypointPath,
      executorRoot: selectedRoot,
      sealedRoot,
      releaseStore,
      deploymentLock: lockPath,
      inheritedLockFd: descriptor,
      mountInfoText: '',
      installedLauncher: '/tmp/fixture-launcher',
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    });
    assert.equal(result.status, 'immutable_release_deployment_executor_verified');
    assert.equal(result.releasePath, selectedRoot);
    assert.equal(result.closureHash, closureHash);
    assert.throws(() => inspectStandaloneExecutorBoundary({
      entrypointPath,
      executorRoot: selectedRoot,
      sealedRoot,
      releaseStore,
      deploymentLock: lockPath,
      inheritedLockFd: descriptor,
      mountInfoText: `1 0 0:1 / ${selectedRoot}/nested ro - ext4 /dev/root ro\n`,
      installedLauncher: '/tmp/fixture-launcher',
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    }), /immutable_release_deployment_executor_nested_mount_forbidden/u);
  });
