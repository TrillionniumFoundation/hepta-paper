import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  channelCapabilities,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  computeCustomerMessagePreviewHash,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import {
  approvalPlanDigest,
  approvalProvenanceDigest,
  computeApprovalPacketHash,
  computeFreshEvidenceBundleHash,
} from './approval-evidence-hashes.mjs';
import {
  humanFeedbackPrimaryRevisionContractFor,
  humanFeedbackRevisionContractFor,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackWorkflow,
  validateHumanFeedbackRevisionContract,
} from './human-feedback-contracts.mjs';
import { validateGenerationJob } from './generation-contracts.mjs';

export const EXECUTION_GATE_VERSION = 1;

export const EXECUTION_POLICIES = Object.freeze({
  SAFE_PLAN: 'safe-plan',
  SPEND_ALLOWED: 'spend-allowed',
  PREPARE_ALLOWED: 'prepare-allowed',
  SUBMIT_ALLOWED: 'submit-allowed',
  ACCEPTANCE_ALLOWED: 'acceptance-allowed',
  DEPLOYMENT_ALLOWED: 'deployment-allowed',
});

export const EXECUTION_GATE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  NEEDS_APPROVAL: 'needs_approval',
  BLOCKED: 'blocked',
});

const ACTION_POLICY = Object.freeze({
  [EXECUTION_POLICIES.SAFE_PLAN]: Object.freeze([EXTERNAL_ACTIONS.NONE]),
  [EXECUTION_POLICIES.SPEND_ALLOWED]: Object.freeze([
    EXTERNAL_ACTIONS.NONE,
    EXTERNAL_ACTIONS.PROVIDER_SPEND,
    EXTERNAL_ACTIONS.MODEL_SPEND,
  ]),
  [EXECUTION_POLICIES.PREPARE_ALLOWED]: Object.freeze([
    EXTERNAL_ACTIONS.NONE,
    EXTERNAL_ACTIONS.LIVE_PREPARE,
  ]),
  [EXECUTION_POLICIES.SUBMIT_ALLOWED]: Object.freeze([
    EXTERNAL_ACTIONS.NONE,
    EXTERNAL_ACTIONS.LIVE_SUBMIT,
    EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  ]),
  [EXECUTION_POLICIES.ACCEPTANCE_ALLOWED]: Object.freeze([
    EXTERNAL_ACTIONS.NONE,
    EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  ]),
  [EXECUTION_POLICIES.DEPLOYMENT_ALLOWED]: Object.freeze([
    EXTERNAL_ACTIONS.NONE,
    EXTERNAL_ACTIONS.DEPLOYMENT,
  ]),
});

const APPROVAL_ONLY_CODES = new Set([
  'approval_required',
  'fresh_evidence_required',
  'evidence_hash_required',
]);
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function knownActions() {
  return Object.values(EXTERNAL_ACTIONS);
}

function allowedActionsForPolicy(policy) {
  return ACTION_POLICY[policy] || [];
}

function evidenceRefs(values = []) {
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

function artifactNames(artifactPackage) {
  return (artifactPackage?.artifacts || [])
    .map((artifact) => normalizeText(artifact.filename || artifact.path || artifact.id || ''))
    .filter(Boolean);
}

function sortedValues(values = []) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameNameSet(left = [], right = []) {
  const leftSorted = sortedValues(left);
  const rightSorted = sortedValues(right);
  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
}

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes) || null,
  };
}

function timeMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizedMessagePreview(messagePreview) {
  return normalizeText(messagePreview || '') || null;
}

function messagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function hasApproval(approval) {
  return Boolean(normalizeText(approval?.approvalHash || ''));
}

function approvalHash(approval) {
  return normalizeText(approval?.approvalHash || '');
}

function evidenceHash(evidenceBundle) {
  return normalizeText(evidenceBundle?.evidenceHash || '');
}

function isSha256Hash(value) {
  return SHA256_HASH_PATTERN.test(normalizeText(value || ''));
}

function reviewMatchesPackage(reviewReport, artifactPackage) {
  if (!reviewReport?.artifactHashes?.length || !artifactPackage?.artifacts?.length) return true;
  const packageByName = new Map(artifactPackage.artifacts.map((artifact) => [artifact.filename, artifact]));
  for (const reviewed of reviewReport.artifactHashes) {
    const current = packageByName.get(reviewed.filename);
    if (!current) return false;
    if (reviewed.hash && current.hash && reviewed.hash !== current.hash) return false;
    if (Number.isFinite(Number(reviewed.sizeBytes)) && Number.isFinite(Number(current.sizeBytes)) && Number(reviewed.sizeBytes) !== Number(current.sizeBytes)) return false;
  }
  return true;
}

function hashedArtifactName(artifact = {}) {
  return normalizeText(artifact.filename || artifact.path || artifact.id || '');
}

function reviewFullyMatchesPackage(reviewReport, artifactPackage) {
  const packageArtifacts = artifactPackage?.artifacts || [];
  const reviewedArtifacts = reviewReport?.artifactHashes || [];
  if (!packageArtifacts.length || !reviewedArtifacts.length) return false;
  const packageNames = packageArtifacts.map(hashedArtifactName).filter(Boolean);
  const reviewedNames = reviewedArtifacts.map(hashedArtifactName).filter(Boolean);
  if (!sameNameSet(packageNames, reviewedNames)) return false;
  const reviewedByName = new Map(reviewedArtifacts.map((artifact) => [hashedArtifactName(artifact), artifact]));
  for (const artifact of packageArtifacts) {
    const name = hashedArtifactName(artifact);
    const reviewed = reviewedByName.get(name);
    if (!name || !reviewed) return false;
    if (!isSha256Hash(artifact.hash) || !isSha256Hash(reviewed.hash)) return false;
    if (artifact.hash !== reviewed.hash) return false;
    if (
      Number.isFinite(Number(artifact.sizeBytes))
      && Number.isFinite(Number(reviewed.sizeBytes))
      && Number(artifact.sizeBytes) !== Number(reviewed.sizeBytes)
    ) {
      return false;
    }
  }
  return true;
}

