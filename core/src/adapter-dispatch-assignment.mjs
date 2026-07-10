import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
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
  ADAPTER_RUNNER_CAPABILITY_STATUS,
  computeAdapterRunnerCapabilityHash,
} from './adapter-runner-capabilities.mjs';
import {
  ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE,
  isExternalWorkspaceRunnerLocation,
} from './adapter-runner-location-boundary.mjs';
import {
  ADAPTER_RUNNER_SELECTION_STATUS,
  computeAdapterRunnerSelectionHash,
} from './adapter-runner-registry.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_DISPATCH_ASSIGNMENT_VERSION = 1;

export const ADAPTER_DISPATCH_ASSIGNMENT_STATUS = Object.freeze({
  READY: 'ready_adapter_dispatch_assignment',
  BLOCKED: 'blocked_adapter_dispatch_assignment',
});

const REQUIRED_DISPATCH_ENVELOPE_HASHES = Object.freeze([
  ['outboxHash', 'dispatch_envelope_outbox_hash_missing'],
  ['replayGuardHash', 'dispatch_envelope_replay_guard_hash_missing'],
  ['manifestHash', 'dispatch_envelope_manifest_hash_missing'],
  ['previewHash', 'dispatch_envelope_preview_hash_missing'],
  ['approvalHash', 'dispatch_envelope_approval_hash_missing'],
  ['evidenceHash', 'dispatch_envelope_evidence_hash_missing'],
]);

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

function expectedDispatchEnvelopeHash(dispatchEnvelope) {
  return text(dispatchEnvelope?.dispatchEnvelopeHash);
}

function expectedCapabilityHash(runnerCapability) {
  return text(runnerCapability?.capabilityHash);
}

function expectedSelectionHash(runnerSelection) {
  return text(runnerSelection?.selectionHash);
}

function isPromptGenerationSpendAction(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function isPromptGenerationSpendHandoff(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return [
    dispatchEnvelope?.action,
    dispatchEnvelope?.actionId,
    dispatchEnvelope?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => isPromptGenerationSpendAction(value));
}

function isCustomerMessageAction(value) {
  return canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function isCustomerMessageHandoff(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return [
    dispatchEnvelope?.action,
    dispatchEnvelope?.actionId,
    dispatchEnvelope?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => isCustomerMessageAction(value));
}

function isHumanFeedbackMessageHandoff(dispatchEnvelope) {
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
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && (
      actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || productValues.some((value) => isHumanFeedbackIdentity(value))
      || text(payload.humanFeedbackRevisionContractHash)
      || text(hashes.humanFeedbackRevisionContractHash)
      || text(snapshots.manifest?.payload?.humanFeedbackRevisionContractHash)
      || text(snapshots.preview?.payload?.humanFeedbackRevisionContractHash)
      || text(snapshots.preview?.adapter?.requiredHashes?.humanFeedbackRevisionContractHash)
    );
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => text(left[key]) === text(right[key]));
}

function promptGenerationBindingValues(dispatchEnvelope) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return [
    dispatchEnvelope?.payload?.promptGenerationBinding,
    dispatchEnvelope?.runner?.requiredHashes?.promptGenerationBinding,
    snapshots.manifest?.payload?.promptGenerationBinding,
    snapshots.preview?.payload?.promptGenerationBinding,
    snapshots.preview?.adapter?.requiredHashes?.promptGenerationBinding,
  ];
}

function promptGenerationBindingBlockers(dispatchEnvelope) {
  const values = promptGenerationBindingValues(dispatchEnvelope);
  const present = values.filter(Boolean);
  if (!present.length) {
    return isPromptGenerationSpendHandoff(dispatchEnvelope)
      ? [issue('dispatch_envelope_prompt_generation_binding_missing')]
      : [];
  }
  if (present.length !== values.length) return [issue('dispatch_envelope_prompt_generation_binding_missing')];
  if (!present.every((value) => samePromptGenerationBinding(value, present[0]))) {
    return [issue('dispatch_envelope_prompt_generation_binding_mismatch')];
  }
  const missingKeys = PROMPT_GENERATION_BINDING_KEYS.filter((key) => !text(present[0]?.[key]));
  if (missingKeys.length) {
    return [issue('dispatch_envelope_prompt_generation_binding_incomplete', missingKeys.join(', '))];
  }
  return [];
}

