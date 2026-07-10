import { digest } from './hash-utils.mjs';
import { reportStableHash } from './report-schema-contract.mjs';

export const REPORT_HASH_STABILITY_REGRESSION_VERSION = 1;

export const REPORT_HASH_STABILITY_REGRESSION_REPORT_FILE_ID = 'report-hash-stability-regression-latest.json';

export const REPORT_HASH_STABILITY_REGRESSION_SCRIPT_ID = 'reports:hash-stability-regression';

const FIXTURE_GENERATED_AT = '2026-01-01T00:00:00.000Z';

const VOLATILE_REPORT_HASH_KEYS = Object.freeze([
  'generatedAt',
  'reportFiles',
  'outputFiles',
  'latestJson',
  'latestMd',
  'jsonPath',
  'markdownPath',
  'markdownFile',
  'markdownOutputPath',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ''));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function duplicateValues(values = []) {
  return values
    .filter((value, index, all) => all.indexOf(value) !== index)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));
}

function stripVolatileReportHashFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileReportHashFields);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => item !== undefined && !VOLATILE_REPORT_HASH_KEYS.includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stripVolatileReportHashFields(item)]),
  );
}

export function stableHashableReportPayload(report = {}) {
  return stripVolatileReportHashFields(report);
}

export function stableReportDigest(report = {}) {
  return digest(stableHashableReportPayload(report));
}

function syntheticReport() {
  return {
    version: 1,
    kind: 'SyntheticLatestReport',
    status: 'pass_synthetic_latest_report',
    ok: true,
    generatedAt: FIXTURE_GENERATED_AT,
    reportFiles: {
      json: 'reports/synthetic-latest.json',
      md: 'reports/synthetic-latest.md',
    },
    summary: {
      recordCount: 3,
      blockerCount: 0,
    },
    blockers: [],
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
    syntheticHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  };
}

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, item]) => [key, reorderObjectKeys(item)]),
  );
}

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'generated_at_noise_same_hash',
    label: 'Changing generatedAt must not change the canonical stable report hash',
    expectedSameHash: true,
    expectedBlockerCode: 'report_hash_stability_generated_at_affects_hash',
    mutate(report) {
      report.generatedAt = '2026-12-31T23:59:59.999Z';
    },
  }),
  Object.freeze({
    scenarioId: 'report_files_output_noise_same_hash',
    label: 'Changing output report paths must not change the canonical stable report hash',
    expectedSameHash: true,
    expectedBlockerCode: 'report_hash_stability_output_path_affects_hash',
    mutate(report) {
      report.reportFiles = {
        json: 'reports/archive/synthetic-latest.json',
        md: 'reports/archive/synthetic-latest.md',
      };
      report.markdownPath = 'reports/archive/synthetic-latest.md';
    },
  }),
  Object.freeze({
    scenarioId: 'key_order_noise_same_hash',
    label: 'Changing object insertion order must not change the canonical stable report hash',
    expectedSameHash: true,
    expectedBlockerCode: 'report_hash_stability_key_order_affects_hash',
    mutate(report) {
      return reorderObjectKeys(report);
    },
  }),
  Object.freeze({
    scenarioId: 'summary_semantic_change_changes_hash',
    label: 'Changing summary semantics must change the canonical stable report hash',
    expectedSameHash: false,
    expectedBlockerCode: 'report_hash_stability_semantic_change_not_hashed',
    mutate(report) {
      report.summary.recordCount += 1;
    },
  }),
  Object.freeze({
    scenarioId: 'blocker_semantic_change_changes_hash',
    label: 'Changing blocker semantics must change the canonical stable report hash',
    expectedSameHash: false,
    expectedBlockerCode: 'report_hash_stability_blocker_change_not_hashed',
    mutate(report) {
      report.summary.blockerCount = 1;
      report.blockers.push({
        code: 'synthetic_blocker',
        notes: 'Synthetic blocker must affect the stable report hash.',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'safety_semantic_change_changes_hash',
    label: 'Changing safety semantics must change the canonical stable report hash',
    expectedSameHash: false,
    expectedBlockerCode: 'report_hash_stability_safety_change_not_hashed',
    mutate(report) {
      report.safety.executesExternalAction = true;
    },
  }),
]);

function runScenario(scenario) {
  const baselineReport = syntheticReport();
  const baselineHash = stableReportDigest(baselineReport);
  const mutatedReport = clone(baselineReport);
  const mutationResult = scenario.mutate(mutatedReport);
  const finalMutatedReport = mutationResult || mutatedReport;
  const mutatedHash = stableReportDigest(finalMutatedReport);
  const sameHash = baselineHash === mutatedHash;
  const ok = scenario.expectedSameHash ? sameHash : !sameHash;
  const blockers = ok ? [] : [{
    code: scenario.expectedBlockerCode,
    notes: `${scenario.scenarioId} expected sameHash=${scenario.expectedSameHash}, observed sameHash=${sameHash}.`,
  }];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_hash_stability_regression_scenario' : 'pass_report_hash_stability_regression_scenario',
    ok: blockers.length === 0,
    expectedSameHash: scenario.expectedSameHash,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observed: {
      baselineHash,
      mutatedHash,
      sameHash,
    },
    blockers,
  };
}

