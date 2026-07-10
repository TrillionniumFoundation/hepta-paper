import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { buildRuntimeDryRunHarnessReport } from './runtime-dry-run-harness.mjs';
import { auditLiveEntrypointsForChannel } from './integration-dependency-audit.mjs';
import { digest } from './hash-utils.mjs';

export const CHANNEL_RUNNER_COVERAGE_MATRIX_VERSION = 1;

export const CHANNEL_RUNNER_COVERAGE_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_channel_runner_coverage_matrix',
  FAIL: 'fail_channel_runner_coverage_matrix',
});

const CHANNEL_IDS = Object.freeze(['zbj', 'epwk', 'hepta']);

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes || '') || null,
  };
}

function liveEntrypointsByChannel() {
  return Object.fromEntries(CHANNEL_IDS.map((channelId) => [
    channelId,
    auditLiveEntrypointsForChannel(channelId),
  ]));
}

function customerMessageAction(value) {
  return canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
}

export function isChannelRunnerHumanFeedbackMessageHandoff(handoff = {}) {
  const actionValues = [handoff.action, handoff.actionId];
  const productValues = [
    handoff.productLineId,
    handoff.workflowId,
    handoff.packageRole,
    handoff.reviewType,
    handoff.role,
  ];
  return actionValues.some(customerMessageAction)
    && (
      actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || productValues.some((value) => canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK)
    );
}

export function isChannelRunnerHumanFeedbackHandoff(handoff = {}) {
  const actionValues = [handoff.action, handoff.actionId];
  const productValues = [
    handoff.productLineId,
    handoff.workflowId,
    handoff.packageRole,
    handoff.reviewType,
    handoff.role,
  ];
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && (
      actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || productValues.some((value) => canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK)
      || Boolean(handoff.humanFeedbackRevisionContractHash)
    );
}

function classifyRoute({ handoff, liveEntrypoint = null }) {
  const action = canonicalExternalAction(handoff.action);
  if (liveEntrypoint) {
    return liveEntrypoint.ok
      ? 'implemented_live_entrypoint'
      : 'blocked_live_entrypoint';
  }
  if (action === EXTERNAL_ACTIONS.PROVIDER_SPEND) return 'guarded_provider_spend';
  if (action === EXTERNAL_ACTIONS.MODEL_SPEND) return 'guarded_model_spend';
  if (action === EXTERNAL_ACTIONS.LIVE_PREPARE) return 'prepare_only_preflight';
  if (customerMessageAction(action) && String(handoff.actionId || '').endsWith('Preview')) {
    return 'preview_only_customer_message';
  }
  return 'implementation_gap';
}

