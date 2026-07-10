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
import { ADAPTER_DISPATCH_ENVELOPE_STATUS, computeAdapterDispatchEnvelopeHash } from './adapter-dispatch-envelope.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, computeAdapterRunReceiptHash } from './adapter-receipt.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_DISPATCH_RECEIPT_INBOX_VERSION = 1;

export const ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS = Object.freeze({
  RECEIVED: 'received_dispatch_receipt',
  TERMINAL: 'terminal_dispatch_result_recorded',
  BLOCKED: 'blocked_dispatch_receipt_inbox',
});

export const ADAPTER_DISPATCH_RECEIPT_NEXT_STEP = Object.freeze({
  CHANNEL_STATE_PROOF_REQUIRED: 'channel_state_proof_required',
  TERMINAL_RESULT_RECORDED: 'terminal_result_recorded',
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

function text(value) {
  return normalizeText(value || '') || null;
}

function hashOf(value, key) {
  return text(key === 'hash' ? value?.hash : value?.[key]);
}

function receiptHash(receipt, key) {
  return text(receipt?.hashBinding?.[key]);
}

function receiptRequiredHash(receipt, key) {
  return text(
    receipt?.hashBinding?.[key]
      || receipt?.payload?.[key]
      || receipt?.result?.external?.[key],
  );
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => text(left[key]) === text(right[key]));
}

function missingPromptGenerationBindingKeys(binding = null) {
  return PROMPT_GENERATION_BINDING_KEYS.filter((key) => !text(binding?.[key]));
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

function dispatchPromptGenerationBinding(dispatchEnvelope = null) {
  return dispatchEnvelope?.payload?.promptGenerationBinding
    || dispatchEnvelope?.runner?.requiredHashes?.promptGenerationBinding
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

function requiresPromptGenerationBinding({ dispatchEnvelope, receipt }) {
  return [
    dispatchEnvelope?.action,
    dispatchEnvelope?.payload?.action,
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

function requiredHash(dispatchEnvelope, key) {
  return text(dispatchEnvelope?.runner?.requiredHashes?.[key]);
}

function dispatchBoundHashValues(dispatchEnvelope = {}, key) {
  const snapshots = dispatchEnvelope?.runner?.handoffSnapshots || {};
  return [
    ['payload', dispatchEnvelope?.payload?.[key]],
    ['runner_required_hashes', dispatchEnvelope?.runner?.requiredHashes?.[key]],
    ['manifest_payload', snapshots.manifest?.payload?.[key]],
    ['preview_payload', snapshots.preview?.payload?.[key]],
    ['preview_required_hashes', snapshots.preview?.adapter?.requiredHashes?.[key]],
  ];
}

function requiredDispatchBoundHashBlockers(dispatchEnvelope, key, {
  required,
  requiredCode,
  mismatchCode,
}) {
  const values = dispatchBoundHashValues(dispatchEnvelope, key);
  const present = values.map(([, value]) => text(value)).filter(Boolean);
  if (!required && !present.length) return [];
  const blockers = [];
  const missingSources = values.filter(([, value]) => !text(value)).map(([source]) => source);
  if (missingSources.length) blockers.push(issue(requiredCode, missingSources.join(', ')));
  if (present.length && present.some((value) => value !== present[0])) blockers.push(issue(mismatchCode));
  return blockers;
}

function requireDispatchEnvelopeHash(dispatchEnvelope, key, code, blockers) {
  if (!requiredHash(dispatchEnvelope, key)) blockers.push(issue(code));
}

function expectedDispatchEnvelopeHash(dispatchEnvelope) {
  if (!dispatchEnvelope) return null;
  return computeAdapterDispatchEnvelopeHash(dispatchEnvelope);
}

function expectedReceiptHash(receipt) {
  if (!receipt) return null;
  return computeAdapterRunReceiptHash(receipt);
}

function compareField(left, right, code, blockers) {
  const normalizedLeft = text(left);
  const normalizedRight = text(right);
  if (!normalizedLeft) return;
  if (!normalizedRight || normalizedLeft !== normalizedRight) blockers.push(issue(code));
}

function compareActionField(left, right, code, blockers) {
  const normalizedLeft = text(left);
  const normalizedRight = text(right);
  if (!normalizedLeft) return;
  if (!normalizedRight) {
    blockers.push(issue(code));
    return;
  }
  if (canonicalExternalAction(normalizedLeft) !== canonicalExternalAction(normalizedRight)) blockers.push(issue(code));
}

function compareHash(expected, actual, missingCode, mismatchCode, blockers) {
  if (!expected) return;
  if (!actual) blockers.push(issue(missingCode));
  if (expected && actual && expected !== actual) blockers.push(issue(mismatchCode));
}

function compareRequiredHash(dispatchEnvelope, receipt, key, prefix, blockers) {
  compareHash(
    requiredHash(dispatchEnvelope, key),
    receiptHash(receipt, key),
    `receipt_${prefix}_hash_missing`,
    `receipt_${prefix}_hash_mismatch`,
    blockers,
  );
}

function compareRequiredReceiptHash(dispatchEnvelope, receipt, key, prefix, blockers) {
  compareHash(
    requiredHash(dispatchEnvelope, key),
    receiptRequiredHash(receipt, key),
    `receipt_${prefix}_hash_missing`,
    `receipt_${prefix}_hash_mismatch`,
    blockers,
  );
}

function requireReceiptHash(receipt, key, code, blockers) {
  if (!receiptHash(receipt, key)) blockers.push(issue(code));
}

function pushIssueOnce(blockers, code) {
  if (!blockers.some((item) => item.code === code)) blockers.push(issue(code));
}

function addMessagePreviewContentBlocker(value, expected, code, blockers) {
  const normalizedExpected = text(expected);
  const rawContentHash = computeCustomerMessagePreviewHashFromFields(value);
  const storedContentHash = text(value?.messagePreviewContentHash);
  const contentHash = rawContentHash || storedContentHash;
  if (rawContentHash && storedContentHash && rawContentHash !== storedContentHash) {
    pushIssueOnce(blockers, code);
  }
  if (contentHash && normalizedExpected && contentHash !== normalizedExpected) {
    pushIssueOnce(blockers, code);
  }
}

function requiresCustomerMessageHashes({ dispatchEnvelope, receipt }) {
  return [
    dispatchEnvelope?.action,
    dispatchEnvelope?.payload?.action,
    receipt?.action,
    receipt?.payload?.action,
  ].some((action) => canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function requiresHumanFeedbackContractHash({ dispatchEnvelope, receipt }) {
  const actionValues = [
    dispatchEnvelope?.action,
    dispatchEnvelope?.payload?.action,
    receipt?.action,
    receipt?.payload?.action,
  ];
  const productValues = [
    dispatchEnvelope?.payload?.productLineId,
    dispatchEnvelope?.payload?.workflowId,
    dispatchEnvelope?.payload?.packageRole,
    dispatchEnvelope?.payload?.reviewType,
    dispatchEnvelope?.payload?.role,
    receipt?.payload?.productLineId,
    receipt?.payload?.workflowId,
    receipt?.payload?.packageRole,
    receipt?.payload?.reviewType,
    receipt?.payload?.role,
  ];
  return Boolean(
    requiredHash(dispatchEnvelope, 'humanFeedbackRevisionContractHash')
      || receiptRequiredHash(receipt, 'humanFeedbackRevisionContractHash')
      || (
        actionValues.some((action) => isHumanFeedbackCustomerFacingAction(action))
        && (
          actionValues.some((action) => isHumanFeedbackMessageActionAlias(action))
          || productValues.some((value) => isHumanFeedbackIdentity(value))
        )
      ),
  );
}

function dispatchEnvelopeMessagePreviewHashBlockers({ dispatchEnvelope, receipt }) {
  return requiredDispatchBoundHashBlockers(dispatchEnvelope, 'messagePreviewHash', {
    required: requiresCustomerMessageHashes({ dispatchEnvelope, receipt }),
    requiredCode: 'dispatch_envelope_message_preview_hash_required',
    mismatchCode: 'dispatch_envelope_message_preview_hash_mismatch',
  });
}

function dispatchEnvelopeHumanFeedbackContractHashBlockers({ dispatchEnvelope, receipt }) {
  return requiredDispatchBoundHashBlockers(dispatchEnvelope, 'humanFeedbackRevisionContractHash', {
    required: requiresHumanFeedbackContractHash({ dispatchEnvelope, receipt }),
    requiredCode: 'dispatch_envelope_human_feedback_contract_hash_required',
    mismatchCode: 'dispatch_envelope_human_feedback_contract_hash_mismatch',
  });
}

function inboxBlockers({ dispatchEnvelope, receipt }) {
  const blockers = [];

  if (!dispatchEnvelope || dispatchEnvelope.kind !== 'AdapterDispatchEnvelope') {
    blockers.push(issue('invalid_dispatch_envelope'));
  } else {
    const dispatchHash = hashOf(dispatchEnvelope, 'dispatchEnvelopeHash');
    const expectedHash = expectedDispatchEnvelopeHash(dispatchEnvelope);
    if (!dispatchHash) blockers.push(issue('dispatch_envelope_hash_required'));
    if (dispatchHash && expectedHash && dispatchHash !== expectedHash) {
      blockers.push(issue('dispatch_envelope_hash_content_mismatch'));
    }
    if (
      dispatchEnvelope.status !== ADAPTER_DISPATCH_ENVELOPE_STATUS.READY
      || dispatchEnvelope.readyForExternalRunner !== true
    ) {
      blockers.push(issue('dispatch_envelope_not_ready'));
    }
    if (dispatchEnvelope.safety?.executesExternalAction === true) {
      blockers.push(issue('dispatch_envelope_claims_external_execution'));
    }
    if (dispatchEnvelope.safety?.readyForExecution === true) {
      blockers.push(issue('dispatch_envelope_claims_execution_ready'));
    }
    if (dispatchEnvelope.safety?.grantsExecutionPermission === true) {
      blockers.push(issue('dispatch_envelope_claims_permission'));
    }
    requireDispatchEnvelopeHash(dispatchEnvelope, 'outboxHash', 'dispatch_envelope_outbox_hash_missing', blockers);
    requireDispatchEnvelopeHash(dispatchEnvelope, 'replayGuardHash', 'dispatch_envelope_replay_guard_hash_missing', blockers);
    requireDispatchEnvelopeHash(dispatchEnvelope, 'manifestHash', 'dispatch_envelope_manifest_hash_missing', blockers);
    requireDispatchEnvelopeHash(dispatchEnvelope, 'previewHash', 'dispatch_envelope_preview_hash_missing', blockers);
    requireDispatchEnvelopeHash(dispatchEnvelope, 'approvalHash', 'dispatch_envelope_approval_hash_missing', blockers);
    requireDispatchEnvelopeHash(dispatchEnvelope, 'evidenceHash', 'dispatch_envelope_evidence_hash_missing', blockers);
    requireDispatchEnvelopeHash(dispatchEnvelope, 'approvalProvenanceHash', 'dispatch_envelope_approval_provenance_hash_missing', blockers);
  }

  if (!receipt || receipt.kind !== 'AdapterRunReceipt') {
    blockers.push(issue('invalid_adapter_receipt'));
  } else {
    const actualReceiptHash = hashOf(receipt, 'receiptHash');
    const expectedHash = expectedReceiptHash(receipt);
    if (!actualReceiptHash) blockers.push(issue('receipt_hash_required'));
    if (actualReceiptHash && expectedHash && actualReceiptHash !== expectedHash) {
      blockers.push(issue('receipt_hash_content_mismatch'));
    }
    if (receipt.status !== ADAPTER_RECEIPT_STATUS.ACCEPTED || receipt.accepted !== true) {
      blockers.push(issue('receipt_not_accepted'));
    }
  }

  if (dispatchEnvelope && receipt) {
    compareField(dispatchEnvelope.channelId, receipt.channelId, 'receipt_dispatch_channel_mismatch', blockers);
    compareField(dispatchEnvelope.actionId, receipt.actionId, 'receipt_dispatch_action_id_mismatch', blockers);
    compareActionField(dispatchEnvelope.action, receipt.action, 'receipt_dispatch_action_mismatch', blockers);
    compareField(dispatchEnvelope.payload?.taskKey, receipt.payload?.taskKey, 'receipt_dispatch_task_mismatch', blockers);
    compareField(dispatchEnvelope.payload?.externalId, receipt.payload?.externalId, 'receipt_dispatch_external_id_mismatch', blockers);

    compareHash(
      hashOf(dispatchEnvelope, 'dispatchEnvelopeHash'),
      receiptHash(receipt, 'dispatchEnvelopeHash'),
      'receipt_dispatch_envelope_hash_missing',
      'receipt_dispatch_envelope_hash_mismatch',
      blockers,
    );
    compareRequiredHash(dispatchEnvelope, receipt, 'outboxHash', 'outbox', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'replayGuardHash', 'replay_guard', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'archiveHash', 'archive', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'ledgerHash', 'ledger', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'manifestHash', 'manifest', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'previewHash', 'preview', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'approvalHash', 'approval', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'evidenceHash', 'evidence', blockers);
    compareRequiredHash(dispatchEnvelope, receipt, 'approvalProvenanceHash', 'approval_provenance', blockers);
    requireReceiptHash(receipt, 'platformStateSnapshotHash', 'receipt_platform_state_snapshot_hash_missing', blockers);
    requireReceiptHash(receipt, 'dryRunReplayHash', 'receipt_dry_run_replay_hash_missing', blockers);
    const expectedPromptGenerationBinding = dispatchPromptGenerationBinding(dispatchEnvelope);
    const promptGenerationBindingRequired = requiresPromptGenerationBinding({ dispatchEnvelope, receipt });
    if (promptGenerationBindingRequired && !expectedPromptGenerationBinding) {
      blockers.push(issue('dispatch_envelope_prompt_generation_binding_missing'));
    }
    if (expectedPromptGenerationBinding || promptGenerationBindingRequired) {
      if (expectedPromptGenerationBinding) {
        const missingExpectedKeys = missingPromptGenerationBindingKeys(expectedPromptGenerationBinding);
        if (missingExpectedKeys.length) {
          blockers.push(issue('dispatch_envelope_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
        }
        pushPromptGenerationBindingSourceBlockers(blockers, [
          {
            binding: dispatchEnvelope?.payload?.promptGenerationBinding,
            required: true,
            missingCode: 'dispatch_envelope_payload_prompt_generation_binding_missing',
            incompleteCode: 'dispatch_envelope_payload_prompt_generation_binding_incomplete',
            mismatchCode: 'dispatch_envelope_payload_prompt_generation_binding_mismatch',
          },
          {
            binding: dispatchEnvelope?.runner?.requiredHashes?.promptGenerationBinding,
            required: true,
            missingCode: 'dispatch_envelope_required_hashes_prompt_generation_binding_missing',
            incompleteCode: 'dispatch_envelope_required_hashes_prompt_generation_binding_incomplete',
            mismatchCode: 'dispatch_envelope_required_hashes_prompt_generation_binding_mismatch',
          },
          {
            binding: dispatchEnvelope?.runner?.handoffSnapshots?.manifest?.payload?.promptGenerationBinding,
            required: Boolean(dispatchEnvelope?.runner?.handoffSnapshots),
            missingCode: 'dispatch_envelope_manifest_snapshot_prompt_generation_binding_missing',
            incompleteCode: 'dispatch_envelope_manifest_snapshot_prompt_generation_binding_incomplete',
            mismatchCode: 'dispatch_envelope_manifest_snapshot_prompt_generation_binding_mismatch',
          },
          {
            binding: dispatchEnvelope?.runner?.handoffSnapshots?.preview?.payload?.promptGenerationBinding,
            required: Boolean(dispatchEnvelope?.runner?.handoffSnapshots),
            missingCode: 'dispatch_envelope_preview_snapshot_prompt_generation_binding_missing',
            incompleteCode: 'dispatch_envelope_preview_snapshot_prompt_generation_binding_incomplete',
            mismatchCode: 'dispatch_envelope_preview_snapshot_prompt_generation_binding_mismatch',
          },
          {
            binding: dispatchEnvelope?.runner?.handoffSnapshots?.preview?.adapter?.requiredHashes?.promptGenerationBinding,
            required: Boolean(dispatchEnvelope?.runner?.handoffSnapshots),
            missingCode: 'dispatch_envelope_preview_required_hashes_prompt_generation_binding_missing',
            incompleteCode: 'dispatch_envelope_preview_required_hashes_prompt_generation_binding_incomplete',
            mismatchCode: 'dispatch_envelope_preview_required_hashes_prompt_generation_binding_mismatch',
          },
        ], expectedPromptGenerationBinding);
      }
      const actualPromptGenerationBinding = receiptPromptGenerationBinding(receipt);
      if (!actualPromptGenerationBinding) {
        blockers.push(issue('receipt_prompt_generation_binding_missing'));
      } else {
        const missingActualKeys = missingPromptGenerationBindingKeys(actualPromptGenerationBinding);
        if (missingActualKeys.length) {
          blockers.push(issue('receipt_prompt_generation_binding_incomplete', missingActualKeys.join(', ')));
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
        if (
          expectedPromptGenerationBinding
          && !samePromptGenerationBinding(expectedPromptGenerationBinding, actualPromptGenerationBinding)
        ) {
          blockers.push(issue('receipt_prompt_generation_binding_mismatch'));
        }
      }
    }
    if (requiresCustomerMessageHashes({ dispatchEnvelope, receipt })) {
      if (!requiredHash(dispatchEnvelope, 'messagePreviewHash')) {
        blockers.push(issue('dispatch_envelope_message_preview_hash_missing'));
      }
      if (!receiptRequiredHash(receipt, 'messagePreviewHash')) {
        blockers.push(issue('receipt_message_preview_hash_missing'));
      }
    }
    if (requiresHumanFeedbackContractHash({ dispatchEnvelope, receipt })) {
      if (!requiredHash(dispatchEnvelope, 'humanFeedbackRevisionContractHash')) {
        blockers.push(issue('dispatch_envelope_human_feedback_contract_hash_missing'));
      }
      if (!receiptRequiredHash(receipt, 'humanFeedbackRevisionContractHash')) {
        blockers.push(issue('receipt_human_feedback_contract_hash_missing'));
      }
    }
    blockers.push(...dispatchEnvelopeMessagePreviewHashBlockers({ dispatchEnvelope, receipt }));
    blockers.push(...dispatchEnvelopeHumanFeedbackContractHashBlockers({ dispatchEnvelope, receipt }));
    compareRequiredReceiptHash(dispatchEnvelope, receipt, 'humanFeedbackRevisionContractHash', 'human_feedback_contract', blockers);
    compareRequiredReceiptHash(dispatchEnvelope, receipt, 'messagePreviewHash', 'message_preview', blockers);
    const expectedMessagePreviewHash = requiredHash(dispatchEnvelope, 'messagePreviewHash')
      || receiptRequiredHash(receipt, 'messagePreviewHash');
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

  return blockers;
}

function nextStepFor(receipt, blockers) {
  if (blockers.length) return ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.BLOCKED;
  if (receipt?.result?.status === ADAPTER_RESULT_STATUS.SUCCESS) {
    return ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED;
  }
  return ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.TERMINAL_RESULT_RECORDED;
}

function statusFor(nextStep, blockers) {
  if (blockers.length) return ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.BLOCKED;
  if (nextStep === ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED) {
    return ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.RECEIVED;
  }
  return ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.TERMINAL;
}

export function buildAdapterDispatchReceiptInboxItem({
  dispatchEnvelope = null,
  receipt = null,
  receivedBy = 'design-production-core.adapter-dispatch-receipt-inbox',
  evidenceRefs = [],
  receivedAt = null,
  createdAt = null,
} = {}) {
  const blockers = inboxBlockers({ dispatchEnvelope, receipt });
  const nextStep = nextStepFor(receipt, blockers);
  const status = statusFor(nextStep, blockers);
  const received = status === ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.RECEIVED;
  const terminal = status === ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.TERMINAL;
  const action = canonicalActionOrNull(dispatchEnvelope?.action || receipt?.action);
  const productLineId = canonicalProductLineOrNull(dispatchEnvelope?.payload?.productLineId || receipt?.payload?.productLineId);
  const workflowId = canonicalProductLineOrNull(dispatchEnvelope?.payload?.workflowId || receipt?.payload?.workflowId);
  const packageRole = canonicalPackageRole(dispatchEnvelope?.payload?.packageRole || receipt?.payload?.packageRole || '') || null;
  const item = {
    version: ADAPTER_DISPATCH_RECEIPT_INBOX_VERSION,
    kind: 'AdapterDispatchReceiptInboxItem',
    receivedBy: normalizeText(receivedBy || 'design-production-core.adapter-dispatch-receipt-inbox'),
    status,
    received,
    terminal,
    nextStep,
    channelId: dispatchEnvelope?.channelId || receipt?.channelId || null,
    actionId: dispatchEnvelope?.actionId || receipt?.actionId || null,
    action,
    payload: {
      taskKey: dispatchEnvelope?.payload?.taskKey || receipt?.payload?.taskKey || null,
      externalId: dispatchEnvelope?.payload?.externalId || receipt?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole,
      resultStatus: receipt?.result?.status || null,
    },
    hashBinding: {
      dispatchEnvelopeHash: hashOf(dispatchEnvelope, 'dispatchEnvelopeHash'),
      outboxHash: requiredHash(dispatchEnvelope, 'outboxHash'),
      replayGuardHash: requiredHash(dispatchEnvelope, 'replayGuardHash'),
      archiveHash: requiredHash(dispatchEnvelope, 'archiveHash'),
      ledgerHash: requiredHash(dispatchEnvelope, 'ledgerHash'),
      receiptHash: hashOf(receipt, 'receiptHash'),
      manifestHash: receiptHash(receipt, 'manifestHash'),
      previewHash: receiptHash(receipt, 'previewHash'),
      approvalHash: receiptHash(receipt, 'approvalHash'),
      evidenceHash: receiptHash(receipt, 'evidenceHash'),
      approvalProvenanceHash: receiptHash(receipt, 'approvalProvenanceHash'),
      humanFeedbackRevisionContractHash: receiptRequiredHash(receipt, 'humanFeedbackRevisionContractHash'),
      messagePreviewHash: receiptRequiredHash(receipt, 'messagePreviewHash'),
      promptGenerationBinding: receiptPromptGenerationBinding(receipt),
      platformStateSnapshotHash: receiptHash(receipt, 'platformStateSnapshotHash'),
      dryRunReplayHash: receiptHash(receipt, 'dryRunReplayHash'),
    },
    blockers,
    warnings: [
      issue('dispatch_receipt_inbox_verifies_only', 'Core dispatch receipt inbox items never run adapters or fetch channel state.', 'warning'),
      ...(nextStep === ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED
        ? [issue('channel_state_proof_required', 'A successful dispatch receipt still needs independent channel state proof.', 'warning')]
        : []),
      ...(nextStep === ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.TERMINAL_RESULT_RECORDED
        ? [issue('terminal_result_recorded', 'A non-success accepted dispatch receipt is terminal and does not request channel proof.', 'warning')]
        : []),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      dispatchReceiptInboxOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
      requiresDispatchEnvelope: true,
      requiresReceiptHashBinding: true,
      currentChannelProofStillRequired: nextStep === ADAPTER_DISPATCH_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED,
    },
    receivedAt: receivedAt || createdAt || new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  };
  const inboxHash = computeAdapterDispatchReceiptInboxHash(item);
  return {
    ...item,
    inboxHash,
    hash: inboxHash,
  };
}

export function computeAdapterDispatchReceiptInboxHash(item = null) {
  return digest({
    version: item?.version,
    kind: item?.kind,
    receivedBy: item?.receivedBy,
    status: item?.status,
    received: item?.received,
    terminal: item?.terminal,
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

export function summarizeAdapterDispatchReceiptInbox(items = []) {
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
    version: ADAPTER_DISPATCH_RECEIPT_INBOX_VERSION,
    count: items.length,
    byStatus,
    byNextStep,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      dispatchReceiptInboxOnly: true,
      executesExternalAction: items.some((item) => item.safety?.executesExternalAction === true),
      fetchesChannelState: items.some((item) => item.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: items.some((item) => item.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: items.some((item) => item.safety?.grantsExecutionPermission === true),
    },
  };
}
