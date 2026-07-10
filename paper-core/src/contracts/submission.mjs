import { normalizeText, uniqueStrings } from '../runtime/text-utils.mjs';
import { nowIso } from '../runtime/time-utils.mjs';
import {
  PAPER_CORE_VERSION,
  PAPER_MANIFEST_STATUS,
  PAPER_RUN_RECEIPT_STATUS,
  hashPaperRecord,
  normalizeRefs,
} from '../paper-contract-primitives.mjs';

export function buildSubmissionApprovalPacket({
  paperTask,
  mode = 'reviewed-submit',
  approved = false,
  approver = '',
  approvalActor = '',
  artifactPackage = null,
  venuePlan = null,
  researchReport = null,
  independentReviewAuthorityReceipt = null,
  liveAuthorizationReceipt = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('SubmissionApprovalPacket requires paperTask');
  const blockers = [];
  if (!approved) blockers.push('explicit_reviewed_submit_approval_required');
  if (!artifactPackage?.submitReady) blockers.push('artifact_package_not_submit_ready');
  if (venuePlan?.status !== 'local_dry_run_ready') blockers.push('venue_submission_plan_not_ready');
  if (researchReport?.status === 'blocked') blockers.push('research_verify_blocked');
  if (researchReport?.academicEvidenceStatus !== 'academic_evidence_verified'
    || researchReport?.academicEvidenceEligible !== true
    || researchReport?.academicEvidenceAttestation?.cryptographicSignaturesVerified !== true
    || Number(researchReport?.academicEvidenceAttestation?.verifiedWorkerReceiptCount || 0) < 1) {
    blockers.push('attested_academic_evidence_required_for_reviewed_submit');
  }
  if (independentReviewAuthorityReceipt?.status !== 'independent_referee_acceptance_verified'
    || independentReviewAuthorityReceipt?.acceptanceAuthorityReady !== true) {
    blockers.push('independent_referee_acceptance_authority_required');
  }
  if (liveAuthorizationReceipt?.status !== 'live_submission_authorization_verified'
    || liveAuthorizationReceipt?.liveExternalActionAuthorized !== true) {
    blockers.push('live_submission_authorization_required');
  }
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionApprovalPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizeText(mode) || 'reviewed-submit',
    status: blockers.length ? 'blocked_approval_packet' : 'approved_for_external_executor_handoff',
    approved: Boolean(approved) && blockers.length === 0,
    approver: normalizeText(approver) || null,
    approvalActor: normalizeText(approvalActor) || null,
    agentApproved: false,
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    researchReportHash: researchReport?.researchReportHash || researchReport?.researchVerifyReceiptHash || null,
    academicEvidenceVerificationHash: researchReport?.academicEvidenceAttestation
      ?.academicEvidenceAttestationVerificationHash || null,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    liveSubmissionAuthorizationReceiptHash:
      liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    externalExecutorRequired: true,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      grantsLiveExecutionInsideOverlay: false,
      externalActionPerformed: false,
      requiresSeparateExecutor: true,
      agentMayApprove: false,
      cryptographicDualControlRequired: true,
    },
    createdAt: createdAt || nowIso(),
  };
  const approvalHash = hashPaperRecord('SubmissionApprovalPacket', packet);
  return { ...packet, approvalHash, submissionApprovalPacketHash: approvalHash };
}

export function buildFreshVenueEvidenceBundle({
  paperTask,
  venuePlan,
  artifactPackage = null,
  researchReport = null,
  independentReviewAuthorityReceipt = null,
  requireAcademicEvidence = false,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !venuePlan?.kind) throw new Error('FreshVenueEvidenceBundle requires paperTask and venuePlan');
  const blockers = [];
  if (venuePlan.status !== 'local_dry_run_ready') blockers.push('venue_plan_not_ready');
  if (!artifactPackage?.artifactPackageHash) blockers.push('artifact_package_hash_missing');
  if (requireAcademicEvidence && (
    researchReport?.academicEvidenceStatus !== 'academic_evidence_verified'
    || researchReport?.academicEvidenceEligible !== true
    || researchReport?.academicEvidenceAttestation?.cryptographicSignaturesVerified !== true
    || Number(researchReport?.academicEvidenceAttestation?.verifiedWorkerReceiptCount || 0) < 1
  )) {
    blockers.push('attested_academic_evidence_required_for_reviewed_submit');
  }
  if (requireAcademicEvidence && (
    independentReviewAuthorityReceipt?.status !== 'independent_referee_acceptance_verified'
    || independentReviewAuthorityReceipt?.acceptanceAuthorityReady !== true
  )) {
    blockers.push('independent_referee_acceptance_authority_required');
  }
  const bundle = {
    version: PAPER_CORE_VERSION,
    kind: 'FreshVenueEvidenceBundle',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_fresh_venue_evidence' : 'fresh_venue_evidence_ready',
    venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    researchReportHash: researchReport?.researchReportHash || researchReport?.researchVerifyReceiptHash || null,
    academicEvidenceStatus: researchReport?.academicEvidenceStatus || null,
    academicEvidenceEligible: researchReport?.academicEvidenceEligible === true,
    academicEvidenceVerificationHash: researchReport?.academicEvidenceAttestation
      ?.academicEvidenceAttestationVerificationHash || null,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    evidenceRefs: normalizeRefs([
      ...(artifactPackage?.evidenceRefs || []),
      ...(researchReport?.evidenceRefs || []),
    ]),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      fetchedPortalState: false,
      externalActionPerformed: false,
      dryRunEvidenceOnly: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...bundle, freshVenueEvidenceBundleHash: hashPaperRecord('FreshVenueEvidenceBundle', bundle) };
}

