import { CHANNEL_IDS, normalizeText, uniqueStrings } from './contracts.mjs';
import {
  ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE,
  isExternalWorkspaceRunnerLocation,
} from './adapter-runner-location-boundary.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_RUNNER_CAPABILITY_VERSION = 1;

export const ADAPTER_RUNNER_CAPABILITY_STATUS = Object.freeze({
  READY: 'ready_adapter_runner_capability',
  BLOCKED: 'blocked_adapter_runner_capability',
});

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

function runnerActionPrefix(channelId) {
  if (channelId === CHANNEL_IDS.ZBJ) return 'zbj.';
  if (channelId === CHANNEL_IDS.EPWK) return 'epwk.';
  if (channelId === CHANNEL_IDS.HEPTA) return 'hepta.';
  if (channelId === CHANNEL_IDS.MANUAL) return 'manual.';
  return null;
}

function capabilityBlockers({
  runnerId,
  channelId,
  runnerLocation,
  supportedActionIds,
  requiresExplicitExecuteFlag,
  requiresCurrentApproval,
  requiresFreshEvidence,
  externalRunner,
}) {
  const blockers = [];
  const normalizedRunnerLocation = normalizeText(runnerLocation || '');
  if (!normalizeText(runnerId || '')) blockers.push(issue('runner_id_required'));
  if (!Object.values(CHANNEL_IDS).includes(channelId)) blockers.push(issue('unknown_channel_id'));
  if (!normalizedRunnerLocation) {
    blockers.push(issue('runner_location_required'));
  } else if (!isExternalWorkspaceRunnerLocation(normalizedRunnerLocation)) {
    blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, normalizedRunnerLocation));
  }
  if (!supportedActionIds.length) blockers.push(issue('supported_actions_required'));

  const prefix = runnerActionPrefix(channelId);
  if (prefix) {
    for (const actionId of supportedActionIds) {
      if (!actionId.startsWith(prefix)) blockers.push(issue('action_id_not_owned_by_channel', actionId));
    }
  }

  if (requiresExplicitExecuteFlag !== true) blockers.push(issue('explicit_execute_flag_required'));
  if (requiresCurrentApproval !== true) blockers.push(issue('current_approval_required'));
  if (requiresFreshEvidence !== true) blockers.push(issue('fresh_evidence_required'));
  if (externalRunner !== true) blockers.push(issue('external_runner_boundary_required'));

  return blockers;
}

function adapterRunnerCapabilityHashPayload(capability = {}) {
  return {
    version: capability?.version,
    kind: capability?.kind,
    status: capability?.status,
    readyForDispatchUse: capability?.readyForDispatchUse,
    runnerId: capability?.runnerId,
    channelId: capability?.channelId,
    runnerLocation: capability?.runnerLocation,
    supportedActionIds: capability?.supportedActionIds,
    policy: capability?.policy,
    blockers: capability?.blockers,
    warnings: capability?.warnings,
    notes: capability?.notes,
    evidenceRefs: capability?.evidenceRefs,
    safety: capability?.safety,
  };
}

export function computeAdapterRunnerCapabilityHash(capability = {}) {
  return digest(adapterRunnerCapabilityHashPayload(capability));
}

export function buildAdapterRunnerCapability({
  runnerId = null,
  channelId = null,
  supportedActionIds = [],
  runnerLocation = null,
  supportsExecute = false,
  dryRunDefault = true,
  requiresExplicitExecuteFlag = true,
  requiresCurrentApproval = true,
  requiresFreshEvidence = true,
  requiresReplayGuard = true,
  externalRunner = true,
  notes = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const actions = uniqueStrings((supportedActionIds || []).map((actionId) => normalizeText(actionId || '')), 128);
  const blockers = capabilityBlockers({
    runnerId,
    channelId,
    runnerLocation,
    supportedActionIds: actions,
    requiresExplicitExecuteFlag,
    requiresCurrentApproval,
    requiresFreshEvidence,
    externalRunner,
  });
  const status = blockers.length
    ? ADAPTER_RUNNER_CAPABILITY_STATUS.BLOCKED
    : ADAPTER_RUNNER_CAPABILITY_STATUS.READY;

  const capability = {
    version: ADAPTER_RUNNER_CAPABILITY_VERSION,
    kind: 'AdapterRunnerCapability',
    status,
    readyForDispatchUse: status === ADAPTER_RUNNER_CAPABILITY_STATUS.READY,
    runnerId: normalizeText(runnerId || '') || null,
    channelId,
    runnerLocation: normalizeText(runnerLocation || '') || null,
    supportedActionIds: actions,
    policy: {
      supportsExecute: Boolean(supportsExecute),
      dryRunDefault: dryRunDefault !== false,
      requiresExplicitExecuteFlag: requiresExplicitExecuteFlag === true,
      requiresCurrentApproval: requiresCurrentApproval === true,
      requiresFreshEvidence: requiresFreshEvidence === true,
      requiresReplayGuard: requiresReplayGuard !== false,
      externalRunner: externalRunner === true,
      runnerLocationMustBeExternalWorkspace: true,
      runnerLocationExternalWorkspace: isExternalWorkspaceRunnerLocation(runnerLocation),
    },
    blockers,
    warnings: [
      issue('capability_descriptor_only', 'Runner capabilities describe external adapters but never execute them.', 'warning'),
    ],
    notes: normalizeText(notes || '') || null,
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      capabilityDescriptorOnly: true,
      executesExternalAction: false,
      runnerMayExecuteExternalAction: status === ADAPTER_RUNNER_CAPABILITY_STATUS.READY && Boolean(supportsExecute),
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const capabilityHash = computeAdapterRunnerCapabilityHash(capability);

  return {
    ...capability,
    capabilityHash,
    hash: capabilityHash,
  };
}

export function summarizeAdapterRunnerCapabilities(capabilities = []) {
  const byStatus = {};
  const byChannel = {};
  const blockerCodes = {};
  let executableRunnerCount = 0;
  for (const capability of capabilities || []) {
    byStatus[capability.status] = (byStatus[capability.status] || 0) + 1;
    byChannel[capability.channelId || 'unknown'] = (byChannel[capability.channelId || 'unknown'] || 0) + 1;
    if (capability.safety?.runnerMayExecuteExternalAction === true) executableRunnerCount += 1;
    for (const blocker of capability.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_RUNNER_CAPABILITY_VERSION,
    count: capabilities.length,
    executableRunnerCount,
    byStatus,
    byChannel,
    blockerCodes,
    safety: {
      capabilityDescriptorOnly: true,
      executesExternalAction: capabilities.some((capability) => capability.safety?.executesExternalAction === true),
      fetchesChannelState: capabilities.some((capability) => capability.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: capabilities.some((capability) => capability.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: capabilities.some((capability) => capability.safety?.grantsExecutionPermission === true),
    },
  };
}
