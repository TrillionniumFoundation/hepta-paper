import path from 'node:path';
export {
  evidenceResyncConsumingSelection,
  evidenceResyncDecisionPlan,
  postApplyFinalGateConsumingSelection,
  postApplyFinalGateDecisionPlan,
  readyMergeBoundaryConsumingSelection,
  readyMergeBoundaryDecisionPlan,
  refereeRevisionRequestConsumingSelection,
  refereeRevisionRequestDecisionPlan,
} from './decision-routing.mjs';
import {
  fileRecord,
  pathWithin,
  relativePath,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../paper-core/src/runtime/text-utils.mjs';
import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import {
  buildRefereeRevisionDryRunReceipt,
  buildRefereeRevisionIssueQueue,
  buildRefereeRevisionPatchPlan,
  buildRefereeRevisionPatchExecutionPreflight,
  buildRefereeRevisionPreimageSnapshotLedger,
  buildRefereeRevisionExecutePlan,
  buildRefereeRevisionApplyModeContract,
  buildRefereeRevisionExecuteDesignPacket,
  buildRefereeRevisionRollbackLedgerDraft,
} from '../../paper-core/src/contracts/referee-planning.mjs';
import {
  buildRefereeApplyApprovalPacket,
  buildRefereePatchApplyExecution,
  buildRefereePatchApplyInvocation,
  buildRefereeAppliedPatchReceipt,
} from '../../paper-core/src/contracts/referee-application.mjs';
import {
  buildPostRepairBuildPackage,
  buildRefereeIssueResolutionProof,
  buildRepairReconciliation,
  buildRepairStateMutationReceipt,
} from '../../paper-core/src/contracts/referee-closure.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import { heptaStorePath } from '../../paper-core/src/hepta-store.mjs';
import {
  runLatexBuildAdapter,
  runPackageAdapter,
} from '../build-package/index.mjs';
import { runResearchVerifyAdapter } from '../research-verify/index.mjs';
import {
  escapeSqlText,
  normalizePatch,
  normalizeRequest,
  sqliteExec,
  sqliteJson,
  sqlJson,
  sqlText,
} from '../referee-store.mjs';

import {
  buildAgentRepairPatchBundle,
  issueIsOpen,
  stderrLines,
  validateAndMaybeApplyPatches,
} from './repair-executor.mjs';
function withRecordHash(kind, record, fieldName) {
  const value = { ...record };
  value[fieldName] = hashPaperRecord(kind, value);
  return value;
}

function repairMainTexRow(row, agentRepairPatchBundle) {
  const targetPath = normalizeText(agentRepairPatchBundle?.targetPath || '');
  if (!targetPath || !targetPath.endsWith('.tex')) return row;
  return {
    ...row,
    task: {
      ...row.task,
      mainTex: targetPath,
    },
  };
}

async function runPostRepairRechecks({
  root,
  runtimeRoot,
  row,
  store,
  agentRepairPatchBundle = null,
  appliedPatchReceipt = null,
  execute = false,
} = {}) {
  const blockers = [];
  const warnings = [];
  if (!execute) blockers.push('post_repair_recheck_execute_required');
  if (appliedPatchReceipt?.status !== 'applied_patch_receipt_recorded') {
    blockers.push('applied_patch_receipt_not_recorded');
  }
  if (!runtimeRoot) blockers.push('runtime_root_required_for_post_repair_rechecks');
  if (blockers.length) {
    return {
      kind: 'PostRepairRecheckReport',
      paperId: row.task.paperId,
      status: 'post_repair_recheck_blocked',
      buildRecheck: null,
      packageRecheck: null,
      researchRecheck: null,
      blockers: uniqueStrings(blockers, 32),
      warnings,
    };
  }

  const recheckRow = repairMainTexRow(row, agentRepairPatchBundle);
  const buildResult = await runLatexBuildAdapter({
    root,
    row: recheckRow,
    runtimeRoot,
    execute: true,
  });
  const buildBlockers = [
    ...(buildResult.blockers || []),
    ...((buildResult.status === 'build_passed') ? [] : ['latex_build_recheck_not_passed']),
    ...(buildResult.buildArtifactAcceptance?.accepted ? [] : ['build_artifact_acceptance_missing']),
  ];
  const buildRecheck = withRecordHash('PostRepairBuildRecheck', {
    kind: 'PostRepairBuildRecheck',
    paperId: row.task.paperId,
    status: buildBlockers.length ? 'build_recheck_blocked' : 'build_recheck_passed',
    mainTex: recheckRow.task.mainTex,
    buildResultStatus: buildResult.status,
    builtPdf: buildResult.builtPdf || null,
    buildArtifactAcceptanceHash: buildResult.buildArtifactAcceptance?.paperBuildArtifactAcceptanceHash || null,
    blockers: uniqueStrings(buildBlockers, 32),
    warnings: uniqueStrings(buildResult.warnings || [], 32),
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
    },
  }, 'buildRecheckHash');

  let packageResult = null;
  let packageRecheck = null;
  if (buildRecheck.status === 'build_recheck_passed') {
    packageResult = await runPackageAdapter({
      root,
      row: recheckRow,
      buildResult,
      runtimeRoot,
      execute: true,
      store,
    });
    const packageBlockers = [
      ...(packageResult.blockers || []),
      ...((packageResult.status === 'package_ready') ? [] : ['package_rewrite_not_ready']),
      ...(packageResult.artifactPackage?.submitReady ? [] : ['artifact_package_not_submit_ready_after_repair']),
    ];
    packageRecheck = withRecordHash('PostRepairPackageRecheck', {
      kind: 'PostRepairPackageRecheck',
      paperId: row.task.paperId,
      status: packageBlockers.length ? 'package_rewrite_blocked' : 'package_rewrite_ready',
      packageDir: packageResult.packageDir || null,
      sourceZip: packageResult.sourceZip || null,
      packageRecord: packageResult.packageRecord || null,
      sha256Sums: packageResult.sha256Sums || null,
      artifactPackageHash: packageResult.artifactPackage?.artifactPackageHash || null,
      blockers: uniqueStrings(packageBlockers, 32),
      warnings: uniqueStrings(packageResult.warnings || [], 32),
      safety: {
        sourceMutation: false,
        writesPackage: packageBlockers.length === 0,
        outputUnderRuntime: true,
        externalActionPerformed: false,
      },
    }, 'packageRecheckHash');
  } else {
    packageRecheck = withRecordHash('PostRepairPackageRecheck', {
      kind: 'PostRepairPackageRecheck',
      paperId: row.task.paperId,
      status: 'package_rewrite_blocked',
      packageDir: null,
      blockers: ['build_recheck_not_passed'],
      warnings: [],
      safety: {
        sourceMutation: false,
        writesPackage: false,
        outputUnderRuntime: true,
        externalActionPerformed: false,
      },
    }, 'packageRecheckHash');
  }

  const researchReport = await runResearchVerifyAdapter({ root, row: recheckRow, runtimeRoot });
  const researchBlockers = [
    ...(researchReport.blockers || []),
    ...((researchReport.status === 'blocked') ? ['research_verify_recheck_blocked'] : []),
  ];
  const researchRecheck = withRecordHash('PostRepairResearchRecheck', {
    kind: 'PostRepairResearchRecheck',
    paperId: row.task.paperId,
    status: researchBlockers.length ? 'research_recheck_blocked' : 'research_recheck_passed',
    researchReportHash: researchReport.researchReportHash || null,
    researchStatus: researchReport.status,
    claimCount: researchReport.claimCount,
    proofObligationCount: researchReport.proofObligationCount,
    evidenceItemCount: researchReport.evidenceItemCount,
    reproducibilityItemCount: researchReport.reproducibilityItemCount,
    blockers: uniqueStrings(researchBlockers, 32),
    warnings: uniqueStrings(researchReport.warnings || [], 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  }, 'researchRecheckHash');

  const report = withRecordHash('PostRepairRecheckReport', {
    kind: 'PostRepairRecheckReport',
    paperId: row.task.paperId,
    status: [
      buildRecheck.status,
      packageRecheck.status,
      researchRecheck.status,
    ].every((status) => ['build_recheck_passed', 'package_rewrite_ready', 'research_recheck_passed'].includes(status))
      ? 'post_repair_rechecks_passed'
      : 'post_repair_rechecks_blocked',
    mainTex: recheckRow.task.mainTex,
    buildRecheck,
    packageRecheck,
    researchRecheck,
    blockers: uniqueStrings([
      ...(buildRecheck.blockers || []),
      ...(packageRecheck.blockers || []),
      ...(researchRecheck.blockers || []),
    ], 64),
    warnings: uniqueStrings([
      ...warnings,
      ...(buildRecheck.warnings || []),
      ...(packageRecheck.warnings || []),
      ...(researchRecheck.warnings || []),
    ], 64),
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
      writesPackage: packageRecheck.status === 'package_rewrite_ready',
    },
  }, 'postRepairRecheckReportHash');
  const recheckPath = path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'POST_REPAIR_RECHECKS.json');
  await writeJsonFile(recheckPath, report);
  return report;
}

