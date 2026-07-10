import {
  HUMAN_FEEDBACK_CUSTOMER_FACING_ACTION_IDS,
  HUMAN_FEEDBACK_WORKFLOW_IDS,
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  computeHumanFeedbackRevisionContractHash,
  isHumanFeedbackCustomerFacingAction as isContractHumanFeedbackCustomerFacingAction,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';

export const HUMAN_FEEDBACK_CONTRACT_VERSION = 1;

export const HUMAN_FEEDBACK_PREVIEW_CLASSES = Object.freeze({
  OPERATOR_PREVIEW: 'operator_preview',
  CUSTOMER_FACING_REVISION: 'customer_facing_revision',
  FINAL_DELIVERY_HANDOFF: 'final_delivery_handoff',
});

const CUSTOMER_FACING_ACTIONS = new Set(
  HUMAN_FEEDBACK_CUSTOMER_FACING_ACTION_IDS
    .map((action) => canonicalExternalAction(action))
    .filter((action) => action && action !== EXTERNAL_ACTIONS.NONE),
);

export const HUMAN_FEEDBACK_CUSTOMER_FACING_STAGE_IDS = Object.freeze([
  'human_feedback_message',
  'human_feedback_im',
  'human_feedback_handoff',
  'human_feedback_delivery',
  'human_feedback_acceptance',
]);
const CUSTOMER_FACING_STAGES = new Set(HUMAN_FEEDBACK_CUSTOMER_FACING_STAGE_IDS);
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isHumanFeedbackCustomerFacingAction(action) {
  return isContractHumanFeedbackCustomerFacingAction(action);
}

export const HUMAN_FEEDBACK_REVIEW_TYPES = new Set([
  'human_feedback_revision',
  'human_feedback_review',
  'human_feedback_referee',
]);

const HUMAN_FEEDBACK_WORKFLOW_ALIASES = new Set(HUMAN_FEEDBACK_WORKFLOW_IDS);

function snakeToCamel(value) {
  return normalizeText(value || '').replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
}

function stageAliasForms(value) {
  const raw = normalizeText(value || '');
  if (!raw) return [];
  const snake = raw.replace(/[ -]+/g, '_');
  const kebab = raw.replace(/[_ ]+/g, '-');
  const spaced = raw.replace(/[_-]+/g, ' ');
  const compact = raw.replace(/[_.\-\s]+/g, '').toLowerCase();
  return uniqueStrings([
    raw,
    raw.toLowerCase(),
    snake.toLowerCase(),
    kebab.toLowerCase(),
    spaced.toLowerCase(),
    snakeToCamel(snake.toLowerCase()),
    compact,
  ], 16);
}

function feedbackStageAliases(suffix) {
  return [
    `human_feedback_${suffix}`,
    `consumer_feedback_${suffix}`,
    `buyer_feedback_${suffix}`,
  ].flatMap((value) => stageAliasForms(value));
}

function actionAliasesFor(canonicalAction) {
  return HUMAN_FEEDBACK_CUSTOMER_FACING_ACTION_IDS
    .filter((value) => canonicalExternalAction(value) === canonicalAction);
}

function stageEntries(stage, aliases = []) {
  return aliases.flatMap((alias) => stageAliasForms(alias).map((value) => [value, stage]));
}

function humanFeedbackStageAliases() {
  return Object.freeze(Object.fromEntries([
    ...stageEntries('human_feedback_message', [
      ...feedbackStageAliases('message'),
      ...actionAliasesFor(EXTERNAL_ACTIONS.CUSTOMER_MESSAGE),
    ]),
    ...stageEntries('human_feedback_im', feedbackStageAliases('im')),
    ...stageEntries('human_feedback_handoff', [
      ...feedbackStageAliases('handoff'),
      ...actionAliasesFor(EXTERNAL_ACTIONS.LIVE_SUBMIT),
    ]),
    ...stageEntries('human_feedback_delivery', feedbackStageAliases('delivery')),
    ...stageEntries('human_feedback_acceptance', [
      ...feedbackStageAliases('acceptance'),
      ...actionAliasesFor(EXTERNAL_ACTIONS.ACCEPTANCE_APPLY),
    ]),
    ...stageEntries('human_feedback_step', feedbackStageAliases('step')),
  ]));
}

const HUMAN_FEEDBACK_STAGE_ALIASES = humanFeedbackStageAliases();

const ACTIVE_ATOMIC_STATUSES = new Set(['active', 'active_change', 'active-change']);
const PENDING_ATOMIC_STATUSES = new Set(['pending', 'pending_change', 'pending-change']);
const DONE_ATOMIC_STATUS_PREFIXES = Object.freeze([
  'done',
  'complete',
  'completed',
  'closed',
  'superseded',
  'rejected',
]);

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes || '') || null,
  };
}

function normalizeRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: normalizeText(item) };
    return {
      kind: normalizeText(item?.kind || 'path') || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: normalizeText(item?.hash || '') || null,
      notes: normalizeText(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

function isSha256Hash(value) {
  return SHA256_HASH_PATTERN.test(normalizeText(value || ''));
}

function normalizeOptionalId(value) {
  if (value === null || value === undefined) return null;
  return normalizeText(String(value)) || null;
}

export function hashHumanFeedbackRevisionContract(contract = {}) {
  return computeHumanFeedbackRevisionContractHash(contract);
}

function reviewGateWithContractHash(reviewGate, contractHash) {
  if (!reviewGate || typeof reviewGate !== 'object') return reviewGate || null;
  const existingHash = normalizeText(
    reviewGate.humanFeedbackRevisionContractHash
      || reviewGate.contractHash
      || reviewGate.humanFeedbackRevisionContract?.contractHash
      || '',
  );
  if (existingHash === contractHash) return reviewGate;
  return {
    ...reviewGate,
    humanFeedbackRevisionContractHash: contractHash,
  };
}

function canonicalFeedbackReviewGate(reviewGate) {
  if (!reviewGate || typeof reviewGate !== 'object') return reviewGate || null;
  const normalized = { ...reviewGate };
  for (const field of ['reviewType', 'packageRole', 'role']) {
    if (Object.hasOwn(normalized, field)) normalized[field] = canonicalPackageRole(normalized[field]);
  }
  return normalized;
}

function canonicalAtomicStatus(status) {
  const normalized = normalizeText(status || '').toLowerCase();
  if (!normalized) return 'pending';
  if (ACTIVE_ATOMIC_STATUSES.has(normalized) || normalized.startsWith('active_') || normalized.startsWith('active-')) return 'active';
  if (PENDING_ATOMIC_STATUSES.has(normalized) || normalized.startsWith('pending_') || normalized.startsWith('pending-')) return 'pending';
  if (DONE_ATOMIC_STATUS_PREFIXES.some((prefix) => (
    normalized === prefix
      || normalized.startsWith(`${prefix}_`)
      || normalized.startsWith(`${prefix}-`)
  ))) return 'done';
  return normalized;
}

function normalizeTargetArtifact(target = {}) {
  return {
    artifactId: normalizeText(target.artifactId || target.id || '') || null,
    workNo: normalizeText(target.workNo || '') || null,
    worksId: normalizeText(target.worksId || target.submissionId || '') || null,
    filename: normalizeText(target.filename || target.name || '') || null,
    path: normalizeText(target.path || '') || null,
    hash: normalizeText(target.hash || '') || null,
    description: normalizeText(target.description || target.notes || '') || null,
  };
}

function normalizeBaselineLock(lock = {}) {
  return {
    locked: lock.locked === true,
    lockedFacts: uniqueStrings(lock.lockedFacts || lock.facts || [], 128),
    invariantHashes: uniqueStrings(lock.invariantHashes || lock.hashes || [], 64),
    notes: normalizeText(lock.notes || '') || null,
  };
}

function normalizeAtomicQueue(queue = []) {
  return (queue || []).map((item, index) => ({
    id: normalizeText(item?.id || `change-${index + 1}`),
    status: canonicalAtomicStatus(item?.status || item?.state || 'pending'),
    description: normalizeText(item?.description || item?.text || item?.change || ''),
    sourceRef: normalizeText(item?.sourceRef || item?.source || '') || null,
    targetArtifactId: normalizeText(item?.targetArtifactId || item?.artifactId || '') || null,
  })).filter((item) => item.id && item.description);
}

function bindAtomicQueueSourceRefs(queue = [], sourceRefs = []) {
  const sourceRef = sourceRefs.length === 1 ? normalizeText(sourceRefs[0].ref || '') : '';
  if (!sourceRef) return queue;
  return queue.map((item) => (
    item.status === 'active' && !item.sourceRef
      ? { ...item, sourceRef }
      : item
  ));
}

function normalizeActiveAtomicChange(activeAtomicChange, atomicQueue) {
  if (typeof activeAtomicChange === 'string') {
    return { id: normalizeText(activeAtomicChange), description: null };
  }
  if (activeAtomicChange && typeof activeAtomicChange === 'object') {
    return {
      id: normalizeText(activeAtomicChange.id || ''),
      description: normalizeText(activeAtomicChange.description || activeAtomicChange.text || activeAtomicChange.change || '') || null,
    };
  }
  const activeItems = atomicQueue.filter((item) => item.status === 'active');
  if (activeItems.length === 1) return { id: activeItems[0].id, description: activeItems[0].description };
  return null;
}

export function isHumanFeedbackWorkflow(value) {
  const normalized = normalizeText(value || '');
  return canonicalProductLineId(normalized) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(normalized)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || HUMAN_FEEDBACK_WORKFLOW_ALIASES.has(normalized.toLowerCase());
}

export function normalizeHumanFeedbackStage(value) {
  const action = canonicalExternalAction(value || EXTERNAL_ACTIONS.NONE);
  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) return 'human_feedback_message';
  if (action === EXTERNAL_ACTIONS.LIVE_SUBMIT) return 'human_feedback_handoff';
  if (action === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) return 'human_feedback_acceptance';
  const normalized = normalizeText(value || '').toLowerCase();
  return HUMAN_FEEDBACK_STAGE_ALIASES[normalized] || normalized;
}

export function createHumanFeedbackRevisionContract({
  platform = null,
  taskId = null,
  orderId = null,
  taskKey = null,
  channelId = null,
  externalId = null,
  workflowId = PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  sourceSnapshot = {},
  sourceSnapshotHash = null,
  targetArtifact = {},
  baselineInvariantLock = {},
  atomicQueue = [],
  activeAtomicChange = null,
  unchangedRegressionChecklist = [],
  previewClass = HUMAN_FEEDBACK_PREVIEW_CLASSES.OPERATOR_PREVIEW,
  exitAction = EXTERNAL_ACTIONS.NONE,
  exitStage = null,
  reviewGate = null,
  generationPolicy = null,
  evidenceRefs = [],
  createdAt = null,
  includeExitAction = true,
  includeLegacyNullFields = false,
} = {}) {
  const normalizedSourceRefs = normalizeRefs(sourceSnapshot.refs || sourceSnapshot.evidenceRefs || []);
  const normalizedQueue = bindAtomicQueueSourceRefs(normalizeAtomicQueue(atomicQueue), normalizedSourceRefs);
  const normalizedReviewGate = canonicalFeedbackReviewGate(reviewGate);
  const normalizedPlatform = normalizeOptionalId(platform);
  const normalizedTaskId = normalizeOptionalId(taskId);
  const normalizedOrderId = normalizeOptionalId(orderId);
  const normalizedExitStage = normalizeHumanFeedbackStage(exitStage || '') || null;
  const contract = {
    version: HUMAN_FEEDBACK_CONTRACT_VERSION,
    kind: 'HumanFeedbackRevisionContract',
    ...(normalizedPlatform || includeLegacyNullFields ? { platform: normalizedPlatform } : {}),
    ...(normalizedTaskId || includeLegacyNullFields ? { taskId: normalizedTaskId } : {}),
    ...(normalizedOrderId || includeLegacyNullFields ? { orderId: normalizedOrderId } : {}),
    taskKey: normalizeText(taskKey || '') || null,
    channelId: normalizeText(channelId || '') || null,
    externalId: normalizeText(externalId || '') || null,
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    workflowId: isHumanFeedbackWorkflow(workflowId) ? PRODUCT_LINE_IDS.HUMAN_FEEDBACK : normalizeText(workflowId || PRODUCT_LINE_IDS.HUMAN_FEEDBACK),
    sourceSnapshot: {
      ...sourceSnapshot,
      hash: normalizeText(sourceSnapshotHash || sourceSnapshot.hash || sourceSnapshot.sourceSnapshotHash || '') || null,
      refreshedAt: normalizeText(sourceSnapshot.refreshedAt || sourceSnapshot.capturedAt || sourceSnapshot.generatedAt || '') || null,
      refs: normalizedSourceRefs,
    },
    targetArtifact: normalizeTargetArtifact(targetArtifact),
    baselineInvariantLock: normalizeBaselineLock(baselineInvariantLock),
    atomicQueue: normalizedQueue,
    activeAtomicChange: normalizeActiveAtomicChange(activeAtomicChange, normalizedQueue),
    unchangedRegressionChecklist: uniqueStrings(unchangedRegressionChecklist, 128),
    previewClass: normalizeText(previewClass || HUMAN_FEEDBACK_PREVIEW_CLASSES.OPERATOR_PREVIEW),
    ...(includeExitAction ? { exitAction: canonicalExternalAction(exitAction || EXTERNAL_ACTIONS.NONE) } : {}),
    ...(normalizedExitStage || includeLegacyNullFields ? { exitStage: normalizedExitStage } : {}),
    reviewGate: normalizedReviewGate || null,
    generationPolicy: generationPolicy || null,
    evidenceRefs: normalizeRefs(evidenceRefs),
    createdAt: createdAt || new Date().toISOString(),
  };
  const contractHash = hashHumanFeedbackRevisionContract(contract);
  return {
    ...contract,
    contractHash,
    reviewGate: reviewGateWithContractHash(contract.reviewGate, contractHash),
  };
}

export function createHumanFeedbackLegacyStageRevisionContract({
  platform = null,
  taskId = null,
  orderId = null,
  taskKey = null,
  channelId = null,
  externalId = null,
  workflowId = PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  exitStage = null,
  ...contractInput
} = {}) {
  const normalizedPlatform = normalizeOptionalId(platform || channelId);
  const normalizedChannelId = normalizeOptionalId(channelId || normalizedPlatform);
  const normalizedTaskId = normalizeOptionalId(taskId);
  const normalizedOrderId = normalizeOptionalId(orderId);
  const normalizedTaskKey = normalizeText(
    taskKey || (normalizedTaskId && normalizedChannelId ? `${normalizedChannelId}:${normalizedTaskId}` : '') || '',
  ) || null;
  const normalizedExternalId = normalizeText(externalId || normalizedTaskId || '') || null;
  return createHumanFeedbackRevisionContract({
    ...contractInput,
    platform: normalizedPlatform,
    taskId: normalizedTaskId,
    orderId: normalizedOrderId,
    taskKey: normalizedTaskKey,
    channelId: normalizedChannelId,
    externalId: normalizedExternalId,
    workflowId,
    exitStage,
    includeExitAction: false,
    includeLegacyNullFields: true,
  });
}

function hasTargetBinding(target = {}) {
  return Boolean(target.artifactId
    || target.workNo
    || target.worksId
    || ((target.path || target.filename) && isSha256Hash(target.hash)));
}

function hasBaselineLock(lock = {}) {
  return lock.locked === true && Boolean(lock.lockedFacts?.length || lock.invariantHashes?.length);
}

function reviewGateCandidate(contract, reviewReport) {
  return reviewReport || contract?.reviewGate || null;
}

function reviewGateType(gate = {}) {
  return canonicalPackageRole(gate.reviewType
    || gate.type
    || gate.packageRole
    || gate.role
    || gate.humanFeedbackRevisionContract?.packageRole
    || '') || null;
}

function reviewGateLooksHumanFeedback(gate = {}) {
  const type = reviewGateType(gate);
  return HUMAN_FEEDBACK_REVIEW_TYPES.has(type);
}

function targetBindingMatches(left = {}, right = {}) {
  const strongPairs = ['artifactId', 'workNo', 'worksId', 'hash'];
  return strongPairs.some((key) => left?.[key] && right?.[key] && normalizeText(left[key]) === normalizeText(right[key]));
}

function reviewGateContractHash(gate = {}) {
  return normalizeText(
    gate.humanFeedbackRevisionContractHash
      || gate.contractHash
      || gate.humanFeedbackRevisionContract?.contractHash
      || '',
  );
}

function reviewGateHashBlocker(contract, gate = {}) {
  const gateHash = reviewGateContractHash(gate);
  const contractHash = normalizeText(contract?.contractHash || '');
  if (!gateHash) return issue('human_feedback_review_gate_contract_hash_required');
  if (!contractHash || gateHash !== contractHash) return issue('human_feedback_review_gate_contract_hash_mismatch');
  return null;
}

function reviewGateBindsToContract(contract, gate = {}) {
  const embedded = gate.humanFeedbackRevisionContract || null;
  const activeId = normalizeText(contract?.activeAtomicChange?.id || '');
  const gateActiveId = normalizeText(
    embedded?.activeAtomicChange?.id
      || gate.activeAtomicChangeId
      || gate.activeChangeId
      || gate.changeId
      || gate.activeAtomicChange?.id
      || '',
  );
  if (!gateActiveId || gateActiveId !== activeId) return false;
  const gateTarget = embedded?.targetArtifact || gate.targetArtifact || gate.target || null;
  return targetBindingMatches(contract?.targetArtifact, gateTarget);
}

function reviewReportShapeBlockers(reviewReport, expectedContract = null) {
  const blockers = [];
  if (!reviewReport) return blockers;
  if (reviewReport.kind !== 'ReviewReport') blockers.push(issue('human_feedback_review_report_shape_required'));
  if (reviewReport.humanFeedbackRevisionContract?.kind !== 'HumanFeedbackRevisionContract') {
    blockers.push(issue('human_feedback_review_report_contract_required'));
  } else {
    const embeddedContract = reviewReport.humanFeedbackRevisionContract;
    const embeddedContractHash = normalizeText(embeddedContract.contractHash || '');
    if (expectedContract && !embeddedContractHash) {
      blockers.push(issue('human_feedback_review_report_contract_hash_required'));
    } else if (embeddedContractHash) {
      const expectedContractHash = normalizeText(expectedContract?.contractHash || '');
      if (expectedContractHash && embeddedContractHash !== expectedContractHash) {
        blockers.push(issue('human_feedback_review_report_contract_hash_mismatch'));
      }
      if (hashHumanFeedbackRevisionContract(embeddedContract) !== embeddedContractHash) {
        blockers.push(issue('human_feedback_review_report_contract_hash_invalid'));
      }
    }
  }
  const artifactHashes = reviewReport.artifactHashes || [];
  if (!artifactHashes.length || artifactHashes.some((artifact) => !normalizeText(artifact?.hash || ''))) {
    blockers.push(issue('human_feedback_review_report_artifact_hash_required'));
  }
  if (artifactHashes.some((artifact) => normalizeText(artifact?.hash || '') && !isSha256Hash(artifact.hash))) {
    blockers.push(issue('human_feedback_review_report_artifact_hash_invalid'));
  }
  return blockers;
}

function reviewGateValidation(contract, reviewReport) {
  const gate = reviewGateCandidate(contract, reviewReport);
  const blockers = [];
  if (!reviewReport) blockers.push(issue('human_feedback_review_report_required'));
  if (!(gate?.ok === true || gate?.decision === 'pass')) {
    blockers.push(issue('human_feedback_review_gate_pass_required'));
    return blockers;
  }
  blockers.push(...reviewReportShapeBlockers(reviewReport, contract));
  if (!reviewGateLooksHumanFeedback(gate)) blockers.push(issue('human_feedback_review_gate_type_required'));
  const hashBlocker = reviewGateHashBlocker(contract, gate);
  if (hashBlocker) blockers.push(hashBlocker);
  if (!reviewGateBindsToContract(contract, gate)) blockers.push(issue('human_feedback_review_gate_binding_required'));
  return blockers;
}

function contextBindingBlockers(contract, context = {}) {
  const blockers = [];
  for (const [field, code] of [
    ['taskKey', 'human_feedback_contract_task_mismatch'],
    ['channelId', 'human_feedback_contract_channel_mismatch'],
    ['externalId', 'human_feedback_contract_external_id_mismatch'],
  ]) {
    const expected = normalizeText(context?.[field] || '');
    if (!expected) continue;
    const actual = normalizeText(contract?.[field] || '');
    if (!actual) {
      blockers.push(issue(code.replace('_mismatch', '_required'), expected));
    } else if (actual !== expected) {
      blockers.push(issue(code, `expected ${expected}, got ${actual}`));
    }
  }
  return blockers;
}

function activeSourceRefBlockers(contract = {}) {
  const sourceRefs = new Set((contract.sourceSnapshot?.refs || [])
    .map((ref) => normalizeText(ref?.ref || ''))
    .filter(Boolean));
  const activeId = normalizeText(contract.activeAtomicChange?.id || '');
  const activeItem = (contract.atomicQueue || []).find((item) => item.id === activeId);
  if (!activeId || !activeItem) return [];
  const sourceRef = normalizeText(activeItem.sourceRef || '');
  if (!sourceRef) return [issue('human_feedback_active_source_ref_required')];
  if (sourceRefs.size && !sourceRefs.has(sourceRef)) {
    return [issue('human_feedback_active_source_ref_mismatch', sourceRef)];
  }
  return [];
}

export function validateHumanFeedbackRevisionContract(contract, {
  externalAction = null,
  reviewReport = null,
  requireCustomerFacing = false,
  context = null,
  taskKey = null,
  channelId = null,
  externalId = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  const action = canonicalExternalAction(externalAction || EXTERNAL_ACTIONS.NONE);
  const customerFacing = requireCustomerFacing || CUSTOMER_FACING_ACTIONS.has(action);

  if (!contract || contract.kind !== 'HumanFeedbackRevisionContract') {
    return {
      ok: false,
      blockers: [issue('human_feedback_revision_contract_required')],
      warnings,
    };
  }

  if (!isHumanFeedbackWorkflow(contract.workflowId || contract.productLineId)) {
    blockers.push(issue('human_feedback_workflow_required', contract.workflowId || contract.productLineId));
  }
  if (canonicalProductLineId(contract.productLineId) !== PRODUCT_LINE_IDS.HUMAN_FEEDBACK) {
    blockers.push(issue('human_feedback_product_line_required', contract.productLineId));
  }
  if (!normalizeText(contract.taskKey || '')) blockers.push(issue('human_feedback_contract_task_required'));
  if (!normalizeText(contract.channelId || '')) blockers.push(issue('human_feedback_contract_channel_required'));
  if (!normalizeText(contract.externalId || '')) blockers.push(issue('human_feedback_contract_external_id_required'));
  const expectedContractHash = hashHumanFeedbackRevisionContract(contract);
  if (!normalizeText(contract.contractHash || '')) {
    blockers.push(issue('human_feedback_contract_hash_required'));
  } else if (contract.contractHash !== expectedContractHash) {
    blockers.push(issue('human_feedback_contract_hash_mismatch'));
  }
  const embeddedReviewGateHash = reviewGateContractHash(contract.reviewGate || {});
  if (embeddedReviewGateHash && embeddedReviewGateHash !== contract.contractHash) {
    blockers.push(issue('human_feedback_review_gate_contract_hash_mismatch', embeddedReviewGateHash));
  }
  if (contract.reviewGate) {
    blockers.push(...reviewReportShapeBlockers(contract.reviewGate));
    const embeddedReviewGateContractHash = normalizeText(contract.reviewGate.humanFeedbackRevisionContract?.contractHash || '');
    if (embeddedReviewGateContractHash && embeddedReviewGateContractHash !== contract.contractHash) {
      blockers.push(issue('human_feedback_review_gate_contract_hash_mismatch', embeddedReviewGateContractHash));
    }
  }
  const sourceSnapshotHash = normalizeText(contract.sourceSnapshot?.hash || contract.sourceSnapshotHash || '');
  if (!sourceSnapshotHash) {
    blockers.push(issue('human_feedback_source_snapshot_hash_required'));
  } else if (!isSha256Hash(sourceSnapshotHash)) {
    blockers.push(issue('human_feedback_source_snapshot_hash_invalid'));
  }
  if (!contract.sourceSnapshot?.refreshedAt && !contract.sourceSnapshot?.refs?.length) {
    blockers.push(issue('human_feedback_history_refresh_evidence_required'));
  }
  const sourceRefs = contract.sourceSnapshot?.refs || [];
  if (!sourceRefs.length) {
    blockers.push(issue('human_feedback_source_ref_required'));
  } else {
    if (sourceRefs.some((ref) => !normalizeText(ref.hash || ''))) {
      blockers.push(issue('human_feedback_source_ref_hash_required'));
    }
    if (sourceRefs.some((ref) => normalizeText(ref.hash || '') && !isSha256Hash(ref.hash))) {
      blockers.push(issue('human_feedback_source_ref_hash_invalid'));
    }
  }
  const invalidInvariantHashes = (contract.baselineInvariantLock?.invariantHashes || [])
    .filter((hash) => normalizeText(hash || '') && !isSha256Hash(hash));
  if (invalidInvariantHashes.length) {
    blockers.push(issue('human_feedback_baseline_invariant_hash_invalid'));
  }
  if (normalizeText(contract.targetArtifact?.hash || '') && !isSha256Hash(contract.targetArtifact.hash)) {
    blockers.push(issue('human_feedback_target_artifact_hash_invalid'));
  }
  if (!hasTargetBinding(contract.targetArtifact)) {
    blockers.push(issue('human_feedback_target_artifact_binding_required'));
  }
  if (!hasBaselineLock(contract.baselineInvariantLock)) {
    blockers.push(issue('human_feedback_baseline_invariant_lock_required'));
  }
  if (!contract.atomicQueue?.length) {
    blockers.push(issue('human_feedback_atomic_queue_required'));
  }

  const activeItems = (contract.atomicQueue || []).filter((item) => item.status === 'active');
  const activeId = normalizeText(contract.activeAtomicChange?.id || '');
  if (!activeId) {
    blockers.push(issue('human_feedback_active_atomic_change_required'));
  }
  if (activeItems.length !== 1) {
    blockers.push(issue('human_feedback_exactly_one_active_atomic_change_required', `active=${activeItems.length}`));
  }
  if (activeId && contract.atomicQueue?.length && !contract.atomicQueue.some((item) => item.id === activeId)) {
    blockers.push(issue('human_feedback_active_atomic_change_not_in_queue', activeId));
  }
  blockers.push(...activeSourceRefBlockers(contract));
  if (!contract.unchangedRegressionChecklist?.length) {
    blockers.push(issue('human_feedback_unchanged_regression_checklist_required'));
  }
  if (!Object.values(HUMAN_FEEDBACK_PREVIEW_CLASSES).includes(contract.previewClass)) {
    blockers.push(issue('human_feedback_preview_class_invalid', contract.previewClass));
  }
  blockers.push(...contextBindingBlockers(contract, {
    ...(context || {}),
    taskKey: taskKey || context?.taskKey || null,
    channelId: channelId || context?.channelId || null,
    externalId: externalId || context?.externalId || null,
  }));

  if (customerFacing) {
    if (contract.previewClass === HUMAN_FEEDBACK_PREVIEW_CLASSES.OPERATOR_PREVIEW) {
      blockers.push(issue('human_feedback_operator_preview_not_customer_facing'));
    }
    blockers.push(...reviewGateValidation(contract, reviewReport));
    if (action !== EXTERNAL_ACTIONS.NONE && canonicalExternalAction(contract.exitAction) !== action) {
      blockers.push(issue('human_feedback_exit_action_mismatch', `expected ${action}, got ${contract.exitAction}`));
    }
    if (contract.generationPolicy?.localOnly === true && contract.generationPolicy?.customerFacingOverride?.approved !== true) {
      blockers.push(issue('human_feedback_local_only_artifact_not_customer_facing'));
    }
  } else if (contract.previewClass !== HUMAN_FEEDBACK_PREVIEW_CLASSES.OPERATOR_PREVIEW) {
    warnings.push(issue('human_feedback_customer_facing_preview_without_external_action', null, 'warning'));
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
  };
}

function validateHumanFeedbackRevisionContractBase(contract, {
  context = null,
  taskKey = null,
  channelId = null,
  externalId = null,
  checkEmbeddedReviewGateShape = true,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!contract || contract.kind !== 'HumanFeedbackRevisionContract') {
    return {
      ok: false,
      blockers: [issue('human_feedback_revision_contract_required')],
      warnings,
    };
  }

  if (!isHumanFeedbackWorkflow(contract.workflowId || contract.productLineId)) {
    blockers.push(issue('human_feedback_workflow_required', contract.workflowId || contract.productLineId));
  }
  if (canonicalProductLineId(contract.productLineId) !== PRODUCT_LINE_IDS.HUMAN_FEEDBACK) {
    blockers.push(issue('human_feedback_product_line_required', contract.productLineId));
  }
  if (!normalizeText(contract.taskKey || '')) blockers.push(issue('human_feedback_contract_task_required'));
  if (!normalizeText(contract.channelId || '')) blockers.push(issue('human_feedback_contract_channel_required'));
  if (!normalizeText(contract.externalId || '')) blockers.push(issue('human_feedback_contract_external_id_required'));
  const expectedContractHash = hashHumanFeedbackRevisionContract(contract);
  if (!normalizeText(contract.contractHash || '')) {
    blockers.push(issue('human_feedback_contract_hash_required'));
  } else if (contract.contractHash !== expectedContractHash) {
    blockers.push(issue('human_feedback_contract_hash_mismatch'));
  }
  const embeddedReviewGateHash = reviewGateContractHash(contract.reviewGate || {});
  if (embeddedReviewGateHash && embeddedReviewGateHash !== contract.contractHash) {
    blockers.push(issue('human_feedback_review_gate_contract_hash_mismatch', embeddedReviewGateHash));
  }
  if (checkEmbeddedReviewGateShape && contract.reviewGate) {
    blockers.push(...reviewReportShapeBlockers(contract.reviewGate));
    const embeddedReviewGateContractHash = normalizeText(contract.reviewGate.humanFeedbackRevisionContract?.contractHash || '');
    if (embeddedReviewGateContractHash && embeddedReviewGateContractHash !== contract.contractHash) {
      blockers.push(issue('human_feedback_review_gate_contract_hash_mismatch', embeddedReviewGateContractHash));
    }
  }
  const sourceSnapshotHash = normalizeText(contract.sourceSnapshot?.hash || contract.sourceSnapshotHash || '');
  if (!sourceSnapshotHash) {
    blockers.push(issue('human_feedback_source_snapshot_hash_required'));
  } else if (!isSha256Hash(sourceSnapshotHash)) {
    blockers.push(issue('human_feedback_source_snapshot_hash_invalid'));
  }
  if (!contract.sourceSnapshot?.refreshedAt && !contract.sourceSnapshot?.refs?.length) {
    blockers.push(issue('human_feedback_history_refresh_evidence_required'));
  }
  const sourceRefs = contract.sourceSnapshot?.refs || [];
  if (!sourceRefs.length) {
    blockers.push(issue('human_feedback_source_ref_required'));
  } else {
    if (sourceRefs.some((ref) => !normalizeText(ref.hash || ''))) {
      blockers.push(issue('human_feedback_source_ref_hash_required'));
    }
    if (sourceRefs.some((ref) => normalizeText(ref.hash || '') && !isSha256Hash(ref.hash))) {
      blockers.push(issue('human_feedback_source_ref_hash_invalid'));
    }
  }
  const invalidInvariantHashes = (contract.baselineInvariantLock?.invariantHashes || [])
    .filter((hash) => normalizeText(hash || '') && !isSha256Hash(hash));
  if (invalidInvariantHashes.length) {
    blockers.push(issue('human_feedback_baseline_invariant_hash_invalid'));
  }
  if (normalizeText(contract.targetArtifact?.hash || '') && !isSha256Hash(contract.targetArtifact.hash)) {
    blockers.push(issue('human_feedback_target_artifact_hash_invalid'));
  }
  if (!hasTargetBinding(contract.targetArtifact)) {
    blockers.push(issue('human_feedback_target_artifact_binding_required'));
  }
  if (!hasBaselineLock(contract.baselineInvariantLock)) {
    blockers.push(issue('human_feedback_baseline_invariant_lock_required'));
  }
  if (!contract.atomicQueue?.length) {
    blockers.push(issue('human_feedback_atomic_queue_required'));
  }

  const activeItems = (contract.atomicQueue || []).filter((item) => item.status === 'active');
  const activeId = normalizeText(contract.activeAtomicChange?.id || '');
  if (!activeId) {
    blockers.push(issue('human_feedback_active_atomic_change_required'));
  }
  if (activeItems.length !== 1) {
    blockers.push(issue('human_feedback_exactly_one_active_atomic_change_required', `active=${activeItems.length}`));
  }
  if (activeId && contract.atomicQueue?.length && !contract.atomicQueue.some((item) => item.id === activeId)) {
    blockers.push(issue('human_feedback_active_atomic_change_not_in_queue', activeId));
  }
  blockers.push(...activeSourceRefBlockers(contract));
  if (!contract.unchangedRegressionChecklist?.length) {
    blockers.push(issue('human_feedback_unchanged_regression_checklist_required'));
  }
  if (!Object.values(HUMAN_FEEDBACK_PREVIEW_CLASSES).includes(contract.previewClass)) {
    blockers.push(issue('human_feedback_preview_class_invalid', contract.previewClass));
  }
  blockers.push(...contextBindingBlockers(contract, {
    ...(context || {}),
    taskKey: taskKey || context?.taskKey || null,
    channelId: channelId || context?.channelId || null,
    externalId: externalId || context?.externalId || null,
  }));

  return { blockers, warnings };
}

function legacyStageReviewGateBlockers(contract) {
  const gate = contract?.reviewGate || null;
  const blockers = [];
  if (!(gate?.ok === true || gate?.decision === 'pass')) {
    blockers.push(issue('human_feedback_review_gate_pass_required'));
    return blockers;
  }
  for (const blocker of reviewReportShapeBlockers(gate)) {
    blockers.push(blocker);
    if (blocker.code === 'human_feedback_review_report_contract_hash_invalid') {
      blockers.push(issue('human_feedback_review_gate_contract_hash_invalid'));
    }
  }
  if (!reviewGateLooksHumanFeedback(gate)) blockers.push(issue('human_feedback_review_gate_type_required'));
  const hashBlocker = reviewGateHashBlocker(contract, gate);
  if (hashBlocker) blockers.push(hashBlocker);
  if (!reviewGateBindsToContract(contract, gate)) blockers.push(issue('human_feedback_review_gate_binding_required'));
  return blockers;
}

export function validateHumanFeedbackRevisionContractForStage(contract, {
  stage = null,
  context = null,
  taskKey = null,
  channelId = null,
  externalId = null,
} = {}) {
  const normalizedStage = normalizeHumanFeedbackStage(stage || '');
  const customerFacing = CUSTOMER_FACING_STAGES.has(normalizedStage);
  const { blockers, warnings } = validateHumanFeedbackRevisionContractBase(contract, {
    context,
    taskKey,
    channelId,
    externalId,
    checkEmbeddedReviewGateShape: false,
  });
  if (!contract || contract.kind !== 'HumanFeedbackRevisionContract') {
    return {
      ok: false,
      blockers,
      warnings,
    };
  }
  if (customerFacing) {
    if (contract.previewClass === HUMAN_FEEDBACK_PREVIEW_CLASSES.OPERATOR_PREVIEW) {
      blockers.push(issue('human_feedback_operator_preview_not_customer_facing'));
    }
    blockers.push(...legacyStageReviewGateBlockers(contract));
    if (normalizeText(contract.exitStage || '') && normalizeHumanFeedbackStage(contract.exitStage) !== normalizedStage) {
      blockers.push(issue('human_feedback_exit_stage_mismatch', `expected ${normalizedStage}, got ${contract.exitStage}`));
    }
    if (contract.generationPolicy?.localOnly === true && contract.generationPolicy?.customerFacingOverride?.approved !== true) {
      blockers.push(issue('human_feedback_local_only_artifact_not_customer_facing'));
    }
  }
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
  };
}

export function humanFeedbackRevisionContractFor(record = {}) {
  return humanFeedbackPrimaryRevisionContractFor(record)
    || record?.reviewReport?.humanFeedbackRevisionContract
    || null;
}

export function humanFeedbackPrimaryRevisionContractFor(record = {}) {
  return record?.humanFeedbackRevisionContract
    || record?.feedbackRevisionContract
    || record?.humanFeedbackContract
    || record?.plan?.humanFeedbackRevisionContract
    || record?.artifactPackage?.humanFeedbackRevisionContract
    || null;
}
