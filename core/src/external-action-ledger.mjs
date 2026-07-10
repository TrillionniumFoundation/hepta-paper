import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  computeCustomerMessagePreviewHash,
  computeCustomerMessagePreviewHashFromFields,
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
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, computeAdapterRunReceiptHash } from './adapter-receipt.mjs';
import {
  ADAPTER_RECEIPT_INBOX_STATUS,
  ADAPTER_RECEIPT_NEXT_STEP,
  computeAdapterReceiptInboxHash,
} from './adapter-receipt-inbox.mjs';
import {
  CHANNEL_STATE_PROOF_STATUS,
  RECEIPT_TRANSITION_STATUS,
  computeChannelStateProofHash,
  computeReceiptStateTransitionHash,
} from './channel-state-proof.mjs';
import {
  CHANNEL_STATE_PROOF_INBOX_STATUS,
  CHANNEL_STATE_PROOF_NEXT_STEP,
  computeChannelStateProofInboxHash,
} from './channel-state-proof-inbox.mjs';
import {
  RECEIPT_STATE_TRANSITION_INBOX_STATUS,
  RECEIPT_STATE_TRANSITION_NEXT_STEP,
  computeReceiptStateTransitionInboxHash,
} from './receipt-state-transition-inbox.mjs';
import {
  ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS,
  ADAPTER_DISPATCH_RECEIPT_NEXT_STEP,
  computeAdapterDispatchReceiptInboxHash,
} from './adapter-dispatch-receipt-inbox.mjs';
import {
  ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS,
  ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP,
  computeAdapterDispatchChannelStateProofInboxHash,
} from './adapter-dispatch-channel-state-proof-inbox.mjs';
import {
  ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS,
  ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP,
  computeAdapterDispatchReceiptStateTransitionInboxHash,
} from './adapter-dispatch-receipt-state-transition-inbox.mjs';
import { handoffSnapshotIdentityMismatches } from './handoff-snapshot-identity.mjs';
import { digest } from './hash-utils.mjs';

export const EXTERNAL_ACTION_LEDGER_VERSION = 1;

