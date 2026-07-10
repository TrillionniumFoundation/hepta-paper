import { digest } from './hash-utils.mjs';

export const REFPACK_OUTCOME_SCORE_VERSION = 1;

export const DEFAULT_REFPACK_OUTCOME_WORKFLOWS = Object.freeze([
  'logo_brand',
  'packaging_design',
  'catalog_brochure',
  'poster_design',
  'proposal_board',
  'presentation_deck',
  'product_design',
  'naming_text',
]);

export function refpackOutcomeBucketKey({ industryId = null, workflowId = null } = {}) {
  return [industryId || 'unknown_industry', workflowId || 'unknown_workflow'].join('::');
}

function number(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function list(value, limit = 8) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const normalized = String(item?.text || item || '').replace(/\s+/g, ' ').trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function sortedPatternTexts(values = [], limit = 8) {
  return [...(values || [])]
    .sort((left, right) => number(right.weight || right.count) - number(left.weight || left.count) || number(right.confidence) - number(left.confidence))
    .map((item) => item.text || item)
    .filter(Boolean)
    .slice(0, limit);
}

function fallbackDesignReferenceSpec({ pack = {}, workflowId = null } = {}) {
  return {
    id: pack.id || null,
    industryId: pack.industryId || null,
    workflowId: workflowId || pack.workflowId || null,
    label: pack.label || null,
    referenceSourceStatus: pack.referenceSourceStatus || null,
    successPatterns: pack.successPatterns || [],
    rejectedPatterns: pack.rejectedPatterns || [],
    buyerCorrections: pack.buyerCorrections || [],
  };
}

export function scoreRefpackOutcome({ spec = {}, bucket = {}, workflowId = null } = {}) {
  const successCount = number(bucket.successCount) + number(bucket.redoSuccessCount);
  const rejectedCount = number(bucket.rejectedCount) + number(bucket.redoFailedCount);
  const correctionCount = number(bucket.correctionCount);
  const caseCount = number(bucket.caseCount);
  const weightedCaseCount = number(bucket.weightedCaseCount);
  const humanConfirmedCount = number(bucket.humanConfirmedCount);
  const sourceResolvedRatio = number(spec.referenceSourceStatus?.total)
    ? number(spec.referenceSourceStatus?.resolvedCount) / Math.max(1, number(spec.referenceSourceStatus?.total))
    : 0;
  const successPatterns = sortedPatternTexts(bucket.successPatterns || [], 8);
  const rejectedPatterns = sortedPatternTexts(bucket.rejectedPatterns || [], 8);
  const buyerCorrections = sortedPatternTexts(bucket.buyerCorrections || [], 8);
  const learningSignals = successPatterns.length + rejectedPatterns.length + buyerCorrections.length;
  const successRate = caseCount ? successCount / Math.max(1, successCount + rejectedCount + correctionCount) : null;
  const score = Math.max(0, Math.min(100, Math.round(
    38
    + sourceResolvedRatio * 14
    + Math.min(14, weightedCaseCount * 1.8)
    + Math.min(14, successCount * 4)
    + Math.min(8, humanConfirmedCount * 4)
    + Math.min(10, successPatterns.length * 2)
    + Math.min(6, buyerCorrections.length * 1.5)
    - Math.min(16, rejectedCount * 4)
    - Math.min(5, correctionCount)
  )));
  const status = caseCount
    ? (score >= 70 ? 'outcome_learning_strong' : (score >= 55 ? 'outcome_learning_warm' : 'outcome_learning_watch'))
    : 'learning_cold_start';
  const blockers = [];
  if (spec.referenceSourceStatus?.ok === false) blockers.push('reference_sources_unresolved');
  if (rejectedCount >= successCount + 2 && rejectedCount >= 3) blockers.push('rejection_pattern_pressure_high');
  return {
    version: REFPACK_OUTCOME_SCORE_VERSION,
    kind: 'RefpackOutcomeScore',
    status,
    ok: blockers.length === 0,
    refpackId: spec.id || null,
    industryId: spec.industryId || null,
    workflowId: workflowId || spec.workflowId || null,
    label: spec.label || null,
    score,
    successRate: successRate === null ? null : Number(successRate.toFixed(3)),
    counts: {
      caseCount,
      weightedCaseCount,
      successCount,
      rejectedCount,
      correctionCount,
      humanConfirmedCount,
      learningSignalCount: learningSignals,
    },
    sourceEvidence: {
      sourceResolvedRatio: Number(sourceResolvedRatio.toFixed(3)),
      resolvedCount: number(spec.referenceSourceStatus?.resolvedCount),
      total: number(spec.referenceSourceStatus?.total),
      digestCount: number(spec.referenceSourceStatus?.digestCount),
      digestMode: spec.referenceSourceStatus?.digestMode || null,
    },
    patterns: {
      successPatterns: successPatterns.length ? successPatterns : list(spec.successPatterns || [], 8),
      rejectedPatterns: rejectedPatterns.length ? rejectedPatterns : list(spec.rejectedPatterns || [], 8),
      buyerCorrections: buyerCorrections.length ? buyerCorrections : list(spec.buyerCorrections || [], 8),
    },
    blockers,
    recommendations: [
      caseCount ? null : 'cold start: ingest real winning/losing/correction evidence before trusting outcome score',
      rejectedCount > successCount ? 'review rejected patterns before next generation prompt' : null,
      successPatterns.length ? 'promote high-weight success patterns into prompt compiler outcome-learning section' : null,
      buyerCorrections.length ? 'turn repeated buyer corrections into QA blockers or acceptance checks' : null,
    ].filter(Boolean),
  };
}

export function buildRefpackOutcomeScoreReport({
  workflows = DEFAULT_REFPACK_OUTCOME_WORKFLOWS,
  packs = [],
  ledger = {},
  createdAt = new Date().toISOString(),
  referencePackVersion = null,
  caseLedgerVersion = null,
  resolveDesignReferenceSpec = null,
} = {}) {
  const rows = [];
  for (const pack of packs || []) {
    for (const workflowId of workflows || []) {
      const spec = typeof resolveDesignReferenceSpec === 'function'
        ? resolveDesignReferenceSpec({ pack, workflowId })
        : fallbackDesignReferenceSpec({ pack, workflowId });
      const bucket = ledger.buckets?.[refpackOutcomeBucketKey({ industryId: spec.industryId, workflowId })] || {};
      rows.push(scoreRefpackOutcome({ spec, bucket, workflowId }));
    }
  }
  const blockers = rows.flatMap((row) => (row.blockers || []).map((code) => ({ code, refpackId: row.refpackId, workflowId: row.workflowId })));
  const scoredRows = rows.filter((row) => row.counts.caseCount > 0);
  const report = {
    ok: blockers.length === 0,
    version: REFPACK_OUTCOME_SCORE_VERSION,
    kind: 'RefpackOutcomeScoreReport',
    status: blockers.length ? 'blocked_refpack_outcome_score' : 'refpack_outcome_score_ready',
    createdAt,
    referencePackVersion,
    caseLedgerVersion: caseLedgerVersion || ledger.version || null,
    caseLedgerUpdatedAt: ledger.updatedAt || null,
    workflows: [...(workflows || [])],
    counts: {
      packCount: (packs || []).length,
      rowCount: rows.length,
      scoredRowCount: scoredRows.length,
      coldStartRowCount: rows.filter((row) => row.status === 'learning_cold_start').length,
      blockerCount: blockers.length,
    },
    topOutcomeRows: [...scoredRows].sort((left, right) => right.score - left.score).slice(0, 20),
    watchRows: [...rows].filter((row) => row.blockers.length || row.score < 55).sort((left, right) => left.score - right.score).slice(0, 20),
    rows,
    blockers,
    safety: {
      localReportOnly: true,
      localScoringOnly: true,
      callsProviderOrModel: false,
      opensBrowserOrPlatform: false,
      uploadsOrSubmits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      paysOrDeploys: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...report,
    reportHash: digest(report),
  };
}

export function refpackOutcomeScoreMarkdown(report = {}) {
  const lines = [
    '# Refpack Outcome Score',
    '',
    `- status: ${report.status || '-'}`,
    `- generatedAt: ${report.createdAt || '-'}`,
    `- rows: ${report.counts?.rowCount ?? 0}`,
    `- scoredRows: ${report.counts?.scoredRowCount ?? 0}`,
    `- coldStartRows: ${report.counts?.coldStartRowCount ?? 0}`,
    `- blockers: ${report.counts?.blockerCount ?? 0}`,
    `- reportHash: ${report.reportHash || '-'}`,
    '',
    '## Top Outcome Rows',
    '',
  ];
  if (!report.topOutcomeRows?.length) lines.push('- none');
  for (const row of report.topOutcomeRows || []) {
    lines.push(`- ${row.refpackId} / ${row.workflowId}: score=${row.score}, cases=${row.counts.caseCount}, success=${row.counts.successCount}, rejected=${row.counts.rejectedCount}, corrections=${row.counts.correctionCount}`);
    if (row.patterns.successPatterns.length) lines.push(`  - success: ${row.patterns.successPatterns.slice(0, 3).join(' | ')}`);
    if (row.patterns.rejectedPatterns.length) lines.push(`  - rejected: ${row.patterns.rejectedPatterns.slice(0, 3).join(' | ')}`);
  }
  lines.push('');
  lines.push('## Watch Rows');
  lines.push('');
  if (!report.watchRows?.length) lines.push('- none');
  for (const row of report.watchRows || []) {
    lines.push(`- ${row.refpackId} / ${row.workflowId}: score=${row.score}, status=${row.status}, blockers=${row.blockers.join(', ') || '-'}`);
  }
  lines.push('');
  lines.push('Safety: outcome scoring is local evidence only. It does not permit generation, upload, submit, IM, acceptance, payment, or deployment.');
  return lines.join('\n') + '\n';
}

export function refpackOutcomeScoringSelftest() {
  const report = buildRefpackOutcomeScoreReport({
    workflows: ['logo_brand'],
    packs: [{
      id: 'refpack_general_technology_b2b_v1',
      industryId: 'general_technology_b2b',
      label: 'General technology',
    }],
    referencePackVersion: 1,
    caseLedgerVersion: 1,
    ledger: {
      version: 1,
      updatedAt: 'selftest',
      buckets: {
        [refpackOutcomeBucketKey({ industryId: 'general_technology_b2b', workflowId: 'logo_brand' })]: {
          industryId: 'general_technology_b2b',
          workflowId: 'logo_brand',
          caseCount: 3,
          successCount: 2,
          rejectedCount: 1,
          correctionCount: 1,
          weightedCaseCount: 3.2,
          humanConfirmedCount: 1,
          successPatterns: [{ text: 'large wordmark plus product dashboard proof', weight: 2, confidence: 0.9 }],
          rejectedPatterns: [{ text: 'blue-purple empty tech mockup', weight: 1.5, confidence: 0.8 }],
          buyerCorrections: [{ text: 'make wordmark more legible at small size', weight: 1.2, confidence: 0.8 }],
        },
      },
    },
    resolveDesignReferenceSpec: ({ pack, workflowId }) => ({
      id: pack.id,
      industryId: pack.industryId,
      workflowId,
      label: pack.label,
      referenceSourceStatus: {
        ok: true,
        total: 2,
        resolvedCount: 2,
        digestCount: 2,
        digestMode: 'prompt_summary',
      },
    }),
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  const tech = report.rows.find((row) => row.industryId === 'general_technology_b2b' && row.workflowId === 'logo_brand');
  return {
    ok: report.ok
      && report.safety.localScoringOnly === true
      && report.safety.callsProviderOrModel === false
      && tech?.score > 50
      && tech.patterns.successPatterns.some((item) => /wordmark/.test(item))
      && report.reportHash?.startsWith('sha256:'),
    tech,
    reportHash: report.reportHash,
  };
}