function comparableArtifactEntries(values = []) {
  return (values || [])
    .map((artifact) => ({
      name: hashedArtifactName(artifact),
      hash: normalizeText(artifact?.hash || '') || null,
      sizeBytes: Number.isFinite(Number(artifact?.sizeBytes)) ? Number(artifact.sizeBytes) : null,
    }))
    .filter((artifact) => artifact.name);
}

function artifactEntriesMatchCurrent(snapshotEntries = [], currentEntries = []) {
  if (!currentEntries.length || !snapshotEntries.length) return false;
  if (!sameNameSet(
    currentEntries.map((artifact) => artifact.name),
    snapshotEntries.map((artifact) => artifact.name),
  )) {
    return false;
  }
  const snapshotByName = new Map(snapshotEntries.map((artifact) => [artifact.name, artifact]));
  for (const current of currentEntries) {
    const snapshot = snapshotByName.get(current.name);
    if (!snapshot) return false;
    if (!isSha256Hash(current.hash) || !isSha256Hash(snapshot.hash)) return false;
    if (current.hash !== snapshot.hash) return false;
    if (
      current.sizeBytes !== null
      && snapshot.sizeBytes !== null
      && current.sizeBytes !== snapshot.sizeBytes
    ) {
      return false;
    }
  }
  return true;
}

function approvalContractHashes(approval = {}) {
  return uniqueStrings([
    approval?.plan?.humanFeedbackRevisionContractHash,
    approval?.artifactPackage?.humanFeedbackRevisionContractHash,
    approval?.reviewReport?.humanFeedbackRevisionContractHash,
  ], 8);
}

function evidenceContractHashes(evidenceBundle = {}) {
  return uniqueStrings([
    evidenceBundle?.state?.plan?.humanFeedbackRevisionContractHash,
    evidenceBundle?.state?.artifactPackage?.humanFeedbackRevisionContractHash,
    evidenceBundle?.state?.reviewReport?.humanFeedbackRevisionContractHash,
  ], 8);
}

function valueLooksHumanFeedback(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || isHumanFeedbackWorkflow(value);
}

function recordLooksHumanFeedback(record = {}) {
  return [
    record?.productLineId,
    record?.workflowId,
    record?.packageRole,
    record?.reviewType,
    record?.role,
  ].some(valueLooksHumanFeedback);
}

function contractHashBindingBlockers({ contractHash, hashes, missingCode, mismatchCode }) {
  if (!contractHash) return [];
  if (!hashes.length) return [issue(missingCode)];
  if (hashes.some((hash) => hash !== contractHash)) {
    return [issue(mismatchCode, hashes.join(', '))];
  }
  return [];
}

function requiredContractHashBindingBlockers({ contractHash, entries = [] }) {
  if (!contractHash) return [];
  const blockers = [];
  for (const { hash, missingCode, mismatchCode } of entries) {
    const normalized = normalizeText(hash || '');
    if (!normalized) blockers.push(issue(missingCode));
    else if (normalized !== contractHash) blockers.push(issue(mismatchCode, normalized));
  }
  return blockers;
}

function messagePreviewBindingBlockers({
  currentPreview,
  boundPreview,
  missingCode,
  mismatchCode,
}) {
  const current = normalizedMessagePreview(currentPreview);
  if (!current) return [];
  const bound = normalizedMessagePreview(boundPreview);
  if (!bound) return [issue(missingCode)];
  if (bound !== current) return [issue(mismatchCode)];
  return [];
}

function humanFeedbackRecordIdentityBlockers(record, label, request) {
  if (!record) return [];
  const blockers = [];
  for (const [field, suffix] of [
    ['taskKey', 'task'],
    ['channelId', 'channel'],
    ['externalId', 'external_id'],
  ]) {
    const expected = normalizeText(request?.[field] || '');
    const actual = normalizeText(record?.[field] || '');
    if (!expected) continue;
    if (!actual) {
      blockers.push(issue(`human_feedback_${label}_${suffix}_required`, expected));
    } else if (actual !== expected) {
      blockers.push(issue(
        `human_feedback_${label}_${suffix}_mismatch`,
        `expected ${expected}, got ${actual}`,
      ));
    }
  }
  return blockers;
}

function exactScopeBindingBlockers(record, label, request) {
  const blockers = [];
  for (const [field, suffix] of [
    ['taskKey', 'task'],
    ['channelId', 'channel'],
    ['externalId', 'external_id'],
  ]) {
    const expected = normalizeText(request?.[field] || '');
    if (!expected) continue;
    const actual = normalizeText(record?.[field] || '');
    if (!actual) {
      blockers.push(issue(`${label}_${suffix}_required`, expected));
    } else if (actual !== expected) {
      blockers.push(issue(`${label}_${suffix}_mismatch`, `expected ${expected}, got ${actual}`));
    }
  }
  return blockers;
}

function valueFlagged(value) {
  if (value === true) return true;
  const normalized = normalizeText(value || '').toLowerCase();
  return ['true', 'yes', 'allow', 'allowed', 'granted', '1'].includes(normalized);
}

