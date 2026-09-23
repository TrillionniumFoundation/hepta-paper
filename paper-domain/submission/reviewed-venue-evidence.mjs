import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PLACEHOLDER = /\b(?:auto[_ -]?draft|placeholder|tbd|todo|unknown|example\.com)\b/i;
const HASH = /^sha256:[a-f0-9]{64}$/i;

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

export function buildReviewedVenueEvidence({
  paperTask,
  venuePlan,
  observation = null,
  now = null,
  purpose = 'submission_preflight',
  sourceVerificationReceipt = null,
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) blockers.push('reviewed_venue_reference_time_required');
  const observedAtMs = Date.parse(String(observation?.observedAt || ''));
  const expiresAtMs = Date.parse(String(observation?.expiresAt || ''));
  const evidenceHashes = unique(observation?.evidenceHashes).sort();
  const requiredText = ['provider', 'portalRoute', 'venueTarget', 'track', 'deadlineState', 'observedState', 'reviewedBy'];
  if (!paperTask?.taskKey) blockers.push('reviewed_venue_evidence_paper_task_missing');
  if (venuePlan?.status !== 'local_dry_run_ready') blockers.push('reviewed_venue_evidence_venue_plan_not_ready');
  if (!observation) blockers.push('reviewed_venue_observation_missing');
  for (const field of requiredText) {
    const value = String(observation?.[field] || '').trim();
    if (!value) blockers.push(`reviewed_venue_${field}_missing`);
    else if (PLACEHOLDER.test(value)) blockers.push(`reviewed_venue_${field}_placeholder_forbidden`);
  }
  if (observation?.fetchedPortalState !== true) blockers.push('reviewed_venue_portal_state_not_fetched');
  if (!Number.isFinite(observedAtMs)) blockers.push('reviewed_venue_observed_at_invalid');
  if (!Number.isFinite(expiresAtMs)) blockers.push('reviewed_venue_expires_at_invalid');
  if (Number.isFinite(observedAtMs) && Number.isFinite(nowMs) && observedAtMs > nowMs) blockers.push('reviewed_venue_observation_in_future');
  if (Number.isFinite(observedAtMs) && Number.isFinite(nowMs) && nowMs - observedAtMs > 24 * 60 * 60 * 1000) blockers.push('reviewed_venue_observation_stale');
  if (Number.isFinite(observedAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs <= observedAtMs) {
    blockers.push('reviewed_venue_expiry_not_after_observation');
  }
  if (Number.isFinite(observedAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs - observedAtMs > 24 * 60 * 60 * 1000) blockers.push('reviewed_venue_evidence_lifetime_exceeds_policy');
  if (Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && nowMs >= expiresAtMs) blockers.push('reviewed_venue_evidence_expired');
  if (!evidenceHashes.length) blockers.push('reviewed_venue_evidence_hashes_missing');
  if (evidenceHashes.some((value) => !HASH.test(value))) blockers.push('reviewed_venue_evidence_hash_invalid');
  const expectedTarget = venuePlan?.venue?.name || venuePlan?.target || paperTask?.venueTarget || null;
  if (expectedTarget && observation?.venueTarget !== expectedTarget) blockers.push('reviewed_venue_target_mismatch');
  if (purpose === 'submission_preflight') {
    if (!['open', 'open_until_deadline'].includes(observation?.deadlineState)) blockers.push('reviewed_venue_deadline_not_open');
    if (!['accepting_submissions', 'submission_form_available'].includes(observation?.observedState)) {
      blockers.push('reviewed_venue_not_accepting_submissions');
    }
  }
  if (purpose === 'ambiguous_redrive' && observation?.observedState !== 'not_submitted') {
    blockers.push('reviewed_venue_non_submission_not_proven');
  }
  if (sourceVerificationReceipt?.status !== 'reviewed_venue_observation_source_verified'
    || sourceVerificationReceipt?.cryptographicSignaturesVerified !== true
    || sourceVerificationReceipt?.ledgerReceiptsVerified !== true
    || sourceVerificationReceipt?.artifactSourcesVerified !== true) {
    blockers.push('reviewed_venue_source_verification_required');
  }
  if (sourceVerificationReceipt?.purpose !== purpose) blockers.push('reviewed_venue_source_purpose_mismatch');
  if (sourceVerificationReceipt?.provider !== observation?.provider) blockers.push('reviewed_venue_source_provider_mismatch');
  if (sourceVerificationReceipt?.portalRoute !== observation?.portalRoute) blockers.push('reviewed_venue_source_portal_route_mismatch');
  if (sourceVerificationReceipt?.reviewedBy !== observation?.reviewedBy
    || !(sourceVerificationReceipt?.verifiedSubjectIds || []).includes(observation?.reviewedBy)) blockers.push('reviewed_venue_source_reviewer_mismatch');
  const payload = {
    version: 1,
    kind: 'ReviewedVenueEvidence',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'reviewed_venue_evidence_blocked' : 'reviewed_venue_evidence_verified',
    purpose,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    provider: observation?.provider || null,
    portalRoute: observation?.portalRoute || null,
    venueTarget: observation?.venueTarget || null,
    track: observation?.track || null,
    deadlineState: observation?.deadlineState || null,
    observedState: observation?.observedState || null,
    observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : null,
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    reviewedBy: observation?.reviewedBy || null,
    evidenceHashes,
    retargetEvidenceHashes: unique(observation?.retargetEvidenceHashes).sort(),
    exceptionEvidenceHashes: unique(observation?.exceptionEvidenceHashes).sort(),
    fetchedPortalState: observation?.fetchedPortalState === true,
    observationSubjectHash: sourceVerificationReceipt?.observationSubjectHash || null,
    sourceVerificationReceiptHash: sourceVerificationReceipt?.reviewedVenueObservationSourceVerificationReceiptHash || null,
    sourceVerifiedSubjectIds: sourceVerificationReceipt?.verifiedSubjectIds || [],
    blockers: unique(blockers),
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, reviewedVenueEvidenceHash: hashRecord('ReviewedVenueEvidence', payload) });
}
