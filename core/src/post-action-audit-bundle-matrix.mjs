import {
  CORE_STAGES,
  EXTERNAL_ACTIONS,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { buildAdapterRunReceipt } from './adapter-receipt.mjs';
import {
  buildChannelStateProof,
  buildReceiptStateTransition,
} from './channel-state-proof.mjs';
import { buildAdapterHandoffOutboxItem } from './adapter-handoff-outbox.mjs';
import { buildAdapterReceiptInboxItem } from './adapter-receipt-inbox.mjs';
import { buildChannelStateProofInboxItem } from './channel-state-proof-inbox.mjs';
import { buildReceiptStateTransitionInboxItem } from './receipt-state-transition-inbox.mjs';
import { buildExternalActionLedgerEntry } from './external-action-ledger.mjs';
import { computeExternalActionLedgerHash } from './external-action-ledger.mjs';
import { buildExternalActionAuditBundle } from './external-action-audit-bundle.mjs';
import { buildRuntimeDryRunHarnessReport } from './runtime-dry-run-harness.mjs';
import { buildPostActionEvidenceMatrixReport } from './post-action-evidence-matrix.mjs';
import { computeChannelActionManifestHash } from './action-manifest.mjs';
import { computeAdapterRunPreviewHash } from './adapter-runner.mjs';
import { digest } from './hash-utils.mjs';

export const POST_ACTION_AUDIT_BUNDLE_MATRIX_VERSION = 1;

export const POST_ACTION_AUDIT_BUNDLE_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_post_action_audit_bundle_matrix',
  FAIL: 'fail_post_action_audit_bundle_matrix',
});

const FIXED_CREATED_AT = '2026-06-08T08:40:00.000Z';

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

function hash(label, scenarioId) {
  return digest({ kind: 'post-action-audit-bundle-matrix-fixture', label, scenarioId });
}

function transitionForAction(action) {
  const canonicalAction = canonicalExternalAction(action);
  if (canonicalAction === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonicalAction === EXTERNAL_ACTIONS.MODEL_SPEND) {
    return { fromStage: CORE_STAGES.PLAN_READY, toStage: CORE_STAGES.GENERATION_READY };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_PREPARE) {
    return { fromStage: CORE_STAGES.REVIEW_READY, toStage: CORE_STAGES.PREPARE_READY };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_SUBMIT) {
    return { fromStage: CORE_STAGES.SUBMIT_READY, toStage: CORE_STAGES.SUBMITTED_VERIFIED };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) {
    return { fromStage: CORE_STAGES.DELIVERY_READY, toStage: CORE_STAGES.DELIVERY_READY };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    return { fromStage: CORE_STAGES.SUBMITTED_VERIFIED, toStage: CORE_STAGES.SUBMITTED_VERIFIED };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.DEPLOYMENT) {
    return { fromStage: CORE_STAGES.REVIEW_READY, toStage: CORE_STAGES.DELIVERY_READY };
  }
  return { fromStage: CORE_STAGES.REVIEW_READY, toStage: CORE_STAGES.REVIEW_READY };
}

function syntheticArtifactNames(scenario) {
  const count = Math.max(1, Number(scenario?.handoff?.artifactCount || 2));
  const action = canonicalExternalAction(scenario.handoff.action);
  return Array.from({ length: count }, (_, index) => `${scenario.handoff.channelId}-${token(action)}-${String(index + 1).padStart(2, '0')}.png`);
}

