import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import {
  ADAPTER_HANDOFF_OUTBOX_STATUS,
  computeAdapterHandoffOutboxHash,
} from './adapter-handoff-outbox.mjs';
import {
  EXTERNAL_ACTION_REPLAY_GUARD_STATUS,
  computeExternalActionReplayGuardHash,
} from './external-action-replay-guard.mjs';
import { handoffSnapshotIdentityMismatches } from './handoff-snapshot-identity.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_DISPATCH_ENVELOPE_VERSION = 1;

export const ADAPTER_DISPATCH_ENVELOPE_STATUS = Object.freeze({
  READY: 'ready_adapter_dispatch_envelope',
  BLOCKED: 'blocked_adapter_dispatch_envelope',
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

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = uniqueStrings([...Object.keys(left), ...Object.keys(right)], 32);
  return keys.every((key) => text(left[key]) === text(right[key]));
}

function isPromptGenerationSpendAction(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function isPromptGenerationSpendOutbox(outboxItem = {}) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  return [
    outboxItem?.action,
    outboxItem?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => isPromptGenerationSpendAction(value));
}

function isCustomerMessageOutbox(outboxItem = {}) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  return [
    outboxItem?.action,
    outboxItem?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function isHumanFeedbackValue(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function isHumanFeedbackOutbox(outboxItem = {}) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  const productValues = [
    outboxItem?.payload?.productLineId,
    outboxItem?.payload?.workflowId,
    outboxItem?.payload?.packageRole,
    snapshots.manifest?.productLineId,
    snapshots.manifest?.workflowId,
    snapshots.manifest?.payload?.productLineId,
    snapshots.manifest?.payload?.workflowId,
    snapshots.manifest?.payload?.packageRole,
    snapshots.manifest?.payload?.reviewType,
    snapshots.manifest?.payload?.role,
    snapshots.preview?.payload?.productLineId,
    snapshots.preview?.payload?.workflowId,
    snapshots.preview?.payload?.packageRole,
    snapshots.preview?.payload?.reviewType,
    snapshots.preview?.payload?.role,
  ];
  const actionValues = [
    outboxItem?.action,
    outboxItem?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ];
  return productValues.some((value) => isHumanFeedbackValue(value))
    || actionValues.some((value) => isHumanFeedbackMessageActionAlias(value));
}

function boundHashValues(outboxItem = {}, key) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  return [
    ['payload', outboxItem?.payload?.[key]],
    ['runner_required_hashes', outboxItem?.runner?.requiredHashes?.[key]],
    ['manifest_payload', snapshots.manifest?.payload?.[key]],
    ['preview_payload', snapshots.preview?.payload?.[key]],
    ['preview_required_hashes', snapshots.preview?.adapter?.requiredHashes?.[key]],
  ];
}

function hasBoundHashValue(outboxItem = {}, key) {
  return boundHashValues(outboxItem, key).some(([, value]) => text(value));
}

function isHumanFeedbackActionOutbox(outboxItem = {}) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  const actionValues = [
    outboxItem?.action,
    outboxItem?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ];
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && (
      isHumanFeedbackOutbox(outboxItem)
      || hasBoundHashValue(outboxItem, 'humanFeedbackRevisionContractHash')
    );
}

function requiredBoundHashBlockers(outboxItem, key, {
  required,
  requiredCode,
  mismatchCode,
}) {
  const values = boundHashValues(outboxItem, key);
  const present = values.map(([, value]) => text(value)).filter(Boolean);
  if (!required && !present.length) return [];
  const blockers = [];
  const missingSources = values.filter(([, value]) => !text(value)).map(([source]) => source);
  if (missingSources.length) blockers.push(issue(requiredCode, missingSources.join(', ')));
  if (present.length && present.some((value) => value !== present[0])) blockers.push(issue(mismatchCode));
  return blockers;
}

function messagePreviewHashBlockers(outboxItem = {}) {
  return requiredBoundHashBlockers(outboxItem, 'messagePreviewHash', {
    required: isCustomerMessageOutbox(outboxItem),
    requiredCode: 'outbox_message_preview_hash_required',
    mismatchCode: 'outbox_message_preview_hash_mismatch',
  });
}

