import path from 'node:path';

import {
  createPackageRecoveryDeletionLeaseAcquireRequest,
  createPackageRecoveryDeletionLeaseCommand,
} from '../../paper-domain/automation/package-recovery-deletion-lease-contract.mjs';
import { createPackageRecoveryDeletionLeaseResumeRequest }
  from '../../paper-domain/automation/package-recovery-deletion-lease-resume-contract.mjs';
import { assertPackageRecoveryDeletionLeasePort }
  from '../../paper-ports/package-recovery-deletion-lease-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from './package-recovery-tree-inventory-repository.mjs';
import { createRuntimeRetentionPackageDeletionFenceRepository }
  from './runtime-retention-package-deletion-fence-repository.mjs';
import {
  retentionRemovalRecoveryBindingForIntent,
  verifyRetentionRemovalRecoveryBinding,
} from './runtime-retention-removal-recovery-contract.mjs';
import { retentionPathExists }
  from './runtime-retention-scope-repository.mjs';

const PUBLISHED_EVIDENCE = 'package_superseded_recovery_verified';
const ACQUIRE_HORIZON_MS = 120_000;
const ASSERT_HORIZON_MS = 15_000;
const RENEW_THRESHOLD_MS = 45_000;

function canonicalNow(clock) {
  const value = clock?.nowIso?.();
  if (typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error('runtime_retention_package_deletion_clock_invalid');
  }
  return value;
}

function recoveryBindingHash(binding) {
  verifyRetentionRemovalRecoveryBinding(binding);
  return hashRecord('RuntimeRetentionRemovalRecoveryBinding', binding);
}

function operationBinding({ intent, entry, member, recoveryBinding }) {
  const evidence = entry?.retentionDeletionEvidence;
  if (evidence?.evidenceKind !== PUBLISHED_EVIDENCE
    || evidence.packageLifecycleReceiptHash === undefined) {
    throw new Error('runtime_retention_package_deletion_lease_binding_invalid');
  }
  const deletionOperationHash = hashRecord(
    'RuntimeRetentionPublishedPackageDeletionOperation',
    {
      version: 1,
      kind: 'RuntimeRetentionPublishedPackageDeletionOperation',
      runtimeRetentionIntentReceiptHash:
        intent.runtimeRetentionIntentReceiptHash,
      runtimeRetentionDeletionEvidenceHash:
        evidence.runtimeRetentionDeletionEvidenceHash,
      packageRecoveryDeletionLeaseBindingHash:
        evidence.packageRecoveryDeletionLeaseBindingHash,
      recoveryBindingHash: recoveryBindingHash(recoveryBinding),
      packagePath: member.path,
      packageContentHash: member.contentHash,
    },
  );
  const challengeHash = hashRecord(
    'RuntimeRetentionPublishedPackageDeletionLeaseChallenge',
    {
      operationId: intent.operationId,
      deletionOperationHash,
      packageLifecycleReceiptHash: evidence.packageLifecycleReceiptHash,
    },
  );
  return Object.freeze({ evidence, deletionOperationHash, challengeHash });
}

function acquireRequestFor({ intent, operation }) {
  const { evidence } = operation;
  return createPackageRecoveryDeletionLeaseAcquireRequest({
    challengeHash: operation.challengeHash,
    operationId: intent.operationId,
    deletionOperationHash: operation.deletionOperationHash,
    packageLifecycleReceiptHash: evidence.packageLifecycleReceiptHash,
    packageRetentionRecoveryReceiptHash:
      evidence.packageRetentionRecoveryReceiptHash,
    authoritySnapshotHash: evidence.packageRecoveryAuthoritySnapshotHash,
    storageAuthorityId: evidence.storageAuthorityId,
    storageObjectId: evidence.storageObjectId,
    storageObjectVersion: evidence.storageObjectVersion,
    storageObjectBytesHash: evidence.storageObjectBytesHash,
    retentionLockVersion: evidence.retentionLockVersion,
    retentionLockIdentityHash: evidence.retentionLockIdentityHash,
    retainUntil: evidence.retainUntil,
    storageLedgerReceiptId: evidence.storageLedgerReceiptId,
    storageLedgerReceiptHash: evidence.storageLedgerReceiptHash,
    trustStoreHash: evidence.trustStoreHash,
    requestedAt: intent.createdAt,
    minimumRemainingHorizonMs: ACQUIRE_HORIZON_MS,
  });
}

