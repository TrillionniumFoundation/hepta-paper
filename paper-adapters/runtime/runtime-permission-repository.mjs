import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  emptyRuntimePermissionApplyResult,
  executeLockedRuntimePermissionPlan,
  rollbackCommittedRuntimePermissionPlan,
  rollbackRuntimePermissionRows,
} from './runtime-permission-execution-lock.mjs';
import {
  RUNTIME_PERMISSION_SCAN_LIMITS,
  resolveRuntimePermissionLimits,
} from './runtime-permission-scan-limits.mjs';

export { RUNTIME_PERMISSION_SCAN_LIMITS };

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

export const RUNTIME_PERMISSION_POLICY = Object.freeze({
  version: 3,
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
  mutation: 'descriptor_relative_fchmod_with_best_effort_failure_rollback',
  inventory: 'complete_descriptor_relative_scan_with_hash_bound_bounded_report_pages',
  executionPlan: 'fully_materialized_bounded_plan_required_before_first_mutation',
  executionLock: 'runtime_root_scoped_exclusive_lock_with_locked_inventory_revalidation',
  writerQuiescence: 'caller_confirmed_cooperative_runtime_writer_quiescence_required',
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

function sameCompleteIdentity(identity, stat) {
  return identity.device === String(stat.dev)
    && identity.inode === String(stat.ino)
    && identity.type === typeOf(stat)
    && identity.linkCount === Number(stat.nlink)
    && identity.size === Number(stat.size)
    && identity.mtimeNs === String(stat.mtimeNs);
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

function blocker(relativePath, reason, details = null) {
  return Object.freeze({
    relativePath,
    reason,
    ...(details ? { details: Object.freeze({ ...details }) } : {}),
  });
}

function pageMetadata(totalCount, reportedCount, limit) {
  const omittedCount = totalCount - reportedCount;
  return Object.freeze({ limit, totalCount, reportedCount, omittedCount, truncated: omittedCount > 0 });
}

function createBoundedRowAccumulator(kind, reportLimit) {
  const digest = crypto.createHash('sha256');
  digest.update(`${kind}\0`);
  const rows = [];
  let count = 0;
  return {
    get count() { return count; },
    add(value) {
      const row = Object.freeze(value);
      const rowHash = hashRecord(`${kind}Row`, row);
      digest.update(`${count}\0${rowHash}\0`);
      count += 1;
      if (rows.length < reportLimit) rows.push(row);
      return row;
    },
    finish() {
      const page = Object.freeze([...rows]);
      return Object.freeze({
        rows: page, count, rowsHash: `sha256:${digest.digest('hex')}`,
        page: pageMetadata(count, page.length, reportLimit),
      });
    },
  };
}

function readBoundedDirectoryNames(descriptor, maximumDirectoryEntries) {
  const directory = fs.opendirSync(descriptorAccessPath(descriptor, { directory: true }));
  const names = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) {
        return Object.freeze({
          exceeded: false, names: Object.freeze(names.sort()), observedAtLeast: names.length,
        });
      }
      if (names.length >= maximumDirectoryEntries) {
        return Object.freeze({
          exceeded: true, names: Object.freeze([]), observedAtLeast: names.length + 1,
        });
      }
      names.push(entry.name);
    }
  } finally {
    try {
      directory.closeSync();
    } catch (error) {
      if (error?.code !== 'ERR_DIR_CLOSED') throw error;
    }
  }
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
    const realPath = fs.realpathSync.native(descriptorAccessPath(descriptor, { directory: true }));
    return { descriptor, resolved, realPath, identity: identityOf(pinned) };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function entryStillInsideRoot(root, descriptor, { directory = false } = {}) {
  const realPath = fs.realpathSync.native(descriptorAccessPath(descriptor, { directory }));
  return isPathWithin(root.realPath, realPath);
}

function scanRuntimePermissionTree(runtimeRoot, limits) {
  const {
    maximumEntries, maximumDirectoryEntries, maximumDepth, reportLimit,
    maximumExecutePlanEntries,
  } = limits;
  const plannedRows = createBoundedRowAccumulator('RuntimePermissionPlannedRows', reportLimit);
  const skippedRows = createBoundedRowAccumulator('RuntimePermissionSkippedRows', reportLimit);
  const blockerRows = createBoundedRowAccumulator('RuntimePermissionBlockerRows', reportLimit);
  const executionPlan = [];
  let executionPlanComplete = true;
  let inventoryComplete = true;
  let entryLimitReached = false;
  let entriesSeen = 0;
  let maximumDepthObserved = 0;
  let root;

  const addBlocker = (relativePath, reason, details = null, incomplete = false) => {
    if (incomplete) inventoryComplete = false;
    blockerRows.add(blocker(relativePath, reason, details));
  };
  const reserveEntry = () => {
    if (entryLimitReached) return false;
    if (entriesSeen < maximumEntries) {
      entriesSeen += 1;
      return true;
    }
    entryLimitReached = true;
    addBlocker('.', 'runtime_permission_entry_limit_exceeded', {
      maximumEntries, entriesSeen,
    }, true);
    return false;
  };
  const recordSafeEntry = (relativePath, stat) => {
    const row = permissionRecord(relativePath, stat);
    if (row.currentMode === row.targetMode) {
      skippedRows.add(Object.freeze({ ...row, reason: 'already_compliant' }));
    } else {
      const planned = plannedRows.add(row);
      if (executionPlan.length < maximumExecutePlanEntries) executionPlan.push(planned);
      else executionPlanComplete = false;
    }
  };
  const visitDirectory = (descriptor, relativePath, initialStat, depth) => {
    maximumDepthObserved = Math.max(maximumDepthObserved, depth);
    recordSafeEntry(relativePath, initialStat);
    let listing;
    try {
      listing = readBoundedDirectoryNames(descriptor, maximumDirectoryEntries);
    } catch (error) {
      addBlocker(relativePath, 'runtime_permission_directory_read_failed', {
        code: error?.code || error?.message || 'unknown',
      }, true);
      return;
    }
    if (listing.exceeded) {
      addBlocker(relativePath, 'runtime_permission_directory_entry_limit_exceeded', {
        maximumDirectoryEntries, observedAtLeast: listing.observedAtLeast,
      }, true);
      return;
    }
    for (const name of listing.names) {
      const childRelative = relativePath === '.' ? name : `${relativePath}/${name}`;
      if (!reserveEntry()) break;
      let childDescriptor;
      try {
        const candidate = descriptorEntryPath(descriptor, name);
        const observed = fs.lstatSync(candidate, { bigint: true });
        if (observed.isSymbolicLink()) {
          addBlocker(childRelative, 'runtime_permission_symbolic_link_forbidden', {
            identity: identityOf(observed),
          });
          continue;
        }
        if (!observed.isDirectory() && !observed.isFile()) {
          addBlocker(childRelative, 'runtime_permission_special_file_forbidden', {
            type: typeOf(observed), identity: identityOf(observed),
          });
          continue;
        }
        childDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW
          | (observed.isDirectory() ? DIRECTORY_ONLY : 0));
        const pinned = fs.fstatSync(childDescriptor, { bigint: true });
        if (!sameObject(observed, pinned)) {
          addBlocker(childRelative, 'runtime_permission_entry_identity_changed', {
            observedIdentity: identityOf(observed), pinnedIdentity: identityOf(pinned),
          }, true);
          continue;
        }
        if (!entryStillInsideRoot(root, childDescriptor, { directory: pinned.isDirectory() })) {
          addBlocker(childRelative, 'runtime_permission_entry_escaped_root', null, true);
          continue;
        }
        if (pinned.isFile() && Number(pinned.nlink) !== 1) {
          addBlocker(childRelative, 'runtime_permission_multiply_linked_file_forbidden', {
            identity: identityOf(pinned), linkCount: Number(pinned.nlink),
          });
          continue;
        }
        if (!pinned.isDirectory()) {
          recordSafeEntry(childRelative, pinned);
          continue;
        }
        const childDepth = depth + 1;
        maximumDepthObserved = Math.max(maximumDepthObserved, childDepth);
        if (childDepth > maximumDepth) {
          recordSafeEntry(childRelative, pinned);
          addBlocker(childRelative, 'runtime_permission_depth_limit_exceeded', {
            maximumDepth, observedDepth: childDepth,
          }, true);
        } else {
          visitDirectory(childDescriptor, childRelative, pinned, childDepth);
        }
      } catch (error) {
        addBlocker(childRelative, 'runtime_permission_entry_open_failed', {
          code: error?.code || error?.message || 'unknown',
        }, true);
      } finally {
        if (childDescriptor !== undefined) fs.closeSync(childDescriptor);
      }
    }
    try {
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameObject(initialStat, after)
        || String(initialStat.mtimeNs) !== String(after.mtimeNs)
        || Number(initialStat.size) !== Number(after.size)) {
        addBlocker(relativePath, 'runtime_permission_directory_changed_during_scan', null, true);
      }
    } catch (error) {
      addBlocker(relativePath, 'runtime_permission_directory_reinspection_failed', {
        code: error?.code || error?.message || 'unknown',
      }, true);
    }
  };

  try {
    root = openRoot(runtimeRoot);
    if (reserveEntry()) {
      visitDirectory(root.descriptor, '.', fs.fstatSync(root.descriptor, { bigint: true }), 0);
    }
    const currentRoot = fs.lstatSync(root.resolved, { bigint: true });
    if (!sameCompleteIdentity(root.identity, currentRoot) || currentRoot.isSymbolicLink()) {
      addBlocker('.', 'runtime_permission_root_identity_changed', null, true);
    }
  } catch (error) {
    addBlocker('.', error?.message || 'runtime_permission_root_open_failed', {
      code: error?.code || 'unknown',
    }, true);
  } finally {
    if (root?.descriptor !== undefined) fs.closeSync(root.descriptor);
  }
  if (!executionPlanComplete) {
    addBlocker('.', 'runtime_permission_execute_plan_limit_exceeded', {
      maximumExecutePlanEntries, plannedCount: plannedRows.count,
    });
  }
  const planned = plannedRows.finish();
  const skipped = skippedRows.finish();
  const blockers = blockerRows.finish();
  const inventoryPayload = {
    version: 1,
    kind: 'RuntimePermissionInventoryEvidence',
    runtimeRoot: path.resolve(runtimeRoot),
    runtimeRealRoot: root?.realPath || null,
    rootIdentity: root?.identity || null,
    policy: RUNTIME_PERMISSION_POLICY,
    scanLimits: Object.freeze({
      maximumEntries, maximumDirectoryEntries, maximumDepth, maximumExecutePlanEntries,
    }),
    inventoryComplete,
    executionPlanComplete,
    entriesSeen,
    maximumDepthObserved,
    plannedCount: planned.count,
    plannedRowsHash: planned.rowsHash,
    skippedCount: skipped.count,
    skippedRowsHash: skipped.rowsHash,
    blockerCount: blockers.count,
    blockerRowsHash: blockers.rowsHash,
  };
  const inventoryEvidence = Object.freeze({
    ...inventoryPayload,
    inventoryHash: hashRecord('RuntimePermissionInventory', inventoryPayload),
  });
  return Object.freeze({
    runtimeRoot: inventoryEvidence.runtimeRoot,
    runtimeRealRoot: inventoryEvidence.runtimeRealRoot,
    rootIdentity: inventoryEvidence.rootIdentity,
    inventoryComplete,
    executionPlanComplete,
    entriesSeen,
    maximumDepthObserved,
    planned: planned.rows,
    plannedCount: planned.count,
    plannedRowsHash: planned.rowsHash,
    skipped: skipped.rows,
    skippedCount: skipped.count,
    skippedRowsHash: skipped.rowsHash,
    blockers: blockers.rows,
    blockerCount: blockers.count,
    blockerRowsHash: blockers.rowsHash,
    reportPages: Object.freeze({
      planned: planned.page, skipped: skipped.page, blockers: blockers.page,
    }),
    executionPlan: Object.freeze([...executionPlan]),
    inventoryEvidence,
    inventoryHash: inventoryEvidence.inventoryHash,
  });
}
function openRelativeEntry(root, row) {
  if (row.relativePath === '.') {
    const stat = fs.fstatSync(root.descriptor, { bigint: true });
    if (!sameCompleteIdentity(row.identity, stat)) throw new Error('runtime_permission_entry_identity_changed');
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
    if (!sameCompleteIdentity(row.identity, stat)) throw new Error('runtime_permission_entry_identity_changed');
    if (stat.isFile() && Number(stat.nlink) !== 1) {
      throw new Error('runtime_permission_multiply_linked_file_forbidden');
    }
    return { descriptor, close: true, stat };
  } catch (error) {
    if (closeDescriptor) fs.closeSync(descriptor);
    throw error;
  }
}

