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
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, buildAdapterRunReceipt } from './adapter-receipt.mjs';
import { buildChannelStateProof, buildReceiptStateTransition } from './channel-state-proof.mjs';
import { buildAdapterDispatchReceiptInboxItem } from './adapter-dispatch-receipt-inbox.mjs';
import { buildAdapterDispatchChannelStateProofInboxItem } from './adapter-dispatch-channel-state-proof-inbox.mjs';
import { buildAdapterDispatchReceiptStateTransitionInboxItem } from './adapter-dispatch-receipt-state-transition-inbox.mjs';
import { buildExternalActionLedgerEntry } from './external-action-ledger.mjs';
import { buildExternalActionAuditBundle } from './external-action-audit-bundle.mjs';
import { buildExternalActionAuditArchive } from './external-action-audit-archive.mjs';
import { buildExternalActionReplayGuardDecision } from './external-action-replay-guard.mjs';
import {
  buildPostActionDispatchEnvelopeMatrixRecords,
  buildPostActionDispatchEnvelopeMatrixReport,
} from './post-action-dispatch-envelope-matrix.mjs';
import { digest } from './hash-utils.mjs';

export const POST_ACTION_DISPATCH_COMPLETION_MATRIX_VERSION = 1;

export const POST_ACTION_DISPATCH_COMPLETION_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_post_action_dispatch_completion_matrix',
  FAIL: 'fail_post_action_dispatch_completion_matrix',
});

const FIXED_CREATED_AT = '2026-06-08T09:45:00.000Z';

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
    notes: normalizeText(notes || '') || null,
  };
}