function localFenceToken(request) {
  return `local-package-deletion:${request.packageRecoveryDeletionLeaseAcquireRequestHash}`;
}

function localFenceBinding({ intent, member, recoveryBinding, operation, request }) {
  const evidence = operation.evidence;
  return Object.freeze({
    packageLifecycleReceiptHash: evidence.packageLifecycleReceiptHash,
    packagePath: path.resolve(member.path),
    packageContentHash: member.contentHash,
    deletionIntentHash: intent.runtimeRetentionIntentReceiptHash,
    recoveryBindingHash: recoveryBindingHash(recoveryBinding),
    authoritySnapshotHash: evidence.packageRecoveryAuthoritySnapshotHash,
    operationId: intent.operationId,
    fenceToken: localFenceToken(request),
  });
}

function commandIdHash({ action, sequence, handle, request,
  localFenceHash, reasonHash }) {
  const terminal = ['commit', 'abort_release'].includes(action);
  return hashRecord('RuntimeRetentionPackageDeletionLeaseCommandId', {
    action,
    sequence: terminal ? null : sequence,
    authorityRequestHash: terminal
      ? request.packageRecoveryDeletionLeaseAcquireRequestHash
      : handle.lease.packageRecoveryDeletionLeaseHash,
    localFenceHash,
    reasonHash,
  });
}

function createLeaseController({ port, request, clock, faultInjector }) {
  let handle = port.acquire(request);
  let sequence = 0;
  const command = (action, {
    minimumRemainingHorizonMs = 0,
    localDeletedFenceHash = null,
    abortReasonHash = null,
  } = {}) => {
    sequence += 1;
    const terminal = ['commit', 'abort_release'].includes(action);
    return createPackageRecoveryDeletionLeaseCommand({
      lease: handle.lease,
      fenceToken: handle.fenceToken,
      action,
      commandIdHash: commandIdHash({
        action,
        sequence,
        handle,
        request,
        localFenceHash: localDeletedFenceHash,
        reasonHash: abortReasonHash,
      }),
      requestedAt: terminal ? handle.lease.issuedAt : canonicalNow(clock),
      minimumRemainingHorizonMs,
      localDeletedFenceHash,
      abortReasonHash,
    });
  };
  const renewIfNeeded = () => {
    const now = canonicalNow(clock);
    if (Date.parse(handle.lease.expiresAt) - Date.parse(now)
      >= RENEW_THRESHOLD_MS) return;
    faultInjector?.({ stage: 'before_package_deletion_lease_renewed' });
    handle = port.renew(handle, command('renew', {
      minimumRemainingHorizonMs: ACQUIRE_HORIZON_MS,
    }));
    faultInjector?.({ stage: 'after_package_deletion_lease_renewed' });
  };
  return Object.freeze({
    assertLive() {
      renewIfNeeded();
      faultInjector?.({ stage: 'before_package_deletion_lease_asserted' });
      const receipt = port.assert(handle, command('assert', {
        minimumRemainingHorizonMs: ASSERT_HORIZON_MS,
      }));
      faultInjector?.({
        stage: 'after_package_deletion_lease_asserted',
        packageRecoveryDeletionLeaseOperationReceiptHash:
          receipt.packageRecoveryDeletionLeaseOperationReceiptHash,
      });
      return receipt;
    },
    commit(localDeletedFenceHash) {
      faultInjector?.({ stage: 'before_package_deletion_lease_committed' });
      const receipt = port.commit(handle, command('commit', {
        localDeletedFenceHash,
      }));
      faultInjector?.({
        stage: 'after_package_deletion_lease_committed',
        packageRecoveryDeletionLeaseOperationReceiptHash:
          receipt.packageRecoveryDeletionLeaseOperationReceiptHash,
      });
      return receipt;
    },
    abortRelease(abortReasonHash) {
      faultInjector?.({ stage: 'before_package_deletion_lease_aborted' });
      const receipt = port.abortRelease(handle, command('abort_release', {
        abortReasonHash,
      }));
      faultInjector?.({
        stage: 'after_package_deletion_lease_aborted',
        packageRecoveryDeletionLeaseOperationReceiptHash:
          receipt.packageRecoveryDeletionLeaseOperationReceiptHash,
      });
      return receipt;
    },
  });
}

