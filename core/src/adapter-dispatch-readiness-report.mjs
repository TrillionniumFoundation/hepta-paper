import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  computeCustomerMessagePreviewHash,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
} from './contracts.mjs';
import {
  ADAPTER_DISPATCH_ENVELOPE_STATUS,
  computeAdapterDispatchEnvelopeHash,
} from './adapter-dispatch-envelope.mjs';
import {
  ADAPTER_DISPATCH_ASSIGNMENT_STATUS,
  computeAdapterDispatchAssignmentHash,
} from './adapter-dispatch-assignment.mjs';
import {
  ADAPTER_RUNNER_REGISTRY_STATUS,
  ADAPTER_RUNNER_SELECTION_STATUS,
  computeAdapterRunnerRegistryHash,
  computeAdapterRunnerSelectionHash,
} from './adapter-runner-registry.mjs';
import { isExternalWorkspaceRunnerLocation } from './adapter-runner-location-boundary.mjs';
import { dispatchReadinessOperatorHint } from './dispatch-readiness-operator-hints.mjs';
import { computeChannelActionManifestHash } from './action-manifest.mjs';
import { computeAdapterRunPreviewHash } from './adapter-runner.mjs';
import { handoffSnapshotIdentityMismatches } from './handoff-snapshot-identity.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_DISPATCH_READINESS_REPORT_VERSION = 1;

export const ADAPTER_DISPATCH_READINESS_REPORT_STATUS = Object.freeze({
  READY: 'ready_adapter_dispatch_readiness_report',
  BLOCKED: 'blocked_adapter_dispatch_readiness_report',
});

const PROMPT_GENERATION_BINDING_KEYS = Object.freeze([
  'designReferenceRetrievalHash',
  'promptCompilerHash',
  'promptReadinessHash',
  'promptProductionContractHash',
  'generationJobId',
  'generationPromptProductionContractHash',
]);

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes) || null,
  };
}

function normalizeRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: item };
    return {
      kind: item?.kind || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: normalizeText(item?.hash || '') || null,
      notes: normalizeText(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

function text(value) {
  return normalizeText(value || '') || null;
}

function hashOf(item, keys = []) {
  for (const key of keys) {
    const value = text(item?.[key] || item?.hashBinding?.[key] || item?.runner?.requiredHashes?.[key]);
    if (value) return value;
  }
  return null;
}

function genericHashOf(item) {
  return text(item?.hash);
}

function routeMatches(registry, selection, assignment) {
  const selected = selection?.runner || {};
  return (registry?.routes || []).some((route) => (
    route.channelId === selection?.channelId
    && route.actionId === selection?.actionId
    && route.runnerId === selected.runnerId
    && route.capabilityHash === selected.capabilityHash
    && route.runnerId === assignment?.runner?.runnerId
    && route.capabilityHash === assignment?.runner?.capabilityHash
  ));
}

function requiredHashesReady(dispatchEnvelope) {
  const hashes = dispatchEnvelope?.runner?.requiredHashes || {};
  const required = ['outboxHash', 'replayGuardHash', 'manifestHash', 'previewHash', 'approvalHash', 'evidenceHash', 'approvalProvenanceHash'];
  return required.every((key) => text(hashes[key]));
}

function handoffSnapshotsReady(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  const hashes = dispatchEnvelope?.runner?.requiredHashes || {};
  const manifestHash = text(snapshots.manifest?.manifestHash);
  const manifestGenericHash = genericHashOf(snapshots.manifest);
  const previewHash = text(snapshots.preview?.previewHash);
  const previewGenericHash = genericHashOf(snapshots.preview);
  return Boolean(
    snapshots.manifest?.kind === 'ChannelActionManifest'
      && snapshots.preview?.kind === 'AdapterRunPreview'
      && manifestHash
      && manifestGenericHash
      && previewHash
      && previewGenericHash
      && manifestHash === manifestGenericHash
      && previewHash === previewGenericHash
      && manifestHash === text(hashes.manifestHash)
      && previewHash === text(hashes.previewHash)
      && manifestHash === computeChannelActionManifestHash(snapshots.manifest)
      && previewHash === computeAdapterRunPreviewHash(snapshots.preview),
  );
}

function handoffIdentityForDispatchEnvelope(dispatchEnvelope = {}) {
  const payload = dispatchEnvelope?.payload || {};
  return {
    channelId: dispatchEnvelope?.channelId || null,
    actionId: dispatchEnvelope?.actionId || null,
    action: dispatchEnvelope?.action || payload.action || null,
    taskKey: payload.taskKey || null,
    externalId: payload.externalId || null,
    productLineId: payload.productLineId || null,
    workflowId: payload.workflowId || null,
    packageRole: payload.packageRole || null,
  };
}

function dispatchHandoffSnapshotIdentityMismatches(dispatchEnvelope) {
  return handoffSnapshotIdentityMismatches({
    handoff: handoffIdentityForDispatchEnvelope(dispatchEnvelope),
    snapshots: dispatchEnvelope?.runner?.handoffSnapshots || {},
  });
}

function isHumanFeedbackCustomerFacingHandoff(dispatchEnvelope) {
  const payload = dispatchEnvelope?.payload || {};
  const hashes = dispatchEnvelope?.runner?.requiredHashes || {};
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  const actionValues = [
    dispatchEnvelope?.action,
    dispatchEnvelope?.actionId,
    payload.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ];
  const productValues = [
    payload.productLineId,
    payload.workflowId,
    payload.packageRole,
    payload.reviewType,
    payload.role,
    snapshots.manifest?.productLineId,
    snapshots.manifest?.workflowId,
    snapshots.manifest?.payload?.packageRole,
    snapshots.manifest?.payload?.reviewType,
    snapshots.manifest?.payload?.role,
    snapshots.manifest?.payload?.productLineId,
    snapshots.manifest?.payload?.workflowId,
    snapshots.preview?.payload?.productLineId,
    snapshots.preview?.payload?.workflowId,
    snapshots.preview?.payload?.packageRole,
    snapshots.preview?.payload?.reviewType,
    snapshots.preview?.payload?.role,
  ];
  const customerFacingFeedbackAction = actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value));
  const humanFeedbackActionAlias = actionValues.some((value) => isHumanFeedbackMessageActionAlias(value));
  const humanFeedbackProduct = productValues.some((value) => canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK);
  return customerFacingFeedbackAction
    && (
      humanFeedbackActionAlias
      || humanFeedbackProduct
      || text(payload.humanFeedbackRevisionContractHash)
      || text(hashes.humanFeedbackRevisionContractHash)
      || text(snapshots.manifest?.payload?.humanFeedbackRevisionContractHash)
      || text(snapshots.preview?.payload?.humanFeedbackRevisionContractHash)
      || text(snapshots.preview?.adapter?.requiredHashes?.humanFeedbackRevisionContractHash)
    );
}

