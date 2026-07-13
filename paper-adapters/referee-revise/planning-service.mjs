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
import { buildRefereeApplyApprovalPacket } from '../../paper-domain/contracts/referee-application.mjs';
import { buildAgentRepairPatchBundle } from './repair-executor.mjs';
import { targetPreimageRecords } from './reconciliation.mjs';

export async function buildRefereeRevisionPlanningContext({
  root,
  runtimeRoot,
  row,
  mode,
  execute,
  requests,
  patches,
} = {}) {
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
  return {
    agentRepairPatchBundle,
    agentPatchBundleSelected,
    effectivePatchQueue,
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
  };
}
