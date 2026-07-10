import fs from 'node:fs';
import path from 'node:path';
import { readJsonIfExists } from '../../paper-core/src/utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contracts.mjs';
import {
  loadAuthorityTrustStore,
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../../paper-core/src/authority-signatures.mjs';

export function buildLiveSubmissionAuthorizationSubject({
  paperTask,
  artifactPackage,
  researchReport,
  independentReviewAuthorityReceipt,
  venuePlan,
  provider,
  accountId,
} = {}) {
  const subject = {
    version: 1,
    kind: 'LiveSubmissionAuthorizationSubject',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    action: 'reviewed_submit',
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    academicEvidenceVerificationHash: researchReport?.academicEvidenceAttestation
      ?.academicEvidenceAttestationVerificationHash || null,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    venueTarget: venuePlan?.venue?.name || venuePlan?.target || paperTask?.venueTarget || null,
    provider: provider || null,
    accountId: accountId || null,
  };
  return {
    ...subject,
    liveSubmissionAuthorizationSubjectHash: hashPaperRecord('LiveSubmissionAuthorizationSubject', subject),
  };
}

function blockedReceipt({ paperTask, authorizationPath, blocker }) {
  const report = {
    version: 1,
    kind: 'LiveSubmissionAuthorizationReceipt',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: 'live_submission_authorization_blocked',
    liveExternalActionAuthorized: false,
    cryptographicSignaturesVerified: false,
    authorizationPath,
    authorizerSubjectIds: [],
    blockers: [blocker],
    safety: {
      dualControlRequired: true,
      singleUseAuthorization: true,
      grantsExecutionInsideOverlay: false,
      externalActionPerformed: false,
    },
  };
  return {
    ...report,
    liveSubmissionAuthorizationReceiptHash: hashPaperRecord('LiveSubmissionAuthorizationReceipt', report),
  };
}

export async function verifyLiveSubmissionAuthorization({
  root,
  runtimeRoot,
  paperTask,
  artifactPackage = null,
  researchReport = null,
  independentReviewAuthorityReceipt = null,
  venuePlan = null,
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const inbox = runtimeRoot && paperTask?.paperId
    ? path.join(runtimeRoot, 'authority-inbox', paperTask.paperId)
    : null;
  const authorizationFile = inbox ? path.join(inbox, 'LIVE_SUBMISSION_AUTHORIZATION.json') : null;
  const authorizationPath = authorizationFile
    ? path.relative(root, authorizationFile).replace(/\\/g, '/')
    : null;
  const document = authorizationFile ? await readJsonIfExists(authorizationFile) : null;
  if (!document) {
    return blockedReceipt({
      paperTask,
      authorizationPath,
      blocker: 'live_submission_authorization_missing',
    });
  }
  const blockers = [];
  if (document.version !== 1 || document.kind !== 'LiveSubmissionAuthorization') {
    blockers.push('live_submission_authorization_schema_invalid');
  }
  if (document.paperId !== paperTask?.paperId) blockers.push('live_submission_authorization_paper_id_mismatch');
  if (document.taskKey !== paperTask?.taskKey) blockers.push('live_submission_authorization_task_key_mismatch');
  if (document.allowLiveExternalAction !== true) blockers.push('live_external_action_not_explicitly_authorized');
  if (document.environment !== 'production') blockers.push('live_submission_environment_not_production');
  if (document.portalAction !== 'submit_manuscript') blockers.push('live_submission_portal_action_invalid');
  if (document.singleUse !== true) blockers.push('live_submission_authorization_must_be_single_use');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(document.nonce || ''))) {
    blockers.push('live_submission_authorization_nonce_invalid');
  }
  if (!document.provider || !document.accountId) blockers.push('live_submission_provider_scope_missing');
  const expectedSubject = buildLiveSubmissionAuthorizationSubject({
    paperTask,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    provider: document.provider,
    accountId: document.accountId,
  });
  if (document.authorizationSubjectHash !== expectedSubject.liveSubmissionAuthorizationSubjectHash) {
    blockers.push('live_submission_authorization_subject_hash_mismatch');
  }
  if (!artifactPackage?.artifactPackageHash) blockers.push('live_submission_artifact_package_missing');
  if (researchReport?.academicEvidenceEligible !== true) blockers.push('live_submission_academic_evidence_not_verified');
  if (independentReviewAuthorityReceipt?.acceptanceAuthorityReady !== true) {
    blockers.push('live_submission_independent_referee_acceptance_missing');
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
  const separatedAuthoritySubjects = new Set([
    ...(researchReport?.academicEvidenceAttestation?.signerSubjectIds || []),
    ...(independentReviewAuthorityReceipt?.reviewerSubjectIds || []),
  ]);
  if (signatureVerification.verifiedSubjectIds.some((subjectId) => separatedAuthoritySubjects.has(subjectId))) {
    blockers.push('live_authorizer_not_separated_from_evidence_or_referee_authority');
  }
  const timeWindow = verifyAuthorityTimeWindow({
    signedAt: document.signedAt,
    validFrom: document.validFrom,
    expiresAt: document.expiresAt,
    now,
    maximumLifetimeMs: 24 * 60 * 60 * 1000,
  });
  blockers.push(...timeWindow.blockers);
  const consumedPath = runtimeRoot && document.nonce
    ? path.join(runtimeRoot, 'submission-authorization-consumed', paperTask.paperId, `${document.nonce}.json`)
    : null;
  if (consumedPath && fs.existsSync(consumedPath)) blockers.push('live_submission_authorization_nonce_already_consumed');
  const report = {
    version: 1,
    kind: 'LiveSubmissionAuthorizationReceipt',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length
      ? 'live_submission_authorization_blocked'
      : 'live_submission_authorization_verified',
    liveExternalActionAuthorized: blockers.length === 0,
    cryptographicSignaturesVerified: signatureVerification.cryptographicSignaturesVerified,
    authorizationPath,
    authorizationSubject: expectedSubject,
    authorizationSubjectHash: expectedSubject.liveSubmissionAuthorizationSubjectHash,
    provider: document.provider || null,
    accountId: document.accountId || null,
    portalAction: document.portalAction || null,
    environment: document.environment || null,
    nonce: document.nonce || null,
    singleUse: document.singleUse === true,
    authorizerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    consumed: Boolean(consumedPath && fs.existsSync(consumedPath)),
    blockers: [...new Set(blockers)],
    safety: {
      dualControlRequired: true,
      singleUseAuthorization: true,
      authorizationLifetimeHoursMaximum: 24,
      separatedDutiesEnforced: true,
      grantsExecutionInsideOverlay: false,
      executorImplementationPresent: false,
      externalActionPerformed: false,
    },
  };
  return {
    ...report,
    liveSubmissionAuthorizationReceiptHash: hashPaperRecord('LiveSubmissionAuthorizationReceipt', report),
  };
}
