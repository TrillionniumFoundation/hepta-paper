export function assertCampaignStorePort(store) {
  for (const method of [
    'createCampaign', 'getCampaign', 'listNodes', 'claimReady', 'startNode',
    'prepareNodeResult', 'beginNodeResultIntegration', 'markNodeResultIntegrated', 'completeNode', 'failNode', 'skipFutureRounds', 'recoverExpiredLeases', 'listEvents',
    'renewNodeLease', 'pauseCampaign', 'resumeCampaign', 'extendCampaign', 'cancelCampaign', 'cancelNode', 'retryNode',
    'recordUsage', 'failCampaign', 'stopCampaign', 'listCampaigns',
  ]) {
    if (typeof store?.[method] !== 'function') throw new Error(`CampaignStorePort.${method} is required`);
  }
  if (Number(store.version || 0) < 2) throw new Error('CampaignStorePort.version 2 with attempt fencing is required');
  return store;
}
