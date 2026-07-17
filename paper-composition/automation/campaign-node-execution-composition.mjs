import { createCampaignNodeExecutor as createApplicationCampaignNodeExecutor } from '../../paper-application/automation/campaign-node-executor.mjs';
import { createCampaignNodePrimitivesAdapter } from '../../paper-adapters/automation/campaign-node-primitives-adapter.mjs';
import { createCampaignWorkspaceAttemptAdapter } from '../../paper-adapters/automation/campaign-workspace-attempt-adapter.mjs';

export function createCampaignNodeExecutor(options = {}) {
  return createApplicationCampaignNodeExecutor({
    nodePrimitives: createCampaignNodePrimitivesAdapter(options),
    workspaceAttempts: createCampaignWorkspaceAttemptAdapter({ runtimeRoot: options.runtimeRoot }),
    experimentRegistryAuthorityVerifier: options.experimentRegistryAuthorityVerifier || null,
  });
}
