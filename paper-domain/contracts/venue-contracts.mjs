import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { PAPER_CORE_VERSION, PAPER_RUN_RECEIPT_STATUS, hashPaperRecord } from './primitives.mjs';

export function buildVenueSubmissionPlan({
  paperTask,
  venue = null,
  artifactPackage = null,
  mode = 'local-dry-run',
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('VenueSubmissionPlan requires paperTask');
  const planBlockers = [...(blockers || [])];
  if (!paperTask.venueTarget && !venue?.name) planBlockers.push('venue_target_missing');
  if (!artifactPackage?.artifactCount) planBlockers.push('artifact_package_missing');
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueSubmissionPlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    venueTarget: paperTask.venueTarget || venue?.name || null,
    venueId: venue?.venue_id || venue?.venueId || null,
    venueKind: venue?.kind || null,
    mode: normalizeText(mode) || 'local-dry-run',
    status: planBlockers.length ? 'blocked_plan' : 'local_dry_run_ready',
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    externalActionAuthorized: false,
    blockers: uniqueStrings(planBlockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      opensPortal: false,
      uploads: false,
      emails: false,
      submits: false,
    },
    createdAt: createdAt || null,
  };
  return { ...plan, venueSubmissionPlanHash: hashPaperRecord('VenueSubmissionPlan', plan) };
}

export function buildVenueStateProof({ receipt, venuePlan, createdAt = null } = {}) {
  if (!receipt?.kind || !venuePlan?.kind) throw new Error('VenueStateProof requires receipt and venuePlan');
  const blockers = [];
  if (receipt.status !== PAPER_RUN_RECEIPT_STATUS.DRY_RUN_RECORDED) blockers.push('receipt_not_dry_run_recorded');
  if (venuePlan.status !== 'local_dry_run_ready') blockers.push('venue_plan_not_ready');
  if (receipt.externalActionPerformed) blockers.push('unexpected_external_action_performed');
  if (venuePlan.externalActionAuthorized) blockers.push('unexpected_external_authorization');
  const proof = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueStateProof',
    taskKey: receipt.taskKey,
    paperId: receipt.paperId,
    venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
    receiptHash: receipt.receiptHash,
    status: blockers.length ? 'blocked_proof' : 'dry_run_state_proof',
    externalStateChanged: false,
    blockers,
    createdAt: createdAt || null,
  };
  return { ...proof, venueStateProofHash: hashPaperRecord('VenueStateProof', proof) };
}
