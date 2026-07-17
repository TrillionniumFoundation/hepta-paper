import { bootstrapAutomationContext } from './automation-context-bootstrap.mjs';
import { bootstrapFormalReviewAgentExecutor } from './formal-review-agent-bootstrap.mjs';

export function bootstrapCampaignExecutionContext(options = {}) {
  const context = bootstrapAutomationContext(options);
  return Object.freeze({
    context,
    createFormalReviewAgentExecutor({ authorAgentId, model = undefined, provider = undefined, ...reviewerOptions } = {}) {
      return bootstrapFormalReviewAgentExecutor({
        authorAgentId,
        model,
        provider,
        ...reviewerOptions,
        runtimeRoot: options.runtimeRoot,
        workspaceRegistry: context.services.workspaceRegistry,
      });
    },
  });
}
