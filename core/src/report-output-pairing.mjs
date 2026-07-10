import { digest } from './hash-utils.mjs';

export const REPORT_OUTPUT_PAIRING_VERSION = 1;

export const REPORT_OUTPUT_PAIRING_REPORT_FILE_ID = 'report-output-pairing-latest.json';

export const REPORT_OUTPUT_PAIRING_SCRIPT_ID = 'reports:output-pairing';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function markdownFileIdFor(fileId) {
  return String(fileId || '').replace(/\.json$/, '.md');
}

function basenameFromPath(value) {
  if (!value || typeof value !== 'string') return null;
  return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || null;
}

function includesReport(readmeText, fileId) {
  return String(readmeText || '').includes(fileId);
}

function blocker(code, fileId, notes, extra = {}) {
  return { code, fileId, notes, ...extra };
}

function normalizeRecord(record = {}) {
  const fileId = record.fileId;
  const mdFileId = markdownFileIdFor(fileId);
  const reportFiles = record.report?.reportFiles || {};
  const reportFilesJsonBasename = basenameFromPath(reportFiles.json);
  const reportFilesMarkdownBasename = basenameFromPath(reportFiles.md);
  return {
    fileId,
    mdFileId,
    jsonExists: record.jsonExists === true,
    mdExists: record.mdExists === true,
    kind: record.report?.kind || null,
    status: record.report?.status || null,
    ok: record.report?.ok === true,
    reportFilesJson: reportFiles.json || null,
    reportFilesMd: reportFiles.md || null,
    reportFilesJsonMatches: !reportFilesJsonBasename || reportFilesJsonBasename === fileId,
    reportFilesMarkdownMatches: !reportFilesMarkdownBasename || reportFilesMarkdownBasename === mdFileId,
    hasReportFilesJson: Boolean(reportFilesJsonBasename),
    hasReportFilesMd: Boolean(reportFilesMarkdownBasename),
  };
}

