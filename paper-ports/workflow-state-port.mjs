export function assertWorkflowStatePort(store) {
  for (const method of ['put', 'get', 'list']) {
    if (typeof store?.[method] !== 'function') throw new Error(`WorkflowStatePort.${method} is required`);
  }
  return store;
}
