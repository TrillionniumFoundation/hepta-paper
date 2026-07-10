import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  channelCapabilities,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import {
  ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE,
  isExternalWorkspaceRunnerLocation,
} from './adapter-runner-location-boundary.mjs';
import { digest } from './hash-utils.mjs';

export const CHANNEL_ADAPTER_INTERFACE_VERSION = 1;

export const CHANNEL_ADAPTER_INTERFACE_STATUS = Object.freeze({
  READY: 'ready_channel_adapter_interface',
  BLOCKED: 'blocked_channel_adapter_interface',
});

export const CHANNEL_ADAPTER_INTERFACE_SET_STATUS = Object.freeze({
  READY: 'ready_channel_adapter_interface_set',
  BLOCKED: 'blocked_channel_adapter_interface_set',
});

export const CHANNEL_ADAPTER_INTERFACE_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_channel_adapter_interface_validation',
  FAIL: 'fail_channel_adapter_interface_validation',
});

const CHANNEL_ACTION_PREFIX = Object.freeze({
  [CHANNEL_IDS.ZBJ]: 'zbj.',
  [CHANNEL_IDS.EPWK]: 'epwk.',
  [CHANNEL_IDS.HEPTA]: 'hepta.',
  [CHANNEL_IDS.MANUAL]: 'manual.',
});

const CHANNEL_INTERFACE_SPECS = Object.freeze({
  [CHANNEL_IDS.ZBJ]: Object.freeze({
    adapterId: 'zbj-auto-intake',
    channelId: CHANNEL_IDS.ZBJ,
    displayName: 'ZBJ',
    workspace: 'zbj-auto-intake',
    taskNormalizerExport: 'channelTaskFromZbj',
    taskSourceKinds: ['zbj-task-store-entry', 'zbj-plan-source', 'zbj-live-task'],
    runnerId: 'zbj-auto-intake.live-runner',
    runnerLocation: '../zbj-auto-intake',
    supportedActions: [
      ['zbj.providerSpendGuarded', EXTERNAL_ACTIONS.PROVIDER_SPEND, 'guarded_provider_spend'],
      ['zbj.modelSpendGuarded', EXTERNAL_ACTIONS.MODEL_SPEND, 'guarded_model_spend'],
      ['zbj.pitchPrepareOnly', EXTERNAL_ACTIONS.LIVE_PREPARE, 'live_prepare'],
      ['zbj.pitchSubmitLive', EXTERNAL_ACTIONS.LIVE_SUBMIT, 'live_submit'],
      ['zbj.acceptanceApplyLive', EXTERNAL_ACTIONS.ACCEPTANCE_APPLY, 'acceptance_apply'],
      ['zbj.customerMessagePreview', EXTERNAL_ACTIONS.CUSTOMER_MESSAGE, 'customer_message'],
    ],
    readOnlyProbes: ['pitch-dryrun', 'pitch-verify-privacy', 'seller-session-health', 'acceptance-scan'],
    executionBoundaries: ['approval_hash', 'fresh_evidence_hash', 'seller_duplicate_preflight', 'replay_guard', 'captcha_stop_policy'],
  }),
  [CHANNEL_IDS.EPWK]: Object.freeze({
    adapterId: 'epwk-auto-intake',
    channelId: CHANNEL_IDS.EPWK,
    displayName: 'EPWK',
    workspace: 'epwk-auto-intake',
    taskNormalizerExport: 'channelTaskFromEpwk',
    taskSourceKinds: ['epwk-radar-record', 'epwk-detail-record', 'epwk-candidate-pack'],
    runnerId: 'epwk-auto-intake.live-runner',
    runnerLocation: '../epwk-auto-intake',
    supportedActions: [
      ['epwk.providerSpendGuarded', EXTERNAL_ACTIONS.PROVIDER_SPEND, 'guarded_provider_spend'],
      ['epwk.modelSpendGuarded', EXTERNAL_ACTIONS.MODEL_SPEND, 'guarded_model_spend'],
      ['epwk.prepareOnly', EXTERNAL_ACTIONS.LIVE_PREPARE, 'prepare_only'],
      ['epwk.submitLive', EXTERNAL_ACTIONS.LIVE_SUBMIT, 'live_submit'],
      ['epwk.workModifyLive', EXTERNAL_ACTIONS.LIVE_SUBMIT, 'work_modify_live_submit'],
      ['epwk.bidSubmitLive', EXTERNAL_ACTIONS.LIVE_SUBMIT, 'bid_live_submit'],
      ['epwk.customerMessageLive', EXTERNAL_ACTIONS.CUSTOMER_MESSAGE, 'customer_message'],
      ['epwk.acceptanceApplyLive', EXTERNAL_ACTIONS.ACCEPTANCE_APPLY, 'acceptance_apply'],
    ],
    readOnlyProbes: ['epwk-radar', 'epwk-detail-fetch', 'epwk-submit-dryrun', 'epwk-prepare-only', 'epwk-workback-proof', 'epwk-lifecycle-dashboard'],
    executionBoundaries: [
      'account_gate',
      'approval_hash',
      'fresh_evidence_hash',
      'prepare_only_evidence',
      'workback_duplicate_preflight',
      'adapter_receipt_required',
      'channel_state_proof_required',
      'message_preview_required',
      'delivery_artifact_binding_required',
      'live_im_acceptance_adapters_require_runtime_proof',
    ],
  }),
  [CHANNEL_IDS.HEPTA]: Object.freeze({
    adapterId: 'hepta-delivery',
    channelId: CHANNEL_IDS.HEPTA,
    displayName: 'Hepta',
    workspace: 'hepta',
    taskNormalizerExport: 'channelTaskFromHepta',
    taskSourceKinds: ['hepta-order', 'hepta-checkout-session', 'hepta-delivery-request'],
    runnerId: 'hepta.delivery-runner',
    runnerLocation: '../hepta',
    supportedActions: [
      ['hepta.providerSpendGuarded', EXTERNAL_ACTIONS.PROVIDER_SPEND, 'guarded_provider_spend'],
      ['hepta.modelSpendGuarded', EXTERNAL_ACTIONS.MODEL_SPEND, 'guarded_model_spend'],
      ['hepta.customerMessagePreview', EXTERNAL_ACTIONS.CUSTOMER_MESSAGE, 'customer_message'],
      ['hepta.deliveryDeploy', EXTERNAL_ACTIONS.DEPLOYMENT, 'deployment'],
    ],
    readOnlyProbes: ['order-fixture-read', 'delivery-artifact-index', 'deployment-preview'],
    executionBoundaries: ['approval_hash', 'fresh_evidence_hash', 'deployment_build_proof', 'customer_message_approval'],
  }),
});

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes || '') || null,
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