export function analyzeReportOutputPairingRecords({
  expectedFileIds = [],
  records = [],
  readmeText = '',
  packageScriptIds = [],
  requiredScriptIds = [REPORT_OUTPUT_PAIRING_SCRIPT_ID],
  freshnessRequiredFileIds = [],
} = {}) {
  const expectedIds = uniqueSorted(expectedFileIds);
  const byFileId = Object.fromEntries(records.map((record) => [record.fileId, record]));
  const normalizedRecords = expectedIds.map((fileId) => normalizeRecord({
    fileId,
    ...(byFileId[fileId] || {}),
  }));
  const scriptIdSet = new Set(packageScriptIds);
  const freshnessRequiredIdSet = new Set(freshnessRequiredFileIds);
  const missingScriptIds = requiredScriptIds.filter((scriptId) => !scriptIdSet.has(scriptId));
  const readmeMissingFileIds = expectedIds.filter((fileId) => !includesReport(readmeText, fileId));
  const blockers = [
    ...normalizedRecords
      .filter((record) => !record.jsonExists)
      .map((record) => blocker(
        'report_output_pairing_json_missing',
        record.fileId,
        `${record.fileId} is required in the latest JSON report index but is missing.`,
      )),
    ...normalizedRecords
      .filter((record) => !record.mdExists)
      .map((record) => blocker(
        'report_output_pairing_markdown_missing',
        record.fileId,
        `${record.fileId} must have a matching ${record.mdFileId} Markdown report.`,
        { mdFileId: record.mdFileId },
      )),
    ...normalizedRecords
      .filter((record) => !record.reportFilesJsonMatches)
      .map((record) => blocker(
        'report_output_pairing_report_files_json_mismatch',
        record.fileId,
        `${record.fileId} reportFiles.json must point at the same latest JSON basename.`,
        { reportFilesJson: record.reportFilesJson },
      )),
    ...normalizedRecords
      .filter((record) => !record.reportFilesMarkdownMatches)
      .map((record) => blocker(
        'report_output_pairing_report_files_markdown_mismatch',
        record.fileId,
        `${record.fileId} reportFiles.md must point at the matching Markdown basename when present.`,
        { reportFilesMd: record.reportFilesMd, mdFileId: record.mdFileId },
      )),
    ...readmeMissingFileIds.map((fileId) => blocker(
      'report_output_pairing_readme_missing_report',
      fileId,
      `reports/README.md must list ${fileId}.`,
    )),
    ...missingScriptIds.map((scriptId) => blocker(
      'report_output_pairing_required_script_missing',
      null,
      `package.json must expose ${scriptId}.`,
      { scriptId },
    )),
    ...(!freshnessRequiredIdSet.has(REPORT_OUTPUT_PAIRING_REPORT_FILE_ID) ? [blocker(
      'report_output_pairing_freshness_inventory_missing_self',
      REPORT_OUTPUT_PAIRING_REPORT_FILE_ID,
      `${REPORT_OUTPUT_PAIRING_REPORT_FILE_ID} must be present in REPORT_FRESHNESS_REQUIRED_REPORTS.`,
    )] : []),
  ];
  return {
    status: blockers.length ? 'blocked_report_output_pairing_analysis' : 'pass_report_output_pairing_analysis',
    ok: blockers.length === 0,
    expectedJsonReportCount: expectedIds.length,
    jsonReportCount: normalizedRecords.filter((record) => record.jsonExists).length,
    markdownReportCount: normalizedRecords.filter((record) => record.mdExists).length,
    readmeListedReportCount: expectedIds.length - readmeMissingFileIds.length,
    reportFilesJsonPointerCount: normalizedRecords.filter((record) => record.hasReportFilesJson).length,
    reportFilesMarkdownPointerCount: normalizedRecords.filter((record) => record.hasReportFilesMd).length,
    reportFilesJsonMismatchCount: normalizedRecords.filter((record) => !record.reportFilesJsonMatches).length,
    reportFilesMarkdownMismatchCount: normalizedRecords.filter((record) => !record.reportFilesMarkdownMatches).length,
    requiredScriptCount: requiredScriptIds.length,
    presentRequiredScriptCount: requiredScriptIds.length - missingScriptIds.length,
    freshnessSelfPresent: freshnessRequiredIdSet.has(REPORT_OUTPUT_PAIRING_REPORT_FILE_ID),
    expectedFileIds: expectedIds,
    records: normalizedRecords,
    blockers,
  };
}

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_markdown_pair',
    label: 'A latest JSON report loses its Markdown pair',
    expectedBlockerCode: 'report_output_pairing_markdown_missing',
    mutate(input) {
      input.records = input.records.map((record) => (record.fileId === 'package-surface-latest.json'
        ? { ...record, mdExists: false }
        : record));
    },
  }),
  Object.freeze({
    scenarioId: 'report_files_json_drift',
    label: 'A reportFiles.json pointer drifts from the JSON basename',
    expectedBlockerCode: 'report_output_pairing_report_files_json_mismatch',
    mutate(input) {
      input.records = input.records.map((record) => (record.fileId === 'contract-schemas-latest.json'
        ? {
          ...record,
          report: {
            ...(record.report || {}),
            reportFiles: {
              ...(record.report?.reportFiles || {}),
              json: 'reports/drifted-contract-schemas-latest.json',
              md: 'reports/contract-schemas-latest.md',
            },
          },
        }
        : record));
    },
  }),
  Object.freeze({
    scenarioId: 'report_files_markdown_drift',
    label: 'A reportFiles.md pointer drifts from the Markdown basename',
    expectedBlockerCode: 'report_output_pairing_report_files_markdown_mismatch',
    mutate(input) {
      input.records = input.records.map((record) => (record.fileId === 'contract-schemas-latest.json'
        ? {
          ...record,
          report: {
            ...(record.report || {}),
            reportFiles: {
              ...(record.report?.reportFiles || {}),
              json: 'reports/contract-schemas-latest.json',
              md: 'reports/drifted-contract-schemas-latest.md',
            },
          },
        }
        : record));
    },
  }),
  Object.freeze({
    scenarioId: 'readme_missing_latest_report',
    label: 'reports/README.md loses a latest report entry',
    expectedBlockerCode: 'report_output_pairing_readme_missing_report',
    mutate(input) {
      input.readmeText = input.readmeText.replaceAll('package-surface-latest.json', 'package-surface-omitted.json');
    },
  }),
  Object.freeze({
    scenarioId: 'required_script_missing',
    label: 'package.json loses the output pairing script',
    expectedBlockerCode: 'report_output_pairing_required_script_missing',
    mutate(input) {
      input.packageScriptIds = input.packageScriptIds.filter((scriptId) => scriptId !== REPORT_OUTPUT_PAIRING_SCRIPT_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'freshness_inventory_missing_self',
    label: 'REPORT_FRESHNESS_REQUIRED_REPORTS does not include this guard',
    expectedBlockerCode: 'report_output_pairing_freshness_inventory_missing_self',
    mutate(input) {
      input.freshnessRequiredFileIds = input.freshnessRequiredFileIds.filter((fileId) => fileId !== REPORT_OUTPUT_PAIRING_REPORT_FILE_ID);
    },
  }),
]);

