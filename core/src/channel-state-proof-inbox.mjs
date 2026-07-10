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
  ADAPTER_RECEIPT_INBOX_STATUS,
  ADAPTER_RECEIPT_NEXT_STEP,
  computeAdapterReceiptInboxHash,
} from './adapter-receipt-inbox.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, computeAdapterRunReceiptHash } from './adapter-receipt.mjs';
import { CHANNEL_STATE_PROOF_STATUS, computeChannelStateProofHash } from './channel-state-proof.mjs';
import { digest } from './hash-utils.mjs';

export const CHANNEL_STATE_PROOF_INBOX_VERSION = 1;

export const CHANNEL_STATE_PROOF_INBOX_STATUS = Object.freeze({
  RECEIVED: 'received_channel_state_proof',
  BLOCKED: 'blocked_channel_state_proof_inbox',
});

export const CHANNEL_STATE_PROOF_NEXT_STEP = Object.freeze({
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

function expectedReceiptHash(receipt) {
  return receipt?.kind === 'AdapterRunReceipt' ? computeAdapterRunReceiptHash(receipt) : null;
}

function expectedProofHash(proof) {
  return proof?.kind === 'ChannelStateProof' ? computeChannelStateProofHash(proof) : null;
}

function receiptHashFromInbox(inboxItem) {
  return normalizeText(inboxItem?.hashBinding?.receiptHash || '') || null;
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

function receiptPromptGenerationBinding(receipt = null) {
  return receipt?.hashBinding?.promptGenerationBinding
    || receipt?.payload?.promptGenerationBinding
    || receipt?.result?.external?.promptGenerationBinding
    || null;
}

function proofPromptGenerationBinding(proof = null) {
  return proof?.hashBinding?.promptGenerationBinding
    || proof?.payload?.promptGenerationBinding
    || proof?.evidence?.promptGenerationBinding
    || null;
}

function isPromptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonical === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function requiresPromptGenerationBinding({ receiptInboxItem, proof, receipt }) {
  return [
    receiptInboxItem?.action,
    receiptInboxItem?.payload?.action,
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

function propagateProofBlockers(proof, blockers) {
  for (const blocker of proof?.blockers || []) {
    if (!blockers.some((item) => item.code === blocker.code)) blockers.push(blocker);
  }
}

function requiresCustomerMessageHashes({ receiptInboxItem, proof, receipt }) {
  return [
    receiptInboxItem?.action,
    proof?.action,
    receipt?.action,
  ].some((action) => canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function requiresHumanFeedbackContractHash({ receiptInboxItem, proof, receipt }) {
  const actionValues = [
    receiptInboxItem?.action,
    proof?.action,
    receipt?.action,
  ];
  const productValues = [
    receiptInboxItem?.payload?.productLineId,
    receiptInboxItem?.payload?.workflowId,
    receiptInboxItem?.payload?.packageRole,
    receiptInboxItem?.payload?.reviewType,
    receiptInboxItem?.payload?.role,
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
    receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
      || requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash')
      || (
        actionValues.some((action) => isHumanFeedbackCustomerFacingAction(action))
        && (
          actionValues.some((action) => isHumanFeedbackMessageActionAlias(action))
          || productValues.some((id) => (
            canonicalProductLineId(id) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
              || canonicalProductLineId(canonicalPackageRole(id)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
          ))
        )
      ),
  );
}

function inboxBlockers({ receiptInboxItem, proof, receipt }) {
  const blockers = [];

  if (receiptInboxItem?.kind !== 'AdapterReceiptInboxItem') blockers.push(issue('invalid_receipt_inbox_kind'));
  if (
    receiptInboxItem
    && (receiptInboxItem.status !== ADAPTER_RECEIPT_INBOX_STATUS.RECEIVED || receiptInboxItem.received !== true)
  ) {
    blockers.push(issue('receipt_inbox_not_received'));
  }
  if (receiptInboxItem && receiptInboxItem.nextStep !== ADAPTER_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED) {
    blockers.push(issue('receipt_inbox_not_waiting_for_proof'));
  }
  if (receiptInboxItem?.kind === 'AdapterReceiptInboxItem') {
    const recordedHash = hashOf(receiptInboxItem, 'inboxHash');
    const recomputedHash = computeAdapterReceiptInboxHash(receiptInboxItem);
    if (!recordedHash) blockers.push(issue('receipt_inbox_hash_required'));
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('receipt_inbox_hash_content_mismatch'));
    }
    if (!receiptInboxItem.hashBinding?.receiptHash) {
      blockers.push(issue('receipt_inbox_receipt_hash_missing'));
    }
    if (!receiptInboxItem.hashBinding?.platformStateSnapshotHash) {
      blockers.push(issue('receipt_inbox_platform_state_snapshot_hash_missing'));
    }
    if (!receiptInboxItem.hashBinding?.dryRunReplayHash) {
      blockers.push(issue('receipt_inbox_dry_run_replay_hash_missing'));
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

  if (requiresCustomerMessageHashes({ receiptInboxItem, proof, receipt })) {
    if (!receiptInboxItem?.hashBinding?.messagePreviewHash) {
      blockers.push(issue('receipt_inbox_message_preview_hash_missing'));
    }
  }
  if (requiresHumanFeedbackContractHash({ receiptInboxItem, proof, receipt })) {
    if (!receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('receipt_inbox_human_feedback_contract_hash_missing'));
    }
  }

  compareHash(receiptHashFromInbox(receiptInboxItem), proof?.receiptHash, 'receipt_hash_mismatch', blockers);
  compareHash(receiptInboxItem?.hashBinding?.approvalProvenanceHash, proof?.hashBinding?.approvalProvenanceHash, 'approval_provenance_hash_mismatch', blockers);
  compareHash(receiptInboxItem?.hashBinding?.platformStateSnapshotHash, proof?.hashBinding?.platformStateSnapshotHash, 'platform_state_snapshot_hash_mismatch', blockers);
  compareHash(receiptInboxItem?.hashBinding?.dryRunReplayHash, proof?.hashBinding?.dryRunReplayHash, 'dry_run_replay_hash_mismatch', blockers);
  compareRequiredHash(
    receiptInboxItem?.hashBinding?.messagePreviewHash,
    requiredProofHash(proof, 'messagePreviewHash'),
    'proof_message_preview_hash_missing',
    'proof_message_preview_hash_mismatch',
    blockers,
  );
  compareRequiredHash(
    receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
    requiredProofHash(proof, 'humanFeedbackRevisionContractHash'),
    'proof_human_feedback_contract_hash_missing',
    'proof_human_feedback_contract_hash_mismatch',
    blockers,
  );
  const expectedPromptGenerationBinding = receiptInboxItem?.hashBinding?.promptGenerationBinding || null;
  const promptGenerationBindingRequired = requiresPromptGenerationBinding({ receiptInboxItem, proof, receipt });
  if (promptGenerationBindingRequired && !expectedPromptGenerationBinding) {
    blockers.push(issue('receipt_inbox_prompt_generation_binding_missing'));
  }
  if (expectedPromptGenerationBinding || promptGenerationBindingRequired) {
    if (expectedPromptGenerationBinding) {
      const missingExpectedKeys = missingPromptGenerationBindingKeys(expectedPromptGenerationBinding);
      if (missingExpectedKeys.length) {
        blockers.push(issue('receipt_inbox_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
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
  if (requiresCustomerMessageHashes({ receiptInboxItem, proof, receipt })) {
    const expectedMessagePreviewHash = receiptInboxItem?.hashBinding?.messagePreviewHash
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
  if (requiresHumanFeedbackContractHash({ receiptInboxItem, proof, receipt })) {
    const expectedHumanFeedbackContractHash = receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
      || requiredReceiptHash(receipt, 'humanFeedbackRevisionContractHash');
    proofHumanFeedbackContractHashSourceBlockers(proof, expectedHumanFeedbackContractHash, blockers);
  }
  compareField(receiptInboxItem?.channelId, proof?.channelId, 'channel_id_mismatch', blockers);
  compareField(receiptInboxItem?.actionId, proof?.actionId, 'action_id_mismatch', blockers);
  compareActionField(receiptInboxItem?.action, proof?.action, 'action_mismatch', blockers);
  compareField(receiptInboxItem?.payload?.taskKey, proof?.payload?.taskKey, 'task_key_mismatch', blockers);
  compareField(receiptInboxItem?.payload?.externalId, proof?.payload?.externalId, 'external_id_mismatch', blockers);

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
    compareHash(receiptHashFromInbox(receiptInboxItem), receipt?.receiptHash, 'receipt_hash_mismatch', blockers);
    compareHash(proof?.receiptHash, receipt?.receiptHash, 'receipt_hash_mismatch', blockers);
    compareHash(proof?.hashBinding?.approvalProvenanceHash, receipt.hashBinding?.approvalProvenanceHash, 'approval_provenance_hash_mismatch', blockers);
    compareHash(proof?.hashBinding?.platformStateSnapshotHash, receipt.hashBinding?.platformStateSnapshotHash, 'platform_state_snapshot_hash_mismatch', blockers);
    compareHash(proof?.hashBinding?.dryRunReplayHash, receipt.hashBinding?.dryRunReplayHash, 'dry_run_replay_hash_mismatch', blockers);
    compareRequiredHash(
      receiptInboxItem?.hashBinding?.messagePreviewHash,
      requiredReceiptHash(receipt, 'messagePreviewHash'),
      'receipt_message_preview_hash_missing',
      'receipt_message_preview_hash_mismatch',
      blockers,
    );
    compareRequiredHash(
      receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
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
    compareField(receiptInboxItem?.channelId, receipt.channelId, 'channel_id_mismatch', blockers);
    compareField(receiptInboxItem?.actionId, receipt.actionId, 'action_id_mismatch', blockers);
    compareActionField(receiptInboxItem?.action, receipt.action, 'action_mismatch', blockers);
    compareField(receiptInboxItem?.payload?.taskKey, receipt.payload?.taskKey, 'task_key_mismatch', blockers);
    compareField(receiptInboxItem?.payload?.externalId, receipt.payload?.externalId, 'external_id_mismatch', blockers);
  }

  return blockers;
}

export function buildChannelStateProofInboxItem({
  receiptInboxItem = null,
  proof = null,
  receipt = null,
  receivedBy = 'design-production-core.channel-state-proof-inbox',
  evidenceRefs = [],
  receivedAt = null,
  createdAt = null,
} = {}) {
  const blockers = inboxBlockers({ receiptInboxItem, proof, receipt });
  const nextStep = blockers.length
    ? CHANNEL_STATE_PROOF_NEXT_STEP.BLOCKED
    : CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY;
  const action = canonicalActionOrNull(receiptInboxItem?.action || proof?.action || receipt?.action);
  const productLineId = canonicalProductLineOrNull(
    receiptInboxItem?.payload?.productLineId || proof?.payload?.productLineId || receipt?.payload?.productLineId,
  );
  const workflowId = canonicalProductLineOrNull(
    receiptInboxItem?.payload?.workflowId || proof?.payload?.workflowId || receipt?.payload?.workflowId,
  );
  const packageRole = canonicalPackageRole(
    receiptInboxItem?.payload?.packageRole || proof?.payload?.packageRole || receipt?.payload?.packageRole || '',
  ) || null;
  const item = {
    version: CHANNEL_STATE_PROOF_INBOX_VERSION,
    kind: 'ChannelStateProofInboxItem',
    receivedBy: normalizeText(receivedBy || 'design-production-core.channel-state-proof-inbox'),
    status: blockers.length
      ? CHANNEL_STATE_PROOF_INBOX_STATUS.BLOCKED
      : CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED,
    received: blockers.length === 0,
    nextStep,
    channelId: receiptInboxItem?.channelId || proof?.channelId || receipt?.channelId || null,
    actionId: receiptInboxItem?.actionId || proof?.actionId || receipt?.actionId || null,
    action,
    payload: {
      taskKey: receiptInboxItem?.payload?.taskKey || proof?.payload?.taskKey || receipt?.payload?.taskKey || null,
      externalId: receiptInboxItem?.payload?.externalId || proof?.payload?.externalId || receipt?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole,
      resultStatus: receiptInboxItem?.payload?.resultStatus || proof?.resultStatus || receipt?.result?.status || null,
    },
    hashBinding: {
      receiptInboxHash: hashOf(receiptInboxItem, 'inboxHash'),
      receiptHash: receiptHashFromInbox(receiptInboxItem) || null,
      proofHash: proof?.proofHash || null,
      approvalProvenanceHash: requiredProofHash(proof, 'approvalProvenanceHash')
        || receiptInboxItem?.hashBinding?.approvalProvenanceHash
        || receipt?.hashBinding?.approvalProvenanceHash
        || null,
      platformStateSnapshotHash: proof?.hashBinding?.platformStateSnapshotHash || receiptInboxItem?.hashBinding?.platformStateSnapshotHash || receipt?.hashBinding?.platformStateSnapshotHash || null,
      dryRunReplayHash: proof?.hashBinding?.dryRunReplayHash || receiptInboxItem?.hashBinding?.dryRunReplayHash || receipt?.hashBinding?.dryRunReplayHash || null,
      humanFeedbackRevisionContractHash: requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
        || receiptInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
        || receipt?.payload?.humanFeedbackRevisionContractHash
        || receipt?.result?.external?.humanFeedbackRevisionContractHash
        || null,
      messagePreviewHash: requiredProofHash(proof, 'messagePreviewHash')
        || receiptInboxItem?.hashBinding?.messagePreviewHash
        || receipt?.payload?.messagePreviewHash
        || receipt?.result?.external?.messagePreviewHash
        || null,
      promptGenerationBinding: proofPromptGenerationBinding(proof)
        || receiptInboxItem?.hashBinding?.promptGenerationBinding
        || receiptPromptGenerationBinding(receipt),
    },
    blockers,
    warnings: [
      issue('proof_inbox_verifies_only', 'Core proof inbox items never fetch channel state or apply lifecycle transitions.', 'warning'),
      ...(nextStep === CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY
        ? [issue('receipt_state_transition_required', 'A verified proof still needs the local receipt state transition step.', 'warning')]
        : []),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      proofInboxOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      requiresReceiptInbox: true,
      requiresVerifiedProof: true,
      localStateTransitionStillRequired: nextStep === CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY,
    },
    receivedAt: receivedAt || createdAt || new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  };
  const proofInboxHash = computeChannelStateProofInboxHash(item);
  return {
    ...item,
    proofInboxHash,
    hash: proofInboxHash,
  };
}

export function computeChannelStateProofInboxHash(item = null) {
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

export function summarizeChannelStateProofInbox(items = []) {
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
    version: CHANNEL_STATE_PROOF_INBOX_VERSION,
    count: items.length,
    byStatus,
    byNextStep,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      proofInboxOnly: true,
      executesExternalAction: items.some((item) => item.safety?.executesExternalAction === true),
      fetchesChannelState: items.some((item) => item.safety?.fetchesChannelState === true),
    },
  };
}
