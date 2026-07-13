import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { PAPER_CORE_VERSION, hashPaperRecord, normalizedId } from './primitives.mjs';

export function buildRefereeApplyApprovalPacket({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  rollbackLedgerDraft = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  executeDesignPacket = null,
  approved = false,
  approver = 'openclaw-agent',
  approvalActor = 'agent',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeApplyApprovalPacket requires paperTask, issueQueue, and patchPlan');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const approvalNeeded = openIssueCount > 0;
  const normalizedActor = normalizeText(approvalActor) || 'agent';
  const normalizedApprover = normalizeText(approver);
  const blockers = [];
  if (approvalNeeded && !approved) blockers.push('agent_referee_apply_approval_required');
  if (approvalNeeded && approved && normalizedActor !== 'agent') blockers.push('agent_referee_apply_approval_required');
  if (approvalNeeded && approved && !normalizedApprover) blockers.push('agent_id_required');
  if (approvalNeeded && ![
    'referee_execute_design_ready_apply_blocked',
    'referee_execute_design_ready_for_apply_execution',
  ].includes(executeDesignPacket?.status)) {
    blockers.push('execute_design_packet_not_ready');
  }
  if (approvalNeeded && executePlan?.status !== 'execute_plan_ready_requires_explicit_apply_mode') {
    blockers.push('execute_plan_not_ready');
  }
  if (approvalNeeded && rollbackLedgerDraft?.status !== 'rollback_ledger_draft_ready') {
    blockers.push('rollback_ledger_draft_not_ready');
  }
  if (approvalNeeded && preimageSnapshotLedger?.status !== 'preimage_snapshot_ready') {
    blockers.push('preimage_snapshot_not_ready');
  }
  if (approvalNeeded && approved && applyModeContract?.status !== 'apply_mode_ready') {
    blockers.push('apply_mode_contract_not_ready');
  }
  const preimageEntries = preimageSnapshotLedger?.entries || [];
  const targetPaths = preimageEntries.length
    ? preimageEntries.map((entry) => entry.targetPath)
    : (patchExecutionPreflight?.targetPaths || []);
  const targetPathAcceptance = targetPaths.map((targetPath, index) => {
    const preimage = preimageEntries.find((entry) => entry.targetPath === targetPath);
    return {
      id: `${paperTask.paperId}:referee-apply-target:${index + 1}`,
      targetPath: normalizeText(targetPath),
      preimageHash: preimage?.preimageHash || null,
      preimageSnapshotStatus: preimage?.snapshotStatus || 'preimage_snapshot_required',
      acceptedByAgent: approvalNeeded && Boolean(approved) && blockers.length === 0,
      acceptedByOperator: false,
    };
  });
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeApplyApprovalPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !approvalNeeded
      ? 'no_referee_apply_approval_needed'
      : (blockers.length ? 'referee_apply_approval_blocked' : 'referee_apply_approval_ready_for_patch_execution'),
    approved: approvalNeeded && Boolean(approved) && blockers.length === 0,
    approvalActor: normalizedActor,
    approver: approvalNeeded && approved ? normalizedApprover || null : null,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    targetPathCount: targetPathAcceptance.length,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
      rollbackLedgerDraftHash: rollbackLedgerDraft?.refereeRevisionRollbackLedgerDraftHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
      executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
      applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
      executeDesignPacketHash: executeDesignPacket?.refereeRevisionExecuteDesignPacketHash || null,
    },
    requiredAgentApprovalInputs: [
      'approval_decision',
      'agent_id',
      'decision_timestamp',
      'accepted_issue_queue_hash',
      'accepted_patch_plan_hash',
      'accepted_patch_execution_preflight_hash',
      'accepted_rollback_ledger_draft_hash',
      'accepted_preimage_snapshot_ledger_hash',
      'accepted_execute_plan_hash',
      'accepted_execute_design_packet_hash',
      'accepted_target_paths',
      'accepted_preimage_hashes',
      'worktree_scope_confirmation',
      'rollback_restore_confirmation',
    ],
    requiredOperatorInputs: [],
    approvalIntakeTemplate: {
      approvalDecision: approvalNeeded && approved && blockers.length === 0 ? 'approved_by_agent' : null,
      agentId: approvalNeeded && approved ? normalizedApprover || null : null,
      operatorId: null,
      decisionTimestamp: approvalNeeded && approved && blockers.length === 0 ? (createdAt || nowIso()) : null,
      acceptedHashes: {
        issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
        patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
        patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
        rollbackLedgerDraftHash: rollbackLedgerDraft?.refereeRevisionRollbackLedgerDraftHash || null,
        preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
        executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
        executeDesignPacketHash: executeDesignPacket?.refereeRevisionExecuteDesignPacketHash || null,
      },
      acceptedTargetPaths: approvalNeeded && approved && blockers.length === 0 ? targetPaths : [],
      acceptedPreimageHashes: approvalNeeded && approved && blockers.length === 0
        ? preimageEntries.map((entry) => entry.preimageHash).filter(Boolean)
        : [],
      rollbackRestoreConfirmed: approvalNeeded && approved && blockers.length === 0,
      worktreeScopeConfirmed: approvalNeeded && approved && blockers.length === 0,
      cleanOrIsolatedWorktreeConfirmed: false,
    },
    targetPathAcceptance,
    rollbackAcceptance: (rollbackLedgerDraft?.entries || []).map((entry) => ({
      targetPath: entry.targetPath,
      snapshotStatus: entry.snapshotStatus,
      restoreAction: entry.restoreAction,
      acceptedByAgent: approvalNeeded && Boolean(approved) && blockers.length === 0,
      acceptedByOperator: false,
    })),
    nextAllowedStepWhenApproved: 'referee_patch_apply_execution',
    blockedActionsUntilApproved: [
      'apply_patch_to_source',
      'write_postimage_snapshot',
      'mark_referee_issues_resolved',
      'rebuild_repaired_package',
      'advance_submission_readiness_from_repair',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      approvalIntakeOnly: true,
      agentApprovalOnly: true,
      appliesPatch: false,
      writesSource: false,
      sourceMutation: false,
      externalActionPerformed: false,
      grantsSourceMutationInsideOverlay: false,
      requiresSeparateApplyExecutor: true,
      requiresPostApplyReceipts: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    refereeApplyApprovalPacketHash: hashPaperRecord('RefereeApplyApprovalPacket', packet),
  };
}