function isCustomerMessageHandoff(dispatchEnvelope) {
  const payload = dispatchEnvelope?.payload || {};
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return [
    dispatchEnvelope?.action,
    dispatchEnvelope?.actionId,
    payload.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function messagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function allEqualNonEmpty(values = []) {
  const normalized = values.map((value) => text(value)).filter(Boolean);
  return normalized.length === values.length && new Set(normalized).size === 1;
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => text(left[key]) === text(right[key]));
}

function isPromptGenerationSpendAction(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function isPromptGenerationSpendHandoff(dispatchEnvelope) {
  const payload = dispatchEnvelope?.payload || {};
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return [
    dispatchEnvelope?.action,
    dispatchEnvelope?.actionId,
    payload.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => isPromptGenerationSpendAction(value));
}

function promptGenerationBindingReady(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  const values = [
    dispatchEnvelope?.payload?.promptGenerationBinding,
    dispatchEnvelope?.runner?.requiredHashes?.promptGenerationBinding,
    snapshots.manifest?.payload?.promptGenerationBinding,
    snapshots.preview?.payload?.promptGenerationBinding,
    snapshots.preview?.adapter?.requiredHashes?.promptGenerationBinding,
  ];
  const present = values.filter(Boolean);
  if (!present.length) return !isPromptGenerationSpendHandoff(dispatchEnvelope);
  const complete = PROMPT_GENERATION_BINDING_KEYS.every((key) => text(present[0]?.[key]));
  return present.length === values.length
    && present.every((value) => samePromptGenerationBinding(value, present[0]))
    && complete;
}

function humanFeedbackContractHashReady(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return allEqualNonEmpty([
    dispatchEnvelope?.payload?.humanFeedbackRevisionContractHash,
    dispatchEnvelope?.runner?.requiredHashes?.humanFeedbackRevisionContractHash,
    snapshots.manifest?.payload?.humanFeedbackRevisionContractHash,
    snapshots.preview?.payload?.humanFeedbackRevisionContractHash,
    snapshots.preview?.adapter?.requiredHashes?.humanFeedbackRevisionContractHash,
  ]);
}

function customerMessagePreviewHashReady(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  const expected = messagePreviewHash(dispatchEnvelope?.payload?.messagePreview);
  return Boolean(expected)
    && allEqualNonEmpty([
      expected,
      dispatchEnvelope?.payload?.messagePreviewHash,
      dispatchEnvelope?.runner?.requiredHashes?.messagePreviewHash,
      snapshots.manifest?.payload?.messagePreviewHash,
      snapshots.preview?.payload?.messagePreviewHash,
      snapshots.preview?.adapter?.requiredHashes?.messagePreviewHash,
    ]);
}

function approvalProvenanceHashReady(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return allEqualNonEmpty([
    dispatchEnvelope?.payload?.approvalProvenanceHash,
    dispatchEnvelope?.runner?.requiredHashes?.approvalProvenanceHash,
    snapshots.manifest?.payload?.approvalProvenanceHash,
    snapshots.preview?.payload?.approvalProvenanceHash,
    snapshots.preview?.adapter?.requiredHashes?.approvalProvenanceHash,
  ]);
}

function hashIdentityPayload(value = null) {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(hashIdentityPayload);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'action' || key === 'sideEffectClass') {
      out[key] = canonicalActionOrNull(item);
    } else if (key === 'productLineId' || key === 'workflowId') {
      out[key] = canonicalProductLineOrNull(item);
    } else if (key === 'packageRole' || key === 'reviewType' || key === 'role') {
      out[key] = canonicalPackageRole(item) || null;
    } else {
      out[key] = hashIdentityPayload(item);
    }
  }
  return out;
}

function unsafeRecords(records) {
  const unsafeKeys = [
    'executesExternalAction',
    'uploads',
    'submits',
    'sendsMessages',
    'acceptsDelivery',
    'pays',
    'deploys',
    'fetchesChannelState',
    'appliesLocalStateTransition',
    'grantsExecutionPermission',
    'readyForExecution',
  ];
  return records.filter((record) => unsafeKeys.some((key) => record?.safety?.[key] === true));
}

function addCheck(checks, id, passed, notes = null) {
  checks.push({
    id,
    passed: Boolean(passed),
    notes: text(notes),
  });
}