export function buildSubmissionReplayGuard({
  manifest,
  venueEvidenceBundle = null,
  priorReceipt = null,
  createdAt = null,
} = {}) {
  if (!manifest?.kind) throw new Error('SubmissionReplayGuard requires manifest');
  const blockers = [];
  if (manifest.status !== PAPER_MANIFEST_STATUS.READY) blockers.push('manifest_not_ready');
  if (venueEvidenceBundle && venueEvidenceBundle.status !== 'fresh_venue_evidence_ready') blockers.push('fresh_venue_evidence_not_ready');
  if (priorReceipt?.externalActionPerformed) blockers.push('prior_external_action_already_performed');
  const guard = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionReplayGuard',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blockers.length ? 'blocked_replay_guard' : 'dry_run_replay_allowed',
    manifestHash: manifest.manifestHash,
    freshVenueEvidenceBundleHash: venueEvidenceBundle?.freshVenueEvidenceBundleHash || null,
    priorReceiptHash: priorReceipt?.receiptHash || null,
    replayKey: hashPaperRecord('SubmissionReplayKey', {
      paperId: manifest.paperId,
      action: manifest.action,
      manifestHash: manifest.manifestHash,
      freshVenueEvidenceBundleHash: venueEvidenceBundle?.freshVenueEvidenceBundleHash || null,
    }),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      preventsDuplicateLiveAction: true,
      grantsExecutionPermission: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...guard, submissionReplayGuardHash: hashPaperRecord('SubmissionReplayGuard', guard) };
}

export function buildExternalExecutorHandoffOutbox({
  manifest,
  handoff,
  replayGuard,
  createdAt = null,
} = {}) {
  if (!manifest?.kind || !handoff?.kind || !replayGuard?.kind) throw new Error('ExternalExecutorHandoffOutbox requires manifest, handoff, and replayGuard');
  const blockers = [
    ...(manifest.blockers || []),
    ...(handoff.blockers || []),
    ...(replayGuard.blockers || []),
  ];
  const outbox = {
    version: PAPER_CORE_VERSION,
    kind: 'ExternalExecutorHandoffOutbox',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blockers.length ? 'blocked_outbox_item' : 'queued_for_dry_run_executor',
    manifestHash: manifest.manifestHash,
    handoffEnvelopeHash: handoff.envelopeHash,
    replayGuardHash: replayGuard.submissionReplayGuardHash,
    commandPreview: handoff.commandPreview,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      previewOnly: true,
      externalActionPerformed: false,
      sourceMutation: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...outbox, externalExecutorHandoffOutboxHash: hashPaperRecord('ExternalExecutorHandoffOutbox', outbox) };
}

