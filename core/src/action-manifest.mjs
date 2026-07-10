import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  computeCustomerMessagePreviewHash,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { EXECUTION_GATE_DECISIONS } from './execution-gates.mjs';
import { digest } from './hash-utils.mjs';
import { TRANSITION_DECISIONS } from './state-machine.mjs';
import { isHumanFeedbackWorkflow } from './human-feedback-contracts.mjs';
import {
  approvalPlanDigest,
  computeApprovalProvenanceHash,
  computeApprovalPacketHash,
  computeFreshEvidenceBundleHash,
} from './approval-evidence-hashes.mjs';

export const ACTION_MANIFEST_VERSION = 1;

export const ACTION_MANIFEST_STATUS = Object.freeze({
  READY: 'ready_for_adapter',
  BLOCKED: 'blocked_manifest',
});

const CHANNEL_ACTIONS = Object.freeze({
  [CHANNEL_IDS.ZBJ]: Object.freeze({
    [EXTERNAL_ACTIONS.PROVIDER_SPEND]: 'zbj.providerSpendGuarded',
    [EXTERNAL_ACTIONS.MODEL_SPEND]: 'zbj.modelSpendGuarded',
    [EXTERNAL_ACTIONS.LIVE_PREPARE]: 'zbj.pitchPrepareOnly',
    [EXTERNAL_ACTIONS.LIVE_SUBMIT]: 'zbj.pitchSubmitLive',
    [EXTERNAL_ACTIONS.ACCEPTANCE_APPLY]: 'zbj.acceptanceApplyLive',
    [EXTERNAL_ACTIONS.CUSTOMER_MESSAGE]: 'zbj.customerMessagePreview',
  }),
  [CHANNEL_IDS.EPWK]: Object.freeze({
    [EXTERNAL_ACTIONS.PROVIDER_SPEND]: 'epwk.providerSpendGuarded',
    [EXTERNAL_ACTIONS.MODEL_SPEND]: 'epwk.modelSpendGuarded',
    [EXTERNAL_ACTIONS.LIVE_PREPARE]: 'epwk.prepareOnly',
    [EXTERNAL_ACTIONS.LIVE_SUBMIT]: 'epwk.submitLive',
    [EXTERNAL_ACTIONS.ACCEPTANCE_APPLY]: 'epwk.acceptanceApplyLive',
    [EXTERNAL_ACTIONS.CUSTOMER_MESSAGE]: 'epwk.customerMessageLive',
  }),
  [CHANNEL_IDS.HEPTA]: Object.freeze({
    [EXTERNAL_ACTIONS.PROVIDER_SPEND]: 'hepta.providerSpendGuarded',
    [EXTERNAL_ACTIONS.MODEL_SPEND]: 'hepta.modelSpendGuarded',
    [EXTERNAL_ACTIONS.CUSTOMER_MESSAGE]: 'hepta.customerMessagePreview',
    [EXTERNAL_ACTIONS.DEPLOYMENT]: 'hepta.deliveryDeploy',
  }),
  [CHANNEL_IDS.MANUAL]: Object.freeze({
    [EXTERNAL_ACTIONS.PROVIDER_SPEND]: 'manual.providerSpendGuarded',
    [EXTERNAL_ACTIONS.MODEL_SPEND]: 'manual.modelSpendGuarded',
    [EXTERNAL_ACTIONS.CUSTOMER_MESSAGE]: 'manual.customerMessagePreview',
    [EXTERNAL_ACTIONS.DEPLOYMENT]: 'manual.deliveryExport',
  }),
});

const PROMPT_GENERATION_BINDING_KEYS = Object.freeze([
  'designReferenceRetrievalHash',
  'promptCompilerHash',
  'promptReadinessHash',
  'promptProductionContractHash',
  'generationJobId',
  'generationPromptProductionContractHash',
]);

const CHANNEL_ACTION_VARIANTS = Object.freeze({
  [CHANNEL_IDS.EPWK]: Object.freeze({
    [EXTERNAL_ACTIONS.LIVE_SUBMIT]: Object.freeze([
      'epwk.workModifyLive',
      'epwk.bidSubmitLive',
    ]),
  }),
});

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

function artifactNames(artifactPackage, gateDecision) {
  const fromPackage = (artifactPackage?.artifacts || [])
    .map((artifact) => normalizeText(artifact.filename || artifact.path || artifact.id || ''))
    .filter(Boolean);
  const fromGate = (gateDecision?.artifactNames || [])
    .map((name) => normalizeText(name))
    .filter(Boolean);
  return uniqueStrings(fromPackage.length ? fromPackage : fromGate, 64);
}

function resolveChannelAction(channelId, action) {
  return CHANNEL_ACTIONS[channelId]?.[action] || null;
}

