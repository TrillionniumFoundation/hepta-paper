import { digest } from './hash-utils.mjs';
import {
  REPORT_FRESHNESS_GATE_REPORT,
  REPORT_FRESHNESS_REQUIRED_REPORTS,
} from './report-freshness.mjs';

export const REPORT_SCHEMA_CONTRACT_VERSION = 1;

export const REPORT_SCHEMA_CONTRACT_REPORT_FILE_ID = 'report-schema-contract-latest.json';

export const REPORT_SCHEMA_CONTRACT_SCRIPT_ID = 'reports:schema-contract';

const REPORT_FRESHNESS_FILE_ID = 'report-freshness-latest.json';

const HASH_FIELD_IDS = Object.freeze([
  'freshnessHash',
  'freshnessRegressionHash',
  'sequenceRegressionHash',
  'inventoryConsistencyHash',
  'schemaContractHash',
  'lineageTopologyHash',
  'hashStabilityRegressionHash',
  'outputPairingHash',
  'artifactReproducibilityHash',
  'selfReferenceBoundaryRegressionHash',
  'contractManifestHash',
  'contractSyntaxCoverageRegressionHash',
  'contractSourceDerivationRegressionHash',
  'contractAuditForwardingRegressionHash',
  'contractCheckpointBindingShapeRegressionHash',
  'contractGateSummaryShapeRegressionHash',
  'contractExporterStdoutShapeRegressionHash',
  'contractSafetyFlagRegressionHash',
  'contractArtifactBindingRegressionHash',
  'contractDocIndexAnchorRegressionHash',
  'contractDocPageLatestDetailRegressionHash',
  'contractDocPageCommandSectionRegressionHash',
  'contractDocPageSafetySectionDetailRegressionHash',
  'contractDocPageStrictGateSectionRegressionHash',
  'contractDocPageOutputSectionRegressionHash',
  'contractDocPageCrossReportSectionRegressionHash',
  'contractDocPageCloseoutSectionRegressionHash',
  'contractDocPagePostGateWriterSectionRegressionHash',
  'contractDocPageRetentionSectionRegressionHash',
  'contractDocPageFreshnessHashSectionRegressionHash',
  'contractDocPageCheckpointHashSectionRegressionHash',
  'latestRecoveryRegressionHash',
  'runnerContractRegressionHash',
  'retentionRegressionHash',
  'channelRunnerCoverageMatrixHash',
  'postActionReconciliationMatrixHash',
  'postActionDispatchCompletionMatrixHash',
  'postActionDispatchEnvelopeMatrixHash',
  'postActionReplayGuardMatrixHash',
  'postActionAuditArchiveMatrixHash',
  'postActionAuditBundleMatrixHash',
  'postActionEvidenceMatrixHash',
  'toolingHash',
  'checkpointHash',
  'policyHash',
  'chainHash',
  'reportHash',
  'gateHash',
  'auditHash',
  'schemaHash',
  'retentionHash',
  'surfaceHash',
  'allowlistHash',
  'resolverHash',
  'migrationHash',
  'regressionHash',
  'symbolManifestHash',
  'symbolRegressionHash',
  'symbolMinimizationHash',
  'healthHash',
  'verificationHash',
  'archiveHash',
  'archiveCloseoutHash',
  'summaryHash',
  'syntheticHash',
  'hash',
]);

