import path from 'node:path';
import {
  PAPER_ACTIONS,
  buildControlledExternalExecutorReceipt,
  buildExternalExecutorHandoffOutbox,
  buildExternalSubmissionReceipt,
  buildFreshVenueEvidenceBundle,
  buildPaperHandoffEnvelope,
  buildReviewedSubmitPreflightPacket,
  buildSubmissionApprovalPacket,
  buildSubmissionReceiptInbox,
  buildSubmissionReconciliation,
  buildSubmissionReplayGuard,
  buildVenueStateProof,
  buildVenueSubmissionPlan,
  createPaperActionManifest,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import { buildSubmissionDeliveryRuntime } from '../../paper-domain/submission/delivery-runtime.mjs';
import { buildSemanticPromotionLock } from '../../paper-domain/submission/semantic-promotion-lock.mjs';
import { buildReviewedVenueEvidence } from '../../paper-domain/submission/reviewed-venue-evidence.mjs';
import { buildReviewedSubmissionDecisionPacket } from '../../paper-domain/submission/reviewed-submission-decision.mjs';
import { verifyIndependentRefereeAuthority } from '../referee-review/independent-authority.mjs';
import { verifyLiveSubmissionAuthorization } from './live-authorization.mjs';
import { verifyReviewedVenueObservationSource } from './venue-observation-verification.mjs';
import { loadAuthorityTrustStore } from '../../paper-adapters/authority/authority-signatures.mjs';

export { exportSubmissionHandoffBundle } from './handoff-bundle-exporter.mjs';
export { verifySignedExecutorResponse } from './executor-response-verification.mjs';
export { buildReviewedVenueEvidence } from '../../paper-domain/submission/reviewed-venue-evidence.mjs';
export { buildSubmissionRedriveDecision } from '../../paper-domain/submission/redrive-decision.mjs';
export { buildReviewedSubmissionDecisionPacket } from '../../paper-domain/submission/reviewed-submission-decision.mjs';
export { buildVenueObservationSubject, verifyReviewedVenueObservationSource } from './venue-observation-verification.mjs';
export { verifySignedAmbiguousRedriveReview } from './redrive-review-verification.mjs';
export { buildProviderCapabilitySubject, verifyProviderCapabilityAttestation } from './provider-capability-verification.mjs';

function matchVenue(venues = [], target = '') {
  const normalized = normalizeText(target).toLowerCase();
  if (!normalized) return null;
  return venues.find((venue) => normalizeText(venue.name).toLowerCase() === normalized)
    || venues.find((venue) => normalized.includes(normalizeText(venue.name).toLowerCase()))
    || venues.find((venue) => normalizeText(venue.venue_id).toLowerCase() === normalized)
    || null;
}

export function buildSubmissionVenuePlan({
  row,
  venues = [],
  artifactPackage = null,
  mode = 'local-dry-run',
} = {}) {
  const venue = row.venue || matchVenue(venues, row.task.venueTarget);
  return buildVenueSubmissionPlan({
    paperTask: row.task,
    venue,
    artifactPackage,
    mode,
    warnings: venue ? [] : ['venue_registry_match_missing'],
  });
}

export async function prepareSubmissionAuthorities({
  root,
  runtimeRoot,
  row,
  venues = [],
  artifactPackage = null,
  packageResult = null,
  researchReport = null,
  targetScopeReceipt = null,
  mode = 'reviewed-submit',
  trustStoreOverride = null,
  now = new Date(),
  authorityVerifier = null,
  executorDescriptor = null,
  submissionMetadata = null,
  submissionMetadataReview = null,
  venuePreflightObservation = null,
  signedVenueObservation = null,
  receiptLedger = null,
  redrivePlan = null,
  redriveDecision = null,
  providerCapabilityVerificationReceipt = null,
} = {}) {
  const venuePlan = buildSubmissionVenuePlan({ row, venues, artifactPackage, mode });
  const promotionGate = packageResult?.manuscriptPromotionGate || null;
  const semanticPromotionLock = buildSemanticPromotionLock({
    paperTask: row.task,
    targetScopeReceipt,
    artifactPackage,
    packageVerificationReceipt: packageResult?.packageVerificationReceipt || null,
    researchReport,
    promotionGate,
    venuePlan,
  });
  const sourceRoot = row?.task?.sourceWorkspace
    ? (path.isAbsolute(row.task.sourceWorkspace)
      ? row.task.sourceWorkspace
      : path.join(root, row.task.sourceWorkspace))
    : null;
  const verifyIndependent = authorityVerifier?.verifyIndependentReferee || verifyIndependentRefereeAuthority;
  const verifyLive = authorityVerifier?.verifyLiveAuthorization || verifyLiveSubmissionAuthorization;
  const independentReviewAuthorityReceipt = await verifyIndependent({
    root,
    runtimeRoot,
    sourceRoot,
    paperTask: row.task,
    researchReport,
    artifactPackage,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride,
    now,
  });
  const submissionDecisionPacket = buildReviewedSubmissionDecisionPacket({
    paperTask: row.task,
    venuePlan,
    metadata: submissionMetadata,
    review: submissionMetadataReview,
  });
  const trustStore = await loadAuthorityTrustStore({ runtimeRoot, trustStoreOverride });
  const venueObservationSourceVerificationReceipt = verifyReviewedVenueObservationSource({
    paperTask: row.task,
    venuePlan,
    observation: venuePreflightObservation,
    signedObservation: signedVenueObservation,
    receiptLedger,
    trustStore,
    now,
  });
  const reviewedVenueEvidence = buildReviewedVenueEvidence({
    paperTask: row.task,
    venuePlan,
    observation: venuePreflightObservation,
    now,
    sourceVerificationReceipt: venueObservationSourceVerificationReceipt,
  });
  const liveAuthorizationReceipt = await verifyLive({
    root,
    runtimeRoot,
    paperTask: row.task,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride,
    now,
    executorDescriptor,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    redrivePlan,
    redriveDecision,
    venueObservationSourceVerificationReceipt,
    providerCapabilityVerificationReceipt,
  });
  return {
    venuePlan,
    promotionGate,
    semanticPromotionLock,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    submissionDecisionPacket,
    venueObservationSourceVerificationReceipt,
    reviewedVenueEvidence,
  };
}

export function buildSubmissionLifecycle({
  row,
  venues = [],
  artifactPackage = null,
  packageResult = null,
  researchReport = null,
  targetScopeReceipt = null,
  mode = 'local-dry-run',
  reviewedSubmit = false,
  venuePlanOverride = null,
  independentReviewAuthorityReceipt = null,
  liveAuthorizationReceipt = null,
  semanticPromotionLock = null,
  deliveryStore = null,
  executorResponse = null,
  venueObservation = null,
  venuePreflightObservation = null,
  venueEvidenceNow = new Date(),
  priorRedriveAttempts = [],
  executorDescriptor = null,
  executorResponseVerificationReceipt = null,
  submissionDecisionPacket = null,
  reviewedVenueEvidenceOverride = null,
  providerCapabilityVerificationReceipt = null,
} = {}) {
  const venuePlan = venuePlanOverride || buildSubmissionVenuePlan({ row, venues, artifactPackage, mode });
  const promotionGate = packageResult?.manuscriptPromotionGate || null;
  const effectiveSemanticPromotionLock = semanticPromotionLock || buildSemanticPromotionLock({
    paperTask: row.task,
    targetScopeReceipt,
    artifactPackage,
    packageVerificationReceipt: packageResult?.packageVerificationReceipt || null,
    researchReport,
    promotionGate,
    venuePlan,
  });
  const liveAuthorized = liveAuthorizationReceipt?.status === 'live_submission_authorization_verified'
    && liveAuthorizationReceipt?.liveExternalActionAuthorized === true;
  const approvalPacket = buildSubmissionApprovalPacket({
    paperTask: row.task,
    mode,
    approved: Boolean(reviewedSubmit && liveAuthorized),
    approver: liveAuthorized ? (liveAuthorizationReceipt.authorizerSubjectIds || []).join(',') : '',
    approvalActor: liveAuthorized ? 'cryptographic_dual_control' : '',
    artifactPackage,
    venuePlan,
    researchReport,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    promotionGate,
    semanticPromotionLock: effectiveSemanticPromotionLock,
  });
  const reviewedVenueEvidence = reviewedSubmit
    ? (reviewedVenueEvidenceOverride || buildReviewedVenueEvidence({ paperTask: row.task, venuePlan, observation: venuePreflightObservation, now: venueEvidenceNow }))
    : null;
  const freshVenueEvidenceBundle = buildFreshVenueEvidenceBundle({
    paperTask: row.task,
    venuePlan,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    promotionGate,
    semanticPromotionLock: effectiveSemanticPromotionLock,
    requireAcademicEvidence: Boolean(reviewedSubmit),
    reviewedVenueEvidence,
  });
  const action = reviewedSubmit ? PAPER_ACTIONS.REVIEWED_SUBMIT : PAPER_ACTIONS.VENUE_DRY_RUN;
  const manifest = createPaperActionManifest({
    paperTask: row.task,
    action,
    mode,
    artifactPackage,
    researchReport,
    venuePlan,
    venueEvidenceBundle: freshVenueEvidenceBundle,
    dryRun: true,
    approvalPacket: reviewedSubmit ? approvalPacket : null,
    promotionGate,
    semanticPromotionLock: effectiveSemanticPromotionLock,
    extraBlockers: [
      ...(row.state?.blockers || []),
    ],
  });
  const handoff = buildPaperHandoffEnvelope({ manifest });
  const replayGuard = buildSubmissionReplayGuard({ manifest, venueEvidenceBundle: freshVenueEvidenceBundle });
  const outbox = buildExternalExecutorHandoffOutbox({ manifest, handoff, replayGuard });
  const reviewedSubmitPreflightPacket = reviewedSubmit
    ? buildReviewedSubmitPreflightPacket({
      paperTask: row.task,
      approvalPacket,
      freshVenueEvidenceBundle,
      manifest,
      replayGuard,
      outbox,
      artifactPackage,
      researchReport,
      venuePlan,
      independentReviewAuthorityReceipt,
      liveAuthorizationReceipt,
      promotionGate,
      semanticPromotionLock: effectiveSemanticPromotionLock,
      submissionDecisionPacket,
    })
    : null;
  const controlledExecutorReceipt = reviewedSubmit
    ? buildControlledExternalExecutorReceipt({
      paperTask: row.task,
      approvalPacket,
      reviewedSubmitPreflightPacket,
      manifest,
      outbox,
      replayGuard,
      independentReviewAuthorityReceipt,
      liveAuthorizationReceipt,
      executorDescriptor,
      executorId: executorDescriptor?.executorId || 'openclaw-agent-controlled-reviewed-submit-executor',
      submissionDecisionPacket,
    })
    : null;
  const receipt = buildExternalSubmissionReceipt({ manifest, outbox, venuePlan, reviewedSubmit });
  const receiptInbox = buildSubmissionReceiptInbox({ receipt, outbox });
  const venueStateProof = buildVenueStateProof({ receipt, venuePlan });
  const auditArchive = {
    version: 1,
    kind: 'SubmissionAuditArchive',
    paperId: row.task.paperId,
    mode,
    venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
    approvalHash: approvalPacket.approvalHash,
    freshVenueEvidenceBundleHash: freshVenueEvidenceBundle.freshVenueEvidenceBundleHash,
    reviewedSubmitPreflightPacketHash: reviewedSubmitPreflightPacket?.reviewedSubmitPreflightPacketHash || null,
    controlledExternalExecutorReceiptHash: controlledExecutorReceipt?.controlledExternalExecutorReceiptHash || null,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    liveSubmissionAuthorizationReceiptHash:
      liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    manuscriptPromotionGateHash: promotionGate?.manuscriptPromotionGateHash || null,
    semanticPromotionLockHash: effectiveSemanticPromotionLock?.semanticPromotionLockHash || null,
    manifestHash: manifest.manifestHash,
    replayGuardHash: replayGuard.submissionReplayGuardHash,
    envelopeHash: handoff.envelopeHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    receiptHash: receipt.receiptHash,
    receiptInboxHash: receiptInbox.submissionReceiptInboxHash,
    venueStateProofHash: venueStateProof.venueStateProofHash,
    externalActionPerformed: false,
    liveSubmitBlocked: true,
    controlledExecutorReceiptRecorded: controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded',
  };
  const hashedArchive = {
    ...auditArchive,
    auditArchiveHash: hashPaperRecord('SubmissionAuditArchive', auditArchive),
  };
  const reconciliation = buildSubmissionReconciliation({
    manifest,
    outbox,
    receipt,
    venueStateProof,
    auditArchive: hashedArchive,
  });
  const deliveryRuntime = buildSubmissionDeliveryRuntime({
    paperTask: row.task,
    outbox,
    replayGuard,
    reviewedSubmitPreflightPacket,
    controlledExecutorReceipt,
    liveAuthorizationReceipt,
    reconciliation,
    artifactPackage,
    executorResponse,
    executorResponseVerificationReceipt,
    venueObservation,
    priorRedriveAttempts,
    responseDueAt: liveAuthorizationReceipt?.responseDueAt || null,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    providerCapabilityVerificationReceipt,
  });
  let deliveryPersistence = {
    status: 'submission_delivery_persistence_blocked',
    messageId: null,
    releaseLockStatus: null,
    blockers: ['dispatch_authorization_not_ready'],
  };
  if (deliveryStore && deliveryRuntime.dispatchAuthorization.status === 'submission_dispatch_authorization_ready') {
    const message = deliveryStore.enqueueAuthorized({
      paperId: row.task.paperId,
      dispatchAuthorization: deliveryRuntime.dispatchAuthorization,
      payload: { outbox, reviewedSubmitPreflightPacket, controlledExecutorReceipt },
    });
    const lock = message._releaseLock;
    const responsePersistenceReceipt = executorResponse
      ? deliveryStore.recordResponse({ messageId: message.message_id, response: executorResponse, responseVerificationReceipt: executorResponseVerificationReceipt })
      : null;
    const released = executorResponse && deliveryRuntime.releaseLock.status === 'submission_release_unlocked'
      ? deliveryStore.release({ paperId: row.task.paperId, lockToken: lock?.lock_token, releaseLock: deliveryRuntime.releaseLock })
      : null;
    deliveryPersistence = {
      status: released
        ? 'submission_delivery_released'
        : responsePersistenceReceipt
          ? 'submission_response_persisted'
          : 'submission_delivery_persisted',
      messageId: message.message_id,
      outboxStatus: message.status,
      responsePersistenceReceipt,
      releaseLockStatus: released?.status || lock?.status || null,
      blockers: [],
    };
  }
  return {
    version: 1,
    kind: 'PaperSubmissionLifecycle',
    paperId: row.task.paperId,
    mode,
    reviewedSubmit,
    venuePlan,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    approvalPacket,
    freshVenueEvidenceBundle,
    reviewedVenueEvidence,
    submissionDecisionPacket,
    reviewedSubmitPreflightPacket,
    controlledExecutorReceipt,
    manifest,
    handoff,
    replayGuard,
    outbox,
    receipt,
    receiptInbox,
    venueStateProof,
    auditArchive: hashedArchive,
    reconciliation,
    postActionReconciliation: deliveryRuntime.reconciliation,
    deliveryRuntime,
    deliveryPersistence,
    targetScopeReceipt,
    promotionGate,
    semanticPromotionLock: effectiveSemanticPromotionLock,
    safety: {
      dryRunOnly: !executorResponse,
      postActionEvidenceIngested: Boolean(executorResponse),
      externalActionPerformed: deliveryRuntime.externalActionPerformed,
      controlledExecutorReceiptRecorded: controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded',
      liveSubmitRequiresSeparateAuthorization: true,
      independentRefereeAuthorityVerified:
        independentReviewAuthorityReceipt?.status === 'independent_referee_acceptance_verified',
      liveAuthorizationVerified: liveAuthorized,
      executorImplementationPresent: false,
    },
  };
}
