import path from 'node:path';

export function createExecutionContext({
  root,
  runtimeRoot,
  mode,
  execute = false,
  writeReport = false,
  options = {},
  services = {},
} = {}) {
  if (!root) throw new Error('ExecutionContext root is required');
  if (!runtimeRoot) throw new Error('ExecutionContext runtimeRoot is required');
  if (!mode) throw new Error('ExecutionContext mode is required');
  return Object.freeze({
    version: 1,
    kind: 'PaperExecutionContext',
    root: path.resolve(root),
    runtimeRoot: path.resolve(runtimeRoot),
    mode,
    execute: Boolean(execute),
    writeReport: Boolean(writeReport),
    options: Object.freeze({ ...options }),
    services: Object.freeze({ ...services }),
    safety: Object.freeze({
      externalActionAllowed: false,
      legacyControlPlaneImportsAllowed: false,
      writesMustUseDeclaredPort: true,
    }),
  });
}

export function assertExecutionServices(context) {
  const required = ['store', 'artifactRepositoryFactory', 'clock', 'hasher', 'authorityVerifier', 'receiptLedger', 'jobReceiptStore', 'workflowStateStore', 'submissionDeliveryStore'];
  const missing = required.filter((name) => !context?.services?.[name]);
  if (missing.length) throw new Error(`ExecutionContext services missing: ${missing.join(',')}`);
  return context.services;
}
