import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  reportHashKeysForFileId,
} from './export-report-freshness.mjs';

export const REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_REPORT_FILE_ID = 'report-contract-checkpoint-binding-shape-regression-latest.json';
export const REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_SCRIPT_ID = 'reports:contract-checkpoint-binding-shape-regression';
export const REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_STEP_ID = 'report_contract_checkpoint_binding_shape_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_doc_coverage_regression';
const CHECKPOINT_HASH_HELPER_CALL = 'reportHashForFileId(report, filename)';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_checkpoint_binding',
    label: 'A new manifest contract is added without a checkpoint report binding',
    expectedBlockerCode: 'report_contract_checkpoint_binding_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_checkpoint_binding',
        label: 'Report future checkpoint binding',
        scriptId: 'reports:future-checkpoint-binding',
        exporterPath: 'src/export-report-future-checkpoint-binding.mjs',
        stepIds: ['report_future_checkpoint_binding_export'],
        fileId: 'report-future-checkpoint-binding-latest.json',
        stdoutHashField: 'futureCheckpointBindingHash',
        gateSummaryHashKey: 'reportFutureCheckpointBindingHash',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_binding_missing',
    label: 'A manifest contract loses its checkpoint report binding',
    expectedBlockerCode: 'report_contract_checkpoint_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = removeCheckpointBinding(input.checkpointSourceText, summaryBaseKey(contract));
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_binding_filename_drift',
    label: 'A checkpoint report binding points at the wrong latest file',
    expectedBlockerCode: 'report_contract_checkpoint_binding_filename_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = replaceToken(input.checkpointSourceText, contract.fileId, 'report-mistyped-checkpoint-binding-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_binding_marked_optional',
    label: 'A checkpoint report binding stops being required',
    expectedBlockerCode: 'report_contract_checkpoint_binding_required_false',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = mutateCheckpointBinding(input.checkpointSourceText, summaryBaseKey(contract), (binding) => (
        binding.replace(/\}\)/, ', required: false })')
      ));
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_hash_extractor_missing',
    label: 'The checkpoint hash extractor stops reading a contract primary hash field',
    expectedBlockerCode: 'report_contract_checkpoint_hash_extractor_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = removeCheckpointHashExtractor(input.checkpointSourceText, contract);
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_summary_hash_missing',
    label: 'The checkpoint summary stops exposing a contract hash key',
    expectedBlockerCode: 'report_contract_checkpoint_summary_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = replaceToken(
        input.checkpointSourceText,
        `${contract.gateSummaryHashKey}: byKey.${summaryBaseKey(contract)}.hash ?? null`,
        `${contract.gateSummaryHashKey}Missing: byKey.${summaryBaseKey(contract)}.hash ?? null`,
      );
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_summary_scenarios_missing',
    label: 'The checkpoint summary stops exposing a contract scenario count',
    expectedBlockerCode: 'report_contract_checkpoint_summary_scenarios_missing',
    mutate(input) {
      const contract = targetContract(input);
      const key = `${summaryBaseKey(contract)}Scenarios`;
      input.checkpointSourceText = replaceToken(input.checkpointSourceText, `${key}:`, `${key}Missing:`);
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_summary_passed_scenarios_missing',
    label: 'The checkpoint summary stops exposing a contract passed-scenario count',
    expectedBlockerCode: 'report_contract_checkpoint_summary_passed_scenarios_missing',
    mutate(input) {
      const contract = targetContract(input);
      const key = `${summaryBaseKey(contract)}PassedScenarios`;
      input.checkpointSourceText = replaceToken(input.checkpointSourceText, `${key}:`, `${key}Missing:`);
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_summary_blockers_missing',
    label: 'The checkpoint summary stops exposing a contract blocker count',
    expectedBlockerCode: 'report_contract_checkpoint_summary_blockers_missing',
    mutate(input) {
      const contract = targetContract(input);
      const key = `${summaryBaseKey(contract)}Blockers`;
      input.checkpointSourceText = replaceToken(input.checkpointSourceText, `${key}:`, `${key}Missing:`);
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_markdown_hash_missing',
    label: 'The checkpoint markdown stops rendering a contract hash summary line',
    expectedBlockerCode: 'report_contract_checkpoint_markdown_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = replaceToken(
        input.checkpointSourceText,
        `checkpoint.summary.${contract.gateSummaryHashKey}`,
        `checkpoint.summary.${contract.gateSummaryHashKey}Missing`,
      );
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceToken(sourceText, token, replacement) {
  return String(sourceText || '').split(token).join(replacement);
}

function removeCheckpointHashExtractor(sourceText = '', contract = {}) {
  const helperLine = `  const hash = ${CHECKPOINT_HASH_HELPER_CALL};\n`;
  const source = String(sourceText || '');
  if (source.includes(helperLine)) {
    return replaceToken(source, helperLine, '  const hash = null;\n');
  }
  return replaceToken(source, `    || report.${contract.stdoutHashField}\n`, '');
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    fileId: contract.fileId || null,
    stdoutHashField: contract.stdoutHashField || null,
    gateSummaryHashKey: contract.gateSummaryHashKey || null,
  };
}

function summaryBaseKey(contract = {}) {
  return String(contract.gateSummaryHashKey || '').replace(/Hash$/, '');
}

function scenarioExpected(contract = {}) {
  return contract.contractId !== 'report_freshness';
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function checkpointBindings(sourceText = '') {
  const bindings = [];
  const pattern = /reportBinding\(\{\s*key:\s*'([^']+)'\s*,\s*filename:\s*'([^']+)'(?:\s*,\s*required:\s*(true|false))?\s*\}\)/g;
  for (const match of String(sourceText || '').matchAll(pattern)) {
    bindings.push({
      key: match[1],
      filename: match[2],
      required: match[3] == null ? true : match[3] === 'true',
      source: match[0],
    });
  }
  return bindings;
}

function bindingFor(sourceText = '', key = '') {
  return checkpointBindings(sourceText).find((binding) => binding.key === key) || null;
}

function removeCheckpointBinding(sourceText = '', key = '') {
  const binding = bindingFor(sourceText, key);
  if (!binding) return sourceText;
  const linePattern = new RegExp(`\\n\\s*${escapeRegExp(binding.source)},`);
  return String(sourceText || '').replace(linePattern, '');
}

function mutateCheckpointBinding(sourceText = '', key = '', mutate) {
  const binding = bindingFor(sourceText, key);
  if (!binding) return sourceText;
  return String(sourceText || '').replace(binding.source, mutate(binding.source));
}

function propertyPresent(sourceText = '', property = '') {
  return new RegExp(`\\b${escapeRegExp(property)}\\s*:`).test(String(sourceText || ''));
}

function hashExtractorPresent(sourceText = '', field = '') {
  return new RegExp(`\\breport\\.${escapeRegExp(field)}\\b`).test(String(sourceText || ''));
}

function semanticHashHelperPresent(sourceText = '') {
  const source = String(sourceText || '');
  return /\breportHashForFileId\b/.test(source)
    && source.includes("} from './export-report-freshness.mjs'")
    && source.includes(CHECKPOINT_HASH_HELPER_CALL);
}

function semanticHashExtractorPresent(input = {}, contract = {}) {
  if (!semanticHashHelperPresent(input.checkpointSourceText)) return false;
  return reportHashKeysForFileId(contract.fileId).includes(contract.stdoutHashField);
}

function summaryHashShapePresent(sourceText = '', contract = {}) {
  const baseKey = summaryBaseKey(contract);
  return String(sourceText || '').includes(`${contract.gateSummaryHashKey}: byKey.${baseKey}.hash ?? null`);
}

function summaryMetricShapePresent(sourceText = '', baseKey = '', metricKey = '', summaryField = '') {
  return String(sourceText || '').includes(`${metricKey}: byKey.${baseKey}.report?.summary?.${summaryField} ?? null`);
}

function markdownHashPresent(sourceText = '', contract = {}) {
  return new RegExp(`\\bcheckpoint\\.summary\\.${escapeRegExp(contract.gateSummaryHashKey)}\\b`).test(String(sourceText || ''));
}

function analyzeContract(contract = {}, input = {}) {
  const baseKey = summaryBaseKey(contract);
  const expectsScenarios = scenarioExpected(contract);
  const scenarioKey = `${baseKey}Scenarios`;
  const passedScenarioKey = `${baseKey}PassedScenarios`;
  const blockerKey = `${baseKey}Blockers`;
  const binding = bindingFor(input.checkpointSourceText, baseKey);
  const bindingPresent = Boolean(binding);
  const bindingFilenamePresent = bindingPresent && binding.filename === contract.fileId;
  const bindingRequired = bindingPresent && binding.required === true;
  const extractorPresent = hashExtractorPresent(input.checkpointSourceText, contract.stdoutHashField)
    || semanticHashExtractorPresent(input, contract);
  const summaryHashPresent = propertyPresent(input.checkpointSourceText, contract.gateSummaryHashKey)
    && summaryHashShapePresent(input.checkpointSourceText, contract);
  const summaryScenarioPresent = !expectsScenarios || (
    propertyPresent(input.checkpointSourceText, scenarioKey)
    && summaryMetricShapePresent(input.checkpointSourceText, baseKey, scenarioKey, 'scenarioCount')
  );
  const summaryPassedScenarioPresent = !expectsScenarios || (
    propertyPresent(input.checkpointSourceText, passedScenarioKey)
    && summaryMetricShapePresent(input.checkpointSourceText, baseKey, passedScenarioKey, 'passedScenarioCount')
  );
  const summaryBlockerPresent = !expectsScenarios || (
    propertyPresent(input.checkpointSourceText, blockerKey)
    && summaryMetricShapePresent(input.checkpointSourceText, baseKey, blockerKey, 'blockerCount')
  );
  const markdownHashLinePresent = markdownHashPresent(input.checkpointSourceText, contract);
  const blockers = [
    ...(bindingPresent ? [] : [blocker(
      'report_contract_checkpoint_binding_missing',
      `${contract.contractId} must have a checkpoint reportBinding for ${baseKey}.`,
      { contractId: contract.contractId, key: baseKey },
    )]),
    ...(bindingFilenamePresent ? [] : [blocker(
      'report_contract_checkpoint_binding_filename_mismatch',
      `${contract.contractId} checkpoint binding must point at ${contract.fileId}.`,
      { contractId: contract.contractId, key: contract.fileId },
    )]),
    ...(bindingRequired ? [] : [blocker(
      'report_contract_checkpoint_binding_required_false',
      `${contract.contractId} checkpoint binding must remain required.`,
      { contractId: contract.contractId, key: baseKey },
    )]),
    ...(extractorPresent ? [] : [blocker(
      'report_contract_checkpoint_hash_extractor_missing',
      `${contract.contractId} checkpoint hash extraction must read ${contract.stdoutHashField}.`,
      { contractId: contract.contractId, key: contract.stdoutHashField },
    )]),
    ...(summaryHashPresent ? [] : [blocker(
      'report_contract_checkpoint_summary_hash_missing',
      `${contract.contractId} checkpoint summary must expose ${contract.gateSummaryHashKey} from byKey.${baseKey}.hash.`,
      { contractId: contract.contractId, key: contract.gateSummaryHashKey },
    )]),
    ...(summaryScenarioPresent ? [] : [blocker(
      'report_contract_checkpoint_summary_scenarios_missing',
      `${contract.contractId} checkpoint summary must expose ${scenarioKey}.`,
      { contractId: contract.contractId, key: scenarioKey },
    )]),
    ...(summaryPassedScenarioPresent ? [] : [blocker(
      'report_contract_checkpoint_summary_passed_scenarios_missing',
      `${contract.contractId} checkpoint summary must expose ${passedScenarioKey}.`,
      { contractId: contract.contractId, key: passedScenarioKey },
    )]),
    ...(summaryBlockerPresent ? [] : [blocker(
      'report_contract_checkpoint_summary_blockers_missing',
      `${contract.contractId} checkpoint summary must expose ${blockerKey}.`,
      { contractId: contract.contractId, key: blockerKey },
    )]),
    ...(markdownHashLinePresent ? [] : [blocker(
      'report_contract_checkpoint_markdown_hash_missing',
      `${contract.contractId} checkpoint markdown must render ${contract.gateSummaryHashKey}.`,
      { contractId: contract.contractId, key: contract.gateSummaryHashKey },
    )]),
  ];
  return {
    contractId: contract.contractId,
    status: blockers.length ? 'blocked_report_contract_checkpoint_binding_shape_contract' : 'pass_report_contract_checkpoint_binding_shape_contract',
    ok: blockers.length === 0,
    baseKey,
    fileId: contract.fileId,
    stdoutHashField: contract.stdoutHashField,
    hashKey: contract.gateSummaryHashKey,
    scenarioKey: expectsScenarios ? scenarioKey : null,
    passedScenarioKey: expectsScenarios ? passedScenarioKey : null,
    blockerKey: expectsScenarios ? blockerKey : null,
    bindingPresent,
    bindingFilenamePresent,
    bindingRequired,
    hashExtractorPresent: extractorPresent,
    summaryHashPresent,
    summaryScenarioPresent,
    summaryPassedScenarioPresent,
    summaryBlockerPresent,
    markdownHashPresent: markdownHashLinePresent,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    baseKey: contract.baseKey,
    fileId: contract.fileId,
    stdoutHashField: contract.stdoutHashField,
    hashKey: contract.hashKey,
    scenarioKey: contract.scenarioKey,
    passedScenarioKey: contract.passedScenarioKey,
    blockerKey: contract.blockerKey,
    bindingPresent: contract.bindingPresent === true,
    bindingFilenamePresent: contract.bindingFilenamePresent === true,
    bindingRequired: contract.bindingRequired === true,
    hashExtractorPresent: contract.hashExtractorPresent === true,
    summaryHashPresent: contract.summaryHashPresent === true,
    summaryScenarioPresent: contract.summaryScenarioPresent === true,
    summaryPassedScenarioPresent: contract.summaryPassedScenarioPresent === true,
    summaryBlockerPresent: contract.summaryBlockerPresent === true,
    markdownHashPresent: contract.markdownHashPresent === true,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      key: item.key || null,
    })),
  };
}

