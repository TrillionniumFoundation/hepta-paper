import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
  REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS,
  REPORT_BOOTSTRAP_SEED_REASON,
} from './report-bootstrap-seed-regression.mjs';

export const REPORT_CLEAN_GATE_IDEMPOTENCE_REGRESSION_VERSION = 1;

export const REPORT_CLEAN_GATE_IDEMPOTENCE_REGRESSION_REPORT_FILE_ID = 'report-clean-gate-idempotence-regression-latest.json';

export const REPORT_CLEAN_GATE_IDEMPOTENCE_REGRESSION_SCRIPT_ID = 'reports:clean-gate-idempotence-regression';

const FIXTURE_GENERATED_AT_A = '2026-01-01T00:00:00.000Z';
const FIXTURE_GENERATED_AT_B = '2026-01-01T00:05:00.000Z';
const CLEAN_SKIP_REASON = 'already_ok_final_report';

const TRACKED_EXTRA_FILE_IDS = Object.freeze([
  'architecture-checkpoint-latest.json',
]);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'second_run_hash_drift',
    label: 'The second clean gate run changes a semantic report hash',
    expectedBlockerCode: 'report_clean_gate_idempotence_hash_drift',
    mutate(input) {
      const fileId = 'report-freshness-latest.json';
      input.runB.reports[fileId].hash = hashFor(fileId, 'run_b_drift');
    },
  }),
  Object.freeze({
    scenarioId: 'second_run_hash_missing',
    label: 'The second clean gate run loses a tracked report hash',
    expectedBlockerCode: 'report_clean_gate_idempotence_hash_missing',
    mutate(input) {
      delete input.runB.reports['integration-gate-tooling-latest.json'].hash;
    },
  }),
  Object.freeze({
    scenarioId: 'second_run_writes_seed',
    label: 'The second clean gate run writes a bootstrap seed',
    expectedBlockerCode: 'report_clean_gate_idempotence_seed_written_on_clean_run',
    mutate(input) {
      const fileId = 'integration-dependency-audit-latest.json';
      input.runB.seedDecisions[fileId] = {
        ...input.runB.seedDecisions[fileId],
        write: true,
        reason: 'forced_seed',
      };
    },
  }),
  Object.freeze({
    scenarioId: 'first_run_clean_skip_missing',
    label: 'The first clean gate run loses a bootstrap skip decision',
    expectedBlockerCode: 'report_clean_gate_idempotence_clean_skip_missing',
    mutate(input) {
      delete input.runA.seedDecisions['report-schema-contract-latest.json'];
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_mismatch',
    label: 'The second gate summary drifts from the latest report hash',
    expectedBlockerCode: 'report_clean_gate_idempotence_gate_summary_hash_mismatch',
    mutate(input) {
      input.runB.gateSummary.reportFreshnessHash = hashFor('report-freshness-latest.json', 'gate_summary_drift');
    },
  }),
  Object.freeze({
    scenarioId: 'seed_marker_leak',
    label: 'A clean run final latest report still carries a bootstrap seed marker',
    expectedBlockerCode: 'report_clean_gate_idempotence_seed_marker_leaked',
    mutate(input) {
      input.runB.reports['integration-dependency-gate-latest.json'].bootstrapSeed = true;
    },
  }),
  Object.freeze({
    scenarioId: 'idempotence_gate_step_missing',
    label: 'The clean gate idempotence regression step disappears from the gate',
    expectedBlockerCode: 'report_clean_gate_idempotence_gate_step_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps
        .filter((step) => step.stepId !== 'report_clean_gate_idempotence_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'idempotence_gate_step_without_strict',
    label: 'The clean gate idempotence regression step loses strict mode',
    expectedBlockerCode: 'report_clean_gate_idempotence_gate_step_arg_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === 'report_clean_gate_idempotence_regression_export'
        ? { ...step, args: step.args.filter((arg) => arg !== '--strict') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'idempotence_after_runner_contract',
    label: 'The idempotence regression moves after runner contract validation',
    expectedBlockerCode: 'report_clean_gate_idempotence_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(input.sourceSteps, 'report_clean_gate_idempotence_regression_export', 'report_runner_contract_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'clean_rerun_after_idempotence',
    label: 'The clean rerun regression moves after the idempotence guard',
    expectedBlockerCode: 'report_clean_gate_idempotence_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(input.sourceSteps, 'report_gate_clean_rerun_regression_export', 'report_clean_gate_idempotence_regression_export');
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function trackedFileIds() {
  return uniqueSorted([
    ...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
    ...TRACKED_EXTRA_FILE_IDS,
  ]);
}

function hashFor(fileId, variant = 'clean_semantic_hash') {
  return digest({
    fixture: 'report_clean_gate_idempotence_regression',
    fileId,
    variant,
  });
}

function reportSafety(extra = {}) {
  return {
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
    ...extra,
  };
}

function buildCleanLatestReport(fileId, runId) {
  const hash = hashFor(fileId);
  return {
    version: 1,
    kind: 'SyntheticCleanGateIdempotenceLatestReport',
    status: 'pass_clean_gate_idempotence_latest_report',
    ok: true,
    generatedAt: runId === 'run_a' ? FIXTURE_GENERATED_AT_A : FIXTURE_GENERATED_AT_B,
    fileId,
    runId,
    summary: {
      blockerCount: 0,
      variant: 'clean_gate_semantic_equivalent',
      noisyGeneratedAtIgnored: true,
    },
    blockers: [],
    safety: reportSafety(),
    hash,
    reportHash: hash,
  };
}

function buildGateSummary(reports = {}) {
  const summary = {};
  for (const [fileId, hashKey] of Object.entries(REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS)) {
    summary[hashKey] = reports[fileId]?.hash || null;
  }
  return summary;
}

function buildSeedDecisions(reports = {}) {
  return Object.fromEntries(REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.map((fileId) => [fileId, {
    write: false,
    reason: CLEAN_SKIP_REASON,
    hash: reports[fileId]?.hash || null,
    status: reports[fileId]?.status || null,
  }]));
}

function buildCleanRun(runId) {
  const reports = Object.fromEntries(trackedFileIds().map((fileId) => [
    fileId,
    buildCleanLatestReport(fileId, runId),
  ]));
  return {
    runId,
    reports,
    gateSummary: buildGateSummary(reports),
    seedDecisions: buildSeedDecisions(reports),
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

function sourceStepIndex(sourceSteps = [], stepId) {
  return sourceSteps.findIndex((step) => step.stepId === stepId);
}

function ensureOrder(sourceSteps, beforeStepId, afterStepId, blockers) {
  const beforeIndex = sourceStepIndex(sourceSteps, beforeStepId);
  const afterIndex = sourceStepIndex(sourceSteps, afterStepId);
  if (beforeIndex < 0 || afterIndex < 0) return;
  if (beforeIndex > afterIndex) {
    blockers.push(blocker(
      'report_clean_gate_idempotence_order_drift',
      `${beforeStepId} must run before ${afterStepId}.`,
      { beforeStepId, afterStepId },
    ));
  }
}

function hasSeedMarker(report = {}) {
  return report.bootstrapSeed === true
    || report.summary?.bootstrapSeed === true
    || report.seedReason === REPORT_BOOTSTRAP_SEED_REASON
    || String(report.status || '').includes('bootstrap');
}

function validateCleanRun({ run, runLabel, counterpartRun, sourceSteps }) {
  const blockers = [];
  const comparable = [];
  for (const fileId of trackedFileIds()) {
    const report = run.reports[fileId];
    const counterpart = counterpartRun.reports[fileId];
    if (!report) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_report_missing',
        `${runLabel} is missing ${fileId}.`,
        { runId: run.runId, fileId },
      ));
      continue;
    }
    if (!report.hash) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_hash_missing',
        `${runLabel} ${fileId} does not expose a stable hash.`,
        { runId: run.runId, fileId },
      ));
    }
    if (counterpart?.hash && report.hash && counterpart.hash !== report.hash) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_hash_drift',
        `${fileId} changed semantic hash across clean gate runs.`,
        { fileId, firstHash: counterpart.hash, secondHash: report.hash },
      ));
    }
    if (hasSeedMarker(report)) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_seed_marker_leaked',
        `${runLabel} ${fileId} still carries bootstrap seed markers.`,
        { runId: run.runId, fileId },
      ));
    }
    if (report.hash && counterpart?.hash) {
      comparable.push({ fileId, hash: report.hash, counterpartHash: counterpart.hash });
    }
  }

  for (const fileId of REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS) {
    const decision = run.seedDecisions[fileId];
    if (!decision) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_clean_skip_missing',
        `${runLabel} is missing clean bootstrap skip decision for ${fileId}.`,
        { runId: run.runId, fileId },
      ));
      continue;
    }
    if (decision.write === true) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_seed_written_on_clean_run',
        `${runLabel} writes a bootstrap seed for ${fileId}; clean gate reruns must skip.`,
        { runId: run.runId, fileId, reason: decision.reason },
      ));
    }
    if (decision.reason !== CLEAN_SKIP_REASON) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_clean_skip_reason_mismatch',
        `${runLabel} ${fileId} skip reason must be ${CLEAN_SKIP_REASON}.`,
        { runId: run.runId, fileId, reason: decision.reason || null },
      ));
    }
    if (!decision.hash) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_clean_skip_hash_missing',
        `${runLabel} ${fileId} skip decision must bind the final report hash.`,
        { runId: run.runId, fileId },
      ));
    }
    if (decision.hash && run.reports[fileId]?.hash && decision.hash !== run.reports[fileId].hash) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_clean_skip_hash_mismatch',
        `${runLabel} ${fileId} skip decision hash must match final report hash.`,
        { runId: run.runId, fileId, decisionHash: decision.hash, reportHash: run.reports[fileId].hash },
      ));
    }
  }

  for (const [fileId, hashKey] of Object.entries(REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS)) {
    const expectedHash = run.reports[fileId]?.hash || null;
    const gateHash = run.gateSummary?.[hashKey] || null;
    if (!gateHash) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_gate_summary_hash_missing',
        `${runLabel} gate summary is missing ${hashKey}.`,
        { runId: run.runId, fileId, hashKey },
      ));
    } else if (expectedHash && gateHash !== expectedHash) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_gate_summary_hash_mismatch',
        `${runLabel} gate summary ${hashKey} must match ${fileId}.`,
        { runId: run.runId, fileId, hashKey, expectedHash, gateHash },
      ));
    }
  }

  const idempotenceStep = sourceSteps.find((step) => step.stepId === 'report_clean_gate_idempotence_regression_export');
  if (!idempotenceStep) {
    blockers.push(blocker(
      'report_clean_gate_idempotence_gate_step_missing',
      'Integration gate must run report_clean_gate_idempotence_regression_export.',
      { stepId: 'report_clean_gate_idempotence_regression_export' },
    ));
  } else {
    if (!idempotenceStep.args.includes('--strict')) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_gate_step_arg_missing',
        'report_clean_gate_idempotence_regression_export must run with --strict.',
        { stepId: idempotenceStep.stepId, arg: '--strict' },
      ));
    }
    if (idempotenceStep.parseJsonOutput !== true) {
      blockers.push(blocker(
        'report_clean_gate_idempotence_gate_step_parse_json_missing',
        'report_clean_gate_idempotence_regression_export must parse JSON output.',
        { stepId: idempotenceStep.stepId },
      ));
    }
  }

  ensureOrder(sourceSteps, 'report_bootstrap_seed_export', 'report_clean_gate_idempotence_regression_export', blockers);
  ensureOrder(sourceSteps, 'report_gate_clean_rerun_regression_export', 'report_clean_gate_idempotence_regression_export', blockers);
  ensureOrder(sourceSteps, 'report_clean_gate_idempotence_regression_export', 'report_runner_contract_regression_export', blockers);

  return {
    runId: run.runId,
    status: blockers.length ? 'blocked_clean_gate_idempotence_analysis' : 'pass_clean_gate_idempotence_analysis',
    ok: blockers.length === 0,
    comparableHashCount: comparable.length,
    matchingHashCount: comparable.filter((item) => item.hash === item.counterpartHash).length,
    seedWriteCount: Object.values(run.seedDecisions || {}).filter((decision) => decision.write === true).length,
    seedSkipCount: Object.values(run.seedDecisions || {}).filter((decision) => decision.write === false).length,
    gateSummaryHashCount: Object.keys(run.gateSummary || {}).length,
    blockers,
  };
}