const CHECK_HINTS = Object.freeze({
  runner_registry_ready: dispatchReadinessOperatorHint('refresh_runner_registry'),
  runner_registry_hash_present: dispatchReadinessOperatorHint('rebuild_runner_registry_hash'),
  runner_registry_generic_hash_present: dispatchReadinessOperatorHint('rebuild_runner_registry_hash'),
  runner_registry_hash_alias_matches_generic: dispatchReadinessOperatorHint('rebuild_runner_registry_hash'),
  runner_registry_hash_content_matches: dispatchReadinessOperatorHint('rebuild_runner_registry_hash'),
  runner_selection_ready: dispatchReadinessOperatorHint('select_supported_runner_route'),
  runner_selection_hash_present: dispatchReadinessOperatorHint('rebuild_runner_selection_hash'),
  runner_selection_generic_hash_present: dispatchReadinessOperatorHint('rebuild_runner_selection_hash'),
  runner_selection_hash_alias_matches_generic: dispatchReadinessOperatorHint('rebuild_runner_selection_hash'),
  runner_selection_hash_content_matches: dispatchReadinessOperatorHint('rebuild_runner_selection_hash'),
  runner_selection_binds_registry: dispatchReadinessOperatorHint('reselect_runner_from_current_registry'),
  dispatch_envelope_ready: dispatchReadinessOperatorHint('refresh_dispatch_envelope_after_replay_guard'),
  dispatch_envelope_hash_present: dispatchReadinessOperatorHint('rebuild_dispatch_envelope_hash'),
  dispatch_envelope_generic_hash_present: dispatchReadinessOperatorHint('rebuild_dispatch_envelope_hash'),
  dispatch_envelope_hash_alias_matches_generic: dispatchReadinessOperatorHint('rebuild_dispatch_envelope_hash'),
  dispatch_envelope_hash_content_matches: dispatchReadinessOperatorHint('rebuild_dispatch_envelope_hash'),
  dispatch_required_hashes_present: dispatchReadinessOperatorHint('restore_required_handoff_hashes'),
  dispatch_handoff_snapshots_present: dispatchReadinessOperatorHint('restore_required_handoff_hashes', 'Dispatch handoff must carry hash-bound ChannelActionManifest and AdapterRunPreview snapshots.'),
  dispatch_handoff_snapshot_identity_matches: dispatchReadinessOperatorHint('restore_required_handoff_hashes', 'Dispatch handoff snapshots must carry the same channel/action/task identity as the dispatch envelope, not only matching hashes.'),
  dispatch_approval_provenance_hash_bound: dispatchReadinessOperatorHint('restore_required_handoff_hashes', 'External-action handoffs must carry the same approvalProvenanceHash in payload, required hashes, manifest snapshot, preview snapshot, and preview adapter required hashes.'),
  dispatch_human_feedback_contract_hash_bound: dispatchReadinessOperatorHint('restore_required_handoff_hashes', 'Human-feedback customer-facing handoffs must carry the same humanFeedbackRevisionContractHash in payload, required hashes, manifest snapshot, preview snapshot, and preview adapter required hashes.'),
  dispatch_customer_message_preview_hash_bound: dispatchReadinessOperatorHint('restore_required_handoff_hashes', 'Customer-message handoffs must carry a messagePreviewHash in payload, required hashes, both handoff snapshots, and preview adapter required hashes.'),
  dispatch_prompt_generation_binding_bound: dispatchReadinessOperatorHint('restore_required_handoff_hashes', 'Prompt-generation provider/model spend handoffs must carry the same promptGenerationBinding in payload, required hashes, manifest snapshot, and preview snapshot.'),
  dispatch_assignment_ready: dispatchReadinessOperatorHint('rebuild_dispatch_assignment'),
  dispatch_assignment_hash_present: dispatchReadinessOperatorHint('rebuild_dispatch_assignment_hash'),
  dispatch_assignment_generic_hash_present: dispatchReadinessOperatorHint('rebuild_dispatch_assignment_hash'),
  dispatch_assignment_hash_alias_matches_generic: dispatchReadinessOperatorHint('rebuild_dispatch_assignment_hash'),
  dispatch_assignment_hash_content_matches: dispatchReadinessOperatorHint('rebuild_dispatch_assignment_hash'),
  assignment_binds_dispatch_envelope: dispatchReadinessOperatorHint('rebind_assignment_to_dispatch_envelope'),
  assignment_binds_selection: dispatchReadinessOperatorHint('rebind_assignment_to_runner_selection'),
  assignment_binds_registry: dispatchReadinessOperatorHint('rebind_assignment_to_runner_registry'),
  runner_location_present: dispatchReadinessOperatorHint('review_dispatch_readiness_blocker', 'Assignment must include the external runner location before SDK handoff.'),
  runner_location_external_workspace: dispatchReadinessOperatorHint('review_dispatch_readiness_blocker', 'Assignment runner location must point outside design-production-core before SDK handoff.'),
  selection_matches_dispatch_route: dispatchReadinessOperatorHint('select_matching_runner_route'),
  selection_matches_assignment_runner: dispatchReadinessOperatorHint('select_matching_runner_capability'),
  registry_route_matches_assignment: dispatchReadinessOperatorHint('repair_runner_registry_route'),
  ready_assignment_is_not_execution_permission: dispatchReadinessOperatorHint('remove_execution_permission_claim'),
  readiness_inputs_do_not_execute_external_actions: dispatchReadinessOperatorHint('remove_core_execution_claims'),
});

