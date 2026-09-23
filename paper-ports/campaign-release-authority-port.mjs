export function assertCampaignReleaseAuthorityPort(repository) {
  if (Number(repository?.version || 0) < 1) {
    throw new Error('CampaignReleaseAuthorityPort.version 1 is required');
  }
  for (const method of ['promoteCompletedRelease', 'getCurrentRelease']) {
    if (typeof repository?.[method] !== 'function') {
      throw new Error(`CampaignReleaseAuthorityPort.${method} is required`);
    }
  }
  return repository;
}
