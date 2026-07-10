import { digest } from './hash-utils.mjs';

export const SEMANTIC_REVIEWER_CALIBRATION_VERSION = 1;

export const SEMANTIC_REVIEWER_CALIBRATION_SAFETY = Object.freeze({
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

export function semanticReviewerCalibrationHash(value) {
  return digest(value).replace(/^sha256:/, '');
}

export function defaultSemanticReviewerCalibrationSet({ now = new Date().toISOString() } = {}) {
  return {
    version: SEMANTIC_REVIEWER_CALIBRATION_VERSION,
    createdAt: now,
    updatedAt: now,
    policy: {
      mode: 'adjudication-only',
      modelCalls: false,
      purpose: 'Calibrate PASS/REVIEW/FAIL thresholds before enabling semantic reviewer as a blocking gate.',
    },
    thresholds: {
      passMaxRiskScore: 0.24,
      reviewMinRiskScore: 0.25,
      failMinRiskScore: 0.68,
      hardFailLabels: ['duplicate_package', 'off_brief', 'wrong_text', 'forbidden_content', 'unsafe_submit_artifact'],
    },
    dimensions: [
      'briefFit',
      'industryFit',
      'textAccuracy',
      'packageDiversity',
      'visualQuality',
      'applicationRealism',
      'negativePatternRisk',
      'submissionReadiness',
    ],
    cases: [
      {
        id: 'accepted-food-chain-logo-1003603002',
        taskId: '1003603002',
        workflowId: 'logo_brand',
        industryId: 'food_service_chain',
        source: 'historical_success',
        expectedDecision: 'PASS',
        labels: ['accepted', 'industry_fit', 'application_ready'],
        rationale: '天成万家快餐连锁 LOGO 包按门头识别、家常烟火气和标准化快餐品牌感提交成功，适合作为 PASS 正样本。',
      },
      {
        id: 'accepted-nutrition-wordmark-1003611435',
        taskId: '1003611435',
        workflowId: 'logo_brand',
        industryId: 'beauty_health',
        source: 'historical_success',
        expectedDecision: 'PASS',
        labels: ['accepted', 'clean_international', 'text_correct'],
        rationale: 'Juicy Diamond 美国市场营养补充剂品牌，成功包强调 clean/modern/natural/international，可校准文字准确与行业克制感。',
      },
      {
        id: 'duplicate-warning-fashion-wordmark-1003599274',
        taskId: '1003599274',
        workflowId: 'logo_brand',
        industryId: 'fashion_apparel',
        source: 'user_correction',
        expectedDecision: 'FAIL',
        labels: ['duplicate_package', 'low_diversity', 'buyer_correction'],
        rationale: 'LSGT 首轮被用户指出几张重复，semantic reviewer 应在 package diversity 上直接 FAIL 或至少强 REVIEW。',
      },
      {
        id: 'accepted-hotel-vi-1003626241',
        taskId: '1003626241',
        workflowId: 'proposal_board',
        industryId: 'hotel_hospitality',
        source: 'historical_success',
        expectedDecision: 'PASS',
        labels: ['accepted', 'proposal_board_ready', 'regional_fit'],
        rationale: 'W.半岛酒店 VI 十张包成功落单，适合作为空间/酒店方案类 PASS 正样本，但隐私 backend 字段另行校验。',
      },
      {
        id: 'wrong-direction-alpha-split-vao',
        taskId: 'VAO-fangcunjian',
        workflowId: 'logo_brand',
        industryId: 'sports_culture',
        source: 'user_rejected',
        expectedDecision: 'FAIL',
        labels: ['wrong_direction', 'visual_quality_regression', 'buyer_correction'],
        rationale: 'alpha/RGB split 两版被用户明确否定为错误方向，校准 reviewer 不能把局部指标或规则修复误判为可交付质量。',
      },
      {
        id: 'review-live-path-blocked-1003687808',
        taskId: '1003687808',
        workflowId: 'generic_design',
        industryId: 'unknown',
        source: 'workflow_blocker',
        expectedDecision: 'REVIEW',
        labels: ['live_path_blocked', 'seller_session_or_entry_missing'],
        rationale: '作品本身不是 FAIL，但 live path 未解开时不能进入 prepare/submit，semantic reviewer 之外的 final gate 应保持 REVIEW/BLOCKED。',
      },
      {
        id: 'accepted-rsgh-clover-logo-1003721813',
        taskId: '1003721813',
        workflowId: 'logo_brand',
        industryId: 'environmental_technology',
        source: 'recent_verified_submit',
        expectedDecision: 'PASS',
        labels: ['accepted', 'logo_vi', 'semantic_pass', 'seller_verified'],
        rationale: '瑞胜绿合四叶草/苹果极简方向均完成 seller-side 验证，作为近期 LOGO/VI PASS 回放样本。',
      },
      {
        id: 'overlay-degraded-logo-1003715380',
        taskId: '1003715380',
        workflowId: 'logo_brand',
        industryId: 'unknown',
        source: 'user_correction',
        expectedDecision: 'FAIL',
        labels: ['overlay_repair_regression', 'visual_quality_regression', 'buyer_correction'],
        rationale: '用户明确指出遮挡式修复破坏原本可接受的 LOGO/VI 输出，final/package reviewer 应保持 FAIL。',
      },
      {
        id: 'overlay-degraded-logo-1003708375',
        taskId: '1003708375',
        workflowId: 'logo_brand',
        industryId: 'unknown',
        source: 'user_correction',
        expectedDecision: 'FAIL',
        labels: ['overlay_repair_regression', 'visual_quality_regression', 'buyer_correction'],
        rationale: '遮挡 title/chip/mask 类修复不应被 referee 误判为可交付质量，作为近期 FAIL 回放样本。',
      },
    ],
  };
}

export function normalizeSemanticReviewerDecision(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'pass' || text === 'passed') return 'PASS';
  if (text === 'fail' || text === 'failed') return 'FAIL';
  if (text === 'review' || text === 'pending' || text === 'blocked' || text === 'ready') return 'REVIEW';
  return text ? text.toUpperCase() : null;
}

export function decisionFromSemanticReviewerReport(report = {}) {
  return normalizeSemanticReviewerDecision(
    report.expectedActualDecision
      || report.decision
      || report.packageReview?.decision
      || report.semanticReferee?.decision
      || report.semanticReviewer?.decision
      || report.finalDecision
      || report.status,
  );
}

export function taskIdFromSemanticReviewerReport(report = {}) {
  return report.taskId
    || report.entry?.taskId
    || report.manifest?.taskId
    || report.packageReview?.taskId
    || report.semanticReferee?.taskId
    || null;
}

export function summarizeSemanticReviewerCalibration(dataset = {}) {
  const counts = {};
  for (const item of dataset.cases || []) counts[item.expectedDecision] = (counts[item.expectedDecision] || 0) + 1;
  const labels = {};
  for (const item of dataset.cases || []) for (const label of item.labels || []) labels[label] = (labels[label] || 0) + 1;
  const hasAllDecisions = ['PASS', 'REVIEW', 'FAIL'].every((decision) => counts[decision] > 0);
  return {
    ok: hasAllDecisions,
    version: dataset.version,
    datasetHash: semanticReviewerCalibrationHash(dataset),
    caseCount: dataset.cases?.length || 0,
    counts,
    labels,
    thresholds: dataset.thresholds,
    dimensions: dataset.dimensions,
    safety: SEMANTIC_REVIEWER_CALIBRATION_SAFETY,
    next: 'use this adjudication set to score semantic reviewer reports before enabling semantic FAIL as a blocking import-ready gate',
  };
}

export function scoreSemanticReviewerReport(report, dataset) {
  const reportDecision = String(report.decision || report.semanticDecision || '').toUpperCase();
  const expected = String(report.expectedDecision || '').toUpperCase();
  const ok = !expected || reportDecision === expected;
  return {
    ok,
    reportDecision,
    expectedDecision: expected || null,
    datasetHash: semanticReviewerCalibrationHash(dataset),
    calibrationVersion: dataset.version,
    safety: SEMANTIC_REVIEWER_CALIBRATION_SAFETY,
    notes: ok ? 'report decision matches expected decision when supplied' : 'report decision differs from calibration expectation',
  };
}

export function gateSemanticReviewerCalibrationReports({ dataset, records }) {
  const byTask = new Map();
  for (const record of records || []) {
    const previous = byTask.get(String(record.taskId));
    const previousTime = Date.parse(previous?.reviewedAt || '') || previous?.mtimeMs || 0;
    const nextTime = Date.parse(record.reviewedAt || '') || record.mtimeMs || 0;
    if (!previous || nextTime >= previousTime) byTask.set(String(record.taskId), record);
  }
  const cases = [];
  for (const item of dataset.cases || []) {
    const expected = normalizeSemanticReviewerDecision(item.expectedDecision);
    const latest = byTask.get(String(item.taskId));
    const actual = latest?.decision || null;
    cases.push({
      id: item.id,
      taskId: String(item.taskId),
      expectedDecision: expected,
      actualDecision: actual,
      ok: latest ? actual === expected : null,
      missing: !latest,
      reportPath: latest?.file || null,
      reportHash: latest?.reportHash || null,
      labels: item.labels || [],
    });
  }
  const checked = cases.filter((item) => item.ok !== null);
  const mismatches = checked.filter((item) => !item.ok);
  const missing = cases.filter((item) => item.missing);
  return {
    ok: checked.length > 0 && mismatches.length === 0,
    checked: checked.length,
    totalCases: cases.length,
    missing: missing.length,
    mismatches: mismatches.length,
    datasetHash: semanticReviewerCalibrationHash(dataset),
    calibrationVersion: dataset.version,
    safety: SEMANTIC_REVIEWER_CALIBRATION_SAFETY,
    cases,
    next: mismatches.length
      ? 'inspect mismatched reports before making semantic reviewer a hard gate'
      : (checked.length ? 'calibration replay matched available reports' : 'no matching reports found for calibration cases'),
  };
}

export function semanticReviewerCalibrationContractsSelftest() {
  const dataset = defaultSemanticReviewerCalibrationSet({ now: '2026-06-21T00:00:00.000Z' });
  const summary = summarizeSemanticReviewerCalibration(dataset);
  const scored = scoreSemanticReviewerReport({ decision: 'FAIL', expectedDecision: 'FAIL' }, dataset);
  const gate = gateSemanticReviewerCalibrationReports({
    dataset,
    records: [
      { taskId: '1003603002', decision: 'PASS', file: '/tmp/a.json', mtimeMs: 1, reportHash: 'a' },
      { taskId: '1003599274', decision: 'FAIL', file: '/tmp/b.json', mtimeMs: 1, reportHash: 'b' },
      { taskId: '1003687808', decision: 'REVIEW', file: '/tmp/c.json', mtimeMs: 1, reportHash: 'c' },
    ],
  });
  return {
    ok: summary.ok
      && summary.counts.PASS >= 2
      && summary.counts.FAIL >= 2
      && summary.counts.REVIEW >= 1
      && scored.ok
      && gate.ok
      && gate.checked === 3
      && gate.mismatches === 0,
    safety: SEMANTIC_REVIEWER_CALIBRATION_SAFETY,
    summary,
    scored,
    gate,
  };
}
