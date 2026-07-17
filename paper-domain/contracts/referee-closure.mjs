import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { PAPER_CORE_VERSION, hashPaperRecord, normalizedId } from './primitives.mjs';

export function buildPostRepairBuildPackage({
  paperTask,
  issueQueue,
  patchApplyExecution = null,
  appliedPatchReceipt = null,
  buildRecheck = null,
  packageRecheck = null,
  researchRecheck = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('PostRepairBuildPackage requires paperTask and issueQueue');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const receiptRecorded = appliedPatchReceipt?.status === 'applied_patch_receipt_recorded';
  const blockers = [];
  if (openIssueCount && !receiptRecorded) blockers.push('applied_patch_receipt_not_recorded');
  if (openIssueCount && receiptRecorded && buildRecheck?.status !== 'build_recheck_passed') {
    blockers.push('post_repair_build_recheck_missing');
  }
  if (openIssueCount && receiptRecorded && packageRecheck?.status !== 'package_rewrite_ready') {
    blockers.push('post_repair_package_rewrite_missing');
  }
  if (openIssueCount && receiptRecorded && researchRecheck?.status !== 'research_recheck_passed') {
    blockers.push('post_repair_research_recheck_missing');
  }
  const gate = {
    version: PAPER_CORE_VERSION,
    kind: 'PostRepairBuildPackage',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_post_repair_build_package_needed'
      : (blockers.length ? 'post_repair_build_package_blocked' : 'post_repair_build_package_ready'),
    repairedPackageWritten: false,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchApplyExecutionHash: patchApplyExecution?.refereePatchApplyExecutionHash || null,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      buildRecheckHash: buildRecheck?.hash || buildRecheck?.buildRecheckHash || null,
      packageRecheckHash: packageRecheck?.hash || packageRecheck?.packageRecheckHash || null,
      researchRecheckHash: researchRecheck?.hash || researchRecheck?.researchRecheckHash || null,
    },
    requiredGateRechecks: [
      'applied_patch_receipt_recorded',
      'postimage_snapshot_present',
      'latex_build_recheck_passed',
      'package_record_rewritten',
      'sha256sums_rewritten',
      'research_verify_rechecked',
      'rollback_ledger_reconciled',
    ],
    expectedArtifacts: [
      'repaired_pdf',
      'repaired_source_package',
      'post_repair_package_record',
      'post_repair_sha256sums',
      'post_repair_research_verify_receipt',
    ],
    blockedActionsUntilPostRepairPackage: [
      'mark_referee_issues_resolved',
      'write_referee_issue_resolution_proof',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
      'replace_current_submit_ready_package',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      gateOnly: true,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresAppliedPatchReceipt: true,
      requiresPostRepairRechecks: true,
    },
    createdAt: createdAt || null,
  };
  return {
    ...gate,
    postRepairBuildPackageHash: hashPaperRecord('PostRepairBuildPackage', gate),
  };
}

