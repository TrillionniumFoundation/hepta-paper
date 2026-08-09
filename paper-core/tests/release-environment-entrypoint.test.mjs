import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  RELEASE_ENVIRONMENT_ACTIONS,
  RELEASE_ENVIRONMENT_ELAN_HOME,
  RELEASE_ENVIRONMENT_LAUNCHER,
  RELEASE_ENVIRONMENT_ROOT,
  buildReleaseActionCommand,
  buildReleaseEnvironment,
  inspectDeploymentClosure,
  inspectProductionReleaseEnvironment,
  inspectReleaseEnvironmentLauncherBoundary,
  inspectReleaseMount,
  inspectRootOwnedTree,
  parseReleaseEnvironmentArguments,
  releaseEnvironmentActionPolicy,
  releaseEnvironmentUsage,
  runReleaseAction,
} from '../../paper-adapters/runtime/release-environment-entrypoint.mjs';
import {
  captureReleaseDependencyTree,
} from '../../paper-adapters/runtime/release-dependency-tree.mjs';
import {
  inspectComposedProductionReleaseEnvironment,
} from '../../paper-composition/bootstrap/release-environment-composition.mjs';
import { runReleaseEnvironmentCli } from '../bin/release-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcherPath = path.join(root, 'paper-core', 'deploy', 'hepta-paper-release-env');
const installerPath = path.join(
  root,
  'paper-core',
  'deploy',
  'install-hepta-paper-systemd-host.sh',
);

function cleanNodeTestEnvironment() {
  const environment = {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
  };
  if (process.env.NODE_V8_COVERAGE) {
    environment.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  }
  return environment;
}

function memoryStream() {
  let value = '';
  return Object.freeze({
    stream: Object.freeze({ write(chunk) { value += String(chunk); } }),
    value() { return value; },
  });
}