function resumeTerminalLease({ port, request, action, localDeletedFenceHash = null,
  abortReasonHash = null, faultInjector }) {
  const resumeRequest = createPackageRecoveryDeletionLeaseResumeRequest({
    acquireRequest: request,
    action,
    commandIdHash: commandIdHash({
      action,
      sequence: null,
      handle: null,
      request,
      localFenceHash: localDeletedFenceHash,
      reasonHash: abortReasonHash,
    }),
    localDeletedFenceHash,
    abortReasonHash,
  });
  const suffix = action === 'commit' ? 'committed' : 'aborted';
  faultInjector?.({ stage: `before_package_deletion_lease_${suffix}` });
  const receipt = port.resumeTerminal(request, resumeRequest);
  faultInjector?.({
    stage: `after_package_deletion_lease_${suffix}`,
    packageRecoveryDeletionLeaseOperationReceiptHash:
      receipt.packageRecoveryDeletionLeaseOperationReceiptHash,
  });
  return receipt;
}

function transition(repo, state, status, clock, extra = {}) {
  return repo.transition(state.handle, {
    expectedRecordHash:
      state.record.runtimeRetentionPackageDeletionFenceHash,
    status,
    transitionedAt: canonicalNow(clock),
    transitionId: hashRecord('RuntimeRetentionPackageDeletionFenceTransition', {
      status,
      generation: state.record.generation,
      fromHash: state.record.runtimeRetentionPackageDeletionFenceHash,
    }),
    ...extra,
  });
}

function assertExactRollback(member, evidence, recoveryBinding = null) {
  if (!retentionPathExists(member.path)) {
    throw new Error('runtime_retention_package_deletion_rollback_missing');
  }
  if (recoveryBinding && retentionPathExists(path.join(
    path.dirname(member.path),
    recoveryBinding.quarantineName,
  ))) {
    throw new Error('runtime_retention_package_deletion_rollback_collision');
  }
  const observed = inspectPackageRecoveryTreeInventorySync({
    packagePath: member.path,
  });
  if (observed.inventory.packageRecoveryTreeInventoryHash
    !== evidence.packageRecoveryTreeInventoryHash) {
    throw new Error('runtime_retention_package_deletion_rollback_inventory_changed');
  }
  return observed;
}

function exactRollbackAbortReasonHash(operation) {
  return hashRecord('RuntimeRetentionPackageDeletionLeaseAbortReason', {
    status: 'runtime_retention_package_deletion_exact_rollback_verified',
    deletionOperationHash: operation.deletionOperationHash,
    rollbackInventoryHash:
      operation.evidence.packageRecoveryTreeInventoryHash,
  });
}

function assertDeletedPostimage(member, recoveryBinding) {
  const quarantine = path.join(
    path.dirname(member.path),
    recoveryBinding.quarantineName,
  );
  if (retentionPathExists(member.path) || retentionPathExists(quarantine)) {
    throw new Error('runtime_retention_package_deletion_postimage_invalid');
  }
}

function prepareLocalFence({ repo, intent, member, recoveryBinding,
  operation, request, clock }) {
  const binding = localFenceBinding({
    intent, member, recoveryBinding, operation, request,
  });
  const prior = repo.inspect(binding.packageLifecycleReceiptHash);
  if (prior?.status === 'deleted') {
    throw new Error('runtime_retention_package_deletion_fence_package_deleted');
  }
  if (prior?.status === 'deleting') {
    throw new Error('runtime_retention_package_deletion_fence_reconciliation_required');
  }
  return repo.prepare({
    ...binding,
    transitionId: hashRecord('RuntimeRetentionPackageDeletionFencePrepare', {
      acquireRequestHash:
        request.packageRecoveryDeletionLeaseAcquireRequestHash,
      previousFenceHash:
        prior?.runtimeRetentionPackageDeletionFenceHash || null,
    }),
    preparedAt: canonicalNow(clock),
    expectedPreviousFenceHash:
      prior?.runtimeRetentionPackageDeletionFenceHash || null,
  });
}

