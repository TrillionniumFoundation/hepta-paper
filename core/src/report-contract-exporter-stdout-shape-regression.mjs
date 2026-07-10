import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_REPORT_FILE_ID = 'report-contract-exporter-stdout-shape-regression-latest.json';
export const REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_SCRIPT_ID = 'reports:contract-exporter-stdout-shape-regression';
export const REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_STEP_ID = 'report_contract_exporter_stdout_shape_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_doc_coverage_regression';
const REPORT_FILES_JSON_SHAPES = Object.freeze([
  'json: relative(reportFiles.latestJson)',
  'json: relativeToWorkspace(reportFiles.latestJson)',
]);
const REPORT_FILES_MD_SHAPES = Object.freeze([
  'md: relative(reportFiles.latestMd)',
  'md: relativeToWorkspace(reportFiles.latestMd)',
]);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_exporter_stdout_shape',
    label: 'A new manifest contract is added without an inspected exporter source',
    expectedBlockerCode: 'report_contract_exporter_source_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_exporter_stdout_shape',
        exporterPath: 'src/export-report-future-exporter-stdout-shape.mjs',
        stdoutHashField: 'futureExporterStdoutShapeHash',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_ok_shape_drift',
    label: 'An exporter stdout summary stops forwarding report.ok',
    expectedBlockerCode: 'report_contract_exporter_stdout_ok_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.exporterSources[contract.exporterPath] = replaceToken(
        input.exporterSources[contract.exporterPath],
        'ok: report.ok',
        'ok: true',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_status_shape_drift',
    label: 'An exporter stdout summary stops forwarding report.status',
    expectedBlockerCode: 'report_contract_exporter_stdout_status_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.exporterSources[contract.exporterPath] = replaceToken(
        input.exporterSources[contract.exporterPath],
        'status: report.status',
        'status: "pass"',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_hash_shape_drift',
    label: 'An exporter stdout summary stops forwarding the manifest hash field',
    expectedBlockerCode: 'report_contract_exporter_stdout_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.exporterSources[contract.exporterPath] = replaceToken(
        input.exporterSources[contract.exporterPath],
        hashShape(contract),
        `${contract.stdoutHashField}: report.hash`,
      );
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_summary_shape_drift',
    label: 'An exporter stdout summary stops forwarding report.summary',
    expectedBlockerCode: 'report_contract_exporter_stdout_summary_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.exporterSources[contract.exporterPath] = replaceToken(
        input.exporterSources[contract.exporterPath],
        'summary: report.summary',
        'summary: {}',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_blockers_shape_drift',
    label: 'An exporter stdout summary stops forwarding blocker codes',
    expectedBlockerCode: 'report_contract_exporter_stdout_blockers_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.exporterSources[contract.exporterPath] = replaceToken(
        input.exporterSources[contract.exporterPath],
        blockersShape(),
        'blockers: report.blockers',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_report_files_shape_drift',
    label: 'An exporter stdout summary stops forwarding latest json/md pointers',
    expectedBlockerCode: 'report_contract_exporter_stdout_report_files_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.exporterSources[contract.exporterPath] = REPORT_FILES_JSON_SHAPES.reduce(
        (sourceText, token) => replaceToken(sourceText, token, 'json: reportFiles.latestJson'),
        input.exporterSources[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'strict_exit_shape_drift',
    label: 'An exporter stops failing --strict runs when the report is blocked',
    expectedBlockerCode: 'report_contract_exporter_strict_exit_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.exporterSources[contract.exporterPath] = replaceToken(
        input.exporterSources[contract.exporterPath],
        'if (strict && !report.ok) process.exitCode = 1;',
        'if (strict && false) process.exitCode = 1;',
      );
    },
  }),
]);

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceToken(sourceText, token, replacement) {
  return String(sourceText || '').split(token).join(replacement);
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    exporterPath: contract.exporterPath || null,
    stdoutHashField: contract.stdoutHashField || null,
  };
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function hashShape(contract = {}) {
  return `${contract.stdoutHashField}: report.${contract.stdoutHashField}`;
}

function blockersShape() {
  return 'blockers: report.blockers.map((item) => item.code)';
}

function stdoutJsonPresent(sourceText = '') {
  return String(sourceText || '').includes('process.stdout.write(`${JSON.stringify({');
}

function reportFilesShapePresent(sourceText = '') {
  const text = String(sourceText || '');
  return text.includes('reportFiles:')
    && REPORT_FILES_JSON_SHAPES.some((token) => text.includes(token))
    && REPORT_FILES_MD_SHAPES.some((token) => text.includes(token));
}

function strictFlagPresent(sourceText = '') {
  return String(sourceText || '').includes("const strict = process.argv.includes('--strict');");
}