function normalizeAction([actionId, externalAction, sideEffectClass]) {
  return {
    actionId: normalizeText(actionId),
    externalAction,
    sideEffectClass,
    dryRunDefault: true,
    executeFlagRequired: true,
    currentApprovalRequired: externalAction !== EXTERNAL_ACTIONS.NONE,
    freshEvidenceRequired: externalAction !== EXTERNAL_ACTIONS.NONE,
  };
}

function specForChannel(channelId) {
  return CHANNEL_INTERFACE_SPECS[channelId] || null;
}

function adapterBlockers({
  spec,
  channelId,
  actions,
  taskNormalizerExport,
  runnerId,
  runnerLocation,
  sourceSnapshotPolicy,
  safety,
}) {
  const blockers = [];
  if (!Object.values(CHANNEL_IDS).includes(channelId)) blockers.push(issue('unknown_channel_id'));
  if (!spec) blockers.push(issue('channel_adapter_spec_missing'));
  if (!normalizeText(taskNormalizerExport || '')) blockers.push(issue('task_normalizer_export_required'));
  if (!normalizeText(runnerId || '')) blockers.push(issue('runner_id_required'));
  const normalizedRunnerLocation = normalizeText(runnerLocation || '');
  if (!normalizedRunnerLocation) {
    blockers.push(issue('runner_location_required'));
  } else if (!isExternalWorkspaceRunnerLocation(normalizedRunnerLocation)) {
    blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, normalizedRunnerLocation));
  }
  if (!actions.length) blockers.push(issue('adapter_supported_actions_required'));
  const prefix = CHANNEL_ACTION_PREFIX[channelId];
  if (prefix) {
    for (const action of actions) {
      if (!action.actionId.startsWith(prefix)) blockers.push(issue('adapter_action_prefix_mismatch', action.actionId));
      if (!Object.values(EXTERNAL_ACTIONS).includes(action.externalAction)) {
        blockers.push(issue('unknown_external_action', action.externalAction));
      }
      if (action.executeFlagRequired !== true) blockers.push(issue('adapter_action_execute_flag_required', action.actionId));
      if (action.dryRunDefault !== true) blockers.push(issue('adapter_action_dry_run_default_required', action.actionId));
      if (action.externalAction !== EXTERNAL_ACTIONS.NONE && action.currentApprovalRequired !== true) {
        blockers.push(issue('adapter_action_current_approval_required', action.actionId));
      }
      if (action.externalAction !== EXTERNAL_ACTIONS.NONE && action.freshEvidenceRequired !== true) {
        blockers.push(issue('adapter_action_fresh_evidence_required', action.actionId));
      }
    }
  }
  if (sourceSnapshotPolicy !== 'redacted_by_default') blockers.push(issue('source_snapshot_policy_must_be_redacted_by_default'));
  for (const key of [
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
  ]) {
    if (safety?.[key] === true) blockers.push(issue(`unsafe_adapter_interface_claims_${key}`));
  }
  return blockers;
}

