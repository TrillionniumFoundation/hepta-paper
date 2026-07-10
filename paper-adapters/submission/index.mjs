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

function matchVenue(venues = [], target = '') {
  const normalized = normalizeText(target).toLowerCase();
  if (!normalized) return null;
  return venues.find((venue) => normalizeText(venue.name).toLowerCase() === normalized)
    || venues.find((venue) => normalized.includes(normalizeText(venue.name).toLowerCase()))
    || venues.find((venue) => normalizeText(venue.venue_id).toLowerCase() === normalized)
    || null;
}

export function buildSubmissionLifecycle({
  row,
  venues = [],
  artifactPackage = null,
  researchReport = null,
  mode = 'local-dry-run',
  reviewedSubmit = false,
} = {}) {
  const venue = row.venue || matchVenue(venues, row.task.venueTarget);
  const venuePlan = buildVenueSubmissionPlan({
    paperTask: row.task,
    venue,
    artifactPackage,
    mode,
    warnings: venue ? [] : ['venue_registry_match_missing'],
  });
  const approvalPacket = buildSubmissionApprovalPacket({
    paperTask: row.task,
    mode,
    approved: Boolean(reviewedSubmit),
    approver: reviewedSubmit ? 'openclaw-agent' : '',
    approvalActor: reviewedSubmit ? 'agent' : '',
    artifactPackage,
    venuePlan,
    researchReport,
  });
  const freshVenueEvidenceBundle = buildFreshVenueEvidenceBundle({
    paperTask: row.task,
    venuePlan,
    artifactPackage,
    researchReport,
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
    extraBlockers: row.state?.blockers || [],
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
    manifestHash: manifest.manifestHash,
    replayGuardHash: replayGuard.submissionReplayGuardHash,
    envelopeHash: handoff.envelopeHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    receiptHash: receipt.receiptHash,
    receiptInboxHash: receiptInbox.submissionReceiptInboxHash,
    venueStateProofHash: venueStateProof.venueStateProofHash,
    externalActionPerformed: false,
    liveSubmitBlocked: false,
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
    },
  };
}
