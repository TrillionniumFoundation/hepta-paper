import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  computeCustomerMessagePreviewHashFromFields,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
} from './contracts.mjs';
import {
  ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS,
  ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP,
  computeAdapterDispatchChannelStateProofInboxHash,
} from './adapter-dispatch-channel-state-proof-inbox.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, computeAdapterRunReceiptHash } from './adapter-receipt.mjs';
import {
  CHANNEL_STATE_PROOF_STATUS,
  RECEIPT_TRANSITION_STATUS,
  computeChannelStateProofHash,
  computeReceiptStateTransitionHash,
} from './channel-state-proof.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_VERSION = 1;

export const ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS = Object.freeze({
  RECEIVED: 'received_dispatch_receipt_state_transition',
  BLOCKED: 'blocked_dispatch_receipt_state_transition_inbox',
});

export const ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP = Object.freeze({
  EXTERNAL_ACTION_LEDGER_READY: 'external_action_ledger_ready',
  BLOCKED: 'blocked',
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
  return normalizeText(key === 'hash' ? value?.hash : value?.[key] || '') || null;
}

function storedHashAliases(value = null, semanticKey) {
  const semanticHash = normalizeText(value?.[semanticKey] || '') || null;
  const genericHash = normalizeText(value?.hash || '') || null;
  return {
    semanticHash,
    genericHash,
    effectiveHash: semanticHash,
  };
}

function transitionHashOf(transition) {
  return normalizeText(transition?.transitionHash || '') || null;
}

function compareField(left, right, code, blockers) {
  const normalizedLeft = normalizeText(left || '');
  const normalizedRight = normalizeText(right || '');
  if (!normalizedLeft) return;
  if (!normalizedRight || normalizedLeft !== normalizedRight) blockers.push(issue(code));
}

function compareActionField(left, right, code, blockers) {
  const normalizedLeft = normalizeText(left || '');
  const normalizedRight = normalizeText(right || '');
  if (!normalizedLeft) return;
  if (!normalizedRight) {
    blockers.push(issue(code));
    return;
  }
  if (canonicalExternalAction(normalizedLeft) !== canonicalExternalAction(normalizedRight)) blockers.push(issue(code));
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

function requiredProofHash(proof, key) {
  return normalizeText(
    proof?.hashBinding?.[key]
      || proof?.payload?.[key]
      || proof?.evidence?.[key]
      || '',
  ) || null;
}

function requiredReceiptHash(receipt, key) {
  return normalizeText(
    receipt?.hashBinding?.[key]
      || receipt?.payload?.[key]
      || receipt?.result?.external?.[key]
      || '',
  ) || null;
}

function requiredTransitionHash(transition, key) {
  return normalizeText(
    transition?.hashBinding?.[key]
      || '',
  ) || null;
}

function pushRequiredHashSourceBlockers(blockers, sources = [], expected = null) {
  for (const source of sources) {
    const value = normalizeText(source.value || '') || null;
    if (!value) {
      blockers.push(issue(source.missingCode));
    } else if (expected && value !== expected) {
      blockers.push(issue(source.mismatchCode));
    }
  }
}

function proofMessagePreviewHashSourceBlockers(proof, expected, blockers) {
  pushRequiredHashSourceBlockers(blockers, [
    {
      value: proof?.hashBinding?.messagePreviewHash,
      missingCode: 'proof_hash_binding_message_preview_hash_missing',
      mismatchCode: 'proof_hash_binding_message_preview_hash_mismatch',
    },
    {
      value: proof?.payload?.messagePreviewHash,
      missingCode: 'proof_payload_message_preview_hash_missing',
      mismatchCode: 'proof_payload_message_preview_hash_mismatch',
    },
    {
      value: proof?.evidence?.messagePreviewHash,
      missingCode: 'proof_evidence_message_preview_hash_missing',
      mismatchCode: 'proof_evidence_message_preview_hash_mismatch',
    },
  ], expected);
}

function proofHumanFeedbackContractHashSourceBlockers(proof, expected, blockers) {
  pushRequiredHashSourceBlockers(blockers, [
    {
      value: proof?.hashBinding?.humanFeedbackRevisionContractHash,
      missingCode: 'proof_hash_binding_human_feedback_contract_hash_missing',
      mismatchCode: 'proof_hash_binding_human_feedback_contract_hash_mismatch',
    },
    {
      value: proof?.payload?.humanFeedbackRevisionContractHash,
      missingCode: 'proof_payload_human_feedback_contract_hash_missing',
      mismatchCode: 'proof_payload_human_feedback_contract_hash_mismatch',
    },
    {
      value: proof?.evidence?.humanFeedbackRevisionContractHash,
      missingCode: 'proof_evidence_human_feedback_contract_hash_missing',
      mismatchCode: 'proof_evidence_human_feedback_contract_hash_mismatch',
    },
  ], expected);
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => normalizeText(left[key] || '') === normalizeText(right[key] || ''));
}

function missingPromptGenerationBindingKeys(binding = null) {
  return PROMPT_GENERATION_BINDING_KEYS.filter((key) => !normalizeText(binding?.[key] || ''));
}

function pushPromptGenerationBindingSourceBlockers(blockers, sources = [], expected = null) {
  for (const source of sources) {
    const binding = source.binding || null;
    if (!binding) {
      if (source.required) blockers.push(issue(source.missingCode));
      continue;
    }
    const missingKeys = missingPromptGenerationBindingKeys(binding);
    if (missingKeys.length) {
      blockers.push(issue(source.incompleteCode, missingKeys.join(', ')));
    } else if (expected && !samePromptGenerationBinding(expected, binding)) {
      blockers.push(issue(source.mismatchCode));
    }
  }
}

function proofPromptGenerationBinding(proof = null) {
  return proof?.hashBinding?.promptGenerationBinding
    || proof?.payload?.promptGenerationBinding
    || proof?.evidence?.promptGenerationBinding
    || null;
}

function receiptPromptGenerationBinding(receipt = null) {
  return receipt?.hashBinding?.promptGenerationBinding
    || receipt?.payload?.promptGenerationBinding
    || receipt?.result?.external?.promptGenerationBinding
    || null;
}

function transitionPromptGenerationBinding(transition = null) {
  return transition?.hashBinding?.promptGenerationBinding || null;
}

function isPromptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonical === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function requiresPromptGenerationBinding({ dispatchProofInboxItem, proof, transition, receipt }) {
  return [
    dispatchProofInboxItem?.action,
    dispatchProofInboxItem?.payload?.action,
    proof?.action,
    proof?.payload?.action,
    transition?.result?.decision?.action,
    receipt?.action,
    receipt?.payload?.action,
    receipt?.result?.external?.action,
  ].some((action) => isPromptGenerationSpendAction(action));
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

function pushIssueOnce(blockers, code) {
  if (!blockers.some((item) => item.code === code)) blockers.push(issue(code));
}

function addMessagePreviewContentBlocker(value, expectedHash, code, blockers) {
  const normalizedExpected = normalizeText(expectedHash || '');
  const rawContentHash = computeCustomerMessagePreviewHashFromFields(value);
  const storedContentHash = normalizeText(value?.messagePreviewContentHash || '') || null;
  const contentHash = rawContentHash || storedContentHash;
  if (rawContentHash && storedContentHash && rawContentHash !== storedContentHash) {
    pushIssueOnce(blockers, code);
  }
  if (contentHash && normalizedExpected && contentHash !== normalizedExpected) {
    pushIssueOnce(blockers, code);
  }
}

function propagateBlockers(source, blockers) {
  for (const blocker of source?.blockers || []) {
    if (!blockers.some((item) => item.code === blocker.code)) blockers.push(blocker);
  }
}

function receiptHashFromDispatchProofInbox(dispatchProofInboxItem) {
  return normalizeText(dispatchProofInboxItem?.hashBinding?.receiptHash || '') || null;
}

function proofHashFromDispatchProofInbox(dispatchProofInboxItem) {
  return normalizeText(dispatchProofInboxItem?.hashBinding?.proofHash || '') || null;
}

function requiresCustomerMessageHashes({ dispatchProofInboxItem, proof, receipt }) {
  return [
    dispatchProofInboxItem?.action,
    proof?.action,
    receipt?.action,
  ].some((action) => canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function requiresHumanFeedbackContractHash({ dispatchProofInboxItem, proof, receipt }) {
  const actionValues = [
    dispatchProofInboxItem?.action,
    proof?.action,
    receipt?.action,
  ];
  const productValues = [
    dispatchProofInboxItem?.payload?.productLineId,
    dispatchProofInboxItem?.payload?.workflowId,
    dispatchProofInboxItem?.payload?.packageRole,
    dispatchProofInboxItem?.payload?.reviewType,
    dispatchProofInboxItem?.payload?.role,
    proof?.payload?.productLineId,
    proof?.payload?.workflowId,
    proof?.payload?.packageRole,
    proof?.payload?.reviewType,
    proof?.payload?.role,
    receipt?.payload?.productLineId,
    receipt?.payload?.workflowId,
    receipt?.payload?.packageRole,
    receipt?.payload?.reviewType,
    receipt?.payload?.role,
  ];
  return Boolean(
    dispatchProofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
      || requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')
      || (
        actionValues.some((action) => isHumanFeedbackCustomerFacingAction(action))
        && (
          actionValues.some((action) => isHumanFeedbackMessageActionAlias(action))
          || productValues.some((id) => isHumanFeedbackIdentity(id))
        )
      ),
  );
}

function dispatchProofInboxBlockers(dispatchProofInboxItem, blockers) {
  if (dispatchProofInboxItem?.kind !== 'AdapterDispatchChannelStateProofInboxItem') {
    blockers.push(issue('invalid_dispatch_proof_inbox_kind'));
  }
  if (
    dispatchProofInboxItem
    && (
      dispatchProofInboxItem.status !== ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED
      || dispatchProofInboxItem.received !== true
    )
  ) {
    blockers.push(issue('dispatch_proof_inbox_not_received'));
  }
  if (
    dispatchProofInboxItem
    && dispatchProofInboxItem.nextStep !== ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY
  ) {
    blockers.push(issue('dispatch_proof_inbox_not_transition_ready'));
  }
  if (dispatchProofInboxItem?.kind === 'AdapterDispatchChannelStateProofInboxItem') {
    const recordedHash = hashOf(dispatchProofInboxItem, 'proofInboxHash');
    const recomputedHash = computeAdapterDispatchChannelStateProofInboxHash(dispatchProofInboxItem);
    if (!recordedHash) blockers.push(issue('dispatch_proof_inbox_hash_required'));
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('dispatch_proof_inbox_hash_content_mismatch'));
    }
    if (!dispatchProofInboxItem.hashBinding?.dispatchReceiptInboxHash) {
      blockers.push(issue('dispatch_proof_inbox_receipt_inbox_hash_missing'));
    }
    if (!dispatchProofInboxItem.hashBinding?.dispatchEnvelopeHash) {
      blockers.push(issue('dispatch_proof_inbox_dispatch_envelope_hash_missing'));
    }
    if (!dispatchProofInboxItem.hashBinding?.outboxHash) {
      blockers.push(issue('dispatch_proof_inbox_outbox_hash_missing'));
    }
    if (!dispatchProofInboxItem.hashBinding?.replayGuardHash) {
      blockers.push(issue('dispatch_proof_inbox_replay_guard_hash_missing'));
    }
    if (!dispatchProofInboxItem.hashBinding?.receiptHash) {
      blockers.push(issue('dispatch_proof_inbox_receipt_hash_missing'));
    }
    if (!dispatchProofInboxItem.hashBinding?.proofHash) {
      blockers.push(issue('dispatch_proof_inbox_proof_hash_missing'));
    }
    if (!dispatchProofInboxItem.hashBinding?.platformStateSnapshotHash) {
      blockers.push(issue('dispatch_proof_inbox_platform_state_snapshot_hash_missing'));
    }
    if (!dispatchProofInboxItem.hashBinding?.dryRunReplayHash) {
      blockers.push(issue('dispatch_proof_inbox_dry_run_replay_hash_missing'));
    }
  }
}

function proofBlockers(proof, blockers) {
  if (proof?.kind !== 'ChannelStateProof') blockers.push(issue('invalid_channel_state_proof'));
  if (proof && (proof.status !== CHANNEL_STATE_PROOF_STATUS.VERIFIED || proof.verified !== true)) {
    blockers.push(issue('channel_state_proof_not_verified'));
    propagateBlockers(proof, blockers);
  }
  if (proof?.kind === 'ChannelStateProof') {
    const storedHashes = storedHashAliases(proof, 'proofHash');
    const recordedHash = storedHashes.effectiveHash;
    const recomputedHash = computeChannelStateProofHash(proof);
    if (!recordedHash) blockers.push(issue('proof_hash_required'));
    if (!storedHashes.semanticHash) blockers.push(issue('proof_hash_alias_required'));
    if (!storedHashes.genericHash) blockers.push(issue('proof_generic_hash_required'));
    if (
      storedHashes.semanticHash
      && storedHashes.genericHash
      && storedHashes.semanticHash !== storedHashes.genericHash
    ) {
      blockers.push(issue('proof_hash_alias_mismatch'));
    }
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('proof_hash_content_mismatch'));
    }
  }
}

