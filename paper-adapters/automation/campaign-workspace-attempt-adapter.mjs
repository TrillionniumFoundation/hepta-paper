import {
  buildWorkspaceIntegrationDescriptorSync,
  integrateWorkspaceAttemptSync,
  prepareWorkspaceAttemptSync,
} from './workspace-attempt-repository.mjs';
import {
  resolveCampaignWorkspace,
  workspaceAttemptPath,
  workspaceAttemptRelative,
} from './campaign-node-workspace-support.mjs';

export function createCampaignWorkspaceAttemptAdapter({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('campaign_workspace_attempt_runtime_root_required');
  const resolvedRuntimeRoot = resolveCampaignWorkspace(runtimeRoot);
  return Object.freeze({
    version: 1,
    kind: 'CampaignWorkspaceAttemptAdapter',
    prepare({ campaign, node } = {}) {
      const identity = {
        campaignId: campaign?.campaignId,
        nodeId: node?.nodeId,
        attemptId: node?.attemptId,
      };
      return prepareWorkspaceAttemptSync({
        sourceRoot: resolveCampaignWorkspace(campaign?.spec?.sourceWorkspace),
        attemptBaseRoot: resolvedRuntimeRoot,
        attemptRelative: workspaceAttemptRelative(identity),
        ...identity,
      });
    },
    describe(workspaceAttempt) {
      return buildWorkspaceIntegrationDescriptorSync(workspaceAttempt);
    },
    integrate({ campaign, node, result, executionSignal = null } = {}) {
      if (!campaign?.campaignId || !node?.nodeId) throw new Error('campaign_node_integration_identity_required');
      const originalAttemptId = node.preparedAttemptId || node.attemptId;
      if (!originalAttemptId) throw new Error('campaign_node_original_attempt_id_required');
      const identity = { campaignId: campaign.campaignId, nodeId: node.nodeId, attemptId: originalAttemptId };
      return integrateWorkspaceAttemptSync(result.workspaceAttemptIntegration, {
        expected: {
          campaignId: identity.campaignId,
          nodeId: identity.nodeId,
          originalAttemptId,
          sourceRoot: resolveCampaignWorkspace(campaign.spec.sourceWorkspace),
          attemptRoot: workspaceAttemptPath(resolvedRuntimeRoot, identity),
          runtimeRoot: resolvedRuntimeRoot,
        },
        executionSignal,
      });
    },
  });
}
