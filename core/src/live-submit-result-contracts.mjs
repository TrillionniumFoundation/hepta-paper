import { EXTERNAL_ACTIONS, normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const LIVE_SUBMIT_RESULT_CONTRACT_VERSION = 1;

export const LIVE_SUBMIT_RESULT_STATUS = Object.freeze({
  SUBMITTED_VERIFIED: 'submitted_verified',
  SUBMITTED_UNCONFIRMED: 'submitted_unconfirmed',
  PREPARED: 'prepared',
  PREPARE_ONLY_DONE: 'prepare_only_done',
  ALREADY_SUBMITTED: 'already_submitted',
  NOT_SUBMITTED: 'not_submitted',
  BLOCKED: 'blocked',
  BLOCKED_CAPTCHA: 'blocked_captcha',
  BLOCKED_REFUND: 'blocked_refund',
  BLOCKED_DUPLICATE: 'blocked_duplicate',
  BLOCKED_BACKEND_REJECTED: 'blocked_backend_rejected',
  BLOCKED_PREPARE_MISMATCH: 'blocked_prepare_mismatch',
  BLOCKED_NO_SUBMIT_PATH: 'blocked_no_submit_path',
});

export const LIVE_SUBMIT_BLOCKER_TYPES = Object.freeze({
  CAPTCHA_REQUIRED: 'captcha_required',
  EMPLOYER_REFUND_REQUESTED: 'employer_refund_requested',
  SELLER_VERIFIED_WORK_EXISTS: 'seller_verified_work_exists',
  BACKEND_REJECTED: 'backend_rejected',
  PREPARE_VERIFICATION_FAILED: 'prepare_verification_failed',
  LIVE_SUBMIT_PATH_MISSING: 'live_submit_path_missing',
  NO_MY_WORKS_RECORDS: 'no_my_works_records',
  UNKNOWN: 'unknown_submit_blocker',
});

function text(value) {
  return normalizeText(value || '') || null;
}

function boolOrNull(value) {
  return value === undefined || value === null ? null : Boolean(value);
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function stageText(input = {}) {
  return [
    input.stage,
    input.status,
    input.reason,
    input.blockerType,
    input.errorType,
    input.error,
    input.description,
    input.message,
  ].map((item) => text(item)).filter(Boolean).join(' ');
}

function hasPattern(value, pattern) {
  return pattern.test(stageText(value));
}

function firstWorkId(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeSellerItems(input = {}) {
  const items = Array.isArray(input.items)
    ? input.items
    : (Array.isArray(input.sellerItems) ? input.sellerItems : []);
  return items.map((item = {}) => ({
    worksId: text(item.worksId || item.workId),
    worksIsHidden: boolOrNull(item.worksIsHidden),
    buyerIsHide: boolOrNull(item.buyerIsHide),
    fileCount: numberOrNull(item.fileCount || item.files?.length),
    sellerName: text(item.sellerName),
  }));
}

function deriveBlockerType(input, { hasSubmissionProof }) {
  if (hasSubmissionProof) return null;
  if (hasPattern(input, /captcha|geetest|滑块|验证码/i)) return LIVE_SUBMIT_BLOCKER_TYPES.CAPTCHA_REQUIRED;
  if (hasPattern(input, /refund|退款|employer_refund_requested/i)) return LIVE_SUBMIT_BLOCKER_TYPES.EMPLOYER_REFUND_REQUESTED;
  if (hasPattern(input, /duplicate|already_submitted|seller_verified_work_exists|existing_verified_submission/i)) {
    return LIVE_SUBMIT_BLOCKER_TYPES.SELLER_VERIFIED_WORK_EXISTS;
  }
  if (hasPattern(input, /backend_rejected|TRADE-|订单当前状态无法交稿|rejected/i)) return LIVE_SUBMIT_BLOCKER_TYPES.BACKEND_REJECTED;
  if (hasPattern(input, /prepare_mismatch|prepare_verification_failed|upload.*mismatch/i)) return LIVE_SUBMIT_BLOCKER_TYPES.PREPARE_VERIFICATION_FAILED;
  if (hasPattern(input, /no_my_works_records|totalMyWorks=0|totalMyWorks 0/i)) return LIVE_SUBMIT_BLOCKER_TYPES.NO_MY_WORKS_RECORDS;
  if (hasPattern(input, /missing_seller_submit_entry|submit_entry_missing|public_xq_only|seller_task_page_not_found|no_submit|submit button missing/i)) {
    return LIVE_SUBMIT_BLOCKER_TYPES.LIVE_SUBMIT_PATH_MISSING;
  }
  return null;
}

function deriveStatus(input, { hasSubmissionProof, blockerType, totalMyWorks }) {
  const rawStage = text(input.stage || input.status || input.resultStatus);
  if (hasSubmissionProof) {
    if (hasPattern(input, /already_submitted|seller_verified_work_exists|duplicate/i)) return LIVE_SUBMIT_RESULT_STATUS.ALREADY_SUBMITTED;
    return LIVE_SUBMIT_RESULT_STATUS.SUBMITTED_VERIFIED;
  }
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.CAPTCHA_REQUIRED) return LIVE_SUBMIT_RESULT_STATUS.BLOCKED_CAPTCHA;
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.EMPLOYER_REFUND_REQUESTED) return LIVE_SUBMIT_RESULT_STATUS.BLOCKED_REFUND;
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.SELLER_VERIFIED_WORK_EXISTS) return LIVE_SUBMIT_RESULT_STATUS.BLOCKED_DUPLICATE;
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.BACKEND_REJECTED) return LIVE_SUBMIT_RESULT_STATUS.BLOCKED_BACKEND_REJECTED;
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.PREPARE_VERIFICATION_FAILED) return LIVE_SUBMIT_RESULT_STATUS.BLOCKED_PREPARE_MISMATCH;
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.LIVE_SUBMIT_PATH_MISSING) return LIVE_SUBMIT_RESULT_STATUS.BLOCKED_NO_SUBMIT_PATH;
  if (rawStage === LIVE_SUBMIT_RESULT_STATUS.PREPARED || rawStage === LIVE_SUBMIT_RESULT_STATUS.PREPARE_ONLY_DONE) return rawStage;
  if (/submitted_unconfirmed/.test(rawStage || '')) return LIVE_SUBMIT_RESULT_STATUS.SUBMITTED_UNCONFIRMED;
  if (totalMyWorks === 0 || blockerType === LIVE_SUBMIT_BLOCKER_TYPES.NO_MY_WORKS_RECORDS) return LIVE_SUBMIT_RESULT_STATUS.NOT_SUBMITTED;
  if (/blocked/.test(rawStage || '')) return LIVE_SUBMIT_RESULT_STATUS.BLOCKED;
  return LIVE_SUBMIT_RESULT_STATUS.NOT_SUBMITTED;
}

