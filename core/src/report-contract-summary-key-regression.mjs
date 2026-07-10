import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_REPORT_FILE_ID = 'report-contract-summary-key-regression-latest.json';
export const REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_SCRIPT_ID = 'reports:contract-summary-key-regression';
export const REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_STEP_ID = 'report_contract_summary_key_regression_export';

const NON_SCENARIO_CONTRACT_IDS = Object.freeze([
  'report_freshness',
]);

const TARGET_CONTRACT_ID = 'report_contract_doc_coverage_regression';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_summary_keys',
    label: 'A new manifest contract is added without any downstream summary keys',
    expectedBlockerCode: 'report_contract_summary_key_gate_hash_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_summary_key_guard',
        label: 'Report future summary key guard',
        scriptId: 'reports:future-summary-key-guard',
        exporterPath: 'src/export-report-future-summary-key-guard.mjs',
        stepIds: ['report_future_summary_key_guard_export'],
        fileId: 'report-future-summary-key-guard-latest.json',
        stdoutHashField: 'futureSummaryKeyGuardHash',
        gateSummaryHashKey: 'reportFutureSummaryKeyGuardHash',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_missing',
    label: 'The integration gate summary drops a contract hash key',
    expectedBlockerCode: 'report_contract_summary_key_gate_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        `${contract.gateSummaryHashKey}:`,
        'missingContractDocCoverageGateHash:',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_ok_missing',
    label: 'The integration gate summary drops a contract ok key',
    expectedBlockerCode: 'report_contract_summary_key_gate_ok_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSourceText = replaceToken(
        input.gateSourceText,
        `${summaryBaseKey(contract)}Ok:`,
        'missingContractDocCoverageGateOk:',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_hash_missing',
    label: 'The architecture checkpoint summary drops a contract hash key',
    expectedBlockerCode: 'report_contract_summary_key_checkpoint_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = replaceToken(
        input.checkpointSourceText,
        `${contract.gateSummaryHashKey}:`,
        'missingContractDocCoverageCheckpointHash:',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_scenarios_missing',
    label: 'The architecture checkpoint summary drops a contract scenario key',
    expectedBlockerCode: 'report_contract_summary_key_checkpoint_scenarios_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.checkpointSourceText = replaceToken(
        input.checkpointSourceText,
        `${summaryBaseKey(contract)}Scenarios:`,
        'missingContractDocCoverageCheckpointScenarios:',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'audit_object_missing',
    label: 'The integration audit drops a contract report object',
    expectedBlockerCode: 'report_contract_summary_key_audit_object_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = replaceToken(
        input.auditSourceText,
        `${summaryBaseKey(contract)}: {`,
        'missingContractDocCoverageAudit: {',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'selftest_hash_missing',
    label: 'Selftest drops a contract hash output key',
    expectedBlockerCode: 'report_contract_summary_key_selftest_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.selftestSourceText = replaceToken(
        input.selftestSourceText,
        `${contract.gateSummaryHashKey}:`,
        'missingContractDocCoverageSelftestHash:',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'selftest_lanes_hash_missing',
    label: 'Selftest lanes stop requiring a contract hash output key',
    expectedBlockerCode: 'report_contract_summary_key_selftest_lane_hash_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.selftestLanesSourceText = replaceToken(
        input.selftestLanesSourceText,
        `'${contract.gateSummaryHashKey}'`,
        '\'missingContractDocCoverageLaneHash\'',
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

function propertyPresent(sourceText = '', key) {
  return new RegExp(`\\b${escapeRegExp(key)}\\s*:`).test(String(sourceText || ''));
}

function quotedKeyPresent(sourceText = '', key) {
  return new RegExp(`['"]${escapeRegExp(key)}['"]`).test(String(sourceText || ''));
}

function auditObjectPresent(sourceText = '', key) {
  return new RegExp(`\\n\\s{4}${escapeRegExp(key)}\\s*:\\s*\\{`).test(String(sourceText || ''));
}

function replaceToken(sourceText, token, replacement) {
  return String(sourceText || '').split(token).join(replacement);
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    scriptId: contract.scriptId || null,
    fileId: contract.fileId || null,
    stdoutHashField: contract.stdoutHashField || null,
    gateSummaryHashKey: contract.gateSummaryHashKey || null,
  };
}

function summaryBaseKey(contract = {}) {
  return String(contract.gateSummaryHashKey || '').replace(/Hash$/, '');
}

