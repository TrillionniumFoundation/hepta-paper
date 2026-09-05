// Existing prepared-result and workspace integration fence, kept separate
// from resource admission. Executor code receives no additional writer handle.
export async function prepareAndIntegrateCampaignNodeResult({
  campaignId, campaignStore, node, result, workerId, executor, campaign,
  signal, leaseSeconds, nowEpochMs,
}) {
  const workspaceIntegrationDescriptor = result?.workspaceAttemptIntegration || null;
  const integrationKey = workspaceIntegrationDescriptor?.workspaceAttemptIntegrationDescriptorHash || null;
  const prepared = node.preparedResultHash ? node : campaignStore.prepareNodeResult({
    nodeId: node.nodeId,
    workerId,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    result,
    requiresIntegration: Boolean(workspaceIntegrationDescriptor),
    integrationKey,
  });
  const beforeIntegrationCampaign = campaignStore.getCampaign(campaignId);
  const beforeIntegrationNode = campaignStore.listNodes(campaignId).find((item) => item.nodeId === node.nodeId);
  const beforeIntegrationLeaseExpired = Date.parse(beforeIntegrationNode?.leaseExpiresAt || '') < nowEpochMs();
  if (signal.aborted
    || beforeIntegrationCampaign?.status !== 'running'
    || beforeIntegrationNode?.status !== 'running'
    || beforeIntegrationNode?.leaseOwner !== workerId
    || beforeIntegrationNode?.attemptId !== node.attemptId
    || beforeIntegrationNode?.leaseGeneration !== node.leaseGeneration
    || beforeIntegrationLeaseExpired) {
    const error = new Error('campaign_node_integration_fence_lost');
    error.retryable = false;
    throw error;
  }
  let integrationReceipt = prepared.preparedIntegrationReceipt || null;
  if (prepared.preparedRequiresIntegration && prepared.preparedIntegrationStatus !== 'integrated') {
    if (typeof executor.integratePrepared !== 'function') throw new Error('campaign_node_integrator_required');
    const integrating = campaignStore.beginNodeResultIntegration({
      nodeId: node.nodeId,
      workerId,
      attemptId: node.attemptId,
      leaseGeneration: node.leaseGeneration,
      integrationKey: prepared.preparedIntegrationKey,
      integrationLeaseSeconds: Math.max(leaseSeconds, 1800),
    });
    if (integrating.preparedIntegrationStatus !== 'integrating') throw new Error('campaign_node_integration_intent_invalid');
    try {
      if (signal.aborted) throw new Error('campaign_node_integration_fence_lost');
      campaignStore.renewNodeLease({
        nodeId: node.nodeId,
        workerId,
        attemptId: node.attemptId,
        leaseGeneration: node.leaseGeneration,
        leaseSeconds: Math.max(leaseSeconds, 1800),
      });
      if (signal.aborted) throw new Error('campaign_node_integration_fence_lost');
    } catch {
      const error = new Error('campaign_node_integration_fence_lost');
      error.retryable = false;
      throw error;
    }
    integrationReceipt = await executor.integratePrepared({ campaign, node, result: prepared.preparedResult || result, executionSignal: signal });
    if (integrationReceipt?.descriptorHash !== prepared.preparedIntegrationKey
      || integrationReceipt?.status !== 'workspace_attempt_integrated') {
      throw new Error('campaign_node_integration_receipt_invalid');
    }
    campaignStore.markNodeResultIntegrated({
      nodeId: node.nodeId,
      workerId,
      attemptId: node.attemptId,
      leaseGeneration: node.leaseGeneration,
      integrationKey: prepared.preparedIntegrationKey,
      integrationReceipt,
    });
  }
  if (signal.aborted) {
    const error = new Error(String(signal.reason || 'campaign_execution_fence_lost'));
    error.retryable = true;
    throw error;
  }
  return prepared;
}
