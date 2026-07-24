import { bootstrapAutomationContext } from './automation-context-bootstrap.mjs';
import { bootstrapFormalReviewAgentExecutor } from './formal-review-agent-bootstrap.mjs';
import {
  openAutonomousResearchExternallyFencedPaperStore,
} from './autonomous-research-native-store-composition.mjs';

export { openAutonomousResearchExternallyFencedPaperStore };

export function bootstrapCampaignExecutionContext(options = {}) {
  const requireExternallyFencedNativeStore =
    options.requireExternallyFencedNativeStore === true;
  if (requireExternallyFencedNativeStore && options.serviceOverrides?.store) {
    throw new Error('autonomous_research_native_store_override_forbidden');
  }
  const strictStore = requireExternallyFencedNativeStore
    ? openAutonomousResearchExternallyFencedPaperStore({
      root: options.root,
      runtimeRoot: options.runtimeRoot,
      mutationCoordinator: options.nativeStoreMutationCoordinator,
    }) : null;
  let context;
  try {
    context = bootstrapAutomationContext({
      ...options,
      submissionHandoffMutationCoordinator:
        options.submissionHandoffMutationCoordinator
          || options.nativeStoreMutationCoordinator || null,
      serviceOverrides: strictStore
        ? { ...(options.serviceOverrides || {}), store: strictStore }
        : options.serviceOverrides,
    });
  } catch (error) {
    strictStore?.close?.();
    throw error;
  }
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
