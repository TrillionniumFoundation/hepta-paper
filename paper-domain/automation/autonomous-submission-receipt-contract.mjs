import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousLiveSubmissionAuthorizationBinding,
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
