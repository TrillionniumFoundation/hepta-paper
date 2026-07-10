import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
} from './report-bootstrap-seed-regression.mjs';

export const REPORT_POST_FINAL_DRIFT_REGRESSION_VERSION = 1;

export const REPORT_POST_FINAL_DRIFT_REGRESSION_REPORT_FILE_ID = 'report-post-final-drift-regression-latest.json';

export const REPORT_POST_FINAL_DRIFT_REGRESSION_SCRIPT_ID = 'reports:post-final-drift-regression';

const POST_FINAL_DRIFT_STEP_ID = 'report_post_final_drift_regression_export';

const DRIFT_WRITERS = Object.freeze([
  Object.freeze({
    driftId: 'audit_after_final_gate',
    command: 'npm run audit:integration:strict',
    fileId: 'integration-dependency-audit-latest.json',
    gateSummaryHashKey: 'integrationAuditHash',
  }),
  Object.freeze({
    driftId: 'tooling_after_final_gate',
    command: 'npm run integration:tooling',
    fileId: 'integration-gate-tooling-latest.json',
    gateSummaryHashKey: 'integrationGateToolingHash',
  }),
  Object.freeze({
    driftId: 'selftest_lanes_after_final_gate',
    command: 'npm run selftest:lanes',
    fileId: 'selftest-lanes-latest.json',
    gateSummaryHashKey: 'selftestLanesHash',
  }),
  Object.freeze({
    driftId: 'report_output_pairing_after_final_gate',
    command: 'npm run reports:output-pairing',
    fileId: 'report-output-pairing-latest.json',
    gateSummaryHashKey: 'reportOutputPairingHash',
  }),
]);

