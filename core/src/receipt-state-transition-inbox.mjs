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
  CHANNEL_STATE_PROOF_INBOX_STATUS,
  CHANNEL_STATE_PROOF_NEXT_STEP,
  computeChannelStateProofInboxHash,
} from './channel-state-proof-inbox.mjs';
import {
  CHANNEL_STATE_PROOF_STATUS,
  RECEIPT_TRANSITION_STATUS,
  computeChannelStateProofHash,
  computeReceiptStateTransitionHash,
} from './channel-state-proof.mjs';
import { digest } from './hash-utils.mjs';

export const RECEIPT_STATE_TRANSITION_INBOX_VERSION = 1;

export const RECEIPT_STATE_TRANSITION_INBOX_STATUS = Object.freeze({
  RECEIVED: 'received_receipt_state_transition',
  BLOCKED: 'blocked_receipt_state_transition_inbox',
});

export const RECEIPT_STATE_TRANSITION_NEXT_STEP = Object.freeze({
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

function transitionProofHash(transition) {
  return normalizeText(transition?.proofHash || '') || null;
}

function transitionRecordedHash(transition) {
  return normalizeText(transition?.transitionHash || '') || null;
}

function requiredProofHash(proof, key) {
  return normalizeText(
    proof?.hashBinding?.[key]
      || proof?.payload?.[key]
      || proof?.evidence?.[key]
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

function transitionPromptGenerationBinding(transition = null) {
  return transition?.hashBinding?.promptGenerationBinding || null;
}

function isPromptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonical === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function requiresPromptGenerationBinding({ proofInboxItem, proof, transition }) {
  return [
    proofInboxItem?.action,
    proofInboxItem?.payload?.action,
    proof?.action,
    proof?.payload?.action,
    transition?.result?.decision?.action,
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

function requiresCustomerMessageHashes({ proofInboxItem, proof, transition }) {
  return [
    proofInboxItem?.action,
    proof?.action,
    transition?.result?.decision?.action,
  ].some((action) => canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function requiresHumanFeedbackContractHash({ proofInboxItem, proof, transition }) {
  const actionValues = [
    proofInboxItem?.action,
    proof?.action,
    transition?.result?.decision?.action,
  ];
  const productValues = [
    proofInboxItem?.payload?.productLineId,
    proofInboxItem?.payload?.workflowId,
    proofInboxItem?.payload?.packageRole,
    proofInboxItem?.payload?.reviewType,
    proofInboxItem?.payload?.role,
    proof?.payload?.productLineId,
    proof?.payload?.workflowId,
    proof?.payload?.packageRole,
    proof?.payload?.reviewType,
    proof?.payload?.role,
    transition?.result?.decision?.packageRole,
    transition?.result?.decision?.reviewType,
    transition?.result?.decision?.role,
  ];
  return Boolean(
    proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
      || (
        actionValues.some((action) => isHumanFeedbackCustomerFacingAction(action))
        && (
          actionValues.some((action) => isHumanFeedbackMessageActionAlias(action))
          || productValues.some((id) => isHumanFeedbackIdentity(id))
        )
      ),
  );
}

function proofInboxBlockers(proofInboxItem, blockers) {
  if (proofInboxItem?.kind !== 'ChannelStateProofInboxItem') blockers.push(issue('invalid_proof_inbox_kind'));
  if (
    proofInboxItem
    && (proofInboxItem.status !== CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED || proofInboxItem.received !== true)
  ) {
    blockers.push(issue('proof_inbox_not_received'));
  }
  if (proofInboxItem && proofInboxItem.nextStep !== CHANNEL_STATE_PROOF_NEXT_STEP.RECEIPT_STATE_TRANSITION_READY) {
    blockers.push(issue('proof_inbox_not_ready_for_transition'));
  }
  if (proofInboxItem?.kind === 'ChannelStateProofInboxItem') {
    const recordedHash = hashOf(proofInboxItem, 'proofInboxHash');
    const recomputedHash = computeChannelStateProofInboxHash(proofInboxItem);
    if (!recordedHash) blockers.push(issue('proof_inbox_hash_required'));
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('proof_inbox_hash_content_mismatch'));
    }
    if (!proofInboxItem.hashBinding?.receiptInboxHash) {
      blockers.push(issue('proof_inbox_receipt_inbox_hash_missing'));
    }
    if (!proofInboxItem.hashBinding?.receiptHash) {
      blockers.push(issue('proof_inbox_receipt_hash_missing'));
    }
    if (!proofInboxItem.hashBinding?.proofHash) {
      blockers.push(issue('proof_inbox_proof_hash_missing'));
    }
    if (!proofInboxItem.hashBinding?.platformStateSnapshotHash) {
      blockers.push(issue('proof_inbox_platform_state_snapshot_hash_missing'));
    }
    if (!proofInboxItem.hashBinding?.dryRunReplayHash) {
      blockers.push(issue('proof_inbox_dry_run_replay_hash_missing'));
    }
  }
}

function transitionBlockers(transition, blockers) {
  if (transition?.kind !== 'ReceiptStateTransition') blockers.push(issue('invalid_receipt_state_transition'));
  if (transition && (transition.status !== RECEIPT_TRANSITION_STATUS.READY || transition.ready !== true)) {
    blockers.push(issue('receipt_state_transition_not_ready'));
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
    blockers.push(issue('receipt_state_transition_result_not_allowed'));
  }
  if (transition?.safety?.executesExternalAction === true || transition?.result?.safety?.executesExternalAction === true) {
    blockers.push(issue('transition_executes_external_action'));
  }
}

function optionalProofBlockers(proof, blockers) {
  if (!proof) return;
  if (proof.kind !== 'ChannelStateProof') blockers.push(issue('invalid_channel_state_proof'));
  if (proof.status !== CHANNEL_STATE_PROOF_STATUS.VERIFIED || proof.verified !== true) {
    blockers.push(issue('channel_state_proof_not_verified'));
  }
  if (proof.kind === 'ChannelStateProof') {
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

function inboxBlockers({ proofInboxItem, transition, proof }) {
  const blockers = [];
  proofInboxBlockers(proofInboxItem, blockers);
  transitionBlockers(transition, blockers);
  optionalProofBlockers(proof, blockers);

  if (requiresCustomerMessageHashes({ proofInboxItem, proof, transition })) {
    if (!proofInboxItem?.hashBinding?.messagePreviewHash) {
      blockers.push(issue('proof_inbox_message_preview_hash_missing'));
    }
    if (!requiredTransitionHash(transition, 'messagePreviewHash')) {
      blockers.push(issue('transition_message_preview_hash_missing'));
    }
  }
  if (requiresHumanFeedbackContractHash({ proofInboxItem, proof, transition })) {
    if (!proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('proof_inbox_human_feedback_contract_hash_missing'));
    }
    if (!requiredTransitionHash(transition, 'humanFeedbackRevisionContractHash')) {
      blockers.push(issue('transition_human_feedback_contract_hash_missing'));
    }
  }

  compareHash(proofInboxItem?.hashBinding?.proofHash, transitionProofHash(transition), 'proof_hash_mismatch', blockers);
  compareHash(proof?.proofHash, transitionProofHash(transition), 'proof_hash_mismatch', blockers);
  compareHash(proofInboxItem?.hashBinding?.proofHash, transition?.hashBinding?.proofHash, 'transition_proof_hash_mismatch', blockers);
  compareHash(proofInboxItem?.hashBinding?.receiptHash, transition?.hashBinding?.receiptHash, 'transition_receipt_hash_mismatch', blockers);
  compareRequiredHash(
    proofInboxItem?.hashBinding?.approvalProvenanceHash,
    requiredProofHash(proof, 'approvalProvenanceHash'),
    'proof_approval_provenance_hash_missing',
    'proof_approval_provenance_hash_mismatch',
    blockers,
  );
  compareRequiredHash(
    proofInboxItem?.hashBinding?.approvalProvenanceHash,
    requiredTransitionHash(transition, 'approvalProvenanceHash'),
    'transition_approval_provenance_hash_missing',
    'transition_approval_provenance_hash_mismatch',
    blockers,
  );
  compareRequiredHash(
    proofInboxItem?.hashBinding?.messagePreviewHash,
    requiredProofHash(proof, 'messagePreviewHash'),
    'proof_message_preview_hash_missing',
    'proof_message_preview_hash_mismatch',
    blockers,
  );
  compareRequiredHash(
    proofInboxItem?.hashBinding?.messagePreviewHash,
    requiredTransitionHash(transition, 'messagePreviewHash'),
    'transition_message_preview_hash_missing',
    'transition_message_preview_hash_mismatch',
    blockers,
  );
  if (requiresCustomerMessageHashes({ proofInboxItem, proof, transition })) {
    const expectedMessagePreviewHash = proofInboxItem?.hashBinding?.messagePreviewHash
      || requiredProofHash(proof, 'messagePreviewHash')
      || requiredTransitionHash(transition, 'messagePreviewHash');
    if (proof) proofMessagePreviewHashSourceBlockers(proof, expectedMessagePreviewHash, blockers);
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
  }
  compareRequiredHash(
    proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
    requiredProofHash(proof, 'humanFeedbackRevisionContractHash'),
    'proof_human_feedback_contract_hash_missing',
    'proof_human_feedback_contract_hash_mismatch',
    blockers,
  );
  compareRequiredHash(
    proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash,
    requiredTransitionHash(transition, 'humanFeedbackRevisionContractHash'),
    'transition_human_feedback_contract_hash_missing',
    'transition_human_feedback_contract_hash_mismatch',
    blockers,
  );
  if (proof && requiresHumanFeedbackContractHash({ proofInboxItem, proof, transition })) {
    const expectedHumanFeedbackContractHash = proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
      || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
      || requiredTransitionHash(transition, 'humanFeedbackRevisionContractHash');
    proofHumanFeedbackContractHashSourceBlockers(proof, expectedHumanFeedbackContractHash, blockers);
  }
  const expectedPromptGenerationBinding = proofInboxItem?.hashBinding?.promptGenerationBinding || null;
  const promptGenerationBindingRequired = requiresPromptGenerationBinding({ proofInboxItem, proof, transition });
  if (promptGenerationBindingRequired && !expectedPromptGenerationBinding) {
    blockers.push(issue('proof_inbox_prompt_generation_binding_missing'));
  }
  if (expectedPromptGenerationBinding || promptGenerationBindingRequired) {
    if (expectedPromptGenerationBinding) {
      const missingExpectedKeys = missingPromptGenerationBindingKeys(expectedPromptGenerationBinding);
      if (missingExpectedKeys.length) {
        blockers.push(issue('proof_inbox_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
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
    if (proof && !actualProofPromptGenerationBinding) {
      blockers.push(issue('proof_prompt_generation_binding_missing'));
    } else if (actualProofPromptGenerationBinding) {
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
  }
  compareHash(
    proofInboxItem?.hashBinding?.platformStateSnapshotHash,
    transition?.hashBinding?.platformStateSnapshotHash,
    'transition_platform_state_snapshot_hash_mismatch',
    blockers,
  );
  compareHash(
    proofInboxItem?.hashBinding?.dryRunReplayHash,
    transition?.hashBinding?.dryRunReplayHash,
    'transition_dry_run_replay_hash_mismatch',
    blockers,
  );
  compareField(proofInboxItem?.payload?.taskKey, transition?.result?.taskKey, 'task_key_mismatch', blockers);
  compareActionField(proofInboxItem?.action, transition?.result?.decision?.action, 'action_mismatch', blockers);
  compareField(proof?.payload?.taskKey, transition?.result?.taskKey, 'task_key_mismatch', blockers);
  compareActionField(proof?.action, transition?.result?.decision?.action, 'action_mismatch', blockers);
  compareField(proof?.stateSuggestion?.fromStage, transition?.result?.previousStage, 'from_stage_mismatch', blockers);
  compareField(proof?.stateSuggestion?.toStage, transition?.result?.requestedStage, 'to_stage_mismatch', blockers);

  return blockers;
}

export function buildReceiptStateTransitionInboxItem({
  proofInboxItem = null,
  transition = null,
  proof = null,
  receivedBy = 'design-production-core.receipt-state-transition-inbox',
  evidenceRefs = [],
  receivedAt = null,
  createdAt = null,
} = {}) {
  const blockers = inboxBlockers({ proofInboxItem, transition, proof });
  const nextStep = blockers.length
    ? RECEIPT_STATE_TRANSITION_NEXT_STEP.BLOCKED
    : RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY;
  const action = canonicalActionOrNull(proofInboxItem?.action || proof?.action || transition?.result?.decision?.action);
  const productLineId = canonicalProductLineOrNull(proofInboxItem?.payload?.productLineId || proof?.payload?.productLineId);
  const workflowId = canonicalProductLineOrNull(proofInboxItem?.payload?.workflowId || proof?.payload?.workflowId);
  const packageRole = canonicalPackageRole(proofInboxItem?.payload?.packageRole || proof?.payload?.packageRole || '') || null;
  const item = {
    version: RECEIPT_STATE_TRANSITION_INBOX_VERSION,
    kind: 'ReceiptStateTransitionInboxItem',
    receivedBy: normalizeText(receivedBy || 'design-production-core.receipt-state-transition-inbox'),
    status: blockers.length
      ? RECEIPT_STATE_TRANSITION_INBOX_STATUS.BLOCKED
      : RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED,
    received: blockers.length === 0,
    nextStep,
    channelId: proofInboxItem?.channelId || proof?.channelId || null,
    actionId: proofInboxItem?.actionId || proof?.actionId || null,
    action,
    payload: {
      taskKey: proofInboxItem?.payload?.taskKey || proof?.payload?.taskKey || transition?.result?.taskKey || null,
      externalId: proofInboxItem?.payload?.externalId || proof?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole,
      resultStatus: proofInboxItem?.payload?.resultStatus || proof?.resultStatus || null,
      fromStage: transition?.result?.previousStage || proof?.stateSuggestion?.fromStage || null,
      toStage: transition?.result?.stage || proof?.stateSuggestion?.toStage || null,
    },
    hashBinding: {
      proofInboxHash: hashOf(proofInboxItem, 'proofInboxHash'),
      receiptInboxHash: proofInboxItem?.hashBinding?.receiptInboxHash || null,
      receiptHash: proofInboxItem?.hashBinding?.receiptHash || proof?.receiptHash || null,
      proofHash: proofInboxItem?.hashBinding?.proofHash || null,
      approvalProvenanceHash: proofInboxItem?.hashBinding?.approvalProvenanceHash
        || requiredProofHash(proof, 'approvalProvenanceHash')
        || null,
      platformStateSnapshotHash: proofInboxItem?.hashBinding?.platformStateSnapshotHash
        || proof?.hashBinding?.platformStateSnapshotHash
        || null,
      dryRunReplayHash: proofInboxItem?.hashBinding?.dryRunReplayHash
        || proof?.hashBinding?.dryRunReplayHash
        || null,
      humanFeedbackRevisionContractHash: proofInboxItem?.hashBinding?.humanFeedbackRevisionContractHash
        || requiredProofHash(proof, 'humanFeedbackRevisionContractHash')
        || null,
      messagePreviewHash: proofInboxItem?.hashBinding?.messagePreviewHash
        || requiredProofHash(proof, 'messagePreviewHash')
        || null,
      promptGenerationBinding: transitionPromptGenerationBinding(transition)
        || proofInboxItem?.hashBinding?.promptGenerationBinding
        || proofPromptGenerationBinding(proof),
      transitionHash: transitionRecordedHash(transition),
    },
    blockers,
    warnings: [
      issue('transition_inbox_verifies_only', 'Core transition inbox items never apply lifecycle state or run adapters.', 'warning'),
      ...(nextStep === RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY
        ? [issue('external_action_ledger_required', 'A ready transition still needs the external action ledger chain check.', 'warning')]
        : []),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      transitionInboxOnly: true,
      executesExternalAction: false,
      appliesLocalStateTransition: false,
      requiresProofInbox: true,
      requiresReadyTransition: true,
      ledgerVerificationStillRequired: nextStep === RECEIPT_STATE_TRANSITION_NEXT_STEP.EXTERNAL_ACTION_LEDGER_READY,
    },
    receivedAt: receivedAt || createdAt || new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  };
  const transitionInboxHash = computeReceiptStateTransitionInboxHash(item);
  return {
    ...item,
    transitionInboxHash,
    hash: transitionInboxHash,
  };
}

export function computeReceiptStateTransitionInboxHash(item = null) {
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

export function summarizeReceiptStateTransitionInbox(items = []) {
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
    version: RECEIPT_STATE_TRANSITION_INBOX_VERSION,
    count: items.length,
    byStatus,
    byNextStep,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      transitionInboxOnly: true,
      executesExternalAction: items.some((item) => item.safety?.executesExternalAction === true),
      appliesLocalStateTransition: items.some((item) => item.safety?.appliesLocalStateTransition === true),
    },
  };
}