function disallowedApprovalBoundaryBlockers(approval = {}) {
  const disallowedGroups = [
    {
      code: 'approval_standing_authorization_rejected',
      keys: ['standingAuthorization', 'standingApproval', 'standingAuth'],
    },
    {
      code: 'approval_inherited_authorization_rejected',
      keys: ['inheritedAuthorization', 'inheritedApproval', 'inheritedAuth'],
    },
    {
      code: 'approval_broad_batch_authorization_rejected',
      keys: ['broadAuthorization', 'broadBatchApproval', 'batchAuthorization', 'batchApproval', 'broadScope'],
    },
    {
      code: 'approval_forwardable_rejected',
      keys: ['forwardable', 'canForward', 'transferable'],
    },
    {
      code: 'approval_replayable_rejected',
      keys: ['replayable', 'canReplay', 'reusable', 'multiUse'],
    },
    {
      code: 'approval_background_runner_consumption_rejected',
      keys: ['backgroundRunnerConsumable', 'backgroundConsumable', 'backgroundRunnerMayConsume'],
    },
  ];
  return disallowedGroups.flatMap(({ code, keys }) => {
    const flaggedKey = keys.find((key) => valueFlagged(approval?.[key]));
    return flaggedKey ? [issue(code, flaggedKey)] : [];
  });
}

function sameCanonicalJson(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function approvalProvenanceBlockers(approval = {}, { action, policy, taskKey, channelId, externalId, createdAt } = {}) {
  if (approval.kind !== 'ApprovalPacket' || approval.ok !== true) return [];
  const blockers = [];
  const provenance = approvalProvenanceDigest(approval.approvalProvenance || approval.provenance);
  if (!provenance) {
    blockers.push(issue('approval_current_chat_provenance_required'));
    return blockers;
  }
  const requiredFields = [
    ['source', 'approval_source_required'],
    ['currentChatId', 'approval_current_chat_id_required'],
    ['sourceMessageId', 'approval_source_message_required'],
    ['requesterId', 'approval_requester_identity_required'],
    ['capturedAt', 'approval_source_timestamp_required'],
    ['intentNonce', 'approval_intent_nonce_required'],
    ['approvalNonce', 'approval_nonce_required'],
    ['approvalTextHash', 'approval_explicit_text_hash_required'],
  ];
  for (const [field, code] of requiredFields) {
    if (!normalizeText(provenance[field] || '')) blockers.push(issue(code));
  }
  if (provenance.explicitApproval !== true) {
    blockers.push(issue('approval_explicit_wording_required'));
  }
  if (provenance.approvalTextHash && !isSha256Hash(provenance.approvalTextHash)) {
    blockers.push(issue('approval_explicit_text_hash_invalid'));
  }
  const capturedAtMs = timeMs(provenance.capturedAt);
  const evaluationMs = timeMs(createdAt || new Date().toISOString());
  if (provenance.capturedAt && capturedAtMs === null) {
    blockers.push(issue('approval_source_timestamp_invalid'));
  } else if (capturedAtMs !== null && evaluationMs !== null && capturedAtMs > evaluationMs) {
    blockers.push(issue('approval_source_timestamp_in_future'));
  }
  const scopeChecks = [
    ['taskKey', taskKey, 'approval_provenance_task_mismatch'],
    ['channelId', channelId, 'approval_provenance_channel_mismatch'],
    ['externalId', externalId, 'approval_provenance_external_id_mismatch'],
    ['policy', policy, 'approval_provenance_policy_mismatch'],
  ];
  for (const [field, expectedRaw, code] of scopeChecks) {
    const expected = normalizeText(expectedRaw || '');
    const actual = normalizeText(provenance[field] || '');
    if (expected && actual && expected !== actual) blockers.push(issue(code, `expected ${expected}, got ${actual}`));
  }
  const provenanceAction = canonicalExternalAction(provenance.action || EXTERNAL_ACTIONS.NONE);
  if (action && provenanceAction && provenanceAction !== action) {
    blockers.push(issue('approval_provenance_action_mismatch', `expected ${action}, got ${provenance.action}`));
  }
  return blockers;
}

function capabilityForAction(channelTask, action) {
  const capabilities = channelTask?.channelCapabilities || channelCapabilities(channelTask?.channelId);
  if (action === EXTERNAL_ACTIONS.LIVE_PREPARE) return capabilities.prepare_only;
  if (action === EXTERNAL_ACTIONS.LIVE_SUBMIT) return capabilities.submit;
  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) return capabilities.message;
  if (action === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) return capabilities.acceptance;
  if (action === EXTERNAL_ACTIONS.DEPLOYMENT) return channelTask?.channelId === 'hepta' || channelTask?.channelId === 'manual';
  return true;
}

function decisionFromBlockers(blockers) {
  if (!blockers.length) return EXECUTION_GATE_DECISIONS.ALLOW;
  if (blockers.every((blocker) => APPROVAL_ONLY_CODES.has(blocker.code))) return EXECUTION_GATE_DECISIONS.NEEDS_APPROVAL;
  return EXECUTION_GATE_DECISIONS.BLOCKED;
}

