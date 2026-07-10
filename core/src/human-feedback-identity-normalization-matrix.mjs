import {
  CHANNEL_IDS,
  CORE_STAGES,
  EXTERNAL_ACTIONS,
  OUTPUT_MODES,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  computeCustomerMessagePreviewHash,
  createChannelTask,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import {
  HUMAN_FEEDBACK_PREVIEW_CLASSES,
  createHumanFeedbackRevisionContract,
} from './human-feedback-contracts.mjs';
import {
  EXECUTION_GATE_DECISIONS,
  EXECUTION_POLICIES,
} from './execution-gates.mjs';
import {
  buildApprovalPacket,
  buildFreshEvidenceBundle,
} from './approval-packets.mjs';
import {
  buildChannelActionManifest,
  computeChannelActionManifestHash,
} from './action-manifest.mjs';
import {
  buildAdapterRunPreview,
  computeAdapterRunPreviewHash,
} from './adapter-runner.mjs';
import {
  ADAPTER_RESULT_STATUS,
  buildAdapterRunReceipt,
  computeAdapterRunReceiptHash,
} from './adapter-receipt.mjs';
import {
  buildChannelStateProof,
  buildReceiptStateTransition,
  computeChannelStateProofHash,
  computeReceiptStateTransitionHash,
} from './channel-state-proof.mjs';
import {
  buildAdapterReceiptInboxItem,
  computeAdapterReceiptInboxHash,
} from './adapter-receipt-inbox.mjs';
import {
  buildChannelStateProofInboxItem,
  computeChannelStateProofInboxHash,
} from './channel-state-proof-inbox.mjs';
import {
  buildReceiptStateTransitionInboxItem,
  computeReceiptStateTransitionInboxHash,
} from './receipt-state-transition-inbox.mjs';
import {
  buildAdapterDispatchReceiptInboxItem,
  computeAdapterDispatchReceiptInboxHash,
} from './adapter-dispatch-receipt-inbox.mjs';
import {
  buildAdapterDispatchChannelStateProofInboxItem,
  computeAdapterDispatchChannelStateProofInboxHash,
} from './adapter-dispatch-channel-state-proof-inbox.mjs';
import {
  buildAdapterDispatchReceiptStateTransitionInboxItem,
  computeAdapterDispatchReceiptStateTransitionInboxHash,
} from './adapter-dispatch-receipt-state-transition-inbox.mjs';
import {
  buildExternalActionLedgerEntry,
  computeExternalActionLedgerHash,
} from './external-action-ledger.mjs';
import {
  buildExternalActionAuditBundle,
  computeExternalActionAuditBundleHash,
} from './external-action-audit-bundle.mjs';
import {
  buildExternalActionAuditArchive,
  computeExternalActionAuditArchiveHash,
} from './external-action-audit-archive.mjs';
import {
  buildExternalActionReplayGuardDecision,
  computeExternalActionReplayGuardHash,
} from './external-action-replay-guard.mjs';
import {
  buildAdapterHandoffOutboxItem,
  computeAdapterHandoffOutboxHash,
} from './adapter-handoff-outbox.mjs';
import {
  buildAdapterDispatchEnvelope,
  computeAdapterDispatchEnvelopeHash,
} from './adapter-dispatch-envelope.mjs';
import {
  buildAdapterRunnerCapability,
} from './adapter-runner-capabilities.mjs';
import {
  buildAdapterRunnerRegistry,
  selectAdapterRunnerCapability,
} from './adapter-runner-registry.mjs';
import {
  buildAdapterDispatchAssignment,
  computeAdapterDispatchAssignmentHash,
} from './adapter-dispatch-assignment.mjs';
import {
  buildAdapterDispatchReadinessReport,
  computeAdapterDispatchReadinessReportHash,
} from './adapter-dispatch-readiness-report.mjs';
import { applyStateTransition } from './state-machine.mjs';
import { digest } from './hash-utils.mjs';

export const HUMAN_FEEDBACK_IDENTITY_NORMALIZATION_MATRIX_VERSION = 1;

const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';
const PLATFORM_STATE_SNAPSHOT_HASH = digest({ kind: 'human-feedback-identity-normalization-matrix', snapshot: 'platform-state' });
const DRY_RUN_REPLAY_HASH = digest({ kind: 'human-feedback-identity-normalization-matrix', snapshot: 'dry-run-replay' });
const RUNNER_LOCATION = '../external-adapter-runners/human-feedback';

const UNSAFE_SAFETY_KEYS = Object.freeze([
  'executesExternalAction',
  'uploads',
  'submits',
  'sendsMessages',
  'acceptsDelivery',
  'pays',
  'deploys',
  'fetchesChannelState',
  'appliesLocalStateTransition',
  'grantsExecutionPermission',
  'readyForExecution',
]);

const PROFILE_FIXTURES = Object.freeze([
  {
    id: 'consumer-feedback-message-alias',
    description: 'customer-facing message action uses consumerFeedbackMessage/humanFeedback aliases',
    channelId: CHANNEL_IDS.ZBJ,
    externalId: 'cf-matrix-message-001',
    rawAction: 'consumerFeedbackMessage',
    rawProductLineId: 'humanFeedback',
    rawWorkflowId: 'buyerFeedback',
    rawPackageRole: 'humanFeedbackRevision',
    expectedAction: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
    expectedPolicy: EXECUTION_POLICIES.SUBMIT_ALLOWED,
    fromStage: CORE_STAGES.SUBMITTED_VERIFIED,
    toStage: CORE_STAGES.DELIVERY_READY,
    requiresMessagePreviewHash: true,
    requiresHumanFeedbackRevisionContractHash: true,
    messagePreview: '客户反馈已整理为一条可执行修订：保留原始方向，只调整版式层级。',
    resultEvidence: {
      messageId: 'matrix-message-001',
      externalResultId: 'matrix-message-001',
    },
    stateEvidence: {
      messageId: 'matrix-message-001',
      ok: true,
      verified: true,
      landed: true,
      stateCode: 'message_visible',
    },
  },
  {
    id: 'work-modify-live-package-role-alias',
    description: 'live submit action is human feedback by packageRole/reviewType/role aliases',
    channelId: CHANNEL_IDS.EPWK,
    externalId: 'cf-matrix-live-001',
    rawAction: 'workModifyLive',
    rawProductLineId: 'logoBrand',
    rawWorkflowId: 'logoBrand',
    rawPackageRole: 'humanFeedbackReview',
    expectedAction: EXTERNAL_ACTIONS.LIVE_SUBMIT,
    expectedPolicy: EXECUTION_POLICIES.SUBMIT_ALLOWED,
    fromStage: CORE_STAGES.SUBMIT_READY,
    toStage: CORE_STAGES.SUBMITTED_VERIFIED,
    requiresMessagePreviewHash: false,
    requiresHumanFeedbackRevisionContractHash: true,
    messagePreview: null,
    resultEvidence: {
      worksId: 'matrix-work-001',
      submissionId: 'matrix-submission-001',
      externalResultId: 'matrix-submission-001',
      uploadedArtifactNames: ['submitted.pdf'],
      totalMyWorks: 7,
      worksIsHidden: false,
      buyerIsHide: false,
    },
    stateEvidence: {
      worksId: 'matrix-work-001',
      submissionId: 'matrix-submission-001',
      ok: true,
      verified: true,
      landed: true,
      submissionConfirmed: true,
      artifactNames: ['submitted.pdf'],
      artifactCount: 1,
      stateCode: 'submitted',
      totalMyWorks: 7,
      worksIsHidden: false,
      buyerIsHide: false,
    },
  },
  {
    id: 'acceptance-apply-role-alias',
    description: 'acceptance apply action is human feedback by role aliases and contract hash',
    channelId: CHANNEL_IDS.ZBJ,
    externalId: 'cf-matrix-acceptance-001',
    rawAction: 'acceptanceApply',
    rawProductLineId: 'logoBrand',
    rawWorkflowId: 'logoBrand',
    rawPackageRole: 'humanFeedbackReview',
    expectedAction: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
    expectedPolicy: EXECUTION_POLICIES.ACCEPTANCE_ALLOWED,
    fromStage: CORE_STAGES.DELIVERY_READY,
    toStage: CORE_STAGES.DELIVERY_READY,
    requiresMessagePreviewHash: false,
    requiresHumanFeedbackRevisionContractHash: true,
    messagePreview: null,
    resultEvidence: {
      acceptanceId: 'matrix-acceptance-001',
      externalResultId: 'matrix-acceptance-001',
    },
    stateEvidence: {
      acceptanceId: 'matrix-acceptance-001',
      ok: true,
      verified: true,
      landed: true,
      stateCode: 'acceptance_applied',
      artifactNames: ['submitted.pdf'],
      artifactCount: 1,
    },
  },
]);

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes || '') || null,
  };
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function withRecordedHash(value, semanticKey, computeHash) {
  const clone = deepClone(value);
  const hash = computeHash(clone);
  clone[semanticKey] = hash;
  clone.hash = hash;
  return clone;
}