function rowForScenario(scenario, channelLiveEntrypoints = []) {
  const handoff = scenario.handoff || {};
  const action = canonicalExternalAction(handoff.action);
  const productLineId = canonicalProductLineIdOrNull(handoff.productLineId);
  const workflowId = canonicalProductLineIdOrNull(handoff.workflowId);
  const packageRole = canonicalPackageRole(handoff.packageRole || '') || null;
  const liveEntrypoint = channelLiveEntrypoints.find((entrypoint) => entrypoint.actionId === handoff.actionId) || null;
  const implementationClass = classifyRoute({ handoff, liveEntrypoint });
  const liveFiles = liveEntrypoint?.files || [];
  const entryFiles = liveFiles.filter((file) => file.role === 'live_entrypoint');
  const bridgeFiles = liveFiles.filter((file) => file.role === 'core_bridge');
  const classified = implementationClass !== 'implementation_gap' && implementationClass !== 'blocked_live_entrypoint';
  const customerMessageRoute = customerMessageAction(action);
  const humanFeedbackRoute = isChannelRunnerHumanFeedbackHandoff({
    ...handoff,
    action,
    productLineId,
    workflowId,
    packageRole,
  });
  const blockers = [
    ...(implementationClass === 'implementation_gap'
      ? [issue('channel_runner_coverage_route_unclassified', handoff.actionId)]
      : []),
    ...(implementationClass === 'blocked_live_entrypoint'
      ? [issue('channel_runner_coverage_live_entrypoint_blocked', handoff.actionId)]
      : []),
    ...(liveEntrypoint && liveEntrypoint.packageScript?.exists !== true
      ? [issue('channel_runner_coverage_live_script_missing', handoff.actionId)]
      : []),
    ...(liveEntrypoint && liveEntrypoint.lifecycleValidationStatus !== 'pass_external_action_lifecycle_chain'
      ? [issue('channel_runner_coverage_lifecycle_not_validated', handoff.actionId)]
      : []),
    ...(customerMessageRoute && !handoff.messagePreviewHash
      ? [issue('channel_runner_coverage_customer_message_preview_hash_missing', handoff.actionId)]
      : []),
    ...(humanFeedbackRoute && !handoff.humanFeedbackRevisionContractHash
      ? [issue('channel_runner_coverage_human_feedback_contract_hash_missing', handoff.actionId)]
      : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    channelId: handoff.channelId,
    action,
    actionId: handoff.actionId,
    productLineId,
    workflowId,
    packageRole,
    messagePreviewHash: handoff.messagePreviewHash || null,
    humanFeedbackRevisionContractHash: handoff.humanFeedbackRevisionContractHash || null,
    runnerLocation: handoff.runnerLocation,
    implementationClass,
    classified,
    liveEntrypointMatched: Boolean(liveEntrypoint),
    liveEntrypointOk: liveEntrypoint?.ok === true,
    liveEntrypointStatus: liveEntrypoint?.status || null,
    packageScriptExists: liveEntrypoint?.packageScript?.exists ?? null,
    entryFileCount: entryFiles.length,
    existingEntryFileCount: entryFiles.filter((file) => file.exists === true).length,
    bridgeFileCount: bridgeFiles.length,
    existingBridgeFileCount: bridgeFiles.filter((file) => file.exists === true).length,
    lifecycleValidationStatus: liveEntrypoint?.lifecycleValidationStatus || null,
    lifecycleProfileId: liveEntrypoint?.lifecycleProfileId || null,
    commandPreview: handoff.commandPreview || null,
    hashes: {
      manifestHash: scenario.hashes?.manifestHash || null,
      previewHash: scenario.hashes?.previewHash || null,
      packageRole,
      messagePreviewHash: handoff.messagePreviewHash || null,
      humanFeedbackRevisionContractHash: scenario.hashes?.humanFeedbackRevisionContractHash
        || handoff.humanFeedbackRevisionContractHash
        || null,
      dispatchEnvelopeHash: scenario.hashes?.dispatchEnvelopeHash || null,
      sdkHash: scenario.hashes?.sdkHash || null,
    },
    blockers,
  };
}

function auditOnlyEntrypoints(rows, liveEntrypointsByChannelMap) {
  const coveredActionIds = new Set(rows.map((row) => row.actionId));
  return CHANNEL_IDS.flatMap((channelId) => (liveEntrypointsByChannelMap[channelId] || [])
    .filter((entrypoint) => !coveredActionIds.has(entrypoint.actionId))
    .map((entrypoint) => ({
      channelId,
      actionId: entrypoint.actionId,
      label: entrypoint.label,
      status: entrypoint.status,
      ok: entrypoint.ok === true,
      packageScriptExists: entrypoint.packageScript?.exists ?? null,
      lifecycleValidationStatus: entrypoint.lifecycleValidationStatus || null,
      lifecycleProfileId: entrypoint.lifecycleProfileId || null,
      notes: 'Live entrypoint is enforced by integration audit but is not represented in the runtime adapter action matrix.',
    })));
}

function summarize(rows, auditOnlyRows, runtimeDryRunHarness) {
  const classCounts = {};
  const channelCounts = {};
  for (const row of rows) {
    classCounts[row.implementationClass] = (classCounts[row.implementationClass] || 0) + 1;
    channelCounts[row.channelId] = (channelCounts[row.channelId] || 0) + 1;
  }
  return {
    routeCount: rows.length,
    runtimeReadyRouteCount: runtimeDryRunHarness.summary?.readyScenarioCount || 0,
    classifiedRouteCount: rows.filter((row) => row.classified).length,
    unclassifiedRouteCount: rows.filter((row) => row.implementationClass === 'implementation_gap').length,
    implementedLiveEntrypointRouteCount: rows.filter((row) => row.implementationClass === 'implemented_live_entrypoint').length,
    blockedLiveEntrypointRouteCount: rows.filter((row) => row.implementationClass === 'blocked_live_entrypoint').length,
    guardedProviderSpendRouteCount: rows.filter((row) => row.implementationClass === 'guarded_provider_spend').length,
    guardedModelSpendRouteCount: rows.filter((row) => row.implementationClass === 'guarded_model_spend').length,
    prepareOnlyRouteCount: rows.filter((row) => row.implementationClass === 'prepare_only_preflight').length,
    previewOnlyCustomerMessageRouteCount: rows.filter((row) => row.implementationClass === 'preview_only_customer_message').length,
    packageRoleRouteCount: rows.filter((row) => row.packageRole).length,
    customerMessageHashBoundRouteCount: rows.filter((row) => customerMessageAction(row.action) && row.messagePreviewHash).length,
    humanFeedbackMessageHashBoundRouteCount: rows.filter((row) => isChannelRunnerHumanFeedbackMessageHandoff(row)
      && row.humanFeedbackRevisionContractHash
      && row.messagePreviewHash).length,
    humanFeedbackCustomerFacingHashBoundRouteCount: rows.filter((row) => isChannelRunnerHumanFeedbackHandoff(row)
      && row.humanFeedbackRevisionContractHash).length,
    humanFeedbackContractBoundRouteCount: rows.filter((row) => row.humanFeedbackRevisionContractHash).length,
    humanFeedbackPackageRoleBoundRouteCount: rows.filter((row) => isChannelRunnerHumanFeedbackHandoff(row)
      && row.packageRole).length,
    liveEntrypointMatchedRouteCount: rows.filter((row) => row.liveEntrypointMatched).length,
    liveEntrypointOkRouteCount: rows.filter((row) => row.liveEntrypointOk).length,
    auditOnlyLiveEntrypointCount: auditOnlyRows.length,
    auditOnlyLiveEntrypointOkCount: auditOnlyRows.filter((row) => row.ok).length,
    byImplementationClass: classCounts,
    byChannel: channelCounts,
  };
}

export function buildChannelRunnerCoverageMatrixReport({
  generatedAt = new Date().toISOString(),
} = {}) {
  const runtimeDryRunHarness = buildRuntimeDryRunHarnessReport({ generatedAt });
  const liveEntrypointsByChannelMap = liveEntrypointsByChannel();
  const readyScenarios = (runtimeDryRunHarness.scenarios || [])
    .filter((scenario) => scenario.readyForExternalRunner === true && scenario.expectedReady === true);
  const rows = readyScenarios.map((scenario) => rowForScenario(
    scenario,
    liveEntrypointsByChannelMap[scenario.handoff?.channelId] || [],
  ));
  const auditOnlyRows = auditOnlyEntrypoints(rows, liveEntrypointsByChannelMap);
  const summary = summarize(rows, auditOnlyRows, runtimeDryRunHarness);
  const blockers = [
    ...(runtimeDryRunHarness.ok !== true ? [issue('channel_runner_coverage_runtime_harness_not_ok')] : []),
    ...rows.flatMap((row) => row.blockers.map((blocker) => ({
      ...blocker,
      route: row.actionId,
    }))),
  ];
  const report = {
    version: CHANNEL_RUNNER_COVERAGE_MATRIX_VERSION,
    kind: 'ChannelRunnerCoverageMatrixReport',
    status: blockers.length
      ? CHANNEL_RUNNER_COVERAGE_MATRIX_STATUS.FAIL
      : CHANNEL_RUNNER_COVERAGE_MATRIX_STATUS.PASS,
    ok: blockers.length === 0,
    runtimeDryRunHarnessHash: runtimeDryRunHarness.runtimeDryRunHarnessHash,
    summary,
    rows,
    auditOnlyLiveEntrypoints: auditOnlyRows,
    blockers,
    warnings: [
      issue('channel_runner_coverage_local_only', 'Coverage reads local code, package scripts, and synthetic runtime handoffs only.', 'warning'),
      ...auditOnlyRows.map((row) => issue(
        'channel_runner_coverage_audit_only_live_entrypoint',
        `${row.actionId} is audited as a live entrypoint but is not yet in the runtime adapter action matrix.`,
        'warning',
      )),
    ],
    safety: {
      localOnly: true,
      readsLocalFiles: true,
      syntheticRuntimeOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      dispatchesRunner: false,
      consumesQueue: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
      readyForExecution: false,
    },
    generatedAt,
  };
  const channelRunnerCoverageMatrixHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    ok: report.ok,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
    summary: report.summary,
    rows: report.rows.map((row) => ({
      scenarioId: row.scenarioId,
      channelId: row.channelId,
      action: row.action,
      actionId: row.actionId,
      productLineId: row.productLineId,
      workflowId: row.workflowId,
      packageRole: row.packageRole,
      messagePreviewHash: row.messagePreviewHash,
      humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
      runnerLocation: row.runnerLocation,
      implementationClass: row.implementationClass,
      classified: row.classified,
      liveEntrypointMatched: row.liveEntrypointMatched,
      liveEntrypointOk: row.liveEntrypointOk,
      liveEntrypointStatus: row.liveEntrypointStatus,
      packageScriptExists: row.packageScriptExists,
      entryFileCount: row.entryFileCount,
      existingEntryFileCount: row.existingEntryFileCount,
      bridgeFileCount: row.bridgeFileCount,
      existingBridgeFileCount: row.existingBridgeFileCount,
      lifecycleValidationStatus: row.lifecycleValidationStatus,
      lifecycleProfileId: row.lifecycleProfileId,
      hashes: row.hashes,
      blockerCodes: uniqueStrings(row.blockers.map((blocker) => blocker.code), 16),
    })),
    auditOnlyLiveEntrypoints: report.auditOnlyLiveEntrypoints,
    blockers: report.blockers,
    warnings: report.warnings,
    safety: report.safety,
  });
  return {
    ...report,
    channelRunnerCoverageMatrixHash,
    hash: channelRunnerCoverageMatrixHash,
  };
}
