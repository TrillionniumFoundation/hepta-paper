import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentCodeProvenance } from './code-provenance.mjs';
import { assertReleaseDependencyTreeContract } from './release-dependency-tree.mjs';
import { inspectSealedDeploymentClosure } from './release-environment-deployment-closure.mjs';
import { inspectReleaseEnvironmentLauncherBoundary } from './release-environment-launcher-boundary.mjs';

export { inspectReleaseEnvironmentLauncherBoundary };

export const RELEASE_ENVIRONMENT_ROOT = '/opt/hepta-paper';
export const RELEASE_ENVIRONMENT_ELAN_HOME = '/opt/hepta-paper/elan';
export const RELEASE_ENVIRONMENT_LAUNCHER =
  '/usr/libexec/hepta-paper/hepta-paper-release-env';
export const RELEASE_ENVIRONMENT_ASSET_ROOT = '/srv/hepta-paper/assets';
export const RELEASE_ENVIRONMENT_RUNTIME_ROOT = '/var/lib/hepta-paper/runtime';

const RELEASE_DIRECTORY = '/opt/hepta-paper-releases';
const NODE_EXECUTABLE = '/usr/bin/node';
const NPM_EXECUTABLE = '/usr/bin/npm';
const COMMIT = /^[0-9a-f]{40,64}$/u;
const MAXIMUM_CLOSURE_BYTES = 16 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

const ACTIONS = Object.freeze({
  'release:state-gate': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze([
      'paper-core/bin/release-state-check.mjs',
      '--require-state',
      'release_ready',
    ]),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'formal:gate': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze(['paper-core/bin/dynamic-formal-kernel-operational.mjs']),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'release:verify': Object.freeze({
    executable: NPM_EXECUTABLE,
    arguments: Object.freeze(['run', 'release:verify']),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'release:trust-gate': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze(['paper-core/bin/release-trust-gate.mjs']),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'store:trust-gate': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze([
      'paper-core/bin/hepta-store.mjs',
      'status',
      '--require-trust-clean',
      '--allow-isolated-verification-evidence',
    ]),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'store:logical-integrity': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze(['paper-core/bin/hepta-store-logical-integrity.mjs']),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'store:restore-drill': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze(['paper-core/bin/hepta-store.mjs', 'restore-drill']),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'assets:cold-volume-release-gate': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze([
      'paper-core/bin/verify-cold-volume-contract.mjs',
      '--require-mounted',
    ]),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'assets:cold-volume-cas-release-gate': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze([
      'paper-core/bin/cold-volume-cas.mjs',
      'status',
      '--require-ready',
    ]),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'assets:cold-volume-cas-restore-drill': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze([
      'paper-core/bin/cold-volume-cas.mjs',
      'restore-drill',
    ]),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'offhost:worm-status': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze([
      'paper-core/bin/offhost-worm-snapshot.mjs',
      'status',
      '--require-custody',
    ]),
    releaseReadyRequired: false,
    forwardedOption: null,
  }),
  'offhost:worm-restore-drill': Object.freeze({
    executable: NODE_EXECUTABLE,
    arguments: Object.freeze(['paper-core/bin/offhost-worm-snapshot.mjs', 'restore-drill']),
    releaseReadyRequired: false,
    forwardedOption: '--manifest',
  }),
});

export const RELEASE_ENVIRONMENT_ACTIONS = Object.freeze(Object.keys(ACTIONS));