function token(value) {
  return normalizeText(value || '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function blockerCodes(record) {
  return uniqueStrings((record?.blockers || []).map((item) => item.code), 64);
}

function hashOf(value, key) {
  return normalizeText(value?.[key] || '') || null;
}

function dispatchRequiredHash(record, key) {
  return normalizeText(record.dispatchEnvelope?.runner?.requiredHashes?.[key] || '') || null;
}

function customerMessageAction(value) {
  return canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
}

function humanFeedbackProductRoute(route = {}) {
  const payload = route.payload || {};
  const productValues = [
    route.productLineId,
    route.workflowId,
    route.packageRole,
    route.reviewType,
    route.role,
    payload.productLineId,
    payload.workflowId,
    payload.packageRole,
    payload.reviewType,
    payload.role,
  ];
  return productValues.some((value) => canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK);
}

export function isPostActionDispatchCompletionHumanFeedbackRoute(route = {}) {
  const payload = route.payload || {};
  const actionValues = [route.action, route.actionId, payload.action, route.dispatchEnvelope?.action];
  return actionValues.some(customerMessageAction)
    && (
      actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || humanFeedbackProductRoute(route)
    );
}

function isPostActionDispatchCompletionHumanFeedbackContractRoute(route = {}) {
  const payload = route.payload || {};
  const actionValues = [route.action, route.actionId, payload.action, route.dispatchEnvelope?.action];
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && humanFeedbackProductRoute(route);
}

function humanFeedbackContractRecord(record, ledger = null) {
  return isPostActionDispatchCompletionHumanFeedbackContractRoute({
    action: record.action,
    actionId: record.actionId,
    productLineId: ledger?.payload?.productLineId || record.dispatchEnvelope?.payload?.productLineId,
    workflowId: ledger?.payload?.workflowId || record.dispatchEnvelope?.payload?.workflowId,
    packageRole: ledger?.payload?.packageRole || record.dispatchEnvelope?.payload?.packageRole,
    payload: {
      action: ledger?.payload?.action || record.dispatchEnvelope?.payload?.action,
      productLineId: ledger?.payload?.productLineId || record.dispatchEnvelope?.payload?.productLineId,
      workflowId: ledger?.payload?.workflowId || record.dispatchEnvelope?.payload?.workflowId,
      packageRole: ledger?.payload?.packageRole || record.dispatchEnvelope?.payload?.packageRole,
    },
    dispatchEnvelope: record.dispatchEnvelope,
  });
}

function promptGenerationSpendRoute(record = {}, ledger = null) {
  return [record.action, record.actionId, record.dispatchEnvelope?.payload?.action, ledger?.payload?.action]
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

function dispatchReportedHashes(record, overrides = {}) {
  return {
    manifestHash: dispatchRequiredHash(record, 'manifestHash'),
    previewHash: dispatchRequiredHash(record, 'previewHash'),
    approvalHash: dispatchRequiredHash(record, 'approvalHash'),
    evidenceHash: dispatchRequiredHash(record, 'evidenceHash'),
    approvalProvenanceHash: dispatchRequiredHash(record, 'approvalProvenanceHash'),
    platformStateSnapshotHash: record.sourceReceipt?.hashBinding?.platformStateSnapshotHash || null,
    dryRunReplayHash: record.sourceReceipt?.hashBinding?.dryRunReplayHash || null,
    dispatchEnvelopeHash: hashOf(record.dispatchEnvelope, 'dispatchEnvelopeHash'),
    outboxHash: dispatchRequiredHash(record, 'outboxHash'),
    replayGuardHash: dispatchRequiredHash(record, 'replayGuardHash'),
    archiveHash: dispatchRequiredHash(record, 'archiveHash'),
    ledgerHash: dispatchRequiredHash(record, 'ledgerHash'),
    ...overrides,
  };
}

function buildDispatchReceipt(record, overrides = {}) {
  return buildAdapterRunReceipt({
    manifest: record.manifest,
    preview: record.preview,
    resultStatus: ADAPTER_RESULT_STATUS.SUCCESS,
    externalResult: record.sourceReceipt?.result?.external || {},
    reportedHashes: dispatchReportedHashes(record, overrides),
    runnerId: 'post-action-dispatch-completion-matrix.external-runner',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function buildDispatchProof(record, receipt) {
  return buildChannelStateProof({
    receipt,
    stateEvidence: {
      ...(record.sourceProof?.evidence || {}),
      receiptHash: hashOf(receipt, 'receiptHash'),
    },
    verifierId: 'post-action-dispatch-completion-matrix.synthetic-proof',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function buildDispatchTransition(proof) {
  return buildReceiptStateTransition({
    proof,
    actor: 'post-action-dispatch-completion-matrix.transition',
    reason: 'synthetic dispatch completion matrix receipt transition',
    createdAt: FIXED_CREATED_AT,
  });
}

function buildDispatchReceiptInbox(record, receipt) {
  return buildAdapterDispatchReceiptInboxItem({
    dispatchEnvelope: record.dispatchEnvelope,
    receipt,
    receivedBy: 'post-action-dispatch-completion-matrix.receipt-inbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function buildDispatchProofInbox(dispatchReceiptInboxItem, proof, receipt) {
  return buildAdapterDispatchChannelStateProofInboxItem({
    dispatchReceiptInboxItem,
    proof,
    receipt,
    receivedBy: 'post-action-dispatch-completion-matrix.proof-inbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function buildDispatchTransitionInbox(dispatchProofInboxItem, proof, receipt, transition) {
  return buildAdapterDispatchReceiptStateTransitionInboxItem({
    dispatchProofInboxItem,
    proof,
    receipt,
    transition,
    receivedBy: 'post-action-dispatch-completion-matrix.transition-inbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function buildDispatchLedger(record, parts = {}) {
  return buildExternalActionLedgerEntry({
    manifest: record.manifest,
    preview: record.preview,
    receipt: parts.receipt || null,
    proof: parts.proof || null,
    transition: parts.transition || null,
    dispatchReceiptInboxItem: parts.dispatchReceiptInboxItem || null,
    dispatchProofInboxItem: parts.dispatchProofInboxItem || null,
    dispatchTransitionInboxItem: parts.dispatchTransitionInboxItem || null,
    actor: 'post-action-dispatch-completion-matrix.ledger',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function buildDispatchBundle(ledgerEntry, bundleRole = 'post_action_dispatch_completion') {
  return buildExternalActionAuditBundle({
    ledgerEntry,
    bundleRole,
    requireInboxChain: true,
    actor: 'post-action-dispatch-completion-matrix.bundle',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function replayCandidateForRecord(record, bundle = null) {
  return {
    kind: 'ReplayGuardCandidate',
    channelId: record.channelId,
    actionId: record.actionId,
    action: canonicalActionOrNull(record.action),
    taskKey: record.dispatchEnvelope?.payload?.taskKey || record.scenarioId,
    externalId: record.dispatchEnvelope?.payload?.externalId || null,
    productLineId: canonicalProductLineOrNull(record.dispatchEnvelope?.payload?.productLineId),
    workflowId: canonicalProductLineOrNull(record.dispatchEnvelope?.payload?.workflowId),
    packageRole: canonicalPackageRole(record.dispatchEnvelope?.payload?.packageRole || '') || null,
    messagePreviewHash: record.dispatchEnvelope?.payload?.messagePreviewHash || null,
    humanFeedbackRevisionContractHash: record.dispatchEnvelope?.payload?.humanFeedbackRevisionContractHash || null,
    promptGenerationBinding: record.dispatchEnvelope?.payload?.promptGenerationBinding || null,
    bundleHash: hashOf(bundle, 'bundleHash'),
  };
}

function strippedHashAlias(value, key) {
  const stripped = cloneJson(value);
  delete stripped[key];
  return stripped;
}

function strippedDispatchRequiredHashRecord(record, key) {
  const stripped = cloneJson(record);
  if (stripped.dispatchEnvelope?.runner?.requiredHashes) {
    delete stripped.dispatchEnvelope.runner.requiredHashes[key];
  }
  return stripped;
}

function strippedDispatchPayloadHashRecord(record, key) {
  const stripped = cloneJson(record);
  if (stripped.dispatchEnvelope?.payload) {
    delete stripped.dispatchEnvelope.payload[key];
  }
  return stripped;
}

function archiveForBundles(bundles) {
  return buildExternalActionAuditArchive({
    bundles,
    archiveRole: 'post_action_dispatch_completion_matrix_archive',
    actor: 'post-action-dispatch-completion-matrix.archive',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function rowForRecord(record, aggregateArchive = null) {
  const receipt = buildDispatchReceipt(record);
  const dispatchReceiptInboxItem = buildDispatchReceiptInbox(record, receipt);
  const proof = buildDispatchProof(record, receipt);
  const dispatchProofInboxItem = buildDispatchProofInbox(dispatchReceiptInboxItem, proof, receipt);
  const transition = buildDispatchTransition(proof);
  const dispatchTransitionInboxItem = buildDispatchTransitionInbox(dispatchProofInboxItem, proof, receipt, transition);
  const ledger = buildDispatchLedger(record, {
    receipt,
    proof,
    transition,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
  });
  const auditBundle = buildDispatchBundle(ledger);
  const perRouteArchive = archiveForBundles([auditBundle]);

  const badReceipt = buildDispatchReceipt(record, {
    dispatchEnvelopeHash: `sha256:tampered-dispatch-envelope-${token(record.scenarioId)}`,
  });
  const tamperedReceiptInboxItem = buildDispatchReceiptInbox(record, badReceipt);
  const missingProofInboxItem = buildDispatchProofInbox(dispatchReceiptInboxItem, null, receipt);
  const missingTransitionInboxItem = buildDispatchTransitionInbox(dispatchProofInboxItem, proof, receipt, null);
  const rawLedger = buildDispatchLedger(record, { receipt, proof, transition });
  const rawBundle = buildDispatchBundle(rawLedger, 'post_action_dispatch_completion_raw_ledger_probe');
  const missingTransitionLedger = buildDispatchLedger(record, {
    receipt,
    proof,
    transition,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
  });
  const missingTransitionBundle = buildDispatchBundle(missingTransitionLedger, 'post_action_dispatch_completion_missing_transition_probe');
  const missingDispatchRequiredHashReceipt = buildDispatchReceipt(strippedDispatchRequiredHashRecord(record, 'manifestHash'));
  const ledgerMessagePreviewHash = ledger.chain?.messagePreviewHash || ledger.payload?.messagePreviewHash || null;
  const ledgerHumanFeedbackRevisionContractHash = ledger.chain?.humanFeedbackRevisionContractHash
    || ledger.payload?.humanFeedbackRevisionContractHash
    || null;
  const ledgerPromptGenerationBinding = ledger.chain?.promptGenerationBinding
    || ledger.payload?.promptGenerationBinding
    || null;
  const humanFeedbackContractRoute = humanFeedbackContractRecord(record, ledger);
  const currentPromptGenerationSpendRoute = promptGenerationSpendRoute(record, ledger);
  const replayGuardDecision = aggregateArchive
    ? buildExternalActionReplayGuardDecision({
      archive: aggregateArchive,
      candidate: replayCandidateForRecord(record, auditBundle),
      actor: 'post-action-dispatch-completion-matrix.replay-guard',
      evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
      createdAt: FIXED_CREATED_AT,
    })
    : null;
  const strippedPayloadMessageHashReplayGuardDecision = aggregateArchive && customerMessageAction(record.action)
    ? buildExternalActionReplayGuardDecision({
      archive: aggregateArchive,
      candidate: replayCandidateForRecord(strippedDispatchPayloadHashRecord(record, 'messagePreviewHash'), auditBundle),
      actor: 'post-action-dispatch-completion-matrix.stripped-payload-message-hash-replay-guard',
      evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
      createdAt: FIXED_CREATED_AT,
    })
    : null;
  const strippedPayloadContractHashReplayGuardDecision = aggregateArchive && humanFeedbackContractRoute
    ? buildExternalActionReplayGuardDecision({
      archive: aggregateArchive,
      candidate: replayCandidateForRecord(strippedDispatchPayloadHashRecord(record, 'humanFeedbackRevisionContractHash'), auditBundle),
      actor: 'post-action-dispatch-completion-matrix.stripped-payload-contract-hash-replay-guard',
      evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
      createdAt: FIXED_CREATED_AT,
    })
    : null;
  const strippedPayloadPromptBindingReplayGuardDecision = aggregateArchive && currentPromptGenerationSpendRoute
    ? buildExternalActionReplayGuardDecision({
      archive: aggregateArchive,
      candidate: replayCandidateForRecord(strippedDispatchPayloadHashRecord(record, 'promptGenerationBinding'), auditBundle),
      actor: 'post-action-dispatch-completion-matrix.stripped-payload-prompt-binding-replay-guard',
      evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
      createdAt: FIXED_CREATED_AT,
    })
    : null;
  const strippedBundleAliasReplayGuardDecision = aggregateArchive
    ? buildExternalActionReplayGuardDecision({
      archive: aggregateArchive,
      candidate: replayCandidateForRecord(record, strippedHashAlias(auditBundle, 'bundleHash')),
      actor: 'post-action-dispatch-completion-matrix.stripped-bundle-alias-replay-guard',
      evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-completion-matrix' }],
      createdAt: FIXED_CREATED_AT,
    })
    : null;
  const perRouteArchiveEntry = perRouteArchive.entries?.[0] || null;

  const blockers = [];
  if (receipt.status !== 'accepted_receipt') blockers.push(issue('dispatch_completion_receipt_not_accepted', record.scenarioId));
  if (dispatchReceiptInboxItem.status !== 'received_dispatch_receipt') blockers.push(issue('dispatch_completion_receipt_inbox_not_received', record.scenarioId));
  if (proof.status !== 'verified_state_proof') blockers.push(issue('dispatch_completion_proof_not_verified', record.scenarioId));
  if (dispatchProofInboxItem.status !== 'received_dispatch_channel_state_proof') blockers.push(issue('dispatch_completion_proof_inbox_not_received', record.scenarioId));
  if (transition.status !== 'receipt_transition_ready') blockers.push(issue('dispatch_completion_transition_not_ready', record.scenarioId));
  if (dispatchTransitionInboxItem.status !== 'received_dispatch_receipt_state_transition') blockers.push(issue('dispatch_completion_transition_inbox_not_received', record.scenarioId));
  if (ledger.status !== 'verified_action_ledger' || ledger.chain?.usesDispatchInboxChain !== true) blockers.push(issue('dispatch_completion_ledger_not_verified', record.scenarioId));
  if (auditBundle.status !== 'verified_action_audit_bundle' || auditBundle.hashBinding?.usesDispatchInboxChain !== true) blockers.push(issue('dispatch_completion_bundle_not_verified', record.scenarioId));
  if (perRouteArchive.status !== 'ready_external_action_audit_archive' || perRouteArchive.summary?.dispatchInboxChainCount !== 1) blockers.push(issue('dispatch_completion_archive_not_ready', record.scenarioId));
  if (tamperedReceiptInboxItem.status !== 'blocked_dispatch_receipt_inbox') blockers.push(issue('tampered_dispatch_receipt_not_blocked', record.scenarioId));
  if (!tamperedReceiptInboxItem.blockers.some((item) => item.code === 'receipt_dispatch_envelope_hash_mismatch')) blockers.push(issue('tampered_dispatch_receipt_blocker_missing', record.scenarioId));
  if (missingProofInboxItem.status !== 'blocked_dispatch_channel_state_proof_inbox') blockers.push(issue('missing_dispatch_proof_not_blocked', record.scenarioId));
  if (missingTransitionInboxItem.status !== 'blocked_dispatch_receipt_state_transition_inbox') blockers.push(issue('missing_dispatch_transition_not_blocked', record.scenarioId));
  if (rawBundle.status !== 'blocked_action_audit_bundle') blockers.push(issue('raw_dispatch_bundle_not_blocked', record.scenarioId));
  if (missingTransitionBundle.status !== 'blocked_action_audit_bundle') blockers.push(issue('missing_dispatch_transition_bundle_not_blocked', record.scenarioId));
  if (missingDispatchRequiredHashReceipt.status !== ADAPTER_RECEIPT_STATUS.BLOCKED) {
    blockers.push(issue('missing_dispatch_required_hash_receipt_not_blocked', record.scenarioId));
  }
  if (!missingDispatchRequiredHashReceipt.blockers.some((item) => item.code === 'manifest_hash_report_required')) {
    blockers.push(issue('missing_dispatch_required_hash_receipt_blocker_missing', record.scenarioId));
  }
  if (replayGuardDecision && replayGuardDecision.status !== 'blocked_replay_guard') blockers.push(issue('dispatch_completion_replay_not_blocked', record.scenarioId));
  if (
    strippedPayloadMessageHashReplayGuardDecision
    && strippedPayloadMessageHashReplayGuardDecision.candidate?.messagePreviewHash !== null
  ) {
    blockers.push(issue('stripped_payload_message_hash_candidate_used_required_hash_fallback', record.scenarioId));
  }
  if (strippedPayloadMessageHashReplayGuardDecision && strippedPayloadMessageHashReplayGuardDecision.status !== 'blocked_replay_guard') {
    blockers.push(issue('stripped_payload_message_hash_replay_not_blocked', record.scenarioId));
  }
  if (
    strippedPayloadContractHashReplayGuardDecision
    && strippedPayloadContractHashReplayGuardDecision.candidate?.humanFeedbackRevisionContractHash !== null
  ) {
    blockers.push(issue('stripped_payload_contract_hash_candidate_used_required_hash_fallback', record.scenarioId));
  }
  if (strippedPayloadContractHashReplayGuardDecision && strippedPayloadContractHashReplayGuardDecision.status !== 'blocked_replay_guard') {
    blockers.push(issue('stripped_payload_contract_hash_replay_not_blocked', record.scenarioId));
  }
  if (
    strippedPayloadPromptBindingReplayGuardDecision
    && strippedPayloadPromptBindingReplayGuardDecision.candidate?.promptGenerationBinding !== null
  ) {
    blockers.push(issue('stripped_payload_prompt_binding_candidate_used_required_hash_fallback', record.scenarioId));
  }
  if (strippedPayloadPromptBindingReplayGuardDecision && strippedPayloadPromptBindingReplayGuardDecision.status !== 'blocked_replay_guard') {
    blockers.push(issue('stripped_payload_prompt_binding_replay_not_blocked', record.scenarioId));
  }
  if (
    strippedPayloadPromptBindingReplayGuardDecision
    && !strippedPayloadPromptBindingReplayGuardDecision.blockers.some((item) => item.code === 'candidate_prompt_generation_binding_required')
  ) {
    blockers.push(issue('stripped_payload_prompt_binding_blocker_missing', record.scenarioId));
  }
  if (strippedBundleAliasReplayGuardDecision?.candidate?.bundleHash !== null) {
    blockers.push(issue('stripped_bundle_alias_candidate_used_generic_hash', record.scenarioId));
  }
  if (currentPromptGenerationSpendRoute && !promptGenerationBindingComplete(ledgerPromptGenerationBinding)) {
    blockers.push(issue('dispatch_completion_prompt_generation_binding_missing', record.scenarioId));
  }
  if (
    ledgerPromptGenerationBinding
    && !samePromptGenerationBinding(perRouteArchiveEntry?.promptGenerationBinding, ledgerPromptGenerationBinding)
  ) {
    blockers.push(issue('dispatch_completion_archive_prompt_generation_binding_mismatch', record.scenarioId));
  }
  if (humanFeedbackContractRoute && !ledgerHumanFeedbackRevisionContractHash) {
    blockers.push(issue('dispatch_completion_human_feedback_contract_hash_missing', record.scenarioId));
  }
  if (
    ledgerHumanFeedbackRevisionContractHash
    && perRouteArchiveEntry?.humanFeedbackRevisionContractHash !== ledgerHumanFeedbackRevisionContractHash
  ) {
    blockers.push(issue('dispatch_completion_archive_human_feedback_contract_hash_mismatch', record.scenarioId));
  }
  if (ledgerMessagePreviewHash && perRouteArchiveEntry?.messagePreviewHash !== ledgerMessagePreviewHash) {
    blockers.push(issue('dispatch_completion_archive_message_preview_hash_mismatch', record.scenarioId));
  }

  return {
    scenarioId: record.scenarioId,
    channelId: record.channelId,
    actionId: record.actionId,
    action: canonicalActionOrNull(record.action),
    productLineId: canonicalProductLineOrNull(ledger.payload?.productLineId),
    workflowId: canonicalProductLineOrNull(ledger.payload?.workflowId),
    packageRole: canonicalPackageRole(ledger.payload?.packageRole || record.dispatchEnvelope?.payload?.packageRole || '') || null,
    messagePreviewHash: ledgerMessagePreviewHash,
    humanFeedbackRevisionContractHash: ledgerHumanFeedbackRevisionContractHash,
    promptGenerationBinding: ledgerPromptGenerationBinding,
    promptGenerationSpendRoute: currentPromptGenerationSpendRoute,
    dispatchEnvelopeHash: hashOf(record.dispatchEnvelope, 'dispatchEnvelopeHash'),
    receiptHash: hashOf(receipt, 'receiptHash'),
    dispatchReceiptInboxHash: hashOf(dispatchReceiptInboxItem, 'inboxHash'),
    proofHash: hashOf(proof, 'proofHash'),
    dispatchProofInboxHash: hashOf(dispatchProofInboxItem, 'proofInboxHash'),
    transitionHash: dispatchTransitionInboxItem.hashBinding?.transitionHash || null,
    dispatchTransitionInboxHash: hashOf(dispatchTransitionInboxItem, 'transitionInboxHash'),
    ledgerHash: hashOf(ledger, 'ledgerHash'),
    bundleHash: hashOf(auditBundle, 'bundleHash'),
    perRouteArchiveHash: hashOf(perRouteArchive, 'archiveHash'),
    receiptStatus: receipt.status,
    dispatchReceiptInboxStatus: dispatchReceiptInboxItem.status,
    proofStatus: proof.status,
    dispatchProofInboxStatus: dispatchProofInboxItem.status,
    transitionStatus: transition.status,
    dispatchTransitionInboxStatus: dispatchTransitionInboxItem.status,
    ledgerStatus: ledger.status,
    auditBundleStatus: auditBundle.status,
    perRouteArchiveStatus: perRouteArchive.status,
    usesDispatchInboxChain: ledger.chain?.usesDispatchInboxChain === true && auditBundle.hashBinding?.usesDispatchInboxChain === true,
    dispatchChainHashesPresent: Boolean(
      dispatchReceiptInboxItem.hashBinding?.dispatchEnvelopeHash
        && dispatchProofInboxItem.hashBinding?.dispatchReceiptInboxHash
        && dispatchTransitionInboxItem.hashBinding?.dispatchProofInboxHash
        && ledger.chain?.dispatchReceiptInboxHash
        && auditBundle.hashBinding?.dispatchEnvelopeHash
    ),
    tamperedReceiptInboxStatus: tamperedReceiptInboxItem.status,
    tamperedReceiptInboxBlockers: blockerCodes(tamperedReceiptInboxItem),
    missingProofInboxStatus: missingProofInboxItem.status,
    missingProofInboxBlockers: blockerCodes(missingProofInboxItem),
    missingTransitionInboxStatus: missingTransitionInboxItem.status,
    missingTransitionInboxBlockers: blockerCodes(missingTransitionInboxItem),
    rawBundleStatus: rawBundle.status,
    rawBundleBlockers: blockerCodes(rawBundle),
    missingTransitionBundleStatus: missingTransitionBundle.status,
    missingTransitionBundleBlockers: blockerCodes(missingTransitionBundle),
    missingDispatchRequiredHashReceiptStatus: missingDispatchRequiredHashReceipt.status,
    missingDispatchRequiredHashReceiptBlockers: blockerCodes(missingDispatchRequiredHashReceipt),
    replayGuardStatus: replayGuardDecision?.status || null,
    replayGuardBlockers: blockerCodes(replayGuardDecision),
    strippedPayloadMessageHashReplayCandidateMessagePreviewHash: strippedPayloadMessageHashReplayGuardDecision?.candidate?.messagePreviewHash || null,
    strippedPayloadMessageHashReplayStatus: strippedPayloadMessageHashReplayGuardDecision?.status || null,
    strippedPayloadMessageHashReplayBlockers: blockerCodes(strippedPayloadMessageHashReplayGuardDecision),
    strippedPayloadContractHashReplayCandidateContractHash: strippedPayloadContractHashReplayGuardDecision?.candidate?.humanFeedbackRevisionContractHash || null,
    strippedPayloadContractHashReplayStatus: strippedPayloadContractHashReplayGuardDecision?.status || null,
    strippedPayloadContractHashReplayBlockers: blockerCodes(strippedPayloadContractHashReplayGuardDecision),
    strippedPayloadPromptBindingReplayCandidatePromptGenerationBinding: strippedPayloadPromptBindingReplayGuardDecision?.candidate?.promptGenerationBinding || null,
    strippedPayloadPromptBindingReplayStatus: strippedPayloadPromptBindingReplayGuardDecision?.status || null,
    strippedPayloadPromptBindingReplayBlockers: blockerCodes(strippedPayloadPromptBindingReplayGuardDecision),
    strippedBundleAliasReplayCandidateBundleHash: strippedBundleAliasReplayGuardDecision?.candidate?.bundleHash || null,
    strippedBundleAliasReplayStatus: strippedBundleAliasReplayGuardDecision?.status || null,
    receipt,
    proof,
    transition,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
    ledger,
    auditBundle,
    perRouteArchive,
    rawBundle,
    missingTransitionBundle,
    missingDispatchRequiredHashReceipt,
    replayGuardDecision,
    strippedPayloadMessageHashReplayGuardDecision,
    strippedPayloadContractHashReplayGuardDecision,
    strippedPayloadPromptBindingReplayGuardDecision,
    strippedBundleAliasReplayGuardDecision,
    blockers,
  };
}

function reportRows(rows) {
  return rows.map((row) => ({
    scenarioId: row.scenarioId,
    channelId: row.channelId,
    actionId: row.actionId,
    action: row.action,
    productLineId: row.productLineId,
    workflowId: row.workflowId,
    packageRole: row.packageRole,
    messagePreviewHash: row.messagePreviewHash,
    humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
    promptGenerationBinding: row.promptGenerationBinding,
    promptGenerationSpendRoute: row.promptGenerationSpendRoute,
    receiptStatus: row.receiptStatus,
    dispatchReceiptInboxStatus: row.dispatchReceiptInboxStatus,
    proofStatus: row.proofStatus,
    dispatchProofInboxStatus: row.dispatchProofInboxStatus,
    transitionStatus: row.transitionStatus,
    dispatchTransitionInboxStatus: row.dispatchTransitionInboxStatus,
    ledgerStatus: row.ledgerStatus,
    auditBundleStatus: row.auditBundleStatus,
    perRouteArchiveStatus: row.perRouteArchiveStatus,
    usesDispatchInboxChain: row.usesDispatchInboxChain,
    dispatchChainHashesPresent: row.dispatchChainHashesPresent,
    tamperedReceiptInboxStatus: row.tamperedReceiptInboxStatus,
    tamperedReceiptInboxBlockers: row.tamperedReceiptInboxBlockers,
    missingProofInboxStatus: row.missingProofInboxStatus,
    missingProofInboxBlockers: row.missingProofInboxBlockers,
    missingTransitionInboxStatus: row.missingTransitionInboxStatus,
    missingTransitionInboxBlockers: row.missingTransitionInboxBlockers,
    rawBundleStatus: row.rawBundleStatus,
    rawBundleBlockers: row.rawBundleBlockers,
    missingTransitionBundleStatus: row.missingTransitionBundleStatus,
    missingTransitionBundleBlockers: row.missingTransitionBundleBlockers,
    missingDispatchRequiredHashReceiptStatus: row.missingDispatchRequiredHashReceiptStatus,
    missingDispatchRequiredHashReceiptBlockers: row.missingDispatchRequiredHashReceiptBlockers,
    replayGuardStatus: row.replayGuardStatus,
    replayGuardBlockers: row.replayGuardBlockers,
    strippedPayloadMessageHashReplayCandidateMessagePreviewHash: row.strippedPayloadMessageHashReplayCandidateMessagePreviewHash,
    strippedPayloadMessageHashReplayStatus: row.strippedPayloadMessageHashReplayStatus,
    strippedPayloadMessageHashReplayBlockers: row.strippedPayloadMessageHashReplayBlockers,
    strippedPayloadContractHashReplayCandidateContractHash: row.strippedPayloadContractHashReplayCandidateContractHash,
    strippedPayloadContractHashReplayStatus: row.strippedPayloadContractHashReplayStatus,
    strippedPayloadContractHashReplayBlockers: row.strippedPayloadContractHashReplayBlockers,
    strippedPayloadPromptBindingReplayCandidatePromptGenerationBinding: row.strippedPayloadPromptBindingReplayCandidatePromptGenerationBinding,
    strippedPayloadPromptBindingReplayStatus: row.strippedPayloadPromptBindingReplayStatus,
    strippedPayloadPromptBindingReplayBlockers: row.strippedPayloadPromptBindingReplayBlockers,
    strippedBundleAliasReplayCandidateBundleHash: row.strippedBundleAliasReplayCandidateBundleHash,
    strippedBundleAliasReplayStatus: row.strippedBundleAliasReplayStatus,
    blockerCodes: row.blockers.map((item) => item.code),
  }));
}

export function buildPostActionDispatchCompletionMatrixRecords() {
  const dispatchEnvelopeMatrix = buildPostActionDispatchEnvelopeMatrixRecords();
  const firstPassRows = dispatchEnvelopeMatrix.records.map((record) => rowForRecord(record));
  const aggregateArchive = archiveForBundles(firstPassRows.map((row) => row.auditBundle));
  const rows = dispatchEnvelopeMatrix.records.map((record) => rowForRecord(record, aggregateArchive));
  return {
    ...dispatchEnvelopeMatrix,
    aggregateArchive,
    rows,
  };
}

export function buildPostActionDispatchCompletionMatrixReport({ generatedAt = new Date().toISOString() } = {}) {
  const postActionDispatchEnvelopeMatrix = buildPostActionDispatchEnvelopeMatrixReport({ generatedAt: FIXED_CREATED_AT });
  const {
    runtimeReport,
    postActionEvidenceMatrix,
    postActionReplayGuardMatrix,
    archive: preDispatchArchive,
    aggregateArchive,
    rows,
  } = buildPostActionDispatchCompletionMatrixRecords();

  const actionClasses = uniqueStrings(rows.map((row) => row.action), 32);
  const summary = {
    routeCount: rows.length,
    actionClassCount: actionClasses.length,
    actionClasses,
    postActionDispatchEnvelopeMatrixHash: postActionDispatchEnvelopeMatrix.postActionDispatchEnvelopeMatrixHash,
    postActionDispatchEnvelopeMatrixOk: postActionDispatchEnvelopeMatrix.ok === true,
    preDispatchArchiveHash: hashOf(preDispatchArchive, 'archiveHash'),
    aggregateArchiveHash: hashOf(aggregateArchive, 'archiveHash'),
    aggregateArchiveEntries: aggregateArchive.summary?.count || 0,
    aggregateDispatchInboxChainEntries: aggregateArchive.summary?.dispatchInboxChainCount || 0,
    aggregatePromptGenerationBindingBoundEntries: aggregateArchive.summary?.promptGenerationBindingBoundCount || 0,
    acceptedReceiptCount: rows.filter((row) => row.receiptStatus === 'accepted_receipt').length,
    dispatchReceiptInboxReceivedCount: rows.filter((row) => row.dispatchReceiptInboxStatus === 'received_dispatch_receipt').length,
    verifiedProofCount: rows.filter((row) => row.proofStatus === 'verified_state_proof').length,
    dispatchProofInboxReceivedCount: rows.filter((row) => row.dispatchProofInboxStatus === 'received_dispatch_channel_state_proof').length,
    readyTransitionCount: rows.filter((row) => row.transitionStatus === 'receipt_transition_ready').length,
    dispatchTransitionInboxReceivedCount: rows.filter((row) => row.dispatchTransitionInboxStatus === 'received_dispatch_receipt_state_transition').length,
    verifiedLedgerCount: rows.filter((row) => row.ledgerStatus === 'verified_action_ledger').length,
    verifiedAuditBundleCount: rows.filter((row) => row.auditBundleStatus === 'verified_action_audit_bundle').length,
    perRouteArchiveReadyCount: rows.filter((row) => row.perRouteArchiveStatus === 'ready_external_action_audit_archive').length,
    usesDispatchInboxChainCount: rows.filter((row) => row.usesDispatchInboxChain).length,
    dispatchChainHashBindingCount: rows.filter((row) => row.dispatchChainHashesPresent).length,
    tamperedReceiptInboxBlockedCount: rows.filter((row) => row.tamperedReceiptInboxStatus === 'blocked_dispatch_receipt_inbox').length,
    missingProofInboxBlockedCount: rows.filter((row) => row.missingProofInboxStatus === 'blocked_dispatch_channel_state_proof_inbox').length,
    missingTransitionInboxBlockedCount: rows.filter((row) => row.missingTransitionInboxStatus === 'blocked_dispatch_receipt_state_transition_inbox').length,
    rawBundleBlockedCount: rows.filter((row) => row.rawBundleStatus === 'blocked_action_audit_bundle').length,
    missingTransitionBundleBlockedCount: rows.filter((row) => row.missingTransitionBundleStatus === 'blocked_action_audit_bundle').length,
    missingDispatchRequiredHashReceiptBlockedCount: rows.filter((row) => row.missingDispatchRequiredHashReceiptStatus === ADAPTER_RECEIPT_STATUS.BLOCKED).length,
    archivedDispatchReplayBlockedCount: rows.filter((row) => row.replayGuardStatus === 'blocked_replay_guard').length,
    strippedPayloadMessageHashReplayCandidateNullCount: rows.filter((row) => (
      customerMessageAction(row.action) && row.strippedPayloadMessageHashReplayCandidateMessagePreviewHash === null
    )).length,
    strippedPayloadMessageHashReplayBlockedCount: rows.filter((row) => row.strippedPayloadMessageHashReplayStatus === 'blocked_replay_guard').length,
    strippedPayloadContractHashReplayCandidateNullCount: rows.filter((row) => (
      isPostActionDispatchCompletionHumanFeedbackContractRoute(row) && row.strippedPayloadContractHashReplayCandidateContractHash === null
    )).length,
    strippedPayloadContractHashReplayBlockedCount: rows.filter((row) => row.strippedPayloadContractHashReplayStatus === 'blocked_replay_guard').length,
    strippedPayloadPromptBindingReplayCandidateNullCount: rows.filter((row) => (
      row.promptGenerationSpendRoute && row.strippedPayloadPromptBindingReplayCandidatePromptGenerationBinding === null
    )).length,
    strippedPayloadPromptBindingReplayBlockedCount: rows.filter((row) => row.strippedPayloadPromptBindingReplayStatus === 'blocked_replay_guard').length,
    strippedBundleAliasCandidateNullCount: rows.filter((row) => row.strippedBundleAliasReplayCandidateBundleHash === null).length,
    packageRoleRouteCount: rows.filter((row) => row.packageRole).length,
    customerMessageRouteCount: rows.filter((row) => customerMessageAction(row.action)).length,
    customerMessageHashBoundRouteCount: rows.filter((row) => customerMessageAction(row.action) && row.messagePreviewHash).length,
    humanFeedbackCustomerMessageRouteCount: rows.filter(isPostActionDispatchCompletionHumanFeedbackRoute).length,
    humanFeedbackContractBoundRouteCount: rows.filter((row) => row.humanFeedbackRevisionContractHash).length,
    humanFeedbackPackageRoleBoundRouteCount: rows.filter((row) => (
      isPostActionDispatchCompletionHumanFeedbackContractRoute(row) && row.packageRole
    )).length,
    promptGenerationSpendRouteCount: rows.filter((row) => row.promptGenerationSpendRoute).length,
    promptGenerationBindingBoundRouteCount: rows.filter((row) => (
      row.promptGenerationSpendRoute && promptGenerationBindingComplete(row.promptGenerationBinding)
    )).length,
    routeBlockerCount: rows.reduce((sum, row) => sum + row.blockers.length, 0),
  };

  const blockers = [
    ...(runtimeReport.ok === true ? [] : [issue('runtime_dry_run_harness_not_ready')]),
    ...(postActionEvidenceMatrix.ok === true ? [] : [issue('post_action_evidence_matrix_not_ready')]),
    ...(postActionReplayGuardMatrix.ok === true ? [] : [issue('post_action_replay_guard_matrix_not_ready')]),
    ...(postActionDispatchEnvelopeMatrix.ok === true ? [] : [issue('post_action_dispatch_envelope_matrix_not_ready')]),
    ...(postActionDispatchEnvelopeMatrix.postActionDispatchEnvelopeMatrixHash ? [] : [issue('post_action_dispatch_envelope_matrix_hash_missing')]),
    ...(preDispatchArchive.status === 'ready_external_action_audit_archive' ? [] : [issue('pre_dispatch_archive_not_ready')]),
    ...(aggregateArchive.status === 'ready_external_action_audit_archive' ? [] : [issue('dispatch_completion_archive_not_ready')]),
    ...rows.flatMap((row) => row.blockers),
  ];
  if (summary.routeCount !== 20) blockers.push(issue('post_action_dispatch_completion_matrix_route_count_unexpected', `${summary.routeCount}/20`));
  if (summary.actionClassCount !== 7) blockers.push(issue('post_action_dispatch_completion_matrix_action_class_count_unexpected', `${summary.actionClassCount}/7`));
  if (summary.packageRoleRouteCount !== rows.length) blockers.push(issue('post_action_dispatch_completion_package_role_not_bound', `${summary.packageRoleRouteCount}/${rows.length}`));
  const customerMessageRows = rows.filter((row) => customerMessageAction(row.action));
  const humanFeedbackRows = rows.filter(isPostActionDispatchCompletionHumanFeedbackContractRoute);
  const promptGenerationSpendRows = rows.filter((row) => row.promptGenerationSpendRoute);
  if (summary.customerMessageHashBoundRouteCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_dispatch_completion_customer_message_preview_hash_not_bound',
    `${summary.customerMessageHashBoundRouteCount}/${customerMessageRows.length}`,
  ));
  if (summary.humanFeedbackContractBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_dispatch_completion_human_feedback_contract_hash_not_bound',
    `${summary.humanFeedbackContractBoundRouteCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.humanFeedbackPackageRoleBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_dispatch_completion_human_feedback_package_role_not_bound',
    `${summary.humanFeedbackPackageRoleBoundRouteCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.promptGenerationBindingBoundRouteCount !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_dispatch_completion_prompt_generation_binding_not_bound',
    `${summary.promptGenerationBindingBoundRouteCount}/${promptGenerationSpendRows.length}`,
  ));
  if (summary.aggregatePromptGenerationBindingBoundEntries !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_dispatch_completion_archive_prompt_generation_binding_not_bound',
    `${summary.aggregatePromptGenerationBindingBoundEntries}/${promptGenerationSpendRows.length}`,
  ));
  if (summary.strippedBundleAliasCandidateNullCount !== rows.length) blockers.push(issue(
    'post_action_dispatch_completion_stripped_bundle_alias_candidate_fallback',
    `${summary.strippedBundleAliasCandidateNullCount}/${rows.length}`,
  ));
  if (summary.strippedPayloadMessageHashReplayCandidateNullCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_dispatch_completion_stripped_payload_message_hash_candidate_fallback',
    `${summary.strippedPayloadMessageHashReplayCandidateNullCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadMessageHashReplayBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_dispatch_completion_stripped_payload_message_hash_replay_not_blocked',
    `${summary.strippedPayloadMessageHashReplayBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadContractHashReplayCandidateNullCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_dispatch_completion_stripped_payload_contract_hash_candidate_fallback',
    `${summary.strippedPayloadContractHashReplayCandidateNullCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadContractHashReplayBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_dispatch_completion_stripped_payload_contract_hash_replay_not_blocked',
    `${summary.strippedPayloadContractHashReplayBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingReplayCandidateNullCount !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_dispatch_completion_stripped_payload_prompt_binding_candidate_fallback',
    `${summary.strippedPayloadPromptBindingReplayCandidateNullCount}/${promptGenerationSpendRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingReplayBlockedCount !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_dispatch_completion_stripped_payload_prompt_binding_replay_not_blocked',
    `${summary.strippedPayloadPromptBindingReplayBlockedCount}/${promptGenerationSpendRows.length}`,
  ));
  if (summary.missingDispatchRequiredHashReceiptBlockedCount !== rows.length) blockers.push(issue(
    'post_action_dispatch_completion_missing_dispatch_required_hash_receipt_not_blocked',
    `${summary.missingDispatchRequiredHashReceiptBlockedCount}/${rows.length}`,
  ));

  const status = blockers.length
    ? POST_ACTION_DISPATCH_COMPLETION_MATRIX_STATUS.FAIL
    : POST_ACTION_DISPATCH_COMPLETION_MATRIX_STATUS.PASS;
  const postActionDispatchCompletionMatrixHash = digest({
    version: POST_ACTION_DISPATCH_COMPLETION_MATRIX_VERSION,
    status,
    summary,
    rows: reportRows(rows),
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionReplayGuardMatrixHash: postActionReplayGuardMatrix.postActionReplayGuardMatrixHash,
    postActionDispatchEnvelopeMatrixHash: postActionDispatchEnvelopeMatrix.postActionDispatchEnvelopeMatrixHash,
    preDispatchArchiveHash: hashOf(preDispatchArchive, 'archiveHash'),
    aggregateArchiveHash: hashOf(aggregateArchive, 'archiveHash'),
    blockers,
  });

  return {
    version: POST_ACTION_DISPATCH_COMPLETION_MATRIX_VERSION,
    kind: 'PostActionDispatchCompletionMatrixReport',
    status,
    ok: blockers.length === 0,
    generatedAt,
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionReplayGuardMatrixHash: postActionReplayGuardMatrix.postActionReplayGuardMatrixHash,
    postActionDispatchEnvelopeMatrixHash: postActionDispatchEnvelopeMatrix.postActionDispatchEnvelopeMatrixHash,
    preDispatchArchiveHash: hashOf(preDispatchArchive, 'archiveHash'),
    aggregateArchiveHash: hashOf(aggregateArchive, 'archiveHash'),
    postActionDispatchCompletionMatrixHash,
    summary,
    rows: reportRows(rows),
    blockers,
    safety: {
      syntheticFixturesOnly: true,
      dispatchCompletionEvidenceOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      callsProvider: false,
      callsModel: false,
      appliesLocalStateTransition: false,
      dispatchesRunner: false,
      consumesQueue: false,
      acknowledgesDispatchCompletion: false,
      grantsExecutionPermission: false,
    },
    hash: postActionDispatchCompletionMatrixHash,
  };
}
