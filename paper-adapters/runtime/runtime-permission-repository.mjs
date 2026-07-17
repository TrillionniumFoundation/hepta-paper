import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

export const RUNTIME_PERMISSION_POLICY = Object.freeze({
  version: 2,
  kind: 'RuntimePermissionPolicy',
  directoryMode: '0700',
  writableRegularFileMode: '0600',
  readOnlyRegularFileMode: '0400',
  writableExecutableFileMode: '0700',
  readOnlyExecutableFileMode: '0500',
  executableRule: 'preserve_owner_execution_only_when_any_execution_bit_was_present',
  writeRule: 'preserve_read_only_files_without_granting_owner_write',
  symbolicLinks: 'forbidden',
  multiplyLinkedRegularFiles: 'forbidden',
  specialFiles: 'forbidden',
  mutation: 'descriptor_relative_fchmod_only',
});

function octalMode(mode) {
  return (Number(mode) & 0o777).toString(8).padStart(4, '0');
}

function modeNumber(stat) {
  return Number(stat.mode & 0o777n);
}

function typeOf(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'regular_file';
  if (stat.isSymbolicLink()) return 'symbolic_link';
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isBlockDevice()) return 'block_device';
  if (stat.isCharacterDevice()) return 'character_device';
  return 'unknown';
}

function identityOf(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    type: typeOf(stat),
    linkCount: Number(stat.nlink),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
  });
}

function sameObject(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && typeOf(left) === typeOf(right);
}

function sameIdentity(identity, stat) {
  return identity.device === String(stat.dev)
    && identity.inode === String(stat.ino)
    && identity.type === typeOf(stat);
}

function descriptorAccessPath(descriptor, { directory = false } = {}) {
  const expected = fs.fstatSync(descriptor, { bigint: true });
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    const candidate = path.join(base, String(descriptor));
    let probe;
    try {
      probe = fs.openSync(
        directory ? path.join(candidate, '.') : candidate,
        fs.constants.O_RDONLY | (directory ? DIRECTORY_ONLY : 0),
      );
      if (sameObject(expected, fs.fstatSync(probe, { bigint: true }))) return candidate;
    } catch {
      // A descriptor namespace is used only after its identity is proven.
    } finally {
      if (probe !== undefined) fs.closeSync(probe);
    }
  }
  throw new Error('descriptor_relative_runtime_permission_io_unsupported');
}

function descriptorEntryPath(descriptor, name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('runtime_permission_entry_name_invalid');
  }
  return path.join(descriptorAccessPath(descriptor, { directory: true }), name);
}

function openedRealPath(descriptor, { directory = false } = {}) {
  return fs.realpathSync.native(descriptorAccessPath(descriptor, { directory }));
}

function blocker(relativePath, reason, details = null) {
  return Object.freeze({
    relativePath,
    reason,
    ...(details ? { details } : {}),
  });
}

function sorted(rows) {
  return [...rows].sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
      || String(left.reason || '').localeCompare(String(right.reason || ''))
  ));
}

function targetModeFor(stat) {
  if (stat.isDirectory()) return 0o700;
  const currentMode = modeNumber(stat);
  const executable = (currentMode & 0o111) !== 0;
  const writable = (currentMode & 0o222) !== 0;
  if (executable) return writable ? 0o700 : 0o500;
  return writable ? 0o600 : 0o400;
}

function permissionRecord(relativePath, stat) {
  const currentMode = modeNumber(stat);
  const targetMode = targetModeFor(stat);
  return Object.freeze({
    relativePath,
    type: typeOf(stat),
    currentMode: octalMode(currentMode),
    targetMode: octalMode(targetMode),
    identity: identityOf(stat),
  });
}

