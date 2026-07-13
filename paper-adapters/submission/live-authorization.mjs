import fs from 'node:fs';
import path from 'node:path';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import {
  loadAuthorityTrustStore,
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../../paper-adapters/authority/authority-signatures.mjs';
import { validateBoundaryRecord } from '../../paper-ports/boundary-schema-catalog.mjs';

export function buildLiveSubmissionAuthorizationSubject({
  paperTask,
  artifactPackage,
  researchReport,
  independentReviewAuthorityReceipt,
  venuePlan,
  provider,
  accountId,
  semanticPromotionLock,
  executorDescriptor = null,
  submissionDecisionPacket = null,
  reviewedVenueEvidence = null,
  redrivePlan = null,
  redriveDecision = null,
  providerCapabilityVerificationReceipt = null,
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
    portalRoute: reviewedVenueEvidence?.portalRoute || null,
    providerCapabilityVerificationReceiptHash: providerCapabilityVerificationReceipt?.providerCapabilityVerificationReceiptHash || null,
    semanticPromotionLockHash: semanticPromotionLock?.semanticPromotionLockHash || null,
    executorDescriptorHash: executorDescriptor?.submissionExecutorDescriptorHash || null,
    executorCapabilitiesHash: executorDescriptor?.capabilitiesHash || null,
    reviewedSubmissionDecisionPacketHash: submissionDecisionPacket?.reviewedSubmissionDecisionPacketHash || null,
    reviewedVenueEvidenceHash: reviewedVenueEvidence?.reviewedVenueEvidenceHash || null,
    venueObservationSourceVerificationReceiptHash: reviewedVenueEvidence?.sourceVerificationReceiptHash || null,
    venueObservationSubjectHash: reviewedVenueEvidence?.observationSubjectHash || null,
    venueObserverId: reviewedVenueEvidence?.reviewedBy || null,
    venueObservationPurpose: reviewedVenueEvidence?.purpose || null,
    redrivePlanHash: redrivePlan?.submissionRedrivePlanHash || null,
    redriveDecisionHash: redriveDecision?.submissionRedriveDecisionHash || null,
    priorDispatchAuthorizationHash: redrivePlan?.dispatchAuthorizationHash || null,
    priorDispatchCycleHash: redrivePlan?.priorDispatchCycleHash || null,
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
  semanticPromotionLock = null,
  executorDescriptor = null,
  submissionDecisionPacket = null,
  reviewedVenueEvidence = null,
  redrivePlan = null,
  redriveDecision = null,
  venueObservationSourceVerificationReceipt = null,
  providerCapabilityVerificationReceipt = null,
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
  const authorizationRead = authorizationFile && inbox
    ? readScopedFileSync({ scopeRoot: inbox, candidate: authorizationFile })
    : null;
  let document = null;
  if (authorizationRead?.status === 'scoped_file_read_verified') {
    try { document = JSON.parse(authorizationRead.content.toString('utf8')); } catch { /* blocked below */ }
  }
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
    semanticPromotionLock,
    executorDescriptor,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    redrivePlan,
    redriveDecision,
    providerCapabilityVerificationReceipt,
  });
  blockers.push(...validateBoundaryRecord(expectedSubject).blockers);
  if (submissionDecisionPacket?.status !== 'reviewed_submission_decision_verified') blockers.push('reviewed_submission_decision_required');
  if (reviewedVenueEvidence?.status !== 'reviewed_venue_evidence_verified'
    || !reviewedVenueEvidence?.sourceVerificationReceiptHash) blockers.push('reviewed_venue_source_verified_evidence_required');
  if (venueObservationSourceVerificationReceipt?.status !== 'reviewed_venue_observation_source_verified'
    || venueObservationSourceVerificationReceipt?.cryptographicSignaturesVerified !== true
    || venueObservationSourceVerificationReceipt?.ledgerReceiptsVerified !== true
    || venueObservationSourceVerificationReceipt?.artifactSourcesVerified !== true
    || venueObservationSourceVerificationReceipt?.reviewedVenueObservationSourceVerificationReceiptHash !== reviewedVenueEvidence?.sourceVerificationReceiptHash
    || venueObservationSourceVerificationReceipt?.observationSubjectHash !== reviewedVenueEvidence?.observationSubjectHash
    || venueObservationSourceVerificationReceipt?.reviewedBy !== reviewedVenueEvidence?.reviewedBy
    || venueObservationSourceVerificationReceipt?.purpose !== reviewedVenueEvidence?.purpose
    || venueObservationSourceVerificationReceipt?.portalRoute !== reviewedVenueEvidence?.portalRoute) {
    blockers.push('reviewed_venue_source_verification_receipt_invalid');
  }
  if (providerCapabilityVerificationReceipt?.status !== 'provider_capability_verified'
    || providerCapabilityVerificationReceipt?.cryptographicSignaturesVerified !== true
    || providerCapabilityVerificationReceipt?.provider !== document.provider
    || providerCapabilityVerificationReceipt?.accountId !== document.accountId
    || providerCapabilityVerificationReceipt?.executorDescriptorHash !== executorDescriptor?.submissionExecutorDescriptorHash
    || providerCapabilityVerificationReceipt?.capabilitiesHash !== executorDescriptor?.capabilitiesHash
    || providerCapabilityVerificationReceipt?.portalRoute !== reviewedVenueEvidence?.portalRoute) {
    blockers.push('provider_capability_not_bound_to_live_authorization');
  }
  if (redrivePlan) {
    if (redrivePlan?.status !== 'submission_redrive_reauthorization_required') blockers.push('redrive_plan_not_ready');
    if (redriveDecision?.status !== 'submission_redrive_reauthorization_approved') blockers.push('redrive_decision_not_approved');
    if (redrivePlan?.redriveDecisionHash !== redriveDecision?.submissionRedriveDecisionHash) blockers.push('redrive_decision_plan_mismatch');
  }
  if (document.authorizationSubjectHash !== expectedSubject.liveSubmissionAuthorizationSubjectHash) {
    blockers.push('live_submission_authorization_subject_hash_mismatch');
  }
  if (!artifactPackage?.artifactPackageHash) blockers.push('live_submission_artifact_package_missing');
  if (semanticPromotionLock?.status !== 'semantic_promotion_unlocked') blockers.push('live_submission_semantic_promotion_lock_not_ready');
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
  const responseDueMs = Date.parse(String(document.responseDueAt || ''));
  if (!Number.isFinite(responseDueMs)) blockers.push('live_submission_response_due_at_invalid');
  if (Number.isFinite(responseDueMs) && responseDueMs <= now.getTime()) blockers.push('live_submission_response_due_at_not_future');
  if (Number.isFinite(responseDueMs) && Number.isFinite(Date.parse(String(document.expiresAt || '')))
    && responseDueMs > Date.parse(String(document.expiresAt))) blockers.push('live_submission_response_due_after_authorization_expiry');
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
    semanticPromotionLockHash: semanticPromotionLock?.semanticPromotionLockHash || null,
    portalAction: document.portalAction || null,
    environment: document.environment || null,
    nonce: document.nonce || null,
    singleUse: document.singleUse === true,
    authorizerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    consumed: Boolean(consumedPath && fs.existsSync(consumedPath)),
    responseDueAt: Number.isFinite(responseDueMs) ? new Date(responseDueMs).toISOString() : null,
    reviewedVenueEvidenceHash: reviewedVenueEvidence?.reviewedVenueEvidenceHash || null,
    venueObservationSourceVerificationReceiptHash: reviewedVenueEvidence?.sourceVerificationReceiptHash || null,
    venueObservationSubjectHash: reviewedVenueEvidence?.observationSubjectHash || null,
    venueObserverId: reviewedVenueEvidence?.reviewedBy || null,
    venueObservationPurpose: reviewedVenueEvidence?.purpose || null,
    portalRoute: reviewedVenueEvidence?.portalRoute || null,
    providerCapabilityVerificationReceiptHash: providerCapabilityVerificationReceipt?.providerCapabilityVerificationReceiptHash || null,
    redrivePlanHash: redrivePlan?.submissionRedrivePlanHash || null,
    redriveDecisionHash: redriveDecision?.submissionRedriveDecisionHash || null,
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