function validateApproval({ action, policy, approval, estimatedCostUsd, taskKey, channelId, externalId, createdAt }) {
  const blockers = [];
  if (!approval) {
    blockers.push(issue('approval_required'));
    return blockers;
  }
  if (approval.kind !== 'ApprovalPacket') {
    blockers.push(issue('approval_packet_required'));
  }
  const semanticApprovalHash = approvalHash(approval);
  if (approval.kind === 'ApprovalPacket') {
    const genericHash = normalizeText(approval.hash || '');
    if (!genericHash) blockers.push(issue('approval_generic_hash_required'));
    if (semanticApprovalHash && genericHash && semanticApprovalHash !== genericHash) {
      blockers.push(issue('approval_hash_alias_mismatch'));
    }
  }
  if (!semanticApprovalHash) {
    blockers.push(issue('approval_hash_required'));
    return blockers;
  }
  const approvalAction = canonicalExternalAction(approval.action || EXTERNAL_ACTIONS.NONE);
  if (approval.kind === 'ApprovalPacket' && approval.action && approval.action !== approvalAction) {
    blockers.push(issue('approval_action_not_canonical', `expected ${approvalAction}, got ${approval.action}`));
  }
  if (approval.revoked || approval.consumed) blockers.push(issue('approval_unavailable'));
  if (approval.kind === 'ApprovalPacket' && computeApprovalPacketHash(approval) !== semanticApprovalHash) {
    blockers.push(issue('approval_hash_mismatch'));
  }
  if (approval.ok !== true) blockers.push(issue('approval_not_granted'));
  if (approval.kind === 'ApprovalPacket' && approval.ok === true) {
    const expiresAt = normalizeText(approval.expiresAt || '');
    if (!expiresAt) {
      blockers.push(issue('approval_expiry_required'));
    } else {
      const expiryMs = timeMs(expiresAt);
      const nowMs = timeMs(createdAt || new Date().toISOString());
      if (expiryMs === null) blockers.push(issue('approval_expiry_invalid'));
      else if (nowMs === null) blockers.push(issue('evaluation_time_invalid'));
      else if (expiryMs <= nowMs) blockers.push(issue('approval_expired'));
    }
  }
  if (approval.policy && approval.policy !== policy) blockers.push(issue('approval_policy_mismatch', `expected ${policy}, got ${approval.policy}`));
  if (approval.action && approvalAction !== action) blockers.push(issue('approval_action_mismatch', `expected ${action}, got ${approval.action}`));
  blockers.push(...disallowedApprovalBoundaryBlockers(approval));
  blockers.push(...approvalProvenanceBlockers(approval, { action, policy, taskKey, channelId, externalId, createdAt }));
  blockers.push(...exactScopeBindingBlockers(approval, 'approval', { taskKey, channelId, externalId }));
  if (
    Number.isFinite(Number(estimatedCostUsd))
    && Number.isFinite(Number(approval.budgetUsd))
    && Number(estimatedCostUsd) > Number(approval.budgetUsd)
  ) {
    blockers.push(issue('budget_exceeds_approval'));
  }
  return blockers;
}

function validateEvidence({ action, approval, evidenceBundle, taskKey, channelId, externalId, createdAt }) {
  const blockers = [];
  if (!evidenceBundle) {
    blockers.push(issue('fresh_evidence_required'));
    return blockers;
  }
  if (evidenceBundle.kind !== 'FreshEvidenceBundle') {
    blockers.push(issue('fresh_evidence_bundle_required'));
  }
  const semanticEvidenceHash = evidenceHash(evidenceBundle);
  const bundleAction = canonicalExternalAction(evidenceBundle.action || EXTERNAL_ACTIONS.NONE);
  if (evidenceBundle.kind === 'FreshEvidenceBundle' && evidenceBundle.action && evidenceBundle.action !== bundleAction) {
    blockers.push(issue('evidence_action_not_canonical', `expected ${bundleAction}, got ${evidenceBundle.action}`));
  }
  if (!semanticEvidenceHash) blockers.push(issue('evidence_hash_required'));
  if (evidenceBundle.kind === 'FreshEvidenceBundle') {
    const genericHash = normalizeText(evidenceBundle.hash || '');
    if (!genericHash) blockers.push(issue('evidence_generic_hash_required'));
    if (semanticEvidenceHash && genericHash && semanticEvidenceHash !== genericHash) {
      blockers.push(issue('evidence_hash_alias_mismatch'));
    }
  }
  if (evidenceBundle.kind === 'FreshEvidenceBundle' && semanticEvidenceHash && computeFreshEvidenceBundleHash(evidenceBundle) !== semanticEvidenceHash) {
    blockers.push(issue('evidence_hash_mismatch'));
  }
  if (evidenceBundle.ok !== true) blockers.push(issue('evidence_not_ok'));
  if (evidenceBundle.kind === 'FreshEvidenceBundle' && evidenceBundle.ok === true) {
    const expiresAt = normalizeText(evidenceBundle.expiresAt || '');
    if (!expiresAt) {
      blockers.push(issue('evidence_expiry_required'));
    } else {
      const expiryMs = timeMs(expiresAt);
      const nowMs = timeMs(createdAt || new Date().toISOString());
      if (expiryMs === null) blockers.push(issue('evidence_expiry_invalid'));
      else if (nowMs === null) blockers.push(issue('evaluation_time_invalid'));
      else if (expiryMs <= nowMs) blockers.push(issue('evidence_expired'));
    }
  }
  if (evidenceBundle.action && bundleAction !== action) blockers.push(issue('evidence_action_mismatch', `expected ${action}, got ${evidenceBundle.action}`));
  if (hasApproval(approval)) {
    const reportedApprovalHash = normalizeText(evidenceBundle.approvalHash || '');
    if (!reportedApprovalHash) {
      blockers.push(issue('evidence_approval_hash_required'));
    } else if (reportedApprovalHash !== approvalHash(approval)) {
      blockers.push(issue('evidence_approval_mismatch'));
    }
  }
  if (approval?.kind === 'ApprovalPacket' && evidenceBundle.kind === 'FreshEvidenceBundle') {
    const approvalProvenance = approvalProvenanceDigest(approval.approvalProvenance || approval.provenance);
    const evidenceProvenance = approvalProvenanceDigest(evidenceBundle.approvalProvenance || evidenceBundle.approval?.approvalProvenance);
    if (approvalProvenance && !evidenceProvenance) {
      blockers.push(issue('evidence_approval_provenance_required'));
    } else if (approvalProvenance && evidenceProvenance && !sameCanonicalJson(approvalProvenance, evidenceProvenance)) {
      blockers.push(issue('evidence_approval_provenance_mismatch'));
    }
  }
  blockers.push(...exactScopeBindingBlockers(evidenceBundle, 'evidence', { taskKey, channelId, externalId }));
  return blockers;
}