export function withPublishedPackageDeletionLeaseSync({
  intent,
  entry,
  member,
  recoveryBinding,
  packageRecoveryDeletionLeasePort,
  operation: destructiveOperation,
  clock = { nowIso: () => new Date().toISOString() },
  faultInjector = null,
} = {}) {
  if (entry?.retentionDeletionEvidence?.evidenceKind !== PUBLISHED_EVIDENCE) {
    return Object.freeze({
      result: destructiveOperation(Object.freeze({
        assertDeletionLease: () => {},
        withDeletionFenceGuard: (operation) => operation(),
      })),
      localDeletionFence: null,
      externalDeletionLeaseCommitReceipt: null,
    });
  }
  if (typeof destructiveOperation !== 'function') {
    throw new Error('runtime_retention_package_deletion_operation_invalid');
  }
  const port = assertPackageRecoveryDeletionLeasePort(
    packageRecoveryDeletionLeasePort,
  );
  const recovery = verifyRetentionRemovalRecoveryBinding(recoveryBinding);
  const operation = operationBinding({ intent, entry, member, recoveryBinding: recovery });
  const request = acquireRequestFor({ intent, operation });
  const repo = createRuntimeRetentionPackageDeletionFenceRepository({
    runtimeRoot: intent.runtimeRoot,
  });
  let local = null;
  let lease = null;
  let filesystemDeleted = false;
  try {
    local = prepareLocalFence({
      repo, intent, member, recoveryBinding: recovery, operation, request, clock,
    });
    lease = createLeaseController({ port, request, clock, faultInjector });
    local = transition(repo, local, 'deleting', clock);
    const result = destructiveOperation(Object.freeze({
      assertDeletionLease: () => lease.assertLive(),
      withDeletionFenceGuard: (destructive) =>
        repo.withDeletionGuard(local.handle, destructive),
    }));
    if (result && typeof result.then === 'function') {
      throw new Error('runtime_retention_package_deletion_async_operation_forbidden');
    }
    filesystemDeleted = true;
    repo.withDeletionGuard(local.handle, () => {
      lease.assertLive();
      assertDeletedPostimage(member, recovery);
    });
    faultInjector?.({
      stage: 'after_package_filesystem_deleted_before_local_fence_deleted',
    });
    local = transition(repo, local, 'deleted', clock);
    const commitReceipt = lease.commit(
      local.record.runtimeRetentionPackageDeletionFenceHash,
    );
    return Object.freeze({
      result,
      localDeletionFence: local.record,
      externalDeletionLeaseCommitReceipt: commitReceipt,
    });
  } catch (error) {
    if (filesystemDeleted || local?.record.status === 'deleted') throw error;
    const recoveryErrors = [];
    try { assertExactRollback(member, operation.evidence, recovery); }
    catch (rollbackError) { recoveryErrors.push(rollbackError); }
    if (!recoveryErrors.length && local) {
      const abortReasonHash = exactRollbackAbortReasonHash(operation);
      if (lease) {
        try { lease.abortRelease(abortReasonHash); }
        catch (abortError) { recoveryErrors.push(abortError); }
      }
      if (!recoveryErrors.length) {
        try {
          local = transition(repo, local, 'aborted', clock, {
            abortReasonHash,
          });
        } catch (abortError) { recoveryErrors.push(abortError); }
      }
    }
    if (recoveryErrors.length) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        'runtime_retention_package_deletion_failed_and_fence_recovery_failed',
      );
    }
    throw error;
  }
}