function scenarioExpected(contract = {}) {
  return !NON_SCENARIO_CONTRACT_IDS.includes(contract.contractId);
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function analyzeContract(contract, input = {}) {
  const baseKey = summaryBaseKey(contract);
  const hashKey = contract.gateSummaryHashKey;
  const okKey = `${baseKey}Ok`;
  const scenarioKey = `${baseKey}Scenarios`;
  const passedScenarioKey = `${baseKey}PassedScenarios`;
  const blockerKey = `${baseKey}Blockers`;
  const expectsScenarios = scenarioExpected(contract);
  const gateHashPresent = propertyPresent(input.gateSourceText, hashKey);
  const gateOkPresent = propertyPresent(input.gateSourceText, okKey);
  const checkpointHashPresent = propertyPresent(input.checkpointSourceText, hashKey);
  const checkpointScenarioPresent = !expectsScenarios || propertyPresent(input.checkpointSourceText, scenarioKey);
  const checkpointPassedScenarioPresent = !expectsScenarios || propertyPresent(input.checkpointSourceText, passedScenarioKey);
  const checkpointBlockerPresent = !expectsScenarios || propertyPresent(input.checkpointSourceText, blockerKey);
  const auditReportObjectPresent = auditObjectPresent(input.auditSourceText, baseKey);
  const auditHashFieldPresent = propertyPresent(input.auditSourceText, contract.stdoutHashField);
  const selftestHashPresent = propertyPresent(input.selftestSourceText, hashKey);
  const selftestScenarioPresent = !expectsScenarios || propertyPresent(input.selftestSourceText, scenarioKey);
  const selftestLaneHashPresent = quotedKeyPresent(input.selftestLanesSourceText, hashKey);
  const selftestLaneScenarioPresent = !expectsScenarios || quotedKeyPresent(input.selftestLanesSourceText, scenarioKey);
  const blockers = [
    ...(gateHashPresent ? [] : [blocker(
      'report_contract_summary_key_gate_hash_missing',
      `${contract.contractId} gate summary must expose ${hashKey}.`,
      { contractId: contract.contractId, key: hashKey },
    )]),
    ...(gateOkPresent ? [] : [blocker(
      'report_contract_summary_key_gate_ok_missing',
      `${contract.contractId} gate summary must expose ${okKey}.`,
      { contractId: contract.contractId, key: okKey },
    )]),
    ...(checkpointHashPresent ? [] : [blocker(
      'report_contract_summary_key_checkpoint_hash_missing',
      `${contract.contractId} checkpoint summary must expose ${hashKey}.`,
      { contractId: contract.contractId, key: hashKey },
    )]),
    ...(checkpointScenarioPresent ? [] : [blocker(
      'report_contract_summary_key_checkpoint_scenarios_missing',
      `${contract.contractId} checkpoint summary must expose ${scenarioKey}.`,
      { contractId: contract.contractId, key: scenarioKey },
    )]),
    ...(checkpointPassedScenarioPresent ? [] : [blocker(
      'report_contract_summary_key_checkpoint_passed_scenarios_missing',
      `${contract.contractId} checkpoint summary must expose ${passedScenarioKey}.`,
      { contractId: contract.contractId, key: passedScenarioKey },
    )]),
    ...(checkpointBlockerPresent ? [] : [blocker(
      'report_contract_summary_key_checkpoint_blockers_missing',
      `${contract.contractId} checkpoint summary must expose ${blockerKey}.`,
      { contractId: contract.contractId, key: blockerKey },
    )]),
    ...(auditReportObjectPresent ? [] : [blocker(
      'report_contract_summary_key_audit_object_missing',
      `${contract.contractId} audit report must expose ${baseKey}.`,
      { contractId: contract.contractId, key: baseKey },
    )]),
    ...(auditHashFieldPresent ? [] : [blocker(
      'report_contract_summary_key_audit_hash_missing',
      `${contract.contractId} audit report must expose ${contract.stdoutHashField}.`,
      { contractId: contract.contractId, key: contract.stdoutHashField },
    )]),
    ...(selftestHashPresent ? [] : [blocker(
      'report_contract_summary_key_selftest_hash_missing',
      `${contract.contractId} selftest output must expose ${hashKey}.`,
      { contractId: contract.contractId, key: hashKey },
    )]),
    ...(selftestScenarioPresent ? [] : [blocker(
      'report_contract_summary_key_selftest_scenarios_missing',
      `${contract.contractId} selftest output must expose ${scenarioKey}.`,
      { contractId: contract.contractId, key: scenarioKey },
    )]),
    ...(selftestLaneHashPresent ? [] : [blocker(
      'report_contract_summary_key_selftest_lane_hash_missing',
      `${contract.contractId} selftest lane metrics must require ${hashKey}.`,
      { contractId: contract.contractId, key: hashKey },
    )]),
    ...(selftestLaneScenarioPresent ? [] : [blocker(
      'report_contract_summary_key_selftest_lane_scenarios_missing',
      `${contract.contractId} selftest lane metrics must require ${scenarioKey}.`,
      { contractId: contract.contractId, key: scenarioKey },
    )]),
  ];
  return {
    contractId: contract.contractId,
    status: blockers.length ? 'blocked_report_contract_summary_key_contract' : 'pass_report_contract_summary_key_contract',
    ok: blockers.length === 0,
    baseKey,
    hashKey,
    okKey,
    scenarioKey: expectsScenarios ? scenarioKey : null,
    passedScenarioKey: expectsScenarios ? passedScenarioKey : null,
    blockerKey: expectsScenarios ? blockerKey : null,
    stdoutHashField: contract.stdoutHashField,
    gateHashPresent,
    gateOkPresent,
    checkpointHashPresent,
    checkpointScenarioPresent,
    checkpointPassedScenarioPresent,
    checkpointBlockerPresent,
    auditObjectPresent: auditReportObjectPresent,
    auditHashFieldPresent,
    selftestHashPresent,
    selftestScenarioPresent,
    selftestLaneHashPresent,
    selftestLaneScenarioPresent,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    baseKey: contract.baseKey,
    hashKey: contract.hashKey,
    okKey: contract.okKey,
    scenarioKey: contract.scenarioKey,
    passedScenarioKey: contract.passedScenarioKey,
    blockerKey: contract.blockerKey,
    stdoutHashField: contract.stdoutHashField,
    gateHashPresent: contract.gateHashPresent === true,
    gateOkPresent: contract.gateOkPresent === true,
    checkpointHashPresent: contract.checkpointHashPresent === true,
    checkpointScenarioPresent: contract.checkpointScenarioPresent === true,
    checkpointPassedScenarioPresent: contract.checkpointPassedScenarioPresent === true,
    checkpointBlockerPresent: contract.checkpointBlockerPresent === true,
    auditObjectPresent: contract.auditObjectPresent === true,
    auditHashFieldPresent: contract.auditHashFieldPresent === true,
    selftestHashPresent: contract.selftestHashPresent === true,
    selftestScenarioPresent: contract.selftestScenarioPresent === true,
    selftestLaneHashPresent: contract.selftestLaneHashPresent === true,
    selftestLaneScenarioPresent: contract.selftestLaneScenarioPresent === true,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      key: item.key || null,
    })),
  };
}