function validateReviewPackage({ action, artifactPackage, reviewReport }) {
  const blockers = [];
  if (![EXTERNAL_ACTIONS.LIVE_PREPARE, EXTERNAL_ACTIONS.LIVE_SUBMIT, EXTERNAL_ACTIONS.ACCEPTANCE_APPLY].includes(action)) return blockers;
  if (!artifactPackage?.artifacts?.length) blockers.push(issue('artifact_package_required'));
  if (!artifactPackage?.submitReady && action !== EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) blockers.push(issue('submit_ready_package_required'));
  if (reviewReport && !reviewReport.ok) blockers.push(issue('pass_review_required'));
  if (reviewReport && !reviewMatchesPackage(reviewReport, artifactPackage)) blockers.push(issue('review_artifact_mismatch'));
  return blockers;
}

function validatePrepareEvidence({ artifactPackage, prepareEvidence }) {
  const blockers = [];
  if (!prepareEvidence) {
    blockers.push(issue('prepare_evidence_required'));
    return blockers;
  }
  if (prepareEvidence.ok === false) blockers.push(issue('prepare_evidence_not_ok'));
  const expected = artifactNames(artifactPackage);
  const prepared = (prepareEvidence.filenames || prepareEvidence.uploadedFiles || prepareEvidence.files || [])
    .map((item) => normalizeText(typeof item === 'string' ? item : item?.filename || item?.name || item?.path || ''))
    .filter(Boolean);
  if (expected.length && prepared.length && !sameNameSet(expected, prepared)) blockers.push(issue('prepare_artifact_mismatch'));
  return blockers;
}

function validateDuplicatePreflight(duplicatePreflight) {
  const blockers = [];
  if (!duplicatePreflight) {
    blockers.push(issue('duplicate_preflight_required'));
    return blockers;
  }
  if (duplicatePreflight.ok === false) blockers.push(issue('duplicate_preflight_failed'));
  if (duplicatePreflight.existingMyWorks || duplicatePreflight.totalMyWorks > 0) blockers.push(issue('duplicate_existing_my_works'));
  return blockers;
}

function promptChainHashes(plan = {}) {
  const digest = approvalPlanDigest(plan || {});
  return {
    designReferenceRetrievalHash: digest.designReferenceRetrievalHash,
    promptCompilerHash: digest.promptCompilerHash,
    promptReadinessHash: digest.promptReadinessHash,
    promptProductionContractHash: digest.promptProductionContractHash,
    generationJobId: digest.generationJobId,
    generationPromptProductionContractHash: digest.generationPromptProductionContractHash,
  };
}

function hasPromptGenerationChain(plan = {}) {
  const hashes = promptChainHashes(plan);
  return Boolean(
    hashes.designReferenceRetrievalHash
      || hashes.promptCompilerHash
      || hashes.promptReadinessHash
      || hashes.promptProductionContractHash
      || hashes.generationJobId
      || hashes.generationPromptProductionContractHash
      || plan?.generationJob
      || plan?.generationManifest,
  );
}

function planDigestMatches(left = {}, right = {}) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function generationJobDigest(job = {}) {
  return {
    designReferenceRetrievalHash: normalizeText(
      job?.designReferenceRetrieval?.retrievalHash
        || job?.retrievalHash
        || '',
    ) || null,
    promptCompilerHash: normalizeText(
      job?.promptCompiler?.promptCompilerHash
        || job?.promptCompilerHash
        || '',
    ) || null,
    promptReadinessHash: normalizeText(
      job?.promptReadiness?.readinessHash
        || job?.promptReadinessHash
        || '',
    ) || null,
    promptProductionContractHash: normalizeText(
      job?.promptProductionContract?.promptProductionContractHash
        || job?.promptProductionContractHash
        || '',
    ) || null,
    generationJobId: normalizeText(job?.id || '') || null,
  };
}

