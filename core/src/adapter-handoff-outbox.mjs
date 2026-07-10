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
  ACTION_MANIFEST_STATUS,
  computeChannelActionManifestHash,
} from './action-manifest.mjs';
import {
  ADAPTER_RUNNER_STATUS,
  computeAdapterRunPreviewHash,
} from './adapter-runner.mjs';
import {
  EXTERNAL_ACTION_LEDGER_STATUS,
  computeExternalActionLedgerHash,
} from './external-action-ledger.mjs';
import { handoffSnapshotIdentityMismatches } from './handoff-snapshot-identity.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_HANDOFF_OUTBOX_VERSION = 1;

const PROMPT_GENERATION_BINDING_KEYS = Object.freeze([
  'designReferenceRetrievalHash',
  'promptCompilerHash',
  'promptReadinessHash',
  'promptProductionContractHash',
  'generationJobId',
  'generationPromptProductionContractHash',
]);

export const ADAPTER_HANDOFF_OUTBOX_STATUS = Object.freeze({
  QUEUED: 'queued_for_external_adapter',
  BLOCKED: 'blocked_outbox_item',
});

export const ADAPTER_HANDOFF_PRIORITY = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
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

function hashOf(value, key) {
  return normalizeText(value?.[key] || '') || null;
}

function storedHashAliases(value, key) {
  return {
    semanticHash: normalizeText(value?.[key] || '') || null,
    genericHash: normalizeText(value?.hash || '') || null,
  };
}

function hashAliasBlockers(value, key, {
  semanticMissingCode,
  genericMissingCode,
  mismatchCode,
}) {
  const blockers = [];
  const { semanticHash, genericHash } = storedHashAliases(value, key);
  if (!semanticHash) blockers.push(issue(semanticMissingCode));
  if (!genericHash) blockers.push(issue(genericMissingCode));
  if (semanticHash && genericHash && semanticHash !== genericHash) blockers.push(issue(mismatchCode));
  return blockers;
}

function compareRequiredLedgerHash(expected, actual, missingCode, mismatchCode, blockers) {
  const normalizedExpected = normalizeText(expected || '');
  const normalizedActual = normalizeText(actual || '');
  if (!normalizedActual) {
    blockers.push(issue(missingCode));
    return;
  }
  if (normalizedExpected && normalizedExpected !== normalizedActual) blockers.push(issue(mismatchCode));
}

function isPromptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === 'provider_spend' || canonical === 'model_spend';
}

function promptGenerationBindingCandidates({ manifest = null, preview = null } = {}) {
  return [
    manifest?.payload?.promptGenerationBinding,
    preview?.payload?.promptGenerationBinding,
    preview?.adapter?.requiredHashes?.promptGenerationBinding,
  ].filter(Boolean);
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => normalizeText(left[key] || '') === normalizeText(right[key] || ''));
}

function promptGenerationBindingBlockers({ action, manifest = null, preview = null } = {}) {
  const candidates = promptGenerationBindingCandidates({ manifest, preview });
  if (!candidates.length) {
    return isPromptGenerationSpendAction(action) ? [issue('outbox_prompt_generation_binding_required')] : [];
  }
  const blockers = [];
  const expected = candidates[0];
  const missingSources = [
    ['manifest_payload', manifest?.payload?.promptGenerationBinding],
    ['preview_payload', preview?.payload?.promptGenerationBinding],
    ['preview_required_hashes', preview?.adapter?.requiredHashes?.promptGenerationBinding],
  ].filter(([, value]) => !value).map(([source]) => source);
  if (missingSources.length) {
    blockers.push(issue('outbox_prompt_generation_binding_required', missingSources.join(', ')));
  }
  if (!candidates.every((candidate) => samePromptGenerationBinding(candidate, expected))) {
    blockers.push(issue('outbox_prompt_generation_binding_mismatch'));
  }
  const missingKeys = PROMPT_GENERATION_BINDING_KEYS.filter((key) => !normalizeText(expected?.[key] || ''));
  if (missingKeys.length) {
    blockers.push(issue('outbox_prompt_generation_binding_incomplete', missingKeys.join(', ')));
  }
  return blockers;
}