function retryPolicyFor({ status, blockerType, hasSubmissionProof }) {
  if (hasSubmissionProof) return 'do_not_retry_already_landed';
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.CAPTCHA_REQUIRED) return 'human_captcha_then_readonly_verify_before_retry';
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.EMPLOYER_REFUND_REQUESTED) return 'do_not_retry_refund_gate';
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.SELLER_VERIFIED_WORK_EXISTS) return 'do_not_retry_duplicate';
  if (blockerType === LIVE_SUBMIT_BLOCKER_TYPES.BACKEND_REJECTED) return 'do_not_retry_until_live_state_changes';
  if (status === LIVE_SUBMIT_RESULT_STATUS.NOT_SUBMITTED) return 'fresh_approval_and_evidence_required_before_retry';
  return 'review_required_before_retry';
}

export function normalizeLiveSubmitResult(input = {}) {
  const sellerItems = normalizeSellerItems(input);
  const latestItem = sellerItems.find((item) => item.worksId) || sellerItems[0] || null;
  const worksId = firstWorkId(input.worksId, input.workId, input.latestWorkNo, latestItem?.worksId);
  const submissionId = firstWorkId(input.submissionId, input.manuscriptId);
  const externalResultId = firstWorkId(input.externalResultId, input.resultId, input.id);
  const totalMyWorks = numberOrNull(input.totalMyWorks ?? input.totalPage ?? input.total);
  const fileCount = numberOrNull(input.fileCount ?? input.files?.length ?? latestItem?.fileCount);
  const worksIsHidden = boolOrNull(input.worksIsHidden ?? latestItem?.worksIsHidden);
  const buyerIsHide = boolOrNull(input.buyerIsHide ?? latestItem?.buyerIsHide);
  const hasSubmissionProof = Boolean(worksId || submissionId || externalResultId);
  const blockerType = deriveBlockerType(input, { hasSubmissionProof });
  const status = deriveStatus(input, { hasSubmissionProof, blockerType, totalMyWorks });
  const sellerVerifiedWorkExists = hasSubmissionProof || (Number(totalMyWorks) > 0 && Boolean(worksId || latestItem?.worksId));
  const hiddenVerified = worksIsHidden === true || buyerIsHide === true;
  const contract = {
    version: LIVE_SUBMIT_RESULT_CONTRACT_VERSION,
    action: EXTERNAL_ACTIONS.LIVE_SUBMIT,
    status,
    submitted: status === LIVE_SUBMIT_RESULT_STATUS.SUBMITTED_VERIFIED || status === LIVE_SUBMIT_RESULT_STATUS.ALREADY_SUBMITTED,
    sellerVerifiedWorkExists,
    blockerType: blockerType || null,
    humanRequired: blockerType === LIVE_SUBMIT_BLOCKER_TYPES.CAPTCHA_REQUIRED,
    retryPolicy: retryPolicyFor({ status, blockerType, hasSubmissionProof }),
    proof: {
      worksId,
      submissionId,
      externalResultId,
      totalMyWorks,
      fileCount,
      worksIsHidden,
      buyerIsHide,
      sellerName: text(input.sellerName || latestItem?.sellerName),
      hiddenVerified,
      sellerItems,
    },
    source: {
      stage: text(input.stage || input.status || input.resultStatus),
      reason: text(input.reason || input.errorType || input.failureCode || input.error),
      source: text(input.source),
    },
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...contract,
    resultHash: digest(contract),
  };
}

