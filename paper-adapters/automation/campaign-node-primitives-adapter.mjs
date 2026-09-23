import { createCampaignAgentPrimitivesAdapter } from './campaign-agent-primitives-adapter.mjs';
import { createCampaignEmpiricalPrimitivesAdapter } from './campaign-empirical-primitives-adapter.mjs';
import { createCampaignQualityPrimitivesAdapter } from './campaign-quality-primitives-adapter.mjs';
import { createCampaignReleasePrimitivesAdapter } from './campaign-release-primitives-adapter.mjs';
import { createCampaignWorkspacePrimitivesAdapter } from './campaign-workspace-primitives-adapter.mjs';

export function createCampaignNodePrimitivesAdapter(options = {}) {
  return Object.freeze({
    version: 1,
    kind: 'CampaignNodePrimitivesAdapter',
    workspace: createCampaignWorkspacePrimitivesAdapter(options),
    agent: createCampaignAgentPrimitivesAdapter(options),
    empirical: createCampaignEmpiricalPrimitivesAdapter(options),
    quality: createCampaignQualityPrimitivesAdapter(options),
    release: createCampaignReleasePrimitivesAdapter(options),
  });
}