function previewAndManifest(scenario) {
  const handoff = scenario.handoff;
  const action = canonicalExternalAction(handoff.action);
  const productLineId = canonicalProductLineOrNull(handoff.productLineId);
  const workflowId = canonicalProductLineOrNull(handoff.workflowId);
  const packageRole = canonicalPackageRole(handoff.packageRole || '') || null;
  const isCustomerMessage = action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
  const artifactNames = syntheticArtifactNames(scenario);
  const approvalHash = hash('approval', scenario.scenarioId);
  const evidenceHash = hash('evidence', scenario.scenarioId);
  const approvalProvenanceHash = hash('approval-provenance', scenario.scenarioId);
  const humanFeedbackRevisionContractHash = normalizeText(
    scenario.hashes?.humanFeedbackRevisionContractHash
      || scenario.handoff?.humanFeedbackRevisionContractHash
      || '',
  ) || null;
  const promptGenerationBinding = scenario.handoff?.promptGenerationBinding || null;
  const messagePreviewHash = normalizeText(
    scenario.hashes?.messagePreviewHash
      || scenario.handoff?.messagePreviewHash
      || '',
  ) || null;
  const messagePreview = normalizeText(scenario.handoff?.messagePreview || '') || null;
  const transition = transitionForAction(action);
  const manifest = {
    version: 1,
    kind: 'ChannelActionManifest',
    status: 'ready_for_adapter',
    readyForAdapter: true,
    readyForExternalAction: false,
    channelId: handoff.channelId,
    actionId: handoff.actionId,
    action,
    taskKey: handoff.taskKey,
    externalId: handoff.externalId || null,
    productLineId,
    workflowId,
    adapter: {
      channelId: handoff.channelId,
      actionId: handoff.actionId,
    },
    payload: {
      externalId: handoff.externalId,
      ...(packageRole ? { packageRole } : {}),
      approvalHash,
      evidenceHash,
      approvalProvenanceHash,
      ...(promptGenerationBinding ? { promptGenerationBinding } : {}),
      transition,
      artifactNames,
      humanFeedbackRevisionContractHash,
      ...(isCustomerMessage ? { messagePreview, messagePreviewHash } : {}),
    },
  };
  const manifestHash = computeChannelActionManifestHash(manifest);
  manifest.manifestHash = manifestHash;
  manifest.hash = manifestHash;
  const preview = {
    version: 1,
    kind: 'AdapterRunPreview',
    status: 'dry_run_ready',
    readyForDryRun: true,
    readyForExecution: false,
    runnerId: 'post-action-audit-bundle-matrix.synthetic-runner',
    adapter: {
      channelId: handoff.channelId,
      actionId: handoff.actionId,
      requiredHashes: {
        manifestHash,
        approvalHash,
        evidenceHash,
        approvalProvenanceHash,
        humanFeedbackRevisionContractHash,
        ...(promptGenerationBinding ? { promptGenerationBinding } : {}),
        ...(isCustomerMessage ? { messagePreviewHash } : {}),
      },
    },
    payload: {
      action,
      taskKey: handoff.taskKey,
      externalId: handoff.externalId,
      productLineId,
      workflowId,
      ...(packageRole ? { packageRole } : {}),
      manifestHash,
      approvalHash,
      evidenceHash,
      approvalProvenanceHash,
      ...(promptGenerationBinding ? { promptGenerationBinding } : {}),
      humanFeedbackRevisionContractHash,
      ...(isCustomerMessage ? { messagePreview, messagePreviewHash } : {}),
      artifactNames,
      artifactCount: artifactNames.length,
    },
  };
  const previewHash = computeAdapterRunPreviewHash(preview);
  preview.previewHash = previewHash;
  preview.hash = previewHash;
  return {
    manifest,
    preview,
    artifactNames,
    hashes: {
      manifestHash,
      previewHash,
      approvalHash,
      evidenceHash,
      approvalProvenanceHash,
      messagePreviewHash,
      humanFeedbackRevisionContractHash,
      promptGenerationBinding,
      platformStateSnapshotHash: hash('platform-state-snapshot', scenario.scenarioId),
      dryRunReplayHash: hash('dry-run-replay', scenario.scenarioId),
    },
  };
}

function successExternalResult(action, scenarioId, artifactNames, messagePreviewHash = null, humanFeedbackRevisionContractHash = null) {
  const canonicalAction = canonicalExternalAction(action);
  const baseId = `${token(canonicalAction)}-${token(scenarioId)}`;
  if (canonicalAction === EXTERNAL_ACTIONS.PROVIDER_SPEND) {
    return { providerRunId: `provider-${baseId}`, cacheKey: `provider-cache-${baseId}`, externalResultId: `external-${baseId}` };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.MODEL_SPEND) {
    return { modelRunId: `model-${baseId}`, cacheKey: `model-cache-${baseId}`, externalResultId: `external-${baseId}` };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_PREPARE) {
    return { prepareId: `prepare-${baseId}`, externalResultId: `external-${baseId}`, prepareEvidenceOk: true, uploadedArtifactNames: artifactNames };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_SUBMIT) {
    return {
      worksId: `works-${baseId}`,
      submissionId: `submission-${baseId}`,
      externalResultId: `external-${baseId}`,
      humanFeedbackRevisionContractHash: normalizeText(humanFeedbackRevisionContractHash || '') || null,
      totalMyWorks: 1,
      worksIsHidden: true,
      buyerIsHide: false,
      uploadedArtifactNames: artifactNames,
    };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) {
    return {
      acceptanceId: `acceptance-${baseId}`,
      externalResultId: `external-${baseId}`,
      humanFeedbackRevisionContractHash: normalizeText(humanFeedbackRevisionContractHash || '') || null,
    };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    return {
      messageId: `message-${baseId}`,
      externalResultId: `external-${baseId}`,
      messagePreviewHash: normalizeText(messagePreviewHash || '') || null,
      humanFeedbackRevisionContractHash: normalizeText(humanFeedbackRevisionContractHash || '') || null,
    };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.DEPLOYMENT) {
    return {
      deploymentId: `deploy-${baseId}`,
      buildId: `build-${baseId}`,
      url: `https://hepta.example/${baseId}`,
      externalResultId: `external-${baseId}`,
      buildEvidenceOk: true,
    };
  }
  return {};
}

