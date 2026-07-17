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
  createPaperActionManifest,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { buildSubmissionDeliveryRuntime } from '../../paper-domain/submission/delivery-runtime.mjs';
import { buildReviewedVenueEvidence } from '../../paper-domain/submission/reviewed-venue-evidence.mjs';
import { buildSemanticPromotionLock } from '../../paper-domain/submission/semantic-promotion-lock.mjs';
import { buildSubmissionVenuePlan } from './submission-venue-plan.mjs';

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
  const venueEvidenceNowMs = venueEvidenceNow instanceof Date
    ? venueEvidenceNow.getTime()
    : Date.parse(String(venueEvidenceNow || ''));
  const lifecycleCreatedAt = Number.isFinite(venueEvidenceNowMs)
    ? new Date(venueEvidenceNowMs).toISOString()
    : null;
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
    createdAt: lifecycleCreatedAt,
  });
  const handoff = buildPaperHandoffEnvelope({ manifest, createdAt: lifecycleCreatedAt });
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
