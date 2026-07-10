import { digest } from './hash-utils.mjs';
import {
  REPORT_FRESHNESS_GATE_REPORT,
  REPORT_FRESHNESS_REQUIRED_REPORTS,
  buildReportFreshnessReport,
} from './report-freshness.mjs';

export const REPORT_FRESHNESS_REGRESSION_VERSION = 1;

export const REPORT_FRESHNESS_REGRESSION_REPORT_FILE_ID = 'report-freshness-regression-latest.json';

const FIXTURE_GENERATED_AT = '2026-01-01T00:00:00.000Z';

const SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_required_report',
    label: 'Missing required latest report',
    expectedBlockerCode: 'report_freshness_required_report_missing',
    mutate({ reportBindings }) {
      reportBindings['contract-schemas-latest.json'] = {
        ...reportBindings['contract-schemas-latest.json'],
        exists: false,
        ok: false,
        status: 'missing_fixture_report',
        hash: null,
      };
    },
  }),
  Object.freeze({
    scenarioId: 'not_ok_required_report',
    label: 'Required latest report is not ok',
    expectedBlockerCode: 'report_freshness_required_report_not_ok',
    mutate({ reportBindings }) {
      reportBindings['read-only-report-chain-latest.json'] = {
        ...reportBindings['read-only-report-chain-latest.json'],
        ok: false,
        status: 'blocked_fixture_read_only_report_chain',
      };
    },
  }),
  Object.freeze({
    scenarioId: 'missing_required_report_hash',
    label: 'Required latest report has no stable hash',
    expectedBlockerCode: 'report_freshness_required_report_hash_missing',
    mutate({ reportBindings }) {
      reportBindings['package-surface-latest.json'] = {
        ...reportBindings['package-surface-latest.json'],
        hash: null,
      };
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_drift',
    label: 'Latest report hash drifts from integration gate summary',
    expectedBlockerCode: 'report_freshness_gate_hash_mismatch',
    mutate({ reportBindings }) {
      reportBindings['package-surface-latest.json'] = {
        ...reportBindings['package-surface-latest.json'],
        hash: 'sha256:fixture-drifted-package-surface-latest.json',
      };
    },
  }),
  Object.freeze({
    scenarioId: 'missing_integration_gate_report',
    label: 'Final freshness run has no integration gate report',
    expectedBlockerCode: 'report_freshness_integration_gate_missing',
    mutate({ reportBindings }) {
      reportBindings[REPORT_FRESHNESS_GATE_REPORT.fileId] = {
        ...reportBindings[REPORT_FRESHNESS_GATE_REPORT.fileId],
        exists: false,
        ok: false,
        status: 'missing_fixture_integration_gate',
        hash: null,
      };
    },
  }),
  Object.freeze({
    scenarioId: 'integration_gate_file_hash_drift',
    label: 'Integration gate binding hash drifts from gate report hash',
    expectedBlockerCode: 'report_freshness_integration_gate_file_hash_mismatch',
    mutate({ reportBindings }) {
      reportBindings[REPORT_FRESHNESS_GATE_REPORT.fileId] = {
        ...reportBindings[REPORT_FRESHNESS_GATE_REPORT.fileId],
        hash: 'sha256:fixture-drifted-integration-gate-file-hash',
      };
    },
  }),
  Object.freeze({
    scenarioId: 'missing_integration_gate_hash_alias',
    label: 'Integration gate report keeps generic hash but drops gateHash',
    expectedBlockerCode: 'report_freshness_integration_gate_hash_alias_missing',
    mutate({ gateReport }) {
      delete gateReport.gateHash;
    },
  }),
]);