function allowedChannelActions(channelId, action) {
  return uniqueStrings([
    CHANNEL_ACTIONS[channelId]?.[action],
    ...(CHANNEL_ACTION_VARIANTS[channelId]?.[action] || []),
  ].filter(Boolean), 32);
}

function resolveChannelActionSelection(channelId, action, adapterHints = {}) {
  const requestedActionId = normalizeText(adapterHints.adapterActionId || adapterHints.actionId || '') || null;
  const allowedActionIds = allowedChannelActions(channelId, action);
  if (requestedActionId) {
    return {
      adapterActionId: allowedActionIds.includes(requestedActionId) ? requestedActionId : null,
      requestedActionId,
      allowedActionIds,
      unsupportedRequestedActionId: !allowedActionIds.includes(requestedActionId),
    };
  }
  return {
    adapterActionId: resolveChannelAction(channelId, action),
    requestedActionId: null,
    allowedActionIds,
    unsupportedRequestedActionId: false,
  };
}

function approvalHash(approvalPacket = {}) {
  return normalizeText(approvalPacket?.approvalHash || '');
}

function evidenceHash(evidenceBundle = {}) {
  return normalizeText(evidenceBundle?.evidenceHash || '');
}

function approvalProvenanceHashFromApproval(approvalPacket = null) {
  return computeApprovalProvenanceHash(approvalPacket?.approvalProvenance || approvalPacket?.provenance);
}

function approvalProvenanceHashFromEvidence(evidenceBundle = null) {
  return computeApprovalProvenanceHash(evidenceBundle?.approvalProvenance || evidenceBundle?.approval?.approvalProvenance);
}

function approvalProvenanceHashBinding({
  gateDecision = null,
  approvalPacket = null,
  evidenceBundle = null,
} = {}) {
  const gateHashValue = normalizeText(gateDecision?.approvalProvenanceHash || '') || null;
  const approvalHashValue = approvalProvenanceHashFromApproval(approvalPacket);
  const evidenceHashValue = approvalProvenanceHashFromEvidence(evidenceBundle);
  return gateHashValue || approvalHashValue || evidenceHashValue || null;
}

function normalizedMessagePreview(messagePreview) {
  return normalizeText(messagePreview || '') || null;
}

function normalizeActionVariant(actionVariant) {
  const variant = normalizeText(actionVariant || '');
  if (!variant) return null;
  return isHumanFeedbackMessageActionAlias(variant) ? 'human_feedback_message' : variant;
}

function messagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function promptGenerationBindingFromPlanDigest(planDigest = null) {
  if (!planDigest || typeof planDigest !== 'object') return null;
  const binding = Object.fromEntries(
    PROMPT_GENERATION_BINDING_KEYS.map((key) => [key, normalizeText(planDigest[key] || '') || null]),
  );
  return PROMPT_GENERATION_BINDING_KEYS.some((key) => binding[key]) ? binding : null;
}

function promptGenerationBindingCandidates({
  plan = null,
  approvalPacket = null,
  evidenceBundle = null,
} = {}) {
  return [
    { source: 'plan', expected: Boolean(plan), binding: promptGenerationBindingFromPlanDigest(approvalPlanDigest(plan)) },
    { source: 'approval', expected: Boolean(approvalPacket?.plan), binding: promptGenerationBindingFromPlanDigest(approvalPacket?.plan) },
    { source: 'evidence', expected: Boolean(evidenceBundle?.state?.plan), binding: promptGenerationBindingFromPlanDigest(evidenceBundle?.state?.plan) },
  ];
}

function samePromptGenerationBinding(left = {}, right = {}) {
  return PROMPT_GENERATION_BINDING_KEYS.every((key) => (left?.[key] || null) === (right?.[key] || null));
}

function promptGenerationBindingFromCandidates(candidates = []) {
  return candidates.find((candidate) => candidate.binding)?.binding || null;
}

function missingPromptGenerationBindingKeys(binding = null) {
  return PROMPT_GENERATION_BINDING_KEYS.filter((key) => !normalizeText(binding?.[key] || ''));
}

