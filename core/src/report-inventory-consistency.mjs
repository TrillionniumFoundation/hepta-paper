import { digest } from './hash-utils.mjs';
import {
  REPORT_FRESHNESS_GATE_REPORT,
  REPORT_FRESHNESS_REQUIRED_REPORTS,
} from './report-freshness.mjs';
import {
  INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS,
} from './integration-gate-tooling.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';

export const REPORT_INVENTORY_CONSISTENCY_VERSION = 1;

export const REPORT_INVENTORY_CONSISTENCY_REPORT_FILE_ID = 'report-inventory-consistency-latest.json';

export const REPORT_INVENTORY_CONSISTENCY_SCRIPT_ID = 'reports:inventory-consistency';

const REPORT_FRESHNESS_FILE_ID = 'report-freshness-latest.json';
const INTEGRATION_GATE_TOOLING_FILE_ID = 'integration-gate-tooling-latest.json';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'tooling_missing_freshness_report',
    label: 'Integration tooling omits a freshness-required report',
    expectedBlockerCode: 'report_inventory_tooling_missing_freshness_report',
    mutate(input) {
      input.toolingReportFileIds = input.toolingReportFileIds.filter((fileId) => fileId !== 'package-surface-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'tooling_untracked_extra_report',
    label: 'Integration tooling tracks a report outside the freshness inventory',
    expectedBlockerCode: 'report_inventory_tooling_untracked_report',
    mutate(input) {
      input.toolingReportFileIds.push('stray-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_missing_report',
    label: 'Architecture checkpoint omits a required latest report binding',
    expectedBlockerCode: 'report_inventory_checkpoint_missing_report',
    mutate(input) {
      input.checkpointBindings = input.checkpointBindings.filter((binding) => binding.filename !== 'report-freshness-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_key_missing',
    label: 'Integration gate source loses a freshness gate-summary hash key',
    expectedBlockerCode: 'report_inventory_gate_summary_hash_key_missing',
    mutate(input) {
      input.gateSummaryHashKeys = input.gateSummaryHashKeys.filter((key) => key !== 'packageSurfaceHash');
    },
  }),
  Object.freeze({
    scenarioId: 'required_script_missing',
    label: 'Package scripts lose a required local gate script',
    expectedBlockerCode: 'report_inventory_required_script_missing',
    mutate(input) {
      input.packageScriptIds = input.packageScriptIds.filter((scriptId) => scriptId !== 'reports:freshness');
    },
  }),
  Object.freeze({
    scenarioId: 'tooling_duplicate_report',
    label: 'Integration tooling contains a duplicated report file id',
    expectedBlockerCode: 'report_inventory_tooling_duplicate_file_id',
    mutate(input) {
      input.toolingReportFileIds.push('package-surface-latest.json');
    },
  }),
]);

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function duplicateValues(values = []) {
  return values
    .filter((value, index, all) => all.indexOf(value) !== index)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function expectedToolingReportFileIds(requiredReports = REPORT_FRESHNESS_REQUIRED_REPORTS) {
  return uniqueSorted([
    ...requiredReports
      .map((spec) => spec.fileId)
      .filter((fileId) => fileId !== INTEGRATION_GATE_TOOLING_FILE_ID),
    REPORT_FRESHNESS_FILE_ID,
  ]);
}

export function expectedCheckpointReportFileIds(requiredReports = REPORT_FRESHNESS_REQUIRED_REPORTS) {
  return uniqueSorted([
    ...requiredReports.map((spec) => spec.fileId),
    REPORT_FRESHNESS_FILE_ID,
    REPORT_FRESHNESS_GATE_REPORT.fileId,
  ]);
}

export function extractCheckpointReportBindings(sourceText = '') {
  const bindings = [];
  const pattern = /reportBinding\(\{\s*key:\s*'([^']+)'\s*,\s*filename:\s*'([^']+)'/g;
  for (const match of String(sourceText).matchAll(pattern)) {
    bindings.push({
      key: match[1],
      filename: match[2],
    });
  }
  return bindings;
}

export function extractGateSummaryHashKeys(sourceText = '') {
  const text = String(sourceText);
  const start = text.indexOf('summary: {');
  if (start < 0) return [];
  const end = text.indexOf('\n    },\n    blockers,', start);
  const summarySource = end < 0 ? text.slice(start) : text.slice(start, end);
  return uniqueSorted([...summarySource.matchAll(/([A-Za-z0-9]+Hash)\s*:/g)].map((match) => match[1]));
}

function setDiff(expected = [], actual = []) {
  const actualSet = new Set(actual);
  return expected.filter((value) => !actualSet.has(value));
}

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    freshnessRequiredReportCount: analysis.freshnessRequiredReportCount,
    toolingReportCount: analysis.toolingReportCount,
    expectedToolingReportCount: analysis.expectedToolingReportCount,
    checkpointBindingCount: analysis.checkpointBindingCount,
    expectedCheckpointBindingCount: analysis.expectedCheckpointBindingCount,
    gateSummaryHashKeyCount: analysis.gateSummaryHashKeyCount,
    requiredGateSummaryHashKeyCount: analysis.requiredGateSummaryHashKeyCount,
    requiredScriptCount: analysis.requiredScriptCount,
    presentRequiredScriptCount: analysis.presentRequiredScriptCount,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      key: item.key || null,
      scriptId: item.scriptId || null,
    })),
  };
}

