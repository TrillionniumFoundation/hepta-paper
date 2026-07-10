import { digest } from './hash-utils.mjs';
import { summarizeSubmitReadyLedger } from './submit-ready-lifecycle-contracts.mjs';

export const SUBMIT_READY_ACTION_PROJECTION_VERSION = 1;

export const SUBMIT_READY_ACTION_PROJECTION_SAFETY = Object.freeze({
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

function uniqueStrings(values = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function projectionBucketForSubmitReadyLedgerEntry(entry = {}) {
  if (entry.status === 'already_submitted' || entry.submittedSignals?.submitted) {
    return {
      bucket: 'already_submitted',
      recommendation: 'monitor verified submission proof and avoid duplicate live submit',
      priority: 10,
      nextLocalGate: 'submission_receipt_review',
    };
  }
  if (entry.cleanup?.status === 'fail') {
    return {
      bucket: 'cleanup_blocked',
      recommendation: 'rerun submit-ready cleanup before preparing submit evidence',
      priority: 95,
      nextLocalGate: 'submit_ready_cleanup',
    };
  }
  if (entry.status === 'submit_ready_current') {
    return {
      bucket: 'submit_ready_current',
      recommendation: 'prepare submit approval/evidence with current final-reviewed files',
      priority: 80,
      nextLocalGate: 'submit_evidence_prepare',
    };
  }
  if (entry.status === 'final_review_stale') {
    return {
      bucket: 'final_review_stale',
      recommendation: 'rerun final review against the current submit-ready file set',
      priority: 90,
      nextLocalGate: 'final_review_refresh',
    };
  }
  if (entry.status === 'submit_ready_needs_final_review') {
    return {
      bucket: 'needs_final_review',
      recommendation: 'run final/package review before submit approval',
      priority: 85,
      nextLocalGate: 'final_review',
    };
  }
  if (Number(entry.submitReadyCount || 0) === 0) {
    return {
      bucket: 'not_submit_ready',
      recommendation: 'generate or select submit-ready files before final review',
      priority: 50,
      nextLocalGate: 'package_generation_or_selection',
    };
  }
  return {
    bucket: 'unknown',
    recommendation: 'inspect submit-ready ledger before action',
    priority: 40,
    nextLocalGate: 'manual_review',
  };
}

export function buildSubmitReadyActionProjection({ entries = [], now = null } = {}) {
  const rows = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const items = rows.map((entry) => {
    const bucket = projectionBucketForSubmitReadyLedgerEntry(entry);
    return {
      taskId: entry.taskId || null,
      orderId: entry.orderId || null,
      title: entry.title || null,
      status: entry.status || 'unknown',
      actionBucket: bucket.bucket,
      nextLocalGate: bucket.nextLocalGate,
      recommendation: bucket.recommendation,
      priority: bucket.priority,
      submitReadyCount: Number(entry.submitReadyCount || 0),
      finalReviewCurrentOk: entry.finalReviewCurrentOk === true,
      finalReviewCurrentIssues: uniqueStrings(entry.finalReviewCurrentIssues || [], 12),
      cleanupStatus: entry.cleanup?.status || null,
      blockers: uniqueStrings(entry.blockers || [], 12),
      submitted: entry.submittedSignals?.submitted === true,
      ledgerHash: entry.ledgerHash || null,
    };
  });
  const byBucket = {};
  for (const item of items) byBucket[item.actionBucket] = Number(byBucket[item.actionBucket] || 0) + 1;
  const summary = summarizeSubmitReadyLedger(rows);
  const projection = {
    version: SUBMIT_READY_ACTION_PROJECTION_VERSION,
    kind: 'SubmitReadyActionProjectionContract',
    ok: true,
    generatedAt: now || new Date().toISOString(),
    summary: {
      ...summary,
      cleanupBlocked: Number(byBucket.cleanup_blocked || 0),
      needsLocalAction: items.filter((item) => !['already_submitted', 'unknown'].includes(item.actionBucket)).length,
      byBucket,
    },
    topActions: [...items]
      .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))
      .slice(0, 20),
    items,
    safety: SUBMIT_READY_ACTION_PROJECTION_SAFETY,
  };
  projection.projectionHash = digest({
    version: projection.version,
    summary: projection.summary,
    items: items.map((item) => ({
      taskId: item.taskId,
      orderId: item.orderId,
      status: item.status,
      actionBucket: item.actionBucket,
      ledgerHash: item.ledgerHash,
    })),
  });
  return projection;
}

export function submitReadyActionProjectionMarkdownLines(projection = {}) {
  const summary = projection.summary || {};
  return [
    '- submit-ready projection: current=' + Number(summary.readyCurrent || 0)
      + '; stale final review=' + Number(summary.staleFinalReview || 0)
      + '; cleanup blocked=' + Number(summary.cleanupBlocked || summary.cleanupFail || 0)
      + '; needs final review=' + Number(summary.needsFinalReview || 0)
      + '; already submitted=' + Number(summary.alreadySubmitted || 0),
    '- submit-ready projection hash: ' + (projection.projectionHash || '-'),
  ];
}

export function submitReadyActionProjectionContractsSelftest() {
  const projection = buildSubmitReadyActionProjection({
    now: '2026-06-21T00:00:00.000Z',
    entries: [
      {
        taskId: 1,
        status: 'submit_ready_current',
        submitReadyCount: 5,
        finalReviewCurrentOk: true,
        cleanup: { status: 'pass' },
        ledgerHash: 'sha256:ready',
      },
      {
        taskId: 2,
        status: 'final_review_stale',
        submitReadyCount: 5,
        finalReviewCurrentOk: false,
        cleanup: { status: 'fail' },
        blockers: ['submit_ready_cleanup_skipped_files'],
        ledgerHash: 'sha256:cleanup',
      },
    ],
  });
  const lines = submitReadyActionProjectionMarkdownLines(projection);
  return {
    ok: projection.summary.readyCurrent === 1
      && projection.summary.cleanupBlocked === 1
      && projection.topActions[0].actionBucket === 'cleanup_blocked'
      && projection.projectionHash?.startsWith('sha256:')
      && lines.some((line) => line.includes('cleanup blocked=1')),
    version: SUBMIT_READY_ACTION_PROJECTION_VERSION,
    safety: SUBMIT_READY_ACTION_PROJECTION_SAFETY,
    projectionHash: projection.projectionHash,
  };
}
