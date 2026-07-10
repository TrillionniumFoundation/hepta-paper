import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
  REPORT_CONTRACT_MANIFEST_OPTIONAL_CONTRACT_REASONS,
  REQUIRED_CONTRACT_IDS,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_VERSION = 1;

export const REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_REPORT_FILE_ID = 'report-contract-required-coverage-regression-latest.json';

export const REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_SCRIPT_ID = 'reports:contract-required-coverage-regression';

export const REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_STEP_ID = 'report_contract_required_coverage_regression_export';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_required_or_optional_reason',
    label: 'A new manifest contract is added without required coverage or an optional reason',
    expectedBlockerCode: 'report_contract_required_coverage_unclassified_contract',
    mutate(input) {
      input.manifest.push({
        contractId: 'synthetic_new_report_contract',
        label: 'Synthetic new report contract',
        scriptId: 'reports:synthetic-new-report-contract',
        exporterPath: 'src/export-synthetic-new-report-contract.mjs',
        stepIds: ['synthetic_new_report_contract_export'],
        fileId: 'synthetic-new-report-contract-latest.json',
        stdoutHashField: 'syntheticNewReportContractHash',
        gateSummaryHashKey: 'syntheticNewReportContractHash',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'existing_manifest_contract_removed_from_required_ids',
    label: 'An existing manifest contract is removed from REQUIRED_CONTRACT_IDS without an optional reason',
    expectedBlockerCode: 'report_contract_required_coverage_unclassified_contract',
    mutate(input) {
      input.requiredContractIds = input.requiredContractIds
        .filter((contractId) => contractId !== 'report_closeout_command_inventory_regression');
    },
  }),
  Object.freeze({
    scenarioId: 'optional_contract_reason_missing',
    label: 'An optional manifest contract has an empty optional reason',
    expectedBlockerCode: 'report_contract_required_coverage_optional_reason_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'synthetic_optional_report_contract',
        label: 'Synthetic optional report contract',
        scriptId: 'reports:synthetic-optional-report-contract',
        exporterPath: 'src/export-synthetic-optional-report-contract.mjs',
        stepIds: ['synthetic_optional_report_contract_export'],
        fileId: 'synthetic-optional-report-contract-latest.json',
        stdoutHashField: 'syntheticOptionalReportContractHash',
        gateSummaryHashKey: 'syntheticOptionalReportContractHash',
      });
      input.optionalContractReasons.synthetic_optional_report_contract = '';
    },
  }),
  Object.freeze({
    scenarioId: 'optional_contract_missing_from_manifest',
    label: 'An optional reason references a contract that is not in the manifest',
    expectedBlockerCode: 'report_contract_required_coverage_optional_contract_missing',
    mutate(input) {
      input.optionalContractReasons.synthetic_missing_optional_contract = 'temporary migration fixture';
    },
  }),
  Object.freeze({
    scenarioId: 'required_contract_missing_from_manifest',
    label: 'A required contract id is not present in the manifest',
    expectedBlockerCode: 'report_contract_required_coverage_required_contract_missing',
    mutate(input) {
      input.manifest = input.manifest
        .filter((contract) => contract.contractId !== 'report_runner_contract_regression');
    },
  }),
  Object.freeze({
    scenarioId: 'required_and_optional_overlap',
    label: 'A contract is both required and optional',
    expectedBlockerCode: 'report_contract_required_coverage_optional_required_overlap',
    mutate(input) {
      input.optionalContractReasons.report_runner_contract_regression = 'should not be optional';
    },
  }),
  Object.freeze({
    scenarioId: 'duplicate_required_contract_id',
    label: 'The required contract id list contains a duplicate',
    expectedBlockerCode: 'report_contract_required_coverage_duplicate_required_contract_id',
    mutate(input) {
      input.requiredContractIds.push('report_runner_contract_regression');
    },
  }),
  Object.freeze({
    scenarioId: 'required_ids_not_exported',
    label: 'The required contract id list stops being exported',
    expectedBlockerCode: 'report_contract_required_coverage_required_export_missing',
    mutate(input) {
      input.manifestSourceText = input.manifestSourceText
        .replace('export const REQUIRED_CONTRACT_IDS', 'const REQUIRED_CONTRACT_IDS');
    },
  }),
  Object.freeze({
    scenarioId: 'optional_reasons_not_exported',
    label: 'The optional contract reason map stops being exported',
    expectedBlockerCode: 'report_contract_required_coverage_optional_export_missing',
    mutate(input) {
      input.manifestSourceText = input.manifestSourceText
        .replace('export const REPORT_CONTRACT_MANIFEST_OPTIONAL_CONTRACT_REASONS', 'const REPORT_CONTRACT_MANIFEST_OPTIONAL_CONTRACT_REASONS');
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

function duplicateValues(values = []) {
  return values
    .filter((value, index, all) => values.indexOf(value) !== index)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    scriptId: contract.scriptId || null,
    fileId: contract.fileId || null,
  };
}

function normalizeOptionalReasons(optionalContractReasons = {}) {
  return Object.fromEntries(Object.entries(optionalContractReasons || {}).map(([contractId, reason]) => [
    contractId,
    String(reason || ''),
  ]));
}

function compactBlockers(blockers = []) {
  return blockers.map((item) => ({
    code: item.code,
    contractId: item.contractId || null,
    notes: item.notes,
  }));
}

function analyzeRequiredCoverage(input = {}) {
  const manifest = (input.manifest || []).map(normalizeContract);
  const manifestContractIds = manifest.map((contract) => contract.contractId).filter(Boolean);
  const requiredContractIds = [...(input.requiredContractIds || [])].filter(Boolean);
  const optionalContractReasons = normalizeOptionalReasons(input.optionalContractReasons || {});
  const optionalContractIds = Object.keys(optionalContractReasons).filter(Boolean);
  const manifestSet = new Set(manifestContractIds);
  const requiredSet = new Set(requiredContractIds);
  const optionalSet = new Set(optionalContractIds);
  const classifiedContractIds = uniqueSorted([
    ...requiredContractIds,
    ...optionalContractIds.filter((contractId) => optionalContractReasons[contractId].trim()),
  ]);
  const unclassifiedContractIds = manifestContractIds
    .filter((contractId) => !requiredSet.has(contractId))
    .filter((contractId) => !optionalContractReasons[contractId]?.trim())
    .sort((left, right) => left.localeCompare(right));
  const missingRequiredContractIds = requiredContractIds
    .filter((contractId) => !manifestSet.has(contractId))
    .sort((left, right) => left.localeCompare(right));
  const optionalMissingManifestContractIds = optionalContractIds
    .filter((contractId) => !manifestSet.has(contractId))
    .sort((left, right) => left.localeCompare(right));
  const optionalReasonMissingContractIds = optionalContractIds
    .filter((contractId) => !optionalContractReasons[contractId].trim())
    .sort((left, right) => left.localeCompare(right));
  const optionalRequiredOverlapContractIds = optionalContractIds
    .filter((contractId) => requiredSet.has(contractId))
    .sort((left, right) => left.localeCompare(right));
  const requiredExportPresent = /export\s+const\s+REQUIRED_CONTRACT_IDS\s*=/.test(input.manifestSourceText || '');
  const optionalExportPresent = /export\s+const\s+REPORT_CONTRACT_MANIFEST_OPTIONAL_CONTRACT_REASONS\s*=/.test(input.manifestSourceText || '');
  const blockers = [
    ...duplicateValues(requiredContractIds).map((contractId) => blocker(
      'report_contract_required_coverage_duplicate_required_contract_id',
      `${contractId} appears more than once in REQUIRED_CONTRACT_IDS.`,
      { contractId },
    )),
    ...unclassifiedContractIds.map((contractId) => blocker(
      'report_contract_required_coverage_unclassified_contract',
      `${contractId} must be listed in REQUIRED_CONTRACT_IDS or carry a non-empty optional reason.`,
      { contractId },
    )),
    ...missingRequiredContractIds.map((contractId) => blocker(
      'report_contract_required_coverage_required_contract_missing',
      `${contractId} is required but missing from REPORT_CONTRACT_MANIFEST.`,
      { contractId },
    )),
    ...optionalMissingManifestContractIds.map((contractId) => blocker(
      'report_contract_required_coverage_optional_contract_missing',
      `${contractId} has an optional reason but is missing from REPORT_CONTRACT_MANIFEST.`,
      { contractId },
    )),
    ...optionalReasonMissingContractIds.map((contractId) => blocker(
      'report_contract_required_coverage_optional_reason_missing',
      `${contractId} is optional but does not explain why.`,
      { contractId },
    )),
    ...optionalRequiredOverlapContractIds.map((contractId) => blocker(
      'report_contract_required_coverage_optional_required_overlap',
      `${contractId} cannot be both required and optional.`,
      { contractId },
    )),
    ...(!requiredExportPresent ? [blocker(
      'report_contract_required_coverage_required_export_missing',
      'REQUIRED_CONTRACT_IDS must remain exported for downstream guards.',
    )] : []),
    ...(!optionalExportPresent ? [blocker(
      'report_contract_required_coverage_optional_export_missing',
      'REPORT_CONTRACT_MANIFEST_OPTIONAL_CONTRACT_REASONS must remain exported for downstream guards.',
    )] : []),
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_required_coverage_analysis' : 'pass_report_contract_required_coverage_analysis',
    ok: blockers.length === 0,
    manifestContractIds: uniqueSorted(manifestContractIds),
    requiredContractIds: uniqueSorted(requiredContractIds),
    optionalContractReasons,
    optionalContractIds: uniqueSorted(optionalContractIds),
    classifiedContractIds,
    unclassifiedContractIds,
    missingRequiredContractIds,
    optionalMissingManifestContractIds,
    optionalReasonMissingContractIds,
    optionalRequiredOverlapContractIds,
    requiredExportPresent,
    optionalExportPresent,
    blockers,
  };
}

function compactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    manifestContractCount: (analysis.manifestContractIds || []).length,
    requiredContractCount: (analysis.requiredContractIds || []).length,
    optionalContractCount: (analysis.optionalContractIds || []).length,
    classifiedContractCount: (analysis.classifiedContractIds || []).length,
    unclassifiedContractCount: (analysis.unclassifiedContractIds || []).length,
    missingRequiredContractCount: (analysis.missingRequiredContractIds || []).length,
    optionalMissingManifestContractCount: (analysis.optionalMissingManifestContractIds || []).length,
    optionalReasonMissingContractCount: (analysis.optionalReasonMissingContractIds || []).length,
    optionalRequiredOverlapContractCount: (analysis.optionalRequiredOverlapContractIds || []).length,
    requiredExportPresent: analysis.requiredExportPresent === true,
    optionalExportPresent: analysis.optionalExportPresent === true,
    blockers: compactBlockers(analysis.blockers || []),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeRequiredCoverage(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_required_coverage_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail required coverage analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_required_coverage_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_required_coverage_scenario' : 'pass_report_contract_required_coverage_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractRequiredCoverageRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  requiredContractIds = REQUIRED_CONTRACT_IDS,
  optionalContractReasons = REPORT_CONTRACT_MANIFEST_OPTIONAL_CONTRACT_REASONS,
  manifestSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = {
    manifest: manifest.map((contract) => ({
      ...contract,
      stepIds: Array.isArray(contract.stepIds) ? [...contract.stepIds] : [],
    })),
    requiredContractIds: [...requiredContractIds],
    optionalContractReasons: normalizeOptionalReasons(optionalContractReasons),
    manifestSourceText: String(manifestSourceText || ''),
  };
  const actual = analyzeRequiredCoverage(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({ ...item, source: 'actual_required_coverage' })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_VERSION,
    kind: 'ReportContractRequiredCoverageRegression',
    status: blockers.length ? 'blocked_report_contract_required_coverage_regression' : 'pass_report_contract_required_coverage_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
    },
    actual: {
      ...compactAnalysis(actual),
      manifestContractIds: actual.manifestContractIds,
      requiredContractIds: actual.requiredContractIds,
      optionalContractIds: actual.optionalContractIds,
      unclassifiedContractIds: actual.unclassifiedContractIds,
      missingRequiredContractIds: actual.missingRequiredContractIds,
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      manifestContractCount: actual.manifestContractIds.length,
      requiredContractCount: actual.requiredContractIds.length,
      optionalContractCount: actual.optionalContractIds.length,
      classifiedContractCount: actual.classifiedContractIds.length,
      unclassifiedContractCount: actual.unclassifiedContractIds.length,
      missingRequiredContractCount: actual.missingRequiredContractIds.length,
      optionalReasonMissingContractCount: actual.optionalReasonMissingContractIds.length,
      optionalMissingManifestContractCount: actual.optionalMissingManifestContractIds.length,
      optionalRequiredOverlapContractCount: actual.optionalRequiredOverlapContractIds.length,
      requiredExportPresent: actual.requiredExportPresent === true,
      optionalExportPresent: actual.optionalExportPresent === true,
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
  const contractRequiredCoverageRegressionHash = digest({
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
    contractRequiredCoverageRegressionHash,
    hash: contractRequiredCoverageRegressionHash,
  };
}

export function summarizeReportContractRequiredCoverageRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_contract_required_coverage_regression',
    ok: report?.ok === true,
    contractRequiredCoverageRegressionHash: report?.contractRequiredCoverageRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    manifestContractCount: report?.summary?.manifestContractCount || 0,
    requiredContractCount: report?.summary?.requiredContractCount || 0,
    optionalContractCount: report?.summary?.optionalContractCount || 0,
    unclassifiedContractCount: report?.summary?.unclassifiedContractCount || 0,
    missingRequiredContractCount: report?.summary?.missingRequiredContractCount || 0,
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
