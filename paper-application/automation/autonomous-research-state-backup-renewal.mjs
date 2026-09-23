import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function observedNow(clock) {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_state_backup_renewal_clock_invalid');
  }
  return date;
}

function blocked(blockers, extra = {}) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupRenewalReceipt',
    status: 'autonomous_research_state_backup_renewal_blocked',
    productionStateMutated: false,
    blockers: Object.freeze([...new Set(blockers)].sort()),
    ...extra,
  });
}

export async function renewAutonomousResearchStateBackup({
  createBackup,
  drillExactBundle,
  publishRenewalReceipt,
  clock = null,
} = {}) {
  let backupReceipt = null;
  let restoreDrillReceipt = null;
  try {
    if (typeof createBackup !== 'function'
      || typeof drillExactBundle !== 'function'
      || typeof publishRenewalReceipt !== 'function') {
      throw new Error('autonomous_research_state_backup_renewal_configuration_invalid');
    }
    backupReceipt = await createBackup();
    if (backupReceipt?.status !== 'autonomous_research_state_backup_recorded') {
      return blocked([
        ...(backupReceipt?.blockers || []),
        'autonomous_research_state_backup_renewal_backup_required',
      ], { backupReceipt, restoreDrillReceipt: null });
    }
    restoreDrillReceipt = await drillExactBundle({
      bundlePath: backupReceipt.bundlePath,
    });
    if (restoreDrillReceipt?.status !== 'autonomous_research_state_restore_drill_passed'
      || restoreDrillReceipt.bundlePath !== backupReceipt.bundlePath
      || restoreDrillReceipt.bundleManifestHash !== backupReceipt.bundleManifestHash
      || restoreDrillReceipt.snapshotContentHash !== backupReceipt.snapshotContentHash) {
      return blocked([
        ...(restoreDrillReceipt?.blockers || []),
        'autonomous_research_state_backup_renewal_restore_drill_required',
      ], { backupReceipt, restoreDrillReceipt });
    }
    const payload = {
      version: 1,
      kind: 'AutonomousResearchStateBackupRenewalReceipt',
      status: 'autonomous_research_state_backup_renewal_complete',
      bundlePath: backupReceipt.bundlePath,
      bundleManifestHash: backupReceipt.bundleManifestHash,
      snapshotContentHash: backupReceipt.snapshotContentHash,
      backupAuthorityHeadSequence: backupReceipt.authorityHeadSequence,
      backupAuthorityHeadHash: backupReceipt.authorityHeadHash,
      restoreAuthorityHeadSequence:
        restoreDrillReceipt.authorityCurrentHeadReceipt.headSequence,
      restoreAuthorityHeadHash: restoreDrillReceipt.authorityCurrentHeadReceipt.headHash,
      restoreDrillReceiptHash: restoreDrillReceipt.restoreDrillReceiptHash,
      recoverabilityBindingHash: restoreDrillReceipt.recoverabilityBindingHash,
      completeFinalizedMutationJournal:
        restoreDrillReceipt.completeFinalizedMutationJournal,
      journalReplayMutationCount: restoreDrillReceipt.journalReplayMutationCount,
      renewedAt: observedNow(clock).toISOString(),
      productionStateMutated: false,
      blockers: Object.freeze([]),
    };
    const receipt = Object.freeze({
      ...payload,
      renewalReceiptHash: hashRecord(
        'AutonomousResearchStateBackupRenewalReceipt', payload,
      ),
    });
    await publishRenewalReceipt({
      bundlePath: backupReceipt.bundlePath,
      receipt,
    });
    return receipt;
  } catch (error) {
    return blocked([
      error?.message || 'autonomous_research_state_backup_renewal_failed',
    ], { backupReceipt, restoreDrillReceipt });
  }
}
