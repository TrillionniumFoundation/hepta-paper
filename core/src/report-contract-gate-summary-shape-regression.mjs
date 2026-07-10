import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_REPORT_FILE_ID = 'report-contract-gate-summary-shape-regression-latest.json';
export const REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_SCRIPT_ID = 'reports:contract-gate-summary-shape-regression';
export const REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_STEP_ID = 'report_contract_gate_summary_shape_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_doc_coverage_regression';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_gate_summary',
    label: 'A new manifest contract is added without gate summary keys',
    expectedBlockerCode: 'report_contract_gate_summary_ok_shape_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_gate_summary',
        stepIds: ['report_future_gate_summary_export'],
        stdoutHashField: 'futureGateSummaryHash',
        gateSummaryHashKey: 'reportFutureGateSummaryHash',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_ok_shape_drift',
    label: 'The gate summary ok key stops reading the contract export step ok flag',
    expectedBlockerCode: 'report_contract_gate_summary_ok_shape_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        okShape(contract),
        `${gateOkKey(contract)}: true`,
      );
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_shape_drift',
    label: 'The gate summary hash key stops reading the contract primary hash field',
    expectedBlockerCode: 'report_contract_gate_summary_hash_shape_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        hashShape(contract),
        `${contract.gateSummaryHashKey}: null`,
      );
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_field_drift',
    label: 'The gate summary hash key reads the wrong stdout hash field',
    expectedBlockerCode: 'report_contract_gate_summary_hash_shape_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        `outputJson?.${contract.stdoutHashField} || null`,
        'outputJson?.mistypedContractHash || null',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_step_id_drift',
    label: 'The gate summary keys read the wrong step id',
    expectedBlockerCode: 'report_contract_gate_summary_ok_shape_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        `step.stepId === '${primaryStepId(contract)}'`,
        "step.stepId === 'report_mistyped_gate_summary_export'",
      );
    },
  }),
  Object.freeze({
    scenarioId: 'gate_markdown_ok_missing',
    label: 'The gate markdown stops rendering the contract ok summary key',
    expectedBlockerCode: 'report_contract_gate_markdown_ok_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        `gate.summary.${gateOkKey(contract)}`,
        `gate.summary.${gateOkKey(contract)}Missing`,
      );
    },
  }),
  Object.freeze({
    scenarioId: 'gate_markdown_hash_missing',
    label: 'The gate markdown stops rendering the contract hash summary key',
    expectedBlockerCode: 'report_contract_gate_markdown_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        `gate.summary.${contract.gateSummaryHashKey}`,
        `gate.summary.${contract.gateSummaryHashKey}Missing`,
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

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    stepIds: Array.isArray(contract.stepIds) ? [...contract.stepIds] : [],
    stdoutHashField: contract.stdoutHashField || null,
    gateSummaryHashKey: contract.gateSummaryHashKey || null,
  };
}

function primaryStepId(contract = {}) {
  return contract.stepIds?.[0] || null;
}

function gateSummaryStepId(contract = {}) {
  if (contract.contractId === 'report_freshness') {
    return contract.stepIds?.[1] || primaryStepId(contract);
  }
  return primaryStepId(contract);
}

function gateOkKey(contract = {}) {
  return String(contract.gateSummaryHashKey || '').replace(/Hash$/, 'Ok');
}

function propertyPresent(sourceText = '', property = '') {
  return new RegExp(`\\b${escapeRegExp(property)}\\s*:`).test(String(sourceText || ''));
}

function okShape(contract = {}) {
  return `${gateOkKey(contract)}: steps.find((step) => step.stepId === '${gateSummaryStepId(contract)}')?.outputJson?.ok === true`;
}

function hashShape(contract = {}) {
  return `${contract.gateSummaryHashKey}: steps.find((step) => step.stepId === '${gateSummaryStepId(contract)}')?.outputJson?.${contract.stdoutHashField} || null`;
}

function markdownOkPresent(sourceText = '', contract = {}) {
  return new RegExp(`\\bgate\\.summary\\.${escapeRegExp(gateOkKey(contract))}\\b`).test(String(sourceText || ''));
}

