import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
} from './report-bootstrap-seed-regression.mjs';

export const REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_VERSION = 1;

export const REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_REPORT_FILE_ID = 'report-closeout-drift-classification-regression-latest.json';

export const REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_SCRIPT_ID = 'reports:closeout-drift-classification-regression';

const CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID = 'report_closeout_drift_classification_regression_export';

export const REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS = Object.freeze({
  [REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_SCRIPT_ID]: 'node src/export-report-closeout-drift-classification-regression.mjs --strict',
  'gate:integration:strict': 'node src/integration-dependency-gate.mjs --strict',
  'reports:prune:dry-run': 'node src/prune-reports.mjs --dry-run',
  'reports:freshness': 'node src/export-report-freshness.mjs --strict',
  'checkpoint:architecture': 'node src/export-architecture-checkpoint.mjs --strict',
  'reports:bootstrap-seeds': 'node src/export-report-bootstrap-seeds.mjs',
  'audit:integration:strict': 'node src/integration-dependency-audit.mjs --strict',
  'integration:tooling': 'node src/export-integration-gate-tooling.mjs --strict',
  'selftest:lanes': 'node src/selftest-lanes.mjs --strict',
  'reports:output-pairing': 'node src/export-report-output-pairing.mjs --strict',
});

