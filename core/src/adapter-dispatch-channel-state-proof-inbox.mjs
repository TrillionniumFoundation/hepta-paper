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
  ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS,
  ADAPTER_DISPATCH_RECEIPT_NEXT_STEP,
  computeAdapterDispatchReceiptInboxHash,
} from './adapter-dispatch-receipt-inbox.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, computeAdapterRunReceiptHash } from './adapter-receipt.mjs';
import { CHANNEL_STATE_PROOF_STATUS, computeChannelStateProofHash } from './channel-state-proof.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_VERSION = 1;

export const ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS = Object.freeze({
  RECEIVED: 'received_dispatch_channel_state_proof',
  BLOCKED: 'blocked_dispatch_channel_state_proof_inbox',
});

export const ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP = Object.freeze({
  RECEIPT_STATE_TRANSITION_READY: 'receipt_state_transition_ready',
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

function receiptHashFromInbox(inboxItem) {
  return normalizeText(inboxItem?.hashBinding?.receiptHash || '') || null;
}

function expectedReceiptHash(receipt) {
  return receipt?.kind === 'AdapterRunReceipt' ? computeAdapterRunReceiptHash(receipt) : null;
}

function expectedProofHash(proof) {
  return proof?.kind === 'ChannelStateProof' ? computeChannelStateProofHash(proof) : null;
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

function isPromptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonical === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function requiresPromptGenerationBinding({ dispatchReceiptInboxItem, proof, receipt }) {
  return [
    dispatchReceiptInboxItem?.action,
    dispatchReceiptInboxItem?.payload?.action,
    proof?.action,
    proof?.payload?.action,
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

function compareRequiredProofHash(expected, actual, missingCode, mismatchCode, blockers) {
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

function propagateProofBlockers(proof, blockers) {
  for (const blocker of proof?.blockers || []) {
    if (!blockers.some((item) => item.code === blocker.code)) blockers.push(blocker);
  }
}

function requiresCustomerMessageHashes({ dispatchReceiptInboxItem, proof, receipt }) {
  return [
    dispatchReceiptInboxItem?.action,
    proof?.action,
    receipt?.action,
  ].some((action) => canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function requiresHumanFeedbackContractHash({ dispatchReceiptInboxItem, proof, receipt }) {
  const actionValues = [
    dispatchReceiptInboxItem?.action,
    proof?.action,
    receipt?.action,
  ];
  const productValues = [
    dispatchReceiptInboxItem?.payload?.productLineId,
    dispatchReceiptInboxItem?.payload?.workflowId,
    dispatchReceiptInboxItem?.payload?.packageRole,
    dispatchReceiptInboxItem?.payload?.reviewType,
    dispatchReceiptInboxItem?.payload?.role,
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
    dispatchReceiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
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

function inboxBlockers({ dispatchReceiptInboxItem, proof, receipt }) {
  const blockers = [];

  if (dispatchReceiptInboxItem?.kind !== 'AdapterDispatchReceiptInboxItem') {
    blockers.push(issue('invalid_dispatch_receipt_inbox_kind'));
  }
  if (
    dispatchReceiptInboxItem
    && (
      dispatchReceiptInboxItem.status !== ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.RECEIVED
      || dispatchReceiptInboxItem.received !== true
    )
  ) {
    blockers.push(issue('dispatch_receipt_inbox_not_received'));
  }
  if (
    dispatchReceiptInboxItem
    && dispatchReceiptInboxItem.nextStep !== ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED
  ) {
    blockers.push(issue('dispatch_receipt_inbox_not_waiting_for_proof'));
  }
  if (dispatchReceiptInboxItem?.kind === 'AdapterDispatchReceiptInboxItem') {
    const recordedHash = hashOf(dispatchReceiptInboxItem, 'inboxHash');
    const recomputedHash = computeAdapterDispatchReceiptInboxHash(dispatchReceiptInboxItem);
    if (!recordedHash) blockers.push(issue('dispatch_receipt_inbox_hash_required'));
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('dispatch_receipt_inbox_hash_content_mismatch'));
    }
    if (!dispatchReceiptInboxItem.hashBinding?.dispatchEnvelopeHash) {
      blockers.push(issue('dispatch_receipt_inbox_dispatch_envelope_hash_missing'));
    }
    if (!dispatchReceiptInboxItem.hashBinding?.outboxHash) {
      blockers.push(issue('dispatch_receipt_inbox_outbox_hash_missing'));
    }
    if (!dispatchReceiptInboxItem.hashBinding?.replayGuardHash) {
      blockers.push(issue('dispatch_receipt_inbox_replay_guard_hash_missing'));
    }
    if (!dispatchReceiptInboxItem.hashBinding?.receiptHash) {
      blockers.push(issue('dispatch_receipt_inbox_receipt_hash_missing'));
    }
    if (!dispatchReceiptInboxItem.hashBinding?.platformStateSnapshotHash) {
      blockers.push(issue('dispatch_receipt_inbox_platform_state_snapshot_hash_missing'));
    }
    if (!dispatchReceiptInboxItem.hashBinding?.dryRunReplayHash) {
      blockers.push(issue('dispatch_receipt_inbox_dry_run_replay_hash_missing'));
    }
  }

  if (proof?.kind !== 'ChannelStateProof') blockers.push(issue('invalid_channel_state_proof'));
  if (proof && (proof.status !== CHANNEL_STATE_PROOF_STATUS.VERIFIED || proof.verified !== true)) {
    blockers.push(issue('channel_state_proof_not_verified'));
    propagateProofBlockers(proof, blockers);
  }
  if (proof?.kind === 'ChannelStateProof') {
    const storedHashes = storedHashAliases(proof, 'proofHash');
    const recordedHash = storedHashes.effectiveHash;
    const recomputedHash = expectedProofHash(proof);
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

  if (requiresCustomerMessageHashes({ dispatchReceiptInboxItem, proof, receipt })) {
    if (!dispatchReceiptInboxItem?.hashBinding?.messagePreviewHash) {
      blockers.push(issue('dispatch_receipt_inbox_message_preview_hash_missing'));
    }
    if (!requiredProofHash(proof, 'messagePreviewHash')) {
      blockers.push(issue('proof_message_preview_hash_missing'));
    }
    if (receipt && !requiredReceiptHash(receipt, 'messagePreviewHash')) {
      blockers.push(issue('receipt_message_preview_hash_missing'));
    }
  }
  if (requiresHumanFeedbackContractHash({ dispatchReceiptInboxItem, proof, receipt })) {
    if (!dispatchReceiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('dispatch_receipt_inbox_human_feedback_contract_hash_missing'));
    }
    if (!requiredProofHash(proof, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('proof_human_feedback_contract_hash_missing'));
    }
    if (receipt && !requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('receipt_human_feedback_contract_hash_missing'));
    }
  }

  compareHash(receiptHashFromInbox(dispatchReceiptInboxItem), proof?.receiptHash, 'receipt_hash_mismatch', blockers);
  compareHash(dispatchReceiptInboxItem?.hashBinding?.approvalProvenanceHash, proof?.hashBinding?.approvalProvenanceHash, 'approval_provenance_hash_mismatch', blockers);
  compareHash(dispatchReceiptInboxItem?.hashBinding?.platformStateSnapshotHash, proof?.hashBinding?.platformStateSnapshotHash, 'platform_state_snapshot_hash_mismatch', blockers);
  compareHash(dispatchReceiptInboxItem?.hashBinding?.dryRunReplayHash, proof?.hashBinding?.dryRunReplayHash, 'dry_run_replay_hash_mismatch', blockers);
  compareRequiredProofHash(
    dispatchReceiptInboxItem?.hashBinding?.messagePreviewHash,
    requiredProofHash(proof, 'messagePreviewHash'),
    'proof_message_preview_hash_missing',
    'proof_message_preview_hash_mismatch',
    blockers,
  );
  compareRequiredProofHash(
    dispatchReceiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
    requiredProofHash(proof, 'humanFeedbackRevisionContractHash'),
    'proof_human_feedback_contract_hash_missing',
    'proof_human_feedback_contract_hash_mismatch',
    blockers,
  );
  const expectedPromptGenerationBinding = dispatchReceiptInboxItem?.hashBinding?.promptGenerationBinding || null;
  const promptGenerationBindingRequired = requiresPromptGenerationBinding({ dispatchReceiptInboxItem, proof, receipt });
  if (promptGenerationBindingRequired && !expectedPromptGenerationBinding) {
    blockers.push(issue('dispatch_receipt_inbox_prompt_generation_binding_missing'));
  }
  if (expectedPromptGenerationBinding || promptGenerationBindingRequired) {
    if (expectedPromptGenerationBinding) {
      const missingExpectedKeys = missingPromptGenerationBindingKeys(expectedPromptGenerationBinding);
      if (missingExpectedKeys.length) {
        blockers.push(issue('dispatch_receipt_inbox_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
      }
    }
    const actualProofPromptGenerationBinding = proofPromptGenerationBinding(proof);
    if (!actualProofPromptGenerationBinding) {
      blockers.push(issue('prompt_generation_binding_missing'));
    } else {
      const missingProofKeys = missingPromptGenerationBindingKeys(actualProofPromptGenerationBinding);
      if (missingProofKeys.length) {
        blockers.push(issue('prompt_generation_binding_incomplete', missingProofKeys.join(', ')));
      }
      if (
        expectedPromptGenerationBinding
        && !samePromptGenerationBinding(expectedPromptGenerationBinding, actualProofPromptGenerationBinding)
      ) {
        blockers.push(issue('prompt_generation_binding_mismatch'));
      }
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
  if (requiresCustomerMessageHashes({ dispatchReceiptInboxItem, proof, receipt })) {
    const expectedMessagePreviewHash = dispatchReceiptInboxItem?.hashBinding?.messagePreviewHash
      || requiredProofHash(proof, 'messagePreviewHash')
      || requiredReceiptHash(receipt, 'messagePreviewHash');
    proofMessagePreviewHashSourceBlockers(proof, expectedMessagePreviewHash, blockers);
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
  if (requiresHumanFeedbackContractHash({ dispatchReceiptInboxItem, proof, receipt })) {
    const expectedHumanFeedbackContractHash = dispatchReceiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
      || requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash');
    proofHumanFeedbackContractHashSourceBlockers(proof, expectedHumanFeedbackContractHash, blockers);
  }
  compareField(dispatchReceiptInboxItem?.channelId, proof?.channelId, 'channel_id_mismatch', blockers);
  compareField(dispatchReceiptInboxItem?.actionId, proof?.actionId, 'action_id_mismatch', blockers);
  compareActionField(dispatchReceiptInboxItem?.action, proof?.action, 'action_mismatch', blockers);
  compareField(dispatchReceiptInboxItem?.payload?.taskKey, proof?.payload?.taskKey, 'task_key_mismatch', blockers);
  compareField(dispatchReceiptInboxItem?.payload?.externalId, proof?.payload?.externalId, 'external_id_mismatch', blockers);

  if (receipt) {
    if (receipt.kind !== 'AdapterRunReceipt') blockers.push(issue('invalid_receipt_kind'));
    if (receipt.status !== ADAPTER_RECEIPT_STATUS.ACCEPTED || receipt.accepted !== true) {
      blockers.push(issue('receipt_not_accepted'));
    }
    const storedHashes = storedHashAliases(receipt, 'receiptHash');
    const recordedHash = storedHashes.effectiveHash;
    const recomputedHash = expectedReceiptHash(receipt);
    if (!recordedHash) blockers.push(issue('receipt_hash_required'));
    if (!storedHashes.semanticHash) blockers.push(issue('receipt_hash_alias_required'));
    if (!storedHashes.genericHash) blockers.push(issue('receipt_generic_hash_required'));
    if (
      storedHashes.semanticHash
      && storedHashes.genericHash
      && storedHashes.semanticHash !== storedHashes.genericHash
    ) {
      blockers.push(issue('receipt_hash_alias_mismatch'));
    }
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('receipt_hash_content_mismatch'));
    }
    if (receipt.result?.status !== ADAPTER_RESULT_STATUS.SUCCESS) blockers.push(issue('receipt_result_not_success'));
    compareHash(receiptHashFromInbox(dispatchReceiptInboxItem), receipt?.receiptHash, 'receipt_hash_mismatch', blockers);
    compareHash(proof?.receiptHash, receipt?.receiptHash, 'receipt_hash_mismatch', blockers);
    compareHash(proof?.hashBinding?.approvalProvenanceHash, receipt.hashBinding?.approvalProvenanceHash, 'approval_provenance_hash_mismatch', blockers);
    compareHash(proof?.hashBinding?.platformStateSnapshotHash, receipt.hashBinding?.platformStateSnapshotHash, 'platform_state_snapshot_hash_mismatch', blockers);
    compareHash(proof?.hashBinding?.dryRunReplayHash, receipt.hashBinding?.dryRunReplayHash, 'dry_run_replay_hash_mismatch', blockers);
    compareRequiredProofHash(
      dispatchReceiptInboxItem?.hashBinding?.messagePreviewHash,
      requiredReceiptHash(receipt, 'messagePreviewHash'),
      'receipt_message_preview_hash_missing',
      'receipt_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredProofHash(
      dispatchReceiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
      requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash'),
      'receipt_human_feedback_contract_hash_missing',
      'receipt_human_feedback_contract_hash_mismatch',
      blockers,
    );
    if (expectedPromptGenerationBinding || promptGenerationBindingRequired) {
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
    compareField(dispatchReceiptInboxItem?.channelId, receipt.channelId, 'channel_id_mismatch', blockers);
    compareField(dispatchReceiptInboxItem?.actionId, receipt.actionId, 'action_id_mismatch', blockers);
    compareActionField(dispatchReceiptInboxItem?.action, receipt.action, 'action_mismatch', blockers);
    compareField(dispatchReceiptInboxItem?.payload?.taskKey, receipt.payload?.taskKey, 'task_key_mismatch', blockers);
    compareField(dispatchReceiptInboxItem?.payload?.externalId, receipt.payload?.externalId, 'external_id_mismatch', blockers);
  }

  return blockers;
}

export function buildAdapterDispatchChannelStateProofInboxItem({
  dispatchReceiptInboxItem = null,
  proof = null,
  receipt = null,
  receivedBy = 'design-production-core.adapter-dispatch-channel-state-proof-inbox',
  evidenceRefs = [],
  receivedAt = null,
  createdAt = null,
} = {}) {
  const blockers = inboxBlockers({ dispatchReceiptInboxItem, proof, receipt });
  const nextStep = blockers.length
    ? ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP.BLOCKED
    : ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY;
  const action = canonicalActionOrNull(dispatchReceiptInboxItem?.action || proof?.action || receipt?.action);
  const productLineId = canonicalProductLineOrNull(
    dispatchReceiptInboxItem?.payload?.productLineId || proof?.payload?.productLineId || receipt?.payload?.productLineId,
  );
  const workflowId = canonicalProductLineOrNull(
    dispatchReceiptInboxItem?.payload?.workflowId || proof?.payload?.workflowId || receipt?.payload?.workflowId,
  );
  const packageRole = canonicalPackageRole(
    dispatchReceiptInboxItem?.payload?.packageRole || proof?.payload?.packageRole || receipt?.payload?.packageRole || '',
  ) || null;
  const item = {
    version: ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_VERSION,
    kind: 'AdapterDispatchChannelStateProofInboxItem',
    receivedBy: normalizeText(receivedBy || 'design-production-core.adapter-dispatch-channel-state-proof-inbox'),
    status: blockers.length
      ? ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS.BLOCKED
      : ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED,
    received: blockers.length === 0,
    nextStep,
    channelId: dispatchReceiptInboxItem?.channelId || proof?.channelId || receipt?.channelId || null,
    actionId: dispatchReceiptInboxItem?.actionId || proof?.actionId || receipt?.actionId || null,
    action,
    payload: {
      taskKey: dispatchReceiptInboxItem?.payload?.taskKey || proof?.payload?.taskKey || receipt?.payload?.taskKey || null,
      externalId: dispatchReceiptInboxItem?.payload?.externalId || proof?.payload?.externalId || receipt?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole,
      resultStatus: dispatchReceiptInboxItem?.payload?.resultStatus || proof?.resultStatus || receipt?.result?.status || null,
    },
    hashBinding: {
      dispatchReceiptInboxHash: hashOf(dispatchReceiptInboxItem, 'inboxHash'),
      dispatchEnvelopeHash: dispatchReceiptInboxItem?.hashBinding?.dispatchEnvelopeHash || null,
      outboxHash: dispatchReceiptInboxItem?.hashBinding?.outboxHash || null,
      replayGuardHash: dispatchReceiptInboxItem?.hashBinding?.replayGuardHash || null,
      archiveHash: dispatchReceiptInboxItem?.hashBinding?.archiveHash || null,
      ledgerHash: dispatchReceiptInboxItem?.hashBinding?.ledgerHash || null,
      receiptHash: receiptHashFromInbox(dispatchReceiptInboxItem) || null,
      proofHash: proof?.proofHash || null,
      approvalProvenanceHash: requiredProofHash(proof, 'approvalProvenanceHash')
        || dispatchReceiptInboxItem?.hashBinding?.approvalProvenanceHash
        || receipt?.hashBinding?.approvalProvenanceHash
        || null,
      platformStateSnapshotHash: proof?.hashBinding?.platformStateSnapshotHash || dispatchReceiptInboxItem?.hashBinding?.platformStateSnapshotHash || receipt?.hashBinding?.platformStateSnapshotHash || null,
      dryRunReplayHash: proof?.hashBinding?.dryRunReplayHash || dispatchReceiptInboxItem?.hashBinding?.dryRunReplayHash || receipt?.hashBinding?.dryRunReplayHash || null,
      humanFeedbackRevisionContractHash: requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
        || dispatchReceiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
        || receipt?.payload?.humanFeedbackRevisionContractHash
        || receipt?.result?.external?.humanFeedbackRevisionContractHash
        || null,
      messagePreviewHash: requiredProofHash(proof, 'messagePreviewHash')
        || dispatchReceiptInboxItem?.hashBinding?.messagePreviewHash
        || receipt?.payload?.messagePreviewHash
        || receipt?.result?.external?.messagePreviewHash
        || null,
      promptGenerationBinding: proofPromptGenerationBinding(proof)
        || dispatchReceiptInboxItem?.hashBinding?.promptGenerationBinding
        || receiptPromptGenerationBinding(receipt),
    },
    blockers,
    warnings: [
      issue('dispatch_proof_inbox_verifies_only', 'Core dispatch proof inbox items never fetch channel state or apply lifecycle transitions.', 'warning'),
      ...(nextStep === ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY
        ? [issue('receipt_state_transition_required', 'A verified dispatch proof still needs the local receipt state transition step.', 'warning')]
        : []),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      dispatchChannelStateProofInboxOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
      requiresDispatchReceiptInbox: true,
      requiresVerifiedProof: true,
      localStateTransitionStillRequired: nextStep === ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY,
    },
    receivedAt: receivedAt || createdAt || new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  };
  const proofInboxHash = computeAdapterDispatchChannelStateProofInboxHash(item);
  return {
    ...item,
    proofInboxHash,
    hash: proofInboxHash,
  };
}

export function computeAdapterDispatchChannelStateProofInboxHash(item = null) {
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

export function summarizeAdapterDispatchChannelStateProofInbox(items = []) {
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
    version: ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_VERSION,
    count: items.length,
    byStatus,
    byNextStep,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      dispatchChannelStateProofInboxOnly: true,
      executesExternalAction: items.some((item) => item.safety?.executesExternalAction === true),
      fetchesChannelState: items.some((item) => item.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: items.some((item) => item.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: items.some((item) => item.safety?.grantsExecutionPermission === true),
    },
  };
}
