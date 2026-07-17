import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  evaluateAutonomousResearchQualificationEligibility,
} from '../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import {
  inspectAutonomousResearchGlobalGoldenQualificationAuthority,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';
import { requestExternalResearchQualification } from './external-qualification-recovery.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const VERIFIED_EXTERNAL_STATUSES = new Set([
  'qualification_external_service_verified',
  'qualification_cached_verified_locally',
]);

function dateFromClock(clock) {
  const observed = clock?.now ? clock.now() : new Date();
  const value = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(value.getTime())) {
    throw new Error('autonomous_research_qualification_renewal_clock_invalid');
  }
  return value;
}

async function reportQualificationProgress(onProgress, stage) {
  if (onProgress === null || onProgress === undefined) return;
  if (typeof onProgress !== 'function') {
    throw new Error('autonomous_research_qualification_progress_callback_invalid');
  }
  try { await onProgress(Object.freeze({ stage })); }
  catch (error) {
    throw new Error('autonomous_research_qualification_progress_fence_lost', {
      cause: error,
    });
  }
}

function eligibilityFor(preparation, campaignReleaseAuthority, inspection) {
  return evaluateAutonomousResearchQualificationEligibility({
    proposal: preparation?.proposal,
    policyAuthorization: preparation?.policyAuthorization,
    seedBundle: preparation?.seedBundle,
    seedBinding: preparation?.seedBinding,
    principalSeparation: preparation?.principalSeparation,
    topologyInspection: preparation?.topologyInspection,
    datasetLaunchInspection: preparation?.datasetLaunchInspection,
    empiricalRuntimeCapabilityInspection: preparation?.empiricalRuntimeCapabilityInspection,
    empiricalExecutionProfileSelection: preparation?.empiricalExecutionProfileSelection,
    campaignReleaseAuthority,
    fullResearchQualificationInspection: inspection,
  });
}

function validStateBinding(state, campaignReleaseAuthority, inspection) {
  return state?.recovery?.status === 'qualification_verified'
    && state?.campaignId === campaignReleaseAuthority?.campaignId
    && state?.paperId === campaignReleaseAuthority?.paperId
    && state?.campaignReleaseBundleHash === campaignReleaseAuthority?.campaignReleaseBundleHash
    && SHA256.test(String(state?.autonomousExternalQualificationStateHash || ''))
    && Number.isSafeInteger(Number(state?.generation))
    && Number(state.generation) >= 1
    && state?.receipt?.fullResearchQualificationReceiptHash
      === inspection?.qualificationReceiptHash;
}

function requireDependencies(value) {
  if (value?.externalQualificationClient?.kind !== 'ExternalResearchQualificationClient'
    || value?.externalQualificationVerifier?.kind
      !== 'IndependentExternalResearchQualificationVerifier'
    || typeof value.externalQualificationVerifier.verifyLocally !== 'function'
    || value?.qualificationStateStore?.kind
      !== 'AutonomousResearchQualificationStateRepository'
    || typeof value.qualificationStateStore.readExternalQualificationState !== 'function'
    || value?.receiptPointerRepository?.kind
      !== 'FullResearchQualificationReceiptPointerRepository'
    || typeof value.receiptPointerRepository.tryAcquirePublicationLease !== 'function'
    || typeof value.receiptPointerRepository.publish !== 'function'
    || typeof value.receiptPointerRepository.releasePublicationLease !== 'function'
    || typeof value.assertSupervisorLease !== 'function'
    || typeof value.inspectGlobalReadiness !== 'function') {
    throw new Error('autonomous_research_qualification_renewal_dependencies_invalid');
  }
}