function openCurrentPlanEntry(root, initial, row) {
  const currentRoot = fs.lstatSync(root.resolved, { bigint: true });
  if (!sameCompleteIdentity(initial.rootIdentity, currentRoot)
    || currentRoot.isSymbolicLink()) {
    throw new Error('runtime_permission_root_identity_changed');
  }
  let opened;
  try {
    opened = openRelativeEntry(root, row);
    if (octalMode(modeNumber(opened.stat)) !== row.currentMode) {
      throw new Error('runtime_permission_entry_mode_changed');
    }
    return opened;
  } catch (error) {
    if (opened?.close) fs.closeSync(opened.descriptor);
    throw error;
  }
}

function applyRuntimePermissionPlan(initial, reportLimit) {
  const appliedRows = createBoundedRowAccumulator('RuntimePermissionAppliedRows', reportLimit);
  const blockerRows = createBoundedRowAccumulator('RuntimePermissionApplyBlockerRows', reportLimit);
  const mutatedRows = [];
  let rolledBackCount = 0;
  let rollbackIncomplete = false;
  let root;
  let phase = 'plan_validation';
  let activeRow = null;
  try {
    if (!initial.inventoryComplete
      || !initial.executionPlanComplete
      || initial.executionPlan.length !== initial.plannedCount) {
      throw new Error('runtime_permission_execute_plan_incomplete');
    }
    root = openRoot(initial.runtimeRoot);
    if (!initial.rootIdentity || root.realPath !== initial.runtimeRealRoot
      || !sameCompleteIdentity(initial.rootIdentity, fs.fstatSync(root.descriptor, { bigint: true }))) {
      throw new Error('runtime_permission_root_identity_changed');
    }
    for (const row of initial.executionPlan) {
      activeRow = row;
      const opened = openCurrentPlanEntry(root, initial, row);
      if (opened.close) fs.closeSync(opened.descriptor);
    }
    phase = 'apply';
    for (const row of initial.executionPlan) {
      activeRow = row;
      const opened = openCurrentPlanEntry(root, initial, row);
      try {
        const targetMode = Number.parseInt(row.targetMode, 8);
        fs.fchmodSync(opened.descriptor, targetMode);
        mutatedRows.push(row);
        const verified = fs.fstatSync(opened.descriptor, { bigint: true });
        if (!sameCompleteIdentity(row.identity, verified)
          || modeNumber(verified) !== targetMode) {
          throw new Error('runtime_permission_post_chmod_verification_failed');
        }
      } finally {
        if (opened.close) fs.closeSync(opened.descriptor);
      }
    }
    for (const row of mutatedRows) {
      appliedRows.add(Object.freeze({ ...row, appliedMode: row.targetMode }));
    }
  } catch (error) {
    blockerRows.add(Object.freeze({
      ...blocker(activeRow?.relativePath || '.',
        error?.message || 'runtime_permission_apply_failed',
        { code: error?.code || 'unknown' }),
      phase,
    }));
    const rollback = rollbackRuntimePermissionRows({
      root, rows: mutatedRows, openEntry: openRelativeEntry,
      sameIdentity: sameCompleteIdentity,
      reportLimit,
      recordBlocker: blockerRows.add,
    });
    ({ rolledBackCount, rollbackIncomplete } = rollback);
  } finally {
    if (root?.descriptor !== undefined) fs.closeSync(root.descriptor);
  }
  const applied = appliedRows.finish();
  const blockers = blockerRows.finish();
  return Object.freeze({
    applied: applied.rows, appliedCount: applied.count,
    appliedRowsHash: applied.rowsHash, appliedPage: applied.page,
    blockers: blockers.rows, blockerCount: blockers.count,
    blockerRowsHash: blockers.rowsHash,
    mutationAttemptCount: mutatedRows.length,
    rolledBackCount,
    rollbackIncomplete,
  });
}

