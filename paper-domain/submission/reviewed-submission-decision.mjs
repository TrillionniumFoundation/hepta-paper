import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PLACEHOLDER = /\b(?:auto[_ -]?draft|placeholder|tbd|todo|unknown)\b/i;
const SECRET = /(?:-----BEGIN .*PRIVATE KEY-----|\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=])/i;
const REQUIRED_CONFIRMATIONS = Object.freeze([
  'title', 'abstract', 'authors', 'track', 'anonymity', 'keywords', 'subjectAreas',
  'conflicts', 'supplements', 'checklist', 'coverLetter',
]);

function textInvalid(value) {
  const text = String(value || '').trim();
  return !text || PLACEHOLDER.test(text) || SECRET.test(text);
}

export function buildReviewedSubmissionDecisionPacket({ paperTask, venuePlan, metadata = null, review = null } = {}) {
  const blockers = [];
  if (!paperTask?.taskKey) blockers.push('submission_decision_paper_task_missing');
  if (venuePlan?.status !== 'local_dry_run_ready') blockers.push('submission_decision_venue_plan_not_ready');
  for (const field of ['title', 'abstract', 'track', 'anonymity', 'coverLetter']) {
    if (textInvalid(metadata?.[field])) blockers.push(`submission_metadata_${field}_invalid`);
  }
  for (const field of ['authors', 'keywords', 'subjectAreas', 'conflicts', 'supplements']) {
    if (!Array.isArray(metadata?.[field])) blockers.push(`submission_metadata_${field}_invalid`);
  }
  if (!metadata?.checklist || typeof metadata.checklist !== 'object' || Array.isArray(metadata.checklist)) {
    blockers.push('submission_metadata_checklist_invalid');
  }
  const serialized = JSON.stringify(metadata || {});
  if (SECRET.test(serialized)) blockers.push('submission_metadata_secret_like_material_forbidden');
  if (PLACEHOLDER.test(serialized)) blockers.push('submission_metadata_placeholder_forbidden');
  if (!review?.reviewedBy || !review?.reviewedAt) blockers.push('submission_metadata_human_review_missing');
  if (review?.reviewActorType !== 'human') blockers.push('submission_metadata_human_confirmation_required');
  const confirmed = new Set(Array.isArray(review?.humanConfirmedFields) ? review.humanConfirmedFields.map(String) : []);
  for (const field of REQUIRED_CONFIRMATIONS) if (!confirmed.has(field)) blockers.push(`submission_metadata_human_confirmation_missing:${field}`);
  const payload = {
    version: 1,
    kind: 'ReviewedSubmissionDecisionPacket',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'reviewed_submission_decision_blocked' : 'reviewed_submission_decision_verified',
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    metadata: metadata || null,
    reviewedBy: review?.reviewedBy || null,
    reviewedAt: review?.reviewedAt || null,
    reviewActorType: review?.reviewActorType || null,
    humanConfirmedFields: [...confirmed].sort(),
    machineSuggestionsAreAuthority: false,
    localWorksheetGrantsAuthorization: false,
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, reviewedSubmissionDecisionPacketHash: hashRecord('ReviewedSubmissionDecisionPacket', payload) });
}
