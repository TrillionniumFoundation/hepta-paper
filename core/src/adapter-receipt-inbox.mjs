import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  computeCustomerMessagePreviewHashFromFields,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
} from './contracts.mjs';
import {
  ADAPTER_HANDOFF_OUTBOX_STATUS,
  computeAdapterHandoffOutboxHash,
} from './adapter-handoff-outbox.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, computeAdapterRunReceiptHash } from './adapter-receipt.mjs';
import {
  EXTERNAL_ACTION_LEDGER_STATUS,
  computeExternalActionLedgerHash,
} from './external-action-ledger.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_RECEIPT_INBOX_VERSION = 1;

export const ADAPTER_RECEIPT_INBOX_STATUS = Object.freeze({
  RECEIVED: 'received_adapter_receipt',
  BLOCKED: 'blocked_receipt_inbox',
});

export const ADAPTER_RECEIPT_NEXT_STEP = Object.freeze({
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

function hashOf(value, key) {
  return normalizeText(key === 'hash' ? value?.hash : value?.[key] || '') || null;
}

function expectedHash(outboxItem, key) {
  return normalizeText(outboxItem?.runner?.requiredHashes?.[key] || '') || null;
}

function isCustomerMessageOutbox(outboxItem = {}) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  return [
    outboxItem?.action,
    outboxItem?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function isHumanFeedbackValue(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function isHumanFeedbackOutbox(outboxItem = {}) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  const productValues = [
    outboxItem?.payload?.productLineId,
    outboxItem?.payload?.workflowId,
    outboxItem?.payload?.packageRole,
    snapshots.manifest?.productLineId,
    snapshots.manifest?.workflowId,
    snapshots.manifest?.payload?.productLineId,
    snapshots.manifest?.payload?.workflowId,
    snapshots.manifest?.payload?.packageRole,
    snapshots.manifest?.payload?.reviewType,
    snapshots.manifest?.payload?.role,
    snapshots.preview?.payload?.productLineId,
    snapshots.preview?.payload?.workflowId,
    snapshots.preview?.payload?.packageRole,
    snapshots.preview?.payload?.reviewType,
    snapshots.preview?.payload?.role,
  ];
  const actionValues = [
    outboxItem?.action,
    outboxItem?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ];
  return productValues.some((value) => isHumanFeedbackValue(value))
    || actionValues.some((value) => isHumanFeedbackMessageActionAlias(value));
}

function boundHashValues(outboxItem = {}, key) {
  const snapshots = outboxItem?.runner?.handoffSnapshots || {};
  return [
    ['payload', outboxItem?.payload?.[key]],
    ['runner_required_hashes', outboxItem?.runner?.requiredHashes?.[key]],
    ['manifest_payload', snapshots.manifest?.payload?.[key]],
    ['preview_payload', snapshots.preview?.payload?.[key]],
    ['preview_required_hashes', snapshots.preview?.adapter?.requiredHashes?.[key]],
  ];
}

function hasBoundHashValue(outboxItem = {}, key) {
  return boundHashValues(outboxItem, key).some(([, value]) => normalizeText(value || ''));
}

function isHumanFeedbackMessageOutbox(outboxItem = {}) {
  return isCustomerMessageOutbox(outboxItem)
    && (
      isHumanFeedbackOutbox(outboxItem)
      || hasBoundHashValue(outboxItem, 'humanFeedbackRevisionContractHash')
    );
}

function requiredBoundHashBlockers(outboxItem, key, {
  required,
  requiredCode,
  mismatchCode,
}) {
  const values = boundHashValues(outboxItem, key);
  const present = values.map(([, value]) => normalizeText(value || '') || null).filter(Boolean);
  if (!required && !present.length) return [];
  const blockers = [];
  const missingSources = values.filter(([, value]) => !normalizeText(value || '')).map(([source]) => source);
  if (missingSources.length) blockers.push(issue(requiredCode, missingSources.join(', ')));
  if (present.length && present.some((value) => value !== present[0])) blockers.push(issue(mismatchCode));
  return blockers;
}

function messagePreviewHashBlockers(outboxItem = {}) {
  return requiredBoundHashBlockers(outboxItem, 'messagePreviewHash', {
    required: isCustomerMessageOutbox(outboxItem),
    requiredCode: 'outbox_message_preview_hash_required',
    mismatchCode: 'outbox_message_preview_hash_mismatch',
  });
}

function humanFeedbackContractHashBlockers(outboxItem = {}) {
  return requiredBoundHashBlockers(outboxItem, 'humanFeedbackRevisionContractHash', {
    required: isHumanFeedbackMessageOutbox(outboxItem),
    requiredCode: 'outbox_human_feedback_contract_hash_required',
    mismatchCode: 'outbox_human_feedback_contract_hash_mismatch',
  });
}

function receiptHash(receipt, key) {
  return normalizeText(receipt?.hashBinding?.[key] || '') || null;
}

function receiptRequiredHash(receipt, key) {
  return normalizeText(
    receipt?.hashBinding?.[key]
      || receipt?.payload?.[key]
      || receipt?.result?.external?.[key]
      || '',
  ) || null;
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

function recordedReceiptHash(receipt) {
  return normalizeText(receipt?.receiptHash || '') || null;
}

function hashMismatch(outboxItem, receipt, key, blockers) {
  const expected = expectedHash(outboxItem, key);
  const actual = receiptHash(receipt, key);
  if (!expected) blockers.push(issue(`${key}_missing_from_outbox`));
  if (!actual) blockers.push(issue(`${key}_missing_from_receipt`));
  if (expected && actual && expected !== actual) blockers.push(issue(`${key}_mismatch`));
}

function ledgerChainHashMismatch(outboxItem, ledgerEntry, key, blockers) {
  const expected = expectedHash(outboxItem, key);
  const actual = normalizeText(ledgerEntry?.chain?.[key] || '') || null;
  const label = key === 'manifestHash' ? 'manifest_hash' : 'preview_hash';
  if (!expected) blockers.push(issue(`${label}_missing_from_outbox`));
  if (!actual) blockers.push(issue(`ledger_${label}_missing`));
  if (expected && actual && expected !== actual) blockers.push(issue(`ledger_${label}_mismatch`));
}

function requiredHashMismatch(outboxItem, receipt, key, prefix, blockers) {
  const expected = expectedHash(outboxItem, key);
  const actual = receiptRequiredHash(receipt, key);
  if (!expected) return;
  if (!actual) blockers.push(issue(`receipt_${prefix}_hash_missing`));
  if (expected && actual && expected !== actual) blockers.push(issue(`receipt_${prefix}_hash_mismatch`));
}

function requireReceiptHash(receipt, key, code, blockers) {
  if (!receiptHash(receipt, key)) blockers.push(issue(code));
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

function expectedPromptGenerationBinding(outboxItem = null) {
  return outboxItem?.payload?.promptGenerationBinding
    || outboxItem?.runner?.requiredHashes?.promptGenerationBinding
    || null;
}

function receiptPromptGenerationBinding(receipt = null) {
  return receipt?.hashBinding?.promptGenerationBinding
    || receipt?.payload?.promptGenerationBinding
    || null;
}

function isPromptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonical === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function requiresPromptGenerationBinding({ outboxItem, receipt }) {
  return [
    outboxItem?.action,
    outboxItem?.payload?.action,
    receipt?.action,
    receipt?.payload?.action,
    receipt?.result?.external?.action,
  ].some((action) => isPromptGenerationSpendAction(action));
}

function promptGenerationBindingMismatch(outboxItem, receipt, blockers) {
  const expected = expectedPromptGenerationBinding(outboxItem);
  const required = requiresPromptGenerationBinding({ outboxItem, receipt });
  if (required && !expected) blockers.push(issue('outbox_prompt_generation_binding_missing'));
  if (!expected && !required) return;
  if (expected) {
    const missingExpectedKeys = missingPromptGenerationBindingKeys(expected);
    if (missingExpectedKeys.length) {
      blockers.push(issue('outbox_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
    }
    pushPromptGenerationBindingSourceBlockers(blockers, [
      {
        binding: outboxItem?.payload?.promptGenerationBinding,
        required: true,
        missingCode: 'outbox_payload_prompt_generation_binding_missing',
        incompleteCode: 'outbox_payload_prompt_generation_binding_incomplete',
        mismatchCode: 'outbox_payload_prompt_generation_binding_mismatch',
      },
      {
        binding: outboxItem?.runner?.requiredHashes?.promptGenerationBinding,
        required: true,
        missingCode: 'outbox_required_hashes_prompt_generation_binding_missing',
        incompleteCode: 'outbox_required_hashes_prompt_generation_binding_incomplete',
        mismatchCode: 'outbox_required_hashes_prompt_generation_binding_mismatch',
      },
      {
        binding: outboxItem?.runner?.handoffSnapshots?.manifest?.payload?.promptGenerationBinding,
        required: Boolean(outboxItem?.runner?.handoffSnapshots),
        missingCode: 'outbox_manifest_snapshot_prompt_generation_binding_missing',
        incompleteCode: 'outbox_manifest_snapshot_prompt_generation_binding_incomplete',
        mismatchCode: 'outbox_manifest_snapshot_prompt_generation_binding_mismatch',
      },
      {
        binding: outboxItem?.runner?.handoffSnapshots?.preview?.payload?.promptGenerationBinding,
        required: Boolean(outboxItem?.runner?.handoffSnapshots),
        missingCode: 'outbox_preview_snapshot_prompt_generation_binding_missing',
        incompleteCode: 'outbox_preview_snapshot_prompt_generation_binding_incomplete',
        mismatchCode: 'outbox_preview_snapshot_prompt_generation_binding_mismatch',
      },
      {
        binding: outboxItem?.runner?.handoffSnapshots?.preview?.adapter?.requiredHashes?.promptGenerationBinding,
        required: Boolean(outboxItem?.runner?.handoffSnapshots),
        missingCode: 'outbox_preview_required_hashes_prompt_generation_binding_missing',
        incompleteCode: 'outbox_preview_required_hashes_prompt_generation_binding_incomplete',
        mismatchCode: 'outbox_preview_required_hashes_prompt_generation_binding_mismatch',
      },
    ], expected);
  }
  const actual = receiptPromptGenerationBinding(receipt);
  if (!actual) {
    blockers.push(issue('receipt_prompt_generation_binding_missing'));
  } else {
    const missingActualKeys = missingPromptGenerationBindingKeys(actual);
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
    ], expected);
  }
  if (
    actual
    && expected
    && !samePromptGenerationBinding(expected, actual)
  ) {
    blockers.push(issue('receipt_prompt_generation_binding_mismatch'));
  }
}

function ledgerPromptGenerationBindingMismatch(outboxItem, ledgerEntry, blockers) {
  const expected = expectedPromptGenerationBinding(outboxItem);
  const actual = ledgerEntry?.chain?.promptGenerationBinding || ledgerEntry?.payload?.promptGenerationBinding || null;
  if (!expected || !actual) return;
  const missingActualKeys = missingPromptGenerationBindingKeys(actual);
  if (missingActualKeys.length) {
    blockers.push(issue('ledger_prompt_generation_binding_incomplete', missingActualKeys.join(', ')));
  } else if (!samePromptGenerationBinding(expected, actual)) {
    blockers.push(issue('ledger_prompt_generation_binding_mismatch'));
  }
}

function pushIssueOnce(blockers, code) {
  if (!blockers.some((item) => item.code === code)) blockers.push(issue(code));
}

function addMessagePreviewContentBlocker(value, expected, code, blockers) {
  const normalizedExpected = normalizeText(expected || '');
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

function inboxBlockers({ outboxItem, receipt, ledgerEntry }) {
  const blockers = [];

  if (outboxItem?.kind !== 'AdapterHandoffOutboxItem') blockers.push(issue('invalid_outbox_kind'));
  if (outboxItem && (outboxItem.status !== ADAPTER_HANDOFF_OUTBOX_STATUS.QUEUED || outboxItem.queued !== true)) {
    blockers.push(issue('outbox_not_queued'));
  }
  if (outboxItem?.kind === 'AdapterHandoffOutboxItem') {
    const outboxHash = hashOf(outboxItem, 'outboxHash');
    const recomputedHash = computeAdapterHandoffOutboxHash(outboxItem);
    if (!outboxHash) blockers.push(issue('outbox_hash_required'));
    if (outboxHash && recomputedHash && outboxHash !== recomputedHash) {
      blockers.push(issue('outbox_hash_content_mismatch'));
    }
  }
  if (receipt?.kind !== 'AdapterRunReceipt') blockers.push(issue('invalid_receipt_kind'));
  if (receipt && (receipt.status !== ADAPTER_RECEIPT_STATUS.ACCEPTED || receipt.accepted !== true)) {
    blockers.push(issue('receipt_not_accepted'));
  }
  if (receipt?.kind === 'AdapterRunReceipt') {
    const recordedHash = recordedReceiptHash(receipt);
    const recomputedHash = computeAdapterRunReceiptHash(receipt);
    if (!recordedHash) blockers.push(issue('receipt_hash_required'));
    if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
      blockers.push(issue('receipt_hash_content_mismatch'));
    }
  }

  compareField(outboxItem?.channelId, receipt?.channelId, 'channel_id_mismatch', blockers);
  compareField(outboxItem?.actionId, receipt?.actionId, 'action_id_mismatch', blockers);
  compareActionField(outboxItem?.action, receipt?.action, 'action_mismatch', blockers);
  compareField(outboxItem?.payload?.taskKey, receipt?.payload?.taskKey, 'task_key_mismatch', blockers);
  compareField(outboxItem?.payload?.externalId, receipt?.payload?.externalId, 'external_id_mismatch', blockers);

  hashMismatch(outboxItem, receipt, 'manifestHash', blockers);
  hashMismatch(outboxItem, receipt, 'previewHash', blockers);
  hashMismatch(outboxItem, receipt, 'approvalHash', blockers);
  hashMismatch(outboxItem, receipt, 'evidenceHash', blockers);
  hashMismatch(outboxItem, receipt, 'approvalProvenanceHash', blockers);
  requireReceiptHash(receipt, 'platformStateSnapshotHash', 'receipt_platform_state_snapshot_hash_missing', blockers);
  requireReceiptHash(receipt, 'dryRunReplayHash', 'receipt_dry_run_replay_hash_missing', blockers);
  requiredHashMismatch(outboxItem, receipt, 'humanFeedbackRevisionContractHash', 'human_feedback_contract', blockers);
  requiredHashMismatch(outboxItem, receipt, 'messagePreviewHash', 'message_preview', blockers);
  blockers.push(...messagePreviewHashBlockers(outboxItem));
  blockers.push(...humanFeedbackContractHashBlockers(outboxItem));
  promptGenerationBindingMismatch(outboxItem, receipt, blockers);
  const expectedMessagePreviewHash = expectedHash(outboxItem, 'messagePreviewHash')
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

  if (ledgerEntry) {
    if (ledgerEntry.kind !== 'ExternalActionLedgerEntry') blockers.push(issue('invalid_ledger_kind'));
    if (ledgerEntry.status !== EXTERNAL_ACTION_LEDGER_STATUS.PENDING_RUNNER_RECEIPT) {
      blockers.push(issue('ledger_not_pending_runner_receipt'));
    }
    const outboxLedgerHash = expectedHash(outboxItem, 'ledgerHash');
    const ledgerHash = hashOf(ledgerEntry, 'ledgerHash');
    const recomputedLedgerHash = computeExternalActionLedgerHash(ledgerEntry);
    if (!ledgerHash) blockers.push(issue('ledger_hash_required'));
    if (ledgerHash && recomputedLedgerHash && ledgerHash !== recomputedLedgerHash) {
      blockers.push(issue('ledger_hash_content_mismatch'));
    }
    if (!outboxLedgerHash) blockers.push(issue('ledger_hash_missing_from_outbox'));
    if (outboxLedgerHash && ledgerHash && outboxLedgerHash !== ledgerHash) blockers.push(issue('ledger_hash_mismatch'));
    ledgerChainHashMismatch(outboxItem, ledgerEntry, 'manifestHash', blockers);
    ledgerChainHashMismatch(outboxItem, ledgerEntry, 'previewHash', blockers);
    ledgerPromptGenerationBindingMismatch(outboxItem, ledgerEntry, blockers);
    if (ledgerEntry.chain?.receiptHash) blockers.push(issue('ledger_already_has_receipt'));
  }

  return blockers;
}

function nextStepFor(receipt, blockers) {
  if (blockers.length) return ADAPTER_RECEIPT_NEXT_STEP.BLOCKED;
  if (receipt?.result?.status === ADAPTER_RESULT_STATUS.SUCCESS) return ADAPTER_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED;
  return ADAPTER_RECEIPT_NEXT_STEP.TERMINAL_RESULT_RECORDED;
}

export function buildAdapterReceiptInboxItem({
  outboxItem = null,
  receipt = null,
  ledgerEntry = null,
  receivedBy = 'design-production-core.adapter-receipt-inbox',
  evidenceRefs = [],
  receivedAt = null,
  createdAt = null,
} = {}) {
  const blockers = inboxBlockers({ outboxItem, receipt, ledgerEntry });
  const nextStep = nextStepFor(receipt, blockers);
  const action = canonicalActionOrNull(outboxItem?.action || receipt?.action);
  const productLineId = canonicalProductLineOrNull(outboxItem?.payload?.productLineId || receipt?.payload?.productLineId);
  const workflowId = canonicalProductLineOrNull(outboxItem?.payload?.workflowId || receipt?.payload?.workflowId);
  const packageRole = canonicalPackageRole(outboxItem?.payload?.packageRole || receipt?.payload?.packageRole || '') || null;
  const item = {
    version: ADAPTER_RECEIPT_INBOX_VERSION,
    kind: 'AdapterReceiptInboxItem',
    receivedBy: normalizeText(receivedBy || 'design-production-core.adapter-receipt-inbox'),
    status: blockers.length ? ADAPTER_RECEIPT_INBOX_STATUS.BLOCKED : ADAPTER_RECEIPT_INBOX_STATUS.RECEIVED,
    received: blockers.length === 0,
    nextStep,
    channelId: outboxItem?.channelId || receipt?.channelId || null,
    actionId: outboxItem?.actionId || receipt?.actionId || null,
    action,
    payload: {
      taskKey: outboxItem?.payload?.taskKey || receipt?.payload?.taskKey || null,
      externalId: outboxItem?.payload?.externalId || receipt?.payload?.externalId || null,
      productLineId,
      workflowId,
      packageRole,
      resultStatus: receipt?.result?.status || null,
    },
    hashBinding: {
      outboxHash: hashOf(outboxItem, 'outboxHash'),
      ledgerHash: hashOf(ledgerEntry, 'ledgerHash') || expectedHash(outboxItem, 'ledgerHash'),
      receiptHash: recordedReceiptHash(receipt),
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
      issue('inbox_verifies_only', 'Core receipt inbox items never run adapters or fetch channel state.', 'warning'),
      ...(nextStep === ADAPTER_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED
        ? [issue('channel_state_proof_required', 'A successful receipt still needs independent channel state proof.', 'warning')]
        : []),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      inboxOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      requiresQueuedOutbox: true,
      requiresReceiptHashBinding: true,
      currentChannelProofStillRequired: nextStep === ADAPTER_RECEIPT_NEXT_STEP.CHANNEL_STATE_PROOF_REQUIRED,
    },
    receivedAt: receivedAt || createdAt || new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  };
  const inboxHash = computeAdapterReceiptInboxHash(item);
  return {
    ...item,
    inboxHash,
    hash: inboxHash,
  };
}

export function computeAdapterReceiptInboxHash(item = null) {
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

export function summarizeAdapterReceiptInbox(items = []) {
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
    version: ADAPTER_RECEIPT_INBOX_VERSION,
    count: items.length,
    byStatus,
    byNextStep,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      inboxOnly: true,
      executesExternalAction: items.some((item) => item.safety?.executesExternalAction === true),
      fetchesChannelState: items.some((item) => item.safety?.fetchesChannelState === true),
    },
  };
}
