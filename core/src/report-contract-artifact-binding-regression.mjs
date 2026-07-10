import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_REPORT_FILE_ID = 'report-contract-artifact-binding-regression-latest.json';
export const REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_SCRIPT_ID = 'reports:contract-artifact-binding-regression';
export const REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_STEP_ID = 'report_contract_artifact_binding_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_safety_flag_regression';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_artifact_bindings',
    label: 'A new manifest contract is added without latest artifacts or cross-report bindings',
    expectedBlockerCode: 'report_contract_artifact_latest_json_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_artifact_binding',
        fileId: 'report-future-artifact-binding-latest.json',
        requiresFreshnessInventory: true,
      });
    },
  }),
  Object.freeze({
    scenarioId: 'latest_json_missing',
    label: 'A manifest contract latest JSON output disappears',
    expectedBlockerCode: 'report_contract_artifact_latest_json_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportArtifactsByFileId[contract.fileId].jsonExists = false;
    },
  }),
  Object.freeze({
    scenarioId: 'latest_markdown_missing',
    label: 'A manifest contract latest Markdown output disappears',
    expectedBlockerCode: 'report_contract_artifact_latest_markdown_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportArtifactsByFileId[contract.fileId].mdExists = false;
    },
  }),
  Object.freeze({
    scenarioId: 'readme_binding_missing',
    label: 'reports/README.md stops listing a manifest latest JSON output',
    expectedBlockerCode: 'report_contract_artifact_readme_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportsReadmeText = input.reportsReadmeText.replaceAll(contract.fileId, 'report-contract-artifact-binding-omitted-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'freshness_binding_missing',
    label: 'REPORT_FRESHNESS_REQUIRED_REPORTS stops seeing a manifest contract',
    expectedBlockerCode: 'report_contract_artifact_freshness_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.freshnessRequiredFileIds = input.freshnessRequiredFileIds.filter((fileId) => fileId !== contract.fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'tooling_binding_missing',
    label: 'Integration gate tooling report inventory stops seeing a manifest contract',
    expectedBlockerCode: 'report_contract_artifact_tooling_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.toolingReportFileIds = input.toolingReportFileIds.filter((fileId) => fileId !== contract.fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'schema_binding_missing',
    label: 'Report schema contract expected set stops seeing a manifest contract',
    expectedBlockerCode: 'report_contract_artifact_schema_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.schemaExpectedFileIds = input.schemaExpectedFileIds.filter((fileId) => fileId !== contract.fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'output_pairing_binding_missing',
    label: 'Report output pairing expected set stops seeing a manifest contract',
    expectedBlockerCode: 'report_contract_artifact_output_pairing_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.outputPairingExpectedFileIds = input.outputPairingExpectedFileIds.filter((fileId) => fileId !== contract.fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'artifact_reproducibility_binding_missing',
    label: 'Report artifact reproducibility expected set stops seeing a manifest contract',
    expectedBlockerCode: 'report_contract_artifact_reproducibility_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.artifactReproducibilityExpectedFileIds = input.artifactReproducibilityExpectedFileIds.filter((fileId) => fileId !== contract.fileId);
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

function markdownFileIdFor(fileId = '') {
  return String(fileId || '').replace(/\.json$/, '.md');
}

function includesReport(readmeText = '', fileId = '') {
  return String(readmeText || '').includes(fileId);
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    fileId: contract.fileId || null,
    requiresFreshnessInventory: contract.requiresFreshnessInventory !== false,
  };
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function bindingExpectations(contract = {}) {
  return {
    freshness: contract.requiresFreshnessInventory !== false,
    tooling: true,
    schema: contract.contractId !== 'report_schema_contract',
    outputPairing: contract.contractId !== 'report_output_pairing',
    artifactReproducibility: ![
      'report_schema_contract',
      'report_artifact_reproducibility',
    ].includes(contract.contractId),
  };
}

function skipReasons(contract = {}) {
  const expectations = bindingExpectations(contract);
  return {
    freshness: expectations.freshness ? null : 'freshness_report_self_cycle',
    schema: expectations.schema ? null : 'schema_report_self_cycle',
    outputPairing: expectations.outputPairing ? null : 'output_pairing_report_self_cycle',
    artifactReproducibility: expectations.artifactReproducibility ? null : 'artifact_reproducibility_self_or_schema_cycle',
  };
}

function bindingPresent(set, fileId) {
  return set.has(fileId);
}

function analyzeContract(contract = {}, input = {}) {
  const freshnessSet = new Set(input.freshnessRequiredFileIds || []);
  const toolingSet = new Set(input.toolingReportFileIds || []);
  const schemaSet = new Set(input.schemaExpectedFileIds || []);
  const outputPairingSet = new Set(input.outputPairingExpectedFileIds || []);
  const artifactReproducibilitySet = new Set(input.artifactReproducibilityExpectedFileIds || []);
  const artifact = input.reportArtifactsByFileId?.[contract.fileId] || {};
  const expectations = bindingExpectations(contract);
  const skips = skipReasons(contract);
  const jsonExists = artifact.jsonExists === true;
  const mdExists = artifact.mdExists === true;
  const readmeListed = includesReport(input.reportsReadmeText, contract.fileId);
  const bindings = {
    freshness: {
      expected: expectations.freshness,
      present: bindingPresent(freshnessSet, contract.fileId),
      skipReason: skips.freshness,
    },
    tooling: {
      expected: expectations.tooling,
      present: bindingPresent(toolingSet, contract.fileId),
      skipReason: null,
    },
    schema: {
      expected: expectations.schema,
      present: bindingPresent(schemaSet, contract.fileId),
      skipReason: skips.schema,
    },
    outputPairing: {
      expected: expectations.outputPairing,
      present: bindingPresent(outputPairingSet, contract.fileId),
      skipReason: skips.outputPairing,
    },
    artifactReproducibility: {
      expected: expectations.artifactReproducibility,
      present: bindingPresent(artifactReproducibilitySet, contract.fileId),
      skipReason: skips.artifactReproducibility,
    },
  };
  const blockers = [
    ...(jsonExists ? [] : [blocker(
      'report_contract_artifact_latest_json_missing',
      `${contract.fileId || 'unknown'} latest JSON output must exist for artifact binding analysis.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(mdExists ? [] : [blocker(
      'report_contract_artifact_latest_markdown_missing',
      `${markdownFileIdFor(contract.fileId)} latest Markdown output must exist for artifact binding analysis.`,
      { contractId: contract.contractId, fileId: contract.fileId, mdFileId: markdownFileIdFor(contract.fileId) },
    )]),
    ...(readmeListed ? [] : [blocker(
      'report_contract_artifact_readme_binding_missing',
      `reports/README.md must list ${contract.fileId}.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(!bindings.freshness.expected || bindings.freshness.present ? [] : [blocker(
      'report_contract_artifact_freshness_binding_missing',
      `${contract.fileId} must be present in REPORT_FRESHNESS_REQUIRED_REPORTS.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(!bindings.tooling.expected || bindings.tooling.present ? [] : [blocker(
      'report_contract_artifact_tooling_binding_missing',
      `${contract.fileId} must be present in INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(!bindings.schema.expected || bindings.schema.present ? [] : [blocker(
      'report_contract_artifact_schema_binding_missing',
      `${contract.fileId} must be present in report schema contract expected file ids.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(!bindings.outputPairing.expected || bindings.outputPairing.present ? [] : [blocker(
      'report_contract_artifact_output_pairing_binding_missing',
      `${contract.fileId} must be present in report output pairing expected file ids.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(!bindings.artifactReproducibility.expected || bindings.artifactReproducibility.present ? [] : [blocker(
      'report_contract_artifact_reproducibility_binding_missing',
      `${contract.fileId} must be present in report artifact reproducibility expected file ids.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
  ];
  return {
    contractId: contract.contractId,
    fileId: contract.fileId,
    mdFileId: markdownFileIdFor(contract.fileId),
    status: blockers.length ? 'blocked_report_contract_artifact_binding_contract' : 'pass_report_contract_artifact_binding_contract',
    ok: blockers.length === 0,
    jsonExists,
    mdExists,
    readmeListed,
    bindings,
    blockerCount: blockers.length,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    fileId: contract.fileId,
    mdFileId: contract.mdFileId,
    status: contract.status,
    ok: contract.ok === true,
    jsonExists: contract.jsonExists === true,
    mdExists: contract.mdExists === true,
    readmeListed: contract.readmeListed === true,
    bindings: Object.fromEntries(Object.entries(contract.bindings || {}).map(([key, binding]) => [
      key,
      {
        expected: binding.expected === true,
        present: binding.present === true,
        skipReason: binding.skipReason || null,
      },
    ])),
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
    })),
  };
}

function bindingCount(contracts = [], bindingId, predicate) {
  return contracts.filter((contract) => predicate(contract.bindings?.[bindingId] || {})).length;
}

function analyzeArtifactBindings(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_artifact_binding_analysis' : 'pass_report_contract_artifact_binding_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    jsonReportCount: contractAnalyses.filter((contract) => contract.jsonExists).length,
    markdownReportCount: contractAnalyses.filter((contract) => contract.mdExists).length,
    readmeBindingCount: contractAnalyses.filter((contract) => contract.readmeListed).length,
    freshnessExpectedCount: bindingCount(contractAnalyses, 'freshness', (binding) => binding.expected),
    freshnessBindingCount: bindingCount(contractAnalyses, 'freshness', (binding) => binding.expected && binding.present),
    toolingExpectedCount: bindingCount(contractAnalyses, 'tooling', (binding) => binding.expected),
    toolingBindingCount: bindingCount(contractAnalyses, 'tooling', (binding) => binding.expected && binding.present),
    schemaExpectedCount: bindingCount(contractAnalyses, 'schema', (binding) => binding.expected),
    schemaBindingCount: bindingCount(contractAnalyses, 'schema', (binding) => binding.expected && binding.present),
    outputPairingExpectedCount: bindingCount(contractAnalyses, 'outputPairing', (binding) => binding.expected),
    outputPairingBindingCount: bindingCount(contractAnalyses, 'outputPairing', (binding) => binding.expected && binding.present),
    artifactReproducibilityExpectedCount: bindingCount(contractAnalyses, 'artifactReproducibility', (binding) => binding.expected),
    artifactReproducibilityBindingCount: bindingCount(contractAnalyses, 'artifactReproducibility', (binding) => binding.expected && binding.present),
    skippedBindingCount: contractAnalyses.reduce((sum, contract) => sum + Object.values(contract.bindings)
      .filter((binding) => !binding.expected && binding.skipReason).length, 0),
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
    jsonReportCount: analysis.jsonReportCount || 0,
    markdownReportCount: analysis.markdownReportCount || 0,
    readmeBindingCount: analysis.readmeBindingCount || 0,
    freshnessExpectedCount: analysis.freshnessExpectedCount || 0,
    freshnessBindingCount: analysis.freshnessBindingCount || 0,
    toolingExpectedCount: analysis.toolingExpectedCount || 0,
    toolingBindingCount: analysis.toolingBindingCount || 0,
    schemaExpectedCount: analysis.schemaExpectedCount || 0,
    schemaBindingCount: analysis.schemaBindingCount || 0,
    outputPairingExpectedCount: analysis.outputPairingExpectedCount || 0,
    outputPairingBindingCount: analysis.outputPairingBindingCount || 0,
    artifactReproducibilityExpectedCount: analysis.artifactReproducibilityExpectedCount || 0,
    artifactReproducibilityBindingCount: analysis.artifactReproducibilityBindingCount || 0,
    skippedBindingCount: analysis.skippedBindingCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      fileId: item.fileId || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeArtifactBindings(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_artifact_binding_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract artifact binding analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_artifact_binding_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_artifact_binding_scenario' : 'pass_report_contract_artifact_binding_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractArtifactBindingRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  reportArtifactsByFileId = {},
  reportsReadmeText = '',
  freshnessRequiredFileIds = [],
  toolingReportFileIds = [],
  schemaExpectedFileIds = [],
  outputPairingExpectedFileIds = [],
  artifactReproducibilityExpectedFileIds = [],
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    reportArtifactsByFileId: { ...(reportArtifactsByFileId || {}) },
    reportsReadmeText: String(reportsReadmeText || ''),
    freshnessRequiredFileIds: uniqueSorted(freshnessRequiredFileIds),
    toolingReportFileIds: uniqueSorted(toolingReportFileIds),
    schemaExpectedFileIds: uniqueSorted(schemaExpectedFileIds),
    outputPairingExpectedFileIds: uniqueSorted(outputPairingExpectedFileIds),
    artifactReproducibilityExpectedFileIds: uniqueSorted(artifactReproducibilityExpectedFileIds),
  };
}

export function buildReportContractArtifactBindingRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  reportArtifactsByFileId = {},
  reportsReadmeText = '',
  freshnessRequiredFileIds = [],
  toolingReportFileIds = [],
  schemaExpectedFileIds = [],
  outputPairingExpectedFileIds = [],
  artifactReproducibilityExpectedFileIds = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractArtifactBindingRegressionInput({
    manifest,
    reportArtifactsByFileId,
    reportsReadmeText,
    freshnessRequiredFileIds,
    toolingReportFileIds,
    schemaExpectedFileIds,
    outputPairingExpectedFileIds,
    artifactReproducibilityExpectedFileIds,
  });
  const actual = analyzeArtifactBindings(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_artifact_bindings',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_VERSION,
    kind: 'ReportContractArtifactBindingRegression',
    status: blockers.length ? 'blocked_report_contract_artifact_binding_regression' : 'pass_report_contract_artifact_binding_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      freshnessRequiredFileIds: baseInput.freshnessRequiredFileIds,
      toolingReportFileIds: baseInput.toolingReportFileIds,
      schemaExpectedFileIds: baseInput.schemaExpectedFileIds,
      outputPairingExpectedFileIds: baseInput.outputPairingExpectedFileIds,
      artifactReproducibilityExpectedFileIds: baseInput.artifactReproducibilityExpectedFileIds,
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
      jsonReportCount: actual.jsonReportCount,
      markdownReportCount: actual.markdownReportCount,
      readmeBindingCount: actual.readmeBindingCount,
      freshnessExpectedCount: actual.freshnessExpectedCount,
      freshnessBindingCount: actual.freshnessBindingCount,
      toolingExpectedCount: actual.toolingExpectedCount,
      toolingBindingCount: actual.toolingBindingCount,
      schemaExpectedCount: actual.schemaExpectedCount,
      schemaBindingCount: actual.schemaBindingCount,
      outputPairingExpectedCount: actual.outputPairingExpectedCount,
      outputPairingBindingCount: actual.outputPairingBindingCount,
      artifactReproducibilityExpectedCount: actual.artifactReproducibilityExpectedCount,
      artifactReproducibilityBindingCount: actual.artifactReproducibilityBindingCount,
      skippedBindingCount: actual.skippedBindingCount,
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
  const contractArtifactBindingRegressionHash = digest({
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
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractArtifactBindingRegressionHash,
    hash: contractArtifactBindingRegressionHash,
  };
}

export function summarizeReportContractArtifactBindingRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractArtifactBindingRegressionHash: report.contractArtifactBindingRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    jsonReportCount: report.summary?.jsonReportCount ?? null,
    markdownReportCount: report.summary?.markdownReportCount ?? null,
    readmeBindingCount: report.summary?.readmeBindingCount ?? null,
    freshnessBindingCount: report.summary?.freshnessBindingCount ?? null,
    freshnessExpectedCount: report.summary?.freshnessExpectedCount ?? null,
    toolingBindingCount: report.summary?.toolingBindingCount ?? null,
    toolingExpectedCount: report.summary?.toolingExpectedCount ?? null,
    schemaBindingCount: report.summary?.schemaBindingCount ?? null,
    schemaExpectedCount: report.summary?.schemaExpectedCount ?? null,
    outputPairingBindingCount: report.summary?.outputPairingBindingCount ?? null,
    outputPairingExpectedCount: report.summary?.outputPairingExpectedCount ?? null,
    artifactReproducibilityBindingCount: report.summary?.artifactReproducibilityBindingCount ?? null,
    artifactReproducibilityExpectedCount: report.summary?.artifactReproducibilityExpectedCount ?? null,
    skippedBindingCount: report.summary?.skippedBindingCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
