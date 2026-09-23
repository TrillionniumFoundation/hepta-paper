import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { PAPER_CORE_VERSION, hashPaperRecord, normalizedId, normalizeRefs } from './primitives.mjs';

export function buildRefereeReviewIntake({
  paperTask,
  sourceRecord = null,
  evidenceRefs = [],
  reviewScope = 'agent_referee_review',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('RefereeReviewIntake requires paperTask');
  const blockers = [];
  const normalizedScope = normalizeText(reviewScope) || 'agent_referee_review';
  if (!paperTask.mainTex) blockers.push('main_tex_required_for_referee_review');
  if (!sourceRecord?.hash) blockers.push('source_record_required_for_referee_review');
  const intake = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeReviewIntake',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    reviewScope: normalizedScope,
    status: blockers.length ? 'referee_review_intake_blocked' : 'referee_review_intake_ready',
    mainTex: paperTask.mainTex || null,
    sourceRecord,
    evidenceRefs: normalizeRefs(evidenceRefs).slice(0, 32),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      readsOnly: true,
      modelCallPerformed: false,
      writesSqlite: false,
      writesSource: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...intake, refereeReviewIntakeHash: hashPaperRecord('RefereeReviewIntake', intake) };
}

export function buildAgentRefereeReviewReport({
  paperTask,
  intake,
  findings = [],
  reviewerId = 'openclaw-agent-referee-reviewer',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !intake?.kind) throw new Error('AgentRefereeReviewReport requires paperTask and intake');
  const blockers = [];
  if (intake.status !== 'referee_review_intake_ready') blockers.push('referee_review_intake_not_ready');
  const normalizedFindings = (findings || []).slice(0, 32).map((finding, index) => {
    const requestKey = normalizeText(finding.requestKey || finding.request_key || finding.id)
      || `${paperTask.paperId}:agent-review:${index + 1}`;
    return {
      id: normalizedId(finding.id || requestKey, `${paperTask.paperId}:agent-review:${index + 1}`),
      requestKey,
      status: normalizeText(finding.status || 'requested') || 'requested',
      severity: normalizeText(finding.severity || 'medium') || 'medium',
      riskClass: normalizeText(finding.riskClass || finding.risk_class || 'agent_referee_review') || 'agent_referee_review',
      objection: normalizeText(finding.objection || ''),
      sourceLocator: normalizeText(finding.sourceLocator || finding.source_locator || '') || null,
      evidenceLocator: normalizeText(finding.evidenceLocator || finding.evidence_locator || '') || null,
      proposedFix: normalizeText(finding.proposedFix || finding.proposed_fix || ''),
      evidenceNeeded: normalizeText(finding.evidenceNeeded || finding.evidence_needed || '') || null,
      verification: normalizeText(finding.verification || ''),
      patchScope: normalizeText(finding.patchScope || finding.patch_scope || 'single_main_tex_repair') || 'single_main_tex_repair',
    };
  }).filter((finding) => finding.objection && finding.proposedFix && finding.verification);
  const report = {
    version: PAPER_CORE_VERSION,
    kind: 'AgentRefereeReviewReport',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    reviewerId: normalizeText(reviewerId) || 'openclaw-agent-referee-reviewer',
    status: blockers.length
      ? 'agent_referee_review_blocked'
      : (normalizedFindings.length ? 'agent_referee_review_ready' : 'agent_referee_review_clear'),
    intakeHash: intake.refereeReviewIntakeHash,
    findingCount: normalizedFindings.length,
    findings: normalizedFindings,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      deterministicLocalReview: true,
      modelCallPerformed: false,
      writesSqlite: false,
      writesSource: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...report, agentRefereeReviewReportHash: hashPaperRecord('AgentRefereeReviewReport', report) };
}

