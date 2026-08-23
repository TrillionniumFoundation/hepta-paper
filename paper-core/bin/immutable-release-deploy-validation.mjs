import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAXIMUM_EXECUTOR_ENTRIES = 1_000_000;
const MAXIMUM_CLOSURE_BYTES = 1024 * 1024;
const PLAN_HASH = /^sha256:[0-9a-f]{64}$/u;

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function decodeMountPath(value) {
  return String(value).replace(/\\([0-7]{3})/gu, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function withinOrSame(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

export function inspectSealedExecutorTree(
  root,
  { expectedUid = 0, expectedGid = 0 } = {},
) {
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const candidate = pending.pop();
    entries += 1;
    if (entries > MAXIMUM_EXECUTOR_ENTRIES) {
      throw codedError('immutable_release_deployment_executor_tree_budget_exceeded');
    }
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.uid !== BigInt(expectedUid) || stat.gid !== BigInt(expectedGid)) {
      throw codedError('immutable_release_deployment_executor_tree_owner_invalid');
    }
    if (stat.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(candidate); } catch (error) {
        throw codedError('immutable_release_deployment_executor_symlink_invalid', { cause: error });
      }
      if (!withinOrSame(root, target)) {
        throw codedError('immutable_release_deployment_executor_external_symlink_forbidden');
      }
    } else if (stat.isDirectory()) {
      if ((stat.mode & 0o7777n) !== 0o555n) {
        throw codedError('immutable_release_deployment_executor_directory_mode_invalid');
      }
      for (const name of fs.readdirSync(candidate).sort().reverse()) {
        pending.push(path.join(candidate, name));
      }
    } else if (stat.isFile()) {
      const mode = Number(stat.mode & 0o7777n);
      if (stat.nlink !== 1n || ![0o444, 0o555].includes(mode)) {
        throw codedError('immutable_release_deployment_executor_file_mode_invalid');
      }
    } else throw codedError('immutable_release_deployment_executor_special_file_forbidden');
  }
  return entries;
}