const REQUIRED_PACKAGE_SCRIPTS = Object.freeze({
  [REPORT_POST_FINAL_DRIFT_REGRESSION_SCRIPT_ID]: 'node src/export-report-post-final-drift-regression.mjs --strict',
  'gate:integration:strict': 'node src/integration-dependency-gate.mjs --strict',
  'reports:freshness': 'node src/export-report-freshness.mjs --strict',
  'checkpoint:architecture': 'node src/export-architecture-checkpoint.mjs --strict',
  'reports:bootstrap-seeds': 'node src/export-report-bootstrap-seeds.mjs',
});

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_post_final_drift_gate_step',
    label: 'The post-final drift regression gate step is missing',
    expectedBlockerCode: 'report_post_final_drift_gate_step_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps
        .filter((step) => step.stepId !== POST_FINAL_DRIFT_STEP_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'post_final_drift_gate_step_without_strict',
    label: 'The post-final drift regression gate step loses strict mode',
    expectedBlockerCode: 'report_post_final_drift_gate_step_arg_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === POST_FINAL_DRIFT_STEP_ID
        ? { ...step, args: step.args.filter((arg) => arg !== '--strict') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'post_final_drift_gate_step_without_parse_json',
    label: 'The post-final drift regression gate step stops parsing JSON stdout',
    expectedBlockerCode: 'report_post_final_drift_gate_step_parse_json_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === POST_FINAL_DRIFT_STEP_ID
        ? { ...step, parseJsonOutput: false }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'post_final_drift_before_final_settlement',
    label: 'The post-final drift guard moves before final settlement',
    expectedBlockerCode: 'report_post_final_drift_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepBefore(input.sourceSteps, POST_FINAL_DRIFT_STEP_ID, 'report_final_settlement_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'post_final_drift_after_runner_contract',
    label: 'The post-final drift guard moves after runner contract validation',
    expectedBlockerCode: 'report_post_final_drift_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(input.sourceSteps, POST_FINAL_DRIFT_STEP_ID, 'report_runner_contract_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'drift_event_hash_not_changed',
    label: 'A post-final drift writer refreshes a report without changing its hash',
    expectedBlockerCode: 'report_post_final_drift_event_hash_not_changed',
    mutate(input) {
      input.drift.events[0].afterHash = input.drift.events[0].beforeHash;
    },
  }),
  Object.freeze({
    scenarioId: 'drift_freshness_unexpectedly_passes',
    label: 'Freshness incorrectly passes after post-final latest drift',
    expectedBlockerCode: 'report_post_final_drift_freshness_not_blocked',
    mutate(input) {
      input.drift.postDriftFreshness.ok = true;
      input.drift.postDriftFreshness.status = 'pass_report_freshness';
      input.drift.postDriftFreshness.gateHashMismatchCount = 0;
      input.drift.postDriftFreshness.mismatchedFileIds = [];
    },
  }),
  Object.freeze({
    scenarioId: 'drift_freshness_missing_mismatch',
    label: 'Freshness blocks but does not identify every drifted gate-bound latest report',
    expectedBlockerCode: 'report_post_final_drift_freshness_mismatch_count_missing',
    mutate(input) {
      input.drift.postDriftFreshness.gateHashMismatchCount = 1;
      input.drift.postDriftFreshness.mismatchedFileIds = [input.drift.events[0].fileId];
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_accepts_post_final_drift',
    label: 'Architecture checkpoint accepts a blocked post-drift freshness report',
    expectedBlockerCode: 'report_post_final_drift_checkpoint_not_blocked',
    mutate(input) {
      input.drift.postDriftCheckpoint.ok = true;
      input.drift.postDriftCheckpoint.status = 'pass_architecture_checkpoint';
      input.drift.postDriftCheckpoint.blockerCodes = [];
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_final_gate_semantic_hash_missing',
    label: 'The final closeout gate loses gateHash while keeping a generic hash',
    expectedBlockerCode: 'report_post_final_drift_closeout_gate_hash_missing',
    mutate(input) {
      delete input.closeout.finalGate.gateHash;
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_final_freshness_semantic_hash_missing',
    label: 'The final closeout freshness loses freshnessHash while keeping a generic hash',
    expectedBlockerCode: 'report_post_final_drift_closeout_freshness_hash_missing',
    mutate(input) {
      delete input.closeout.finalFreshness.freshnessHash;
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_checkpoint_semantic_hash_missing',
    label: 'The final closeout checkpoint loses checkpointHash while keeping a generic hash',
    expectedBlockerCode: 'report_post_final_drift_closeout_checkpoint_hash_missing',
    mutate(input) {
      delete input.closeout.checkpoint.checkpointHash;
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_clean_gate_missing',
    label: 'Post-final drift recovery skips the clean gate rerun',
    expectedBlockerCode: 'report_post_final_drift_recovery_clean_gate_missing',
    mutate(input) {
      input.recovery.cleanGate = null;
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_clean_gate_semantic_hash_missing',
    label: 'The recovery clean gate loses gateHash while keeping a generic hash',
    expectedBlockerCode: 'report_post_final_drift_recovery_clean_gate_hash_missing',
    mutate(input) {
      delete input.recovery.cleanGate.gateHash;
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_freshness_semantic_hash_missing',
    label: 'Recovered freshness loses freshnessHash while keeping a generic hash',
    expectedBlockerCode: 'report_post_final_drift_recovery_freshness_hash_missing',
    mutate(input) {
      delete input.recovery.finalFreshness.freshnessHash;
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_checkpoint_semantic_hash_missing',
    label: 'Recovered checkpoint loses checkpointHash while keeping a generic hash',
    expectedBlockerCode: 'report_post_final_drift_recovery_checkpoint_hash_missing',
    mutate(input) {
      delete input.recovery.checkpoint.checkpointHash;
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_freshness_gate_hash_mismatch',
    label: 'Recovered final freshness still binds the stale gate hash',
    expectedBlockerCode: 'report_post_final_drift_recovery_freshness_gate_hash_mismatch',
    mutate(input) {
      input.recovery.finalFreshness.gateHash = input.closeout.finalGate.gateHash;
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_checkpoint_freshness_hash_mismatch',
    label: 'Recovered checkpoint binds a stale freshness hash',
    expectedBlockerCode: 'report_post_final_drift_recovery_checkpoint_freshness_hash_mismatch',
    mutate(input) {
      input.recovery.checkpoint.reportFreshnessHash = input.closeout.finalFreshness.freshnessHash;
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_seed_written',
    label: 'Recovered clean closeout writes a bootstrap seed',
    expectedBlockerCode: 'report_post_final_drift_recovery_seed_written',
    mutate(input) {
      input.recovery.cleanSeedCheck.seededFileCount = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'post_final_drift_script_missing',
    label: 'The package loses the post-final drift regression script',
    expectedBlockerCode: 'report_post_final_drift_package_script_missing',
    mutate(input) {
      delete input.packageScripts[REPORT_POST_FINAL_DRIFT_REGRESSION_SCRIPT_ID];
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

function hashFor(value) {
  return digest({
    fixture: 'report_post_final_drift_regression',
    value,
  });
}

function isSha256Hash(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ''));
}

function semanticReportHash(report, {
  label,
  semanticKey,
  missingCode,
  genericMissingCode,
  mismatchCode,
}, blockers) {
  const semanticHash = report?.[semanticKey] || null;
  const genericHash = report?.hash || null;
  if (!isSha256Hash(semanticHash)) {
    blockers.push(blocker(
      missingCode,
      `${label} must expose a stable sha256 ${semanticKey}; generic hash is not a substitute.`,
      { [semanticKey]: semanticHash },
    ));
  }
  if (!isSha256Hash(genericHash)) {
    blockers.push(blocker(
      genericMissingCode,
      `${label} must expose a stable sha256 generic hash alongside ${semanticKey}.`,
      { hash: genericHash },
    ));
  }
  if (isSha256Hash(semanticHash) && isSha256Hash(genericHash) && semanticHash !== genericHash) {
    blockers.push(blocker(
      mismatchCode,
      `${label} ${semanticKey} must match its generic hash.`,
      { [semanticKey]: semanticHash, hash: genericHash },
    ));
  }
  return semanticHash;
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

function sourceStepIndex(sourceSteps = [], stepId) {
  return sourceSteps.findIndex((step) => step.stepId === stepId);
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

function moveStepBefore(steps, movingStepId, anchorStepId) {
  const moving = steps.find((step) => step.stepId === movingStepId);
  if (!moving) return steps;
  const withoutMoving = steps.filter((step) => step.stepId !== movingStepId);
  const anchorIndex = withoutMoving.findIndex((step) => step.stepId === anchorStepId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex),
    moving,
    ...withoutMoving.slice(anchorIndex),
  ];
}

function ensureSourceOrder(sourceSteps, beforeStepId, afterStepId, blockers) {
  const beforeIndex = sourceStepIndex(sourceSteps, beforeStepId);
  const afterIndex = sourceStepIndex(sourceSteps, afterStepId);
  if (beforeIndex < 0 || afterIndex < 0) return;
  if (beforeIndex > afterIndex) {
    blockers.push(blocker(
      'report_post_final_drift_order_drift',
      `${beforeStepId} must run before ${afterStepId}.`,
      { beforeStepId, afterStepId },
    ));
  }
}

function buildDriftEvents() {
  return DRIFT_WRITERS.map((writer) => ({
    ...writer,
    beforeHash: hashFor(`${writer.fileId}:closed`),
    afterHash: hashFor(`${writer.fileId}:post_final_drifted`),
  }));
}

function buildBaseInput({
  gateSourceText = '',
  packageScripts = {},
} = {}) {
  const closeoutGateHash = hashFor('closeout_final_gate');
  const closeoutFreshnessHash = hashFor('closeout_final_freshness');
  const recoveryGateHash = hashFor('recovery_clean_gate');
  const recoveryFreshnessHash = hashFor('recovery_final_freshness');
  const driftEvents = buildDriftEvents();
  return {
    sourceSteps: extractIntegrationGateStepSpecs(gateSourceText),
    packageScripts: { ...(packageScripts || {}) },
    closeout: {
      finalGate: {
        ok: true,
        gateHash: closeoutGateHash,
        hash: closeoutGateHash,
      },
      finalFreshness: {
        ok: true,
        freshnessHash: closeoutFreshnessHash,
        hash: closeoutFreshnessHash,
        gateHash: closeoutGateHash,
        gateHashMismatchCount: 0,
      },
      checkpoint: {
        ok: true,
        reportFreshnessHash: closeoutFreshnessHash,
        checkpointHash: hashFor('closeout_checkpoint'),
        hash: hashFor('closeout_checkpoint'),
      },
    },
    drift: {
      events: driftEvents,
      postDriftFreshness: {
        ok: false,
        status: 'blocked_report_freshness',
        gateHash: closeoutGateHash,
        gateHashMismatchCount: driftEvents.length,
        mismatchedFileIds: driftEvents.map((event) => event.fileId),
        blockerCodes: ['report_freshness_gate_hash_mismatch'],
        hash: hashFor('post_drift_blocked_freshness'),
      },
      postDriftCheckpoint: {
        ok: false,
        status: 'blocked_architecture_checkpoint',
        reportFreshnessHash: hashFor('post_drift_blocked_freshness'),
        blockerCodes: ['report_freshness_gate_hash_mismatches_present'],
        hash: hashFor('post_drift_blocked_checkpoint'),
      },
    },
    recovery: {
      cleanGate: {
        ok: true,
        gateHash: recoveryGateHash,
        hash: recoveryGateHash,
      },
      finalFreshness: {
        ok: true,
        freshnessHash: recoveryFreshnessHash,
        hash: recoveryFreshnessHash,
        gateHash: recoveryGateHash,
        gateHashMismatchCount: 0,
      },
      checkpoint: {
        ok: true,
        reportFreshnessHash: recoveryFreshnessHash,
        checkpointHash: hashFor('recovery_checkpoint'),
        hash: hashFor('recovery_checkpoint'),
      },
      cleanSeedCheck: {
        ok: true,
        strict: true,
        seededFileCount: 0,
        skippedFileCount: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length,
      },
    },
  };
}

function analyzeInput(input = {}) {
  const blockers = [];
  const sourceSteps = input.sourceSteps || [];
  const driftEvents = input.drift?.events || [];

  for (const [scriptId, expectedCommand] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
    const actualCommand = input.packageScripts?.[scriptId] || null;
    if (!actualCommand) {
      blockers.push(blocker(
        'report_post_final_drift_package_script_missing',
        `${scriptId} must be present so post-final drift can be replayed locally.`,
        { scriptId },
      ));
    } else if (actualCommand !== expectedCommand) {
      blockers.push(blocker(
        'report_post_final_drift_package_script_command_drift',
        `${scriptId} must run ${expectedCommand}.`,
        { scriptId, expectedCommand, actualCommand },
      ));
    }
  }

  const driftStep = sourceSteps.find((step) => step.stepId === POST_FINAL_DRIFT_STEP_ID);
  if (!driftStep) {
    blockers.push(blocker(
      'report_post_final_drift_gate_step_missing',
      `Integration gate must run ${POST_FINAL_DRIFT_STEP_ID}.`,
      { stepId: POST_FINAL_DRIFT_STEP_ID },
    ));
  } else {
    for (const arg of ['src/export-report-post-final-drift-regression.mjs', '--strict']) {
      if (!driftStep.args.includes(arg)) {
        blockers.push(blocker(
          'report_post_final_drift_gate_step_arg_missing',
          `${POST_FINAL_DRIFT_STEP_ID} must include ${arg}.`,
          { stepId: POST_FINAL_DRIFT_STEP_ID, arg },
        ));
      }
    }
    if (driftStep.parseJsonOutput !== true) {
      blockers.push(blocker(
        'report_post_final_drift_gate_step_parse_json_missing',
        `${POST_FINAL_DRIFT_STEP_ID} must parse JSON output.`,
        { stepId: POST_FINAL_DRIFT_STEP_ID },
      ));
    }
  }

  ensureSourceOrder(sourceSteps, 'report_final_settlement_regression_export', POST_FINAL_DRIFT_STEP_ID, blockers);
  ensureSourceOrder(sourceSteps, POST_FINAL_DRIFT_STEP_ID, 'report_runner_contract_regression_export', blockers);
  ensureSourceOrder(sourceSteps, POST_FINAL_DRIFT_STEP_ID, 'report_freshness_export_pre_tooling', blockers);

  if (!driftEvents.length) {
    blockers.push(blocker(
      'report_post_final_drift_event_missing',
      'The regression must model at least one post-final latest writer.',
    ));
  }

  for (const event of driftEvents) {
    if (!event.fileId || !event.gateSummaryHashKey) {
      blockers.push(blocker(
        'report_post_final_drift_event_binding_missing',
        'Every drift event must bind a latest file to a gate summary hash key.',
        { driftId: event.driftId || null, fileId: event.fileId || null },
      ));
    }
    if (!event.beforeHash || !event.afterHash || event.beforeHash === event.afterHash) {
      blockers.push(blocker(
        'report_post_final_drift_event_hash_not_changed',
        `${event.fileId || 'unknown file'} must change hash in the post-final drift fixture.`,
        { driftId: event.driftId || null, fileId: event.fileId || null },
      ));
    }
  }

  const closeoutGate = input.closeout?.finalGate || null;
  const closeoutFreshness = input.closeout?.finalFreshness || {};
  const closeoutCheckpoint = input.closeout?.checkpoint || {};
  const closeoutGateHash = semanticReportHash(closeoutGate, {
    label: 'Final closeout gate',
    semanticKey: 'gateHash',
    missingCode: 'report_post_final_drift_closeout_gate_hash_missing',
    genericMissingCode: 'report_post_final_drift_closeout_gate_generic_hash_missing',
    mismatchCode: 'report_post_final_drift_closeout_gate_hash_mismatch',
  }, blockers);
  const closeoutFreshnessHash = semanticReportHash(closeoutFreshness, {
    label: 'Final closeout freshness',
    semanticKey: 'freshnessHash',
    missingCode: 'report_post_final_drift_closeout_freshness_hash_missing',
    genericMissingCode: 'report_post_final_drift_closeout_freshness_generic_hash_missing',
    mismatchCode: 'report_post_final_drift_closeout_freshness_hash_mismatch',
  }, blockers);
  semanticReportHash(closeoutCheckpoint, {
    label: 'Final closeout checkpoint',
    semanticKey: 'checkpointHash',
    missingCode: 'report_post_final_drift_closeout_checkpoint_hash_missing',
    genericMissingCode: 'report_post_final_drift_closeout_checkpoint_generic_hash_missing',
    mismatchCode: 'report_post_final_drift_closeout_checkpoint_hash_mismatch',
  }, blockers);
  if (closeoutGate?.ok !== true || !isSha256Hash(closeoutGateHash)) {
    blockers.push(blocker(
      'report_post_final_drift_closeout_gate_missing',
      'The post-final drift fixture must start from a clean final gate.',
    ));
  }
  if (closeoutFreshness.ok !== true
    || closeoutFreshness.gateHash !== closeoutGateHash
    || Number(closeoutFreshness.gateHashMismatchCount || 0) !== 0) {
    blockers.push(blocker(
      'report_post_final_drift_closeout_freshness_gate_hash_mismatch',
      'Final closeout freshness must bind the final gate semantic hash with zero mismatches.',
      {
        expectedGateHash: closeoutGateHash || null,
        actualGateHash: closeoutFreshness.gateHash || null,
      },
    ));
  }
  if (closeoutCheckpoint.ok !== true || closeoutCheckpoint.reportFreshnessHash !== closeoutFreshnessHash) {
    blockers.push(blocker(
      'report_post_final_drift_closeout_checkpoint_freshness_hash_mismatch',
      'Final closeout checkpoint must bind the final freshness semantic hash.',
      {
        expectedFreshnessHash: closeoutFreshnessHash || null,
        actualFreshnessHash: closeoutCheckpoint.reportFreshnessHash || null,
      },
    ));
  }

  const postDriftFreshness = input.drift?.postDriftFreshness || {};
  const expectedMismatchedFileIds = uniqueSorted(driftEvents.map((event) => event.fileId));
  const actualMismatchedFileIds = uniqueSorted(postDriftFreshness.mismatchedFileIds || []);
  if (postDriftFreshness.ok !== false || postDriftFreshness.status !== 'blocked_report_freshness') {
    blockers.push(blocker(
      'report_post_final_drift_freshness_not_blocked',
      'Report freshness must fail closed after post-final gate-bound latest drift.',
      { status: postDriftFreshness.status || null },
    ));
  }
  if (Number(postDriftFreshness.gateHashMismatchCount || 0) !== expectedMismatchedFileIds.length
    || expectedMismatchedFileIds.some((fileId) => !actualMismatchedFileIds.includes(fileId))) {
    blockers.push(blocker(
      'report_post_final_drift_freshness_mismatch_count_missing',
      'Report freshness must expose every post-final drift as a gate hash mismatch.',
      {
        expectedMismatchedFileIds,
        actualMismatchedFileIds,
        gateHashMismatchCount: Number(postDriftFreshness.gateHashMismatchCount || 0),
      },
    ));
  }

  const postDriftCheckpoint = input.drift?.postDriftCheckpoint || {};
  if (postDriftCheckpoint.ok !== false
    || !(postDriftCheckpoint.blockerCodes || []).includes('report_freshness_gate_hash_mismatches_present')) {
    blockers.push(blocker(
      'report_post_final_drift_checkpoint_not_blocked',
      'Architecture checkpoint must not accept a blocked post-drift freshness report.',
      { status: postDriftCheckpoint.status || null },
    ));
  }

  const cleanGate = input.recovery?.cleanGate || null;
  const recoveryFreshness = input.recovery?.finalFreshness || {};
  const recoveryCheckpoint = input.recovery?.checkpoint || {};
  const recoverySeed = input.recovery?.cleanSeedCheck || {};
  const recoveryGateHash = semanticReportHash(cleanGate, {
    label: 'Recovery clean gate',
    semanticKey: 'gateHash',
    missingCode: 'report_post_final_drift_recovery_clean_gate_hash_missing',
    genericMissingCode: 'report_post_final_drift_recovery_clean_gate_generic_hash_missing',
    mismatchCode: 'report_post_final_drift_recovery_clean_gate_hash_mismatch',
  }, blockers);
  const recoveryFreshnessHash = semanticReportHash(recoveryFreshness, {
    label: 'Recovery final freshness',
    semanticKey: 'freshnessHash',
    missingCode: 'report_post_final_drift_recovery_freshness_hash_missing',
    genericMissingCode: 'report_post_final_drift_recovery_freshness_generic_hash_missing',
    mismatchCode: 'report_post_final_drift_recovery_freshness_hash_mismatch',
  }, blockers);
  semanticReportHash(recoveryCheckpoint, {
    label: 'Recovery checkpoint',
    semanticKey: 'checkpointHash',
    missingCode: 'report_post_final_drift_recovery_checkpoint_hash_missing',
    genericMissingCode: 'report_post_final_drift_recovery_checkpoint_generic_hash_missing',
    mismatchCode: 'report_post_final_drift_recovery_checkpoint_hash_mismatch',
  }, blockers);
  if (!cleanGate || cleanGate.ok !== true || !isSha256Hash(recoveryGateHash)) {
    blockers.push(blocker(
      'report_post_final_drift_recovery_clean_gate_missing',
      'Recovering from post-final drift requires a clean integration gate rerun.',
    ));
  }
  if (recoveryFreshness.ok !== true
    || recoveryFreshness.gateHash !== recoveryGateHash
    || Number(recoveryFreshness.gateHashMismatchCount || 0) !== 0) {
    blockers.push(blocker(
      'report_post_final_drift_recovery_freshness_gate_hash_mismatch',
      'Recovered final freshness must bind the recovery clean gate hash with zero mismatches.',
      {
        expectedGateHash: recoveryGateHash || null,
        actualGateHash: recoveryFreshness.gateHash || null,
      },
    ));
  }
  if (recoveryCheckpoint.ok !== true || recoveryCheckpoint.reportFreshnessHash !== recoveryFreshnessHash) {
    blockers.push(blocker(
      'report_post_final_drift_recovery_checkpoint_freshness_hash_mismatch',
      'Recovered checkpoint must bind the recovered final freshness hash.',
      {
        expectedFreshnessHash: recoveryFreshnessHash || null,
        actualFreshnessHash: recoveryCheckpoint.reportFreshnessHash || null,
      },
    ));
  }
  if (Number(recoverySeed.seededFileCount || 0) !== 0) {
    blockers.push(blocker(
      'report_post_final_drift_recovery_seed_written',
      'Clean post-final drift recovery must not write bootstrap seeds.',
      { seededFileCount: Number(recoverySeed.seededFileCount || 0) },
    ));
  }
  if (Number(recoverySeed.skippedFileCount || 0) !== REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length) {
    blockers.push(blocker(
      'report_post_final_drift_recovery_seed_skip_count_mismatch',
      'Clean post-final drift recovery must skip every allowlisted bootstrap seed file.',
      {
        skippedFileCount: Number(recoverySeed.skippedFileCount || 0),
        expectedSkippedFileCount: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length,
      },
    ));
  }

  return {
    status: blockers.length ? 'blocked_report_post_final_drift_analysis' : 'pass_report_post_final_drift_analysis',
    ok: blockers.length === 0,
    driftEventCount: driftEvents.length,
    driftedFileIds: expectedMismatchedFileIds,
    postDriftFreshnessBlocked: postDriftFreshness.ok === false,
    postDriftFreshnessGateHashMismatchCount: Number(postDriftFreshness.gateHashMismatchCount || 0),
    postDriftCheckpointBlocked: postDriftCheckpoint.ok === false,
    recoveryCleanGateOk: cleanGate?.ok === true,
    recoveryFreshnessGateHashMatches: Boolean(isSha256Hash(recoveryGateHash) && recoveryFreshness.gateHash === recoveryGateHash),
    recoveryFreshnessGateHashMismatchCount: Number(recoveryFreshness.gateHashMismatchCount || 0),
    recoveryCheckpointFreshnessMatches: Boolean(isSha256Hash(recoveryFreshnessHash) && recoveryCheckpoint.reportFreshnessHash === recoveryFreshnessHash),
    recoverySeedWriteCount: Number(recoverySeed.seededFileCount || 0),
    recoverySeedSkipCount: Number(recoverySeed.skippedFileCount || 0),
    packageScriptCount: Object.keys(REQUIRED_PACKAGE_SCRIPTS).length,
    presentPackageScriptCount: Object.keys(REQUIRED_PACKAGE_SCRIPTS)
      .filter((scriptId) => input.packageScripts?.[scriptId]).length,
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
      'report_post_final_drift_scenario_unexpectedly_passed',
      `${scenario.scenarioId} passed unexpectedly.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!expectedObserved ? [blocker(
      'report_post_final_drift_expected_blocker_missing',
      `${scenario.scenarioId} did not produce ${scenario.expectedBlockerCode}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_post_final_drift_scenario' : 'pass_report_post_final_drift_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    blockers,
  };
}

export function buildReportPostFinalDriftRegressionReport({
  gateSourceText = '',
  packageScripts = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const actualInput = buildBaseInput({ gateSourceText, packageScripts });
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
    driftEventCount: actual.driftEventCount,
    driftedFileCount: actual.driftedFileIds.length,
    postDriftFreshnessBlocked: actual.postDriftFreshnessBlocked,
    postDriftFreshnessGateHashMismatchCount: actual.postDriftFreshnessGateHashMismatchCount,
    postDriftCheckpointBlocked: actual.postDriftCheckpointBlocked,
    recoveryCleanGateOk: actual.recoveryCleanGateOk,
    recoveryFreshnessGateHashMatches: actual.recoveryFreshnessGateHashMatches,
    recoveryFreshnessGateHashMismatchCount: actual.recoveryFreshnessGateHashMismatchCount,
    recoveryCheckpointFreshnessMatches: actual.recoveryCheckpointFreshnessMatches,
    recoverySeedWriteCount: actual.recoverySeedWriteCount,
    recoverySeedSkipCount: actual.recoverySeedSkipCount,
    packageScriptCount: actual.packageScriptCount,
    presentPackageScriptCount: actual.presentPackageScriptCount,
    expectedScenarioCount: NEGATIVE_SCENARIOS.length,
    scenarioCount: scenarios.length,
    passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
    failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
    observedExpectedBlockerCount: scenarios.filter((scenario) => (
      scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
    )).length,
    blockerCount: blockers.length,
  };
  const postFinalDriftRegressionHash = digest({
    version: REPORT_POST_FINAL_DRIFT_REGRESSION_VERSION,
    kind: 'ReportPostFinalDriftRegression',
    summary,
    actual: {
      driftedFileIds: actual.driftedFileIds,
      postDriftFreshnessBlocked: actual.postDriftFreshnessBlocked,
      postDriftCheckpointBlocked: actual.postDriftCheckpointBlocked,
      recoveryCleanGateOk: actual.recoveryCleanGateOk,
      recoveryFreshnessGateHashMatches: actual.recoveryFreshnessGateHashMatches,
      recoveryCheckpointFreshnessMatches: actual.recoveryCheckpointFreshnessMatches,
      recoverySeedWriteCount: actual.recoverySeedWriteCount,
      recoverySeedSkipCount: actual.recoverySeedSkipCount,
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
    version: REPORT_POST_FINAL_DRIFT_REGRESSION_VERSION,
    kind: 'ReportPostFinalDriftRegression',
    status: blockers.length ? 'blocked_report_post_final_drift_regression' : 'pass_report_post_final_drift_regression',
    ok: blockers.length === 0,
    generatedAt,
    postFinalDriftRegressionHash,
    hash: postFinalDriftRegressionHash,
    summary,
    fixture: {
      driftWriters: DRIFT_WRITERS.map((writer) => ({ ...writer })),
      requiredPackageScripts: { ...REQUIRED_PACKAGE_SCRIPTS },
      allowedBootstrapSeedFileIds: [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS],
    },
    actual,
    scenarios,
    blockers,
    safety: reportSafety(),
  };
}

export function summarizeReportPostFinalDriftRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || 'missing_report_post_final_drift_regression',
    postFinalDriftRegressionHash: report.postFinalDriftRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    driftEventCount: Number(report.summary?.driftEventCount || 0),
    postDriftFreshnessBlocked: report.summary?.postDriftFreshnessBlocked === true,
    postDriftFreshnessGateHashMismatchCount: Number(report.summary?.postDriftFreshnessGateHashMismatchCount || 0),
    postDriftCheckpointBlocked: report.summary?.postDriftCheckpointBlocked === true,
    recoveryCleanGateOk: report.summary?.recoveryCleanGateOk === true,
    recoveryFreshnessGateHashMatches: report.summary?.recoveryFreshnessGateHashMatches === true,
    recoveryCheckpointFreshnessMatches: report.summary?.recoveryCheckpointFreshnessMatches === true,
    recoverySeedWriteCount: Number(report.summary?.recoverySeedWriteCount || 0),
    recoverySeedSkipCount: Number(report.summary?.recoverySeedSkipCount || 0),
    scenarioCount: Number(report.summary?.scenarioCount || 0),
    passedScenarioCount: Number(report.summary?.passedScenarioCount || 0),
    blockerCount: Number(report.summary?.blockerCount || 0),
    safety: report.safety || {},
  };
}
