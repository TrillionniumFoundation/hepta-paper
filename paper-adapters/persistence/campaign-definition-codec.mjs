import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateCampaignReleaseTopology } from '../../paper-domain/automation/campaign-release-topology-policy.mjs';

export function canonicalCampaignDefinition(spec = {}) {
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const normalizedNodes = nodes.map((node = {}) => ({
    ...node,
    nodeId: String(node.nodeId || ''),
    kind: String(node.kind || ''),
    roundIndex: Number(node.roundIndex || 0),
    priority: Number(node.priority || 100),
    dependencies: [...new Set((node.dependencies || []).map(String))].sort(),
    maxAttempts: Math.max(1, Number(node.maxAttempts || 3)),
    role: node.role || null,
  })).sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  return JSON.parse(JSON.stringify({
    ...spec,
    campaignId: String(spec.campaignId || ''),
    paperId: String(spec.paperId || ''),
    maxRounds: Math.max(1, Number(spec.maxRounds || 1)),
    parentCampaignId: spec.parentCampaignId || null,
    supersedesCampaignId: spec.supersedesCampaignId || null,
    recoveryOfCampaignId: spec.recoveryOfCampaignId || null,
    nodes: normalizedNodes,
  }));
}

export function assertCampaignDefinition(spec = {}) {
  if (!spec.campaignId || !spec.paperId || !Array.isArray(spec.nodes) || !spec.nodes.length) {
    throw new Error('campaignId, paperId and non-empty nodes are required');
  }
  const nodeIds = spec.nodes.map((node) => String(node?.nodeId || ''));
  if (nodeIds.some((nodeId) => !nodeId) || new Set(nodeIds).size !== nodeIds.length) {
    throw new Error('campaign_definition_duplicate_or_missing_node_id');
  }
  const knownNodeIds = new Set(nodeIds);
  if (spec.nodes.some((node) => !node?.kind
    || (node.dependencies || []).some((dependency) => !knownNodeIds.has(String(dependency))))) {
    throw new Error('campaign_definition_node_or_dependency_invalid');
  }
  const releaseTopology = evaluateCampaignReleaseTopology({ nodes: spec.nodes });
  if (releaseTopology.blockers.length) {
    throw new Error(`campaign_definition_release_topology_invalid:${releaseTopology.blockers.join(',')}`);
  }
  if (releaseTopology.releasePackagingPresent) {
    if (spec.researchVerificationRequired !== true
      || spec.paperQualityRequirements?.researchVerificationRequired !== true) {
      throw new Error('campaign_definition_release_research_requirement_invalid');
    }
    const { campaignPlanHash, ...planPayload } = spec;
    if (!campaignPlanHash || hashRecord('PaperCampaignPlan', planPayload) !== campaignPlanHash) {
      throw new Error('campaign_definition_plan_hash_invalid');
    }
  }
  return spec;
}

export function campaignDefinitionHash(spec) {
  return hashRecord('PaperCampaignDefinition', canonicalCampaignDefinition(spec));
}

export function persistedCampaignDefinition(campaign, nodes) {
  return {
    ...campaign.spec,
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    maxRounds: campaign.maxRounds,
    parentCampaignId: campaign.parentCampaignId,
    supersedesCampaignId: campaign.supersedesCampaignId,
    recoveryOfCampaignId: campaign.recoveryOfCampaignId,
    nodes: nodes.map((node) => ({
      ...node.spec,
      nodeId: node.nodeId,
      kind: node.kind,
      roundIndex: node.roundIndex,
      priority: node.priority,
      dependencies: node.dependencies,
      maxAttempts: node.maxAttempts,
      role: node.role,
    })),
  };
}

export function assertCampaignDefinitionReplay(spec, campaign, nodes) {
  const requestedHash = campaignDefinitionHash(spec);
  const persistedHash = campaignDefinitionHash(persistedCampaignDefinition(campaign, nodes));
  if (requestedHash !== persistedHash) {
    const error = new Error('campaign_definition_conflict');
    error.code = 'campaign_definition_conflict';
    throw error;
  }
  return requestedHash;
}
