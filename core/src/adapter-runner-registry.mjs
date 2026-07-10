import { CHANNEL_IDS, normalizeText, uniqueStrings } from './contracts.mjs';
import {
  ADAPTER_RUNNER_CAPABILITY_STATUS,
  computeAdapterRunnerCapabilityHash,
} from './adapter-runner-capabilities.mjs';
import {
  ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE,
  isExternalWorkspaceRunnerLocation,
} from './adapter-runner-location-boundary.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_RUNNER_REGISTRY_VERSION = 1;

export const ADAPTER_RUNNER_REGISTRY_STATUS = Object.freeze({
  READY: 'ready_adapter_runner_registry',
  BLOCKED: 'blocked_adapter_runner_registry',
});

export const ADAPTER_RUNNER_SELECTION_STATUS = Object.freeze({
  READY: 'ready_adapter_runner_selection',
  BLOCKED: 'blocked_adapter_runner_selection',
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

function text(value) {
  return normalizeText(value || '') || null;
}

function recordedCapabilityHash(capability) {
  return text(capability?.capabilityHash);
}

function routeKey(channelId, actionId) {
  return `${channelId || 'unknown'}:${actionId || 'unknown'}`;
}

function capabilityEntry(capability) {
  return {
    runnerId: capability?.runnerId || null,
    channelId: capability?.channelId || null,
    runnerLocation: capability?.runnerLocation || null,
    capabilityHash: recordedCapabilityHash(capability),
    supportedActionIds: uniqueStrings(capability?.supportedActionIds || [], 128),
    runnerMayExecuteExternalAction: capability?.safety?.runnerMayExecuteExternalAction === true,
  };
}

function registryBlockers(capabilities) {
  const blockers = [];
  const routeOwners = new Map();
  const runnerIds = new Set();

  if (!capabilities.length) blockers.push(issue('runner_capabilities_required'));
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];
    if (!capability || capability.kind !== 'AdapterRunnerCapability') {
      blockers.push(issue('invalid_runner_capability', `index=${index}`));
      continue;
    }
    if (capability.status !== ADAPTER_RUNNER_CAPABILITY_STATUS.READY || capability.readyForDispatchUse !== true) {
      blockers.push(issue('runner_capability_not_ready', capability.runnerId || `index=${index}`));
    }
    const capabilityAliasHash = recordedCapabilityHash(capability);
    const capabilityGenericHash = text(capability.hash);
    const storedCapabilityHash = capabilityAliasHash || capabilityGenericHash;
    if (!storedCapabilityHash) {
      blockers.push(issue('runner_capability_hash_required', capability.runnerId || `index=${index}`));
    }
    if (!capabilityAliasHash) {
      blockers.push(issue('runner_capability_hash_alias_required', capability.runnerId || `index=${index}`));
    }
    if (!capabilityGenericHash) {
      blockers.push(issue('runner_capability_generic_hash_required', capability.runnerId || `index=${index}`));
    }
    if (capabilityAliasHash && capabilityGenericHash && capabilityAliasHash !== capabilityGenericHash) {
      blockers.push(issue('runner_capability_hash_alias_mismatch', capability.runnerId || `index=${index}`));
    }
    if (storedCapabilityHash && storedCapabilityHash !== computeAdapterRunnerCapabilityHash(capability)) {
      blockers.push(issue('runner_capability_hash_content_mismatch', capability.runnerId || `index=${index}`));
    }
    const runnerLocation = text(capability.runnerLocation);
    if (!runnerLocation) {
      blockers.push(issue('runner_location_required', capability.runnerId || `index=${index}`));
    } else if (!isExternalWorkspaceRunnerLocation(runnerLocation)) {
      blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, capability.runnerId || `index=${index}`));
    }
    if (!Object.values(CHANNEL_IDS).includes(capability.channelId)) blockers.push(issue('unknown_channel_id', capability.channelId));
    if (capability.safety?.executesExternalAction === true) blockers.push(issue('runner_capability_claims_core_execution', capability.runnerId));
    if (capability.safety?.grantsExecutionPermission === true) blockers.push(issue('runner_capability_claims_permission', capability.runnerId));

    if (capability.runnerId) {
      if (runnerIds.has(capability.runnerId)) blockers.push(issue('duplicate_runner_id', capability.runnerId));
      runnerIds.add(capability.runnerId);
    }
    for (const actionId of capability.supportedActionIds || []) {
      const key = routeKey(capability.channelId, actionId);
      if (routeOwners.has(key)) {
        blockers.push(issue('duplicate_runner_action_route', key));
      } else {
        routeOwners.set(key, capability.runnerId || `index=${index}`);
      }
    }
  }

  return blockers;
}

