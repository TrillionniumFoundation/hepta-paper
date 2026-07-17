export function assertCampaignResearchVerifierPort(value) {
  if (!value || value.kind !== 'CampaignResearchVerifierPort' || typeof value.verify !== 'function') {
    throw new Error('CampaignResearchVerifierPort required');
  }
  return value;
}
