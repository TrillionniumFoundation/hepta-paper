import {
  buildAgentPostprocessingFailureUsageReceipt,
  buildAgentExecutionUsageBinding,
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';

export function requireVerifiedAgentReceipt(receipt, label) {
  if (!verifyAgentExecutionReceipt(receipt)) {
    const error = new Error(`${label}_agent_execution_receipt_invalid`);
    error.retryable = false;
    error.receipt = receipt || null;
    throw error;
  }
  return receipt;
}

export function agentExecutionUsageFields(receipt) {
  const binding = buildAgentExecutionUsageBinding(receipt);
  if (!binding) {
    const error = new Error('agent_execution_usage_binding_invalid');
    error.retryable = false;
    error.receipt = receipt || null;
    throw error;
  }
  return Object.freeze({
    agentExecutionReceiptHash: receipt.agentExecutionReceiptHash,
    agentExecutionReceipt: receipt,
    usage: binding.usage,
    agentExecutionUsageBindingHash: binding.agentExecutionUsageBindingHash,
    agentExecutionUsageBinding: binding,
  });
}

export function attachSuccessfulAgentReceipt(error, receipt) {
  if (!error || typeof error !== 'object') return error;
  if (error.receipt && error.receipt !== receipt) {
    error.postprocessingReceipt = error.receipt;
  }
  const meteringReceipt = buildAgentPostprocessingFailureUsageReceipt(receipt);
  error.agentExecutionReceipt = receipt;
  error.receipt = meteringReceipt || receipt;
  try {
    const fields = agentExecutionUsageFields(receipt);
    error.usage = fields.usage;
    error.agentExecutionUsageBinding = fields.agentExecutionUsageBinding;
    error.agentExecutionUsageBindingHash = fields.agentExecutionUsageBindingHash;
  } catch {
    // The verified execution receipt remains attached even when legacy usage is absent.
  }
  return error;
}

export async function runNestedAgent({
  primitives,
  executionResources,
  executionBudget,
  executionSignal,
  principal,
  request,
} = {}) {
  const operation = ({
    remainingTokenCount = Number(executionBudget?.remainingTokenCount || 8192),
    signal = executionSignal,
  } = {}) => primitives.agent.execute({
    principal,
    request: {
      ...request,
      outputTokenBudget: Math.min(
        Number(request.outputTokenBudget || remainingTokenCount),
        Number(remainingTokenCount || request.outputTokenBudget || 8192),
      ),
      signal,
    },
  });
  return executionResources?.runNestedAgent
    ? executionResources.runNestedAgent(operation)
    : operation();
}