function humanFeedbackContractHashBlockers(outboxItem = {}) {
  return requiredBoundHashBlockers(outboxItem, 'humanFeedbackRevisionContractHash', {
    required: isHumanFeedbackActionOutbox(outboxItem),
    requiredCode: 'outbox_human_feedback_contract_hash_required',
    mismatchCode: 'outbox_human_feedback_contract_hash_mismatch',
  });
}

function approvalProvenanceHashBlockers(outboxItem = {}) {
  const action = canonicalExternalAction(outboxItem?.action || outboxItem?.payload?.action || EXTERNAL_ACTIONS.NONE);
  return requiredBoundHashBlockers(outboxItem, 'approvalProvenanceHash', {
    required: action !== EXTERNAL_ACTIONS.NONE,
    requiredCode: 'outbox_approval_provenance_hash_required',
    mismatchCode: 'outbox_approval_provenance_hash_mismatch',
  });
}

function promptGenerationBindingValues(outboxItem = {}) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  return [
    outboxItem?.payload?.promptGenerationBinding,
    outboxItem?.runner?.requiredHashes?.promptGenerationBinding,
    snapshots.manifest?.payload?.promptGenerationBinding,
    snapshots.preview?.payload?.promptGenerationBinding,
    snapshots.preview?.adapter?.requiredHashes?.promptGenerationBinding,
  ];
}

function promptGenerationBindingBlockers(outboxItem = {}) {
  if (!isPromptGenerationSpendOutbox(outboxItem)) return [];
  const values = promptGenerationBindingValues(outboxItem);
  const present = values.filter(Boolean);
  if (!present.length || present.length !== values.length) {
    return [issue('outbox_prompt_generation_binding_required')];
  }
  if (!present.every((value) => samePromptGenerationBinding(value, present[0]))) {
    return [issue('outbox_prompt_generation_binding_mismatch')];
  }
  const missingKeys = PROMPT_GENERATION_BINDING_KEYS.filter((key) => !text(present[0]?.[key]));
  if (missingKeys.length) {
    return [issue('outbox_prompt_generation_binding_incomplete', missingKeys.join(', '))];
  }
  return [];
}

function handoffIdentityForOutbox(outboxItem = {}) {
  const payload = outboxItem?.payload || {};
  return {
    channelId: outboxItem?.channelId || null,
    actionId: outboxItem?.actionId || null,
    action: outboxItem?.action || payload.action || null,
    taskKey: payload.taskKey || null,
    externalId: payload.externalId || null,
    productLineId: payload.productLineId || null,
    workflowId: payload.workflowId || null,
    packageRole: payload.packageRole || null,
  };
}

function outboxHandoffSnapshotIdentityBlockers(outboxItem = {}) {
  const mismatches = handoffSnapshotIdentityMismatches({
    handoff: handoffIdentityForOutbox(outboxItem),
    snapshots: outboxItem?.runner?.handoffSnapshots || {},
  });
  return mismatches.length
    ? [issue('outbox_handoff_snapshot_identity_mismatch', mismatches.slice(0, 8).join('; '))]
    : [];
}

function canonicalHashPayload(payload = null) {
  if (!payload) return payload;
  const out = {
    ...payload,
    productLineId: canonicalProductLineOrNull(payload.productLineId),
    workflowId: canonicalProductLineOrNull(payload.workflowId),
  };
  for (const key of ['packageRole', 'reviewType', 'role']) {
    if (Object.hasOwn(out, key)) out[key] = canonicalPackageRole(out[key]) || null;
  }
  return out;
}

function expectedOutboxHash(outboxItem) {
  return computeAdapterHandoffOutboxHash(outboxItem);
}

function requireOutboxRunnerHash(outboxItem, key, code, blockers) {
  if (!text(outboxItem?.runner?.requiredHashes?.[key])) blockers.push(issue(code));
}

