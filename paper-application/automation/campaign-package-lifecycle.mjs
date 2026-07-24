export function assertCampaignPackageLifecycleAuthority(authority) {
  if (authority !== null
    && (typeof authority?.prepareCurrentReleaseRecording !== 'function'
      || typeof authority?.reconcileCampaign !== 'function'
      || typeof authority?.reconcile !== 'function')) {
    throw new Error('campaign_package_lifecycle_authority_invalid');
  }
  return authority;
}

export function prepareCampaignPackageLifecycle({
  authority, campaignId, node, workerId, preparedResultHash,
} = {}) {
  if (node?.kind !== 'package' || !authority) return null;
  return authority.prepareCurrentReleaseRecording({
    campaignId,
    nodeId: node.nodeId,
    workerId,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    preparedResultHash,
  });
}
