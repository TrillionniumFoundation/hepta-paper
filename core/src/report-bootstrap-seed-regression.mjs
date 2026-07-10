import { digest } from './hash-utils.mjs';
import {
  REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS,
} from './report-latest-recovery-regression.mjs';

export const REPORT_BOOTSTRAP_SEED_REGRESSION_VERSION = 1;

export const REPORT_BOOTSTRAP_SEED_REGRESSION_REPORT_FILE_ID = 'report-bootstrap-seed-regression-latest.json';

export const REPORT_BOOTSTRAP_SEED_REGRESSION_SCRIPT_ID = 'reports:bootstrap-seed-regression';

export const REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS = REPORT_LATEST_RECOVERY_CONTAMINATED_FILE_IDS;

export const REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS = Object.freeze({
  'integration-dependency-audit-latest.json': 'integrationAuditHash',
  'integration-gate-tooling-latest.json': 'integrationGateToolingHash',
  'report-freshness-latest.json': 'reportFreshnessHash',
  'report-schema-contract-latest.json': 'reportSchemaContractHash',
  'integration-dependency-gate-latest.json': 'gateHash',
});

const REPORT_BOOTSTRAP_SEED_HASH_KEYS = Object.freeze({
  'integration-dependency-audit-latest.json': Object.freeze(['integrationAuditHash', 'auditHash']),
  'integration-gate-tooling-latest.json': Object.freeze(['integrationGateToolingHash', 'toolingHash']),
  'report-freshness-latest.json': Object.freeze(['reportFreshnessHash', 'freshnessHash']),
  'report-schema-contract-latest.json': Object.freeze(['reportSchemaContractHash', 'schemaContractHash']),
  'integration-dependency-gate-latest.json': Object.freeze(['gateHash']),
});