function aliasIdentity(value, profile) {
  const clone = deepClone(value);
  if (!clone || typeof clone !== 'object') return clone;

  if (Object.hasOwn(clone, 'action')) clone.action = profile.rawAction;
  if (Object.hasOwn(clone, 'productLineId')) clone.productLineId = profile.rawProductLineId;
  if (Object.hasOwn(clone, 'workflowId')) clone.workflowId = profile.rawWorkflowId;
  if (clone.payload && typeof clone.payload === 'object') {
    if (Object.hasOwn(clone.payload, 'action')) clone.payload.action = profile.rawAction;
    if (Object.hasOwn(clone.payload, 'productLineId')) clone.payload.productLineId = profile.rawProductLineId;
    if (Object.hasOwn(clone.payload, 'workflowId')) clone.payload.workflowId = profile.rawWorkflowId;
    if (Object.hasOwn(clone.payload, 'packageRole')) clone.payload.packageRole = profile.rawPackageRole;
    if (Object.hasOwn(clone.payload, 'reviewType')) clone.payload.reviewType = profile.rawPackageRole;
    if (Object.hasOwn(clone.payload, 'role')) clone.payload.role = profile.rawPackageRole;
  }
  if (clone.result?.external && typeof clone.result.external === 'object') {
    clone.result.external.action = profile.rawAction;
  }
  return clone;
}

function aliasManifest(manifest, profile) {
  const clone = aliasIdentity(manifest, profile);
  clone.adapter = {
    ...clone.adapter,
    sideEffectClass: profile.rawAction,
    hints: {
      ...(clone.adapter?.hints || {}),
      actionVariant: profile.rawAction,
    },
  };
  return withRecordedHash(clone, 'manifestHash', computeChannelActionManifestHash);
}

function aliasPreview(preview, profile) {
  return withRecordedHash(aliasIdentity(preview, profile), 'previewHash', computeAdapterRunPreviewHash);
}

function aliasReceipt(receipt, profile) {
  return withRecordedHash(aliasIdentity(receipt, profile), 'receiptHash', computeAdapterRunReceiptHash);
}

function aliasProof(proof, profile) {
  return withRecordedHash(aliasIdentity(proof, profile), 'proofHash', computeChannelStateProofHash);
}

function aliasReceiptTransition(transition, profile) {
  return withRecordedHash(aliasIdentity(transition, profile), 'transitionHash', computeReceiptStateTransitionHash);
}

function aliasLedgerEntry(ledgerEntry, profile) {
  return withRecordedHash(aliasIdentity(ledgerEntry, profile), 'ledgerHash', computeExternalActionLedgerHash);
}

function aliasBundle(bundle, profile) {
  return withRecordedHash(aliasIdentity(bundle, profile), 'bundleHash', computeExternalActionAuditBundleHash);
}

function aliasArchive(archive) {
  return withRecordedHash(archive, 'archiveHash', computeExternalActionAuditArchiveHash);
}

function aliasOutbox(outbox, profile) {
  return withRecordedHash(aliasIdentity(outbox, profile), 'outboxHash', computeAdapterHandoffOutboxHash);
}