function registryRoutes(entries) {
  return entries.flatMap((entry) => (entry.supportedActionIds || []).map((actionId) => ({
    channelId: entry.channelId,
    actionId,
    runnerId: entry.runnerId,
    capabilityHash: entry.capabilityHash,
  })));
}

function adapterRunnerRegistryHashPayload(registry = {}) {
  return {
    version: registry?.version,
    kind: registry?.kind,
    registryId: registry?.registryId,
    actor: registry?.actor,
    status: registry?.status,
    ready: registry?.ready,
    entries: registry?.entries,
    routes: registry?.routes,
    blockers: registry?.blockers,
    warnings: registry?.warnings,
    evidenceRefs: registry?.evidenceRefs,
    safety: registry?.safety,
  };
}

export function computeAdapterRunnerRegistryHash(registry = {}) {
  return digest(adapterRunnerRegistryHashPayload(registry));
}

export function buildAdapterRunnerRegistry({
  capabilities = [],
  registryId = 'default-runner-registry',
  actor = 'design-production-core.adapter-runner-registry',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const normalizedCapabilities = Array.isArray(capabilities) ? capabilities : [];
  const blockers = registryBlockers(normalizedCapabilities);
  const status = blockers.length
    ? ADAPTER_RUNNER_REGISTRY_STATUS.BLOCKED
    : ADAPTER_RUNNER_REGISTRY_STATUS.READY;
  const entries = normalizedCapabilities
    .filter((capability) => capability?.kind === 'AdapterRunnerCapability')
    .map(capabilityEntry);
  const routes = registryRoutes(entries);

  const registry = {
    version: ADAPTER_RUNNER_REGISTRY_VERSION,
    kind: 'AdapterRunnerRegistry',
    registryId: normalizeText(registryId || '') || 'default-runner-registry',
    actor: normalizeText(actor || '') || 'design-production-core.adapter-runner-registry',
    status,
    ready: status === ADAPTER_RUNNER_REGISTRY_STATUS.READY,
    entries,
    routes,
    blockers,
    warnings: [
      issue('runner_registry_descriptor_only', 'Runner registries select external adapters but never execute them.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      runnerRegistryOnly: true,
      executesExternalAction: false,
      runnerMayExecuteExternalAction: entries.some((entry) => entry.runnerMayExecuteExternalAction === true),
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
  const registryHash = computeAdapterRunnerRegistryHash(registry);

  return {
    ...registry,
    registryHash,
    hash: registryHash,
  };
}

function findRoute(registry, channelId, actionId) {
  return (registry?.routes || []).find((route) => route.channelId === channelId && route.actionId === actionId) || null;
}

function selectionBlockers({ registry, channelId, actionId, route }) {
  const blockers = [];
  if (!registry || registry.kind !== 'AdapterRunnerRegistry') {
    blockers.push(issue('invalid_runner_registry'));
  } else {
    if (registry.status !== ADAPTER_RUNNER_REGISTRY_STATUS.READY || registry.ready !== true) {
      blockers.push(issue('runner_registry_not_ready'));
    }
    const registryAliasHash = text(registry.registryHash);
    const registryGenericHash = text(registry.hash);
    const registryHash = registryAliasHash || registryGenericHash;
    if (!registryHash) {
      blockers.push(issue('runner_registry_hash_required'));
    }
    if (!registryAliasHash) {
      blockers.push(issue('runner_registry_hash_alias_required'));
    }
    if (!registryGenericHash) {
      blockers.push(issue('runner_registry_generic_hash_required'));
    }
    if (registryAliasHash && registryGenericHash && registryAliasHash !== registryGenericHash) {
      blockers.push(issue('runner_registry_hash_alias_mismatch'));
    }
    if (registryHash && registryHash !== computeAdapterRunnerRegistryHash(registry)) {
      blockers.push(issue('runner_registry_hash_content_mismatch'));
    }
    if (registry.safety?.executesExternalAction === true) blockers.push(issue('runner_registry_claims_core_execution'));
    if (registry.safety?.grantsExecutionPermission === true) blockers.push(issue('runner_registry_claims_permission'));
  }
  if (!Object.values(CHANNEL_IDS).includes(channelId)) blockers.push(issue('unknown_channel_id', channelId));
  if (!text(actionId)) blockers.push(issue('action_id_required'));
  if (registry?.ready === true && channelId && actionId && !route) blockers.push(issue('runner_route_not_found', routeKey(channelId, actionId)));
  return blockers;
}

function adapterRunnerSelectionHashPayload(selection = {}) {
  return {
    version: selection?.version,
    kind: selection?.kind,
    requestedBy: selection?.requestedBy,
    status: selection?.status,
    selected: selection?.selected,
    registryHash: selection?.registryHash,
    channelId: selection?.channelId,
    actionId: selection?.actionId,
    runner: selection?.runner,
    blockers: selection?.blockers,
    warnings: selection?.warnings,
    evidenceRefs: selection?.evidenceRefs,
    safety: selection?.safety,
  };
}

export function computeAdapterRunnerSelectionHash(selection = {}) {
  return digest(adapterRunnerSelectionHashPayload(selection));
}

export function selectAdapterRunnerCapability({
  registry = null,
  channelId = null,
  actionId = null,
  requestedBy = 'design-production-core.adapter-runner-registry',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const normalizedChannelId = text(channelId);
  const normalizedActionId = text(actionId);
  const route = findRoute(registry, normalizedChannelId, normalizedActionId);
  const blockers = selectionBlockers({
    registry,
    channelId: normalizedChannelId,
    actionId: normalizedActionId,
    route,
  });
  const status = blockers.length
    ? ADAPTER_RUNNER_SELECTION_STATUS.BLOCKED
    : ADAPTER_RUNNER_SELECTION_STATUS.READY;

  const selection = {
    version: ADAPTER_RUNNER_REGISTRY_VERSION,
    kind: 'AdapterRunnerSelection',
    requestedBy: normalizeText(requestedBy || '') || 'design-production-core.adapter-runner-registry',
    status,
    selected: status === ADAPTER_RUNNER_SELECTION_STATUS.READY,
    registryHash: text(registry?.registryHash),
    channelId: normalizedChannelId,
    actionId: normalizedActionId,
    runner: route
      ? {
        runnerId: route.runnerId,
        capabilityHash: route.capabilityHash,
      }
      : null,
    blockers,
    warnings: [
      issue('runner_selection_descriptor_only', 'Runner selections do not execute adapters or grant permission.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      runnerSelectionOnly: true,
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
  const selectionHash = computeAdapterRunnerSelectionHash(selection);

  return {
    ...selection,
    selectionHash,
    hash: selectionHash,
  };
}

export function summarizeAdapterRunnerRegistries(registries = []) {
  const byStatus = {};
  const blockerCodes = {};
  let routeCount = 0;
  for (const registry of registries || []) {
    byStatus[registry.status] = (byStatus[registry.status] || 0) + 1;
    routeCount += registry.routes?.length || 0;
    for (const blocker of registry.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_RUNNER_REGISTRY_VERSION,
    count: registries.length,
    routeCount,
    byStatus,
    blockerCodes,
    safety: {
      runnerRegistryOnly: true,
      executesExternalAction: registries.some((registry) => registry.safety?.executesExternalAction === true),
      fetchesChannelState: registries.some((registry) => registry.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: registries.some((registry) => registry.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: registries.some((registry) => registry.safety?.grantsExecutionPermission === true),
      readyForExecution: registries.some((registry) => registry.safety?.readyForExecution === true),
    },
  };
}

export function summarizeAdapterRunnerSelections(selections = []) {
  const byStatus = {};
  const byChannel = {};
  const blockerCodes = {};
  for (const selection of selections || []) {
    byStatus[selection.status] = (byStatus[selection.status] || 0) + 1;
    byChannel[selection.channelId || 'unknown'] = (byChannel[selection.channelId || 'unknown'] || 0) + 1;
    for (const blocker of selection.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_RUNNER_REGISTRY_VERSION,
    count: selections.length,
    byStatus,
    byChannel,
    blockerCodes,
    safety: {
      runnerSelectionOnly: true,
      executesExternalAction: selections.some((selection) => selection.safety?.executesExternalAction === true),
      fetchesChannelState: selections.some((selection) => selection.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: selections.some((selection) => selection.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: selections.some((selection) => selection.safety?.grantsExecutionPermission === true),
      readyForExecution: selections.some((selection) => selection.safety?.readyForExecution === true),
    },
  };
}
