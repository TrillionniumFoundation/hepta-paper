import fs from 'node:fs';
import path from 'node:path';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import {
  buildExecutorCapabilities,
  capabilityRequestFromExecution,
  evaluateExecutorCapabilityRequest,
} from '../../paper-ports/executor-capabilities.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { changedWorkspacePaths, createWorkspaceManifest } from './workspace-change-tracker.mjs';

export function hashAgentPrompt(prompt) {
  return hashBytes(String(prompt));
}

export function isExternalAgentCancellation(result = {}) {
  return result?.aborted === true && result?.timedOut !== true;
}

function normalizeExecutionInput(input = {}) {
  const {
    role,
    workspacePath,
    instructions,
    context = {},
    requiredChecks = [],
    sandbox = 'workspace-write',
    outputTokenBudget = null,
    timeoutMs: requestedTimeout = null,
    signal = null,
    workspaceMutationPolicy = null,
  } = input;
  return {
    input,
    role,
    workspacePath,
    instructions,
    context,
    requiredChecks,
    sandbox,
    outputTokenBudget,
    requestedTimeout,
    signal,
    workspaceMutationPolicy,
  };
}

function validateWorkspace({
  role,
  instructions,
  workspacePath,
  requireDirectory,
  workspaceValidationMessage,
}) {
  const workspace = path.resolve(workspacePath || '');
  const exists = fs.existsSync(workspace);
  const usable = exists && (!requireDirectory || fs.statSync(workspace).isDirectory());
  if (!role || !instructions || !usable) throw new Error(workspaceValidationMessage);
  return workspace;
}

export function finalizeAgentExecution({ payload, failureMessage, retryable = true }) {
  const receipt = Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
  if (payload.status === 'agent_execution_completed') return receipt;
  const message = typeof failureMessage === 'function'
    ? failureMessage({ payload, receipt })
    : failureMessage;
  const error = new Error(message || 'agent execution failed');
  error.retryable = typeof retryable === 'function'
    ? retryable({ payload, receipt })
    : retryable === true;
  error.receipt = receipt;
  throw error;
}

export function createAgentExecutorTemplate({
  kind,
  executorId,
  capabilityDefinition,
  workspaceValidationMessage,
  requireDirectory = true,
  captureWorkspaceManifest = false,
  sandboxValidationMessage = null,
  executeStrategy,
} = {}) {
  if (typeof executeStrategy !== 'function') throw new Error('agent executor strategy is required');
  const capabilities = buildExecutorCapabilities({
    executorId,
    sandboxModes: ['read-only', 'workspace-write'],
    workspaceIsolation: false,
    receiptKinds: ['AgentExecutionReceipt'],
    ...capabilityDefinition,
  });
  return assertAgentExecutorPort({
    version: 1,
    kind,
    executorId,
    capabilities: () => capabilities,
    async execute(input = {}) {
      const execution = normalizeExecutionInput(input);
      const preflight = evaluateExecutorCapabilityRequest({
        capabilities,
        request: capabilityRequestFromExecution({
          ...input,
          sandbox: execution.sandbox,
          outputTokenBudget: execution.outputTokenBudget,
          timeoutMs: execution.requestedTimeout,
        }),
      });
      if (preflight.blockers.length) throw new Error(preflight.blockers.join(','));
      const workspace = validateWorkspace({
        ...execution,
        requireDirectory,
        workspaceValidationMessage,
      });
      if (sandboxValidationMessage && !capabilities.sandboxModes.includes(execution.sandbox)) {
        throw new Error(sandboxValidationMessage);
      }
      const beforeWorkspaceManifest = captureWorkspaceManifest
        ? createWorkspaceManifest(workspace)
        : null;
      const result = await executeStrategy({
        ...execution,
        capabilities,
        workspace,
        promptHash: hashAgentPrompt,
        changedWorkspacePaths() {
          if (!beforeWorkspaceManifest) throw new Error('agent executor workspace manifest was not captured');
          return changedWorkspacePaths(beforeWorkspaceManifest, createWorkspaceManifest(workspace));
        },
      });
      return finalizeAgentExecution({
        ...result,
        payload: {
          version: 1,
          kind: 'AgentExecutionReceipt',
          executorId,
          ...result.payload,
          externalActionPerformed: result.payload?.externalActionPerformed ?? null,
          externalActionVerification: result.payload?.externalActionVerification || 'not_observed',
        },
      });
    },
  });
}
