import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyAutonomousVenueProfileSelection } from './autonomous-venue-profile-contract.mjs';
import {
  verifyAutonomousVenueComplianceReceipt,
} from './autonomous-venue-compliance-contract.mjs';
import {
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
  verifyAutonomousResearchReleaseBinding,
} from './autonomous-research-release-binding-contract.mjs';
import {
  autonomousSubmissionQualificationInspectionValid,
} from './autonomous-submission-qualification-inspection.mjs';
import {
  resolveAutonomousSubmissionResearchClosure,
  verifyAutonomousSubmissionResearchClosure,
} from './autonomous-submission-research-closure.mjs';
import {
  autonomousLiveSubmissionAuthorizationBinding,
  buildAutonomousLiveSubmissionAuthorizationSubject,
} from '../submission/autonomous-live-submission-authorization-contract.mjs';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const MANUSCRIPT_PROOF_FIELDS = Object.freeze([
  'trustedAutonomousManuscriptRenderReceiptHash',
  'evidenceBoundManuscriptIrHash',
  'manuscriptIrFileHash',
  'renderedManuscriptHash',
  'agentExecutionReceiptHash',
  'isolatedAgentMergeReceiptHash',
  'agentAuthoredSourceDraftHash',
  'agentAuthoredSourceDraftFileHash',
  'agentWorkspacePostimageBindingHash',
]);
function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}
function recordHashValid(record, kind, hashField) {
  const { [hashField]: claimedHash, ...payload } = record || {};
  return Boolean(sha(claimedHash) && hashRecord(kind, payload) === claimedHash);
}
function failClosedVerifier(verifier) {
  return (input) => {
    try { return typeof verifier === 'function' && verifier(input) === true; }
    catch { return false; }
  };
}
export function buildAutonomousSubmissionRequest({
  campaignId,
  paperId,
  venueProfileSelection,
  campaignReleaseAuthority,
  qualificationInspection,
  venueComplianceReceipt,
  portalConfigurationHash,
  portalDescriptor = null,
  requestedAt,
  researchClosureReceipt = null,
  requireResearchClosure = false,
  humanAuthorizationReceipt = null,
  requireHumanAuthorization = false,
  verifyHumanAuthorization = null,
  verifyQualificationSignature = null,
  verifyIndependentQualificationEvidence = null,
  gpuScientificPromotionAuthorityVerifier = null,
  gpuScientificAuthorityVerificationTime = null,
} = {}) {
  const releaseBundle = campaignReleaseAuthority?.releaseBundle || null;
  const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
  const releaseBindingVerification = verifyAutonomousResearchReleaseBinding(releaseBinding, {
    campaignId,
    paperId,
    campaignPlanHash: releaseBundle?.campaignPlanHash,
    authorityObservedAt: requestedAt,
  });
  const timestamp = String(requestedAt || '');
  if (!SAFE_ID.test(String(campaignId || '')) || !SAFE_ID.test(String(paperId || ''))
    || !verifyAutonomousVenueProfileSelection(venueProfileSelection, {
      authorityObservedAt: requestedAt,
    })
    || venueProfileSelection.version !== 2
    || venueProfileSelection.profile.externalSubmissionEnabled !== true
    || !venueProfileSelection.profile.submissionPortalProfileId
    || campaignReleaseAuthority?.status !== 'current_completed_release'
    || campaignReleaseAuthority?.campaignId !== campaignId
    || campaignReleaseAuthority?.paperId !== paperId
    || releaseBundle?.campaignReleaseBundleHash
      !== campaignReleaseAuthority.campaignReleaseBundleHash
    || !recordHashValid(releaseBundle, 'CampaignReleaseBundle', 'campaignReleaseBundleHash')
    || !recordHashValid(
      releaseBundle?.packageOutput,
      'ImmutableCampaignPackageOutput',
      'immutableCampaignPackageOutputHash',
    )
    || releaseBundle?.venueTarget !== venueProfileSelection.venueId
    || !releaseBindingVerification.valid
    || releaseBinding?.qualificationScope
      !== PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
    || releaseBinding?.fullResearchQualificationEligible !== true
    || releaseBinding?.externalSubmissionEligible !== true
    || releaseBinding?.venueProfileSelectionHash
      !== venueProfileSelection.autonomousVenueProfileSelectionReceiptHash
    || releaseBinding?.venueProfileRankingReceiptHash
      !== venueProfileSelection.rankingReceipt?.autonomousVenueProfileRankingReceiptHash
    || qualificationInspection?.status !== 'full_research_qualification_verified'
    || qualificationInspection?.ready !== true
    || qualificationInspection?.campaignId !== campaignId
    || qualificationInspection?.paperId !== paperId
    || qualificationInspection?.campaignReleaseBundleHash
      !== campaignReleaseAuthority.campaignReleaseBundleHash
    || !sha(qualificationInspection?.qualificationReceiptHash)
    || qualificationInspection?.qualificationScope
      !== PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
    || MANUSCRIPT_PROOF_FIELDS.some((field) => (
      qualificationInspection?.[field] !== releaseBinding?.[field]
    ))
    || qualificationInspection?.venueProfileSelectionHash
      !== releaseBinding?.venueProfileSelectionHash
    || qualificationInspection?.submissionMetadataReceiptHash
      !== releaseBinding?.submissionMetadataReceiptHash
    || !autonomousSubmissionQualificationInspectionValid(
      qualificationInspection,
      releaseBinding,
      campaignReleaseAuthority,
      MANUSCRIPT_PROOF_FIELDS,
      { verifyIndependentQualificationEvidence, verificationTime: timestamp },
    )
    || !verifyAutonomousVenueComplianceReceipt(venueComplianceReceipt, {
      campaignReleaseAuthority,
      paperId,
      campaignId,
      venueId: venueProfileSelection.venueId,
      venueProfileSelectionHash:
        venueProfileSelection.autonomousVenueProfileSelectionReceiptHash,
      campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
      qualificationScope: PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
      trustedAutonomousManuscriptRenderReceiptHash:
        releaseBinding?.trustedAutonomousManuscriptRenderReceiptHash,
      evidenceBoundManuscriptIrHash: releaseBinding?.evidenceBoundManuscriptIrHash,
      manuscriptIrFileHash: releaseBinding?.manuscriptIrFileHash,
      renderedSourceHash: releaseBinding?.renderedManuscriptHash,
      agentExecutionReceiptHash: releaseBinding?.agentExecutionReceiptHash,
      isolatedAgentMergeReceiptHash:
        releaseBinding?.isolatedAgentMergeReceiptHash,
      agentWorkspacePostimageBindingHash:
        releaseBinding?.agentWorkspacePostimageBindingHash,
    })
    || !sha(portalConfigurationHash)
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error('autonomous_submission_request_invalid');
  }
  const closureReceipt = resolveAutonomousSubmissionResearchClosure({
    campaignId,
    paperId,
    venueId: venueProfileSelection.venueId,
    campaignReleaseAuthority,
    qualificationInspection,
    venueComplianceReceipt,
    requestedAt: timestamp,
    suppliedReceipt: researchClosureReceipt,
    requireResearchClosure,
    verifyQualificationSignature,
    verifyIndependentQualificationEvidence,
    gpuScientificPromotionAuthorityVerifier,
    gpuScientificAuthorityVerificationTime:
      gpuScientificAuthorityVerificationTime ?? timestamp,
  });
  let humanAuthorization = null;
  if (requireHumanAuthorization === true) {
    let expectedSubject = null;
    try {
      expectedSubject = buildAutonomousLiveSubmissionAuthorizationSubject({
        campaignId,
        paperId,
        immutableCampaignPackageOutputHash:
          releaseBundle.immutableCampaignPackageOutputHash,
        campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
        qualificationReceiptHash: qualificationInspection.qualificationReceiptHash,
        researchClosureReceiptHash: closureReceipt?.researchClosureReceiptHash,
        venueComplianceReceiptHash:
          venueComplianceReceipt.autonomousVenueComplianceReceiptHash,
        submissionMetadataReceiptHash:
          venueComplianceReceipt.submissionMetadataReceiptHash,
        venueProfileSelectionHash:
          venueProfileSelection.autonomousVenueProfileSelectionReceiptHash,
        venueId: venueProfileSelection.venueId,
        submissionPortalProfileId:
          venueProfileSelection.profile.submissionPortalProfileId,
        portalId: portalDescriptor?.portalId,
        portalConfigurationHash,
        portalDescriptorHash: portalDescriptor?.portalDescriptorHash,
        serviceIdentityHash: portalDescriptor?.serviceIdentityHash,
        portalAccountIdentityHash: portalDescriptor?.portalAccountIdentityHash,
        portalTrustDomainIdentityHash:
          portalDescriptor?.portalTrustDomainIdentityHash,
      });
    } catch {
      throw new Error('autonomous_submission_human_authorization_invalid');
    }
    if (typeof verifyHumanAuthorization !== 'function') {
      throw new Error('autonomous_submission_human_authorization_verifier_required');
    }
    try {
      if (verifyHumanAuthorization({
        receipt: humanAuthorizationReceipt,
        expectedSubject,
        observedAt: new Date(timestamp),
      }) !== true) {
        throw new Error('invalid');
      }
    } catch {
      throw new Error('autonomous_submission_human_authorization_invalid');
    }
    humanAuthorization = Object.freeze({
      receipt: humanAuthorizationReceipt,
      subject: expectedSubject,
    });
  }
  const payload = {
    version: humanAuthorization ? 7 : closureReceipt ? 6 : 5,
    kind: 'AutonomousSubmissionRequest',
    campaignId: String(campaignId),
    paperId: String(paperId),
    venueId: venueProfileSelection.venueId,
    venueProfileHash: venueProfileSelection.venueProfileHash,
    venueProfileSelectionHash:
      venueProfileSelection.autonomousVenueProfileSelectionReceiptHash,
    venueProfileRankingReceiptHash:
      venueProfileSelection.rankingReceipt.autonomousVenueProfileRankingReceiptHash,
    venueSelectorConfigurationHash:
      venueProfileSelection.rankingReceipt.selectorConfigurationHash,
    venueAuthorityConfigurationHash:
      venueProfileSelection.venueAuthorityConfigurationHash,
    submissionPortalProfileId:
      venueProfileSelection.profile.submissionPortalProfileId,
    venueProfileSelection,
    campaignReleaseAuthority,
    autonomousResearchReleaseBinding: releaseBinding,
    qualificationInspection,
    venueComplianceReceipt,
    ...(closureReceipt ? {
      researchClosureReceiptHash: closureReceipt.researchClosureReceiptHash,
      researchClosureReceipt: closureReceipt,
    } : {}),
    campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
    immutableCampaignPackageOutputHash:
      sha(releaseBundle.immutableCampaignPackageOutputHash),
    sourceSnapshotHash: sha(releaseBundle.sourceSnapshotHash),
    sourceTreeManifestHash: sha(releaseBundle.sourceTreeManifestHash),
    researchEvidenceCapsuleManifestHash:
      sha(releaseBundle.researchEvidenceCapsuleManifestHash),
    qualificationReceiptHash: sha(qualificationInspection.qualificationReceiptHash),
    qualificationScope: releaseBinding.qualificationScope,
    manuscriptProductionMode: releaseBinding.manuscriptProductionMode,
    ...Object.fromEntries(MANUSCRIPT_PROOF_FIELDS.map((field) => (
      [field, releaseBinding[field]]
    ))),
    venueComplianceReceiptHash:
      venueComplianceReceipt.autonomousVenueComplianceReceiptHash,
    submissionMetadataReceiptHash:
      venueComplianceReceipt.submissionMetadataReceiptHash,
    submissionMetadataAuthorityConfigurationHash:
      releaseBinding.submissionMetadataAuthorityConfigurationHash,
    renderedSourceHash: venueComplianceReceipt.renderedSourceHash,
    compiledPdfHash: venueComplianceReceipt.compiledPdfHash,
    independentRebuiltPdfHash: venueComplianceReceipt.independentRebuiltPdfHash,
    pageCount: venueComplianceReceipt.pageCount,
    portalConfigurationHash: sha(portalConfigurationHash),
    ...(humanAuthorization ? {
      portalId: portalDescriptor.portalId,
      portalDescriptorHash: portalDescriptor.portalDescriptorHash,
      portalServiceIdentityHash: portalDescriptor.serviceIdentityHash,
      portalAccountIdentityHash: portalDescriptor.portalAccountIdentityHash,
      portalTrustDomainIdentityHash:
        portalDescriptor.portalTrustDomainIdentityHash,
      humanAuthorizationReceiptHash:
        humanAuthorization.receipt.liveSubmissionAuthorizationReceiptHash,
      humanAuthorizationSubjectHash:
        humanAuthorization.subject.liveSubmissionAuthorizationSubjectHash,
      humanAuthorizationNonce: humanAuthorization.receipt.nonce,
      humanAuthorizationExpiresAt: humanAuthorization.receipt.expiresAt,
      humanAuthorizationReceipt: humanAuthorization.receipt,
    } : {}),
    idempotencyKey: hashRecord('AutonomousSubmissionIdempotencyKey', {
      immutableCampaignPackageOutputHash:
        sha(releaseBundle.immutableCampaignPackageOutputHash),
      venueId: venueProfileSelection.venueId,
      campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
      venueProfileHash: venueProfileSelection.venueProfileHash,
      venueProfileRankingReceiptHash:
        venueProfileSelection.rankingReceipt.autonomousVenueProfileRankingReceiptHash,
      venueSelectorConfigurationHash:
        venueProfileSelection.rankingReceipt.selectorConfigurationHash,
      venueAuthorityConfigurationHash:
        venueProfileSelection.venueAuthorityConfigurationHash,
      qualificationReceiptHash: qualificationInspection.qualificationReceiptHash,
      submissionMetadataReceiptHash:
        venueComplianceReceipt.submissionMetadataReceiptHash,
      submissionMetadataAuthorityConfigurationHash:
        releaseBinding.submissionMetadataAuthorityConfigurationHash,
      trustedAutonomousManuscriptRenderReceiptHash:
        releaseBinding.trustedAutonomousManuscriptRenderReceiptHash,
      evidenceBoundManuscriptIrHash: releaseBinding.evidenceBoundManuscriptIrHash,
      manuscriptIrFileHash: releaseBinding.manuscriptIrFileHash,
      renderedManuscriptHash: releaseBinding.renderedManuscriptHash,
      agentExecutionReceiptHash: releaseBinding.agentExecutionReceiptHash,
      isolatedAgentMergeReceiptHash: releaseBinding.isolatedAgentMergeReceiptHash,
      agentAuthoredSourceDraftHash: releaseBinding.agentAuthoredSourceDraftHash,
      agentAuthoredSourceDraftFileHash:
        releaseBinding.agentAuthoredSourceDraftFileHash,
      agentWorkspacePostimageBindingHash:
        releaseBinding.agentWorkspacePostimageBindingHash,
      venueComplianceReceiptHash:
        venueComplianceReceipt.autonomousVenueComplianceReceiptHash,
      ...(closureReceipt ? {
        researchClosureReceiptHash: closureReceipt.researchClosureReceiptHash,
      } : {}),
      portalConfigurationHash,
      ...(humanAuthorization ? {
        portalId: portalDescriptor.portalId,
        portalDescriptorHash: portalDescriptor.portalDescriptorHash,
        portalServiceIdentityHash: portalDescriptor.serviceIdentityHash,
        portalAccountIdentityHash: portalDescriptor.portalAccountIdentityHash,
        portalTrustDomainIdentityHash:
          portalDescriptor.portalTrustDomainIdentityHash,
        humanAuthorizationReceiptHash:
          humanAuthorization.receipt.liveSubmissionAuthorizationReceiptHash,
        humanAuthorizationSubjectHash:
          humanAuthorization.subject.liveSubmissionAuthorizationSubjectHash,
        humanAuthorizationNonce: humanAuthorization.receipt.nonce,
        humanAuthorizationExpiresAt: humanAuthorization.receipt.expiresAt,
      } : {}),
    }),
    humanApprovalPerformed: humanAuthorization !== null,
    requestedAt: timestamp,
  };
  if ([
    payload.immutableCampaignPackageOutputHash,
    payload.sourceSnapshotHash,
    payload.sourceTreeManifestHash,
    payload.researchEvidenceCapsuleManifestHash,
  ].some((value) => !value)) throw new Error('autonomous_submission_release_evidence_invalid');
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousSubmissionRequest', payload),
  });
}
export function verifyAutonomousSubmissionRequest(request, {
  verifyCurrentCampaignReleaseAuthority = null,
  verifyQualificationAuthority = null,
  verifyVenueComplianceAuthority = null,
  verifyPortalConfigurationAuthority = null,
  verifyQualificationSignature = null,
  authorityObservedAt = null,
  requireResearchClosure = false,
  requireHumanAuthorization = false,
  verifyHumanAuthorization = null,
  verifyIndependentQualificationEvidence = null,
  gpuScientificPromotionAuthorityVerifier = null,
  gpuScientificAuthorityVerificationTime = null,
} = {}) {
  const observedAt = authorityObservedAt || request?.requestedAt || null;
  const { requestHash: claimedHash, ...payload } = request || {};
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousSubmissionRequest', payload) !== claimedHash) return false;
  const expectedIdempotencyKey = hashRecord('AutonomousSubmissionIdempotencyKey', {
    immutableCampaignPackageOutputHash: request?.immutableCampaignPackageOutputHash,
    venueId: request?.venueId,
    campaignReleaseBundleHash: request?.campaignReleaseBundleHash,
    venueProfileHash: request?.venueProfileHash,
    venueProfileRankingReceiptHash: request?.venueProfileRankingReceiptHash,
    venueSelectorConfigurationHash: request?.venueSelectorConfigurationHash,
    venueAuthorityConfigurationHash: request?.venueAuthorityConfigurationHash,
    qualificationReceiptHash: request?.qualificationReceiptHash,
    submissionMetadataReceiptHash: request?.submissionMetadataReceiptHash,
    submissionMetadataAuthorityConfigurationHash:
      request?.submissionMetadataAuthorityConfigurationHash,
    trustedAutonomousManuscriptRenderReceiptHash:
      request?.trustedAutonomousManuscriptRenderReceiptHash,
    evidenceBoundManuscriptIrHash: request?.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: request?.manuscriptIrFileHash,
    renderedManuscriptHash: request?.renderedManuscriptHash,
    agentExecutionReceiptHash: request?.agentExecutionReceiptHash,
    isolatedAgentMergeReceiptHash: request?.isolatedAgentMergeReceiptHash,
    agentAuthoredSourceDraftHash: request?.agentAuthoredSourceDraftHash,
    agentAuthoredSourceDraftFileHash: request?.agentAuthoredSourceDraftFileHash,
    agentWorkspacePostimageBindingHash:
      request?.agentWorkspacePostimageBindingHash,
    venueComplianceReceiptHash: request?.venueComplianceReceiptHash,
    ...([6, 7].includes(request?.version) ? {
      researchClosureReceiptHash: request?.researchClosureReceiptHash,
    } : {}),
    portalConfigurationHash: request?.portalConfigurationHash,
    ...(request?.version === 7 ? {
      portalId: request?.portalId,
      portalDescriptorHash: request?.portalDescriptorHash,
      portalServiceIdentityHash: request?.portalServiceIdentityHash,
      portalAccountIdentityHash: request?.portalAccountIdentityHash,
      portalTrustDomainIdentityHash: request?.portalTrustDomainIdentityHash,
      humanAuthorizationReceiptHash: request?.humanAuthorizationReceiptHash,
      humanAuthorizationSubjectHash: request?.humanAuthorizationSubjectHash,
      humanAuthorizationNonce: request?.humanAuthorizationNonce,
      humanAuthorizationExpiresAt: request?.humanAuthorizationExpiresAt,
    } : {}),
  });
  const authority = request?.campaignReleaseAuthority || null;
  const releaseBundle = authority?.releaseBundle || null;
  const releaseBinding = request?.autonomousResearchReleaseBinding || null;
  const venueSelection = request?.venueProfileSelection || null;
  const venueCompliance = request?.venueComplianceReceipt || null;
  const recursiveAuthorityValid = authority?.status === 'current_completed_release'
    && authority?.campaignId === request?.campaignId
    && authority?.paperId === request?.paperId
    && authority?.campaignReleaseBundleHash === request?.campaignReleaseBundleHash
    && releaseBundle?.campaignReleaseBundleHash === request?.campaignReleaseBundleHash
    && recordHashValid(releaseBundle, 'CampaignReleaseBundle', 'campaignReleaseBundleHash')
    && recordHashValid(
      releaseBundle?.packageOutput,
      'ImmutableCampaignPackageOutput',
      'immutableCampaignPackageOutputHash',
    )
    && releaseBundle?.autonomousResearchReleaseBindingHash
      === releaseBinding?.autonomousResearchReleaseBindingHash
    && JSON.stringify(releaseBundle?.autonomousResearchReleaseBinding)
      === JSON.stringify(releaseBinding)
    && verifyAutonomousResearchReleaseBinding(releaseBinding, {
      campaignId: request?.campaignId,
      paperId: request?.paperId,
      campaignPlanHash: releaseBundle?.campaignPlanHash,
      qualificationScope: PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
      fullResearchQualificationEligible: true,
      externalSubmissionEligible: true,
      authorityObservedAt: observedAt,
    }).valid;
  const recursiveVenueValid = verifyAutonomousVenueProfileSelection(venueSelection, {
    authorityObservedAt: observedAt,
  })
    && venueSelection?.version === 2
    && venueSelection?.venueId === request?.venueId
    && venueSelection?.autonomousVenueProfileSelectionReceiptHash
      === request?.venueProfileSelectionHash
    && venueSelection?.rankingReceipt?.autonomousVenueProfileRankingReceiptHash
      === request?.venueProfileRankingReceiptHash
    && venueSelection?.rankingReceipt?.selectorConfigurationHash
      === request?.venueSelectorConfigurationHash
    && venueSelection?.venueAuthorityConfigurationHash
      === request?.venueAuthorityConfigurationHash
    && verifyAutonomousVenueComplianceReceipt(venueCompliance, {
      campaignReleaseAuthority: authority,
      paperId: request?.paperId,
      campaignId: request?.campaignId,
      venueId: request?.venueId,
      campaignReleaseBundleHash: request?.campaignReleaseBundleHash,
      venueProfileSelectionHash: request?.venueProfileSelectionHash,
      submissionMetadataReceiptHash: request?.submissionMetadataReceiptHash,
      qualificationScope: request?.qualificationScope,
      trustedAutonomousManuscriptRenderReceiptHash:
        request?.trustedAutonomousManuscriptRenderReceiptHash,
      evidenceBoundManuscriptIrHash: request?.evidenceBoundManuscriptIrHash,
      manuscriptIrFileHash: request?.manuscriptIrFileHash,
      renderedSourceHash: request?.renderedManuscriptHash,
      agentExecutionReceiptHash: request?.agentExecutionReceiptHash,
      isolatedAgentMergeReceiptHash: request?.isolatedAgentMergeReceiptHash,
      agentWorkspacePostimageBindingHash:
        request?.agentWorkspacePostimageBindingHash,
      ...([6, 7].includes(request?.version) ? {
        autonomousResearchReleaseBindingHash:
          releaseBinding?.autonomousResearchReleaseBindingHash,
        researchAgendaIrHash: releaseBinding?.researchAgendaIrHash,
        venueRequirementIrHash: releaseBinding?.venueRequirementIrHash,
      } : {}),
    });
  const recursiveResearchClosureValid = verifyAutonomousSubmissionResearchClosure({
    request,
    authority,
    releaseBundle,
    releaseBinding,
    venueComplianceReceipt: venueCompliance,
    requireResearchClosure,
    verifyQualificationSignature,
    verifyIndependentQualificationEvidence,
    gpuScientificPromotionAuthorityVerifier,
    gpuScientificAuthorityVerificationTime:
      gpuScientificAuthorityVerificationTime ?? observedAt,
  });
  const humanAuthorizationBinding = request?.version === 7
    ? autonomousLiveSubmissionAuthorizationBinding(request, {
      observedAt: new Date(observedAt),
      verifyAuthorityDocument: typeof verifyHumanAuthorization === 'function'
        ? (input) => verifyHumanAuthorization({
          receipt: request?.humanAuthorizationReceipt,
          expectedSubject: input.expectedSubject,
          observedAt: input.observedAt,
        }) : null,
    }) : null;
  const structurallyValid = [5, 6, 7].includes(request?.version)
    && request?.kind === 'AutonomousSubmissionRequest'
    && (requireResearchClosure !== true || [6, 7].includes(request?.version))
    && (![6, 7].includes(request?.version) || releaseBinding?.version === 4)
    && (requireHumanAuthorization !== true || request?.version === 7)
    && (request?.version !== 7 || Boolean(humanAuthorizationBinding))
    && recursiveResearchClosureValid
    && recursiveAuthorityValid
    && recursiveVenueValid
    && autonomousSubmissionQualificationInspectionValid(
      request?.qualificationInspection,
      releaseBinding,
      authority,
      MANUSCRIPT_PROOF_FIELDS,
      { verifyIndependentQualificationEvidence, verificationTime: observedAt },
    )
    && request?.immutableCampaignPackageOutputHash
      === releaseBundle?.immutableCampaignPackageOutputHash
    && request?.sourceSnapshotHash === releaseBundle?.sourceSnapshotHash
    && request?.sourceTreeManifestHash === releaseBundle?.sourceTreeManifestHash
    && request?.researchEvidenceCapsuleManifestHash
      === releaseBundle?.researchEvidenceCapsuleManifestHash
    && request?.qualificationReceiptHash
      === request?.qualificationInspection?.qualificationReceiptHash
    && request?.venueComplianceReceiptHash
      === venueCompliance?.autonomousVenueComplianceReceiptHash
    && request?.submissionMetadataReceiptHash
      === venueCompliance?.submissionMetadataReceiptHash
    && request?.submissionMetadataAuthorityConfigurationHash
      === releaseBinding?.submissionMetadataAuthorityConfigurationHash
    && request?.renderedSourceHash === venueCompliance?.renderedSourceHash
    && request?.compiledPdfHash === venueCompliance?.compiledPdfHash
    && request?.independentRebuiltPdfHash === venueCompliance?.independentRebuiltPdfHash
    && request?.pageCount === venueCompliance?.pageCount
    && request?.venueProfileHash === venueSelection?.venueProfileHash
    && request?.submissionPortalProfileId
      === venueSelection?.profile?.submissionPortalProfileId
    && request?.idempotencyKey === expectedIdempotencyKey
    && sha(request?.venueComplianceReceiptHash)
    && sha(request?.submissionMetadataReceiptHash)
    && sha(request?.venueProfileRankingReceiptHash)
    && sha(request?.venueSelectorConfigurationHash)
    && sha(request?.venueAuthorityConfigurationHash)
    && sha(request?.submissionMetadataAuthorityConfigurationHash)
    && sha(request?.immutableCampaignPackageOutputHash)
    && sha(request?.sourceSnapshotHash)
    && sha(request?.sourceTreeManifestHash)
    && sha(request?.researchEvidenceCapsuleManifestHash)
    && sha(request?.qualificationReceiptHash)
    && sha(request?.portalConfigurationHash)
    && (![6, 7].includes(request?.version) || sha(request?.researchClosureReceiptHash))
    && (request?.version !== 7 || (
      sha(request?.portalDescriptorHash)
      && sha(request?.portalServiceIdentityHash)
      && sha(request?.portalAccountIdentityHash)
      && sha(request?.portalTrustDomainIdentityHash)
      && sha(request?.humanAuthorizationReceiptHash)
      && sha(request?.humanAuthorizationSubjectHash)
      && request?.humanApprovalPerformed === true
    ))
    && request?.qualificationScope === PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
    && request?.manuscriptProductionMode === 'agent-authored-evidence-bound-ir-v1'
    && MANUSCRIPT_PROOF_FIELDS.every((field) => sha(request?.[field]))
    && sha(request?.renderedSourceHash)
    && sha(request?.compiledPdfHash)
    && sha(request?.independentRebuiltPdfHash)
    && Number.isSafeInteger(request?.pageCount) && request.pageCount > 0
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousSubmissionRequest', payload) === claimedHash;
  if (!structurallyValid
    || typeof verifyCurrentCampaignReleaseAuthority !== 'function'
    || typeof verifyQualificationAuthority !== 'function'
    || typeof verifyVenueComplianceAuthority !== 'function'
    || typeof verifyPortalConfigurationAuthority !== 'function') return false;
  try {
    return verifyCurrentCampaignReleaseAuthority({
      campaignReleaseAuthority: authority,
      request,
    }) === true && verifyVenueComplianceAuthority({
      venueComplianceReceipt: venueCompliance,
      venueProfileSelection: venueSelection,
      campaignReleaseAuthority: authority,
      autonomousResearchReleaseBinding: releaseBinding,
      request,
    }) === true && verifyQualificationAuthority({
      qualificationInspection: request.qualificationInspection,
      qualificationReceipt: request.qualificationInspection?.qualificationReceipt || null,
      campaignReleaseAuthority: authority,
      autonomousResearchReleaseBinding: releaseBinding,
      request,
    }) === true && verifyPortalConfigurationAuthority({
      portalConfigurationHash: request.portalConfigurationHash,
      campaignReleaseAuthority: authority,
      autonomousResearchReleaseBinding: releaseBinding,
      request,
    }) === true;
  } catch { return false; }
}
export function createAutonomousSubmissionRequestVerifier({
  verifyCurrentCampaignReleaseAuthority,
  verifyQualificationAuthority,
  verifyVenueComplianceAuthority,
  verifyPortalConfigurationAuthority,
  verifyQualificationSignature = null,
  verifyIndependentQualificationEvidence = null,
  gpuScientificPromotionAuthorityVerifier = null,
  gpuScientificAuthorityVerificationTimeProvider = null,
  requireResearchClosure = false,
  verifyHumanAuthorization = null,
  requireHumanAuthorization = false,
} = {}) {
  if (typeof verifyCurrentCampaignReleaseAuthority !== 'function'
    || typeof verifyQualificationAuthority !== 'function'
    || typeof verifyVenueComplianceAuthority !== 'function'
    || typeof verifyPortalConfigurationAuthority !== 'function'
    || (requireResearchClosure === true
      && (typeof verifyQualificationSignature !== 'function'
      || typeof verifyIndependentQualificationEvidence !== 'function'))
    || (requireHumanAuthorization === true
      && typeof verifyHumanAuthorization !== 'function')) {
    throw new Error('autonomous_submission_request_trust_verifier_required');
  }
  const qualificationSignatureVerifier =
    failClosedVerifier(verifyQualificationSignature);
  const qualificationEvidenceVerifier =
    failClosedVerifier(verifyIndependentQualificationEvidence);
  const humanAuthorizationVerifier = failClosedVerifier(verifyHumanAuthorization);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verifyQualificationSignature: qualificationSignatureVerifier,
    verifyIndependentQualificationEvidence: qualificationEvidenceVerifier,
    gpuScientificPromotionAuthorityVerifier,
    verifyHumanAuthorization: humanAuthorizationVerifier,
    verify(request) {
      let gpuScientificAuthorityVerificationTime = request?.requestedAt || null;
      if (typeof gpuScientificAuthorityVerificationTimeProvider === 'function') {
        try {
          gpuScientificAuthorityVerificationTime =
            gpuScientificAuthorityVerificationTimeProvider();
        } catch { return false; }
      }
      return verifyAutonomousSubmissionRequest(request, {
        verifyCurrentCampaignReleaseAuthority,
        verifyQualificationAuthority,
        verifyVenueComplianceAuthority,
        verifyPortalConfigurationAuthority,
        verifyQualificationSignature: qualificationSignatureVerifier,
        verifyIndependentQualificationEvidence: qualificationEvidenceVerifier,
        gpuScientificPromotionAuthorityVerifier,
        gpuScientificAuthorityVerificationTime,
        requireResearchClosure,
        verifyHumanAuthorization: humanAuthorizationVerifier,
        requireHumanAuthorization,
      });
    },
  });
}
export {
  autonomousSubmissionCompletedReceiptVerificationPolicyHash,
  buildAutonomousSubmissionReceipt,
  buildCryptographicAutonomousSubmissionReceipt,
  verifyAutonomousSubmissionReceipt,
  verifyCryptographicAutonomousSubmissionReceiptStructure,
  verifyLegacyAutonomousSubmissionReceipt,
} from './autonomous-submission-receipt-contract.mjs';