export function buildRefereePatchApplyExecution({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  executeDesignPacket = null,
  applyApprovalPacket = null,
  execute = false,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereePatchApplyExecution requires paperTask, issueQueue, and patchPlan');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const approvalReady = applyApprovalPacket?.status === 'referee_apply_approval_ready_for_patch_execution';
  const blockers = [];
  if (openIssueCount && executePlan?.status !== 'execute_plan_ready_requires_explicit_apply_mode') {
    blockers.push('execute_plan_not_ready');
  }
  if (openIssueCount && preimageSnapshotLedger?.status !== 'preimage_snapshot_ready') {
    blockers.push('preimage_snapshot_not_ready');
  }
  if (openIssueCount && ![
    'referee_execute_design_ready_apply_blocked',
    'referee_execute_design_ready_for_apply_execution',
  ].includes(executeDesignPacket?.status)) {
    blockers.push('execute_design_packet_not_ready');
  }
  if (openIssueCount && !approvalReady) blockers.push('referee_apply_approval_not_ready');
  if (openIssueCount && approvalReady && applyModeContract?.status !== 'apply_mode_ready') {
    blockers.push('apply_mode_contract_not_ready');
  }
  const candidatePatches = (issueQueue.patchQueue || [])
    .filter((patch) => !['applied', 'rejected', 'superseded'].includes(patch.status));
  const targetPreimages = (preimageSnapshotLedger?.entries || []).map((entry) => ({
    targetPath: entry.targetPath,
    preimageHash: entry.preimageHash,
    snapshotStatus: entry.snapshotStatus,
  }));
  const execution = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereePatchApplyExecution',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_referee_patch_apply_needed'
      : (blockers.length ? 'referee_patch_apply_execution_blocked' : 'referee_patch_apply_ready_for_separate_executor'),
    executionPerformed: false,
    sourceMutationPerformed: false,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    candidatePatchCount: candidatePatches.length,
    targetPathCount: patchExecutionPreflight?.targetPathCount || targetPreimages.length,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
      executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
      applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
      executeDesignPacketHash: executeDesignPacket?.refereeRevisionExecuteDesignPacketHash || null,
      applyApprovalPacketHash: applyApprovalPacket?.refereeApplyApprovalPacketHash || null,
    },
    plannedPatchInputs: candidatePatches.map((patch) => ({
      patchId: patch.id,
      patchPath: patch.patchPath,
      patchSha256: patch.patchSha256,
      targetPaths: patch.targetPaths || [],
      status: patch.status,
    })),
    targetPreimages,
    requiredExecutionOrder: [
      'validate_referee_apply_approval_packet',
      'verify_hash_chain_matches_approval_packet',
      'verify_target_preimage_hashes',
      'apply_patch_queue_entries_to_source',
      'write_postimage_snapshot_ledger',
      'run_latex_build_recheck',
      'run_package_adapter_rewrite',
      'run_research_verify_recheck',
      'write_applied_patch_receipt',
      'reconcile_referee_issue_resolution',
    ],
    blockedActionsUntilAppliedPatchReceipt: [
      'mark_referee_issues_resolved',
      'replace_submit_ready_package',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
    ],
    nextRequiredStep: 'referee_patch_apply_invocation',
    executeInvocationRequested: Boolean(execute),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      executionSurfaceOnly: true,
      appliesPatch: false,
      writesSource: false,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresApprovedRefereeApplyApprovalPacket: true,
      requiresSeparateSourceMutationExecutor: true,
      requiresAppliedPatchReceipt: true,
      requiresPostRepairGateRecheck: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...execution,
    refereePatchApplyExecutionHash: hashPaperRecord('RefereePatchApplyExecution', execution),
  };
}