export function buildRefereeIssueResolutionProof({
  paperTask,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairBuildPackage = null,
  resolutionEvidence = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RefereeIssueResolutionProof requires paperTask and issueQueue');
  }
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const postRepairReady = postRepairBuildPackage?.status === 'post_repair_build_package_ready';
  const normalizedEvidence = (resolutionEvidence || []).slice(0, 128).map((item, index) => ({
    id: normalizedId(item.id || item.ref, `${paperTask.paperId}:resolution-evidence:${index + 1}`),
    issueId: normalizeText(item.issueId || item.issue_id || '') || null,
    kind: normalizeText(item.kind || 'post_repair_evidence') || 'post_repair_evidence',
    ref: normalizeText(item.ref || item.path || item.url || '') || null,
    hash: normalizeText(item.hash || '') || null,
    patchId: normalizeText(item.patchId || item.patch_id || '') || null,
    patchPath: normalizeText(item.patchPath || item.patch_path || '') || null,
    patchHash: normalizeText(item.patchHash || item.patch_sha256 || '') || null,
    repairedArtifactRefs: (item.repairedArtifactRefs || item.repaired_artifact_refs || []).slice(0, 16).map((artifact, artifactIndex) => ({
      id: normalizedId(artifact.id || artifact.ref || artifact.path, `${paperTask.paperId}:repaired-artifact:${index + 1}:${artifactIndex + 1}`),
      role: normalizeText(artifact.role || artifact.kind || 'repaired_artifact') || 'repaired_artifact',
      ref: normalizeText(artifact.ref || artifact.path || '') || null,
      hash: normalizeText(artifact.hash || '') || null,
    })).filter((artifact) => artifact.ref || artifact.hash),
    buildRecheckHash: normalizeText(item.buildRecheckHash || item.build_recheck_hash || '') || null,
    packageRecheckHash: normalizeText(item.packageRecheckHash || item.package_recheck_hash || '') || null,
    researchRecheckHash: normalizeText(item.researchRecheckHash || item.research_recheck_hash || '') || null,
    agentAcceptance: normalizeText(item.agentAcceptance || item.agent_acceptance || '') || null,
  }));
  const blockers = [];
  if (openIssues.length && !postRepairReady) blockers.push('post_repair_build_package_not_ready');
  if (openIssues.length && postRepairReady && appliedPatchReceipt?.status !== 'applied_patch_receipt_recorded') {
    blockers.push('applied_patch_receipt_not_recorded');
  }
  if (openIssues.length && postRepairReady && !normalizedEvidence.length) {
    blockers.push('issue_resolution_evidence_missing');
  }
  const proof = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeIssueResolutionProof',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssues.length
      ? 'no_referee_issue_resolution_needed'
      : (blockers.length ? 'referee_issue_resolution_proof_blocked' : 'referee_issue_resolution_proof_ready'),
    issueCount: issueQueue.issueCount,
    openIssueCount: openIssues.length,
    resolutionEvidenceCount: normalizedEvidence.length,
    resolvedIssueIds: blockers.length ? [] : openIssues.map((issue) => issue.id),
    candidateIssueIds: openIssues.map((issue) => issue.id),
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
    },
    requiredProofFields: [
      'post_repair_build_package_hash',
      'applied_patch_receipt_hash',
      'issue_id_to_patch_input_mapping',
      'issue_id_to_repaired_artifact_mapping',
      'build_recheck_receipt_hash',
      'research_recheck_receipt_hash',
      'agent_or_reviewer_acceptance',
    ],
    resolutionEvidence: normalizedEvidence,
    blockedActionsUntilResolutionProof: [
      'mark_referee_issues_resolved',
      'close_patch_queue_entries',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
      'publish_repaired_package_as_current',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      proofOnly: true,
      marksIssuesResolved: false,
      writesSqlite: false,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresPostRepairPackage: true,
      requiresIssueResolutionEvidence: true,
    },
    createdAt: createdAt || null,
  };
  return {
    ...proof,
    refereeIssueResolutionProofHash: hashPaperRecord('RefereeIssueResolutionProof', proof),
  };
}