function buildActualInput({ gateSourceText = '' } = {}) {
  return {
    sourceSteps: extractIntegrationGateStepSpecs(gateSourceText),
    runA: buildCleanRun('run_a'),
    runB: buildCleanRun('run_b'),
  };
}

function analyzeInput(input) {
  const runA = validateCleanRun({
    run: input.runA,
    runLabel: 'run A',
    counterpartRun: input.runB,
    sourceSteps: input.sourceSteps,
  });
  const runB = validateCleanRun({
    run: input.runB,
    runLabel: 'run B',
    counterpartRun: input.runA,
    sourceSteps: input.sourceSteps,
  });
  const blockers = [...runA.blockers, ...runB.blockers];
  return {
    status: blockers.length ? 'blocked_clean_gate_idempotence_actual' : 'pass_clean_gate_idempotence_actual',
    ok: blockers.length === 0,
    runA,
    runB,
    blockers,
  };
}

function evaluateScenario(input, scenario) {
  const mutated = clone(input);
  scenario.mutate(mutated);
  const analysis = analyzeInput(mutated);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const expectedObserved = observedBlockerCodes.includes(scenario.expectedBlockerCode);
  const blockers = [
    ...(analysis.ok ? [blocker(
      'report_clean_gate_idempotence_scenario_unexpectedly_passed',
      `${scenario.scenarioId} passed unexpectedly.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!expectedObserved ? [blocker(
      'report_clean_gate_idempotence_expected_blocker_missing',
      `${scenario.scenarioId} did not produce ${scenario.expectedBlockerCode}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_clean_gate_idempotence_scenario' : 'pass_clean_gate_idempotence_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    blockers,
  };
}

export function buildReportCleanGateIdempotenceRegressionReport({
  gateSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const actualInput = buildActualInput({ gateSourceText });
  const actual = analyzeInput(actualInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => evaluateScenario(actualInput, scenario));
  const blockers = [
    ...actual.blockers,
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const summary = {
    actualOk: actual.ok,
    trackedReportCount: trackedFileIds().length,
    allowedSeedFileCount: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length,
    runAComparableHashCount: actual.runA.comparableHashCount,
    runBComparableHashCount: actual.runB.comparableHashCount,
    runAMatchingHashCount: actual.runA.matchingHashCount,
    runBMatchingHashCount: actual.runB.matchingHashCount,
    seedWriteCount: actual.runA.seedWriteCount + actual.runB.seedWriteCount,
    seedSkipCount: actual.runA.seedSkipCount + actual.runB.seedSkipCount,
    gateSummaryHashCount: actual.runA.gateSummaryHashCount + actual.runB.gateSummaryHashCount,
    expectedScenarioCount: NEGATIVE_SCENARIOS.length,
    scenarioCount: scenarios.length,
    passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
    failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
    observedExpectedBlockerCount: scenarios.filter((scenario) => (
      scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
    )).length,
    blockerCount: blockers.length,
  };
  const cleanGateIdempotenceRegressionHash = digest({
    version: REPORT_CLEAN_GATE_IDEMPOTENCE_REGRESSION_VERSION,
    kind: 'ReportCleanGateIdempotenceRegression',
    summary,
    actual: {
      runA: {
        comparableHashCount: actual.runA.comparableHashCount,
        matchingHashCount: actual.runA.matchingHashCount,
        seedWriteCount: actual.runA.seedWriteCount,
        seedSkipCount: actual.runA.seedSkipCount,
        gateSummaryHashCount: actual.runA.gateSummaryHashCount,
      },
      runB: {
        comparableHashCount: actual.runB.comparableHashCount,
        matchingHashCount: actual.runB.matchingHashCount,
        seedWriteCount: actual.runB.seedWriteCount,
        seedSkipCount: actual.runB.seedSkipCount,
        gateSummaryHashCount: actual.runB.gateSummaryHashCount,
      },
    },
    scenarios: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
    })),
    blockers: blockers.map((item) => item.code),
  });
  return {
    version: REPORT_CLEAN_GATE_IDEMPOTENCE_REGRESSION_VERSION,
    kind: 'ReportCleanGateIdempotenceRegression',
    status: blockers.length ? 'blocked_report_clean_gate_idempotence_regression' : 'pass_report_clean_gate_idempotence_regression',
    ok: blockers.length === 0,
    generatedAt,
    cleanGateIdempotenceRegressionHash,
    hash: cleanGateIdempotenceRegressionHash,
    summary,
    fixture: {
      trackedFileIds: trackedFileIds(),
      allowedSeedFileIds: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
      gateHashKeys: REPORT_BOOTSTRAP_SEED_GATE_HASH_KEYS,
      cleanSkipReason: CLEAN_SKIP_REASON,
    },
    actual: {
      runA: actual.runA,
      runB: actual.runB,
    },
    scenarios,
    blockers,
    safety: reportSafety(),
  };
}

export function summarizeReportCleanGateIdempotenceRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || 'missing_report_clean_gate_idempotence_regression',
    cleanGateIdempotenceRegressionHash: report.cleanGateIdempotenceRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    trackedReportCount: Number(report.summary?.trackedReportCount || 0),
    seedWriteCount: Number(report.summary?.seedWriteCount || 0),
    seedSkipCount: Number(report.summary?.seedSkipCount || 0),
    gateSummaryHashCount: Number(report.summary?.gateSummaryHashCount || 0),
    scenarioCount: Number(report.summary?.scenarioCount || 0),
    passedScenarioCount: Number(report.summary?.passedScenarioCount || 0),
    blockerCount: Number(report.summary?.blockerCount || 0),
    safety: report.safety || {},
  };
}