function repairedArtifactRefs(postRepairRechecks = {}) {
  return [
    postRepairRechecks.buildRecheck?.builtPdf ? {
      role: 'post_repair_built_pdf',
      ref: postRepairRechecks.buildRecheck.builtPdf.path,
      hash: postRepairRechecks.buildRecheck.builtPdf.hash,
    } : null,
    postRepairRechecks.packageRecheck?.sourceZip ? {
      role: 'post_repair_source_zip',
      ref: postRepairRechecks.packageRecheck.sourceZip.path,
      hash: postRepairRechecks.packageRecheck.sourceZip.hash,
    } : null,
    postRepairRechecks.packageRecheck?.packageRecord ? {
      role: 'post_repair_package_record',
      ref: postRepairRechecks.packageRecheck.packageRecord.path,
      hash: postRepairRechecks.packageRecheck.packageRecord.hash,
    } : null,
    postRepairRechecks.packageRecheck?.sha256Sums ? {
      role: 'post_repair_sha256sums',
      ref: postRepairRechecks.packageRecheck.sha256Sums.path,
      hash: postRepairRechecks.packageRecheck.sha256Sums.hash,
    } : null,
  ].filter(Boolean);
}

function buildIssueResolutionEvidence({
  issueQueue,
  appliedPatchReceipt = null,
  postRepairRechecks = null,
  postRepairBuildPackage = null,
} = {}) {
  if (postRepairBuildPackage?.status !== 'post_repair_build_package_ready') return [];
  const patchInput = (appliedPatchReceipt?.plannedPatchInputs || [])[0] || {};
  const artifacts = repairedArtifactRefs(postRepairRechecks);
  return (issueQueue?.issues || [])
    .filter(issueIsOpen)
    .map((issue) => ({
      id: `${issue.id}:agent-resolution-proof`,
      issueId: issue.id,
      kind: 'agent_post_repair_issue_resolution_mapping',
      ref: postRepairRechecks?.mainTex || artifacts[0]?.ref || null,
      hash: postRepairRechecks?.postRepairRecheckReportHash || postRepairBuildPackage?.postRepairBuildPackageHash || null,
      patchId: patchInput.patchId || null,
      patchPath: patchInput.patchPath || null,
      patchHash: patchInput.patchSha256 || null,
      repairedArtifactRefs: artifacts,
      buildRecheckHash: postRepairRechecks?.buildRecheck?.buildRecheckHash || null,
      packageRecheckHash: postRepairRechecks?.packageRecheck?.packageRecheckHash || null,
      researchRecheckHash: postRepairRechecks?.researchRecheck?.researchRecheckHash || null,
      agentAcceptance: 'agent_accepts_evidence_bounded_repair_mapping',
    }));
}