function aliasReplayGuard(replayGuard, profile) {
  const clone = aliasIdentity(replayGuard, profile);
  if (clone.candidate) clone.candidate = aliasIdentity(clone.candidate, profile);
  return withRecordedHash(clone, 'replayGuardHash', computeExternalActionReplayGuardHash);
}

function aliasDispatchEnvelope(envelope, profile) {
  return withRecordedHash(aliasIdentity(envelope, profile), 'dispatchEnvelopeHash', computeAdapterDispatchEnvelopeHash);
}

function aliasDispatchAssignment(assignment, profile) {
  return withRecordedHash(aliasIdentity(assignment, profile), 'assignmentHash', computeAdapterDispatchAssignmentHash);
}

function aliasReadinessReport(report, profile) {
  return withRecordedHash(aliasIdentity(report, profile), 'reportHash', computeAdapterDispatchReadinessReportHash);
}

function aliasReceiptInbox(item, profile) {
  return withRecordedHash(aliasIdentity(item, profile), 'inboxHash', computeAdapterReceiptInboxHash);
}

function aliasProofInbox(item, profile) {
  return withRecordedHash(aliasIdentity(item, profile), 'proofInboxHash', computeChannelStateProofInboxHash);
}

function aliasTransitionInbox(item, profile) {
  return withRecordedHash(aliasIdentity(item, profile), 'transitionInboxHash', computeReceiptStateTransitionInboxHash);
}

function aliasDispatchReceiptInbox(item, profile) {
  return withRecordedHash(aliasIdentity(item, profile), 'inboxHash', computeAdapterDispatchReceiptInboxHash);
}

function aliasDispatchProofInbox(item, profile) {
  return withRecordedHash(aliasIdentity(item, profile), 'proofInboxHash', computeAdapterDispatchChannelStateProofInboxHash);
}

function aliasDispatchTransitionInbox(item, profile) {
  return withRecordedHash(aliasIdentity(item, profile), 'transitionInboxHash', computeAdapterDispatchReceiptStateTransitionInboxHash);
}

