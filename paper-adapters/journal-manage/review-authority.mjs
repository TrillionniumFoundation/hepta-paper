export function academicEvidenceReady(researchReport = null) {
  return researchReport?.academicEvidenceStatus === 'academic_evidence_verified'
    && researchReport?.academicEvidenceEligible === true;
}

export function independentRefereeAuthorityReady(refereePool = null) {
  return refereePool?.safety?.academicAcceptanceAuthority === true
    && refereePool?.safety?.independentReviewPerformed === true
    && (
      refereePool?.safety?.humanReviewPerformed === true
      || refereePool?.safety?.modelCallPerformed === true
    );
}

export function reviewAuthorityBlockers({ refereePool = null } = {}) {
  return independentRefereeAuthorityReady(refereePool)
    ? []
    : ['independent_referee_review_not_performed'];
}
