import { assertExecutorCapabilities } from './executor-capabilities.mjs';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';
import { assertBoundaryRecord } from './boundary-schema-catalog.mjs';

export function assertSubmissionExecutorPort(executor) {
  for (const field of ['executorId', 'provider', 'accountId', 'workspaceRoot']) {
    if (!executor?.[field]) throw new Error(`SubmissionExecutorPort.${field} is required`);
  }
  if (executor.externalWorkspace !== true) throw new Error('Submission executor must run in an external workspace');
  if (typeof executor.dispatch !== 'function') throw new Error('SubmissionExecutorPort.dispatch is required');
  if (typeof executor.capabilities !== 'function') throw new Error('SubmissionExecutorPort.capabilities is required');
  const capabilities = assertExecutorCapabilities(executor.capabilities());
  if (capabilities.executorId !== executor.executorId) throw new Error('SubmissionExecutorPort capability executorId mismatch');
  if (capabilities.externalActions !== true) throw new Error('Submission executor must explicitly declare external actions');
  if (capabilities.workspaceIsolation !== true) throw new Error('Submission executor must declare workspace isolation');
  if (capabilities.networkPolicy !== 'provider-scoped') throw new Error('Submission executor network must be provider scoped');
  return executor;
}

export function submissionExecutorDescriptor(executor) {
  const port = assertSubmissionExecutorPort(executor);
  const capabilities = port.capabilities();
  const payload = {
    version: 1,
    kind: 'SubmissionExecutorDescriptor',
    executorId: port.executorId,
    provider: port.provider,
    accountId: port.accountId,
    workspaceRoot: port.workspaceRoot,
    externalWorkspace: true,
    capabilities,
    capabilitiesHash: hashRecord('ExecutorCapabilities', capabilities),
  };
  assertBoundaryRecord(payload);
  return Object.freeze({ ...payload, submissionExecutorDescriptorHash: hashRecord('SubmissionExecutorDescriptor', payload) });
}
