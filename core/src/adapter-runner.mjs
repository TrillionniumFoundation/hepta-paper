import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalPackageRole,
  canonicalExternalAction,
  canonicalExternalActionOrNull,
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  computeCustomerMessagePreviewHash,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import {
  ACTION_MANIFEST_STATUS,
  computeChannelActionManifestHash,
} from './action-manifest.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_RUNNER_VERSION = 1;

export const ADAPTER_RUNNER_STATUS = Object.freeze({
  DRY_RUN_READY: 'dry_run_ready',
  BLOCKED: 'blocked_run',
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

function shellQuote(value) {
  const text = normalizeText(value);
  if (!text) return "''";
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function displayCommand(parts = []) {
  return parts.map(shellQuote).join(' ');
}

function taskRef(manifest) {
  return normalizeText(manifest?.payload?.externalId || manifest?.taskKey || '');
}

function hashFlags(manifest) {
  return [
    '--approval-hash',
    manifest?.payload?.approvalHash,
    '--evidence-hash',
    manifest?.payload?.evidenceHash,
  ].filter((part) => part !== null && part !== undefined && part !== '');
}

function channelActionPreview(manifest) {
  const actionId = normalizeText(manifest?.adapter?.actionId || '');
  const ref = taskRef(manifest);
  const hashes = hashFlags(manifest);
  const artifactArgs = (manifest?.payload?.artifactNames || [])
    .slice(0, 12)
    .flatMap((name) => ['--artifact', name]);
  return {
    command: [
      'adapter-runner',
      'handoff',
      '--action-id',
      actionId || 'unknown',
      '--dry-run',
      '--task',
      ref,
      ...hashes,
      ...artifactArgs,
    ],
    requiredFlags: ['--action-id', '--dry-run', '--task', '--approval-hash', '--evidence-hash'],
    commandOwner: 'external_channel_adapter',
  };
}

function manifestStoredHashes(manifest) {
  const manifestHash = normalizeText(manifest?.manifestHash || '');
  const genericHash = normalizeText(manifest?.hash || '');
  return {
    manifestHash,
    genericHash,
    effectiveHash: manifestHash || null,
  };
}

function manifestHashFor(manifest) {
  return manifestStoredHashes(manifest).effectiveHash;
}

function previewHashPayload(payload = null) {
  if (!payload || typeof payload !== 'object') return payload || null;
  const hashPayload = { ...payload };
  if (Object.hasOwn(hashPayload, 'action')) {
    hashPayload.action = canonicalExternalActionOrNull(hashPayload.action);
  }
  if (Object.hasOwn(hashPayload, 'productLineId')) {
    hashPayload.productLineId = canonicalProductLineIdOrNull(hashPayload.productLineId);
  }
  if (Object.hasOwn(hashPayload, 'workflowId')) {
    hashPayload.workflowId = canonicalProductLineIdOrNull(hashPayload.workflowId);
  }
  for (const key of ['packageRole', 'reviewType', 'role']) {
    if (Object.hasOwn(hashPayload, key)) {
      hashPayload[key] = canonicalPackageRole(hashPayload[key]) || null;
    }
  }
  return hashPayload;
}

function adapterRunPreviewHashPayload(preview = {}) {
  return {
    version: preview?.version,
    kind: preview?.kind,
    runnerId: preview?.runnerId,
    status: preview?.status,
    readyForDryRun: preview?.readyForDryRun,
    readyForExecution: preview?.readyForExecution,
    adapter: preview?.adapter,
    payload: previewHashPayload(preview?.payload || null),
    blockers: preview?.blockers,
    warnings: preview?.warnings,
    safety: preview?.safety,
  };
}

export function computeAdapterRunPreviewHash(preview = {}) {
  return digest(adapterRunPreviewHashPayload(preview));
}

function messagePreviewContentHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function manifestMessagePreviewBlockers(manifest) {
  const action = canonicalExternalAction(manifest?.action || '');
  if (action !== EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) return [];
  const preview = normalizeText(manifest?.payload?.messagePreview || '');
  const previewHash = normalizeText(manifest?.payload?.messagePreviewHash || '');
  const blockers = [];
  if (!preview) blockers.push(issue('manifest_message_preview_required'));
  if (!previewHash) blockers.push(issue('manifest_message_preview_hash_required'));
  if (preview && previewHash && messagePreviewContentHash(preview) !== previewHash) {
    blockers.push(issue('manifest_message_preview_hash_mismatch'));
  }
  return blockers;
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function manifestRequiresHumanFeedbackContractHash(manifest) {
  const actionValues = [
    manifest?.action,
    manifest?.payload?.action,
    manifest?.adapter?.hints?.actionVariant,
  ];
  const productValues = [
    manifest?.productLineId,
    manifest?.workflowId,
    manifest?.payload?.productLineId,
    manifest?.payload?.workflowId,
    manifest?.payload?.packageRole,
    manifest?.payload?.reviewType,
    manifest?.payload?.role,
  ];
  return isHumanFeedbackCustomerFacingAction(manifest?.action || manifest?.payload?.action || EXTERNAL_ACTIONS.NONE)
    && (
      actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || productValues.some((value) => isHumanFeedbackIdentity(value))
      || normalizeText(manifest?.payload?.humanFeedbackRevisionContractHash || '')
    );
}

function isPromptGenerationSpendAction(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function promptGenerationBindingBlockers(manifest) {
  if (!isPromptGenerationSpendAction(manifest?.action || manifest?.payload?.action)) return [];
  const binding = manifest?.payload?.promptGenerationBinding || null;
  if (!binding) {
    return [issue('prompt_generation_binding_required', PROMPT_GENERATION_BINDING_KEYS.join(', '))];
  }
  const missingKeys = PROMPT_GENERATION_BINDING_KEYS
    .filter((key) => !normalizeText(binding?.[key] || ''));
  return missingKeys.length
    ? [issue('prompt_generation_binding_required', missingKeys.join(', '))]
    : [];
}

function runnerBlockers({ manifest, execute }) {
  const blockers = [];
  const {
    manifestHash,
    genericHash,
    effectiveHash: existingManifestHash,
  } = manifestStoredHashes(manifest);
  if (!existingManifestHash) {
    blockers.push(issue('manifest_hash_required'));
  }
  if (!manifestHash) blockers.push(issue('manifest_hash_alias_required'));
  if (!genericHash) blockers.push(issue('manifest_generic_hash_required'));
  if (manifestHash && genericHash && manifestHash !== genericHash) {
    blockers.push(issue('manifest_hash_alias_mismatch'));
  }
  if (existingManifestHash && existingManifestHash !== computeChannelActionManifestHash(manifest || {})) {
    blockers.push(issue('manifest_hash_content_mismatch'));
  }
  if (manifest?.kind !== 'ChannelActionManifest') blockers.push(issue('invalid_manifest_kind'));
  if (manifest?.status !== ACTION_MANIFEST_STATUS.READY || manifest?.readyForAdapter !== true) {
    blockers.push(issue('manifest_not_ready'));
  }
  if (!normalizeText(manifest?.adapter?.actionId || '')) blockers.push(issue('adapter_action_missing'));
  if (!normalizeText(manifest?.payload?.approvalHash || '')) blockers.push(issue('approval_hash_missing'));
  if (!normalizeText(manifest?.payload?.evidenceHash || '')) blockers.push(issue('evidence_hash_missing'));
  if (!normalizeText(manifest?.payload?.approvalProvenanceHash || '')) {
    blockers.push(issue('approval_provenance_hash_missing'));
  }
  blockers.push(...manifestMessagePreviewBlockers(manifest || {}));
  if (
    manifestRequiresHumanFeedbackContractHash(manifest || {})
    && !normalizeText(manifest?.payload?.humanFeedbackRevisionContractHash || '')
  ) {
    blockers.push(issue('manifest_human_feedback_contract_hash_required'));
  }
  blockers.push(...promptGenerationBindingBlockers(manifest || {}));
  if (manifest?.safety?.executesExternalAction === true) blockers.push(issue('unsafe_manifest_claims_execution'));
  if (execute === true) blockers.push(issue('execute_not_allowed_in_core_stub'));
  return blockers;
}

export function buildAdapterRunPreview({
  manifest = null,
  execute = false,
  runnerId = 'design-production-core.adapter-runner',
  createdAt = null,
} = {}) {
  const preview = channelActionPreview(manifest || {});
  const blockers = runnerBlockers({ manifest, execute });
  const artifactNames = uniqueStrings(manifest?.payload?.artifactNames || [], 64);
  const command = preview.command.filter((part) => part !== null && part !== undefined && part !== '');
  const manifestHash = manifestHashFor(manifest || {});
  const promptGenerationBinding = manifest?.payload?.promptGenerationBinding || null;

  const runPreview = {
    version: ADAPTER_RUNNER_VERSION,
    kind: 'AdapterRunPreview',
    runnerId,
    status: blockers.length ? ADAPTER_RUNNER_STATUS.BLOCKED : ADAPTER_RUNNER_STATUS.DRY_RUN_READY,
    readyForDryRun: blockers.length === 0,
    readyForExecution: false,
    adapter: {
      actionId: normalizeText(manifest?.adapter?.actionId || '') || null,
      channelId: normalizeText(manifest?.channelId || manifest?.adapter?.channelId || '') || null,
      command,
      commandPreview: displayCommand(command),
      commandOwner: preview.commandOwner,
      requiredFlags: preview.requiredFlags,
      requiredHashes: {
        manifestHash,
        approvalHash: normalizeText(manifest?.payload?.approvalHash || '') || null,
        evidenceHash: normalizeText(manifest?.payload?.evidenceHash || '') || null,
        approvalProvenanceHash: normalizeText(manifest?.payload?.approvalProvenanceHash || '') || null,
        humanFeedbackRevisionContractHash: normalizeText(manifest?.payload?.humanFeedbackRevisionContractHash || '') || null,
        messagePreviewHash: normalizeText(manifest?.payload?.messagePreviewHash || '') || null,
        promptGenerationBinding,
      },
    },
    payload: {
      taskKey: normalizeText(manifest?.taskKey || '') || null,
      externalId: normalizeText(manifest?.payload?.externalId || '') || null,
      action: canonicalExternalAction(manifest?.action || ''),
      productLineId: canonicalProductLineIdOrNull(manifest?.productLineId),
      workflowId: canonicalProductLineIdOrNull(manifest?.workflowId),
      packageRole: canonicalPackageRole(manifest?.payload?.packageRole || '') || null,
      artifactCount: artifactNames.length,
      artifactNames,
      manifestHash,
      approvalHash: normalizeText(manifest?.payload?.approvalHash || '') || null,
      evidenceHash: normalizeText(manifest?.payload?.evidenceHash || '') || null,
      approvalProvenanceHash: normalizeText(manifest?.payload?.approvalProvenanceHash || '') || null,
      humanFeedbackRevisionContractHash: normalizeText(manifest?.payload?.humanFeedbackRevisionContractHash || '') || null,
      ...(promptGenerationBinding
        ? { promptGenerationBinding }
        : {}),
      messagePreview: normalizeText(manifest?.payload?.messagePreview || '') || null,
      messagePreviewHash: normalizeText(manifest?.payload?.messagePreviewHash || '') || null,
    },
    blockers,
    warnings: [
      ...(manifest?.warnings || []).map((warning) => issue(warning.code || warning, warning.notes || null, 'warning')),
      issue('dry_run_preview_only', 'Core adapter-runner stubs never execute channel actions.', 'warning'),
    ],
    safety: {
      dryRunOnly: true,
      executesExternalAction: false,
      requiresExternalAdapter: true,
      executeFlagAccepted: false,
      explicitApprovalStillRequired: true,
      approvalHashRequired: true,
      evidenceHashRequired: true,
      sourceSnapshotRedacted: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const previewHash = computeAdapterRunPreviewHash(runPreview);
  return {
    ...runPreview,
    previewHash,
    hash: previewHash,
  };
}

export function summarizeAdapterRunPreviews(previews = []) {
  const byStatus = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  for (const preview of previews || []) {
    byStatus[preview.status] = (byStatus[preview.status] || 0) + 1;
    const channelId = preview.adapter?.channelId || 'unknown';
    byChannel[channelId] = (byChannel[channelId] || 0) + 1;
    const actionId = preview.adapter?.actionId || 'unknown';
    byActionId[actionId] = (byActionId[actionId] || 0) + 1;
    for (const blocker of preview.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_RUNNER_VERSION,
    count: previews.length,
    byStatus,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      dryRunOnly: true,
      executesExternalAction: previews.some((preview) => preview.safety?.executesExternalAction === true),
      readyForExecution: previews.some((preview) => preview.readyForExecution === true),
    },
  };
}
