import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_REPORT_FILE_ID = 'report-contract-safety-flag-regression-latest.json';
export const REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_SCRIPT_ID = 'reports:contract-safety-flag-regression';
export const REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_STEP_ID = 'report_contract_safety_flag_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_exporter_stdout_shape_regression';

const REQUIRED_TRUE_FLAGS = Object.freeze([
  'localOnly',
  'readOnly',
]);

const REQUIRED_FALSE_FLAGS = Object.freeze([
  'mutatesReportFiles',
  'executesExternalAction',
  'providerSpend',
  'browserAutomation',
  'upload',
  'submit',
  'messaging',
  'payment',
  'acceptance',
  'deployment',
  'fetchesChannelState',
  'appliesLocalStateTransition',
  'grantsExecutionPermission',
]);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_latest_report',
    label: 'A new manifest contract is added without a latest report record',
    expectedBlockerCode: 'report_contract_safety_latest_report_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_safety_flags',
        fileId: 'report-future-safety-flags-latest.json',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'safety_object_missing',
    label: 'A manifest latest report loses its safety object',
    expectedBlockerCode: 'report_contract_safety_object_missing',
    mutate(input) {
      const contract = targetContract(input);
      delete input.reportsByFileId[contract.fileId].safety;
    },
  }),
  Object.freeze({
    scenarioId: 'local_only_missing',
    label: 'A manifest latest report stops declaring localOnly=true',
    expectedBlockerCode: 'report_contract_safety_true_flag_missing',
    mutate(input) {
      const contract = targetContract(input);
      delete input.reportsByFileId[contract.fileId].safety.localOnly;
    },
  }),
  Object.freeze({
    scenarioId: 'read_only_false',
    label: 'A manifest latest report weakens readOnly',
    expectedBlockerCode: 'report_contract_safety_true_flag_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportsByFileId[contract.fileId].safety.readOnly = false;
    },
  }),
  Object.freeze({
    scenarioId: 'external_flag_missing',
    label: 'A manifest latest report omits an explicit external-action false flag',
    expectedBlockerCode: 'report_contract_safety_false_flag_missing',
    mutate(input) {
      const contract = targetContract(input);
      delete input.reportsByFileId[contract.fileId].safety.providerSpend;
    },
  }),
  Object.freeze({
    scenarioId: 'external_flag_true',
    label: 'A manifest latest report grants an external action',
    expectedBlockerCode: 'report_contract_safety_false_flag_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportsByFileId[contract.fileId].safety.submit = true;
    },
  }),
  Object.freeze({
    scenarioId: 'state_transition_true',
    label: 'A manifest latest report grants local state transition application',
    expectedBlockerCode: 'report_contract_safety_false_flag_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportsByFileId[contract.fileId].safety.appliesLocalStateTransition = true;
    },
  }),
  Object.freeze({
    scenarioId: 'mutates_report_files_missing',
    label: 'A manifest latest report omits mutatesReportFiles=false',
    expectedBlockerCode: 'report_contract_safety_false_flag_missing',
    mutate(input) {
      const contract = targetContract(input);
      delete input.reportsByFileId[contract.fileId].safety.mutatesReportFiles;
    },
  }),
]);

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    fileId: contract.fileId || null,
  };
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function analyzeContract(contract = {}, input = {}) {
  const report = input.reportsByFileId?.[contract.fileId] || null;
  const safety = report?.safety;
  const reportPresent = isObject(report);
  const safetyPresent = isObject(safety);
  const trueFlags = REQUIRED_TRUE_FLAGS.map((flagId) => ({
    flagId,
    ok: safetyPresent && safety[flagId] === true,
  }));
  const falseFlags = REQUIRED_FALSE_FLAGS.map((flagId) => ({
    flagId,
    ok: safetyPresent && safety[flagId] === false,
  }));
  const blockers = [
    ...(reportPresent ? [] : [blocker(
      'report_contract_safety_latest_report_missing',
      `${contract.fileId || 'unknown'} must be provided for manifest safety flag analysis.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(reportPresent && safetyPresent ? [] : [blocker(
      'report_contract_safety_object_missing',
      `${contract.fileId || 'unknown'} must expose a safety object.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...trueFlags.filter((flag) => !flag.ok).map((flag) => blocker(
      'report_contract_safety_true_flag_missing',
      `${contract.fileId || 'unknown'} safety.${flag.flagId} must be explicitly true.`,
      { contractId: contract.contractId, fileId: contract.fileId, flagId: flag.flagId },
    )),
    ...falseFlags.filter((flag) => !flag.ok).map((flag) => blocker(
      'report_contract_safety_false_flag_missing',
      `${contract.fileId || 'unknown'} safety.${flag.flagId} must be explicitly false.`,
      { contractId: contract.contractId, fileId: contract.fileId, flagId: flag.flagId },
    )),
  ];
  return {
    contractId: contract.contractId,
    fileId: contract.fileId,
    status: blockers.length ? 'blocked_report_contract_safety_flag_contract' : 'pass_report_contract_safety_flag_contract',
    ok: blockers.length === 0,
    reportPresent,
    safetyPresent,
    trueFlagCount: trueFlags.filter((flag) => flag.ok).length,
    requiredTrueFlagCount: REQUIRED_TRUE_FLAGS.length,
    falseFlagCount: falseFlags.filter((flag) => flag.ok).length,
    requiredFalseFlagCount: REQUIRED_FALSE_FLAGS.length,
    missingTrueFlags: trueFlags.filter((flag) => !flag.ok).map((flag) => flag.flagId),
    missingFalseFlags: falseFlags.filter((flag) => !flag.ok).map((flag) => flag.flagId),
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    fileId: contract.fileId,
    reportPresent: contract.reportPresent === true,
    safetyPresent: contract.safetyPresent === true,
    trueFlagCount: contract.trueFlagCount || 0,
    requiredTrueFlagCount: contract.requiredTrueFlagCount || 0,
    falseFlagCount: contract.falseFlagCount || 0,
    requiredFalseFlagCount: contract.requiredFalseFlagCount || 0,
    missingTrueFlags: contract.missingTrueFlags || [],
    missingFalseFlags: contract.missingFalseFlags || [],
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      flagId: item.flagId || null,
    })),
  };
}