export function createAutonomousResearchQualificationRenewal({
  externalQualificationClient,
  externalQualificationVerifier,
  qualificationStateStore,
  receiptPointerRepository,
  assertSupervisorLease,
  inspectGlobalReadiness,
  clock = { now: () => new Date() },
  scheduler = null,
  pointerLeaseMs = 60_000,
} = {}) {
  requireDependencies({
    externalQualificationClient,
    externalQualificationVerifier,
    qualificationStateStore,
    receiptPointerRepository,
    assertSupervisorLease,
    inspectGlobalReadiness,
  });

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchQualificationRenewal',
    internalSupervisorOnly: true,
    async renew({
      campaign,
      campaignReleaseAuthority,
      runtimeReadiness,
      requiredQualificationValidityMs,
      qualificationRetry = {},
      supervisorLease,
      signal = null,
      onProgress = null,
    } = {}) {
      const preparation = campaign?.spec?.autonomousResearchPreparation || null;
      const now = dateFromClock(clock);
      const requiredValidity = Number(requiredQualificationValidityMs);
      if (!campaign || !preparation || campaignReleaseAuthority?.campaignId !== campaign.campaignId
        || runtimeReadiness?.ready !== true
        || !SHA256.test(String(runtimeReadiness?.receiptHash || ''))
        || !Number.isSafeInteger(requiredValidity) || requiredValidity < 0) {
        throw new Error('autonomous_research_qualification_renewal_input_invalid');
      }
      assertSupervisorLease({ lease: supervisorLease, now });
      await reportQualificationProgress(
        onProgress,
        'qualification_renewal_before_external_recovery',
      );
      const externalQualification = await requestExternalResearchQualification({
        externalQualificationClient,
        externalQualificationVerifier,
        campaignReleaseAuthority,
        preparation,
        qualificationStateStore,
        allowRequest: true,
        retry: {
          ...qualificationRetry,
          clock,
          ...(scheduler ? { scheduler } : {}),
          signal,
          onProgress,
          renewalLeadMs: Math.max(
            requiredValidity,
            Number(qualificationRetry.renewalLeadMs || 0),
          ),
        },
        evaluateEligibility: (inspection) => eligibilityFor(
          preparation,
          campaignReleaseAuthority,
          inspection,
        ),
      });
      await reportQualificationProgress(
        onProgress,
        'qualification_renewal_after_external_recovery',
      );
      if (!VERIFIED_EXTERNAL_STATUSES.has(externalQualification?.status)) {
        return Object.freeze({
          ready: false,
          terminal: externalQualification?.status
            === 'qualification_external_service_terminal_blocked',
          reason: externalQualification?.status || 'qualification_renewal_not_verified',
          externalQualification,
        });
      }
      assertSupervisorLease({ lease: supervisorLease, now: dateFromClock(clock) });
      const state = qualificationStateStore.readExternalQualificationState();
      let localInspection = null;
      try {
        await reportQualificationProgress(
          onProgress,
          'qualification_renewal_before_local_verification',
        );
        localInspection = await externalQualificationVerifier.verifyLocally({
          receipt: state?.receipt,
          campaignReleaseAuthority,
          preparation,
          independentInspection: state?.verifiedInspection,
        });
        await reportQualificationProgress(
          onProgress,
          'qualification_renewal_after_local_verification',
        );
      } catch (error) {
        if (error?.message === 'autonomous_research_qualification_progress_fence_lost') {
          throw error;
        }
        localInspection = null;
      }
      const eligibility = localInspection
        ? eligibilityFor(preparation, campaignReleaseAuthority, localInspection) : null;
      const verificationTime = dateFromClock(clock);
      const expiresAt = Date.parse(String(state?.receipt?.expiresAt || ''));
      if (!validStateBinding(state, campaignReleaseAuthority, localInspection)
        || localInspection?.status !== 'full_research_qualification_verified'
        || localInspection?.ready !== true
        || localInspection?.receiptAccepted !== true
        || localInspection?.fullDomainVerificationReady !== true
        || eligibility?.fullAutomaticResearchWritingReady !== true
        || state.receipt.runtimeImageReproducibilityReceiptHash
          !== runtimeReadiness.receiptHash
        || !Number.isFinite(expiresAt)
        || expiresAt - verificationTime.getTime() <= requiredValidity) {
        throw new Error('autonomous_research_qualification_renewal_local_verification_failed');
      }

      const globalGoldenAuthority =
        inspectAutonomousResearchGlobalGoldenQualificationAuthority({
          campaign,
          campaignReleaseAuthority,
          preparation,
        });
      if (globalGoldenAuthority.ready !== true) {
        const payload = Object.freeze({
          version: 1,
          kind: 'AutonomousResearchQualificationRenewalReceipt',
          status: 'autonomous_research_campaign_local_qualification_renewed',
          ready: true,
          campaignId: campaign.campaignId,
          paperId: campaign.paperId,
          campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
          runtimeImageReproducibilityReceiptHash: runtimeReadiness.receiptHash,
          fullResearchQualificationReceiptHash:
            state.receipt.fullResearchQualificationReceiptHash,
          autonomousExternalQualificationStateHash:
            state.autonomousExternalQualificationStateHash,
          qualificationStateGeneration: state.generation,
          globalQualificationPointerEligible: false,
          globalGoldenQualificationAuthorityInspection: globalGoldenAuthority,
          publication: null,
          verifiedAt: verificationTime.toISOString(),
          directCliActionExposed: false,
          externalActionPerformed: true,
        });
        return Object.freeze({
          ...payload,
          autonomousResearchQualificationRenewalReceiptHash: hashRecord(
            'AutonomousResearchQualificationRenewalReceipt',
            payload,
          ),
        });
      }

      let publicationLease = null;
      let publication = null;
      try {
        await reportQualificationProgress(
          onProgress,
          'qualification_renewal_before_global_pointer_publication',
        );
        assertSupervisorLease({ lease: supervisorLease, now: verificationTime });
        publicationLease = receiptPointerRepository.tryAcquirePublicationLease({
          ownerId: `supervisor-qualification:${campaign.paperId}`,
          leaseMs: pointerLeaseMs,
          now: verificationTime,
        });
        if (!publicationLease) {
          return Object.freeze({
            ready: false,
            terminal: false,
            reason: 'full_research_qualification_pointer_publication_leased',
            externalQualification,
          });
        }
        assertSupervisorLease({ lease: supervisorLease, now: dateFromClock(clock) });
        await reportQualificationProgress(
          onProgress,
          'qualification_renewal_after_global_pointer_publication',
        );
        publication = receiptPointerRepository.publish({
          lease: publicationLease,
          receipt: state.receipt,
          qualificationStateHash: state.autonomousExternalQualificationStateHash,
          qualificationStateGeneration: state.generation,
          expectedRuntimeReceiptHash: runtimeReadiness.receiptHash,
          publisherFence: Object.freeze({
            scope: 'autonomous-research-supervisor',
            ownerId: supervisorLease.ownerId,
            leaseGeneration: supervisorLease.leaseGeneration,
          }),
          now: dateFromClock(clock),
        });
        assertSupervisorLease({ lease: supervisorLease, now: dateFromClock(clock) });
      } finally {
        if (publicationLease) {
          try {
            receiptPointerRepository.releasePublicationLease({
              lease: publicationLease,
              now: dateFromClock(clock),
            });
          } catch { /* stale pointer leases are reconciled by the next mutating startup */ }
        }
      }

      await reportQualificationProgress(
        onProgress,
        'qualification_renewal_before_global_readiness',
      );
      const readinessResult = await inspectGlobalReadiness({
        now: dateFromClock(clock),
        signal,
      });
      await reportQualificationProgress(
        onProgress,
        'qualification_renewal_after_global_readiness',
      );
      const readiness = readinessResult?.report || readinessResult?.readiness
        || readinessResult || null;
      if (readiness?.fullAutomaticResearchWritingReady !== true
        || readiness?.campaignFullyQualified !== true
        || readiness?.fullResearchQualification?.qualificationReceiptHash
          !== state.receipt.fullResearchQualificationReceiptHash) {
        throw new Error('autonomous_research_qualification_renewal_global_readiness_failed');
      }
      const payload = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchQualificationRenewalReceipt',
        status: 'autonomous_research_qualification_renewed_and_published',
        ready: true,
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
        runtimeImageReproducibilityReceiptHash: runtimeReadiness.receiptHash,
        fullResearchQualificationReceiptHash:
          state.receipt.fullResearchQualificationReceiptHash,
        autonomousExternalQualificationStateHash:
          state.autonomousExternalQualificationStateHash,
        qualificationStateGeneration: state.generation,
        globalQualificationPointerEligible: true,
        globalGoldenQualificationAuthorityInspection: globalGoldenAuthority,
        publication,
        verifiedAt: dateFromClock(clock).toISOString(),
        directCliActionExposed: false,
        externalActionPerformed: true,
      });
      return Object.freeze({
        ...payload,
        autonomousResearchQualificationRenewalReceiptHash: hashRecord(
          'AutonomousResearchQualificationRenewalReceipt',
          payload,
        ),
      });
    },
  });
}
