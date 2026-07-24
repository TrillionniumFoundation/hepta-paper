import {
  verifyIndependentEvidenceEntailmentReviewReceipt,
} from './evidence-entailment-review-receipt-contract.mjs';

export function manuscriptPromotionEvidenceEntailmentValid(gate) {
  if (gate?.evidenceEntailmentReviewRequired !== true) return gate?.version !== 2;
  const receipt = gate?.independentEvidenceEntailmentReviewReceipt || null;
  const verification = verifyIndependentEvidenceEntailmentReviewReceipt(receipt, {
    paperId: gate?.paperId || null,
    evidenceEntailmentContractHash: gate?.evidenceEntailmentContractHash || null,
    evidenceBoundManuscriptIrHash:
      receipt?.evidenceBoundManuscriptIrHash || null,
    reviewedManuscriptHash: receipt?.reviewedManuscriptHash || null,
    authorPrincipalId: receipt?.authorPrincipalId || null,
    requireSignedReviewerEvidence: true,
  });
  return gate?.version === 2
    && verification.valid
    && gate?.independentEvidenceEntailmentReviewReceiptHash
      === receipt?.independentEvidenceEntailmentReviewReceiptHash
    && gate?.evidenceEntailmentContractHash
      === receipt?.evidenceEntailmentContractHash
    && gate?.evidenceEntailmentReviewVerification?.valid === true
    && gate?.evidenceEntailmentReviewVerification
      ?.independentEvidenceEntailmentReviewReceiptHash
        === receipt?.independentEvidenceEntailmentReviewReceiptHash;
}