export function buildReviewedSubmitPreflightPacket({
  paperTask,
  approvalPacket,
  freshVenueEvidenceBundle,
  manifest,
  replayGuard,
  outbox,
  artifactPackage = null,
  researchReport = null,
  venuePlan = null,
  independentReviewAuthorityReceipt = null,
  liveAuthorizationReceipt = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !approvalPacket?.kind || !freshVenueEvidenceBundle?.kind || !manifest?.kind || !replayGuard?.kind || !outbox?.kind) {
    throw new Error('ReviewedSubmitPreflightPacket requires paperTask, approvalPacket, freshVenueEvidenceBundle, manifest, replayGuard, and outbox');
  }
  const authorityBlockers = [];
  if (independentReviewAuthorityReceipt?.status !== 'independent_referee_acceptance_verified') {
    authorityBlockers.push('independent_referee_acceptance_authority_required');
  }
  if (liveAuthorizationReceipt?.status !== 'live_submission_authorization_verified') {
    authorityBlockers.push('live_submission_authorization_required');
  }
  const blockers = uniqueStrings([
    ...(approvalPacket.blockers || []),
    ...(freshVenueEvidenceBundle.blockers || []),
    ...(manifest.blockers || []),
    ...(replayGuard.blockers || []),
    ...(outbox.blockers || []),
    ...authorityBlockers,
  ], 64);
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'ReviewedSubmitPreflightPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: 'reviewed-submit',
    status: blockers.length
      ? 'reviewed_submit_preflight_blocked'
      : 'reviewed_submit_preflight_ready_for_external_executor',
    externalExecutorHandoffReady: blockers.length === 0,
    approvalRequired: blockers.includes('explicit_reviewed_submit_approval_required') || !approvalPacket.approved,
    liveExecutorBoundaryBlocked: blockers.length > 0,
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    researchReportHash: researchReport?.researchReportHash || researchReport?.researchVerifyReceiptHash || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    approvalHash: approvalPacket.approvalHash || approvalPacket.submissionApprovalPacketHash || null,
    freshVenueEvidenceBundleHash: freshVenueEvidenceBundle.freshVenueEvidenceBundleHash || null,
    manifestHash: manifest.manifestHash || null,
    replayGuardHash: replayGuard.submissionReplayGuardHash || null,
    outboxHash: outbox.externalExecutorHandoffOutboxHash || null,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    liveSubmissionAuthorizationReceiptHash:
      liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    blockers,
    safety: {
      preflightOnly: true,
      grantsLiveExecutionInsideOverlay: false,
      requiresSeparateReviewedApproval: !approvalPacket.approved,
      requiresExternalExecutor: true,
      dualControlAuthorizationVerified:
        liveAuthorizationReceipt?.status === 'live_submission_authorization_verified',
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    reviewedSubmitPreflightPacketHash: hashPaperRecord('ReviewedSubmitPreflightPacket', packet),
  };
}

export function buildControlledExternalExecutorReceipt({
  paperTask,
  approvalPacket,
  reviewedSubmitPreflightPacket,
  manifest,
  outbox,
  replayGuard,
  independentReviewAuthorityReceipt = null,
  liveAuthorizationReceipt = null,
  executorId = 'openclaw-agent-controlled-reviewed-submit-executor',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !approvalPacket?.kind || !reviewedSubmitPreflightPacket?.kind || !manifest?.kind || !outbox?.kind || !replayGuard?.kind) {
    throw new Error('ControlledExternalExecutorReceipt requires paperTask, approvalPacket, reviewedSubmitPreflightPacket, manifest, outbox, and replayGuard');
  }
  const blockers = [];
  if (approvalPacket.status !== 'approved_for_external_executor_handoff') blockers.push('submission_approval_packet_not_ready');
  if (reviewedSubmitPreflightPacket.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (manifest.status !== PAPER_MANIFEST_STATUS.READY || !manifest.readyForAdapter) blockers.push('manifest_not_ready');
  if (outbox.status !== 'queued_for_dry_run_executor') blockers.push('executor_outbox_not_ready');
  if (replayGuard.status !== 'dry_run_replay_allowed') blockers.push('replay_guard_not_ready');
  if (independentReviewAuthorityReceipt?.status !== 'independent_referee_acceptance_verified') {
    blockers.push('independent_referee_acceptance_authority_required');
  }
  if (liveAuthorizationReceipt?.status !== 'live_submission_authorization_verified'
    || liveAuthorizationReceipt?.liveExternalActionAuthorized !== true) {
    blockers.push('live_submission_authorization_required');
  }
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'ControlledExternalExecutorReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    action: manifest.action,
    mode: 'reviewed-submit',
    status: blockers.length ? 'controlled_external_executor_blocked' : 'controlled_external_executor_receipt_recorded',
    executorId: normalizeText(executorId) || null,
    agentApproved: approvalPacket.agentApproved === true,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    liveSubmissionAuthorizationReceiptHash:
      liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    controlledExecutorReady: blockers.length === 0,
    liveSubmitPerformed: false,
    externalActionPerformed: false,
    hashChain: {
      approvalHash: approvalPacket.approvalHash || approvalPacket.submissionApprovalPacketHash || null,
      reviewedSubmitPreflightPacketHash: reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash || null,
      manifestHash: manifest.manifestHash || null,
      outboxHash: outbox.externalExecutorHandoffOutboxHash || null,
      replayGuardHash: replayGuard.submissionReplayGuardHash || null,
      independentRefereeAuthorityReceiptHash:
        independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
      liveSubmissionAuthorizationReceiptHash:
        liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    },
    blockers: uniqueStrings(blockers, 32),
    safety: {
      receiptOnly: true,
      grantsLiveExecutionInsideOverlay: false,
      executesExternalAction: false,
      externalActionPerformed: false,
      sourceMutation: false,
      liveSubmitPerformed: false,
      requiresSeparateRealPortalExecutor: true,
      dualControlAuthorizationVerified:
        liveAuthorizationReceipt?.status === 'live_submission_authorization_verified',
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    controlledExternalExecutorReceiptHash: hashPaperRecord('ControlledExternalExecutorReceipt', receipt),
  };
}

export function buildExternalSubmissionReceipt({
  manifest,
  outbox,
  venuePlan,
  reviewedSubmit = false,
  createdAt = null,
} = {}) {
  if (!manifest?.kind || !outbox?.kind || !venuePlan?.kind) throw new Error('ExternalSubmissionReceipt requires manifest, outbox, and venuePlan');
  const blockers = [
    ...(manifest.blockers || []),
    ...(outbox.blockers || []),
  ];
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'ExternalSubmissionReceipt',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blockers.length ? PAPER_RUN_RECEIPT_STATUS.BLOCKED : PAPER_RUN_RECEIPT_STATUS.DRY_RUN_RECORDED,
    result: blockers.length ? 'blocked' : 'dry_run_success',
    manifestHash: manifest.manifestHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
    reviewedSubmitRequested: Boolean(reviewedSubmit),
    externalActionPerformed: false,
    sourceMutationPerformed: false,
    blockers: uniqueStrings(blockers, 32),
    createdAt: createdAt || nowIso(),
  };
  const receiptHash = hashPaperRecord('ExternalSubmissionReceipt', receipt);
  return { ...receipt, receiptHash, externalSubmissionReceiptHash: receiptHash };
}