function allEqualNonEmpty(values = []) {
  const normalized = values.map((value) => text(value));
  return normalized.every(Boolean) && new Set(normalized).size === 1;
}

function customerMessagePreviewHashBlockers(dispatchEnvelope) {
  if (!isCustomerMessageHandoff(dispatchEnvelope)) return [];
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  const expected = computeCustomerMessagePreviewHash(dispatchEnvelope?.payload?.messagePreview);
  const values = [
    dispatchEnvelope?.payload?.messagePreviewHash,
    dispatchEnvelope?.runner?.requiredHashes?.messagePreviewHash,
    snapshots.manifest?.payload?.messagePreviewHash,
    snapshots.preview?.payload?.messagePreviewHash,
    snapshots.preview?.adapter?.requiredHashes?.messagePreviewHash,
  ].map((value) => text(value));
  const blockers = [];
  if (!expected || values.some((value) => !value)) {
    blockers.push(issue('dispatch_envelope_message_preview_hash_missing'));
  }
  if (expected && values.some((value) => value && value !== expected)) {
    blockers.push(issue('dispatch_envelope_message_preview_hash_mismatch'));
  }
  return blockers;
}

function humanFeedbackContractHashBlockers(dispatchEnvelope) {
  if (!isHumanFeedbackMessageHandoff(dispatchEnvelope)) return [];
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  const values = [
    dispatchEnvelope?.payload?.humanFeedbackRevisionContractHash,
    dispatchEnvelope?.runner?.requiredHashes?.humanFeedbackRevisionContractHash,
    snapshots.manifest?.payload?.humanFeedbackRevisionContractHash,
    snapshots.preview?.payload?.humanFeedbackRevisionContractHash,
    snapshots.preview?.adapter?.requiredHashes?.humanFeedbackRevisionContractHash,
  ];
  if (allEqualNonEmpty(values)) return [];
  if (values.some((value) => !text(value))) {
    return [issue('dispatch_envelope_human_feedback_contract_hash_missing')];
  }
  return [issue('dispatch_envelope_human_feedback_contract_hash_mismatch')];
}

function requiredDispatchEnvelopeHash(dispatchEnvelope, key) {
  return text(dispatchEnvelope?.runner?.requiredHashes?.[key]);
}

