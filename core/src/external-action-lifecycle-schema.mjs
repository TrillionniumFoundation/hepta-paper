import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalProductLineId,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { ACTION_MANIFEST_STATUS } from './action-manifest.mjs';
import { ADAPTER_RUNNER_STATUS } from './adapter-runner.mjs';
import { ADAPTER_HANDOFF_OUTBOX_STATUS } from './adapter-handoff-outbox.mjs';
import { EXTERNAL_ACTION_REPLAY_GUARD_STATUS } from './external-action-replay-guard.mjs';
import { ADAPTER_DISPATCH_ENVELOPE_STATUS } from './adapter-dispatch-envelope.mjs';
import { ADAPTER_DISPATCH_ASSIGNMENT_STATUS } from './adapter-dispatch-assignment.mjs';
import { ADAPTER_RUNNER_SDK_STATUS } from './adapter-runner-sdk.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS } from './adapter-receipt.mjs';
import {
  ADAPTER_RECEIPT_INBOX_STATUS,
  ADAPTER_RECEIPT_NEXT_STEP,
} from './adapter-receipt-inbox.mjs';
import {
  CHANNEL_STATE_PROOF_STATUS,
  RECEIPT_TRANSITION_STATUS,
} from './channel-state-proof.mjs';
import {
  CHANNEL_STATE_PROOF_INBOX_STATUS,
  CHANNEL_STATE_PROOF_NEXT_STEP,
} from './channel-state-proof-inbox.mjs';
import {
  RECEIPT_STATE_TRANSITION_INBOX_STATUS,
  RECEIPT_STATE_TRANSITION_NEXT_STEP,
} from './receipt-state-transition-inbox.mjs';
import {
  ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS,
  ADAPTER_DISPATCH_RECEIPT_NEXT_STEP,
} from './adapter-dispatch-receipt-inbox.mjs';
import {
  ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS,
  ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP,
} from './adapter-dispatch-channel-state-proof-inbox.mjs';
import {
  ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS,
  ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP,
} from './adapter-dispatch-receipt-state-transition-inbox.mjs';
import { EXTERNAL_ACTION_LEDGER_STATUS } from './external-action-ledger.mjs';
import { EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS } from './external-action-audit-bundle.mjs';
import { EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS } from './external-action-audit-archive.mjs';
import { DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS } from './dispatch-replay-cycle-invariant.mjs';
import { digest } from './hash-utils.mjs';

export const EXTERNAL_ACTION_LIFECYCLE_SCHEMA_VERSION = 1;

export const EXTERNAL_ACTION_LIFECYCLE_STATUS = Object.freeze({
  READY: 'ready_external_action_lifecycle_schema',
  BLOCKED: 'blocked_external_action_lifecycle_schema',
});

export const EXTERNAL_ACTION_LIFECYCLE_CHAIN_STATUS = Object.freeze({
  PASS: 'pass_external_action_lifecycle_chain',
  BLOCKED: 'blocked_external_action_lifecycle_chain',
});

export const EXTERNAL_ACTION_LIFECYCLE_PHASES = Object.freeze({
  PLAN_REFERENCE_BINDING: 'plan_reference_binding',
  APPROVAL_EVIDENCE_GATE: 'approval_evidence_gate',
  CHANNEL_ACTION_MANIFEST: 'channel_action_manifest',
  ADAPTER_RUN_PREVIEW: 'adapter_run_preview',
  ADAPTER_HANDOFF_OUTBOX: 'adapter_handoff_outbox',
  REPLAY_GUARD: 'external_action_replay_guard',
  DISPATCH_ENVELOPE: 'adapter_dispatch_envelope',
  DISPATCH_ASSIGNMENT: 'adapter_dispatch_assignment',
  ADAPTER_RUNNER_SDK: 'adapter_runner_sdk_contract',
  ADAPTER_RUN_RECEIPT: 'adapter_run_receipt',
  ADAPTER_RECEIPT_INBOX: 'adapter_receipt_inbox',
  DISPATCH_RECEIPT_INBOX: 'adapter_dispatch_receipt_inbox',
  CHANNEL_STATE_PROOF: 'channel_state_proof',
  CHANNEL_STATE_PROOF_INBOX: 'channel_state_proof_inbox',
  DISPATCH_CHANNEL_STATE_PROOF_INBOX: 'adapter_dispatch_channel_state_proof_inbox',
  RECEIPT_STATE_TRANSITION: 'receipt_state_transition',
  RECEIPT_STATE_TRANSITION_INBOX: 'receipt_state_transition_inbox',
  DISPATCH_RECEIPT_STATE_TRANSITION_INBOX: 'adapter_dispatch_receipt_state_transition_inbox',
  EXTERNAL_ACTION_LEDGER: 'external_action_ledger',
  EXTERNAL_ACTION_AUDIT_BUNDLE: 'external_action_audit_bundle',
  EXTERNAL_ACTION_AUDIT_ARCHIVE: 'external_action_audit_archive',
  DISPATCH_REPLAY_CYCLE_INVARIANT: 'dispatch_replay_cycle_invariant',
});