const FIXTURE_GENERATED_AT = '2026-01-01T00:00:00.000Z';
export const REPORT_BOOTSTRAP_SEED_STATUS = 'pass_bootstrap_seed_report';
const FINAL_STATUS = 'pass_recovered_latest_report';
export const REPORT_BOOTSTRAP_SEED_REASON = 'break_latest_report_self_reference_cycle';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'unauthorized_seed_file',
    label: 'A bootstrap seed is created for a report outside the allowlist',
    expectedBlockerCode: 'report_bootstrap_seed_file_not_allowed',
    mutate(input) {
      input.seedReports['report-output-pairing-latest.json'] = buildBootstrapSeedReport('report-output-pairing-latest.json');
    },
  }),
  Object.freeze({
    scenarioId: 'missing_allowed_seed',
    label: 'A required cycle-breaking seed is missing',
    expectedBlockerCode: 'report_bootstrap_seed_required_seed_missing',
    mutate(input) {
      delete input.seedReports['integration-dependency-audit-latest.json'];
    },
  }),
  Object.freeze({
    scenarioId: 'seed_not_ok',
    label: 'A bootstrap seed is still not ok',
    expectedBlockerCode: 'report_bootstrap_seed_not_ok',
    mutate(input) {
      input.seedReports['integration-gate-tooling-latest.json'] = {
        ...input.seedReports['integration-gate-tooling-latest.json'],
        ok: false,
        status: 'blocked_bootstrap_seed_report',
      };
    },
  }),
  Object.freeze({
    scenarioId: 'seed_hash_missing',
    label: 'A bootstrap seed loses both stable hash fields',
    expectedBlockerCode: 'report_bootstrap_seed_hash_missing',
    mutate(input) {
      const fileId = 'report-freshness-latest.json';
      const report = deleteSemanticHashAliases(input.seedReports[fileId], fileId);
      delete report.hash;
      input.seedReports[fileId] = report;
    },
  }),
  Object.freeze({
    scenarioId: 'seed_hash_alias_stripped',
    label: 'A bootstrap seed keeps only generic hash after losing its semantic report hash',
    expectedBlockerCode: 'report_bootstrap_seed_hash_missing',
    mutate(input) {
      const fileId = 'report-freshness-latest.json';
      input.seedReports[fileId] = deleteSemanticHashAliases(input.seedReports[fileId], fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'seed_marker_missing',
    label: 'A bootstrap seed loses its explicit bootstrap marker',
    expectedBlockerCode: 'report_bootstrap_seed_marker_missing',
    mutate(input) {
      const report = {
        ...input.seedReports['report-schema-contract-latest.json'],
        summary: {
          ...input.seedReports['report-schema-contract-latest.json'].summary,
          bootstrapSeed: false,
        },
      };
      delete report.bootstrapSeed;
      input.seedReports['report-schema-contract-latest.json'] = report;
    },
  }),
  Object.freeze({
    scenarioId: 'seed_reason_missing',
    label: 'A bootstrap seed loses the reason binding that limits its use',
    expectedBlockerCode: 'report_bootstrap_seed_reason_missing',
    mutate(input) {
      input.seedReports['integration-dependency-gate-latest.json'] = {
        ...input.seedReports['integration-dependency-gate-latest.json'],
        seedReason: '',
      };
    },
  }),
  Object.freeze({
    scenarioId: 'seed_mutates_report_files_flag_missing',
    label: 'A bootstrap seed loses the explicit report-file mutation safety flag',
    expectedBlockerCode: 'report_bootstrap_seed_mutates_report_files_flag_missing',
    mutate(input) {
      const report = {
        ...input.seedReports['report-freshness-latest.json'],
        safety: {
          ...input.seedReports['report-freshness-latest.json'].safety,
        },
      };
      delete report.safety.mutatesReportFiles;
      input.seedReports['report-freshness-latest.json'] = report;
    },
  }),
  Object.freeze({
    scenarioId: 'final_report_missing',
    label: 'A final recovered report is missing for a seeded file',
    expectedBlockerCode: 'report_bootstrap_seed_final_report_missing',
    mutate(input) {
      delete input.finalReports['integration-gate-tooling-latest.json'];
      delete input.gateSummary[REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS['integration-gate-tooling-latest.json']];
    },
  }),
  Object.freeze({
    scenarioId: 'final_hash_alias_stripped',
    label: 'A final recovered report keeps only generic hash after losing its semantic report hash',
    expectedBlockerCode: 'report_bootstrap_seed_final_hash_missing',
    mutate(input) {
      const fileId = 'integration-gate-tooling-latest.json';
      input.finalReports[fileId] = deleteSemanticHashAliases(input.finalReports[fileId], fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'final_report_keeps_seed_marker',
    label: 'A final latest report still carries the bootstrap seed marker',
    expectedBlockerCode: 'report_bootstrap_seed_leaked_to_final_report',
    mutate(input) {
      input.finalReports['report-schema-contract-latest.json'] = {
        ...input.finalReports['report-schema-contract-latest.json'],
        bootstrapSeed: true,
        summary: {
          ...input.finalReports['report-schema-contract-latest.json'].summary,
          bootstrapSeed: true,
        },
      };
    },
  }),
  Object.freeze({
    scenarioId: 'final_reuses_seed_hash',
    label: 'A final latest report keeps the temporary seed hash',
    expectedBlockerCode: 'report_bootstrap_seed_final_hash_not_overwritten',
    mutate(input) {
      const fileId = 'report-freshness-latest.json';
      const seedHash = reportHash(input.seedReports[fileId]);
      input.finalReports[fileId] = {
        ...input.finalReports[fileId],
        hash: seedHash,
        reportHash: seedHash,
      };
      input.gateSummary[REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS[fileId]] = seedHash;
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_seed_hash_leak',
    label: 'The final gate summary points at a temporary seed hash',
    expectedBlockerCode: 'report_bootstrap_seed_gate_summary_uses_seed_hash',
    mutate(input) {
      const fileId = 'integration-dependency-audit-latest.json';
      input.gateSummary[REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS[fileId]] = reportHash(input.seedReports[fileId]);
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_missing',
    label: 'The final gate summary omits a seeded report hash binding',
    expectedBlockerCode: 'report_bootstrap_seed_gate_summary_hash_missing',
    mutate(input) {
      delete input.gateSummary[REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS['integration-dependency-gate-latest.json']];
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function reportHash(report = {}) {
  return report.reportHash
    || report.integrationAuditHash
    || report.auditHash
    || report.integrationGateToolingHash
    || report.toolingHash
    || report.reportFreshnessHash
    || report.freshnessHash
    || report.reportSchemaContractHash
    || report.schemaContractHash
    || report.gateHash
    || null;
}

function semanticHashAliasesFor(fileId) {
  return REPORT_BOOTSTRAP_SEED_HASH_KEYS[fileId] || [];
}

function deleteSemanticHashAliases(report, fileId) {
  const clone = { ...report };
  delete clone.reportHash;
  for (const key of semanticHashAliasesFor(fileId)) delete clone[key];
  return clone;
}

function seedSafety() {
  return {
    localOnly: true,
    readOnly: true,
    syntheticFixtureOnly: true,
    bootstrapSeedOnly: true,
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
  };
}

function hashFor(fileId, phase, variant = 'default') {
  return digest({
    fixture: 'report_bootstrap_seed_regression',
    fileId,
    phase,
    variant,
  });
}

export function buildBootstrapSeedReport(fileId, {
  variant = 'seed',
  generatedAt = FIXTURE_GENERATED_AT,
} = {}) {
  const hash = hashFor(fileId, 'bootstrap_seed', variant);
  const semanticHashes = Object.fromEntries(semanticHashAliasesFor(fileId).map((key) => [key, hash]));
  return {
    version: 1,
    kind: 'SyntheticBootstrapSeedReport',
    status: REPORT_BOOTSTRAP_SEED_STATUS,
    ok: true,
    generatedAt,
    fileId,
    bootstrapSeed: true,
    seedReason: REPORT_BOOTSTRAP_SEED_REASON,
    replacedByFinalReport: true,
    summary: {
      bootstrapSeed: true,
      blockerCount: 0,
      variant,
    },
    blockers: [],
    safety: seedSafety(),
    ...semanticHashes,
    reportHash: hash,
    hash,
  };
}

function buildFinalRecoveredReport(fileId, { variant = 'final' } = {}) {
  const hash = hashFor(fileId, 'final_recovered_report', variant);
  const semanticHashes = Object.fromEntries(semanticHashAliasesFor(fileId).map((key) => [key, hash]));
  return {
    version: 1,
    kind: 'SyntheticRecoveredLatestReport',
    status: FINAL_STATUS,
    ok: true,
    generatedAt: FIXTURE_GENERATED_AT,
    fileId,
    summary: {
      blockerCount: 0,
      variant,
    },
    blockers: [],
    safety: {
      ...seedSafety(),
      bootstrapSeedOnly: false,
    },
    ...semanticHashes,
    reportHash: hash,
    hash,
  };
}

function buildBaseInput() {
  const seedReports = Object.fromEntries(REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.map((fileId) => [
    fileId,
    buildBootstrapSeedReport(fileId),
  ]));
  const finalReports = Object.fromEntries(REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.map((fileId) => [
    fileId,
    buildFinalRecoveredReport(fileId),
  ]));
  const gateSummary = Object.fromEntries(REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.map((fileId) => [
    REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS[fileId],
    reportHash(finalReports[fileId]),
  ]));
  return {
    allowedSeedFileIds: [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS],
    gateHashKeys: { ...REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS },
    seedReports,
    finalReports,
    gateSummary,
  };
}

function compactReport(fileId, report) {
  return {
    fileId,
    exists: Boolean(report),
    ok: report?.ok === true,
    status: report?.status || null,
    hash: reportHash(report),
    bootstrapSeed: report?.bootstrapSeed === true || report?.summary?.bootstrapSeed === true,
    seedReason: report?.seedReason || null,
    blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
  };
}

function analyzeBootstrapSeedPolicy(input = {}) {
  const allowedSeedFileIds = uniqueSorted(input.allowedSeedFileIds || []);
  const requiredSeedFileIds = uniqueSorted(REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS);
  const allowedSet = new Set(allowedSeedFileIds);
  const seedReports = input.seedReports || {};
  const finalReports = input.finalReports || {};
  const gateSummary = input.gateSummary || {};
  const seedFileIds = uniqueSorted(Object.keys(seedReports));
  const finalFileIds = uniqueSorted(Object.keys(finalReports));
  const seedHashes = Object.fromEntries(seedFileIds.map((fileId) => [fileId, reportHash(seedReports[fileId])]));
  const finalHashes = Object.fromEntries(finalFileIds.map((fileId) => [fileId, reportHash(finalReports[fileId])]));

  const missingAllowedSeeds = requiredSeedFileIds.filter((fileId) => !seedReports[fileId]);
  const notAllowedSeeds = seedFileIds.filter((fileId) => !allowedSet.has(fileId));
  const missingFromAllowlist = requiredSeedFileIds.filter((fileId) => !allowedSet.has(fileId));
  const extraAllowlist = allowedSeedFileIds.filter((fileId) => !requiredSeedFileIds.includes(fileId));

  const blockers = [
    ...missingFromAllowlist.map((fileId) => blocker(
      'report_bootstrap_seed_allowlist_required_file_missing',
      `${fileId} must remain in the bootstrap seed allowlist.`,
      { fileId },
    )),
    ...extraAllowlist.map((fileId) => blocker(
      'report_bootstrap_seed_allowlist_extra_file',
      `${fileId} must not be added to the bootstrap seed allowlist without a recovery contract update.`,
      { fileId },
    )),
    ...missingAllowedSeeds.map((fileId) => blocker(
      'report_bootstrap_seed_required_seed_missing',
      `${fileId} must have a temporary bootstrap seed in the recovery fixture.`,
      { fileId },
    )),
    ...notAllowedSeeds.map((fileId) => blocker(
      'report_bootstrap_seed_file_not_allowed',
      `${fileId} is not allowed as a bootstrap seed report.`,
      { fileId },
    )),
  ];

  for (const fileId of seedFileIds) {
    const report = seedReports[fileId] || {};
    const hash = reportHash(report);
    blockers.push(
      ...(report.fileId !== fileId ? [blocker(
        'report_bootstrap_seed_file_id_mismatch',
        `${fileId} seed report must bind its own fileId.`,
        { fileId },
      )] : []),
      ...(report.ok !== true ? [blocker(
        'report_bootstrap_seed_not_ok',
        `${fileId} bootstrap seed must be ok=true.`,
        { fileId },
      )] : []),
      ...(report.status !== REPORT_BOOTSTRAP_SEED_STATUS ? [blocker(
        'report_bootstrap_seed_status_mismatch',
        `${fileId} bootstrap seed must use ${REPORT_BOOTSTRAP_SEED_STATUS}.`,
        { fileId, status: report.status || null },
      )] : []),
      ...(!hash ? [blocker(
        'report_bootstrap_seed_hash_missing',
        `${fileId} bootstrap seed must expose hash/reportHash.`,
        { fileId },
      )] : []),
      ...(!(report.bootstrapSeed === true && report.summary?.bootstrapSeed === true) ? [blocker(
        'report_bootstrap_seed_marker_missing',
        `${fileId} bootstrap seed must be explicitly marked as a bootstrapSeed in both root and summary.`,
        { fileId },
      )] : []),
      ...(report.seedReason !== REPORT_BOOTSTRAP_SEED_REASON ? [blocker(
        'report_bootstrap_seed_reason_missing',
        `${fileId} bootstrap seed must declare ${REPORT_BOOTSTRAP_SEED_REASON}.`,
        { fileId },
      )] : []),
      ...(report.replacedByFinalReport !== true ? [blocker(
        'report_bootstrap_seed_final_replacement_missing',
        `${fileId} bootstrap seed must declare that final gate output replaces it.`,
        { fileId },
      )] : []),
      ...(report.safety?.syntheticFixtureOnly !== true || report.safety?.bootstrapSeedOnly !== true ? [blocker(
        'report_bootstrap_seed_safety_missing',
        `${fileId} bootstrap seed must expose synthetic bootstrap-only safety.`,
        { fileId },
      )] : []),
      ...(report.safety?.mutatesReportFiles !== false ? [blocker(
        'report_bootstrap_seed_mutates_report_files_flag_missing',
        `${fileId} bootstrap seed must explicitly declare safety.mutatesReportFiles=false.`,
        { fileId },
      )] : []),
      ...(report.safety?.executesExternalAction === true || report.safety?.grantsExecutionPermission === true ? [blocker(
        'report_bootstrap_seed_execution_permission_leak',
        `${fileId} bootstrap seed must not grant external action permission.`,
        { fileId },
      )] : []),
    );
  }

  for (const fileId of requiredSeedFileIds) {
    const seedReport = seedReports[fileId];
    const finalReport = finalReports[fileId];
    const seedHash = reportHash(seedReport);
    const finalHash = reportHash(finalReport);
    const gateHashKey = input.gateHashKeys?.[fileId] || REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS[fileId];
    const gateSummaryHash = gateSummary[gateHashKey];
    blockers.push(
      ...(!finalReport ? [blocker(
        'report_bootstrap_seed_final_report_missing',
        `${fileId} must have a final recovered report that overwrites the seed.`,
        { fileId },
      )] : []),
      ...(finalReport && (finalReport.bootstrapSeed === true || finalReport.summary?.bootstrapSeed === true) ? [blocker(
        'report_bootstrap_seed_leaked_to_final_report',
        `${fileId} final report must not carry bootstrapSeed markers.`,
        { fileId },
      )] : []),
      ...(finalReport && String(finalReport.status || '').includes('bootstrap') ? [blocker(
        'report_bootstrap_seed_status_leaked_to_final_report',
        `${fileId} final report status must not be a bootstrap status.`,
        { fileId },
      )] : []),
      ...(finalReport && !finalHash ? [blocker(
        'report_bootstrap_seed_final_hash_missing',
        `${fileId} final report must expose hash/reportHash.`,
        { fileId },
      )] : []),
      ...(seedHash && finalHash && seedHash === finalHash ? [blocker(
        'report_bootstrap_seed_final_hash_not_overwritten',
        `${fileId} final report hash must differ from the temporary bootstrap seed hash.`,
        { fileId },
      )] : []),
      ...(!gateSummaryHash ? [blocker(
        'report_bootstrap_seed_gate_summary_hash_missing',
        `${fileId} final gate summary must expose ${gateHashKey}.`,
        { fileId, gateHashKey },
      )] : []),
      ...(gateSummaryHash && seedHash && gateSummaryHash === seedHash ? [blocker(
        'report_bootstrap_seed_gate_summary_uses_seed_hash',
        `${gateHashKey} must not point at a temporary bootstrap seed hash.`,
        { fileId, gateHashKey },
      )] : []),
      ...(gateSummaryHash && finalHash && gateSummaryHash !== finalHash ? [blocker(
        'report_bootstrap_seed_gate_summary_hash_mismatch',
        `${gateHashKey} must match the final recovered report hash.`,
        { fileId, gateHashKey },
      )] : []),
    );
  }

  return {
    status: blockers.length ? 'blocked_report_bootstrap_seed_policy' : 'pass_report_bootstrap_seed_policy',
    ok: blockers.length === 0,
    allowedSeedFileIds,
    requiredSeedFileIds,
    seedReports: Object.fromEntries(seedFileIds.map((fileId) => [fileId, compactReport(fileId, seedReports[fileId])])),
    finalReports: Object.fromEntries(finalFileIds.map((fileId) => [fileId, compactReport(fileId, finalReports[fileId])])),
    gateSummary,
    seedHashes,
    finalHashes,
    gateHashKeys: { ...(input.gateHashKeys || REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS) },
    blockers,
  };
}

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    allowedSeedFileCount: analysis.allowedSeedFileIds.length,
    requiredSeedFileCount: analysis.requiredSeedFileIds.length,
    seedReportCount: Object.keys(analysis.seedReports || {}).length,
    finalReportCount: Object.keys(analysis.finalReports || {}).length,
    gateSummaryBindingCount: Object.keys(analysis.gateSummary || {}).length,
    seedReports: analysis.seedReports,
    finalReports: analysis.finalReports,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      gateHashKey: item.gateHashKey || null,
    })),
  };
}

function observedBlockerCodes(analysis) {
  return uniqueSorted((analysis.blockers || []).map((item) => item.code));
}

function runScenario(scenario, baselineInput) {
  const input = clone(baselineInput);
  scenario.mutate(input);
  const analysis = analyzeBootstrapSeedPolicy(input);
  const observed = observedBlockerCodes(analysis);
  const blockers = [
    ...(analysis.ok ? [blocker(
      'report_bootstrap_seed_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must make bootstrap seed policy fail.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!observed.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_bootstrap_seed_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observed.join(', ') || 'none'}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes: observed },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_bootstrap_seed_scenario' : 'pass_report_bootstrap_seed_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes: observed,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportBootstrapSeedRegressionReport({
  generatedAt = new Date().toISOString(),
} = {}) {
  const baselineInput = buildBaseInput();
  const actual = analyzeBootstrapSeedPolicy(baselineInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baselineInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_bootstrap_seed_policy',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_BOOTSTRAP_SEED_REGRESSION_VERSION,
    kind: 'ReportBootstrapSeedRegression',
    status: blockers.length ? 'blocked_report_bootstrap_seed_regression' : 'pass_report_bootstrap_seed_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_BOOTSTRAP_SEED_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_BOOTSTRAP_SEED_REGRESSION_SCRIPT_ID,
    fixture: {
      allowedSeedFileIds: [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS],
      gateHashKeys: { ...REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS },
      seedStatus: REPORT_BOOTSTRAP_SEED_STATUS,
      finalStatus: FINAL_STATUS,
      seedReason: REPORT_BOOTSTRAP_SEED_REASON,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
    },
    actual: compactAnalysis(actual),
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      allowedSeedFileCount: actual.allowedSeedFileIds.length,
      requiredSeedFileCount: actual.requiredSeedFileIds.length,
      seedReportCount: Object.keys(actual.seedReports || {}).length,
      finalReportCount: Object.keys(actual.finalReports || {}).length,
      finalReportOverwriteCount: actual.requiredSeedFileIds.filter((fileId) => (
        actual.seedHashes[fileId]
          && actual.finalHashes[fileId]
          && actual.seedHashes[fileId] !== actual.finalHashes[fileId]
      )).length,
      gateSummaryBindingCount: Object.keys(actual.gateSummary || {}).length,
      gateSummarySeedLeakCount: actual.requiredSeedFileIds.filter((fileId) => (
        actual.gateSummary[actual.gateHashKeys[fileId]] === actual.seedHashes[fileId]
      )).length,
      finalBootstrapMarkerLeakCount: actual.requiredSeedFileIds.filter((fileId) => (
        actual.finalReports[fileId]?.bootstrapSeed === true
      )).length,
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
      bootstrapSeedOnly: true,
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
  const bootstrapSeedRegressionHash = digest({
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
    bootstrapSeedRegressionHash,
    hash: bootstrapSeedRegressionHash,
  };
}

export function summarizeReportBootstrapSeedRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_bootstrap_seed_regression',
    ok: report?.ok === true,
    bootstrapSeedRegressionHash: report?.bootstrapSeedRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    allowedSeedFileCount: report?.summary?.allowedSeedFileCount || 0,
    seedReportCount: report?.summary?.seedReportCount || 0,
    finalReportCount: report?.summary?.finalReportCount || 0,
    finalReportOverwriteCount: report?.summary?.finalReportOverwriteCount || 0,
    gateSummarySeedLeakCount: report?.summary?.gateSummarySeedLeakCount || 0,
    finalBootstrapMarkerLeakCount: report?.summary?.finalBootstrapMarkerLeakCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    failedScenarioCount: report?.summary?.failedScenarioCount || 0,
    observedExpectedBlockerCount: report?.summary?.observedExpectedBlockerCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      bootstrapSeedOnly: report?.safety?.bootstrapSeedOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
