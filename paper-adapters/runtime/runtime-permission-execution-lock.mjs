import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

function sameObject(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.isFile() === right.isFile();
}

function writeFully(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
  }
}

function lockLocation(runtimeRoot) {
  const resolvedRoot = path.resolve(runtimeRoot);
  const canonicalRoot = fs.realpathSync.native(resolvedRoot);
  const rootStat = fs.lstatSync(resolvedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('runtime_permission_execution_lock_root_invalid');
  }
  const parent = path.dirname(canonicalRoot);
  const parentDescriptor = fs.openSync(
    parent,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  const parentStat = fs.fstatSync(parentDescriptor, { bigint: true });
  if (!parentStat.isDirectory()) {
    fs.closeSync(parentDescriptor);
    throw new Error('runtime_permission_execution_lock_parent_invalid');
  }
  return Object.freeze({
    canonicalRoot,
    parent,
    parentDescriptor,
    parentStat,
    lockPath: path.join(parent, `.${path.basename(canonicalRoot)}.hepta-runtime-permissions.lock`),
  });
}

function releaseLock(location, descriptor, lockStat) {
  let releaseError = null;
  try {
    const current = fs.lstatSync(location.lockPath, { bigint: true });
    const parent = fs.fstatSync(location.parentDescriptor, { bigint: true });
    if (!sameObject(lockStat, current) || !sameObject(location.parentStat, parent)
      || Number(current.nlink) !== 1) {
      throw new Error('runtime_permission_execution_lock_identity_changed');
    }
    fs.unlinkSync(location.lockPath);
    fs.fsyncSync(location.parentDescriptor);
  } catch (error) {
    releaseError = error;
  } finally {
    fs.closeSync(descriptor);
    fs.closeSync(location.parentDescriptor);
  }
  if (releaseError) throw releaseError;
}

export function withRuntimePermissionExecutionLock(runtimeRoot, operation) {
  const location = lockLocation(runtimeRoot);
  let descriptor;
  let lockStat;
  let operationError = null;
  let operationValue;
  let releaseError = null;
  try {
    descriptor = fs.openSync(
      location.lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    lockStat = fs.fstatSync(descriptor, { bigint: true });
    if (!lockStat.isFile() || Number(lockStat.nlink) !== 1) {
      throw new Error('runtime_permission_execution_lock_invalid');
    }
    const payload = Object.freeze({
      version: 1,
      kind: 'RuntimePermissionExecutionLock',
      runtimeRealRoot: location.canonicalRoot,
      ownerPid: process.pid,
      nonce: crypto.randomBytes(32).toString('base64'),
      acquiredAt: new Date().toISOString(),
      writerQuiescence: 'caller_confirmed_cooperative_runtime_writer_quiescence',
    });
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    writeFully(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const current = fs.lstatSync(location.lockPath, { bigint: true });
    const parent = fs.fstatSync(location.parentDescriptor, { bigint: true });
    if (!sameObject(lockStat, current) || !sameObject(location.parentStat, parent)
      || Number(current.nlink) !== 1) {
      throw new Error('runtime_permission_execution_lock_identity_changed');
    }
    operationValue = operation(Object.freeze({
      ...payload,
      executionLockHash: hashRecord('RuntimePermissionExecutionLock', payload),
    }));
  } catch (error) {
    operationError = error;
  } finally {
    if (descriptor !== undefined && lockStat) {
      try { releaseLock(location, descriptor, lockStat); }
      catch (error) {
        releaseError = error;
      }
    } else {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.closeSync(location.parentDescriptor);
    }
  }
  if (operationError) throw operationError;
  return Object.freeze({
    value: operationValue,
    releaseError: releaseError ? Object.freeze({
      reason: releaseError?.message || 'runtime_permission_execution_lock_release_failed',
      code: releaseError?.code || 'unknown',
    }) : null,
  });
}

function boundedPage(totalCount, reportLimit) {
  const reportedCount = Math.min(totalCount, reportLimit);
  return Object.freeze({
    limit: reportLimit,
    totalCount,
    reportedCount,
    omittedCount: totalCount - reportedCount,
    truncated: totalCount > reportedCount,
  });
}

function createBoundedRowAccumulator(kind, reportLimit) {
  const digest = crypto.createHash('sha256');
  digest.update(`${kind}\0`);
  const rows = [];
  let count = 0;
  return Object.freeze({
    add(value) {
      const row = Object.freeze(value);
      digest.update(`${count}\0${hashRecord(`${kind}Row`, row)}\0`);
      count += 1;
      if (rows.length < reportLimit) rows.push(row);
      return row;
    },
    finish() {
      return Object.freeze({
        rows: Object.freeze(rows),
        count,
        rowsHash: `sha256:${digest.digest('hex')}`,
        page: boundedPage(count, reportLimit),
      });
    },
  });
}

function boundedRowEvidence(kind, values, reportLimit) {
  const accumulator = createBoundedRowAccumulator(kind, reportLimit);
  for (const value of values) accumulator.add(value);
  return accumulator.finish();
}

function postconditionRollbackResult({
  applied, rollback, blockerEvidence, reportLimit,
}) {
  const appliedEvidence = boundedRowEvidence('RuntimePermissionAppliedRows', [], reportLimit);
  return Object.freeze({
    ...applied,
    applied: appliedEvidence.rows,
    appliedCount: appliedEvidence.count,
    appliedRowsHash: appliedEvidence.rowsHash,
    appliedPage: appliedEvidence.page,
    blockers: blockerEvidence.rows,
    blockerCount: blockerEvidence.count,
    blockerRowsHash: blockerEvidence.rowsHash,
    rolledBackCount: rollback.rolledBackCount,
    rollbackIncomplete: rollback.rollbackIncomplete,
  });
}

function executionBlocker(reason, details = null, phase = 'execution_lock_release') {
  return Object.freeze({
    relativePath: '.',
    reason,
    details: details ? Object.freeze(details) : null,
    phase,
  });
}

export function executeLockedRuntimePermissionPlan({
  runtimeRoot,
  execute,
  limits,
  initial,
  writerQuiescenceConfirmed,
  scan,
  apply,
  rollback,
  empty,
} = {}) {
  if (execute !== true || initial.blockerCount !== 0) {
    return Object.freeze({
      applied: empty(),
      executionLock: null,
      executionBlockers: Object.freeze([]),
      lockedInventory: null,
      postcondition: null,
    });
  }
  if (writerQuiescenceConfirmed !== true) {
    return Object.freeze({
      applied: empty({
        reason: 'runtime_permission_writer_quiescence_confirmation_required',
        phase: 'execution_precondition',
      }),
      executionLock: null,
      executionBlockers: Object.freeze([]),
      lockedInventory: null,
      postcondition: null,
    });
  }
  let result;
  try {
    const lockedExecution = withRuntimePermissionExecutionLock(runtimeRoot, (executionLock) => {
      const locked = scan(runtimeRoot, limits);
      if (locked.inventoryHash !== initial.inventoryHash) {
        return Object.freeze({
          applied: empty({
            reason: 'runtime_permission_locked_inventory_changed',
            phase: 'locked_plan_validation',
            details: {
              expectedInventoryHash: initial.inventoryHash,
              lockedInventoryHash: locked.inventoryHash,
            },
          }),
          executionLock,
          executionBlockers: Object.freeze([]),
          lockedInventory: locked.inventoryEvidence,
          postcondition: null,
        });
      }
      const applied = apply(locked, limits.reportLimit);
      if (applied.blockerCount !== 0) {
        try {
          return Object.freeze({
            applied,
            executionLock,
            executionBlockers: Object.freeze([]),
            lockedInventory: locked.inventoryEvidence,
            postcondition: scan(runtimeRoot, limits),
          });
        } catch (error) {
          return Object.freeze({
            applied,
            executionLock,
            executionBlockers: Object.freeze([executionBlocker(
              'runtime_permission_postcondition_scan_failed',
              {
                code: error?.code || 'unknown',
                cause: error?.message || 'unknown',
              },
              'postcondition_scan',
            )]),
            lockedInventory: locked.inventoryEvidence,
            postcondition: null,
          });
        }
      }
      let postcondition;
      let failure = null;
      try {
        postcondition = scan(runtimeRoot, limits);
        if (postcondition.blockerCount !== 0 || postcondition.plannedCount !== 0) {
          failure = Object.freeze({
            reason: 'runtime_permission_postcondition_not_compliant',
            details: {
              blockerCount: postcondition.blockerCount,
              remainingPlannedCount: postcondition.plannedCount,
            },
          });
        }
      } catch (error) {
        failure = Object.freeze({
          reason: 'runtime_permission_postcondition_scan_failed',
          details: {
            code: error?.code || 'unknown',
            cause: error?.message || 'unknown',
          },
        });
      }
      if (!failure) {
        return Object.freeze({
          applied,
          executionLock,
          executionBlockers: Object.freeze([]),
          lockedInventory: locked.inventoryEvidence,
          postcondition,
        });
      }
      const blockerRows = createBoundedRowAccumulator(
        'RuntimePermissionApplyBlockerRows', limits.reportLimit,
      );
      blockerRows.add(executionBlocker(failure.reason, failure.details, 'postcondition'));
      const rollbackResult = rollback(locked, blockerRows.add);
      if (rollbackResult.blockersStreamed !== true) {
        for (const rollbackBlocker of rollbackResult.blockers) blockerRows.add(rollbackBlocker);
      }
      try {
        postcondition = scan(runtimeRoot, limits);
      } catch (error) {
        postcondition = null;
        blockerRows.add(executionBlocker(
          'runtime_permission_rollback_postcondition_scan_failed',
          {
            code: error?.code || 'unknown',
            cause: error?.message || 'unknown',
          },
          'rollback_postcondition_scan',
        ));
      }
      return Object.freeze({
        applied: postconditionRollbackResult({
          applied,
          rollback: rollbackResult,
          blockerEvidence: blockerRows.finish(),
          reportLimit: limits.reportLimit,
        }),
        executionLock,
        executionBlockers: Object.freeze([]),
        lockedInventory: locked.inventoryEvidence,
        postcondition,
      });
    });
    result = lockedExecution.value;
    if (lockedExecution.releaseError) {
      result = Object.freeze({
        ...result,
        executionBlockers: Object.freeze([
          ...result.executionBlockers,
          executionBlocker(
            'runtime_permission_execution_lock_release_failed',
            lockedExecution.releaseError,
          ),
        ]),
      });
    }
    return result;
  } catch (error) {
    return Object.freeze({
      applied: empty({
        reason: error?.code === 'EEXIST'
          ? 'runtime_permission_execution_lock_unavailable'
          : (error?.message || 'runtime_permission_execution_lock_failed'),
        phase: 'execution_lock',
        details: { code: error?.code || 'unknown' },
      }),
      executionLock: null,
      executionBlockers: Object.freeze([]),
      lockedInventory: null,
      postcondition: null,
    });
  }
}

export function rollbackCommittedRuntimePermissionPlan({
  initial,
  openRoot,
  openEntry,
  sameIdentity,
  reportLimit = 2_000,
  recordBlocker = null,
} = {}) {
  let root;
  try {
    root = openRoot(initial.runtimeRoot);
    const current = fs.fstatSync(root.descriptor, { bigint: true });
    if (root.realPath !== initial.runtimeRealRoot
      || !sameIdentity(initial.rootIdentity, current)) {
      throw new Error('runtime_permission_rollback_root_identity_changed');
    }
    return rollbackRuntimePermissionRows({
      root,
      rows: initial.executionPlan,
      openEntry,
      sameIdentity,
      reportLimit,
      recordBlocker,
    });
  } catch (error) {
    const rollbackBlocker = executionBlocker(
      error?.message || 'runtime_permission_rollback_failed',
      { code: error?.code || 'unknown' },
      'rollback',
    );
    if (recordBlocker) recordBlocker(rollbackBlocker);
    const blockerEvidence = boundedRowEvidence(
      'RuntimePermissionApplyBlockerRows', [rollbackBlocker], reportLimit,
    );
    return Object.freeze({
      blockers: blockerEvidence.rows,
      blockerCount: blockerEvidence.count,
      blockerRowsHash: blockerEvidence.rowsHash,
      blockerPage: blockerEvidence.page,
      blockersStreamed: Boolean(recordBlocker),
      rolledBackCount: 0,
      rollbackIncomplete: true,
    });
  } finally {
    if (root?.descriptor !== undefined) fs.closeSync(root.descriptor);
  }
}

export function rollbackRuntimePermissionRows({
  root,
  rows,
  openEntry,
  sameIdentity,
  reportLimit = 2_000,
  recordBlocker = null,
} = {}) {
  let rolledBackCount = 0;
  const blockerRows = createBoundedRowAccumulator(
    'RuntimePermissionApplyBlockerRows', reportLimit,
  );
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    let opened;
    try {
      opened = openEntry(root, row);
      const originalMode = Number.parseInt(row.currentMode, 8);
      fs.fchmodSync(opened.descriptor, originalMode);
      const verified = fs.fstatSync(opened.descriptor, { bigint: true });
      if (!sameIdentity(row.identity, verified)
        || Number(verified.mode & 0o777n) !== originalMode) {
        throw new Error('runtime_permission_rollback_verification_failed');
      }
      rolledBackCount += 1;
    } catch (error) {
      const rollbackBlocker = blockerRows.add(Object.freeze({
        relativePath: row.relativePath,
        reason: error?.message || 'runtime_permission_rollback_failed',
        details: Object.freeze({ code: error?.code || 'unknown' }),
        phase: 'rollback',
      }));
      if (recordBlocker) recordBlocker(rollbackBlocker);
    } finally {
      if (opened?.close) fs.closeSync(opened.descriptor);
    }
  }
  const blockers = blockerRows.finish();
  return Object.freeze({
    blockers: blockers.rows,
    blockerCount: blockers.count,
    blockerRowsHash: blockers.rowsHash,
    blockerPage: blockers.page,
    blockersStreamed: Boolean(recordBlocker),
    rolledBackCount,
    rollbackIncomplete: blockers.count !== 0,
  });
}

export function emptyRuntimePermissionApplyResult({
  reportLimit,
  blockerInput = null,
  createAccumulator,
  createBlocker,
} = {}) {
  const applied = createAccumulator('RuntimePermissionAppliedRows', reportLimit).finish();
  const blockers = createAccumulator('RuntimePermissionApplyBlockerRows', reportLimit);
  if (blockerInput) blockers.add(Object.freeze({
    ...createBlocker('.', blockerInput.reason, blockerInput.details || null),
    phase: blockerInput.phase,
  }));
  const finishedBlockers = blockers.finish();
  return Object.freeze({
    applied: applied.rows,
    appliedCount: 0,
    appliedRowsHash: applied.rowsHash,
    appliedPage: applied.page,
    blockers: finishedBlockers.rows,
    blockerCount: finishedBlockers.count,
    blockerRowsHash: finishedBlockers.rowsHash,
    mutationAttemptCount: 0,
    rolledBackCount: 0,
    rollbackIncomplete: false,
  });
}
