export function assertCampaignStorePort(store) {
  for (const method of [
    'createCampaign', 'getCampaign', 'listNodes', 'claimReady', 'startNode',
    'completeNode', 'failNode', 'skipFutureRounds', 'recoverExpiredLeases', 'listEvents',
    'renewNodeLease', 'pauseCampaign', 'resumeCampaign', 'extendCampaign', 'cancelCampaign', 'cancelNode', 'retryNode',
    'recordUsage', 'failCampaign', 'stopCampaign', 'listCampaigns',
  ]) {
    if (typeof store?.[method] !== 'function') throw new Error(`CampaignStorePort.${method} is required`);
  }
  return store;
}