function openRoot(runtimeRoot) {
  const resolved = path.resolve(runtimeRoot);
  const observed = fs.lstatSync(resolved, { bigint: true });
  if (observed.isSymbolicLink()) throw new Error('runtime_permission_root_symbolic_link_forbidden');
  if (!observed.isDirectory()) throw new Error('runtime_permission_root_not_directory');
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
  try {
    const pinned = fs.fstatSync(descriptor, { bigint: true });
    if (!sameObject(observed, pinned) || !pinned.isDirectory()) {
      throw new Error('runtime_permission_root_identity_changed');
    }
    const realPath = openedRealPath(descriptor, { directory: true });
    return { descriptor, resolved, realPath, identity: identityOf(pinned) };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function entryStillInsideRoot(root, descriptor, { directory = false } = {}) {
  const realPath = openedRealPath(descriptor, { directory });
  return isPathWithin(root.realPath, realPath);
}

function scanRuntimePermissionTree(runtimeRoot, { maximumEntries = 100_000 } = {}) {
  const planned = [];
  const skipped = [];
  const blockers = [];
  let root;
  let entriesSeen = 0;

  const recordSafeEntry = (relativePath, stat) => {
    const row = permissionRecord(relativePath, stat);
    if (row.currentMode === row.targetMode) {
      skipped.push(Object.freeze({ ...row, reason: 'already_compliant' }));
    } else {
      planned.push(row);
    }
  };

  const visitDirectory = (descriptor, relativePath, initialStat) => {
    if (entriesSeen >= maximumEntries) {
      blockers.push(blocker(relativePath, 'runtime_permission_entry_limit_exceeded', { maximumEntries }));
      return;
    }
    entriesSeen += 1;
    recordSafeEntry(relativePath, initialStat);
    let names;
    try {
      names = fs.readdirSync(descriptorAccessPath(descriptor, { directory: true })).sort();
    } catch (error) {
      blockers.push(blocker(relativePath, 'runtime_permission_directory_read_failed', { code: error?.code || 'unknown' }));
      return;
    }
    for (const name of names) {
      if (entriesSeen >= maximumEntries) {
        blockers.push(blocker(relativePath, 'runtime_permission_entry_limit_exceeded', { maximumEntries }));
        break;
      }
      const childRelative = relativePath === '.' ? name : `${relativePath}/${name}`;
      let observed;
      let childDescriptor;
      let counted = false;
      try {
        const candidate = descriptorEntryPath(descriptor, name);
        observed = fs.lstatSync(candidate, { bigint: true });
        const observedType = typeOf(observed);
        if (observed.isSymbolicLink()) {
          entriesSeen += 1;
          counted = true;
          blockers.push(blocker(childRelative, 'runtime_permission_symbolic_link_forbidden'));
          continue;
        }
        if (!observed.isDirectory() && !observed.isFile()) {
          entriesSeen += 1;
          counted = true;
          blockers.push(blocker(childRelative, 'runtime_permission_special_file_forbidden', { type: observedType }));
          continue;
        }
        childDescriptor = fs.openSync(
          candidate,
          fs.constants.O_RDONLY | NO_FOLLOW | (observed.isDirectory() ? DIRECTORY_ONLY : 0),
        );
        const pinned = fs.fstatSync(childDescriptor, { bigint: true });
        if (!sameObject(observed, pinned)) {
          entriesSeen += 1;
          counted = true;
          blockers.push(blocker(childRelative, 'runtime_permission_entry_identity_changed'));
          continue;
        }
        if (!entryStillInsideRoot(root, childDescriptor, { directory: pinned.isDirectory() })) {
          entriesSeen += 1;
          counted = true;
          blockers.push(blocker(childRelative, 'runtime_permission_entry_escaped_root'));
          continue;
        }
        if (pinned.isFile() && Number(pinned.nlink) !== 1) {
          entriesSeen += 1;
          counted = true;
          blockers.push(blocker(childRelative, 'runtime_permission_multiply_linked_file_forbidden', {
            linkCount: Number(pinned.nlink),
          }));
          continue;
        }
        if (pinned.isDirectory()) {
          visitDirectory(childDescriptor, childRelative, pinned);
          counted = true;
        } else {
          entriesSeen += 1;
          counted = true;
          recordSafeEntry(childRelative, pinned);
        }
      } catch (error) {
        if (!counted) entriesSeen += 1;
        blockers.push(blocker(childRelative, 'runtime_permission_entry_open_failed', {
          code: error?.code || error?.message || 'unknown',
        }));
      } finally {
        if (childDescriptor !== undefined) fs.closeSync(childDescriptor);
      }
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameObject(initialStat, after)
      || String(initialStat.mtimeNs) !== String(after.mtimeNs)
      || Number(initialStat.size) !== Number(after.size)) {
      blockers.push(blocker(relativePath, 'runtime_permission_directory_changed_during_scan'));
    }
  };

  try {
    root = openRoot(runtimeRoot);
    visitDirectory(root.descriptor, '.', fs.fstatSync(root.descriptor, { bigint: true }));
    const currentRoot = fs.lstatSync(root.resolved, { bigint: true });
    if (!sameIdentity(root.identity, currentRoot) || currentRoot.isSymbolicLink()) {
      blockers.push(blocker('.', 'runtime_permission_root_identity_changed'));
    }
  } catch (error) {
    blockers.push(blocker('.', error?.message || 'runtime_permission_root_open_failed', {
      code: error?.code || 'unknown',
    }));
  } finally {
    if (root?.descriptor !== undefined) fs.closeSync(root.descriptor);
  }

  const orderedPlanned = sorted(planned);
  const orderedSkipped = sorted(skipped);
  const orderedBlockers = sorted(blockers);
  const inventory = {
    runtimeRoot: path.resolve(runtimeRoot),
    runtimeRealRoot: root?.realPath || null,
    rootIdentity: root?.identity || null,
    policy: RUNTIME_PERMISSION_POLICY,
    planned: orderedPlanned,
    skipped: orderedSkipped,
    blockers: orderedBlockers,
    entriesSeen,
  };
  return Object.freeze({
    ...inventory,
    inventoryHash: hashRecord('RuntimePermissionInventory', inventory),
  });
}

function openRelativeEntry(root, row) {
  if (row.relativePath === '.') {
    const stat = fs.fstatSync(root.descriptor, { bigint: true });
    if (!sameIdentity(row.identity, stat)) throw new Error('runtime_permission_entry_identity_changed');
    return { descriptor: root.descriptor, close: false, stat };
  }
  const components = row.relativePath.split('/');
  let descriptor = root.descriptor;
  let closeDescriptor = false;
  try {
    for (let index = 0; index < components.length; index += 1) {
      const final = index === components.length - 1;
      const expectDirectory = !final || row.type === 'directory';
      const child = fs.openSync(
        descriptorEntryPath(descriptor, components[index]),
        fs.constants.O_RDONLY | NO_FOLLOW | (expectDirectory ? DIRECTORY_ONLY : 0),
      );
      if (closeDescriptor) fs.closeSync(descriptor);
      descriptor = child;
      closeDescriptor = true;
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (expectDirectory && !stat.isDirectory()) throw new Error('runtime_permission_parent_not_directory');
      if (!entryStillInsideRoot(root, descriptor, { directory: stat.isDirectory() })) {
        throw new Error('runtime_permission_entry_escaped_root');
      }
    }
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(row.identity, stat)) throw new Error('runtime_permission_entry_identity_changed');
    if (stat.isFile() && Number(stat.nlink) !== 1) {
      throw new Error('runtime_permission_multiply_linked_file_forbidden');
    }
    return { descriptor, close: true, stat };
  } catch (error) {
    if (closeDescriptor) fs.closeSync(descriptor);
    throw error;
  }
}

function applyRuntimePermissionPlan(initial) {
  const applied = [];
  const blockers = [];
  let root;
  try {
    root = openRoot(initial.runtimeRoot);
    if (!initial.rootIdentity || !sameIdentity(initial.rootIdentity, fs.fstatSync(root.descriptor, { bigint: true }))) {
      throw new Error('runtime_permission_root_identity_changed');
    }
    for (const row of initial.planned) {
      let opened;
      try {
        const currentRoot = fs.lstatSync(root.resolved, { bigint: true });
        if (!sameIdentity(initial.rootIdentity, currentRoot) || currentRoot.isSymbolicLink()) {
          throw new Error('runtime_permission_root_identity_changed');
        }
        opened = openRelativeEntry(root, row);
        if (octalMode(modeNumber(opened.stat)) !== row.currentMode) {
          throw new Error('runtime_permission_entry_mode_changed');
        }
        const targetMode = Number.parseInt(row.targetMode, 8);
        fs.fchmodSync(opened.descriptor, targetMode);
        const verified = fs.fstatSync(opened.descriptor, { bigint: true });
        if (!sameIdentity(row.identity, verified) || modeNumber(verified) !== targetMode) {
          throw new Error('runtime_permission_post_chmod_verification_failed');
        }
        applied.push(Object.freeze({ ...row, appliedMode: octalMode(modeNumber(verified)) }));
      } catch (error) {
        blockers.push(blocker(row.relativePath, error?.message || 'runtime_permission_apply_failed', {
          code: error?.code || 'unknown',
        }));
        break;
      } finally {
        if (opened?.close) fs.closeSync(opened.descriptor);
      }
    }
  } catch (error) {
    blockers.push(blocker('.', error?.message || 'runtime_permission_apply_root_failed', {
      code: error?.code || 'unknown',
    }));
  } finally {
    if (root?.descriptor !== undefined) fs.closeSync(root.descriptor);
  }
  return Object.freeze({ applied: sorted(applied), blockers: sorted(blockers) });
}

export function auditRuntimePermissions({ runtimeRoot, execute = false, maximumEntries = 100_000 } = {}) {
  if (!runtimeRoot) throw new Error('runtime_permission_root_required');
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new Error('runtime_permission_maximum_entries_invalid');
  }
  const initial = scanRuntimePermissionTree(runtimeRoot, { maximumEntries });
  let applied = [];
  let applyBlockers = [];
  let postcondition = null;
  if (execute && initial.blockers.length === 0) {
    const result = applyRuntimePermissionPlan(initial);
    applied = result.applied;
    applyBlockers = result.blockers;
    postcondition = scanRuntimePermissionTree(runtimeRoot, { maximumEntries });
  }
  const blockers = sorted([
    ...initial.blockers.map((row) => ({ ...row, phase: 'initial_scan' })),
    ...applyBlockers.map((row) => ({ ...row, phase: 'apply' })),
    ...(postcondition?.blockers || []).map((row) => ({ ...row, phase: 'postcondition_scan' })),
  ]);
  if (execute && postcondition && postcondition.planned.length !== 0) {
    blockers.push(blocker('.', 'runtime_permission_postcondition_not_compliant', {
      remainingPlannedCount: postcondition.planned.length,
    }));
  }
  const status = execute
    ? (blockers.length
      ? 'runtime_permissions_blocked'
      : (initial.planned.length ? 'runtime_permissions_hardened' : 'runtime_permissions_already_compliant'))
    : (initial.blockers.length
      ? 'runtime_permissions_audit_blocked'
      : (initial.planned.length ? 'runtime_permissions_changes_planned' : 'runtime_permissions_compliant'));
  const payload = {
    version: 1,
    kind: 'RuntimePermissionHygieneReceipt',
    status,
    execute: Boolean(execute),
    runtimeRoot: initial.runtimeRoot,
    runtimeRealRoot: initial.runtimeRealRoot,
    policy: RUNTIME_PERMISSION_POLICY,
    planned: initial.planned,
    applied,
    skipped: initial.skipped,
    blockers: sorted(blockers),
    summary: {
      entriesSeen: initial.entriesSeen,
      plannedCount: initial.planned.length,
      appliedCount: applied.length,
      skippedCount: initial.skipped.length,
      blockerCount: blockers.length,
    },
    initialInventoryHash: initial.inventoryHash,
    postconditionInventoryHash: postcondition?.inventoryHash || null,
  };
  return Object.freeze({
    ...payload,
    runtimePermissionReceiptHash: hashRecord('RuntimePermissionHygieneReceipt', payload),
  });
}