function successStateEvidence(action, receipt, externalResult, artifactNames) {
  const canonicalAction = canonicalExternalAction(action);
  return {
    ok: true,
    verified: true,
    landed: canonicalAction === EXTERNAL_ACTIONS.LIVE_SUBMIT || canonicalAction === EXTERNAL_ACTIONS.DEPLOYMENT,
    receiptHash: receipt.receiptHash,
    externalId: receipt.payload.externalId,
    stateText: 'synthetic post-action audit bundle proof verified',
    promptGenerationBinding: receipt.hashBinding?.promptGenerationBinding || receipt.payload?.promptGenerationBinding || null,
    artifactNames,
    artifactCount: artifactNames.length,
    totalMyWorks: externalResult.totalMyWorks,
    worksId: externalResult.worksId,
    submissionId: externalResult.submissionId,
    prepareId: externalResult.prepareId,
    acceptanceId: externalResult.acceptanceId,
    messageId: externalResult.messageId,
    messagePreviewHash: externalResult.messagePreviewHash,
    humanFeedbackRevisionContractHash: externalResult.humanFeedbackRevisionContractHash,
    deploymentId: externalResult.deploymentId,
    buildId: externalResult.buildId,
    providerRunId: externalResult.providerRunId,
    modelRunId: externalResult.modelRunId,
    cacheKey: externalResult.cacheKey,
    url: externalResult.url,
    worksIsHidden: externalResult.worksIsHidden,
    buyerIsHide: externalResult.buyerIsHide,
    prepareEvidenceOk: externalResult.prepareEvidenceOk,
    buildEvidenceOk: externalResult.buildEvidenceOk,
  };
}