function promptGenerationManifestBlockers({ action, candidates = [] } = {}) {
  const blockers = [];
  const promptGenerationSpend = [EXTERNAL_ACTIONS.PROVIDER_SPEND, EXTERNAL_ACTIONS.MODEL_SPEND].includes(action);
  const presentCandidates = candidates.filter((candidate) => candidate.binding);
  if (!presentCandidates.length) {
    if (promptGenerationSpend) {
      blockers.push(issue(
        'prompt_generation_manifest_binding_required',
        'designReferenceRetrievalHash, promptCompilerHash, promptReadinessHash, promptProductionContractHash, generationJobId, generationPromptProductionContractHash',
      ));
    }
    return blockers;
  }
  const binding = promptGenerationBindingFromCandidates(candidates);
  const mismatchedSources = presentCandidates
    .filter((candidate) => !samePromptGenerationBinding(binding, candidate.binding))
    .map((candidate) => candidate.source);
  if (mismatchedSources.length) {
    blockers.push(issue('prompt_generation_manifest_binding_mismatch', mismatchedSources.join(', ')));
  }
  if (promptGenerationSpend) {
    const expectedMissingSources = candidates
      .filter((candidate) => candidate.expected && !candidate.binding)
      .map((candidate) => candidate.source);
    if (expectedMissingSources.length) {
      blockers.push(issue('prompt_generation_manifest_binding_source_required', expectedMissingSources.join(', ')));
    }
    for (const candidate of presentCandidates) {
      const missingSourceKeys = missingPromptGenerationBindingKeys(candidate.binding);
      if (missingSourceKeys.length) {
        blockers.push(issue(
          `prompt_generation_manifest_${candidate.source}_binding_incomplete`,
          missingSourceKeys.join(', '),
        ));
      }
    }
    const missingKeys = missingPromptGenerationBindingKeys(binding);
    if (missingKeys.length) {
      blockers.push(issue('prompt_generation_manifest_binding_required', missingKeys.join(', ')));
    }
  }
  return blockers;
}

function manifestHashAdapter(adapter = null) {
  if (!adapter || typeof adapter !== 'object') return adapter || null;
  const hashAdapter = { ...adapter };
  if (Object.hasOwn(hashAdapter, 'sideEffectClass')) {
    hashAdapter.sideEffectClass = canonicalExternalActionOrNull(hashAdapter.sideEffectClass);
  }
  if (hashAdapter.hints && typeof hashAdapter.hints === 'object') {
    hashAdapter.hints = { ...hashAdapter.hints };
    if (Object.hasOwn(hashAdapter.hints, 'actionVariant')) {
      hashAdapter.hints.actionVariant = normalizeActionVariant(hashAdapter.hints.actionVariant);
    }
  }
  return hashAdapter;
}

function manifestHashPayload(payload = null) {
  if (!payload || typeof payload !== 'object') return payload || null;
  const hashPayload = { ...payload };
  if (Object.hasOwn(hashPayload, 'action')) {
    hashPayload.action = canonicalExternalActionOrNull(hashPayload.action);
  }
  if (Object.hasOwn(hashPayload, 'productLineId')) {
    hashPayload.productLineId = canonicalProductLineIdOrNull(hashPayload.productLineId);
  }
  if (Object.hasOwn(hashPayload, 'workflowId')) {
    hashPayload.workflowId = canonicalProductLineIdOrNull(hashPayload.workflowId);
  }
  if (Object.hasOwn(hashPayload, 'packageRole')) {
    hashPayload.packageRole = canonicalPackageRole(hashPayload.packageRole);
  }
  return hashPayload;
}

function channelActionManifestHashPayload(manifest = {}) {
  return {
    version: manifest?.version,
    kind: manifest?.kind || null,
    taskKey: manifest?.taskKey || null,
    channelId: manifest?.channelId || null,
    productLineId: canonicalProductLineIdOrNull(manifest?.productLineId),
    workflowId: canonicalProductLineIdOrNull(manifest?.workflowId),
    action: canonicalExternalActionOrNull(manifest?.action),
    status: manifest?.status || null,
    adapter: manifestHashAdapter(manifest?.adapter || null),
    payload: manifestHashPayload(manifest?.payload || null),
    blockers: manifest?.blockers || [],
    warnings: manifest?.warnings || [],
    evidenceRefs: manifest?.evidenceRefs || [],
  };
}

