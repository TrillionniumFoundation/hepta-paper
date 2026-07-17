import { assertLegacyWorkflowProjectionAuthorized } from '../../paper-domain/workflow/operational-authority-policy.mjs';

// Explicit compatibility path only. Production batch execution does not write
// workflow_states unless its caller requests this projection and carries the
// authority-lineage receipt proving that it is non-authoritative.
export function persistLegacyWorkflowStateProjection({
  lineage,
  workflowStateStore,
  paperId,
  mode,
  state,
  workflowReceiptHash = null,
} = {}) {
  assertLegacyWorkflowProjectionAuthorized(lineage);
  if (!workflowStateStore?.put) throw new Error('legacy workflow projection requires WorkflowStatePort');
  return workflowStateStore.put({
    paperId,
    mode,
    state,
    workflowReceiptHash,
    sourceReceiptHashes: [lineage.workflowAuthorityLineageReceiptHash],
  });
}
