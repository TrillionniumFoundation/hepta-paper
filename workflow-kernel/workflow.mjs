import { hashRecord } from './record-hash.mjs';

export async function executeWorkflow({ definition, context, initialState = {}, handlers = {} } = {}) {
  if (!definition?.mode || !Array.isArray(definition.stages)) {
    throw new Error('Workflow definition with ordered stages is required');
  }
  let state = { ...initialState };
  const stages = [];
  let externalActionPerformed = false;
  for (const stage of definition.stages) {
    const handler = handlers[stage];
    if (typeof handler !== 'function') throw new Error(`Missing workflow stage handler: ${stage}`);
    const patch = await handler({ context, state: Object.freeze({ ...state }), stage });
    if (patch && typeof patch !== 'object') throw new Error(`Workflow stage ${stage} returned a non-object patch`);
    const stageExternalActionPerformed = Object.values(patch || {}).some((value) => (
      value?.externalActionPerformed === true || value?.safety?.externalActionPerformed === true
    ));
    externalActionPerformed ||= stageExternalActionPerformed;
    state = { ...state, ...(patch || {}) };
    stages.push(Object.freeze({
      stage,
      status: 'stage_completed',
      outputKeys: Object.keys(patch || {}).sort(),
      externalActionPerformed: stageExternalActionPerformed,
    }));
  }
  const receipt = {
    version: 1,
    kind: 'WorkflowExecutionReceipt',
    workflow: definition.mode,
    stageCount: stages.length,
    stages: Object.freeze(stages),
    externalActionPerformed,
  };
  return {
    state,
    workflowReceipt: Object.freeze({
      ...receipt,
      workflowReceiptHash: hashRecord('WorkflowExecutionReceipt', receipt),
    }),
  };
}
