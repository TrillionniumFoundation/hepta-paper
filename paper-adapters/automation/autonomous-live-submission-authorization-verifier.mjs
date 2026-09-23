import fs from 'node:fs';
import path from 'node:path';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import {
  loadAuthorityTrustStore,
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';
import {
  buildAutonomousLiveSubmissionAuthorizationSubject,
  verifyAutonomousLiveSubmissionAuthorizationReceipt,
} from '../../paper-domain/submission/autonomous-live-submission-authorization-contract.mjs';

function autonomousBlockedReceipt({ paperId, campaignId, authorizationPath, blocker }) {
  const report = {
    version: 2,
    kind: 'LiveSubmissionAuthorizationReceipt',
    authorizationMode: 'autonomous_submission_handoff',
    paperId: paperId || null,
    taskKey: campaignId || null,
    status: 'live_submission_authorization_blocked',
    liveExternalActionAuthorized: false,
    cryptographicSignaturesVerified: false,
    authorizationPath,
    authorizationSubject: null,
    authorizationSubjectHash: null,
    authorizationDocument: null,
    authorizationDocumentHash: null,
    provider: null,
    accountId: null,
    portalRoute: null,
    portalAction: null,
    environment: null,
    nonce: null,
    singleUse: false,
    signedAt: null,
    validFrom: null,
    expiresAt: null,
    authorizerSubjectIds: [],
    signatureVerification: null,
    timeWindow: null,
    consumed: false,
    responseDueAt: null,
    blockers: [blocker],
    safety: {
      humanReviewRequired: true,
      dualControlRequired: true,
      singleUseAuthorization: true,
      grantsExecutionInsideOverlay: false,
      externalActionPerformed: false,
    },
  };
  return {
    ...report,
    liveSubmissionAuthorizationReceiptHash:
      hashPaperRecord('LiveSubmissionAuthorizationReceipt', report),
  };
}

export function verifyAutonomousLiveSubmissionAuthorizationReceiptAuthority({
  document,
  receipt,
  trustStore,
  observedAt,
} = {}) {
  const signatureVerification = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: ['submission_operator', 'live_executor_authorizer'],
    minSignatures: 2,
    requireDistinctSubjects: true,
  });
  const timeWindow = verifyAuthorityTimeWindow({
    signedAt: document?.signedAt,
    validFrom: document?.validFrom,
    expiresAt: document?.expiresAt,
    now: observedAt,
    maximumLifetimeMs: 24 * 60 * 60 * 1000,
  });
  return signatureVerification.cryptographicSignaturesVerified === true
    && timeWindow.valid === true
    && JSON.stringify(signatureVerification) === JSON.stringify(receipt?.signatureVerification)
    && JSON.stringify(timeWindow) === JSON.stringify(receipt?.timeWindow)
    && receipt?.authorizationDocumentHash === hashPaperRecord(
      'LiveSubmissionAuthorizationDocument', document,
    );
}