export function buildRepairReconciliation({
  paperTask,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairBuildPackage = null,
  issueResolutionProof = null,
  repairStateMutationReceipt = null,
  rollbackReconciliation = null,
  issueQueueUpdateReceipt = null,
  patchQueueUpdateReceipt = null,
  submissionReadinessReentryGate = null,
  repairAuditArchiveRecord = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RepairReconciliation requires paperTask and issueQueue');
  }
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const proofReady = issueResolutionProof?.status === 'referee_issue_resolution_proof_ready';
  const blockers = [];
  if (openIssues.length && !proofReady) blockers.push('referee_issue_resolution_proof_not_ready');
  if (openIssues.length && proofReady && postRepairBuildPackage?.status !== 'post_repair_build_package_ready') {
    blockers.push('post_repair_build_package_not_ready');
  }
  if (openIssues.length && proofReady && appliedPatchReceipt?.status !== 'applied_patch_receipt_recorded') {
    blockers.push('applied_patch_receipt_not_recorded');
  }
  if (openIssues.length && proofReady && rollbackReconciliation?.status !== 'rollback_ledger_reconciled') {
    blockers.push('rollback_ledger_reconciliation_missing');
  }
  if (openIssues.length && proofReady && issueQueueUpdateReceipt?.status !== 'issue_queue_update_receipt_ready') {
    blockers.push('issue_queue_update_receipt_missing');
  }
  if (openIssues.length && proofReady && patchQueueUpdateReceipt?.status !== 'patch_queue_update_receipt_ready') {
    blockers.push('patch_queue_update_receipt_missing');
  }
  if (openIssues.length && proofReady && submissionReadinessReentryGate?.status !== 'submission_readiness_reentry_ready') {
    blockers.push('submission_readiness_reentry_gate_missing');
  }
  if (openIssues.length && proofReady && repairAuditArchiveRecord?.status !== 'repair_audit_archive_record_ready') {
    blockers.push('repair_audit_archive_record_missing');
  }
  const ready = openIssues.length > 0 && blockers.length === 0;
  const stateMutationRecorded = repairStateMutationReceipt?.status === 'repair_state_mutation_recorded';
  const issueStateMutationPerformed = ready && (
    Boolean(issueQueueUpdateReceipt?.issueStateMutationPerformed)
    || Boolean(repairStateMutationReceipt?.issueStateMutationPerformed)
  );
  const sqliteWritePerformed = ready && (
    Boolean(issueQueueUpdateReceipt?.sqliteWritePerformed)
    || Boolean(repairStateMutationReceipt?.sqliteWritePerformed)
  );
  const submissionReadinessAdvanced = ready && (
    Boolean(submissionReadinessReentryGate?.submissionReadinessAdvanced)
    || Boolean(repairStateMutationReceipt?.reviewedSubmitReadinessReleased)
  );
  const reconciliation = {
    version: PAPER_CORE_VERSION,
    kind: 'RepairReconciliation',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssues.length
      ? 'no_repair_reconciliation_needed'
      : (blockers.length ? 'repair_reconciliation_blocked' : 'repair_reconciliation_ready'),
    repairReconciled: ready,
    submissionReadinessAdvanced,
    issueStateMutationPerformed,
    stateMutationRecorded,
    issueCount: issueQueue.issueCount,
    openIssueCount: openIssues.length,
    candidateIssueIds: issueResolutionProof?.candidateIssueIds || openIssues.map((issue) => issue.id),
    reconciledIssueIds: ready ? (issueResolutionProof?.resolvedIssueIds || openIssues.map((issue) => issue.id)) : [],
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
      issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
      rollbackReconciliationHash: rollbackReconciliation?.hash || rollbackReconciliation?.rollbackReconciliationHash || null,
      issueQueueUpdateReceiptHash: issueQueueUpdateReceipt?.hash || issueQueueUpdateReceipt?.issueQueueUpdateReceiptHash || null,
      patchQueueUpdateReceiptHash: patchQueueUpdateReceipt?.hash || patchQueueUpdateReceipt?.patchQueueUpdateReceiptHash || null,
      submissionReadinessReentryGateHash: submissionReadinessReentryGate?.hash || submissionReadinessReentryGate?.submissionReadinessReentryGateHash || null,
      repairAuditArchiveRecordHash: repairAuditArchiveRecord?.hash || repairAuditArchiveRecord?.repairAuditArchiveRecordHash || null,
      repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    },
    rollbackReconciliation,
    issueQueueUpdateReceipt,
    patchQueueUpdateReceipt,
    submissionReadinessReentryGate,
    repairAuditArchiveRecord,
    repairStateMutationReceipt,
    requiredReconciliationInputs: [
      'referee_issue_resolution_proof_ready',
      'post_repair_build_package_ready',
      'applied_patch_receipt_recorded',
      'rollback_ledger_reconciled',
      'issue_queue_update_receipt',
      'patch_queue_update_receipt',
      'submission_readiness_reentry_gate',
      'repair_audit_archive_record',
    ],
    blockedActionsUntilRepairReconciled: [
      'advance_reviewed_submit_readiness',
      'emit_repaired_submission_manifest',
      'close_referee_revision_batch',
      'archive_repaired_manuscript_as_final',
      'replace_current_package_as_active',
      'mark_repair_loop_complete',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      reconciliationOnly: true,
      marksIssuesResolved: issueStateMutationPerformed,
      writesSqlite: sqliteWritePerformed,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      advancesSubmissionReadiness: submissionReadinessAdvanced,
      requiresIssueResolutionProof: true,
      requiresPostRepairPackage: true,
    },
    createdAt: createdAt || null,
  };
  return {
    ...reconciliation,
    repairReconciliationHash: hashPaperRecord('RepairReconciliation', reconciliation),
  };
}

