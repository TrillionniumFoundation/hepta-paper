export function assertCampaignReleasePackagerPort(port) {
  if (!port || port.version !== 1 || port.kind !== 'CampaignReleasePackagerPort' || typeof port.packageRelease !== 'function') {
    throw new Error('CampaignReleasePackagerPort v1 is required');
  }
  return port;
}
