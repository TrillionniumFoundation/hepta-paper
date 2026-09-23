import {
  hasExactObjectKeys,
} from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousResearchStateBackupAuthorityReceiptHash,
  AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL,
  verifyAutonomousResearchStateBackupAuthorityCurrentHead,
  verifyAutonomousResearchStateBackupAuthorityFinalization,
  verifyAutonomousResearchStateBackupAuthorityJournalRange,
  verifyAutonomousResearchStateBackupAuthorityReservation,
} from './autonomous-research-state-backup-authority.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateStoredAutonomousResearchStateRestoreDrillReceipt({
  receipt,
  bundle,
  bundlePath,
  authorityTrust,
  onlineMutationVerifier = null,
} = {}) {
  const blockers = [];
  const request = receipt?.authorityCurrentHeadRequest;
  const currentHead = receipt?.authorityCurrentHeadReceipt;
  if (!hasExactObjectKeys(receipt, [
    'version', 'kind', 'status', 'bundlePath', 'bundleManifestHash', 'snapshotContentHash',
    'authorityCurrentHeadRequest', 'authorityCurrentHeadReceipt', 'authorityCurrentHeadReceiptHash',
    'authorityJournalRangeRequest', 'authorityJournalRangeReceipt',
    'authorityJournalRangeReceiptHash', 'journalReplayMutationCount',
    'recoveredDatabaseHeads', 'recoverabilityProtocol',
    'completeFinalizedMutationJournal', 'recoverabilityBindingHash',
    'databaseCount', 'productionStateMutated',
    'performedAt', 'blockers', 'restoreDrillReceiptHash',
  ])
    || receipt.version !== 1
    || receipt.kind !== 'AutonomousResearchStateRestoreDrillReceipt'
    || receipt.status !== 'autonomous_research_state_restore_drill_passed'
    || typeof receipt.bundlePath !== 'string'
    || receipt.bundlePath !== bundlePath
    || receipt.bundleManifestHash !== bundle.bundleManifestHash
    || receipt.snapshotContentHash !== bundle.snapshotContentHash
    || receipt.databaseCount !== bundle.content.databases.length
    || receipt.productionStateMutated !== false
    || !SHA256.test(String(receipt.recoverabilityBindingHash || ''))
    || !Array.isArray(receipt.recoveredDatabaseHeads)
    || !Number.isSafeInteger(receipt.journalReplayMutationCount)
    || receipt.journalReplayMutationCount < 0
    || !Array.isArray(receipt.blockers)
    || receipt.blockers.length !== 0) {
    blockers.push('autonomous_research_state_backup_restore_drill_receipt_invalid');
    return blockers;
  }
  const { restoreDrillReceiptHash, ...receiptPayload } = receipt;
  if (restoreDrillReceiptHash
    !== hashRecord('AutonomousResearchStateRestoreDrillReceipt', receiptPayload)) {
    blockers.push('autonomous_research_state_backup_restore_drill_receipt_hash_invalid');
  }
  if (!hasExactObjectKeys(request, [
    'version', 'kind', 'reservationId', 'databaseScopeHash', 'snapshotContentHash',
    'requestedAt', 'maximumLeaseMs',
  ])
    || request.version !== 1
    || request.kind !== 'AutonomousResearchStateBackupAuthorityCurrentHeadRequest'
    || request.reservationId !== bundle.authorityReservation.reservationId
    || request.databaseScopeHash !== bundle.content.databaseScopeHash
    || request.snapshotContentHash !== bundle.snapshotContentHash
    || !Number.isSafeInteger(request.maximumLeaseMs)
    || request.maximumLeaseMs < 1000
    || !Number.isFinite(Date.parse(String(request.requestedAt || '')))) {
    blockers.push('autonomous_research_state_backup_restore_authority_request_invalid');
  }
  if (!hasExactObjectKeys(currentHead, [
    'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'reservationId',
    'databaseScopeHash', 'headSequence', 'headHash', 'observedAt', 'expiresAt',
    'mutationFenceProtocol', 'allRegisteredMutationsFenced', 'signature',
  ])
    || currentHead.version !== 1
    || currentHead.kind !== 'AutonomousResearchStateBackupAuthorityCurrentHead'
    || currentHead.status !== 'autonomous_research_state_backup_authority_head_observed'
    || currentHead.mutationFenceProtocol !== 'external-linearizable-restore-validation-v1'
    || currentHead.allRegisteredMutationsFenced !== true
    || !SHA256.test(String(currentHead.requestHash || ''))
    || !SHA256.test(String(currentHead.headHash || ''))
    || !SIGNATURE.test(String(currentHead.signature || ''))) {
    blockers.push('autonomous_research_state_backup_restore_authority_receipt_invalid');
  } else {
    const performedAt = Date.parse(receipt.performedAt);
    const observedAt = Date.parse(currentHead.observedAt);
    const expiresAt = Date.parse(currentHead.expiresAt);
    if (currentHead.requestHash
        !== hashRecord('AutonomousResearchStateBackupAuthorityCurrentHeadRequest', request)
      || currentHead.reservationId !== bundle.authorityReservation.reservationId
      || currentHead.databaseScopeHash !== bundle.content.databaseScopeHash
      || currentHead.authorityId !== bundle.authorityFinalization.authorityId
      || currentHead.keyId !== bundle.authorityFinalization.keyId) {
      blockers.push('autonomous_research_state_backup_restore_authority_scope_binding_invalid');
    }
    if (!Number.isFinite(performedAt)
      || !Number.isFinite(observedAt)
      || !Number.isFinite(expiresAt)
      || observedAt > performedAt + 5000
      || expiresAt <= performedAt
      || expiresAt <= observedAt) {
      blockers.push('autonomous_research_state_backup_restore_authority_time_binding_invalid');
    }
  }
  if (receipt.authorityCurrentHeadReceiptHash
    !== autonomousResearchStateBackupAuthorityReceiptHash(currentHead)) {
    blockers.push('autonomous_research_state_backup_restore_authority_receipt_hash_invalid');
  }
  const recoverabilityBindingHash = hashRecord(
    'AutonomousResearchStateRestoreRecoverabilityBinding',
    {
      bundleManifestHash: receipt.bundleManifestHash,
      snapshotContentHash: receipt.snapshotContentHash,
      currentHeadReceiptHash: receipt.authorityCurrentHeadReceiptHash,
      journalRangeReceiptHash: receipt.authorityJournalRangeReceiptHash,
      journalReplayMutationCount: receipt.journalReplayMutationCount,
      recoveredDatabaseHeads: receipt.recoveredDatabaseHeads,
      recoverabilityProtocol: receipt.recoverabilityProtocol,
      completeFinalizedMutationJournal: receipt.completeFinalizedMutationJournal,
    },
  );
  if (receipt.recoverabilityBindingHash !== recoverabilityBindingHash) {
    blockers.push('autonomous_research_state_backup_restore_recoverability_binding_invalid');
  }
  const snapshotHeadUnchanged = currentHead?.headSequence
      === bundle.authorityFinalization.headSequence
    && currentHead?.headHash === bundle.authorityFinalization.headHash;
  if (snapshotHeadUnchanged) {
    if (receipt.authorityJournalRangeRequest !== null
      || receipt.authorityJournalRangeReceipt !== null
      || receipt.authorityJournalRangeReceiptHash !== null
      || receipt.journalReplayMutationCount !== 0
      || receipt.recoveredDatabaseHeads.length !== 0
      || receipt.recoverabilityProtocol !== 'snapshot-current-head-exact-v1'
      || receipt.completeFinalizedMutationJournal !== false) {
      blockers.push('autonomous_research_state_backup_restore_snapshot_protocol_invalid');
    }
  } else {
    const journalRequest = receipt.authorityJournalRangeRequest;
    const journalRange = receipt.authorityJournalRangeReceipt;
    if (currentHead?.headSequence < bundle.authorityFinalization.headSequence
      || !journalRequest
      || !journalRange
      || receipt.recoverabilityProtocol
        !== AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL
      || receipt.completeFinalizedMutationJournal !== true
      || receipt.journalReplayMutationCount !== journalRange?.entries?.length
      || receipt.authorityJournalRangeReceiptHash
        !== autonomousResearchStateBackupAuthorityReceiptHash(journalRange)
      || journalRange?.toGlobalSequence !== currentHead?.headSequence
      || journalRange?.toGlobalHash !== currentHead?.headHash
      || journalRange?.fromGlobalSequence !== bundle.authorityFinalization.headSequence
      || journalRange?.fromGlobalHash !== bundle.authorityFinalization.headHash
      || JSON.stringify(receipt.recoveredDatabaseHeads)
        !== JSON.stringify(journalRange?.databaseHeads)) {
      blockers.push('autonomous_research_state_backup_restore_journal_binding_invalid');
    }
    try {
      if (!verifyAutonomousResearchStateBackupAuthorityJournalRange({
        receipt: journalRange,
        request: journalRequest,
        trust: authorityTrust,
        now: receipt.performedAt,
      })) blockers.push('autonomous_research_state_backup_restore_journal_signature_invalid');
    } catch {
      blockers.push('autonomous_research_state_backup_restore_journal_signature_invalid');
    }
    let globalSequence = bundle.authorityFinalization.headSequence;
    let globalHash = bundle.authorityFinalization.headHash;
    const databaseHeads = new Map();
    for (const entry of journalRange?.entries || []) {
      const requestRecord = entry?.reserveRequest;
      const reservation = entry?.reservationReceipt;
      const finalizeRequest = entry?.finalizeRequest;
      const finalization = entry?.finalizationReceipt;
      const instanceId = reservation?.databaseInstanceId;
      let signedReceiptsValid = false;
      try {
        signedReceiptsValid = Boolean(onlineMutationVerifier
          && onlineMutationVerifier.verifyReservation({
            receipt: reservation,
            request: requestRecord,
            now: new Date(reservation?.issuedAt),
          })
          && onlineMutationVerifier.verifyFinalization({
            receipt: finalization,
            request: finalizeRequest,
            reservation,
            now: new Date(finalization?.finalizedAt),
          }));
      } catch {
        signedReceiptsValid = false;
      }
      const previousDatabaseHead = databaseHeads.get(instanceId) || Object.freeze({
        sequence: reservation?.databasePreviousSequence,
        hash: reservation?.databasePreviousHash,
        stateHash: reservation?.preStateHash,
      });
      if (!signedReceiptsValid
        || !hasExactObjectKeys(entry, [
          'reserveRequest', 'reservationReceipt', 'finalizeRequest', 'finalizationReceipt',
        ])
        || reservation.globalPreviousSequence !== globalSequence
        || reservation.globalPreviousHash !== globalHash
        || reservation.globalSequence !== globalSequence + 1
        || reservation.databasePreviousSequence !== previousDatabaseHead.sequence
        || reservation.databasePreviousHash !== previousDatabaseHead.hash
        || reservation.preStateHash !== previousDatabaseHead.stateHash
        || reservation.databaseSequence !== previousDatabaseHead.sequence + 1) {
        blockers.push('autonomous_research_state_backup_restore_journal_entry_invalid');
        break;
      }
      databaseHeads.set(instanceId, Object.freeze({
        sequence: reservation.databaseSequence,
        hash: reservation.databaseHash,
        stateHash: reservation.postStateHash,
      }));
      globalSequence = reservation.globalSequence;
      globalHash = reservation.globalHash;
    }
    for (const [instanceId, databaseHead] of databaseHeads) {
      const signedHead = journalRange?.databaseHeads?.find((head) => (
        head.databaseInstanceId === instanceId
      ));
      if (!signedHead
        || signedHead.sequence !== databaseHead.sequence
        || signedHead.hash !== databaseHead.hash
        || signedHead.stateHash !== databaseHead.stateHash) {
        blockers.push('autonomous_research_state_backup_restore_journal_database_head_invalid');
      }
    }
    if (globalSequence !== currentHead?.headSequence || globalHash !== currentHead?.headHash) {
      blockers.push('autonomous_research_state_backup_restore_journal_continuity_invalid');
    }
  }
  try {
    if (!verifyAutonomousResearchStateBackupAuthorityReservation({
      receipt: bundle.authorityReservation,
      request: bundle.authorityReserveRequest,
      trust: authorityTrust,
      now: bundle.authorityReservation.issuedAt,
    })) blockers.push('autonomous_research_state_backup_restore_authority_reservation_signature_invalid');
    if (!verifyAutonomousResearchStateBackupAuthorityFinalization({
      receipt: bundle.authorityFinalization,
      request: bundle.authorityFinalizeRequest,
      reservation: bundle.authorityReservation,
      trust: authorityTrust,
      now: bundle.authorityFinalization.finalizedAt,
    })) blockers.push('autonomous_research_state_backup_restore_authority_finalization_signature_invalid');
    if (!verifyAutonomousResearchStateBackupAuthorityCurrentHead({
      receipt: currentHead,
      request,
      trust: authorityTrust,
      now: receipt.performedAt,
    })) blockers.push('autonomous_research_state_backup_restore_authority_current_head_signature_invalid');
  } catch {
    blockers.push('autonomous_research_state_backup_restore_authority_trust_invalid');
  }
  return blockers;
}
