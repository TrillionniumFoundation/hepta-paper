import {
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';

function normalizedMessagePreview(messagePreview) {
  return normalizeText(messagePreview || '') || null;
}

function normalizedLowerText(value) {
  return normalizeText(value || '').toLowerCase() || null;
}

function hashOrDigest(value) {
  const normalized = normalizeText(value || '');
  if (!normalized) return null;
  if (/^sha256:[0-9a-f]{64}$/.test(normalized)) return normalized;
  return digest(normalized);
}

function optionalPackageRoleFields(value = {}) {
  const out = {};
  for (const key of ['packageRole', 'reviewType', 'role']) {
    if (Object.hasOwn(value, key)) out[key] = canonicalPackageRole(value[key]) || null;
  }
  return out;
}

export function approvalCanonicalProductLineId(value) {
  return canonicalProductLineIdOrNull(value);
}

export function approvalEvidenceRefs(values = []) {
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

export function approvalProvenanceDigest(provenance = {}) {
  if (!provenance || typeof provenance !== 'object') return null;
  const explicitApproval = provenance.explicitApproval === true
    || String(provenance.explicitApproval || '').toLowerCase() === 'true';
  const normalizedAction = canonicalExternalAction(provenance.action || '');
  const out = {
    source: normalizedLowerText(provenance.source || provenance.provider || provenance.platform || ''),
    currentChatId: normalizeText(provenance.currentChatId || provenance.chatId || provenance.sourceChatId || '') || null,
    sourceMessageId: normalizeText(
      provenance.sourceMessageId
        || provenance.messageId
        || provenance.approvalMessageId
        || provenance.evidenceId
        || '',
    ) || null,
    requesterId: normalizeText(provenance.requesterId || provenance.requester || provenance.userId || '') || null,
    capturedAt: normalizeText(provenance.capturedAt || provenance.timestamp || provenance.createdAt || '') || null,
    taskKey: normalizeText(provenance.taskKey || '') || null,
    channelId: normalizeText(provenance.channelId || '') || null,
    externalId: normalizeText(provenance.externalId || '') || null,
    action: normalizedAction === 'none' ? null : normalizedAction,
    policy: normalizeText(provenance.policy || provenance.policyProfile || '') || null,
    preflightEvidenceHash: normalizeText(provenance.preflightEvidenceHash || '') || null,
    intentEvidenceHash: normalizeText(provenance.intentEvidenceHash || '') || null,
    intentNonce: normalizeText(provenance.intentNonce || '') || null,
    approvalNonce: normalizeText(provenance.approvalNonce || provenance.nonce || '') || null,
    approvalTextHash: hashOrDigest(
      provenance.approvalTextHash
        || provenance.explicitApprovalTextHash
        || provenance.approvalText
        || provenance.explicitApprovalText
        || '',
    ),
    explicitApproval,
  };
  return Object.values(out).some((value) => value !== null && value !== false) ? out : null;
}

export function computeApprovalProvenanceHash(provenance = {}) {
  const normalized = approvalProvenanceDigest(provenance);
  return normalized ? digest(normalized) : null;
}

export function defaultApprovalProvenance({
  action,
  policy,
  taskKey,
  channelId,
  externalId,
  requestedBy,
  approvedBy,
  reason,
  createdAt,
} = {}) {
  const scope = {
    taskKey: normalizeText(taskKey || '') || null,
    channelId: normalizeText(channelId || '') || null,
    externalId: normalizeText(externalId || '') || null,
    action: canonicalExternalAction(action || ''),
    policy: normalizeText(policy || '') || null,
    requesterId: normalizeText(approvedBy || requestedBy || 'operator') || 'operator',
    capturedAt: normalizeText(createdAt || '') || null,
  };
  return approvalProvenanceDigest({
    source: 'current_chat',
    currentChatId: `local:${scope.channelId || 'unknown-channel'}`,
    sourceMessageId: `local-approval:${scope.taskKey || scope.externalId || 'unknown-task'}`,
    requesterId: scope.requesterId,
    capturedAt: scope.capturedAt,
    taskKey: scope.taskKey,
    channelId: scope.channelId,
    externalId: scope.externalId,
    action: scope.action,
    policy: scope.policy,
    intentNonce: digest({ kind: 'ApprovalIntentNonce', ...scope }),
    approvalNonce: digest({ kind: 'ApprovalNonce', ...scope }),
    approvalTextHash: digest(normalizeText(reason || `approve ${scope.action} ${scope.taskKey || scope.externalId || ''}`)),
    explicitApproval: true,
  });
}

export function approvalArtifactDigest(artifactPackage) {
  return {
    taskKey: artifactPackage?.taskKey || null,
    channelId: artifactPackage?.channelId || null,
    externalId: artifactPackage?.externalId || null,
    productLineId: approvalCanonicalProductLineId(artifactPackage?.productLineId),
    workflowId: approvalCanonicalProductLineId(artifactPackage?.workflowId),
    packageRole: canonicalPackageRole(artifactPackage?.packageRole || '') || null,
    outputMode: artifactPackage?.outputMode || null,
    submitReady: Boolean(artifactPackage?.submitReady),
    artifactCount: artifactPackage?.artifactCount || 0,
    humanFeedbackRevisionContractHash: normalizeText(
      artifactPackage?.humanFeedbackRevisionContractHash
        || artifactPackage?.humanFeedbackRevisionContract?.contractHash
        || '',
    ) || null,
    artifacts: (artifactPackage?.artifacts || []).map((artifact) => ({
      filename: normalizeText(artifact.filename || artifact.path || artifact.id || ''),
      hash: normalizeText(artifact.hash || '') || null,
      sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : null,
    })).filter((artifact) => artifact.filename),
    provenance: artifactPackage?.provenance
      ? {
        providerId: normalizeText(artifactPackage.provenance.providerId || '') || null,
        manualProvider: Boolean(artifactPackage.provenance.manualProvider),
        generatedByCore: Boolean(artifactPackage.provenance.generatedByCore),
      }
      : null,
  };
}

export function approvalReviewDigest(reviewReport) {
  if (!reviewReport) return null;
  return {
    taskKey: reviewReport.taskKey || null,
    channelId: reviewReport.channelId || null,
    externalId: reviewReport.externalId || null,
    productLineId: approvalCanonicalProductLineId(reviewReport.productLineId),
    workflowId: approvalCanonicalProductLineId(reviewReport.workflowId),
    packageRole: canonicalPackageRole(reviewReport.packageRole || '') || null,
    decision: normalizeText(reviewReport.decision || '') || null,
    ok: Boolean(reviewReport.ok),
    reviewer: normalizeText(reviewReport.reviewer || '') || null,
    humanFeedbackRevisionContractHash: normalizeText(
      reviewReport.humanFeedbackRevisionContractHash
        || reviewReport.humanFeedbackRevisionContract?.contractHash
        || '',
    ) || null,
    artifactHashes: (reviewReport.artifactHashes || []).map((artifact) => ({
      filename: normalizeText(artifact.filename || ''),
      hash: normalizeText(artifact.hash || '') || null,
      sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : null,
    })).filter((artifact) => artifact.filename),
    blockers: uniqueStrings(reviewReport.blockers || [], 32),
  };
}

export function approvalChannelTaskDigest(channelTask) {
  return {
    taskKey: channelTask?.taskKey || null,
    channelId: channelTask?.channelId || null,
    externalId: channelTask?.externalId || null,
    title: normalizeText(channelTask?.title || '') || null,
    status: normalizeText(channelTask?.status || '') || null,
    rawCategory: normalizeText(channelTask?.rawCategory || '') || null,
  };
}

export function approvalPlanDigest(plan) {
  return {
    taskKey: plan?.taskKey || null,
    channelId: plan?.channelId || null,
    externalId: plan?.externalId || null,
    productLineId: approvalCanonicalProductLineId(plan?.productLineId),
    workflowId: approvalCanonicalProductLineId(plan?.workflowId),
    outputMode: plan?.outputMode || null,
    artifactCount: Number.isFinite(Number(plan?.artifactCount)) ? Number(plan.artifactCount) : null,
    humanFeedbackRevisionContractHash: normalizeText(
      plan?.humanFeedbackRevisionContractHash
        || plan?.humanFeedbackRevisionContract?.contractHash
        || '',
    ) || null,
    designReferenceRetrievalHash: normalizeText(
      plan?.designReferenceRetrieval?.retrievalHash
        || plan?.retrievalHash
        || '',
    ) || null,
    promptCompilerHash: normalizeText(
      plan?.promptCompiler?.promptCompilerHash
        || plan?.promptCompilerHash
        || '',
    ) || null,
    promptReadinessHash: normalizeText(
      plan?.promptReadiness?.readinessHash
        || plan?.promptReadinessHash
        || '',
    ) || null,
    promptProductionContractHash: normalizeText(
      plan?.promptProductionContract?.promptProductionContractHash
        || plan?.promptProductionContractHash
        || '',
    ) || null,
    generationJobId: normalizeText(
      plan?.generationJob?.id
        || plan?.generationManifest?.id
        || '',
    ) || null,
    generationPromptProductionContractHash: normalizeText(
      plan?.generationJob?.promptProductionContractHash
        || plan?.generationManifest?.promptProductionContractHash
        || '',
    ) || null,
    qualityGates: uniqueStrings(plan?.qualityGates || [], 64),
    liveRules: plan?.liveRules
      ? {
        expectedFinalFiles: plan.liveRules.expectedFinalFiles ?? null,
        maxFilesPerSubmit: plan.liveRules.maxFilesPerSubmit ?? null,
        outputMode: plan.liveRules.outputMode || null,
      }
      : null,
  };
}

export function approvalEvidenceBundleStateDigest({
  action,
  channelTask,
  plan,
  artifactPackage,
  reviewReport,
  prepareEvidence,
  duplicatePreflight,
  messagePreview,
  deliveryArtifactBound,
  deploymentTarget,
  buildEvidence,
  evidenceRefs: refs,
}) {
  return {
    action: canonicalExternalAction(action),
    channelTask: approvalChannelTaskDigest(channelTask),
    plan: approvalPlanDigest(plan),
    artifactPackage: approvalArtifactDigest(artifactPackage),
    reviewReport: approvalReviewDigest(reviewReport),
    prepareEvidence: prepareEvidence
      ? {
        ok: prepareEvidence.ok === true,
        filenames: (prepareEvidence.filenames || prepareEvidence.uploadedFiles || prepareEvidence.files || [])
          .map((item) => normalizeText(typeof item === 'string' ? item : item?.filename || item?.name || item?.path || ''))
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right)),
      }
      : null,
    duplicatePreflight: duplicatePreflight
      ? {
        ok: duplicatePreflight.ok === true,
        totalMyWorks: Number.isFinite(Number(duplicatePreflight.totalMyWorks)) ? Number(duplicatePreflight.totalMyWorks) : null,
        existingMyWorks: Boolean(duplicatePreflight.existingMyWorks),
      }
      : null,
    messagePreview: normalizeText(messagePreview || '') || null,
    deliveryArtifactBound: Boolean(deliveryArtifactBound),
    deploymentTarget: normalizeText(deploymentTarget || '') || null,
    buildEvidence: buildEvidence
      ? {
        ok: buildEvidence.ok === true,
        buildId: normalizeText(buildEvidence.buildId || '') || null,
        target: normalizeText(buildEvidence.target || '') || null,
      }
      : null,
    evidenceRefs: approvalEvidenceRefs(refs),
  };
}

