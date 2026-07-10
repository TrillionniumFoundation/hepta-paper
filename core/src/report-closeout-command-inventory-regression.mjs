import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_SCRIPT_ID,
  REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS,
  REPORT_CLOSEOUT_DRIFT_REQUIRED_BLOCKED_WRITER_IDS,
  REPORT_CLOSEOUT_DRIFT_REQUIRED_CLEAN_CLOSEOUT_IDS,
  REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS,
} from './report-closeout-drift-classification-regression.mjs';

export const REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_VERSION = 1;

export const REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_REPORT_FILE_ID = 'report-closeout-command-inventory-regression-latest.json';

export const REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_SCRIPT_ID = 'reports:closeout-command-inventory-regression';

export const REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID = 'report_closeout_command_inventory_regression_export';

const REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_EXPORTER_PATH = 'src/export-report-closeout-command-inventory-regression.mjs';

const GUARD_SCRIPT_IDS = Object.freeze([
  REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_SCRIPT_ID,
  REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_SCRIPT_ID,
]);

const REQUIRED_READ_ONLY_PROBE_IDS = Object.freeze([
  'active_seed_scan',
  'diff_check',
]);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'inventory_script_missing',
    label: 'The package loses the closeout command inventory script',
    expectedBlockerCode: 'report_closeout_command_inventory_package_script_missing',
    mutate(input) {
      delete input.packageScripts[REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_SCRIPT_ID];
    },
  }),
  Object.freeze({
    scenarioId: 'inventory_script_command_drift',
    label: 'The package inventory script stops running strict mode',
    expectedBlockerCode: 'report_closeout_command_inventory_package_script_command_drift',
    mutate(input) {
      input.packageScripts[REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_SCRIPT_ID] = 'node src/export-report-closeout-command-inventory-regression.mjs';
    },
  }),
  Object.freeze({
    scenarioId: 'classified_script_missing',
    label: 'A classified closeout command package script is missing',
    expectedBlockerCode: 'report_closeout_command_inventory_classified_script_missing',
    mutate(input) {
      delete input.packageScripts['reports:freshness'];
    },
  }),
  Object.freeze({
    scenarioId: 'unclassified_package_closeout_script',
    label: 'A new closeout package script is added without classification',
    expectedBlockerCode: 'report_closeout_command_inventory_unclassified_package_script',
    mutate(input) {
      input.packageScripts['reports:closeout-surprise'] = 'node src/export-report-closeout-surprise.mjs --strict';
    },
  }),
  Object.freeze({
    scenarioId: 'unclassified_doc_closeout_command',
    label: 'Docs mention a closeout command that is not classified',
    expectedBlockerCode: 'report_closeout_command_inventory_unclassified_doc_command',
    mutate(input) {
      input.docsText += '\n`reports:closeout-surprise`\n';
    },
  }),
  Object.freeze({
    scenarioId: 'blocked_writer_docs_missing',
    label: 'A blocked post-final writer loses documentation',
    expectedBlockerCode: 'report_closeout_command_inventory_classified_script_docs_missing',
    mutate(input) {
      input.docsText = input.docsText.replaceAll('reports:output-pairing', '');
    },
  }),
  Object.freeze({
    scenarioId: 'clean_closeout_docs_missing',
    label: 'A required clean closeout command loses documentation',
    expectedBlockerCode: 'report_closeout_command_inventory_classified_script_docs_missing',
    mutate(input) {
      input.docsText = input.docsText.replaceAll('gate:integration:strict', '');
    },
  }),
  Object.freeze({
    scenarioId: 'read_only_probe_missing',
    label: 'A read-only closeout probe is removed from the classification source',
    expectedBlockerCode: 'report_closeout_command_inventory_required_probe_missing',
    mutate(input) {
      input.commands = input.commands.filter((command) => command.commandId !== 'active_seed_scan');
    },
  }),
  Object.freeze({
    scenarioId: 'classification_exports_private',
    label: 'The classification report stops exporting its command inventory constants',
    expectedBlockerCode: 'report_closeout_command_inventory_classification_exports_missing',
    mutate(input) {
      input.classificationSourceText = input.classificationSourceText
        .replaceAll('export const REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS', 'const REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS');
    },
  }),
  Object.freeze({
    scenarioId: 'inventory_gate_step_missing',
    label: 'The integration gate omits the closeout command inventory step',
    expectedBlockerCode: 'report_closeout_command_inventory_gate_step_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps
        .filter((step) => step.stepId !== REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'inventory_gate_step_without_strict',
    label: 'The inventory gate step loses strict mode',
    expectedBlockerCode: 'report_closeout_command_inventory_gate_step_arg_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID
        ? { ...step, args: step.args.filter((arg) => arg !== '--strict') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'inventory_gate_step_without_parse_json',
    label: 'The inventory gate step stops parsing JSON stdout',
    expectedBlockerCode: 'report_closeout_command_inventory_gate_step_parse_json_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID
        ? { ...step, parseJsonOutput: false }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'inventory_before_classification',
    label: 'Inventory moves before the closeout classification report',
    expectedBlockerCode: 'report_closeout_command_inventory_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepBefore(
        input.sourceSteps,
        REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID,
        'report_closeout_drift_classification_regression_export',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'inventory_after_runner_contract',
    label: 'Inventory moves after runner contract validation',
    expectedBlockerCode: 'report_closeout_command_inventory_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(
        input.sourceSteps,
        REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID,
        'report_runner_contract_regression_export',
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

function sourceStepIndex(sourceSteps = [], stepId) {
  return sourceSteps.findIndex((step) => step.stepId === stepId);
}

function ensureSourceOrder(sourceSteps, beforeStepId, afterStepId, blockers) {
  const beforeIndex = sourceStepIndex(sourceSteps, beforeStepId);
  const afterIndex = sourceStepIndex(sourceSteps, afterStepId);
  if (beforeIndex < 0 || afterIndex < 0) return;
  if (beforeIndex > afterIndex) {
    blockers.push(blocker(
      'report_closeout_command_inventory_order_drift',
      `${beforeStepId} must run before ${afterStepId}.`,
      { beforeStepId, afterStepId },
    ));
  }
}

function classifiedScriptIds(commands = []) {
  return uniqueSorted(commands.map((command) => command.scriptId));
}

function docsScriptIds(docsText = '') {
  const text = String(docsText || '');
  return uniqueSorted([
    ...[...text.matchAll(/\bnpm\s+run\s+([a-z0-9:-]+)/g)].map((match) => match[1]),
    ...[...text.matchAll(/`([a-z0-9]+(?::[a-z0-9-]+)+)`/g)].map((match) => match[1]),
  ]);
}

function isCloseoutRelevantScriptId(scriptId, { classifiedSet, guardSet }) {
  if (!scriptId) return false;
  return classifiedSet.has(scriptId)
    || guardSet.has(scriptId)
    || /^reports:closeout-/.test(scriptId);
}

function buildBaseInput({
  gateSourceText = '',
  packageScripts = {},
  docsText = '',
  classificationSourceText = '',
  commands = REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS,
} = {}) {
  return {
    sourceSteps: extractIntegrationGateStepSpecs(gateSourceText),
    packageScripts: { ...(packageScripts || {}) },
    docsText,
    classificationSourceText,
    commands: commands.map((command) => ({ ...command })),
  };
}

function analyzeInput(input = {}) {
  const blockers = [];
  const sourceSteps = input.sourceSteps || [];
  const commands = input.commands || [];
  const commandById = new Map(commands.map((command) => [command.commandId, command]));
  const scriptIds = classifiedScriptIds(commands);
  const classifiedSet = new Set(scriptIds);
  const guardSet = new Set(GUARD_SCRIPT_IDS);
  const requiredPackageScripts = {
    ...REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS,
    [REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_SCRIPT_ID]: `node ${REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_EXPORTER_PATH} --strict`,
  };
  const packageCloseoutScriptIds = uniqueSorted(Object.keys(input.packageScripts || {})
    .filter((scriptId) => isCloseoutRelevantScriptId(scriptId, { classifiedSet, guardSet })));
  const unclassifiedPackageScriptIds = packageCloseoutScriptIds
    .filter((scriptId) => !classifiedSet.has(scriptId) && !guardSet.has(scriptId));
  const docScriptIds = docsScriptIds(input.docsText);
  const docsCloseoutScriptIds = docScriptIds
    .filter((scriptId) => isCloseoutRelevantScriptId(scriptId, { classifiedSet, guardSet }));
  const unclassifiedDocScriptIds = docsCloseoutScriptIds
    .filter((scriptId) => !classifiedSet.has(scriptId) && !guardSet.has(scriptId));
  const blockedWriterScriptIds = uniqueSorted(REPORT_CLOSEOUT_DRIFT_REQUIRED_BLOCKED_WRITER_IDS
    .map((commandId) => commandById.get(commandId)?.scriptId));
  const cleanCloseoutScriptIds = uniqueSorted(REPORT_CLOSEOUT_DRIFT_REQUIRED_CLEAN_CLOSEOUT_IDS
    .map((commandId) => commandById.get(commandId)?.scriptId));
  const requiredDocumentedScriptIds = uniqueSorted([
    ...blockedWriterScriptIds,
    ...cleanCloseoutScriptIds,
  ]);
  const missingDocsScriptIds = requiredDocumentedScriptIds
    .filter((scriptId) => !docScriptIds.includes(scriptId));
  const missingProbeIds = REQUIRED_READ_ONLY_PROBE_IDS.filter((commandId) => !commandById.has(commandId));
  const classificationExportsPresent = [
    'export const REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS',
    'export const REPORT_CLOSEOUT_DRIFT_REQUIRED_BLOCKED_WRITER_IDS',
    'export const REPORT_CLOSEOUT_DRIFT_REQUIRED_CLEAN_CLOSEOUT_IDS',
    'export const REPORT_CLOSEOUT_DRIFT_REQUIRED_PACKAGE_SCRIPTS',
  ].every((token) => String(input.classificationSourceText || '').includes(token));

  for (const [scriptId, expectedCommand] of Object.entries(requiredPackageScripts)) {
    const actualCommand = input.packageScripts?.[scriptId] || null;
    if (!actualCommand) {
      blockers.push(blocker(
        scriptId === REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_SCRIPT_ID
          ? 'report_closeout_command_inventory_package_script_missing'
          : 'report_closeout_command_inventory_classified_script_missing',
        `${scriptId} must be present in package scripts before closeout command inventory can be trusted.`,
        { scriptId },
      ));
    } else if (actualCommand !== expectedCommand) {
      blockers.push(blocker(
        'report_closeout_command_inventory_package_script_command_drift',
        `${scriptId} must run ${expectedCommand}.`,
        { scriptId, expectedCommand, actualCommand },
      ));
    }
  }

  for (const scriptId of unclassifiedPackageScriptIds) {
    blockers.push(blocker(
      'report_closeout_command_inventory_unclassified_package_script',
      `${scriptId} looks closeout-related but is not present in the closeout command classification or guard allowlist.`,
      { scriptId },
    ));
  }

  for (const scriptId of unclassifiedDocScriptIds) {
    blockers.push(blocker(
      'report_closeout_command_inventory_unclassified_doc_command',
      `${scriptId} is documented as closeout-related but is not classified or guard-allowlisted.`,
      { scriptId },
    ));
  }

  for (const scriptId of missingDocsScriptIds) {
    blockers.push(blocker(
      'report_closeout_command_inventory_classified_script_docs_missing',
      `${scriptId} is classified for closeout but not documented in the closeout docs corpus.`,
      { scriptId },
    ));
  }

  for (const commandId of missingProbeIds) {
    blockers.push(blocker(
      'report_closeout_command_inventory_required_probe_missing',
      `${commandId} must remain in the read-only probe classification.`,
      { commandId },
    ));
  }

  if (!classificationExportsPresent) {
    blockers.push(blocker(
      'report_closeout_command_inventory_classification_exports_missing',
      'Closeout drift classification must export its command inventory constants so inventory checks do not duplicate a private list.',
    ));
  }

  const inventoryStep = sourceSteps.find((step) => step.stepId === REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID);
  if (!inventoryStep) {
    blockers.push(blocker(
      'report_closeout_command_inventory_gate_step_missing',
      `Integration gate must run ${REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID}.`,
      { stepId: REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID },
    ));
  } else {
    for (const arg of [REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_EXPORTER_PATH, '--strict']) {
      if (!inventoryStep.args.includes(arg)) {
        blockers.push(blocker(
          'report_closeout_command_inventory_gate_step_arg_missing',
          `${REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID} must include ${arg}.`,
          { stepId: REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID, arg },
        ));
      }
    }
    if (inventoryStep.parseJsonOutput !== true) {
      blockers.push(blocker(
        'report_closeout_command_inventory_gate_step_parse_json_missing',
        `${REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID} must parse JSON output.`,
        { stepId: REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID },
      ));
    }
  }

  ensureSourceOrder(sourceSteps, 'report_closeout_drift_classification_regression_export', REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID, blockers);
  ensureSourceOrder(sourceSteps, REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID, 'report_runner_contract_regression_export', blockers);
  ensureSourceOrder(sourceSteps, REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_STEP_ID, 'report_freshness_export_pre_tooling', blockers);

  return {
    status: blockers.length ? 'blocked_report_closeout_command_inventory_analysis' : 'pass_report_closeout_command_inventory_analysis',
    ok: blockers.length === 0,
    classifiedCommandCount: commands.length,
    classifiedScriptCount: scriptIds.length,
    packageCloseoutScriptCount: packageCloseoutScriptIds.length,
    docsCloseoutScriptCount: docsCloseoutScriptIds.length,
    guardScriptCount: GUARD_SCRIPT_IDS.length,
    blockedWriterScriptCount: blockedWriterScriptIds.length,
    cleanCloseoutScriptCount: cleanCloseoutScriptIds.length,
    readOnlyProbeCount: REQUIRED_READ_ONLY_PROBE_IDS.length - missingProbeIds.length,
    requiredDocumentedScriptCount: requiredDocumentedScriptIds.length,
    documentedClassifiedScriptCount: requiredDocumentedScriptIds.length - missingDocsScriptIds.length,
    unclassifiedPackageCloseoutScriptCount: unclassifiedPackageScriptIds.length,
    unclassifiedDocCloseoutScriptCount: unclassifiedDocScriptIds.length,
    packageScriptCount: Object.keys(requiredPackageScripts).length,
    presentPackageScriptCount: Object.keys(requiredPackageScripts)
      .filter((scriptId) => input.packageScripts?.[scriptId]).length,
    classificationExportsPresent,
    packageCloseoutScriptIds,
    docsCloseoutScriptIds,
    classifiedScriptIds: scriptIds,
    guardScriptIds: [...GUARD_SCRIPT_IDS],
    unclassifiedPackageScriptIds,
    unclassifiedDocScriptIds,
    missingDocsScriptIds,
    missingProbeIds,
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
      'report_closeout_command_inventory_scenario_unexpectedly_passed',
      `${scenario.scenarioId} passed unexpectedly.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!expectedObserved ? [blocker(
      'report_closeout_command_inventory_expected_blocker_missing',
      `${scenario.scenarioId} did not produce ${scenario.expectedBlockerCode}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_closeout_command_inventory_scenario' : 'pass_report_closeout_command_inventory_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    blockers,
  };
}

export function buildReportCloseoutCommandInventoryRegressionReport({
  gateSourceText = '',
  packageScripts = {},
  docsText = '',
  classificationSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const actualInput = buildBaseInput({
    gateSourceText,
    packageScripts,
    docsText,
    classificationSourceText,
  });
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
    classifiedCommandCount: actual.classifiedCommandCount,
    classifiedScriptCount: actual.classifiedScriptCount,
    packageCloseoutScriptCount: actual.packageCloseoutScriptCount,
    docsCloseoutScriptCount: actual.docsCloseoutScriptCount,
    guardScriptCount: actual.guardScriptCount,
    blockedWriterScriptCount: actual.blockedWriterScriptCount,
    cleanCloseoutScriptCount: actual.cleanCloseoutScriptCount,
    readOnlyProbeCount: actual.readOnlyProbeCount,
    requiredDocumentedScriptCount: actual.requiredDocumentedScriptCount,
    documentedClassifiedScriptCount: actual.documentedClassifiedScriptCount,
    unclassifiedPackageCloseoutScriptCount: actual.unclassifiedPackageCloseoutScriptCount,
    unclassifiedDocCloseoutScriptCount: actual.unclassifiedDocCloseoutScriptCount,
    packageScriptCount: actual.packageScriptCount,
    presentPackageScriptCount: actual.presentPackageScriptCount,
    classificationExportsPresent: actual.classificationExportsPresent,
    expectedScenarioCount: NEGATIVE_SCENARIOS.length,
    scenarioCount: scenarios.length,
    passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
    failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
    observedExpectedBlockerCount: scenarios.filter((scenario) => (
      scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
    )).length,
    blockerCount: blockers.length,
  };
  const closeoutCommandInventoryRegressionHash = digest({
    version: REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_VERSION,
    kind: 'ReportCloseoutCommandInventoryRegression',
    summary,
    actual: {
      packageCloseoutScriptIds: actual.packageCloseoutScriptIds,
      docsCloseoutScriptIds: actual.docsCloseoutScriptIds,
      classifiedScriptIds: actual.classifiedScriptIds,
      guardScriptIds: actual.guardScriptIds,
      unclassifiedPackageScriptIds: actual.unclassifiedPackageScriptIds,
      unclassifiedDocScriptIds: actual.unclassifiedDocScriptIds,
      missingDocsScriptIds: actual.missingDocsScriptIds,
      missingProbeIds: actual.missingProbeIds,
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
    version: REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_VERSION,
    kind: 'ReportCloseoutCommandInventoryRegression',
    status: blockers.length ? 'blocked_report_closeout_command_inventory_regression' : 'pass_report_closeout_command_inventory_regression',
    ok: blockers.length === 0,
    generatedAt,
    closeoutCommandInventoryRegressionHash,
    hash: closeoutCommandInventoryRegressionHash,
    fixture: {
      commandClassifications: REPORT_CLOSEOUT_DRIFT_COMMAND_CLASSIFICATIONS.map((command) => ({ ...command })),
      guardScriptIds: [...GUARD_SCRIPT_IDS],
      requiredProbeIds: [...REQUIRED_READ_ONLY_PROBE_IDS],
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
    },
    actual,
    scenarios,
    summary,
    blockers,
    safety: reportSafety(),
  };
}

export function summarizeReportCloseoutCommandInventoryRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || 'missing_report_closeout_command_inventory_regression',
    closeoutCommandInventoryRegressionHash: report.closeoutCommandInventoryRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    classifiedCommandCount: Number(report.summary?.classifiedCommandCount || 0),
    classifiedScriptCount: Number(report.summary?.classifiedScriptCount || 0),
    packageCloseoutScriptCount: Number(report.summary?.packageCloseoutScriptCount || 0),
    docsCloseoutScriptCount: Number(report.summary?.docsCloseoutScriptCount || 0),
    guardScriptCount: Number(report.summary?.guardScriptCount || 0),
    blockedWriterScriptCount: Number(report.summary?.blockedWriterScriptCount || 0),
    cleanCloseoutScriptCount: Number(report.summary?.cleanCloseoutScriptCount || 0),
    readOnlyProbeCount: Number(report.summary?.readOnlyProbeCount || 0),
    requiredDocumentedScriptCount: Number(report.summary?.requiredDocumentedScriptCount || 0),
    documentedClassifiedScriptCount: Number(report.summary?.documentedClassifiedScriptCount || 0),
    unclassifiedPackageCloseoutScriptCount: Number(report.summary?.unclassifiedPackageCloseoutScriptCount || 0),
    unclassifiedDocCloseoutScriptCount: Number(report.summary?.unclassifiedDocCloseoutScriptCount || 0),
    classificationExportsPresent: report.summary?.classificationExportsPresent === true,
    scenarioCount: Number(report.summary?.scenarioCount || 0),
    passedScenarioCount: Number(report.summary?.passedScenarioCount || 0),
    blockerCount: Number(report.summary?.blockerCount || 0),
    safety: report.safety || {},
  };
}
