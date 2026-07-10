import { EXTERNAL_ACTIONS, normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const ACCEPTANCE_LIFECYCLE_CONTRACT_VERSION = 1;

export const ACCEPTANCE_LIFECYCLE_STATUS = Object.freeze({
  ACTIONABLE: 'actionable',
  WAITING_EMPLOYER_RECENT: 'waiting_employer_recent',
  WAITING_EMPLOYER_STALE: 'waiting_employer_stale',
  ALREADY_APPLIED_CLOSED: 'already_applied_closed',
  REVIEW_ONLY: 'review_only',
  WON_NOT_READY: 'won_not_ready',
  BLOCKED_NO_BUTTON_OTHER: 'blocked_no_button_other',
  ERROR: 'error',
});

export const ACCEPTANCE_LIFECYCLE_BUCKETS = Object.freeze({
  ACTIONABLE_NOW: 'actionable_now',
  WAITING_EMPLOYER_STALE: 'waiting_employer_stale',
  WAITING_EMPLOYER_RECENT: 'waiting_employer_recent',
  ALREADY_APPLIED_CLOSED: 'already_applied_closed',
  REVIEW_ONLY: 'review_only',
  WON_NOT_READY: 'won_not_ready',
  BLOCKED_NO_BUTTON_OTHER: 'blocked_no_button_other',
  ERROR: 'error',
});

function text(value) {
  return normalizeText(value || '') || null;
}

function bool(value) {
  return value === undefined || value === null ? false : Boolean(value);
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function daysSince(value, nowMs) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return Number(((Number(nowMs) - time) / 86400000).toFixed(2));
}

function acceptanceTime(input = {}) {
  return text(input.latestAcceptance?.time || input.acceptanceRequestedAt || input.requestedAt);
}

function acceptanceAmount(input = {}) {
  return text(input.latestAcceptance?.amount || input.acceptanceAmount || input.amount);
}

function deliverySource(input = {}) {
  const source = input.deliverySource || {};
  const fileCount = numberOrNull(source.fileCount ?? input.deliveryFileCount);
  return {
    type: text(source.type || input.acceptanceDeliverySourceType || 'none') || 'none',
    dir: text(source.dir),
    fileCount: fileCount ?? 0,
    files: Array.isArray(source.files) ? [...source.files] : [],
  };
}

function deriveStatus({ liveStateName, hasApplyButton, alreadyApplied, actionable, acceptanceAgeDays, staleDays, scanError }) {
  if (scanError) return ACCEPTANCE_LIFECYCLE_STATUS.ERROR;
  if (actionable) return ACCEPTANCE_LIFECYCLE_STATUS.ACTIONABLE;
  if (liveStateName === '待雇主验收') {
    return acceptanceAgeDays !== null && acceptanceAgeDays >= staleDays
      ? ACCEPTANCE_LIFECYCLE_STATUS.WAITING_EMPLOYER_STALE
      : ACCEPTANCE_LIFECYCLE_STATUS.WAITING_EMPLOYER_RECENT;
  }
  if (alreadyApplied) return ACCEPTANCE_LIFECYCLE_STATUS.ALREADY_APPLIED_CLOSED;
  if (liveStateName === '待评价') return ACCEPTANCE_LIFECYCLE_STATUS.REVIEW_ONLY;
  if (['公示中', '工作中'].includes(liveStateName)) return ACCEPTANCE_LIFECYCLE_STATUS.WON_NOT_READY;
  if (!hasApplyButton) return ACCEPTANCE_LIFECYCLE_STATUS.BLOCKED_NO_BUTTON_OTHER;
  return ACCEPTANCE_LIFECYCLE_STATUS.BLOCKED_NO_BUTTON_OTHER;
}

function bucketForStatus(status) {
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.ACTIONABLE) return ACCEPTANCE_LIFECYCLE_BUCKETS.ACTIONABLE_NOW;
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.WAITING_EMPLOYER_STALE) return ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_STALE;
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.WAITING_EMPLOYER_RECENT) return ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_RECENT;
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.ALREADY_APPLIED_CLOSED) return ACCEPTANCE_LIFECYCLE_BUCKETS.ALREADY_APPLIED_CLOSED;
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.REVIEW_ONLY) return ACCEPTANCE_LIFECYCLE_BUCKETS.REVIEW_ONLY;
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.WON_NOT_READY) return ACCEPTANCE_LIFECYCLE_BUCKETS.WON_NOT_READY;
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.ERROR) return ACCEPTANCE_LIFECYCLE_BUCKETS.ERROR;
  return ACCEPTANCE_LIFECYCLE_BUCKETS.BLOCKED_NO_BUTTON_OTHER;
}

export function acceptanceLifecycleRecommendation(contract = {}) {
  const status = contract.status || contract.acceptanceStatus;
  const deliveryReady = contract.delivery?.ready === true;
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.ACTIONABLE) {
    return deliveryReady
      ? 'generate_acceptance_approval_and_fresh_evidence_then_apply'
      : 'prepare_local_delivery_archive_before_acceptance';
  }
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.WAITING_EMPLOYER_STALE) return 'manual_followup_or_recheck';
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.WAITING_EMPLOYER_RECENT) return 'watch_only_recent_acceptance';
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.ALREADY_APPLIED_CLOSED) return 'do_not_apply_again';
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.REVIEW_ONLY) return 'review_or_archive_only';
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.WON_NOT_READY) return 'wait_for_acceptance_button';
  if (status === ACCEPTANCE_LIFECYCLE_STATUS.ERROR) return 'scan_error_recheck';
  return 'recheck_live_state_later';
}