function identityMatches(outboxItem, replayGuardDecision) {
  const candidate = replayGuardDecision?.candidate || {};
  const taskKey = text(outboxItem?.payload?.taskKey);
  const externalId = text(outboxItem?.payload?.externalId);
  const taskMatches = !taskKey || text(candidate.taskKey) === taskKey;
  const externalMatches = !externalId || text(candidate.externalId) === externalId;
  const candidateAction = canonicalExternalAction(candidate.action);
  const outboxAction = canonicalExternalAction(outboxItem?.action);
  const actionId = text(outboxItem?.actionId);
  const actionMatches = (!actionId || text(candidate.actionId) === actionId)
    && (!outboxAction || candidateAction === outboxAction);
  const candidateProductLine = canonicalProductLineId(candidate.productLineId);
  const outboxProductLine = canonicalProductLineId(outboxItem?.payload?.productLineId);
  const productLineMatches = !outboxProductLine || candidateProductLine === outboxProductLine;
  const candidateWorkflow = canonicalProductLineId(candidate.workflowId);
  const outboxWorkflow = canonicalProductLineId(outboxItem?.payload?.workflowId);
  const workflowMatches = !outboxWorkflow || candidateWorkflow === outboxWorkflow;
  const candidatePackageRole = canonicalPackageRole(candidate.packageRole || '');
  const outboxPackageRole = canonicalPackageRole(outboxItem?.payload?.packageRole || '');
  const packageRoleMatches = !outboxPackageRole || candidatePackageRole === outboxPackageRole;
  const outboxHash = text(outboxItem?.outboxHash);
  const outboxHashMatches = !outboxHash || text(candidate.outboxHash) === outboxHash;
  const messagePreviewHash = text(outboxItem?.payload?.messagePreviewHash || outboxItem?.runner?.requiredHashes?.messagePreviewHash);
  const messagePreviewHashMatches = !messagePreviewHash || text(candidate.messagePreviewHash) === messagePreviewHash;
  const promptGenerationBinding = outboxItem?.payload?.promptGenerationBinding || outboxItem?.runner?.requiredHashes?.promptGenerationBinding || null;
  const promptGenerationBindingMatches = !promptGenerationBinding
    || samePromptGenerationBinding(candidate.promptGenerationBinding || null, promptGenerationBinding);
  const contractHash = text(
    outboxItem?.payload?.humanFeedbackRevisionContractHash
      || outboxItem?.runner?.requiredHashes?.humanFeedbackRevisionContractHash,
  );
  const contractHashMatches = !contractHash
    || text(candidate.humanFeedbackRevisionContractHash) === contractHash;
  return taskMatches
    && externalMatches
    && actionMatches
    && productLineMatches
    && workflowMatches
    && packageRoleMatches
    && outboxHashMatches
    && messagePreviewHashMatches
    && promptGenerationBindingMatches
    && contractHashMatches;
}

