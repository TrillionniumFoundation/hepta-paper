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
  EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS,
  computeExternalActionAuditBundleHash,
} from './external-action-audit-bundle.mjs';
import { digest } from './hash-utils.mjs';

export const EXTERNAL_ACTION_AUDIT_ARCHIVE_VERSION = 1;

export const EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS = Object.freeze({
  READY: 'ready_external_action_audit_archive',
  BLOCKED: 'blocked_external_action_audit_archive',
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

function expectedBundleHash(bundle) {
  return computeExternalActionAuditBundleHash(bundle);
}

function bundleHash(bundle) {
  return bundleAliasHash(bundle);
}

function bundleAliasHash(bundle) {
  return normalizeText(bundle?.bundleHash || '') || null;
}

function bundleGenericHash(bundle) {
  return normalizeText(bundle?.hash || '') || null;
}

function chainHash(bundle, key) {
  return normalizeText(bundle?.hashBinding?.[key] || '') || null;
}

function payloadHash(bundle, key) {
  return normalizeText(bundle?.payload?.[key] || '') || null;
}

function canonicalArchiveEntry(entry = null) {
  if (!entry) return entry;
  return {
    ...entry,
    action: canonicalActionOrNull(entry.action),
    productLineId: canonicalProductLineOrNull(entry.productLineId),
    workflowId: canonicalProductLineOrNull(entry.workflowId),
    packageRole: Object.hasOwn(entry, 'packageRole') ? canonicalPackageRole(entry.packageRole) || null : undefined,
  };
}

function humanFeedbackCustomerFacingBundle(bundle) {
  const payload = bundle?.payload || {};
  const actionValues = [bundle?.action, bundle?.actionId, payload.action];
  const productValues = [payload.productLineId, payload.workflowId, payload.packageRole, payload.reviewType, payload.role];
  return actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
    || (
      actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
      && productValues.some((value) => canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK)
    );
}

function promptGenerationSpendBundle(bundle) {
  const payload = bundle?.payload || {};
  return [bundle?.action, bundle?.actionId, payload.action]
    .some((value) => {
      const action = canonicalExternalAction(value);
      return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
    });
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = uniqueStrings([...Object.keys(left), ...Object.keys(right)], 32);
  return keys.every((key) => normalizeText(left[key] || '') === normalizeText(right[key] || ''));
}

function promptGenerationBindingComplete(binding = null) {
  return Boolean(binding)
    && PROMPT_GENERATION_BINDING_KEYS.every((key) => normalizeText(binding?.[key] || ''));
}

function bundleBlockers(bundle, index, { requireVerifiedBundles, requireInboxChain }) {
  const prefix = `bundle[${index}]`;
  const blockers = [];
  if (!bundle || bundle.kind !== 'ExternalActionAuditBundle') {
    blockers.push(issue('invalid_audit_bundle', prefix));
    return blockers;
  }

  const currentBundleAliasHash = bundleAliasHash(bundle);
  const currentBundleGenericHash = bundleGenericHash(bundle);
  const currentBundleHash = currentBundleAliasHash;
  const expectedHash = expectedBundleHash(bundle);
  if (!currentBundleAliasHash) blockers.push(issue('audit_bundle_hash_alias_required', prefix));
  if (!currentBundleGenericHash) blockers.push(issue('audit_bundle_generic_hash_required', prefix));
  if (currentBundleAliasHash && currentBundleGenericHash && currentBundleAliasHash !== currentBundleGenericHash) {
    blockers.push(issue('audit_bundle_hash_alias_mismatch', prefix));
  }
  if (currentBundleHash && expectedHash && currentBundleHash !== expectedHash) {
    blockers.push(issue('audit_bundle_hash_content_mismatch', prefix));
  }

  if (requireVerifiedBundles && (bundle.status !== EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS.VERIFIED || bundle.verified !== true)) {
    blockers.push(issue('audit_bundle_not_verified', prefix));
  }
  if (!chainHash(bundle, 'ledgerHash')) blockers.push(issue('bundle_ledger_hash_required', prefix));
  if (!chainHash(bundle, 'platformStateSnapshotHash')) blockers.push(issue('bundle_platform_state_snapshot_hash_required', prefix));
  if (!chainHash(bundle, 'dryRunReplayHash')) blockers.push(issue('bundle_dry_run_replay_hash_required', prefix));
  if (bundle.safety?.executesExternalAction === true) blockers.push(issue('bundle_claims_external_execution', prefix));
  if (bundle.safety?.appliesLocalStateTransition === true) blockers.push(issue('bundle_claims_local_state_application', prefix));
  if (!normalizeText(bundle.channelId || '')) blockers.push(issue('bundle_channel_id_required', prefix));
  if (!normalizeText(bundle.actionId || '')) blockers.push(issue('bundle_action_id_required', prefix));
  if (!canonicalActionOrNull(bundle.action || bundle.payload?.action)) blockers.push(issue('bundle_action_required', prefix));
  if (!normalizeText(bundle.payload?.taskKey || '')) blockers.push(issue('bundle_task_key_required', prefix));
  if (!normalizeText(bundle.payload?.externalId || '')) blockers.push(issue('bundle_external_id_required', prefix));

  const payloadMessageHash = payloadHash(bundle, 'messagePreviewHash');
  const bindingMessageHash = chainHash(bundle, 'messagePreviewHash');
  const payloadApprovalProvenanceHash = payloadHash(bundle, 'approvalProvenanceHash');
  const bindingApprovalProvenanceHash = chainHash(bundle, 'approvalProvenanceHash');
  if (canonicalActionOrNull(bundle.action || bundle.payload?.action)) {
    if (!payloadApprovalProvenanceHash) blockers.push(issue('bundle_approval_provenance_hash_required', prefix));
    if (!bindingApprovalProvenanceHash) blockers.push(issue('bundle_approval_provenance_hash_binding_required', prefix));
  }
  if (
    (payloadApprovalProvenanceHash || bindingApprovalProvenanceHash)
    && payloadApprovalProvenanceHash !== bindingApprovalProvenanceHash
  ) {
    blockers.push(issue('bundle_approval_provenance_hash_binding_mismatch', prefix));
  }

  if (canonicalExternalAction(bundle.action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    if (!payloadMessageHash) blockers.push(issue('bundle_customer_message_preview_hash_required', prefix));
    if (!bindingMessageHash) blockers.push(issue('bundle_customer_message_preview_hash_binding_required', prefix));
  }
  if ((payloadMessageHash || bindingMessageHash) && payloadMessageHash !== bindingMessageHash) {
    blockers.push(issue('bundle_message_preview_hash_binding_mismatch', prefix));
  }

  const payloadContractHash = payloadHash(bundle, 'humanFeedbackRevisionContractHash');
  const bindingContractHash = chainHash(bundle, 'humanFeedbackRevisionContractHash');
  if (humanFeedbackCustomerFacingBundle(bundle)) {
    if (!payloadContractHash) blockers.push(issue('bundle_human_feedback_contract_hash_required', prefix));
    if (!bindingContractHash) blockers.push(issue('bundle_human_feedback_contract_hash_binding_required', prefix));
  }
  if ((payloadContractHash || bindingContractHash) && payloadContractHash !== bindingContractHash) {
    blockers.push(issue('bundle_human_feedback_contract_hash_binding_mismatch', prefix));
  }

  const payloadPromptGenerationBinding = bundle?.payload?.promptGenerationBinding || null;
  const bindingPromptGenerationBinding = bundle?.hashBinding?.promptGenerationBinding || null;
  if (promptGenerationSpendBundle(bundle) || payloadPromptGenerationBinding || bindingPromptGenerationBinding) {
    if (!payloadPromptGenerationBinding) blockers.push(issue('bundle_prompt_generation_binding_required', prefix));
    if (!bindingPromptGenerationBinding) blockers.push(issue('bundle_prompt_generation_hash_binding_required', prefix));
    const missingPayloadKeys = PROMPT_GENERATION_BINDING_KEYS
      .filter((key) => !normalizeText(payloadPromptGenerationBinding?.[key] || ''));
    if (payloadPromptGenerationBinding && missingPayloadKeys.length) {
      blockers.push(issue('bundle_prompt_generation_binding_incomplete', prefix || missingPayloadKeys.join(', ')));
    }
    const missingBindingKeys = PROMPT_GENERATION_BINDING_KEYS
      .filter((key) => !normalizeText(bindingPromptGenerationBinding?.[key] || ''));
    if (bindingPromptGenerationBinding && missingBindingKeys.length) {
      blockers.push(issue('bundle_prompt_generation_hash_binding_incomplete', prefix || missingBindingKeys.join(', ')));
    }
    if (
      payloadPromptGenerationBinding
      && bindingPromptGenerationBinding
      && !samePromptGenerationBinding(payloadPromptGenerationBinding, bindingPromptGenerationBinding)
    ) {
      blockers.push(issue('bundle_prompt_generation_binding_mismatch', prefix));
    }
  }

  if (requireInboxChain) {
    if (bundle.hashBinding?.usesInboxChain !== true) blockers.push(issue('bundle_inbox_chain_required', prefix));
    if (!chainHash(bundle, 'receiptInboxHash')) blockers.push(issue('bundle_receipt_inbox_hash_required', prefix));
    if (!chainHash(bundle, 'proofInboxHash')) blockers.push(issue('bundle_proof_inbox_hash_required', prefix));
    if (!chainHash(bundle, 'transitionInboxHash')) blockers.push(issue('bundle_transition_inbox_hash_required', prefix));
    if (bundle.hashBinding?.usesDispatchInboxChain === true) {
      if (!chainHash(bundle, 'dispatchReceiptInboxHash')) blockers.push(issue('bundle_dispatch_receipt_inbox_hash_required', prefix));
      if (!chainHash(bundle, 'dispatchProofInboxHash')) blockers.push(issue('bundle_dispatch_proof_inbox_hash_required', prefix));
      if (!chainHash(bundle, 'dispatchTransitionInboxHash')) blockers.push(issue('bundle_dispatch_transition_inbox_hash_required', prefix));
      if (!chainHash(bundle, 'dispatchEnvelopeHash')) blockers.push(issue('bundle_dispatch_envelope_hash_required', prefix));
      if (!chainHash(bundle, 'dispatchOutboxHash')) blockers.push(issue('bundle_dispatch_outbox_hash_required', prefix));
      if (!chainHash(bundle, 'dispatchReplayGuardHash')) blockers.push(issue('bundle_dispatch_replay_guard_hash_required', prefix));
      if (!chainHash(bundle, 'dispatchArchiveHash')) blockers.push(issue('bundle_dispatch_archive_hash_required', prefix));
    }
  }

  return blockers;
}

function duplicateBlockers(bundles) {
  const blockers = [];
  const seenBundleHashes = new Set();
  const seenLedgerHashes = new Set();
  for (const bundle of bundles || []) {
    const currentBundleHash = bundleHash(bundle);
    if (currentBundleHash) {
      if (seenBundleHashes.has(currentBundleHash)) blockers.push(issue('duplicate_audit_bundle_hash', currentBundleHash));
      seenBundleHashes.add(currentBundleHash);
    }
    const ledgerHash = chainHash(bundle, 'ledgerHash');
    if (ledgerHash) {
      if (seenLedgerHashes.has(ledgerHash)) blockers.push(issue('duplicate_ledger_hash', ledgerHash));
      seenLedgerHashes.add(ledgerHash);
    }
  }
  return blockers;
}

function archiveEntries(bundles) {
  return (bundles || []).map((bundle) => ({
    bundleHash: bundleHash(bundle),
    ledgerHash: chainHash(bundle, 'ledgerHash'),
    channelId: bundle?.channelId || null,
    actionId: bundle?.actionId || null,
    action: canonicalActionOrNull(bundle?.action || bundle?.payload?.action),
    taskKey: bundle?.payload?.taskKey || null,
    externalId: bundle?.payload?.externalId || null,
    productLineId: canonicalProductLineOrNull(bundle?.payload?.productLineId),
    workflowId: canonicalProductLineOrNull(bundle?.payload?.workflowId),
    packageRole: canonicalPackageRole(bundle?.payload?.packageRole || '') || null,
    approvalProvenanceHash: bundle?.payload?.approvalProvenanceHash || null,
    messagePreviewHash: bundle?.payload?.messagePreviewHash || null,
    humanFeedbackRevisionContractHash: bundle?.payload?.humanFeedbackRevisionContractHash || null,
    promptGenerationBinding: bundle?.payload?.promptGenerationBinding || null,
    promptGenerationBindingHashBinding: bundle?.hashBinding?.promptGenerationBinding || null,
    status: bundle?.status || null,
    verified: bundle?.verified === true,
    usesInboxChain: bundle?.hashBinding?.usesInboxChain === true,
    usesStandardInboxChain: bundle?.hashBinding?.usesStandardInboxChain === true,
    usesDispatchInboxChain: bundle?.hashBinding?.usesDispatchInboxChain === true,
    dispatchEnvelopeHash: chainHash(bundle, 'dispatchEnvelopeHash'),
    dispatchOutboxHash: chainHash(bundle, 'dispatchOutboxHash'),
    dispatchReplayGuardHash: chainHash(bundle, 'dispatchReplayGuardHash'),
    dispatchArchiveHash: chainHash(bundle, 'dispatchArchiveHash'),
    dispatchLedgerHash: chainHash(bundle, 'dispatchLedgerHash'),
    approvalProvenanceHashBinding: chainHash(bundle, 'approvalProvenanceHash'),
    platformStateSnapshotHash: chainHash(bundle, 'platformStateSnapshotHash'),
    dryRunReplayHash: chainHash(bundle, 'dryRunReplayHash'),
    dispatchReceiptInboxHash: chainHash(bundle, 'dispatchReceiptInboxHash'),
    dispatchProofInboxHash: chainHash(bundle, 'dispatchProofInboxHash'),
    dispatchTransitionInboxHash: chainHash(bundle, 'dispatchTransitionInboxHash'),
  }));
}

function archiveSummary(entries) {
  const byStatus = {};
  const byChannel = {};
  const byActionId = {};
  let verifiedCount = 0;
  let dispatchInboxChainCount = 0;
  let customerMessagePreviewHashBoundCount = 0;
  let humanFeedbackContractBoundCount = 0;
  let approvalProvenanceHashBoundCount = 0;
  let promptGenerationBindingBoundCount = 0;
  let platformStateSnapshotHashBoundCount = 0;
  let dryRunReplayHashBoundCount = 0;
  for (const entry of entries) {
    byStatus[entry.status || 'unknown'] = (byStatus[entry.status || 'unknown'] || 0) + 1;
    byChannel[entry.channelId || 'unknown'] = (byChannel[entry.channelId || 'unknown'] || 0) + 1;
    byActionId[entry.actionId || 'unknown'] = (byActionId[entry.actionId || 'unknown'] || 0) + 1;
    if (entry.verified) verifiedCount += 1;
    if (entry.usesDispatchInboxChain) dispatchInboxChainCount += 1;
    if (canonicalExternalAction(entry.action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE && entry.messagePreviewHash) {
      customerMessagePreviewHashBoundCount += 1;
    }
    if (entry.humanFeedbackRevisionContractHash) humanFeedbackContractBoundCount += 1;
    if (entry.approvalProvenanceHash && entry.approvalProvenanceHashBinding === entry.approvalProvenanceHash) {
      approvalProvenanceHashBoundCount += 1;
    }
    if (
      promptGenerationBindingComplete(entry.promptGenerationBinding)
      && promptGenerationBindingComplete(entry.promptGenerationBindingHashBinding)
      && samePromptGenerationBinding(entry.promptGenerationBinding, entry.promptGenerationBindingHashBinding)
    ) {
      promptGenerationBindingBoundCount += 1;
    }
    if (entry.platformStateSnapshotHash) platformStateSnapshotHashBoundCount += 1;
    if (entry.dryRunReplayHash) dryRunReplayHashBoundCount += 1;
  }
  return {
    count: entries.length,
    verifiedCount,
    blockedCount: entries.length - verifiedCount,
    dispatchInboxChainCount,
    customerMessagePreviewHashBoundCount,
    humanFeedbackContractBoundCount,
    approvalProvenanceHashBoundCount,
    promptGenerationBindingBoundCount,
    platformStateSnapshotHashBoundCount,
    dryRunReplayHashBoundCount,
    byStatus,
    byChannel,
    byActionId,
    taskKeys: uniqueStrings(entries.map((entry) => entry.taskKey), 256),
    externalIds: uniqueStrings(entries.map((entry) => entry.externalId), 256),
    approvalProvenanceHashes: uniqueStrings(entries.map((entry) => entry.approvalProvenanceHash), 256),
    humanFeedbackRevisionContractHashes: uniqueStrings(entries.map((entry) => entry.humanFeedbackRevisionContractHash), 256),
    bundleHashes: uniqueStrings(entries.map((entry) => entry.bundleHash), 512),
    ledgerHashes: uniqueStrings(entries.map((entry) => entry.ledgerHash), 512),
  };
}

export function computeExternalActionAuditArchiveHash(archive) {
  if (!archive) return null;
  const entries = (archive.entries || []).map(canonicalArchiveEntry);
  return digest({
    version: archive.version,
    kind: archive.kind,
    actor: archive.actor,
    status: archive.status,
    ready: archive.ready,
    archiveRole: archive.archiveRole,
    entries,
    summary: archive.summary,
    blockers: archive.blockers,
    warnings: archive.warnings,
    evidenceRefs: archive.evidenceRefs,
    safety: archive.safety,
  });
}

export function buildExternalActionAuditArchive({
  bundles = [],
  archiveRole = 'control_plane_audit_index',
  requireVerifiedBundles = true,
  requireInboxChain = true,
  allowEmptyArchive = false,
  actor = 'design-production-core.external-action-audit-archive',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const archiveBundles = Array.isArray(bundles) ? bundles : [];
  const blockers = [];
  if (!archiveBundles.length && allowEmptyArchive !== true) blockers.push(issue('no_audit_bundles'));
  for (let index = 0; index < archiveBundles.length; index += 1) {
    blockers.push(...bundleBlockers(archiveBundles[index], index, { requireVerifiedBundles, requireInboxChain }));
  }
  blockers.push(...duplicateBlockers(archiveBundles));

  const entries = archiveEntries(archiveBundles);
  const summary = archiveSummary(entries);
  const status = blockers.length
    ? EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS.BLOCKED
    : EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS.READY;
  const archive = {
    version: EXTERNAL_ACTION_AUDIT_ARCHIVE_VERSION,
    kind: 'ExternalActionAuditArchive',
    actor: normalizeText(actor) || 'design-production-core.external-action-audit-archive',
    status,
    ready: status === EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS.READY,
    archiveRole: normalizeText(archiveRole) || 'control_plane_audit_index',
    entries,
    summary,
    blockers,
    warnings: [
      issue('audit_archive_indexes_only', 'Audit archives are redacted indexes and never grant execution permission.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      auditArchiveOnly: true,
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
      requiresVerifiedBundles: requireVerifiedBundles === true,
      requiresInboxChain: requireInboxChain === true,
      allowEmptyArchive: allowEmptyArchive === true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const archiveHash = computeExternalActionAuditArchiveHash(archive);

  return {
    ...archive,
    archiveHash,
    hash: archiveHash,
  };
}

export function summarizeExternalActionAuditArchives(archives = []) {
  const byStatus = {};
  const blockerCodes = {};
  let bundleCount = 0;
  for (const archive of archives || []) {
    byStatus[archive.status] = (byStatus[archive.status] || 0) + 1;
    bundleCount += archive.summary?.count || 0;
    for (const blocker of archive.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: EXTERNAL_ACTION_AUDIT_ARCHIVE_VERSION,
    count: archives.length,
    bundleCount,
    byStatus,
    blockerCodes,
    safety: {
      auditArchiveOnly: true,
      executesExternalAction: archives.some((archive) => archive.safety?.executesExternalAction === true),
      appliesLocalStateTransition: archives.some((archive) => archive.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: archives.some((archive) => archive.safety?.grantsExecutionPermission === true),
    },
  };
}