export async function verifyAutonomousLiveSubmissionAuthorization({
  root,
  runtimeRoot,
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
  separatedAuthoritySubjectIds = [],
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const inbox = runtimeRoot && paperId
    ? path.join(runtimeRoot, 'authority-inbox', paperId)
    : null;
  const authorizationFile = inbox
    ? path.join(inbox, 'LIVE_SUBMISSION_AUTHORIZATION.json') : null;
  const authorizationPath = authorizationFile
    ? path.relative(root, authorizationFile).replace(/\\/g, '/') : null;
  const authorizationRead = authorizationFile && inbox
    ? readScopedFileSync({ scopeRoot: inbox, candidate: authorizationFile }) : null;
  let document = null;
  if (authorizationRead?.status === 'scoped_file_read_verified') {
    try { document = JSON.parse(authorizationRead.content.toString('utf8')); }
    catch { /* blocked below */ }
  }
  if (!document) {
    return autonomousBlockedReceipt({
      paperId, campaignId, authorizationPath,
      blocker: 'live_submission_authorization_missing',
    });
  }
  let expectedSubject = null;
  try {
    expectedSubject = buildAutonomousLiveSubmissionAuthorizationSubject({
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
    });
  } catch {
    return autonomousBlockedReceipt({
      paperId, campaignId, authorizationPath,
      blocker: 'live_submission_authorization_subject_invalid',
    });
  }
  const blockers = [];
  if (document.version !== 1 || document.kind !== 'LiveSubmissionAuthorization') {
    blockers.push('live_submission_authorization_schema_invalid');
  }
  if (document.paperId !== paperId) blockers.push('live_submission_authorization_paper_id_mismatch');
  if (document.taskKey !== campaignId) blockers.push('live_submission_authorization_task_key_mismatch');
  if (document.allowLiveExternalAction !== true) blockers.push('live_external_action_not_explicitly_authorized');
  if (document.environment !== 'production') blockers.push('live_submission_environment_not_production');
  if (document.portalAction !== 'submit_manuscript') blockers.push('live_submission_portal_action_invalid');
  if (document.singleUse !== true) blockers.push('live_submission_authorization_must_be_single_use');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(document.nonce || ''))) {
    blockers.push('live_submission_authorization_nonce_invalid');
  }
  if (document.provider !== expectedSubject.provider
    || document.accountId !== expectedSubject.accountId) {
    blockers.push('live_submission_provider_scope_mismatch');
  }
  if (document.authorizationSubjectHash
    !== expectedSubject.liveSubmissionAuthorizationSubjectHash) {
    blockers.push('live_submission_authorization_subject_hash_mismatch');
  }
  const trustStore = await loadAuthorityTrustStore({ runtimeRoot, trustStoreOverride });
  const signatureVerification = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: ['submission_operator', 'live_executor_authorizer'],
    minSignatures: 2,
    requireDistinctSubjects: true,
  });
  blockers.push(...signatureVerification.blockers);
  const separated = new Set((Array.isArray(separatedAuthoritySubjectIds)
    ? separatedAuthoritySubjectIds : []).map(String));
  if (signatureVerification.verifiedSubjectIds.some((subjectId) => separated.has(subjectId))) {
    blockers.push('live_authorizer_not_separated_from_research_authority');
  }
  const timeWindow = verifyAuthorityTimeWindow({
    signedAt: document.signedAt,
    validFrom: document.validFrom,
    expiresAt: document.expiresAt,
    now,
    maximumLifetimeMs: 24 * 60 * 60 * 1000,
  });
  blockers.push(...timeWindow.blockers);
  const responseDueMs = Date.parse(String(document.responseDueAt || ''));
  if (!Number.isFinite(responseDueMs)) blockers.push('live_submission_response_due_at_invalid');
  if (Number.isFinite(responseDueMs) && responseDueMs <= now.getTime()) {
    blockers.push('live_submission_response_due_at_not_future');
  }
  if (Number.isFinite(responseDueMs)
    && Number.isFinite(Date.parse(String(document.expiresAt || '')))
    && responseDueMs > Date.parse(String(document.expiresAt))) {
    blockers.push('live_submission_response_due_after_authorization_expiry');
  }
  const consumedPath = runtimeRoot && document.nonce
    ? path.join(runtimeRoot, 'submission-authorization-consumed', paperId,
      `${document.nonce}.json`) : null;
  if (consumedPath && fs.existsSync(consumedPath)) {
    blockers.push('live_submission_authorization_nonce_already_consumed');
  }
  const report = {
    version: 2,
    kind: 'LiveSubmissionAuthorizationReceipt',
    authorizationMode: 'autonomous_submission_handoff',
    paperId,
    taskKey: campaignId,
    status: blockers.length
      ? 'live_submission_authorization_blocked'
      : 'live_submission_authorization_verified',
    liveExternalActionAuthorized: blockers.length === 0,
    cryptographicSignaturesVerified:
      signatureVerification.cryptographicSignaturesVerified,
    authorizationPath,
    authorizationSubject: expectedSubject,
    authorizationSubjectHash:
      expectedSubject.liveSubmissionAuthorizationSubjectHash,
    authorizationDocument: document,
    authorizationDocumentHash: hashPaperRecord(
      'LiveSubmissionAuthorizationDocument', document,
    ),
    provider: document.provider || null,
    accountId: document.accountId || null,
    portalRoute: expectedSubject.portalRoute,
    portalAction: document.portalAction || null,
    environment: document.environment || null,
    nonce: document.nonce || null,
    singleUse: document.singleUse === true,
    signedAt: timeWindow.signedAt,
    validFrom: timeWindow.validFrom,
    expiresAt: timeWindow.expiresAt,
    authorizerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    consumed: Boolean(consumedPath && fs.existsSync(consumedPath)),
    responseDueAt: Number.isFinite(responseDueMs)
      ? new Date(responseDueMs).toISOString() : null,
    blockers: [...new Set(blockers)],
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
  const receipt = Object.freeze({
    ...report,
    liveSubmissionAuthorizationReceiptHash:
      hashPaperRecord('LiveSubmissionAuthorizationReceipt', report),
  });
  if (!blockers.length && !verifyAutonomousLiveSubmissionAuthorizationReceipt(receipt, {
    expectedSubject,
    observedAt: now,
    verifyAuthorityDocument: (input) => (
      verifyAutonomousLiveSubmissionAuthorizationReceiptAuthority({
        ...input,
        trustStore,
      })
    ),
  })) {
    throw new Error('autonomous_live_submission_authorization_receipt_invalid');
  }
  return receipt;
}

