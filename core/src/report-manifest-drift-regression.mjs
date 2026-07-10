import { digest } from './hash-utils.mjs';
import {
  INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS,
} from './integration-gate-tooling.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_FRESHNESS_REQUIRED_REPORTS,
} from './report-freshness.mjs';
import {
  extractCheckpointReportBindings,
  extractGateSummaryHashKeys,
} from './report-inventory-consistency.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_MANIFEST_DRIFT_REGRESSION_VERSION = 1;

export const REPORT_MANIFEST_DRIFT_REGRESSION_REPORT_FILE_ID = 'report-manifest-drift-regression-latest.json';

export const REPORT_MANIFEST_DRIFT_REGRESSION_SCRIPT_ID = 'reports:manifest-drift-regression';

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
    scenarioId: 'new_manifest_contract_not_wired',
    label: 'A new manifest contract is added without package/gate/freshness/tooling/checkpoint wiring',
    expectedBlockerCode: 'report_manifest_drift_package_script_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'synthetic_unwired_report_contract',
        label: 'Synthetic unwired report contract',
        scriptId: 'reports:synthetic-unwired',
        exporterPath: 'src/export-synthetic-unwired.mjs',
        stepIds: ['synthetic_unwired_export'],
        fileId: 'synthetic-unwired-latest.json',
        stdoutHashField: 'syntheticUnwiredHash',
        gateSummaryHashKey: 'syntheticUnwiredHash',
        requiredGateArgs: ['--strict'],
        requiresFreshnessInventory: true,
      });
    },
  }),
  Object.freeze({
    scenarioId: 'manifest_script_id_drift',
    label: 'A manifest script id changes without package/tooling updates',
    expectedBlockerCode: 'report_manifest_drift_package_script_missing',
    mutate(input) {
      input.manifest = input.manifest.map((contract) => (contract.contractId === 'report_runner_contract_regression'
        ? { ...contract, scriptId: 'reports:runner-contract-regression-drifted' }
        : contract));
    },
  }),
  Object.freeze({
    scenarioId: 'manifest_file_id_drift',
    label: 'A manifest report file id changes without freshness/tooling/checkpoint updates',
    expectedBlockerCode: 'report_manifest_drift_freshness_inventory_missing',
    mutate(input) {
      input.manifest = input.manifest.map((contract) => (contract.contractId === 'report_runner_contract_regression'
        ? { ...contract, fileId: 'report-runner-contract-regression-drifted-latest.json' }
        : contract));
    },
  }),
  Object.freeze({
    scenarioId: 'manifest_gate_summary_hash_key_drift',
    label: 'A manifest gate summary hash key changes without gate/freshness updates',
    expectedBlockerCode: 'report_manifest_drift_gate_summary_hash_key_missing',
    mutate(input) {
      input.manifest = input.manifest.map((contract) => (contract.contractId === 'report_runner_contract_regression'
        ? { ...contract, gateSummaryHashKey: 'reportRunnerContractRegressionDriftedHash' }
        : contract));
    },
  }),
  Object.freeze({
    scenarioId: 'manifest_step_id_drift',
    label: 'A manifest gate step id changes without integration gate updates',
    expectedBlockerCode: 'report_manifest_drift_gate_step_missing',
    mutate(input) {
      input.manifest = input.manifest.map((contract) => (contract.contractId === 'report_runner_contract_regression'
        ? { ...contract, stepIds: ['report_runner_contract_regression_drifted_export'] }
        : contract));
    },
  }),
  Object.freeze({
    scenarioId: 'manifest_exporter_path_drift',
    label: 'A manifest exporter path changes without package/gate/source updates',
    expectedBlockerCode: 'report_manifest_drift_exporter_source_missing',
    mutate(input) {
      input.manifest = input.manifest.map((contract) => (contract.contractId === 'report_runner_contract_regression'
        ? { ...contract, exporterPath: 'src/export-report-runner-contract-regression-drifted.mjs' }
        : contract));
    },
  }),
  Object.freeze({
    scenarioId: 'manifest_stdout_hash_field_drift',
    label: 'A manifest stdout hash field changes without exporter updates',
    expectedBlockerCode: 'report_manifest_drift_stdout_hash_field_missing',
    mutate(input) {
      input.manifest = input.manifest.map((contract) => (contract.contractId === 'report_runner_contract_regression'
        ? { ...contract, stdoutHashField: 'runnerContractRegressionDriftedHash' }
        : contract));
    },
  }),
  Object.freeze({
    scenarioId: 'tooling_drops_manifest_report',
    label: 'Integration tooling stops tracking a manifest report file',
    expectedBlockerCode: 'report_manifest_drift_tooling_report_missing',
    mutate(input) {
      input.toolingReportFileIds = input.toolingReportFileIds
        .filter((fileId) => fileId !== 'report-runner-contract-regression-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_drops_manifest_report',
    label: 'Architecture checkpoint stops binding a manifest report file',
    expectedBlockerCode: 'report_manifest_drift_checkpoint_binding_missing',
    mutate(input) {
      input.checkpointBindings = input.checkpointBindings
        .filter((binding) => binding.filename !== 'report-runner-contract-regression-latest.json');
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

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    label: contract.label || null,
    scriptId: contract.scriptId || null,
    exporterPath: contract.exporterPath || null,
    stepIds: Array.isArray(contract.stepIds) ? [...contract.stepIds] : [],
    fileId: contract.fileId || null,
    stdoutHashField: contract.stdoutHashField || null,
    gateSummaryHashKey: contract.gateSummaryHashKey || null,
    requiredGateArgs: contract.requiredGateArgs ? [...contract.requiredGateArgs] : ['--strict'],
    requiresFreshnessInventory: contract.requiresFreshnessInventory !== false,
  };
}

function stepById(steps = []) {
  return Object.fromEntries(steps.map((step) => [step.stepId, step]));
}

function byFileId(specs = []) {
  return Object.fromEntries(specs.map((spec) => [spec.fileId, spec]));
}

function checkpointByFilename(bindings = []) {
  return Object.fromEntries(bindings.map((binding) => [binding.filename, binding]));
}

function expectedPackageCommand(contract) {
  return `node ${contract.exporterPath} --strict`;
}

function requiredGateArgs(contract) {
  return [
    contract.exporterPath,
    ...(contract.requiredGateArgs || ['--strict']),
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

function analyzeContract(contract, input = {}) {
  const packageScript = input.packageScripts?.[contract.scriptId] || null;
  const gateSteps = stepById(input.gateSteps || []);
  const freshness = byFileId(input.freshnessReports || []);
  const checkpoint = checkpointByFilename(input.checkpointBindings || []);
  const gateSummaryHashKeys = new Set(input.gateSummaryHashKeys || []);
  const toolingReportFileIds = new Set(input.toolingReportFileIds || []);
  const requiredScriptIds = new Set(input.requiredScriptIds || []);
  const exporterSource = input.exporterSources?.[contract.exporterPath] || '';
  const missingGateSteps = contract.stepIds.filter((stepId) => !gateSteps[stepId]);
  const nonJsonGateSteps = contract.stepIds
    .filter((stepId) => gateSteps[stepId] && gateSteps[stepId].parseJsonOutput !== true);
  const missingGateArgs = contract.stepIds.flatMap((stepId) => {
    const step = gateSteps[stepId];
    if (!step) return [];
    return requiredGateArgs(contract)
      .filter((arg) => !step.args.includes(arg))
      .map((arg) => ({ stepId, arg }));
  });
  const freshnessSpec = freshness[contract.fileId] || null;
  const checkpointBinding = checkpoint[contract.fileId] || null;
  const freshnessOk = contract.requiresFreshnessInventory === false
    || (freshnessSpec && freshnessSpec.gateSummaryHashKey === contract.gateSummaryHashKey);
  const blockers = [
    ...(!packageScript ? [blocker(
      'report_manifest_drift_package_script_missing',
      `${contract.scriptId} must exist as a package script for ${contract.contractId}.`,
      { contractId: contract.contractId, scriptId: contract.scriptId },
    )] : []),
    ...(packageScript && packageScript !== expectedPackageCommand(contract) ? [blocker(
      'report_manifest_drift_package_script_command_mismatch',
      `${contract.scriptId} must run ${expectedPackageCommand(contract)}.`,
      { contractId: contract.contractId, scriptId: contract.scriptId },
    )] : []),
    ...(!requiredScriptIds.has(contract.scriptId) ? [blocker(
      'report_manifest_drift_tooling_script_missing',
      `${contract.scriptId} must be required by integration gate tooling.`,
      { contractId: contract.contractId, scriptId: contract.scriptId },
    )] : []),
    ...(!toolingReportFileIds.has(contract.fileId) ? [blocker(
      'report_manifest_drift_tooling_report_missing',
      `${contract.fileId} must be tracked by integration gate tooling reports.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )] : []),
    ...(!freshnessOk ? [blocker(
      'report_manifest_drift_freshness_inventory_missing',
      `${contract.fileId} must be present in freshness inventory with ${contract.gateSummaryHashKey}.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )] : []),
    ...(!checkpointBinding ? [blocker(
      'report_manifest_drift_checkpoint_binding_missing',
      `${contract.fileId} must be bound by architecture checkpoint.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )] : []),
    ...(!gateSummaryHashKeys.has(contract.gateSummaryHashKey) ? [blocker(
      'report_manifest_drift_gate_summary_hash_key_missing',
      `${contract.gateSummaryHashKey} must be exposed by integration gate summary.`,
      { contractId: contract.contractId, gateSummaryHashKey: contract.gateSummaryHashKey },
    )] : []),
    ...missingGateSteps.map((stepId) => blocker(
      'report_manifest_drift_gate_step_missing',
      `${stepId} must be present in integration gate.`,
      { contractId: contract.contractId, stepId },
    )),
    ...nonJsonGateSteps.map((stepId) => blocker(
      'report_manifest_drift_gate_step_parse_json_missing',
      `${stepId} must parse JSON output.`,
      { contractId: contract.contractId, stepId },
    )),
    ...missingGateArgs.map(({ stepId, arg }) => blocker(
      'report_manifest_drift_gate_step_arg_missing',
      `${stepId} must include ${arg}.`,
      { contractId: contract.contractId, stepId, arg },
    )),
    ...(!exporterSource ? [blocker(
      'report_manifest_drift_exporter_source_missing',
      `${contract.exporterPath} must be readable by the drift regression.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )] : []),
    ...(exporterSource && !sourceHasStdoutHashField(exporterSource, contract.stdoutHashField) ? [blocker(
      'report_manifest_drift_stdout_hash_field_missing',
      `${contract.exporterPath} must expose ${contract.stdoutHashField} in stdout.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )] : []),
    ...(exporterSource && !sourceHasStdoutReportFiles(exporterSource) ? [blocker(
      'report_manifest_drift_stdout_report_files_missing',
      `${contract.exporterPath} must expose reportFiles JSON/Markdown pointers.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )] : []),
    ...(exporterSource && !sourceWritesLatestReports(exporterSource, contract.fileId) ? [blocker(
      'report_manifest_drift_latest_write_missing',
      `${contract.exporterPath} must write latest JSON and Markdown reports.`,
      { contractId: contract.contractId, exporterPath: contract.exporterPath },
    )] : []),
  ];
  return {
    contractId: contract.contractId,
    status: blockers.length ? 'blocked_report_manifest_drift_contract' : 'pass_report_manifest_drift_contract',
    ok: blockers.length === 0,
    scriptId: contract.scriptId,
    exporterPath: contract.exporterPath,
    stepIds: contract.stepIds,
    fileId: contract.fileId,
    stdoutHashField: contract.stdoutHashField,
    gateSummaryHashKey: contract.gateSummaryHashKey,
    packageScriptMatchesManifest: packageScript === expectedPackageCommand(contract),
    toolingScriptPresent: requiredScriptIds.has(contract.scriptId),
    toolingReportPresent: toolingReportFileIds.has(contract.fileId),
    freshnessInventoryMatchesManifest: freshnessOk,
    checkpointBindingPresent: Boolean(checkpointBinding),
    gateSummaryHashKeyPresent: gateSummaryHashKeys.has(contract.gateSummaryHashKey),
    presentGateStepCount: contract.stepIds.length - missingGateSteps.length,
    expectedGateStepCount: contract.stepIds.length,
    parseJsonGateStepCount: contract.stepIds.length - nonJsonGateSteps.length,
    requiredGateArgBindingCount: contract.stepIds.length * requiredGateArgs(contract).length,
    gateArgBindingCount: contract.stepIds.length * requiredGateArgs(contract).length - missingGateArgs.length,
    exporterSourcePresent: Boolean(exporterSource),
    stdoutHashFieldPresent: Boolean(exporterSource) && sourceHasStdoutHashField(exporterSource, contract.stdoutHashField),
    stdoutReportFilesPresent: Boolean(exporterSource) && sourceHasStdoutReportFiles(exporterSource),
    writesLatestReports: Boolean(exporterSource) && sourceWritesLatestReports(exporterSource, contract.fileId),
    blockers,
  };
}

export function buildReportManifestDriftInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  gateSourceText = '',
  checkpointSourceText = '',
  packageScripts = {},
  exporterSources = {},
  freshnessReports = REPORT_FRESHNESS_REQUIRED_REPORTS,
  toolingReportFileIds = INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  requiredScriptIds = INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS,
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    gateSteps: extractIntegrationGateStepSpecs(gateSourceText),
    gateSummaryHashKeys: extractGateSummaryHashKeys(gateSourceText),
    checkpointBindings: extractCheckpointReportBindings(checkpointSourceText),
    packageScripts: { ...(packageScripts || {}) },
    exporterSources: { ...(exporterSources || {}) },
    freshnessReports: freshnessReports.map((spec) => ({
      key: spec.key,
      fileId: spec.fileId,
      gateSummaryHashKey: spec.gateSummaryHashKey || null,
    })),
    toolingReportFileIds: [...toolingReportFileIds],
    requiredScriptIds: [...requiredScriptIds],
  };
}

export function analyzeReportManifestDrift(input = {}) {
  const contracts = input.manifest || [];
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_manifest_drift_analysis' : 'pass_report_manifest_drift_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    packageScriptCount: contractAnalyses.filter((contract) => contract.packageScriptMatchesManifest).length,
    toolingScriptCount: contractAnalyses.filter((contract) => contract.toolingScriptPresent).length,
    toolingReportCount: contractAnalyses.filter((contract) => contract.toolingReportPresent).length,
    freshnessInventoryCount: contractAnalyses.filter((contract) => contract.freshnessInventoryMatchesManifest).length,
    checkpointBindingCount: contractAnalyses.filter((contract) => contract.checkpointBindingPresent).length,
    gateSummaryHashKeyCount: contractAnalyses.filter((contract) => contract.gateSummaryHashKeyPresent).length,
    gateStepBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.presentGateStepCount, 0),
    expectedGateStepBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.expectedGateStepCount, 0),
    parseJsonGateStepCount: contractAnalyses.reduce((sum, contract) => sum + contract.parseJsonGateStepCount, 0),
    gateArgBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.gateArgBindingCount, 0),
    requiredGateArgBindingCount: contractAnalyses.reduce((sum, contract) => sum + contract.requiredGateArgBindingCount, 0),
    exporterSourceCount: contractAnalyses.filter((contract) => contract.exporterSourcePresent).length,
    stdoutHashFieldCount: contractAnalyses.filter((contract) => contract.stdoutHashFieldPresent).length,
    stdoutReportFilesCount: contractAnalyses.filter((contract) => contract.stdoutReportFilesPresent).length,
    latestWriteCount: contractAnalyses.filter((contract) => contract.writesLatestReports).length,
    contractIds: uniqueSorted(contracts.map((contract) => contract.contractId)),
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
    packageScriptMatchesManifest: contract.packageScriptMatchesManifest === true,
    toolingScriptPresent: contract.toolingScriptPresent === true,
    toolingReportPresent: contract.toolingReportPresent === true,
    freshnessInventoryMatchesManifest: contract.freshnessInventoryMatchesManifest === true,
    checkpointBindingPresent: contract.checkpointBindingPresent === true,
    gateSummaryHashKeyPresent: contract.gateSummaryHashKeyPresent === true,
    presentGateStepCount: contract.presentGateStepCount || 0,
    parseJsonGateStepCount: contract.parseJsonGateStepCount || 0,
    gateArgBindingCount: contract.gateArgBindingCount || 0,
    exporterSourcePresent: contract.exporterSourcePresent === true,
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
      arg: item.arg || null,
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
    toolingScriptCount: analysis.toolingScriptCount || 0,
    toolingReportCount: analysis.toolingReportCount || 0,
    freshnessInventoryCount: analysis.freshnessInventoryCount || 0,
    checkpointBindingCount: analysis.checkpointBindingCount || 0,
    gateSummaryHashKeyCount: analysis.gateSummaryHashKeyCount || 0,
    gateStepBindingCount: analysis.gateStepBindingCount || 0,
    expectedGateStepBindingCount: analysis.expectedGateStepBindingCount || 0,
    parseJsonGateStepCount: analysis.parseJsonGateStepCount || 0,
    gateArgBindingCount: analysis.gateArgBindingCount || 0,
    requiredGateArgBindingCount: analysis.requiredGateArgBindingCount || 0,
    exporterSourceCount: analysis.exporterSourceCount || 0,
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
  const analysis = analyzeReportManifestDrift(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_manifest_drift_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report manifest drift analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_manifest_drift_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_manifest_drift_scenario' : 'pass_report_manifest_drift_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportManifestDriftRegressionReport({
  gateSourceText = '',
  checkpointSourceText = '',
  packageScripts = {},
  exporterSources = {},
  freshnessReports = REPORT_FRESHNESS_REQUIRED_REPORTS,
  toolingReportFileIds = INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  requiredScriptIds = INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS,
  manifest = REPORT_CONTRACT_MANIFEST,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportManifestDriftInput({
    manifest,
    gateSourceText,
    checkpointSourceText,
    packageScripts,
    exporterSources,
    freshnessReports,
    toolingReportFileIds,
    requiredScriptIds,
  });
  const actual = analyzeReportManifestDrift(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_manifest_drift',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_MANIFEST_DRIFT_REGRESSION_VERSION,
    kind: 'ReportManifestDriftRegression',
    status: blockers.length ? 'blocked_report_manifest_drift_regression' : 'pass_report_manifest_drift_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_MANIFEST_DRIFT_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_MANIFEST_DRIFT_REGRESSION_SCRIPT_ID,
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
      packageScriptCount: actual.packageScriptCount,
      toolingScriptCount: actual.toolingScriptCount,
      toolingReportCount: actual.toolingReportCount,
      freshnessInventoryCount: actual.freshnessInventoryCount,
      checkpointBindingCount: actual.checkpointBindingCount,
      gateSummaryHashKeyCount: actual.gateSummaryHashKeyCount,
      gateStepBindingCount: actual.gateStepBindingCount,
      expectedGateStepBindingCount: actual.expectedGateStepBindingCount,
      parseJsonGateStepCount: actual.parseJsonGateStepCount,
      gateArgBindingCount: actual.gateArgBindingCount,
      requiredGateArgBindingCount: actual.requiredGateArgBindingCount,
      exporterSourceCount: actual.exporterSourceCount,
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
  const manifestDriftRegressionHash = digest({
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
    manifestDriftRegressionHash,
    hash: manifestDriftRegressionHash,
  };
}

export function summarizeReportManifestDriftRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_manifest_drift_regression',
    ok: report?.ok === true,
    manifestDriftRegressionHash: report?.manifestDriftRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    okContractCount: report?.summary?.okContractCount || 0,
    gateStepBindingCount: report?.summary?.gateStepBindingCount || 0,
    expectedGateStepBindingCount: report?.summary?.expectedGateStepBindingCount || 0,
    freshnessInventoryCount: report?.summary?.freshnessInventoryCount || 0,
    toolingReportCount: report?.summary?.toolingReportCount || 0,
    checkpointBindingCount: report?.summary?.checkpointBindingCount || 0,
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