export function normalizeAcceptanceLifecycle(input = {}, { staleDays = 2, nowMs = Date.now() } = {}) {
  const liveStateName = text(input.liveStateName || input.acceptanceState);
  const latestAcceptance = {
    value: text(input.latestAcceptance?.value),
    amount: acceptanceAmount(input),
    time: acceptanceTime(input),
  };
  const delivery = deliverySource(input);
  const deliveryReady = Number(delivery.fileCount || 0) > 0;
  const hasApplyButton = bool(input.hasApplyButton || input.acceptanceHasApplyButton);
  const alreadyApplied = bool(input.alreadyApplied || input.acceptanceAlreadyApplied)
    || liveStateName === '待雇主验收'
    || (Boolean(latestAcceptance.time || latestAcceptance.value) && !hasApplyButton);
  const reopenedAfterAcceptance = bool(input.reopenedAfterAcceptance)
    || (Boolean(latestAcceptance.time || latestAcceptance.value) && hasApplyButton && liveStateName !== '待雇主验收');
  const actionable = bool(input.actionable || input.acceptanceActionable) || (hasApplyButton && !alreadyApplied);
  const acceptanceAgeDays = daysSince(latestAcceptance.time, nowMs);
  const scanError = text(input.scanError || input.error);
  const status = deriveStatus({
    liveStateName,
    hasApplyButton,
    alreadyApplied,
    actionable,
    acceptanceAgeDays,
    staleDays,
    scanError,
  });
  const contract = {
    version: ACCEPTANCE_LIFECYCLE_CONTRACT_VERSION,
    action: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
    status,
    bucket: bucketForStatus(status),
    taskId: text(input.taskId),
    orderId: text(input.orderId),
    title: text(input.title),
    liveStateName,
    hasApplyButton,
    actionable,
    alreadyApplied,
    reopenedAfterAcceptance,
    latestAcceptance,
    acceptanceAgeDays,
    staleDays,
    delivery: {
      ...delivery,
      ready: deliveryReady,
    },
    scanError,
    skipReason: text(input.skipReason),
    source: text(input.source),
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
    recommendation: acceptanceLifecycleRecommendation(contract),
    contractHash: digest(contract),
  };
}

export function validateAcceptanceLifecycleContract(contract = {}) {
  const normalized = contract.version === ACCEPTANCE_LIFECYCLE_CONTRACT_VERSION
    ? contract
    : normalizeAcceptanceLifecycle(contract);
  const blockers = [];
  if (normalized.action !== EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) blockers.push('acceptance_lifecycle_action_required');
  if (!Object.values(ACCEPTANCE_LIFECYCLE_STATUS).includes(normalized.status)) blockers.push('acceptance_lifecycle_status_invalid');
  if (!Object.values(ACCEPTANCE_LIFECYCLE_BUCKETS).includes(normalized.bucket)) blockers.push('acceptance_lifecycle_bucket_invalid');
  if (normalized.actionable && normalized.alreadyApplied) blockers.push('acceptance_lifecycle_actionable_conflicts_with_already_applied');
  if (normalized.reopenedAfterAcceptance && normalized.liveStateName === '待雇主验收') blockers.push('acceptance_lifecycle_reopened_conflicts_with_waiting_state');
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_acceptance_lifecycle_contract' : 'pass_acceptance_lifecycle_contract',
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

export function acceptanceLifecycleContractsSelftest() {
  const nowMs = Date.parse('2026-06-21T00:00:00.000Z');
  const actionable = normalizeAcceptanceLifecycle({
    taskId: '1',
    orderId: '2',
    liveStateName: '工作中',
    hasApplyButton: true,
    deliverySource: { type: 'case_submit_ready', fileCount: 2 },
  }, { nowMs });
  const stale = normalizeAcceptanceLifecycle({
    liveStateName: '待雇主验收',
    latestAcceptance: { time: '2026-06-17T00:00:00.000Z', amount: '300' },
    deliverySource: { type: 'seller_recovered', fileCount: 1 },
  }, { nowMs, staleDays: 2 });
  const reopened = normalizeAcceptanceLifecycle({
    liveStateName: '工作中',
    hasApplyButton: true,
    latestAcceptance: { time: '2026-06-20T00:00:00.000Z' },
  }, { nowMs });
  const reviewOnly = normalizeAcceptanceLifecycle({ liveStateName: '待评价', hasApplyButton: false }, { nowMs });
  const validation = validateAcceptanceLifecycleContract(actionable);
  return {
    ok: actionable.status === ACCEPTANCE_LIFECYCLE_STATUS.ACTIONABLE
      && actionable.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.ACTIONABLE_NOW
      && actionable.delivery.ready === true
      && stale.status === ACCEPTANCE_LIFECYCLE_STATUS.WAITING_EMPLOYER_STALE
      && stale.recommendation === 'manual_followup_or_recheck'
      && reopened.reopenedAfterAcceptance === true
      && reopened.alreadyApplied === false
      && reviewOnly.status === ACCEPTANCE_LIFECYCLE_STATUS.REVIEW_ONLY
      && validation.ok === true,
    actionable,
    stale,
    reopened,
    reviewOnly,
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
