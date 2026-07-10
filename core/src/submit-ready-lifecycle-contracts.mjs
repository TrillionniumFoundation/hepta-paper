import path from 'node:path';
import { digest } from './hash-utils.mjs';
import { validateFeedbackLearningContinuity } from './feedback-learning-bridge-contracts.mjs';

export const SUBMIT_READY_LIFECYCLE_VERSION = 1;

export const SUBMIT_READY_LIFECYCLE_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

export function currentSubmitReadyItems(caseIndex = null) {
  return [
    ...(caseIndex?.artifacts || []),
    ...(caseIndex?.files || []),
  ].filter((item) => item?.submitReady);
}

export function normalizedSubmitReadyNames(values = []) {
  return [...new Set(values
    .map((value) => path.basename(String(value || '').trim()))
    .filter(Boolean))]
    .sort();
}

export const normalizedNames = normalizedSubmitReadyNames;

export function currentSubmitReadyNames(caseIndex = null) {
  return normalizedSubmitReadyNames(currentSubmitReadyItems(caseIndex).map((item) => item.name || item.path || item.file));
}

export function currentSubmitReadyPaths(caseIndex = null) {
  return currentSubmitReadyItems(caseIndex)
    .map((item) => item.path || item.file)
    .filter(Boolean)
    .map((file) => path.resolve(String(file)))
    .sort();
}

export function caseSubmitReadyCount(caseIndex = null) {
  return currentSubmitReadyItems(caseIndex).length;
}

export function caseSubmitReadyFiles(caseIndex = null) {
  return currentSubmitReadyItems(caseIndex)
    .map((item) => item.path || item.file || item.name)
    .filter(Boolean);
}

export function finalReviewPaths(finalReview = null) {
  return [
    ...(finalReview?.files || []),
    ...(finalReview?.selectedFiles || []).map((item) => item?.path || item?.file || item),
  ]
    .filter(Boolean)
    .map((file) => path.resolve(String(file)))
    .sort();
}

export function finalReviewNames(finalReview = null) {
  return normalizedSubmitReadyNames(finalReviewPaths(finalReview));
}

export function finalReviewAuditFiles(finalReview = null) {
  return [
    ...(finalReview?.audit?.files || []),
    ...(finalReview?.fileEvidence || []),
    ...(finalReview?.artifacts || []),
  ].filter((item) => item?.path || item?.file);
}

export function sameSubmitReadySet(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const sameNames = sameSubmitReadySet;

export function finalReviewCurrentSync(finalReview = null, caseIndex = null, { plan = null, manifest = null } = {}) {
  const issues = [];
  if ((finalReview?.decision || null) !== 'pass') issues.push('final_review_pass_required');
  const currentNames = currentSubmitReadyNames(caseIndex);
  const reviewedNames = finalReviewNames(finalReview);
  const currentPaths = currentSubmitReadyPaths(caseIndex);
  const reviewedPaths = finalReviewPaths(finalReview);
  if (currentNames.length && !reviewedNames.length) issues.push('final_review_file_names_required');
  if (currentNames.length && reviewedNames.length && !sameSubmitReadySet(currentNames, reviewedNames)) issues.push('final_review_current_files_required');
  if (currentPaths.length && reviewedPaths.length && !sameSubmitReadySet(currentPaths, reviewedPaths)) issues.push('final_review_current_paths_required');
  if (currentPaths.length && !reviewedPaths.length) issues.push('final_review_file_paths_required');
  const feedbackContinuity = validateFeedbackLearningContinuity({ plan, manifest, finalReview });
  if (!feedbackContinuity.ok) {
    issues.push(...feedbackContinuity.issues.map((item) => item.code || 'feedback_learning_bridge_stale'));
  }
  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    currentNames,
    reviewedNames,
    currentPaths,
    reviewedPaths,
    feedbackLearningContinuity: feedbackContinuity.required ? feedbackContinuity : null,
  };
}

export function flowJobForTask(flowState = null, taskId = null, orderId = null) {
  if (!flowState?.jobs) return null;
  const taskKey = taskId !== null && taskId !== undefined ? 'task:' + String(taskId) : null;
  const orderKey = orderId !== null && orderId !== undefined ? 'order:' + String(orderId) : null;
  if (taskKey && flowState.jobs[taskKey]) return { key: taskKey, ...flowState.jobs[taskKey] };
  if (orderKey && flowState.jobs[orderKey]) return { key: orderKey, ...flowState.jobs[orderKey] };
  return Object.entries(flowState.jobs || {})
    .map(([key, job]) => ({ key, ...job }))
    .find((job) => (taskId !== null && taskId !== undefined && String(job.taskId) === String(taskId))
      || (orderId !== null && orderId !== undefined && String(job.orderId) === String(orderId))) || null;
}

export function alreadySubmittedSignals({ entry = null, flowJob = null } = {}) {
  const status = flowJob?.status || entry?.flowStatus || entry?.status || null;
  const workNo = flowJob?.workNo || entry?.workNo || entry?.lastSubmittedWorkNo || null;
  const submittedAt = flowJob?.submittedAt || entry?.submittedAt || entry?.lastSubmittedVerifiedAt || null;
  const lastStep = flowJob?.lastStep || entry?.lastStep || '';
  const submitted = status === 'submitted_verified'
    || !!workNo
    || !!submittedAt
    || /submit_live_success|submitted_verified/i.test(String(lastStep || ''));
  return {
    submitted,
    status,
    workNo,
    submittedAt,
    lastStep,
  };
}

