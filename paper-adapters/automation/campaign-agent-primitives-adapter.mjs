import { buildCampaignFormalReviewEnvelope } from './campaign-formal-review-envelope.mjs';

export function createCampaignAgentPrimitivesAdapter({
  agentExecutor,
  formalReviewAgentExecutor = null,
  reviewerPrincipalExecutorPool = null,
  assertExternalSideEffectReady = null,
  formalProofSearchOperationsExecutor = null,
  formalTheoremDependencyGraphOperationsExecutor = null,
} = {}) {
  if (!agentExecutor) throw new Error('agentExecutor is required');
  return Object.freeze({
    version: 1,
    kind: 'CampaignAgentPrimitivesAdapter',
    async execute({ request, principal = 'default' } = {}) {
      const independentReview = ['formal-review', 'independent-review'].includes(principal);
      const reviewerExecutor = reviewerPrincipalExecutorPool || formalReviewAgentExecutor;
      if (independentReview && !reviewerExecutor) {
        const error = new Error('independent_review_principal_executor_required');
        error.retryable = false;
        throw error;
      }
      return (independentReview ? reviewerExecutor : agentExecutor).execute({
        ...request,
        assertExternalSideEffectReady:
          request?.assertExternalSideEffectReady || assertExternalSideEffectReady,
      });
    },
    buildFormalReviewEnvelope: (input) => buildCampaignFormalReviewEnvelope({
      ...input,
      signedReviewerReceiptVerifier:
        reviewerPrincipalExecutorPool?.verifySignedReviewerReceipt || null,
    }),
    executeFormalProofSearchOperations(input) {
      if (!formalProofSearchOperationsExecutor?.execute) {
        throw new Error('formal_proof_search_operations_executor_required');
      }
      return formalProofSearchOperationsExecutor.execute(input);
    },
    executeFormalTheoremDependencyGraphOperations(input) {
      if (!formalTheoremDependencyGraphOperationsExecutor?.execute) {
        throw new Error('formal_theorem_dependency_graph_operations_executor_required');
      }
      return formalTheoremDependencyGraphOperationsExecutor.execute(input);
    },
  });
}