function fixtureSha(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fixtureGit(cwd, argumentsList) {
  const result = spawnSync('/usr/bin/git', ['-C', cwd, ...argumentsList], {
    encoding: 'utf8',
    env: cleanNodeTestEnvironment(),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createGitFixture(directory, content) {
  fs.mkdirSync(directory, { recursive: true });
  fixtureGit(directory, ['init', '--quiet']);
  fs.writeFileSync(path.join(directory, 'sealed.txt'), content);
  fixtureGit(directory, ['add', 'sealed.txt']);
  fixtureGit(directory, [
    '-c', 'user.name=Release Closure Fixture',
    '-c', 'user.email=release-closure@example.invalid',
    'commit', '--quiet', '-m', 'sealed fixture',
  ]);
  return Object.freeze({
    commit: fixtureGit(directory, ['rev-parse', 'HEAD']),
    tree: fixtureGit(directory, ['rev-parse', 'HEAD^{tree}']),
  });
}

function closureTree(directory, { readOnly = false } = {}) {
  return captureReleaseDependencyTree(directory, { readOnlyProjection: readOnly });
}

function fixtureTreeClaim(directory) {
  return Object.freeze({
    sourceTree: closureTree(directory),
    readOnlyTree: closureTree(directory, { readOnly: true }),
    sealedTree: closureTree(directory),
  });
}

function sealClosure(payload) {
  return Object.freeze({ ...payload, closureHash: fixtureSha(JSON.stringify(payload)) });
}

function writeClosure(workspaceRoot, closure) {
  const selected = path.join(workspaceRoot, 'deployment-closure', 'TOOL-CLOSURE.json');
  fs.chmodSync(selected, 0o644);
  fs.writeFileSync(selected, `${JSON.stringify(closure, null, 2)}\n`);
  fs.chmodSync(selected, 0o444);
}

function deploymentClosureFixture(t, {
  version = 2,
  inheritedFromClosureHash = `sha256:${'7'.repeat(64)}`,
} = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-env-closure-'));
  t.after(() => {
    for (const selected of [workspaceRoot, path.join(workspaceRoot, 'deployment-closure')]) {
      try {
        fs.chmodSync(selected, 0o755);
      } catch {
        // A path-substitution test may intentionally replace part of the fixture.
      }
    }
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });
  const elan = path.join(workspaceRoot, 'elan');
  const codex = path.join(workspaceRoot, 'codex-cli-0.144.1');
  fs.mkdirSync(elan);
  fs.mkdirSync(codex);
  fs.writeFileSync(path.join(elan, 'elan'), 'sealed elan\n', { mode: 0o755 });
  fs.writeFileSync(path.join(codex, 'codex'), 'sealed codex\n', { mode: 0o755 });
  const core = path.join(workspaceRoot, 'core');
  const sourceCas = path.join(workspaceRoot, 'runtime-images', 'r-scientific', 'source-cas');
  const coreIdentity = createGitFixture(core, 'sealed core\n');
  const sourceCasIdentity = createGitFixture(sourceCas, 'sealed source cas\n');
  const provenance = Object.freeze({
    version: 2,
    kind: 'CodeProvenance',
    packageVersion: '1.0.0-fixture',
    commit: 'a'.repeat(40),
    commitTree: 'b'.repeat(40),
    tags: Object.freeze([]),
    treeDirty: false,
    indexStateHash: `sha256:${'1'.repeat(64)}`,
    repositoryEntryCount: 12,
    repositoryContentHash: `sha256:${'2'.repeat(64)}`,
    worktreeStateHash: `sha256:${'3'.repeat(64)}`,
    evidenceEnvironment: 'isolated-test',
    evidenceClass: 'fixture',
  });
  const dependencyTree = Object.freeze({
    version: 1,
    kind: 'ReleaseDependencySourceTree',
    counts: Object.freeze({ entries: 1, directories: 1, files: 0, symlinks: 0 }),
    treeHash: `sha256:${'4'.repeat(64)}`,
  });
  const dependencyInspection = Object.freeze({
    version: 1,
    kind: 'ReleaseDependencyTreeInspection',
    status: 'release_dependency_tree_verified',
    contractHash: `sha256:${'5'.repeat(64)}`,
    lockfileHash: `sha256:${'6'.repeat(64)}`,
    tree: Object.freeze({ ...dependencyTree, kind: 'ReleaseDependencyReadOnlyTree' }),
    readOnly: true,
  });
  const payload = {
    version,
    kind: 'HeptaDeploymentToolClosure',
    ...(version === 2 ? { inheritedFromClosureHash } : {}),
    codeProvenance: provenance,
    dependencyInspection: Object.freeze({
      ...dependencyInspection,
      tree: dependencyTree,
      readOnly: false,
    }),
    tools: Object.freeze({
      elan: fixtureTreeClaim(elan),
      codexCli: fixtureTreeClaim(codex),
    }),
    submodules: Object.freeze({
      core: Object.freeze({
        path: 'core',
        ...coreIdentity,
        ...fixtureTreeClaim(core),
      }),
      rScientificSourceCas: Object.freeze({
        path: 'runtime-images/r-scientific/source-cas',
        ...sourceCasIdentity,
        ...fixtureTreeClaim(sourceCas),
      }),
    }),
    sealPolicy: Object.freeze({
      owner: 'root:root',
      directoriesMode: '0555',
      executableFilesMode: '0555',
      nonExecutableFilesMode: '0444',
    }),
  };
  const closure = sealClosure(payload);
  fs.mkdirSync(path.join(workspaceRoot, 'deployment-closure'));
  fs.writeFileSync(
    path.join(workspaceRoot, 'deployment-closure', 'TOOL-CLOSURE.json'),
    `${JSON.stringify(closure, null, 2)}\n`,
    { mode: 0o444 },
  );
  fs.chmodSync(path.join(workspaceRoot, 'deployment-closure'), 0o555);
  fs.chmodSync(workspaceRoot, 0o555);
  return Object.freeze({
    workspaceRoot,
    closure,
    provenance,
    dependencyInspection,
    inheritedFromClosureHash,
    options: Object.freeze({
      workspaceRoot,
      provenance,
      dependencyInspection,
      legacyV1ClosureHash: version === 1
        ? closure.closureHash
        : `sha256:${'6'.repeat(64)}`,
      approvedPredecessorClosureHashes: Object.freeze([inheritedFromClosureHash]),
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    }),
  });
}

test('release environment exposes only the reviewed closed action set', () => {
  assert.deepEqual(RELEASE_ENVIRONMENT_ACTIONS, [
    'release:state-gate',
    'formal:gate',
    'release:verify',
    'release:trust-gate',
    'store:trust-gate',
    'store:logical-integrity',
    'store:restore-drill',
    'assets:cold-volume-release-gate',
    'assets:cold-volume-cas-release-gate',
    'assets:cold-volume-cas-restore-drill',
    'offhost:worm-status',
    'offhost:worm-restore-drill',
  ]);
  for (const forbidden of [
    'submission', 'tag', 'hold', 'snapshot', 'key-provision', 'provider', 'shell',
  ]) {
    assert.equal(RELEASE_ENVIRONMENT_ACTIONS.some((action) => action.includes(forbidden)), false);
  }
  assert.deepEqual(releaseEnvironmentUsage().constraints, {
    root: '/opt/hepta-paper',
    elanHome: '/opt/hepta-paper/elan',
    ambientDynamicLoader: 'systemd_manager_or_clean_root_exec_required',
    preNodeEnvironment: 'installed_env_i_launcher_required',
    executionPrincipal: 'hepta-paper_action_scoped_groups_no_new_privileges',
    productionHoldMutation: 'forbidden',
    providerSecretEnvironment: 'not_inherited',
    releaseTagMutation: 'forbidden',
    liveSubmission: 'forbidden',
    releaseReadyPreflightActions: [],
    wormSnapshotMutation: 'forbidden',
  });
  assert.equal(
    releaseEnvironmentUsage().usage,
    `${RELEASE_ENVIRONMENT_LAUNCHER} <action> [--manifest <absolute-path>]`,
  );
  for (const action of RELEASE_ENVIRONMENT_ACTIONS) {
    assert.equal(
      releaseEnvironmentActionPolicy(action).releaseReadyPreflightRequired,
      false,
      action,
    );
  }
});

test('release environment argument parser rejects passthrough and nonabsolute manifests', () => {
  assert.deepEqual(parseReleaseEnvironmentArguments(['release:verify']), {
    help: false,
    action: 'release:verify',
    manifestPath: null,
  });
  assert.deepEqual(parseReleaseEnvironmentArguments([
    'offhost:worm-restore-drill',
    '--manifest',
    '/media/qian-qi/TOSHIBA_CLEAN3/snapshot/manifest.json',
  ]), {
    help: false,
    action: 'offhost:worm-restore-drill',
    manifestPath: '/media/qian-qi/TOSHIBA_CLEAN3/snapshot/manifest.json',
  });
  assert.throws(
    () => parseReleaseEnvironmentArguments(['release:verify', '--', 'sh']),
    /release_environment_arguments_forbidden/u,
  );
  assert.throws(
    () => parseReleaseEnvironmentArguments(['offhost:worm-snapshot']),
    /release_environment_action_forbidden/u,
  );
  assert.throws(
    () => parseReleaseEnvironmentArguments([
      'offhost:worm-restore-drill', '--manifest', 'relative.json',
    ]),
    /release_environment_manifest_absolute_path_required/u,
  );
});

test('release environment is rebuilt from a minimal deterministic allowlist', () => {
  const environment = buildReleaseEnvironment({ scratchRoot: '/tmp/release-env-test' });
  assert.equal(environment.ELAN_HOME, RELEASE_ENVIRONMENT_ELAN_HOME);
  assert.equal(environment.GIT_CONFIG_VALUE_0, RELEASE_ENVIRONMENT_ROOT);
  assert.equal(environment.HEPTA_PAPER_ASSET_ROOT, '/srv/hepta-paper/assets');
  assert.equal(environment.HEPTA_PAPER_RUNTIME_ROOT, '/var/lib/hepta-paper/runtime');
  assert.equal(environment.PATH, '/usr/bin:/bin');
  assert.equal(environment.HOME, '/tmp/release-env-test/home');
  assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, '/tmp/release-env-test/npm-globalrc');
  assert.equal(environment.NPM_CONFIG_USERCONFIG, '/tmp/release-env-test/npm-userrc');
  assert.notEqual(environment.NPM_CONFIG_GLOBALCONFIG, environment.NPM_CONFIG_USERCONFIG);
  for (const forbidden of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'HEPTA_AUTONOMOUS_AUTHOR_ENV_FILE',
    'HEPTA_AUTONOMOUS_SUBMISSION_ENV_FILE',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'SSH_AUTH_SOCK',
  ]) assert.equal(Object.hasOwn(environment, forbidden), false, forbidden);
  assert.equal(Object.hasOwn(environment, 'HEPTA_CAPABILITY_OWNER_PRIVATE_KEY'), false);
  for (const forbiddenAction of [
    'release:conformance-replay',
    'release:capability-refresh',
    'release:attest',
  ]) {
    assert.throws(() => buildReleaseEnvironment({
      scratchRoot: '/tmp/release-env-test',
      action: forbiddenAction,
    }), /release_environment_action_forbidden/u);
  }
});

test('mount gate binds a read-only mount to its exact commit release directory', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'release-env-mount-'));
  try {
    const workspace = path.join(fixture, 'active');
    const releases = path.join(fixture, 'releases');
    const commit = 'a'.repeat(40);
    const source = path.join(releases, commit);
    fs.mkdirSync(source, { recursive: true });
    fs.symlinkSync(source, workspace);
    const originalRealpath = fs.realpathSync;
    const originalLstat = fs.lstatSync;
    fs.realpathSync = (candidate) => (
      candidate === source ? source : originalRealpath(candidate)
    );
    fs.lstatSync = (candidate, options) => (
      candidate === workspace ? originalLstat(source, options) : originalLstat(candidate, options)
    );
    try {
      const mount = inspectReleaseMount({
        workspaceRoot: workspace,
        commit,
        releaseDirectory: releases,
        mountInfoText: `10 1 8:1 ${source} ${workspace} ro,nosuid,nodev - ext4 /dev/sda rw\n`,
      });
      assert.equal(mount.sourceRoot, source);
      assert.throws(() => inspectReleaseMount({
        workspaceRoot: workspace,
        commit,
        releaseDirectory: releases,
        mountInfoText: `10 1 8:1 ${source} ${workspace} rw,nosuid,nodev - ext4 /dev/sda rw\n`,
      }), /release_environment_mount_option_required:ro/u);
    } finally {
      fs.realpathSync = originalRealpath;
      fs.lstatSync = originalLstat;
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('tree gate rejects writable and escaping entries', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'release-env-tree-'));
  try {
    const uid = process.getuid();
    const gid = process.getgid();
    fs.writeFileSync(path.join(fixture, 'sealed.txt'), 'sealed\n', { mode: 0o444 });
    fs.writeFileSync(path.join(fixture, 'sealed-tool'), 'sealed tool\n', { mode: 0o555 });
    fs.symlinkSync('sealed.txt', path.join(fixture, 'inside-link'));
    fs.chmodSync(fixture, 0o555);
    const accepted = inspectRootOwnedTree({ workspaceRoot: fixture, expectedUid: uid, expectedGid: gid });
    assert.equal(accepted.status, 'release_environment_root_owned_tree_verified');
    fs.chmodSync(path.join(fixture, 'sealed.txt'), 0o644);
    assert.throws(
      () => inspectRootOwnedTree({ workspaceRoot: fixture, expectedUid: uid, expectedGid: gid }),
      /release_environment_non_executable_file_mode_invalid/u,
    );
    fs.chmodSync(path.join(fixture, 'sealed.txt'), 0o666);
    assert.throws(
      () => inspectRootOwnedTree({ workspaceRoot: fixture, expectedUid: uid, expectedGid: gid }),
      /release_environment_group_or_other_writable_entry/u,
    );
    fs.chmodSync(path.join(fixture, 'sealed.txt'), 0o444);
    fs.chmodSync(path.join(fixture, 'sealed-tool'), 0o755);
    assert.throws(
      () => inspectRootOwnedTree({ workspaceRoot: fixture, expectedUid: uid, expectedGid: gid }),
      /release_environment_executable_file_mode_invalid/u,
    );
    fs.chmodSync(path.join(fixture, 'sealed-tool'), 0o555);
    fs.chmodSync(fixture, 0o755);
    assert.throws(
      () => inspectRootOwnedTree({ workspaceRoot: fixture, expectedUid: uid, expectedGid: gid }),
      /release_environment_directory_mode_invalid/u,
    );
    fs.symlinkSync('/etc/passwd', path.join(fixture, 'outside-link'));
    fs.chmodSync(fixture, 0o555);
    assert.throws(
      () => inspectRootOwnedTree({ workspaceRoot: fixture, expectedUid: uid, expectedGid: gid }),
      /release_environment_external_symlink_forbidden/u,
    );
  } finally {
    fs.chmodSync(fixture, 0o755);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('deployment closure verifies strict v2 lineage, tools and submodule identities', (t) => {
  const fixture = deploymentClosureFixture(t);
  assert.deepEqual(inspectDeploymentClosure(fixture.options), {
    status: 'release_environment_deployment_closure_verified',
    version: 2,
    closureHash: fixture.closure.closureHash,
    inheritedFromClosureHash: fixture.inheritedFromClosureHash,
  });
});

test('deployment closure retains only hash-anchored strict legacy v1 compatibility', (t) => {
  const fixture = deploymentClosureFixture(t, { version: 1 });
  assert.deepEqual(inspectDeploymentClosure(fixture.options), {
    status: 'release_environment_deployment_closure_verified',
    version: 1,
    closureHash: fixture.closure.closureHash,
    inheritedFromClosureHash: null,
  });
  assert.throws(() => inspectDeploymentClosure({
    ...fixture.options,
    legacyV1ClosureHash: `sha256:${'8'.repeat(64)}`,
  }), /release_environment_deployment_legacy_anchor_mismatch/u);
});

test('deployment closure accepts an explicitly pinned v2 predecessor and rejects ambient lineage', (t) => {
  const approvedV2Predecessor = `sha256:${'9'.repeat(64)}`;
  const fixture = deploymentClosureFixture(t, {
    inheritedFromClosureHash: approvedV2Predecessor,
  });
  assert.equal(
    inspectDeploymentClosure(fixture.options).inheritedFromClosureHash,
    approvedV2Predecessor,
  );
  assert.throws(() => inspectDeploymentClosure({
    ...fixture.options,
    approvedPredecessorClosureHashes: [`sha256:${'8'.repeat(64)}`],
  }), /release_environment_deployment_lineage_mismatch/u);
});

test('deployment closure defaults to the exact currently deployed v2 predecessor', (t) => {
  const deployedPredecessor =
    'sha256:c2094b9f424b6264ba04ee24c1d91165a481e3be0d9b957eaeeba40d125cf89b';
  const fixture = deploymentClosureFixture(t, {
    inheritedFromClosureHash: deployedPredecessor,
  });
  const {
    approvedPredecessorClosureHashes: ignored,
    ...defaultLineageOptions
  } = fixture.options;
  assert.equal(
    inspectDeploymentClosure(defaultLineageOptions).inheritedFromClosureHash,
    deployedPredecessor,
  );
});

test('deployment closure rejects hash, lineage and exact-schema tampering', async (t) => {
  await t.test('payload hash tamper', (subtest) => {
    const fixture = deploymentClosureFixture(subtest);
    writeClosure(fixture.workspaceRoot, {
      ...fixture.closure,
      inheritedFromClosureHash: `sha256:${'8'.repeat(64)}`,
    });
    assert.throws(
      () => inspectDeploymentClosure(fixture.options),
      /release_environment_deployment_closure_invalid/u,
    );
  });
  await t.test('rehash cannot replace lineage anchor', (subtest) => {
    const fixture = deploymentClosureFixture(subtest);
    const { closureHash: ignored, ...payload } = fixture.closure;
    writeClosure(fixture.workspaceRoot, sealClosure({
      ...payload,
      inheritedFromClosureHash: `sha256:${'8'.repeat(64)}`,
    }));
    assert.throws(
      () => inspectDeploymentClosure(fixture.options),
      /release_environment_deployment_lineage_mismatch/u,
    );
  });
  await t.test('rehash cannot add an undeclared field', (subtest) => {
    const fixture = deploymentClosureFixture(subtest);
    const { closureHash: ignored, ...payload } = fixture.closure;
    writeClosure(fixture.workspaceRoot, sealClosure({ ...payload, unreviewed: true }));
    assert.throws(
      () => inspectDeploymentClosure(fixture.options),
      /release_environment_deployment_closure_invalid/u,
    );
  });
});

test('deployment closure rejects tool content drift and a substituted tool symlink', async (t) => {
  await t.test('content drift', (subtest) => {
    const fixture = deploymentClosureFixture(subtest);
    fs.writeFileSync(path.join(fixture.workspaceRoot, 'elan', 'drift.txt'), 'drift\n');
    assert.throws(
      () => inspectDeploymentClosure(fixture.options),
      /release_environment_deployment_tool_mismatch:elan/u,
    );
  });
  await t.test('root symlink substitution', (subtest) => {
    const fixture = deploymentClosureFixture(subtest);
    const selected = path.join(fixture.workspaceRoot, 'elan');
    fs.chmodSync(fixture.workspaceRoot, 0o755);
    fs.renameSync(selected, `${selected}.real`);
    fs.symlinkSync('elan.real', selected);
    fs.chmodSync(fixture.workspaceRoot, 0o555);
    assert.throws(
      () => inspectDeploymentClosure(fixture.options),
      /release_environment_deployment_path_unsafe/u,
    );
  });
});

test('deployment closure rejects submodule commit, tree and content drift', async (t) => {
  for (const [field, expectedError] of [
    ['commit', 'release_environment_deployment_submodule_commit_mismatch:core'],
    ['tree', 'release_environment_deployment_submodule_tree_mismatch:core'],
  ]) {
    await t.test(`${field} mismatch`, (subtest) => {
      const fixture = deploymentClosureFixture(subtest);
      const { closureHash: ignored, ...payload } = fixture.closure;
      const core = { ...payload.submodules.core, [field]: 'f'.repeat(40) };
      writeClosure(fixture.workspaceRoot, sealClosure({
        ...payload,
        submodules: { ...payload.submodules, core },
      }));
      assert.throws(
        () => inspectDeploymentClosure(fixture.options),
        new RegExp(expectedError, 'u'),
      );
    });
  }
  await t.test('content drift', (subtest) => {
    const fixture = deploymentClosureFixture(subtest);
    fs.writeFileSync(path.join(fixture.workspaceRoot, 'core', 'sealed.txt'), 'drift\n');
    assert.throws(
      () => inspectDeploymentClosure(fixture.options),
      /release_environment_deployment_submodule_content_mismatch:core/u,
    );
  });
});

test('action runner uses fixed cwd, exact argv, no shell and only the rebuilt environment', () => {
  const command = buildReleaseActionCommand({ action: 'formal:gate' });
  let invocation = null;
  const status = runReleaseAction({
    command,
    environment: Object.freeze({ PATH: '/usr/bin:/bin' }),
    runner(executable, argumentsList, options) {
      invocation = { executable, argumentsList, options };
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.equal(invocation.executable, '/usr/bin/node');
  assert.deepEqual(invocation.argumentsList, [
    '/opt/hepta-paper/paper-core/bin/dynamic-formal-kernel-operational.mjs',
  ]);
  assert.equal(invocation.options.cwd, '/opt/hepta-paper');
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.env, { PATH: '/usr/bin:/bin' });
});

test('sealed offhost status is always the production-exit custody gate', () => {
  const command = buildReleaseActionCommand({ action: 'offhost:worm-status' });
  assert.equal(command.executable, '/usr/bin/node');
  assert.deepEqual(command.arguments, [
    '/opt/hepta-paper/paper-core/bin/offhost-worm-snapshot.mjs',
    'status',
    '--require-custody',
  ]);
});

test('composition requires a state inspector and wires the sealed inspection path', () => {
  assert.throws(
    () => inspectComposedProductionReleaseEnvironment({
      action: 'formal:gate',
      entrypointPath: path.join(root, 'paper-core', 'bin', 'release-env.mjs'),
      inspectReleaseState: null,
    }),
    /release_environment_state_inspector_required/u,
  );

  const sourceEntrypoint = path.join(root, 'paper-core', 'bin', 'release-env.mjs');
  const sealedEntrypoint = '/opt/hepta-paper/paper-core/bin/release-env.mjs';
  const originalRealpath = fs.realpathSync;
  let stateInspectionCalls = 0;
  fs.realpathSync = (candidate) => {
    if (candidate === sourceEntrypoint) return sealedEntrypoint;
    if (candidate === RELEASE_ENVIRONMENT_ROOT) throw new Error('fixture_root_stop');
    return originalRealpath(candidate);
  };
  try {
    assert.throws(
      () => inspectComposedProductionReleaseEnvironment({
        action: 'formal:gate',
        entrypointPath: sourceEntrypoint,
        inspectReleaseState({ workspaceRoot }) {
          stateInspectionCalls += 1;
          assert.equal(workspaceRoot, RELEASE_ENVIRONMENT_ROOT);
          return { headCommit: 'fixture', releaseState: { ok: true, state: 'development' } };
        },
      }),
      /fixture_root_stop/u,
    );
  } finally {
    fs.realpathSync = originalRealpath;
  }
  assert.equal(stateInspectionCalls, 1);
});

test('CLI core covers help, parser, launcher, successful dispatch and inspected failure', () => {
  const helpOutput = memoryStream();
  assert.equal(runReleaseEnvironmentCli({
    argv: ['--help'],
    stdout: helpOutput.stream,
  }), 0);
  assert.deepEqual(JSON.parse(helpOutput.value()), releaseEnvironmentUsage());

  const parseError = memoryStream();
  assert.equal(runReleaseEnvironmentCli({ argv: [], stderr: parseError.stream }), 2);
  assert.match(parseError.value(), /release_environment_action_required/u);

  const launcherError = memoryStream();
  assert.equal(runReleaseEnvironmentCli({
    argv: ['formal:gate'],
    stderr: launcherError.stream,
    inspectLauncherBoundary() { throw new Error('fixture_launcher_rejected'); },
  }), 2);
  assert.match(launcherError.value(), /fixture_launcher_rejected/u);

  const successOutput = memoryStream();
  let replacedEnvironment;
  let inspectedState;
  const successStatus = runReleaseEnvironmentCli({
    argv: ['formal:gate'],
    stdout: successOutput.stream,
    inspectLauncherBoundary() {},
    inspectEnvironment(options) {
      inspectedState = options.inspectReleaseState;
      return Object.freeze({ status: 'fixture_release_environment_verified' });
    },
    inspectReleaseState: Object.freeze({ fixture: true }),
    buildCommand(options) {
      assert.deepEqual(options, { action: 'formal:gate', manifestPath: null });
      return Object.freeze({ executable: '/usr/bin/node', arguments: Object.freeze([]) });
    },
    executeAction({ command, environment }) {
      assert.equal(command.executable, '/usr/bin/node');
      assert.equal(environment, replacedEnvironment);
      return 17;
    },
    replaceEnvironment(environment) { replacedEnvironment = environment; },
  });
  assert.equal(successStatus, 17);
  assert.deepEqual(inspectedState, { fixture: true });
  assert.match(successOutput.value(), /fixture_release_environment_verified/u);
  assert.equal(Object.hasOwn(replacedEnvironment, 'NODE_OPTIONS'), false);

  const inspectionError = memoryStream();
  assert.equal(runReleaseEnvironmentCli({
    argv: ['formal:gate'],
    stderr: inspectionError.stream,
    inspectLauncherBoundary() {},
    inspectEnvironment() { throw new Error('fixture_inspection_rejected'); },
    replaceEnvironment() {},
  }), 2);
  assert.match(inspectionError.value(), /fixture_inspection_rejected/u);
});

test('JavaScript launcher boundary rechecks marker, lock metadata and inherited descriptor identity', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'release-env-boundary-'));
  t.after(() => fs.rmSync(fixture, { force: true, recursive: true }));
  fs.chmodSync(fixture, 0o711);
  const deploymentLock = path.join(fixture, 'deployment.lock');
  fs.writeFileSync(deploymentLock, '', { mode: 0o600 });
  const descriptor = fs.openSync(deploymentLock, 'r');
  t.after(() => fs.closeSync(descriptor));
  const options = {
    deploymentLock,
    descriptor,
    environment: { HEPTA_RELEASE_ENV_LAUNCHER: 'sealed-v1' },
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    executionUser: os.userInfo(),
    effectiveUid: process.getuid(),
    effectiveGid: process.getgid(),
    supplementaryGroups: [process.getgid()],
    expectedExecutionUsername: os.userInfo().username,
    processStatus: 'Name:\tnode\nNoNewPrivs:\t1\n',
  };
  assert.deepEqual(inspectReleaseEnvironmentLauncherBoundary(options), {
    status: 'release_environment_launcher_boundary_verified',
    deploymentLock,
    descriptor,
  });
  assert.throws(
    () => inspectReleaseEnvironmentLauncherBoundary({ ...options, environment: {} }),
    /release_environment_launcher_required/u,
  );
  assert.throws(
    () => inspectReleaseEnvironmentLauncherBoundary({ ...options, descriptor: -1 }),
    /release_environment_deployment_lock_invalid/u,
  );
  assert.throws(
    () => inspectReleaseEnvironmentLauncherBoundary({
      ...options,
      supplementaryGroups: [process.getgid(), process.getgid() + 1],
    }),
    /release_environment_execution_principal_invalid/u,
  );
  assert.throws(
    () => inspectReleaseEnvironmentLauncherBoundary({
      ...options,
      processStatus: 'Name:\tnode\nNoNewPrivs:\t0\n',
    }),
    /release_environment_no_new_privileges_required/u,
  );
  assert.deepEqual(inspectReleaseEnvironmentLauncherBoundary({
    ...options,
    action: 'formal:gate',
    dockerGroupGid: process.getgid() + 1,
    supplementaryGroups: [process.getgid(), process.getgid() + 1],
  }), {
    status: 'release_environment_launcher_boundary_verified',
    deploymentLock,
    descriptor,
  });
  fs.chmodSync(fixture, 0o777);
  assert.throws(
    () => inspectReleaseEnvironmentLauncherBoundary(options),
    /release_environment_deployment_lock_invalid/u,
  );
  fs.chmodSync(fixture, 0o711);
  fs.chmodSync(deploymentLock, 0o644);
  assert.throws(
    () => inspectReleaseEnvironmentLauncherBoundary(options),
    /release_environment_deployment_lock_invalid/u,
  );
  fs.chmodSync(deploymentLock, 0o600);
  fs.renameSync(deploymentLock, `${deploymentLock}.original`);
  fs.writeFileSync(deploymentLock, '', { mode: 0o600 });
  assert.throws(
    () => inspectReleaseEnvironmentLauncherBoundary(options),
    /release_environment_deployment_lock_identity_mismatch/u,
  );
});

test('installed launcher is closure-bound and sanitizes before the first Node import', async (t) => {
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  const installer = fs.readFileSync(installerPath, 'utf8');
  assert.equal(fs.statSync(launcherPath).mode & 0o111, 0);
  assert.equal(spawnSync('/bin/sh', ['-n', launcherPath]).status, 0);
  assert.match(launcher, /^exec \/usr\/bin\/env -i \\/m);
  assert.match(launcher, /^test "\$\(\/usr\/bin\/id -u\)" = '0'$/m);
  assert.match(launcher, /^release_uid="\$\(\/usr\/bin\/id -u hepta-paper\)"$/m);
  assert.match(launcher, /^release_gid="\$\(\/usr\/bin\/id -g hepta-paper\)"$/m);
  assert.match(
    launcher,
    /^deployment_lock_root=\/run\/hepta-paper-deployment$/m,
  );
  assert.match(launcher, /^deployment_lock=\$deployment_lock_root\/deployment\.lock$/m);
  assert.match(launcher, /\/usr\/bin\/flock --shared --nonblock 9/);
  assert.match(launcher, /^  HEPTA_RELEASE_ENV_LAUNCHER=sealed-v1 \\/m);
  assert.match(launcher, /^  \/usr\/bin\/setpriv \\/m);
  assert.match(launcher, /^  --reuid "\$release_uid" \\/m);
  assert.match(launcher, /^  --regid "\$release_gid" \\/m);
  assert.match(launcher, /^group_option=--clear-groups$/m);
  assert.match(launcher, /^  formal:gate\|release:verify\)$/m);
  assert.match(launcher, /^    group_option="--groups=\$docker_gid"$/m);
  assert.match(launcher, /^  "\$group_option" \\/m);
  assert.match(launcher, /^  --no-new-privs \\/m);
  assert.match(launcher, /^  \/usr\/bin\/node \\/m);
  assert.match(
    launcher,
    /^  \/opt\/hepta-paper\/paper-core\/bin\/release-env\.mjs "\$@"$/m,
  );
  assert.doesNotMatch(launcher, /\beval\b|\$\{?PATH|NODE_OPTIONS|LD_PRELOAD/u);
  assert.match(installer, /^hepta-paper-release-env$/m);
  assert.match(installer, /hepta-paper-release-env\)\n\s+manifest_path=usr\/libexec\/hepta-paper\/\$artifact/);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'release-env-launcher-'));
  t.after(() => fs.rmSync(fixture, { force: true, recursive: true }));
  const marker = path.join(fixture, 'node-options-import-executed');
  const poison = path.join(fixture, 'poison.mjs');
  const probe = path.join(fixture, 'probe.mjs');
  const deploymentLock = path.join(fixture, 'deployment.lock');
  const fixtureLauncher = path.join(fixture, 'hepta-paper-release-env');
  fs.chmodSync(fixture, 0o711);
  fs.writeFileSync(deploymentLock, '', { mode: 0o600 });
  fs.writeFileSync(poison, [
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.HEPTA_POISON_MARKER, 'executed\\n');",
    '',
  ].join('\n'));
  fs.writeFileSync(probe, [
    'process.stdout.write(`${JSON.stringify({',
    '  argv: process.argv.slice(2),',
    '  environment: Object.fromEntries(Object.entries(process.env).sort()),',
    '})}\\n`);',
    '',
  ].join('\n'));
  fs.writeFileSync(
    fixtureLauncher,
    launcher
      .replace('test "$(/usr/bin/id -u)" = \'0\'', 'test "$(/usr/bin/id -u)" = "$(/usr/bin/id -u)"')
      .replace('/usr/bin/id -u hepta-paper', '/usr/bin/id -u')
      .replace('/usr/bin/id -g hepta-paper', '/usr/bin/id -g')
      .replace([
        '  /usr/bin/setpriv \\',
        '  --reuid "$release_uid" \\',
        '  --regid "$release_gid" \\',
        '  "$group_option" \\',
        '  --no-new-privs \\',
        '  /usr/bin/node \\',
      ].join('\n'), '  /usr/bin/node \\')
      .replaceAll('/run/hepta-paper-deployment', fixture)
      .replaceAll(
        'directory:0:0:711',
        `directory:${process.getuid()}:${process.getgid()}:711`,
      )
      .replaceAll(
        'regular empty file:0:0:600:1',
        `regular empty file:${process.getuid()}:${process.getgid()}:600:1`,
      )
      .replace(
        '/opt/hepta-paper/paper-core/bin/release-env.mjs',
        probe,
      ),
    { mode: 0o700 },
  );
  const result = spawnSync(fixtureLauncher, ['--probe'], {
    encoding: 'utf8',
    env: {
      BASH_ENV: path.join(fixture, 'untrusted-shell-startup'),
      HEPTA_POISON_MARKER: marker,
      LD_LIBRARY_PATH: path.join(fixture, 'untrusted-library-root'),
      NODE_OPTIONS: `--import=${pathToFileURL(poison).href}`,
      NODE_PATH: path.join(fixture, 'untrusted-node-path'),
      OPENAI_API_KEY: 'must-not-reach-node',
      PATH: path.join(fixture, 'untrusted-path'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false, 'poisoned NODE_OPTIONS import executed');
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['--probe'],
    environment: {
      HEPTA_RELEASE_ENV_LAUNCHER: 'sealed-v1',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: '/usr/bin:/bin',
      TZ: 'UTC',
    },
  });

  const exclusiveHolder = spawn('/usr/bin/flock', [
    '--exclusive',
    deploymentLock,
    '/bin/sh',
    '-c',
    'printf locked; read ignored',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    if (exclusiveHolder.exitCode === null) exclusiveHolder.kill('SIGKILL');
  });
  const [ready] = await once(exclusiveHolder.stdout, 'data');
  assert.equal(ready.toString(), 'locked');
  const duringCutover = spawnSync(fixtureLauncher, ['--probe'], {
    encoding: 'utf8',
    env: {},
  });
  assert.equal(duringCutover.status, 75);
  assert.match(duringCutover.stderr, /release_environment_deployment_in_progress/u);
  exclusiveHolder.stdin.end('\n');
  await once(exclusiveHolder, 'exit');
});

test('production inspector refuses an entrypoint outside the sealed root before running gates', () => {
  assert.throws(() => inspectProductionReleaseEnvironment({
    action: 'offhost:worm-status',
    entrypointPath: path.join(root, 'paper-core', 'bin', 'release-env.mjs'),
  }), /release_environment_entrypoint_not_sealed/u);
});

test('JavaScript second-defense help is available from an explicitly clean environment', () => {
  const result = spawnSync(process.execPath, ['paper-core/bin/release-env.mjs', '--help'], {
    cwd: root,
    encoding: 'utf8',
    env: cleanNodeTestEnvironment(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), releaseEnvironmentUsage());
});

test('direct JavaScript actions cannot bypass the pre-Node launcher and lock boundary', () => {
  const result = spawnSync(process.execPath, [
    'paper-core/bin/release-env.mjs',
    'formal:gate',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: cleanNodeTestEnvironment(),
  });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    kind: 'ReleaseEnvironmentCliError',
    error: 'release_environment_launcher_required',
  });
});
