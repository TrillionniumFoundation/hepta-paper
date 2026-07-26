import fs from 'node:fs';
import path from 'node:path';

import {
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';

function currentPrincipalIdentity() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const supplementaryGroups = process.getgroups?.() || [];
  if (!Number.isSafeInteger(uid) || uid < 0
    || !Number.isSafeInteger(gid) || gid < 0
    || supplementaryGroups.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('strict_full_auto_acceptance_runtime_principal_unavailable');
  }
  return Object.freeze({
    uid: String(uid),
    groupIds: new Set([gid, ...supplementaryGroups].map(String)),
  });
}

function effectivePermissionBits(stat, principal) {
  const mode = Number(stat.mode) & 0o777;
  if (String(stat.uid) === principal.uid) return (mode >> 6) & 0o7;
  if (principal.groupIds.has(String(stat.gid))) return (mode >> 3) & 0o7;
  return mode & 0o7;
}

function assertDirectoryAccess({
  stat, selectedPath, rootId, accessMode, errorCode,
}) {
  const mode = Number(stat.mode) & 0o7777;
  const principal = currentPrincipalIdentity();
  if ((mode & 0o022) !== 0) {
    throw new Error(`${errorCode}:${rootId}`);
  }
  if (accessMode === 'read-write') {
    if (String(stat.uid) !== principal.uid
      || (effectivePermissionBits(stat, principal) & 0o7) !== 0o7) {
      throw new Error(`${errorCode}:${rootId}`);
    }
    try {
      fs.accessSync(
        selectedPath,
        fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
      );
    } catch (error) {
      throw new Error(`${errorCode}:${rootId}`, { cause: error });
    }
    return;
  }
  if (!['0', principal.uid].includes(String(stat.uid))) {
    throw new Error(`${errorCode}:${rootId}`);
  }
  const permissions = effectivePermissionBits(stat, principal);
  if ((permissions & 0o5) !== 0o5 || (permissions & 0o2) !== 0) {
    throw new Error(`${errorCode}:${rootId}`);
  }
  try {
    fs.accessSync(selectedPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    throw new Error(`${errorCode}:${rootId}`, { cause: error });
  }
  try {
    fs.accessSync(selectedPath, fs.constants.W_OK);
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') return;
    throw new Error(`${errorCode}:${rootId}`, { cause: error });
  }
  throw new Error(`${errorCode}:${rootId}`);
}

function stableDirectorySnapshot(selectedPath, inspected, rootId, errorCode) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      selectedPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()
      || ['dev', 'ino', 'mode', 'uid', 'gid'].some((field) => (
        String(opened[field]) !== String(inspected[field])
      ))) {
      throw new Error(`${errorCode}:${rootId}`);
    }
    return opened;
  } catch (error) {
    if (String(error?.message || '') === `${errorCode}:${rootId}`) throw error;
    throw new Error(`${errorCode}:${rootId}`, { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function inspectStrictFullAutoAcceptanceRootBinding(candidate, rootId, {
  targetRequired = false,
  accessMode,
} = {}) {
  const resolvedPath = path.resolve(candidate);
  if (!['read-only', 'read-write'].includes(accessMode)) {
    throw new Error(`strict_full_auto_acceptance_root_access_mode_invalid:${rootId}`);
  }
  if (resolvedPath === path.parse(resolvedPath).root) {
    throw new Error(`strict_full_auto_acceptance_root_too_broad:${rootId}`);
  }
  const anchorKind = targetRequired ? 'target' : 'parent';
  const anchorPath = targetRequired ? resolvedPath : path.dirname(resolvedPath);
  let stat;
  try {
    stat = fs.lstatSync(anchorPath, { bigint: true });
  } catch (error) {
    throw new Error(`strict_full_auto_acceptance_root_anchor_missing:${rootId}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(anchorPath) !== anchorPath
  ) {
    throw new Error(`strict_full_auto_acceptance_root_anchor_invalid:${rootId}`);
  }
  assertDirectoryAccess({
    stat,
    selectedPath: anchorPath,
    rootId,
    accessMode,
    errorCode: 'strict_full_auto_acceptance_root_anchor_invalid',
  });
  stat = stableDirectorySnapshot(
    anchorPath,
    stat,
    rootId,
    'strict_full_auto_acceptance_root_anchor_changed',
  );
  let futureTarget = null;
  if (!targetRequired) {
    try { futureTarget = fs.lstatSync(resolvedPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  if (futureTarget) {
    const target = futureTarget;
    if (!target.isDirectory() || target.isSymbolicLink()
      || fs.realpathSync(resolvedPath) !== resolvedPath) {
      throw new Error(`strict_full_auto_acceptance_future_root_target_invalid:${rootId}`);
    }
    assertDirectoryAccess({
      stat: target,
      selectedPath: resolvedPath,
      rootId,
      accessMode,
      errorCode: 'strict_full_auto_acceptance_future_root_target_invalid',
    });
    stableDirectorySnapshot(
      resolvedPath,
      target,
      rootId,
      'strict_full_auto_acceptance_future_root_target_changed',
    );
  }
  const body = Object.freeze({
    rootId,
    accessMode,
    resolvedPath,
    anchorKind,
    anchorPath,
    anchorRealPath: fs.realpathSync(anchorPath),
    anchorDevice: String(stat.dev),
    anchorInode: String(stat.ino),
    anchorMode: Number(stat.mode) & 0o7777,
    anchorUid: String(stat.uid),
    anchorGid: String(stat.gid),
  });
  return Object.freeze({ ...body, identity: strictFullAutoAcceptanceHash(body) });
}

export function preflightStrictFullAutoAcceptanceInputDirectory(candidate, label) {
  const absolute = path.resolve(String(candidate || ''));
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) {
    throw new Error(`strict_full_auto_acceptance_input_directory_missing:${label}`, {
      cause: error,
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error(`strict_full_auto_acceptance_input_directory_invalid:${label}`);
  }
  return absolute;
}
