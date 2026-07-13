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
import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import {
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
  escapeSqlText,
  normalizePatch,
  normalizeRequest,
  sqliteJson,
} from '../referee-store.mjs';

import { validateAndMaybeApplyPatches } from './repair-executor.mjs';
import { runPostRepairRechecks } from './post-repair.mjs';
import { buildIssueResolutionEvidence, buildRepairReconciliationInputs, runRepairStateMutationExecutor } from './reconciliation.mjs';
import { buildRefereeRevisionPlanningContext } from './planning-service.mjs';

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
  const {
    agentRepairPatchBundle,
    agentPatchBundleSelected,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    rollbackLedgerDraft,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    dryRunReceipt,
    executeDesignPacket,
    applyApprovalPacket,
  } = await buildRefereeRevisionPlanningContext({
    root, runtimeRoot, row, mode, execute, requests, patches,
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