function values(record = {}) {
  return Object.values(record || {}).filter(Boolean);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function node({
  phaseId,
  order,
  label,
  moduleId,
  kind = null,
  owner = 'design-production-core',
  statusSet = [],
  readyStatuses = [],
  blockedStatuses = [],
  nextSteps = [],
  requiredBefore = [],
  produces = [],
  consumes = [],
  aliases = [],
}) {
  return {
    phaseId,
    order,
    label,
    moduleId,
    kind,
    owner,
    statusSet: uniqueStrings(statusSet, 32),
    readyStatuses: uniqueStrings(readyStatuses, 16),
    blockedStatuses: uniqueStrings(blockedStatuses, 16),
    nextSteps: uniqueStrings(nextSteps, 16),
    requiredBefore: uniqueStrings(requiredBefore, 32),
    produces: uniqueStrings(produces, 32),
    consumes: uniqueStrings(consumes, 32),
    aliases: uniqueStrings([phaseId, moduleId, kind, ...aliases], 32),
  };
}

const LIFECYCLE_NODES = deepFreeze([
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.PLAN_REFERENCE_BINDING,
    order: 10,
    label: 'Plan/reference binding',
    moduleId: 'plan-only + product-router + design-reference + buyer-asset-package',
    owner: 'design-production-core',
    statusSet: ['ready_plan_reference_binding', 'blocked_plan_reference_binding'],
    readyStatuses: ['ready_plan_reference_binding'],
    blockedStatuses: ['blocked_plan_reference_binding'],
    produces: ['taskKey', 'externalId', 'productLineId', 'workflowId', 'designReferenceSpecHash', 'buyerAssetPackageHash'],
    aliases: ['buildPlanOnlyDraft', 'routeProductLine', 'designReferenceSpec', 'buyerAssetPackage'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.APPROVAL_EVIDENCE_GATE,
    order: 20,
    label: 'Approval/evidence gate',
    moduleId: 'execution-gates + approval-packets',
    owner: 'design-production-core',
    statusSet: ['allow', 'blocked', 'approved_execution_packet', 'blocked_execution_packet'],
    readyStatuses: ['allow', 'approved_execution_packet'],
    blockedStatuses: ['blocked', 'blocked_execution_packet'],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST],
    produces: ['approvalHash', 'evidenceHash', 'policyProfileHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['ExecutionGateDecision', 'ApprovalPacket', 'evaluateExecutionGate', 'buildApprovalPacket'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST,
    order: 30,
    label: 'Channel action manifest',
    moduleId: 'action-manifest',
    kind: 'ChannelActionManifest',
    statusSet: values(ACTION_MANIFEST_STATUS),
    readyStatuses: [ACTION_MANIFEST_STATUS.READY],
    blockedStatuses: [ACTION_MANIFEST_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_PREVIEW],
    consumes: ['approvalHash', 'evidenceHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['manifestHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildChannelActionManifest', 'manifestHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_PREVIEW,
    order: 40,
    label: 'Adapter dry-run preview',
    moduleId: 'adapter-runner',
    kind: 'AdapterRunPreview',
    statusSet: values(ADAPTER_RUNNER_STATUS),
    readyStatuses: [ADAPTER_RUNNER_STATUS.DRY_RUN_READY],
    blockedStatuses: [ADAPTER_RUNNER_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT],
    consumes: ['manifestHash', 'approvalHash', 'evidenceHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['previewHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildAdapterRunPreview', 'AdapterRunPreview', 'previewHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_HANDOFF_OUTBOX,
    order: 50,
    label: 'Adapter handoff outbox',
    moduleId: 'adapter-handoff-outbox',
    kind: 'AdapterHandoffOutboxItem',
    statusSet: values(ADAPTER_HANDOFF_OUTBOX_STATUS),
    readyStatuses: [ADAPTER_HANDOFF_OUTBOX_STATUS.QUEUED],
    blockedStatuses: [ADAPTER_HANDOFF_OUTBOX_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT],
    consumes: ['manifestHash', 'previewHash', 'approvalHash', 'evidenceHash', 'ledgerHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['outboxHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildAdapterHandoffOutboxItem', 'outboxHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.REPLAY_GUARD,
    order: 60,
    label: 'Replay guard',
    moduleId: 'external-action-replay-guard',
    kind: 'ExternalActionReplayGuardDecision',
    statusSet: values(EXTERNAL_ACTION_REPLAY_GUARD_STATUS),
    readyStatuses: [EXTERNAL_ACTION_REPLAY_GUARD_STATUS.CLEAR],
    blockedStatuses: [EXTERNAL_ACTION_REPLAY_GUARD_STATUS.BLOCKED, EXTERNAL_ACTION_REPLAY_GUARD_STATUS.DUPLICATE],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ENVELOPE],
    consumes: ['archiveHash'],
    produces: ['replayGuardHash'],
    aliases: ['buildExternalActionReplayGuardDecision', 'ReplayGuard', 'replayGuardHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ENVELOPE,
    order: 70,
    label: 'Dispatch envelope',
    moduleId: 'adapter-dispatch-envelope',
    kind: 'AdapterDispatchEnvelope',
    statusSet: values(ADAPTER_DISPATCH_ENVELOPE_STATUS),
    readyStatuses: [ADAPTER_DISPATCH_ENVELOPE_STATUS.READY],
    blockedStatuses: [ADAPTER_DISPATCH_ENVELOPE_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ASSIGNMENT, EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_INBOX],
    consumes: ['outboxHash', 'replayGuardHash', 'manifestHash', 'previewHash', 'approvalHash', 'evidenceHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['dispatchEnvelopeHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildAdapterDispatchEnvelope', 'dispatchEnvelopeHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ASSIGNMENT,
    order: 80,
    label: 'Dispatch assignment',
    moduleId: 'adapter-dispatch-assignment',
    kind: 'AdapterDispatchAssignment',
    statusSet: values(ADAPTER_DISPATCH_ASSIGNMENT_STATUS),
    readyStatuses: [ADAPTER_DISPATCH_ASSIGNMENT_STATUS.READY],
    blockedStatuses: [ADAPTER_DISPATCH_ASSIGNMENT_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUNNER_SDK],
    consumes: ['dispatchEnvelopeHash', 'runnerCapabilityHash', 'runnerSelectionHash'],
    produces: ['assignmentHash'],
    aliases: ['buildAdapterDispatchAssignment', 'assignmentHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUNNER_SDK,
    order: 90,
    label: 'Adapter runner SDK contract',
    moduleId: 'adapter-runner-sdk',
    kind: 'AdapterRunnerSdkContract',
    statusSet: values(ADAPTER_RUNNER_SDK_STATUS),
    readyStatuses: [ADAPTER_RUNNER_SDK_STATUS.READY],
    blockedStatuses: [ADAPTER_RUNNER_SDK_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT],
    consumes: ['dispatchReadinessHash', 'assignmentHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['adapterRunnerSdkHash', 'platformStateSnapshotHash', 'dryRunReplayHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash', 'requiredEvidenceKindsByPhase'],
    aliases: ['buildAdapterRunnerSdkContract', 'adapterRunnerSdkHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT,
    order: 100,
    label: 'Adapter run receipt',
    moduleId: 'adapter-receipt',
    kind: 'AdapterRunReceipt',
    statusSet: values(ADAPTER_RECEIPT_STATUS),
    readyStatuses: [ADAPTER_RECEIPT_STATUS.ACCEPTED],
    blockedStatuses: [ADAPTER_RECEIPT_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF],
    consumes: ['manifestHash', 'previewHash', 'approvalHash', 'evidenceHash', 'platformStateSnapshotHash', 'dryRunReplayHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['receiptHash', 'resultStatus', 'messagePreviewHash', 'humanFeedbackRevisionContractHash', ...values(ADAPTER_RESULT_STATUS)],
    aliases: ['buildAdapterRunReceipt', 'AdapterRunReceipt', 'receiptHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RECEIPT_INBOX,
    order: 110,
    label: 'Adapter receipt inbox',
    moduleId: 'adapter-receipt-inbox',
    kind: 'AdapterReceiptInboxItem',
    statusSet: values(ADAPTER_RECEIPT_INBOX_STATUS),
    readyStatuses: [ADAPTER_RECEIPT_INBOX_STATUS.RECEIVED],
    blockedStatuses: [ADAPTER_RECEIPT_INBOX_STATUS.BLOCKED],
    nextSteps: values(ADAPTER_RECEIPT_NEXT_STEP),
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF_INBOX],
    consumes: ['outboxHash', 'receiptHash', 'ledgerHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['inboxHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildAdapterReceiptInboxItem', 'AdapterReceiptInboxItem', 'receiptInboxHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_INBOX,
    order: 120,
    label: 'Dispatch receipt inbox',
    moduleId: 'adapter-dispatch-receipt-inbox',
    kind: 'AdapterDispatchReceiptInboxItem',
    statusSet: values(ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS),
    readyStatuses: [ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.RECEIVED],
    blockedStatuses: [ADAPTER_DISPATCH_RECEIPT_INBOX_STATUS.BLOCKED],
    nextSteps: values(ADAPTER_DISPATCH_RECEIPT_NEXT_STEP),
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_CHANNEL_STATE_PROOF_INBOX],
    consumes: ['dispatchEnvelopeHash', 'outboxHash', 'replayGuardHash', 'receiptHash', 'ledgerHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['dispatchReceiptInboxHash', 'inboxHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildAdapterDispatchReceiptInboxItem', 'AdapterDispatchReceiptInboxItem', 'dispatchReceiptInboxHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF,
    order: 130,
    label: 'Independent channel state proof',
    moduleId: 'channel-state-proof',
    kind: 'ChannelStateProof',
    owner: 'channel-evidence-collector + design-production-core',
    statusSet: values(CHANNEL_STATE_PROOF_STATUS),
    readyStatuses: [CHANNEL_STATE_PROOF_STATUS.VERIFIED],
    blockedStatuses: [CHANNEL_STATE_PROOF_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION],
    consumes: ['receiptHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['proofHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildChannelStateProof', 'ChannelStateProof', 'channelStateProofHash', 'proofHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF_INBOX,
    order: 140,
    label: 'Channel state proof inbox',
    moduleId: 'channel-state-proof-inbox',
    kind: 'ChannelStateProofInboxItem',
    statusSet: values(CHANNEL_STATE_PROOF_INBOX_STATUS),
    readyStatuses: [CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED],
    blockedStatuses: [CHANNEL_STATE_PROOF_INBOX_STATUS.BLOCKED],
    nextSteps: values(CHANNEL_STATE_PROOF_NEXT_STEP),
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION_INBOX],
    consumes: ['receiptInboxHash', 'receiptHash', 'proofHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['proofInboxHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildChannelStateProofInboxItem', 'ChannelStateProofInboxItem', 'proofInboxHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_CHANNEL_STATE_PROOF_INBOX,
    order: 150,
    label: 'Dispatch channel state proof inbox',
    moduleId: 'adapter-dispatch-channel-state-proof-inbox',
    kind: 'AdapterDispatchChannelStateProofInboxItem',
    statusSet: values(ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS),
    readyStatuses: [ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS.RECEIVED],
    blockedStatuses: [ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_INBOX_STATUS.BLOCKED],
    nextSteps: values(ADAPTER_DISPATCH_CHANNEL_STATE_PROOF_NEXT_STEP),
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_STATE_TRANSITION_INBOX],
    consumes: ['dispatchReceiptInboxHash', 'receiptHash', 'proofHash', 'dispatchEnvelopeHash', 'outboxHash', 'replayGuardHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['dispatchProofInboxHash', 'proofInboxHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildAdapterDispatchChannelStateProofInboxItem', 'AdapterDispatchChannelStateProofInboxItem', 'dispatchProofInboxHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION,
    order: 160,
    label: 'Receipt state transition',
    moduleId: 'channel-state-proof',
    kind: 'ReceiptStateTransition',
    statusSet: values(RECEIPT_TRANSITION_STATUS),
    readyStatuses: [RECEIPT_TRANSITION_STATUS.READY],
    blockedStatuses: [RECEIPT_TRANSITION_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER],
    consumes: ['proofHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['transitionHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildReceiptStateTransition', 'ReceiptStateTransition', 'transitionHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION_INBOX,
    order: 170,
    label: 'Receipt state transition inbox',
    moduleId: 'receipt-state-transition-inbox',
    kind: 'ReceiptStateTransitionInboxItem',
    statusSet: values(RECEIPT_STATE_TRANSITION_INBOX_STATUS),
    readyStatuses: [RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED],
    blockedStatuses: [RECEIPT_STATE_TRANSITION_INBOX_STATUS.BLOCKED],
    nextSteps: values(RECEIPT_STATE_TRANSITION_NEXT_STEP),
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER],
    consumes: ['proofInboxHash', 'proofHash', 'transitionHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['transitionInboxHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildReceiptStateTransitionInboxItem', 'ReceiptStateTransitionInboxItem', 'transitionInboxHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_STATE_TRANSITION_INBOX,
    order: 180,
    label: 'Dispatch receipt state transition inbox',
    moduleId: 'adapter-dispatch-receipt-state-transition-inbox',
    kind: 'AdapterDispatchReceiptStateTransitionInboxItem',
    statusSet: values(ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS),
    readyStatuses: [ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS.RECEIVED],
    blockedStatuses: [ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_INBOX_STATUS.BLOCKED],
    nextSteps: values(ADAPTER_DISPATCH_RECEIPT_STATE_TRANSITION_NEXT_STEP),
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER],
    consumes: ['dispatchProofInboxHash', 'dispatchReceiptInboxHash', 'receiptHash', 'proofHash', 'transitionHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['dispatchTransitionInboxHash', 'transitionInboxHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildAdapterDispatchReceiptStateTransitionInboxItem', 'AdapterDispatchReceiptStateTransitionInboxItem', 'dispatchTransitionInboxHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER,
    order: 190,
    label: 'External action ledger',
    moduleId: 'external-action-ledger',
    kind: 'ExternalActionLedgerEntry',
    statusSet: values(EXTERNAL_ACTION_LEDGER_STATUS),
    readyStatuses: [EXTERNAL_ACTION_LEDGER_STATUS.VERIFIED],
    blockedStatuses: [EXTERNAL_ACTION_LEDGER_STATUS.BLOCKED],
    consumes: ['manifestHash', 'previewHash', 'receiptHash', 'proofHash', 'transitionHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['ledgerHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildExternalActionLedgerEntry', 'ExternalActionLedger', 'ledgerHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_BUNDLE,
    order: 200,
    label: 'External action audit bundle',
    moduleId: 'external-action-audit-bundle',
    kind: 'ExternalActionAuditBundle',
    statusSet: values(EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS),
    readyStatuses: [EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS.VERIFIED],
    blockedStatuses: [EXTERNAL_ACTION_AUDIT_BUNDLE_STATUS.BLOCKED],
    requiredBefore: [EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_ARCHIVE],
    consumes: ['ledgerHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['bundleHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildExternalActionAuditBundle', 'bundleHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_ARCHIVE,
    order: 210,
    label: 'External action audit archive',
    moduleId: 'external-action-audit-archive',
    kind: 'ExternalActionAuditArchive',
    statusSet: values(EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS),
    readyStatuses: [EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS.READY],
    blockedStatuses: [EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS.BLOCKED],
    consumes: ['bundleHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['archiveHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    aliases: ['buildExternalActionAuditArchive', 'archiveHash'],
  }),
  node({
    phaseId: EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_REPLAY_CYCLE_INVARIANT,
    order: 220,
    label: 'Dispatch replay-cycle invariant',
    moduleId: 'dispatch-replay-cycle-invariant',
    kind: 'DispatchReplayCycleInvariantReport',
    statusSet: values(DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS),
    readyStatuses: [DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS.PASS],
    blockedStatuses: [DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS.BLOCKED],
    consumes: ['archiveHash', 'replayGuardHash', 'dispatchEnvelopeHash', 'ledgerHash', 'bundleHash', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    produces: ['invariantHash'],
    aliases: ['buildDispatchReplayCycleInvariantReport', 'dispatchReplayCycleInvariant'],
  }),
]);

const PROFILE_ROWS = deepFreeze([
  {
    profileId: 'minimal_verified',
    label: 'Minimal verified lifecycle',
    requiredPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.PLAN_REFERENCE_BINDING,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.APPROVAL_EVIDENCE_GATE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_PREVIEW,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER,
    ],
    recommendedPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_HANDOFF_OUTBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_BUNDLE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_ARCHIVE,
    ],
  },
  {
    profileId: 'live_entrypoint_enforced',
    label: 'Live entrypoint enforced lifecycle',
    requiredPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.PLAN_REFERENCE_BINDING,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.APPROVAL_EVIDENCE_GATE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER,
    ],
    recommendedPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_PREVIEW,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_HANDOFF_OUTBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.REPLAY_GUARD,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION,
    ],
  },
  {
    profileId: 'standard_inbox_verified',
    label: 'Standard inbox verified lifecycle',
    requiredPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.PLAN_REFERENCE_BINDING,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.APPROVAL_EVIDENCE_GATE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_PREVIEW,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_HANDOFF_OUTBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RECEIPT_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_BUNDLE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_ARCHIVE,
    ],
    recommendedPhaseIds: [EXTERNAL_ACTION_LIFECYCLE_PHASES.REPLAY_GUARD],
  },
  {
    profileId: 'dispatch_guarded_verified',
    label: 'Dispatch guarded verified lifecycle',
    requiredPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.PLAN_REFERENCE_BINDING,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.APPROVAL_EVIDENCE_GATE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_PREVIEW,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_HANDOFF_OUTBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.REPLAY_GUARD,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ENVELOPE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ASSIGNMENT,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUNNER_SDK,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_CHANNEL_STATE_PROOF_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_STATE_TRANSITION_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_BUNDLE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_ARCHIVE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_REPLAY_CYCLE_INVARIANT,
    ],
    recommendedPhaseIds: [],
  },
  {
    profileId: 'dispatch_inbox_verified',
    label: 'Dispatch inbox verified lifecycle',
    requiredPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.PLAN_REFERENCE_BINDING,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.APPROVAL_EVIDENCE_GATE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_PREVIEW,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_HANDOFF_OUTBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.REPLAY_GUARD,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ENVELOPE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_CHANNEL_STATE_PROOF_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.RECEIPT_STATE_TRANSITION,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_RECEIPT_STATE_TRANSITION_INBOX,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_BUNDLE,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_AUDIT_ARCHIVE,
    ],
    recommendedPhaseIds: [
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_ASSIGNMENT,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUNNER_SDK,
      EXTERNAL_ACTION_LIFECYCLE_PHASES.DISPATCH_REPLAY_CYCLE_INVARIANT,
    ],
  },
]);

function canonicalIssue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes) || null,
  };
}

function aliasMap(nodes) {
  const entries = [];
  for (const item of nodes || []) {
    for (const alias of item.aliases || []) {
      entries.push([normalizeText(alias).toLowerCase(), item.phaseId]);
    }
  }
  return new Map(entries);
}

function phaseToken(value) {
  if (typeof value === 'string') return normalizeText(value);
  return normalizeText(value?.phaseId || value?.id || value?.kind || value?.moduleId || value?.module || value?.name || '');
}

function resolvePhaseId(value, map) {
  const token = phaseToken(value);
  if (!token) return null;
  return map.get(token.toLowerCase()) || null;
}

function profileById(schema, profileId) {
  return (schema.profiles || []).find((profile) => profile.profileId === profileId) || null;
}

function nodeById(schema, phaseId) {
  return (schema.nodes || []).find((item) => item.phaseId === phaseId) || null;
}

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value || '');
    if (normalized) return normalized;
  }
  return null;
}

function bindingValue(value, key) {
  if (!value || typeof value !== 'object') return null;
  return firstText(
    value?.hashBinding?.[key],
    value?.hashBinding?.requiredHashes?.[key],
    value?.requiredHashes?.[key],
    value?.payload?.[key],
    value?.runner?.requiredHashes?.[key],
    value?.adapter?.requiredHashes?.[key],
    value?.handoff?.[key],
    value?.chain?.[key],
    value?.result?.external?.[key],
    value?.evidence?.[key],
    value?.[key],
  );
}

function objectTextValues(value, keys) {
  if (!value || typeof value !== 'object') return [];
  return keys.map((key) => firstText(
    value?.[key],
    value?.payload?.[key],
    value?.handoff?.[key],
    value?.adapter?.[key],
    value?.runner?.[key],
    value?.result?.decision?.[key],
    value?.result?.external?.[key],
    value?.chain?.[key],
  )).filter(Boolean);
}

function indicatesCustomerMessage(value) {
  return objectTextValues(value, ['action']).some((action) => (
    canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
  ));
}

function indicatesHumanFeedback(value) {
  return Boolean(
    bindingValue(value, 'humanFeedbackRevisionContractHash')
      || objectTextValues(value, ['action']).some((action) => isHumanFeedbackMessageActionAlias(action))
      || objectTextValues(value, ['productLineId', 'workflowId', 'packageRole', 'reviewType', 'role']).some((id) => (
        canonicalProductLineId(id) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
      )),
  );
}

function concreteLifecycleNode(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function participatesInBinding(node, binding) {
  return Boolean(
    node?.consumes?.includes(binding)
      || node?.produces?.includes(binding),
  );
}

function lifecycleSchemaHash(schema) {
  return digest({
    version: schema.version,
    kind: schema.kind,
    status: schema.status,
    nodes: schema.nodes,
    profiles: schema.profiles,
    requiredHashBindings: schema.requiredHashBindings,
    safety: schema.safety,
  });
}

export function buildExternalActionLifecycleSchema({
  schemaOwner = 'design-production-core.external-action-lifecycle-schema',
  createdAt = null,
} = {}) {
  const schema = {
    version: EXTERNAL_ACTION_LIFECYCLE_SCHEMA_VERSION,
    kind: 'ExternalActionLifecycleSchema',
    schemaOwner: normalizeText(schemaOwner || 'design-production-core.external-action-lifecycle-schema'),
    status: EXTERNAL_ACTION_LIFECYCLE_STATUS.READY,
    ready: true,
    nodes: LIFECYCLE_NODES.map((item) => ({ ...item })),
    profiles: PROFILE_ROWS.map((item) => ({
      profileId: item.profileId,
      label: item.label,
      requiredPhaseIds: [...item.requiredPhaseIds],
      recommendedPhaseIds: [...item.recommendedPhaseIds],
    })),
    requiredHashBindings: [
      'approvalHash',
      'evidenceHash',
      'manifestHash',
      'previewHash',
      'platformStateSnapshotHash',
      'dryRunReplayHash',
      'receiptHash',
      'messagePreviewHash',
      'humanFeedbackRevisionContractHash',
      'proofHash',
      'transitionHash',
      'ledgerHash',
    ],
    safety: {
      schemaOnly: true,
      readOnly: true,
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
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const schemaHash = lifecycleSchemaHash(schema);
  return {
    ...schema,
    schemaHash,
    hash: schemaHash,
  };
}

export function validateExternalActionLifecycleChain({
  schema = buildExternalActionLifecycleSchema(),
  profileId = 'minimal_verified',
  phases = [],
  nodes = null,
  strictUnknown = true,
  requiredHashBindings = [],
} = {}) {
  const phaseValues = nodes || phases || [];
  const map = aliasMap(schema.nodes);
  const resolved = [];
  const unknown = [];
  const concreteNodes = [];
  for (const value of phaseValues) {
    const token = phaseToken(value);
    const phaseId = resolvePhaseId(value, map);
    if (!phaseId) {
      if (token) unknown.push(token);
      continue;
    }
    resolved.push(phaseId);
    if (concreteLifecycleNode(value)) {
      concreteNodes.push({
        phaseId,
        node: nodeById(schema, phaseId),
        value,
      });
    }
  }
  const profile = profileById(schema, profileId);
  const requiredPhaseIds = profile?.requiredPhaseIds || [];
  const providedSet = new Set(resolved);
  const missingRequiredPhaseIds = requiredPhaseIds.filter((phaseId) => !providedSet.has(phaseId));
  const orderViolations = [];
  let lastOrder = -Infinity;
  let lastPhaseId = null;
  for (const phaseId of resolved) {
    const currentNode = nodeById(schema, phaseId);
    if (!currentNode) continue;
    if (currentNode.order < lastOrder) {
      orderViolations.push({
        phaseId,
        previousPhaseId: lastPhaseId,
        order: currentNode.order,
        previousOrder: lastOrder,
      });
    }
    lastOrder = Math.max(lastOrder, currentNode.order);
    lastPhaseId = phaseId;
  }
  const requiredBindingSet = new Set(
    (requiredHashBindings || []).map((item) => normalizeText(item)).filter(Boolean),
  );
  for (const item of concreteNodes) {
    if (indicatesCustomerMessage(item.value)) requiredBindingSet.add('messagePreviewHash');
    if (indicatesHumanFeedback(item.value)) requiredBindingSet.add('humanFeedbackRevisionContractHash');
  }
  const requiredBindingIds = [...requiredBindingSet];
  const unknownHashBindings = requiredBindingIds.filter((binding) => !(schema.requiredHashBindings || []).includes(binding));
  const expectedBindings = new Map();
  const missingHashBindings = [];
  const hashBindingMismatches = [];
  for (const item of concreteNodes) {
    for (const binding of requiredBindingIds) {
      if (!participatesInBinding(item.node, binding)) continue;
      const actual = bindingValue(item.value, binding);
      if (!actual) {
        missingHashBindings.push({
          phaseId: item.phaseId,
          binding,
        });
        continue;
      }
      const expected = expectedBindings.get(binding);
      if (expected && expected !== actual) {
        hashBindingMismatches.push({
          phaseId: item.phaseId,
          binding,
          expected,
          actual,
        });
        continue;
      }
      if (!expected) expectedBindings.set(binding, actual);
    }
  }
  const blockers = [
    ...(!profile ? [canonicalIssue('unknown_lifecycle_profile', profileId)] : []),
    ...unknownHashBindings.map((binding) => canonicalIssue('unknown_lifecycle_hash_binding', binding)),
    ...missingRequiredPhaseIds.map((phaseId) => canonicalIssue('required_lifecycle_phase_missing', phaseId)),
    ...orderViolations.map((item) => canonicalIssue('lifecycle_phase_order_violation', `${item.previousPhaseId} before ${item.phaseId}`)),
    ...missingHashBindings.map((item) => canonicalIssue('lifecycle_hash_binding_missing', `${item.phaseId}.${item.binding}`)),
    ...hashBindingMismatches.map((item) => canonicalIssue('lifecycle_hash_binding_mismatch', `${item.phaseId}.${item.binding}`)),
    ...(strictUnknown ? unknown.map((token) => canonicalIssue('unknown_lifecycle_phase', token)) : []),
  ];
  const status = blockers.length
    ? EXTERNAL_ACTION_LIFECYCLE_CHAIN_STATUS.BLOCKED
    : EXTERNAL_ACTION_LIFECYCLE_CHAIN_STATUS.PASS;
  const result = {
    version: EXTERNAL_ACTION_LIFECYCLE_SCHEMA_VERSION,
    kind: 'ExternalActionLifecycleChainValidation',
    profileId,
    status,
    ok: blockers.length === 0,
    providedPhaseIds: resolved,
    unknownPhaseTokens: unknown,
    requiredPhaseIds,
    missingRequiredPhaseIds,
    orderViolations,
    requiredHashBindings: requiredBindingIds,
    missingHashBindings,
    hashBindingMismatches,
    blockers,
    safety: {
      validationOnly: true,
      readOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const validationHash = digest({
    version: result.version,
    kind: result.kind,
    profileId: result.profileId,
    status: result.status,
    providedPhaseIds: result.providedPhaseIds,
    unknownPhaseTokens: result.unknownPhaseTokens,
    requiredPhaseIds: result.requiredPhaseIds,
    missingRequiredPhaseIds: result.missingRequiredPhaseIds,
    orderViolations: result.orderViolations,
    requiredHashBindings: result.requiredHashBindings,
    missingHashBindings: result.missingHashBindings,
    hashBindingMismatches: result.hashBindingMismatches,
    blockers: result.blockers,
    safety: result.safety,
  });
  return {
    ...result,
    validationHash,
    hash: validationHash,
  };
}

export function summarizeExternalActionLifecycleSchema(schema = buildExternalActionLifecycleSchema()) {
  const byOwner = {};
  const byModule = {};
  for (const item of schema.nodes || []) {
    byOwner[item.owner] = (byOwner[item.owner] || 0) + 1;
    byModule[item.moduleId] = (byModule[item.moduleId] || 0) + 1;
  }
  return {
    version: schema.version,
    kind: 'ExternalActionLifecycleSchemaSummary',
    status: schema.status,
    nodeCount: schema.nodes.length,
    profileCount: schema.profiles.length,
    requiredHashBindings: [...schema.requiredHashBindings],
    byOwner,
    byModule,
    safety: {
      schemaOnly: true,
      readOnly: true,
      executesExternalAction: schema.safety?.executesExternalAction === true,
      fetchesChannelState: schema.safety?.fetchesChannelState === true,
      appliesLocalStateTransition: schema.safety?.appliesLocalStateTransition === true,
      grantsExecutionPermission: schema.safety?.grantsExecutionPermission === true,
    },
  };
}

export function summarizeExternalActionLifecycleValidations(validations = []) {
  const byStatus = {};
  const byProfile = {};
  const blockerCodes = {};
  for (const validation of validations || []) {
    byStatus[validation.status] = (byStatus[validation.status] || 0) + 1;
    byProfile[validation.profileId || 'unknown'] = (byProfile[validation.profileId || 'unknown'] || 0) + 1;
    for (const blocker of validation.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: EXTERNAL_ACTION_LIFECYCLE_SCHEMA_VERSION,
    count: validations.length,
    byStatus,
    byProfile,
    blockerCodes,
    safety: {
      validationOnly: true,
      readOnly: true,
      executesExternalAction: validations.some((item) => item.safety?.executesExternalAction === true),
      fetchesChannelState: validations.some((item) => item.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: validations.some((item) => item.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: validations.some((item) => item.safety?.grantsExecutionPermission === true),
    },
  };
}
