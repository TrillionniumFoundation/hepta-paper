import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function auditSkippedAutonomousResearchStateBackupCandidate(candidate, blockers) {
  const safeBlockers = blockers.map((entry) => String(entry).split(':')[0])
    .filter((entry) => /^autonomous_research_state_[a-z0-9_]+$/.test(entry));
  return Object.freeze({
    candidateDirectoryNameHash: hashRecord(
      'AutonomousResearchStateBackupCandidateDirectoryName',
      path.basename(candidate.bundlePath),
    ),
    modifiedAt: new Date(candidate.modifiedAtMs).toISOString(),
    blockers: Object.freeze([...new Set(safeBlockers.length ? safeBlockers : [
      'autonomous_research_state_backup_candidate_invalid',
    ])].sort()),
  });
}

export function buildAutonomousResearchStateBackupSourcesReadyInspection({
  bundlePath,
  bundle,
  restoreReceipt,
  sources,
  skippedCandidates,
} = {}) {
  const currentHead = restoreReceipt.authorityCurrentHeadReceipt;
  const journalRecoverability = restoreReceipt.completeFinalizedMutationJournal === true
    ? {
      recoverabilityProtocol: restoreReceipt.recoverabilityProtocol,
      recoverabilityBindingHash: restoreReceipt.recoverabilityBindingHash,
      completeFinalizedMutationJournal: true,
      journalReplayMutationCount: restoreReceipt.journalReplayMutationCount,
      journalRangeReceiptHash: restoreReceipt.authorityJournalRangeReceiptHash,
      recoveredDatabaseHeads: restoreReceipt.recoveredDatabaseHeads,
    }
    : {};
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupSourcesInspection',
    status: 'autonomous_research_state_backup_sources_ready',
    bundlePath,
    manifestId: bundle.content.manifestId,
    manifestHash: bundle.content.manifestHash,
    bundleManifestHash: bundle.bundleManifestHash,
    snapshotContentHash: bundle.snapshotContentHash,
    snapshotCreatedAt: bundle.content.createdAt,
    inventoryHash: bundle.content.inventoryHash,
    databaseScopeHash: bundle.content.databaseScopeHash,
    databaseInstanceIds: Object.freeze(bundle.content.databases
      .map((entry) => entry.instanceId).sort()),
    restoreDrillReceiptHash: restoreReceipt.restoreDrillReceiptHash,
    restoreDrillPerformedAt: restoreReceipt.performedAt,
    ...journalRecoverability,
    authorityId: currentHead.authorityId,
    keyId: currentHead.keyId,
    headSequence: currentHead.headSequence,
    headHash: currentHead.headHash,
    sources: Object.freeze(sources),
    skippedCandidates: Object.freeze(skippedCandidates),
    blockers: Object.freeze([]),
  });
}