function validatePromptGenerationSpend(request) {
  const blockers = [];
  if (![EXTERNAL_ACTIONS.PROVIDER_SPEND, EXTERNAL_ACTIONS.MODEL_SPEND].includes(request.action)) return blockers;
  if (!hasPromptGenerationChain(request.plan)) {
    blockers.push(issue(
      'prompt_generation_spend_plan_prompt_chain_required',
      'designReferenceRetrievalHash, promptCompilerHash, promptReadinessHash, promptProductionContractHash',
    ));
    blockers.push(issue('prompt_generation_spend_generation_job_required'));
    return blockers;
  }

  const currentPlanDigest = approvalPlanDigest(request.plan || {});
  const missingPlanHashes = [
    ['designReferenceRetrievalHash', currentPlanDigest.designReferenceRetrievalHash],
    ['promptCompilerHash', currentPlanDigest.promptCompilerHash],
    ['promptReadinessHash', currentPlanDigest.promptReadinessHash],
    ['promptProductionContractHash', currentPlanDigest.promptProductionContractHash],
  ].filter(([, value]) => !value);
  if (missingPlanHashes.length) {
    blockers.push(issue('prompt_generation_spend_plan_prompt_chain_required', missingPlanHashes.map(([name]) => name).join(', ')));
  }
  if (!currentPlanDigest.generationJobId || !currentPlanDigest.generationPromptProductionContractHash) {
    blockers.push(issue('prompt_generation_spend_plan_generation_job_binding_required'));
  }
  const generationJob = request.generationJob || request.plan?.generationJob || request.plan?.generationManifest || null;
  if (!generationJob) {
    blockers.push(issue('prompt_generation_spend_generation_job_required'));
  } else {
    const validation = validateGenerationJob({
      ...generationJob,
      execute: true,
    });
    for (const validationIssue of validation.issues || []) {
      blockers.push(issue('prompt_generation_spend_generation_job_invalid', validationIssue));
    }
    if (currentPlanDigest.generationJobId && currentPlanDigest.generationPromptProductionContractHash) {
      const jobDigest = generationJobDigest(generationJob);
      const staleJobBindings = [
        ['generationJobId', currentPlanDigest.generationJobId, jobDigest.generationJobId],
        ['generationPromptProductionContractHash', currentPlanDigest.generationPromptProductionContractHash, jobDigest.promptProductionContractHash],
        ['designReferenceRetrievalHash', currentPlanDigest.designReferenceRetrievalHash, jobDigest.designReferenceRetrievalHash],
        ['promptCompilerHash', currentPlanDigest.promptCompilerHash, jobDigest.promptCompilerHash],
        ['promptReadinessHash', currentPlanDigest.promptReadinessHash, jobDigest.promptReadinessHash],
        ['promptProductionContractHash', currentPlanDigest.promptProductionContractHash, jobDigest.promptProductionContractHash],
      ].filter(([, expected, actual]) => expected && actual && expected !== actual);
      if (staleJobBindings.length) {
        blockers.push(issue('prompt_generation_spend_generation_job_plan_stale', staleJobBindings.map(([name]) => name).join(', ')));
      }
    }
  }

  if (!request.approval?.plan) {
    blockers.push(issue('prompt_generation_spend_approval_plan_binding_required'));
  } else if (!planDigestMatches(request.approval.plan, currentPlanDigest)) {
    blockers.push(issue('prompt_generation_spend_approval_plan_stale'));
  }

  if (!request.evidenceBundle?.state?.plan) {
    blockers.push(issue('prompt_generation_spend_evidence_plan_binding_required'));
  } else if (!planDigestMatches(request.evidenceBundle.state.plan, currentPlanDigest)) {
    blockers.push(issue('prompt_generation_spend_evidence_plan_stale'));
  }
  return blockers;
}

function actionSpecificBlockers(request) {
  const blockers = [];
  const { action } = request;
  blockers.push(...validatePromptGenerationSpend(request));
  blockers.push(...validateReviewPackage(request));
  if (action === EXTERNAL_ACTIONS.LIVE_SUBMIT) {
    blockers.push(...validatePrepareEvidence(request));
    blockers.push(...validateDuplicatePreflight(request.duplicatePreflight));
  }
  if (action === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) {
    if (request.artifactPackage?.packageRole !== 'delivery' && !request.deliveryArtifactBound) {
      blockers.push(issue('delivery_artifact_binding_required'));
    }
  }
  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE && !normalizeText(request.messagePreview)) {
    blockers.push(issue('message_preview_required'));
  }
  if (action === EXTERNAL_ACTIONS.DEPLOYMENT) {
    if (!normalizeText(request.deploymentTarget)) blockers.push(issue('deployment_target_required'));
    if (request.buildEvidence?.ok !== true) blockers.push(issue('build_evidence_required'));
  }
  return blockers;
}