function analyzeSummaryKeys(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  const scenarioContractCount = contractAnalyses.filter((contract) => contract.scenarioKey).length;
  return {
    status: blockers.length ? 'blocked_report_contract_summary_key_analysis' : 'pass_report_contract_summary_key_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    scenarioContractCount,
    gateHashKeyCount: contractAnalyses.filter((contract) => contract.gateHashPresent).length,
    gateOkKeyCount: contractAnalyses.filter((contract) => contract.gateOkPresent).length,
    checkpointHashKeyCount: contractAnalyses.filter((contract) => contract.checkpointHashPresent).length,
    checkpointScenarioKeyCount: contractAnalyses.filter((contract) => contract.scenarioKey && contract.checkpointScenarioPresent).length,
    checkpointPassedScenarioKeyCount: contractAnalyses.filter((contract) => contract.scenarioKey && contract.checkpointPassedScenarioPresent).length,
    checkpointBlockerKeyCount: contractAnalyses.filter((contract) => contract.scenarioKey && contract.checkpointBlockerPresent).length,
    auditObjectKeyCount: contractAnalyses.filter((contract) => contract.auditObjectPresent).length,
    auditHashFieldCount: contractAnalyses.filter((contract) => contract.auditHashFieldPresent).length,
    selftestHashKeyCount: contractAnalyses.filter((contract) => contract.selftestHashPresent).length,
    selftestScenarioKeyCount: contractAnalyses.filter((contract) => contract.scenarioKey && contract.selftestScenarioPresent).length,
    selftestLaneHashKeyCount: contractAnalyses.filter((contract) => contract.selftestLaneHashPresent).length,
    selftestLaneScenarioKeyCount: contractAnalyses.filter((contract) => contract.scenarioKey && contract.selftestLaneScenarioPresent).length,
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
    scenarioContractCount: analysis.scenarioContractCount || 0,
    gateHashKeyCount: analysis.gateHashKeyCount || 0,
    gateOkKeyCount: analysis.gateOkKeyCount || 0,
    checkpointHashKeyCount: analysis.checkpointHashKeyCount || 0,
    checkpointScenarioKeyCount: analysis.checkpointScenarioKeyCount || 0,
    checkpointPassedScenarioKeyCount: analysis.checkpointPassedScenarioKeyCount || 0,
    checkpointBlockerKeyCount: analysis.checkpointBlockerKeyCount || 0,
    auditObjectKeyCount: analysis.auditObjectKeyCount || 0,
    auditHashFieldCount: analysis.auditHashFieldCount || 0,
    selftestHashKeyCount: analysis.selftestHashKeyCount || 0,
    selftestScenarioKeyCount: analysis.selftestScenarioKeyCount || 0,
    selftestLaneHashKeyCount: analysis.selftestLaneHashKeyCount || 0,
    selftestLaneScenarioKeyCount: analysis.selftestLaneScenarioKeyCount || 0,
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
  const analysis = analyzeSummaryKeys(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_summary_key_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract summary key analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_summary_key_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_summary_key_scenario' : 'pass_report_contract_summary_key_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractSummaryKeyRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  gateSourceText = '',
  checkpointSourceText = '',
  auditSourceText = '',
  selftestSourceText = '',
  selftestLanesSourceText = '',
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    gateSourceText: String(gateSourceText || ''),
    checkpointSourceText: String(checkpointSourceText || ''),
    auditSourceText: String(auditSourceText || ''),
    selftestSourceText: String(selftestSourceText || ''),
    selftestLanesSourceText: String(selftestLanesSourceText || ''),
  };
}

export function buildReportContractSummaryKeyRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  gateSourceText = '',
  checkpointSourceText = '',
  auditSourceText = '',
  selftestSourceText = '',
  selftestLanesSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractSummaryKeyRegressionInput({
    manifest,
    gateSourceText,
    checkpointSourceText,
    auditSourceText,
    selftestSourceText,
    selftestLanesSourceText,
  });
  const actual = analyzeSummaryKeys(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_summary_key_coverage',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_VERSION,
    kind: 'ReportContractSummaryKeyRegression',
    status: blockers.length ? 'blocked_report_contract_summary_key_regression' : 'pass_report_contract_summary_key_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      nonScenarioContractIds: [...NON_SCENARIO_CONTRACT_IDS],
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
      scenarioContractCount: actual.scenarioContractCount,
      gateHashKeyCount: actual.gateHashKeyCount,
      gateOkKeyCount: actual.gateOkKeyCount,
      checkpointHashKeyCount: actual.checkpointHashKeyCount,
      checkpointScenarioKeyCount: actual.checkpointScenarioKeyCount,
      checkpointPassedScenarioKeyCount: actual.checkpointPassedScenarioKeyCount,
      checkpointBlockerKeyCount: actual.checkpointBlockerKeyCount,
      auditObjectKeyCount: actual.auditObjectKeyCount,
      auditHashFieldCount: actual.auditHashFieldCount,
      selftestHashKeyCount: actual.selftestHashKeyCount,
      selftestScenarioKeyCount: actual.selftestScenarioKeyCount,
      selftestLaneHashKeyCount: actual.selftestLaneHashKeyCount,
      selftestLaneScenarioKeyCount: actual.selftestLaneScenarioKeyCount,
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
  const contractSummaryKeyRegressionHash = digest({
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
    contractSummaryKeyRegressionHash,
    hash: contractSummaryKeyRegressionHash,
  };
}

export function summarizeReportContractSummaryKeyRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_contract_summary_key_regression',
    ok: report?.ok === true,
    contractSummaryKeyRegressionHash: report?.contractSummaryKeyRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    okContractCount: report?.summary?.okContractCount || 0,
    scenarioContractCount: report?.summary?.scenarioContractCount || 0,
    gateHashKeyCount: report?.summary?.gateHashKeyCount || 0,
    gateOkKeyCount: report?.summary?.gateOkKeyCount || 0,
    checkpointHashKeyCount: report?.summary?.checkpointHashKeyCount || 0,
    checkpointScenarioKeyCount: report?.summary?.checkpointScenarioKeyCount || 0,
    auditObjectKeyCount: report?.summary?.auditObjectKeyCount || 0,
    auditHashFieldCount: report?.summary?.auditHashFieldCount || 0,
    selftestHashKeyCount: report?.summary?.selftestHashKeyCount || 0,
    selftestScenarioKeyCount: report?.summary?.selftestScenarioKeyCount || 0,
    selftestLaneHashKeyCount: report?.summary?.selftestLaneHashKeyCount || 0,
    selftestLaneScenarioKeyCount: report?.summary?.selftestLaneScenarioKeyCount || 0,
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