export const REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS = Object.freeze([
  Object.freeze({
    commandId: 'final_gate',
    scriptId: 'gate:integration:strict',
    command: 'npm run gate:integration:strict',
    classification: 'required_clean_closeout_writer',
    closeoutPhase: 'final_gate',
    writesGateBoundLatest: true,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
  }),
  Object.freeze({
    commandId: 'retention_dry_run',
    scriptId: 'reports:prune:dry-run',
    command: 'npm run reports:prune:dry-run',
    classification: 'allowed_closeout_non_gate_bound_writer',
    closeoutPhase: 'retention_dry_run',
    writesGateBoundLatest: false,
    allowedAfterFinalCloseout: true,
    recoveryRequiredAfterDrift: false,
  }),
  Object.freeze({
    commandId: 'final_freshness',
    scriptId: 'reports:freshness',
    command: 'npm run reports:freshness',
    classification: 'required_clean_closeout_writer',
    closeoutPhase: 'final_freshness',
    writesGateBoundLatest: true,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
  }),
  Object.freeze({
    commandId: 'architecture_checkpoint',
    scriptId: 'checkpoint:architecture',
    command: 'npm run checkpoint:architecture',
    classification: 'required_clean_closeout_writer',
    closeoutPhase: 'architecture_checkpoint',
    writesGateBoundLatest: false,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
  }),
  Object.freeze({
    commandId: 'strict_bootstrap_seed_check',
    scriptId: 'reports:bootstrap-seeds',
    command: 'npm run reports:bootstrap-seeds -- --strict',
    classification: 'required_clean_closeout_zero_seed_check',
    closeoutPhase: 'zero_seed_check',
    writesGateBoundLatest: false,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
    cleanSeedWritesAllowed: false,
  }),
  Object.freeze({
    commandId: 'audit_after_closeout',
    scriptId: 'audit:integration:strict',
    command: 'npm run audit:integration:strict',
    classification: 'blocked_gate_bound_latest_writer',
    fileId: 'integration-dependency-audit-latest.json',
    gateSummaryHashKey: 'integrationAuditHash',
    writesGateBoundLatest: true,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
  }),
  Object.freeze({
    commandId: 'tooling_after_closeout',
    scriptId: 'integration:tooling',
    command: 'npm run integration:tooling',
    classification: 'blocked_gate_bound_latest_writer',
    fileId: 'integration-gate-tooling-latest.json',
    gateSummaryHashKey: 'integrationGateToolingHash',
    writesGateBoundLatest: true,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
  }),
  Object.freeze({
    commandId: 'selftest_lanes_after_closeout',
    scriptId: 'selftest:lanes',
    command: 'npm run selftest:lanes',
    classification: 'blocked_gate_bound_latest_writer',
    fileId: 'selftest-lanes-latest.json',
    gateSummaryHashKey: 'selftestLanesHash',
    writesGateBoundLatest: true,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
  }),
  Object.freeze({
    commandId: 'output_pairing_after_closeout',
    scriptId: 'reports:output-pairing',
    command: 'npm run reports:output-pairing',
    classification: 'blocked_gate_bound_latest_writer',
    fileId: 'report-output-pairing-latest.json',
    gateSummaryHashKey: 'reportOutputPairingHash',
    writesGateBoundLatest: true,
    allowedAfterFinalCloseout: false,
    recoveryRequiredAfterDrift: true,
  }),
  Object.freeze({
    commandId: 'active_seed_scan',
    command: 'rg active bootstrap seed markers',
    classification: 'allowed_read_only_probe',
    writesGateBoundLatest: false,
    allowedAfterFinalCloseout: true,
    recoveryRequiredAfterDrift: false,
  }),
  Object.freeze({
    commandId: 'diff_check',
    command: 'git diff --check',
    classification: 'allowed_read_only_probe',
    writesGateBoundLatest: false,
    allowedAfterFinalCloseout: true,
    recoveryRequiredAfterDrift: false,
  }),
]);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_closeout_drift_classification_gate_step',
    label: 'The closeout drift classification gate step is missing',
    expectedBlockerCode: 'report_closeout_drift_classification_gate_step_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps
        .filter((step) => step.stepId !== CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_drift_classification_gate_step_without_strict',
    label: 'The closeout drift classification gate step loses strict mode',
    expectedBlockerCode: 'report_closeout_drift_classification_gate_step_arg_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID
        ? { ...step, args: step.args.filter((arg) => arg !== '--strict') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_drift_classification_gate_step_without_parse_json',
    label: 'The closeout drift classification gate step stops parsing JSON stdout',
    expectedBlockerCode: 'report_closeout_drift_classification_gate_step_parse_json_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID
        ? { ...step, parseJsonOutput: false }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_drift_classification_before_post_final_drift',
    label: 'Classification moves before post-final drift proof',
    expectedBlockerCode: 'report_closeout_drift_classification_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepBefore(input.sourceSteps, CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID, 'report_post_final_drift_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_drift_classification_after_runner_contract',
    label: 'Classification moves after runner contract validation',
    expectedBlockerCode: 'report_closeout_drift_classification_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(input.sourceSteps, CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID, 'report_runner_contract_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'blocked_writer_missing',
    label: 'A gate-bound post-final writer is removed from the blocked class',
    expectedBlockerCode: 'report_closeout_drift_blocked_writer_missing',
    mutate(input) {
      input.commands = input.commands.filter((command) => command.commandId !== 'audit_after_closeout');
    },
  }),
  Object.freeze({
    scenarioId: 'blocked_writer_marked_allowed',
    label: 'A gate-bound post-final writer is marked allowed after closeout',
    expectedBlockerCode: 'report_closeout_drift_blocked_writer_allowed',
    mutate(input) {
      input.commands = input.commands.map((command) => (command.commandId === 'tooling_after_closeout'
        ? { ...command, allowedAfterFinalCloseout: true }
        : command));
    },
  }),
  Object.freeze({
    scenarioId: 'blocked_writer_no_recovery',
    label: 'A gate-bound post-final writer does not require clean closeout recovery',
    expectedBlockerCode: 'report_closeout_drift_blocked_writer_recovery_missing',
    mutate(input) {
      input.commands = input.commands.map((command) => (command.commandId === 'selftest_lanes_after_closeout'
        ? { ...command, recoveryRequiredAfterDrift: false }
        : command));
    },
  }),
  Object.freeze({
    scenarioId: 'blocked_writer_undocumented',
    label: 'A blocked post-final writer is not documented',
    expectedBlockerCode: 'report_closeout_drift_blocked_writer_docs_missing',
    mutate(input) {
      input.docsText = input.docsText.replaceAll('reports:output-pairing', '');
    },
  }),
  Object.freeze({
    scenarioId: 'clean_closeout_command_missing',
    label: 'A required clean closeout command is missing',
    expectedBlockerCode: 'report_closeout_drift_clean_closeout_command_missing',
    mutate(input) {
      input.commands = input.commands.filter((command) => command.commandId !== 'final_freshness');
    },
  }),
  Object.freeze({
    scenarioId: 'retention_dry_run_misclassified',
    label: 'Retention dry-run is misclassified as a gate-bound blocked writer',
    expectedBlockerCode: 'report_closeout_drift_retention_dry_run_misclassified',
    mutate(input) {
      input.commands = input.commands.map((command) => (command.commandId === 'retention_dry_run'
        ? { ...command, classification: 'blocked_gate_bound_latest_writer', writesGateBoundLatest: true, allowedAfterFinalCloseout: false }
        : command));
    },
  }),
  Object.freeze({
    scenarioId: 'strict_seed_check_writes_seed',
    label: 'Strict clean seed check allows seed writes',
    expectedBlockerCode: 'report_closeout_drift_clean_seed_check_may_write',
    mutate(input) {
      input.commands = input.commands.map((command) => (command.commandId === 'strict_bootstrap_seed_check'
        ? { ...command, cleanSeedWritesAllowed: true }
        : command));
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_drift_script_missing',
    label: 'The package loses the closeout drift classification script',
    expectedBlockerCode: 'report_closeout_drift_package_script_missing',
    mutate(input) {
      delete input.packageScripts[REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_SCRIPT_ID];
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_drift_script_command_drift',
    label: 'A required package script changes command',
    expectedBlockerCode: 'report_closeout_drift_package_script_command_drift',
    mutate(input) {
      input.packageScripts['reports:freshness'] = 'node src/export-report-freshness.mjs';
    },
  }),
]);