export function computeChannelActionManifestHash(manifest = {}) {
  return digest(channelActionManifestHashPayload(manifest));
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

function approvalFeedbackContractHashes(approvalPacket = {}) {
  return uniqueStrings([
    approvalPacket?.plan?.humanFeedbackRevisionContractHash,
    approvalPacket?.artifactPackage?.humanFeedbackRevisionContractHash,
    approvalPacket?.reviewReport?.humanFeedbackRevisionContractHash,
  ], 8);
}

function evidenceFeedbackContractHashes(evidenceBundle = {}) {
  return uniqueStrings([
    evidenceBundle?.state?.plan?.humanFeedbackRevisionContractHash,
    evidenceBundle?.state?.artifactPackage?.humanFeedbackRevisionContractHash,
    evidenceBundle?.state?.reviewReport?.humanFeedbackRevisionContractHash,
  ], 8);
}

function humanFeedbackContractHashes({
  plan = null,
  artifactPackage = null,
  reviewReport = null,
  gateDecision = null,
  approvalPacket = null,
  evidenceBundle = null,
} = {}) {
  return uniqueStrings([
    plan?.humanFeedbackRevisionContract?.contractHash,
    artifactPackage?.humanFeedbackRevisionContract?.contractHash,
    reviewReport?.humanFeedbackRevisionContract?.contractHash,
    gateDecision?.humanFeedbackRevisionContractHash,
    ...approvalFeedbackContractHashes(approvalPacket),
    ...evidenceFeedbackContractHashes(evidenceBundle),
  ], 16);
}

function humanFeedbackContractHashBinding(hashes = []) {
  return hashes.length === 1 ? hashes[0] : null;
}

function humanFeedbackMessagePreviewBinding(approvalPacket = null, evidenceBundle = null) {
  const approvalPreview = normalizedMessagePreview(approvalPacket?.messagePreview);
  const evidencePreview = normalizedMessagePreview(evidenceBundle?.state?.messagePreview);
  const blockers = [];
  if (!approvalPreview) blockers.push(issue('human_feedback_manifest_approval_message_preview_required'));
  if (!evidencePreview) blockers.push(issue('human_feedback_manifest_evidence_message_preview_required'));
  if (approvalPreview && evidencePreview && approvalPreview !== evidencePreview) {
    blockers.push(issue('human_feedback_manifest_message_preview_mismatch'));
  }
  const messagePreview = approvalPreview && evidencePreview && approvalPreview === evidencePreview
    ? approvalPreview
    : null;
  return {
    messagePreview,
    messagePreviewHash: messagePreviewHash(messagePreview),
    blockers,
  };
}

function humanFeedbackScopedRecordBlockers(record, label, { taskKey, channelId, externalId } = {}) {
  if (!record) return [];
  const blockers = [];
  for (const [field, suffix] of [
    ['taskKey', 'task'],
    ['channelId', 'channel'],
    ['externalId', 'external_id'],
  ]) {
    const expected = normalizeText({ taskKey, channelId, externalId }[field] || '');
    if (!expected) continue;
    const actual = normalizeText(record?.[field] || '');
    if (!actual) {
      blockers.push(issue(`human_feedback_manifest_${label}_${suffix}_required`, expected));
    } else if (actual !== expected) {
      blockers.push(issue(
        `human_feedback_manifest_${label}_${suffix}_mismatch`,
        `expected ${expected}, got ${actual}`,
      ));
    }
  }
  return blockers;
}

function manifestScopedRecordBlockers(record, label, { taskKey, channelId, externalId } = {}) {
  if (!record) return [];
  const blockers = [];
  for (const [field, suffix] of [
    ['taskKey', 'task'],
    ['channelId', 'channel'],
    ['externalId', 'external_id'],
  ]) {
    const expected = normalizeText({ taskKey, channelId, externalId }[field] || '');
    if (!expected) continue;
    const actual = normalizeText(record?.[field] || '');
    if (!actual) {
      blockers.push(issue(`manifest_${label}_${suffix}_required`, expected));
    } else if (actual !== expected) {
      blockers.push(issue(`manifest_${label}_${suffix}_mismatch`, `expected ${expected}, got ${actual}`));
    }
  }
  return blockers;
}

function transitionTaskBindingBlockers(transitionResult, { taskKey } = {}) {
  if (!transitionResult) return [];
  const expected = normalizeText(taskKey || '');
  if (!expected) return [];
  const actual = normalizeText(
    transitionResult.taskKey
      || transitionResult.decision?.taskKey
      || transitionResult.auditEvent?.taskKey
      || '',
  );
  if (!actual) return [issue('manifest_transition_task_required', expected)];
  if (actual !== expected) {
    return [issue('manifest_transition_task_mismatch', `expected ${expected}, got ${actual}`)];
  }
  return [];
}

function customerMessagePreviewBinding({
  gateDecision = null,
  approvalPacket = null,
  evidenceBundle = null,
} = {}) {
  const gatePreview = normalizedMessagePreview(gateDecision?.messagePreview);
  const gatePreviewHash = normalizeText(gateDecision?.messagePreviewHash || '');
  const expectedGatePreviewHash = messagePreviewHash(gatePreview);
  const approvalPreview = normalizedMessagePreview(approvalPacket?.messagePreview);
  const evidencePreview = normalizedMessagePreview(evidenceBundle?.state?.messagePreview);
  const previews = uniqueStrings([gatePreview, approvalPreview, evidencePreview].filter(Boolean), 4);
  const blockers = [];
  if (!gatePreview) {
    blockers.push(issue('customer_message_gate_preview_required'));
  } else if (!gatePreviewHash) {
    blockers.push(issue('customer_message_gate_preview_hash_required'));
  } else if (gatePreviewHash !== expectedGatePreviewHash) {
    blockers.push(issue('customer_message_gate_preview_hash_mismatch'));
  }
  if (!previews.length) {
    blockers.push(issue('customer_message_preview_required'));
  }
  if (previews.length > 1) {
    blockers.push(issue('customer_message_preview_mismatch'));
  }
  const messagePreview = previews.length === 1 ? previews[0] : null;
  return {
    messagePreview,
    messagePreviewHash: messagePreviewHash(messagePreview),
    blockers,
  };
}

function isHumanFeedbackManifest({
  action,
  requestedAction = null,
  plan = null,
  artifactPackage = null,
  reviewReport = null,
  gateDecision = null,
  approvalPacket = null,
  evidenceBundle = null,
} = {}) {
  if (!isHumanFeedbackCustomerFacingAction(action)) return false;
  const isHumanFeedbackValue = (value) => (
    canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || isHumanFeedbackWorkflow(value)
  );
  return isHumanFeedbackMessageActionAlias(requestedAction)
    || [
      plan?.productLineId,
      plan?.workflowId,
      artifactPackage?.productLineId,
      artifactPackage?.workflowId,
      artifactPackage?.packageRole,
      artifactPackage?.reviewType,
      artifactPackage?.role,
      reviewReport?.productLineId,
      reviewReport?.workflowId,
      reviewReport?.packageRole,
      reviewReport?.reviewType,
      reviewReport?.role,
      gateDecision?.productLineId,
      gateDecision?.workflowId,
      gateDecision?.packageRole,
      gateDecision?.reviewType,
      gateDecision?.role,
    ].some(isHumanFeedbackValue)
    || recordLooksHumanFeedback(approvalPacket)
    || recordLooksHumanFeedback(evidenceBundle)
    || approvalFeedbackContractHashes(approvalPacket).length > 0
    || evidenceFeedbackContractHashes(evidenceBundle).length > 0;
}

function manifestBlockers({
  taskKey,
  channelId,
  externalId,
  action,
  gateDecision,
  transitionResult,
  approvalPacket,
  evidenceBundle,
  adapterActionId,
  unsupportedRequestedActionId,
  requestedActionId,
  humanFeedbackManifest = false,
  humanFeedbackMessageManifest = false,
  humanFeedbackMessagePreview = null,
  customerMessagePreview = null,
  humanFeedbackContractHashes: feedbackContractHashes = [],
  promptGenerationBindingCandidates: promptGenerationCandidates = [],
}) {
  const blockers = [];
  const gateApprovalHash = normalizeText(gateDecision?.approvalHash || '');
  const gateEvidenceHash = normalizeText(gateDecision?.evidenceHash || '');
  const transitionGateApprovalHash = normalizeText(transitionResult?.decision?.gateDecision?.approvalHash || transitionResult?.auditEvent?.approvalHash || '');
  const transitionGateEvidenceHash = normalizeText(transitionResult?.decision?.gateDecision?.evidenceHash || transitionResult?.auditEvent?.evidenceHash || '');
  const packetApprovalHash = approvalHash(approvalPacket);
  const bundleEvidenceHash = evidenceHash(evidenceBundle);
  const packetApprovalGenericHash = normalizeText(approvalPacket?.hash || '');
  const bundleEvidenceGenericHash = normalizeText(evidenceBundle?.hash || '');
  const packetApprovalProvenanceHash = approvalProvenanceHashFromApproval(approvalPacket);
  const bundleApprovalProvenanceHash = approvalProvenanceHashFromEvidence(evidenceBundle);
  if (!Object.values(CHANNEL_IDS).includes(channelId)) blockers.push(issue('unknown_channel_id'));
  if (!Object.values(EXTERNAL_ACTIONS).includes(action)) blockers.push(issue('unknown_external_action'));
  if (humanFeedbackManifest && !normalizeText(externalId || '')) {
    blockers.push(issue('human_feedback_manifest_external_id_required'));
  }
  if (humanFeedbackManifest) {
    const scope = { taskKey, channelId, externalId };
    blockers.push(...humanFeedbackScopedRecordBlockers(approvalPacket, 'approval', scope));
    blockers.push(...humanFeedbackScopedRecordBlockers(evidenceBundle, 'evidence', scope));
  }
  if (humanFeedbackManifest && feedbackContractHashes.length === 0) {
    blockers.push(issue('human_feedback_manifest_contract_hash_required'));
  }
  if (humanFeedbackManifest && feedbackContractHashes.length > 1) {
    blockers.push(issue('human_feedback_manifest_contract_hash_drift', feedbackContractHashes.join(', ')));
  }
  if (!adapterActionId) blockers.push(issue('channel_action_not_supported'));
  if (unsupportedRequestedActionId) blockers.push(issue('adapter_action_hint_not_supported', requestedActionId));
  if (gateDecision?.action && canonicalExternalAction(gateDecision.action) !== action) blockers.push(issue('gate_action_mismatch'));
  if (transitionResult?.decision?.action && canonicalExternalAction(transitionResult.decision.action) !== action) blockers.push(issue('transition_action_mismatch'));
  if (action !== EXTERNAL_ACTIONS.NONE) {
    blockers.push(...manifestScopedRecordBlockers(gateDecision, 'gate', { taskKey, channelId, externalId }));
    blockers.push(...transitionTaskBindingBlockers(transitionResult, { taskKey }));
  }
  if (gateDecision?.decision !== EXECUTION_GATE_DECISIONS.ALLOW || gateDecision?.allowed !== true) {
    blockers.push(issue('execution_gate_not_allowed'));
  }
  if (transitionResult?.decision?.decision !== TRANSITION_DECISIONS.ALLOW || transitionResult?.allowed !== true) {
    blockers.push(issue('state_transition_not_allowed'));
  }
  if (!normalizeText(gateDecision?.approvalHash) || !normalizeText(gateDecision?.evidenceHash)) {
    blockers.push(issue('manifest_hash_binding_required'));
  }
  if (gateApprovalHash && !transitionGateApprovalHash) {
    blockers.push(issue('transition_gate_approval_hash_required'));
  } else if (transitionGateApprovalHash && gateApprovalHash && transitionGateApprovalHash !== gateApprovalHash) {
    blockers.push(issue('transition_gate_approval_hash_mismatch'));
  }
  if (gateEvidenceHash && !transitionGateEvidenceHash) {
    blockers.push(issue('transition_gate_evidence_hash_required'));
  } else if (transitionGateEvidenceHash && gateEvidenceHash && transitionGateEvidenceHash !== gateEvidenceHash) {
    blockers.push(issue('transition_gate_evidence_hash_mismatch'));
  }
  if (approvalPacket) {
    if (approvalPacket.kind === 'ApprovalPacket') {
      if (!packetApprovalGenericHash) blockers.push(issue('manifest_approval_generic_hash_required'));
      if (packetApprovalHash && packetApprovalGenericHash && packetApprovalHash !== packetApprovalGenericHash) {
        blockers.push(issue('manifest_approval_hash_alias_mismatch'));
      }
      if (!packetApprovalProvenanceHash) blockers.push(issue('manifest_approval_provenance_hash_required'));
    }
    if (!packetApprovalHash) {
      blockers.push(issue('manifest_approval_hash_required'));
    } else {
      if (gateApprovalHash && packetApprovalHash !== gateApprovalHash) {
        blockers.push(issue('manifest_approval_hash_mismatch'));
      }
      if (computeApprovalPacketHash(approvalPacket) !== packetApprovalHash) {
        blockers.push(issue('manifest_approval_hash_content_mismatch'));
      }
    }
  }
  if (evidenceBundle) {
    if (evidenceBundle.kind === 'FreshEvidenceBundle') {
      if (!bundleEvidenceGenericHash) blockers.push(issue('manifest_evidence_generic_hash_required'));
      if (bundleEvidenceHash && bundleEvidenceGenericHash && bundleEvidenceHash !== bundleEvidenceGenericHash) {
        blockers.push(issue('manifest_evidence_hash_alias_mismatch'));
      }
      if (!bundleApprovalProvenanceHash) blockers.push(issue('manifest_evidence_approval_provenance_hash_required'));
    }
    if (!bundleEvidenceHash) {
      blockers.push(issue('manifest_evidence_hash_required'));
    } else {
      if (gateEvidenceHash && bundleEvidenceHash !== gateEvidenceHash) {
        blockers.push(issue('manifest_evidence_hash_mismatch'));
      }
      if (computeFreshEvidenceBundleHash(evidenceBundle) !== bundleEvidenceHash) {
        blockers.push(issue('manifest_evidence_hash_content_mismatch'));
      }
    }
  }
  if (
    packetApprovalProvenanceHash
    && bundleApprovalProvenanceHash
    && packetApprovalProvenanceHash !== bundleApprovalProvenanceHash
  ) {
    blockers.push(issue('manifest_approval_provenance_hash_mismatch'));
  }
  if (humanFeedbackManifest && !approvalPacket) {
    blockers.push(issue('human_feedback_manifest_approval_packet_required'));
  } else if (humanFeedbackManifest && approvalPacket?.kind !== 'ApprovalPacket') {
    blockers.push(issue('human_feedback_manifest_approval_packet_shape_required'));
  } else if (humanFeedbackManifest && !packetApprovalHash) {
    blockers.push(issue('human_feedback_manifest_approval_hash_required'));
  } else if (humanFeedbackManifest && computeApprovalPacketHash(approvalPacket) !== packetApprovalHash) {
    blockers.push(issue('human_feedback_manifest_approval_hash_content_mismatch'));
  }
  if (humanFeedbackManifest && approvalPacket) {
    const approvalContractHashes = approvalFeedbackContractHashes(approvalPacket);
    const boundContractHash = humanFeedbackContractHashBinding(feedbackContractHashes);
    if (!approvalContractHashes.length) {
      blockers.push(issue('human_feedback_manifest_approval_contract_hash_required'));
    } else if (approvalContractHashes.length > 1 || (boundContractHash && approvalContractHashes[0] !== boundContractHash)) {
      blockers.push(issue('human_feedback_manifest_approval_contract_hash_mismatch'));
    }
  }
  if (humanFeedbackManifest && !evidenceBundle) {
    blockers.push(issue('human_feedback_manifest_evidence_bundle_required'));
  } else if (humanFeedbackManifest && evidenceBundle?.kind !== 'FreshEvidenceBundle') {
    blockers.push(issue('human_feedback_manifest_evidence_bundle_shape_required'));
  } else if (humanFeedbackManifest && !bundleEvidenceHash) {
    blockers.push(issue('human_feedback_manifest_evidence_hash_required'));
  } else if (humanFeedbackManifest && computeFreshEvidenceBundleHash(evidenceBundle) !== bundleEvidenceHash) {
    blockers.push(issue('human_feedback_manifest_evidence_hash_content_mismatch'));
  }
  if (humanFeedbackManifest && evidenceBundle) {
    const evidenceContractHashes = evidenceFeedbackContractHashes(evidenceBundle);
    const boundContractHash = humanFeedbackContractHashBinding(feedbackContractHashes);
    if (!evidenceContractHashes.length) {
      blockers.push(issue('human_feedback_manifest_evidence_contract_hash_required'));
    } else if (evidenceContractHashes.length > 1 || (boundContractHash && evidenceContractHashes[0] !== boundContractHash)) {
      blockers.push(issue('human_feedback_manifest_evidence_contract_hash_mismatch'));
    }
  }
  if (humanFeedbackMessageManifest) {
    blockers.push(...(humanFeedbackMessagePreview?.blockers || []));
  }
  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    blockers.push(...(customerMessagePreview?.blockers || []));
  }
  blockers.push(...promptGenerationManifestBlockers({
    action,
    candidates: promptGenerationCandidates,
  }));
  return blockers;
}