function receiptBlockers(receipt, blockers) {
  if (!receipt) return;
  if (receipt.kind !== 'AdapterRunReceipt') blockers.push(issue('invalid_receipt_kind'));
  if (receipt.status !== ADAPTER_RECEIPT_STATUS.ACCEPTED || receipt.accepted !== true) {
    blockers.push(issue('receipt_not_accepted'));
  }
  if (receipt.kind === 'AdapterRunReceipt') {
    const recordedHash = hashOf(receipt, 'receiptHash');
    const recomputedHash = computeAdapterRunReceiptHash(receipt);
    if (!recordedHash) blockers.push(issue('receipt_hash_required'));
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('receipt_hash_content_mismatch'));
    }
  }
  if (receipt.result?.status !== ADAPTER_RESULT_STATUS.SUCCESS) blockers.push(issue('receipt_result_not_success'));
}

function transitionBlockers(transition, blockers) {
  if (transition?.kind !== 'ReceiptStateTransition') blockers.push(issue('invalid_receipt_transition'));
  if (transition && (transition.status !== RECEIPT_TRANSITION_STATUS.READY || transition.ready !== true)) {
    blockers.push(issue('receipt_transition_not_ready'));
    propagateBlockers(transition, blockers);
  }
  if (transition?.kind === 'ReceiptStateTransition') {
    const storedHashes = storedHashAliases(transition, 'transitionHash');
    const recordedHash = storedHashes.effectiveHash;
    const recomputedHash = computeReceiptStateTransitionHash(transition);
    if (!recordedHash) blockers.push(issue('transition_hash_required'));
    if (!storedHashes.semanticHash) blockers.push(issue('transition_hash_alias_required'));
    if (!storedHashes.genericHash) blockers.push(issue('transition_generic_hash_required'));
    if (
      storedHashes.semanticHash
      && storedHashes.genericHash
      && storedHashes.semanticHash !== storedHashes.genericHash
    ) {
      blockers.push(issue('transition_hash_alias_mismatch'));
    }
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('transition_hash_content_mismatch'));
    }
  }
  if (transition?.result && transition.result.allowed !== true) {
    blockers.push(issue('receipt_transition_result_not_allowed'));
  }
  if (transition?.safety?.executesExternalAction === true || transition?.result?.safety?.executesExternalAction === true) {
    blockers.push(issue('transition_executes_external_action'));
  }
}