export function buildRefereePatchApplyInvocation({
  paperTask,
  issueQueue,
  patchApplyExecution = null,
  applyApprovalPacket = null,
  execute = false,
  executorId = 'openclaw-agent-local-patch-apply',
  validationRecords = [],
  targetPreimageChecks = [],
  appliedPatchHashes = [],
  postimageRecords = [],
  sourceDiffHash = null,
  applied = false,
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RefereePatchApplyInvocation requires paperTask and issueQueue');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const normalizedExecutorId = normalizeText(executorId) || null;
  const executionReady = patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor';
  const normalizedValidationRecords = (validationRecords || []).slice(0, 256).map((record, index) => ({
    id: normalizedId(record.id || record.patchId, `${paperTask.paperId}:patch-validation:${index + 1}`),
    patchId: normalizeText(record.patchId || '') || null,
    patchPath: normalizeText(record.patchPath || '') || null,
    patchHashExpected: normalizeText(record.patchHashExpected || '') || null,
    patchHashActual: normalizeText(record.patchHashActual || '') || null,
    targetPaths: uniqueStrings(record.targetPaths || [], 64),
    cleanApplyCheck: normalizeText(record.cleanApplyCheck || '') || null,
    blockers: uniqueStrings(record.blockers || [], 32),
    stderr: uniqueStrings(record.stderr || [], 16),
  }));
  const normalizedPreimageChecks = (targetPreimageChecks || []).slice(0, 256).map((record, index) => ({
    id: normalizedId(record.id || record.targetPath, `${paperTask.paperId}:preimage-check:${index + 1}`),
    targetPath: normalizeText(record.targetPath || '') || null,
    expectedPreimageHash: normalizeText(record.expectedPreimageHash || '') || null,
    actualPreimageHash: normalizeText(record.actualPreimageHash || '') || null,
    status: normalizeText(record.status || '') || null,
    blockers: uniqueStrings(record.blockers || [], 16),
  }));
  const normalizedPostimages = (postimageRecords || []).slice(0, 256).map((record, index) => ({
    id: normalizedId(record.id || record.path || record.targetPath, `${paperTask.paperId}:postimage:${index + 1}`),
    targetPath: normalizeText(record.targetPath || record.path || '') || null,
    postimageHash: normalizeText(record.postimageHash || record.hash || '') || null,
    sizeBytes: Number.isFinite(Number(record.sizeBytes)) ? Number(record.sizeBytes) : null,
  })).filter((record) => record.targetPath);
  const invocationBlockers = [...(blockers || [])];
  for (const record of normalizedValidationRecords) invocationBlockers.push(...(record.blockers || []));
  for (const record of normalizedPreimageChecks) invocationBlockers.push(...(record.blockers || []));
  if (openIssueCount && !executionReady) invocationBlockers.push('referee_patch_apply_execution_not_ready');
  if (openIssueCount && executionReady && !execute) invocationBlockers.push('explicit_referee_patch_apply_execute_invocation_required');
  if (openIssueCount && execute && !normalizedExecutorId) invocationBlockers.push('executor_id_required');
  if (openIssueCount && execute && !normalizedValidationRecords.length) invocationBlockers.push('patch_validation_records_required');
  if (openIssueCount && execute && Boolean(applied) && !normalizedPostimages.length) {
    invocationBlockers.push('postimage_snapshot_required');
  }
  if (openIssueCount && execute && !Boolean(applied) && !invocationBlockers.length) {
    invocationBlockers.push('patch_apply_executor_did_not_apply');
  }
  const appliedCleanly = openIssueCount > 0 && Boolean(execute) && Boolean(applied) && invocationBlockers.length === 0;
  const invocation = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereePatchApplyInvocation',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_referee_patch_apply_invocation_needed'
      : (invocationBlockers.length ? 'referee_patch_apply_invocation_blocked' : 'referee_patch_apply_invocation_applied'),
    executeRequested: Boolean(execute),
    executorId: normalizedExecutorId,
    approvedByAgent: applyApprovalPacket?.approvalActor === 'agent' && applyApprovalPacket?.approved === true,
    appliedPatchPerformed: appliedCleanly,
    sourceMutationPerformed: appliedCleanly,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    plannedPatchInputCount: patchApplyExecution?.plannedPatchInputs?.length || 0,
    validationRecordCount: normalizedValidationRecords.length,
    targetPreimageCheckCount: normalizedPreimageChecks.length,
    postimageCount: normalizedPostimages.length,
    appliedPatchHashes: uniqueStrings(appliedPatchHashes || [], 256),
    sourceDiffHash: normalizeText(sourceDiffHash || '') || null,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchApplyExecutionHash: patchApplyExecution?.refereePatchApplyExecutionHash || null,
      applyApprovalPacketHash: applyApprovalPacket?.refereeApplyApprovalPacketHash || null,
    },
    validationRecords: normalizedValidationRecords,
    targetPreimageChecks: normalizedPreimageChecks,
    postimageRecords: normalizedPostimages,
    blockers: uniqueStrings(invocationBlockers, 64),
    warnings: uniqueStrings(warnings || [], 32),
    safety: {
      invocationReceiptOnlyWhenBlocked: !appliedCleanly,
      appliesPatch: appliedCleanly,
      writesSource: appliedCleanly,
      sourceMutation: appliedCleanly,
      externalActionPerformed: false,
      requiresAppliedPatchReceipt: true,
      requiresPostRepairGateRecheck: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...invocation,
    refereePatchApplyInvocationHash: hashPaperRecord('RefereePatchApplyInvocation', invocation),
  };
}