function approvalPacketPlanPayload(value) {
  return approvalPlanDigest(value);
}

function approvalPacketArtifactPayload(value) {
  return approvalArtifactDigest(value);
}

function approvalPacketReviewPayload(value) {
  return approvalReviewDigest(value);
}

function freshEvidenceBundleStatePayload(state = {}, fallbackAction = null) {
  return approvalEvidenceBundleStateDigest({
    action: state?.action || fallbackAction,
    channelTask: state?.channelTask || null,
    plan: state?.plan || null,
    artifactPackage: state?.artifactPackage || null,
    reviewReport: state?.reviewReport || null,
    prepareEvidence: state?.prepareEvidence || null,
    duplicatePreflight: state?.duplicatePreflight || null,
    messagePreview: state?.messagePreview || null,
    deliveryArtifactBound: state?.deliveryArtifactBound || false,
    deploymentTarget: state?.deploymentTarget || null,
    buildEvidence: state?.buildEvidence || null,
    evidenceRefs: state?.evidenceRefs || [],
  });
}

export function approvalPacketImmutablePayload(approval = {}) {
  const messagePreview = normalizedMessagePreview(approval.messagePreview);
  return {
    version: approval.version || 1,
    action: canonicalExternalAction(approval.action),
    policy: approval.policy,
    ok: approval.ok === true,
    status: normalizeText(approval.status || '') || null,
    approvedBy: normalizeText(approval.approvedBy || '') || null,
    expiresAt: normalizeText(approval.expiresAt || '') || null,
    taskKey: approval.taskKey || null,
    channelId: approval.channelId || null,
    externalId: approval.externalId || null,
    productLineId: approvalCanonicalProductLineId(approval.productLineId),
    workflowId: approvalCanonicalProductLineId(approval.workflowId),
    ...optionalPackageRoleFields(approval),
    reason: normalizeText(approval.reason || '') || null,
    requestedBy: normalizeText(approval.requestedBy || '') || 'operator',
    budgetUsd: Number.isFinite(Number(approval.budgetUsd)) ? Number(approval.budgetUsd) : null,
    estimatedCostUsd: Number.isFinite(Number(approval.estimatedCostUsd)) ? Number(approval.estimatedCostUsd) : null,
    channelTask: approvalChannelTaskDigest(approval.channelTask),
    plan: approvalPacketPlanPayload(approval.plan),
    artifactPackage: approvalPacketArtifactPayload(approval.artifactPackage),
    reviewReport: approvalPacketReviewPayload(approval.reviewReport),
    approvalProvenance: approvalProvenanceDigest(approval.approvalProvenance || approval.provenance),
    ...(messagePreview ? { messagePreview } : {}),
    evidenceRefs: approvalEvidenceRefs(approval.evidenceRefs || []),
  };
}