export function releaseEnvironmentActionPolicy(action) {
  const definition = ACTIONS[action];
  if (!definition) throw codedError(`release_environment_action_forbidden:${action}`);
  return Object.freeze({
    action,
    releaseReadyPreflightRequired: definition.releaseReadyRequired,
    forwardedOption: definition.forwardedOption,
  });
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function withinOrSame(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function exactIdentity(stat) {
  return JSON.stringify({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    uid: String(stat.uid),
    gid: String(stat.gid),
  });
}

function decodeMountInfoPath(value) {
  return String(value).replace(/\\([0-7]{3})/gu, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

export function parseReleaseEnvironmentArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    return Object.freeze({ help: true, action: null, manifestPath: null });
  }
  if (argv.length < 1) throw codedError('release_environment_action_required');
  const [action, ...remaining] = argv;
  const definition = ACTIONS[action];
  if (!definition) throw codedError(`release_environment_action_forbidden:${action}`);
  if (definition.forwardedOption === null) {
    if (remaining.length !== 0) throw codedError('release_environment_arguments_forbidden');
    return Object.freeze({ help: false, action, manifestPath: null });
  }
  if (remaining.length !== 2 || remaining[0] !== definition.forwardedOption) {
    throw codedError(`release_environment_option_required:${definition.forwardedOption}`);
  }
  const manifestPath = remaining[1];
  if (!manifestPath || manifestPath.startsWith('--') || !path.isAbsolute(manifestPath)) {
    throw codedError('release_environment_manifest_absolute_path_required');
  }
  return Object.freeze({ help: false, action, manifestPath });
}

export function buildReleaseEnvironment({ scratchRoot, action = null }) {
  if (!scratchRoot || !path.isAbsolute(scratchRoot)) {
    throw codedError('release_environment_scratch_root_invalid');
  }
  if (action !== null && !ACTIONS[action]) {
    throw codedError(`release_environment_action_forbidden:${action}`);
  }
  const environment = {
    CI: '1',
    ELAN_HOME: RELEASE_ENVIRONMENT_ELAN_HOME,
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_KEY_1: 'safe.directory',
    GIT_CONFIG_KEY_2: 'safe.directory',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_VALUE_0: RELEASE_ENVIRONMENT_ROOT,
    GIT_CONFIG_VALUE_1: `${RELEASE_ENVIRONMENT_ROOT}/core`,
    GIT_CONFIG_VALUE_2: `${RELEASE_ENVIRONMENT_ROOT}/runtime-images/r-scientific/source-cas`,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    HEPTA_PAPER_ASSET_ROOT: RELEASE_ENVIRONMENT_ASSET_ROOT,
    HEPTA_PAPER_RUNTIME_ROOT: RELEASE_ENVIRONMENT_RUNTIME_ROOT,
    HOME: path.join(scratchRoot, 'home'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    NPM_CONFIG_CACHE: path.join(scratchRoot, 'npm-cache'),
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    PATH: '/usr/bin:/bin',
    TMPDIR: path.join(scratchRoot, 'tmp'),
    TZ: 'UTC',
    XDG_CACHE_HOME: path.join(scratchRoot, 'cache'),
    XDG_CONFIG_HOME: path.join(scratchRoot, 'config'),
  };
  return Object.freeze(environment);
}

export function replaceProcessEnvironment(environment) {
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
}

export function parseMountInfo(mountInfoText) {
  return Object.freeze(String(mountInfoText || '').trim().split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(' ');
      const separator = fields.indexOf('-');
      if (separator < 6 || fields.length < separator + 4) {
        throw codedError('release_environment_mountinfo_invalid');
      }
      return Object.freeze({
        root: decodeMountInfoPath(fields[3]),
        mountPoint: decodeMountInfoPath(fields[4]),
        mountOptions: Object.freeze(fields[5].split(',')),
        filesystemType: fields[separator + 1],
        source: decodeMountInfoPath(fields[separator + 2]),
        superOptions: Object.freeze(fields[separator + 3].split(',')),
      });
    }));
}

export function inspectReleaseMount({
  workspaceRoot,
  commit,
  mountInfoText,
  releaseDirectory = RELEASE_DIRECTORY,
}) {
  const mounts = parseMountInfo(mountInfoText);
  const selected = mounts.filter((entry) => entry.mountPoint === workspaceRoot);
  if (selected.length !== 1) throw codedError('release_environment_exact_mount_required');
  const mount = selected[0];
  for (const required of ['ro', 'nosuid', 'nodev']) {
    if (!mount.mountOptions.includes(required)) {
      throw codedError(`release_environment_mount_option_required:${required}`);
    }
  }
  const nested = mounts.filter((entry) => (
    entry.mountPoint !== workspaceRoot && withinOrSame(workspaceRoot, entry.mountPoint)
  ));
  if (nested.length !== 0) throw codedError('release_environment_nested_mount_forbidden');
  const expectedSourceRoot = path.join(releaseDirectory, commit);
  if (mount.root !== expectedSourceRoot) {
    throw codedError('release_environment_mount_source_commit_mismatch');
  }
  let canonicalSource;
  try {
    canonicalSource = fs.realpathSync(expectedSourceRoot);
  } catch {
    throw codedError('release_environment_mount_source_missing');
  }
  if (canonicalSource !== expectedSourceRoot) {
    throw codedError('release_environment_mount_source_not_canonical');
  }
  const rootStat = fs.lstatSync(workspaceRoot, { bigint: true });
  const sourceStat = fs.lstatSync(expectedSourceRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()
    || rootStat.dev !== sourceStat.dev || rootStat.ino !== sourceStat.ino) {
    throw codedError('release_environment_bind_mount_identity_mismatch');
  }
  return Object.freeze({
    mountPoint: mount.mountPoint,
    sourceRoot: expectedSourceRoot,
    mountOptions: mount.mountOptions,
    filesystemType: mount.filesystemType,
    source: mount.source,
  });
}

export function inspectRootOwnedTree({
  workspaceRoot,
  expectedUid = 0,
  expectedGid = 0,
}) {
  const root = path.resolve(workspaceRoot);
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    throw codedError('release_environment_root_missing');
  }
  if (canonicalRoot !== root) throw codedError('release_environment_root_realpath_mismatch');
  const before = fs.lstatSync(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw codedError('release_environment_root_directory_required');
  }
  const counts = { directories: 0, files: 0, symlinks: 0 };
  const pending = [root];
  while (pending.length > 0) {
    const candidate = pending.pop();
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.uid !== BigInt(expectedUid) || stat.gid !== BigInt(expectedGid)) {
      throw codedError('release_environment_root_ownership_invalid');
    }
    if (!stat.isSymbolicLink() && (Number(stat.mode) & 0o022) !== 0) {
      throw codedError('release_environment_group_or_other_writable_entry');
    }
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = fs.realpathSync(candidate);
      } catch {
        throw codedError('release_environment_symlink_target_invalid');
      }
      if (!withinOrSame(root, target)) {
        throw codedError('release_environment_external_symlink_forbidden');
      }
      counts.symlinks += 1;
    } else if (stat.isFile()) {
      const selectedMode = Number(stat.mode) & 0o7777;
      const executable = (selectedMode & 0o111) !== 0;
      if (selectedMode !== (executable ? 0o555 : 0o444)) {
        throw codedError(executable
          ? 'release_environment_executable_file_mode_invalid'
          : 'release_environment_non_executable_file_mode_invalid');
      }
      counts.files += 1;
    } else if (stat.isDirectory()) {
      if ((Number(stat.mode) & 0o7777) !== 0o555) {
        throw codedError('release_environment_directory_mode_invalid');
      }
      counts.directories += 1;
      const entries = fs.readdirSync(candidate).sort((left, right) => left.localeCompare(right));
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        pending.push(path.join(candidate, entries[index]));
      }
    } else {
      throw codedError('release_environment_special_file_forbidden');
    }
  }
  const after = fs.lstatSync(root, { bigint: true });
  if (exactIdentity(before) !== exactIdentity(after)) {
    throw codedError('release_environment_root_changed_during_scan');
  }
  return Object.freeze({
    status: 'release_environment_root_owned_tree_verified',
    counts: Object.freeze({
      ...counts,
      entries: counts.directories + counts.files + counts.symlinks,
    }),
  });
}