export function auditRuntimePermissions({
  runtimeRoot, execute = false, maximumEntries, maximumDirectoryEntries,
  maximumDepth, reportLimit, maximumExecutePlanEntries,
  writerQuiescenceConfirmed = false,
} = {}) {
  if (!runtimeRoot) throw new Error('runtime_permission_root_required');
  const limits = resolveRuntimePermissionLimits({
    maximumEntries, maximumDirectoryEntries, maximumDepth, reportLimit,
    maximumExecutePlanEntries,
  });
  const initial = scanRuntimePermissionTree(runtimeRoot, limits);
  const emptyApply = (blockerInput = null) => emptyRuntimePermissionApplyResult({
    reportLimit: limits.reportLimit,
    blockerInput,
    createAccumulator: createBoundedRowAccumulator,
    createBlocker: blocker,
  });
  const {
    applied, postcondition, lockedInventory, executionLock, executionBlockers,
  } = executeLockedRuntimePermissionPlan({
    runtimeRoot, execute, limits, initial, writerQuiescenceConfirmed,
    scan: scanRuntimePermissionTree,
    apply: applyRuntimePermissionPlan,
    rollback: (locked, recordBlocker) => rollbackCommittedRuntimePermissionPlan({
      initial: locked, openRoot, openEntry: openRelativeEntry,
      sameIdentity: sameCompleteIdentity,
      reportLimit: limits.reportLimit,
      recordBlocker,
    }),
    empty: emptyApply,
  });
  const postconditionBlocker = execute && applied.blockerCount === 0
    && postcondition
    && postcondition.plannedCount !== 0
    ? blocker('.', 'runtime_permission_postcondition_not_compliant', {
      remainingPlannedCount: postcondition.plannedCount,
    }) : null;
  const visibleBlockers = Object.freeze([
    ...initial.blockers.map((row) => Object.freeze({ ...row, phase: 'initial_scan' })),
    ...applied.blockers,
    ...executionBlockers,
    ...(postcondition?.blockers || []).map((row) => Object.freeze(
      { ...row, phase: 'postcondition_scan' },
    )),
    ...(postconditionBlocker
      ? [Object.freeze({ ...postconditionBlocker, phase: 'postcondition' })] : []),
  ].slice(0, limits.reportLimit));
  const blockerSources = Object.freeze({
    initialScan: Object.freeze({ count: initial.blockerCount, rowsHash: initial.blockerRowsHash }),
    planOrApply: Object.freeze({ count: applied.blockerCount, rowsHash: applied.blockerRowsHash }),
    executionLock: Object.freeze({
      count: executionBlockers.length,
      rowsHash: hashRecord('RuntimePermissionExecutionBlockerRows', executionBlockers),
    }),
    postconditionScan: Object.freeze({
      count: postcondition?.blockerCount || 0, rowsHash: postcondition?.blockerRowsHash || null,
    }),
    postcondition: Object.freeze({
      count: postconditionBlocker ? 1 : 0,
      rowsHash: hashRecord('RuntimePermissionPostconditionBlockerRows',
        postconditionBlocker ? [postconditionBlocker] : []),
    }),
  });
  const blockerCount = Object.values(blockerSources).reduce(
    (total, value) => total + value.count, 0,
  );
  const blockerRowsHash = hashRecord('RuntimePermissionReceiptBlockerRows', blockerSources);
  const status = execute
    ? (blockerCount
      ? 'runtime_permissions_blocked'
      : (initial.plannedCount
        ? 'runtime_permissions_hardened'
        : 'runtime_permissions_already_compliant'))
    : (initial.blockerCount
      ? 'runtime_permissions_audit_blocked'
      : (initial.plannedCount
        ? 'runtime_permissions_changes_planned'
        : 'runtime_permissions_compliant'));
  const reportPages = Object.freeze({
    limit: limits.reportLimit, planned: initial.reportPages.planned,
    applied: applied.appliedPage, skipped: initial.reportPages.skipped,
    blockers: pageMetadata(blockerCount, visibleBlockers.length, limits.reportLimit),
  });
  const payload = {
    version: 1,
    kind: 'RuntimePermissionHygieneReceipt',
    status,
    execute: Boolean(execute),
    runtimeRoot: initial.runtimeRoot,
    runtimeRealRoot: initial.runtimeRealRoot,
    policy: RUNTIME_PERMISSION_POLICY,
    limits,
    planned: initial.planned,
    applied: applied.applied,
    skipped: initial.skipped,
    blockers: visibleBlockers,
    reportPages,
    summary: {
      entriesSeen: initial.entriesSeen,
      maximumDepthObserved: initial.maximumDepthObserved,
      inventoryComplete: initial.inventoryComplete,
      executionPlanComplete: initial.executionPlanComplete,
      plannedCount: initial.plannedCount,
      appliedCount: applied.appliedCount,
      mutationAttemptCount: applied.mutationAttemptCount,
      rolledBackCount: applied.rolledBackCount,
      rollbackIncomplete: applied.rollbackIncomplete,
      skippedCount: initial.skippedCount,
      blockerCount,
    },
    initialInventory: initial.inventoryEvidence,
    lockedInventory,
    postconditionInventory: postcondition?.inventoryEvidence || null,
    writerQuiescenceConfirmed: Boolean(writerQuiescenceConfirmed),
    executionLock,
    appliedRowsHash: applied.appliedRowsHash,
    blockerRowsHash,
    initialInventoryHash: initial.inventoryHash,
    postconditionInventoryHash: postcondition?.inventoryHash || null,
  };
  return Object.freeze({
    ...payload,
    runtimePermissionReceiptHash: hashRecord('RuntimePermissionHygieneReceipt', payload),
  });
}
