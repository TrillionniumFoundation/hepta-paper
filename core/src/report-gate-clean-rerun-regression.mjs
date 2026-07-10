import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
  REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS,
  REPORT_BOOTSTRAP_SEED_REASON,
  REPORT_BOOTSTRAP_SEED_STATUS,
  buildBootstrapSeedReport,
} from './report-bootstrap-seed-regression.mjs';

export const REPORT_GATE_CLEAN_RERUN_REGRESSION_VERSION = 1;

export const REPORT_GATE_CLEAN_RERUN_REGRESSION_REPORT_FILE_ID = 'report-gate-clean-rerun-regression-latest.json';

export const REPORT_GATE_CLEAN_RERUN_REGRESSION_SCRIPT_ID = 'reports:gate-clean-rerun-regression';

const FIXTURE_GENERATED_AT = '2026-01-01T00:00:00.000Z';

const CLEAN_SKIP_REASON = 'already_ok_final_report';
const DIRTY_WRITE_REASON = 'not_ok';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'clean_rerun_writes_seed',
    label: 'A clean rerun writes a bootstrap seed instead of skipping',
    expectedBlockerCode: 'report_gate_clean_rerun_seed_written_on_clean_run',
    mutate(input) {
      const fileId = 'report-freshness-latest.json';
      input.cleanSeedDecisions[fileId] = {
        ...input.cleanSeedDecisions[fileId],
        write: true,
        reason: DIRTY_WRITE_REASON,
      };
    },
  }),
  Object.freeze({
    scenarioId: 'clean_skip_missing',
    label: 'A clean rerun loses the skip decision for an allowlisted file',
    expectedBlockerCode: 'report_gate_clean_rerun_clean_skip_missing',
    mutate(input) {
      delete input.cleanSeedDecisions['integration-gate-tooling-latest.json'];
    },
  }),
  Object.freeze({
    scenarioId: 'clean_skip_hash_missing',
    label: 'A clean rerun skip decision loses the final report hash',
    expectedBlockerCode: 'report_gate_clean_rerun_clean_skip_hash_missing',
    mutate(input) {
      delete input.cleanSeedDecisions['report-schema-contract-latest.json'].hash;
    },
  }),
  Object.freeze({
    scenarioId: 'final_seed_marker_leak',
    label: 'The clean rerun final latest report still carries seed markers',
    expectedBlockerCode: 'report_gate_clean_rerun_seed_marker_leaked',
    mutate(input) {
      const fileId = 'integration-dependency-audit-latest.json';
      input.cleanFinalReports[fileId] = {
        ...input.cleanFinalReports[fileId],
        bootstrapSeed: true,
        summary: {
          ...input.cleanFinalReports[fileId].summary,
          bootstrapSeed: true,
        },
      };
    },
  }),
  Object.freeze({
    scenarioId: 'seed_hash_alias_stripped',
    label: 'The polluted-run seed report keeps only generic hash after losing its semantic report hash',
    expectedBlockerCode: 'report_gate_clean_rerun_seed_hash_missing',
    mutate(input) {
      const fileId = 'integration-dependency-audit-latest.json';
      const report = { ...input.seedReports[fileId] };
      delete report.reportHash;
      input.seedReports[fileId] = report;
    },
  }),
  Object.freeze({
    scenarioId: 'final_hash_alias_stripped',
    label: 'The clean rerun final report keeps only generic hash after losing its semantic report hash',
    expectedBlockerCode: 'report_gate_clean_rerun_final_hash_missing',
    mutate(input) {
      const fileId = 'integration-gate-tooling-latest.json';
      const report = { ...input.cleanFinalReports[fileId] };
      delete report.reportHash;
      input.cleanFinalReports[fileId] = report;
    },
  }),
  Object.freeze({
    scenarioId: 'final_reuses_seed_hash',
    label: 'The clean rerun final latest report reuses a seed hash',
    expectedBlockerCode: 'report_gate_clean_rerun_seed_hash_reused',
    mutate(input) {
      const fileId = 'report-freshness-latest.json';
      const seedHash = reportHash(input.seedReports[fileId]);
      input.cleanFinalReports[fileId] = {
        ...input.cleanFinalReports[fileId],
        hash: seedHash,
        reportHash: seedHash,
      };
      input.cleanGateSummary[REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS[fileId]] = seedHash;
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_uses_seed_hash',
    label: 'The clean rerun gate summary points at a temporary seed hash',
    expectedBlockerCode: 'report_gate_clean_rerun_gate_summary_uses_seed_hash',
    mutate(input) {
      const fileId = 'integration-dependency-gate-latest.json';
      input.cleanGateSummary[REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS[fileId]] = reportHash(input.seedReports[fileId]);
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_mismatch',
    label: 'The clean rerun gate summary drifts from the final report hash',
    expectedBlockerCode: 'report_gate_clean_rerun_gate_summary_hash_mismatch',
    mutate(input) {
      input.cleanGateSummary.integrationGateToolingHash = digest({
        fixture: 'report_gate_clean_rerun_regression',
        scenarioId: 'gate_summary_hash_mismatch',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_force_enabled',
    label: 'The gate starts forcing bootstrap seeds on every run',
    expectedBlockerCode: 'report_gate_clean_rerun_bootstrap_force_forbidden',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === 'report_bootstrap_seed_export'
        ? { ...step, args: [...step.args, '--force'] }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_after_schema',
    label: 'The bootstrap seed export moves after schema contract validation',
    expectedBlockerCode: 'report_gate_clean_rerun_bootstrap_step_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(input.sourceSteps, 'report_bootstrap_seed_export', 'report_schema_contract_export');
    },
  }),
  Object.freeze({
    scenarioId: 'clean_rerun_contract_step_missing',
    label: 'The clean rerun regression export disappears from the integration gate',
    expectedBlockerCode: 'report_gate_clean_rerun_gate_step_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.filter((step) => step.stepId !== 'report_gate_clean_rerun_regression_export');
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
  return report.reportHash || report.gateHash || null;
}

function hasSeedMarker(report = {}) {
  return report?.bootstrapSeed === true
    || report?.summary?.bootstrapSeed === true
    || String(report?.status || '').includes('bootstrap')
    || report?.seedReason === REPORT_BOOTSTRAP_SEED_REASON;
}

function hashFor(fileId, phase, variant = 'default') {
  return digest({
    fixture: 'report_gate_clean_rerun_regression',
    fileId,
    phase,
    variant,
  });
}

function reportSafety() {
  return {
    localOnly: true,
    readOnly: true,
    syntheticFixtureOnly: true,
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

function buildPollutedLatestReport(fileId) {
  const hash = hashFor(fileId, 'polluted_latest');
  return {
    version: 1,
    kind: 'SyntheticGateCleanRerunLatestReport',
    status: 'blocked_polluted_latest_report',
    ok: false,
    generatedAt: FIXTURE_GENERATED_AT,
    fileId,
    summary: {
      blockerCount: 1,
      variant: 'polluted_latest_cycle',
    },
    blockers: [{
      code: 'synthetic_polluted_latest_report',
      fileId,
      notes: `${fileId} models the self-referential latest-report cycle before bootstrap recovery.`,
    }],
    safety: reportSafety(),
    reportHash: hash,
    hash,
  };
}

function buildFinalLatestReport(fileId) {
  const hash = hashFor(fileId, 'clean_final_latest');
  return {
    version: 1,
    kind: 'SyntheticGateCleanRerunLatestReport',
    status: 'pass_clean_rerun_latest_report',
    ok: true,
    generatedAt: FIXTURE_GENERATED_AT,
    fileId,
    summary: {
      blockerCount: 0,
      variant: 'clean_rerun_final',
    },
    blockers: [],
    safety: reportSafety(),
    reportHash: hash,
    hash,
  };
}

function dirtySeedDecision(fileId, report) {
  return {
    write: true,
    reason: DIRTY_WRITE_REASON,
    status: report.status || null,
    hash: reportHash(report),
  };
}

function cleanSeedDecision(fileId, report) {
  return {
    write: false,
    reason: CLEAN_SKIP_REASON,
    status: report.status || null,
    hash: reportHash(report),
  };
}

function moveStepAfter(steps, movingStepId, anchorStepId) {
  const moving = steps.find((step) => step.stepId === movingStepId);
  if (!moving) return steps;
  const withoutMoving = steps.filter((step) => step.stepId !== movingStepId);
  const anchorIndex = withoutMoving.findIndex((step) => step.stepId === anchorStepId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex + 1),
    moving,
    ...withoutMoving.slice(anchorIndex + 1),
  ];
}

function stepIndexById(steps = []) {
  return Object.fromEntries(steps.map((step, index) => [step.stepId, index]));
}

function sourceStepBlockers(sourceSteps = []) {
  const indexById = stepIndexById(sourceSteps);
  const bootstrapStep = sourceSteps.find((step) => step.stepId === 'report_bootstrap_seed_export');
  const cleanRerunStep = sourceSteps.find((step) => step.stepId === 'report_gate_clean_rerun_regression_export');
  const requiredSteps = [
    'syntax_report_gate_clean_rerun_regression',
    'syntax_report_gate_clean_rerun_regression_export',
    'report_bootstrap_seed_export',
    'report_schema_contract_export',
    'report_bootstrap_seed_regression_export',
    'report_gate_clean_rerun_regression_export',
    'report_runner_contract_regression_export',
    'report_freshness_export_pre_tooling',
    'integration_gate_tooling_export',
  ];
  const blockers = [
    ...requiredSteps
      .filter((stepId) => indexById[stepId] == null)
      .map((stepId) => blocker(
        'report_gate_clean_rerun_gate_step_missing',
        `${stepId} must remain in integration-dependency-gate.mjs.`,
        { stepId },
      )),
    ...(bootstrapStep && bootstrapStep.args.includes('--force') ? [blocker(
      'report_gate_clean_rerun_bootstrap_force_forbidden',
      'report_bootstrap_seed_export must remain conditional and must not pass --force in the integration gate.',
      { stepId: 'report_bootstrap_seed_export' },
    )] : []),
    ...(cleanRerunStep && !cleanRerunStep.args.includes('--strict') ? [blocker(
      'report_gate_clean_rerun_gate_step_arg_missing',
      'report_gate_clean_rerun_regression_export must run with --strict.',
      { stepId: 'report_gate_clean_rerun_regression_export', arg: '--strict' },
    )] : []),
    ...(cleanRerunStep && cleanRerunStep.parseJsonOutput !== true ? [blocker(
      'report_gate_clean_rerun_gate_step_parse_json_missing',
      'report_gate_clean_rerun_regression_export must parse JSON output.',
      { stepId: 'report_gate_clean_rerun_regression_export' },
    )] : []),
  ];

  for (const laterStepId of [
    'report_schema_contract_export',
    'report_bootstrap_seed_regression_export',
    'report_gate_clean_rerun_regression_export',
    'report_freshness_export_pre_tooling',
    'integration_gate_tooling_export',
  ]) {
    if (indexById.report_bootstrap_seed_export == null || indexById[laterStepId] == null) continue;
    if (indexById.report_bootstrap_seed_export >= indexById[laterStepId]) {
      blockers.push(blocker(
        'report_gate_clean_rerun_bootstrap_step_order_drift',
        `report_bootstrap_seed_export must run before ${laterStepId}.`,
        { stepId: laterStepId, previousStepId: 'report_bootstrap_seed_export' },
      ));
    }
  }

  for (const [previousStepId, stepId] of [
    ['syntax_report_gate_clean_rerun_regression', 'syntax_report_gate_clean_rerun_regression_export'],
    ['syntax_report_gate_clean_rerun_regression_export', 'report_gate_clean_rerun_regression_export'],
    ['report_bootstrap_seed_regression_export', 'report_gate_clean_rerun_regression_export'],
    ['report_gate_clean_rerun_regression_export', 'report_runner_contract_regression_export'],
  ]) {
    if (indexById[previousStepId] == null || indexById[stepId] == null) continue;
    if (indexById[previousStepId] >= indexById[stepId]) {
      blockers.push(blocker(
        'report_gate_clean_rerun_contract_step_order_drift',
        `${previousStepId} must run before ${stepId}.`,
        { stepId, previousStepId },
      ));
    }
  }
  return blockers;
}

function buildBaseInput({ gateSourceText = '' } = {}) {
  const allowedSeedFileIds = [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS];
  const dirtyLatestReports = Object.fromEntries(allowedSeedFileIds.map((fileId) => [
    fileId,
    buildPollutedLatestReport(fileId),
  ]));
  const seedReports = Object.fromEntries(allowedSeedFileIds.map((fileId) => [
    fileId,
    buildBootstrapSeedReport(fileId),
  ]));
  const firstFinalReports = Object.fromEntries(allowedSeedFileIds.map((fileId) => [
    fileId,
    buildFinalLatestReport(fileId),
  ]));
  const cleanFinalReports = clone(firstFinalReports);
  return {
    allowedSeedFileIds,
    gateHashKeys: { ...REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS },
    dirtyLatestReports,
    dirtySeedDecisions: Object.fromEntries(allowedSeedFileIds.map((fileId) => [
      fileId,
      dirtySeedDecision(fileId, dirtyLatestReports[fileId]),
    ])),
    seedReports,
    firstFinalReports,
    cleanSeedDecisions: Object.fromEntries(allowedSeedFileIds.map((fileId) => [
      fileId,
      cleanSeedDecision(fileId, firstFinalReports[fileId]),
    ])),
    cleanFinalReports,
    cleanGateSummary: Object.fromEntries(allowedSeedFileIds.map((fileId) => [
      REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS[fileId],
      reportHash(cleanFinalReports[fileId]),
    ])),
    sourceSteps: extractIntegrationGateStepSpecs(gateSourceText),
  };
}

function compactDecision(fileId, decision = {}) {
  return {
    fileId,
    exists: Boolean(decision),
    write: decision?.write === true,
    reason: decision?.reason || null,
    status: decision?.status || null,
    hash: decision?.hash || null,
  };
}

function compactReport(fileId, report = {}) {
  return {
    fileId,
    exists: Boolean(report),
    ok: report?.ok === true,
    status: report?.status || null,
    hash: reportHash(report),
    seedMarker: hasSeedMarker(report),
    blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
  };
}

function analyzeGateCleanRerun(input = {}) {
  const requiredSeedFileIds = uniqueSorted(REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS);
  const allowedSeedFileIds = uniqueSorted(input.allowedSeedFileIds || []);
  const dirtySeedDecisions = input.dirtySeedDecisions || {};
  const cleanSeedDecisions = input.cleanSeedDecisions || {};
  const seedReports = input.seedReports || {};
  const cleanFinalReports = input.cleanFinalReports || {};
  const cleanGateSummary = input.cleanGateSummary || {};
  const gateHashKeys = input.gateHashKeys || REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS;
  const blockers = [
    ...requiredSeedFileIds
      .filter((fileId) => !allowedSeedFileIds.includes(fileId))
      .map((fileId) => blocker(
        'report_gate_clean_rerun_allowlist_file_missing',
        `${fileId} must stay in the bootstrap seed allowlist for clean rerun coverage.`,
        { fileId },
      )),
    ...allowedSeedFileIds
      .filter((fileId) => !requiredSeedFileIds.includes(fileId))
      .map((fileId) => blocker(
        'report_gate_clean_rerun_allowlist_extra_file',
        `${fileId} is not covered by the clean rerun regression fixture.`,
        { fileId },
      )),
    ...sourceStepBlockers(input.sourceSteps || []),
  ];

  for (const fileId of requiredSeedFileIds) {
    const dirtyDecision = dirtySeedDecisions[fileId];
    const cleanDecision = cleanSeedDecisions[fileId];
    const seedReport = seedReports[fileId];
    const finalReport = cleanFinalReports[fileId];
    const seedHash = reportHash(seedReport);
    const finalHash = reportHash(finalReport);
    const gateHashKey = gateHashKeys[fileId];
    const gateHash = gateHashKey ? cleanGateSummary[gateHashKey] : null;
    blockers.push(
      ...(!dirtyDecision?.write ? [blocker(
        'report_gate_clean_rerun_dirty_seed_not_written',
        `${fileId} must be seeded in the polluted first recovery run.`,
        { fileId },
      )] : []),
      ...(dirtyDecision?.write && dirtyDecision.reason !== DIRTY_WRITE_REASON ? [blocker(
        'report_gate_clean_rerun_dirty_seed_reason_mismatch',
        `${fileId} dirty recovery seed decision must use ${DIRTY_WRITE_REASON}.`,
        { fileId },
      )] : []),
      ...(!cleanDecision ? [blocker(
        'report_gate_clean_rerun_clean_skip_missing',
        `${fileId} must have a clean rerun skip decision.`,
        { fileId },
      )] : []),
      ...(cleanDecision?.write === true ? [blocker(
        'report_gate_clean_rerun_seed_written_on_clean_run',
        `${fileId} must not be rewritten as a seed during a clean rerun.`,
        { fileId },
      )] : []),
      ...(cleanDecision && cleanDecision.write !== true && cleanDecision.reason !== CLEAN_SKIP_REASON ? [blocker(
        'report_gate_clean_rerun_clean_skip_reason_mismatch',
        `${fileId} clean rerun skip decision must use ${CLEAN_SKIP_REASON}.`,
        { fileId },
      )] : []),
      ...(cleanDecision && cleanDecision.write !== true && !cleanDecision.hash ? [blocker(
        'report_gate_clean_rerun_clean_skip_hash_missing',
        `${fileId} clean rerun skip decision must carry the final latest hash it kept.`,
        { fileId },
      )] : []),
      ...(!seedReport ? [blocker(
        'report_gate_clean_rerun_seed_report_missing',
        `${fileId} must have a synthetic seed report in the polluted first run fixture.`,
        { fileId },
      )] : []),
      ...(seedReport && seedReport.status !== REPORT_BOOTSTRAP_SEED_STATUS ? [blocker(
        'report_gate_clean_rerun_seed_status_mismatch',
        `${fileId} seed report must use ${REPORT_BOOTSTRAP_SEED_STATUS}.`,
        { fileId },
      )] : []),
      ...(seedReport && !seedHash ? [blocker(
        'report_gate_clean_rerun_seed_hash_missing',
        `${fileId} seed report must expose a semantic report hash.`,
        { fileId },
      )] : []),
      ...(!finalReport ? [blocker(
        'report_gate_clean_rerun_final_report_missing',
        `${fileId} must have a final latest report after the clean rerun.`,
        { fileId },
      )] : []),
      ...(finalReport && finalReport.ok !== true ? [blocker(
        'report_gate_clean_rerun_final_report_not_ok',
        `${fileId} final clean rerun report must be ok.`,
        { fileId },
      )] : []),
      ...(finalReport && hasSeedMarker(finalReport) ? [blocker(
        'report_gate_clean_rerun_seed_marker_leaked',
        `${fileId} clean final report must not carry bootstrap markers, statuses, or seed reasons.`,
        { fileId },
      )] : []),
      ...(finalReport && !finalHash ? [blocker(
        'report_gate_clean_rerun_final_hash_missing',
        `${fileId} clean final report must expose a semantic report hash.`,
        { fileId },
      )] : []),
      ...(seedHash && finalHash && seedHash === finalHash ? [blocker(
        'report_gate_clean_rerun_seed_hash_reused',
        `${fileId} clean final report hash must not reuse the temporary seed hash.`,
        { fileId },
      )] : []),
      ...(!gateHashKey ? [blocker(
        'report_gate_clean_rerun_gate_hash_key_missing',
        `${fileId} must have a gate summary hash key binding.`,
        { fileId },
      )] : []),
      ...(gateHashKey && !gateHash ? [blocker(
        'report_gate_clean_rerun_gate_summary_hash_missing',
        `${gateHashKey} must be present in the clean rerun gate summary.`,
        { fileId, gateHashKey },
      )] : []),
      ...(gateHash && seedHash && gateHash === seedHash ? [blocker(
        'report_gate_clean_rerun_gate_summary_uses_seed_hash',
        `${gateHashKey} must not point at a temporary seed hash after the clean rerun.`,
        { fileId, gateHashKey },
      )] : []),
      ...(gateHash && finalHash && gateHash !== finalHash ? [blocker(
        'report_gate_clean_rerun_gate_summary_hash_mismatch',
        `${gateHashKey} must match the clean final report hash.`,
        { fileId, gateHashKey },
      )] : []),
    );
  }

  const cleanDecisionRecords = Object.fromEntries(requiredSeedFileIds.map((fileId) => [
    fileId,
    compactDecision(fileId, cleanSeedDecisions[fileId]),
  ]));
  const dirtyDecisionRecords = Object.fromEntries(requiredSeedFileIds.map((fileId) => [
    fileId,
    compactDecision(fileId, dirtySeedDecisions[fileId]),
  ]));
  const seedReportRecords = Object.fromEntries(requiredSeedFileIds.map((fileId) => [
    fileId,
    compactReport(fileId, seedReports[fileId]),
  ]));
  const finalReportRecords = Object.fromEntries(requiredSeedFileIds.map((fileId) => [
    fileId,
    compactReport(fileId, cleanFinalReports[fileId]),
  ]));

  return {
    status: blockers.length ? 'blocked_report_gate_clean_rerun_analysis' : 'pass_report_gate_clean_rerun_analysis',
    ok: blockers.length === 0,
    allowedSeedFileIds,
    requiredSeedFileIds,
    dirtySeedDecisions: dirtyDecisionRecords,
    cleanSeedDecisions: cleanDecisionRecords,
    seedReports: seedReportRecords,
    cleanFinalReports: finalReportRecords,
    cleanGateSummary,
    sourceStepIds: (input.sourceSteps || []).map((step) => step.stepId),
    blockers,
    counts: {
      allowedSeedFileCount: allowedSeedFileIds.length,
      dirtySeedWriteCount: Object.values(dirtyDecisionRecords).filter((decision) => decision.write).length,
      cleanSeedWriteCount: Object.values(cleanDecisionRecords).filter((decision) => decision.write).length,
      cleanSeedSkipCount: Object.values(cleanDecisionRecords).filter((decision) => decision.exists && !decision.write).length,
      finalReportCount: Object.values(finalReportRecords).filter((report) => report.exists).length,
      seedHashReuseCount: requiredSeedFileIds.filter((fileId) => (
        seedReportRecords[fileId]?.hash && finalReportRecords[fileId]?.hash
        && seedReportRecords[fileId].hash === finalReportRecords[fileId].hash
      )).length,
      gateSummarySeedLeakCount: requiredSeedFileIds.filter((fileId) => (
        seedReportRecords[fileId]?.hash
        && cleanGateSummary[gateHashKeys[fileId]] === seedReportRecords[fileId].hash
      )).length,
      finalBootstrapMarkerLeakCount: Object.values(finalReportRecords).filter((report) => report.seedMarker).length,
      sourceStepCount: (input.sourceSteps || []).length,
    },
  };
}

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    counts: analysis.counts,
    dirtySeedDecisions: analysis.dirtySeedDecisions,
    cleanSeedDecisions: analysis.cleanSeedDecisions,
    seedReports: analysis.seedReports,
    cleanFinalReports: analysis.cleanFinalReports,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      stepId: item.stepId || null,
      previousStepId: item.previousStepId || null,
      gateHashKey: item.gateHashKey || null,
      arg: item.arg || null,
    })),
  };
}

function observedBlockerCodes(analysis) {
  return uniqueSorted((analysis.blockers || []).map((item) => item.code));
}

function runScenario(scenario, baselineInput) {
  const input = clone(baselineInput);
  scenario.mutate(input);
  const analysis = analyzeGateCleanRerun(input);
  const observed = observedBlockerCodes(analysis);
  const blockers = [
    ...(analysis.ok ? [blocker(
      'report_gate_clean_rerun_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must make clean rerun analysis fail.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!observed.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_gate_clean_rerun_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observed.join(', ') || 'none'}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes: observed },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_gate_clean_rerun_scenario' : 'pass_report_gate_clean_rerun_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes: observed,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportGateCleanRerunRegressionReport({
  gateSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const baselineInput = buildBaseInput({ gateSourceText });
  const actual = analyzeGateCleanRerun(baselineInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baselineInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_gate_clean_rerun',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_GATE_CLEAN_RERUN_REGRESSION_VERSION,
    kind: 'ReportGateCleanRerunRegression',
    status: blockers.length ? 'blocked_report_gate_clean_rerun_regression' : 'pass_report_gate_clean_rerun_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_GATE_CLEAN_RERUN_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_GATE_CLEAN_RERUN_REGRESSION_SCRIPT_ID,
    fixture: {
      allowedSeedFileIds: [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS],
      gateHashKeys: { ...REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS },
      seedStatus: REPORT_BOOTSTRAP_SEED_STATUS,
      seedReason: REPORT_BOOTSTRAP_SEED_REASON,
      cleanSkipReason: CLEAN_SKIP_REASON,
      dirtyWriteReason: DIRTY_WRITE_REASON,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
    },
    actual: compactAnalysis(actual),
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      allowedSeedFileCount: actual.counts.allowedSeedFileCount,
      dirtySeedWriteCount: actual.counts.dirtySeedWriteCount,
      cleanSeedWriteCount: actual.counts.cleanSeedWriteCount,
      cleanSeedSkipCount: actual.counts.cleanSeedSkipCount,
      finalReportCount: actual.counts.finalReportCount,
      seedHashReuseCount: actual.counts.seedHashReuseCount,
      gateSummarySeedLeakCount: actual.counts.gateSummarySeedLeakCount,
      finalBootstrapMarkerLeakCount: actual.counts.finalBootstrapMarkerLeakCount,
      sourceStepCount: actual.counts.sourceStepCount,
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
  const gateCleanRerunRegressionHash = digest({
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
    gateCleanRerunRegressionHash,
    hash: gateCleanRerunRegressionHash,
  };
}

export function summarizeReportGateCleanRerunRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_gate_clean_rerun_regression',
    ok: report?.ok === true,
    gateCleanRerunRegressionHash: report?.gateCleanRerunRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    allowedSeedFileCount: report?.summary?.allowedSeedFileCount || 0,
    dirtySeedWriteCount: report?.summary?.dirtySeedWriteCount || 0,
    cleanSeedWriteCount: report?.summary?.cleanSeedWriteCount || 0,
    cleanSeedSkipCount: report?.summary?.cleanSeedSkipCount || 0,
    seedHashReuseCount: report?.summary?.seedHashReuseCount || 0,
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
      sourceInspectionOnly: report?.safety?.sourceInspectionOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