function buildRepairReconciliationInputs({
  row,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairRechecks = null,
  postRepairBuildPackage = null,
  issueResolutionProof = null,
  repairStateMutationReceipt = null,
} = {}) {
  if (issueResolutionProof?.status !== 'referee_issue_resolution_proof_ready') return {};
  const issueIds = issueResolutionProof.resolvedIssueIds || [];
  const patchInputs = appliedPatchReceipt?.plannedPatchInputs || [];
  const artifacts = repairedArtifactRefs(postRepairRechecks);
  const stateMutationRecorded = repairStateMutationReceipt?.status === 'repair_state_mutation_recorded';
  const rollbackReconciliation = withRecordHash('RepairRollbackReconciliation', {
    kind: 'RepairRollbackReconciliation',
    paperId: row.task.paperId,
    status: 'rollback_ledger_reconciled',
    issueIds,
    acceptedPreimages: appliedPatchReceipt?.acceptedPreimages || [],
    postimageRecords: appliedPatchReceipt?.postimageRecords || [],
    appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
    postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
    safety: {
      restoresNotPerformed: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  }, 'rollbackReconciliationHash');
  const issueQueueUpdateReceipt = withRecordHash('RepairIssueQueueUpdateReceipt', {
    kind: 'RepairIssueQueueUpdateReceipt',
    paperId: row.task.paperId,
    status: 'issue_queue_update_receipt_ready',
    issueIds,
    plannedStatus: 'resolved',
    issueStateMutationPerformed: stateMutationRecorded,
    sqliteWritePerformed: stateMutationRecorded,
    reason: stateMutationRecorded
      ? 'agent state mutation executor resolved mapped referee issues in sqlite'
      : 'runtime proof ready; sqlite mutation deferred to explicit state-update executor',
    issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
    repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    issueRowsUpdated: repairStateMutationReceipt?.issueRowsUpdated || 0,
    safety: {
      receiptOnly: !stateMutationRecorded,
      writesSqlite: stateMutationRecorded,
      externalActionPerformed: false,
    },
  }, 'issueQueueUpdateReceiptHash');
  const patchQueueUpdateReceipt = withRecordHash('RepairPatchQueueUpdateReceipt', {
    kind: 'RepairPatchQueueUpdateReceipt',
    paperId: row.task.paperId,
    status: 'patch_queue_update_receipt_ready',
    patchInputs,
    plannedStatus: 'agent_patch_applied_and_receipted',
    legacyPatchQueueMutationPerformed: false,
    agentPatchQueueRowsRecorded: stateMutationRecorded,
    reason: stateMutationRecorded
      ? 'agent runtime patch bundle recorded as applied patch_queue row without rewriting stale legacy patch rows'
      : 'agent runtime patch bundle supersedes stale legacy patch_queue entries without mutating them',
    appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
    repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    patchRowsInserted: repairStateMutationReceipt?.patchRowsInserted || 0,
    patchRowsUpdated: repairStateMutationReceipt?.patchRowsUpdated || 0,
    patchRowsAlreadyPresent: repairStateMutationReceipt?.patchRowsAlreadyPresent || 0,
    safety: {
      receiptOnly: !stateMutationRecorded,
      writesSqlite: stateMutationRecorded,
      externalActionPerformed: false,
    },
  }, 'patchQueueUpdateReceiptHash');
  const submissionReadinessReentryGate = withRecordHash('SubmissionReadinessReentryGate', {
    kind: 'SubmissionReadinessReentryGate',
    paperId: row.task.paperId,
    status: 'submission_readiness_reentry_ready',
    submissionReadinessAdvanced: stateMutationRecorded,
    reason: stateMutationRecorded
      ? 'mapped referee issue blockers resolved; paper may re-enter reviewed-submit dry-run readiness path'
      : 'repair loop reconciled locally; reviewed-submit lifecycle remains a separate dry-run/reviewed-submit path',
    repairedArtifactRefs: artifacts,
    postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
    repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    safety: {
      gateOnly: true,
      advancesSubmissionReadiness: stateMutationRecorded,
      externalActionPerformed: false,
    },
  }, 'submissionReadinessReentryGateHash');
  const repairAuditArchiveRecord = withRecordHash('RepairAuditArchiveRecord', {
    kind: 'RepairAuditArchiveRecord',
    paperId: row.task.paperId,
    status: 'repair_audit_archive_record_ready',
    refs: [
      { role: 'applied_patch_receipt', hash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null },
      { role: 'post_repair_recheck_report', hash: postRepairRechecks?.postRepairRecheckReportHash || null },
      { role: 'post_repair_build_package', hash: postRepairBuildPackage?.postRepairBuildPackageHash || null },
      { role: 'issue_resolution_proof', hash: issueResolutionProof?.refereeIssueResolutionProofHash || null },
      ...artifacts,
    ].filter((ref) => ref.hash || ref.ref),
    safety: {
      archiveRecordOnly: true,
      externalActionPerformed: false,
    },
  }, 'repairAuditArchiveRecordHash');
  return {
    rollbackReconciliation,
    issueQueueUpdateReceipt,
    patchQueueUpdateReceipt,
    submissionReadinessReentryGate,
    repairAuditArchiveRecord,
  };
}

function mergeRefereeRepairMetadata(current, patchInput, context) {
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const history = Array.isArray(existing.state_transition_history)
    ? existing.state_transition_history.slice(-24)
    : [];
  return {
    ...existing,
    hepta_referee_repair: {
      source: 'hepta_referee_agent_repair',
      status: 'resolved',
      resolvedBy: 'openclaw-agent',
      resolvedAt: context.resolvedAt,
      agentPatchId: patchInput?.patchId || null,
      agentPatchPath: patchInput?.patchPath || null,
      agentPatchSha256: patchInput?.patchSha256 || null,
      issueResolutionProofHash: context.issueResolutionProofHash || null,
      repairReconciliationHash: context.repairReconciliationHash || null,
      appliedPatchReceiptHash: context.appliedPatchReceiptHash || null,
      postRepairBuildPackageHash: context.postRepairBuildPackageHash || null,
    },
    state_transition_history: [
      ...history,
      {
        at: context.resolvedAt,
        from: context.previousStatus,
        to: 'resolved',
        dry_run: false,
        assignee: 'openclaw-agent',
        reason: 'resolved_by_agent_repair_reconciliation',
        worker_patch_id: null,
        verification_log_path: context.issueResolutionProofPath || '',
        source: 'hepta_referee_repair_state_mutation_executor',
        issue_resolution_proof_hash: context.issueResolutionProofHash || null,
        repair_reconciliation_hash: context.repairReconciliationHash || null,
      },
    ],
  };
}

function patchQueueMetadata(patchInput, context) {
  return {
    source: 'hepta_referee_agent_repair',
    status: 'agent_patch_applied_and_receipted',
    agentPatchId: patchInput?.patchId || null,
    resolvedIssueIds: context.resolvedIssueIds || [],
    appliedAt: context.resolvedAt,
    appliedPatchReceiptHash: context.appliedPatchReceiptHash || null,
    issueResolutionProofHash: context.issueResolutionProofHash || null,
    postRepairBuildPackageHash: context.postRepairBuildPackageHash || null,
    repairReconciliationHash: context.repairReconciliationHash || null,
  };
}

async function runRepairStateMutationExecutor({
  dbPath,
  store = null,
  runtimeRoot,
  row,
  requests,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairBuildPackage = null,
  issueResolutionProof = null,
  repairReconciliation = null,
  execute = false,
} = {}) {
  const resolvedIssueIds = new Set(issueResolutionProof?.resolvedIssueIds || []);
  const openIssues = (issueQueue?.issues || []).filter(issueIsOpen);
  const patchInputs = appliedPatchReceipt?.plannedPatchInputs || [];
  const blockers = [];
  const warnings = [];
  const errors = [];
  if (execute && repairReconciliation?.status === 'repair_reconciliation_ready' && !patchInputs.length) {
    blockers.push('agent_patch_input_missing');
  }
  const openRequestRows = (requests || [])
    .filter((request) => resolvedIssueIds.has(normalizeText(request.request_key || request.requestKey || request.id || '')))
    .filter((request) => !CLOSED_REFEREE_STATUSES.has(normalizeText(request.status || '').toLowerCase()));
  const missingIssueRows = [...resolvedIssueIds].filter((issueId) => !openRequestRows.some((request) => (
    normalizeText(request.request_key || request.requestKey || request.id || '') === issueId
  )));
  if (execute && repairReconciliation?.status === 'repair_reconciliation_ready' && missingIssueRows.length) {
    blockers.push('resolved_issue_rows_missing');
    warnings.push(...missingIssueRows.slice(0, 8).map((issueId) => `missing_issue_row:${issueId}`));
  }

  let issueRowsUpdated = 0;
  let issueRowsAlreadyResolved = 0;
  let patchRowsInserted = 0;
  let patchRowsUpdated = 0;
  let patchRowsAlreadyPresent = 0;
  let issueRows = [];
  let patchRows = [];
  let sqliteWritePerformed = false;
  const resolvedAt = new Date().toISOString();

  if (execute && !blockers.length && openIssues.length && repairReconciliation?.status === 'repair_reconciliation_ready') {
    const statements = ['begin immediate;'];
    const contextBase = {
      resolvedAt,
      resolvedIssueIds: [...resolvedIssueIds],
      issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
      repairReconciliationHash: repairReconciliation?.repairReconciliationHash || null,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
      issueResolutionProofPath: runtimeRoot
        ? relativePath(row.root || path.dirname(dbPath), path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'ISSUE_RESOLUTION_PROOF.json'))
        : '',
    };
    const patchInput = patchInputs[0] || null;
    for (const request of openRequestRows) {
      const previousStatus = normalizeText(request.status || '');
      const metadata = mergeRefereeRepairMetadata(request.metadata, patchInput, {
        ...contextBase,
        previousStatus,
      });
      statements.push([
        'update referee_revision_requests',
        'set status=\'resolved\',',
        'state_reason=\'resolved_by_agent_repair_reconciliation\',',
        'assignee=\'openclaw-agent\',',
        `metadata_json=${sqlJson(metadata)},`,
        'updated_at=datetime(\'now\'),',
        'last_transition_at=datetime(\'now\')',
        `where slug=${sqlText(row.task.paperId)}`,
        `and request_key=${sqlText(request.request_key || request.requestKey || request.id)}`,
        'and status not in (\'closed\',\'resolved\',\'applied\',\'no_patch_needed\');',
      ].join(' '));
      issueRows.push({
        requestId: request.request_id || request.requestId || null,
        requestKey: request.request_key || request.requestKey || request.id,
        previousStatus,
        nextStatus: 'resolved',
        stateReason: 'resolved_by_agent_repair_reconciliation',
      });
    }
    issueRowsUpdated = openRequestRows.length;

    for (const patchInputItem of patchInputs) {
      const patchPath = normalizeText(patchInputItem.patchPath || '');
      const patchSha256 = normalizeText(patchInputItem.patchSha256 || '');
      if (!patchPath || !patchSha256) {
        warnings.push('agent_patch_queue_record_missing_path_or_hash');
        continue;
      }
      const existing = sqliteJson(
        store,
        [
          'select patch_id,status,metadata_json from patch_queue',
          `where slug=${sqlText(row.task.paperId)}`,
          `and patch_path=${sqlText(patchPath)}`,
          `and patch_sha256=${sqlText(patchSha256)}`,
          'limit 1;',
        ].join(' '),
      )[0] || null;
      const metadata = patchQueueMetadata(patchInputItem, contextBase);
      const targetPathsJson = JSON.stringify(patchInputItem.targetPaths || []);
      const batchId = normalizeText(patchInputItem.batchId || `${row.task.paperId}:agent-repair-patch-bundle`);
      if (existing) {
        if (normalizeText(existing.status).toLowerCase() === 'applied') {
          patchRowsAlreadyPresent += 1;
        } else {
          patchRowsUpdated += 1;
        }
        statements.push([
          'update patch_queue',
          'set status=\'applied\',',
          `target_paths_json=${sqlText(targetPathsJson)},`,
          `batch_id=${sqlText(batchId)},`,
          `metadata_json=${sqlJson(metadata)},`,
          'updated_at=datetime(\'now\')',
          `where patch_id=${Number(existing.patch_id)};`,
        ].join(' '));
        patchRows.push({
          patchId: existing.patch_id,
          status: 'applied',
          action: normalizeText(existing.status).toLowerCase() === 'applied' ? 'already_present' : 'updated',
          patchPath,
          patchSha256,
        });
      } else {
        patchRowsInserted += 1;
        statements.push([
          'insert into patch_queue',
          '(slug,status,patch_path,patch_sha256,target_paths_json,batch_id,metadata_json)',
          'values',
          `(${sqlText(row.task.paperId)},'applied',${sqlText(patchPath)},${sqlText(patchSha256)},${sqlText(targetPathsJson)},${sqlText(batchId)},${sqlJson(metadata)});`,
        ].join(' '));
        patchRows.push({
          patchId: null,
          status: 'applied',
          action: 'inserted',
          patchPath,
          patchSha256,
        });
      }
    }
    statements.push('commit;');
    const execResult = sqliteExec(store, statements.join('\n'));
    if (!execResult.ok) {
      errors.push(...stderrLines(execResult.stderr, 8));
      sqliteWritePerformed = false;
    } else {
      sqliteWritePerformed = true;
      const refreshedPatchRows = [];
      for (const patchRow of patchRows) {
        const refreshed = sqliteJson(
          store,
          [
            'select patch_id,status,patch_path,patch_sha256 from patch_queue',
            `where slug=${sqlText(row.task.paperId)}`,
            `and patch_path=${sqlText(patchRow.patchPath)}`,
            `and patch_sha256=${sqlText(patchRow.patchSha256)}`,
            'limit 1;',
          ].join(' '),
        )[0] || null;
        refreshedPatchRows.push(refreshed ? { ...patchRow, patchId: refreshed.patch_id, status: refreshed.status } : patchRow);
      }
      patchRows = refreshedPatchRows;
    }
  }

  if (execute && sqliteWritePerformed) {
    const remaining = sqliteJson(
      store,
      [
        'select count(*) as n from referee_revision_requests',
        `where slug=${sqlText(row.task.paperId)}`,
        'and status not in (\'closed\',\'resolved\',\'applied\',\'no_patch_needed\');',
      ].join(' '),
    )[0];
    if (Number(remaining?.n || 0) > 0) warnings.push(`remaining_open_issues:${Number(remaining.n)}`);
  }

  return buildRepairStateMutationReceipt({
    paperTask: row.task,
    issueQueue,
    appliedPatchReceipt,
    issueResolutionProof,
    repairReconciliation,
    execute,
    sqliteWritePerformed,
    issueRowsUpdated,
    issueRowsAlreadyResolved,
    patchRowsInserted,
    patchRowsUpdated,
    patchRowsAlreadyPresent,
    issueRows,
    patchRows,
    errors,
    blockers,
    warnings,
  });
}

