function assertQuerySource(query) {
  if (Number(query?.version || 0) < 1) {
    throw new Error('CampaignReleaseQueryPort.version 1 is required');
  }
  if (typeof query?.getCurrentRelease !== 'function') {
    throw new Error('CampaignReleaseQueryPort.getCurrentRelease is required');
  }
  return query;
}

export function assertCampaignReleaseQueryPort(query) {
  assertQuerySource(query);
  if (typeof query?.promoteCompletedRelease === 'function') {
    throw new Error('CampaignReleaseQueryPort.promoteCompletedRelease is forbidden');
  }
  return query;
}

export function createCampaignReleaseQueryCapability(query) {
  const source = assertQuerySource(query);
  return Object.freeze(assertCampaignReleaseQueryPort({
    version: 1,
    kind: 'CampaignReleaseQueryCapability',
    getCurrentRelease(options = {}) {
      return source.getCurrentRelease(options);
    },
  }));
}
