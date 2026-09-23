export function assertCampaignAdvancedNumericalExecutionPort(port) {
  if (port?.version !== 1
    || port?.kind !== 'CampaignAdvancedNumericalExecutionPort'
    || typeof port?.execute !== 'function'
    || typeof port?.capabilities !== 'function') {
    throw new Error('CampaignAdvancedNumericalExecutionPort version 1 is required');
  }
  const capabilities = port.capabilities();
  if (capabilities?.optionalCampaignNode !== true
    || capabilities?.hashBoundPlan !== true
    || capabilities?.attemptLeaseBound !== true
    || capabilities?.idempotentNoClobber !== true
    || capabilities?.osSandboxDelegated !== true
    || capabilities?.productionQualificationRequiredForPromotion !== true) {
    throw new Error('CampaignAdvancedNumericalExecutionPort capabilities invalid');
  }
  return port;
}