function cleanupSummary(cleanup = null) {
  if (!cleanup) return null;
  const skippedFiles = Number(cleanup.skippedFiles || 0);
  return {
    status: skippedFiles ? 'fail' : 'pass',
    skippedFiles,
    deletedFiles: Number(cleanup.deletedFiles ?? cleanup.movedFiles ?? 0),
    deletedBytes: Number(cleanup.deletedBytes ?? cleanup.movedBytes ?? 0),
    cleanupStamp: cleanup.cleanupStamp || null,
    reportPath: cleanup.reportPath || null,
  };
}

export function buildSubmitReadyLedgerEntry({
  taskId = null,
  orderId = null,
  title = null,
  entry = null,
  flowJob = null,
  caseIndex = null,
  finalReview = null,
  plan = null,
  manifest = null,
  cleanup = null,
  now = null,
} = {}) {
  const finalGate = finalReviewCurrentSync(finalReview, caseIndex, { plan, manifest });
  const submittedSignals = alreadySubmittedSignals({ entry, flowJob });
  const submitReadyFiles = caseSubmitReadyFiles(caseIndex);
  const submitReadyCount = submitReadyFiles.length;
  const cleanupState = cleanupSummary(cleanup);
  const status = submittedSignals.submitted
    ? 'already_submitted'
    : finalGate.ok && submitReadyCount > 0
      ? 'submit_ready_current'
      : finalReview?.decision === 'pass' && !finalGate.ok
        ? 'final_review_stale'
        : submitReadyCount > 0
          ? 'submit_ready_needs_final_review'
          : 'not_submit_ready';
  const blockers = [
    ...finalGate.issues,
    cleanupState?.status === 'fail' ? 'submit_ready_cleanup_skipped_files' : null,
  ].filter(Boolean);
  const ledger = {
    version: SUBMIT_READY_LIFECYCLE_VERSION,
    taskId: taskId || entry?.taskId || flowJob?.taskId || null,
    orderId: orderId || entry?.orderId || flowJob?.orderId || null,
    title: title || entry?.title || flowJob?.title || null,
    status,
    submitReadyCount,
    submitReadyFiles,
    currentNames: finalGate.currentNames,
    reviewedNames: finalGate.reviewedNames,
    finalReviewDecision: finalReview?.decision || null,
    finalReviewCurrentOk: finalGate.ok,
    finalReviewCurrentIssues: finalGate.issues,
    cleanup: cleanupState,
    feedbackLearningContinuity: finalGate.feedbackLearningContinuity,
    submittedSignals,
    generatedAt: now || new Date().toISOString(),
  };
  ledger.blockers = [...new Set(blockers)];
  ledger.ledgerHash = digest({
    version: ledger.version,
    taskId: ledger.taskId,
    orderId: ledger.orderId,
    status: ledger.status,
    submitReadyFiles: ledger.submitReadyFiles,
    finalReviewDecision: ledger.finalReviewDecision,
    finalReviewCurrentIssues: ledger.finalReviewCurrentIssues,
    feedbackLearningContinuityHash: ledger.feedbackLearningContinuity?.continuityHash || null,
    cleanup: ledger.cleanup,
    submittedSignals: ledger.submittedSignals,
  });
  return ledger;
}

export function summarizeSubmitReadyLedger(entries = []) {
  const rows = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const byStatus = {};
  for (const item of rows) byStatus[item.status || 'unknown'] = Number(byStatus[item.status || 'unknown'] || 0) + 1;
  return {
    version: SUBMIT_READY_LIFECYCLE_VERSION,
    count: rows.length,
    readyCurrent: Number(byStatus.submit_ready_current || 0),
    alreadySubmitted: Number(byStatus.already_submitted || 0),
    staleFinalReview: Number(byStatus.final_review_stale || 0),
    needsFinalReview: Number(byStatus.submit_ready_needs_final_review || 0),
    notSubmitReady: Number(byStatus.not_submit_ready || 0),
    cleanupFail: rows.filter((item) => item.cleanup?.status === 'fail').length,
    byStatus,
    ledgerHash: digest(rows.map((item) => ({
      taskId: item.taskId,
      orderId: item.orderId,
      status: item.status,
      submitReadyCount: item.submitReadyCount,
      finalReviewCurrentOk: item.finalReviewCurrentOk,
      cleanupStatus: item.cleanup?.status || null,
      ledgerHash: item.ledgerHash || null,
    }))),
  };
}

export function submitReadyLifecycleContractsSelftest() {
  const caseIndex = {
    artifacts: [
      { submitReady: true, name: 'final-a.png', path: '/tmp/final-a.png' },
      { submitReady: true, name: 'final-b.png', path: '/tmp/final-b.png' },
      { submitReady: false, name: 'draft.png', path: '/tmp/draft.png' },
    ],
  };
  const finalReview = {
    decision: 'pass',
    files: ['/tmp/final-a.png', '/tmp/final-b.png'],
  };
  const gate = finalReviewCurrentSync(finalReview, caseIndex);
  const stale = finalReviewCurrentSync({ decision: 'pass', files: ['/tmp/final-a.png'] }, caseIndex);
  const entry = buildSubmitReadyLedgerEntry({ taskId: 1001, caseIndex, finalReview, cleanup: { skippedFiles: 0, deletedFiles: 2, deletedBytes: 20 } });
  const summary = summarizeSubmitReadyLedger([entry]);
  return {
    ok: gate.ok
      && stale.issues.includes('final_review_current_files_required')
      && entry.status === 'submit_ready_current'
      && entry.ledgerHash?.startsWith('sha256:')
      && summary.readyCurrent === 1,
    version: SUBMIT_READY_LIFECYCLE_VERSION,
    safety: SUBMIT_READY_LIFECYCLE_SAFETY,
    status: entry.status,
    summary,
  };
}