const EXTERNAL_SAFETY_FLAG_IDS = Object.freeze([
  'executesExternalAction',
  'touchesPlatforms',
  'providerSpend',
  'browserAutomation',
  'upload',
  'uploads',
  'submit',
  'submits',
  'messaging',
  'sendsMessages',
  'payment',
  'pays',
  'acceptance',
  'acceptsDelivery',
  'deployment',
  'deploys',
  'fetchesChannelState',
  'appliesLocalStateTransition',
  'grantsExecutionPermission',
]);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_required_report',
    label: 'A required latest report is missing',
    expectedBlockerCode: 'report_schema_contract_report_missing',
    mutate(records) {
      return records.filter((record) => record.fileId !== 'package-surface-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'kind_missing',
    label: 'A report loses its kind field',
    expectedBlockerCode: 'report_schema_contract_kind_missing',
    mutate(records) {
      return mutateReport(records, 'package-surface-latest.json', (report) => {
        delete report.kind;
      });
    },
  }),
  Object.freeze({
    scenarioId: 'ok_false',
    label: 'A report flips ok=false',
    expectedBlockerCode: 'report_schema_contract_ok_false',
    mutate(records) {
      return mutateReport(records, 'package-surface-latest.json', (report) => {
        report.ok = false;
        report.status = 'blocked_package_surface';
      });
    },
  }),
  Object.freeze({
    scenarioId: 'stable_hash_missing',
    label: 'A report loses every stable hash field',
    expectedBlockerCode: 'report_schema_contract_stable_hash_missing',
    mutate(records) {
      return mutateReport(records, 'package-surface-latest.json', (report) => {
        for (const fieldId of HASH_FIELD_IDS) delete report[fieldId];
        if (report.snapshot) delete report.snapshot.schemaHash;
      });
    },
  }),
  Object.freeze({
    scenarioId: 'top_hash_mismatch',
    label: 'A report hash alias drifts from its primary hash',
    expectedBlockerCode: 'report_schema_contract_top_hash_mismatch',
    mutate(records) {
      return mutateReport(records, 'package-surface-latest.json', (report) => {
        report.hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      });
    },
  }),
  Object.freeze({
    scenarioId: 'unsafe_external_flag',
    label: 'A report safety block grants an external action',
    expectedBlockerCode: 'report_schema_contract_external_safety_flag_true',
    mutate(records) {
      return mutateReport(records, 'package-surface-latest.json', (report) => {
        report.safety = { ...(report.safety || {}), submit: true };
      });
    },
  }),
  Object.freeze({
    scenarioId: 'blockers_not_array',
    label: 'A report blockers field becomes non-array',
    expectedBlockerCode: 'report_schema_contract_blockers_not_array',
    mutate(records) {
      return mutateReport(records, 'package-surface-latest.json', (report) => {
        report.blockers = 'none';
      });
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function mutateReport(records, fileId, mutate) {
  return records.map((record) => {
    if (record.fileId !== fileId) return record;
    const next = clone(record);
    mutate(next.report);
    return next;
  });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function reportStableHash(report = {}) {
  for (const fieldId of HASH_FIELD_IDS.filter((fieldId) => fieldId !== 'hash')) {
    if (typeof report?.[fieldId] === 'string' && report[fieldId]) return report[fieldId];
  }
  if (typeof report?.snapshot?.schemaHash === 'string' && report.snapshot.schemaHash) {
    return report.snapshot.schemaHash;
  }
  if (typeof report?.hash === 'string' && report.hash) return report.hash;
  return null;
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ''));
}

export function expectedReportSchemaContractFileIds(requiredReports = REPORT_FRESHNESS_REQUIRED_REPORTS, {
  includeGateReport = true,
} = {}) {
  return uniqueSorted([
    ...requiredReports
      .map((spec) => spec.fileId)
      .filter((fileId) => fileId !== REPORT_SCHEMA_CONTRACT_REPORT_FILE_ID),
    REPORT_FRESHNESS_FILE_ID,
    ...(includeGateReport ? [REPORT_FRESHNESS_GATE_REPORT.fileId] : []),
  ]);
}

function blocker(code, fileId, notes, extra = {}) {
  return { code, fileId, notes, ...extra };
}

function analyzeReportRecord(record) {
  const { fileId, report } = record;
  if (!isObject(report)) {
    return {
      fileId,
      ok: false,
      status: 'blocked_report_schema_contract_record',
      stableHash: null,
      blockers: [blocker(
        'report_schema_contract_report_not_object',
        fileId,
        `${fileId} must parse to a JSON object.`,
      )],
    };
  }
  const stableHash = reportStableHash(report);
  const blockers = [
    ...(!report.kind || typeof report.kind !== 'string' ? [blocker(
      'report_schema_contract_kind_missing',
      fileId,
      `${fileId} must expose a non-empty kind string.`,
    )] : []),
    ...(!report.status || typeof report.status !== 'string' ? [blocker(
      'report_schema_contract_status_missing',
      fileId,
      `${fileId} must expose a non-empty status string.`,
    )] : []),
    ...(report.status && !/^(pass|ready)_/.test(String(report.status)) ? [blocker(
      'report_schema_contract_status_not_passing',
      fileId,
      `${fileId} status must be pass_* or ready_* for a latest report contract.`,
      { status: report.status },
    )] : []),
    ...(typeof report.ok !== 'boolean' ? [blocker(
      'report_schema_contract_ok_not_boolean',
      fileId,
      `${fileId} must expose ok as a boolean.`,
    )] : []),
    ...(report.ok === false ? [blocker(
      'report_schema_contract_ok_false',
      fileId,
      `${fileId} reports ok=false.`,
    )] : []),
    ...(!report.generatedAt || typeof report.generatedAt !== 'string' ? [blocker(
      'report_schema_contract_generated_at_missing',
      fileId,
      `${fileId} must expose generatedAt as a string.`,
    )] : []),
    ...(!stableHash ? [blocker(
      'report_schema_contract_stable_hash_missing',
      fileId,
      `${fileId} must expose a stable sha256 hash field.`,
    )] : []),
    ...(stableHash && !isSha256(stableHash) ? [blocker(
      'report_schema_contract_stable_hash_invalid',
      fileId,
      `${fileId} stable hash is not a sha256 digest.`,
      { stableHash },
    )] : []),
    ...(report.hash && stableHash && report.hash !== stableHash ? [blocker(
      'report_schema_contract_top_hash_mismatch',
      fileId,
      `${fileId} top-level hash must match the report's primary stable hash.`,
      { stableHash, hash: report.hash },
    )] : []),
    ...(!isObject(report.safety) ? [blocker(
      'report_schema_contract_safety_missing',
      fileId,
      `${fileId} must expose a safety object.`,
    )] : []),
    ...(isObject(report.safety)
      ? EXTERNAL_SAFETY_FLAG_IDS
        .filter((flagId) => report.safety[flagId] === true)
        .map((flagId) => blocker(
          'report_schema_contract_external_safety_flag_true',
          fileId,
          `${fileId} safety.${flagId} must not be true for local report contract tooling.`,
          { flagId },
        ))
      : []),
    ...(Object.prototype.hasOwnProperty.call(report, 'blockers') && !Array.isArray(report.blockers) ? [blocker(
      'report_schema_contract_blockers_not_array',
      fileId,
      `${fileId} blockers must be an array when present.`,
    )] : []),
    ...(Array.isArray(report.blockers)
      && typeof report.summary?.blockerCount === 'number'
      && report.summary.blockerCount !== report.blockers.length ? [blocker(
        'report_schema_contract_summary_blocker_count_mismatch',
        fileId,
        `${fileId} summary.blockerCount must match blockers.length.`,
        { summaryBlockerCount: report.summary.blockerCount, blockerCount: report.blockers.length },
      )] : []),
  ];
  return {
    fileId,
    kind: report.kind || null,
    status: report.status || null,
    ok: blockers.length === 0,
    generatedAt: report.generatedAt || null,
    stableHash,
    topHash: report.hash || null,
    hasSummary: isObject(report.summary),
    hasBlockersArray: Array.isArray(report.blockers),
    hasSafety: isObject(report.safety),
    externalSafetyTrueFlags: isObject(report.safety)
      ? EXTERNAL_SAFETY_FLAG_IDS.filter((flagId) => report.safety[flagId] === true)
      : [],
    blockers,
  };
}

export function analyzeReportSchemaContract({
  expectedFileIds = [],
  records = [],
} = {}) {
  const byFileId = Object.fromEntries(records.map((record) => [record.fileId, record]));
  const missingRecords = expectedFileIds
    .filter((fileId) => !byFileId[fileId])
    .map((fileId) => blocker(
      'report_schema_contract_report_missing',
      fileId,
      `${fileId} is required by the latest report schema contract but was not provided.`,
    ));
  const analyzedRecords = expectedFileIds
    .filter((fileId) => byFileId[fileId])
    .map((fileId) => analyzeReportRecord(byFileId[fileId]));
  const blockers = [
    ...missingRecords,
    ...analyzedRecords.flatMap((record) => record.blockers),
  ];
  return {
    status: blockers.length ? 'blocked_report_schema_contract_analysis' : 'pass_report_schema_contract_analysis',
    ok: blockers.length === 0,
    expectedReportCount: expectedFileIds.length,
    analyzedReportCount: analyzedRecords.length,
    passedReportCount: analyzedRecords.filter((record) => record.ok).length,
    missingReportCount: missingRecords.length,
    hashableReportCount: analyzedRecords.filter((record) => isSha256(record.stableHash)).length,
    safetyReportCount: analyzedRecords.filter((record) => record.hasSafety).length,
    blockerCount: blockers.length,
    expectedFileIds: uniqueSorted(expectedFileIds),
    records: analyzedRecords,
    blockers,
  };
}

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    expectedReportCount: analysis.expectedReportCount,
    analyzedReportCount: analysis.analyzedReportCount,
    passedReportCount: analysis.passedReportCount,
    missingReportCount: analysis.missingReportCount,
    hashableReportCount: analysis.hashableReportCount,
    safetyReportCount: analysis.safetyReportCount,
    blockerCount: analysis.blockerCount,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      flagId: item.flagId || null,
    })),
  };
}