export function validateLiveSubmitResultProof(result = {}, {
  requireSellerVerified = true,
  requireHidden = false,
} = {}) {
  const normalized = result.version === LIVE_SUBMIT_RESULT_CONTRACT_VERSION
    ? result
    : normalizeLiveSubmitResult(result);
  const blockers = [];
  if (normalized.action !== EXTERNAL_ACTIONS.LIVE_SUBMIT) blockers.push('live_submit_result_action_required');
  if (requireSellerVerified && normalized.sellerVerifiedWorkExists !== true) blockers.push('seller_verified_work_required');
  if (requireHidden && normalized.proof?.hiddenVerified !== true) blockers.push('seller_hidden_privacy_required');
  if (normalized.status === LIVE_SUBMIT_RESULT_STATUS.BLOCKED_CAPTCHA) blockers.push('captcha_human_verification_required');
  if (normalized.status === LIVE_SUBMIT_RESULT_STATUS.BLOCKED_REFUND) blockers.push('refund_gate_blocks_submit');
  if (normalized.status === LIVE_SUBMIT_RESULT_STATUS.NOT_SUBMITTED) blockers.push('submission_not_landed');
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_live_submit_result_proof' : 'pass_live_submit_result_proof',
    blockers,
    normalized,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}

export function liveSubmitResultContractsSelftest() {
  const success = normalizeLiveSubmitResult({
    source: 'selftest',
    stage: 'submitted',
    worksId: '126996885',
    totalMyWorks: 1,
    worksIsHidden: true,
    fileCount: 1,
  });
  const captcha = normalizeLiveSubmitResult({
    stage: 'blocked_captcha',
    reason: 'GeeTest slider visible',
    totalMyWorks: 0,
  });
  const noWorks = normalizeLiveSubmitResult({
    reason: 'no_my_works_records',
    totalMyWorks: 0,
  });
  const refund = normalizeLiveSubmitResult({
    stage: 'blocked_refund',
    reason: 'employer_refund_requested',
  });
  const validation = validateLiveSubmitResultProof(success, { requireHidden: true });
  return {
    ok: success.status === LIVE_SUBMIT_RESULT_STATUS.SUBMITTED_VERIFIED
      && success.proof.hiddenVerified === true
      && validation.ok === true
      && captcha.status === LIVE_SUBMIT_RESULT_STATUS.BLOCKED_CAPTCHA
      && captcha.humanRequired === true
      && noWorks.status === LIVE_SUBMIT_RESULT_STATUS.NOT_SUBMITTED
      && refund.blockerType === LIVE_SUBMIT_BLOCKER_TYPES.EMPLOYER_REFUND_REQUESTED,
    success,
    captcha,
    noWorks,
    refund,
    validation,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}
