export function assertCampaignGpuScientificExecutionPort(port) {
  if (port?.version !== 1
    || port?.kind !== 'CampaignGpuScientificExecutionPort'
    || typeof port?.execute !== 'function'
    || typeof port?.capabilities !== 'function') {
    throw new Error('CampaignGpuScientificExecutionPort version 1 is required');
  }
  const capabilities = port.capabilities();
  if (capabilities?.typedHashBoundPlan !== true
    || capabilities?.exactPdeAndDeepLearningTaskSet !== true
    || capabilities?.canonicalPdeCpuOracleRequired !== true
    || capabilities?.canonicalCupyMlpRequired !== true
    || capabilities?.singleGpuUuidRequired !== true
    || capabilities?.absoluteDeadlineBound !== true
    || capabilities?.sourceMutationForbidden !== true
    || capabilities?.productionPromotionDisabled !== true) {
    throw new Error('CampaignGpuScientificExecutionPort capabilities invalid');
  }
  return port;
}