function analyzeSafetyFlags(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_safety_flag_analysis' : 'pass_report_contract_safety_flag_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    reportCount: contractAnalyses.filter((contract) => contract.reportPresent).length,
    safetyCount: contractAnalyses.filter((contract) => contract.safetyPresent).length,
    trueFlagCount: contractAnalyses.reduce((sum, contract) => sum + contract.trueFlagCount, 0),
    requiredTrueFlagCount: contractAnalyses.reduce((sum, contract) => sum + contract.requiredTrueFlagCount, 0),
    falseFlagCount: contractAnalyses.reduce((sum, contract) => sum + contract.falseFlagCount, 0),
    requiredFalseFlagCount: contractAnalyses.reduce((sum, contract) => sum + contract.requiredFalseFlagCount, 0),
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
    reportCount: analysis.reportCount || 0,
    safetyCount: analysis.safetyCount || 0,
    trueFlagCount: analysis.trueFlagCount || 0,
    requiredTrueFlagCount: analysis.requiredTrueFlagCount || 0,
    falseFlagCount: analysis.falseFlagCount || 0,
    requiredFalseFlagCount: analysis.requiredFalseFlagCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      fileId: item.fileId || null,
      flagId: item.flagId || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeSafetyFlags(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_safety_flag_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract safety flag analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_safety_flag_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_safety_flag_scenario' : 'pass_report_contract_safety_flag_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractSafetyFlagRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  reportsByFileId = {},
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    reportsByFileId: { ...(reportsByFileId || {}) },
  };
}

export function buildReportContractSafetyFlagRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  reportsByFileId = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractSafetyFlagRegressionInput({
    manifest,
    reportsByFileId,
  });
  const actual = analyzeSafetyFlags(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_safety_flags',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_VERSION,
    kind: 'ReportContractSafetyFlagRegression',
    status: blockers.length ? 'blocked_report_contract_safety_flag_regression' : 'pass_report_contract_safety_flag_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_SCRIPT_ID,
    fixture: {
      requiredTrueFlags: [...REQUIRED_TRUE_FLAGS],
      requiredFalseFlags: [...REQUIRED_FALSE_FLAGS],
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
      reportCount: actual.reportCount,
      safetyCount: actual.safetyCount,
      trueFlagCount: actual.trueFlagCount,
      requiredTrueFlagCount: actual.requiredTrueFlagCount,
      falseFlagCount: actual.falseFlagCount,
      requiredFalseFlagCount: actual.requiredFalseFlagCount,
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
  const contractSafetyFlagRegressionHash = digest({
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
      fileId: item.fileId || null,
      flagId: item.flagId || null,
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractSafetyFlagRegressionHash,
    hash: contractSafetyFlagRegressionHash,
  };
}

export function summarizeReportContractSafetyFlagRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractSafetyFlagRegressionHash: report.contractSafetyFlagRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    safetyCount: report.summary?.safetyCount ?? null,
    trueFlagCount: report.summary?.trueFlagCount ?? null,
    requiredTrueFlagCount: report.summary?.requiredTrueFlagCount ?? null,
    falseFlagCount: report.summary?.falseFlagCount ?? null,
    requiredFalseFlagCount: report.summary?.requiredFalseFlagCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