function markdownHashPresent(sourceText = '', contract = {}) {
  return new RegExp(`\\bgate\\.summary\\.${escapeRegExp(contract.gateSummaryHashKey)}\\b`).test(String(sourceText || ''));
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function analyzeContract(contract = {}, input = {}) {
  const okKey = gateOkKey(contract);
  const stepId = gateSummaryStepId(contract);
  const okShapePresent = propertyPresent(input.gateSourceText, okKey)
    && String(input.gateSourceText || '').includes(okShape(contract));
  const hashShapePresent = propertyPresent(input.gateSourceText, contract.gateSummaryHashKey)
    && String(input.gateSourceText || '').includes(hashShape(contract));
  const markdownOkLinePresent = markdownOkPresent(input.gateSourceText, contract);
  const markdownHashLinePresent = markdownHashPresent(input.gateSourceText, contract);
  const blockers = [
    ...(okShapePresent ? [] : [blocker(
      'report_contract_gate_summary_ok_shape_missing',
      `${contract.contractId} gate summary must expose ${okKey} from ${stepId}.outputJson.ok.`,
      { contractId: contract.contractId, key: okKey, stepId },
    )]),
    ...(hashShapePresent ? [] : [blocker(
      'report_contract_gate_summary_hash_shape_missing',
      `${contract.contractId} gate summary must expose ${contract.gateSummaryHashKey} from ${stepId}.outputJson.${contract.stdoutHashField}.`,
      { contractId: contract.contractId, key: contract.gateSummaryHashKey, stepId },
    )]),
    ...(markdownOkLinePresent ? [] : [blocker(
      'report_contract_gate_markdown_ok_missing',
      `${contract.contractId} gate markdown must render ${okKey}.`,
      { contractId: contract.contractId, key: okKey },
    )]),
    ...(markdownHashLinePresent ? [] : [blocker(
      'report_contract_gate_markdown_hash_missing',
      `${contract.contractId} gate markdown must render ${contract.gateSummaryHashKey}.`,
      { contractId: contract.contractId, key: contract.gateSummaryHashKey },
    )]),
  ];
  return {
    contractId: contract.contractId,
    status: blockers.length ? 'blocked_report_contract_gate_summary_shape_contract' : 'pass_report_contract_gate_summary_shape_contract',
    ok: blockers.length === 0,
    stepId,
    okKey,
    hashKey: contract.gateSummaryHashKey,
    stdoutHashField: contract.stdoutHashField,
    okShapePresent,
    hashShapePresent,
    markdownOkPresent: markdownOkLinePresent,
    markdownHashPresent: markdownHashLinePresent,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    stepId: contract.stepId,
    okKey: contract.okKey,
    hashKey: contract.hashKey,
    stdoutHashField: contract.stdoutHashField,
    okShapePresent: contract.okShapePresent === true,
    hashShapePresent: contract.hashShapePresent === true,
    markdownOkPresent: contract.markdownOkPresent === true,
    markdownHashPresent: contract.markdownHashPresent === true,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      key: item.key || null,
      stepId: item.stepId || null,
    })),
  };
}

function analyzeGateSummaryShape(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_gate_summary_shape_analysis' : 'pass_report_contract_gate_summary_shape_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    okShapeCount: contractAnalyses.filter((contract) => contract.okShapePresent).length,
    hashShapeCount: contractAnalyses.filter((contract) => contract.hashShapePresent).length,
    markdownOkCount: contractAnalyses.filter((contract) => contract.markdownOkPresent).length,
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
    okContractCount: analysis.okContractCount || 0,
    okShapeCount: analysis.okShapeCount || 0,
    hashShapeCount: analysis.hashShapeCount || 0,
    markdownOkCount: analysis.markdownOkCount || 0,
    markdownHashCount: analysis.markdownHashCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      key: item.key || null,
      stepId: item.stepId || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeGateSummaryShape(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_gate_summary_shape_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract gate summary shape analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_gate_summary_shape_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_gate_summary_shape_scenario' : 'pass_report_contract_gate_summary_shape_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractGateSummaryShapeRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  gateSourceText = '',
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    gateSourceText: String(gateSourceText || ''),
  };
}

export function buildReportContractGateSummaryShapeRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  gateSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractGateSummaryShapeRegressionInput({
    manifest,
    gateSourceText,
  });
  const actual = analyzeGateSummaryShape(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_gate_summary_shape',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_VERSION,
    kind: 'ReportContractGateSummaryShapeRegression',
    status: blockers.length ? 'blocked_report_contract_gate_summary_shape_regression' : 'pass_report_contract_gate_summary_shape_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_SCRIPT_ID,
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
      okShapeCount: actual.okShapeCount,
      hashShapeCount: actual.hashShapeCount,
      markdownOkCount: actual.markdownOkCount,
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
  const contractGateSummaryShapeRegressionHash = digest({
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
      key: item.key || null,
      stepId: item.stepId || null,
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractGateSummaryShapeRegressionHash,
    hash: contractGateSummaryShapeRegressionHash,
  };
}

export function summarizeReportContractGateSummaryShapeRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractGateSummaryShapeRegressionHash: report.contractGateSummaryShapeRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    okShapeCount: report.summary?.okShapeCount ?? null,
    hashShapeCount: report.summary?.hashShapeCount ?? null,
    markdownOkCount: report.summary?.markdownOkCount ?? null,
    markdownHashCount: report.summary?.markdownHashCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
