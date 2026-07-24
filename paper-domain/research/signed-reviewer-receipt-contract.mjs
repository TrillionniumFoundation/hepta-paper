import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  evaluateExternalPrincipalIdentitySeparation,
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../evidence/external-principal-identity-attestation-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;

export const REVIEWER_RECEIPT_SIGNER_ROLE = 'reviewer_receipt_attestor';
export const REVIEWER_RECEIPT_SIGNING_SUBJECT_KIND = 'ReviewerReceiptSigningSubjectV1';
export const REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND =
  'ExternalPrincipalIdentityAttestationSubject';
const liveCryptographicReviewerReceipts = new WeakSet();

function pinnedVerificationReceiptValid(receipt, {
  subjectKind,
  subjectHash,
  requiredRole,
  envelopeHash,
} = {}) {
  const {
    pinnedExternalEvidenceVerificationReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  return receipt?.version === 1
    && receipt?.kind === 'PinnedExternalEvidenceVerificationReceipt'
    && receipt?.status === 'pinned_external_evidence_verified'
    && receipt?.cryptographicAuthorityReady === true
    && receipt?.subjectKind === subjectKind
    && receipt?.subjectHash === subjectHash
    && receipt?.requiredRole === requiredRole
    && receipt?.envelopeHash === envelopeHash
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('PinnedExternalEvidenceVerificationReceipt', payload) === claimedHash;
}

function identitySeparationReceiptValid(receipt, candidateSubjectHash) {
  const {
    externalPrincipalIdentitySeparationReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  return receipt?.version === 1
    && receipt?.kind === 'ExternalPrincipalIdentitySeparationReceipt'
    && receipt?.status === 'external_principal_identity_separation_verified'
    && receipt?.identityIndependenceReady === true
    && receipt?.candidateIdentitySubjectHash === candidateSubjectHash
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('ExternalPrincipalIdentitySeparationReceipt', payload) === claimedHash;
}

export function reviewerReceiptSigningSubject({
  unsignedAgentExecutionReceiptHash,
  principalDescriptorHash,
  researchPrincipalPoolHash,
} = {}) {
  if (![unsignedAgentExecutionReceiptHash, principalDescriptorHash, researchPrincipalPoolHash]
    .every((value) => SHA256.test(String(value || '')))) {
    throw new Error('reviewer_receipt_signing_subject_invalid');
  }
  return hashRecord('ReviewerReceiptSigningSubject', {
    unsignedAgentExecutionReceiptHash,
    principalDescriptorHash,
    researchPrincipalPoolHash,
  });
}

export function buildSignedReviewerReceipt({
  subjectHash,
  principalId,
  principalDescriptorHash,
  researchPrincipalPoolHash,
  signerIdentityHash,
  signatureHash,
  signatureVerificationReceiptHash,
  signedAt,
} = {}) {
  const timestamp = String(signedAt || '');
  if (!SHA256.test(String(subjectHash || ''))
    || !SAFE_ID.test(String(principalId || ''))
    || ![
      principalDescriptorHash,
      researchPrincipalPoolHash,
      signerIdentityHash,
      signatureHash,
      signatureVerificationReceiptHash,
    ].every((value) => SHA256.test(String(value || '')))
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error('signed_reviewer_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'SignedReviewerReceipt',
    status: 'signed_reviewer_receipt_verified',
    subjectHash,
    principalId,
    principalDescriptorHash,
    researchPrincipalPoolHash,
    signerIdentityHash,
    signatureHash,
    signatureVerificationReceiptHash,
    externalActionPerformed: true,
    signedAt: timestamp,
  };
  return Object.freeze({
    ...payload,
    signedReviewerReceiptHash: hashRecord('SignedReviewerReceipt', payload),
  });
}

function reconstructCryptographicSignedReviewerReceipt({
  subjectHash,
  principalId,
  principalDescriptorHash,
  researchPrincipalPoolHash,
  signerIdentityHash,
  authorityEnvelope,
  signatureVerificationReceipt,
  identityAttestationSubject = null,
  identityAttestationAuthorityEnvelope = null,
  identityAttestationVerificationReceipt = null,
  identitySeparationReceipt = null,
} = {}, {
  assertVerificationReceipt = null,
  identityReferenceSubjects = null,
  requireLiveAuthority = false,
} = {}) {
  const authorityEnvelopeHash = authorityEnvelope
    ? hashRecord('PinnedExternalEvidenceEnvelope', authorityEnvelope) : null;
  const signatureVerificationReceiptHash = signatureVerificationReceipt
    ?.pinnedExternalEvidenceVerificationReceiptHash || null;
  if (!SHA256.test(String(subjectHash || ''))
    || !SAFE_ID.test(String(principalId || ''))
    || ![principalDescriptorHash, researchPrincipalPoolHash, signerIdentityHash]
      .every((value) => SHA256.test(String(value || '')))
    || authorityEnvelope?.subjectKind !== REVIEWER_RECEIPT_SIGNING_SUBJECT_KIND
    || authorityEnvelope?.subjectHash !== subjectHash
    || !pinnedVerificationReceiptValid(signatureVerificationReceipt, {
      subjectKind: REVIEWER_RECEIPT_SIGNING_SUBJECT_KIND,
      subjectHash,
      requiredRole: REVIEWER_RECEIPT_SIGNER_ROLE,
      envelopeHash: authorityEnvelopeHash,
    })) {
    throw new Error('cryptographic_signed_reviewer_receipt_invalid');
  }
  if (requireLiveAuthority) {
    if (typeof assertVerificationReceipt !== 'function') {
      throw new Error('cryptographic_signed_reviewer_live_verifier_required');
    }
    assertVerificationReceipt(signatureVerificationReceipt, {
      subjectKind: REVIEWER_RECEIPT_SIGNING_SUBJECT_KIND,
      subjectHash,
      requiredRole: REVIEWER_RECEIPT_SIGNER_ROLE,
    });
  }

  const identityEvidencePresent = identityAttestationSubject !== null
    || identityAttestationAuthorityEnvelope !== null
    || identityAttestationVerificationReceipt !== null;
  let identityAttestationSubjectHash = null;
  let identityAttestationAuthorityEnvelopeHash = null;
  let identityAttestationVerificationReceiptHash = null;
  if (identityEvidencePresent) {
    identityAttestationSubjectHash = identityAttestationSubject
      ?.externalPrincipalIdentityAttestationSubjectHash || null;
    identityAttestationAuthorityEnvelopeHash = identityAttestationAuthorityEnvelope
      ? hashRecord('PinnedExternalEvidenceEnvelope', identityAttestationAuthorityEnvelope) : null;
    identityAttestationVerificationReceiptHash = identityAttestationVerificationReceipt
      ?.pinnedExternalEvidenceVerificationReceiptHash || null;
    if (!verifyExternalPrincipalIdentityAttestationSubject(identityAttestationSubject)
      || identityAttestationAuthorityEnvelope?.subjectKind
        !== REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND
      || identityAttestationAuthorityEnvelope?.subjectHash !== identityAttestationSubjectHash
      || !pinnedVerificationReceiptValid(identityAttestationVerificationReceipt, {
        subjectKind: REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
        subjectHash: identityAttestationSubjectHash,
        requiredRole: 'external_principal_identity_attestor',
        envelopeHash: identityAttestationAuthorityEnvelopeHash,
      })) {
      throw new Error('cryptographic_signed_reviewer_identity_attestation_invalid');
    }
    if (requireLiveAuthority) {
      assertVerificationReceipt(identityAttestationVerificationReceipt, {
        subjectKind: REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
        subjectHash: identityAttestationSubjectHash,
        requiredRole: 'external_principal_identity_attestor',
      });
    }
  }
  const identityIndependenceReady = identitySeparationReceiptValid(
    identitySeparationReceipt,
    identityAttestationSubjectHash,
  );
  if (identitySeparationReceipt !== null && !identityIndependenceReady) {
    throw new Error('cryptographic_signed_reviewer_identity_separation_invalid');
  }
  if (requireLiveAuthority && identitySeparationReceipt !== null) {
    const references = Array.isArray(identityReferenceSubjects)
      ? identityReferenceSubjects : [];
    const recomputed = evaluateExternalPrincipalIdentitySeparation({
      candidate: identityAttestationSubject,
      references,
      now: identityAttestationVerificationReceipt.verifiedAt,
      requirePlatformAttestation: true,
    });
    if (!recomputed.identityIndependenceReady
      || JSON.stringify(recomputed) !== JSON.stringify(identitySeparationReceipt)) {
      throw new Error('cryptographic_signed_reviewer_identity_separation_not_derived');
    }
  }
  const signedAt = signatureVerificationReceipt.signedAt;
  const expiresAt = signatureVerificationReceipt.expiresAt;
  const payload = {
    version: 2,
    kind: 'SignedReviewerReceipt',
    status: 'signed_reviewer_receipt_cryptographically_verified',
    subjectHash,
    principalId,
    principalDescriptorHash,
    researchPrincipalPoolHash,
    signerIdentityHash,
    authorityEnvelopeHash,
    authorityEnvelope,
    signatureVerificationReceiptHash,
    signatureVerificationReceipt,
    cryptographicAuthorityReady: true,
    identityAttestationSubjectHash,
    identityAttestationSubject,
    identityAttestationAuthorityEnvelopeHash,
    identityAttestationAuthorityEnvelope,
    identityAttestationVerificationReceiptHash,
    identityAttestationVerificationReceipt,
    identitySeparationReceiptHash:
      identitySeparationReceipt?.externalPrincipalIdentitySeparationReceiptHash || null,
    identitySeparationReceipt,
    identityIndependenceReady,
    externalActionPerformed: true,
    signedAt,
    expiresAt,
  };
  return Object.freeze({
    ...payload,
    signedReviewerReceiptHash: hashRecord('SignedReviewerReceiptV2', payload),
  });
}

export function buildCryptographicSignedReviewerReceipt(input = {}, {
  assertVerificationReceipt,
  identityReferenceSubjects = [],
} = {}) {
  const receipt = reconstructCryptographicSignedReviewerReceipt(input, {
    assertVerificationReceipt,
    identityReferenceSubjects,
    requireLiveAuthority: true,
  });
  liveCryptographicReviewerReceipts.add(receipt);
  return receipt;
}

export function verifySignedReviewerReceipt(receipt, expected = {}, {
  cryptographicVerifier = null,
} = {}) {
  if (receipt?.version === 2) {
    const { signedReviewerReceiptHash: claimedHash, ...payload } = receipt || {};
    if (!SHA256.test(String(claimedHash || ''))
      || hashRecord('SignedReviewerReceiptV2', payload) !== claimedHash) return false;
    let rebuilt;
    try { rebuilt = reconstructCryptographicSignedReviewerReceipt(receipt); }
    catch { return false; }
    if (JSON.stringify(rebuilt) !== JSON.stringify(receipt)
      || !Object.entries(expected).every(([field, value]) => (
        value === undefined || value === null || receipt[field] === value
      ))) return false;
    if (typeof cryptographicVerifier === 'function') {
      let verified = false;
      try { verified = cryptographicVerifier({ receipt, expected }) === true; }
      catch { verified = false; }
      if (!verified) return false;
      liveCryptographicReviewerReceipts.add(receipt);
      return true;
    }
    return liveCryptographicReviewerReceipts.has(receipt);
  }
  const { signedReviewerReceiptHash: claimedHash, ...payload } = receipt || {};
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('SignedReviewerReceipt', payload) !== claimedHash) return false;
  let rebuilt;
  try { rebuilt = buildSignedReviewerReceipt(receipt); }
  catch { return false; }
  if (JSON.stringify(rebuilt) !== JSON.stringify(receipt)) return false;
  return Object.entries(expected).every(([field, value]) => (
    value === undefined || value === null || receipt[field] === value
  ));
}