async function targetPreimageRecords(root, targetPaths = []) {
  const records = [];
  const seen = new Set();
  for (const targetPath of targetPaths || []) {
    const normalized = normalizeText(targetPath);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const candidate = path.isAbsolute(normalized) ? normalized : path.join(root, normalized);
    if (!pathWithin(root, candidate)) continue;
    const record = await fileRecord(root, candidate, 'referee_revision_preimage');
    if (record) records.push(record);
  }
  return records;
}

export async function runRefereeReviseAdapter({
  root,
  runtimeRoot = null,
  row,
  mode = 'dry-run',
  execute = false,
  limit = 64,
  store = null,
} = {}) {
  if (!store) throw new Error('Referee revision requires StorePort injection');
  const dbPath = heptaStorePath(root, runtimeRoot);
  const slug = escapeSqlText(row.task.paperId);
  const requests = sqliteJson(
    store,
    `select * from referee_revision_requests where slug='${slug}' order by status!='requested', cluster_rank desc, matrix_rank asc, request_id asc limit ${Number(limit) || 64};`,
  ).map(normalizeRequest);
  const patches = sqliteJson(
    store,
    `select * from patch_queue where slug='${slug}' order by updated_at desc, patch_id desc limit ${Number(limit) || 64};`,
  ).map(normalizePatch);
  const baseIssueQueue = buildRefereeRevisionIssueQueue({
    paperTask: row.task,
    requests,
    patchQueue: patches,
  });
  const agentRepairPatchBundle = execute && Number(baseIssueQueue.openIssueCount || 0) > 0
    ? await buildAgentRepairPatchBundle({
      root,
      runtimeRoot,
      row,
      issueQueue: baseIssueQueue,
    })
    : null;
  const agentPatchBundleSelected = [
    'agent_repair_patch_bundle_ready',
    'agent_repair_patch_already_present',
  ].includes(agentRepairPatchBundle?.status);
  const effectivePatchQueue = agentPatchBundleSelected
    ? agentRepairPatchBundle.generatedPatchInputs
    : patches;
  const issueQueue = buildRefereeRevisionIssueQueue({
    paperTask: row.task,
    requests,
    patchQueue: effectivePatchQueue,
  });
  const patchPlan = buildRefereeRevisionPatchPlan({
    paperTask: row.task,
    issueQueue,
    mode,
  });
  const patchExecutionPreflight = buildRefereeRevisionPatchExecutionPreflight({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    sourceWorkspace: row.task.sourceWorkspace,
    mode,
  });
  const rollbackLedgerDraft = buildRefereeRevisionRollbackLedgerDraft({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    mode,
  });
  const targetRecords = await targetPreimageRecords(root, patchExecutionPreflight.targetPaths || []);
  const preimageSnapshotLedger = buildRefereeRevisionPreimageSnapshotLedger({
    paperTask: row.task,
    patchExecutionPreflight,
    targetRecords,
  });
  const executePlan = buildRefereeRevisionExecutePlan({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    preimageSnapshotLedger,
    mode: 'execute-plan',
  });
  const applyModeContract = buildRefereeRevisionApplyModeContract({
    paperTask: row.task,
    executePlan,
    approved: true,
    approver: 'openclaw-agent',
    approvalActor: 'agent',
  });
  const dryRunReceipt = buildRefereeRevisionDryRunReceipt({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    rollbackLedgerDraft,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
  });
  const executeDesignPacket = buildRefereeRevisionExecuteDesignPacket({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    dryRunReceipt,
  });
  const applyApprovalPacket = buildRefereeApplyApprovalPacket({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    rollbackLedgerDraft,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    executeDesignPacket,
    approved: true,
    approver: 'openclaw-agent',
    approvalActor: 'agent',
  });
  const patchApplyExecution = buildRefereePatchApplyExecution({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    executeDesignPacket,
    applyApprovalPacket,
    execute: Boolean(execute),
  });
  const patchApplyAttempt = execute
    ? await validateAndMaybeApplyPatches({
      root,
      row,
      patchApplyExecution,
      preimageSnapshotLedger,
      execute: Boolean(execute),
    })
    : null;
  const patchApplyInvocation = buildRefereePatchApplyInvocation({
    paperTask: row.task,
    issueQueue,
    patchApplyExecution,
    applyApprovalPacket,
    execute: Boolean(execute),
    executorId: 'openclaw-agent-local-patch-apply',
    validationRecords: patchApplyAttempt?.validationRecords || [],
    targetPreimageChecks: patchApplyAttempt?.targetPreimageChecks || [],
    appliedPatchHashes: patchApplyAttempt?.appliedPatchHashes || [],
    postimageRecords: patchApplyAttempt?.postimageRecords || [],
    sourceDiffHash: patchApplyAttempt?.sourceDiffHash || null,
    applied: Boolean(patchApplyAttempt?.applied),
    blockers: patchApplyAttempt?.blockers || [],
    warnings: patchApplyAttempt?.warnings || [],
  });
  if (execute && runtimeRoot && Number(issueQueue.openIssueCount || 0) > 0) {
    const invocationPath = path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'PATCH_APPLY_INVOCATION.json');
    await writeJsonFile(invocationPath, patchApplyInvocation);
  }
  const appliedPatchReceipt = buildRefereeAppliedPatchReceipt({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchApplyExecution,
    patchApplyInvocation,
    applyApprovalPacket,
    preimageSnapshotLedger,
    applied: patchApplyInvocation.status === 'referee_patch_apply_invocation_applied',
    executorId: patchApplyInvocation.executorId,
    postimageRecords: patchApplyInvocation.postimageRecords || [],
  });
  const postRepairRechecks = appliedPatchReceipt.status === 'applied_patch_receipt_recorded'
    ? await runPostRepairRechecks({
      root,
      runtimeRoot,
      row,
      store,
      agentRepairPatchBundle,
      appliedPatchReceipt,
      execute: Boolean(execute),
    })
    : null;
  const postRepairBuildPackage = buildPostRepairBuildPackage({
    paperTask: row.task,
    issueQueue,
    patchApplyExecution,
    patchApplyInvocation,
    appliedPatchReceipt,
    buildRecheck: postRepairRechecks?.buildRecheck || null,
    packageRecheck: postRepairRechecks?.packageRecheck || null,
    researchRecheck: postRepairRechecks?.researchRecheck || null,
  });
  const resolutionEvidence = buildIssueResolutionEvidence({
    issueQueue,
    appliedPatchReceipt,
    postRepairRechecks,
    postRepairBuildPackage,
  });
  const issueResolutionProof = buildRefereeIssueResolutionProof({
    paperTask: row.task,
    issueQueue,
    appliedPatchReceipt,
    postRepairBuildPackage,
    resolutionEvidence,
  });
  let repairReconciliationInputs = buildRepairReconciliationInputs({
    row,
    issueQueue,
    appliedPatchReceipt,
    postRepairRechecks,
    postRepairBuildPackage,
    issueResolutionProof,
  });
  let repairReconciliation = buildRepairReconciliation({
    paperTask: row.task,
    issueQueue,
    appliedPatchReceipt,
    postRepairBuildPackage,
    issueResolutionProof,
    ...repairReconciliationInputs,
  });
  const repairStateMutationReceipt = await runRepairStateMutationExecutor({
    dbPath,
    store,
    runtimeRoot,
    row,
    requests,
    issueQueue,
    appliedPatchReceipt,
    postRepairBuildPackage,
    issueResolutionProof,
    repairReconciliation,
    execute: Boolean(execute),
  });
  if (repairStateMutationReceipt.status === 'repair_state_mutation_recorded') {
    repairReconciliationInputs = buildRepairReconciliationInputs({
      row,
      issueQueue,
      appliedPatchReceipt,
      postRepairRechecks,
      postRepairBuildPackage,
      issueResolutionProof,
      repairStateMutationReceipt,
    });
    repairReconciliation = buildRepairReconciliation({
      paperTask: row.task,
      issueQueue,
      appliedPatchReceipt,
      postRepairBuildPackage,
      issueResolutionProof,
      repairStateMutationReceipt,
      ...repairReconciliationInputs,
    });
  }
  if (execute && runtimeRoot && Number(issueQueue.openIssueCount || 0) > 0) {
    const repairDir = path.join(runtimeRoot, 'referee-repair', row.task.paperId);
    await writeJsonFile(path.join(repairDir, 'ISSUE_RESOLUTION_PROOF.json'), issueResolutionProof);
    await writeJsonFile(path.join(repairDir, 'REPAIR_STATE_MUTATION_RECEIPT.json'), repairStateMutationReceipt);
    await writeJsonFile(path.join(repairDir, 'REPAIR_RECONCILIATION.json'), repairReconciliation);
  }
  const warnings = [];
  if (!requests.length && !patches.length) warnings.push('referee_revision_queue_empty');
  const blockers = [];
  if (mode !== 'dry-run') blockers.push('referee_revision_execute_requires_explicit_rollback_ledger');
  const report = {
    version: 1,
    kind: 'RefereeRevisionAdapterReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: blockers.length ? 'blocked' : (issueQueue.openIssueCount ? 'dry_run_patch_plan_ready' : 'referee_revision_queue_clear'),
    issueCount: issueQueue.issueCount,
    openIssueCount: issueQueue.openIssueCount,
    patchCount: issueQueue.patchCount,
    legacyPatchCount: patches.length,
    effectivePatchSource: agentPatchBundleSelected
      ? 'agent_repair_patch_bundle'
      : 'legacy_patch_queue',
    agentRepairPatchBundle,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    rollbackLedgerDraft,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    executeDesignPacket,
    applyApprovalPacket,
    patchApplyExecution,
    patchApplyInvocation,
    appliedPatchReceipt,
    postRepairRechecks,
    postRepairBuildPackage,
    issueResolutionProof,
    repairStateMutationReceipt,
    repairReconciliation,
    dryRunReceipt,
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    source: {
      sqlite: 'hepta-paper-workspace/runtime/hepta-paper.sqlite',
      tables: ['referee_revision_requests', 'patch_queue'],
      agentRepairPatchBundle: agentRepairPatchBundle?.manifestPath || null,
    },
    safety: {
      readsOnly: !patchApplyInvocation.safety?.sourceMutation,
      dryRunOnly: !execute,
      sourceMutation: Boolean(patchApplyInvocation.safety?.sourceMutation),
      externalActionPerformed: false,
      importsOldControlPlane: false,
    },
  };
  return {
    ...report,
    refereeRevisionAdapterReportHash: hashPaperRecord('RefereeRevisionAdapterReport', report),
  };
}