function compactActualRecord(record) {
  const stableHash = reportStableHash(record.report || {});
  return {
    fileId: record.fileId,
    kind: record.report?.kind || null,
    status: record.report?.status || null,
    ok: record.report?.ok === true,
    stableHash,
    stableHashValid: isSha256(stableHash),
    canonicalHash: stableReportDigest(record.report || {}),
  };
}

export function analyzeReportHashStabilityRecords({
  expectedFileIds = [],
  records = [],
} = {}) {
  const byFileId = Object.fromEntries(records.map((record) => [record.fileId, record]));
  const actualRecords = expectedFileIds
    .filter((fileId) => byFileId[fileId])
    .map((fileId) => compactActualRecord(byFileId[fileId]));
  const missingFileIds = expectedFileIds.filter((fileId) => !byFileId[fileId]);
  const duplicateStableHashes = duplicateValues(actualRecords.map((record) => record.stableHash).filter(Boolean));
  const blockers = [
    ...missingFileIds.map((fileId) => ({
      code: 'report_hash_stability_required_report_missing',
      fileId,
      notes: `${fileId} is required for the latest report hash stability inventory but was not provided.`,
    })),
    ...actualRecords
      .filter((record) => !record.stableHash)
      .map((record) => ({
        code: 'report_hash_stability_report_hash_missing',
        fileId: record.fileId,
        notes: `${record.fileId} does not expose a stable report hash.`,
      })),
    ...actualRecords
      .filter((record) => record.stableHash && !record.stableHashValid)
      .map((record) => ({
        code: 'report_hash_stability_report_hash_invalid',
        fileId: record.fileId,
        notes: `${record.fileId} stable hash is not a sha256 digest.`,
        stableHash: record.stableHash,
      })),
    ...duplicateStableHashes.map((stableHash) => ({
      code: 'report_hash_stability_duplicate_report_hash',
      stableHash,
      notes: `Stable report hash ${stableHash} appears on more than one latest report.`,
    })),
  ];
  return {
    status: blockers.length ? 'blocked_report_hash_stability_analysis' : 'pass_report_hash_stability_analysis',
    ok: blockers.length === 0,
    expectedReportCount: expectedFileIds.length,
    analyzedReportCount: actualRecords.length,
    missingReportCount: missingFileIds.length,
    hashableReportCount: actualRecords.filter((record) => record.stableHashValid).length,
    duplicateStableHashCount: duplicateStableHashes.length,
    expectedFileIds: uniqueSorted(expectedFileIds),
    records: actualRecords,
    blockers,
  };
}

function compactActualAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    expectedReportCount: analysis.expectedReportCount,
    analyzedReportCount: analysis.analyzedReportCount,
    missingReportCount: analysis.missingReportCount,
    hashableReportCount: analysis.hashableReportCount,
    duplicateStableHashCount: analysis.duplicateStableHashCount,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      stableHash: item.stableHash || null,
    })),
  };
}

export function buildReportHashStabilityRegressionReport({
  expectedFileIds = [],
  records = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedExpectedFileIds = uniqueSorted(expectedFileIds);
  const actual = analyzeReportHashStabilityRecords({
    expectedFileIds: normalizedExpectedFileIds,
    records,
  });
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_reports',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_HASH_STABILITY_REGRESSION_VERSION,
    kind: 'ReportHashStabilityRegression',
    status: blockers.length ? 'blocked_report_hash_stability_regression' : 'pass_report_hash_stability_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_HASH_STABILITY_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_HASH_STABILITY_REGRESSION_SCRIPT_ID,
    volatileHashKeys: [...VOLATILE_REPORT_HASH_KEYS],
    expectedFileIds: normalizedExpectedFileIds,
    actual: compactActualAnalysis(actual),
    records: actual.records,
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      expectedReportCount: actual.expectedReportCount,
      analyzedReportCount: actual.analyzedReportCount,
      missingReportCount: actual.missingReportCount,
      hashableReportCount: actual.hashableReportCount,
      duplicateStableHashCount: actual.duplicateStableHashCount,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      noiseScenarioCount: scenarios.filter((scenario) => scenario.expectedSameHash).length,
      semanticScenarioCount: scenarios.filter((scenario) => !scenario.expectedSameHash).length,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      mutatesReportFiles: false,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const hashStabilityRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    volatileHashKeys: report.volatileHashKeys,
    expectedFileIds: report.expectedFileIds,
    actual: report.actual,
    records: report.records,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expectedSameHash: scenario.expectedSameHash,
      observed: scenario.observed,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    hashStabilityRegressionHash,
    hash: hashStabilityRegressionHash,
  };
}

export function summarizeReportHashStabilityRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_hash_stability_regression',
    ok: report?.ok === true,
    hashStabilityRegressionHash: report?.hashStabilityRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    expectedReportCount: report?.summary?.expectedReportCount || 0,
    hashableReportCount: report?.summary?.hashableReportCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      executesExternalAction: false,
    },
  };
}
