export function academicEvidenceReady(researchReport = null) {
  return researchReport?.academicEvidenceStatus === 'academic_evidence_verified'
    && researchReport?.academicEvidenceEligible === true
    && researchReport?.academicEvidenceAttestation?.cryptographicSignaturesVerified === true
    && Number(researchReport?.academicEvidenceAttestation?.verifiedWorkerReceiptCount || 0) > 0
    && Number(researchReport?.executedResearchWorkerCount || 0) > 0;
}

export function independentRefereeAuthorityReady(authorityReceipt = null) {
  return authorityReceipt?.status === 'independent_referee_acceptance_verified'
    && authorityReceipt?.acceptanceAuthorityReady === true
    && authorityReceipt?.cryptographicSignaturesVerified === true
    && authorityReceipt?.safety?.academicAcceptanceAuthority === true
    && authorityReceipt?.safety?.independentReviewPerformed === true;
}

export function reviewAuthorityBlockers({ authorityReceipt = null } = {}) {
  return independentRefereeAuthorityReady(authorityReceipt)
    ? []
    : ['independent_referee_acceptance_authority_required'];
}