function operatorHintsForChecks(checks) {
  const failed = (checks || []).filter((check) => !check.passed);
  if (!failed.length) {
    return [
      dispatchReadinessOperatorHint('external_runner_inspect_and_recheck'),
    ];
  }
  const seen = new Set();
  const hints = [];
  for (const check of failed) {
    const hint = CHECK_HINTS[check.id] || dispatchReadinessOperatorHint('review_dispatch_readiness_blocker', `Unmapped readiness check: ${check.id}.`);
    if (seen.has(hint.code)) continue;
    seen.add(hint.code);
    hints.push(hint);
  }
  return hints;
}

function readinessChecks({ runnerRegistry, runnerSelection, dispatchEnvelope, dispatchAssignment }) {
  const checks = [];
  const registryHash = hashOf(runnerRegistry, ['registryHash']);
  const registryGenericHash = genericHashOf(runnerRegistry);
  const selectionHash = hashOf(runnerSelection, ['selectionHash']);
  const selectionGenericHash = genericHashOf(runnerSelection);
  const dispatchEnvelopeHash = hashOf(dispatchEnvelope, ['dispatchEnvelopeHash']);
  const dispatchEnvelopeGenericHash = genericHashOf(dispatchEnvelope);
  const assignmentHash = hashOf(dispatchAssignment, ['assignmentHash']);
  const assignmentGenericHash = genericHashOf(dispatchAssignment);
  const humanFeedbackCustomerFacingHandoff = isHumanFeedbackCustomerFacingHandoff(dispatchEnvelope);
  const customerMessageHandoff = isCustomerMessageHandoff(dispatchEnvelope);
  const snapshotIdentityMismatches = dispatchHandoffSnapshotIdentityMismatches(dispatchEnvelope);

  addCheck(checks, 'runner_registry_ready', runnerRegistry?.kind === 'AdapterRunnerRegistry'
    && runnerRegistry.status === ADAPTER_RUNNER_REGISTRY_STATUS.READY
    && runnerRegistry.ready === true);
  addCheck(checks, 'runner_registry_hash_present', Boolean(registryHash));
  addCheck(checks, 'runner_registry_generic_hash_present', Boolean(registryGenericHash));
  addCheck(checks, 'runner_registry_hash_alias_matches_generic', Boolean(registryHash && registryGenericHash && registryHash === registryGenericHash));
  addCheck(checks, 'runner_registry_hash_content_matches', Boolean(
    registryHash
    && runnerRegistry?.kind === 'AdapterRunnerRegistry'
    && computeAdapterRunnerRegistryHash(runnerRegistry) === registryHash,
  ));

  addCheck(checks, 'runner_selection_ready', runnerSelection?.kind === 'AdapterRunnerSelection'
    && runnerSelection.status === ADAPTER_RUNNER_SELECTION_STATUS.READY
    && runnerSelection.selected === true);
  addCheck(checks, 'runner_selection_hash_present', Boolean(selectionHash));
  addCheck(checks, 'runner_selection_generic_hash_present', Boolean(selectionGenericHash));
  addCheck(checks, 'runner_selection_hash_alias_matches_generic', Boolean(selectionHash && selectionGenericHash && selectionHash === selectionGenericHash));
  addCheck(checks, 'runner_selection_hash_content_matches', Boolean(
    selectionHash
    && runnerSelection?.kind === 'AdapterRunnerSelection'
    && computeAdapterRunnerSelectionHash(runnerSelection) === selectionHash,
  ));
  addCheck(checks, 'runner_selection_binds_registry', Boolean(registryHash && runnerSelection?.registryHash === registryHash));

  addCheck(checks, 'dispatch_envelope_ready', dispatchEnvelope?.kind === 'AdapterDispatchEnvelope'
    && dispatchEnvelope.status === ADAPTER_DISPATCH_ENVELOPE_STATUS.READY
    && dispatchEnvelope.readyForExternalRunner === true);
  addCheck(checks, 'dispatch_envelope_hash_present', Boolean(dispatchEnvelopeHash));
  addCheck(checks, 'dispatch_envelope_generic_hash_present', Boolean(dispatchEnvelopeGenericHash));
  addCheck(checks, 'dispatch_envelope_hash_alias_matches_generic', Boolean(dispatchEnvelopeHash && dispatchEnvelopeGenericHash && dispatchEnvelopeHash === dispatchEnvelopeGenericHash));
  addCheck(checks, 'dispatch_envelope_hash_content_matches', Boolean(
    dispatchEnvelopeHash
    && dispatchEnvelope?.kind === 'AdapterDispatchEnvelope'
    && computeAdapterDispatchEnvelopeHash(dispatchEnvelope) === dispatchEnvelopeHash,
  ));
  addCheck(checks, 'dispatch_required_hashes_present', requiredHashesReady(dispatchEnvelope));
  addCheck(checks, 'dispatch_handoff_snapshots_present', handoffSnapshotsReady(dispatchEnvelope));
  addCheck(checks, 'dispatch_handoff_snapshot_identity_matches', snapshotIdentityMismatches.length === 0, snapshotIdentityMismatches.slice(0, 8).join('; '));
  addCheck(checks, 'dispatch_approval_provenance_hash_bound', approvalProvenanceHashReady(dispatchEnvelope));
  addCheck(checks, 'dispatch_human_feedback_contract_hash_bound', !humanFeedbackCustomerFacingHandoff || humanFeedbackContractHashReady(dispatchEnvelope));
  addCheck(checks, 'dispatch_customer_message_preview_hash_bound', !customerMessageHandoff || customerMessagePreviewHashReady(dispatchEnvelope));
  addCheck(checks, 'dispatch_prompt_generation_binding_bound', promptGenerationBindingReady(dispatchEnvelope));

  addCheck(checks, 'dispatch_assignment_ready', dispatchAssignment?.kind === 'AdapterDispatchAssignment'
    && dispatchAssignment.status === ADAPTER_DISPATCH_ASSIGNMENT_STATUS.READY
    && dispatchAssignment.readyForExternalRunner === true);
  addCheck(checks, 'dispatch_assignment_hash_present', Boolean(assignmentHash));
  addCheck(checks, 'dispatch_assignment_generic_hash_present', Boolean(assignmentGenericHash));
  addCheck(checks, 'dispatch_assignment_hash_alias_matches_generic', Boolean(assignmentHash && assignmentGenericHash && assignmentHash === assignmentGenericHash));
  addCheck(checks, 'dispatch_assignment_hash_content_matches', Boolean(
    assignmentHash
    && dispatchAssignment?.kind === 'AdapterDispatchAssignment'
    && computeAdapterDispatchAssignmentHash(dispatchAssignment) === assignmentHash,
  ));
  addCheck(checks, 'assignment_binds_dispatch_envelope', Boolean(dispatchEnvelopeHash && dispatchAssignment?.dispatch?.dispatchEnvelopeHash === dispatchEnvelopeHash));
  addCheck(checks, 'assignment_binds_selection', Boolean(selectionHash && dispatchAssignment?.selection?.selectionHash === selectionHash));
  addCheck(checks, 'assignment_binds_registry', Boolean(registryHash && dispatchAssignment?.selection?.registryHash === registryHash));
  const runnerLocation = text(dispatchAssignment?.runner?.runnerLocation);
  addCheck(checks, 'runner_location_present', Boolean(runnerLocation));
  addCheck(checks, 'runner_location_external_workspace', Boolean(runnerLocation && isExternalWorkspaceRunnerLocation(runnerLocation)));

  addCheck(checks, 'selection_matches_dispatch_route', Boolean(
    runnerSelection?.channelId
    && runnerSelection?.actionId
    && runnerSelection.channelId === dispatchEnvelope?.channelId
    && runnerSelection.actionId === dispatchEnvelope?.actionId,
  ));
  addCheck(checks, 'selection_matches_assignment_runner', Boolean(
    runnerSelection?.runner?.runnerId
    && runnerSelection?.runner?.capabilityHash
    && runnerSelection.runner.runnerId === dispatchAssignment?.runner?.runnerId
    && runnerSelection.runner.capabilityHash === dispatchAssignment?.runner?.capabilityHash,
  ));
  addCheck(checks, 'registry_route_matches_assignment', routeMatches(runnerRegistry, runnerSelection, dispatchAssignment));
  addCheck(checks, 'ready_assignment_is_not_execution_permission', dispatchAssignment?.safety?.readyForExecution === false
    && dispatchAssignment?.safety?.grantsExecutionPermission === false);
  addCheck(checks, 'readiness_inputs_do_not_execute_external_actions', unsafeRecords([
    runnerRegistry,
    runnerSelection,
    dispatchEnvelope,
    dispatchAssignment,
  ].filter(Boolean)).length === 0);

  return checks;
}

