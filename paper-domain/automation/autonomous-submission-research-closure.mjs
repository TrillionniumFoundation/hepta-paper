import {
  buildResearchClosureReceipt,
  verifyResearchClosureReceipt,
} from './research-closure-receipt-contract.mjs';

export function autonomousSubmissionResearchClosureRequired({
  releaseBinding,
  requireResearchClosure = false,
} = {}) {
  return requireResearchClosure === true
    || releaseBinding?.externalSubmissionEligible === true
    || releaseBinding?.version === 4;
}

export function resolveAutonomousSubmissionResearchClosure({
  campaignId,
  paperId,
  venueId,
  campaignReleaseAuthority,
  qualificationInspection,
  venueComplianceReceipt,
  requestedAt,
  suppliedReceipt = null,
  requireResearchClosure = false,
  verifyQualificationSignature = null,
  verifyIndependentQualificationEvidence = null,
} = {}) {
  const releaseBinding = campaignReleaseAuthority?.releaseBundle
    ?.autonomousResearchReleaseBinding || null;
  const required = autonomousSubmissionResearchClosureRequired({
    releaseBinding,
    requireResearchClosure,
  });
  if (!required && !suppliedReceipt) return null;
  const receipt = suppliedReceipt || buildResearchClosureReceipt({
    campaignReleaseAuthority,
    qualificationInspection,
    venueComplianceReceipt,
    closedAt: requestedAt,
  }, {
    verifyQualificationSignature,
    verifyIndependentQualificationEvidence,
  });
  if (!verifyResearchClosureReceipt(receipt, {
    campaignId,
    paperId,
    venueId,
    campaignReleaseBundleHash: campaignReleaseAuthority?.campaignReleaseBundleHash,
    qualificationReceiptHash: qualificationInspection?.qualificationReceiptHash,
    venueComplianceReceiptHash:
      venueComplianceReceipt?.autonomousVenueComplianceReceiptHash,
  }, {
    verifyQualificationSignature,
    verifyIndependentQualificationEvidence,
  })
    || JSON.stringify(receipt.campaignReleaseAuthority)
      !== JSON.stringify(campaignReleaseAuthority)
    || JSON.stringify(receipt.qualificationInspection)
      !== JSON.stringify(qualificationInspection)
    || JSON.stringify(receipt.venueComplianceReceipt)
      !== JSON.stringify(venueComplianceReceipt)) {
    throw new Error('autonomous_submission_research_closure_invalid');
  }
  return receipt;
}

export function verifyAutonomousSubmissionResearchClosure({
  request,
  authority,
  releaseBundle,
  releaseBinding,
  venueComplianceReceipt,
  requireResearchClosure = false,
  verifyQualificationSignature = null,
  verifyIndependentQualificationEvidence = null,
} = {}) {
  const required = autonomousSubmissionResearchClosureRequired({
    releaseBinding,
    requireResearchClosure,
  });
  if (![6, 7].includes(request?.version)) return required === false;
  const receipt = request?.researchClosureReceipt || null;
  return verifyResearchClosureReceipt(receipt, {
    campaignId: request?.campaignId,
    paperId: request?.paperId,
    venueId: request?.venueId,
    campaignPlanHash: releaseBundle?.campaignPlanHash,
    campaignReleaseBundleHash: request?.campaignReleaseBundleHash,
    researchAgendaIrHash: releaseBinding?.researchAgendaIrHash,
    researchAgendaClaimBindingReceiptHash:
      releaseBinding?.researchAgendaClaimBindingReceiptHash,
    priorArtEvidenceReceiptHash: releaseBinding?.priorArtEvidenceReceiptHash,
    priorArtClaimAlignmentReceiptHash:
      releaseBinding?.priorArtClaimAlignmentReceiptHash,
    experimentIrExecutionAuthorityReceiptHash:
      releaseBinding?.experimentIrExecutionAuthorityReceiptHash,
    experimentReplayReceiptHash: releaseBinding?.experimentReplayReceiptHash,
    venueRequirementIrHash: releaseBinding?.venueRequirementIrHash,
    researchReportHash: releaseBinding?.researchReportHash,
    proposalClaimToTheoremBindingHash:
      releaseBinding?.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: releaseBinding?.experimentRegistryHash,
    qualificationReceiptHash: request?.qualificationReceiptHash,
    venueComplianceReceiptHash: request?.venueComplianceReceiptHash,
  }, {
    verifyQualificationSignature,
    verifyIndependentQualificationEvidence,
  })
    && request?.researchClosureReceiptHash === receipt?.researchClosureReceiptHash
    && JSON.stringify(receipt?.campaignReleaseAuthority) === JSON.stringify(authority)
    && JSON.stringify(receipt?.qualificationInspection)
      === JSON.stringify(request?.qualificationInspection)
    && JSON.stringify(receipt?.venueComplianceReceipt)
      === JSON.stringify(venueComplianceReceipt);
}