export function buildRefereeIssueQueueMaterialization({
  paperTask,
  reviewReport,
  execute = false,
  sqliteWritePerformed = false,
  materializedIssueRows = [],
  existingIssueRows = [],
  errors = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !reviewReport?.kind) {
    throw new Error('RefereeIssueQueueMaterialization requires paperTask and reviewReport');
  }
  const allBlockers = [...(blockers || [])];
  if (reviewReport.status === 'agent_referee_review_blocked') allBlockers.push('agent_referee_review_not_ready');
  if (execute && reviewReport.status === 'agent_referee_review_ready' && !materializedIssueRows.length && !existingIssueRows.length) {
    allBlockers.push('referee_issue_rows_not_materialized');
  }
  const materialization = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeIssueQueueMaterialization',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: execute ? 'execute' : 'plan',
    status: allBlockers.length
      ? 'referee_issue_queue_materialization_blocked'
      : (!reviewReport.findingCount
        ? 'referee_issue_queue_materialization_not_needed'
        : execute
        ? 'referee_issue_queue_materialized'
        : 'referee_issue_queue_materialization_planned'),
    reviewReportHash: reviewReport.agentRefereeReviewReportHash,
    findingCount: reviewReport.findingCount || 0,
    materializedIssueRows: (materializedIssueRows || []).slice(0, 64).map((row, index) => ({
      id: normalizedId(row.id || row.requestKey || row.request_key || row.requestId, `${paperTask.paperId}:materialized-review:${index + 1}`),
      requestKey: normalizeText(row.requestKey || row.request_key || row.id || ''),
      status: normalizeText(row.status || 'requested') || 'requested',
      action: normalizeText(row.action || 'inserted') || 'inserted',
    })),
    existingIssueRows: (existingIssueRows || []).slice(0, 64).map((row, index) => ({
      id: normalizedId(row.id || row.requestKey || row.request_key || row.requestId, `${paperTask.paperId}:existing-review:${index + 1}`),
      requestKey: normalizeText(row.requestKey || row.request_key || row.id || ''),
      status: normalizeText(row.status || 'requested') || 'requested',
      action: normalizeText(row.action || 'already_present') || 'already_present',
    })),
    blockers: uniqueStrings(allBlockers, 32),
    warnings: uniqueStrings(warnings, 32),
    errors: uniqueStrings(errors, 32),
    safety: {
      writesSqlite: Boolean(execute && sqliteWritePerformed),
      writesSource: false,
      appliesPatch: false,
      externalActionPerformed: false,
      requiresRefereeReviseForSourceMutation: true,
    },
    createdAt: createdAt || null,
  };
  return {
    ...materialization,
    refereeIssueQueueMaterializationHash: hashPaperRecord('RefereeIssueQueueMaterialization', materialization),
  };
}

export function buildRefereeRevisionIssueQueue({
  paperTask,
  requests = [],
  patchQueue = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('RefereeRevisionIssueQueue requires paperTask');
  const issues = (requests || []).slice(0, 128).map((request, index) => ({
    id: normalizedId(request.request_key || request.requestId || request.id, `${paperTask.paperId}:referee:${index + 1}`),
    status: normalizeText(request.status || 'requested') || 'requested',
    riskClass: normalizeText(request.risk_class || request.riskClass || '') || null,
    objection: normalizeText(request.objection || ''),
    sourceLocator: normalizeText(request.source_locator || request.sourceLocator || '') || null,
    evidenceLocator: normalizeText(request.evidence_locator || request.evidenceLocator || '') || null,
    proposedFix: normalizeText(request.proposed_fix || request.proposedFix || '') || null,
    verification: normalizeText(request.verification || '') || null,
    sourcePatchId: request.source_patch_id || request.sourcePatchId || null,
    workerPatchId: request.worker_patch_id || request.workerPatchId || null,
  }));
  const patches = (patchQueue || []).slice(0, 128).map((patch, index) => ({
    id: normalizedId(patch.patch_id || patch.patchId || patch.id, `${paperTask.paperId}:patch:${index + 1}`),
    status: normalizeText(patch.status || 'queued') || 'queued',
    patchPath: normalizeText(patch.patch_path || patch.patchPath || '') || null,
    patchSha256: normalizeText(patch.patch_sha256 || patch.patchSha256 || '') || null,
    targetPaths: Array.isArray(patch.targetPaths) ? patch.targetPaths : [],
    batchId: normalizeText(patch.batch_id || patch.batchId || '') || null,
  }));
  const openIssues = issues.filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const queue = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionIssueQueue',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: openIssues.length ? 'open_referee_revision_items' : 'referee_revision_queue_clear',
    issueCount: issues.length,
    openIssueCount: openIssues.length,
    patchCount: patches.length,
    issues,
    patchQueue: patches,
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...queue, refereeRevisionIssueQueueHash: hashPaperRecord('RefereeRevisionIssueQueue', queue) };
}

