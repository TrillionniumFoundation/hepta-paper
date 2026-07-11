export function assertCampaignStorePort(store) {
  for (const method of [
    'createCampaign', 'getCampaign', 'listNodes', 'claimReady', 'startNode',
    'completeNode', 'failNode', 'skipFutureRounds', 'recoverExpiredLeases', 'listEvents',
  ]) {
    if (typeof store?.[method] !== 'function') throw new Error(`CampaignStorePort.${method} is required`);
  }
  return store;
}