export function buildRepairStateMutationReceipt({
  paperTask,
  issueQueue,
  issueResolutionProof = null,
  repairReconciliation = null,
  appliedPatchReceipt = null,
  execute = false,
  sqliteWritePerformed = false,
  issueRowsUpdated = 0,
  issueRowsAlreadyResolved = 0,
  patchRowsInserted = 0,
  patchRowsUpdated = 0,
  patchRowsAlreadyPresent = 0,
  issueRows = [],
  patchRows = [],
  errors = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RepairStateMutationReceipt requires paperTask and issueQueue');
  }
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const proofReady = issueResolutionProof?.status === 'referee_issue_resolution_proof_ready';
  const reconciliationReady = repairReconciliation?.status === 'repair_reconciliation_ready';
  const resolvedIssueIds = uniqueStrings(issueResolutionProof?.resolvedIssueIds || [], 256);
  const normalizedIssueRows = (issueRows || []).slice(0, 256).map((row, index) => ({
    id: normalizedId(row.id || row.requestKey || row.request_key || row.requestId, `${paperTask.paperId}:state-issue:${index + 1}`),
    requestId: Number.isFinite(Number(row.requestId || row.request_id)) ? Number(row.requestId || row.request_id) : null,
    requestKey: normalizeText(row.requestKey || row.request_key || '') || null,
    previousStatus: normalizeText(row.previousStatus || row.previous_status || '') || null,
    nextStatus: normalizeText(row.nextStatus || row.next_status || '') || null,
    stateReason: normalizeText(row.stateReason || row.state_reason || '') || null,
  }));
  const normalizedPatchRows = (patchRows || []).slice(0, 64).map((row, index) => ({
    id: normalizedId(row.id || row.patchId || row.patch_id || row.patchPath, `${paperTask.paperId}:state-patch:${index + 1}`),
    patchId: Number.isFinite(Number(row.patchId || row.patch_id)) ? Number(row.patchId || row.patch_id) : null,
    status: normalizeText(row.status || '') || null,
    patchPath: normalizeText(row.patchPath || row.patch_path || '') || null,
    patchSha256: normalizeText(row.patchSha256 || row.patch_sha256 || '') || null,
    action: normalizeText(row.action || '') || null,
  }));
  const receiptBlockers = [...(blockers || [])];
  if (openIssues.length && !execute) receiptBlockers.push('explicit_repair_state_mutation_execute_required');
  if (openIssues.length && !proofReady) receiptBlockers.push('referee_issue_resolution_proof_not_ready');
  if (openIssues.length && !reconciliationReady) receiptBlockers.push('repair_reconciliation_not_ready');
  if (openIssues.length && proofReady && !resolvedIssueIds.length) receiptBlockers.push('resolved_issue_ids_missing');
  for (const error of errors || []) {
    if (normalizeText(error)) receiptBlockers.push('sqlite_state_mutation_failed');
  }
  const recorded = openIssues.length > 0
    && Boolean(execute)
    && proofReady
    && reconciliationReady
    && Boolean(sqliteWritePerformed)
    && receiptBlockers.length === 0;
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'RepairStateMutationReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssues.length
      ? 'no_repair_state_mutation_needed'
      : (receiptBlockers.length ? 'repair_state_mutation_blocked' : 'repair_state_mutation_recorded'),
    executeRequested: Boolean(execute),
    issueCount: issueQueue.issueCount,
    openIssueCount: openIssues.length,
    resolvedIssueIds,
    issueRowsUpdated: Number(issueRowsUpdated) || 0,
    issueRowsAlreadyResolved: Number(issueRowsAlreadyResolved) || 0,
    patchRowsInserted: Number(patchRowsInserted) || 0,
    patchRowsUpdated: Number(patchRowsUpdated) || 0,
    patchRowsAlreadyPresent: Number(patchRowsAlreadyPresent) || 0,
    issueRows: normalizedIssueRows,
    patchRows: normalizedPatchRows,
    issueStateMutationPerformed: recorded,
    sqliteWritePerformed: recorded,
    reviewedSubmitReadinessReleased: recorded,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
      repairReconciliationHash: repairReconciliation?.repairReconciliationHash || null,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
    },
    blockers: uniqueStrings(receiptBlockers, 64),
    warnings: uniqueStrings(warnings || [], 64),
    errors: uniqueStrings(errors || [], 16),
    safety: {
      sqliteMutationExecutor: true,
      writesSqlite: recorded,
      marksIssuesResolved: recorded,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      onlyResolvedMappedIssueIds: true,
      recordsAgentPatchQueueRows: true,
      releasesReviewedSubmitReadiness: recorded,
    },
    createdAt: createdAt || null,
  };
  return {
    ...receipt,
    repairStateMutationReceiptHash: hashPaperRecord('RepairStateMutationReceipt', receipt),
  };
}