export function buildReportInventoryInput({
  checkpointSourceText = '',
  gateSourceText = '',
  packageScriptIds = [],
  freshnessReports = REPORT_FRESHNESS_REQUIRED_REPORTS,
  toolingReportFileIds = INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  requiredScriptIds = INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS,
} = {}) {
  return {
    freshnessReports: freshnessReports.map((spec) => ({
      key: spec.key,
      fileId: spec.fileId,
      gateSummaryHashKey: spec.gateSummaryHashKey || null,
    })),
    toolingReportFileIds: [...toolingReportFileIds],
    checkpointBindings: extractCheckpointReportBindings(checkpointSourceText),
    gateSummaryHashKeys: extractGateSummaryHashKeys(gateSourceText),
    gateStepIds: extractIntegrationGateStepSpecs(gateSourceText).map((step) => step.stepId),
    packageScriptIds: [...packageScriptIds],
    requiredScriptIds: [...requiredScriptIds],
  };
}

export function analyzeReportInventoryConsistency(input = {}) {
  const freshnessReports = input.freshnessReports || [];
  const freshnessFileIds = freshnessReports.map((spec) => spec.fileId);
  const freshnessGateSummaryHashKeys = freshnessReports
    .map((spec) => spec.gateSummaryHashKey)
    .filter(Boolean);
  const toolingReportFileIds = input.toolingReportFileIds || [];
  const checkpointBindings = input.checkpointBindings || [];
  const checkpointFileIds = checkpointBindings.map((binding) => binding.filename);
  const gateSummaryHashKeys = input.gateSummaryHashKeys || [];
  const packageScriptIds = input.packageScriptIds || [];
  const requiredScriptIds = input.requiredScriptIds || [];
  const expectedTooling = expectedToolingReportFileIds(freshnessReports);
  const expectedCheckpoint = expectedCheckpointReportFileIds(freshnessReports);
  const blockers = [
    ...duplicateValues(freshnessFileIds).map((fileId) => ({
      code: 'report_inventory_freshness_duplicate_file_id',
      fileId,
      notes: `${fileId} appears more than once in REPORT_FRESHNESS_REQUIRED_REPORTS.`,
    })),
    ...duplicateValues(toolingReportFileIds).map((fileId) => ({
      code: 'report_inventory_tooling_duplicate_file_id',
      fileId,
      notes: `${fileId} appears more than once in INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS.`,
    })),
    ...duplicateValues(checkpointFileIds).map((fileId) => ({
      code: 'report_inventory_checkpoint_duplicate_file_id',
      fileId,
      notes: `${fileId} appears more than once in architecture checkpoint report bindings.`,
    })),
    ...setDiff(expectedTooling, toolingReportFileIds).map((fileId) => ({
      code: 'report_inventory_tooling_missing_freshness_report',
      fileId,
      notes: `${fileId} is required by report freshness but missing from integration gate tooling report inventory.`,
    })),
    ...setDiff(uniqueSorted(toolingReportFileIds), expectedTooling).map((fileId) => ({
      code: 'report_inventory_tooling_untracked_report',
      fileId,
      notes: `${fileId} is tracked by integration gate tooling but not by report freshness or report freshness itself.`,
    })),
    ...setDiff(expectedCheckpoint, checkpointFileIds).map((fileId) => ({
      code: 'report_inventory_checkpoint_missing_report',
      fileId,
      notes: `${fileId} must be bound by architecture checkpoint reports.`,
    })),
    ...setDiff(uniqueSorted(checkpointFileIds), expectedCheckpoint).map((fileId) => ({
      code: 'report_inventory_checkpoint_untracked_report',
      fileId,
      notes: `${fileId} is bound by architecture checkpoint but outside the required report inventory.`,
    })),
    ...setDiff(uniqueSorted(freshnessGateSummaryHashKeys), gateSummaryHashKeys).map((key) => ({
      code: 'report_inventory_gate_summary_hash_key_missing',
      key,
      notes: `${key} is referenced by report freshness but missing from integration dependency gate summary source.`,
    })),
    ...setDiff(requiredScriptIds, packageScriptIds).map((scriptId) => ({
      code: 'report_inventory_required_script_missing',
      scriptId,
      notes: `${scriptId} is required by integration gate tooling but missing from package.json scripts.`,
    })),
  ];
  return {
    status: blockers.length ? 'blocked_report_inventory_consistency_analysis' : 'pass_report_inventory_consistency_analysis',
    ok: blockers.length === 0,
    freshnessRequiredReportCount: freshnessReports.length,
    freshnessRequiredReportFileIds: uniqueSorted(freshnessFileIds),
    toolingReportCount: toolingReportFileIds.length,
    expectedToolingReportCount: expectedTooling.length,
    toolingReportFileIds: uniqueSorted(toolingReportFileIds),
    expectedToolingReportFileIds: expectedTooling,
    checkpointBindingCount: checkpointBindings.length,
    expectedCheckpointBindingCount: expectedCheckpoint.length,
    checkpointFileIds: uniqueSorted(checkpointFileIds),
    expectedCheckpointFileIds: expectedCheckpoint,
    gateSummaryHashKeyCount: gateSummaryHashKeys.length,
    requiredGateSummaryHashKeyCount: uniqueSorted(freshnessGateSummaryHashKeys).length,
    gateSummaryHashKeys: uniqueSorted(gateSummaryHashKeys),
    requiredGateSummaryHashKeys: uniqueSorted(freshnessGateSummaryHashKeys),
    requiredScriptCount: requiredScriptIds.length,
    presentRequiredScriptCount: requiredScriptIds.filter((scriptId) => packageScriptIds.includes(scriptId)).length,
    requiredScriptIds: uniqueSorted(requiredScriptIds),
    packageScriptIds: uniqueSorted(packageScriptIds),
    blockers,
  };
}