export function computeApprovalPacketHash(approval = {}) {
  return digest(approvalPacketImmutablePayload(approval));
}

export function freshEvidenceBundleImmutablePayload(evidenceBundle = {}) {
  return {
    version: evidenceBundle.version || 1,
    action: canonicalExternalAction(evidenceBundle.action),
    approvalHash: normalizeText(evidenceBundle.approvalHash || '') || null,
    ok: evidenceBundle.ok === true,
    expiresAt: normalizeText(evidenceBundle.expiresAt || '') || null,
    taskKey: evidenceBundle.taskKey || null,
    channelId: evidenceBundle.channelId || null,
    externalId: evidenceBundle.externalId || null,
    productLineId: approvalCanonicalProductLineId(evidenceBundle.productLineId),
    workflowId: approvalCanonicalProductLineId(evidenceBundle.workflowId),
    ...optionalPackageRoleFields(evidenceBundle),
    approvalProvenance: approvalProvenanceDigest(evidenceBundle.approvalProvenance || evidenceBundle.approval?.approvalProvenance),
    state: freshEvidenceBundleStatePayload(evidenceBundle.state, evidenceBundle.action),
  };
}

export function computeFreshEvidenceBundleHash(evidenceBundle = {}) {
  return digest(freshEvidenceBundleImmutablePayload(evidenceBundle));
}

export function approvalFeedbackDefaultProductLine(action) {
  return isHumanFeedbackMessageActionAlias(action) ? PRODUCT_LINE_IDS.HUMAN_FEEDBACK : null;
}
