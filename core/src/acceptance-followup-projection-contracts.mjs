import {
  ACCEPTANCE_LIFECYCLE_BUCKETS,
  normalizeAcceptanceLifecycle,
} from './acceptance-lifecycle-contracts.mjs';
import { digest } from './hash-utils.mjs';

export const ACCEPTANCE_FOLLOWUP_PROJECTION_VERSION = 1;

export const ACCEPTANCE_FOLLOWUP_PROJECTION_SAFETY = Object.freeze({
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

export const ACCEPTANCE_TODAY_GROUPS = Object.freeze({
  IMMEDIATE_APPLY: 'immediateApply',
  STALE_FOLLOWUPS: 'staleFollowups',
  PREP_TODAY: 'prepToday',
  WATCH_ONLY: 'watchOnly',
  ARCHIVE_DEBT: 'archiveDebt',
});

function text(value) {
  const str = String(value ?? '').trim();
  return str || null;
}

function numericOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function acceptanceFollowupRecommendationText(lifecycle) {
  switch (lifecycle?.recommendation) {
    case 'generate_acceptance_approval_and_fresh_evidence_then_apply':
      return '生成 acceptance-prepare/acceptance approval + fresh evidence 后，再运行 acceptance-apply-live/queue';
    case 'prepare_local_delivery_archive_before_acceptance':
      return '先补齐交付文件，再生成 acceptance approval + fresh evidence';
    case 'manual_followup_or_recheck':
      return '已申请验收但等待较久，可列入人工催办/后续复查';
    case 'watch_only_recent_acceptance':
      return '刚进入待雇主验收，继续观察即可';
    case 'do_not_apply_again':
      return '已有验收申请记录，当前无需再次申请';
    case 'review_or_archive_only':
      return '当前更像评价/归档阶段，无需申请验收';
    case 'wait_for_acceptance_button':
      return '仍在中标后流程中，等待按钮开放';
    case 'scan_error_recheck':
      return '扫描失败，后续复查 live 状态';
    default:
      return '当前 live 页没有申请验收按钮，后续再复查';
  }
}

export function normalizeAcceptanceFollowupEntry(entry = {}, { staleDays = 2, nowMs = Date.now() } = {}) {
  const lifecycle = normalizeAcceptanceLifecycle(entry, { staleDays, nowMs });
  return {
    ...entry,
    acceptanceLifecycle: lifecycle,
    acceptanceLifecycleStatus: lifecycle.status,
    acceptanceLifecycleRecommendation: lifecycle.recommendation,
    bucket: lifecycle.bucket,
    recommendation: acceptanceFollowupRecommendationText(lifecycle),
    acceptanceAgeDays: lifecycle.acceptanceAgeDays,
    deliveryReady: lifecycle.delivery.ready,
    deliveryFileCount: Number(lifecycle.delivery.fileCount || 0),
    taskUrl: text(entry.taskUrl),
    projectionHash: digest({
      version: ACCEPTANCE_FOLLOWUP_PROJECTION_VERSION,
      taskId: entry.taskId || null,
      orderId: entry.orderId || null,
      lifecycleHash: lifecycle.contractHash,
      taskUrl: text(entry.taskUrl),
    }),
  };
}

function sortForBucket(items, bucket) {
  const list = [...items];
  if (bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_STALE || bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_RECENT) {
    return list.sort((a, b) => numericOrZero(b.acceptanceAgeDays) - numericOrZero(a.acceptanceAgeDays));
  }
  if (bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.ACTIONABLE_NOW) {
    return list.sort((a, b) => Number(a.deliveryReady) - Number(b.deliveryReady));
  }
  return list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function buildAcceptanceFollowupDashboard(entries = [], { staleDays = 2, nowMs = Date.now(), generatedAt = null } = {}) {
  const normalized = (Array.isArray(entries) ? entries : []).map((entry) => normalizeAcceptanceFollowupEntry(entry, { staleDays, nowMs }));
  const buckets = {
    actionable_now: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.ACTIONABLE_NOW), ACCEPTANCE_LIFECYCLE_BUCKETS.ACTIONABLE_NOW),
    waiting_employer_stale: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_STALE), ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_STALE),
    waiting_employer_recent: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_RECENT), ACCEPTANCE_LIFECYCLE_BUCKETS.WAITING_EMPLOYER_RECENT),
    already_applied_closed: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.ALREADY_APPLIED_CLOSED), ACCEPTANCE_LIFECYCLE_BUCKETS.ALREADY_APPLIED_CLOSED),
    review_only: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.REVIEW_ONLY), ACCEPTANCE_LIFECYCLE_BUCKETS.REVIEW_ONLY),
    won_not_ready: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.WON_NOT_READY), ACCEPTANCE_LIFECYCLE_BUCKETS.WON_NOT_READY),
    blocked_no_button_other: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.BLOCKED_NO_BUTTON_OTHER), ACCEPTANCE_LIFECYCLE_BUCKETS.BLOCKED_NO_BUTTON_OTHER),
    error: sortForBucket(normalized.filter((item) => item.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.ERROR), ACCEPTANCE_LIFECYCLE_BUCKETS.ERROR),
    delivery_missing: normalized.filter((item) => !item.deliveryReady),
  };
  const summary = {
    total: normalized.length,
    actionableNow: buckets.actionable_now.length,
    waitingEmployerStale: buckets.waiting_employer_stale.length,
    waitingEmployerRecent: buckets.waiting_employer_recent.length,
    alreadyAppliedClosed: buckets.already_applied_closed.length,
    reviewOnly: buckets.review_only.length,
    wonNotReady: buckets.won_not_ready.length,
    blockedNoButtonOther: buckets.blocked_no_button_other.length,
    errors: buckets.error.length,
    deliveryMissing: buckets.delivery_missing.length,
    staleDays,
  };
  const dashboard = {
    version: ACCEPTANCE_FOLLOWUP_PROJECTION_VERSION,
    generatedAt: generatedAt || new Date(Number(nowMs || Date.now())).toISOString(),
    staleDays,
    summary,
    buckets,
    entries: normalized,
    safety: ACCEPTANCE_FOLLOWUP_PROJECTION_SAFETY,
  };
  return {
    ...dashboard,
    projectionHash: digest({
      version: ACCEPTANCE_FOLLOWUP_PROJECTION_VERSION,
      generatedAt: dashboard.generatedAt,
      staleDays,
      summary,
      entries: normalized.map((item) => ({
        taskId: item.taskId || null,
        orderId: item.orderId || null,
        bucket: item.bucket,
        projectionHash: item.projectionHash,
      })),
    }),
  };
}