function compareIdentity({ dispatchProofInboxItem, proof, transition, receipt, blockers }) {
  compareField(dispatchProofInboxItem?.channelId, proof?.channelId, 'channel_id_mismatch', blockers);
  compareField(dispatchProofInboxItem?.channelId, receipt?.channelId, 'channel_id_mismatch', blockers);
  compareField(dispatchProofInboxItem?.actionId, proof?.actionId, 'action_id_mismatch', blockers);
  compareField(dispatchProofInboxItem?.actionId, receipt?.actionId, 'action_id_mismatch', blockers);
  compareActionField(dispatchProofInboxItem?.action, proof?.action, 'action_mismatch', blockers);
  compareActionField(dispatchProofInboxItem?.action, receipt?.action, 'action_mismatch', blockers);
  compareActionField(dispatchProofInboxItem?.action, transition?.result?.decision?.action, 'action_mismatch', blockers);
  compareField(dispatchProofInboxItem?.payload?.taskKey, proof?.payload?.taskKey, 'task_key_mismatch', blockers);
  compareField(dispatchProofInboxItem?.payload?.taskKey, receipt?.payload?.taskKey, 'task_key_mismatch', blockers);
  compareField(dispatchProofInboxItem?.payload?.taskKey, transition?.result?.taskKey, 'task_key_mismatch', blockers);
  compareField(dispatchProofInboxItem?.payload?.externalId, proof?.payload?.externalId, 'external_id_mismatch', blockers);
  compareField(dispatchProofInboxItem?.payload?.externalId, receipt?.payload?.externalId, 'external_id_mismatch', blockers);
  compareActionField(proof?.action, transition?.result?.decision?.action, 'action_mismatch', blockers);
  compareField(proof?.payload?.taskKey, transition?.result?.taskKey, 'task_key_mismatch', blockers);
  compareField(proof?.stateSuggestion?.fromStage, transition?.result?.previousStage, 'stage_mismatch', blockers);
  compareField(proof?.stateSuggestion?.toStage, transition?.result?.stage, 'stage_mismatch', blockers);
  compareField(proof?.stateSuggestion?.toStage, transition?.result?.requestedStage, 'requested_stage_mismatch', blockers);
}