function adapterInterfaceHashInput(adapter) {
  return {
    version: adapter.version,
    kind: adapter.kind,
    status: adapter.status,
    ready: adapter.ready,
    adapterId: adapter.adapterId,
    channelId: adapter.channelId,
    displayName: adapter.displayName,
    workspace: adapter.workspace,
    taskContract: adapter.taskContract,
    actionContract: adapter.actionContract,
    runnerContract: adapter.runnerContract,
    capabilityContract: adapter.capabilityContract,
    sourceSnapshotPolicy: adapter.sourceSnapshotPolicy,
    blockers: adapter.blockers,
    warnings: adapter.warnings,
    evidenceRefs: adapter.evidenceRefs,
    safety: adapter.safety,
  };
}

export function buildChannelAdapterInterface({
  channelId,
  spec = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const resolvedSpec = spec || specForChannel(channelId);
  const normalizedChannelId = resolvedSpec?.channelId || channelId;
  const actions = (resolvedSpec?.supportedActions || []).map(normalizeAction);
  const sourceSnapshotPolicy = 'redacted_by_default';
  const safety = {
    adapterInterfaceOnly: true,
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
  };
  const blockers = adapterBlockers({
    spec: resolvedSpec,
    channelId: normalizedChannelId,
    actions,
    taskNormalizerExport: resolvedSpec?.taskNormalizerExport,
    runnerId: resolvedSpec?.runnerId,
    runnerLocation: resolvedSpec?.runnerLocation,
    sourceSnapshotPolicy,
    safety,
  });
  const adapter = {
    version: CHANNEL_ADAPTER_INTERFACE_VERSION,
    kind: 'ChannelAdapterInterface',
    status: blockers.length
      ? CHANNEL_ADAPTER_INTERFACE_STATUS.BLOCKED
      : CHANNEL_ADAPTER_INTERFACE_STATUS.READY,
    ready: blockers.length === 0,
    adapterId: normalizeText(resolvedSpec?.adapterId || '') || null,
    channelId: normalizedChannelId || null,
    displayName: normalizeText(resolvedSpec?.displayName || normalizedChannelId || '') || null,
    workspace: normalizeText(resolvedSpec?.workspace || '') || null,
    taskContract: {
      outputKind: 'ChannelTask',
      normalizerExport: normalizeText(resolvedSpec?.taskNormalizerExport || '') || null,
      sourceKinds: uniqueStrings(resolvedSpec?.taskSourceKinds || [], 16),
      sourceSnapshotDefault: false,
      sourceSnapshotOptInOnly: true,
    },
    actionContract: {
      actions,
      supportedExternalActions: uniqueStrings(actions.map((action) => action.externalAction), 16),
      unsupportedActionsStayBlocked: true,
    },
    runnerContract: {
      runnerId: normalizeText(resolvedSpec?.runnerId || '') || null,
      runnerLocation: normalizeText(resolvedSpec?.runnerLocation || '') || null,
      dryRunDefault: true,
      explicitExecuteFlagRequired: true,
      currentApprovalRequired: true,
      freshEvidenceRequired: true,
      replayGuardRequired: true,
      runnerLocationMustBeExternalWorkspace: true,
      runnerLocationExternalWorkspace: isExternalWorkspaceRunnerLocation(resolvedSpec?.runnerLocation),
      readOnlyProbes: uniqueStrings(resolvedSpec?.readOnlyProbes || [], 16),
      executionBoundaries: uniqueStrings(resolvedSpec?.executionBoundaries || [], 24),
    },
    capabilityContract: {
      channelCapabilities: channelCapabilities(normalizedChannelId),
    },
    sourceSnapshotPolicy,
    blockers,
    warnings: [
      issue('adapter_interface_descriptor_only', 'This interface describes shared adapter contracts and never executes channel actions.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety,
    createdAt: createdAt || new Date().toISOString(),
  };
  const adapterInterfaceHash = digest(adapterInterfaceHashInput(adapter));
  return {
    ...adapter,
    adapterInterfaceHash,
    hash: adapterInterfaceHash,
  };
}

function interfaceSetHashInput(set) {
  return {
    version: set.version,
    kind: set.kind,
    status: set.status,
    ready: set.ready,
    channelIds: set.channelIds,
    interfaceHashes: set.interfaceHashes,
    summary: set.summary,
    blockers: set.blockers,
    warnings: set.warnings,
    safety: set.safety,
  };
}

export function summarizeChannelAdapterInterfaces(interfaces = []) {
  const byStatus = {};
  const byChannel = {};
  const blockerCodes = {};
  const supportedActionCounts = {};
  for (const adapter of interfaces || []) {
    byStatus[adapter.status] = (byStatus[adapter.status] || 0) + 1;
    byChannel[adapter.channelId || 'unknown'] = (byChannel[adapter.channelId || 'unknown'] || 0) + 1;
    supportedActionCounts[adapter.channelId || 'unknown'] = adapter.actionContract?.actions?.length || 0;
    for (const blocker of adapter.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: CHANNEL_ADAPTER_INTERFACE_VERSION,
    count: interfaces.length,
    readyCount: interfaces.filter((adapter) => adapter.ready === true).length,
    byStatus,
    byChannel,
    supportedActionCounts,
    blockerCodes,
    safety: {
      adapterInterfaceOnly: true,
      executesExternalAction: interfaces.some((adapter) => adapter.safety?.executesExternalAction === true),
      fetchesChannelState: interfaces.some((adapter) => adapter.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: interfaces.some((adapter) => adapter.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: interfaces.some((adapter) => adapter.safety?.grantsExecutionPermission === true),
      readyForExecution: interfaces.some((adapter) => adapter.safety?.readyForExecution === true || adapter.readyForExecution === true),
    },
  };
}

export function buildChannelAdapterInterfaceSet({
  channelIds = [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const interfaces = uniqueStrings(channelIds, 8).map((channelId) => buildChannelAdapterInterface({
    channelId,
    evidenceRefs,
    createdAt,
  }));
  const blockers = interfaces.flatMap((adapter) => (adapter.blockers || []).map((blocker) => ({
    ...blocker,
    notes: normalizeText([adapter.channelId, blocker.notes].filter(Boolean).join(': ')) || null,
  })));
  const summary = summarizeChannelAdapterInterfaces(interfaces);
  const set = {
    version: CHANNEL_ADAPTER_INTERFACE_VERSION,
    kind: 'ChannelAdapterInterfaceSet',
    status: blockers.length
      ? CHANNEL_ADAPTER_INTERFACE_SET_STATUS.BLOCKED
      : CHANNEL_ADAPTER_INTERFACE_SET_STATUS.READY,
    ready: blockers.length === 0,
    channelIds: interfaces.map((adapter) => adapter.channelId),
    interfaceHashes: Object.fromEntries(interfaces.map((adapter) => [adapter.channelId, adapter.adapterInterfaceHash])),
    interfaces,
    summary,
    blockers,
    warnings: [
      issue('adapter_interface_set_descriptor_only', 'This set aligns ZBJ, EPWK, and Hepta adapter contracts without running any adapter.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      adapterInterfaceSetOnly: true,
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
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const interfaceSetHash = digest(interfaceSetHashInput(set));
  return {
    ...set,
    interfaceSetHash,
    hash: interfaceSetHash,
  };
}

function validateSingleInterface(adapter, recomputedHash) {
  const blockers = [];
  if (!adapter || adapter.kind !== 'ChannelAdapterInterface') {
    blockers.push(issue('invalid_channel_adapter_interface'));
    return blockers;
  }
  const adapterInterfaceHash = normalizeText(adapter.adapterInterfaceHash || '');
  const genericHash = normalizeText(adapter.hash || '');
  const recordedHash = adapterInterfaceHash || null;
  if (!recordedHash) blockers.push(issue('adapter_interface_hash_required'));
  if (!adapterInterfaceHash) blockers.push(issue('adapter_interface_hash_alias_required'));
  if (!genericHash) blockers.push(issue('adapter_interface_generic_hash_required'));
  if (adapterInterfaceHash && genericHash && adapterInterfaceHash !== genericHash) {
    blockers.push(issue('adapter_interface_hash_alias_mismatch'));
  }
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('adapter_interface_hash_content_mismatch'));
  }
  if (adapter.status === CHANNEL_ADAPTER_INTERFACE_STATUS.READY && adapter.ready !== true) {
    blockers.push(issue('ready_interface_without_ready_flag'));
  }
  if (adapter.status === CHANNEL_ADAPTER_INTERFACE_STATUS.READY && (adapter.blockers || []).length) {
    blockers.push(issue('ready_interface_has_blockers'));
  }
  if (adapter.status === CHANNEL_ADAPTER_INTERFACE_STATUS.BLOCKED && adapter.ready === true) {
    blockers.push(issue('blocked_interface_claims_ready'));
  }
  if (!adapter.taskContract?.normalizerExport) blockers.push(issue('task_normalizer_export_required'));
  if (!adapter.runnerContract?.runnerId) blockers.push(issue('runner_id_required'));
  const runnerLocation = normalizeText(adapter.runnerContract?.runnerLocation || '');
  if (!runnerLocation) {
    blockers.push(issue('runner_location_required'));
  } else if (!isExternalWorkspaceRunnerLocation(runnerLocation)) {
    blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, runnerLocation));
  }
  if (!adapter.actionContract?.actions?.length) blockers.push(issue('adapter_supported_actions_required'));
  const prefix = CHANNEL_ACTION_PREFIX[adapter.channelId];
  for (const action of adapter.actionContract?.actions || []) {
    if (prefix && !String(action.actionId || '').startsWith(prefix)) {
      blockers.push(issue('adapter_action_prefix_mismatch', action.actionId));
    }
    if (action.dryRunDefault !== true) blockers.push(issue('adapter_action_dry_run_default_required', action.actionId));
    if (action.executeFlagRequired !== true) blockers.push(issue('adapter_action_execute_flag_required', action.actionId));
  }
  if (adapter.sourceSnapshotPolicy !== 'redacted_by_default') {
    blockers.push(issue('source_snapshot_policy_must_be_redacted_by_default'));
  }
  for (const key of [
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
  ]) {
    if (adapter.safety?.[key] === true || adapter[key] === true) blockers.push(issue(`unsafe_adapter_interface_claims_${key}`));
  }
  return blockers;
}

function validateInterfaceSet(set, recomputedHash) {
  const blockers = [];
  if (!set || set.kind !== 'ChannelAdapterInterfaceSet') {
    blockers.push(issue('invalid_channel_adapter_interface_set'));
    return blockers;
  }
  const interfaceSetHash = normalizeText(set.interfaceSetHash || '');
  const genericHash = normalizeText(set.hash || '');
  const recordedHash = interfaceSetHash || null;
  if (!recordedHash) blockers.push(issue('adapter_interface_set_hash_required'));
  if (!interfaceSetHash) blockers.push(issue('adapter_interface_set_hash_alias_required'));
  if (!genericHash) blockers.push(issue('adapter_interface_set_generic_hash_required'));
  if (interfaceSetHash && genericHash && interfaceSetHash !== genericHash) {
    blockers.push(issue('adapter_interface_set_hash_alias_mismatch'));
  }
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('adapter_interface_set_hash_content_mismatch'));
  }
  if (set.status === CHANNEL_ADAPTER_INTERFACE_SET_STATUS.READY && set.ready !== true) {
    blockers.push(issue('ready_interface_set_without_ready_flag'));
  }
  if (set.status === CHANNEL_ADAPTER_INTERFACE_SET_STATUS.READY && (set.blockers || []).length) {
    blockers.push(issue('ready_interface_set_has_blockers'));
  }
  for (const required of [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA]) {
    if (!set.channelIds?.includes(required)) blockers.push(issue('required_channel_interface_missing', required));
  }
  for (const adapter of set.interfaces || []) {
    const recomputedAdapterHash = adapter?.kind === 'ChannelAdapterInterface'
      ? digest(adapterInterfaceHashInput(adapter))
      : null;
    blockers.push(...validateSingleInterface(adapter, recomputedAdapterHash)
      .map((blocker) => issue(blocker.code, normalizeText([adapter?.channelId, blocker.notes].filter(Boolean).join(': ')) || null)));
    const expectedHash = set.interfaceHashes?.[adapter.channelId];
    const actualHash = adapter.adapterInterfaceHash;
    if (expectedHash && actualHash && expectedHash !== actualHash) {
      blockers.push(issue('adapter_interface_set_hash_binding_mismatch', adapter.channelId));
    }
  }
  for (const key of [
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
  ]) {
    if (set.safety?.[key] === true || set[key] === true) blockers.push(issue(`unsafe_adapter_interface_set_claims_${key}`));
  }
  return blockers;
}

export function validateChannelAdapterInterfaceArtifact(artifact = null) {
  const isSet = artifact?.kind === 'ChannelAdapterInterfaceSet';
  const recomputedHash = isSet
    ? digest(interfaceSetHashInput(artifact))
    : (artifact?.kind === 'ChannelAdapterInterface' ? digest(adapterInterfaceHashInput(artifact)) : null);
  const blockers = isSet
    ? validateInterfaceSet(artifact, recomputedHash)
    : validateSingleInterface(artifact, recomputedHash);
  const validation = {
    version: CHANNEL_ADAPTER_INTERFACE_VERSION,
    kind: 'ChannelAdapterInterfaceValidation',
    status: blockers.length
      ? CHANNEL_ADAPTER_INTERFACE_VALIDATION_STATUS.FAIL
      : CHANNEL_ADAPTER_INTERFACE_VALIDATION_STATUS.PASS,
    ok: blockers.length === 0,
    artifactKind: normalizeText(artifact?.kind || ''),
    artifactHash: normalizeText(artifact?.interfaceSetHash || artifact?.adapterInterfaceHash || ''),
    recomputedHash,
    channelIds: isSet ? (artifact.channelIds || []) : [artifact?.channelId].filter(Boolean),
    blockers,
    warnings: [
      issue('channel_adapter_interface_validation_is_local_only', 'This validator reads saved adapter interface descriptors only.', 'warning'),
    ],
    safety: {
      validationOnly: true,
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
    },
  };
  return {
    ...validation,
    validationHash: digest({
      version: validation.version,
      kind: validation.kind,
      status: validation.status,
      ok: validation.ok,
      artifactKind: validation.artifactKind,
      artifactHash: validation.artifactHash,
      recomputedHash: validation.recomputedHash,
      channelIds: validation.channelIds,
      blockers: validation.blockers,
      warnings: validation.warnings,
      safety: validation.safety,
    }),
  };
}

export function channelAdapterInterfaceSelftest() {
  const set = buildChannelAdapterInterfaceSet({
    createdAt: '2026-05-25T00:00:00.000Z',
  });
  const validation = validateChannelAdapterInterfaceArtifact(set);
  const tamperedValidation = validateChannelAdapterInterfaceArtifact({
    ...set,
    interfaces: set.interfaces.map((adapter) => (adapter.channelId === CHANNEL_IDS.EPWK
      ? {
        ...adapter,
        actionContract: {
          ...adapter.actionContract,
          actions: [
            ...adapter.actionContract.actions,
            {
              actionId: 'zbj.wrongPrefix',
              externalAction: EXTERNAL_ACTIONS.LIVE_SUBMIT,
              sideEffectClass: 'live_submit',
              dryRunDefault: true,
              executeFlagRequired: true,
              currentApprovalRequired: true,
              freshEvidenceRequired: true,
            },
          ],
        },
      }
      : adapter)),
  });
  const unknown = buildChannelAdapterInterface({ channelId: 'unknown', createdAt: '2026-05-25T00:00:00.000Z' });
  const coreLocalRunner = buildChannelAdapterInterface({
    channelId: CHANNEL_IDS.ZBJ,
    spec: {
      ...CHANNEL_INTERFACE_SPECS[CHANNEL_IDS.ZBJ],
      runnerLocation: './src',
    },
    createdAt: '2026-05-25T00:00:00.000Z',
  });
  const strippedSetAlias = validateChannelAdapterInterfaceArtifact({
    ...set,
    interfaceSetHash: undefined,
  });
  const strippedAdapterAlias = validateChannelAdapterInterfaceArtifact({
    ...set,
    interfaces: set.interfaces.map((adapter) => (adapter.channelId === CHANNEL_IDS.ZBJ
      ? { ...adapter, adapterInterfaceHash: undefined }
      : adapter)),
  });
  const summary = summarizeChannelAdapterInterfaces(set.interfaces);
  const ok = set.status === CHANNEL_ADAPTER_INTERFACE_SET_STATUS.READY
    && set.ready === true
    && set.interfaces.length === 3
    && set.interfaceHashes[CHANNEL_IDS.ZBJ]
    && set.interfaceHashes[CHANNEL_IDS.EPWK]
    && set.interfaceHashes[CHANNEL_IDS.HEPTA]
    && set.interfaces.find((adapter) => adapter.channelId === CHANNEL_IDS.ZBJ)?.actionContract.actions.some((action) => action.actionId === 'zbj.pitchSubmitLive')
    && set.interfaces.find((adapter) => adapter.channelId === CHANNEL_IDS.EPWK)?.actionContract.actions.every((action) => action.actionId.startsWith('epwk.'))
    && set.interfaces.find((adapter) => adapter.channelId === CHANNEL_IDS.EPWK)?.actionContract.actions.some((action) => action.actionId === 'epwk.customerMessageLive')
    && set.interfaces.find((adapter) => adapter.channelId === CHANNEL_IDS.EPWK)?.actionContract.actions.some((action) => action.actionId === 'epwk.acceptanceApplyLive')
    && set.interfaces.find((adapter) => adapter.channelId === CHANNEL_IDS.HEPTA)?.actionContract.actions.some((action) => action.actionId === 'hepta.deliveryDeploy')
    && set.safety.executesExternalAction === false
    && set.safety.readyForExecution === false
    && validation.ok === true
    && tamperedValidation.blockers.some((blocker) => blocker.code === 'adapter_interface_set_hash_content_mismatch'
      || blocker.code === 'adapter_action_prefix_mismatch')
    && unknown.status === CHANNEL_ADAPTER_INTERFACE_STATUS.BLOCKED
    && unknown.blockers.some((blocker) => blocker.code === 'unknown_channel_id')
    && coreLocalRunner.status === CHANNEL_ADAPTER_INTERFACE_STATUS.BLOCKED
    && coreLocalRunner.blockers.some((blocker) => blocker.code === ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE)
    && strippedSetAlias.ok === false
    && strippedSetAlias.blockers.some((blocker) => blocker.code === 'adapter_interface_set_hash_alias_required')
    && strippedAdapterAlias.ok === false
    && strippedAdapterAlias.blockers.some((blocker) => blocker.code === 'adapter_interface_hash_alias_required')
    && summary.readyCount === 3
    && summary.safety.executesExternalAction === false
    && summary.safety.grantsExecutionPermission === false;
  return {
    ok,
    set,
    validation,
    tamperedValidation,
    unknown,
    coreLocalRunner,
    strippedSetAlias,
    strippedAdapterAlias,
    summary,
  };
}
