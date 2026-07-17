import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectAutonomousResearchGlobalGoldenQualificationAuthority,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';

const VERIFIED_EXTERNAL_STATUSES = new Set([
  'qualification_external_service_verified',
  'qualification_cached_verified_locally',
]);

function blocked(status, blockers, inspection = null) {
  const payload = Object.freeze({
    version: 1,
    kind: 'GoldenCampaignQualificationPublicationReport',
    status,
    ready: false,
    pointerPublished: false,
    inspection,
    publication: null,
    blockers: Object.freeze([...new Set(blockers.filter(Boolean))]),
  });
  return Object.freeze({
    ...payload,
    goldenCampaignQualificationPublicationReportHash:
      hashRecord('GoldenCampaignQualificationPublicationReport', payload),
  });
}

function stateBoundToRelease(state, authority) {
  return state?.campaignId === authority?.campaignId
    && state?.paperId === authority?.paperId
    && state?.campaignReleaseBundleHash === authority?.campaignReleaseBundleHash
    && state?.recovery?.status === 'qualification_verified'
    && state?.receipt?.fullResearchQualificationReceiptHash
      === state?.verifiedInspection?.qualificationReceiptHash;
}

export function createGoldenCampaignQualificationController({
  localQualificationVerifier,
  receiptPointerRepository,
  clock = null,
} = {}) {
  if (localQualificationVerifier?.kind !== 'IndependentExternalResearchQualificationVerifier'
    || typeof localQualificationVerifier?.verifyLocally !== 'function') {
    throw new Error('golden_campaign_local_qualification_verifier_required');
  }
  if (receiptPointerRepository?.kind
      !== 'FullResearchQualificationReceiptPointerRepository'
    || typeof receiptPointerRepository?.tryAcquirePublicationLease !== 'function'
    || typeof receiptPointerRepository?.releasePublicationLease !== 'function'
    || typeof receiptPointerRepository?.publish !== 'function') {
    throw new Error('golden_campaign_qualification_pointer_repository_required');
  }
  const now = () => {
    const observed = clock?.now ? clock.now() : new Date();
    const value = observed instanceof Date ? observed : new Date(observed);
    if (!Number.isFinite(value.getTime())) throw new Error('golden_campaign_clock_invalid');
    return value;
  };
  return Object.freeze({
    version: 1,
    kind: 'GoldenCampaignQualificationController',
    async finalize({
      externalQualification,
      campaign,
      campaignReleaseAuthority,
      preparation,
      qualificationStateStore,
      evaluateEligibility,
    } = {}) {
      const globalGoldenAuthority =
        inspectAutonomousResearchGlobalGoldenQualificationAuthority({
          campaign,
          campaignReleaseAuthority,
          preparation,
        });
      if (globalGoldenAuthority.ready !== true) {
        return blocked('golden_campaign_global_authority_blocked', [
          'golden_campaign_recurring_machine_intake_authority_required',
          ...globalGoldenAuthority.blockers,
        ], globalGoldenAuthority);
      }
      if (!VERIFIED_EXTERNAL_STATUSES.has(externalQualification?.status)) {
        return blocked('golden_campaign_qualification_not_verified', [
          'golden_campaign_external_qualification_not_verified',
        ]);
      }
      let state;
      try { state = qualificationStateStore?.readExternalQualificationState?.() || null; }
      catch { state = null; }
      if (!stateBoundToRelease(state, campaignReleaseAuthority)
        || JSON.stringify(state?.verifiedInspection)
          !== JSON.stringify(externalQualification?.inspection)) {
        return blocked('golden_campaign_qualification_state_not_current', [
          'golden_campaign_verified_qualification_state_required',
        ]);
      }
      let localInspection;
      try {
        localInspection = await localQualificationVerifier.verifyLocally({
          receipt: state.receipt,
          campaignReleaseAuthority,
          preparation,
          independentInspection: state.verifiedInspection,
          observedAt: now(),
        });
      } catch {
        localInspection = null;
      }
      const eligibility = localInspection?.kind === 'FullResearchQualificationInspection'
        && typeof evaluateEligibility === 'function'
        ? evaluateEligibility(localInspection) : null;
      if (localInspection?.status !== 'full_research_qualification_verified'
        || localInspection?.ready !== true
        || localInspection?.receiptAccepted !== true
        || localInspection?.fullDomainVerificationReady !== true
        || eligibility?.fullAutomaticResearchWritingReady !== true) {
        return blocked('golden_campaign_local_reverification_blocked', [
          'golden_campaign_local_full_domain_reverification_required',
          ...(localInspection?.blockers || []),
          ...(eligibility?.qualificationBlockers || []),
        ], localInspection);
      }
      let publication;
      let publicationLease = null;
      try {
        const publicationNow = now();
        publicationLease = receiptPointerRepository.tryAcquirePublicationLease({
          ownerId: `golden-qualification:${campaignReleaseAuthority.campaignId}`,
          leaseMs: 60_000,
          now: publicationNow,
        });
        if (!publicationLease) {
          throw new Error('full_research_qualification_pointer_publication_leased');
        }
        publication = receiptPointerRepository.publish({
          lease: publicationLease,
          receipt: state.receipt,
          qualificationStateHash: state.autonomousExternalQualificationStateHash,
          qualificationStateGeneration: state.generation,
          expectedRuntimeReceiptHash:
            state.receipt.runtimeImageReproducibilityReceiptHash,
          publisherFence: Object.freeze({
            scope: 'golden-campaign-qualification-controller',
            ownerId: publicationLease.ownerId,
            leaseGeneration: publicationLease.leaseGeneration,
          }),
          now: publicationNow,
        });
      } catch (error) {
        return blocked('golden_campaign_qualification_pointer_publication_blocked', [
          'golden_campaign_qualification_pointer_atomic_publication_required',
          String(error?.message || 'golden_campaign_qualification_pointer_publication_failed'),
        ], localInspection);
      } finally {
        if (publicationLease) {
          try {
            receiptPointerRepository.releasePublicationLease({ lease: publicationLease, now: now() });
          } catch { /* a stale publication owner must not affect the verified result */ }
        }
      }
      const payload = Object.freeze({
        version: 1,
        kind: 'GoldenCampaignQualificationPublicationReport',
        status: 'golden_campaign_qualification_published',
        ready: true,
        pointerPublished: true,
        inspection: localInspection,
        globalGoldenQualificationAuthorityInspection: globalGoldenAuthority,
        publication,
        blockers: Object.freeze([]),
      });
      return Object.freeze({
        ...payload,
        goldenCampaignQualificationPublicationReportHash:
          hashRecord('GoldenCampaignQualificationPublicationReport', payload),
      });
    },
  });
}