export const EXTERNAL_ACTION_LEDGER_STATUS = Object.freeze({
  VERIFIED: 'verified_action_ledger',
  PENDING_RUNNER_RECEIPT: 'pending_runner_receipt',
  PENDING_CHANNEL_PROOF: 'pending_channel_state_proof',
  PENDING_STATE_TRANSITION: 'pending_state_transition',
  BLOCKED: 'blocked_action_ledger',
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

function transitionHash(transition) {
  if (!transition) return null;
  return hashOf(transition, 'transitionHash');
}

function receiptContentHashBlockers(receipt) {
  const blockers = [];
  if (!receipt || receipt.kind !== 'AdapterRunReceipt') return blockers;
  blockers.push(...hashAliasBlockers(receipt, 'receiptHash', {
    semanticMissingCode: 'receipt_hash_alias_required',
    genericMissingCode: 'receipt_generic_hash_required',
    mismatchCode: 'receipt_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(receipt, 'receiptHash');
  const recomputedHash = computeAdapterRunReceiptHash(receipt);
  if (!recordedHash) blockers.push(issue('receipt_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('receipt_hash_content_mismatch'));
  }
  return blockers;
}

function proofContentHashBlockers(proof) {
  const blockers = [];
  if (!proof || proof.kind !== 'ChannelStateProof') return blockers;
  blockers.push(...hashAliasBlockers(proof, 'proofHash', {
    semanticMissingCode: 'proof_hash_alias_required',
    genericMissingCode: 'proof_generic_hash_required',
    mismatchCode: 'proof_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(proof, 'proofHash');
  const recomputedHash = computeChannelStateProofHash(proof);
  if (!recordedHash) blockers.push(issue('proof_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('proof_hash_content_mismatch'));
  }
  return blockers;
}

function transitionContentHashBlockers(transition) {
  const blockers = [];
  if (!transition || transition.kind !== 'ReceiptStateTransition') return blockers;
  blockers.push(...hashAliasBlockers(transition, 'transitionHash', {
    semanticMissingCode: 'transition_hash_alias_required',
    genericMissingCode: 'transition_generic_hash_required',
    mismatchCode: 'transition_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(transition, 'transitionHash');
  const recomputedHash = computeReceiptStateTransitionHash(transition);
  if (!recordedHash) blockers.push(issue('transition_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('transition_hash_content_mismatch'));
  }
  return blockers;
}

function dispatchReceiptInboxContentHashBlockers(item) {
  const blockers = [];
  if (!item || item.kind !== 'AdapterDispatchReceiptInboxItem') return blockers;
  blockers.push(...hashAliasBlockers(item, 'inboxHash', {
    semanticMissingCode: 'dispatch_receipt_inbox_hash_alias_required',
    genericMissingCode: 'dispatch_receipt_inbox_generic_hash_required',
    mismatchCode: 'dispatch_receipt_inbox_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(item, 'inboxHash');
  const recomputedHash = computeAdapterDispatchReceiptInboxHash(item);
  if (!recordedHash) blockers.push(issue('dispatch_receipt_inbox_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('dispatch_receipt_inbox_hash_content_mismatch'));
  }
  return blockers;
}

function dispatchProofInboxContentHashBlockers(item) {
  const blockers = [];
  if (!item || item.kind !== 'AdapterDispatchChannelStateProofInboxItem') return blockers;
  blockers.push(...hashAliasBlockers(item, 'proofInboxHash', {
    semanticMissingCode: 'dispatch_proof_inbox_hash_alias_required',
    genericMissingCode: 'dispatch_proof_inbox_generic_hash_required',
    mismatchCode: 'dispatch_proof_inbox_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(item, 'proofInboxHash');
  const recomputedHash = computeAdapterDispatchChannelStateProofInboxHash(item);
  if (!recordedHash) blockers.push(issue('dispatch_proof_inbox_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('dispatch_proof_inbox_hash_content_mismatch'));
  }
  return blockers;
}

function dispatchTransitionInboxContentHashBlockers(item) {
  const blockers = [];
  if (!item || item.kind !== 'AdapterDispatchReceiptStateTransitionInboxItem') return blockers;
  blockers.push(...hashAliasBlockers(item, 'transitionInboxHash', {
    semanticMissingCode: 'dispatch_transition_inbox_hash_alias_required',
    genericMissingCode: 'dispatch_transition_inbox_generic_hash_required',
    mismatchCode: 'dispatch_transition_inbox_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(item, 'transitionInboxHash');
  const recomputedHash = computeAdapterDispatchReceiptStateTransitionInboxHash(item);
  if (!recordedHash) blockers.push(issue('dispatch_transition_inbox_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('dispatch_transition_inbox_hash_content_mismatch'));
  }
  return blockers;
}

function receiptInboxContentHashBlockers(item) {
  const blockers = [];
  if (!item || item.kind !== 'AdapterReceiptInboxItem') return blockers;
  blockers.push(...hashAliasBlockers(item, 'inboxHash', {
    semanticMissingCode: 'receipt_inbox_hash_alias_required',
    genericMissingCode: 'receipt_inbox_generic_hash_required',
    mismatchCode: 'receipt_inbox_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(item, 'inboxHash');
  const recomputedHash = computeAdapterReceiptInboxHash(item);
  if (!recordedHash) blockers.push(issue('receipt_inbox_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('receipt_inbox_hash_content_mismatch'));
  }
  return blockers;
}

function proofInboxContentHashBlockers(item) {
  const blockers = [];
  if (!item || item.kind !== 'ChannelStateProofInboxItem') return blockers;
  blockers.push(...hashAliasBlockers(item, 'proofInboxHash', {
    semanticMissingCode: 'proof_inbox_hash_alias_required',
    genericMissingCode: 'proof_inbox_generic_hash_required',
    mismatchCode: 'proof_inbox_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(item, 'proofInboxHash');
  const recomputedHash = computeChannelStateProofInboxHash(item);
  if (!recordedHash) blockers.push(issue('proof_inbox_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('proof_inbox_hash_content_mismatch'));
  }
  return blockers;
}

function transitionInboxContentHashBlockers(item) {
  const blockers = [];
  if (!item || item.kind !== 'ReceiptStateTransitionInboxItem') return blockers;
  blockers.push(...hashAliasBlockers(item, 'transitionInboxHash', {
    semanticMissingCode: 'transition_inbox_hash_alias_required',
    genericMissingCode: 'transition_inbox_generic_hash_required',
    mismatchCode: 'transition_inbox_hash_alias_mismatch',
  }));
  const recordedHash = hashOf(item, 'transitionInboxHash');
  const recomputedHash = computeReceiptStateTransitionInboxHash(item);
  if (!recordedHash) blockers.push(issue('transition_inbox_hash_required'));
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('transition_inbox_hash_content_mismatch'));
  }
  return blockers;
}

function propagateBlockers(source, blockers) {
  for (const blocker of source?.blockers || []) {
    if (!blockers.some((item) => item.code === blocker.code)) {
      blockers.push(issue(blocker.code, blocker.notes || null, blocker.level || 'error'));
    }
  }
}

function artifactNames(manifest, preview, receipt, proof) {
  return uniqueStrings([
    ...(manifest?.payload?.artifactNames || []),
    ...(preview?.payload?.artifactNames || []),
    ...(receipt?.payload?.artifactNames || []),
    ...(proof?.payload?.artifactNames || []),
  ], 128);
}

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value || '');
    if (normalized) return normalized;
  }
  return null;
}

function ledgerHashPayload(payload = null) {
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

function computedMessagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function rawMessagePreviewContentHash(value = null) {
  return computeCustomerMessagePreviewHashFromFields(value);
}

function humanFeedbackRevisionContractHash(manifest, preview, receipt, proof) {
  return firstText(
    preview?.payload?.humanFeedbackRevisionContractHash,
    manifest?.payload?.humanFeedbackRevisionContractHash,
    receipt?.payload?.humanFeedbackRevisionContractHash,
    proof?.payload?.humanFeedbackRevisionContractHash,
    receipt?.result?.external?.humanFeedbackRevisionContractHash,
    receipt?.result?.external?.feedbackRevisionContractHash,
    receipt?.result?.external?.humanFeedbackContractHash,
    proof?.evidence?.humanFeedbackRevisionContractHash,
    proof?.evidence?.feedbackRevisionContractHash,
    proof?.evidence?.humanFeedbackContractHash,
  );
}

function approvalProvenanceHashFrom(value = null) {
  return firstText(
    value?.payload?.approvalProvenanceHash,
    value?.hashBinding?.approvalProvenanceHash,
    value?.runner?.requiredHashes?.approvalProvenanceHash,
    value?.adapter?.requiredHashes?.approvalProvenanceHash,
    value?.chain?.approvalProvenanceHash,
  );
}

function approvalProvenanceHashFromSources(...values) {
  return values.map((value) => approvalProvenanceHashFrom(value)).find(Boolean) || null;
}

function approvalProvenanceHashContinuityBlockers(sources = []) {
  const presentSources = sources.filter(([, value]) => value);
  if (!presentSources.length) return [];
  const expected = approvalProvenanceHashFromSources(...presentSources.map(([, value]) => value));
  if (!expected) return [issue('ledger_approval_provenance_hash_required')];
  const blockers = [];
  for (const [name, value] of presentSources) {
    const actual = approvalProvenanceHashFrom(value);
    if (!actual) {
      blockers.push(issue(`${name}_approval_provenance_hash_missing`));
    } else if (actual !== expected) {
      blockers.push(issue(`${name}_approval_provenance_hash_mismatch`));
    }
  }
  return blockers;
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => normalizeText(left[key] || '') === normalizeText(right[key] || ''));
}

function isPromptGenerationSpendAction(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function sourceCarriesPromptGenerationSpend(value = null) {
  return [
    value?.action,
    value?.actionId,
    value?.payload?.action,
    value?.result?.decision?.action,
    value?.result?.external?.action,
  ].some((action) => isPromptGenerationSpendAction(action));
}

function promptGenerationBindingFrom(value = null) {
  return value?.hashBinding?.promptGenerationBinding
    || value?.payload?.promptGenerationBinding
    || value?.runner?.requiredHashes?.promptGenerationBinding
    || value?.adapter?.requiredHashes?.promptGenerationBinding
    || value?.evidence?.promptGenerationBinding
    || value?.result?.external?.promptGenerationBinding
    || value?.chain?.promptGenerationBinding
    || null;
}

function promptGenerationBindingFromSources(...values) {
  return values.map((value) => promptGenerationBindingFrom(value)).find(Boolean) || null;
}

function promptGenerationBindingEntries(name, value = null) {
  const kind = value?.kind || '';
  const entry = (source, binding, required = true) => ({
    source,
    binding: binding || null,
    required,
    missingCode: `${name}_${source}_prompt_generation_binding_missing`,
    incompleteCode: `${name}_${source}_prompt_generation_binding_incomplete`,
    mismatchCode: `${name}_${source}_prompt_generation_binding_mismatch`,
  });
  if (kind === 'ChannelActionManifest') {
    return [entry('payload', value?.payload?.promptGenerationBinding)];
  }
  if (kind === 'AdapterRunPreview') {
    return [
      entry('payload', value?.payload?.promptGenerationBinding),
      entry('adapter_required_hashes', value?.adapter?.requiredHashes?.promptGenerationBinding),
    ];
  }
  if (kind === 'AdapterRunReceipt') {
    return [
      entry('hash_binding', value?.hashBinding?.promptGenerationBinding),
      entry('payload', value?.payload?.promptGenerationBinding),
      entry('external', value?.result?.external?.promptGenerationBinding, false),
    ];
  }
  if (kind === 'ChannelStateProof') {
    return [
      entry('hash_binding', value?.hashBinding?.promptGenerationBinding),
      entry('payload', value?.payload?.promptGenerationBinding),
      entry('evidence', value?.evidence?.promptGenerationBinding),
    ];
  }
  if (kind === 'ReceiptStateTransition') {
    return [entry('hash_binding', value?.hashBinding?.promptGenerationBinding)];
  }
  if (kind.endsWith('InboxItem')) {
    return [entry('hash_binding', value?.hashBinding?.promptGenerationBinding)];
  }
  return [
    entry('hash_binding', value?.hashBinding?.promptGenerationBinding, false),
    entry('payload', value?.payload?.promptGenerationBinding, false),
    entry('runner_required_hashes', value?.runner?.requiredHashes?.promptGenerationBinding, false),
    entry('adapter_required_hashes', value?.adapter?.requiredHashes?.promptGenerationBinding, false),
    entry('evidence', value?.evidence?.promptGenerationBinding, false),
    entry('external', value?.result?.external?.promptGenerationBinding, false),
    entry('chain', value?.chain?.promptGenerationBinding, false),
  ].filter((item) => item.binding);
}

function promptGenerationBindingContinuityBlockers(sources = []) {
  const presentSources = sources.filter(([, value]) => value);
  const expected = promptGenerationBindingFromSources(...presentSources.map(([, value]) => value));
  if (!expected) {
    return presentSources.some(([, value]) => sourceCarriesPromptGenerationSpend(value))
      ? [issue('ledger_prompt_generation_binding_required')]
      : [];
  }
  const blockers = [];
  const missingExpectedKeys = PROMPT_GENERATION_BINDING_KEYS.filter((key) => !normalizeText(expected?.[key] || ''));
  if (missingExpectedKeys.length) {
    blockers.push(issue('ledger_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
  }
  for (const [name, value] of presentSources) {
    const actual = promptGenerationBindingFrom(value);
    if (!actual) {
      blockers.push(issue(`${name}_prompt_generation_binding_missing`));
    } else if (!samePromptGenerationBinding(expected, actual)) {
      blockers.push(issue(`${name}_prompt_generation_binding_mismatch`));
    }
    for (const entry of promptGenerationBindingEntries(name, value)) {
      if (!entry.binding) {
        if (entry.required) blockers.push(issue(entry.missingCode));
        continue;
      }
      const missingKeys = PROMPT_GENERATION_BINDING_KEYS
        .filter((key) => !normalizeText(entry.binding?.[key] || ''));
      if (missingKeys.length) {
        blockers.push(issue(entry.incompleteCode, missingKeys.join(', ')));
      } else if (!samePromptGenerationBinding(expected, entry.binding)) {
        blockers.push(issue(entry.mismatchCode));
      }
    }
  }
  return blockers;
}

function messagePreviewHash(manifest, preview, receipt, proof) {
  return firstText(
    preview?.payload?.messagePreviewHash,
    manifest?.payload?.messagePreviewHash,
    receipt?.payload?.messagePreviewHash,
    proof?.payload?.messagePreviewHash,
    receipt?.result?.external?.messagePreviewHash,
    receipt?.result?.external?.previewHash,
    proof?.evidence?.messagePreviewHash,
    proof?.evidence?.previewHash,
  );
}

function customerMessageSemanticBlockers({ manifest, preview, receipt, proof }) {
  const blockers = [];
  const action = canonicalExternalAction(preview?.payload?.action || manifest?.action || receipt?.action || proof?.action || null);
  const expectedContractHash = firstText(
    preview?.payload?.humanFeedbackRevisionContractHash,
    manifest?.payload?.humanFeedbackRevisionContractHash,
  );
  const customerMessageAction = action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
  const humanFeedbackAction = Boolean(expectedContractHash && isHumanFeedbackCustomerFacingAction(action));
  if (!customerMessageAction && !humanFeedbackAction) return blockers;

  const manifestMessagePreviewHash = firstText(manifest?.payload?.messagePreviewHash);
  const previewMessagePreviewHash = firstText(preview?.payload?.messagePreviewHash);
  const expectedMessagePreviewHash = firstText(previewMessagePreviewHash, manifestMessagePreviewHash);
  const successReceipt = receipt?.result?.status === ADAPTER_RESULT_STATUS.SUCCESS;
  const manifestMessagePreviewContentHash = computedMessagePreviewHash(manifest?.payload?.messagePreview);
  const previewMessagePreviewContentHash = computedMessagePreviewHash(preview?.payload?.messagePreview);

  if (customerMessageAction && expectedMessagePreviewHash) {
    const receiptPayloadHash = firstText(receipt?.payload?.messagePreviewHash);
    const receiptExternalHash = firstText(receipt?.result?.external?.messagePreviewHash, receipt?.result?.external?.previewHash);
    const receiptPayloadContentHash = computedMessagePreviewHash(receipt?.payload?.messagePreview);
    const receiptExternalStoredContentHash = firstText(receipt?.result?.external?.messagePreviewContentHash);
    const receiptExternalRawContentHash = rawMessagePreviewContentHash(receipt?.result?.external);
    const receiptExternalContentHash = firstText(receiptExternalRawContentHash, receiptExternalStoredContentHash);
    const proofPayloadHash = firstText(proof?.payload?.messagePreviewHash);
    const proofEvidenceHash = firstText(proof?.evidence?.messagePreviewHash, proof?.evidence?.previewHash);
    const proofEvidenceStoredContentHash = firstText(proof?.evidence?.messagePreviewContentHash);
    const proofEvidenceRawContentHash = rawMessagePreviewContentHash(proof?.evidence);
    const proofEvidenceContentHash = firstText(proofEvidenceRawContentHash, proofEvidenceStoredContentHash);

    if (manifest && !manifestMessagePreviewContentHash) blockers.push(issue('manifest_message_preview_required'));
    if (manifestMessagePreviewContentHash && manifestMessagePreviewHash && manifestMessagePreviewContentHash !== manifestMessagePreviewHash) {
      blockers.push(issue('manifest_message_preview_hash_mismatch'));
    }
    if (preview && !previewMessagePreviewContentHash) blockers.push(issue('preview_message_preview_required'));
    if (previewMessagePreviewContentHash && previewMessagePreviewHash && previewMessagePreviewContentHash !== previewMessagePreviewHash) {
      blockers.push(issue('preview_message_preview_hash_mismatch'));
    }
    if (manifestMessagePreviewHash && previewMessagePreviewHash && manifestMessagePreviewHash !== previewMessagePreviewHash) {
      blockers.push(issue('preview_manifest_message_preview_hash_mismatch'));
    }
    if (receipt && !receiptPayloadContentHash) blockers.push(issue('receipt_message_preview_required'));
    if (receipt && !receiptPayloadHash) blockers.push(issue('receipt_message_preview_hash_required'));
    if (receiptPayloadContentHash && receiptPayloadHash && receiptPayloadContentHash !== receiptPayloadHash) {
      blockers.push(issue('receipt_message_preview_hash_content_mismatch'));
    }
    if (receiptPayloadHash && receiptPayloadHash !== expectedMessagePreviewHash) blockers.push(issue('receipt_message_preview_hash_mismatch'));
    if (receipt && successReceipt && !receiptExternalHash) blockers.push(issue('receipt_external_message_preview_hash_required'));
    if (
      receiptExternalRawContentHash
      && receiptExternalStoredContentHash
      && receiptExternalRawContentHash !== receiptExternalStoredContentHash
    ) {
      blockers.push(issue('receipt_external_message_preview_hash_content_mismatch'));
    }
    if (receiptExternalContentHash && receiptExternalHash && receiptExternalContentHash !== receiptExternalHash) {
      blockers.push(issue('receipt_external_message_preview_hash_content_mismatch'));
    }
    if (receiptExternalHash && receiptExternalHash !== expectedMessagePreviewHash) blockers.push(issue('receipt_external_message_preview_hash_mismatch'));
    if (proof && !proofPayloadHash) blockers.push(issue('proof_message_preview_hash_required'));
    if (proofPayloadHash && proofPayloadHash !== expectedMessagePreviewHash) blockers.push(issue('proof_message_preview_hash_mismatch'));
    if (proof && !proofEvidenceHash) blockers.push(issue('proof_evidence_message_preview_hash_required'));
    if (
      proofEvidenceRawContentHash
      && proofEvidenceStoredContentHash
      && proofEvidenceRawContentHash !== proofEvidenceStoredContentHash
    ) {
      blockers.push(issue('proof_evidence_message_preview_hash_content_mismatch'));
    }
    if (proofEvidenceContentHash && proofEvidenceHash && proofEvidenceContentHash !== proofEvidenceHash) {
      blockers.push(issue('proof_evidence_message_preview_hash_content_mismatch'));
    }
    if (proofEvidenceHash && proofEvidenceHash !== expectedMessagePreviewHash) blockers.push(issue('proof_evidence_message_preview_hash_mismatch'));
  }

  if (humanFeedbackAction && expectedContractHash) {
    const receiptPayloadHash = firstText(receipt?.payload?.humanFeedbackRevisionContractHash);
    const receiptExternalHash = firstText(
      receipt?.result?.external?.humanFeedbackRevisionContractHash,
      receipt?.result?.external?.feedbackRevisionContractHash,
      receipt?.result?.external?.humanFeedbackContractHash,
    );
    const proofPayloadHash = firstText(proof?.payload?.humanFeedbackRevisionContractHash);
    const proofEvidenceHash = firstText(
      proof?.evidence?.humanFeedbackRevisionContractHash,
      proof?.evidence?.feedbackRevisionContractHash,
      proof?.evidence?.humanFeedbackContractHash,
    );

    if (receipt && !receiptPayloadHash) blockers.push(issue('receipt_human_feedback_contract_hash_required'));
    if (receiptPayloadHash && receiptPayloadHash !== expectedContractHash) blockers.push(issue('receipt_human_feedback_contract_hash_mismatch'));
    if (receipt && successReceipt && !receiptExternalHash) blockers.push(issue('receipt_external_human_feedback_contract_hash_required'));
    if (receiptExternalHash && receiptExternalHash !== expectedContractHash) blockers.push(issue('receipt_external_human_feedback_contract_hash_mismatch'));
    if (proof && !proofPayloadHash) blockers.push(issue('proof_human_feedback_contract_hash_required'));
    if (proofPayloadHash && proofPayloadHash !== expectedContractHash) blockers.push(issue('proof_human_feedback_contract_hash_mismatch'));
    if (proof && !proofEvidenceHash) blockers.push(issue('proof_evidence_human_feedback_contract_hash_required'));
    if (proofEvidenceHash && proofEvidenceHash !== expectedContractHash) blockers.push(issue('proof_evidence_human_feedback_contract_hash_mismatch'));
  }

  return blockers;
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
    ? [issue('ledger_handoff_snapshot_identity_mismatch', mismatches.slice(0, 8).join('; '))]
    : [];
}

function statusFrom({ blockers, receipt, proof, transition }) {
  if (blockers.length) return EXTERNAL_ACTION_LEDGER_STATUS.BLOCKED;
  if (!receipt) return EXTERNAL_ACTION_LEDGER_STATUS.PENDING_RUNNER_RECEIPT;
  if (!proof) return EXTERNAL_ACTION_LEDGER_STATUS.PENDING_CHANNEL_PROOF;
  if (!transition) return EXTERNAL_ACTION_LEDGER_STATUS.PENDING_STATE_TRANSITION;
  return EXTERNAL_ACTION_LEDGER_STATUS.VERIFIED;
}

function inboxChainBlockers({
  receiptInboxItem,
  proofInboxItem,
  transitionInboxItem,
  receipt,
  proof,
  transition,
}) {
  const blockers = [];
  const chainContext = {
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    receipt,
    proof,
    transition,
  };
  const expectedMessagePreviewHash = messagePreviewHash(null, null, receipt, proof);
  const expectedHumanFeedbackContractHash = humanFeedbackRevisionContractHash(null, null, receipt, proof);

  if (receiptInboxItem) {
    if (receiptInboxItem.kind !== 'AdapterReceiptInboxItem') blockers.push(issue('invalid_receipt_inbox_kind'));
    blockers.push(...receiptInboxContentHashBlockers(receiptInboxItem));
    if (receiptInboxItem.status !== ADAPTER_RECEIPT_INBOX_STATUS.RECEIVED || receiptInboxItem.received !== true) {
      blockers.push(issue('receipt_inbox_not_received'));
    }
    if (receiptInboxItem.nextStep !== ADAPTER_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED) {
      blockers.push(issue('receipt_inbox_not_waiting_for_proof'));
    }
    if (receiptInboxItem.status !== ADAPTER_RECEIPT_INBOX_STATUS.RECEIVED || receiptInboxItem.received !== true) {
      propagateBlockers(receiptInboxItem, blockers);
    }
    requireBindingHashes(receiptInboxItem, [
      ['receiptHash', 'receipt_inbox_receipt_hash_missing'],
    ], blockers);
    const receiptHash = hashOf(receipt, 'receiptHash');
    compareRequiredHash(
      receiptHash,
      receiptInboxItem.hashBinding?.receiptHash,
      'receipt_inbox_receipt_hash_missing',
      'receipt_inbox_receipt_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.platformStateSnapshotHash,
      receiptInboxItem.hashBinding?.platformStateSnapshotHash,
      'receipt_inbox_platform_state_snapshot_hash_missing',
      'receipt_inbox_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.dryRunReplayHash,
      receiptInboxItem.hashBinding?.dryRunReplayHash,
      'receipt_inbox_dry_run_replay_hash_missing',
      'receipt_inbox_dry_run_replay_hash_mismatch',
      blockers,
    );
    if (chainCarriesCustomerMessage(chainContext) && !receiptInboxItem.hashBinding?.messagePreviewHash) {
      blockers.push(issue('receipt_inbox_message_preview_hash_missing'));
    }
    if (chainCarriesHumanFeedbackContract(chainContext) && !receiptInboxItem.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('receipt_inbox_human_feedback_contract_hash_missing'));
    }
    compareRequiredHash(
      expectedMessagePreviewHash,
      receiptInboxItem.hashBinding?.messagePreviewHash,
      'receipt_inbox_message_preview_hash_missing',
      'receipt_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedHumanFeedbackContractHash,
      receiptInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      'receipt_inbox_human_feedback_contract_hash_missing',
      'receipt_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
  }

  if (proofInboxItem) {
    if (!receiptInboxItem) blockers.push(issue('proof_inbox_without_receipt_inbox'));
    if (proofInboxItem.kind !== 'ChannelStateProofInboxItem') blockers.push(issue('invalid_proof_inbox_kind'));
    blockers.push(...proofInboxContentHashBlockers(proofInboxItem));
    if (proofInboxItem.status !== CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED || proofInboxItem.received !== true) {
      blockers.push(issue('proof_inbox_not_received'));
    }
    if (proofInboxItem.nextStep !== CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY) {
      blockers.push(issue('proof_inbox_not_ready_for_transition'));
    }
    if (proofInboxItem.status !== CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED || proofInboxItem.received !== true) {
      propagateBlockers(proofInboxItem, blockers);
    }
    requireBindingHashes(proofInboxItem, [
      ['receiptInboxHash', 'proof_inbox_receipt_inbox_hash_missing'],
      ['receiptHash', 'proof_inbox_receipt_hash_missing'],
      ['proofHash', 'proof_inbox_proof_hash_missing'],
    ], blockers);
    const receiptInboxHash = hashOf(receiptInboxItem, 'inboxHash');
    compareRequiredHash(
      receiptInboxHash,
      proofInboxItem.hashBinding?.receiptInboxHash,
      'proof_inbox_receipt_inbox_hash_missing',
      'proof_inbox_receipt_inbox_hash_mismatch',
      blockers,
    );
    const receiptHash = receiptInboxItem?.hashBinding?.receiptHash || hashOf(receipt, 'receiptHash');
    compareRequiredHash(
      receiptHash,
      proofInboxItem.hashBinding?.receiptHash,
      'proof_inbox_receipt_hash_missing',
      'proof_inbox_receipt_hash_mismatch',
      blockers,
    );
    const proofHash = hashOf(proof, 'proofHash');
    compareRequiredHash(
      proofHash,
      proofInboxItem.hashBinding?.proofHash,
      'proof_inbox_proof_hash_missing',
      'proof_inbox_proof_hash_mismatch',
      blockers,
    );
    if (chainCarriesCustomerMessage(chainContext) && !proofInboxItem.hashBinding?.messagePreviewHash) {
      blockers.push(issue('proof_inbox_message_preview_hash_missing'));
    }
    if (chainCarriesHumanFeedbackContract(chainContext) && !proofInboxItem.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('proof_inbox_human_feedback_contract_hash_missing'));
    }
    compareHash(
      proofInboxItem.hashBinding?.messagePreviewHash,
      receiptInboxItem?.hashBinding?.messagePreviewHash,
      'proof_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareHash(
      proofInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
      'proof_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedMessagePreviewHash,
      proofInboxItem.hashBinding?.messagePreviewHash,
      'proof_inbox_message_preview_hash_missing',
      'proof_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedHumanFeedbackContractHash,
      proofInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      'proof_inbox_human_feedback_contract_hash_missing',
      'proof_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receiptInboxItem?.hashBinding?.platformStateSnapshotHash || receipt?.hashBinding?.platformStateSnapshotHash,
      proofInboxItem.hashBinding?.platformStateSnapshotHash,
      'proof_inbox_platform_state_snapshot_hash_missing',
      'proof_inbox_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receiptInboxItem?.hashBinding?.dryRunReplayHash || receipt?.hashBinding?.dryRunReplayHash,
      proofInboxItem.hashBinding?.dryRunReplayHash,
      'proof_inbox_dry_run_replay_hash_missing',
      'proof_inbox_dry_run_replay_hash_mismatch',
      blockers,
    );
  }

  if (transitionInboxItem) {
    if (!proofInboxItem) blockers.push(issue('transition_inbox_without_proof_inbox'));
    if (transitionInboxItem.kind !== 'ReceiptStateTransitionInboxItem') blockers.push(issue('invalid_transition_inbox_kind'));
    blockers.push(...transitionInboxContentHashBlockers(transitionInboxItem));
    if (transitionInboxItem.status !== RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED || transitionInboxItem.received !== true) {
      blockers.push(issue('transition_inbox_not_received'));
    }
    if (transitionInboxItem.nextStep !== RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY) {
      blockers.push(issue('transition_inbox_not_ready_for_ledger'));
    }
    if (transitionInboxItem.status !== RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED || transitionInboxItem.received !== true) {
      propagateBlockers(transitionInboxItem, blockers);
    }
    const proofInboxHash = hashOf(proofInboxItem, 'proofInboxHash');
    compareRequiredHash(
      proofInboxHash,
      transitionInboxItem.hashBinding?.proofInboxHash,
      'transition_inbox_proof_inbox_hash_missing',
      'transition_inbox_proof_inbox_hash_mismatch',
      blockers,
    );
    const receiptInboxHash = proofInboxItem?.hashBinding?.receiptInboxHash || hashOf(receiptInboxItem, 'inboxHash');
    compareRequiredHash(
      receiptInboxHash,
      transitionInboxItem.hashBinding?.receiptInboxHash,
      'transition_inbox_receipt_inbox_hash_missing',
      'transition_inbox_receipt_inbox_hash_mismatch',
      blockers,
    );
    const receiptHash = proofInboxItem?.hashBinding?.receiptHash || receiptInboxItem?.hashBinding?.receiptHash || hashOf(receipt, 'receiptHash');
    compareRequiredHash(
      receiptHash,
      transitionInboxItem.hashBinding?.receiptHash,
      'transition_inbox_receipt_hash_missing',
      'transition_inbox_receipt_hash_mismatch',
      blockers,
    );
    const proofHash = proofInboxItem?.hashBinding?.proofHash || hashOf(proof, 'proofHash');
    compareRequiredHash(
      proofHash,
      transitionInboxItem.hashBinding?.proofHash,
      'transition_inbox_proof_hash_missing',
      'transition_inbox_proof_hash_mismatch',
      blockers,
    );
    const expectedTransitionHash = transitionHash(transition);
    compareRequiredHash(
      expectedTransitionHash,
      transitionInboxItem.hashBinding?.transitionHash,
      'transition_inbox_transition_hash_missing',
      'transition_inbox_transition_hash_mismatch',
      blockers,
    );
    if (chainCarriesCustomerMessage(chainContext) && !transitionInboxItem.hashBinding?.messagePreviewHash) {
      blockers.push(issue('transition_inbox_message_preview_hash_missing'));
    }
    if (chainCarriesHumanFeedbackContract(chainContext) && !transitionInboxItem.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('transition_inbox_human_feedback_contract_hash_missing'));
    }
    compareHash(
      transitionInboxItem.hashBinding?.messagePreviewHash,
      proofInboxItem?.hashBinding?.messagePreviewHash,
      'transition_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareHash(
      transitionInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
      'transition_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedMessagePreviewHash,
      transitionInboxItem.hashBinding?.messagePreviewHash,
      'transition_inbox_message_preview_hash_missing',
      'transition_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedHumanFeedbackContractHash,
      transitionInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      'transition_inbox_human_feedback_contract_hash_missing',
      'transition_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proofInboxItem?.hashBinding?.platformStateSnapshotHash || proof?.hashBinding?.platformStateSnapshotHash,
      transitionInboxItem.hashBinding?.platformStateSnapshotHash,
      'transition_inbox_platform_state_snapshot_hash_missing',
      'transition_inbox_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proofInboxItem?.hashBinding?.dryRunReplayHash || proof?.hashBinding?.dryRunReplayHash,
      transitionInboxItem.hashBinding?.dryRunReplayHash,
      'transition_inbox_dry_run_replay_hash_missing',
      'transition_inbox_dry_run_replay_hash_mismatch',
      blockers,
    );
  }

  return blockers;
}

function compareHash(left, right, code, blockers) {
  const normalizedLeft = normalizeText(left || '');
  const normalizedRight = normalizeText(right || '');
  if (!normalizedLeft) return;
  if (!normalizedRight) {
    blockers.push(issue(code));
    return;
  }
  if (normalizedLeft !== normalizedRight) blockers.push(issue(code));
}

function compareRequiredHash(expected, actual, missingCode, mismatchCode, blockers) {
  const normalizedExpected = normalizeText(expected || '');
  const normalizedActual = normalizeText(actual || '');
  if (!normalizedExpected) return;
  if (!normalizedActual) {
    blockers.push(issue(missingCode));
    return;
  }
  if (normalizedExpected !== normalizedActual) blockers.push(issue(mismatchCode));
}

function requireHash(actual, missingCode, blockers) {
  if (!normalizeText(actual || '')) blockers.push(issue(missingCode));
}

function requireBindingHashes(value, bindings, blockers) {
  for (const [key, code] of bindings) {
    requireHash(value?.hashBinding?.[key], code, blockers);
  }
}

function compareRequiredBindingHash(expected, actual, missingCode, mismatchCode, blockers) {
  const normalizedExpected = normalizeText(expected || '');
  const normalizedActual = normalizeText(actual || '');
  if (!normalizedActual) {
    blockers.push(issue(missingCode));
    return;
  }
  if (normalizedExpected && normalizedExpected !== normalizedActual) blockers.push(issue(mismatchCode));
}

function compareRequiredField(expected, actual, missingCode, mismatchCode, blockers) {
  const normalizedExpected = normalizeText(expected || '');
  const normalizedActual = normalizeText(actual || '');
  if (!normalizedExpected) return;
  if (!normalizedActual) {
    blockers.push(issue(missingCode));
    return;
  }
  if (normalizedExpected !== normalizedActual) blockers.push(issue(mismatchCode));
}

function compareRequiredAction(expected, actual, missingCode, mismatchCode, blockers) {
  const normalizedExpected = normalizeText(expected || '');
  const normalizedActual = normalizeText(actual || '');
  if (!normalizedExpected) return;
  if (!normalizedActual) {
    blockers.push(issue(missingCode));
    return;
  }
  if (canonicalExternalAction(normalizedExpected) !== canonicalExternalAction(normalizedActual)) {
    blockers.push(issue(mismatchCode));
  }
}

function requiredReceiptHash(receipt, key) {
  return firstText(
    receipt?.hashBinding?.[key],
    receipt?.payload?.[key],
    receipt?.result?.external?.[key],
  );
}

function requiredProofHash(proof, key) {
  return firstText(
    proof?.hashBinding?.[key],
    proof?.payload?.[key],
    proof?.evidence?.[key],
  );
}

function requiredTransitionHash(transition, key) {
  return firstText(
    transition?.hashBinding?.[key],
  );
}

function chainCarriesCustomerMessage({ receiptInboxItem, proofInboxItem, transitionInboxItem, receipt, proof, transition }) {
  return [
    receiptInboxItem?.action,
    proofInboxItem?.action,
    transitionInboxItem?.action,
    receipt?.action,
    proof?.action,
    transition?.result?.decision?.action,
  ].some((action) => canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function chainCarriesHumanFeedbackActionAlias({ receiptInboxItem, proofInboxItem, transitionInboxItem, receipt, proof, transition }) {
  return [
    receiptInboxItem?.action,
    proofInboxItem?.action,
    transitionInboxItem?.action,
    receipt?.action,
    proof?.action,
    transition?.result?.decision?.action,
  ].some((action) => isHumanFeedbackMessageActionAlias(action));
}

function chainCarriesHumanFeedbackCustomerFacingAction({
  receiptInboxItem,
  proofInboxItem,
  transitionInboxItem,
  receipt,
  proof,
  transition,
}) {
  return [
    receiptInboxItem?.action,
    proofInboxItem?.action,
    transitionInboxItem?.action,
    receipt?.action,
    proof?.action,
    transition?.result?.decision?.action,
  ].some((action) => isHumanFeedbackCustomerFacingAction(action));
}

function chainCarriesHumanFeedbackIdentity({
  receiptInboxItem,
  proofInboxItem,
  transitionInboxItem,
  receipt,
  proof,
}) {
  return [
    receiptInboxItem?.payload?.productLineId,
    receiptInboxItem?.payload?.workflowId,
    receiptInboxItem?.payload?.packageRole,
    receiptInboxItem?.payload?.reviewType,
    receiptInboxItem?.payload?.role,
    proofInboxItem?.payload?.productLineId,
    proofInboxItem?.payload?.workflowId,
    proofInboxItem?.payload?.packageRole,
    proofInboxItem?.payload?.reviewType,
    proofInboxItem?.payload?.role,
    transitionInboxItem?.payload?.productLineId,
    transitionInboxItem?.payload?.workflowId,
    transitionInboxItem?.payload?.packageRole,
    transitionInboxItem?.payload?.reviewType,
    transitionInboxItem?.payload?.role,
    receipt?.payload?.productLineId,
    receipt?.payload?.workflowId,
    receipt?.payload?.packageRole,
    receipt?.payload?.reviewType,
    receipt?.payload?.role,
    proof?.payload?.productLineId,
    proof?.payload?.workflowId,
    proof?.payload?.packageRole,
    proof?.payload?.reviewType,
    proof?.payload?.role,
  ].some((id) => canonicalProductLineId(id) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK);
}

function chainCarriesHumanFeedbackContract({ receiptInboxItem, proofInboxItem, transitionInboxItem, receipt, proof, transition }) {
  const context = {
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    receipt,
    proof,
    transition,
  };
  return Boolean(
    receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || transitionInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')
      || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
      || requiredTransitionHash(transition, 'humanFeedbackRevisionContractHash')
      || chainCarriesHumanFeedbackActionAlias(context)
      || (
        chainCarriesHumanFeedbackCustomerFacingAction(context)
        && chainCarriesHumanFeedbackIdentity(context)
      ),
  );
}

function compareDispatchEnvelopeHashes(leftItem, rightItem, blockers) {
  const keys = [
    ['dispatchEnvelopeHash', 'dispatch_envelope_hash_mismatch'],
    ['outboxHash', 'dispatch_outbox_hash_mismatch'],
    ['replayGuardHash', 'dispatch_replay_guard_hash_mismatch'],
    ['archiveHash', 'dispatch_archive_hash_mismatch'],
    ['ledgerHash', 'dispatch_ledger_hash_mismatch'],
  ];
  for (const [key, code] of keys) {
    compareHash(leftItem?.hashBinding?.[key], rightItem?.hashBinding?.[key], code, blockers);
  }
}

function dispatchInboxChainBlockers({
  dispatchReceiptInboxItem,
  dispatchProofInboxItem,
  dispatchTransitionInboxItem,
  receipt,
  proof,
  transition,
}) {
  const blockers = [];
  const chainContext = {
    receiptInboxItem: dispatchReceiptInboxItem,
    proofInboxItem: dispatchProofInboxItem,
    transitionInboxItem: dispatchTransitionInboxItem,
    receipt,
    proof,
    transition,
  };
  const expectedMessagePreviewHash = messagePreviewHash(null, null, receipt, proof);
  const expectedHumanFeedbackContractHash = humanFeedbackRevisionContractHash(null, null, receipt, proof);

  if (dispatchReceiptInboxItem) {
    if (dispatchReceiptInboxItem.kind !== 'AdapterDispatchReceiptInboxItem') blockers.push(issue('invalid_dispatch_receipt_inbox_kind'));
    blockers.push(...dispatchReceiptInboxContentHashBlockers(dispatchReceiptInboxItem));
    if (
      dispatchReceiptInboxItem.status !== ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.RECEIVED
      || dispatchReceiptInboxItem.received !== true
    ) {
      blockers.push(issue('dispatch_receipt_inbox_not_received'));
    }
    if (dispatchReceiptInboxItem.nextStep !== ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED) {
      blockers.push(issue('dispatch_receipt_inbox_not_waiting_for_proof'));
    }
    if (
      dispatchReceiptInboxItem.status !== ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.RECEIVED
      || dispatchReceiptInboxItem.received !== true
    ) {
      propagateBlockers(dispatchReceiptInboxItem, blockers);
    }
    requireBindingHashes(dispatchReceiptInboxItem, [
      ['dispatchEnvelopeHash', 'dispatch_receipt_inbox_dispatch_envelope_hash_missing'],
      ['outboxHash', 'dispatch_receipt_inbox_outbox_hash_missing'],
      ['replayGuardHash', 'dispatch_receipt_inbox_replay_guard_hash_missing'],
      ['receiptHash', 'dispatch_receipt_inbox_receipt_hash_missing'],
    ], blockers);
    compareRequiredHash(
      hashOf(receipt, 'receiptHash'),
      dispatchReceiptInboxItem.hashBinding?.receiptHash,
      'dispatch_receipt_inbox_receipt_hash_missing',
      'dispatch_receipt_inbox_receipt_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.platformStateSnapshotHash,
      dispatchReceiptInboxItem.hashBinding?.platformStateSnapshotHash,
      'dispatch_receipt_inbox_platform_state_snapshot_hash_missing',
      'dispatch_receipt_inbox_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.dryRunReplayHash,
      dispatchReceiptInboxItem.hashBinding?.dryRunReplayHash,
      'dispatch_receipt_inbox_dry_run_replay_hash_missing',
      'dispatch_receipt_inbox_dry_run_replay_hash_mismatch',
      blockers,
    );
    if (chainCarriesCustomerMessage(chainContext) && !dispatchReceiptInboxItem.hashBinding?.messagePreviewHash) {
      blockers.push(issue('dispatch_receipt_inbox_message_preview_hash_missing'));
    }
    if (chainCarriesHumanFeedbackContract(chainContext) && !dispatchReceiptInboxItem.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('dispatch_receipt_inbox_human_feedback_contract_hash_missing'));
    }
    compareRequiredHash(
      expectedMessagePreviewHash,
      dispatchReceiptInboxItem.hashBinding?.messagePreviewHash,
      'dispatch_receipt_inbox_message_preview_hash_missing',
      'dispatch_receipt_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedHumanFeedbackContractHash,
      dispatchReceiptInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      'dispatch_receipt_inbox_human_feedback_contract_hash_missing',
      'dispatch_receipt_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
  }

  if (dispatchProofInboxItem) {
    if (!dispatchReceiptInboxItem) blockers.push(issue('dispatch_proof_inbox_without_dispatch_receipt_inbox'));
    if (dispatchProofInboxItem.kind !== 'AdapterDispatchChannelStateProofInboxItem') blockers.push(issue('invalid_dispatch_proof_inbox_kind'));
    blockers.push(...dispatchProofInboxContentHashBlockers(dispatchProofInboxItem));
    if (
      dispatchProofInboxItem.status !== ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED
      || dispatchProofInboxItem.received !== true
    ) {
      blockers.push(issue('dispatch_proof_inbox_not_received'));
    }
    if (dispatchProofInboxItem.nextStep !== ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY) {
      blockers.push(issue('dispatch_proof_inbox_not_ready_for_transition'));
    }
    if (
      dispatchProofInboxItem.status !== ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED
      || dispatchProofInboxItem.received !== true
    ) {
      propagateBlockers(dispatchProofInboxItem, blockers);
    }
    requireBindingHashes(dispatchProofInboxItem, [
      ['dispatchReceiptInboxHash', 'dispatch_proof_inbox_receipt_inbox_hash_missing'],
      ['dispatchEnvelopeHash', 'dispatch_proof_inbox_dispatch_envelope_hash_missing'],
      ['outboxHash', 'dispatch_proof_inbox_outbox_hash_missing'],
      ['replayGuardHash', 'dispatch_proof_inbox_replay_guard_hash_missing'],
      ['receiptHash', 'dispatch_proof_inbox_receipt_hash_missing'],
      ['proofHash', 'dispatch_proof_inbox_proof_hash_missing'],
    ], blockers);
    compareRequiredHash(
      hashOf(dispatchReceiptInboxItem, 'inboxHash'),
      dispatchProofInboxItem.hashBinding?.dispatchReceiptInboxHash,
      'dispatch_proof_inbox_receipt_inbox_hash_missing',
      'dispatch_proof_inbox_receipt_inbox_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchReceiptInboxItem?.hashBinding?.receiptHash || hashOf(receipt, 'receiptHash'),
      dispatchProofInboxItem.hashBinding?.receiptHash,
      'dispatch_proof_inbox_receipt_hash_missing',
      'dispatch_proof_inbox_receipt_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      hashOf(proof, 'proofHash'),
      dispatchProofInboxItem.hashBinding?.proofHash,
      'dispatch_proof_inbox_proof_hash_missing',
      'dispatch_proof_inbox_proof_hash_mismatch',
      blockers,
    );
    if (chainCarriesCustomerMessage(chainContext) && !dispatchProofInboxItem.hashBinding?.messagePreviewHash) {
      blockers.push(issue('dispatch_proof_inbox_message_preview_hash_missing'));
    }
    if (chainCarriesHumanFeedbackContract(chainContext) && !dispatchProofInboxItem.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('dispatch_proof_inbox_human_feedback_contract_hash_missing'));
    }
    compareHash(
      dispatchProofInboxItem.hashBinding?.messagePreviewHash,
      dispatchReceiptInboxItem?.hashBinding?.messagePreviewHash,
      'dispatch_proof_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareHash(
      dispatchProofInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      dispatchReceiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
      'dispatch_proof_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedMessagePreviewHash,
      dispatchProofInboxItem.hashBinding?.messagePreviewHash,
      'dispatch_proof_inbox_message_preview_hash_missing',
      'dispatch_proof_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedHumanFeedbackContractHash,
      dispatchProofInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      'dispatch_proof_inbox_human_feedback_contract_hash_missing',
      'dispatch_proof_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchReceiptInboxItem?.hashBinding?.platformStateSnapshotHash || receipt?.hashBinding?.platformStateSnapshotHash,
      dispatchProofInboxItem.hashBinding?.platformStateSnapshotHash,
      'dispatch_proof_inbox_platform_state_snapshot_hash_missing',
      'dispatch_proof_inbox_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchReceiptInboxItem?.hashBinding?.dryRunReplayHash || receipt?.hashBinding?.dryRunReplayHash,
      dispatchProofInboxItem.hashBinding?.dryRunReplayHash,
      'dispatch_proof_inbox_dry_run_replay_hash_missing',
      'dispatch_proof_inbox_dry_run_replay_hash_mismatch',
      blockers,
    );
    compareDispatchEnvelopeHashes(dispatchReceiptInboxItem, dispatchProofInboxItem, blockers);
  }

  if (dispatchTransitionInboxItem) {
    if (!dispatchProofInboxItem) blockers.push(issue('dispatch_transition_inbox_without_dispatch_proof_inbox'));
    if (dispatchTransitionInboxItem.kind !== 'AdapterDispatchReceiptStateTransitionInboxItem') {
      blockers.push(issue('invalid_dispatch_transition_inbox_kind'));
    }
    blockers.push(...dispatchTransitionInboxContentHashBlockers(dispatchTransitionInboxItem));
    if (
      dispatchTransitionInboxItem.status !== ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED
      || dispatchTransitionInboxItem.received !== true
    ) {
      blockers.push(issue('dispatch_transition_inbox_not_received'));
    }
    if (dispatchTransitionInboxItem.nextStep !== ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY) {
      blockers.push(issue('dispatch_transition_inbox_not_ready_for_ledger'));
    }
    if (
      dispatchTransitionInboxItem.status !== ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED
      || dispatchTransitionInboxItem.received !== true
    ) {
      propagateBlockers(dispatchTransitionInboxItem, blockers);
    }
    requireBindingHashes(dispatchTransitionInboxItem, [
      ['dispatchProofInboxHash', 'dispatch_transition_inbox_proof_inbox_hash_missing'],
      ['dispatchReceiptInboxHash', 'dispatch_transition_inbox_receipt_inbox_hash_missing'],
      ['dispatchEnvelopeHash', 'dispatch_transition_inbox_dispatch_envelope_hash_missing'],
      ['outboxHash', 'dispatch_transition_inbox_outbox_hash_missing'],
      ['replayGuardHash', 'dispatch_transition_inbox_replay_guard_hash_missing'],
      ['receiptHash', 'dispatch_transition_inbox_receipt_hash_missing'],
      ['proofHash', 'dispatch_transition_inbox_proof_hash_missing'],
      ['transitionHash', 'dispatch_transition_inbox_transition_hash_missing'],
    ], blockers);
    compareRequiredHash(
      hashOf(dispatchProofInboxItem, 'proofInboxHash'),
      dispatchTransitionInboxItem.hashBinding?.dispatchProofInboxHash,
      'dispatch_transition_inbox_proof_inbox_hash_missing',
      'dispatch_transition_inbox_proof_inbox_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchProofInboxItem?.hashBinding?.dispatchReceiptInboxHash || hashOf(dispatchReceiptInboxItem, 'inboxHash'),
      dispatchTransitionInboxItem.hashBinding?.dispatchReceiptInboxHash,
      'dispatch_transition_inbox_receipt_inbox_hash_missing',
      'dispatch_transition_inbox_receipt_inbox_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchProofInboxItem?.hashBinding?.receiptHash || dispatchReceiptInboxItem?.hashBinding?.receiptHash || hashOf(receipt, 'receiptHash'),
      dispatchTransitionInboxItem.hashBinding?.receiptHash,
      'dispatch_transition_inbox_receipt_hash_missing',
      'dispatch_transition_inbox_receipt_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchProofInboxItem?.hashBinding?.proofHash || hashOf(proof, 'proofHash'),
      dispatchTransitionInboxItem.hashBinding?.proofHash,
      'dispatch_transition_inbox_proof_hash_missing',
      'dispatch_transition_inbox_proof_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      transitionHash(transition),
      dispatchTransitionInboxItem.hashBinding?.transitionHash,
      'dispatch_transition_inbox_transition_hash_missing',
      'dispatch_transition_inbox_transition_hash_mismatch',
      blockers,
    );
    if (chainCarriesCustomerMessage(chainContext) && !dispatchTransitionInboxItem.hashBinding?.messagePreviewHash) {
      blockers.push(issue('dispatch_transition_inbox_message_preview_hash_missing'));
    }
    if (chainCarriesHumanFeedbackContract(chainContext) && !dispatchTransitionInboxItem.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('dispatch_transition_inbox_human_feedback_contract_hash_missing'));
    }
    compareHash(
      dispatchTransitionInboxItem.hashBinding?.messagePreviewHash,
      dispatchProofInboxItem?.hashBinding?.messagePreviewHash,
      'dispatch_transition_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareHash(
      dispatchTransitionInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      dispatchProofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
      'dispatch_transition_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedMessagePreviewHash,
      dispatchTransitionInboxItem.hashBinding?.messagePreviewHash,
      'dispatch_transition_inbox_message_preview_hash_missing',
      'dispatch_transition_inbox_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      expectedHumanFeedbackContractHash,
      dispatchTransitionInboxItem.hashBinding?.humanFeedbackRevisionContractHash,
      'dispatch_transition_inbox_human_feedback_contract_hash_missing',
      'dispatch_transition_inbox_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchProofInboxItem?.hashBinding?.platformStateSnapshotHash || proof?.hashBinding?.platformStateSnapshotHash,
      dispatchTransitionInboxItem.hashBinding?.platformStateSnapshotHash,
      'dispatch_transition_inbox_platform_state_snapshot_hash_missing',
      'dispatch_transition_inbox_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      dispatchProofInboxItem?.hashBinding?.dryRunReplayHash || proof?.hashBinding?.dryRunReplayHash,
      dispatchTransitionInboxItem.hashBinding?.dryRunReplayHash,
      'dispatch_transition_inbox_dry_run_replay_hash_missing',
      'dispatch_transition_inbox_dry_run_replay_hash_mismatch',
      blockers,
    );
    compareDispatchEnvelopeHashes(dispatchProofInboxItem, dispatchTransitionInboxItem, blockers);
  }

  return blockers;
}

function ledgerBlockers({
  manifest,
  preview,
  receipt,
  proof,
  transition,
  receiptInboxItem,
  proofInboxItem,
  transitionInboxItem,
  dispatchReceiptInboxItem,
  dispatchProofInboxItem,
  dispatchTransitionInboxItem,
}) {
  const blockers = [];
  const directChainContext = { receipt, proof, transition };
  const usesInboxChain = Boolean(
    receiptInboxItem
      || proofInboxItem
      || transitionInboxItem
      || dispatchReceiptInboxItem
      || dispatchProofInboxItem
      || dispatchTransitionInboxItem,
  );

  if (manifest?.kind !== 'ChannelActionManifest') blockers.push(issue('manifest_required'));
  if (manifest && (manifest.status !== ACTION_MANIFEST_STATUS.READY || manifest.readyForAdapter !== true)) {
    blockers.push(issue('manifest_not_ready'));
  }
  if (preview?.kind !== 'AdapterRunPreview') blockers.push(issue('preview_required'));
  if (preview && (preview.status !== ADAPTER_RUNNER_STATUS.DRY_RUN_READY || preview.readyForDryRun !== true)) {
    blockers.push(issue('preview_not_ready'));
  }

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
  if (manifest?.kind === 'ChannelActionManifest' && preview?.kind === 'AdapterRunPreview') {
    blockers.push(...handoffSnapshotIdentityBlockers({ manifest, preview }));
  }

  if (receipt) {
    if (receipt.kind !== 'AdapterRunReceipt') blockers.push(issue('invalid_receipt_kind'));
    if (receipt.status !== ADAPTER_RECEIPT_STATUS.ACCEPTED || receipt.accepted !== true) blockers.push(issue('receipt_not_accepted'));
    blockers.push(...receiptContentHashBlockers(receipt));
    const expectedApprovalHash = firstText(
      preview?.payload?.approvalHash,
      preview?.adapter?.requiredHashes?.approvalHash,
      manifest?.payload?.approvalHash,
    );
    const expectedEvidenceHash = firstText(
      preview?.payload?.evidenceHash,
      preview?.adapter?.requiredHashes?.evidenceHash,
      manifest?.payload?.evidenceHash,
    );
    compareRequiredBindingHash(
      manifestHash,
      receipt.hashBinding?.manifestHash,
      'receipt_manifest_hash_missing',
      'receipt_manifest_hash_mismatch',
      blockers,
    );
    compareRequiredBindingHash(
      previewHash,
      receipt.hashBinding?.previewHash,
      'receipt_preview_hash_missing',
      'receipt_preview_hash_mismatch',
      blockers,
    );
    compareRequiredBindingHash(
      expectedApprovalHash,
      receipt.hashBinding?.approvalHash,
      'receipt_approval_hash_missing',
      'receipt_approval_hash_mismatch',
      blockers,
    );
    compareRequiredBindingHash(
      expectedEvidenceHash,
      receipt.hashBinding?.evidenceHash,
      'receipt_evidence_hash_missing',
      'receipt_evidence_hash_mismatch',
      blockers,
    );
    requireHash(receipt.hashBinding?.platformStateSnapshotHash, 'receipt_platform_state_snapshot_hash_missing', blockers);
    requireHash(receipt.hashBinding?.dryRunReplayHash, 'receipt_dry_run_replay_hash_missing', blockers);
    if (!usesInboxChain && chainCarriesCustomerMessage(directChainContext) && !requiredReceiptHash(receipt, 'messagePreviewHash')) {
      blockers.push(issue('receipt_message_preview_hash_missing'));
    }
    if (!usesInboxChain && chainCarriesHumanFeedbackContract(directChainContext) && !requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('receipt_human_feedback_contract_hash_missing'));
    }
  }

  if (proof) {
    if (!receipt) blockers.push(issue('proof_without_receipt'));
    if (proof.kind !== 'ChannelStateProof') blockers.push(issue('invalid_channel_state_proof'));
    if (proof.status !== CHANNEL_STATE_PROOF_STATUS.VERIFIED || proof.verified !== true) {
      blockers.push(issue('channel_state_proof_not_verified'));
    }
    blockers.push(...proofContentHashBlockers(proof));
    const receiptHash = hashOf(receipt, 'receiptHash');
    if (proof.receiptHash && receiptHash && proof.receiptHash !== receiptHash) blockers.push(issue('proof_receipt_hash_mismatch'));
    compareRequiredHash(receiptHash, proof.receiptHash, 'proof_receipt_hash_missing', 'proof_receipt_hash_mismatch', blockers);
    compareRequiredHash(
      receipt?.hashBinding?.manifestHash,
      proof.hashBinding?.manifestHash,
      'proof_manifest_hash_missing',
      'proof_manifest_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.previewHash,
      proof.hashBinding?.previewHash,
      'proof_preview_hash_missing',
      'proof_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.approvalHash,
      proof.hashBinding?.approvalHash,
      'proof_approval_hash_missing',
      'proof_approval_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.evidenceHash,
      proof.hashBinding?.evidenceHash,
      'proof_evidence_hash_missing',
      'proof_evidence_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.platformStateSnapshotHash,
      proof.hashBinding?.platformStateSnapshotHash,
      'proof_platform_state_snapshot_hash_missing',
      'proof_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receipt?.hashBinding?.dryRunReplayHash,
      proof.hashBinding?.dryRunReplayHash,
      'proof_dry_run_replay_hash_missing',
      'proof_dry_run_replay_hash_mismatch',
      blockers,
    );
    if (!usesInboxChain && chainCarriesCustomerMessage(directChainContext) && !requiredProofHash(proof, 'messagePreviewHash')) {
      blockers.push(issue('proof_message_preview_hash_missing'));
    }
    if (!usesInboxChain && chainCarriesHumanFeedbackContract(directChainContext) && !requiredProofHash(proof, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('proof_human_feedback_contract_hash_missing'));
    }
    for (const blocker of proof.blockers || []) {
      blockers.push(issue(blocker.code, blocker.notes || null));
    }
  }

  if (transition) {
    if (!proof) blockers.push(issue('transition_without_proof'));
    if (transition.kind !== 'ReceiptStateTransition') blockers.push(issue('invalid_receipt_state_transition'));
    if (transition.status !== RECEIPT_TRANSITION_STATUS.READY || transition.ready !== true) {
      blockers.push(issue('receipt_state_transition_not_ready'));
    }
    blockers.push(...transitionContentHashBlockers(transition));
    const proofHash = hashOf(proof, 'proofHash');
    if (transition.proofHash && proofHash && transition.proofHash !== proofHash) blockers.push(issue('transition_proof_hash_mismatch'));
    compareRequiredHash(
      proofHash,
      transition.hashBinding?.proofHash,
      'transition_proof_hash_missing',
      'transition_proof_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proof?.receiptHash || hashOf(receipt, 'receiptHash'),
      transition.hashBinding?.receiptHash,
      'transition_receipt_hash_missing',
      'transition_receipt_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proof?.hashBinding?.manifestHash,
      transition.hashBinding?.manifestHash,
      'transition_manifest_hash_missing',
      'transition_manifest_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proof?.hashBinding?.previewHash,
      transition.hashBinding?.previewHash,
      'transition_preview_hash_missing',
      'transition_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proof?.hashBinding?.approvalHash,
      transition.hashBinding?.approvalHash,
      'transition_approval_hash_missing',
      'transition_approval_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proof?.hashBinding?.evidenceHash,
      transition.hashBinding?.evidenceHash,
      'transition_evidence_hash_missing',
      'transition_evidence_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proof?.hashBinding?.platformStateSnapshotHash,
      transition.hashBinding?.platformStateSnapshotHash,
      'transition_platform_state_snapshot_hash_missing',
      'transition_platform_state_snapshot_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      proof?.hashBinding?.dryRunReplayHash,
      transition.hashBinding?.dryRunReplayHash,
      'transition_dry_run_replay_hash_missing',
      'transition_dry_run_replay_hash_mismatch',
      blockers,
    );
    if (chainCarriesCustomerMessage(directChainContext) && !transition.hashBinding?.messagePreviewHash) {
      blockers.push(issue('transition_message_preview_hash_missing'));
    }
    if (chainCarriesHumanFeedbackContract(directChainContext) && !transition.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('transition_human_feedback_contract_hash_missing'));
    }
    compareRequiredHash(
      messagePreviewHash(null, null, receipt, proof),
      transition.hashBinding?.messagePreviewHash,
      'transition_message_preview_hash_missing',
      'transition_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      humanFeedbackRevisionContractHash(null, null, receipt, proof),
      transition.hashBinding?.humanFeedbackRevisionContractHash,
      'transition_human_feedback_contract_hash_missing',
      'transition_human_feedback_contract_hash_mismatch',
      blockers,
    );
    compareRequiredField(
      proof?.payload?.taskKey,
      transition.result?.taskKey,
      'transition_task_key_required',
      'transition_task_key_mismatch',
      blockers,
    );
    compareRequiredAction(
      proof?.action,
      transition.result?.decision?.action,
      'transition_action_required',
      'transition_action_mismatch',
      blockers,
    );
    compareRequiredField(
      proof?.stateSuggestion?.fromStage,
      transition.result?.previousStage,
      'transition_from_stage_required',
      'transition_from_stage_mismatch',
      blockers,
    );
    compareRequiredField(
      proof?.stateSuggestion?.toStage,
      transition.result?.stage,
      'transition_to_stage_required',
      'transition_to_stage_mismatch',
      blockers,
    );
    compareRequiredField(
      proof?.stateSuggestion?.toStage,
      transition.result?.requestedStage,
      'transition_requested_stage_required',
      'transition_requested_stage_mismatch',
      blockers,
    );
    for (const blocker of transition.blockers || []) {
      blockers.push(issue(blocker.code, blocker.notes || null));
    }
  }

  blockers.push(...approvalProvenanceHashContinuityBlockers([
    ['manifest', manifest],
    ['preview', preview],
    ['receipt', receipt],
    ['proof', proof],
    ['transition', transition],
    ['receipt_inbox', receiptInboxItem],
    ['proof_inbox', proofInboxItem],
    ['transition_inbox', transitionInboxItem],
    ['dispatch_receipt_inbox', dispatchReceiptInboxItem],
    ['dispatch_proof_inbox', dispatchProofInboxItem],
    ['dispatch_transition_inbox', dispatchTransitionInboxItem],
  ]));

  blockers.push(...promptGenerationBindingContinuityBlockers([
    ['manifest', manifest],
    ['preview', preview],
    ['receipt', receipt],
    ['proof', proof],
    ['transition', transition],
    ['receipt_inbox', receiptInboxItem],
    ['proof_inbox', proofInboxItem],
    ['transition_inbox', transitionInboxItem],
    ['dispatch_receipt_inbox', dispatchReceiptInboxItem],
    ['dispatch_proof_inbox', dispatchProofInboxItem],
    ['dispatch_transition_inbox', dispatchTransitionInboxItem],
  ]));

  blockers.push(...inboxChainBlockers({
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    receipt,
    proof,
    transition,
  }));
  blockers.push(...dispatchInboxChainBlockers({
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
    receipt,
    proof,
    transition,
  }));
  blockers.push(...customerMessageSemanticBlockers({
    manifest,
    preview,
    receipt,
    proof,
  }));

  return blockers;
}

export function computeExternalActionLedgerHash(entry) {
  if (!entry) return null;
  return digest({
    version: entry.version,
    kind: entry.kind,
    actor: entry.actor,
    status: entry.status,
    verified: entry.verified,
    channelId: entry.channelId,
    actionId: entry.actionId,
    action: canonicalActionOrNull(entry.action),
    payload: ledgerHashPayload(entry.payload),
    chain: entry.chain,
    blockers: entry.blockers,
    warnings: entry.warnings,
    evidenceRefs: entry.evidenceRefs,
    safety: entry.safety,
  });
}

export function buildExternalActionLedgerEntry({
  manifest = null,
  preview = null,
  receipt = null,
  proof = null,
  transition = null,
  receiptInboxItem = null,
  proofInboxItem = null,
  transitionInboxItem = null,
  dispatchReceiptInboxItem = null,
  dispatchProofInboxItem = null,
  dispatchTransitionInboxItem = null,
  actor = 'design-production-core.external-action-ledger',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const blockers = ledgerBlockers({
    manifest,
    preview,
    receipt,
    proof,
    transition,
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
  });
  const status = statusFrom({ blockers, receipt, proof, transition });
  const usesStandardInboxChain = Boolean(receiptInboxItem || proofInboxItem || transitionInboxItem);
  const usesDispatchInboxChain = Boolean(dispatchReceiptInboxItem || dispatchProofInboxItem || dispatchTransitionInboxItem);
  const usesInboxChain = usesStandardInboxChain || usesDispatchInboxChain;
  const receiptInboxHash = hashOf(receiptInboxItem, 'inboxHash') || hashOf(dispatchReceiptInboxItem, 'inboxHash');
  const proofInboxHash = hashOf(proofInboxItem, 'proofInboxHash') || hashOf(dispatchProofInboxItem, 'proofInboxHash');
  const transitionInboxHash = hashOf(transitionInboxItem, 'transitionInboxHash') || hashOf(dispatchTransitionInboxItem, 'transitionInboxHash');
  const entry = {
    version: EXTERNAL_ACTION_LEDGER_VERSION,
    kind: 'ExternalActionLedgerEntry',
    actor: normalizeText(actor || 'design-production-core.external-action-ledger'),
    status,
    verified: status === EXTERNAL_ACTION_LEDGER_STATUS.VERIFIED,
    channelId: manifest?.channelId || preview?.adapter?.channelId || receipt?.channelId || proof?.channelId || null,
    actionId: manifest?.adapter?.actionId || preview?.adapter?.actionId || receipt?.actionId || proof?.actionId || null,
    action: canonicalActionOrNull(manifest?.action || preview?.payload?.action || receipt?.action || proof?.action || null),
    payload: {
      taskKey: manifest?.taskKey || preview?.payload?.taskKey || receipt?.payload?.taskKey || proof?.payload?.taskKey || null,
      externalId: manifest?.payload?.externalId || preview?.payload?.externalId || receipt?.payload?.externalId || proof?.payload?.externalId || null,
      productLineId: canonicalProductLineOrNull(manifest?.productLineId || preview?.payload?.productLineId || receipt?.payload?.productLineId || proof?.payload?.productLineId),
      workflowId: canonicalProductLineOrNull(manifest?.workflowId || preview?.payload?.workflowId || receipt?.payload?.workflowId || proof?.payload?.workflowId),
      packageRole: canonicalPackageRole(
        manifest?.payload?.packageRole
          || preview?.payload?.packageRole
          || receipt?.payload?.packageRole
          || proof?.payload?.packageRole
          || '',
      ) || null,
      approvalProvenanceHash: approvalProvenanceHashFromSources(manifest, preview, receipt, proof, transition),
      messagePreviewHash: messagePreviewHash(manifest, preview, receipt, proof),
      humanFeedbackRevisionContractHash: humanFeedbackRevisionContractHash(manifest, preview, receipt, proof),
      promptGenerationBinding: promptGenerationBindingFromSources(manifest, preview, receipt, proof, transition),
      artifactNames: artifactNames(manifest, preview, receipt, proof),
    },
    chain: {
      manifestHash: hashOf(manifest, 'manifestHash'),
      previewHash: hashOf(preview, 'previewHash'),
      approvalProvenanceHash: approvalProvenanceHashFromSources(
        manifest,
        preview,
        receipt,
        proof,
        transition,
        receiptInboxItem,
        proofInboxItem,
        transitionInboxItem,
        dispatchReceiptInboxItem,
        dispatchProofInboxItem,
        dispatchTransitionInboxItem,
      ),
      messagePreviewHash: messagePreviewHash(manifest, preview, receipt, proof),
      humanFeedbackRevisionContractHash: humanFeedbackRevisionContractHash(manifest, preview, receipt, proof),
      promptGenerationBinding: promptGenerationBindingFromSources(
        manifest,
        preview,
        receipt,
        proof,
        transition,
        receiptInboxItem,
        proofInboxItem,
        transitionInboxItem,
        dispatchReceiptInboxItem,
        dispatchProofInboxItem,
        dispatchTransitionInboxItem,
      ),
      receiptHash: hashOf(receipt, 'receiptHash'),
      receiptInboxHash,
      dispatchReceiptInboxHash: hashOf(dispatchReceiptInboxItem, 'inboxHash'),
      dispatchEnvelopeHash: dispatchReceiptInboxItem?.hashBinding?.dispatchEnvelopeHash
        || dispatchProofInboxItem?.hashBinding?.dispatchEnvelopeHash
        || dispatchTransitionInboxItem?.hashBinding?.dispatchEnvelopeHash
        || null,
      dispatchOutboxHash: dispatchReceiptInboxItem?.hashBinding?.outboxHash
        || dispatchProofInboxItem?.hashBinding?.outboxHash
        || dispatchTransitionInboxItem?.hashBinding?.outboxHash
        || null,
      dispatchReplayGuardHash: dispatchReceiptInboxItem?.hashBinding?.replayGuardHash
        || dispatchProofInboxItem?.hashBinding?.replayGuardHash
        || dispatchTransitionInboxItem?.hashBinding?.replayGuardHash
        || null,
      dispatchArchiveHash: dispatchReceiptInboxItem?.hashBinding?.archiveHash
        || dispatchProofInboxItem?.hashBinding?.archiveHash
        || dispatchTransitionInboxItem?.hashBinding?.archiveHash
        || null,
      dispatchLedgerHash: dispatchReceiptInboxItem?.hashBinding?.ledgerHash
        || dispatchProofInboxItem?.hashBinding?.ledgerHash
        || dispatchTransitionInboxItem?.hashBinding?.ledgerHash
        || null,
      proofHash: hashOf(proof, 'proofHash'),
      proofInboxHash,
      dispatchProofInboxHash: hashOf(dispatchProofInboxItem, 'proofInboxHash'),
      platformStateSnapshotHash: proof?.hashBinding?.platformStateSnapshotHash
        || receipt?.hashBinding?.platformStateSnapshotHash
        || proofInboxItem?.hashBinding?.platformStateSnapshotHash
        || dispatchProofInboxItem?.hashBinding?.platformStateSnapshotHash
        || transitionInboxItem?.hashBinding?.platformStateSnapshotHash
        || dispatchTransitionInboxItem?.hashBinding?.platformStateSnapshotHash
        || null,
      dryRunReplayHash: proof?.hashBinding?.dryRunReplayHash
        || receipt?.hashBinding?.dryRunReplayHash
        || proofInboxItem?.hashBinding?.dryRunReplayHash
        || dispatchProofInboxItem?.hashBinding?.dryRunReplayHash
        || transitionInboxItem?.hashBinding?.dryRunReplayHash
        || dispatchTransitionInboxItem?.hashBinding?.dryRunReplayHash
        || null,
      transitionHash: transitionHash(transition),
      transitionInboxHash,
      dispatchTransitionInboxHash: hashOf(dispatchTransitionInboxItem, 'transitionInboxHash'),
      transitionStage: transition?.result?.stage || null,
      transitionAuditDecision: transition?.result?.auditEvent?.decision || null,
      usesInboxChain,
      usesStandardInboxChain,
      usesDispatchInboxChain,
    },
    blockers,
    warnings: [
      issue('ledger_verifies_only', 'Core action ledger entries do not run adapters or external actions.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      ledgerOnly: true,
      executesExternalAction: false,
      requiresExternalAdapter: true,
      requiresReceiptBeforeProof: true,
      requiresChannelProofBeforeStateTransition: true,
      usesInboxChain,
      usesStandardInboxChain,
      usesDispatchInboxChain,
      requiresInboxChainForFinalVerification: usesInboxChain,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const ledgerHash = computeExternalActionLedgerHash(entry);
  return {
    ...entry,
    ledgerHash,
    hash: ledgerHash,
  };
}

export function summarizeExternalActionLedger(entries = []) {
  const byStatus = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  for (const entry of entries || []) {
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    const channelId = entry.channelId || 'unknown';
    byChannel[channelId] = (byChannel[channelId] || 0) + 1;
    const actionId = entry.actionId || 'unknown';
    byActionId[actionId] = (byActionId[actionId] || 0) + 1;
    for (const blocker of entry.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: EXTERNAL_ACTION_LEDGER_VERSION,
    count: entries.length,
    byStatus,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      ledgerOnly: true,
      executesExternalAction: entries.some((entry) => entry.safety?.executesExternalAction === true),
    },
  };
}