function runScenario(scenario, baselineInput) {
  const input = clone(baselineInput);
  scenario.mutate(input);
  const analysis = analyzeReportInventoryConsistency(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [{
      code: 'report_inventory_consistency_scenario_unexpectedly_passed',
      notes: `${scenario.scenarioId} must make report inventory consistency fail.`,
    }] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [{
      code: 'report_inventory_consistency_expected_blocker_missing',
      notes: `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, got ${observedBlockerCodes.join(', ') || 'none'}.`,
    }] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_inventory_consistency_scenario' : 'pass_report_inventory_consistency_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportInventoryConsistencyReport({
  checkpointSourceText = '',
  gateSourceText = '',
  packageScriptIds = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const input = buildReportInventoryInput({
    checkpointSourceText,
    gateSourceText,
    packageScriptIds,
  });
  const actual = analyzeReportInventoryConsistency(input);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, input));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_inventory',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_INVENTORY_CONSISTENCY_VERSION,
    kind: 'ReportInventoryConsistency',
    status: blockers.length ? 'blocked_report_inventory_consistency' : 'pass_report_inventory_consistency',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_INVENTORY_CONSISTENCY_REPORT_FILE_ID,
    scriptId: REPORT_INVENTORY_CONSISTENCY_SCRIPT_ID,
    actual: compactAnalysis(actual),
    inventory: {
      freshnessRequiredReportFileIds: actual.freshnessRequiredReportFileIds,
      toolingReportFileIds: actual.toolingReportFileIds,
      expectedToolingReportFileIds: actual.expectedToolingReportFileIds,
      checkpointFileIds: actual.checkpointFileIds,
      expectedCheckpointFileIds: actual.expectedCheckpointFileIds,
      requiredGateSummaryHashKeys: actual.requiredGateSummaryHashKeys,
      gateSummaryHashKeys: actual.gateSummaryHashKeys,
      requiredScriptIds: actual.requiredScriptIds,
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      freshnessRequiredReportCount: actual.freshnessRequiredReportCount,
      toolingReportCount: actual.toolingReportCount,
      expectedToolingReportCount: actual.expectedToolingReportCount,
      checkpointBindingCount: actual.checkpointBindingCount,
      expectedCheckpointBindingCount: actual.expectedCheckpointBindingCount,
      gateSummaryHashKeyCount: actual.gateSummaryHashKeyCount,
      requiredGateSummaryHashKeyCount: actual.requiredGateSummaryHashKeyCount,
      requiredScriptCount: actual.requiredScriptCount,
      presentRequiredScriptCount: actual.presentRequiredScriptCount,
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
      sourceInspectionOnly: true,
      syntheticFixtureOnly: true,
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
  const inventoryConsistencyHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    actual: report.actual,
    inventory: report.inventory,
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
    inventoryConsistencyHash,
    hash: inventoryConsistencyHash,
  };
}

export function summarizeReportInventoryConsistencyReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_inventory_consistency',
    ok: report?.ok === true,
    inventoryConsistencyHash: report?.inventoryConsistencyHash || null,
    actualOk: report?.summary?.actualOk === true,
    freshnessRequiredReportCount: report?.summary?.freshnessRequiredReportCount || 0,
    toolingReportCount: report?.summary?.toolingReportCount || 0,
    checkpointBindingCount: report?.summary?.checkpointBindingCount || 0,
    requiredGateSummaryHashKeyCount: report?.summary?.requiredGateSummaryHashKeyCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: true,
      readOnly: true,
      sourceInspectionOnly: true,
      syntheticFixtureOnly: true,
      executesExternalAction: false,
    },
  };
}