function runScenario(baseInput, scenario) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeReportOutputPairingRecords(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const ok = observedBlockerCodes.includes(scenario.expectedBlockerCode);
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: ok ? 'pass_report_output_pairing_scenario' : 'blocked_report_output_pairing_scenario',
    ok,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    blockers: ok ? [] : [blocker(
      'report_output_pairing_expected_blocker_not_observed',
      null,
      `${scenario.scenarioId} did not observe ${scenario.expectedBlockerCode}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )],
  };
}

function compactActualAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    expectedJsonReportCount: analysis.expectedJsonReportCount,
    jsonReportCount: analysis.jsonReportCount,
    markdownReportCount: analysis.markdownReportCount,
    readmeListedReportCount: analysis.readmeListedReportCount,
    reportFilesJsonPointerCount: analysis.reportFilesJsonPointerCount,
    reportFilesMarkdownPointerCount: analysis.reportFilesMarkdownPointerCount,
    reportFilesJsonMismatchCount: analysis.reportFilesJsonMismatchCount,
    reportFilesMarkdownMismatchCount: analysis.reportFilesMarkdownMismatchCount,
    requiredScriptCount: analysis.requiredScriptCount,
    presentRequiredScriptCount: analysis.presentRequiredScriptCount,
    freshnessSelfPresent: analysis.freshnessSelfPresent,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      scriptId: item.scriptId || null,
    })),
  };
}

export function buildReportOutputPairingReport({
  expectedFileIds = [],
  records = [],
  readmeText = '',
  packageScriptIds = [],
  requiredScriptIds = [REPORT_OUTPUT_PAIRING_SCRIPT_ID],
  freshnessRequiredFileIds = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = {
    expectedFileIds: uniqueSorted(expectedFileIds),
    records,
    readmeText,
    packageScriptIds,
    requiredScriptIds,
    freshnessRequiredFileIds,
  };
  const actual = analyzeReportOutputPairingRecords(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(baseInput, scenario));
  const blockers = [
    ...actual.blockers.map((item) => ({ ...item, source: 'actual_reports' })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_OUTPUT_PAIRING_VERSION,
    kind: 'ReportOutputPairing',
    status: blockers.length ? 'blocked_report_output_pairing' : 'pass_report_output_pairing',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_OUTPUT_PAIRING_REPORT_FILE_ID,
    scriptId: REPORT_OUTPUT_PAIRING_SCRIPT_ID,
    expectedFileIds: baseInput.expectedFileIds,
    actual: compactActualAnalysis(actual),
    records: actual.records,
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      expectedJsonReportCount: actual.expectedJsonReportCount,
      jsonReportCount: actual.jsonReportCount,
      markdownReportCount: actual.markdownReportCount,
      readmeListedReportCount: actual.readmeListedReportCount,
      reportFilesJsonPointerCount: actual.reportFilesJsonPointerCount,
      reportFilesMarkdownPointerCount: actual.reportFilesMarkdownPointerCount,
      reportFilesJsonMismatchCount: actual.reportFilesJsonMismatchCount,
      reportFilesMarkdownMismatchCount: actual.reportFilesMarkdownMismatchCount,
      requiredScriptCount: actual.requiredScriptCount,
      presentRequiredScriptCount: actual.presentRequiredScriptCount,
      freshnessSelfPresent: actual.freshnessSelfPresent,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      observedExpectedBlockerCount: scenarios.filter((scenario) => scenario.ok).length,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      sourceInspectionOnly: true,
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
  const outputPairingHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    expectedFileIds: report.expectedFileIds,
    actual: report.actual,
    records: report.records,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    outputPairingHash,
    hash: outputPairingHash,
  };
}

export function summarizeReportOutputPairingReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_output_pairing',
    ok: report?.ok === true,
    outputPairingHash: report?.outputPairingHash || null,
    actualOk: report?.summary?.actualOk === true,
    expectedJsonReportCount: report?.summary?.expectedJsonReportCount || 0,
    jsonReportCount: report?.summary?.jsonReportCount || 0,
    markdownReportCount: report?.summary?.markdownReportCount || 0,
    readmeListedReportCount: report?.summary?.readmeListedReportCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      sourceInspectionOnly: true,
      executesExternalAction: false,
    },
  };
}
