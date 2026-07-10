import { digest } from './hash-utils.mjs';
import {
  REPORT_FRESHNESS_REQUIRED_REPORTS,
} from './report-freshness.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  extractGateSummaryHashKeys,
} from './report-inventory-consistency.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_RUNNER_CONTRACT_REGRESSION_VERSION = 1;

export const REPORT_RUNNER_CONTRACT_REGRESSION_REPORT_FILE_ID = 'report-runner-contract-regression-latest.json';

export const REPORT_RUNNER_CONTRACT_REGRESSION_SCRIPT_ID = 'reports:runner-contract-regression';

export const REPORT_RUNNER_CONTRACTS = REPORT_CONTRACT_MANIFEST;

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
    scenarioId: 'missing_package_script',
    label: 'A report exporter package script is missing',
    expectedBlockerCode: 'report_runner_contract_package_script_missing',
    mutate(input) {
      delete input.packageScripts[REPORT_RUNNER_CONTRACT_REGRESSION_SCRIPT_ID];
    },
  }),
  Object.freeze({
    scenarioId: 'package_script_without_strict',
    label: 'A report exporter package script loses --strict',
    expectedBlockerCode: 'report_runner_contract_package_script_not_strict',
    mutate(input) {
      input.packageScripts[REPORT_RUNNER_CONTRACT_REGRESSION_SCRIPT_ID] = 'node src/export-report-runner-contract-regression.mjs';
    },
  }),
  Object.freeze({
    scenarioId: 'missing_gate_step',
    label: 'A report exporter gate step is missing',
    expectedBlockerCode: 'report_runner_contract_gate_step_missing',
    mutate(input) {
      input.gateSteps = input.gateSteps
        .filter((step) => step.stepId !== 'report_runner_contract_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'gate_step_without_parse_json',
    label: 'A report exporter gate step stops parsing JSON stdout',
    expectedBlockerCode: 'report_runner_contract_gate_step_parse_json_missing',
    mutate(input) {
      input.gateSteps = input.gateSteps.map((step) => (step.stepId === 'report_runner_contract_regression_export'
        ? { ...step, parseJsonOutput: false }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'gate_step_without_strict',
    label: 'A report exporter gate step loses --strict',
    expectedBlockerCode: 'report_runner_contract_gate_step_arg_missing',
    mutate(input) {
      input.gateSteps = input.gateSteps.map((step) => (step.stepId === 'report_runner_contract_regression_export'
        ? { ...step, args: step.args.filter((arg) => arg !== '--strict') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'missing_gate_summary_hash_key',
    label: 'The integration gate summary omits a report hash key',
    expectedBlockerCode: 'report_runner_contract_gate_summary_hash_key_missing',
    mutate(input) {
      input.gateSummaryHashKeys = input.gateSummaryHashKeys
        .filter((key) => key !== 'reportRunnerContractRegressionHash');
    },
  }),
  Object.freeze({
    scenarioId: 'missing_freshness_inventory',
    label: 'The freshness inventory omits a report runner output',
    expectedBlockerCode: 'report_runner_contract_freshness_inventory_missing',
    mutate(input) {
      input.freshnessReports = input.freshnessReports
        .filter((spec) => spec.fileId !== REPORT_RUNNER_CONTRACT_REGRESSION_REPORT_FILE_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_hash_field_missing',
    label: 'A report exporter stdout summary omits its hash field',
    expectedBlockerCode: 'report_runner_contract_stdout_hash_field_missing',
    mutate(input) {
      input.exporterSources['src/export-report-runner-contract-regression.mjs'] = input
        .exporterSources['src/export-report-runner-contract-regression.mjs']
        .replace('runnerContractRegressionHash:', 'runnerContractRegressionDigest:');
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_report_files_missing',
    label: 'A report exporter stdout summary omits reportFiles pointers',
    expectedBlockerCode: 'report_runner_contract_stdout_report_files_missing',
    mutate(input) {
      input.exporterSources['src/export-report-runner-contract-regression.mjs'] = input
        .exporterSources['src/export-report-runner-contract-regression.mjs']
        .replace('reportFiles:', 'latestFiles:');
    },
  }),
]);

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function arrayFromFrozen(values = []) {
  return [...values];
}

function stepById(steps = []) {
  return Object.fromEntries(steps.map((step) => [step.stepId, step]));
}

function freshnessByFileId(freshnessReports = []) {
  return Object.fromEntries(freshnessReports.map((spec) => [spec.fileId, spec]));
}

function expectedPackageCommand(contract) {
  return `node ${contract.exporterPath} --strict`;
}

function requiredGateArgs(contract) {
  return [
    contract.exporterPath,
    ...(contract.requiredGateArgs ? arrayFromFrozen(contract.requiredGateArgs) : ['--strict']),
  ];
}

function sourceHasStdoutHashField(sourceText = '', hashField) {
  return new RegExp(`\\b${hashField}\\s*:`).test(String(sourceText));
}

function sourceHasStdoutReportFiles(sourceText = '') {
  const text = String(sourceText);
  return text.includes('reportFiles:')
    && REPORT_FILES_JSON_SHAPES.some((token) => text.includes(token))
    && REPORT_FILES_MD_SHAPES.some((token) => text.includes(token));
}

function sourceWritesLatestReports(sourceText = '', fileId = '') {
  const text = String(sourceText);
  return text.includes('writeLatestReportPair({')
    && text.includes(`fileId: '${fileId}'`)
    && text.includes('markdown: markdownFor(');
}

export function buildReportRunnerContractInput({
  gateSourceText = '',
  packageScripts = {},
  exporterSources = {},
  freshnessReports = REPORT_FRESHNESS_REQUIRED_REPORTS,
} = {}) {
  return {
    contracts: REPORT_RUNNER_CONTRACTS.map((contract) => ({
      ...contract,
      stepIds: arrayFromFrozen(contract.stepIds),
      requiredGateArgs: requiredGateArgs(contract),
      requiresFreshnessInventory: contract.requiresFreshnessInventory !== false,
    })),
    gateSteps: extractIntegrationGateStepSpecs(gateSourceText),
    gateSummaryHashKeys: extractGateSummaryHashKeys(gateSourceText),
    packageScripts: { ...(packageScripts || {}) },
    freshnessReports: freshnessReports.map((spec) => ({
      key: spec.key,
      fileId: spec.fileId,
      gateSummaryHashKey: spec.gateSummaryHashKey || null,
    })),
    exporterSources: { ...(exporterSources || {}) },
  };
}

function analyzeContract(contract, input = {}) {
  const steps = stepById(input.gateSteps || []);
  const freshness = freshnessByFileId(input.freshnessReports || []);
  const gateSummaryHashKeys = new Set(input.gateSummaryHashKeys || []);
  const packageScript = input.packageScripts?.[contract.scriptId] || null;
  const exporterSource = input.exporterSources?.[contract.exporterPath] || '';
  const missingStepIds = contract.stepIds.filter((stepId) => !steps[stepId]);
  const missingParseJsonStepIds = contract.stepIds
    .filter((stepId) => steps[stepId] && steps[stepId].parseJsonOutput !== true);
  const missingGateArgs = contract.stepIds.flatMap((stepId) => {
    const step = steps[stepId];
    if (!step) return [];
    return contract.requiredGateArgs
      .filter((arg) => !step.args.includes(arg))
      .map((arg) => ({ stepId, arg }));
  });
  const freshnessSpec = freshness[contract.fileId] || null;
  const freshnessInventoryOk = contract.requiresFreshnessInventory === false
    || (freshnessSpec && freshnessSpec.gateSummaryHashKey === contract.gateSummaryHashKey);
  const blockers = [
    ...(!packageScript ? [blocker(
      'report_runner_contract_package_script_missing',
      `${contract.scriptId} must be present in package.json scripts.`,
      { contractId: contract.contractId, scriptId: contract.scriptId },
    )] : []),
    ...(packageScript && packageScript !== expectedPackageCommand(contract) ? [blocker(
      'report_runner_contract_package_script_not_strict',
      `${contract.scriptId} must run ${expectedPackageCommand(contract)}.`,
      { contractId: contract.contractId, scriptId: contract.scriptId },
    )] : []),
    ...missingStepIds.map((stepId) => blocker(
      'report_runner_contract_gate_step_missing',
      `${stepId} must run inside integration-dependency-gate.mjs.`,
      { contractId: contract.contractId, stepId },
    )),
    ...missingParseJsonStepIds.map((stepId) => blocker(
      'report_runner_contract_gate_step_parse_json_missing',
      `${stepId} must set parseJsonOutput: true so the gate can inspect ok/hash/reportFiles.`,
      { contractId: contract.contractId, stepId },
    )),
    ...missingGateArgs.map(({ stepId, arg }) => blocker(
      'report_runner_contract_gate_step_arg_missing',
      `${stepId} must include ${arg}.`,
      { contractId: contract.contractId, stepId, arg },
    )),
    ...(contract.gateSummaryHashKey && !gateSummaryHashKeys.has(contract.gateSummaryHashKey) ? [blocker(
      'report_runner_contract_gate_summary_hash_key_missing',
      `${contract.gateSummaryHashKey} must be exposed by integration gate summary.`,
      { contractId: contract.contractId, gateSummaryHashKey: contract.gateSummaryHashKey },
    )] : []),
    ...(!freshnessInventoryOk ? [blocker(
      'report_runner_contract_freshness_inventory_missing',
      `${contract.fileId} must be present in REPORT_FRESHNESS_REQUIRED_REPORTS with ${contract.gateSummaryHashKey}.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )] : []),
    ...(!sourceHasStdoutHashField(exporterSource, contract.stdoutHashField) ? [blocker(
      'report_runner_contract_stdout_hash_field_missing',
      `${contract.exporterPath} stdout summary must expose ${contract.stdoutHashField}.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )] : []),
    ...(!sourceHasStdoutReportFiles(exporterSource) ? [blocker(
      'report_runner_contract_stdout_report_files_missing',
      `${contract.exporterPath} stdout summary must expose reportFiles json/md pointers.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )] : []),
    ...(!sourceWritesLatestReports(exporterSource, contract.fileId) ? [blocker(
      'report_runner_contract_latest_write_missing',
      `${contract.exporterPath} must write latest JSON and Markdown reports.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )] : []),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    status: blockers.length ? 'blocked_report_runner_contract' : 'pass_report_runner_contract',
    ok: blockers.length === 0,
    scriptId: contract.scriptId,
    exporterPath: contract.exporterPath,
    stepIds: contract.stepIds,
    fileId: contract.fileId,
    stdoutHashField: contract.stdoutHashField,
    gateSummaryHashKey: contract.gateSummaryHashKey,
    packageScriptPresent: Boolean(packageScript),
    packageScriptStrict: packageScript === expectedPackageCommand(contract),
    gateStepCount: contract.stepIds.length,
    presentGateStepCount: contract.stepIds.length - missingStepIds.length,
    parseJsonGateStepCount: contract.stepIds.length - missingParseJsonStepIds.length,
    gateArgBindingCount: contract.stepIds.length * contract.requiredGateArgs.length - missingGateArgs.length,
    requiredGateArgBindingCount: contract.stepIds.length * contract.requiredGateArgs.length,
    gateSummaryHashKeyPresent: gateSummaryHashKeys.has(contract.gateSummaryHashKey),
    freshnessInventoryPresent: contract.requiresFreshnessInventory === false || Boolean(freshnessSpec),
    freshnessInventoryHashKeyMatches: freshnessInventoryOk,
    stdoutHashFieldPresent: sourceHasStdoutHashField(exporterSource, contract.stdoutHashField),
    stdoutReportFilesPresent: sourceHasStdoutReportFiles(exporterSource),
    writesLatestReports: sourceWritesLatestReports(exporterSource, contract.fileId),
    blockers,
  };
}

export function analyzeReportRunnerContracts(input = {}) {
  const contracts = input.contracts || [];
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_runner_contract_analysis' : 'pass_report_runner_contract_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    packageScriptCount: contractAnalyses.filter((contract) => contract.packageScriptPresent).length,
    strictPackageScriptCount: contractAnalyses.filter((contract) => contract.packageScriptStrict).length,
    gateStepBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.presentGateStepCount, 0),
    expectedGateStepBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.gateStepCount, 0),
    parseJsonGateStepCount: contractAnalyses.reduce((sum, contract) => sum + contract.parseJsonGateStepCount, 0),
    gateArgBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.gateArgBindingCount, 0),
    requiredGateArgBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.requiredGateArgBindingCount, 0),
    gateSummaryHashKeyCount: uniqueSorted(contractAnalyses.map((contract) => contract.gateSummaryHashKey).filter(Boolean)).length,
    presentGateSummaryHashKeyCount: contractAnalyses.filter((contract) => contract.gateSummaryHashKeyPresent).length,
    freshnessInventoryCount: contractAnalyses.filter((contract) => contract.freshnessInventoryPresent).length,
    stdoutHashFieldCount: contractAnalyses.filter((contract) => contract.stdoutHashFieldPresent).length,
    stdoutReportFilesCount: contractAnalyses.filter((contract) => contract.stdoutReportFilesPresent).length,
    latestWriteCount: contractAnalyses.filter((contract) => contract.writesLatestReports).length,
    contracts: contractAnalyses,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    scriptId: contract.scriptId,
    exporterPath: contract.exporterPath,
    stepIds: contract.stepIds,
    fileId: contract.fileId,
    stdoutHashField: contract.stdoutHashField,
    gateSummaryHashKey: contract.gateSummaryHashKey,
    packageScriptStrict: contract.packageScriptStrict === true,
    presentGateStepCount: contract.presentGateStepCount || 0,
    parseJsonGateStepCount: contract.parseJsonGateStepCount || 0,
    gateArgBindingCount: contract.gateArgBindingCount || 0,
    gateSummaryHashKeyPresent: contract.gateSummaryHashKeyPresent === true,
    freshnessInventoryHashKeyMatches: contract.freshnessInventoryHashKeyMatches === true,
    stdoutHashFieldPresent: contract.stdoutHashFieldPresent === true,
    stdoutReportFilesPresent: contract.stdoutReportFilesPresent === true,
    writesLatestReports: contract.writesLatestReports === true,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      scriptId: item.scriptId || null,
      stepId: item.stepId || null,
      fileId: item.fileId || null,
      gateSummaryHashKey: item.gateSummaryHashKey || null,
      exporterPath: item.exporterPath || null,
    })),
  };
}

function compactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    contractCount: analysis.contractCount || 0,
    okContractCount: analysis.okContractCount || 0,
    packageScriptCount: analysis.packageScriptCount || 0,
    strictPackageScriptCount: analysis.strictPackageScriptCount || 0,
    gateStepBindingCount: analysis.gateStepBindingCount || 0,
    expectedGateStepBindingCount: analysis.expectedGateStepBindingCount || 0,
    parseJsonGateStepCount: analysis.parseJsonGateStepCount || 0,
    gateArgBindingCount: analysis.gateArgBindingCount || 0,
    requiredGateArgBindingCount: analysis.requiredGateArgBindingCount || 0,
    gateSummaryHashKeyCount: analysis.gateSummaryHashKeyCount || 0,
    presentGateSummaryHashKeyCount: analysis.presentGateSummaryHashKeyCount || 0,
    freshnessInventoryCount: analysis.freshnessInventoryCount || 0,
    stdoutHashFieldCount: analysis.stdoutHashFieldCount || 0,
    stdoutReportFilesCount: analysis.stdoutReportFilesCount || 0,
    latestWriteCount: analysis.latestWriteCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      scriptId: item.scriptId || null,
      stepId: item.stepId || null,
      fileId: item.fileId || null,
      gateSummaryHashKey: item.gateSummaryHashKey || null,
      exporterPath: item.exporterPath || null,
      arg: item.arg || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeReportRunnerContracts(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_runner_contract_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report runner contract analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_runner_contract_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_runner_contract_scenario' : 'pass_report_runner_contract_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportRunnerContractRegressionReport({
  gateSourceText = '',
  packageScripts = {},
  exporterSources = {},
  freshnessReports = REPORT_FRESHNESS_REQUIRED_REPORTS,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportRunnerContractInput({
    gateSourceText,
    packageScripts,
    exporterSources,
    freshnessReports,
  });
  const actual = analyzeReportRunnerContracts(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_contract',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_RUNNER_CONTRACT_REGRESSION_VERSION,
    kind: 'ReportRunnerContractRegression',
    status: blockers.length ? 'blocked_report_runner_contract_regression' : 'pass_report_runner_contract_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_RUNNER_CONTRACT_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_RUNNER_CONTRACT_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.contracts.map((contract) => contract.contractId),
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
      packageScriptCount: actual.packageScriptCount,
      strictPackageScriptCount: actual.strictPackageScriptCount,
      gateStepBindingCount: actual.gateStepBindingCount,
      expectedGateStepBindingCount: actual.expectedGateStepBindingCount,
      parseJsonGateStepCount: actual.parseJsonGateStepCount,
      gateArgBindingCount: actual.gateArgBindingCount,
      requiredGateArgBindingCount: actual.requiredGateArgBindingCount,
      gateSummaryHashKeyCount: actual.gateSummaryHashKeyCount,
      presentGateSummaryHashKeyCount: actual.presentGateSummaryHashKeyCount,
      freshnessInventoryCount: actual.freshnessInventoryCount,
      stdoutHashFieldCount: actual.stdoutHashFieldCount,
      stdoutReportFilesCount: actual.stdoutReportFilesCount,
      latestWriteCount: actual.latestWriteCount,
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
  const runnerContractRegressionHash = digest({
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
    runnerContractRegressionHash,
    hash: runnerContractRegressionHash,
  };
}

export function summarizeReportRunnerContractRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_runner_contract_regression',
    ok: report?.ok === true,
    runnerContractRegressionHash: report?.runnerContractRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    okContractCount: report?.summary?.okContractCount || 0,
    gateStepBindingCount: report?.summary?.gateStepBindingCount || 0,
    expectedGateStepBindingCount: report?.summary?.expectedGateStepBindingCount || 0,
    parseJsonGateStepCount: report?.summary?.parseJsonGateStepCount || 0,
    stdoutHashFieldCount: report?.summary?.stdoutHashFieldCount || 0,
    stdoutReportFilesCount: report?.summary?.stdoutReportFilesCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      sourceInspectionOnly: report?.safety?.sourceInspectionOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
