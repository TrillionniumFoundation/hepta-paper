import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousResearchOnlineMutationReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';

const DEFAULT_FRESH_SNAPSHOT_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TRANSIENT_BACKOFF_MS = 15 * 60 * 1000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function observedNow(clock) {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_state_recoverability_clock_invalid');
  }
  return date;
}

function receipt(payload) {
  return Object.freeze({
    ...payload,
    recoverabilityControllerReceiptHash: hashRecord(
      'AutonomousResearchStateRecoverabilityControllerReceipt', payload,
    ),
  });
}

function fatal(blockers) {
  const unique = [...new Set(blockers)].sort();
  const error = new Error(unique[0] || 'autonomous_research_state_recoverability_fatal');
  error.name = 'AutonomousResearchStateRecoverabilityFatalError';
  error.stateRecoverabilityFatal = true;
  error.blockers = Object.freeze(unique);
  throw error;
}

function validHead(head) {
  return Boolean(
    Number.isSafeInteger(head?.globalSequence)
    && head.globalSequence >= 0
    && SHA256.test(String(head?.globalHash || '')),
  );
}

function deferredFenceError(blockers, extra = {}) {
  const unique = [...new Set(blockers)].sort();
  const error = new Error(
    unique[0] || 'autonomous_research_state_recoverability_epoch_deferred',
  );
  error.name = 'AutonomousResearchStateRecoverabilityDeferredError';
  error.stateRecoverabilityDeferred = true;
  error.blockers = Object.freeze(unique);
  error.retryable = true;
  Object.assign(error, extra);
  return error;
}

function transient(blockers) {
  return blockers.some((blocker) => (
    /(?:process_failed|temporarily_unavailable|timeout|timed_out|connection|unavailable)$/.test(blocker)
    || blocker === 'autonomous_research_state_backup_current_head_observation_failed'
  ));
}

function fallbackEligible(blockers) {
  return blockers.some((blocker) => (
    blocker === 'autonomous_research_state_restore_journal_range_unbounded'
    || blocker === 'autonomous_research_state_backup_bundle_missing'
    || blocker === 'autonomous_research_state_backup_no_valid_restore_drill_bundle'
  ));
}

function exactRecoveryEvidence(recovery, {
  recoveredFinalizationCount,
  abortedRemoteOnlyReservationCount,
} = {}) {
  const heads = recovery?.finalizedHeads;
  const abortedIds = recovery?.abortedRemoteOnlyReservationIds;
  const abortHashes = recovery?.abortedRemoteOnlyAbortReceiptHashes;
  const abortReceipts = recovery?.abortedRemoteOnlyAbortReceipts;
  return Array.isArray(heads)
    && heads.length === recoveredFinalizationCount
    && new Set(heads.map((head) => head?.reservationId)).size === heads.length
    && heads.every((head) => (
      typeof head?.reservationId === 'string'
      && head.reservationId.length > 0
      && validHead(head)
    ))
    && Array.isArray(abortedIds)
    && Array.isArray(abortHashes)
    && Array.isArray(abortReceipts)
    && abortedIds.length === abortedRemoteOnlyReservationCount
    && abortedIds.length === abortHashes.length
    && abortedIds.length === abortReceipts.length
    && new Set(abortedIds).size === abortedIds.length
    && abortReceipts.every((abortReceipt, index) => (
      abortReceipt?.kind === 'AutonomousResearchOnlineMutationAbortReceipt'
      && abortReceipt.status === 'autonomous_research_online_mutation_aborted'
      && abortReceipt.reservationId === abortedIds[index]
      && typeof abortReceipt.authorityId === 'string'
      && abortReceipt.authorityId.length > 0
      && typeof abortReceipt.keyId === 'string'
      && abortReceipt.keyId.length > 0
      && typeof abortReceipt.signature === 'string'
      && abortReceipt.signature.length > 0
      && autonomousResearchOnlineMutationReceiptHash(abortReceipt)
        === abortHashes[index]
    ));
}

