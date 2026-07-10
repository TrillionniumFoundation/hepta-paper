import { digest } from './hash-utils.mjs';
import {
  INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS,
  INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS,
  buildIntegrationGateTooling,
} from './integration-gate-tooling.mjs';
import {
  REPORT_FRESHNESS_GATE_REPORT,
  REPORT_FRESHNESS_REQUIRED_REPORTS,
  buildReportFreshnessReport,
} from './report-freshness.mjs';
import {
  buildReportSchemaContractReport,
  expectedReportSchemaContractFileIds,
} from './report-schema-contract.mjs';

export const REPORT_LATEST_RECOVERY_REGRESSION_VERSION = 1;

export const REPORT_LATEST_RECOVERY_REGRESSION_REPORT_FILE_ID = 'report-latest-recovery-regression-latest.json';

export const REPORT_LATEST_RECOVERY_REGRESSION_SCRIPT_ID = 'reports:latest-recovery-regression';

export const REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS = Object.freeze([
  'integration-dependency-audit-latest.json',
  'integration-gate-tooling-latest.json',
  'report-freshness-latest.json',
  'report-schema-contract-latest.json',
  'integration-dependency-gate-latest.json',
]);

const FIXTURE_GENERATED_AT = '2026-01-01T00:00:00.000Z';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'contaminated_schema_still_passes',
    label: 'Contaminated latest reports stop blocking schema contract recovery',
    expectedBlockerCode: 'report_latest_recovery_contaminated_schema_not_blocked',
    mutate(input) {
      input.contaminatedReports = restoreContaminatedReports(input.contaminatedReports, input.passReports);
    },
  }),
  Object.freeze({
    scenarioId: 'contaminated_freshness_still_passes',
    label: 'Contaminated latest reports stop blocking skip-gate freshness recovery',
    expectedBlockerCode: 'report_latest_recovery_contaminated_freshness_not_blocked',
    mutate(input) {
      input.contaminatedReports = restoreContaminatedReports(input.contaminatedReports, input.passReports);
    },
  }),
  Object.freeze({
    scenarioId: 'contaminated_tooling_still_passes',
    label: 'Contaminated latest reports stop blocking tooling recovery',
    expectedBlockerCode: 'report_latest_recovery_contaminated_tooling_not_blocked',
    mutate(input) {
      input.contaminatedReports = restoreContaminatedReports(input.contaminatedReports, input.passReports);
    },
  }),
  Object.freeze({
    scenarioId: 'missing_gate_bootstrap',
    label: 'Final recovery runs without a usable gate bootstrap report',
    expectedBlockerCode: 'report_freshness_integration_gate_missing',
    mutate(input) {
      input.finalGateReport = null;
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_report_not_ok',
    label: 'A bootstrap seed is still blocked',
    expectedBlockerCode: 'report_latest_recovery_bootstrap_schema_not_passed',
    mutate(input) {
      input.bootstrapReports = {
        ...input.bootstrapReports,
        'integration-dependency-audit-latest.json': blockedLatestReport('integration-dependency-audit-latest.json', {
          variant: 'bootstrap_still_blocked',
        }),
      };
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_hash_missing',
    label: 'A bootstrap seed loses its stable hash',
    expectedBlockerCode: 'report_schema_contract_stable_hash_missing',
    mutate(input) {
      const fileId = 'integration-gate-tooling-latest.json';
      const report = clone(input.bootstrapReports[fileId]);
      delete report.reportHash;
      delete report.hash;
      input.bootstrapReports = {
        ...input.bootstrapReports,
        [fileId]: report,
      };
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_hash_alias_stripped',
    label: 'A bootstrap seed keeps only generic hash after losing its semantic report hash',
    expectedBlockerCode: 'report_freshness_required_report_hash_missing',
    mutate(input) {
      const fileId = 'integration-gate-tooling-latest.json';
      const report = clone(input.bootstrapReports[fileId]);
      delete report.reportHash;
      input.bootstrapReports = {
        ...input.bootstrapReports,
        [fileId]: report,
      };
    },
  }),
  Object.freeze({
    scenarioId: 'final_gate_hash_drift',
    label: 'The final gate summary drifts from recovered latest report hashes',
    expectedBlockerCode: 'report_freshness_gate_hash_mismatch',
    mutate(input) {
      input.finalGateReport = {
        ...input.finalGateReport,
        summary: {
          ...input.finalGateReport.summary,
          integrationGateToolingHash: digest({
            scenarioId: 'final_gate_hash_drift',
            field: 'integrationGateToolingHash',
          }),
        },
      };
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function allLatestFileIds() {
  return uniqueSorted([
    ...expectedReportSchemaContractFileIds(),
    ...REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
    ...INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
    REPORT_FRESHNESS_GATE_REPORT.fileId,
  ]);
}

function reportHashFor(fileId, status, variant) {
  return digest({
    fixture: 'report_latest_recovery_regression',
    fileId,
    status,
    variant,
  });
}

function safetyBlock() {
  return {
    localOnly: true,
    readOnly: true,
    syntheticFixtureOnly: true,
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
  };
}

function passLatestReport(fileId, { variant = 'pass' } = {}) {
  const hash = reportHashFor(fileId, 'pass_synthetic_latest_report', variant);
  return {
    version: 1,
    kind: 'SyntheticLatestRecoveryReport',
    status: 'pass_synthetic_latest_report',
    ok: true,
    generatedAt: FIXTURE_GENERATED_AT,
    fileId,
    summary: {
      blockerCount: 0,
      variant,
    },
    blockers: [],
    safety: safetyBlock(),
    reportHash: hash,
    hash,
  };
}

function blockedLatestReport(fileId, { variant = 'contaminated' } = {}) {
  const hash = reportHashFor(fileId, 'blocked_synthetic_latest_report', variant);
  return {
    version: 1,
    kind: 'SyntheticLatestRecoveryReport',
    status: 'blocked_synthetic_latest_report',
    ok: false,
    generatedAt: FIXTURE_GENERATED_AT,
    fileId,
    summary: {
      blockerCount: 1,
      variant,
    },
    blockers: [{
      code: 'synthetic_latest_blocked',
      fileId,
      notes: `${fileId} is intentionally blocked to model latest report contamination.`,
    }],
    safety: safetyBlock(),
    reportHash: hash,
    hash,
  };
}

function buildPassReports() {
  return Object.fromEntries(allLatestFileIds().map((fileId) => [
    fileId,
    passLatestReport(fileId),
  ]));
}

function contaminateReports(passReports) {
  return Object.fromEntries(Object.entries(passReports).map(([fileId, report]) => [
    fileId,
    REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS.includes(fileId)
      ? blockedLatestReport(fileId)
      : report,
  ]));
}

function restoreContaminatedReports(reports, passReports) {
  return Object.fromEntries(Object.entries(reports).map(([fileId, report]) => [
    fileId,
    REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS.includes(fileId)
      ? passReports[fileId]
      : report,
  ]));
}

function buildRecoveryInput() {
  const passReports = buildPassReports();
  const contaminatedReports = contaminateReports(passReports);
  const bootstrapReports = restoreContaminatedReports(contaminatedReports, passReports);
  return {
    passReports,
    contaminatedReports,
    bootstrapReports,
    finalGateReport: buildSyntheticGateReport(bootstrapReports),
  };
}

function recordsFromReports(fileIds, reportsByFileId) {
  return fileIds.map((fileId) => ({
    fileId,
    report: reportsByFileId[fileId],
  }));
}

function semanticReportHash(report = {}) {
  return report?.reportHash
    || report?.gateHash
    || report?.schemaContractHash
    || report?.freshnessHash
    || report?.toolingHash
    || report?.latestRecoveryRegressionHash
    || null;
}

function bindingFromReport(fileId, report) {
  return {
    exists: Boolean(report),
    ok: report?.ok === true,
    status: report?.status || null,
    hash: semanticReportHash(report),
    blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
    generatedAt: report?.generatedAt || null,
    report: report || null,
  };
}

function bindingsFromReports(fileIds, reportsByFileId) {
  return Object.fromEntries(fileIds.map((fileId) => [
    fileId,
    bindingFromReport(fileId, reportsByFileId[fileId]),
  ]));
}

function finalBindingsFromReports(reportsByFileId, gateReport) {
  const bindings = bindingsFromReports([
    ...REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
    REPORT_FRESHNESS_GATE_REPORT.fileId,
  ], reportsByFileId);
  bindings[REPORT_FRESHNESS_GATE_REPORT.fileId] = gateReport
    ? bindingFromReport(REPORT_FRESHNESS_GATE_REPORT.fileId, gateReport)
    : {
      exists: false,
      ok: false,
      status: null,
      hash: null,
      blockerCount: 0,
      generatedAt: null,
      report: null,
    };
  return bindings;
}

function buildSyntheticGateReport(reportsByFileId) {
  const summary = Object.fromEntries(REPORT_FRESHNESS_REQUIRED_REPORTS
    .filter((spec) => spec.gateSummaryHashKey)
    .map((spec) => [
      spec.gateSummaryHashKey,
      semanticReportHash(reportsByFileId[spec.fileId]),
    ]));
  const gateHash = digest({
    kind: 'SyntheticLatestRecoveryIntegrationGate',
    status: 'pass_synthetic_latest_recovery_integration_gate',
    summary,
  });
  return {
    version: 1,
    kind: 'SyntheticLatestRecoveryIntegrationGate',
    status: 'pass_synthetic_latest_recovery_integration_gate',
    ok: true,
    generatedAt: FIXTURE_GENERATED_AT,
    summary,
    blockers: [],
    safety: safetyBlock(),
    gateHash,
    hash: gateHash,
  };
}

function hasBlocker(report, code) {
  return (report?.blockers || []).some((item) => item.code === code);
}

function observedBlockerCodesFromReports(reports = []) {
  return uniqueSorted(reports.flatMap((report) => (report?.blockers || []).map((item) => item.code)));
}

function compactReport(report) {
  return {
    status: report?.status || null,
    ok: report?.ok === true,
    hash: semanticReportHash(report),
    summary: report?.summary || null,
    blockerCodes: observedBlockerCodesFromReports([report]),
  };
}

function analyzeRecoveryCase(input = {}) {
  const schemaExpectedFileIds = expectedReportSchemaContractFileIds();
  const contaminatedSchema = buildReportSchemaContractReport({
    expectedFileIds: schemaExpectedFileIds,
    records: recordsFromReports(schemaExpectedFileIds, input.contaminatedReports),
    generatedAt: FIXTURE_GENERATED_AT,
  });
  const contaminatedFreshness = buildReportFreshnessReport({
    reportBindings: bindingsFromReports(
      REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
      input.contaminatedReports,
    ),
    includeGateReport: false,
    generatedAt: FIXTURE_GENERATED_AT,
  });
  const contaminatedTooling = buildIntegrationGateTooling({
    publicModules: ['integration-gate-tooling'],
    compatibilityModules: [],
    scriptIds: [...INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS],
    reportBindings: bindingsFromReports(INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS, input.contaminatedReports),
    indexSource: '',
    packageExports: INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS,
    generatedAt: FIXTURE_GENERATED_AT,
  });
  const bootstrapSchema = buildReportSchemaContractReport({
    expectedFileIds: schemaExpectedFileIds,
    records: recordsFromReports(schemaExpectedFileIds, input.bootstrapReports),
    generatedAt: FIXTURE_GENERATED_AT,
  });
  const bootstrapFreshness = buildReportFreshnessReport({
    reportBindings: bindingsFromReports(
      REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
      input.bootstrapReports,
    ),
    includeGateReport: false,
    generatedAt: FIXTURE_GENERATED_AT,
  });
  const bootstrapTooling = buildIntegrationGateTooling({
    publicModules: ['integration-gate-tooling'],
    compatibilityModules: [],
    scriptIds: [...INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS],
    reportBindings: bindingsFromReports(INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS, input.bootstrapReports),
    indexSource: '',
    packageExports: INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS,
    generatedAt: FIXTURE_GENERATED_AT,
  });
  const finalFreshness = buildReportFreshnessReport({
    reportBindings: finalBindingsFromReports(input.bootstrapReports, input.finalGateReport),
    gateReport: input.finalGateReport || null,
    includeGateReport: true,
    generatedAt: FIXTURE_GENERATED_AT,
  });
  const blockers = [
    ...(contaminatedSchema.ok ? [blocker(
      'report_latest_recovery_contaminated_schema_not_blocked',
      'Contaminated latest reports must block the schema contract before bootstrap recovery.',
    )] : []),
    ...(!hasBlocker(contaminatedSchema, 'report_schema_contract_status_not_passing') ? [blocker(
      'report_latest_recovery_contaminated_schema_status_blocker_missing',
      'Contaminated schema analysis must observe non-passing latest report status.',
    )] : []),
    ...(contaminatedFreshness.ok ? [blocker(
      'report_latest_recovery_contaminated_freshness_not_blocked',
      'Contaminated latest reports must block skip-gate freshness before bootstrap recovery.',
    )] : []),
    ...(!hasBlocker(contaminatedFreshness, 'report_freshness_required_report_not_ok') ? [blocker(
      'report_latest_recovery_contaminated_freshness_not_ok_blocker_missing',
      'Contaminated freshness analysis must observe not-ok required reports.',
    )] : []),
    ...(contaminatedTooling.ok ? [blocker(
      'report_latest_recovery_contaminated_tooling_not_blocked',
      'Contaminated latest reports must block integration gate tooling before bootstrap recovery.',
    )] : []),
    ...(!hasBlocker(contaminatedTooling, 'integration_gate_tooling_report_not_ok') ? [blocker(
      'report_latest_recovery_contaminated_tooling_not_ok_blocker_missing',
      'Contaminated tooling analysis must observe not-ok tracked reports.',
    )] : []),
    ...(!bootstrapSchema.ok ? [blocker(
      'report_latest_recovery_bootstrap_schema_not_passed',
      'Bootstrap latest reports must make the schema contract pass again.',
    )] : []),
    ...(!bootstrapFreshness.ok ? [blocker(
      'report_latest_recovery_bootstrap_freshness_not_passed',
      'Bootstrap latest reports must make skip-gate freshness pass again.',
    )] : []),
    ...(!bootstrapTooling.ok ? [blocker(
      'report_latest_recovery_bootstrap_tooling_not_passed',
      'Bootstrap latest reports must make integration gate tooling pass again.',
    )] : []),
    ...(!finalFreshness.ok ? [blocker(
      'report_latest_recovery_final_freshness_not_passed',
      'Final freshness must pass once the gate report hash summary matches recovered latest reports.',
    )] : []),
  ];
  return {
    status: blockers.length ? 'blocked_report_latest_recovery_analysis' : 'pass_report_latest_recovery_analysis',
    ok: blockers.length === 0,
    schemaExpectedFileIds,
    contaminatedFileIds: [...REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS],
    phases: {
      contaminated: {
        schema: compactReport(contaminatedSchema),
        freshness: compactReport(contaminatedFreshness),
        tooling: compactReport(contaminatedTooling),
      },
      bootstrap: {
        restoredFileIds: [...REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS],
        schema: compactReport(bootstrapSchema),
        freshness: compactReport(bootstrapFreshness),
        tooling: compactReport(bootstrapTooling),
      },
      final: {
        freshness: compactReport(finalFreshness),
      },
    },
    phaseReports: {
      contaminatedSchema,
      contaminatedFreshness,
      contaminatedTooling,
      bootstrapSchema,
      bootstrapFreshness,
      bootstrapTooling,
      finalFreshness,
    },
    blockers,
  };
}

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    contaminatedFileIds: analysis.contaminatedFileIds,
    schemaExpectedReportCount: analysis.schemaExpectedFileIds.length,
    phases: analysis.phases,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
    })),
  };
}

function observedRecoveryBlockerCodes(analysis) {
  return uniqueSorted([
    ...analysis.blockers.map((item) => item.code),
    ...observedBlockerCodesFromReports(Object.values(analysis.phaseReports)),
  ]);
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeRecoveryCase(input);
  const observedBlockerCodes = observedRecoveryBlockerCodes(analysis);
  const blockers = [
    ...(analysis.ok ? [blocker(
      'report_latest_recovery_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must make latest recovery regression fail.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_latest_recovery_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_latest_recovery_scenario' : 'pass_report_latest_recovery_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportLatestRecoveryRegressionReport({
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildRecoveryInput();
  const actual = analyzeRecoveryCase(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_latest_recovery',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_LATEST_RECOVERY_REGRESSION_VERSION,
    kind: 'ReportLatestRecoveryRegression',
    status: blockers.length ? 'blocked_report_latest_recovery_regression' : 'pass_report_latest_recovery_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_LATEST_RECOVERY_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_LATEST_RECOVERY_REGRESSION_SCRIPT_ID,
    fixture: {
      contaminatedFileIds: [...REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS],
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
    },
    actual: compactAnalysis(actual),
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      contaminatedFileCount: REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS.length,
      schemaExpectedReportCount: actual.schemaExpectedFileIds.length,
      contaminatedSchemaBlocked: actual.phaseReports.contaminatedSchema.ok === false,
      contaminatedFreshnessBlocked: actual.phaseReports.contaminatedFreshness.ok === false,
      contaminatedToolingBlocked: actual.phaseReports.contaminatedTooling.ok === false,
      bootstrapSchemaOk: actual.phaseReports.bootstrapSchema.ok === true,
      bootstrapFreshnessOk: actual.phaseReports.bootstrapFreshness.ok === true,
      bootstrapToolingOk: actual.phaseReports.bootstrapTooling.ok === true,
      finalFreshnessOk: actual.phaseReports.finalFreshness.ok === true,
      finalGateHashMismatchCount: actual.phaseReports.finalFreshness.summary?.gateHashMismatchCount || 0,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      observedExpectedBlockerCount: scenarios.filter((scenario) => (
        scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
      )).length,
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
  const latestRecoveryRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    fixture: report.fixture,
    actual: report.actual,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
      analysis: scenario.analysis,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    latestRecoveryRegressionHash,
    hash: latestRecoveryRegressionHash,
  };
}

export function summarizeReportLatestRecoveryRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_latest_recovery_regression',
    ok: report?.ok === true,
    latestRecoveryRegressionHash: report?.latestRecoveryRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contaminatedFileCount: report?.summary?.contaminatedFileCount || 0,
    contaminatedSchemaBlocked: report?.summary?.contaminatedSchemaBlocked === true,
    contaminatedFreshnessBlocked: report?.summary?.contaminatedFreshnessBlocked === true,
    contaminatedToolingBlocked: report?.summary?.contaminatedToolingBlocked === true,
    bootstrapSchemaOk: report?.summary?.bootstrapSchemaOk === true,
    bootstrapFreshnessOk: report?.summary?.bootstrapFreshnessOk === true,
    bootstrapToolingOk: report?.summary?.bootstrapToolingOk === true,
    finalFreshnessOk: report?.summary?.finalFreshnessOk === true,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
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