function assignmentBlockers({ dispatchEnvelope, runnerCapability, runnerSelection }) {
  const blockers = [];

  if (!dispatchEnvelope || dispatchEnvelope.kind !== 'AdapterDispatchEnvelope') {
    blockers.push(issue('invalid_dispatch_envelope'));
  } else {
    if (dispatchEnvelope.status !== ADAPTER_DISPATCH_ENVELOPE_STATUS.READY || dispatchEnvelope.readyForExternalRunner !== true) {
      blockers.push(issue('dispatch_envelope_not_ready'));
    }
    const dispatchEnvelopeAliasHash = expectedDispatchEnvelopeHash(dispatchEnvelope);
    const dispatchEnvelopeGenericHash = text(dispatchEnvelope.hash);
    const dispatchEnvelopeHash = dispatchEnvelopeAliasHash || dispatchEnvelopeGenericHash;
    if (!dispatchEnvelopeHash) {
      blockers.push(issue('dispatch_envelope_hash_required'));
    }
    if (!dispatchEnvelopeAliasHash) {
      blockers.push(issue('dispatch_envelope_hash_alias_required'));
    }
    if (!dispatchEnvelopeGenericHash) {
      blockers.push(issue('dispatch_envelope_generic_hash_required'));
    }
    if (dispatchEnvelopeAliasHash && dispatchEnvelopeGenericHash && dispatchEnvelopeAliasHash !== dispatchEnvelopeGenericHash) {
      blockers.push(issue('dispatch_envelope_hash_alias_mismatch'));
    }
    if (dispatchEnvelopeHash && dispatchEnvelopeHash !== computeAdapterDispatchEnvelopeHash(dispatchEnvelope)) {
      blockers.push(issue('dispatch_envelope_hash_content_mismatch'));
    }
    for (const [key, code] of REQUIRED_DISPATCH_ENVELOPE_HASHES) {
      if (!requiredDispatchEnvelopeHash(dispatchEnvelope, key)) blockers.push(issue(code));
    }
    blockers.push(...customerMessagePreviewHashBlockers(dispatchEnvelope));
    blockers.push(...humanFeedbackContractHashBlockers(dispatchEnvelope));
    blockers.push(...promptGenerationBindingBlockers(dispatchEnvelope));
    if (dispatchEnvelope.safety?.executesExternalAction === true) blockers.push(issue('dispatch_envelope_claims_external_execution'));
    if (dispatchEnvelope.safety?.readyForExecution === true) blockers.push(issue('dispatch_envelope_claims_execution_ready'));
    if (dispatchEnvelope.safety?.grantsExecutionPermission === true) blockers.push(issue('dispatch_envelope_claims_permission'));
  }

  if (!runnerCapability || runnerCapability.kind !== 'AdapterRunnerCapability') {
    blockers.push(issue('invalid_runner_capability'));
  } else {
    if (runnerCapability.status !== ADAPTER_RUNNER_CAPABILITY_STATUS.READY || runnerCapability.readyForDispatchUse !== true) {
      blockers.push(issue('runner_capability_not_ready'));
    }
    const runnerCapabilityAliasHash = expectedCapabilityHash(runnerCapability);
    const runnerCapabilityGenericHash = text(runnerCapability.hash);
    const runnerCapabilityHash = runnerCapabilityAliasHash || runnerCapabilityGenericHash;
    if (!runnerCapabilityHash) {
      blockers.push(issue('runner_capability_hash_required'));
    }
    if (!runnerCapabilityAliasHash) {
      blockers.push(issue('runner_capability_hash_alias_required'));
    }
    if (!runnerCapabilityGenericHash) {
      blockers.push(issue('runner_capability_generic_hash_required'));
    }
    if (runnerCapabilityAliasHash && runnerCapabilityGenericHash && runnerCapabilityAliasHash !== runnerCapabilityGenericHash) {
      blockers.push(issue('runner_capability_hash_alias_mismatch'));
    }
    if (runnerCapabilityHash && runnerCapabilityHash !== computeAdapterRunnerCapabilityHash(runnerCapability)) {
      blockers.push(issue('runner_capability_hash_content_mismatch'));
    }
    const runnerLocation = text(runnerCapability.runnerLocation);
    if (!runnerLocation) {
      blockers.push(issue('runner_location_required'));
    } else if (!isExternalWorkspaceRunnerLocation(runnerLocation)) {
      blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, runnerLocation));
    }
    if (runnerCapability.safety?.executesExternalAction === true) blockers.push(issue('runner_capability_claims_core_execution'));
    if (runnerCapability.safety?.grantsExecutionPermission === true) blockers.push(issue('runner_capability_claims_permission'));
  }

  if (dispatchEnvelope && runnerCapability) {
    const dispatchChannelId = text(dispatchEnvelope.channelId);
    const capabilityChannelId = text(runnerCapability.channelId);
    if (dispatchChannelId) {
      if (!capabilityChannelId) {
        blockers.push(issue('runner_channel_required'));
      } else if (dispatchChannelId !== capabilityChannelId) {
        blockers.push(issue('runner_channel_mismatch'));
      }
    }
    if (dispatchEnvelope.actionId && !(runnerCapability.supportedActionIds || []).includes(dispatchEnvelope.actionId)) {
      blockers.push(issue('runner_action_not_supported', dispatchEnvelope.actionId));
    }
  }

  if (runnerSelection) {
    if (runnerSelection.kind !== 'AdapterRunnerSelection') {
      blockers.push(issue('invalid_runner_selection'));
    } else {
      if (runnerSelection.status !== ADAPTER_RUNNER_SELECTION_STATUS.READY || runnerSelection.selected !== true) {
        blockers.push(issue('runner_selection_not_ready'));
      }
      const runnerSelectionAliasHash = expectedSelectionHash(runnerSelection);
      const runnerSelectionGenericHash = text(runnerSelection.hash);
      const runnerSelectionHash = runnerSelectionAliasHash || runnerSelectionGenericHash;
      if (!runnerSelectionHash) {
        blockers.push(issue('runner_selection_hash_required'));
      }
      if (!runnerSelectionAliasHash) {
        blockers.push(issue('runner_selection_hash_alias_required'));
      }
      if (!runnerSelectionGenericHash) {
        blockers.push(issue('runner_selection_generic_hash_required'));
      }
      if (runnerSelectionAliasHash && runnerSelectionGenericHash && runnerSelectionAliasHash !== runnerSelectionGenericHash) {
        blockers.push(issue('runner_selection_hash_alias_mismatch'));
      }
      if (runnerSelectionHash && runnerSelectionHash !== computeAdapterRunnerSelectionHash(runnerSelection)) {
        blockers.push(issue('runner_selection_hash_content_mismatch'));
      }
      if (runnerSelection.safety?.executesExternalAction === true) blockers.push(issue('runner_selection_claims_core_execution'));
      if (runnerSelection.safety?.grantsExecutionPermission === true) blockers.push(issue('runner_selection_claims_permission'));
      const dispatchChannelId = text(dispatchEnvelope?.channelId);
      const selectionChannelId = text(runnerSelection.channelId);
      if (dispatchChannelId) {
        if (!selectionChannelId) {
          blockers.push(issue('runner_selection_channel_required'));
        } else if (dispatchChannelId !== selectionChannelId) {
          blockers.push(issue('runner_selection_channel_mismatch'));
        }
      }
      const dispatchActionId = text(dispatchEnvelope?.actionId);
      const selectionActionId = text(runnerSelection.actionId);
      if (dispatchActionId) {
        if (!selectionActionId) {
          blockers.push(issue('runner_selection_action_required'));
        } else if (dispatchActionId !== selectionActionId) {
          blockers.push(issue('runner_selection_action_mismatch'));
        }
      }
      const capabilityRunnerId = text(runnerCapability?.runnerId);
      const selectionRunnerId = text(runnerSelection.runner?.runnerId);
      if (capabilityRunnerId) {
        if (!selectionRunnerId) {
          blockers.push(issue('runner_selection_runner_required'));
        } else if (capabilityRunnerId !== selectionRunnerId) {
          blockers.push(issue('runner_selection_runner_mismatch'));
        }
      }
      const selectedCapabilityHash = text(runnerSelection.runner?.capabilityHash);
      const currentCapabilityHash = expectedCapabilityHash(runnerCapability);
      if (currentCapabilityHash) {
        if (!selectedCapabilityHash) {
          blockers.push(issue('runner_selection_capability_hash_required'));
        } else if (selectedCapabilityHash !== currentCapabilityHash) {
          blockers.push(issue('runner_selection_capability_mismatch'));
        }
      }
    }
  }

  return blockers;
}