function exactPendingReconciliation(receipt) {
  const {
    pendingReconciliationReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  return receipt?.status
      === 'autonomous_research_state_pending_reconciliation_complete'
    && receipt.businessDmlReplayed === false
    && receipt.reconciledDatabaseCount
      === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && Number.isSafeInteger(receipt.recoveredFinalizationCount)
    && receipt.recoveredFinalizationCount >= 0
    && Number.isSafeInteger(receipt.abortedRemoteOnlyReservationCount)
    && receipt.abortedRemoteOnlyReservationCount >= 0
    && Array.isArray(receipt.reconciliations)
    && receipt.reconciliations.length
      === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && Array.isArray(receipt.pendingInspections)
    && receipt.pendingInspections.length
      === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && receipt.pendingInspections.every((inspection) => (
      inspection?.pendingFinalizationCount === 0
    ))
    && exactRecoveryEvidence(receipt.recovery, receipt)
    && Array.isArray(receipt.blockers)
    && receipt.blockers.length === 0
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchStatePendingReconciliationReceipt', payload)
      === claimedHash;
}

function reconciliationRecovery(receipt) {
  const reconciliations = Array.isArray(receipt?.reconciliations)
    ? receipt.reconciliations : [];
  return Object.freeze({
    finalizedHeads: Object.freeze(reconciliations.flatMap(
      (entry) => Array.isArray(entry?.finalizedHeads) ? entry.finalizedHeads : [],
    )),
    abortedRemoteOnlyReservationIds: Object.freeze(reconciliations.flatMap(
      (entry) => entry?.abortedRemoteOnlyReservationIds || [],
    )),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze(reconciliations.flatMap(
      (entry) => entry?.abortedRemoteOnlyAbortReceiptHashes || [],
    )),
    abortedRemoteOnlyAbortReceipts: Object.freeze(reconciliations.flatMap(
      (entry) => entry?.abortedRemoteOnlyAbortReceipts || [],
    )),
  });
}

function exactReconcileAndRenew(receipt) {
  const renewal = receipt?.renewalReceipt;
  const claimedHash = receipt?.reconcileAndRenewReceiptHash;
  const payload = { ...(receipt || {}) };
  delete payload.reconcileAndRenewReceiptHash;
  delete payload.reconciliations;
  delete payload.pendingInspections;
  delete payload.renewalReceipt;
  const renewalPayload = { ...(renewal || {}) };
  delete renewalPayload.renewalReceiptHash;
  return receipt?.status === 'autonomous_research_state_reconcile_and_renew_complete'
    && receipt.businessDmlReplayed === false
    && receipt.backupAttempted === true
    && receipt.reconciledDatabaseCount
      === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && Array.isArray(receipt.reconciliations)
    && receipt.reconciliations.length
      === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && Array.isArray(receipt.pendingInspections)
    && receipt.pendingInspections.length
      === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && receipt.pendingInspections.every((inspection) => (
      inspection?.pendingFinalizationCount === 0
    ))
    && Array.isArray(receipt.blockers)
    && receipt.blockers.length === 0
    && exactRecoveryEvidence(reconciliationRecovery(receipt), receipt)
    && renewal?.status === 'autonomous_research_state_backup_renewal_complete'
    && renewal.productionStateMutated === false
    && Array.isArray(renewal.blockers)
    && renewal.blockers.length === 0
    && SHA256.test(String(renewal.renewalReceiptHash || ''))
    && hashRecord('AutonomousResearchStateBackupRenewalReceipt', renewalPayload)
      === renewal.renewalReceiptHash
    && receipt.renewalReceiptHash === renewal.renewalReceiptHash
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchStateReconcileAndRenewReceipt', payload)
      === claimedHash
    && typeof renewal.bundlePath === 'string'
    && renewal.bundlePath.length > 0
    && SHA256.test(String(renewal.restoreDrillReceiptHash || ''))
    && SHA256.test(String(renewal.recoverabilityBindingHash || ''));
}

export function assertAutonomousResearchStateRecoverabilityReady(
  candidate,
  { action = 'state_recoverability_reconciliation' } = {},
) {
  if (candidate?.status === 'autonomous_research_state_recoverability_ready'
    && Array.isArray(candidate.blockers)
    && candidate.blockers.length === 0
    && Number.isSafeInteger(candidate.headSequence)
    && SHA256.test(String(candidate.headHash || ''))) return candidate;
  throw deferredFenceError(candidate?.blockers || [
    'autonomous_research_state_recoverability_reconciliation_deferred',
  ], {
    action,
    retryAt: candidate?.nextAttemptAt || null,
    recoverabilityReceipt: candidate || null,
  });
}

export function createAutonomousResearchStateRecoverabilityController({
  service,
  assertResidentLease,
  clock = null,
  initialVerifiedHead = null,
  freshSnapshotAgeMs = DEFAULT_FRESH_SNAPSHOT_AGE_MS,
  transientBackoffMs = DEFAULT_TRANSIENT_BACKOFF_MS,
} = {}) {
  if (!service
    || typeof service.offhostSources !== 'function'
    || typeof service.observeBundleHead !== 'function'
    || typeof service.restoreDrill !== 'function'
    || typeof service.reconcilePending !== 'function'
    || typeof service.reconcileAndRenew !== 'function'
    || typeof assertResidentLease !== 'function'
    || !Number.isSafeInteger(freshSnapshotAgeMs)
    || freshSnapshotAgeMs < 60_000
    || !Number.isSafeInteger(transientBackoffMs)
    || transientBackoffMs < 1000
    || (initialVerifiedHead !== null && !validHead(initialVerifiedHead))) {
    throw new Error('autonomous_research_state_recoverability_controller_configuration_invalid');
  }
  let inFlight = null;
  let fatalBlockers = null;
  let verifiedHead = initialVerifiedHead ? Object.freeze({ ...initialVerifiedHead }) : null;
  let dirtyHead = verifiedHead ? null : Object.freeze({
    globalSequence: null,
    globalHash: null,
  });
  let reconciliationRequirements = Object.freeze([]);

  const enterFatal = (blockers) => {
    fatalBlockers = Object.freeze([...new Set(blockers)].sort());
    fatal(fatalBlockers);
  };

  const assertLease = async (phase, residentLeaseContext) => {
    const valid = await assertResidentLease({
      phase,
      residentLeaseContext: residentLeaseContext || null,
      now: observedNow(clock),
    });
    if (valid !== true) enterFatal([
      'autonomous_research_state_recoverability_resident_lease_lost',
    ]);
  };

  const deferred = (blockers, mode) => {
    const now = observedNow(clock);
    return receipt({
      version: 1,
      kind: 'AutonomousResearchStateRecoverabilityControllerReceipt',
      status: 'autonomous_research_state_recoverability_deferred',
      mode,
      bundlePath: null,
      headSequence: null,
      headHash: null,
      checkedAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + transientBackoffMs).toISOString(),
      productionStateMutated: false,
      blockers: Object.freeze([...new Set(blockers)].sort()),
    });
  };

  const recordFinalizedHead = ({ globalSequence, globalHash } = {}) => {
    if (fatalBlockers) fatal(fatalBlockers);
    const candidate = Object.freeze({ globalSequence, globalHash });
    if (!validHead(candidate)) {
      enterFatal(['autonomous_research_state_recoverability_finalized_head_invalid']);
    }
    const previous = dirtyHead?.globalSequence === null ? verifiedHead : dirtyHead;
    if (previous
      && (candidate.globalSequence < previous.globalSequence
        || (candidate.globalSequence === previous.globalSequence
          && candidate.globalHash !== previous.globalHash))) {
      enterFatal(['autonomous_research_state_recoverability_finalized_head_conflict']);
    }
    if (verifiedHead
      && candidate.globalSequence === verifiedHead.globalSequence
      && candidate.globalHash === verifiedHead.globalHash) {
      dirtyHead = null;
    } else {
      dirtyHead = candidate;
    }
    return candidate;
  };

  const reconcilePendingMutations = async (residentLeaseContext) => {
    if (reconciliationRequirements.length === 0) return null;
    await assertLease('before_pending_mutation_reconciliation', residentLeaseContext);
    const reconciliation = await service.reconcilePending();
    await assertLease('after_pending_mutation_reconciliation', residentLeaseContext);
    if (!exactPendingReconciliation(reconciliation)) {
      const blockers = reconciliation?.blockers || [
        'autonomous_research_state_pending_reconciliation_invalid',
      ];
      if (transient(blockers)) return deferred(blockers, 'pending-reconciliation');
      enterFatal(blockers);
    }
    for (const head of [...reconciliation.recovery.finalizedHeads]
      .sort((left, right) => left.globalSequence - right.globalSequence)) {
      recordFinalizedHead(head);
    }
    reconciliationRequirements = Object.freeze([]);
    return null;
  };

  const ready = ({ mode, sources }) => {
    const candidate = Object.freeze({
      globalSequence: sources.headSequence,
      globalHash: sources.headHash,
    });
    if (!validHead(candidate)) {
      enterFatal(['autonomous_research_state_recoverability_verified_head_invalid']);
    }
    if (dirtyHead && dirtyHead.globalSequence !== null) {
      if (candidate.globalSequence < dirtyHead.globalSequence) {
        return deferred([
          'autonomous_research_state_recoverability_finalized_head_not_covered',
        ], 'concurrent-finalization');
      }
      if (candidate.globalSequence === dirtyHead.globalSequence
        && candidate.globalHash !== dirtyHead.globalHash) {
        enterFatal(['autonomous_research_state_recoverability_finalized_head_conflict']);
      }
    }
    if (verifiedHead
      && (candidate.globalSequence < verifiedHead.globalSequence
        || (candidate.globalSequence === verifiedHead.globalSequence
          && candidate.globalHash !== verifiedHead.globalHash))) {
      enterFatal(['autonomous_research_state_recoverability_verified_head_rollback']);
    }
    verifiedHead = candidate;
    dirtyHead = null;
    return receipt({
      version: 1,
      kind: 'AutonomousResearchStateRecoverabilityControllerReceipt',
      status: 'autonomous_research_state_recoverability_ready',
      mode,
      bundlePath: sources.bundlePath,
      headSequence: sources.headSequence,
      headHash: sources.headHash,
      restoreDrillReceiptHash: sources.restoreDrillReceiptHash,
      recoverabilityBindingHash: sources.recoverabilityBindingHash || null,
      checkedAt: observedNow(clock).toISOString(),
      nextAttemptAt: null,
      productionStateMutated: false,
      blockers: Object.freeze([]),
    });
  };

  const renewFreshSnapshot = async (residentLeaseContext) => {
    await assertLease('before_fresh_snapshot_renewal', residentLeaseContext);
    const reconciliation = await service.reconcileAndRenew();
    await assertLease('after_fresh_snapshot_renewal', residentLeaseContext);
    if (!exactReconcileAndRenew(reconciliation)) {
      const blockers = reconciliation?.blockers || [
        'autonomous_research_state_reconcile_and_renew_invalid',
      ];
      if (transient(blockers)) return deferred(blockers, 'fresh-snapshot-renewal');
      enterFatal(blockers);
    }
    for (const head of [...reconciliationRecovery(reconciliation).finalizedHeads]
      .sort((left, right) => left.globalSequence - right.globalSequence)) {
      recordFinalizedHead(head);
    }
    const renewal = reconciliation.renewalReceipt;
    const sources = await service.offhostSources();
    if (sources?.status !== 'autonomous_research_state_backup_sources_ready'
      || sources.bundlePath !== renewal.bundlePath
      || sources.restoreDrillReceiptHash !== renewal.restoreDrillReceiptHash
      || sources.recoverabilityBindingHash !== renewal.recoverabilityBindingHash
      || sources.headSequence !== renewal.restoreAuthorityHeadSequence
      || sources.headHash !== renewal.restoreAuthorityHeadHash) {
      enterFatal(['autonomous_research_state_recoverability_fresh_snapshot_publish_invalid']);
    }
    return ready({ mode: 'fresh-snapshot-renewed', sources });
  };

  const reconcileOnce = async ({
    requiredValidityMs = 0,
    residentLeaseContext = null,
  } = {}) => {
    if (fatalBlockers) fatal(fatalBlockers);
    if (!Number.isSafeInteger(requiredValidityMs) || requiredValidityMs < 0) {
      enterFatal(['autonomous_research_state_recoverability_required_validity_invalid']);
    }
    await assertLease('before_recoverability_reconciliation', residentLeaseContext);
    const pendingReconciliation = await reconcilePendingMutations(residentLeaseContext);
    if (pendingReconciliation) return pendingReconciliation;
    let sources = await service.offhostSources();
    if (sources?.status !== 'autonomous_research_state_backup_sources_ready') {
      const blockers = sources?.blockers || [
        'autonomous_research_state_backup_no_valid_restore_drill_bundle',
      ];
      if (fallbackEligible(blockers)) return renewFreshSnapshot(residentLeaseContext);
      if (transient(blockers)) return deferred(blockers, 'source-inspection');
      enterFatal(blockers);
    }
    const snapshotCreatedAt = Date.parse(String(sources.snapshotCreatedAt || ''));
    if (!Number.isFinite(snapshotCreatedAt)
      || observedNow(clock).getTime() - snapshotCreatedAt >= freshSnapshotAgeMs) {
      return renewFreshSnapshot(residentLeaseContext);
    }
    const observation = await service.observeBundleHead({ bundlePath: sources.bundlePath });
    await assertLease('after_current_head_observation', residentLeaseContext);
    if (observation?.status !== 'autonomous_research_state_backup_current_head_observed') {
      const blockers = observation?.blockers || [
        'autonomous_research_state_backup_current_head_observation_failed',
      ];
      if (transient(blockers)) return deferred(blockers, 'current-head-observation');
      enterFatal(blockers);
    }
    const liveHead = observation.authorityCurrentHeadReceipt;
    const liveExpiry = Date.parse(String(liveHead?.expiresAt || ''));
    if (!Number.isFinite(liveExpiry)
      || liveExpiry - observedNow(clock).getTime() < requiredValidityMs) {
      enterFatal(['autonomous_research_state_recoverability_observation_validity_insufficient']);
    }
    if (liveHead.headSequence < sources.headSequence
      || (liveHead.headSequence === sources.headSequence
        && liveHead.headHash !== sources.headHash)) {
      enterFatal(['autonomous_research_state_recoverability_authority_rollback_or_equivocation']);
    }
    if (liveHead.headSequence === sources.headSequence
      && liveHead.headHash === sources.headHash) {
      return ready({ mode: 'current', sources });
    }
    await assertLease('before_journal_restore_drill', residentLeaseContext);
    const drill = await service.restoreDrill({ bundlePath: sources.bundlePath });
    await assertLease('after_journal_restore_drill', residentLeaseContext);
    if (drill?.status !== 'autonomous_research_state_restore_drill_passed') {
      const blockers = drill?.blockers || [
        'autonomous_research_state_restore_drill_failed',
      ];
      if (fallbackEligible(blockers)) return renewFreshSnapshot(residentLeaseContext);
      if (transient(blockers)) return deferred(blockers, 'journal-restore-drill');
      enterFatal(blockers);
    }
    sources = await service.offhostSources();
    if (sources?.status !== 'autonomous_research_state_backup_sources_ready'
      || sources.bundlePath !== drill.bundlePath
      || sources.restoreDrillReceiptHash !== drill.restoreDrillReceiptHash
      || sources.headSequence !== liveHead.headSequence
      || sources.headHash !== liveHead.headHash) {
      enterFatal(['autonomous_research_state_recoverability_journal_publish_invalid']);
    }
    return ready({ mode: 'journal-renewed', sources });
  };

  return Object.freeze({
    reconcile(input = {}) {
      const requestedValidity = input?.requiredValidityMs || 0;
      const start = () => {
        const pending = {
          requiredValidityMs: requestedValidity,
          promise: null,
        };
        pending.promise = reconcileOnce(input).finally(() => {
          if (inFlight === pending) inFlight = null;
        });
        inFlight = pending;
        return pending.promise;
      };
      if (!inFlight) return start();
      if (requestedValidity <= inFlight.requiredValidityMs) {
        return inFlight.promise;
      }
      return inFlight.promise.then(start);
    },
    markMutationFinalized({ globalSequence, globalHash } = {}) {
      recordFinalizedHead({ globalSequence, globalHash });
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchStateRecoverabilityEpochStatus',
        status: dirtyHead
          ? 'autonomous_research_state_recoverability_epoch_dirty'
          : 'autonomous_research_state_recoverability_epoch_current',
        verifiedHead,
        dirtyHead,
      });
    },
    markMutationReconciliationRequired({
      reason,
      databaseRole,
      databaseInstanceId,
      reservationId = null,
      mutationAttemptId = null,
      committed = false,
    } = {}) {
      if (fatalBlockers) fatal(fatalBlockers);
      if (typeof reason !== 'string' || reason.length < 1 || reason.length > 191
        || typeof databaseRole !== 'string' || databaseRole.length < 1
        || typeof databaseInstanceId !== 'string' || databaseInstanceId.length < 1
        || (reservationId !== null
          && (typeof reservationId !== 'string' || reservationId.length < 1))
        || (mutationAttemptId !== null
          && (typeof mutationAttemptId !== 'string' || mutationAttemptId.length < 1))
        || ![false, true, 'unknown'].includes(committed)) {
        enterFatal([
          'autonomous_research_state_recoverability_reconciliation_requirement_invalid',
        ]);
      }
      const requirement = Object.freeze({
        reason,
        databaseRole,
        databaseInstanceId,
        reservationId,
        mutationAttemptId,
        committed,
      });
      const key = JSON.stringify(requirement);
      if (!reconciliationRequirements.some((entry) => JSON.stringify(entry) === key)) {
        reconciliationRequirements = Object.freeze([
          ...reconciliationRequirements,
          requirement,
        ]);
      }
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchStateRecoverabilityEpochStatus',
        status: 'autonomous_research_state_recoverability_reconciliation_required',
        verifiedHead,
        dirtyHead,
        reconciliationRequirements,
      });
    },
    assertCurrent({ action } = {}) {
      if (fatalBlockers) fatal(fatalBlockers);
      if (typeof action !== 'string' || action.length < 1 || action.length > 191) {
        enterFatal(['autonomous_research_state_recoverability_fence_action_invalid']);
      }
      if (!verifiedHead || dirtyHead || reconciliationRequirements.length > 0) {
        throw deferredFenceError([
          'autonomous_research_state_recoverability_epoch_reconciliation_required',
        ], {
          action,
          verifiedHead,
          dirtyHead,
          reconciliationRequirements,
        });
      }
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchStateRecoverabilityEpochPermit',
        status: 'autonomous_research_state_recoverability_epoch_current',
        action,
        globalSequence: verifiedHead.globalSequence,
        globalHash: verifiedHead.globalHash,
      });
    },
    epochStatus() {
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchStateRecoverabilityEpochStatus',
        status: fatalBlockers
          ? 'autonomous_research_state_recoverability_epoch_fatal'
          : (!verifiedHead || dirtyHead || reconciliationRequirements.length > 0)
            ? 'autonomous_research_state_recoverability_epoch_dirty'
            : 'autonomous_research_state_recoverability_epoch_current',
        verifiedHead,
        dirtyHead,
        reconciliationRequirements,
        blockers: fatalBlockers || Object.freeze([]),
      });
    },
    policy: Object.freeze({ freshSnapshotAgeMs, transientBackoffMs }),
  });
}