function runScenario(scenario, expectedFileIds, records) {
  const mutatedRecords = scenario.mutate(clone(records));
  const analysis = analyzeReportSchemaContract({ expectedFileIds, records: mutatedRecords });
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [{
      code: 'report_schema_contract_scenario_unexpectedly_passed',
      notes: `${scenario.scenarioId} must make report schema contract analysis fail.`,
    }] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [{
      code: 'report_schema_contract_expected_blocker_missing',
      notes: `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, got ${observedBlockerCodes.join(', ') || 'none'}.`,
    }] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_schema_contract_scenario' : 'pass_report_schema_contract_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportSchemaContractReport({
  expectedFileIds = expectedReportSchemaContractFileIds(),
  records = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedExpectedFileIds = uniqueSorted(expectedFileIds);
  const actual = analyzeReportSchemaContract({
    expectedFileIds: normalizedExpectedFileIds,
    records,
  });
  const scenarioBaselineRecords = buildScenarioBaselineRecords();
  const scenarioExpectedFileIds = scenarioBaselineRecords.map((record) => record.fileId);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(
    scenario,
    scenarioExpectedFileIds,
    scenarioBaselineRecords,
  ));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_reports',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_SCHEMA_CONTRACT_VERSION,
    kind: 'ReportSchemaContract',
    status: blockers.length ? 'blocked_report_schema_contract' : 'pass_report_schema_contract',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_SCHEMA_CONTRACT_REPORT_FILE_ID,
    scriptId: REPORT_SCHEMA_CONTRACT_SCRIPT_ID,
    expectedFileIds: normalizedExpectedFileIds,
    actual: compactAnalysis(actual),
    records: actual.records.map((record) => ({
      fileId: record.fileId,
      kind: record.kind,
      status: record.status,
      ok: record.ok,
      stableHash: record.stableHash,
      hasSummary: record.hasSummary,
      hasBlockersArray: record.hasBlockersArray,
      hasSafety: record.hasSafety,
      externalSafetyTrueFlags: record.externalSafetyTrueFlags,
      blockerCount: record.blockers.length,
    })),
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      expectedReportCount: actual.expectedReportCount,
      analyzedReportCount: actual.analyzedReportCount,
      passedReportCount: actual.passedReportCount,
      missingReportCount: actual.missingReportCount,
      hashableReportCount: actual.hashableReportCount,
      safetyReportCount: actual.safetyReportCount,
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
  const schemaContractHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    expectedFileIds: report.expectedFileIds,
    actual: report.actual,
    records: report.records,
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
    schemaContractHash,
    hash: schemaContractHash,
  };
}

export function summarizeReportSchemaContractReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_schema_contract',
    ok: report?.ok === true,
    schemaContractHash: report?.schemaContractHash || null,
    actualOk: report?.summary?.actualOk === true,
    expectedReportCount: report?.summary?.expectedReportCount || 0,
    passedReportCount: report?.summary?.passedReportCount || 0,
    hashableReportCount: report?.summary?.hashableReportCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      executesExternalAction: false,
    },
  };
}

function buildScenarioBaselineRecords() {
  const baseReport = {
    version: 1,
    kind: 'SyntheticLatestReport',
    status: 'pass_synthetic_latest_report',
    ok: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
    summary: {
      blockerCount: 0,
    },
    blockers: [],
    safety: {
      localOnly: true,
      readOnly: true,
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
    syntheticHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  };
  return [
    'package-surface-latest.json',
    'report-freshness-latest.json',
    'integration-dependency-gate-latest.json',
  ].map((fileId, index) => {
    const hash = `sha256:${String(index + 1).repeat(64)}`;
    return {
      fileId,
      report: {
        ...clone(baseReport),
        kind: `SyntheticLatestReport${index + 1}`,
        syntheticHash: hash,
        hash,
      },
    };
  });
}