function fixtureHash(fileId) {
  return `sha256:fixture-${fileId}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baselineFixture() {
  const hashes = Object.fromEntries(REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => [
    spec.fileId,
    fixtureHash(spec.fileId),
  ]));
  const gateReport = {
    ok: true,
    status: 'pass_integration_dependency_gate',
    gateHash: fixtureHash(REPORT_FRESHNESS_GATE_REPORT.fileId),
    hash: fixtureHash(REPORT_FRESHNESS_GATE_REPORT.fileId),
    summary: Object.fromEntries(REPORT_FRESHNESS_REQUIRED_REPORTS
      .filter((spec) => spec.gateSummaryHashKey)
      .map((spec) => [spec.gateSummaryHashKey, hashes[spec.fileId]])),
  };
  const reportBindings = Object.fromEntries([
    ...REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => [spec.fileId, {
      exists: true,
      ok: true,
      status: `pass_fixture_${spec.key}`,
      hash: hashes[spec.fileId],
      blockerCount: 0,
      generatedAt: FIXTURE_GENERATED_AT,
      file: `design-production-core/reports/${spec.fileId}`,
    }]),
    [REPORT_FRESHNESS_GATE_REPORT.fileId, {
      exists: true,
      ok: true,
      status: gateReport.status,
      hash: gateReport.gateHash,
      blockerCount: 0,
      generatedAt: FIXTURE_GENERATED_AT,
      file: `design-production-core/reports/${REPORT_FRESHNESS_GATE_REPORT.fileId}`,
    }],
  ]);
  return { reportBindings, gateReport };
}

function compactFreshnessReport(report) {
  return {
    status: report.status,
    ok: report.ok === true,
    freshnessHash: report.freshnessHash,
    summary: {
      reportCount: report.summary.reportCount,
      okReportCount: report.summary.okReportCount,
      gateHashMismatchCount: report.summary.gateHashMismatchCount,
      missingReportCount: report.summary.missingReportCount,
      notOkReportCount: report.summary.notOkReportCount,
      missingHashCount: report.summary.missingHashCount,
      gateReportOk: report.summary.gateReportOk,
      gateReportHashMatchesFile: report.summary.gateReportHashMatchesFile,
      blockerCount: report.summary.blockerCount,
    },
    blockers: report.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
    })),
  };
}

function runScenario(scenario, generatedAt) {
  const fixture = baselineFixture();
  scenario.mutate({
    reportBindings: fixture.reportBindings,
    gateReport: fixture.gateReport,
  });
  const freshness = buildReportFreshnessReport({
    reportBindings: fixture.reportBindings,
    gateReport: fixture.gateReport,
    includeGateReport: true,
    generatedAt,
  });
  const observedBlockerCodes = freshness.blockers.map((item) => item.code);
  const blockers = [
    ...(freshness.ok === true ? [{
      code: 'freshness_regression_scenario_unexpectedly_passed',
      notes: `${scenario.scenarioId} must make report freshness fail.`,
    }] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [{
      code: 'freshness_regression_expected_blocker_missing',
      notes: `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, got ${observedBlockerCodes.join(', ') || 'none'}.`,
    }] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_freshness_regression_scenario' : 'pass_report_freshness_regression_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    freshness: compactFreshnessReport(freshness),
    blockers,
  };
}

export function buildReportFreshnessRegressionReport({
  generatedAt = new Date().toISOString(),
} = {}) {
  const scenarios = SCENARIOS.map((scenario) => runScenario(scenario, generatedAt));
  const blockers = scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
    ...item,
    scenarioId: scenario.scenarioId,
  })));
  const report = {
    version: REPORT_FRESHNESS_REGRESSION_VERSION,
    kind: 'ReportFreshnessRegression',
    status: blockers.length ? 'blocked_report_freshness_regression' : 'pass_report_freshness_regression',
    ok: blockers.length === 0,
    generatedAt,
    fixture: {
      generatedAt: FIXTURE_GENERATED_AT,
      requiredReportCount: REPORT_FRESHNESS_REQUIRED_REPORTS.length,
      gateReportFileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      scenarioIds: SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
    },
    scenarios,
    summary: {
      expectedScenarioCount: SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      expectedBlockerCount: SCENARIOS.length,
      observedExpectedBlockerCount: scenarios.filter((scenario) => (
        scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
      )).length,
      requiredReportCount: REPORT_FRESHNESS_REQUIRED_REPORTS.length,
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
  const freshnessRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    fixture: report.fixture,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
      freshness: scenario.freshness,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    freshnessRegressionHash,
    hash: freshnessRegressionHash,
  };
}

export function summarizeReportFreshnessRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_freshness_regression',
    ok: report?.ok === true,
    freshnessRegressionHash: report?.freshnessRegressionHash || null,
    scenarioCount: report?.summary?.scenarioCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    failedScenarioCount: report?.summary?.failedScenarioCount || 0,
    observedExpectedBlockerCount: report?.summary?.observedExpectedBlockerCount || 0,
    requiredReportCount: report?.summary?.requiredReportCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