export function buildRefereeRevisionPatchPlan({
  paperTask,
  issueQueue,
  mode = 'dry-run',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) throw new Error('RefereeRevisionPatchPlan requires paperTask and issueQueue');
  const openIssues = (issueQueue.issues || []).filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const planItems = openIssues.slice(0, 64).map((issue, index) => ({
    id: `${issue.id}:plan:${index + 1}`,
    issueId: issue.id,
    action: 'plan_patch_or_claim_downgrade',
    sourceLocator: issue.sourceLocator,
    proposedFix: issue.proposedFix,
    verification: issue.verification,
  }));
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionPatchPlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizeText(mode) || 'dry-run',
    status: planItems.length ? 'dry_run_patch_plan_ready' : 'no_referee_revision_patch_needed',
    issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
    planItemCount: planItems.length,
    planItems,
    rollbackRequiredForExecute: true,
    safety: {
      dryRunOnly: true,
      sourceMutation: false,
      requiresRollbackLedgerForExecute: true,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...plan, refereeRevisionPatchPlanHash: hashPaperRecord('RefereeRevisionPatchPlan', plan) };
}

export function buildRefereeRevisionPatchExecutionPreflight({
  paperTask,
  issueQueue,
  patchPlan,
  sourceWorkspace = null,
  mode = 'dry-run',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeRevisionPatchExecutionPreflight requires paperTask, issueQueue, and patchPlan');
  }
  const blockers = [];
  const warnings = [];
  const normalizedMode = normalizeText(mode) || 'dry-run';
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const candidatePatches = (issueQueue.patchQueue || [])
    .filter((patch) => !['applied', 'rejected', 'superseded'].includes(patch.status));
  const targetPaths = uniqueStrings(
    candidatePatches.flatMap((patch) => patch.targetPaths || []).map((target) => normalizeText(target)).filter(Boolean),
    128,
  );
  if (normalizedMode !== 'dry-run') blockers.push('referee_revision_execute_disabled_in_overlay');
  if (!sourceWorkspace) blockers.push('source_workspace_required_for_patch_preflight');
  if (openIssues.length && !patchPlan.planItemCount) blockers.push('patch_plan_missing_for_open_issues');
  if (candidatePatches.length && !targetPaths.length) warnings.push('patch_queue_target_paths_missing');
  if (openIssues.length && !candidatePatches.length) warnings.push('open_issues_without_patch_queue_entries');
  const preflight = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionPatchExecutionPreflight',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizedMode,
    status: blockers.length
      ? 'blocked_preflight'
      : (openIssues.length ? 'dry_run_patch_execution_preflight_ready' : 'no_referee_revision_execution_needed'),
    issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    sourceWorkspace: normalizeText(sourceWorkspace) || null,
    openIssueCount: openIssues.length,
    candidatePatchCount: candidatePatches.length,
    targetPathCount: targetPaths.length,
    targetPaths,
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      dryRunOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresRollbackLedgerForExecute: true,
    },
    createdAt: createdAt || null,
  };
  return {
    ...preflight,
    refereeRevisionPatchExecutionPreflightHash: hashPaperRecord('RefereeRevisionPatchExecutionPreflight', preflight),
  };
}

export function buildRefereeRevisionRollbackLedgerDraft({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight,
  mode = 'dry-run',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchPlan?.kind || !patchExecutionPreflight?.kind) {
    throw new Error('RefereeRevisionRollbackLedgerDraft requires paperTask, patchPlan, and patchExecutionPreflight');
  }
  const blockers = [];
  const normalizedMode = normalizeText(mode) || 'dry-run';
  if (normalizedMode !== 'dry-run') blockers.push('rollback_ledger_execute_requires_real_preimage_snapshot');
  if (patchExecutionPreflight.status === 'blocked_preflight') blockers.push('patch_execution_preflight_blocked');
  const targetPaths = patchExecutionPreflight.targetPaths || [];
  const entries = targetPaths.map((targetPath, index) => ({
    id: `${paperTask.paperId}:rollback:${index + 1}`,
    targetPath,
    preimageHash: null,
    postimageHash: null,
    snapshotStatus: 'snapshot_required_before_execute',
    restoreAction: 'restore_preimage_before_commit',
  }));
  const draft = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionRollbackLedgerDraft',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizedMode,
    status: blockers.length
      ? 'blocked_rollback_ledger_draft'
      : (entries.length ? 'rollback_ledger_draft_ready' : 'no_rollback_entries_needed'),
    issueQueueHash: issueQueue?.refereeRevisionIssueQueueHash || null,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    patchExecutionPreflightHash: patchExecutionPreflight.refereeRevisionPatchExecutionPreflightHash,
    entryCount: entries.length,
    entries,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      dryRunOnly: true,
      sourceMutation: false,
      writesRollbackLedger: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...draft,
    refereeRevisionRollbackLedgerDraftHash: hashPaperRecord('RefereeRevisionRollbackLedgerDraft', draft),
  };
}