export function buildChannelActionManifest({
  action,
  channelTask = null,
  plan = null,
  artifactPackage = null,
  reviewReport = null,
  gateDecision = null,
  transitionResult = null,
  approvalPacket = null,
  evidenceBundle = null,
  adapterHints = {},
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const channelId = channelTask?.channelId || plan?.channelId || artifactPackage?.channelId || gateDecision?.channelId || null;
  const taskKey = channelTask?.taskKey || plan?.taskKey || artifactPackage?.taskKey || gateDecision?.taskKey || transitionResult?.taskKey || null;
  const externalId = channelTask?.externalId || plan?.externalId || artifactPackage?.externalId || reviewReport?.externalId || gateDecision?.externalId || null;
  const requestedAction = action || gateDecision?.action || transitionResult?.action || EXTERNAL_ACTIONS.NONE;
  const normalizedAction = canonicalExternalAction(requestedAction);
  const productLineId = canonicalProductLineIdOrNull(plan?.productLineId || artifactPackage?.productLineId || gateDecision?.productLineId);
  const workflowId = canonicalProductLineIdOrNull(plan?.workflowId || artifactPackage?.workflowId || gateDecision?.workflowId);
  const actionSelection = resolveChannelActionSelection(channelId, normalizedAction, adapterHints);
  const { adapterActionId } = actionSelection;
  const humanFeedbackManifest = isHumanFeedbackManifest({
    action: normalizedAction,
    requestedAction,
    plan,
    artifactPackage,
    reviewReport,
    gateDecision,
    approvalPacket,
    evidenceBundle,
  });
  const humanFeedbackMessageManifest = humanFeedbackManifest
    && normalizedAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
  const humanFeedbackMessagePreview = humanFeedbackMessageManifest
    ? humanFeedbackMessagePreviewBinding(approvalPacket, evidenceBundle)
    : null;
  const customerMessagePreview = normalizedAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
    ? customerMessagePreviewBinding({ gateDecision, approvalPacket, evidenceBundle })
    : null;
  const feedbackContractHashes = humanFeedbackContractHashes({
    plan,
    artifactPackage,
    reviewReport,
    gateDecision,
    approvalPacket,
    evidenceBundle,
  });
  const humanFeedbackRevisionContractHash = humanFeedbackManifest
    ? humanFeedbackContractHashBinding(feedbackContractHashes)
    : null;
  const promptGenerationCandidates = promptGenerationBindingCandidates({
    plan,
    approvalPacket,
    evidenceBundle,
  });
  const promptGenerationBinding = promptGenerationBindingFromCandidates(promptGenerationCandidates);
  const approvalProvenanceHash = approvalProvenanceHashBinding({
    gateDecision,
    approvalPacket,
    evidenceBundle,
  });
  const blockers = manifestBlockers({
    taskKey,
    channelId,
    externalId,
    action: normalizedAction,
    gateDecision,
    transitionResult,
    approvalPacket,
    evidenceBundle,
    adapterActionId,
    unsupportedRequestedActionId: actionSelection.unsupportedRequestedActionId,
    requestedActionId: actionSelection.requestedActionId,
    humanFeedbackManifest,
    humanFeedbackMessageManifest,
    humanFeedbackMessagePreview,
    customerMessagePreview,
    humanFeedbackContractHashes: feedbackContractHashes,
    promptGenerationBindingCandidates: promptGenerationCandidates,
  });
  const names = artifactNames(artifactPackage, gateDecision);

  const manifest = {
    version: ACTION_MANIFEST_VERSION,
    kind: 'ChannelActionManifest',
    taskKey,
    channelId,
    productLineId,
    workflowId,
    action: normalizedAction,
    status: blockers.length ? ACTION_MANIFEST_STATUS.BLOCKED : ACTION_MANIFEST_STATUS.READY,
    readyForAdapter: blockers.length === 0,
    adapter: {
      actionId: adapterActionId,
      channelId,
      dryRunDefault: true,
      executeFlagRequired: true,
      sideEffectClass: normalizedAction,
      hints: {
        mode: normalizeText(adapterHints.mode || '') || null,
        actionVariant: normalizeActionVariant(adapterHints.actionVariant),
        requestedActionId: actionSelection.requestedActionId,
        uploadBatchSize: adapterHints.uploadBatchSize ?? null,
        allowResubmit: Boolean(adapterHints.allowResubmit),
      },
    },
    payload: {
      externalId,
      title: normalizeText(channelTask?.title || '') || null,
      outputMode: plan?.outputMode || artifactPackage?.outputMode || null,
      packageRole: canonicalPackageRole(artifactPackage?.packageRole || '') || null,
      artifactCount: names.length,
      artifactNames: names,
      reviewDecision: reviewReport?.decision || null,
      approvalHash: normalizeText(gateDecision?.approvalHash || approvalPacket?.approvalHash || '') || null,
      evidenceHash: normalizeText(gateDecision?.evidenceHash || evidenceBundle?.evidenceHash || '') || null,
      approvalProvenanceHash,
      humanFeedbackRevisionContractHash,
      ...(promptGenerationBinding
        ? { promptGenerationBinding }
        : {}),
      ...(normalizedAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
        ? {
          messagePreview: humanFeedbackMessagePreview?.messagePreview || customerMessagePreview?.messagePreview || null,
          messagePreviewHash: humanFeedbackMessagePreview?.messagePreviewHash || customerMessagePreview?.messagePreviewHash || null,
        }
        : {}),
      transition: transitionResult
        ? {
          fromStage: transitionResult.previousStage || transitionResult.decision?.fromStage || null,
          toStage: transitionResult.stage || transitionResult.requestedStage || transitionResult.decision?.toStage || null,
          auditDecision: transitionResult.auditEvent?.decision || null,
        }
        : null,
    },
    blockers,
    warnings: [
      ...(gateDecision?.warnings || []).map((warning) => issue(warning.code || warning, warning.notes || null, 'warning')),
      ...(transitionResult?.decision?.warnings || []).map((warning) => issue(warning.code || warning, warning.notes || null, 'warning')),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      manifestOnly: true,
      executesExternalAction: false,
      adapterMayExecuteExternalAction: blockers.length === 0,
      requiresExplicitAdapterRunner: true,
      approvalHashRequired: true,
      evidenceHashRequired: true,
      sourceSnapshotRedacted: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const manifestHash = computeChannelActionManifestHash(manifest);
  return {
    ...manifest,
    manifestHash,
    hash: manifestHash,
  };
}

export function summarizeActionManifests(manifests = []) {
  const byChannel = {};
  const byAction = {};
  const byStatus = {};
  const byAdapterAction = {};
  const blockerCodes = {};
  for (const manifest of manifests || []) {
    byChannel[manifest.channelId] = (byChannel[manifest.channelId] || 0) + 1;
    const action = canonicalExternalActionOrNull(manifest.action) || 'unknown';
    byAction[action] = (byAction[action] || 0) + 1;
    byStatus[manifest.status] = (byStatus[manifest.status] || 0) + 1;
    const actionId = manifest.adapter?.actionId || 'unsupported';
    byAdapterAction[actionId] = (byAdapterAction[actionId] || 0) + 1;
    for (const blocker of manifest.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ACTION_MANIFEST_VERSION,
    count: manifests.length,
    byChannel,
    byAction,
    byStatus,
    byAdapterAction,
    blockerCodes,
    safety: {
      manifestOnly: true,
      executesExternalAction: manifests.some((manifest) => manifest.safety?.executesExternalAction === true),
    },
  };
}