function envelopeBlockers({ outboxItem, replayGuardDecision }) {
  const blockers = [];

  if (!outboxItem || outboxItem.kind !== 'AdapterHandoffOutboxItem') {
    blockers.push(issue('invalid_outbox_item'));
  } else {
    const outboxAliasHash = text(outboxItem.outboxHash);
    const outboxGenericHash = text(outboxItem.hash);
    const outboxHash = outboxAliasHash || outboxGenericHash;
    const expectedHash = expectedOutboxHash(outboxItem);
    if (!outboxHash) blockers.push(issue('outbox_hash_required'));
    if (!outboxAliasHash) blockers.push(issue('outbox_hash_alias_required'));
    if (!outboxGenericHash) blockers.push(issue('outbox_generic_hash_required'));
    if (outboxAliasHash && outboxGenericHash && outboxAliasHash !== outboxGenericHash) {
      blockers.push(issue('outbox_hash_alias_mismatch'));
    }
    if (outboxHash && expectedHash && outboxHash !== expectedHash) blockers.push(issue('outbox_hash_content_mismatch'));
    if (outboxItem.status !== ADAPTER_HANDOFF_OUTBOX_STATUS.QUEUED || outboxItem.queued !== true) {
      blockers.push(issue('outbox_not_queued'));
    }
    if (outboxItem.safety?.executesExternalAction === true) blockers.push(issue('outbox_claims_external_execution'));
    if (outboxItem.safety?.readyForExecution === true) blockers.push(issue('outbox_claims_execution_ready'));
    requireOutboxRunnerHash(outboxItem, 'manifestHash', 'outbox_manifest_hash_missing', blockers);
    requireOutboxRunnerHash(outboxItem, 'previewHash', 'outbox_preview_hash_missing', blockers);
    requireOutboxRunnerHash(outboxItem, 'approvalHash', 'outbox_approval_hash_missing', blockers);
    requireOutboxRunnerHash(outboxItem, 'evidenceHash', 'outbox_evidence_hash_missing', blockers);
    requireOutboxRunnerHash(outboxItem, 'approvalProvenanceHash', 'outbox_approval_provenance_hash_missing', blockers);
    blockers.push(...outboxHandoffSnapshotIdentityBlockers(outboxItem));
    blockers.push(...approvalProvenanceHashBlockers(outboxItem));
    blockers.push(...messagePreviewHashBlockers(outboxItem));
    blockers.push(...humanFeedbackContractHashBlockers(outboxItem));
    blockers.push(...promptGenerationBindingBlockers(outboxItem));
  }

  if (!replayGuardDecision || replayGuardDecision.kind !== 'ExternalActionReplayGuardDecision') {
    blockers.push(issue('replay_guard_required'));
  } else {
    const replayGuardAliasHash = text(replayGuardDecision.replayGuardHash);
    const replayGuardGenericHash = text(replayGuardDecision.hash);
    const replayGuardHash = replayGuardAliasHash || replayGuardGenericHash;
    const expectedHash = computeExternalActionReplayGuardHash(replayGuardDecision);
    if (!replayGuardHash) blockers.push(issue('replay_guard_hash_required'));
    if (!replayGuardAliasHash) blockers.push(issue('replay_guard_hash_alias_required'));
    if (!replayGuardGenericHash) blockers.push(issue('replay_guard_generic_hash_required'));
    if (replayGuardAliasHash && replayGuardGenericHash && replayGuardAliasHash !== replayGuardGenericHash) {
      blockers.push(issue('replay_guard_hash_alias_mismatch'));
    }
    if (replayGuardHash && expectedHash && replayGuardHash !== expectedHash) blockers.push(issue('replay_guard_hash_content_mismatch'));
    if (replayGuardDecision.status !== EXTERNAL_ACTION_REPLAY_GUARD_STATUS.CLEAR || replayGuardDecision.clear !== true) {
      blockers.push(issue('replay_guard_not_clear'));
    }
    if (outboxItem && !identityMatches(outboxItem, replayGuardDecision)) {
      blockers.push(issue('replay_guard_candidate_mismatch'));
    }
    if (replayGuardDecision.safety?.executesExternalAction === true) blockers.push(issue('replay_guard_claims_external_execution'));
    if (replayGuardDecision.safety?.grantsExecutionPermission === true) blockers.push(issue('replay_guard_claims_permission'));
  }

  return blockers;
}