export const REPORT_CLOSEOUT_DRIFT_REQUIRED_BLOCKED_WRITER_IDS = Object.freeze([
  'audit_after_closeout',
  'tooling_after_closeout',
  'selftest_lanes_after_closeout',
  'output_pairing_after_closeout',
]);

export const REPORT_CLOSEOUT_DRIFT_REQUIRED_CLEAN_CLOSEOUT_IDS = Object.freeze([
  'final_gate',
  'retention_dry_run',
  'final_freshness',
  'architecture_checkpoint',
  'strict_bootstrap_seed_check',
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
      'report_closeout_drift_classification_order_drift',
      `${beforeStepId} must run before ${afterStepId}.`,
      { beforeStepId, afterStepId },
    ));
  }
}

function buildBaseInput({
  gateSourceText = '',
  packageScripts = {},
  docsText = '',
} = {}) {
  return {
    sourceSteps: extractIntegrationGateStepSpecs(gateSourceText),
    packageScripts: { ...(packageScripts || {}) },
    docsText,
    commands: REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS.map((command) => ({ ...command })),
  };
}

function analyzeInput(input = {}) {
  const blockers = [];
  const sourceSteps = input.sourceSteps || [];
  const commands = input.commands || [];
  const commandById = new Map(commands.map((command) => [command.commandId, command]));

  for (const [scriptId, expectedCommand] of Object.entries(REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS)) {
    const actualCommand = input.packageScripts?.[scriptId] || null;
    if (!actualCommand) {
      blockers.push(blocker(
        'report_closeout_drift_package_script_missing',
        `${scriptId} must be present so closeout drift command classes can be replayed locally.`,
        { scriptId },
      ));
    } else if (actualCommand !== expectedCommand) {
      blockers.push(blocker(
        'report_closeout_drift_package_script_command_drift',
        `${scriptId} must run ${expectedCommand}.`,
        { scriptId, expectedCommand, actualCommand },
      ));
    }
  }

  const classificationStep = sourceSteps.find((step) => step.stepId === CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID);
  if (!classificationStep) {
    blockers.push(blocker(
      'report_closeout_drift_classification_gate_step_missing',
      `Integration gate must run ${CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID}.`,
      { stepId: CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID },
    ));
  } else {
    for (const arg of ['src/export-report-closeout-drift-classification-regression.mjs', '--strict']) {
      if (!classificationStep.args.includes(arg)) {
        blockers.push(blocker(
          'report_closeout_drift_classification_gate_step_arg_missing',
          `${CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID} must include ${arg}.`,
          { stepId: CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID, arg },
        ));
      }
    }
    if (classificationStep.parseJsonOutput !== true) {
      blockers.push(blocker(
        'report_closeout_drift_classification_gate_step_parse_json_missing',
        `${CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID} must parse JSON output.`,
        { stepId: CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID },
      ));
    }
  }

  ensureSourceOrder(sourceSteps, 'report_post_final_drift_regression_export', CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID, blockers);
  ensureSourceOrder(sourceSteps, CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID, 'report_runner_contract_regression_export', blockers);
  ensureSourceOrder(sourceSteps, CLOSEOUT_DRIFT_CLASSIFICATION_STEP_ID, 'report_freshness_export_pre_tooling', blockers);

  for (const commandId of REPORT_CLOSEOUT_DRIFT_REQUIRED_CLEAN_CLOSEOUT_IDS) {
    if (!commandById.has(commandId)) {
      blockers.push(blocker(
        'report_closeout_drift_clean_closeout_command_missing',
        `${commandId} must be classified as part of the clean closeout sequence.`,
        { commandId },
      ));
    }
  }

  const retentionDryRun = commandById.get('retention_dry_run');
  if (!retentionDryRun
    || retentionDryRun.classification !== 'allowed_closeout_non_gate_bound_writer'
    || retentionDryRun.writesGateBoundLatest !== false
    || retentionDryRun.allowedAfterFinalCloseout !== true) {
    blockers.push(blocker(
      'report_closeout_drift_retention_dry_run_misclassified',
      'Retention dry-run must remain an allowed closeout writer that is not gate-bound drift.',
    ));
  }

  const strictSeedCheck = commandById.get('strict_bootstrap_seed_check');
  if (!strictSeedCheck || strictSeedCheck.cleanSeedWritesAllowed !== false) {
    blockers.push(blocker(
      'report_closeout_drift_clean_seed_check_may_write',
      'Strict clean bootstrap seed check must classify seed writes as disallowed in final closeout.',
      { allowedSeedFiles: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length },
    ));
  }

  for (const commandId of REPORT_CLOSEOUT_DRIFT_REQUIRED_BLOCKED_WRITER_IDS) {
    const command = commandById.get(commandId);
    if (!command) {
      blockers.push(blocker(
        'report_closeout_drift_blocked_writer_missing',
        `${commandId} must be classified as a blocked gate-bound latest writer after closeout.`,
        { commandId },
      ));
      continue;
    }
    if (command.classification !== 'blocked_gate_bound_latest_writer'
      || command.writesGateBoundLatest !== true
      || !command.fileId
      || !command.gateSummaryHashKey) {
      blockers.push(blocker(
        'report_closeout_drift_blocked_writer_missing',
        `${commandId} must keep gate-bound latest file and gate summary hash metadata.`,
        { commandId },
      ));
    }
    if (command.allowedAfterFinalCloseout !== false) {
      blockers.push(blocker(
        'report_closeout_drift_blocked_writer_allowed',
        `${commandId} must not be allowed after final closeout without recovery.`,
        { commandId },
      ));
    }
    if (command.recoveryRequiredAfterDrift !== true) {
      blockers.push(blocker(
        'report_closeout_drift_blocked_writer_recovery_missing',
        `${commandId} must require clean gate/freshness/checkpoint recovery after drift.`,
        { commandId },
      ));
    }
    if (!String(input.docsText || '').includes(command.scriptId)) {
      blockers.push(blocker(
        'report_closeout_drift_blocked_writer_docs_missing',
        `${command.scriptId} must be documented as a post-final drift writer.`,
        { commandId, scriptId: command.scriptId },
      ));
    }
  }

  const blockedWriters = commands.filter((command) => command.classification === 'blocked_gate_bound_latest_writer');
  const cleanCloseoutCommands = commands.filter((command) => REPORT_CLOSEOUT_DRIFT_REQUIRED_CLEAN_CLOSEOUT_IDS.includes(command.commandId));
  const readOnlyCommands = commands.filter((command) => command.classification === 'allowed_read_only_probe');
  const nonGateBoundWriters = commands.filter((command) => command.classification === 'allowed_closeout_non_gate_bound_writer');
  return {
    status: blockers.length ? 'blocked_report_closeout_drift_classification_analysis' : 'pass_report_closeout_drift_classification_analysis',
    ok: blockers.length === 0,
    commandCount: commands.length,
    cleanCloseoutCommandCount: cleanCloseoutCommands.length,
    blockedGateBoundWriterCount: blockedWriters.length,
    blockedGateBoundWriterIds: uniqueSorted(blockedWriters.map((command) => command.commandId)),
    documentedBlockedWriterCount: blockedWriters
      .filter((command) => String(input.docsText || '').includes(command.scriptId)).length,
    allowedReadOnlyProbeCount: readOnlyCommands.length,
    allowedNonGateBoundWriterCount: nonGateBoundWriters.length,
    recoveryRequiredBlockedWriterCount: blockedWriters
      .filter((command) => command.recoveryRequiredAfterDrift === true).length,
    cleanSeedAllowedFileCount: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length,
    cleanSeedWritesAllowed: strictSeedCheck?.cleanSeedWritesAllowed === true,
    packageScriptCount: Object.keys(REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS).length,
    presentPackageScriptCount: Object.keys(REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS)
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
      'report_closeout_drift_classification_scenario_unexpectedly_passed',
      `${scenario.scenarioId} passed unexpectedly.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!expectedObserved ? [blocker(
      'report_closeout_drift_classification_expected_blocker_missing',
      `${scenario.scenarioId} did not produce ${scenario.expectedBlockerCode}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_closeout_drift_classification_scenario' : 'pass_report_closeout_drift_classification_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    blockers,
  };
}

