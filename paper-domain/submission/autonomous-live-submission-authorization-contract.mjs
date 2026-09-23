import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

function sha(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function id(value) {
  const selected = String(value || '').trim();
  return SAFE_ID.test(selected) ? selected : null;
}

function canonicalInstant(value) {
  const selected = String(value || '');
  const milliseconds = Date.parse(selected);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === selected
    ? selected : null;
}

export function buildAutonomousLiveSubmissionAuthorizationSubject({
  campaignId,
  paperId,
  immutableCampaignPackageOutputHash,
  campaignReleaseBundleHash,
  qualificationReceiptHash,
  researchClosureReceiptHash,
  venueComplianceReceiptHash,
  submissionMetadataReceiptHash,
  venueProfileSelectionHash,
  venueId,
  submissionPortalProfileId,
  portalId,
  portalConfigurationHash,
  portalDescriptorHash,
  serviceIdentityHash,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
} = {}) {
  const payload = Object.freeze({
    version: 2,
    kind: 'LiveSubmissionAuthorizationSubject',
    authorizationTarget: 'autonomous_submission_handoff',
    action: 'reviewed_submit',
    campaignId: id(campaignId),
    paperId: id(paperId),
    taskKey: id(campaignId),
    artifactPackageHash: sha(immutableCampaignPackageOutputHash),
    campaignReleaseBundleHash: sha(campaignReleaseBundleHash),
    qualificationReceiptHash: sha(qualificationReceiptHash),
    researchClosureReceiptHash: sha(researchClosureReceiptHash),
    venueComplianceReceiptHash: sha(venueComplianceReceiptHash),
    submissionMetadataReceiptHash: sha(submissionMetadataReceiptHash),
    venueProfileSelectionHash: sha(venueProfileSelectionHash),
    venueTarget: id(venueId),
    provider: id(portalId),
    accountId: sha(portalAccountIdentityHash),
    portalRoute: id(submissionPortalProfileId),
    portalConfigurationHash: sha(portalConfigurationHash),
    portalDescriptorHash: sha(portalDescriptorHash),
    serviceIdentityHash: sha(serviceIdentityHash),
    portalAccountIdentityHash: sha(portalAccountIdentityHash),
    portalTrustDomainIdentityHash: sha(portalTrustDomainIdentityHash),
  });
  if (Object.values(payload).some((value) => value === null)) {
    throw new Error('autonomous_live_submission_authorization_subject_invalid');
  }
  return Object.freeze({
    ...payload,
    liveSubmissionAuthorizationSubjectHash: hashRecord(
      'LiveSubmissionAuthorizationSubject', payload,
    ),
  });
}

export function autonomousLiveSubmissionAuthorizationSubjectFromRequest(request) {
  return buildAutonomousLiveSubmissionAuthorizationSubject({
    campaignId: request?.campaignId,
    paperId: request?.paperId,
    immutableCampaignPackageOutputHash: request?.immutableCampaignPackageOutputHash,
    campaignReleaseBundleHash: request?.campaignReleaseBundleHash,
    qualificationReceiptHash: request?.qualificationReceiptHash,
    researchClosureReceiptHash: request?.researchClosureReceiptHash,
    venueComplianceReceiptHash: request?.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: request?.submissionMetadataReceiptHash,
    venueProfileSelectionHash: request?.venueProfileSelectionHash,
    venueId: request?.venueId,
    submissionPortalProfileId: request?.submissionPortalProfileId,
    portalId: request?.portalId,
    portalConfigurationHash: request?.portalConfigurationHash,
    portalDescriptorHash: request?.portalDescriptorHash,
    serviceIdentityHash: request?.portalServiceIdentityHash,
    portalAccountIdentityHash: request?.portalAccountIdentityHash,
    portalTrustDomainIdentityHash: request?.portalTrustDomainIdentityHash,
  });
}

export function inspectAutonomousLiveSubmissionAuthorizationReceipt(receipt, {
  expectedSubject,
  observedAt,
  verifyAuthorityDocument = null,
} = {}) {
  const blockers = [];
  const { liveSubmissionAuthorizationReceiptHash: claimedHash, ...payload } = receipt || {};
  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  const subjectHash = expectedSubject?.liveSubmissionAuthorizationSubjectHash || null;
  const signedAt = canonicalInstant(receipt?.signedAt);
  const validFrom = canonicalInstant(receipt?.validFrom);
  const expiresAt = canonicalInstant(receipt?.expiresAt);
  if (receipt?.version !== 2 || receipt?.kind !== 'LiveSubmissionAuthorizationReceipt') {
    blockers.push('live_submission_authorization_receipt_schema_invalid');
  }
  if (!sha(claimedHash)
    || hashRecord('LiveSubmissionAuthorizationReceipt', payload) !== claimedHash) {
    blockers.push('live_submission_authorization_receipt_hash_invalid');
  }
  if (receipt?.status !== 'live_submission_authorization_verified'
    || receipt?.liveExternalActionAuthorized !== true
    || receipt?.cryptographicSignaturesVerified !== true
    || receipt?.singleUse !== true
    || receipt?.consumed !== false) {
    blockers.push('live_submission_authorization_receipt_not_authorized');
  }
  if (!expectedSubject || receipt?.authorizationSubjectHash !== subjectHash
    || receipt?.authorizationSubject?.liveSubmissionAuthorizationSubjectHash !== subjectHash
    || JSON.stringify(receipt?.authorizationSubject) !== JSON.stringify(expectedSubject)) {
    blockers.push('live_submission_authorization_subject_mismatch');
  }
  if (receipt?.provider !== expectedSubject?.provider
    || receipt?.accountId !== expectedSubject?.accountId
    || receipt?.portalRoute !== expectedSubject?.portalRoute) {
    blockers.push('live_submission_authorization_provider_scope_mismatch');
  }
  if (!NONCE.test(String(receipt?.nonce || ''))) {
    blockers.push('live_submission_authorization_nonce_invalid');
  }
  if (!signedAt || !validFrom || !expiresAt
    || !Number.isFinite(observed.getTime())
    || observed.getTime() < Date.parse(validFrom)
    || observed.getTime() >= Date.parse(expiresAt)
    || Date.parse(expiresAt) <= Date.parse(signedAt)
    || Date.parse(expiresAt) - Date.parse(signedAt) > 24 * 60 * 60 * 1000) {
    blockers.push('live_submission_authorization_time_window_invalid');
  }
  const subjects = Array.isArray(receipt?.authorizerSubjectIds)
    ? receipt.authorizerSubjectIds.map(String) : [];
  if (subjects.length < 2 || new Set(subjects).size !== subjects.length
    || receipt?.signatureVerification?.cryptographicSignaturesVerified !== true
    || !receipt?.signatureVerification?.verifiedRoles?.includes('submission_operator')
    || !receipt?.signatureVerification?.verifiedRoles?.includes('live_executor_authorizer')) {
    blockers.push('live_submission_authorization_dual_control_invalid');
  }
  if (receipt?.authorizationDocument?.authorizationSubjectHash !== subjectHash
    || receipt?.authorizationDocument?.nonce !== receipt?.nonce
    || receipt?.authorizationDocument?.provider !== receipt?.provider
    || receipt?.authorizationDocument?.accountId !== receipt?.accountId
    || receipt?.authorizationDocument?.expiresAt !== receipt?.expiresAt
    || receipt?.authorizationDocument?.singleUse !== true
    || receipt?.authorizationDocumentHash !== hashRecord(
      'LiveSubmissionAuthorizationDocument', receipt?.authorizationDocument || null,
    )) {
    blockers.push('live_submission_authorization_document_binding_invalid');
  }
  if (typeof verifyAuthorityDocument !== 'function') {
    blockers.push('live_submission_authorization_authority_verifier_required');
  } else {
    try {
      if (verifyAuthorityDocument({
        document: receipt.authorizationDocument,
        receipt,
        expectedSubject,
        observedAt: observed,
      }) !== true) blockers.push('live_submission_authorization_authority_replay_invalid');
    } catch {
      blockers.push('live_submission_authorization_authority_replay_invalid');
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function verifyAutonomousLiveSubmissionAuthorizationReceipt(receipt, options = {}) {
  return inspectAutonomousLiveSubmissionAuthorizationReceipt(receipt, options).valid;
}

export function autonomousLiveSubmissionAuthorizationBinding(request, {
  observedAt,
  verifyAuthorityDocument,
} = {}) {
  let subject = null;
  try { subject = autonomousLiveSubmissionAuthorizationSubjectFromRequest(request); }
  catch { return null; }
  const receipt = request?.humanAuthorizationReceipt || null;
  if (!verifyAutonomousLiveSubmissionAuthorizationReceipt(receipt, {
    expectedSubject: subject,
    observedAt,
    verifyAuthorityDocument,
  })
    || request?.humanApprovalPerformed !== true
    || request?.humanAuthorizationReceiptHash
      !== receipt?.liveSubmissionAuthorizationReceiptHash
    || request?.humanAuthorizationSubjectHash
      !== subject.liveSubmissionAuthorizationSubjectHash
    || request?.humanAuthorizationNonce !== receipt?.nonce
    || request?.humanAuthorizationExpiresAt !== receipt?.expiresAt) return null;
  return Object.freeze({ subject, receipt });
}
