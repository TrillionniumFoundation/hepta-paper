import {
  hashPaperRecord,
  validatePaperProposalApprovalDocument,
} from '../../paper-domain/contracts/index.mjs';
import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  loadAuthorityTrustStore,
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';

export const PROPOSAL_APPROVAL_MAXIMUM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export async function verifyPaperProposalApproval({
  ideaBrief,
  proposalEnvelope,
  generationReceipt,
  approvalDocument = null,
  runtimeRoot = null,
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const bindingVerification = validatePaperProposalApprovalDocument({
    ideaBrief,
    proposalEnvelope,
    generationReceipt,
    approvalDocument,
  });
  const trustStore = await loadAuthorityTrustStore({ runtimeRoot, trustStoreOverride });
  const signatureVerification = verifyAuthoritySignatures({
    document: approvalDocument,
    trustStore,
    requiredRoles: ['proposal_approver'],
    minSignatures: 1,
    requireDistinctSubjects: true,
  });
  const timeWindowVerification = verifyAuthorityTimeWindow({
    signedAt: approvalDocument?.signedAt,
    validFrom: approvalDocument?.validFrom,
    expiresAt: approvalDocument?.expiresAt,
    now,
    maximumLifetimeMs: PROPOSAL_APPROVAL_MAXIMUM_LIFETIME_MS,
  });
  const blockers = [
    ...bindingVerification.blockers,
    ...signatureVerification.blockers,
    ...timeWindowVerification.blockers,
  ];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const signedAtMs = Date.parse(String(approvalDocument?.signedAt || ''));
  const validFromMs = Date.parse(String(approvalDocument?.validFrom || ''));
  if (Number.isFinite(signedAtMs) && Number.isFinite(nowMs) && signedAtMs > nowMs) {
    blockers.push('proposal_approval_signed_in_future');
  }
  if (Number.isFinite(signedAtMs) && Number.isFinite(validFromMs) && validFromMs < signedAtMs) {
    blockers.push('proposal_approval_valid_from_precedes_signature');
  }
  const operatorSubjectId = String(approvalDocument?.operatorIdentity?.subjectId || '');
  const operatorSignature = signatureVerification.verifiedSignatures.find((signature) => (
    signature.role === 'proposal_approver' && signature.subjectId === operatorSubjectId
  ));
  if (!operatorSignature) blockers.push('proposal_approval_operator_not_verified_signer');
  const approvalDocumentHash = approvalDocument && typeof approvalDocument === 'object'
    ? hashPaperRecord('PaperProposalApprovalDocument', approvalDocument)
    : null;
  const uniqueBlockers = uniqueStrings(blockers, 64);
  const receipt = {
    version: 1,
    kind: 'PaperProposalApprovalVerificationReceipt',
    status: uniqueBlockers.length ? 'proposal_approval_blocked' : 'proposal_approval_verified',
    paperId: proposalEnvelope?.paperId || null,
    proposalEnvelopeHash: proposalEnvelope?.paperProposalEnvelopeHash || null,
    generationReceiptHash: generationReceipt?.paperProposalGenerationReceiptHash || null,
    approvalDocumentHash,
    targetVenue: bindingVerification.binding.targetVenue,
    contributionClaimHashes: [...bindingVerification.binding.contributionClaimHashes],
    qualityProfiles: [...bindingVerification.binding.qualityProfiles],
    riskHashes: [...bindingVerification.binding.riskHashes],
    operatorIdentity: approvalDocument?.operatorIdentity || null,
    signatureVerification,
    timeWindowVerification,
    blockers: uniqueBlockers,
    verifiedAt: new Date(nowMs).toISOString(),
  };
  return {
    ...receipt,
    paperProposalApprovalVerificationReceiptHash: hashPaperRecord(
      'PaperProposalApprovalVerificationReceipt',
      receipt,
    ),
  };
}