function strictExitPresent(sourceText = '') {
  return String(sourceText || '').includes('if (strict && !report.ok) process.exitCode = 1;');
}

function sourceIncludes(sourceText = '', token = '') {
  return String(sourceText || '').includes(token);
}

function analyzeContract(contract = {}, input = {}) {
  const sourceText = input.exporterSources?.[contract.exporterPath] || '';
  const sourcePresent = Boolean(sourceText);
  const stdoutJson = stdoutJsonPresent(sourceText);
  const okPresent = sourceIncludes(sourceText, 'ok: report.ok');
  const statusPresent = sourceIncludes(sourceText, 'status: report.status');
  const hashPresent = sourceIncludes(sourceText, hashShape(contract));
  const summaryPresent = sourceIncludes(sourceText, 'summary: report.summary');
  const blockersPresent = sourceIncludes(sourceText, blockersShape());
  const reportFilesPresent = reportFilesShapePresent(sourceText);
  const strictFlag = strictFlagPresent(sourceText);
  const strictExit = strictExitPresent(sourceText);
  const blockers = [
    ...(sourcePresent ? [] : [blocker(
      'report_contract_exporter_source_missing',
      `${contract.exporterPath || 'unknown'} must be provided for stdout shape inspection.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && stdoutJson ? [] : [blocker(
      'report_contract_exporter_stdout_json_missing',
      `${contract.exporterPath || 'unknown'} must write a JSON stdout summary.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && okPresent ? [] : [blocker(
      'report_contract_exporter_stdout_ok_missing',
      `${contract.exporterPath || 'unknown'} stdout must expose ok: report.ok.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && statusPresent ? [] : [blocker(
      'report_contract_exporter_stdout_status_missing',
      `${contract.exporterPath || 'unknown'} stdout must expose status: report.status.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && hashPresent ? [] : [blocker(
      'report_contract_exporter_stdout_hash_missing',
      `${contract.exporterPath || 'unknown'} stdout must expose ${contract.stdoutHashField}: report.${contract.stdoutHashField}.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath, stdoutHashField: contract.stdoutHashField },
    )]),
    ...(sourcePresent && summaryPresent ? [] : [blocker(
      'report_contract_exporter_stdout_summary_missing',
      `${contract.exporterPath || 'unknown'} stdout must expose summary: report.summary.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && blockersPresent ? [] : [blocker(
      'report_contract_exporter_stdout_blockers_missing',
      `${contract.exporterPath || 'unknown'} stdout must expose blocker code arrays.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && reportFilesPresent ? [] : [blocker(
      'report_contract_exporter_stdout_report_files_missing',
      `${contract.exporterPath || 'unknown'} stdout must expose relative latest json/md reportFiles.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && strictFlag ? [] : [blocker(
      'report_contract_exporter_strict_flag_missing',
      `${contract.exporterPath || 'unknown'} must parse the --strict flag.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
    ...(sourcePresent && strictExit ? [] : [blocker(
      'report_contract_exporter_strict_exit_missing',
      `${contract.exporterPath || 'unknown'} must set process.exitCode when strict and report.ok is false.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )]),
  ];
  return {
    contractId: contract.contractId,
    exporterPath: contract.exporterPath,
    stdoutHashField: contract.stdoutHashField,
    status: blockers.length ? 'blocked_report_contract_exporter_stdout_shape_contract' : 'pass_report_contract_exporter_stdout_shape_contract',
    ok: blockers.length === 0,
    sourcePresent,
    stdoutJsonPresent: stdoutJson,
    okPresent,
    statusPresent,
    hashPresent,
    summaryPresent,
    blockersPresent,
    reportFilesPresent,
    strictFlagPresent: strictFlag,
    strictExitPresent: strictExit,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    exporterPath: contract.exporterPath,
    stdoutHashField: contract.stdoutHashField,
    sourcePresent: contract.sourcePresent === true,
    stdoutJsonPresent: contract.stdoutJsonPresent === true,
    okPresent: contract.okPresent === true,
    statusPresent: contract.statusPresent === true,
    hashPresent: contract.hashPresent === true,
    summaryPresent: contract.summaryPresent === true,
    blockersPresent: contract.blockersPresent === true,
    reportFilesPresent: contract.reportFilesPresent === true,
    strictFlagPresent: contract.strictFlagPresent === true,
    strictExitPresent: contract.strictExitPresent === true,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      exporterPath: item.exporterPath || null,
      stdoutHashField: item.stdoutHashField || null,
    })),
  };
}

function analyzeExporterStdoutShape(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_exporter_stdout_shape_analysis' : 'pass_report_contract_exporter_stdout_shape_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    sourceCount: contractAnalyses.filter((contract) => contract.sourcePresent).length,
    stdoutJsonCount: contractAnalyses.filter((contract) => contract.stdoutJsonPresent).length,
    stdoutOkCount: contractAnalyses.filter((contract) => contract.okPresent).length,
    stdoutStatusCount: contractAnalyses.filter((contract) => contract.statusPresent).length,
    stdoutHashCount: contractAnalyses.filter((contract) => contract.hashPresent).length,
    stdoutSummaryCount: contractAnalyses.filter((contract) => contract.summaryPresent).length,
    stdoutBlockersCount: contractAnalyses.filter((contract) => contract.blockersPresent).length,
    stdoutReportFilesCount: contractAnalyses.filter((contract) => contract.reportFilesPresent).length,
    strictFlagCount: contractAnalyses.filter((contract) => contract.strictFlagPresent).length,
    strictExitCount: contractAnalyses.filter((contract) => contract.strictExitPresent).length,
    contracts: contractAnalyses,
    blockers,
  };
}

function compactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    contractCount: analysis.contractCount || 0,
    okContractCount: analysis.okContractCount || 0,
    sourceCount: analysis.sourceCount || 0,
    stdoutJsonCount: analysis.stdoutJsonCount || 0,
    stdoutOkCount: analysis.stdoutOkCount || 0,
    stdoutStatusCount: analysis.stdoutStatusCount || 0,
    stdoutHashCount: analysis.stdoutHashCount || 0,
    stdoutSummaryCount: analysis.stdoutSummaryCount || 0,
    stdoutBlockersCount: analysis.stdoutBlockersCount || 0,
    stdoutReportFilesCount: analysis.stdoutReportFilesCount || 0,
    strictFlagCount: analysis.strictFlagCount || 0,
    strictExitCount: analysis.strictExitCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      exporterPath: item.exporterPath || null,
      stdoutHashField: item.stdoutHashField || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeExporterStdoutShape(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_exporter_stdout_shape_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract exporter stdout shape analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_exporter_stdout_shape_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_exporter_stdout_shape_scenario' : 'pass_report_contract_exporter_stdout_shape_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractExporterStdoutShapeRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  exporterSources = {},
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    exporterSources: { ...(exporterSources || {}) },
  };
}

export function buildReportContractExporterStdoutShapeRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  exporterSources = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractExporterStdoutShapeRegressionInput({
    manifest,
    exporterSources,
  });
  const actual = analyzeExporterStdoutShape(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_exporter_stdout_shape',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_VERSION,
    kind: 'ReportContractExporterStdoutShapeRegression',
    status: blockers.length ? 'blocked_report_contract_exporter_stdout_shape_regression' : 'pass_report_contract_exporter_stdout_shape_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
    },
    actual: {
      ...compactAnalysis(actual),
      contracts: actual.contracts.map(compactContract),
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      contractCount: actual.contractCount,
      okContractCount: actual.okContractCount,
      sourceCount: actual.sourceCount,
      stdoutJsonCount: actual.stdoutJsonCount,
      stdoutOkCount: actual.stdoutOkCount,
      stdoutStatusCount: actual.stdoutStatusCount,
      stdoutHashCount: actual.stdoutHashCount,
      stdoutSummaryCount: actual.stdoutSummaryCount,
      stdoutBlockersCount: actual.stdoutBlockersCount,
      stdoutReportFilesCount: actual.stdoutReportFilesCount,
      strictFlagCount: actual.strictFlagCount,
      strictExitCount: actual.strictExitCount,
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
  const contractExporterStdoutShapeRegressionHash = digest({
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
      blockerCodes: scenario.blockers.map((item) => item.code),
    })),
    summary: report.summary,
    blockers: report.blockers.map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      scenarioId: item.scenarioId || null,
      exporterPath: item.exporterPath || null,
      stdoutHashField: item.stdoutHashField || null,
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractExporterStdoutShapeRegressionHash,
    hash: contractExporterStdoutShapeRegressionHash,
  };
}

export function summarizeReportContractExporterStdoutShapeRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractExporterStdoutShapeRegressionHash: report.contractExporterStdoutShapeRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    stdoutOkCount: report.summary?.stdoutOkCount ?? null,
    stdoutStatusCount: report.summary?.stdoutStatusCount ?? null,
    stdoutHashCount: report.summary?.stdoutHashCount ?? null,
    stdoutSummaryCount: report.summary?.stdoutSummaryCount ?? null,
    stdoutBlockersCount: report.summary?.stdoutBlockersCount ?? null,
    stdoutReportFilesCount: report.summary?.stdoutReportFilesCount ?? null,
    strictExitCount: report.summary?.strictExitCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