export function pickAcceptanceTodayGroups(dashboard = {}) {
  const buckets = dashboard?.buckets || {};
  const immediateApply = Array.isArray(buckets.actionable_now) ? buckets.actionable_now : [];
  const staleFollowups = Array.isArray(buckets.waiting_employer_stale) ? buckets.waiting_employer_stale : [];
  const deliveryMissing = Array.isArray(buckets.delivery_missing) ? buckets.delivery_missing : [];
  const recentWaiting = Array.isArray(buckets.waiting_employer_recent) ? buckets.waiting_employer_recent : [];
  const prepToday = deliveryMissing.filter((item) => item?.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.WON_NOT_READY && !item?.alreadyApplied);
  const archiveDebt = deliveryMissing.filter((item) => !(item?.bucket === ACCEPTANCE_LIFECYCLE_BUCKETS.WON_NOT_READY && !item?.alreadyApplied));
  return {
    immediateApply,
    staleFollowups,
    prepToday,
    watchOnly: recentWaiting,
    archiveDebt,
  };
}

export function summarizeAcceptanceTodayGroups(groups = {}) {
  return {
    mustDoToday: (groups.immediateApply || []).length + (groups.staleFollowups || []).length + (groups.prepToday || []).length,
    immediateApply: (groups.immediateApply || []).length,
    staleFollowups: (groups.staleFollowups || []).length,
    prepToday: (groups.prepToday || []).length,
    watchOnly: (groups.watchOnly || []).length,
    archiveDebt: (groups.archiveDebt || []).length,
  };
}

export function buildAcceptanceTodayTodoProjection(dashboard = {}, { generatedAt = null } = {}) {
  const groups = pickAcceptanceTodayGroups(dashboard);
  const summary = summarizeAcceptanceTodayGroups(groups);
  const todo = {
    version: ACCEPTANCE_FOLLOWUP_PROJECTION_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    sourceDashboardAt: dashboard?.generatedAt || null,
    sourceProjectionHash: dashboard?.projectionHash || null,
    groups,
    summary,
    safety: ACCEPTANCE_FOLLOWUP_PROJECTION_SAFETY,
  };
  return {
    ...todo,
    projectionHash: digest({
      version: ACCEPTANCE_FOLLOWUP_PROJECTION_VERSION,
      sourceProjectionHash: todo.sourceProjectionHash,
      summary,
      groups: Object.fromEntries(Object.entries(groups).map(([key, items]) => [
        key,
        (items || []).map((item) => ({ taskId: item.taskId || null, orderId: item.orderId || null, bucket: item.bucket || null })),
      ])),
    }),
  };
}

export function acceptanceFollowupProjectionContractsSelftest() {
  const nowMs = Date.parse('2026-06-21T00:00:00.000Z');
  const dashboard = buildAcceptanceFollowupDashboard([
    {
      taskId: '1',
      orderId: 'o1',
      title: '可验收',
      liveStateName: '工作中',
      hasApplyButton: true,
      deliverySource: { type: 'case_submit_ready', fileCount: 1 },
      taskUrl: 'https://task.zbj.com/speed/o1',
    },
    {
      taskId: '2',
      orderId: 'o2',
      title: '待雇主',
      liveStateName: '待雇主验收',
      latestAcceptance: { time: '2026-06-18T00:00:00.000Z', amount: '300' },
      deliverySource: { type: 'seller_recovered', fileCount: 1 },
    },
    {
      taskId: '3',
      orderId: 'o3',
      title: '缺交付',
      liveStateName: '工作中',
      hasApplyButton: false,
      deliverySource: { type: 'none', fileCount: 0 },
    },
  ], { nowMs, staleDays: 2, generatedAt: '2026-06-21T00:00:00.000Z' });
  const today = buildAcceptanceTodayTodoProjection(dashboard, { generatedAt: '2026-06-21T00:00:01.000Z' });
  const ok = dashboard.summary.actionableNow === 1
    && dashboard.summary.waitingEmployerStale === 1
    && dashboard.summary.deliveryMissing === 1
    && today.summary.mustDoToday === 3
    && today.summary.immediateApply === 1
    && today.summary.staleFollowups === 1
    && dashboard.safety.acceptsDelivery === false
    && today.safety.acceptsDelivery === false;
  return { ok, dashboard, today, safety: ACCEPTANCE_FOLLOWUP_PROJECTION_SAFETY };
}
