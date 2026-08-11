import {
  deriveAutonomousSubmissionPortalPublicConfiguration,
} from '../../paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  buildAutonomousLiveSubmissionAuthorizationSubject,
} from '../../paper-domain/submission/autonomous-live-submission-authorization-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const NOW = '2026-07-19T02:00:00.000Z';
export const H = (label) => hashRecord('AutonomousSubmissionDurableOutboxTest', { label });

export function requestFixture(portalConfiguration = null) {
  const configuration = portalConfiguration && typeof portalConfiguration === 'object'
    ? portalConfiguration : null;
  const portalConfigurationHash = configuration?.configurationHash
    || portalConfiguration || H('portal-configuration');
  const portalId = configuration?.portalId || 'durable-portal';
  const portalServiceIdentityHash = configuration?.serviceIdentityHash
    || H('fixture-portal-service');
  const portalAccountIdentityHash = configuration?.portalAccountIdentityHash
    || H('portal-account');
  const portalTrustDomainIdentityHash = configuration?.portalTrustDomainIdentityHash
    || H('portal-trust-domain');
  const portalDescriptorHash = configuration
    ? autonomousSubmissionPortalPublicDescriptorHash(
      deriveAutonomousSubmissionPortalPublicConfiguration({ configuration }),
    ) : H('portal-descriptor');
  const idempotencyPayload = {
    immutableCampaignPackageOutputHash: H('package'),
    venueId: 'durable-journal',
    campaignReleaseBundleHash: H('release'),
    venueProfileHash: H('venue-profile'),
    qualificationReceiptHash: H('qualification'),
    submissionMetadataReceiptHash: H('metadata'),
    venueComplianceReceiptHash: H('compliance'),
    researchClosureReceiptHash: H('research-closure'),
    portalConfigurationHash,
  };
  const authorizationSubject = buildAutonomousLiveSubmissionAuthorizationSubject({
    campaignId: 'campaign-durable-1',
    paperId: 'paper-durable-1',
    immutableCampaignPackageOutputHash:
      idempotencyPayload.immutableCampaignPackageOutputHash,
    campaignReleaseBundleHash: idempotencyPayload.campaignReleaseBundleHash,
    qualificationReceiptHash: idempotencyPayload.qualificationReceiptHash,
    researchClosureReceiptHash: idempotencyPayload.researchClosureReceiptHash,
    venueComplianceReceiptHash: idempotencyPayload.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: idempotencyPayload.submissionMetadataReceiptHash,
    venueProfileSelectionHash: H('venue-selection'),
    venueId: idempotencyPayload.venueId,
    submissionPortalProfileId: 'durable-portal-v1',
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    serviceIdentityHash: portalServiceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
  });
  const authorizationDocument = {
    version: 1,
    kind: 'LiveSubmissionAuthorization',
    paperId: 'paper-durable-1',
    taskKey: 'campaign-durable-1',
    allowLiveExternalAction: true,
    environment: 'production',
    portalAction: 'submit_manuscript',
    singleUse: true,
    nonce: 'durable-human-permit-0001',
    provider: portalId,
    accountId: portalAccountIdentityHash,
    authorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    signedAt: '2026-07-19T01:59:00.000Z',
    validFrom: '2026-07-19T01:59:00.000Z',
    expiresAt: '2026-07-19T02:30:00.000Z',
    responseDueAt: '2026-07-19T02:20:00.000Z',
    signatures: [
      { keyId: 'operator', role: 'submission_operator', algorithm: 'ed25519', value: 'fixture' },
      { keyId: 'executor', role: 'live_executor_authorizer', algorithm: 'ed25519', value: 'fixture' },
    ],
  };
  const signatureVerification = {
    status: 'authority_signatures_verified',
    cryptographicSignaturesVerified: true,
    requiredRoles: ['submission_operator', 'live_executor_authorizer'],
    requiredSignatureCount: 2,
    verifiedSignatures: [],
    verifiedRoles: ['live_executor_authorizer', 'submission_operator'],
    verifiedSubjectIds: ['durable-executor-authorizer', 'durable-submission-operator'],
    blockers: [],
  };
  const timeWindow = {
    valid: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    blockers: [],
  };
  const authorizationReport = {
    version: 2,
    kind: 'LiveSubmissionAuthorizationReceipt',
    authorizationMode: 'autonomous_submission_handoff',
    paperId: 'paper-durable-1',
    taskKey: 'campaign-durable-1',
    status: 'live_submission_authorization_verified',
    liveExternalActionAuthorized: true,
    cryptographicSignaturesVerified: true,
    authorizationPath: 'fixture/LIVE_SUBMISSION_AUTHORIZATION.json',
    authorizationSubject,
    authorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    authorizationDocument,
    authorizationDocumentHash: hashRecord(
      'LiveSubmissionAuthorizationDocument', authorizationDocument,
    ),
    provider: portalId,
    accountId: portalAccountIdentityHash,
    portalRoute: 'durable-portal-v1',
    portalAction: 'submit_manuscript',
    environment: 'production',
    nonce: authorizationDocument.nonce,
    singleUse: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    authorizerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    consumed: false,
    responseDueAt: authorizationDocument.responseDueAt,
    blockers: [],
    safety: {
      humanReviewRequired: true,
      dualControlRequired: true,
      singleUseAuthorization: true,
      authorizationLifetimeHoursMaximum: 24,
      separatedDutiesEnforced: true,
      grantsExecutionInsideOverlay: false,
      externalActionPerformed: false,
    },
  };
  const humanAuthorizationReceipt = Object.freeze({
    ...authorizationReport,
    liveSubmissionAuthorizationReceiptHash: hashRecord(
      'LiveSubmissionAuthorizationReceipt', authorizationReport,
    ),
  });
  Object.assign(idempotencyPayload, {
    portalId,
    portalDescriptorHash,
    portalServiceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    humanAuthorizationReceiptHash:
      humanAuthorizationReceipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    humanAuthorizationNonce: humanAuthorizationReceipt.nonce,
    humanAuthorizationExpiresAt: humanAuthorizationReceipt.expiresAt,
  });
  const payload = {
    version: 7,
    kind: 'AutonomousSubmissionRequest',
    campaignId: 'campaign-durable-1',
    paperId: 'paper-durable-1',
    venueId: idempotencyPayload.venueId,
    venueProfileHash: idempotencyPayload.venueProfileHash,
    venueProfileSelectionHash: H('venue-selection'),
    submissionPortalProfileId: 'durable-portal-v1',
    campaignReleaseBundleHash: idempotencyPayload.campaignReleaseBundleHash,
    immutableCampaignPackageOutputHash:
      idempotencyPayload.immutableCampaignPackageOutputHash,
    sourceSnapshotHash: H('source'),
    sourceTreeManifestHash: H('tree'),
    researchEvidenceCapsuleManifestHash: H('capsule'),
    researchClosureReceiptHash: idempotencyPayload.researchClosureReceiptHash,
    qualificationReceiptHash: idempotencyPayload.qualificationReceiptHash,
    venueComplianceReceiptHash: idempotencyPayload.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: idempotencyPayload.submissionMetadataReceiptHash,
    renderedSourceHash: H('rendered'),
    compiledPdfHash: H('pdf'),
    independentRebuiltPdfHash: H('independent-pdf'),
    pageCount: 7,
    portalConfigurationHash: idempotencyPayload.portalConfigurationHash,
    portalId,
    portalDescriptorHash,
    portalServiceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    humanAuthorizationReceiptHash:
      humanAuthorizationReceipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    humanAuthorizationNonce: humanAuthorizationReceipt.nonce,
    humanAuthorizationExpiresAt: humanAuthorizationReceipt.expiresAt,
    humanAuthorizationReceipt,
    idempotencyKey: hashRecord('AutonomousSubmissionIdempotencyKey', idempotencyPayload),
    humanApprovalPerformed: true,
    requestedAt: NOW,
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousSubmissionRequest', payload),
  });
}

export function resealRequest(request, patch = {}) {
  const { requestHash: _requestHash, ...payload } = request;
  const selected = { ...payload, ...patch };
  return Object.freeze({
    ...selected,
    requestHash: hashRecord('AutonomousSubmissionRequest', selected),
  });
}

export function expiredAuthorizationRequest(request) {
  const receipt = structuredClone(request.humanAuthorizationReceipt);
  receipt.authorizationDocument.expiresAt = '2026-07-19T01:59:30.000Z';
  receipt.expiresAt = receipt.authorizationDocument.expiresAt;
  receipt.timeWindow.expiresAt = receipt.expiresAt;
  receipt.authorizationDocumentHash = hashRecord(
    'LiveSubmissionAuthorizationDocument', receipt.authorizationDocument,
  );
  delete receipt.liveSubmissionAuthorizationReceiptHash;
  receipt.liveSubmissionAuthorizationReceiptHash = hashRecord(
    'LiveSubmissionAuthorizationReceipt', receipt,
  );
  return resealRequest(request, {
    humanAuthorizationReceipt: receipt,
    humanAuthorizationReceiptHash: receipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationExpiresAt: receipt.expiresAt,
  });
}