function analyzeCheckpointBindingShape(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_checkpoint_binding_shape_analysis' : 'pass_report_contract_checkpoint_binding_shape_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    scenarioContractCount: contractAnalyses.filter((contract) => contract.scenarioKey).length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    bindingCount: contractAnalyses.filter((contract) => contract.bindingPresent).length,
    bindingFilenameCount: contractAnalyses.filter((contract) => contract.bindingFilenamePresent).length,
    bindingRequiredCount: contractAnalyses.filter((contract) => contract.bindingRequired).length,
    hashExtractorCount: contractAnalyses.filter((contract) => contract.hashExtractorPresent).length,
    summaryHashCount: contractAnalyses.filter((contract) => contract.summaryHashPresent).length,
    summaryScenarioCount: contractAnalyses.filter((contract) => contract.summaryScenarioPresent).length,
    summaryPassedScenarioCount: contractAnalyses.filter((contract) => contract.summaryPassedScenarioPresent).length,
    summaryBlockerCount: contractAnalyses.filter((contract) => contract.summaryBlockerPresent).length,
    markdownHashCount: contractAnalyses.filter((contract) => contract.markdownHashPresent).length,
    contracts: contractAnalyses,
    blockers,
  };
}

function compactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    contractCount: analysis.contractCount || 0,
    scenarioContractCount: analysis.scenarioContractCount || 0,
    okContractCount: analysis.okContractCount || 0,
    bindingCount: analysis.bindingCount || 0,
    bindingFilenameCount: analysis.bindingFilenameCount || 0,
    bindingRequiredCount: analysis.bindingRequiredCount || 0,
    hashExtractorCount: analysis.hashExtractorCount || 0,
    summaryHashCount: analysis.summaryHashCount || 0,
    summaryScenarioCount: analysis.summaryScenarioCount || 0,
    summaryPassedScenarioCount: analysis.summaryPassedScenarioCount || 0,
    summaryBlockerCount: analysis.summaryBlockerCount || 0,
    markdownHashCount: analysis.markdownHashCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      key: item.key || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeCheckpointBindingShape(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_checkpoint_binding_shape_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract checkpoint binding shape analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_checkpoint_binding_shape_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_checkpoint_binding_shape_scenario' : 'pass_report_contract_checkpoint_binding_shape_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractCheckpointBindingShapeRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  checkpointSourceText = '',
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    checkpointSourceText: String(checkpointSourceText || ''),
  };
}

export function buildReportContractCheckpointBindingShapeRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  checkpointSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractCheckpointBindingShapeRegressionInput({
    manifest,
    checkpointSourceText,
  });
  const actual = analyzeCheckpointBindingShape(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_checkpoint_binding_shape',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_VERSION,
    kind: 'ReportContractCheckpointBindingShapeRegression',
    status: blockers.length ? 'blocked_report_contract_checkpoint_binding_shape_regression' : 'pass_report_contract_checkpoint_binding_shape_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_SCRIPT_ID,
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
      scenarioContractCount: actual.scenarioContractCount,
      okContractCount: actual.okContractCount,
      bindingCount: actual.bindingCount,
      bindingFilenameCount: actual.bindingFilenameCount,
      bindingRequiredCount: actual.bindingRequiredCount,
      hashExtractorCount: actual.hashExtractorCount,
      summaryHashCount: actual.summaryHashCount,
      summaryScenarioCount: actual.summaryScenarioCount,
      summaryPassedScenarioCount: actual.summaryPassedScenarioCount,
      summaryBlockerCount: actual.summaryBlockerCount,
      markdownHashCount: actual.markdownHashCount,
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
  const contractCheckpointBindingShapeRegressionHash = digest({
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
    contractCheckpointBindingShapeRegressionHash,
    hash: contractCheckpointBindingShapeRegressionHash,
  };
}

export function summarizeReportContractCheckpointBindingShapeRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_contract_checkpoint_binding_shape_regression',
    ok: report?.ok === true,
    contractCheckpointBindingShapeRegressionHash: report?.contractCheckpointBindingShapeRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    scenarioContractCount: report?.summary?.scenarioContractCount || 0,
    okContractCount: report?.summary?.okContractCount || 0,
    bindingCount: report?.summary?.bindingCount || 0,
    bindingFilenameCount: report?.summary?.bindingFilenameCount || 0,
    bindingRequiredCount: report?.summary?.bindingRequiredCount || 0,
    hashExtractorCount: report?.summary?.hashExtractorCount || 0,
    summaryHashCount: report?.summary?.summaryHashCount || 0,
    summaryScenarioCount: report?.summary?.summaryScenarioCount || 0,
    summaryPassedScenarioCount: report?.summary?.summaryPassedScenarioCount || 0,
    summaryBlockerCount: report?.summary?.summaryBlockerCount || 0,
    markdownHashCount: report?.summary?.markdownHashCount || 0,
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