function reconcileEntryFence({ intent, entry, entryIndex, member, memberIndex,
  packageRecoveryDeletionLeasePort, phase, clock, faultInjector }) {
  const recoveryBinding = retentionRemovalRecoveryBindingForIntent(
    intent, entry, entryIndex, member, memberIndex,
  );
  const operation = operationBinding({ intent, entry, member, recoveryBinding });
  const request = acquireRequestFor({ intent, operation });
  const binding = localFenceBinding({
    intent, member, recoveryBinding, operation, request,
  });
  const repo = createRuntimeRetentionPackageDeletionFenceRepository({
    runtimeRoot: intent.runtimeRoot,
  });
  const prior = repo.inspect(binding.packageLifecycleReceiptHash);
  if (!prior || prior.status === 'aborted') return null;
  const bindingHash = recoveryBindingHash(recoveryBinding);
  if (phase === 'before_restore' && prior.status !== 'deleted') {
    if (!retentionPathExists(member.path)) return null;
    const local = repo.resume(binding);
    const port = assertPackageRecoveryDeletionLeasePort(
      packageRecoveryDeletionLeasePort,
    );
    assertExactRollback(member, operation.evidence, recoveryBinding);
    const abortReasonHash = exactRollbackAbortReasonHash(operation);
    resumeTerminalLease({
      port,
      request,
      action: 'abort_release',
      abortReasonHash,
      faultInjector,
    });
    transition(repo, local, 'aborted', clock, { abortReasonHash });
    return Object.freeze({ kind: 'exact_restored', bindingHash });
  }
  if (phase === 'after_restore' && prior.status === 'deleted') return null;
  const port = assertPackageRecoveryDeletionLeasePort(
    packageRecoveryDeletionLeasePort,
  );
  const local = repo.resume(binding);
  if (prior.status === 'deleted') {
    assertDeletedPostimage(member, recoveryBinding);
    resumeTerminalLease({
      port,
      request,
      action: 'commit',
      localDeletedFenceHash:
        prior.runtimeRetentionPackageDeletionFenceHash,
      faultInjector,
    });
    return Object.freeze({ kind: 'deleted', bindingHash });
  }
  assertExactRollback(member, operation.evidence, recoveryBinding);
  const abortReasonHash = exactRollbackAbortReasonHash(operation);
  resumeTerminalLease({
    port,
    request,
    action: 'abort_release',
    abortReasonHash,
    faultInjector,
  });
  transition(repo, local, 'aborted', clock, { abortReasonHash });
  return Object.freeze({ kind: 'exact_restored', bindingHash });
}

export function reconcilePublishedPackageDeletionFencesSync({
  intent,
  packageRecoveryDeletionLeasePort = null,
  phase = 'before_restore',
  clock = { nowIso: () => new Date().toISOString() },
  faultInjector = null,
} = {}) {
  if (!['before_restore', 'after_restore'].includes(phase)) {
    throw new Error('runtime_retention_package_deletion_reconciliation_phase_invalid');
  }
  const published = intent?.entries?.some((entry) => entry.authorized
    && entry.category === 'packages'
    && entry.retentionDeletionEvidence?.evidenceKind === PUBLISHED_EVIDENCE);
  if (!published) return Object.freeze({
    skipRecoveryBindingHashes: Object.freeze([]),
    exactRestoredRecoveryBindingHashes: Object.freeze([]),
  });
  const skipRecoveryBindingHashes = [];
  const exactRestoredRecoveryBindingHashes = [];
  for (let entryIndex = 0; entryIndex < intent.entries.length; entryIndex += 1) {
    const entry = intent.entries[entryIndex];
    if (!entry.authorized || entry.category !== 'packages'
      || entry.retentionDeletionEvidence?.evidenceKind !== PUBLISHED_EVIDENCE) continue;
    for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
      const member = entry.members[memberIndex];
      if (member.identity?.entryKind !== 'directory') continue;
      const reconciled = reconcileEntryFence({
        intent,
        entry,
        entryIndex,
        member,
        memberIndex,
        packageRecoveryDeletionLeasePort,
        phase,
        clock,
        faultInjector,
      });
      if (reconciled?.kind === 'deleted') {
        skipRecoveryBindingHashes.push(reconciled.bindingHash);
      } else if (reconciled?.kind === 'exact_restored') {
        exactRestoredRecoveryBindingHashes.push(reconciled.bindingHash);
      }
    }
  }
  return Object.freeze({
    skipRecoveryBindingHashes: Object.freeze([
      ...new Set(skipRecoveryBindingHashes),
    ].sort()),
    exactRestoredRecoveryBindingHashes: Object.freeze([
      ...new Set(exactRestoredRecoveryBindingHashes),
    ].sort()),
  });
}
