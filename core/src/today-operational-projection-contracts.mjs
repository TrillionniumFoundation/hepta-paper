import { digest } from './hash-utils.mjs';

export const TODAY_OPERATIONAL_PROJECTION_VERSION = 1;

export const TODAY_OPERATIONAL_PROJECTION_SAFETY = Object.freeze({
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

function clean(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function groupRows(groups = {}) {
  return [
    ['immediateApply', groups.immediateApply || []],
    ['staleFollowups', groups.staleFollowups || []],
    ['prepToday', groups.prepToday || []],
    ['watchOnly', groups.watchOnly || []],
    ['archiveDebt', groups.archiveDebt || []],
  ].flatMap(([groupId, rows]) => (Array.isArray(rows) ? rows : []).map((row) => ({ groupId, row })));
}

function acceptanceProjectionBucket({ groupId, row }) {
  const lifecycle = row?.acceptanceLifecycle || {};
  const bucket = clean(row?.bucket || lifecycle.bucket || lifecycle.status || groupId);
  if (groupId === 'immediateApply' || bucket === 'actionable_now') {
    return {
      actionBucket: 'acceptance_apply_ready',
      priority: 100,
      nextLocalGate: 'acceptance_evidence_prepare',
      recommendation: 'prepare acceptance approval/fresh evidence, then run the guarded acceptance apply queue',
      mustDoToday: true,
    };
  }
  if (groupId === 'staleFollowups' || bucket === 'waiting_employer_stale') {
    return {
      actionBucket: 'acceptance_followup_stale',
      priority: 75,
      nextLocalGate: 'acceptance_followup_review',
      recommendation: 'recheck stale employer-acceptance items and decide whether to follow up',
      mustDoToday: true,
    };
  }
  if (groupId === 'prepToday' || bucket === 'won_not_ready') {
    return {
      actionBucket: 'acceptance_delivery_archive_needed',
      priority: 60,
      nextLocalGate: 'acceptance_delivery_archive',
      recommendation: 'prepare or repair local delivery archive before acceptance can be applied',
      mustDoToday: true,
    };
  }
  if (groupId === 'watchOnly' || bucket === 'waiting_employer_recent') {
    return {
      actionBucket: 'acceptance_watch_only',
      priority: 15,
      nextLocalGate: 'watch_only',
      recommendation: 'watch recent acceptance state; no local action needed today',
      mustDoToday: false,
    };
  }
  return {
    actionBucket: 'acceptance_archive_debt',
    priority: 25,
    nextLocalGate: 'acceptance_archive_backlog',
    recommendation: 'backlog archive cleanup, not a today blocker',
    mustDoToday: false,
  };
}

export function buildAcceptanceTodayProjection({ acceptanceToday = null, now = null } = {}) {
  const groups = acceptanceToday?.groups || {};
  const items = groupRows(groups).map(({ groupId, row }) => {
    const bucket = acceptanceProjectionBucket({ groupId, row });
    return {
      lane: 'acceptance_post_win',
      groupId,
      taskId: clean(row?.taskId),
      orderId: clean(row?.orderId),
      title: clean(row?.title),
      liveStateName: clean(row?.liveStateName),
      actionBucket: bucket.actionBucket,
      nextLocalGate: bucket.nextLocalGate,
      recommendation: bucket.recommendation,
      priority: bucket.priority,
      mustDoToday: bucket.mustDoToday,
      deliveryReady: row?.deliveryReady === true || row?.acceptanceLifecycle?.delivery?.ready === true,
      deliveryFileCount: number(row?.deliveryFileCount ?? row?.acceptanceLifecycle?.delivery?.fileCount),
      acceptanceAgeDays: row?.acceptanceAgeDays ?? row?.acceptanceLifecycle?.acceptanceAgeDays ?? null,
      latestAcceptanceAmount: clean(row?.latestAcceptance?.amount || row?.acceptanceLifecycle?.latestAcceptance?.amount),
      lifecycleStatus: clean(row?.acceptanceLifecycleStatus || row?.acceptanceLifecycle?.status),
      lifecycleBucket: clean(row?.acceptanceLifecycle?.bucket || row?.bucket),
      lifecycleHash: clean(row?.acceptanceLifecycle?.contractHash),
      taskUrl: clean(row?.taskUrl),
    };
  });
  const byBucket = {};
  for (const item of items) byBucket[item.actionBucket] = number(byBucket[item.actionBucket]) + 1;
  const summary = {
    mustDoToday: items.filter((item) => item.mustDoToday).length,
    immediateApply: number(byBucket.acceptance_apply_ready),
    staleFollowups: number(byBucket.acceptance_followup_stale),
    prepToday: number(byBucket.acceptance_delivery_archive_needed),
    watchOnly: number(byBucket.acceptance_watch_only),
    archiveDebt: number(byBucket.acceptance_archive_debt),
    byBucket,
  };
  const projection = {
    version: TODAY_OPERATIONAL_PROJECTION_VERSION,
    kind: 'AcceptanceTodayProjectionContract',
    ok: true,
    generatedAt: now || new Date().toISOString(),
    sourceGeneratedAt: clean(acceptanceToday?.generatedAt),
    sourceDashboardAt: clean(acceptanceToday?.sourceDashboardAt),
    summary,
    topActions: [...items]
      .filter((item) => item.mustDoToday)
      .sort((left, right) => number(right.priority) - number(left.priority))
      .slice(0, 20),
    items,
    safety: TODAY_OPERATIONAL_PROJECTION_SAFETY,
  };
  projection.projectionHash = digest({
    version: projection.version,
    kind: projection.kind,
    sourceGeneratedAt: projection.sourceGeneratedAt,
    sourceDashboardAt: projection.sourceDashboardAt,
    summary: projection.summary,
    items: projection.items.map((item) => ({
      groupId: item.groupId,
      taskId: item.taskId,
      orderId: item.orderId,
      actionBucket: item.actionBucket,
      lifecycleHash: item.lifecycleHash,
    })),
  });
  return projection;
}

function preSubmitTopActions(projection = {}) {
  return (projection.topActions || []).map((item) => ({
    lane: 'pre_submit',
    taskId: clean(item.taskId),
    orderId: clean(item.orderId),
    title: clean(item.title),
    actionBucket: clean(item.actionBucket),
    nextLocalGate: clean(item.nextLocalGate),
    recommendation: clean(item.recommendation),
    priority: number(item.priority),
    sourceHash: clean(item.ledgerHash),
  }));
}

export function buildTodayOperationalProjection({
  submitReadyActionProjection = null,
  acceptanceToday = null,
  now = null,
} = {}) {
  const acceptance = buildAcceptanceTodayProjection({ acceptanceToday, now });
  const preSubmitActions = preSubmitTopActions(submitReadyActionProjection || {});
  const topLocalActions = [
    ...preSubmitActions,
    ...acceptance.topActions.map((item) => ({
      lane: item.lane,
      taskId: item.taskId,
      orderId: item.orderId,
      title: item.title,
      actionBucket: item.actionBucket,
      nextLocalGate: item.nextLocalGate,
      recommendation: item.recommendation,
      priority: item.priority,
      sourceHash: item.lifecycleHash,
    })),
  ].sort((left, right) => number(right.priority) - number(left.priority)).slice(0, 30);
  const preSubmitSummary = submitReadyActionProjection?.summary || {};
  const projection = {
    version: TODAY_OPERATIONAL_PROJECTION_VERSION,
    kind: 'TodayOperationalProjectionContract',
    ok: true,
    generatedAt: now || new Date().toISOString(),
    lanes: {
      preSubmit: {
        lane: 'pre_submit',
        projectionHash: submitReadyActionProjection?.projectionHash || null,
        summary: preSubmitSummary,
        topActions: preSubmitActions,
      },
      acceptancePostWin: acceptance,
    },
    summary: {
      preSubmitNeedsLocalAction: number(preSubmitSummary.needsLocalAction),
      preSubmitReadyCurrent: number(preSubmitSummary.readyCurrent),
      preSubmitStaleFinalReview: number(preSubmitSummary.staleFinalReview),
      acceptanceMustDoToday: number(acceptance.summary.mustDoToday),
      acceptanceImmediateApply: number(acceptance.summary.immediateApply),
      acceptanceStaleFollowups: number(acceptance.summary.staleFollowups),
      acceptancePrepToday: number(acceptance.summary.prepToday),
      totalTopLocalActions: topLocalActions.length,
    },
    topLocalActions,
    safety: TODAY_OPERATIONAL_PROJECTION_SAFETY,
  };
  projection.projectionHash = digest({
    version: projection.version,
    kind: projection.kind,
    summary: projection.summary,
    preSubmitProjectionHash: projection.lanes.preSubmit.projectionHash,
    acceptanceProjectionHash: acceptance.projectionHash,
    topLocalActions: topLocalActions.map((item) => ({
      lane: item.lane,
      taskId: item.taskId,
      orderId: item.orderId,
      actionBucket: item.actionBucket,
      sourceHash: item.sourceHash,
    })),
  });
  return projection;
}

export function todayOperationalProjectionMarkdownLines(projection = {}) {
  const summary = projection.summary || {};
  return [
    '- today operational projection: pre-submit local actions=' + number(summary.preSubmitNeedsLocalAction)
      + '; acceptance must-do=' + number(summary.acceptanceMustDoToday)
      + '; immediate acceptance=' + number(summary.acceptanceImmediateApply)
      + '; stale acceptance followups=' + number(summary.acceptanceStaleFollowups),
    '- today operational projection hash: ' + (projection.projectionHash || '-'),
  ];
}

export function todayOperationalProjectionContractsSelftest() {
  const submitProjection = {
    projectionHash: 'sha256:submit-ready-projection',
    summary: {
      needsLocalAction: 2,
      readyCurrent: 1,
      staleFinalReview: 1,
    },
    topActions: [{
      taskId: 'pre-1',
      orderId: 'order-pre',
      actionBucket: 'final_review_stale',
      nextLocalGate: 'final_review_refresh',
      recommendation: 'rerun final review',
      priority: 90,
      ledgerHash: 'sha256:ledger-pre',
    }],
  };
  const acceptanceToday = {
    generatedAt: '2026-06-21T00:00:00.000Z',
    groups: {
      immediateApply: [{
        taskId: 'acc-1',
        orderId: 'order-acc',
        title: 'acceptance ready',
        liveStateName: '工作中',
        deliveryReady: true,
        deliveryFileCount: 5,
        acceptanceLifecycle: {
          status: 'actionable',
          bucket: 'actionable_now',
          contractHash: 'sha256:acceptance-ready',
        },
      }],
      staleFollowups: [{
        taskId: 'acc-2',
        orderId: 'order-stale',
        liveStateName: '待雇主验收',
        acceptanceAgeDays: 8,
        acceptanceLifecycle: {
          status: 'waiting_employer_stale',
          bucket: 'waiting_employer_stale',
          contractHash: 'sha256:acceptance-stale',
        },
      }],
      watchOnly: [],
      prepToday: [],
      archiveDebt: [],
    },
  };
  const projection = buildTodayOperationalProjection({
    submitReadyActionProjection: submitProjection,
    acceptanceToday,
    now: '2026-06-21T01:00:00.000Z',
  });
  const lines = todayOperationalProjectionMarkdownLines(projection);
  return {
    ok: projection.summary.preSubmitNeedsLocalAction === 2
      && projection.summary.acceptanceMustDoToday === 2
      && projection.lanes.acceptancePostWin.summary.immediateApply === 1
      && projection.topLocalActions[0].lane === 'acceptance_post_win'
      && projection.projectionHash?.startsWith('sha256:')
      && lines.some((line) => line.includes('acceptance must-do=2')),
    projectionHash: projection.projectionHash,
    safety: TODAY_OPERATIONAL_PROJECTION_SAFETY,
  };
}
