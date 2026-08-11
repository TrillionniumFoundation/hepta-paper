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
} = {}) {
  const observedAt = authorityObservedAt || request?.requestedAt || null;
  const { requestHash: claimedHash, ...payload } = request || {};
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
    verifyHumanAuthorization: humanAuthorizationVerifier,
    verify: (request) => verifyAutonomousSubmissionRequest(request, {
      verifyCurrentCampaignReleaseAuthority,
      verifyQualificationAuthority,
      verifyVenueComplianceAuthority,
      verifyPortalConfigurationAuthority,
      verifyQualificationSignature: qualificationSignatureVerifier,
      verifyIndependentQualificationEvidence: qualificationEvidenceVerifier,
      requireResearchClosure,
      verifyHumanAuthorization: humanAuthorizationVerifier,
      requireHumanAuthorization,
    }),
  });
}
export function buildAutonomousSubmissionReceipt({
  request,
  requestVerifier,
  portalSubmissionId,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
  submissionArtifactManifestHash,
  signatureHash,
  signatureVerificationReceiptHash,
  submittedAt,
} = {}) {
  const timestamp = String(submittedAt || '');
  if (requestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || requestVerifier.verify(request) !== true
    || !SAFE_ID.test(String(portalSubmissionId || ''))
    || ![
      portalAccountIdentityHash,
      portalTrustDomainIdentityHash,
      submissionArtifactManifestHash,
      signatureHash,
      signatureVerificationReceiptHash,
    ].every((value) => sha(value))
    || (request?.version === 7 && (
      portalAccountIdentityHash !== request.portalAccountIdentityHash
      || portalTrustDomainIdentityHash !== request.portalTrustDomainIdentityHash
      || !autonomousLiveSubmissionAuthorizationBinding(request, {
        observedAt: new Date(timestamp),
        verifyAuthorityDocument: (input) => requestVerifier.verifyHumanAuthorization?.({
          receipt: request.humanAuthorizationReceipt,
          expectedSubject: input.expectedSubject,
          observedAt: input.observedAt,
        }) === true,
      })
    ))
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error('autonomous_submission_receipt_invalid');
  }
  const payload = {
    version: 5,
    kind: 'AutonomousSubmissionReceipt',
    status: 'autonomous_submission_completed',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    campaignId: request.campaignId,
    paperId: request.paperId,
    venueId: request.venueId,
    campaignReleaseBundleHash: request.campaignReleaseBundleHash,
    qualificationReceiptHash: request.qualificationReceiptHash,
    venueComplianceReceiptHash: request.venueComplianceReceiptHash,
    ...(request.researchClosureReceiptHash ? {
      researchClosureReceiptHash: request.researchClosureReceiptHash,
    } : {}),
    ...(request.version === 7 ? {
      humanAuthorizationReceiptHash: request.humanAuthorizationReceiptHash,
      humanAuthorizationSubjectHash: request.humanAuthorizationSubjectHash,
      humanAuthorizationNonce: request.humanAuthorizationNonce,
      humanAuthorizationExpiresAt: request.humanAuthorizationExpiresAt,
    } : {}),
    submissionMetadataReceiptHash: request.submissionMetadataReceiptHash,
    qualificationScope: request.qualificationScope,
    manuscriptProductionMode: request.manuscriptProductionMode,
    ...Object.fromEntries(MANUSCRIPT_PROOF_FIELDS.map((field) => [field, request[field]])),
    portalSubmissionId: String(portalSubmissionId),
    portalAccountIdentityHash: sha(portalAccountIdentityHash),
    portalTrustDomainIdentityHash: sha(portalTrustDomainIdentityHash),
    submissionArtifactManifestHash: sha(submissionArtifactManifestHash),
    signatureHash: sha(signatureHash),
    signatureVerificationReceiptHash: sha(signatureVerificationReceiptHash),
    humanApprovalPerformed: request.version === 7,
    externalActionPerformed: true,
    submittedAt: timestamp,
  };
  return Object.freeze({
    ...payload,
    autonomousSubmissionReceiptHash:
      hashRecord('AutonomousSubmissionReceipt', payload),
  });
}
export function verifyAutonomousSubmissionReceipt(receipt, {
  request = null,
  requestVerifier = null,
  completedReceiptVerifier = null,
  requireCryptographicAuthority = false,
} = {}) {
  if (request?.version === 6 && receipt?.version !== 6) return false;
  if (receipt?.version === 6) {
    return completedReceiptVerifier?.kind
      === 'AutonomousSubmissionCompletedReceiptVerifier'
      && typeof completedReceiptVerifier.verify === 'function'
      && completedReceiptVerifier.verify({
        receipt,
        request,
        requestVerifier,
      }) === true;
  }
  if (requireCryptographicAuthority) return false;
  return verifyLegacyAutonomousSubmissionReceipt(receipt, {
    request,
    requestVerifier,
  });
}
export function verifyLegacyAutonomousSubmissionReceipt(receipt, {
  request = null,
  requestVerifier = null,
} = {}) {
  const { autonomousSubmissionReceiptHash: claimedHash, ...payload } = receipt || {};
  if (receipt?.version !== 5 || receipt?.kind !== 'AutonomousSubmissionReceipt'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousSubmissionReceipt', payload) !== claimedHash
    || requestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || requestVerifier.verify(request) !== true) return false;
  let rebuilt;
  try {
    rebuilt = buildAutonomousSubmissionReceipt({
      ...receipt,
      request,
      requestVerifier,
    });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(receipt)
    && receipt.requestHash === request.requestHash
    && receipt.idempotencyKey === request.idempotencyKey
    && (![6, 7].includes(request?.version)
      || receipt.researchClosureReceiptHash === request.researchClosureReceiptHash);
}
function submissionCompletedVerificationPolicyHash(configuration) {
  return hashRecord('AutonomousSubmissionCompletedReceiptVerificationPolicy', {
    verificationPolicy: 'pinned-canonical-json-ed25519-v1',
    portalConfigurationHash: configuration?.configurationHash || null,
    receiptTrustStoreHash: configuration?.receiptTrustStoreHash || null,
    receiptSignerKeyIds: configuration?.receiptSignerKeyIds || null,
    receiptSignerRole: configuration?.receiptSignerRole || null,
    receiptMaximumLifetimeMs: configuration?.receiptMaximumLifetimeMs || null,
  });
}
function portalVerificationConfigurationValid(configuration, request) {
  const { configurationHash: claimedHash, ...payload } = configuration || {};
  return [2, 3].includes(configuration?.version)
    && configuration?.kind === 'AutonomousSubmissionPortalConfiguration'
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousSubmissionPortalConfiguration', payload) === claimedHash
    && request?.portalConfigurationHash === claimedHash
    && configuration?.receiptSignerRole === 'autonomous_submission_portal'
    && Array.isArray(configuration?.receiptSignerKeyIds)
    && configuration.receiptSignerKeyIds.length > 0
    && SHA256.test(String(configuration?.receiptTrustStoreHash || ''))
    && Number.isSafeInteger(configuration?.receiptMaximumLifetimeMs)
    && configuration.receiptMaximumLifetimeMs >= 1_000;
}

function pinnedVerificationReceiptStructurallyValid(receipt, {
  subjectHash,
  envelopeHash,
  configuration,
} = {}) {
  const {
    pinnedExternalEvidenceVerificationReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  return receipt?.version === 1
    && receipt?.kind === 'PinnedExternalEvidenceVerificationReceipt'
    && receipt?.status === 'pinned_external_evidence_verified'
    && receipt?.verificationPolicy === 'pinned-canonical-json-ed25519-v1'
    && receipt?.subjectKind === 'AutonomousSubmissionReceiptV5'
    && receipt?.subjectHash === subjectHash
    && receipt?.requiredRole === configuration?.receiptSignerRole
    && receipt?.trustStoreHash === configuration?.receiptTrustStoreHash
    && receipt?.envelopeHash === envelopeHash
    && receipt?.cryptographicAuthorityReady === true
    && receipt?.externalActionPerformed === false
    && Array.isArray(receipt?.blockers) && receipt.blockers.length === 0
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('PinnedExternalEvidenceVerificationReceipt', payload) === claimedHash;
}

export function buildCryptographicAutonomousSubmissionReceipt({
  request,
  requestVerifier,
  legacyReceipt,
  authorityEnvelope,
  signatureVerificationReceipt,
  portalVerificationConfiguration,
} = {}) {
  const legacyReceiptHash = legacyReceipt?.autonomousSubmissionReceiptHash || null;
  const authorityEnvelopeHash = authorityEnvelope
    ? hashRecord('PinnedExternalEvidenceEnvelope', authorityEnvelope) : null;
  const signatureVerificationReceiptHash = signatureVerificationReceipt
    ?.pinnedExternalEvidenceVerificationReceiptHash || null;
  if (!verifyLegacyAutonomousSubmissionReceipt(legacyReceipt, {
    request,
    requestVerifier,
  }) || !portalVerificationConfigurationValid(portalVerificationConfiguration, request)
    || authorityEnvelope?.kind !== 'PinnedExternalEvidenceEnvelope'
    || authorityEnvelope?.subjectKind !== 'AutonomousSubmissionReceiptV5'
    || authorityEnvelope?.subjectHash !== legacyReceiptHash
    || !pinnedVerificationReceiptStructurallyValid(signatureVerificationReceipt, {
      subjectHash: legacyReceiptHash,
      envelopeHash: authorityEnvelopeHash,
      configuration: portalVerificationConfiguration,
    })) {
    throw new Error('cryptographic_autonomous_submission_receipt_invalid');
  }
  const payload = Object.freeze({
    version: 6,
    kind: 'AutonomousSubmissionReceipt',
    status: 'autonomous_submission_cryptographically_verified',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    campaignId: request.campaignId,
    paperId: request.paperId,
    venueId: request.venueId,
    ...(request.researchClosureReceiptHash ? {
      researchClosureReceiptHash: request.researchClosureReceiptHash,
    } : {}),
    ...(request.version === 7 ? {
      humanAuthorizationReceiptHash: request.humanAuthorizationReceiptHash,
      humanAuthorizationSubjectHash: request.humanAuthorizationSubjectHash,
      humanAuthorizationNonce: request.humanAuthorizationNonce,
      humanAuthorizationExpiresAt: request.humanAuthorizationExpiresAt,
    } : {}),
    portalSubmissionId: legacyReceipt.portalSubmissionId,
    portalAccountIdentityHash: legacyReceipt.portalAccountIdentityHash,
    portalTrustDomainIdentityHash: legacyReceipt.portalTrustDomainIdentityHash,
    portalConfigurationHash: portalVerificationConfiguration.configurationHash,
    legacyReceiptHash,
    legacyReceipt: Object.freeze({ ...legacyReceipt }),
    authorityEnvelopeHash,
    authorityEnvelope: Object.freeze({ ...authorityEnvelope }),
    signatureVerificationReceiptHash,
    signatureVerificationReceipt: Object.freeze({ ...signatureVerificationReceipt }),
    receiptTrustStoreHash: portalVerificationConfiguration.receiptTrustStoreHash,
    signatureVerificationPolicyHash:
      submissionCompletedVerificationPolicyHash(portalVerificationConfiguration),
    portalVerificationConfiguration: Object.freeze({
      ...portalVerificationConfiguration,
    }),
    cryptographicAuthorityReady: true,
    humanApprovalPerformed: request.version === 7,
    externalActionPerformed: true,
    submittedAt: legacyReceipt.submittedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousSubmissionReceiptHash: hashRecord(
      'AutonomousSubmissionReceiptV6',
      payload,
    ),
  });
}

export function verifyCryptographicAutonomousSubmissionReceiptStructure(receipt, {
  request = null,
  requestVerifier = null,
} = {}) {
  const { autonomousSubmissionReceiptHash: claimedHash, ...payload } = receipt || {};
  if (receipt?.version !== 6 || receipt?.kind !== 'AutonomousSubmissionReceipt'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousSubmissionReceiptV6', payload) !== claimedHash) return false;
  let rebuilt;
  try {
    rebuilt = buildCryptographicAutonomousSubmissionReceipt({
      request,
      requestVerifier,
      legacyReceipt: receipt.legacyReceipt,
      authorityEnvelope: receipt.authorityEnvelope,
      signatureVerificationReceipt: receipt.signatureVerificationReceipt,
      portalVerificationConfiguration: receipt.portalVerificationConfiguration,
    });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(receipt);
}

export function autonomousSubmissionCompletedReceiptVerificationPolicyHash(configuration) {
  return submissionCompletedVerificationPolicyHash(configuration);
}
