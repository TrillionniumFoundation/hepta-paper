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
} from '../../paper-core/src/paper-contracts.mjs';
import { normalizeText } from '../../paper-core/src/utils.mjs';
import { verifyIndependentRefereeAuthority } from '../referee-review/independent-authority.mjs';
import { verifyLiveSubmissionAuthorization } from './live-authorization.mjs';

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
  researchReport = null,
  mode = 'reviewed-submit',
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const venuePlan = buildSubmissionVenuePlan({ row, venues, artifactPackage, mode });
  const sourceRoot = row?.task?.sourceWorkspace
    ? (path.isAbsolute(row.task.sourceWorkspace)
      ? row.task.sourceWorkspace
      : path.join(root, row.task.sourceWorkspace))
    : null;
  const independentReviewAuthorityReceipt = await verifyIndependentRefereeAuthority({
    root,
    runtimeRoot,
    sourceRoot,
    paperTask: row.task,
    researchReport,
    artifactPackage,
    venuePlan,
    trustStoreOverride,
    now,
  });
  const liveAuthorizationReceipt = await verifyLiveSubmissionAuthorization({
    root,
    runtimeRoot,
    paperTask: row.task,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    trustStoreOverride,
    now,
  });
  return {
    venuePlan,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
  };
}

export function buildSubmissionLifecycle({
  row,
  venues = [],
  artifactPackage = null,
  researchReport = null,
  mode = 'local-dry-run',
  reviewedSubmit = false,
  venuePlanOverride = null,
  independentReviewAuthorityReceipt = null,
  liveAuthorizationReceipt = null,
} = {}) {
  const venuePlan = venuePlanOverride || buildSubmissionVenuePlan({ row, venues, artifactPackage, mode });
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
  });
  const freshVenueEvidenceBundle = buildFreshVenueEvidenceBundle({
    paperTask: row.task,
    venuePlan,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    requireAcademicEvidence: Boolean(reviewedSubmit),
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
    safety: {
      dryRunOnly: true,
      externalActionPerformed: false,
      controlledExecutorReceiptRecorded: controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded',
      liveSubmitRequiresSeparateAuthorization: true,
      independentRefereeAuthorityVerified:
        independentReviewAuthorityReceipt?.status === 'independent_referee_acceptance_verified',
      liveAuthorizationVerified: liveAuthorized,
      executorImplementationPresent: false,
    },
  };
}
