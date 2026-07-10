export async function runWorkflowStages({ definition, context, initialState = {}, handlers = {} } = {}) {
  if (!definition?.mode || !Array.isArray(definition.stages)) {
    throw new Error('Workflow definition with ordered stages is required');
  }
  let state = { ...initialState };
  const stageReceipts = [];
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
    stageReceipts.push(Object.freeze({
      stage,
      status: 'stage_completed',
      outputKeys: Object.keys(patch || {}).sort(),
      externalActionPerformed: stageExternalActionPerformed,
    }));
  }
  return {
    state,
    workflowReceipt: Object.freeze({
      version: 1,
      kind: 'PaperWorkflowExecutionReceipt',
      mode: definition.mode,
      stageCount: stageReceipts.length,
      stages: Object.freeze(stageReceipts),
      externalActionPerformed,
    }),
  };
}