export function computeAdapterDispatchReadinessReportHash(report = {}) {
  return digest({
    version: report?.version,
    kind: report?.kind,
    actor: report?.actor,
    status: report?.status,
    readyForExternalRunner: report?.readyForExternalRunner,
    handoff: hashIdentityPayload(report?.handoff),
    runner: report?.runner,
    hashBinding: report?.hashBinding,
    handoffSnapshots: hashIdentityPayload(report?.handoffSnapshots),
    stepStatuses: report?.stepStatuses,
    checkSummary: report?.checkSummary,
    checks: report?.checks,
    blockers: report?.blockers,
    operatorHints: report?.operatorHints,
    warnings: report?.warnings,
    evidenceRefs: report?.evidenceRefs,
    safety: report?.safety,
  });
}

export function buildAdapterDispatchReadinessReport({
  runnerRegistry = null,
  runnerSelection = null,
  dispatchEnvelope = null,
  dispatchAssignment = null,
  actor = 'design-production-core.adapter-dispatch-readiness-report',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const checks = readinessChecks({
    runnerRegistry,
    runnerSelection,
    dispatchEnvelope,
    dispatchAssignment,
  });
  const failedChecks = checks.filter((check) => !check.passed);
  const blockers = failedChecks.map((check) => issue('dispatch_readiness_check_failed', check.id));
  const operatorHints = operatorHintsForChecks(checks);
  const status = blockers.length
    ? ADAPTER_DISPATCH_READINESS_REPORT_STATUS.BLOCKED
    : ADAPTER_DISPATCH_READINESS_REPORT_STATUS.READY;
  const report = {
    version: ADAPTER_DISPATCH_READINESS_REPORT_VERSION,
    kind: 'AdapterDispatchReadinessReport',
    actor: normalizeText(actor) || 'design-production-core.adapter-dispatch-readiness-report',
    status,
    readyForExternalRunner: status === ADAPTER_DISPATCH_READINESS_REPORT_STATUS.READY,
    handoff: {
      channelId: dispatchEnvelope?.channelId || null,
      actionId: dispatchEnvelope?.actionId || null,
      action: canonicalActionOrNull(dispatchEnvelope?.action),
      taskKey: dispatchEnvelope?.payload?.taskKey || null,
      externalId: dispatchEnvelope?.payload?.externalId || null,
      productLineId: canonicalProductLineOrNull(dispatchEnvelope?.payload?.productLineId),
      workflowId: canonicalProductLineOrNull(dispatchEnvelope?.payload?.workflowId),
      packageRole: canonicalPackageRole(dispatchEnvelope?.payload?.packageRole || '') || null,
      approvalProvenanceHash: dispatchEnvelope?.payload?.approvalProvenanceHash || null,
      humanFeedbackRevisionContractHash: dispatchEnvelope?.payload?.humanFeedbackRevisionContractHash || null,
      promptGenerationBinding: dispatchEnvelope?.payload?.promptGenerationBinding || null,
      messagePreview: dispatchEnvelope?.payload?.messagePreview || null,
      messagePreviewHash: dispatchEnvelope?.payload?.messagePreviewHash || null,
      artifactNames: dispatchEnvelope?.payload?.artifactNames || [],
      artifactCount: dispatchEnvelope?.payload?.artifactCount || 0,
    },
    runner: {
      registryHash: hashOf(runnerRegistry, ['registryHash']),
      selectionHash: hashOf(runnerSelection, ['selectionHash']),
      runnerId: runnerSelection?.runner?.runnerId || dispatchAssignment?.runner?.runnerId || null,
      capabilityHash: runnerSelection?.runner?.capabilityHash || dispatchAssignment?.runner?.capabilityHash || null,
      runnerLocation: dispatchAssignment?.runner?.runnerLocation || null,
      runnerLocationExternalWorkspace: isExternalWorkspaceRunnerLocation(dispatchAssignment?.runner?.runnerLocation),
      runnerMayExecuteExternalAction: dispatchAssignment?.runner?.mayExecuteExternalAction === true,
    },
    hashBinding: {
      dispatchEnvelopeHash: hashOf(dispatchEnvelope, ['dispatchEnvelopeHash']),
      assignmentHash: hashOf(dispatchAssignment, ['assignmentHash']),
      requiredHashes: dispatchEnvelope?.runner?.requiredHashes || {},
    },
    handoffSnapshots: dispatchEnvelope?.runner?.handoffSnapshots || null,
    stepStatuses: {
      runnerRegistry: runnerRegistry?.status || null,
      runnerSelection: runnerSelection?.status || null,
      dispatchEnvelope: dispatchEnvelope?.status || null,
      dispatchAssignment: dispatchAssignment?.status || null,
    },
    checkSummary: {
      total: checks.length,
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
      failedCheckIds: failedChecks.map((check) => check.id),
    },
    checks,
    blockers,
    operatorHints,
    warnings: [
      issue('adapter_dispatch_readiness_report_only', 'Readiness reports summarize handoff compatibility and never execute adapters or grant permission.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      readinessReportOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
      readyForExecution: false,
      readyForExternalRunner: status === ADAPTER_DISPATCH_READINESS_REPORT_STATUS.READY,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const reportHash = computeAdapterDispatchReadinessReportHash(report);

  return {
    ...report,
    reportHash,
    hash: reportHash,
  };
}

export function summarizeAdapterDispatchReadinessReports(reports = []) {
  const byStatus = {};
  const byChannel = {};
  const failedCheckIds = {};
  const operatorHintCodes = {};
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    byChannel[report.handoff?.channelId || 'unknown'] = (byChannel[report.handoff?.channelId || 'unknown'] || 0) + 1;
    for (const checkId of report.checkSummary?.failedCheckIds || []) {
      failedCheckIds[checkId] = (failedCheckIds[checkId] || 0) + 1;
    }
    for (const hint of report.operatorHints || []) {
      operatorHintCodes[hint.code] = (operatorHintCodes[hint.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_DISPATCH_READINESS_REPORT_VERSION,
    count: reports.length,
    byStatus,
    byChannel,
    failedCheckIds,
    operatorHintCodes,
    safety: {
      readinessReportOnly: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
      readyForExecution: reports.some((report) => report.safety?.readyForExecution === true),
    },
  };
}