export function inspectSealedExecutorClosure(
  root,
  { expectedUid = 0, expectedGid = 0 } = {},
) {
  const file = path.join(root, 'deployment-closure', 'TOOL-CLOSURE.json');
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(expectedUid)
      || before.gid !== BigInt(expectedGid) || before.nlink !== 1n
      || (before.mode & 0o7777n) !== 0o444n || before.size < 2n
      || before.size > BigInt(MAXIMUM_CLOSURE_BYTES)) {
      throw codedError('immutable_release_deployment_executor_closure_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size) {
      throw codedError('immutable_release_deployment_executor_closure_changed');
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const closure = JSON.parse(raw);
    if (raw !== `${JSON.stringify(closure)}\n`
      && raw !== `${JSON.stringify(closure, null, 2)}\n`) {
      throw codedError('immutable_release_deployment_executor_closure_noncanonical');
    }
    const { closureHash, ...payload } = closure || {};
    const actual = `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(payload)).digest('hex')}`;
    if (!PLAN_HASH.test(String(closureHash || '')) || closureHash !== actual) {
      throw codedError('immutable_release_deployment_executor_closure_invalid');
    }
    return closureHash;
  } catch (error) {
    if (error?.code?.startsWith?.('immutable_release_')) throw error;
    throw codedError('immutable_release_deployment_executor_closure_invalid', { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function inspectImmutableReleaseDeploymentExecutorBoundary({
  entrypointPath,
  executorRoot,
  sealedRoot,
  releaseStore,
  deploymentLock,
  inheritedLockFd,
  mountInfoText,
  installedLauncher,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  const selectedRoot = executorRoot || sealedRoot;
  const selectedEntrypoint = `${selectedRoot}/paper-core/bin/immutable-release-deploy.mjs`;
  if (selectedRoot !== sealedRoot && (
    path.dirname(selectedRoot) !== releaseStore
    || !/^[0-9a-f]{40}$/u.test(path.basename(selectedRoot))
  )) throw codedError('immutable_release_deployment_executor_root_invalid');
  let canonicalEntrypoint;
  let canonicalRoot;
  try {
    canonicalEntrypoint = fs.realpathSync(entrypointPath);
    canonicalRoot = fs.realpathSync(selectedRoot);
  } catch (error) {
    throw codedError('immutable_release_deployment_executor_missing', { cause: error });
  }
  if (entrypointPath !== selectedEntrypoint || canonicalEntrypoint !== selectedEntrypoint
    || canonicalRoot !== selectedRoot) {
    throw codedError('immutable_release_deployment_executor_not_sealed');
  }
  const root = fs.lstatSync(selectedRoot, { bigint: true });
  const entrypoint = fs.lstatSync(selectedEntrypoint, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory()
    || root.uid !== BigInt(expectedUid) || root.gid !== BigInt(expectedGid)
    || (root.mode & 0o7777n) !== 0o555n
    || entrypoint.isSymbolicLink() || !entrypoint.isFile()
    || entrypoint.uid !== BigInt(expectedUid) || entrypoint.gid !== BigInt(expectedGid)
    || entrypoint.nlink !== 1n
    || ![0o444, 0o555].includes(Number(entrypoint.mode & 0o7777n))) {
    throw codedError('immutable_release_deployment_executor_metadata_invalid');
  }
  const mounts = String(mountInfoText).trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4) {
      throw codedError('immutable_release_deployment_executor_mountinfo_invalid');
    }
    return Object.freeze({
      root: decodeMountPath(fields[3]),
      mountPoint: decodeMountPath(fields[4]),
      options: Object.freeze(fields[5].split(',')),
    });
  });
  if (mounts.some(({ mountPoint }) => mountPoint !== selectedRoot
    && withinOrSame(selectedRoot, mountPoint))) {
    throw codedError('immutable_release_deployment_executor_nested_mount_forbidden');
  }
  let releasePath = selectedRoot;
  if (selectedRoot === sealedRoot) {
    const selected = mounts.filter(({ mountPoint }) => mountPoint === sealedRoot);
    if (selected.length !== 1
      || !['ro', 'nosuid', 'nodev'].every((option) => selected[0].options.includes(option))
      || path.dirname(selected[0].root) !== releaseStore
      || !/^[0-9a-f]{40}$/u.test(path.basename(selected[0].root))) {
      throw codedError('immutable_release_deployment_executor_mount_invalid');
    }
    const source = fs.lstatSync(selected[0].root, { bigint: true });
    if (fs.realpathSync(selected[0].root) !== selected[0].root
      || source.isSymbolicLink() || !source.isDirectory()
      || source.uid !== BigInt(expectedUid) || source.gid !== BigInt(expectedGid)
      || (source.mode & 0o7777n) !== 0o555n
      || source.dev !== root.dev || source.ino !== root.ino) {
      throw codedError('immutable_release_deployment_executor_mount_identity_invalid');
    }
    releasePath = selected[0].root;
  } else {
    const store = fs.lstatSync(releaseStore, { bigint: true });
    if (fs.realpathSync(releaseStore) !== releaseStore || store.isSymbolicLink()
      || !store.isDirectory() || store.uid !== BigInt(expectedUid)
      || store.gid !== BigInt(expectedGid) || (store.mode & 0o7777n) !== 0o755n) {
      throw codedError('immutable_release_deployment_executor_store_invalid');
    }
  }
  if (!Number.isSafeInteger(inheritedLockFd) || inheritedLockFd < 3) {
    throw codedError('immutable_release_deployment_inherited_lock_required');
  }
  const lock = fs.lstatSync(deploymentLock, { bigint: true });
  const inheritedLock = fs.fstatSync(inheritedLockFd, { bigint: true });
  if (!lock.isFile() || lock.isSymbolicLink()
    || lock.uid !== BigInt(expectedUid) || lock.gid !== BigInt(expectedGid)
    || (lock.mode & 0o7777n) !== 0o600n || lock.nlink !== 1n || lock.size !== 0n
    || lock.dev !== inheritedLock.dev || lock.ino !== inheritedLock.ino) {
    throw codedError('immutable_release_deployment_inherited_lock_invalid');
  }
  const executorEntries = inspectSealedExecutorTree(selectedRoot, { expectedUid, expectedGid });
  const closureHash = inspectSealedExecutorClosure(selectedRoot, { expectedUid, expectedGid });
  return Object.freeze({
    status: 'immutable_release_deployment_executor_verified',
    launcher: installedLauncher,
    entrypoint: selectedEntrypoint,
    releasePath,
    closureHash,
    executorEntries,
  });
}