function customerMessageHandoff({ action, manifest = null, preview = null } = {}) {
  return [
    action,
    manifest?.action,
    manifest?.payload?.action,
    preview?.payload?.action,
  ].some((value) => canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function humanFeedbackValue(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function sourceHashValues({ manifest = null, preview = null } = {}, key) {
  return [
    ['manifest_payload', manifest?.payload?.[key]],
    ['preview_payload', preview?.payload?.[key]],
    ['preview_required_hashes', preview?.adapter?.requiredHashes?.[key]],
  ];
}

function hasSourceHashValue(input = {}, key) {
  return sourceHashValues(input, key).some(([, value]) => normalizeText(value || ''));
}

function humanFeedbackActionHandoff({ action, manifest = null, preview = null } = {}) {
  const productValues = [
    manifest?.productLineId,
    manifest?.workflowId,
    manifest?.payload?.productLineId,
    manifest?.payload?.workflowId,
    manifest?.payload?.packageRole,
    manifest?.payload?.reviewType,
    manifest?.payload?.role,
    preview?.payload?.productLineId,
    preview?.payload?.workflowId,
    preview?.payload?.packageRole,
    preview?.payload?.reviewType,
    preview?.payload?.role,
  ];
  const actionValues = [
    action,
    manifest?.action,
    manifest?.payload?.action,
    preview?.payload?.action,
  ];
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && (
      productValues.some((value) => humanFeedbackValue(value))
      || actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || hasSourceHashValue({ manifest, preview }, 'humanFeedbackRevisionContractHash')
    );
}

function requiredSourceHashBlockers(input, key, {
  required,
  requiredCode,
  mismatchCode,
}) {
  const values = sourceHashValues(input, key);
  const present = values.map(([, value]) => normalizeText(value || '') || null).filter(Boolean);
  if (!required && !present.length) return [];
  const blockers = [];
  const missingSources = values
    .filter(([, value]) => !normalizeText(value || ''))
    .map(([source]) => source);
  if (missingSources.length) blockers.push(issue(requiredCode, missingSources.join(', ')));
  if (present.length && present.some((value) => value !== present[0])) blockers.push(issue(mismatchCode));
  return blockers;
}

function messagePreviewHashBlockers({ action, manifest = null, preview = null } = {}) {
  return requiredSourceHashBlockers({ manifest, preview }, 'messagePreviewHash', {
    required: customerMessageHandoff({ action, manifest, preview }),
    requiredCode: 'outbox_message_preview_hash_required',
    mismatchCode: 'outbox_message_preview_hash_mismatch',
  });
}

function humanFeedbackContractHashBlockers({ action, manifest = null, preview = null } = {}) {
  return requiredSourceHashBlockers({ manifest, preview }, 'humanFeedbackRevisionContractHash', {
    required: humanFeedbackActionHandoff({ action, manifest, preview }),
    requiredCode: 'outbox_human_feedback_contract_hash_required',
    mismatchCode: 'outbox_human_feedback_contract_hash_mismatch',
  });
}

function approvalProvenanceHashBlockers({ action, manifest = null, preview = null } = {}) {
  return requiredSourceHashBlockers({ manifest, preview }, 'approvalProvenanceHash', {
    required: Boolean(canonicalActionOrNull(action) && canonicalActionOrNull(action) !== EXTERNAL_ACTIONS.NONE),
    requiredCode: 'outbox_approval_provenance_hash_required',
    mismatchCode: 'outbox_approval_provenance_hash_mismatch',
  });
}

function handoffIdentityForSnapshots({ manifest = null, preview = null } = {}) {
  return {
    channelId: manifest?.channelId || preview?.adapter?.channelId || null,
    actionId: manifest?.adapter?.actionId || preview?.adapter?.actionId || null,
    action: manifest?.action || manifest?.payload?.action || preview?.payload?.action || null,
    taskKey: manifest?.taskKey || preview?.payload?.taskKey || null,
    externalId: manifest?.payload?.externalId || preview?.payload?.externalId || null,
    productLineId: manifest?.productLineId || manifest?.payload?.productLineId || preview?.payload?.productLineId || null,
    workflowId: manifest?.workflowId || manifest?.payload?.workflowId || preview?.payload?.workflowId || null,
    packageRole: manifest?.payload?.packageRole || preview?.payload?.packageRole || null,
  };
}

function handoffSnapshotIdentityBlockers({ manifest = null, preview = null } = {}) {
  const mismatches = handoffSnapshotIdentityMismatches({
    handoff: handoffIdentityForSnapshots({ manifest, preview }),
    snapshots: { manifest, preview },
  });
  return mismatches.length
    ? [issue('outbox_handoff_snapshot_identity_mismatch', mismatches.slice(0, 8).join('; '))]
    : [];
}

function priorityOf(value) {
  const normalized = normalizeText(value || ADAPTER_HANDOFF_PRIORITY.NORMAL);
  return Object.values(ADAPTER_HANDOFF_PRIORITY).includes(normalized) ? normalized : ADAPTER_HANDOFF_PRIORITY.NORMAL;
}

function hashPayload(payload = null) {
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

function artifactNames(manifest, preview) {
  return uniqueStrings([
    ...(manifest?.payload?.artifactNames || []),
    ...(preview?.payload?.artifactNames || []),
  ], 128);
}

export function computeAdapterHandoffOutboxHash(outboxItem) {
  if (!outboxItem) return null;
  return digest({
    version: outboxItem.version,
    kind: outboxItem.kind,
    requestedBy: outboxItem.requestedBy,
    status: outboxItem.status,
    queued: outboxItem.queued,
    priority: outboxItem.priority,
    channelId: outboxItem.channelId,
    actionId: outboxItem.actionId,
    action: canonicalActionOrNull(outboxItem.action),
    payload: hashPayload(outboxItem.payload),
    runner: outboxItem.runner,
    blockers: outboxItem.blockers,
    warnings: outboxItem.warnings,
    evidenceRefs: outboxItem.evidenceRefs,
    safety: outboxItem.safety,
  });
}

function outboxBlockers({ manifest, preview, ledgerEntry, execute }) {
  const blockers = [];
  const action = canonicalActionOrNull(manifest?.action || preview?.payload?.action);
  if (manifest?.kind !== 'ChannelActionManifest') blockers.push(issue('invalid_manifest_kind'));
  if (manifest && (manifest.status !== ACTION_MANIFEST_STATUS.READY || manifest.readyForAdapter !== true)) {
    blockers.push(issue('manifest_not_ready'));
  }
  if (preview?.kind !== 'AdapterRunPreview') blockers.push(issue('invalid_preview_kind'));
  if (preview && (preview.status !== ADAPTER_RUNNER_STATUS.DRY_RUN_READY || preview.readyForDryRun !== true)) {
    blockers.push(issue('preview_not_ready'));
  }
  if (preview?.readyForExecution === true) blockers.push(issue('unsafe_preview_claims_execution_ready'));
  if (execute === true) blockers.push(issue('execute_not_allowed_in_core_outbox'));

  const actionId = normalizeText(manifest?.adapter?.actionId || preview?.adapter?.actionId || '');
  if (!actionId) blockers.push(issue('adapter_action_missing'));
  if (!normalizeText(manifest?.payload?.approvalHash || preview?.payload?.approvalHash || '')) blockers.push(issue('approval_hash_missing'));
  if (!normalizeText(manifest?.payload?.evidenceHash || preview?.payload?.evidenceHash || '')) blockers.push(issue('evidence_hash_missing'));

  const manifestHash = hashOf(manifest, 'manifestHash');
  const previewManifestHash = preview?.payload?.manifestHash || preview?.adapter?.requiredHashes?.manifestHash || null;
  const previewHash = hashOf(preview, 'previewHash');
  if (manifest?.kind === 'ChannelActionManifest') {
    blockers.push(...hashAliasBlockers(manifest, 'manifestHash', {
      semanticMissingCode: 'manifest_hash_alias_required',
      genericMissingCode: 'manifest_generic_hash_required',
      mismatchCode: 'manifest_hash_alias_mismatch',
    }));
  }
  if (preview?.kind === 'AdapterRunPreview') {
    blockers.push(...hashAliasBlockers(preview, 'previewHash', {
      semanticMissingCode: 'preview_hash_alias_required',
      genericMissingCode: 'preview_generic_hash_required',
      mismatchCode: 'preview_hash_alias_mismatch',
    }));
  }
  if (!manifestHash) blockers.push(issue('manifest_hash_missing'));
  if (!previewHash) blockers.push(issue('preview_hash_missing'));
  if (manifestHash && manifestHash !== computeChannelActionManifestHash(manifest)) {
    blockers.push(issue('manifest_hash_content_mismatch'));
  }
  if (previewHash && previewHash !== computeAdapterRunPreviewHash(preview)) {
    blockers.push(issue('preview_hash_content_mismatch'));
  }
  if (manifestHash && previewManifestHash && manifestHash !== previewManifestHash) blockers.push(issue('preview_manifest_hash_mismatch'));
  blockers.push(...handoffSnapshotIdentityBlockers({ manifest, preview }));
  blockers.push(...approvalProvenanceHashBlockers({ action, manifest, preview }));
  blockers.push(...messagePreviewHashBlockers({ action, manifest, preview }));
  blockers.push(...humanFeedbackContractHashBlockers({ action, manifest, preview }));
  blockers.push(...promptGenerationBindingBlockers({ action, manifest, preview }));

  if (ledgerEntry) {
    if (ledgerEntry.kind !== 'ExternalActionLedgerEntry') blockers.push(issue('invalid_ledger_kind'));
    if (ledgerEntry.status !== EXTERNAL_ACTION_LEDGER_STATUS.PENDING_RUNNER_RECEIPT) {
      blockers.push(issue('ledger_not_pending_runner_receipt'));
    }
    blockers.push(...hashAliasBlockers(ledgerEntry, 'ledgerHash', {
      semanticMissingCode: 'ledger_hash_alias_required',
      genericMissingCode: 'ledger_generic_hash_required',
      mismatchCode: 'ledger_hash_alias_mismatch',
    }));
    const ledgerHash = hashOf(ledgerEntry, 'ledgerHash');
    const expectedLedgerHash = computeExternalActionLedgerHash(ledgerEntry);
    if (!ledgerHash) blockers.push(issue('ledger_hash_required'));
    if (ledgerHash && expectedLedgerHash && ledgerHash !== expectedLedgerHash) {
      blockers.push(issue('ledger_hash_content_mismatch'));
    }
    compareRequiredLedgerHash(
      manifestHash,
      ledgerEntry.chain?.manifestHash,
      'ledger_manifest_hash_missing',
      'ledger_manifest_hash_mismatch',
      blockers,
    );
    compareRequiredLedgerHash(
      previewHash,
      ledgerEntry.chain?.previewHash,
      'ledger_preview_hash_missing',
      'ledger_preview_hash_mismatch',
      blockers,
    );
  }

  return blockers;
}

export function buildAdapterHandoffOutboxItem({
  manifest = null,
  preview = null,
  ledgerEntry = null,
  priority = ADAPTER_HANDOFF_PRIORITY.NORMAL,
  execute = false,
  requestedBy = 'design-production-core.adapter-handoff-outbox',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const blockers = outboxBlockers({ manifest, preview, ledgerEntry, execute });
  const names = artifactNames(manifest, preview);
  const action = canonicalActionOrNull(manifest?.action || preview?.payload?.action);
  const productLineId = canonicalProductLineOrNull(manifest?.productLineId || preview?.payload?.productLineId);
  const workflowId = canonicalProductLineOrNull(manifest?.workflowId || preview?.payload?.workflowId);
  const promptGenerationBinding = manifest?.payload?.promptGenerationBinding
    || preview?.payload?.promptGenerationBinding
    || null;
  const item = {
    version: ADAPTER_HANDOFF_OUTBOX_VERSION,
    kind: 'AdapterHandoffOutboxItem',
    requestedBy: normalizeText(requestedBy || 'design-production-core.adapter-handoff-outbox'),
    status: blockers.length ? ADAPTER_HANDOFF_OUTBOX_STATUS.BLOCKED : ADAPTER_HANDOFF_OUTBOX_STATUS.QUEUED,
    queued: blockers.length === 0,
    priority: priorityOf(priority),
    channelId: manifest?.channelId || preview?.adapter?.channelId || null,
    actionId: manifest?.adapter?.actionId || preview?.adapter?.actionId || null,
    action,
    payload: {
      taskKey: manifest?.taskKey || preview?.payload?.taskKey || null,
      externalId: manifest?.payload?.externalId || preview?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole: canonicalPackageRole(manifest?.payload?.packageRole || preview?.payload?.packageRole || '') || null,
      humanFeedbackRevisionContractHash: manifest?.payload?.humanFeedbackRevisionContractHash
        || preview?.payload?.humanFeedbackRevisionContractHash
        || null,
      approvalProvenanceHash: normalizeText(
        manifest?.payload?.approvalProvenanceHash
          || preview?.payload?.approvalProvenanceHash
          || '',
      ) || null,
      ...(promptGenerationBinding
        ? { promptGenerationBinding }
        : {}),
      messagePreview: manifest?.payload?.messagePreview || preview?.payload?.messagePreview || null,
      messagePreviewHash: manifest?.payload?.messagePreviewHash || preview?.payload?.messagePreviewHash || null,
      artifactNames: names,
      artifactCount: names.length,
    },
    runner: {
      commandPreview: preview?.adapter?.commandPreview || null,
      requiredFlags: uniqueStrings(preview?.adapter?.requiredFlags || [], 32),
      requiredHashes: {
        manifestHash: hashOf(manifest, 'manifestHash'),
        previewHash: hashOf(preview, 'previewHash'),
        approvalHash: normalizeText(preview?.payload?.approvalHash || manifest?.payload?.approvalHash || '') || null,
        evidenceHash: normalizeText(preview?.payload?.evidenceHash || manifest?.payload?.evidenceHash || '') || null,
        approvalProvenanceHash: normalizeText(
          preview?.payload?.approvalProvenanceHash
            || manifest?.payload?.approvalProvenanceHash
            || '',
        ) || null,
        humanFeedbackRevisionContractHash: normalizeText(
          preview?.payload?.humanFeedbackRevisionContractHash
            || manifest?.payload?.humanFeedbackRevisionContractHash
            || '',
        ) || null,
        messagePreviewHash: normalizeText(
          preview?.payload?.messagePreviewHash
            || manifest?.payload?.messagePreviewHash
            || '',
        ) || null,
        promptGenerationBinding,
        ledgerHash: hashOf(ledgerEntry, 'ledgerHash'),
      },
      handoffSnapshots: {
        manifest: manifest || null,
        preview: preview || null,
      },
    },
    blockers,
    warnings: [
      issue('outbox_handoff_only', 'Core outbox items never execute adapter commands.', 'warning'),
      ...(ledgerEntry ? [] : [issue('ledger_entry_recommended', 'Attach a pending runner ledger entry before dispatch.', 'warning')]),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      outboxOnly: true,
      executesExternalAction: false,
      readyForExecution: false,
      requiresExternalAdapter: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckChannelState: true,
      externalRunnerMustAppendReceipt: true,
      currentChatApprovalStillRequired: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const outboxHash = computeAdapterHandoffOutboxHash(item);
  return {
    ...item,
    outboxHash,
    hash: outboxHash,
  };
}

export function summarizeAdapterHandoffOutbox(items = []) {
  const byStatus = {};
  const byPriority = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  for (const item of items || []) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    byPriority[item.priority] = (byPriority[item.priority] || 0) + 1;
    const channelId = item.channelId || 'unknown';
    byChannel[channelId] = (byChannel[channelId] || 0) + 1;
    const actionId = item.actionId || 'unknown';
    byActionId[actionId] = (byActionId[actionId] || 0) + 1;
    for (const blocker of item.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_HANDOFF_OUTBOX_VERSION,
    count: items.length,
    byStatus,
    byPriority,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      outboxOnly: true,
      executesExternalAction: items.some((item) => item.safety?.executesExternalAction === true),
      readyForExecution: items.some((item) => item.safety?.readyForExecution === true),
    },
  };
}
