import { buildCampaignFormalReviewEnvelope } from './campaign-formal-review-envelope.mjs';

export function createCampaignAgentPrimitivesAdapter({ agentExecutor, formalReviewAgentExecutor = null } = {}) {
  if (!agentExecutor) throw new Error('agentExecutor is required');
  return Object.freeze({
    version: 1,
    kind: 'CampaignAgentPrimitivesAdapter',
    async execute({ request, principal = 'default' } = {}) {
      const independentReview = ['formal-review', 'independent-review'].includes(principal);
      if (independentReview && !formalReviewAgentExecutor) {
        const error = new Error('independent_review_principal_executor_required');
        error.retryable = false;
        throw error;
      }
      return (independentReview ? formalReviewAgentExecutor : agentExecutor).execute(request);
    },
    buildFormalReviewEnvelope: (input) => buildCampaignFormalReviewEnvelope(input),
  });
}
