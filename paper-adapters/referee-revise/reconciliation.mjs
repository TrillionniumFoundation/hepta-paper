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
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
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
} from '../../paper-domain/contracts/referee-planning.mjs';
import {
  buildRefereeApplyApprovalPacket,
  buildRefereePatchApplyExecution,
  buildRefereePatchApplyInvocation,
  buildRefereeAppliedPatchReceipt,
} from '../../paper-domain/contracts/referee-application.mjs';
import {
  buildPostRepairBuildPackage,
  buildRefereeIssueResolutionProof,
  buildRepairReconciliation,
  buildRepairStateMutationReceipt,
} from '../../paper-domain/contracts/referee-closure.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
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
import { withRecordHash, repairMainTexRow, runPostRepairRechecks } from './post-repair.mjs';

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


export { repairedArtifactRefs, buildIssueResolutionEvidence, buildRepairReconciliationInputs, mergeRefereeRepairMetadata, patchQueueMetadata, runRepairStateMutationExecutor, targetPreimageRecords };