function readRegularFileNoFollow(file, maximumBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw codedError('release_environment_regular_file_required');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (exactIdentity(before) !== exactIdentity(after) || BigInt(bytes.length) !== before.size) {
      throw codedError('release_environment_file_changed_during_read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function inspectDeploymentClosure(options) {
  return inspectSealedDeploymentClosure(options);
}

export function assertProductionReleaseEntrypoint(entrypointPath) {
  const expected = `${RELEASE_ENVIRONMENT_ROOT}/paper-core/bin/release-env.mjs`;
  let canonical;
  try {
    canonical = fs.realpathSync(entrypointPath);
  } catch {
    throw codedError('release_environment_entrypoint_missing');
  }
  if (canonical !== expected) throw codedError('release_environment_entrypoint_not_sealed');
}

function assertReleaseState({ action, snapshot, provenance }) {
  if (snapshot?.headCommit !== provenance.commit) {
    throw codedError('release_environment_state_commit_mismatch');
  }
  const state = snapshot?.releaseState;
  if (!state?.ok) throw codedError('release_environment_release_state_invalid');
  if (ACTIONS[action].releaseReadyRequired && state.state !== 'release_ready') {
    throw codedError(`release_environment_release_ready_required:${state.state || 'invalid'}`);
  }
  return state.state;
}

export function inspectProductionReleaseEnvironment({
  action,
  entrypointPath,
  releaseStateSnapshot,
}) {
  if (!ACTIONS[action]) throw codedError(`release_environment_action_forbidden:${action}`);
  assertProductionReleaseEntrypoint(entrypointPath);
  const canonicalRoot = fs.realpathSync(RELEASE_ENVIRONMENT_ROOT);
  if (canonicalRoot !== RELEASE_ENVIRONMENT_ROOT) {
    throw codedError('release_environment_root_realpath_mismatch');
  }
  const tree = inspectRootOwnedTree({ workspaceRoot: RELEASE_ENVIRONMENT_ROOT });
  let provenance;
  let dependencyInspection;
  try {
    provenance = currentCodeProvenance({
      workspaceRoot: RELEASE_ENVIRONMENT_ROOT,
      allowReleaseCommitEnvironment: false,
    });
    dependencyInspection = assertReleaseDependencyTreeContract({
      workspaceRoot: RELEASE_ENVIRONMENT_ROOT,
      readOnly: true,
    });
  } catch (error) {
    const suffix = String(error?.code || error?.message || 'invalid')
      .replace(/[^A-Za-z0-9_.:-]/gu, '_');
    throw codedError(`release_environment_exact_tree_invalid:${suffix}`);
  }
  if (provenance.treeDirty || !COMMIT.test(String(provenance.commit || ''))) {
    throw codedError('release_environment_clean_commit_required');
  }
  const mount = inspectReleaseMount({
    workspaceRoot: RELEASE_ENVIRONMENT_ROOT,
    commit: provenance.commit,
    mountInfoText: fs.readFileSync('/proc/self/mountinfo', 'utf8'),
  });
  const closure = inspectDeploymentClosure({
    workspaceRoot: RELEASE_ENVIRONMENT_ROOT,
    provenance,
    dependencyInspection,
  });
  const releaseState = assertReleaseState({
    action,
    snapshot: releaseStateSnapshot,
    provenance,
  });
  return Object.freeze({
    version: 1,
    kind: 'SealedReleaseEnvironmentInspection',
    status: 'sealed_release_environment_verified',
    action,
    commit: provenance.commit,
    commitTree: provenance.commitTree,
    releaseState,
    mount,
    tree,
    dependencyContractHash: dependencyInspection.contractHash,
    closureHash: closure.closureHash,
  });
}

function configuredWormRoot(workspaceRoot) {
  const file = path.join(workspaceRoot, 'paper-core', 'config', 'offhost-worm-contract.v1.json');
  let contract;
  try {
    contract = JSON.parse(readRegularFileNoFollow(file, MAXIMUM_CLOSURE_BYTES).toString('utf8'));
  } catch {
    throw codedError('release_environment_worm_contract_invalid');
  }
  const target = String(contract?.targetMountRoot || '');
  if (!path.isAbsolute(target) || path.resolve(target) !== target) {
    throw codedError('release_environment_worm_contract_invalid');
  }
  return target;
}

function verifiedManifestPath({ manifestPath, workspaceRoot }) {
  const wormRoot = configuredWormRoot(workspaceRoot);
  let canonicalManifest;
  let canonicalWormRoot;
  try {
    canonicalWormRoot = fs.realpathSync(wormRoot);
    canonicalManifest = fs.realpathSync(manifestPath);
  } catch {
    throw codedError('release_environment_worm_manifest_missing');
  }
  if (canonicalWormRoot !== wormRoot
    || canonicalManifest !== path.resolve(manifestPath)
    || !withinOrSame(canonicalWormRoot, canonicalManifest)) {
    throw codedError('release_environment_worm_manifest_outside_target');
  }
  const stat = fs.lstatSync(canonicalManifest, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || (Number(stat.mode) & 0o022) !== 0) {
    throw codedError('release_environment_worm_manifest_unsafe');
  }
  return canonicalManifest;
}

export function buildReleaseActionCommand({
  action,
  manifestPath = null,
  workspaceRoot = RELEASE_ENVIRONMENT_ROOT,
}) {
  const definition = ACTIONS[action];
  if (!definition) throw codedError(`release_environment_action_forbidden:${action}`);
  const argumentsList = definition.arguments.map((argument, index) => (
    index === 0 && definition.executable === NODE_EXECUTABLE
      ? path.join(workspaceRoot, argument)
      : argument
  ));
  if (definition.forwardedOption) {
    if (!manifestPath) throw codedError('release_environment_worm_manifest_required');
    argumentsList.push(definition.forwardedOption, verifiedManifestPath({
      manifestPath,
      workspaceRoot,
    }));
  } else if (manifestPath !== null) {
    throw codedError('release_environment_manifest_forbidden_for_action');
  }
  return Object.freeze({
    executable: definition.executable,
    arguments: Object.freeze(argumentsList),
  });
}

export function runReleaseAction({ command, environment, runner = spawnSync }) {
  const result = runner(command.executable, command.arguments, {
    cwd: RELEASE_ENVIRONMENT_ROOT,
    env: environment,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw codedError('release_environment_action_spawn_failed');
  if (!Number.isInteger(result.status)) {
    throw codedError(`release_environment_action_terminated:${result.signal || 'unknown'}`);
  }
  return result.status;
}

export function releaseEnvironmentUsage() {
  return Object.freeze({
    version: 1,
    kind: 'ReleaseEnvironmentUsage',
    usage: `${RELEASE_ENVIRONMENT_LAUNCHER} <action> [--manifest <absolute-path>]`,
    actions: RELEASE_ENVIRONMENT_ACTIONS,
    constraints: Object.freeze({
      root: RELEASE_ENVIRONMENT_ROOT,
      elanHome: RELEASE_ENVIRONMENT_ELAN_HOME,
      ambientDynamicLoader:
        'systemd_manager_or_clean_root_exec_required',
      preNodeEnvironment: 'installed_env_i_launcher_required',
      executionPrincipal:
        'hepta-paper_action_scoped_groups_no_new_privileges',
      productionHoldMutation: 'forbidden',
      providerSecretEnvironment: 'not_inherited',
      releaseTagMutation: 'forbidden',
      liveSubmission: 'forbidden',
      releaseReadyPreflightActions: Object.freeze(RELEASE_ENVIRONMENT_ACTIONS.filter(
        (action) => ACTIONS[action].releaseReadyRequired,
      )),
      wormSnapshotMutation: 'forbidden',
    }),
  });
}