function compareHashes({ dispatchProofInboxItem, proof, transition, receipt, blockers }) {
  const dispatchReceiptHash = receiptHashFromDispatchProofInbox(dispatchProofInboxItem);
  const dispatchProofHash = proofHashFromDispatchProofInbox(dispatchProofInboxItem);
  const dispatchMessagePreviewHash = dispatchProofInboxItem?.hashBinding?.messagePreviewHash || null;
  const dispatchHumanFeedbackContractHash = dispatchProofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash || null;
  const dispatchApprovalProvenanceHash = dispatchProofInboxItem?.hashBinding?.approvalProvenanceHash || null;
  if (requiresCustomerMessageHashes({ dispatchProofInboxItem, proof, receipt })) {
    if (!dispatchMessagePreviewHash) blockers.push(issue('dispatch_proof_inbox_message_preview_hash_missing'));
    if (!requiredProofHash(proof, 'messagePreviewHash')) {
      blockers.push(issue('proof_message_preview_hash_missing'));
    }
    if (receipt && !requiredReceiptHash(receipt, 'messagePreviewHash')) {
      blockers.push(issue('receipt_message_preview_hash_missing'));
    }
    if (!requiredTransitionHash(transition, 'messagePreviewHash')) {
      blockers.push(issue('transition_message_preview_hash_missing'));
    }
    if (proof) {
      const expectedMessagePreviewHash = dispatchMessagePreviewHash
        || requiredProofHash(proof, 'messagePreviewHash')
        || requiredReceiptHash(receipt, 'messagePreviewHash')
        || requiredTransitionHash(transition, 'messagePreviewHash');
      proofMessagePreviewHashSourceBlockers(proof, expectedMessagePreviewHash, blockers);
    }
  }
  if (requiresHumanFeedbackContractHash({ dispatchProofInboxItem, proof, receipt })) {
    if (!dispatchHumanFeedbackContractHash) blockers.push(issue('dispatch_proof_inbox_human_feedback_contract_hash_missing'));
    if (!requiredProofHash(proof, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('proof_human_feedback_contract_hash_missing'));
    }
    if (receipt && !requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('receipt_human_feedback_contract_hash_missing'));
    }
    if (!requiredTransitionHash(transition, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('transition_human_feedback_contract_hash_missing'));
    }
    if (proof) {
      const expectedHumanFeedbackContractHash = dispatchHumanFeedbackContractHash
        || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
        || requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')
        || requiredTransitionHash(transition, 'humanFeedbackRevisionContractHash');
      proofHumanFeedbackContractHashSourceBlockers(proof, expectedHumanFeedbackContractHash, blockers);
    }
  }
  compareHash(dispatchReceiptHash, proof?.receiptHash, 'receipt_hash_mismatch', blockers);
  compareHash(dispatchReceiptHash, hashOf(receipt, 'receiptHash'), 'receipt_hash_mismatch', blockers);
  compareHash(proof?.receiptHash, hashOf(receipt, 'receiptHash'), 'receipt_hash_mismatch', blockers);
  compareHash(dispatchProofHash, proof?.proofHash, 'proof_hash_mismatch', blockers);
  compareHash(dispatchProofHash, transition?.proofHash, 'proof_hash_mismatch', blockers);
  compareHash(proof?.proofHash, transition?.proofHash, 'proof_hash_mismatch', blockers);
  compareHash(dispatchReceiptHash, transition?.hashBinding?.receiptHash, 'transition_receipt_hash_mismatch', blockers);
  compareHash(dispatchProofHash, transition?.hashBinding?.proofHash, 'transition_proof_hash_mismatch', blockers);
  compareRequiredHash(dispatchApprovalProvenanceHash, requiredProofHash(proof, 'approvalProvenanceHash'), 'proof_approval_provenance_hash_missing', 'proof_approval_provenance_hash_mismatch', blockers);
  compareRequiredHash(dispatchApprovalProvenanceHash, requiredReceiptHash(receipt, 'approvalProvenanceHash'), 'receipt_approval_provenance_hash_missing', 'receipt_approval_provenance_hash_mismatch', blockers);
  compareRequiredHash(dispatchApprovalProvenanceHash, requiredTransitionHash(transition, 'approvalProvenanceHash'), 'transition_approval_provenance_hash_missing', 'transition_approval_provenance_hash_mismatch', blockers);
  compareRequiredHash(dispatchMessagePreviewHash, requiredProofHash(proof, 'messagePreviewHash'), 'proof_message_preview_hash_missing', 'proof_message_preview_hash_mismatch', blockers);
  compareRequiredHash(dispatchHumanFeedbackContractHash, requiredProofHash(proof, 'humanFeedbackRevisionContractHash'), 'proof_human_feedback_contract_hash_missing', 'proof_human_feedback_contract_hash_mismatch', blockers);
  compareRequiredHash(dispatchMessagePreviewHash, requiredReceiptHash(receipt, 'messagePreviewHash'), 'receipt_message_preview_hash_missing', 'receipt_message_preview_hash_mismatch', blockers);
  compareRequiredHash(dispatchHumanFeedbackContractHash, requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash'), 'receipt_human_feedback_contract_hash_missing', 'receipt_human_feedback_contract_hash_mismatch', blockers);
  compareRequiredHash(dispatchMessagePreviewHash, requiredTransitionHash(transition, 'messagePreviewHash'), 'transition_message_preview_hash_missing', 'transition_message_preview_hash_mismatch', blockers);
  const expectedPromptGenerationBinding = dispatchProofInboxItem?.hashBinding?.promptGenerationBinding || null;
  const promptGenerationBindingRequired = requiresPromptGenerationBinding({
    dispatchProofInboxItem,
    proof,
    transition,
    receipt,
  });
  if (promptGenerationBindingRequired && !expectedPromptGenerationBinding) {
    blockers.push(issue('dispatch_proof_inbox_prompt_generation_binding_missing'));
  }
  if (expectedPromptGenerationBinding || promptGenerationBindingRequired) {
    if (expectedPromptGenerationBinding) {
      const missingExpectedKeys = missingPromptGenerationBindingKeys(expectedPromptGenerationBinding);
      if (missingExpectedKeys.length) {
        blockers.push(issue('dispatch_proof_inbox_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
      }
    }
    const actualTransitionPromptGenerationBinding = transitionPromptGenerationBinding(transition);
    if (!actualTransitionPromptGenerationBinding) {
      blockers.push(issue('transition_prompt_generation_binding_missing'));
    } else {
      const missingTransitionKeys = missingPromptGenerationBindingKeys(actualTransitionPromptGenerationBinding);
      if (missingTransitionKeys.length) {
        blockers.push(issue('transition_prompt_generation_binding_incomplete', missingTransitionKeys.join(', ')));
      }
      if (
        expectedPromptGenerationBinding
        && !samePromptGenerationBinding(expectedPromptGenerationBinding, actualTransitionPromptGenerationBinding)
      ) {
        blockers.push(issue('transition_prompt_generation_binding_mismatch'));
      }
    }
    pushPromptGenerationBindingSourceBlockers(blockers, [
      {
        binding: transition?.hashBinding?.promptGenerationBinding,
        required: true,
        missingCode: 'transition_prompt_generation_binding_missing',
        incompleteCode: 'transition_prompt_generation_binding_incomplete',
        mismatchCode: 'transition_prompt_generation_binding_mismatch',
      },
    ], expectedPromptGenerationBinding);
    const actualProofPromptGenerationBinding = proofPromptGenerationBinding(proof);
    if (!actualProofPromptGenerationBinding) {
      blockers.push(issue('proof_prompt_generation_binding_missing'));
    } else {
      const missingProofKeys = missingPromptGenerationBindingKeys(actualProofPromptGenerationBinding);
      if (missingProofKeys.length) {
        blockers.push(issue('proof_prompt_generation_binding_incomplete', missingProofKeys.join(', ')));
      }
      if (
        expectedPromptGenerationBinding
        && !samePromptGenerationBinding(expectedPromptGenerationBinding, actualProofPromptGenerationBinding)
      ) {
        blockers.push(issue('proof_prompt_generation_binding_mismatch'));
      }
      pushPromptGenerationBindingSourceBlockers(blockers, [
        {
          binding: proof?.hashBinding?.promptGenerationBinding,
          required: true,
          missingCode: 'proof_hash_binding_prompt_generation_binding_missing',
          incompleteCode: 'proof_hash_binding_prompt_generation_binding_incomplete',
          mismatchCode: 'proof_hash_binding_prompt_generation_binding_mismatch',
        },
        {
          binding: proof?.payload?.promptGenerationBinding,
          required: true,
          missingCode: 'proof_payload_prompt_generation_binding_missing',
          incompleteCode: 'proof_payload_prompt_generation_binding_incomplete',
          mismatchCode: 'proof_payload_prompt_generation_binding_mismatch',
        },
        {
          binding: proof?.evidence?.promptGenerationBinding,
          required: true,
          missingCode: 'proof_evidence_prompt_generation_binding_missing',
          incompleteCode: 'proof_evidence_prompt_generation_binding_incomplete',
          mismatchCode: 'proof_evidence_prompt_generation_binding_mismatch',
        },
      ], expectedPromptGenerationBinding);
    }
    if (receipt) {
      const actualReceiptPromptGenerationBinding = receiptPromptGenerationBinding(receipt);
      if (!actualReceiptPromptGenerationBinding) {
        blockers.push(issue('receipt_prompt_generation_binding_missing'));
      } else {
        const missingReceiptKeys = missingPromptGenerationBindingKeys(actualReceiptPromptGenerationBinding);
        if (missingReceiptKeys.length) {
          blockers.push(issue('receipt_prompt_generation_binding_incomplete', missingReceiptKeys.join(', ')));
        }
        if (
          expectedPromptGenerationBinding
          && !samePromptGenerationBinding(expectedPromptGenerationBinding, actualReceiptPromptGenerationBinding)
        ) {
          blockers.push(issue('receipt_prompt_generation_binding_mismatch'));
        }
      }
      pushPromptGenerationBindingSourceBlockers(blockers, [
        {
          binding: receipt?.hashBinding?.promptGenerationBinding,
          required: true,
          missingCode: 'receipt_hash_binding_prompt_generation_binding_missing',
          incompleteCode: 'receipt_hash_binding_prompt_generation_binding_incomplete',
          mismatchCode: 'receipt_hash_binding_prompt_generation_binding_mismatch',
        },
        {
          binding: receipt?.payload?.promptGenerationBinding,
          required: true,
          missingCode: 'receipt_payload_prompt_generation_binding_missing',
          incompleteCode: 'receipt_payload_prompt_generation_binding_incomplete',
          mismatchCode: 'receipt_payload_prompt_generation_binding_mismatch',
        },
        {
          binding: receipt?.result?.external?.promptGenerationBinding,
          required: false,
          missingCode: 'receipt_external_prompt_generation_binding_missing',
          incompleteCode: 'receipt_external_prompt_generation_binding_incomplete',
          mismatchCode: 'receipt_external_prompt_generation_binding_mismatch',
        },
      ], expectedPromptGenerationBinding);
    }
  }
  if (requiresCustomerMessageHashes({ dispatchProofInboxItem, proof, receipt })) {
    const expectedMessagePreviewHash = dispatchMessagePreviewHash
      || requiredProofHash(proof, 'messagePreviewHash')
      || requiredReceiptHash(receipt, 'messagePreviewHash')
      || requiredTransitionHash(transition, 'messagePreviewHash');
    addMessagePreviewContentBlocker(
      proof?.payload,
      expectedMessagePreviewHash,
      'proof_message_preview_hash_content_mismatch',
      blockers,
    );
    addMessagePreviewContentBlocker(
      proof?.evidence,
      expectedMessagePreviewHash,
      'proof_evidence_message_preview_hash_content_mismatch',
      blockers,
    );
    addMessagePreviewContentBlocker(
      receipt?.payload,
      expectedMessagePreviewHash,
      'receipt_message_preview_hash_content_mismatch',
      blockers,
    );
    addMessagePreviewContentBlocker(
      receipt?.result?.external,
      expectedMessagePreviewHash,
      'receipt_external_message_preview_hash_content_mismatch',
      blockers,
    );
  }
  compareRequiredHash(dispatchHumanFeedbackContractHash, requiredTransitionHash(transition, 'humanFeedbackRevisionContractHash'), 'transition_human_feedback_contract_hash_missing', 'transition_human_feedback_contract_hash_mismatch', blockers);
  compareHash(
    dispatchProofInboxItem?.hashBinding?.platformStateSnapshotHash,
    transition?.hashBinding?.platformStateSnapshotHash,
    'transition_platform_state_snapshot_hash_mismatch',
    blockers,
  );
  compareHash(
    dispatchProofInboxItem?.hashBinding?.dryRunReplayHash,
    transition?.hashBinding?.dryRunReplayHash,
    'transition_dry_run_replay_hash_mismatch',
    blockers,
  );
}

function inboxBlockers({ dispatchProofInboxItem, proof, transition, receipt }) {
  const blockers = [];
  dispatchProofInboxBlockers(dispatchProofInboxItem, blockers);
  proofBlockers(proof, blockers);
  receiptBlockers(receipt, blockers);
  transitionBlockers(transition, blockers);
  compareHashes({ dispatchProofInboxItem, proof, transition, receipt, blockers });
  compareIdentity({ dispatchProofInboxItem, proof, transition, receipt, blockers });
  return blockers;
}

export function buildAdapterDispatchReceiptStateTransitionInboxItem({
  dispatchProofInboxItem = null,
  proof = null,
  transition = null,
  receipt = null,
  receivedBy = 'design-production-core.adapter-dispatch-receipt-state-transition-inbox',
  evidenceRefs = [],
  receivedAt = null,
  createdAt = null,
} = {}) {
  const blockers = inboxBlockers({ dispatchProofInboxItem, proof, transition, receipt });
  const nextStep = blockers.length
    ? ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP.BLOCKED
    : ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY;
  const action = canonicalActionOrNull(
    dispatchProofInboxItem?.action || proof?.action || receipt?.action || transition?.result?.decision?.action,
  );
  const productLineId = canonicalProductLineOrNull(
    dispatchProofInboxItem?.payload?.productLineId || proof?.payload?.productLineId || receipt?.payload?.productLineId,
  );
  const workflowId = canonicalProductLineOrNull(
    dispatchProofInboxItem?.payload?.workflowId || proof?.payload?.workflowId || receipt?.payload?.workflowId,
  );
  const packageRole = canonicalPackageRole(
    dispatchProofInboxItem?.payload?.packageRole || proof?.payload?.packageRole || receipt?.payload?.packageRole || '',
  ) || null;
  const item = {
    version: ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_VERSION,
    kind: 'AdapterDispatchReceiptStateTransitionInboxItem',
    receivedBy: normalizeText(receivedBy || 'design-production-core.adapter-dispatch-receipt-state-transition-inbox'),
    status: blockers.length
      ? ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS.BLOCKED
      : ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED,
    received: blockers.length === 0,
    nextStep,
    channelId: dispatchProofInboxItem?.channelId || proof?.channelId || receipt?.channelId || null,
    actionId: dispatchProofInboxItem?.actionId || proof?.actionId || receipt?.actionId || null,
    action,
    payload: {
      taskKey: dispatchProofInboxItem?.payload?.taskKey || proof?.payload?.taskKey || receipt?.payload?.taskKey || transition?.result?.taskKey || null,
      externalId: dispatchProofInboxItem?.payload?.externalId || proof?.payload?.externalId || receipt?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole,
      resultStatus: dispatchProofInboxItem?.payload?.resultStatus || proof?.resultStatus || receipt?.result?.status || null,
      fromStage: transition?.result?.previousStage || proof?.stateSuggestion?.fromStage || null,
      toStage: transition?.result?.stage || proof?.stateSuggestion?.toStage || null,
      requestedStage: transition?.result?.requestedStage || proof?.stateSuggestion?.toStage || null,
    },
    hashBinding: {
      dispatchProofInboxHash: hashOf(dispatchProofInboxItem, 'proofInboxHash'),
      dispatchReceiptInboxHash: dispatchProofInboxItem?.hashBinding?.dispatchReceiptInboxHash || null,
      dispatchEnvelopeHash: dispatchProofInboxItem?.hashBinding?.dispatchEnvelopeHash || null,
      outboxHash: dispatchProofInboxItem?.hashBinding?.outboxHash || null,
      replayGuardHash: dispatchProofInboxItem?.hashBinding?.replayGuardHash || null,
      archiveHash: dispatchProofInboxItem?.hashBinding?.archiveHash || null,
      ledgerHash: dispatchProofInboxItem?.hashBinding?.ledgerHash || null,
      receiptHash: receiptHashFromDispatchProofInbox(dispatchProofInboxItem) || null,
      proofHash: proofHashFromDispatchProofInbox(dispatchProofInboxItem) || null,
      approvalProvenanceHash: dispatchProofInboxItem?.hashBinding?.approvalProvenanceHash
        || requiredProofHash(proof, 'approvalProvenanceHash')
        || requiredReceiptHash(receipt, 'approvalProvenanceHash')
        || null,
      platformStateSnapshotHash: dispatchProofInboxItem?.hashBinding?.platformStateSnapshotHash
        || proof?.hashBinding?.platformStateSnapshotHash
        || receipt?.hashBinding?.platformStateSnapshotHash
        || null,
      dryRunReplayHash: dispatchProofInboxItem?.hashBinding?.dryRunReplayHash
        || proof?.hashBinding?.dryRunReplayHash
        || receipt?.hashBinding?.dryRunReplayHash
        || null,
      humanFeedbackRevisionContractHash: dispatchProofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
        || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
        || requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')
        || null,
      messagePreviewHash: dispatchProofInboxItem?.hashBinding?.messagePreviewHash
        || requiredProofHash(proof, 'messagePreviewHash')
        || requiredReceiptHash(receipt, 'messagePreviewHash')
        || null,
      promptGenerationBinding: transitionPromptGenerationBinding(transition)
        || dispatchProofInboxItem?.hashBinding?.promptGenerationBinding
        || proofPromptGenerationBinding(proof)
        || receiptPromptGenerationBinding(receipt),
      transitionHash: transitionHashOf(transition),
    },
    blockers,
    warnings: [
      issue('dispatch_transition_inbox_verifies_only', 'Core dispatch transition inbox items never apply lifecycle state or run adapters.', 'warning'),
      ...(nextStep === ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY
        ? [issue('external_action_ledger_required', 'A ready dispatch transition still needs final external action ledger verification.', 'warning')]
        : []),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      dispatchReceiptStateTransitionInboxOnly: true,
      executesExternalAction: false,
      appliesLocalStateTransition: false,
      fetchesChannelState: false,
      grantsExecutionPermission: false,
      requiresDispatchProofInbox: true,
      requiresReadyTransition: true,
      externalActionLedgerStillRequired: nextStep === ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY,
    },
    receivedAt: receivedAt || createdAt || new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  };
  const transitionInboxHash = computeAdapterDispatchReceiptStateTransitionInboxHash(item);
  return {
    ...item,
    transitionInboxHash,
    hash: transitionInboxHash,
  };
}

export function computeAdapterDispatchReceiptStateTransitionInboxHash(item = null) {
  return digest({
    version: item?.version,
    kind: item?.kind,
    receivedBy: item?.receivedBy,
    status: item?.status,
    received: item?.received,
    nextStep: item?.nextStep,
    channelId: item?.channelId,
    actionId: item?.actionId,
    action: canonicalActionOrNull(item?.action),
    payload: canonicalHashPayload(item?.payload),
    hashBinding: item?.hashBinding,
    blockers: item?.blockers,
    warnings: item?.warnings,
    evidenceRefs: item?.evidenceRefs,
    safety: item?.safety,
    receivedAt: item?.receivedAt,
  });
}

export function summarizeAdapterDispatchReceiptStateTransitionInbox(items = []) {
  const byStatus = {};
  const byNextStep = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  for (const item of items || []) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    byNextStep[item.nextStep] = (byNextStep[item.nextStep] || 0) + 1;
    const channelId = item.channelId || 'unknown';
    byChannel[channelId] = (byChannel[channelId] || 0) + 1;
    const actionId = item.actionId || 'unknown';
    byActionId[actionId] = (byActionId[actionId] || 0) + 1;
    for (const blocker of item.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_VERSION,
    count: items.length,
    byStatus,
    byNextStep,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      dispatchReceiptStateTransitionInboxOnly: true,
      executesExternalAction: items.some((item) => item.safety?.executesExternalAction === true),
      appliesLocalStateTransition: items.some((item) => item.safety?.appliesLocalStateTransition === true),
      fetchesChannelState: items.some((item) => item.safety?.fetchesChannelState === true),
      grantsExecutionPermission: items.some((item) => item.safety?.grantsExecutionPermission === true),
    },
  };
}