function humanFeedbackBlockers(request) {
  const blockers = [];
  const isFeedback = canonicalProductLineId(request.productLineId) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || isHumanFeedbackWorkflow(request.workflowId)
    || isHumanFeedbackWorkflow(request.artifactPackage?.packageRole)
    || isHumanFeedbackWorkflow(request.reviewReport?.packageRole)
    || humanFeedbackRevisionContractFor(request)
    || isHumanFeedbackMessageActionAlias(request.requestedAction)
    || recordLooksHumanFeedback(request.approval)
    || recordLooksHumanFeedback(request.evidenceBundle)
    || approvalContractHashes(request.approval).length > 0
    || evidenceContractHashes(request.evidenceBundle).length > 0;
  if (!isFeedback || request.action === EXTERNAL_ACTIONS.NONE) return blockers;
  const contractHashEntries = [
    ['topLevel', request.humanFeedbackRevisionContract],
    ['plan', request.plan?.humanFeedbackRevisionContract],
    ['artifactPackage', request.artifactPackage?.humanFeedbackRevisionContract],
    ['reviewReport', request.reviewReport?.humanFeedbackRevisionContract],
  ]
    .map(([label, contract]) => [label, normalizeText(contract?.contractHash || '')])
    .filter(([, hash]) => hash);
  const uniqueContractHashes = uniqueStrings(contractHashEntries.map(([, hash]) => hash), 8);
  if (uniqueContractHashes.length > 1) {
    blockers.push(issue(
      'human_feedback_contract_hash_drift',
      contractHashEntries.map(([label, hash]) => `${label}=${hash}`).join('; '),
    ));
  }
  const primaryContract = humanFeedbackPrimaryRevisionContractFor(request);
  blockers.push(...humanFeedbackRecordIdentityBlockers(request.approval, 'approval', request));
  blockers.push(...humanFeedbackRecordIdentityBlockers(request.evidenceBundle, 'evidence', request));
  blockers.push(...humanFeedbackRecordIdentityBlockers(request.plan, 'plan', request));
  blockers.push(...humanFeedbackRecordIdentityBlockers(request.artifactPackage, 'package', request));
  blockers.push(...humanFeedbackRecordIdentityBlockers(request.reviewReport, 'review_report', request));
  const validation = validateHumanFeedbackRevisionContract(
    primaryContract,
    {
      externalAction: request.action,
      reviewReport: request.reviewReport,
      context: {
        taskKey: request.taskKey,
        channelId: request.channelId,
        externalId: request.externalId || request.channelTask?.externalId || request.plan?.externalId || request.artifactPackage?.externalId || request.reviewReport?.externalId || null,
      },
    },
  );
  blockers.push(...validation.blockers.map((blocker) => issue(blocker.code, blocker.notes, blocker.level)));
  if (isHumanFeedbackCustomerFacingAction(request.action)) {
    const contractHash = normalizeText(primaryContract?.contractHash || '');
    if (request.approval && request.approval.kind !== 'ApprovalPacket') {
      blockers.push(issue('human_feedback_approval_packet_shape_required'));
    }
    if (request.evidenceBundle && request.evidenceBundle.kind !== 'FreshEvidenceBundle') {
      blockers.push(issue('human_feedback_evidence_bundle_shape_required'));
    }
    blockers.push(...messagePreviewBindingBlockers({
      currentPreview: request.messagePreview,
      boundPreview: request.approval?.messagePreview,
      missingCode: 'human_feedback_approval_message_preview_required',
      mismatchCode: 'human_feedback_approval_message_preview_mismatch',
    }));
    blockers.push(...messagePreviewBindingBlockers({
      currentPreview: request.messagePreview,
      boundPreview: request.evidenceBundle?.state?.messagePreview,
      missingCode: 'human_feedback_evidence_message_preview_required',
      mismatchCode: 'human_feedback_evidence_message_preview_mismatch',
    }));
    blockers.push(...contractHashBindingBlockers({
      contractHash,
      hashes: approvalContractHashes(request.approval),
      missingCode: 'human_feedback_approval_contract_hash_required',
      mismatchCode: 'human_feedback_approval_contract_hash_mismatch',
    }));
    blockers.push(...contractHashBindingBlockers({
      contractHash,
      hashes: evidenceContractHashes(request.evidenceBundle),
      missingCode: 'human_feedback_evidence_contract_hash_required',
      mismatchCode: 'human_feedback_evidence_contract_hash_mismatch',
    }));
    blockers.push(...requiredContractHashBindingBlockers({
      contractHash,
      entries: [
        {
          hash: request.approval?.plan?.humanFeedbackRevisionContractHash,
          missingCode: 'human_feedback_approval_plan_contract_hash_required',
          mismatchCode: 'human_feedback_approval_plan_contract_hash_mismatch',
        },
        {
          hash: request.approval?.artifactPackage?.humanFeedbackRevisionContractHash,
          missingCode: 'human_feedback_approval_package_contract_hash_required',
          mismatchCode: 'human_feedback_approval_package_contract_hash_mismatch',
        },
        {
          hash: request.approval?.reviewReport?.humanFeedbackRevisionContractHash,
          missingCode: 'human_feedback_approval_review_contract_hash_required',
          mismatchCode: 'human_feedback_approval_review_contract_hash_mismatch',
        },
      ],
    }));
    blockers.push(...requiredContractHashBindingBlockers({
      contractHash,
      entries: [
        {
          hash: request.evidenceBundle?.state?.plan?.humanFeedbackRevisionContractHash,
          missingCode: 'human_feedback_evidence_plan_contract_hash_required',
          mismatchCode: 'human_feedback_evidence_plan_contract_hash_mismatch',
        },
        {
          hash: request.evidenceBundle?.state?.artifactPackage?.humanFeedbackRevisionContractHash,
          missingCode: 'human_feedback_evidence_package_contract_hash_required',
          mismatchCode: 'human_feedback_evidence_package_contract_hash_mismatch',
        },
        {
          hash: request.evidenceBundle?.state?.reviewReport?.humanFeedbackRevisionContractHash,
          missingCode: 'human_feedback_evidence_review_contract_hash_required',
          mismatchCode: 'human_feedback_evidence_review_contract_hash_mismatch',
        },
      ],
    }));
    if (!request.artifactPackage?.artifacts?.length) {
      blockers.push(issue('human_feedback_artifact_package_required'));
    } else if ((request.artifactPackage.artifacts || []).some((artifact) => !normalizeText(artifact.hash || ''))) {
      blockers.push(issue('human_feedback_artifact_hash_required'));
    } else if ((request.artifactPackage.artifacts || []).some((artifact) => !isSha256Hash(artifact.hash))) {
      blockers.push(issue('human_feedback_artifact_hash_invalid'));
    }
    if (
      request.reviewReport
      && request.artifactPackage?.artifacts?.length
      && !reviewFullyMatchesPackage(request.reviewReport, request.artifactPackage)
    ) {
      blockers.push(issue('human_feedback_review_artifact_mismatch'));
    }
    const currentPackageArtifacts = comparableArtifactEntries(request.artifactPackage?.artifacts || []);
    const currentReviewArtifacts = comparableArtifactEntries(request.reviewReport?.artifactHashes || []);
    if (request.approval && !artifactEntriesMatchCurrent(
      comparableArtifactEntries(request.approval?.artifactPackage?.artifacts || []),
      currentPackageArtifacts,
    )) {
      blockers.push(issue('human_feedback_approval_package_artifact_mismatch'));
    }
    if (request.approval && !artifactEntriesMatchCurrent(
      comparableArtifactEntries(request.approval?.reviewReport?.artifactHashes || []),
      currentReviewArtifacts,
    )) {
      blockers.push(issue('human_feedback_approval_review_artifact_mismatch'));
    }
    if (request.evidenceBundle && !artifactEntriesMatchCurrent(
      comparableArtifactEntries(request.evidenceBundle?.state?.artifactPackage?.artifacts || []),
      currentPackageArtifacts,
    )) {
      blockers.push(issue('human_feedback_evidence_package_artifact_mismatch'));
    }
    if (request.evidenceBundle && !artifactEntriesMatchCurrent(
      comparableArtifactEntries(request.evidenceBundle?.state?.reviewReport?.artifactHashes || []),
      currentReviewArtifacts,
    )) {
      blockers.push(issue('human_feedback_evidence_review_artifact_mismatch'));
    }
  }
  return blockers;
}