export function buildReportCloseoutDriftClassificationRegressionReport({
  gateSourceText = '',
  packageScripts = {},
  docsText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const actualInput = buildBaseInput({ gateSourceText, packageScripts, docsText });
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
    commandCount: actual.commandCount,
    cleanCloseoutCommandCount: actual.cleanCloseoutCommandCount,
    blockedGateBoundWriterCount: actual.blockedGateBoundWriterCount,
    documentedBlockedWriterCount: actual.documentedBlockedWriterCount,
    recoveryRequiredBlockedWriterCount: actual.recoveryRequiredBlockedWriterCount,
    allowedReadOnlyProbeCount: actual.allowedReadOnlyProbeCount,
    allowedNonGateBoundWriterCount: actual.allowedNonGateBoundWriterCount,
    cleanSeedWritesAllowed: actual.cleanSeedWritesAllowed,
    cleanSeedAllowedFileCount: actual.cleanSeedAllowedFileCount,
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
  const closeoutDriftClassificationRegressionHash = digest({
    version: REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_VERSION,
    kind: 'ReportCloseoutDriftClassificationRegression',
    summary,
    actual: {
      blockedGateBoundWriterIds: actual.blockedGateBoundWriterIds,
      cleanCloseoutCommandCount: actual.cleanCloseoutCommandCount,
      allowedReadOnlyProbeCount: actual.allowedReadOnlyProbeCount,
      allowedNonGateBoundWriterCount: actual.allowedNonGateBoundWriterCount,
      cleanSeedWritesAllowed: actual.cleanSeedWritesAllowed,
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
    version: REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_VERSION,
    kind: 'ReportCloseoutDriftClassificationRegression',
    status: blockers.length ? 'blocked_report_closeout_drift_classification_regression' : 'pass_report_closeout_drift_classification_regression',
    ok: blockers.length === 0,
    generatedAt,
    closeoutDriftClassificationRegressionHash,
    hash: closeoutDriftClassificationRegressionHash,
    summary,
    fixture: {
      commandClassifications: REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS.map((command) => ({ ...command })),
      requiredPackageScripts: { ...REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS },
      requiredBlockedWriterIds: [...REPORT_CLOSEOUT_DRIFT_REQUIRED_BLOCKED_WRITER_IDS],
      requiredCleanCloseoutIds: [...REPORT_CLOSEOUT_DRIFT_REQUIRED_CLEAN_CLOSEOUT_IDS],
      allowedBootstrapSeedFileIds: [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS],
    },
    actual,
    scenarios,
    blockers,
    safety: reportSafety(),
  };
}

export function summarizeReportCloseoutDriftClassificationRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || 'missing_report_closeout_drift_classification_regression',
    closeoutDriftClassificationRegressionHash: report.closeoutDriftClassificationRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    commandCount: Number(report.summary?.commandCount || 0),
    cleanCloseoutCommandCount: Number(report.summary?.cleanCloseoutCommandCount || 0),
    blockedGateBoundWriterCount: Number(report.summary?.blockedGateBoundWriterCount || 0),
    documentedBlockedWriterCount: Number(report.summary?.documentedBlockedWriterCount || 0),
    recoveryRequiredBlockedWriterCount: Number(report.summary?.recoveryRequiredBlockedWriterCount || 0),
    allowedReadOnlyProbeCount: Number(report.summary?.allowedReadOnlyProbeCount || 0),
    allowedNonGateBoundWriterCount: Number(report.summary?.allowedNonGateBoundWriterCount || 0),
    cleanSeedWritesAllowed: report.summary?.cleanSeedWritesAllowed === true,
    scenarioCount: Number(report.summary?.scenarioCount || 0),
    passedScenarioCount: Number(report.summary?.passedScenarioCount || 0),
    blockerCount: Number(report.summary?.blockerCount || 0),
    safety: report.safety || {},
  };
}
