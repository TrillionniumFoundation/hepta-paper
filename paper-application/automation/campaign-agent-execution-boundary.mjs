import {
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