export function buildSubmissionReceiptInbox({
  receipt,
  outbox,
  createdAt = null,
} = {}) {
  if (!receipt?.kind || !outbox?.kind) throw new Error('SubmissionReceiptInbox requires receipt and outbox');
  const blockers = [];
  if (receipt.outboxHash !== outbox.externalExecutorHandoffOutboxHash) blockers.push('receipt_outbox_hash_mismatch');
  if (receipt.externalActionPerformed) blockers.push('unexpected_external_action_performed');
  const inbox = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionReceiptInbox',
    taskKey: receipt.taskKey,
    paperId: receipt.paperId,
    status: blockers.length ? 'blocked_receipt_inbox' : 'receipt_inbox_recorded',
    receiptHash: receipt.receiptHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    blockers: uniqueStrings(blockers, 32),
    createdAt: createdAt || nowIso(),
  };
  return { ...inbox, submissionReceiptInboxHash: hashPaperRecord('SubmissionReceiptInbox', inbox) };
}

export function buildSubmissionReconciliation({
  manifest,
  outbox,
  receipt,
  venueStateProof,
  auditArchive = null,
  createdAt = null,
} = {}) {
  if (!manifest?.kind || !outbox?.kind || !receipt?.kind || !venueStateProof?.kind) {
    throw new Error('SubmissionReconciliation requires manifest, outbox, receipt, and venueStateProof');
  }
  const blockers = [];
  if (receipt.manifestHash !== manifest.manifestHash) blockers.push('receipt_manifest_hash_mismatch');
  if (receipt.outboxHash !== outbox.externalExecutorHandoffOutboxHash) blockers.push('receipt_outbox_hash_mismatch');
  if (venueStateProof.receiptHash !== receipt.receiptHash) blockers.push('proof_receipt_hash_mismatch');
  if (receipt.externalActionPerformed || venueStateProof.externalStateChanged) blockers.push('unexpected_external_state_change');
  const reconciliation = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionReconciliation',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    status: blockers.length ? 'blocked_reconciliation' : 'dry_run_reconciled',
    manifestHash: manifest.manifestHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    receiptHash: receipt.receiptHash,
    venueStateProofHash: venueStateProof.venueStateProofHash,
    auditArchiveHash: auditArchive?.auditArchiveHash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      externalActionPerformed: false,
      externalStateChanged: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...reconciliation, submissionReconciliationHash: hashPaperRecord('SubmissionReconciliation', reconciliation) };
}