function outboxFor({ preview, manifest }) {
  return buildAdapterHandoffOutboxItem({
    manifest,
    preview,
    requestedBy: 'post-action-audit-bundle-matrix.synthetic-outbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function recomputedLedgerCopy(ledger, mutate) {
  const copy = JSON.parse(JSON.stringify(ledger));
  mutate(copy);
  const ledgerHash = computeExternalActionLedgerHash(copy);
  copy.ledgerHash = ledgerHash;
  copy.hash = ledgerHash;
  return copy;
}

function auditBundleForLedger(ledgerEntry, actorSuffix) {
  return buildExternalActionAuditBundle({
    ledgerEntry,
    requireInboxChain: true,
    actor: `post-action-audit-bundle-matrix.${actorSuffix}`,
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function strippedLedgerSourceBundle(ledger, source, key, actorSuffix) {
  const strippedLedger = recomputedLedgerCopy(ledger, (copy) => {
    if (source === 'payload') delete copy.payload[key];
    if (source === 'chain') delete copy.chain[key];
  });
  return auditBundleForLedger(strippedLedger, actorSuffix);
}

function recordForScenario(scenario) {
  const { manifest, preview, artifactNames, hashes } = previewAndManifest(scenario);
  const action = canonicalExternalAction(scenario.handoff.action);
  const externalResult = successExternalResult(
    action,
    scenario.scenarioId,
    artifactNames,
    preview?.payload?.messagePreviewHash,
    preview?.payload?.humanFeedbackRevisionContractHash,
  );
  const receipt = buildAdapterRunReceipt({
    preview,
    manifest,
    resultStatus: 'success',
    externalResult,
    reportedHashes: hashes,
    runnerId: scenario.handoff.runnerId || 'post-action-audit-bundle-matrix.synthetic-runner',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
  const proof = buildChannelStateProof({
    receipt,
    stateEvidence: successStateEvidence(action, receipt, externalResult, artifactNames),
    verifierId: 'post-action-audit-bundle-matrix.synthetic-proof',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    observedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });
  const transition = buildReceiptStateTransition({
    proof,
    actor: 'post-action-audit-bundle-matrix.synthetic-transition',
    createdAt: FIXED_CREATED_AT,
  });
  const outboxItem = outboxFor({ scenario, preview, manifest, hashes });
  const receiptInboxItem = buildAdapterReceiptInboxItem({
    outboxItem,
    receipt,
    receivedBy: 'post-action-audit-bundle-matrix.receipt-inbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
  const proofInboxItem = buildChannelStateProofInboxItem({
    receiptInboxItem,
    proof,
    receipt,
    receivedBy: 'post-action-audit-bundle-matrix.proof-inbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
  const transitionInboxItem = buildReceiptStateTransitionInboxItem({
    proofInboxItem,
    transition,
    proof,
    receivedBy: 'post-action-audit-bundle-matrix.transition-inbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
  const ledger = buildExternalActionLedgerEntry({
    manifest,
    preview,
    receipt,
    proof,
    transition,
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    actor: 'post-action-audit-bundle-matrix.ledger',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
  const auditBundle = buildExternalActionAuditBundle({
    ledgerEntry: ledger,
    requireInboxChain: true,
    actor: 'post-action-audit-bundle-matrix.audit-bundle',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-bundle-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });

  const rawLedger = buildExternalActionLedgerEntry({
    manifest,
    preview,
    receipt,
    proof,
    transition,
    actor: 'post-action-audit-bundle-matrix.raw-ledger',
    createdAt: FIXED_CREATED_AT,
  });
  const rawLedgerBundle = buildExternalActionAuditBundle({
    ledgerEntry: rawLedger,
    requireInboxChain: true,
    actor: 'post-action-audit-bundle-matrix.raw-ledger-bundle',
    createdAt: FIXED_CREATED_AT,
  });
  const missingTransitionInboxLedger = buildExternalActionLedgerEntry({
    manifest,
    preview,
    receipt,
    proof,
    transition,
    receiptInboxItem,
    proofInboxItem,
    actor: 'post-action-audit-bundle-matrix.missing-transition-inbox-ledger',
    createdAt: FIXED_CREATED_AT,
  });
  const missingTransitionInboxBundle = buildExternalActionAuditBundle({
    ledgerEntry: missingTransitionInboxLedger,
    requireInboxChain: true,
    actor: 'post-action-audit-bundle-matrix.missing-transition-inbox-bundle',
    createdAt: FIXED_CREATED_AT,
  });
  const strippedPayloadApprovalProvenanceBundle = strippedLedgerSourceBundle(
    ledger,
    'payload',
    'approvalProvenanceHash',
    'stripped-payload-approval-provenance-bundle',
  );
  const strippedChainApprovalProvenanceBundle = strippedLedgerSourceBundle(
    ledger,
    'chain',
    'approvalProvenanceHash',
    'stripped-chain-approval-provenance-bundle',
  );
  const strippedPayloadMessageHashBundle = action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
    ? strippedLedgerSourceBundle(ledger, 'payload', 'messagePreviewHash', 'stripped-payload-message-hash-bundle')
    : null;
  const strippedChainMessageHashBundle = action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
    ? strippedLedgerSourceBundle(ledger, 'chain', 'messagePreviewHash', 'stripped-chain-message-hash-bundle')
    : null;
  const hasHumanFeedbackContract = Boolean(
    ledger.payload?.humanFeedbackRevisionContractHash
      || ledger.chain?.humanFeedbackRevisionContractHash,
  );
  const strippedPayloadContractHashBundle = hasHumanFeedbackContract
    ? strippedLedgerSourceBundle(ledger, 'payload', 'humanFeedbackRevisionContractHash', 'stripped-payload-contract-hash-bundle')
    : null;
  const strippedChainContractHashBundle = hasHumanFeedbackContract
    ? strippedLedgerSourceBundle(ledger, 'chain', 'humanFeedbackRevisionContractHash', 'stripped-chain-contract-hash-bundle')
    : null;
  const hasPromptGenerationBinding = Boolean(
    ledger.payload?.promptGenerationBinding
      || ledger.chain?.promptGenerationBinding,
  );
  const strippedPayloadPromptBindingBundle = hasPromptGenerationBinding
    ? strippedLedgerSourceBundle(ledger, 'payload', 'promptGenerationBinding', 'stripped-payload-prompt-binding-bundle')
    : null;
  const strippedChainPromptBindingBundle = hasPromptGenerationBinding
    ? strippedLedgerSourceBundle(ledger, 'chain', 'promptGenerationBinding', 'stripped-chain-prompt-binding-bundle')
    : null;

  const blockers = [];
  if (receiptInboxItem.status !== 'received_adapter_receipt') blockers.push(issue('receipt_inbox_not_received', scenario.scenarioId));
  if (proofInboxItem.status !== 'received_channel_state_proof') blockers.push(issue('proof_inbox_not_received', scenario.scenarioId));
  if (transitionInboxItem.status !== 'received_receipt_state_transition') blockers.push(issue('transition_inbox_not_received', scenario.scenarioId));
  if (ledger.status !== 'verified_action_ledger' || ledger.verified !== true) blockers.push(issue('ledger_not_verified', scenario.scenarioId));
  if (auditBundle.status !== 'verified_action_audit_bundle' || auditBundle.verified !== true) blockers.push(issue('audit_bundle_not_verified', scenario.scenarioId));
  if (rawLedgerBundle.status !== 'blocked_action_audit_bundle') blockers.push(issue('raw_ledger_bundle_not_blocked', scenario.scenarioId));
  if (missingTransitionInboxBundle.status !== 'blocked_action_audit_bundle') blockers.push(issue('missing_transition_inbox_bundle_not_blocked', scenario.scenarioId));
  if (!auditBundle.hashBinding.receiptInboxHash || !auditBundle.hashBinding.proofInboxHash || !auditBundle.hashBinding.transitionInboxHash) {
    blockers.push(issue('audit_bundle_inbox_hash_chain_incomplete', scenario.scenarioId));
  }
  if (!ledger.payload?.approvalProvenanceHash || !ledger.chain?.approvalProvenanceHash) {
    blockers.push(issue('audit_bundle_matrix_approval_provenance_hash_missing', scenario.scenarioId));
  }
  if (
    auditBundle.payload?.approvalProvenanceHash !== ledger.payload?.approvalProvenanceHash
    || auditBundle.hashBinding?.approvalProvenanceHash !== ledger.chain?.approvalProvenanceHash
  ) {
    blockers.push(issue('audit_bundle_matrix_approval_provenance_hash_mismatch', scenario.scenarioId));
  }
  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    if (!ledger.payload?.messagePreviewHash || !ledger.chain?.messagePreviewHash) {
      blockers.push(issue('audit_bundle_matrix_customer_message_preview_hash_missing', scenario.scenarioId));
    }
    if (auditBundle.payload?.messagePreviewHash !== ledger.payload?.messagePreviewHash
      || auditBundle.hashBinding?.messagePreviewHash !== ledger.chain?.messagePreviewHash) {
      blockers.push(issue('audit_bundle_matrix_customer_message_preview_hash_mismatch', scenario.scenarioId));
    }
  }
  if (ledger.payload?.humanFeedbackRevisionContractHash) {
    if (auditBundle.payload?.humanFeedbackRevisionContractHash !== ledger.payload.humanFeedbackRevisionContractHash
      || auditBundle.hashBinding?.humanFeedbackRevisionContractHash !== ledger.chain?.humanFeedbackRevisionContractHash) {
      blockers.push(issue('audit_bundle_matrix_human_feedback_contract_hash_mismatch', scenario.scenarioId));
    }
  }
  if (strippedPayloadApprovalProvenanceBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_payload_approval_provenance_not_blocked', scenario.scenarioId));
  }
  if (strippedChainApprovalProvenanceBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_chain_approval_provenance_not_blocked', scenario.scenarioId));
  }
  if (strippedPayloadMessageHashBundle && strippedPayloadMessageHashBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_payload_message_hash_not_blocked', scenario.scenarioId));
  }
  if (strippedChainMessageHashBundle && strippedChainMessageHashBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_chain_message_hash_not_blocked', scenario.scenarioId));
  }
  if (strippedPayloadContractHashBundle && strippedPayloadContractHashBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_payload_contract_hash_not_blocked', scenario.scenarioId));
  }
  if (strippedChainContractHashBundle && strippedChainContractHashBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_chain_contract_hash_not_blocked', scenario.scenarioId));
  }
  if (strippedPayloadPromptBindingBundle && strippedPayloadPromptBindingBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_payload_prompt_binding_not_blocked', scenario.scenarioId));
  }
  if (strippedChainPromptBindingBundle && strippedChainPromptBindingBundle.status !== 'blocked_action_audit_bundle') {
    blockers.push(issue('audit_bundle_matrix_stripped_chain_prompt_binding_not_blocked', scenario.scenarioId));
  }

  const row = {
    scenarioId: scenario.scenarioId,
    channelId: scenario.handoff.channelId,
    actionId: scenario.handoff.actionId,
    action,
    productLineId: canonicalProductLineOrNull(scenario.handoff.productLineId),
    workflowId: canonicalProductLineOrNull(scenario.handoff.workflowId),
    packageRole: canonicalPackageRole(ledger.payload?.packageRole || scenario.handoff.packageRole || '') || null,
    approvalProvenanceHash: ledger.payload?.approvalProvenanceHash || null,
    messagePreviewHash: ledger.payload?.messagePreviewHash || null,
    humanFeedbackRevisionContractHash: ledger.payload?.humanFeedbackRevisionContractHash || null,
    promptGenerationBindingPresent: hasPromptGenerationBinding,
    receiptInboxStatus: receiptInboxItem.status,
    proofInboxStatus: proofInboxItem.status,
    transitionInboxStatus: transitionInboxItem.status,
    ledgerStatus: ledger.status,
    ledgerHash: ledger.ledgerHash,
    auditBundleStatus: auditBundle.status,
    auditBundleHash: auditBundle.bundleHash,
    rawLedgerBundleStatus: rawLedgerBundle.status,
    rawLedgerBundleBlockers: uniqueStrings(rawLedgerBundle.blockers.map((item) => item.code), 32),
    missingTransitionInboxBundleStatus: missingTransitionInboxBundle.status,
    missingTransitionInboxBundleBlockers: uniqueStrings(missingTransitionInboxBundle.blockers.map((item) => item.code), 32),
    strippedPayloadApprovalProvenanceBundleStatus: strippedPayloadApprovalProvenanceBundle.status,
    strippedPayloadApprovalProvenanceBundleBlockers: uniqueStrings(strippedPayloadApprovalProvenanceBundle.blockers.map((item) => item.code), 32),
    strippedChainApprovalProvenanceBundleStatus: strippedChainApprovalProvenanceBundle.status,
    strippedChainApprovalProvenanceBundleBlockers: uniqueStrings(strippedChainApprovalProvenanceBundle.blockers.map((item) => item.code), 32),
    strippedPayloadMessageHashBundleStatus: strippedPayloadMessageHashBundle?.status || null,
    strippedPayloadMessageHashBundleBlockers: uniqueStrings((strippedPayloadMessageHashBundle?.blockers || []).map((item) => item.code), 32),
    strippedChainMessageHashBundleStatus: strippedChainMessageHashBundle?.status || null,
    strippedChainMessageHashBundleBlockers: uniqueStrings((strippedChainMessageHashBundle?.blockers || []).map((item) => item.code), 32),
    strippedPayloadContractHashBundleStatus: strippedPayloadContractHashBundle?.status || null,
    strippedPayloadContractHashBundleBlockers: uniqueStrings((strippedPayloadContractHashBundle?.blockers || []).map((item) => item.code), 32),
    strippedChainContractHashBundleStatus: strippedChainContractHashBundle?.status || null,
    strippedChainContractHashBundleBlockers: uniqueStrings((strippedChainContractHashBundle?.blockers || []).map((item) => item.code), 32),
    strippedPayloadPromptBindingBundleStatus: strippedPayloadPromptBindingBundle?.status || null,
    strippedPayloadPromptBindingBundleBlockers: uniqueStrings((strippedPayloadPromptBindingBundle?.blockers || []).map((item) => item.code), 32),
    strippedChainPromptBindingBundleStatus: strippedChainPromptBindingBundle?.status || null,
    strippedChainPromptBindingBundleBlockers: uniqueStrings((strippedChainPromptBindingBundle?.blockers || []).map((item) => item.code), 32),
    inboxHashesPresent: Boolean(auditBundle.hashBinding.receiptInboxHash && auditBundle.hashBinding.proofInboxHash && auditBundle.hashBinding.transitionInboxHash),
    blockers,
  };
  return {
    scenario,
    row,
    manifest,
    preview,
    receipt,
    proof,
    transition,
    outboxItem,
    receiptInboxItem,
    proofInboxItem,
    transitionInboxItem,
    ledger,
    auditBundle,
    rawLedger,
    rawLedgerBundle,
    missingTransitionInboxLedger,
    missingTransitionInboxBundle,
  };
}

export function buildPostActionAuditBundleMatrixRecords() {
  const runtimeReport = buildRuntimeDryRunHarnessReport({ generatedAt: FIXED_CREATED_AT });
  const postActionEvidenceMatrix = buildPostActionEvidenceMatrixReport({ generatedAt: FIXED_CREATED_AT });
  const readyScenarios = (runtimeReport.scenarios || []).filter((scenario) => scenario.readyForExternalRunner === true);
  return {
    runtimeReport,
    postActionEvidenceMatrix,
    readyScenarios,
    records: readyScenarios.map(recordForScenario),
  };
}

export function buildPostActionAuditBundleMatrixReport({ generatedAt = new Date().toISOString() } = {}) {
  const {
    runtimeReport,
    postActionEvidenceMatrix,
    records,
  } = buildPostActionAuditBundleMatrixRecords();
  const rows = records.map((record) => record.row);
  const blockers = [
    ...(runtimeReport.ok === true ? [] : [issue('runtime_dry_run_harness_not_ready')]),
    ...(postActionEvidenceMatrix.ok === true ? [] : [issue('post_action_evidence_matrix_not_ready')]),
    ...rows.flatMap((row) => row.blockers),
  ];
  const actionClasses = uniqueStrings(rows.map((row) => row.action), 32);
  const summary = {
    routeCount: rows.length,
    actionClassCount: actionClasses.length,
    actionClasses,
    receiptInboxReceivedCount: rows.filter((row) => row.receiptInboxStatus === 'received_adapter_receipt').length,
    proofInboxReceivedCount: rows.filter((row) => row.proofInboxStatus === 'received_channel_state_proof').length,
    transitionInboxReceivedCount: rows.filter((row) => row.transitionInboxStatus === 'received_receipt_state_transition').length,
    verifiedLedgerCount: rows.filter((row) => row.ledgerStatus === 'verified_action_ledger').length,
    verifiedAuditBundleCount: rows.filter((row) => row.auditBundleStatus === 'verified_action_audit_bundle').length,
    rawLedgerBundleBlockedCount: rows.filter((row) => row.rawLedgerBundleStatus === 'blocked_action_audit_bundle').length,
    missingTransitionInboxBundleBlockedCount: rows.filter((row) => row.missingTransitionInboxBundleStatus === 'blocked_action_audit_bundle').length,
    inboxHashChainPresentCount: rows.filter((row) => row.inboxHashesPresent === true).length,
    packageRoleRouteCount: rows.filter((row) => row.packageRole).length,
    approvalProvenanceHashBoundRouteCount: rows.filter((row) => row.approvalProvenanceHash).length,
    customerMessageHashBoundRouteCount: rows.filter((row) => canonicalExternalAction(row.action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE && row.messagePreviewHash).length,
    humanFeedbackContractBoundRouteCount: rows.filter((row) => row.humanFeedbackRevisionContractHash).length,
    humanFeedbackPackageRoleBoundRouteCount: rows.filter((row) => (
      row.humanFeedbackRevisionContractHash && row.packageRole
    )).length,
    promptGenerationBindingRouteCount: rows.filter((row) => row.promptGenerationBindingPresent === true).length,
    strippedPayloadApprovalProvenanceBundleBlockedCount: rows.filter((row) => row.strippedPayloadApprovalProvenanceBundleStatus === 'blocked_action_audit_bundle').length,
    strippedChainApprovalProvenanceBundleBlockedCount: rows.filter((row) => row.strippedChainApprovalProvenanceBundleStatus === 'blocked_action_audit_bundle').length,
    strippedPayloadMessageHashBundleBlockedCount: rows.filter((row) => row.strippedPayloadMessageHashBundleStatus === 'blocked_action_audit_bundle').length,
    strippedChainMessageHashBundleBlockedCount: rows.filter((row) => row.strippedChainMessageHashBundleStatus === 'blocked_action_audit_bundle').length,
    strippedPayloadContractHashBundleBlockedCount: rows.filter((row) => row.strippedPayloadContractHashBundleStatus === 'blocked_action_audit_bundle').length,
    strippedChainContractHashBundleBlockedCount: rows.filter((row) => row.strippedChainContractHashBundleStatus === 'blocked_action_audit_bundle').length,
    strippedPayloadPromptBindingBundleBlockedCount: rows.filter((row) => row.strippedPayloadPromptBindingBundleStatus === 'blocked_action_audit_bundle').length,
    strippedChainPromptBindingBundleBlockedCount: rows.filter((row) => row.strippedChainPromptBindingBundleStatus === 'blocked_action_audit_bundle').length,
    routeBlockerCount: rows.reduce((sum, row) => sum + row.blockers.length, 0),
  };
  if (summary.routeCount !== 20) blockers.push(issue('post_action_audit_bundle_matrix_route_count_unexpected', `${summary.routeCount}/20`));
  if (summary.actionClassCount !== 7) blockers.push(issue('post_action_audit_bundle_matrix_action_class_count_unexpected', `${summary.actionClassCount}/7`));
  if (summary.packageRoleRouteCount !== rows.length) blockers.push(issue('post_action_audit_bundle_package_role_not_bound', `${summary.packageRoleRouteCount}/${rows.length}`));
  if (summary.approvalProvenanceHashBoundRouteCount !== rows.length) blockers.push(issue(
    'post_action_audit_bundle_approval_provenance_hash_not_bound',
    `${summary.approvalProvenanceHashBoundRouteCount}/${rows.length}`,
  ));
  const customerMessageRows = rows.filter((row) => canonicalExternalAction(row.action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
  const humanFeedbackRows = rows.filter((row) => row.humanFeedbackRevisionContractHash);
  if (summary.strippedPayloadApprovalProvenanceBundleBlockedCount !== rows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_payload_approval_provenance_not_blocked',
    `${summary.strippedPayloadApprovalProvenanceBundleBlockedCount}/${rows.length}`,
  ));
  if (summary.strippedChainApprovalProvenanceBundleBlockedCount !== rows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_chain_approval_provenance_not_blocked',
    `${summary.strippedChainApprovalProvenanceBundleBlockedCount}/${rows.length}`,
  ));
  if (summary.customerMessageHashBoundRouteCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_audit_bundle_customer_message_preview_hash_not_bound',
    `${summary.customerMessageHashBoundRouteCount}/${customerMessageRows.length}`,
  ));
  if (summary.humanFeedbackContractBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_bundle_human_feedback_contract_hash_not_bound',
    `${summary.humanFeedbackContractBoundRouteCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.humanFeedbackPackageRoleBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_bundle_human_feedback_package_role_not_bound',
    `${summary.humanFeedbackPackageRoleBoundRouteCount}/${humanFeedbackRows.length}`,
  ));
  const promptGenerationRows = rows.filter((row) => row.promptGenerationBindingPresent === true);
  if (summary.strippedPayloadMessageHashBundleBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_payload_message_hash_not_blocked',
    `${summary.strippedPayloadMessageHashBundleBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedChainMessageHashBundleBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_chain_message_hash_not_blocked',
    `${summary.strippedChainMessageHashBundleBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadContractHashBundleBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_payload_contract_hash_not_blocked',
    `${summary.strippedPayloadContractHashBundleBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedChainContractHashBundleBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_chain_contract_hash_not_blocked',
    `${summary.strippedChainContractHashBundleBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingBundleBlockedCount !== promptGenerationRows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_payload_prompt_binding_not_blocked',
    `${summary.strippedPayloadPromptBindingBundleBlockedCount}/${promptGenerationRows.length}`,
  ));
  if (summary.strippedChainPromptBindingBundleBlockedCount !== promptGenerationRows.length) blockers.push(issue(
    'post_action_audit_bundle_stripped_chain_prompt_binding_not_blocked',
    `${summary.strippedChainPromptBindingBundleBlockedCount}/${promptGenerationRows.length}`,
  ));
  const status = blockers.length
    ? POST_ACTION_AUDIT_BUNDLE_MATRIX_STATUS.FAIL
    : POST_ACTION_AUDIT_BUNDLE_MATRIX_STATUS.PASS;
  const matrixHash = digest({
    version: POST_ACTION_AUDIT_BUNDLE_MATRIX_VERSION,
    status,
    summary,
    rows: rows.map((row) => ({
      scenarioId: row.scenarioId,
      channelId: row.channelId,
      actionId: row.actionId,
      action: row.action,
      productLineId: row.productLineId,
      workflowId: row.workflowId,
      packageRole: row.packageRole,
      approvalProvenanceHash: row.approvalProvenanceHash,
      messagePreviewHash: row.messagePreviewHash,
      humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
      promptGenerationBindingPresent: row.promptGenerationBindingPresent,
      receiptInboxStatus: row.receiptInboxStatus,
      proofInboxStatus: row.proofInboxStatus,
      transitionInboxStatus: row.transitionInboxStatus,
      ledgerStatus: row.ledgerStatus,
      auditBundleStatus: row.auditBundleStatus,
      rawLedgerBundleStatus: row.rawLedgerBundleStatus,
      rawLedgerBundleBlockers: row.rawLedgerBundleBlockers,
      missingTransitionInboxBundleStatus: row.missingTransitionInboxBundleStatus,
      missingTransitionInboxBundleBlockers: row.missingTransitionInboxBundleBlockers,
      strippedPayloadApprovalProvenanceBundleStatus: row.strippedPayloadApprovalProvenanceBundleStatus,
      strippedPayloadApprovalProvenanceBundleBlockers: row.strippedPayloadApprovalProvenanceBundleBlockers,
      strippedChainApprovalProvenanceBundleStatus: row.strippedChainApprovalProvenanceBundleStatus,
      strippedChainApprovalProvenanceBundleBlockers: row.strippedChainApprovalProvenanceBundleBlockers,
      strippedPayloadMessageHashBundleStatus: row.strippedPayloadMessageHashBundleStatus,
      strippedPayloadMessageHashBundleBlockers: row.strippedPayloadMessageHashBundleBlockers,
      strippedChainMessageHashBundleStatus: row.strippedChainMessageHashBundleStatus,
      strippedChainMessageHashBundleBlockers: row.strippedChainMessageHashBundleBlockers,
      strippedPayloadContractHashBundleStatus: row.strippedPayloadContractHashBundleStatus,
      strippedPayloadContractHashBundleBlockers: row.strippedPayloadContractHashBundleBlockers,
      strippedChainContractHashBundleStatus: row.strippedChainContractHashBundleStatus,
      strippedChainContractHashBundleBlockers: row.strippedChainContractHashBundleBlockers,
      strippedPayloadPromptBindingBundleStatus: row.strippedPayloadPromptBindingBundleStatus,
      strippedPayloadPromptBindingBundleBlockers: row.strippedPayloadPromptBindingBundleBlockers,
      strippedChainPromptBindingBundleStatus: row.strippedChainPromptBindingBundleStatus,
      strippedChainPromptBindingBundleBlockers: row.strippedChainPromptBindingBundleBlockers,
      blockerCodes: row.blockers.map((item) => item.code),
    })),
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    blockers,
  });
  return {
    version: POST_ACTION_AUDIT_BUNDLE_MATRIX_VERSION,
    kind: 'PostActionAuditBundleMatrixReport',
    status,
    ok: blockers.length === 0,
    generatedAt,
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    summary,
    rows,
    blockers,
    safety: {
      syntheticFixturesOnly: true,
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
      grantsExecutionPermission: false,
    },
    postActionAuditBundleMatrixHash: matrixHash,
    hash: matrixHash,
  };
}
