export async function executeAutonomousResearchSupervisorProviderCanary({
  stateRepository,
  lease,
  campaign,
  qualificationState,
  runtimeReadiness,
  decision,
  runProviderCanary,
  publishCampaignProgress,
  autonomyFence,
  machineRecord,
  residentLeaseContext,
  signal,
  now,
} = {}) {
  const providerConfigurationHash = campaign.spec?.autonomousResearchPreparation
    ?.autonomousResearchProviderConfigurationHash || null;
  const authorization = stateRepository.beginProviderCanary({
    lease,
    providerConfigurationHash,
    now: now(),
  });
  if (!authorization.authorized) {
    return Object.freeze({
      blocked: true,
      reason: authorization.blocker,
      residentLeaseContext,
    });
  }
  let currentResidentLeaseContext = residentLeaseContext;
  if (authorization.required) {
    try {
      currentResidentLeaseContext = await publishCampaignProgress(
        'before_provider_canary',
      ) || currentResidentLeaseContext;
      autonomyFence.assertCurrent({
        campaign, record: machineRecord, residentLeaseContext: currentResidentLeaseContext,
      });
      const canary = await runProviderCanary({
        campaign,
        qualificationState,
        runtimeReadiness,
        qualificationRenewalRequired: decision.qualificationRenewalRequired,
        requiredQualificationValidityMs: decision.requiredQualificationValidityMs,
        supervisorLease: lease,
        providerCanaryReservation: authorization.providerCanaryReservation,
        externalActionAttempt: authorization.externalActionAttempt,
        signal,
      });
      currentResidentLeaseContext = await publishCampaignProgress(
        'after_provider_canary',
      ) || currentResidentLeaseContext;
      if (canary?.verified !== true) throw new Error('supervisor_provider_canary_not_verified');
      stateRepository.finishProviderCanary({
        lease,
        attempt: authorization.externalActionAttempt,
        verified: true,
        receiptHash: canary.providerCanaryPairReceiptHash || null,
        receipt: canary,
        now: now(),
      });
    } catch (error) {
      stateRepository.finishProviderCanary({
        lease,
        attempt: authorization.externalActionAttempt,
        verified: false,
        sideEffectInspection:
          error?.autonomousResearchProviderCanarySideEffectInspection || null,
        error: error?.message || error,
        now: now(),
      });
      throw error;
    }
  }
  return Object.freeze({
    blocked: false,
    reason: null,
    residentLeaseContext: currentResidentLeaseContext,
  });
}
