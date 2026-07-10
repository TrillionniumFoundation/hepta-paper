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
} from './contracts.mjs';
import {
  EXTERNAL_ACTION_LEDGER_STATUS,
  computeExternalActionLedgerHash,
} from './external-action-ledger.mjs';
import { digest } from './hash-utils.mjs';

export const EXTERNAL_ACTION_AUDIT_BUNDLE_VERSION = 1;

export const EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS = Object.freeze({
  VERIFIED: 'verified_action_audit_bundle',
  BLOCKED: 'blocked_action_audit_bundle',
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

function expectedLedgerHash(ledgerEntry) {
  return computeExternalActionLedgerHash(ledgerEntry);
}

function chainHash(chain, key) {
  return normalizeText(chain?.[key] || '') || null;
}

function chainValue(chain, key) {
  return chain?.[key] || null;
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => normalizeText(left[key] || '') === normalizeText(right[key] || ''));
}

function promptGenerationSpendLedger(ledgerEntry) {
  const payload = ledgerEntry?.payload || {};
  return [ledgerEntry?.action, ledgerEntry?.actionId, payload.action]
    .some((value) => {
      const action = canonicalExternalAction(value);
      return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
    });
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

function hashBlockers(ledgerEntry, requireInboxChain) {
  const blockers = [];
  const chain = ledgerEntry?.chain || {};
  const ledgerAliasHash = normalizeText(ledgerEntry?.ledgerHash || '') || null;
  const ledgerGenericHash = normalizeText(ledgerEntry?.hash || '') || null;
  const ledgerHash = ledgerAliasHash || ledgerGenericHash;
  const expectedHash = expectedLedgerHash(ledgerEntry);

  if (!ledgerHash) blockers.push(issue('ledger_hash_required'));
  if (!ledgerAliasHash) blockers.push(issue('ledger_hash_alias_required'));
  if (!ledgerGenericHash) blockers.push(issue('ledger_generic_hash_required'));
  if (ledgerAliasHash && ledgerGenericHash && ledgerAliasHash !== ledgerGenericHash) {
    blockers.push(issue('ledger_hash_alias_mismatch'));
  }
  if (ledgerHash && expectedHash && ledgerHash !== expectedHash) blockers.push(issue('ledger_hash_content_mismatch'));
  if (!chainHash(chain, 'manifestHash')) blockers.push(issue('manifest_hash_required'));
  if (!chainHash(chain, 'previewHash')) blockers.push(issue('preview_hash_required'));
  if (!chainHash(chain, 'receiptHash')) blockers.push(issue('receipt_hash_required'));
  if (!chainHash(chain, 'proofHash')) blockers.push(issue('proof_hash_required'));
  if (!chainHash(chain, 'transitionHash')) blockers.push(issue('transition_hash_required'));
  if (!chainHash(chain, 'platformStateSnapshotHash')) blockers.push(issue('platform_state_snapshot_hash_required'));
  if (!chainHash(chain, 'dryRunReplayHash')) blockers.push(issue('dry_run_replay_hash_required'));

  if (requireInboxChain) {
    if (chain.usesInboxChain !== true) blockers.push(issue('inbox_chain_required'));
    if (!chainHash(chain, 'receiptInboxHash')) blockers.push(issue('receipt_inbox_hash_required'));
    if (!chainHash(chain, 'proofInboxHash')) blockers.push(issue('proof_inbox_hash_required'));
    if (!chainHash(chain, 'transitionInboxHash')) blockers.push(issue('transition_inbox_hash_required'));
    if (chain.usesDispatchInboxChain === true) {
      if (!chainHash(chain, 'dispatchReceiptInboxHash')) blockers.push(issue('dispatch_receipt_inbox_hash_required'));
      if (!chainHash(chain, 'dispatchProofInboxHash')) blockers.push(issue('dispatch_proof_inbox_hash_required'));
      if (!chainHash(chain, 'dispatchTransitionInboxHash')) blockers.push(issue('dispatch_transition_inbox_hash_required'));
      if (!chainHash(chain, 'dispatchEnvelopeHash')) blockers.push(issue('dispatch_envelope_hash_required'));
      if (!chainHash(chain, 'dispatchOutboxHash')) blockers.push(issue('dispatch_outbox_hash_required'));
      if (!chainHash(chain, 'dispatchReplayGuardHash')) blockers.push(issue('dispatch_replay_guard_hash_required'));
      if (!chainHash(chain, 'dispatchArchiveHash')) blockers.push(issue('dispatch_archive_hash_required'));
    }
  }

  return blockers;
}

function humanFeedbackCustomerFacingLedger(ledgerEntry) {
  const payload = ledgerEntry?.payload || {};
  const actionValues = [ledgerEntry?.action, ledgerEntry?.actionId, payload.action];
  const productValues = [payload.productLineId, payload.workflowId, payload.packageRole, payload.reviewType, payload.role];
  return actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
    || (
      actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
      && productValues.some((value) => canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK)
    );
}

function payloadChainHashBlockers(ledgerEntry) {
  const blockers = [];
  const payload = ledgerEntry?.payload || {};
  const chain = ledgerEntry?.chain || {};
  const action = canonicalActionOrNull(ledgerEntry?.action || payload.action);
  const payloadApprovalProvenanceHash = normalizeText(payload.approvalProvenanceHash || '') || null;
  const chainApprovalProvenanceHash = chainHash(chain, 'approvalProvenanceHash');
  const payloadMessageHash = normalizeText(payload.messagePreviewHash || '') || null;
  const chainMessageHash = chainHash(chain, 'messagePreviewHash');
  const payloadContractHash = normalizeText(payload.humanFeedbackRevisionContractHash || '') || null;
  const chainContractHash = chainHash(chain, 'humanFeedbackRevisionContractHash');
  const payloadPromptGenerationBinding = payload.promptGenerationBinding || null;
  const chainPromptGenerationBinding = chainValue(chain, 'promptGenerationBinding');

  if (action) {
    if (!payloadApprovalProvenanceHash) blockers.push(issue('audit_bundle_approval_provenance_hash_required'));
    if (!chainApprovalProvenanceHash) blockers.push(issue('audit_bundle_approval_provenance_chain_hash_required'));
  }
  if ((payloadApprovalProvenanceHash || chainApprovalProvenanceHash) && payloadApprovalProvenanceHash !== chainApprovalProvenanceHash) {
    blockers.push(issue('audit_bundle_approval_provenance_hash_binding_mismatch'));
  }

  if (canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    if (!payloadMessageHash) blockers.push(issue('audit_bundle_customer_message_preview_hash_required'));
    if (!chainMessageHash) blockers.push(issue('audit_bundle_customer_message_preview_chain_hash_required'));
  }
  if ((payloadMessageHash || chainMessageHash) && payloadMessageHash !== chainMessageHash) {
    blockers.push(issue('audit_bundle_message_preview_hash_binding_mismatch'));
  }

  if (humanFeedbackCustomerFacingLedger(ledgerEntry)) {
    if (!payloadContractHash) blockers.push(issue('audit_bundle_human_feedback_contract_hash_required'));
    if (!chainContractHash) blockers.push(issue('audit_bundle_human_feedback_contract_chain_hash_required'));
  }
  if ((payloadContractHash || chainContractHash) && payloadContractHash !== chainContractHash) {
    blockers.push(issue('audit_bundle_human_feedback_contract_hash_binding_mismatch'));
  }
  if (promptGenerationSpendLedger(ledgerEntry) || payloadPromptGenerationBinding || chainPromptGenerationBinding) {
    if (!payloadPromptGenerationBinding) {
      blockers.push(issue('audit_bundle_prompt_generation_binding_required'));
    }
    if (!chainPromptGenerationBinding) {
      blockers.push(issue('audit_bundle_prompt_generation_chain_binding_required'));
    }
    const missingPayloadKeys = PROMPT_GENERATION_BINDING_KEYS
      .filter((key) => !normalizeText(payloadPromptGenerationBinding?.[key] || ''));
    if (payloadPromptGenerationBinding && missingPayloadKeys.length) {
      blockers.push(issue('audit_bundle_prompt_generation_binding_incomplete', missingPayloadKeys.join(', ')));
    }
    const missingChainKeys = PROMPT_GENERATION_BINDING_KEYS
      .filter((key) => !normalizeText(chainPromptGenerationBinding?.[key] || ''));
    if (chainPromptGenerationBinding && missingChainKeys.length) {
      blockers.push(issue('audit_bundle_prompt_generation_chain_binding_incomplete', missingChainKeys.join(', ')));
    }
    if (
      payloadPromptGenerationBinding
      && chainPromptGenerationBinding
      && !samePromptGenerationBinding(payloadPromptGenerationBinding, chainPromptGenerationBinding)
    ) {
      blockers.push(issue('audit_bundle_prompt_generation_binding_mismatch'));
    }
  }

  return blockers;
}

function identityBlockers(ledgerEntry) {
  const blockers = [];
  const payload = ledgerEntry?.payload || {};
  if (!normalizeText(ledgerEntry?.channelId || '')) blockers.push(issue('audit_bundle_channel_id_required'));
  if (!normalizeText(ledgerEntry?.actionId || '')) blockers.push(issue('audit_bundle_action_id_required'));
  if (!canonicalActionOrNull(ledgerEntry?.action || payload.action)) blockers.push(issue('audit_bundle_action_required'));
  if (!normalizeText(payload.taskKey || '')) blockers.push(issue('audit_bundle_task_key_required'));
  if (!normalizeText(payload.externalId || '')) blockers.push(issue('audit_bundle_external_id_required'));
  return blockers;
}

function auditBlockers({ ledgerEntry, requireInboxChain }) {
  const blockers = [];

  if (!ledgerEntry || ledgerEntry.kind !== 'ExternalActionLedgerEntry') {
    blockers.push(issue('invalid_external_action_ledger'));
  }
  if (ledgerEntry?.status !== EXTERNAL_ACTION_LEDGER_STATUS.VERIFIED || ledgerEntry?.verified !== true) {
    blockers.push(issue('ledger_not_verified'));
  }
  if (ledgerEntry?.safety?.executesExternalAction === true) {
    blockers.push(issue('ledger_claims_external_execution'));
  }

  blockers.push(...hashBlockers(ledgerEntry, requireInboxChain));
  blockers.push(...identityBlockers(ledgerEntry));
  blockers.push(...payloadChainHashBlockers(ledgerEntry));
  return blockers;
}

function lineageStep(kind, hash, extras = {}) {
  return {
    kind,
    hash: normalizeText(hash || '') || null,
    ...extras,
  };
}

function buildLineage(chain, ledgerHash, includeCommandPreview) {
  const lineage = [
    lineageStep('ChannelActionManifest', chain?.manifestHash),
    lineageStep('AdapterRunPreview', chain?.previewHash, {
      commandPreviewIncluded: includeCommandPreview === true,
    }),
  ];

  if (chain?.usesDispatchInboxChain === true) {
    lineage.push(lineageStep('AdapterHandoffOutboxItem', chain?.dispatchOutboxHash));
    lineage.push(lineageStep('ExternalActionReplayGuardDecision', chain?.dispatchReplayGuardHash));
    lineage.push(lineageStep('ExternalActionAuditArchive', chain?.dispatchArchiveHash));
    if (chain?.dispatchLedgerHash) {
      lineage.push(lineageStep('PriorExternalActionLedgerEntry', chain?.dispatchLedgerHash));
    }
    lineage.push(lineageStep('AdapterDispatchEnvelope', chain?.dispatchEnvelopeHash));
  }

  lineage.push(lineageStep('AdapterRunReceipt', chain?.receiptHash));

  if (chain?.usesDispatchInboxChain === true || chain?.dispatchReceiptInboxHash) {
    lineage.push(lineageStep('AdapterDispatchReceiptInboxItem', chain?.dispatchReceiptInboxHash));
  } else if (chain?.usesInboxChain === true || chain?.receiptInboxHash) {
    lineage.push(lineageStep('AdapterReceiptInboxItem', chain?.receiptInboxHash));
  }

  lineage.push(lineageStep('ChannelStateProof', chain?.proofHash));

  if (chain?.usesDispatchInboxChain === true || chain?.dispatchProofInboxHash) {
    lineage.push(lineageStep('AdapterDispatchChannelStateProofInboxItem', chain?.dispatchProofInboxHash));
  } else if (chain?.usesInboxChain === true || chain?.proofInboxHash) {
    lineage.push(lineageStep('ChannelStateProofInboxItem', chain?.proofInboxHash));
  }

  lineage.push(lineageStep('ReceiptStateTransition', chain?.transitionHash));

  if (chain?.usesDispatchInboxChain === true || chain?.dispatchTransitionInboxHash) {
    lineage.push(lineageStep('AdapterDispatchReceiptStateTransitionInboxItem', chain?.dispatchTransitionInboxHash));
  } else if (chain?.usesInboxChain === true || chain?.transitionInboxHash) {
    lineage.push(lineageStep('ReceiptStateTransitionInboxItem', chain?.transitionInboxHash));
  }

  lineage.push(lineageStep('ExternalActionLedgerEntry', ledgerHash));
  return lineage;
}

export function computeExternalActionAuditBundleHash(bundle) {
  if (!bundle) return null;
  return digest({
    version: bundle.version,
    kind: bundle.kind,
    actor: bundle.actor,
    status: bundle.status,
    verified: bundle.verified,
    bundleRole: bundle.bundleRole,
    channelId: bundle.channelId,
    actionId: bundle.actionId,
    action: canonicalActionOrNull(bundle.action),
    payload: canonicalHashPayload(bundle.payload),
    hashBinding: bundle.hashBinding,
    lineage: bundle.lineage,
    blockers: bundle.blockers,
    warnings: bundle.warnings,
    evidenceRefs: bundle.evidenceRefs,
    safety: bundle.safety,
  });
}

export function buildExternalActionAuditBundle({
  ledgerEntry = null,
  bundleRole = 'control_plane_receipt',
  requireInboxChain = true,
  includeCommandPreview = false,
  actor = 'design-production-core.external-action-audit-bundle',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const blockers = auditBlockers({ ledgerEntry, requireInboxChain });
  const status = blockers.length
    ? EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS.BLOCKED
    : EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS.VERIFIED;
  const chain = ledgerEntry?.chain || {};
  const ledgerHash = normalizeText(ledgerEntry?.ledgerHash || '') || null;
  const normalizedRole = normalizeText(bundleRole) || 'control_plane_receipt';
  const action = canonicalActionOrNull(ledgerEntry?.action || ledgerEntry?.payload?.action);
  const productLineId = canonicalProductLineOrNull(ledgerEntry?.payload?.productLineId);
  const workflowId = canonicalProductLineOrNull(ledgerEntry?.payload?.workflowId);
  const packageRole = canonicalPackageRole(ledgerEntry?.payload?.packageRole || '') || null;

  const bundle = {
    version: EXTERNAL_ACTION_AUDIT_BUNDLE_VERSION,
    kind: 'ExternalActionAuditBundle',
    actor: normalizeText(actor) || 'design-production-core.external-action-audit-bundle',
    status,
    verified: status === EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS.VERIFIED,
    bundleRole: normalizedRole,
    channelId: ledgerEntry?.channelId || null,
    actionId: ledgerEntry?.actionId || null,
    action,
    payload: {
      taskKey: ledgerEntry?.payload?.taskKey || null,
      externalId: ledgerEntry?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole,
      approvalProvenanceHash: ledgerEntry?.payload?.approvalProvenanceHash || null,
      messagePreviewHash: ledgerEntry?.payload?.messagePreviewHash || null,
      humanFeedbackRevisionContractHash: ledgerEntry?.payload?.humanFeedbackRevisionContractHash || null,
      promptGenerationBinding: ledgerEntry?.payload?.promptGenerationBinding || null,
      artifactNames: ledgerEntry?.payload?.artifactNames || [],
    },
    hashBinding: {
      ledgerHash,
      manifestHash: chainHash(chain, 'manifestHash'),
      previewHash: chainHash(chain, 'previewHash'),
      approvalProvenanceHash: chainHash(chain, 'approvalProvenanceHash'),
      messagePreviewHash: chainHash(chain, 'messagePreviewHash'),
      humanFeedbackRevisionContractHash: chainHash(chain, 'humanFeedbackRevisionContractHash'),
      promptGenerationBinding: chainValue(chain, 'promptGenerationBinding'),
      receiptHash: chainHash(chain, 'receiptHash'),
      receiptInboxHash: chainHash(chain, 'receiptInboxHash'),
      proofHash: chainHash(chain, 'proofHash'),
      proofInboxHash: chainHash(chain, 'proofInboxHash'),
      platformStateSnapshotHash: chainHash(chain, 'platformStateSnapshotHash'),
      dryRunReplayHash: chainHash(chain, 'dryRunReplayHash'),
      transitionHash: chainHash(chain, 'transitionHash'),
      transitionInboxHash: chainHash(chain, 'transitionInboxHash'),
      dispatchReceiptInboxHash: chainHash(chain, 'dispatchReceiptInboxHash'),
      dispatchProofInboxHash: chainHash(chain, 'dispatchProofInboxHash'),
      dispatchTransitionInboxHash: chainHash(chain, 'dispatchTransitionInboxHash'),
      dispatchEnvelopeHash: chainHash(chain, 'dispatchEnvelopeHash'),
      dispatchOutboxHash: chainHash(chain, 'dispatchOutboxHash'),
      dispatchReplayGuardHash: chainHash(chain, 'dispatchReplayGuardHash'),
      dispatchArchiveHash: chainHash(chain, 'dispatchArchiveHash'),
      dispatchLedgerHash: chainHash(chain, 'dispatchLedgerHash'),
      usesInboxChain: chain?.usesInboxChain === true,
      usesStandardInboxChain: chain?.usesStandardInboxChain === true,
      usesDispatchInboxChain: chain?.usesDispatchInboxChain === true,
    },
    lineage: buildLineage(chain, ledgerHash, includeCommandPreview),
    blockers,
    warnings: [
      issue('audit_bundle_verifies_only', 'Audit bundles are redacted records and never execute adapter actions.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      auditBundleOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      requiresVerifiedLedger: true,
      requiresInboxChain: requireInboxChain === true,
      usesStandardInboxChain: chain?.usesStandardInboxChain === true,
      usesDispatchInboxChain: chain?.usesDispatchInboxChain === true,
      includesCommandPreview: includeCommandPreview === true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const bundleHash = computeExternalActionAuditBundleHash(bundle);

  return {
    ...bundle,
    bundleHash,
    hash: bundleHash,
  };
}

export function summarizeExternalActionAuditBundles(bundles = []) {
  const byStatus = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  for (const bundle of bundles || []) {
    byStatus[bundle.status] = (byStatus[bundle.status] || 0) + 1;
    const channelId = bundle.channelId || 'unknown';
    byChannel[channelId] = (byChannel[channelId] || 0) + 1;
    const actionId = bundle.actionId || 'unknown';
    byActionId[actionId] = (byActionId[actionId] || 0) + 1;
    for (const blocker of bundle.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: EXTERNAL_ACTION_AUDIT_BUNDLE_VERSION,
    count: bundles.length,
    byStatus,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      auditBundleOnly: true,
      executesExternalAction: bundles.some((bundle) => bundle.safety?.executesExternalAction === true),
      appliesLocalStateTransition: bundles.some((bundle) => bundle.safety?.appliesLocalStateTransition === true),
    },
  };
}
