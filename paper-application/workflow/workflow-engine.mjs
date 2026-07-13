import { executeWorkflow } from '../../workflow-kernel/workflow.mjs';

export async function runWorkflowStages(options = {}) {
  const execution = await executeWorkflow(options);
  return {
    ...execution,
    workflowReceipt: Object.freeze({
      ...execution.workflowReceipt,
      kind: 'PaperWorkflowExecutionReceipt',
      mode: execution.workflowReceipt.workflow,
    }),
  };
}