function assignmentHashDispatch(dispatch = null) {
  if (!dispatch || typeof dispatch !== 'object') return dispatch || null;
  return {
    ...dispatch,
    action: canonicalActionOrNull(dispatch.action),
    packageRole: Object.hasOwn(dispatch, 'packageRole') ? canonicalPackageRole(dispatch.packageRole) || null : undefined,
  };
}

export function computeAdapterDispatchAssignmentHash(assignment = {}) {
  return digest({
    version: assignment?.version,
    kind: assignment?.kind,
    requestedBy: assignment?.requestedBy,
    status: assignment?.status,
    readyForExternalRunner: assignment?.readyForExternalRunner,
    dispatch: assignmentHashDispatch(assignment?.dispatch),
    runner: assignment?.runner,
    selection: assignment?.selection,
    blockers: assignment?.blockers,
    warnings: assignment?.warnings,
    evidenceRefs: assignment?.evidenceRefs,
    safety: assignment?.safety,
  });
}

export function buildAdapterDispatchAssignment({
  dispatchEnvelope = null,
  runnerCapability = null,
  runnerSelection = null,
  requestedBy = 'design-production-core.adapter-dispatch-assignment',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const blockers = assignmentBlockers({ dispatchEnvelope, runnerCapability, runnerSelection });
  const status = blockers.length
    ? ADAPTER_DISPATCH_ASSIGNMENT_STATUS.BLOCKED
    : ADAPTER_DISPATCH_ASSIGNMENT_STATUS.READY;

  const assignment = {
    version: ADAPTER_DISPATCH_ASSIGNMENT_VERSION,
    kind: 'AdapterDispatchAssignment',
    requestedBy: normalizeText(requestedBy) || 'design-production-core.adapter-dispatch-assignment',
    status,
    readyForExternalRunner: status === ADAPTER_DISPATCH_ASSIGNMENT_STATUS.READY,
    dispatch: {
      dispatchEnvelopeHash: expectedDispatchEnvelopeHash(dispatchEnvelope),
      channelId: dispatchEnvelope?.channelId || null,
      actionId: dispatchEnvelope?.actionId || null,
      action: canonicalActionOrNull(dispatchEnvelope?.action),
      packageRole: canonicalPackageRole(dispatchEnvelope?.payload?.packageRole || '') || null,
      taskKey: dispatchEnvelope?.payload?.taskKey || null,
      externalId: dispatchEnvelope?.payload?.externalId || null,
      requiredHashes: dispatchEnvelope?.runner?.requiredHashes || {},
    },
    runner: {
      runnerId: runnerCapability?.runnerId || null,
      channelId: runnerCapability?.channelId || null,
      runnerLocation: runnerCapability?.runnerLocation || null,
      capabilityHash: expectedCapabilityHash(runnerCapability),
      supportedActionIds: runnerCapability?.supportedActionIds || [],
      mayExecuteExternalAction: runnerCapability?.safety?.runnerMayExecuteExternalAction === true,
    },
    selection: runnerSelection
      ? {
        selectionHash: expectedSelectionHash(runnerSelection),
        registryHash: runnerSelection?.registryHash || null,
        channelId: runnerSelection?.channelId || null,
        actionId: runnerSelection?.actionId || null,
        runnerId: runnerSelection?.runner?.runnerId || null,
        capabilityHash: runnerSelection?.runner?.capabilityHash || null,
      }
      : null,
    blockers,
    warnings: [
      issue('dispatch_assignment_handoff_only', 'Assignments only match a ready envelope to a capable runner; they do not execute.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      dispatchAssignmentOnly: true,
      executesExternalAction: false,
      runnerMayExecuteExternalAction: runnerCapability?.safety?.runnerMayExecuteExternalAction === true,
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
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckChannelState: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const assignmentHash = computeAdapterDispatchAssignmentHash(assignment);

  return {
    ...assignment,
    assignmentHash,
    hash: assignmentHash,
  };
}

export function summarizeAdapterDispatchAssignments(assignments = []) {
  const byStatus = {};
  const byChannel = {};
  const byRunner = {};
  const blockerCodes = {};
  for (const assignment of assignments || []) {
    byStatus[assignment.status] = (byStatus[assignment.status] || 0) + 1;
    byChannel[assignment.dispatch?.channelId || 'unknown'] = (byChannel[assignment.dispatch?.channelId || 'unknown'] || 0) + 1;
    byRunner[assignment.runner?.runnerId || 'unknown'] = (byRunner[assignment.runner?.runnerId || 'unknown'] || 0) + 1;
    for (const blocker of assignment.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_DISPATCH_ASSIGNMENT_VERSION,
    count: assignments.length,
    byStatus,
    byChannel,
    byRunner,
    blockerCodes,
    safety: {
      dispatchAssignmentOnly: true,
      executesExternalAction: assignments.some((assignment) => assignment.safety?.executesExternalAction === true),
      fetchesChannelState: assignments.some((assignment) => assignment.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: assignments.some((assignment) => assignment.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: assignments.some((assignment) => assignment.safety?.grantsExecutionPermission === true),
      readyForExecution: assignments.some((assignment) => assignment.safety?.readyForExecution === true),
    },
  };
}
