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
  reconcileStateRecoverability = null,
  assertStateRecoverabilityCurrent = null,
  onExternalSideEffectStarted = null,
} = {}) {
  const providerConfigurationHash = campaign.spec?.autonomousResearchPreparation
    ?.autonomousResearchProviderConfigurationHash || null;
  const sideEffectPermitRequired =
    stateRepository?.externallyFencedMutationsRequired === true;
  if (sideEffectPermitRequired
    && typeof stateRepository?.assertProviderCanarySideEffectPermit !== 'function') {
    throw new Error(
      'autonomous_research_supervisor_provider_canary_side_effect_permit_verifier_required',
    );
  }
  if (sideEffectPermitRequired
    && typeof stateRepository?.cancelProviderCanaryInfrastructureDeferred !== 'function') {
    throw new Error(
      'autonomous_research_supervisor_provider_canary_infrastructure_cancel_required',
    );
  }
  let currentResidentLeaseContext = await publishCampaignProgress(
    'before_provider_canary',
  ) || residentLeaseContext;
  autonomyFence.assertCurrent({
    campaign, record: machineRecord, residentLeaseContext: currentResidentLeaseContext,
    action: 'provider_canary_reservation',
  });
  const authorization = stateRepository.beginProviderCanary({
    lease,
    providerConfigurationHash,
    now: now(),
  });
  if (!authorization.authorized) {
    return Object.freeze({
      blocked: true,
      reason: authorization.blocker,
      residentLeaseContext: currentResidentLeaseContext,
    });
  }
  if (authorization.required) {
    let externalSideEffectStarted = false;
    try {
      await reconcileStateRecoverability?.({
        residentLeaseContext: currentResidentLeaseContext,
        action: 'supervisor_provider_canary_after_reservation',
      });
      assertStateRecoverabilityCurrent?.(
        'supervisor_provider_canary_side_effect',
      );
      if (typeof stateRepository.assertProviderCanarySideEffectPermit === 'function') {
        const permitted = stateRepository.assertProviderCanarySideEffectPermit({
          authorization,
        });
        if (typeof permitted?.then === 'function' || permitted !== true) {
          throw new Error(
            'autonomous_research_supervisor_provider_canary_side_effect_permit_invalid',
          );
        }
      }
      const canary = await runProviderCanary({
        campaign,
        qualificationState,
        runtimeReadiness,
        qualificationRenewalRequired: decision.qualificationRenewalRequired,
        requiredQualificationValidityMs: decision.requiredQualificationValidityMs,
        supervisorLease: lease,
        providerCanaryReservation: authorization.providerCanaryReservation,
        externalActionAttempt: authorization.externalActionAttempt,
        residentLeaseContext: currentResidentLeaseContext,
        onExternalSideEffectStarted: (value) => {
          externalSideEffectStarted = true;
          return onExternalSideEffectStarted?.(value);
        },
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
      if (error?.stateRecoverabilityFatal === true
        || error?.stateRecoverabilityDeferred === true
        || error?.authorityEvidenceRenewalFatal === true
        || error?.authorityEvidenceRenewalDeferred === true
        || error?.residentReactivationRequired === true) {
        if (!externalSideEffectStarted) {
          try {
            stateRepository.cancelProviderCanaryInfrastructureDeferred({
              lease,
              authorization,
              now: now(),
            });
            error.dispatchInfrastructureReservationCancelled = true;
          } catch (cancelError) {
            const fatal = new Error(
              'autonomous_research_supervisor_provider_canary_infrastructure_cancel_failed',
              { cause: cancelError },
            );
            fatal.stateRecoverabilityFatal = true;
            fatal.originalInfrastructureControlError = error;
            throw fatal;
          }
        }
        throw error;
      }
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