export function buildRefereeAppliedPatchReceipt({
  paperTask,
  issueQueue,
  patchPlan,
  patchApplyExecution = null,
  patchApplyInvocation = null,
  applyApprovalPacket = null,
  preimageSnapshotLedger = null,
  applied = false,
  executorId = '',
  postimageRecords = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeAppliedPatchReceipt requires paperTask, issueQueue, and patchPlan');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const executionReady = patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor';
  const invocationApplied = patchApplyInvocation?.status === 'referee_patch_apply_invocation_applied';
  const blockers = [];
  if (openIssueCount && !executionReady) blockers.push('referee_patch_apply_execution_not_ready');
  if (openIssueCount && executionReady && !invocationApplied) blockers.push('referee_patch_apply_invocation_not_applied');
  if (openIssueCount && invocationApplied && !applied) blockers.push('applied_patch_receipt_missing');
  if (openIssueCount && applied && !normalizeText(executorId)) blockers.push('executor_id_required');
  if (openIssueCount && applied && !postimageRecords.length) blockers.push('postimage_snapshot_required');
  const normalizedPostimages = (postimageRecords || []).slice(0, 128).map((record, index) => ({
    id: normalizedId(record.id || record.path, `${paperTask.paperId}:postimage:${index + 1}`),
    targetPath: normalizeText(record.targetPath || record.path || ''),
    postimageHash: normalizeText(record.postimageHash || record.hash || '') || null,
    sizeBytes: Number.isFinite(Number(record.sizeBytes)) ? Number(record.sizeBytes) : null,
  })).filter((record) => record.targetPath);
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeAppliedPatchReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_referee_applied_patch_receipt_needed'
      : (blockers.length ? 'applied_patch_receipt_blocked' : 'applied_patch_receipt_recorded'),
    executorId: normalizeText(executorId) || null,
    appliedPatchPerformed: openIssueCount > 0 && Boolean(applied) && blockers.length === 0,
    sourceMutationPerformed: openIssueCount > 0 && Boolean(applied) && blockers.length === 0,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    plannedPatchInputCount: patchApplyExecution?.plannedPatchInputs?.length || 0,
    postimageCount: normalizedPostimages.length,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      applyApprovalPacketHash: applyApprovalPacket?.refereeApplyApprovalPacketHash || null,
      patchApplyExecutionHash: patchApplyExecution?.refereePatchApplyExecutionHash || null,
      patchApplyInvocationHash: patchApplyInvocation?.refereePatchApplyInvocationHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
    },
    expectedReceiptFields: [
      'patch_apply_invocation_hash',
      'executor_id',
      'applied_patch_input_hashes',
      'accepted_preimage_hashes',
      'postimage_hashes',
      'source_mutation_diff_hash',
      'latex_build_recheck_result',
      'package_rewrite_result',
      'research_verify_recheck_result',
      'rollback_ledger_reconciliation_result',
    ],
    plannedPatchInputs: patchApplyExecution?.plannedPatchInputs || [],
    acceptedPreimages: patchApplyInvocation?.targetPreimageChecks || patchApplyExecution?.targetPreimages || (preimageSnapshotLedger?.entries || []),
    postimageRecords: normalizedPostimages,
    blockedActionsUntilReceiptRecorded: [
      'post_repair_build_package',
      'mark_referee_issues_resolved',
      'write_referee_issue_resolution_proof',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      receiptOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresActualSourceMutationExecutorReceipt: true,
      requiresPostRepairGateRecheck: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    refereeAppliedPatchReceiptHash: hashPaperRecord('RefereeAppliedPatchReceipt', receipt),
  };
}