export function buildRefereeRevisionPreimageSnapshotLedger({
  paperTask,
  patchExecutionPreflight,
  targetRecords = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchExecutionPreflight?.kind) {
    throw new Error('RefereeRevisionPreimageSnapshotLedger requires paperTask and patchExecutionPreflight');
  }
  const targetRecordByPath = new Map((targetRecords || [])
    .map((record) => [normalizeText(record.path), record])
    .filter(([key]) => key));
  const entries = (patchExecutionPreflight.targetPaths || []).map((targetPath, index) => {
    const record = targetRecordByPath.get(normalizeText(targetPath));
    return {
      id: `${paperTask.paperId}:preimage:${index + 1}`,
      targetPath: normalizeText(targetPath),
      exists: Boolean(record),
      preimageHash: record?.hash || null,
      sizeBytes: Number.isFinite(Number(record?.sizeBytes)) ? Number(record.sizeBytes) : null,
      snapshotStatus: record ? 'preimage_hash_recorded' : 'target_missing_before_execute',
    };
  });
  const missing = entries.filter((entry) => !entry.exists);
  const ledger = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionPreimageSnapshotLedger',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: missing.length ? 'preimage_snapshot_incomplete' : (entries.length ? 'preimage_snapshot_ready' : 'no_preimage_targets'),
    patchExecutionPreflightHash: patchExecutionPreflight.refereeRevisionPatchExecutionPreflightHash,
    targetCount: entries.length,
    missingTargetCount: missing.length,
    entries,
    blockers: uniqueStrings(missing.map((entry) => `target_missing:${entry.targetPath}`), 32),
    safety: {
      readsOnly: true,
      writesSource: false,
      appliesPatch: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...ledger,
    refereeRevisionPreimageSnapshotLedgerHash: hashPaperRecord('RefereeRevisionPreimageSnapshotLedger', ledger),
  };
}

export function buildRefereeRevisionExecutePlan({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight,
  preimageSnapshotLedger,
  mode = 'execute-plan',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchPlan?.kind || !patchExecutionPreflight?.kind || !preimageSnapshotLedger?.kind) {
    throw new Error('RefereeRevisionExecutePlan requires paperTask, patchPlan, preflight, and preimage snapshot ledger');
  }
  const blockers = [];
  if (patchExecutionPreflight.status !== 'dry_run_patch_execution_preflight_ready') blockers.push('patch_execution_preflight_not_ready');
  if (preimageSnapshotLedger.status !== 'preimage_snapshot_ready') blockers.push('preimage_snapshot_not_ready');
  if (!patchPlan.planItemCount) blockers.push('patch_plan_empty');
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionExecutePlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizeText(mode) || 'execute-plan',
    status: blockers.length ? 'execute_plan_blocked' : 'execute_plan_ready_requires_explicit_apply_mode',
    issueQueueHash: issueQueue?.refereeRevisionIssueQueueHash || null,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    patchExecutionPreflightHash: patchExecutionPreflight.refereeRevisionPatchExecutionPreflightHash,
    preimageSnapshotLedgerHash: preimageSnapshotLedger.refereeRevisionPreimageSnapshotLedgerHash,
    requiredExecutionOrder: [
      'write_preimage_snapshot_ledger',
      'apply_single_paper_patch',
      'run_latex_build',
      'run_package_adapter',
      'run_research_verify_adapter',
      'write_postimage_snapshot',
      'reconcile_rollback_ledger',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      planOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresExplicitApplyMode: true,
    },
    createdAt: createdAt || null,
  };
  return { ...plan, refereeRevisionExecutePlanHash: hashPaperRecord('RefereeRevisionExecutePlan', plan) };
}

export function buildRefereeRevisionApplyModeContract({
  paperTask,
  executePlan,
  approved = false,
  approver = '',
  approvalActor = 'agent',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !executePlan?.kind) {
    throw new Error('RefereeRevisionApplyModeContract requires paperTask and executePlan');
  }
  const blockers = [];
  const normalizedActor = normalizeText(approvalActor) || 'agent';
  const normalizedApprover = normalizeText(approver);
  if (!approved) blockers.push('agent_referee_apply_approval_required');
  if (approved && normalizedActor !== 'agent') blockers.push('agent_referee_apply_approval_required');
  if (approved && !normalizedApprover) blockers.push('agent_id_required');
  if (executePlan.status !== 'execute_plan_ready_requires_explicit_apply_mode') blockers.push('execute_plan_not_ready');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionApplyModeContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'apply_mode_blocked' : 'apply_mode_ready',
    approved: Boolean(approved) && blockers.length === 0,
    approvalActor: normalizedActor,
    approver: normalizedApprover || null,
    executePlanHash: executePlan.refereeRevisionExecutePlanHash,
    requiredPreconditions: [
      'agent_referee_apply_approval',
      'clean_or_isolated_worktree',
      'preimage_snapshot_ledger_ready',
      'single_paper_patch_scope',
      'rollback_restore_command_available',
    ],
    requiredPostconditions: [
      'postimage_snapshot_written',
      'latex_build_rechecked',
      'package_record_rewritten',
      'research_verify_rechecked',
      'rollback_ledger_reconciled',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      contractOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresSeparateApplyInvocation: true,
      agentApprovalOnly: true,
    },
    createdAt: createdAt || null,
  };
  return {
    ...contract,
    refereeRevisionApplyModeContractHash: hashPaperRecord('RefereeRevisionApplyModeContract', contract),
  };
}