export function buildExecutionGateRequest({
  action,
  policy = EXECUTION_POLICIES.SAFE_PLAN,
  taskKey = null,
  channelId = null,
  externalId = null,
  productLineId = null,
  workflowId = null,
  channelTask = null,
  plan = null,
  generationJob = null,
  artifactPackage = null,
  reviewReport = null,
  approval = null,
  evidenceBundle = null,
  prepareEvidence = null,
  duplicatePreflight = null,
  estimatedCostUsd = null,
  messagePreview = null,
  humanFeedbackRevisionContract = null,
  deliveryArtifactBound = false,
  deploymentTarget = null,
  buildEvidence = null,
  evidenceRefs: refs = [],
  createdAt = null,
} = {}) {
  return {
    version: EXECUTION_GATE_VERSION,
    kind: 'ExecutionGateRequest',
    action: canonicalExternalAction(action || EXTERNAL_ACTIONS.NONE),
    requestedAction: normalizeText(action || '') || null,
    policy,
    taskKey: channelTask?.taskKey || plan?.taskKey || artifactPackage?.taskKey || reviewReport?.taskKey || normalizeText(taskKey || '') || null,
    channelId: channelTask?.channelId || plan?.channelId || artifactPackage?.channelId || reviewReport?.channelId || normalizeText(channelId || '') || null,
    externalId: channelTask?.externalId || plan?.externalId || artifactPackage?.externalId || reviewReport?.externalId || normalizeText(externalId || '') || null,
    productLineId: canonicalProductLineIdOrNull(plan?.productLineId || artifactPackage?.productLineId || reviewReport?.productLineId || productLineId),
    workflowId: canonicalProductLineIdOrNull(plan?.workflowId || artifactPackage?.workflowId || reviewReport?.workflowId || workflowId),
    channelTask,
    plan,
    generationJob: generationJob || plan?.generationJob || plan?.generationManifest || null,
    artifactPackage,
    reviewReport,
    approval,
    evidenceBundle,
    prepareEvidence,
    duplicatePreflight,
    estimatedCostUsd: Number.isFinite(Number(estimatedCostUsd)) ? Number(estimatedCostUsd) : null,
    messagePreview: normalizeText(messagePreview) || null,
    humanFeedbackRevisionContract,
    deliveryArtifactBound: Boolean(deliveryArtifactBound),
    deploymentTarget: normalizeText(deploymentTarget) || null,
    buildEvidence,
    evidenceRefs: evidenceRefs(refs),
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function evaluateExecutionGate(input = {}) {
  const request = buildExecutionGateRequest(input);
  const blockers = [];
  const warnings = [];

  if (!knownActions().includes(request.action)) blockers.push(issue('unknown_external_action'));
  if (!ACTION_POLICY[request.policy]) blockers.push(issue('unknown_execution_policy'));
  if (!allowedActionsForPolicy(request.policy).includes(request.action)) {
    blockers.push(issue('policy_does_not_allow_action', `${request.policy} cannot run ${request.action}`));
  }

  if (request.action !== EXTERNAL_ACTIONS.NONE) {
    const capability = capabilityForAction(request.channelTask, request.action);
    if (capability === false || capability === undefined || capability === null) {
      blockers.push(issue('channel_capability_unsupported'));
    } else if (capability === 'partial') {
      warnings.push(issue('channel_capability_partial_requires_live_confirmation', null, 'warning'));
    }
    blockers.push(...validateApproval(request));
    blockers.push(...validateEvidence(request));
    blockers.push(...actionSpecificBlockers(request));
    blockers.push(...humanFeedbackBlockers(request));
  }

  return {
    version: EXECUTION_GATE_VERSION,
    kind: 'ExecutionGateDecision',
    taskKey: request.taskKey,
    channelId: request.channelId,
    externalId: request.externalId,
    productLineId: request.productLineId,
    workflowId: request.workflowId,
    action: request.action,
    policy: request.policy,
    decision: decisionFromBlockers(blockers),
    allowed: blockers.length === 0,
    blockers,
    warnings,
    approvalHash: approvalHash(request.approval) || null,
    evidenceHash: evidenceHash(request.evidenceBundle) || null,
    humanFeedbackRevisionContractHash: humanFeedbackRevisionContractFor(request)?.contractHash || null,
    messagePreview: request.action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE ? request.messagePreview : null,
    messagePreviewHash: request.action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE ? messagePreviewHash(request.messagePreview) : null,
    artifactNames: artifactNames(request.artifactPackage),
    safety: {
      executesExternalAction: blockers.length === 0 && request.action !== EXTERNAL_ACTIONS.NONE,
      approvalRequired: request.action !== EXTERNAL_ACTIONS.NONE,
      evidenceRequired: request.action !== EXTERNAL_ACTIONS.NONE,
    },
  };
}

export function summarizeExecutionGateDecisions(decisions = []) {
  const byAction = {};
  const byPolicy = {};
  const byDecision = {};
  const blockerCodes = {};
  for (const decision of decisions) {
    const action = canonicalExternalAction(decision.action || EXTERNAL_ACTIONS.NONE);
    byAction[action] = (byAction[action] || 0) + 1;
    byPolicy[decision.policy] = (byPolicy[decision.policy] || 0) + 1;
    byDecision[decision.decision] = (byDecision[decision.decision] || 0) + 1;
    for (const blocker of decision.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: EXECUTION_GATE_VERSION,
    count: decisions.length,
    byAction,
    byPolicy,
    byDecision,
    blockerCodes,
    policies: Object.values(EXECUTION_POLICIES),
    externalActions: uniqueStrings(knownActions()),
  };
}