function transitionInputFor(profile, gateDecision) {
  return {
    taskKey: `${profile.channelId}:${profile.externalId}`,
    fromStage: profile.fromStage,
    toStage: profile.toStage,
    action: profile.expectedAction,
    gateDecision,
    reason: 'human-feedback identity normalization matrix',
    actor: 'design-production-core.human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  };
}

function buildContract(profile, channelTask) {
  const artifactHash = digest({ kind: 'artifact', profileId: profile.id });
  const sourceHash = digest({ kind: 'source-snapshot', profileId: profile.id });
  return createHumanFeedbackRevisionContract({
    taskKey: channelTask.taskKey,
    channelId: channelTask.channelId,
    externalId: channelTask.externalId,
    workflowId: profile.rawWorkflowId,
    sourceSnapshot: {
      hash: sourceHash,
      refreshedAt: FIXED_CREATED_AT,
      refs: [
        {
          kind: 'path',
          ref: `reports/human-feedback-identity-normalization-matrix/${profile.id}/source.md`,
          hash: sourceHash,
        },
      ],
    },
    targetArtifact: {
      workNo: `matrix-${profile.id}`,
      filename: 'submitted.pdf',
      hash: artifactHash,
    },
    baselineInvariantLock: {
      locked: true,
      lockedFacts: ['do not rewrite customer source intent during identity normalization'],
    },
    atomicQueue: [
      {
        id: `${profile.id}-atomic-001`,
        status: 'active',
        description: 'Verify human-feedback aliases keep the same customer-facing contract binding.',
      },
    ],
    activeAtomicChange: `${profile.id}-atomic-001`,
    unchangedRegressionChecklist: [
      'no external runner execution',
      'no customer message send',
      'no acceptance or payment mutation',
    ],
    previewClass: HUMAN_FEEDBACK_PREVIEW_CLASSES.CUSTOMER_FACING_REVISION,
    exitAction: profile.expectedAction,
    exitStage: profile.expectedAction === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY
      ? 'humanFeedbackAcceptance'
      : 'humanFeedbackHandoff',
    reviewGate: {
      kind: 'ReviewReport',
      ok: true,
      decision: 'pass',
      reviewType: profile.rawPackageRole,
      activeAtomicChangeId: `${profile.id}-atomic-001`,
      targetArtifact: {
        workNo: `matrix-${profile.id}`,
        hash: artifactHash,
      },
      artifactHashes: [
        {
          filename: 'submitted.pdf',
          hash: artifactHash,
        },
      ],
    },
    generationPolicy: {
      localOnly: false,
      customerFacingOnlyAfterApproval: true,
    },
    evidenceRefs: [
      {
        kind: 'report',
        ref: 'reports/human-feedback-identity-normalization-matrix-latest.json',
      },
    ],
    createdAt: FIXED_CREATED_AT,
  });
}

function buildWorkRecords(profile, channelTask, contract) {
  const artifactHash = contract.targetArtifact.hash;
  const common = {
    taskKey: channelTask.taskKey,
    channelId: channelTask.channelId,
    externalId: channelTask.externalId,
    productLineId: profile.rawProductLineId,
    workflowId: profile.rawWorkflowId,
    humanFeedbackRevisionContractHash: contract.contractHash,
    humanFeedbackRevisionContract: contract,
  };
  const artifactPackage = {
    ...common,
    kind: 'ArtifactPackage',
    packageRole: profile.rawPackageRole,
    reviewType: profile.rawPackageRole,
    role: profile.rawPackageRole,
    outputMode: OUTPUT_MODES.PDF_DECK,
    submitReady: true,
    artifactCount: 1,
    artifacts: [
      {
        filename: 'submitted.pdf',
        hash: artifactHash,
        sizeBytes: 12345,
      },
    ],
    provenance: {
      providerId: 'matrix-local-fixture',
      manualProvider: false,
      generatedByCore: false,
    },
  };
  const reviewReport = {
    ...common,
    kind: 'ReviewReport',
    packageRole: profile.rawPackageRole,
    reviewType: profile.rawPackageRole,
    role: profile.rawPackageRole,
    decision: 'pass',
    ok: true,
    reviewer: 'human-feedback-identity-normalization-matrix',
    artifactHashes: artifactPackage.artifacts,
    blockers: [],
  };
  const plan = {
    ...common,
    kind: 'Plan',
    outputMode: OUTPUT_MODES.PDF_DECK,
    artifactCount: 1,
    packageRole: profile.rawPackageRole,
    reviewType: profile.rawPackageRole,
    role: profile.rawPackageRole,
  };
  return { plan, artifactPackage, reviewReport };
}

function buildApprovalAndEvidence({ profile, channelTask, plan, artifactPackage, reviewReport }) {
  const approvalPacket = buildApprovalPacket({
    action: profile.rawAction,
    policy: profile.expectedPolicy,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
    messagePreview: profile.messagePreview,
    reason: 'human-feedback identity normalization matrix',
    requestedBy: 'human-feedback-identity-normalization-matrix',
    approved: true,
    approvedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const evidenceBundle = buildFreshEvidenceBundle({
    approvalPacket,
    action: profile.rawAction,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
    messagePreview: profile.messagePreview,
    ok: true,
    createdAt: FIXED_CREATED_AT,
  });
  return { approvalPacket, evidenceBundle };
}

function buildGateDecision({
  profile,
  channelTask,
  plan,
  artifactPackage,
  approvalPacket,
  evidenceBundle,
  contract,
}) {
  const messagePreviewHash = profile.messagePreview
    ? computeCustomerMessagePreviewHash(profile.messagePreview)
    : null;
  return {
    version: 1,
    kind: 'ExecutionGateDecision',
    decision: EXECUTION_GATE_DECISIONS.ALLOW,
    allowed: true,
    action: profile.expectedAction,
    policy: profile.expectedPolicy,
    taskKey: channelTask.taskKey,
    channelId: channelTask.channelId,
    externalId: channelTask.externalId,
    productLineId: canonicalProductLineId(plan.productLineId),
    workflowId: canonicalProductLineId(plan.workflowId),
    packageRole: canonicalPackageRole(artifactPackage.packageRole),
    reviewType: canonicalPackageRole(artifactPackage.reviewType),
    role: canonicalPackageRole(artifactPackage.role),
    approvalHash: approvalPacket.approvalHash,
    evidenceHash: evidenceBundle.evidenceHash,
    humanFeedbackRevisionContractHash: contract.contractHash,
    messagePreview: profile.messagePreview,
    messagePreviewHash,
    blockers: [],
    warnings: [],
    safety: {
      localGateOnly: true,
      executesExternalAction: false,
      grantsExecutionPermission: false,
      requiresCurrentApproval: true,
      requiresFreshEvidence: true,
    },
    createdAt: FIXED_CREATED_AT,
  };
}

function receiptExternalResult(profile, contract) {
  return {
    ...profile.resultEvidence,
    humanFeedbackRevisionContractHash: contract.contractHash,
    messagePreview: profile.messagePreview,
    messagePreviewHash: profile.messagePreview
      ? computeCustomerMessagePreviewHash(profile.messagePreview)
      : null,
    statusText: 'matrix success evidence',
  };
}

function proofStateEvidence(profile, contract, receipt) {
  return {
    ...profile.stateEvidence,
    externalId: profile.externalId,
    receiptHash: receipt.receiptHash,
    humanFeedbackRevisionContractHash: contract.contractHash,
    messagePreview: profile.messagePreview,
    messagePreviewHash: profile.messagePreview
      ? computeCustomerMessagePreviewHash(profile.messagePreview)
      : null,
  };
}

function reportedHashes(preview, manifest, extra = {}) {
  return {
    manifestHash: manifest.manifestHash,
    previewHash: preview.previewHash,
    approvalHash: preview.payload.approvalHash,
    evidenceHash: preview.payload.evidenceHash,
    approvalProvenanceHash: preview.payload.approvalProvenanceHash,
    platformStateSnapshotHash: PLATFORM_STATE_SNAPSHOT_HASH,
    dryRunReplayHash: DRY_RUN_REPLAY_HASH,
    ...extra,
  };
}

function buildBaseChain(profile) {
  const channelTask = createChannelTask({
    channelId: profile.channelId,
    externalId: profile.externalId,
    title: `Human feedback matrix ${profile.id}`,
    status: 'buyer_feedback',
    rawCategory: 'design',
    createdAt: FIXED_CREATED_AT,
  });
  const contract = buildContract(profile, channelTask);
  const { plan, artifactPackage, reviewReport } = buildWorkRecords(profile, channelTask, contract);
  const { approvalPacket, evidenceBundle } = buildApprovalAndEvidence({
    profile,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
  });
  const gateDecision = buildGateDecision({
    profile,
    channelTask,
    plan,
    artifactPackage,
    approvalPacket,
    evidenceBundle,
    contract,
  });
  const transitionResult = applyStateTransition(transitionInputFor(profile, gateDecision));
  const manifest = buildChannelActionManifest({
    action: profile.rawAction,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
    gateDecision,
    transitionResult,
    approvalPacket,
    evidenceBundle,
    adapterHints: {
      mode: 'dry-run',
      actionVariant: profile.rawAction,
    },
    createdAt: FIXED_CREATED_AT,
  });
  const preview = buildAdapterRunPreview({
    manifest,
    execute: false,
    runnerId: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const pendingLedgerEntry = buildExternalActionLedgerEntry({
    manifest,
    preview,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const replayArchive = buildExternalActionAuditArchive({
    bundles: [],
    allowEmptyArchive: true,
    requireInboxChain: false,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const outbox = buildAdapterHandoffOutboxItem({
    manifest,
    preview,
    ledgerEntry: pendingLedgerEntry,
    execute: false,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const replayGuard = buildExternalActionReplayGuardDecision({
    archive: replayArchive,
    candidate: outbox,
    requireReadyArchive: true,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchEnvelope = buildAdapterDispatchEnvelope({
    outboxItem: outbox,
    replayGuardDecision: replayGuard,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const receipt = buildAdapterRunReceipt({
    preview,
    manifest,
    resultStatus: ADAPTER_RESULT_STATUS.SUCCESS,
    externalResult: receiptExternalResult(profile, contract),
    reportedHashes: reportedHashes(preview, manifest, {
      dispatchEnvelopeHash: dispatchEnvelope.dispatchEnvelopeHash,
      outboxHash: outbox.outboxHash,
      replayGuardHash: replayGuard.replayGuardHash,
      archiveHash: replayArchive.archiveHash,
      ledgerHash: pendingLedgerEntry.ledgerHash,
    }),
    runnerId: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const proof = buildChannelStateProof({
    receipt,
    stateEvidence: proofStateEvidence(profile, contract, receipt),
    verifierId: 'human-feedback-identity-normalization-matrix',
    observedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });
  const receiptTransition = buildReceiptStateTransition({
    proof,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const receiptInboxItem = buildAdapterReceiptInboxItem({
    outboxItem: outbox,
    receipt,
    ledgerEntry: pendingLedgerEntry,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const proofInboxItem = buildChannelStateProofInboxItem({
    receiptInboxItem,
    proof,
    receipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const transitionInboxItem = buildReceiptStateTransitionInboxItem({
    proofInboxItem,
    transition: receiptTransition,
    proof,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchReceiptInboxItem = buildAdapterDispatchReceiptInboxItem({
    dispatchEnvelope,
    receipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchProofInboxItem = buildAdapterDispatchChannelStateProofInboxItem({
    dispatchReceiptInboxItem,
    proof,
    receipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchTransitionInboxItem = buildAdapterDispatchReceiptStateTransitionInboxItem({
    dispatchProofInboxItem,
    proof,
    transition: receiptTransition,
    receipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const ledgerEntry = buildExternalActionLedgerEntry({
    manifest,
    preview,
    receipt,
    proof,
    transition: receiptTransition,
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const bundle = buildExternalActionAuditBundle({
    ledgerEntry,
    requireInboxChain: true,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const archive = buildExternalActionAuditArchive({
    bundles: [bundle],
    requireInboxChain: true,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const runnerCapability = buildAdapterRunnerCapability({
    runnerId: `human-feedback-matrix-${profile.channelId}-${profile.expectedAction}`,
    channelId: profile.channelId,
    supportedActionIds: [manifest.adapter.actionId],
    runnerLocation: RUNNER_LOCATION,
    supportsExecute: true,
    createdAt: FIXED_CREATED_AT,
  });
  const runnerRegistry = buildAdapterRunnerRegistry({
    capabilities: [runnerCapability],
    registryId: `human-feedback-matrix-${profile.id}`,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const runnerSelection = selectAdapterRunnerCapability({
    registry: runnerRegistry,
    channelId: profile.channelId,
    actionId: manifest.adapter.actionId,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchAssignment = buildAdapterDispatchAssignment({
    dispatchEnvelope,
    runnerCapability,
    runnerSelection,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchReadinessReport = buildAdapterDispatchReadinessReport({
    runnerRegistry,
    runnerSelection,
    dispatchEnvelope,
    dispatchAssignment,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  return {
    profile,
    channelTask,
    contract,
    plan,
    artifactPackage,
    reviewReport,
    approvalPacket,
    evidenceBundle,
    gateDecision,
    transitionResult,
    manifest,
    preview,
    receipt,
    proof,
    receiptTransition,
    pendingLedgerEntry,
    replayArchive,
    ledgerEntry,
    bundle,
    archive,
    outbox,
    replayGuard,
    dispatchEnvelope,
    runnerCapability,
    runnerRegistry,
    runnerSelection,
    dispatchAssignment,
    dispatchReadinessReport,
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
  };
}

function buildAliasChain(profile, base) {
  const manifest = aliasManifest(base.manifest, profile);
  const preview = buildAdapterRunPreview({
    manifest,
    execute: false,
    runnerId: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedPreview = aliasPreview(preview, profile);
  const pendingLedgerEntry = aliasLedgerEntry(buildExternalActionLedgerEntry({
    manifest,
    preview: aliasedPreview,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }), profile);
  const replayArchive = aliasArchive(buildExternalActionAuditArchive({
    bundles: [],
    allowEmptyArchive: true,
    requireInboxChain: false,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }));
  const outbox = buildAdapterHandoffOutboxItem({
    manifest,
    preview: aliasedPreview,
    ledgerEntry: pendingLedgerEntry,
    execute: false,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedOutbox = aliasOutbox(outbox, profile);
  const replayGuard = buildExternalActionReplayGuardDecision({
    archive: replayArchive,
    candidate: aliasedOutbox,
    requireReadyArchive: true,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedReplayGuard = aliasReplayGuard(replayGuard, profile);
  const dispatchEnvelope = buildAdapterDispatchEnvelope({
    outboxItem: aliasedOutbox,
    replayGuardDecision: aliasedReplayGuard,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedDispatchEnvelope = aliasDispatchEnvelope(dispatchEnvelope, profile);
  const receipt = buildAdapterRunReceipt({
    preview: aliasedPreview,
    manifest,
    resultStatus: ADAPTER_RESULT_STATUS.SUCCESS,
    externalResult: receiptExternalResult(profile, base.contract),
    reportedHashes: reportedHashes(aliasedPreview, manifest, {
      dispatchEnvelopeHash: aliasedDispatchEnvelope.dispatchEnvelopeHash,
      outboxHash: aliasedOutbox.outboxHash,
      replayGuardHash: aliasedReplayGuard.replayGuardHash,
      archiveHash: replayArchive.archiveHash,
      ledgerHash: pendingLedgerEntry.ledgerHash,
    }),
    runnerId: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedReceipt = aliasReceipt(receipt, profile);
  const proof = buildChannelStateProof({
    receipt: aliasedReceipt,
    stateEvidence: proofStateEvidence(profile, base.contract, aliasedReceipt),
    verifierId: 'human-feedback-identity-normalization-matrix',
    observedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedProof = aliasProof(proof, profile);
  const receiptTransition = buildReceiptStateTransition({
    proof: aliasedProof,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedReceiptTransition = aliasReceiptTransition(receiptTransition, profile);
  const receiptInboxItem = aliasReceiptInbox(buildAdapterReceiptInboxItem({
    outboxItem: aliasedOutbox,
    receipt: aliasedReceipt,
    ledgerEntry: pendingLedgerEntry,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }), profile);
  const proofInboxItem = aliasProofInbox(buildChannelStateProofInboxItem({
    receiptInboxItem,
    proof: aliasedProof,
    receipt: aliasedReceipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }), profile);
  const transitionInboxItem = aliasTransitionInbox(buildReceiptStateTransitionInboxItem({
    proofInboxItem,
    transition: aliasedReceiptTransition,
    proof: aliasedProof,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }), profile);
  const dispatchReceiptInboxItem = aliasDispatchReceiptInbox(buildAdapterDispatchReceiptInboxItem({
    dispatchEnvelope: aliasedDispatchEnvelope,
    receipt: aliasedReceipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }), profile);
  const dispatchProofInboxItem = aliasDispatchProofInbox(buildAdapterDispatchChannelStateProofInboxItem({
    dispatchReceiptInboxItem,
    proof: aliasedProof,
    receipt: aliasedReceipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }), profile);
  const dispatchTransitionInboxItem = aliasDispatchTransitionInbox(buildAdapterDispatchReceiptStateTransitionInboxItem({
    dispatchProofInboxItem,
    proof: aliasedProof,
    transition: aliasedReceiptTransition,
    receipt: aliasedReceipt,
    receivedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }), profile);
  const ledgerEntry = buildExternalActionLedgerEntry({
    manifest,
    preview: aliasedPreview,
    receipt: aliasedReceipt,
    proof: aliasedProof,
    transition: aliasedReceiptTransition,
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedLedgerEntry = aliasLedgerEntry(ledgerEntry, profile);
  const bundle = buildExternalActionAuditBundle({
    ledgerEntry: aliasedLedgerEntry,
    requireInboxChain: false,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedBundle = aliasBundle(bundle, profile);
  const archive = aliasArchive(buildExternalActionAuditArchive({
    bundles: [aliasedBundle],
    requireInboxChain: true,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  }));
  const runnerCapability = buildAdapterRunnerCapability({
    runnerId: `human-feedback-matrix-alias-${profile.channelId}-${profile.expectedAction}`,
    channelId: profile.channelId,
    supportedActionIds: [manifest.adapter.actionId],
    runnerLocation: RUNNER_LOCATION,
    supportsExecute: true,
    createdAt: FIXED_CREATED_AT,
  });
  const runnerRegistry = buildAdapterRunnerRegistry({
    capabilities: [runnerCapability],
    registryId: `human-feedback-matrix-alias-${profile.id}`,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const runnerSelection = selectAdapterRunnerCapability({
    registry: runnerRegistry,
    channelId: profile.channelId,
    actionId: manifest.adapter.actionId,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchAssignment = buildAdapterDispatchAssignment({
    dispatchEnvelope: aliasedDispatchEnvelope,
    runnerCapability,
    runnerSelection,
    requestedBy: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedDispatchAssignment = aliasDispatchAssignment(dispatchAssignment, profile);
  const dispatchReadinessReport = buildAdapterDispatchReadinessReport({
    runnerRegistry,
    runnerSelection,
    dispatchEnvelope: aliasedDispatchEnvelope,
    dispatchAssignment: aliasedDispatchAssignment,
    actor: 'human-feedback-identity-normalization-matrix',
    createdAt: FIXED_CREATED_AT,
  });
  const aliasedDispatchReadinessReport = aliasReadinessReport(dispatchReadinessReport, profile);
  return {
    manifest,
    preview: aliasedPreview,
    receipt: aliasedReceipt,
    proof: aliasedProof,
    receiptTransition: aliasedReceiptTransition,
    pendingLedgerEntry,
    replayArchive,
    ledgerEntry: aliasedLedgerEntry,
    bundle: aliasedBundle,
    archive,
    outbox: aliasedOutbox,
    replayGuard: aliasedReplayGuard,
    dispatchEnvelope: aliasedDispatchEnvelope,
    runnerCapability,
    runnerRegistry,
    runnerSelection,
    dispatchAssignment: aliasedDispatchAssignment,
    dispatchReadinessReport: aliasedDispatchReadinessReport,
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    dispatchReceiptInboxItem,
    dispatchProofInboxItem,
    dispatchTransitionInboxItem,
  };
}

function blockerCodes(record) {
  return uniqueStrings((record?.blockers || []).map((blocker) => blocker.code || blocker), 64);
}

function recordStatus(record) {
  return record?.status || (record?.clear === true ? 'clear' : null);
}

function recordReady(record) {
  if (!record) return false;
  if (record.blockers?.length) return false;
  if (record.readyForAdapter === false || record.readyForDryRun === false || record.accepted === false || record.verified === false) return false;
  if (record.ready === false || record.clear === false || record.queued === false || record.received === false) return false;
  if (record.readyForExternalRunner === false) return false;
  return true;
}

function text(value) {
  return normalizeText(value || '') || null;
}

function contractHashOf(record) {
  return text(
    record?.payload?.humanFeedbackRevisionContractHash
      || record?.hashBinding?.humanFeedbackRevisionContractHash
      || record?.runner?.requiredHashes?.humanFeedbackRevisionContractHash
      || record?.dispatch?.requiredHashes?.humanFeedbackRevisionContractHash
      || record?.handoff?.humanFeedbackRevisionContractHash
      || record?.candidate?.humanFeedbackRevisionContractHash
      || record?.chain?.humanFeedbackRevisionContractHash
      || record?.entries?.[0]?.humanFeedbackRevisionContractHash,
  );
}

function messagePreviewHashOf(record) {
  return text(
    record?.payload?.messagePreviewHash
      || record?.hashBinding?.messagePreviewHash
      || record?.runner?.requiredHashes?.messagePreviewHash
      || record?.dispatch?.requiredHashes?.messagePreviewHash
      || record?.handoff?.messagePreviewHash
      || record?.candidate?.messagePreviewHash
      || record?.chain?.messagePreviewHash
      || record?.entries?.[0]?.messagePreviewHash,
  );
}

function canonicalIdentityOf(record) {
  return {
    action: canonicalExternalAction(
      record?.action
        || record?.payload?.action
        || record?.result?.decision?.action
        || record?.handoff?.action
        || record?.dispatch?.action
        || record?.candidate?.action
        || record?.entries?.[0]?.action,
    ),
    productLineId: canonicalProductLineId(
      record?.productLineId
        || record?.payload?.productLineId
        || record?.handoff?.productLineId
        || record?.candidate?.productLineId
        || record?.entries?.[0]?.productLineId,
    ),
    workflowId: canonicalProductLineId(
      record?.workflowId
        || record?.payload?.workflowId
        || record?.handoff?.workflowId
        || record?.candidate?.workflowId
        || record?.entries?.[0]?.workflowId,
    ),
    packageRole: canonicalPackageRole(
      record?.payload?.packageRole
        || record?.handoff?.packageRole
        || record?.dispatch?.packageRole
        || record?.candidate?.packageRole
        || record?.entries?.[0]?.packageRole
        || '',
    ),
  };
}

function unsafeSafetyCodes(record) {
  const safety = record?.safety || {};
  return UNSAFE_SAFETY_KEYS.filter((key) => safety[key] === true);
}

function matrixRow({ profile, surface, variant, record, expectedContractHash, expectedMessagePreviewHash }) {
  const identity = canonicalIdentityOf(record);
  const codes = blockerCodes(record);
  const safetyCodes = unsafeSafetyCodes(record);
  const contractHash = contractHashOf(record);
  const messagePreviewHash = messagePreviewHashOf(record);
  const failures = [];

  if (!recordReady(record)) failures.push('record_not_ready');
  if (identity.action !== profile.expectedAction) failures.push('action_not_canonical');
  if (profile.requiresHumanFeedbackRevisionContractHash) {
    if (!contractHash) failures.push('human_feedback_contract_hash_missing');
    if (contractHash && contractHash !== expectedContractHash) failures.push('human_feedback_contract_hash_mismatch');
  }
  if (profile.requiresMessagePreviewHash) {
    if (!messagePreviewHash) failures.push('message_preview_hash_missing');
    if (messagePreviewHash && messagePreviewHash !== expectedMessagePreviewHash) failures.push('message_preview_hash_mismatch');
  } else if (messagePreviewHash) {
    failures.push('message_preview_hash_unexpected_for_non_message_action');
  }
  if (codes.length) failures.push('blockers_present');
  if (safetyCodes.length) failures.push('unsafe_safety_claim');

  return {
    profileId: profile.id,
    surface,
    variant,
    ok: failures.length === 0,
    status: recordStatus(record),
    kind: record?.kind || null,
    action: identity.action,
    productLineId: identity.productLineId || null,
    workflowId: identity.workflowId || null,
    packageRole: identity.packageRole || null,
    contractHash,
    messagePreviewHash,
    expectedContractHash,
    expectedMessagePreviewHash,
    requiresHumanFeedbackRevisionContractHash: profile.requiresHumanFeedbackRevisionContractHash,
    requiresMessagePreviewHash: profile.requiresMessagePreviewHash,
    blockerCodes: codes,
    unsafeSafetyCodes: safetyCodes,
    failures,
  };
}

function profileRows(profile, base, aliasChain) {
  const expectedContractHash = base.contract.contractHash;
  const expectedMessagePreviewHash = profile.messagePreview
    ? computeCustomerMessagePreviewHash(profile.messagePreview)
    : null;
  const records = [
    ['manifest', base.manifest],
    ['preview', base.preview],
    ['receipt', base.receipt],
    ['channel_state_proof', base.proof],
    ['receipt_state_transition', base.receiptTransition],
    ['standard_receipt_inbox', base.receiptInboxItem],
    ['standard_proof_inbox', base.proofInboxItem],
    ['standard_transition_inbox', base.transitionInboxItem],
    ['ledger', base.ledgerEntry],
    ['audit_bundle', base.bundle],
    ['audit_archive', base.archive],
    ['handoff_outbox', base.outbox],
    ['replay_guard', base.replayGuard],
    ['dispatch_envelope', base.dispatchEnvelope],
    ['dispatch_receipt_inbox', base.dispatchReceiptInboxItem],
    ['dispatch_proof_inbox', base.dispatchProofInboxItem],
    ['dispatch_transition_inbox', base.dispatchTransitionInboxItem],
    ['dispatch_assignment', base.dispatchAssignment],
    ['dispatch_readiness', base.dispatchReadinessReport],
  ];
  const aliasRecords = [
    ['manifest', aliasChain.manifest],
    ['preview_from_alias_manifest', aliasChain.preview],
    ['receipt_from_alias_preview', aliasChain.receipt],
    ['proof_from_alias_receipt', aliasChain.proof],
    ['transition_from_alias_proof', aliasChain.receiptTransition],
    ['standard_receipt_inbox_from_alias_receipt', aliasChain.receiptInboxItem],
    ['standard_proof_inbox_from_alias_proof', aliasChain.proofInboxItem],
    ['standard_transition_inbox_from_alias_transition', aliasChain.transitionInboxItem],
    ['ledger_from_alias_chain', aliasChain.ledgerEntry],
    ['audit_bundle_from_alias_ledger', aliasChain.bundle],
    ['audit_archive_from_alias_bundle', aliasChain.archive],
    ['handoff_outbox_from_alias_manifest_preview', aliasChain.outbox],
    ['replay_guard_from_alias_candidate', aliasChain.replayGuard],
    ['dispatch_envelope_from_alias_outbox', aliasChain.dispatchEnvelope],
    ['dispatch_receipt_inbox_from_alias_envelope', aliasChain.dispatchReceiptInboxItem],
    ['dispatch_proof_inbox_from_alias_proof', aliasChain.dispatchProofInboxItem],
    ['dispatch_transition_inbox_from_alias_transition', aliasChain.dispatchTransitionInboxItem],
    ['dispatch_assignment_from_alias_envelope', aliasChain.dispatchAssignment],
    ['dispatch_readiness_from_alias_assignment', aliasChain.dispatchReadinessReport],
  ];
  return [
    ...records.map(([surface, record]) => matrixRow({
      profile,
      surface,
      variant: 'canonical_chain',
      record,
      expectedContractHash,
      expectedMessagePreviewHash,
    })),
    ...aliasRecords.map(([surface, record]) => matrixRow({
      profile,
      surface,
      variant: 'alias_ingress',
      record,
      expectedContractHash,
      expectedMessagePreviewHash,
    })),
  ];
}

function reportHashPayload(report) {
  return {
    version: report.version,
    kind: report.kind,
    status: report.status,
    ok: report.ok,
    profiles: report.profiles,
    summary: report.summary,
    rows: report.rows,
    blockers: report.blockers,
    safety: report.safety,
  };
}

export function computeHumanFeedbackIdentityNormalizationMatrixHash(report) {
  return digest(reportHashPayload(report));
}

export function buildHumanFeedbackIdentityNormalizationMatrix({
  profiles = PROFILE_FIXTURES,
  createdAt = null,
} = {}) {
  const rows = [];
  const profileSummaries = [];
  const blockers = [];
  for (const profile of profiles) {
    const normalizedProfile = {
      ...profile,
      expectedAction: canonicalExternalAction(profile.expectedAction || profile.rawAction),
    };
    let base = null;
    let aliasChain = null;
    try {
      base = buildBaseChain(normalizedProfile);
      aliasChain = buildAliasChain(normalizedProfile, base);
      const profileRowsValue = profileRows(normalizedProfile, base, aliasChain);
      rows.push(...profileRowsValue);
      profileSummaries.push({
        id: normalizedProfile.id,
        description: normalizedProfile.description,
        rawAction: normalizedProfile.rawAction,
        rawProductLineId: normalizedProfile.rawProductLineId,
        rawWorkflowId: normalizedProfile.rawWorkflowId,
        rawPackageRole: normalizedProfile.rawPackageRole,
        expectedAction: normalizedProfile.expectedAction,
        channelId: normalizedProfile.channelId,
        contractHash: base.contract.contractHash,
        rowCount: profileRowsValue.length,
        failedRowCount: profileRowsValue.filter((row) => !row.ok).length,
      });
    } catch (error) {
      blockers.push(issue('profile_matrix_build_failed', `${normalizedProfile.id}: ${error.message}`));
      rows.push({
        profileId: normalizedProfile.id,
        surface: 'profile_build',
        variant: 'exception',
        ok: false,
        failures: ['profile_matrix_build_failed'],
        error: error.message,
      });
      profileSummaries.push({
        id: normalizedProfile.id,
        description: normalizedProfile.description,
        rawAction: normalizedProfile.rawAction,
        expectedAction: normalizedProfile.expectedAction,
        channelId: normalizedProfile.channelId,
        rowCount: 1,
        failedRowCount: 1,
      });
    }
  }
  const failedRows = rows.filter((row) => !row.ok);
  const unsafeRows = rows.filter((row) => row.unsafeSafetyCodes?.length);
  const surfaceIds = uniqueStrings(rows.map((row) => row.surface), 128);
  const variantIds = uniqueStrings(rows.map((row) => row.variant), 8);
  const summary = {
    profileCount: profileSummaries.length,
    surfaceCount: surfaceIds.length,
    variantCount: variantIds.length,
    rowCount: rows.length,
    passedRowCount: rows.length - failedRows.length,
    failedRowCount: failedRows.length,
    humanFeedbackContractBoundRows: rows.filter((row) => row.requiresHumanFeedbackRevisionContractHash && row.contractHash).length,
    messagePreviewBoundRows: rows.filter((row) => row.requiresMessagePreviewHash && row.messagePreviewHash).length,
    nonMessageRowsWithoutMessagePreviewHash: rows.filter((row) => !row.requiresMessagePreviewHash && !row.messagePreviewHash).length,
    failedSurfaces: uniqueStrings(failedRows.map((row) => row.surface), 128),
    failedProfiles: uniqueStrings(failedRows.map((row) => row.profileId), 64),
    unsafeRowCount: unsafeRows.length,
  };
  const ok = blockers.length === 0 && failedRows.length === 0 && unsafeRows.length === 0;
  const report = {
    version: HUMAN_FEEDBACK_IDENTITY_NORMALIZATION_MATRIX_VERSION,
    kind: 'HumanFeedbackIdentityNormalizationMatrix',
    status: ok ? 'passed' : 'blocked',
    ok,
    generatedAt: createdAt || new Date().toISOString(),
    profiles: profileSummaries,
    summary,
    rows,
    blockers: [
      ...blockers,
      ...failedRows.map((row) => issue('matrix_row_failed', `${row.profileId}/${row.variant}/${row.surface}: ${row.failures.join(', ')}`)),
      ...unsafeRows.map((row) => issue('matrix_row_unsafe_safety_claim', `${row.profileId}/${row.variant}/${row.surface}: ${row.unsafeSafetyCodes.join(', ')}`)),
    ],
    safety: {
      reportOnly: true,
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
      readyForExecution: false,
    },
  };
  const reportHash = computeHumanFeedbackIdentityNormalizationMatrixHash(report);
  return {
    ...report,
    reportHash,
    hash: reportHash,
  };
}

export function summarizeHumanFeedbackIdentityNormalizationMatrix(report = {}) {
  return {
    version: HUMAN_FEEDBACK_IDENTITY_NORMALIZATION_MATRIX_VERSION,
    kind: 'HumanFeedbackIdentityNormalizationMatrixSummary',
    status: report.status || 'unknown',
    ok: report.ok === true,
    reportHash: report.reportHash || null,
    humanFeedbackIdentityNormalizationMatrixHash: report.reportHash || null,
    profileCount: report.summary?.profileCount || 0,
    surfaceCount: report.summary?.surfaceCount || 0,
    rowCount: report.summary?.rowCount || 0,
    failedRowCount: report.summary?.failedRowCount || 0,
    failedProfiles: report.summary?.failedProfiles || [],
    failedSurfaces: report.summary?.failedSurfaces || [],
    safety: report.safety || null,
  };
}