export function buildRefereeRevisionDryRunReceipt({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  rollbackLedgerDraft = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchPlan?.kind) throw new Error('RefereeRevisionDryRunReceipt requires paperTask and patchPlan');
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionDryRunReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: 'dry_run_recorded',
    issueQueueHash: issueQueue?.refereeRevisionIssueQueueHash || null,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
    rollbackLedgerDraftHash: rollbackLedgerDraft?.refereeRevisionRollbackLedgerDraftHash || null,
    preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
    executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
    applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
    sourceMutationPerformed: false,
    rollbackLedgerWritten: false,
    executeBlockedUntilExplicitMode: true,
    createdAt: createdAt || null,
  };
  return { ...receipt, refereeRevisionDryRunReceiptHash: hashPaperRecord('RefereeRevisionDryRunReceipt', receipt) };
}

export function buildRefereeRevisionExecuteDesignPacket({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  dryRunReceipt = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeRevisionExecuteDesignPacket requires paperTask, issueQueue, and patchPlan');
  }
  const blockers = [];
  if (issueQueue.openIssueCount && patchExecutionPreflight?.status !== 'dry_run_patch_execution_preflight_ready') {
    blockers.push('patch_execution_preflight_not_ready');
  }
  if (issueQueue.openIssueCount && preimageSnapshotLedger?.status !== 'preimage_snapshot_ready') {
    blockers.push('preimage_snapshot_not_ready');
  }
  if (issueQueue.openIssueCount && executePlan?.status !== 'execute_plan_ready_requires_explicit_apply_mode') {
    blockers.push('execute_plan_not_ready');
  }
  const applyReady = applyModeContract?.status === 'apply_mode_ready';
  const applyBlocked = !applyReady && (
    (applyModeContract?.blockers || []).includes('agent_referee_apply_approval_required')
  );
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionExecuteDesignPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !issueQueue.openIssueCount
      ? 'no_referee_execute_needed'
      : (blockers.length
        ? 'referee_execute_design_blocked'
        : (applyReady ? 'referee_execute_design_ready_for_apply_execution' : 'referee_execute_design_ready_apply_blocked')),
    issueCount: issueQueue.issueCount,
    openIssueCount: issueQueue.openIssueCount,
    targetPathCount: patchExecutionPreflight?.targetPathCount || 0,
    chain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
      executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
      applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
      dryRunReceiptHash: dryRunReceipt?.refereeRevisionDryRunReceiptHash || null,
    },
    requiredAuthorization: [
      'agent_referee_apply_approval',
      'clean_or_isolated_worktree',
      'single_paper_patch_scope',
      'preimage_snapshot_ledger_ready',
      'rollback_restore_command_available',
    ],
    executionOrder: executePlan?.requiredExecutionOrder || [
      'write_preimage_snapshot_ledger',
      'apply_single_paper_patch',
      'run_latex_build',
      'run_package_adapter',
      'run_research_verify_adapter',
      'write_postimage_snapshot',
      'reconcile_rollback_ledger',
    ],
    reentryGates: [
      'latex_build_recheck',
      'package_record_rewrite',
      'research_verify_recheck',
      'local_dry_run_recheck',
      'referee_issue_queue_reconcile',
    ],
    blockedActionsUntilApplyMode: [
      'apply_patch_to_source',
      'merge_or_commit_source_changes',
      'mark_referee_issues_resolved',
      'advance_submission_readiness_from_unverified_patch',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(applyBlocked ? ['apply_mode_waiting_for_agent_approval'] : [], 32),
    safety: {
      designOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresSeparateApplyInvocation: true,
    },
    createdAt: createdAt || null,
  };
  return {
    ...packet,
    refereeRevisionExecuteDesignPacketHash: hashPaperRecord('RefereeRevisionExecuteDesignPacket', packet),
  };
}
