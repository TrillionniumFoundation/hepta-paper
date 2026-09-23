import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
  fullResearchQualificationSigningPayloadHash,
} from './full-research-qualification-contract.mjs';
import {
  independentExternalResearchQualificationEvidenceHash,
} from './external-research-qualification-verification-evidence-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const sha = (value) => SHA256.test(String(value || '').toLowerCase());

function recordHashValid(record, kind, hashField) {
  const { [hashField]: claimedHash, ...payload } = record || {};
  return sha(claimedHash) && hashRecord(kind, payload) === claimedHash;
}

function independentEvidenceVerified(verifier, input) {
  if (typeof verifier !== 'function') return false;
  try { return verifier(input) === true; }
  catch { return false; }
}

export function autonomousSubmissionQualificationInspectionValid(
  inspection,
  releaseBinding,
  authority,
  manuscriptProofFields,
  {
    verifyIndependentQualificationEvidence = null,
    verificationTime = null,
  } = {},
) {
  const qualificationReceipt = inspection?.qualificationReceipt || null;
  const independentVerificationEvidence =
    inspection?.independentVerificationEvidence || null;
  const signingPayloadHash = fullResearchQualificationSigningPayloadHash(qualificationReceipt);
  return recordHashValid(
    inspection,
    'FullResearchQualificationInspection',
    'fullResearchQualificationInspectionHash',
  ) && recordHashValid(
    qualificationReceipt,
    'FullResearchGoldenMicroCampaignQualificationReceipt',
    'fullResearchQualificationReceiptHash',
  ) && sha(signingPayloadHash)
    && qualificationReceipt?.signer?.role === FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE
    && qualificationReceipt?.signer?.algorithm === 'ed25519'
    && typeof qualificationReceipt?.signature === 'string'
    && qualificationReceipt.signature.length > 0
    && inspection?.status === 'full_research_qualification_verified'
    && inspection?.ready === true
    && inspection?.receiptAccepted === true
    && inspection?.qualificationSignatureVerified === true
    && inspection?.qualificationTimeWindowVerified === true
    && inspection?.releasePointerVerified === true
    && inspection?.independentVerifierVerified === true
    && inspection?.fullDomainVerificationReady === true
    && sha(inspection?.externalVerificationRequestHash)
    && sha(
      independentVerificationEvidence
        ?.independentExternalResearchQualificationVerificationEvidenceHash,
    )
    && independentExternalResearchQualificationEvidenceHash(
      independentVerificationEvidence,
    ) === independentVerificationEvidence
      ?.independentExternalResearchQualificationVerificationEvidenceHash
    && inspection?.independentVerificationEvidenceHash
      === independentVerificationEvidence
        ?.independentExternalResearchQualificationVerificationEvidenceHash
    && independentVerificationEvidence?.request?.requestHash
      === inspection?.externalVerificationRequestHash
    && independentEvidenceVerified(verifyIndependentQualificationEvidence, {
      evidence: independentVerificationEvidence,
      receipt: qualificationReceipt,
      campaignReleaseAuthority: authority,
      releaseBinding,
      verificationTime,
      qualificationInspection: inspection,
    })
    && inspection?.qualificationReceiptHash
      === qualificationReceipt?.fullResearchQualificationReceiptHash
    && inspection?.campaignId === authority?.campaignId
    && inspection?.paperId === authority?.paperId
    && inspection?.campaignReleaseBundleHash === authority?.campaignReleaseBundleHash
    && inspection?.qualificationScope === releaseBinding?.qualificationScope
    && qualificationReceipt?.qualificationScope === releaseBinding?.qualificationScope
    && inspection?.genericContentCanaryVerified === true
    && qualificationReceipt?.genericContentCanaryVerified === true
    && releaseBinding?.genericContentCanaryVerified === true
    && manuscriptProofFields.every((field) => sha(inspection?.[field])
      && inspection[field] === qualificationReceipt?.[field]
      && inspection[field] === releaseBinding?.[field])
    && inspection?.venueProfileSelectionHash === releaseBinding?.venueProfileSelectionHash
    && inspection?.submissionMetadataReceiptHash
      === releaseBinding?.submissionMetadataReceiptHash;
}