export function buildAdapterDispatchEnvelope({
  outboxItem = null,
  replayGuardDecision = null,
  dispatchRole = 'external_runner_handoff',
  requestedBy = 'design-production-core.adapter-dispatch-envelope',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const blockers = envelopeBlockers({ outboxItem, replayGuardDecision });
  const status = blockers.length
    ? ADAPTER_DISPATCH_ENVELOPE_STATUS.BLOCKED
    : ADAPTER_DISPATCH_ENVELOPE_STATUS.READY;
  const action = canonicalActionOrNull(outboxItem?.action);
  const productLineId = canonicalProductLineOrNull(outboxItem?.payload?.productLineId);
  const workflowId = canonicalProductLineOrNull(outboxItem?.payload?.workflowId);
  const promptGenerationBinding = outboxItem?.payload?.promptGenerationBinding
    || outboxItem?.runner?.requiredHashes?.promptGenerationBinding
    || null;
  const envelope = {
    version: ADAPTER_DISPATCH_ENVELOPE_VERSION,
    kind: 'AdapterDispatchEnvelope',
    requestedBy: normalizeText(requestedBy) || 'design-production-core.adapter-dispatch-envelope',
    status,
    readyForExternalRunner: status === ADAPTER_DISPATCH_ENVELOPE_STATUS.READY,
    dispatchRole: normalizeText(dispatchRole) || 'external_runner_handoff',
    channelId: outboxItem?.channelId || null,
    actionId: outboxItem?.actionId || null,
    action,
    payload: {
      taskKey: outboxItem?.payload?.taskKey || null,
      externalId: outboxItem?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole: canonicalPackageRole(outboxItem?.payload?.packageRole || '') || null,
      approvalProvenanceHash: outboxItem?.payload?.approvalProvenanceHash
        || outboxItem?.runner?.requiredHashes?.approvalProvenanceHash
        || null,
      humanFeedbackRevisionContractHash: outboxItem?.payload?.humanFeedbackRevisionContractHash || null,
      ...(promptGenerationBinding
        ? { promptGenerationBinding }
        : {}),
      messagePreview: outboxItem?.payload?.messagePreview || null,
      messagePreviewHash: outboxItem?.payload?.messagePreviewHash || null,
      artifactNames: uniqueStrings(outboxItem?.payload?.artifactNames || [], 128),
      artifactCount: outboxItem?.payload?.artifactCount || 0,
    },
    runner: {
      commandPreview: outboxItem?.runner?.commandPreview || null,
      requiredFlags: uniqueStrings(outboxItem?.runner?.requiredFlags || [], 32),
      requiredHashes: {
        outboxHash: text(outboxItem?.outboxHash),
        replayGuardHash: text(replayGuardDecision?.replayGuardHash),
        archiveHash: text(replayGuardDecision?.archiveHash),
        manifestHash: text(outboxItem?.runner?.requiredHashes?.manifestHash),
        previewHash: text(outboxItem?.runner?.requiredHashes?.previewHash),
        approvalHash: text(outboxItem?.runner?.requiredHashes?.approvalHash),
        evidenceHash: text(outboxItem?.runner?.requiredHashes?.evidenceHash),
        approvalProvenanceHash: text(outboxItem?.runner?.requiredHashes?.approvalProvenanceHash),
        humanFeedbackRevisionContractHash: text(outboxItem?.runner?.requiredHashes?.humanFeedbackRevisionContractHash),
        messagePreviewHash: text(outboxItem?.runner?.requiredHashes?.messagePreviewHash),
        promptGenerationBinding,
        ledgerHash: text(outboxItem?.runner?.requiredHashes?.ledgerHash),
      },
      handoffSnapshots: outboxItem?.runner?.handoffSnapshots || null,
    },
    blockers,
    warnings: [
      issue('dispatch_envelope_handoff_only', 'Core dispatch envelopes do not execute adapter commands.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      dispatchEnvelopeOnly: true,
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
      readyForExternalRunner: status === ADAPTER_DISPATCH_ENVELOPE_STATUS.READY,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustAppendReceipt: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const dispatchEnvelopeHash = computeAdapterDispatchEnvelopeHash(envelope);

  return {
    ...envelope,
    dispatchEnvelopeHash,
    hash: dispatchEnvelopeHash,
  };
}

export function computeAdapterDispatchEnvelopeHash(envelope = null) {
  return digest({
    version: envelope?.version,
    kind: envelope?.kind,
    requestedBy: envelope?.requestedBy,
    status: envelope?.status,
    readyForExternalRunner: envelope?.readyForExternalRunner,
    dispatchRole: envelope?.dispatchRole,
    channelId: envelope?.channelId,
    actionId: envelope?.actionId,
    action: canonicalActionOrNull(envelope?.action),
    payload: canonicalHashPayload(envelope?.payload),
    runner: envelope?.runner,
    blockers: envelope?.blockers,
    warnings: envelope?.warnings,
    evidenceRefs: envelope?.evidenceRefs,
    safety: envelope?.safety,
  });
}

export function summarizeAdapterDispatchEnvelopes(envelopes = []) {
  const byStatus = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  for (const envelope of envelopes || []) {
    byStatus[envelope.status] = (byStatus[envelope.status] || 0) + 1;
    byChannel[envelope.channelId || 'unknown'] = (byChannel[envelope.channelId || 'unknown'] || 0) + 1;
    byActionId[envelope.actionId || 'unknown'] = (byActionId[envelope.actionId || 'unknown'] || 0) + 1;
    for (const blocker of envelope.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_DISPATCH_ENVELOPE_VERSION,
    count: envelopes.length,
    byStatus,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      dispatchEnvelopeOnly: true,
      executesExternalAction: envelopes.some((envelope) => envelope.safety?.executesExternalAction === true),
      readyForExecution: envelopes.some((envelope) => envelope.safety?.readyForExecution === true),
      grantsExecutionPermission: envelopes.some((envelope) => envelope.safety?.grantsExecutionPermission === true),
    },
  };
}
