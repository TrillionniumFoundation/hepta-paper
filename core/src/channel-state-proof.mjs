import {
  CORE_STAGES,
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  computeCustomerMessagePreviewHash,
  computeCustomerMessagePreviewHashFromFields,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { EXECUTION_GATE_DECISIONS } from './execution-gates.mjs';
import { digest } from './hash-utils.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, computeAdapterRunReceiptHash } from './adapter-receipt.mjs';
import { applyStateTransition } from './state-machine.mjs';

export const CHANNEL_STATE_PROOF_VERSION = 1;

export const CHANNEL_STATE_PROOF_STATUS = Object.freeze({
  VERIFIED: 'verified_state_proof',
  BLOCKED: 'blocked_state_proof',
});

export const RECEIPT_TRANSITION_STATUS = Object.freeze({
  READY: 'receipt_transition_ready',
  BLOCKED: 'blocked_receipt_transition',
});

const SUBMISSION_NOT_CONFIRMED_STATE_CODES = new Set([
  'no_my_works_records',
  'not_found',
  'missing',
  'missing_submission',
  'submission_missing',
  'works_missing',
]);

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

function normalizeNames(values = []) {
  return uniqueStrings((values || []).map((item) => {
    if (typeof item === 'string') return item;
    return item?.filename || item?.name || item?.path || item?.id || '';
  }), 128);
}

function normalizeStateCode(value) {
  return normalizeText(value || '').toLowerCase().replaceAll(' ', '_').replaceAll('-', '_');
}

function sorted(values = []) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameNameSet(left = [], right = []) {
  const leftSorted = sorted(left);
  const rightSorted = sorted(right);
  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
}

function computedMessagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function pushIssueOnce(blockers, code) {
  if (!blockers.some((item) => item.code === code)) blockers.push(issue(code));
}

function addMessagePreviewContentBlocker(value, expectedHash, code, blockers) {
  const normalizedExpected = normalizeText(expectedHash || '');
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

function receiptCarriesHumanFeedbackCustomerFacingAction(receipt, action) {
  const actionValues = [
    action,
    receipt?.action,
    receipt?.payload?.action,
    receipt?.result?.external?.action,
  ];
  const productValues = [
    receipt?.payload?.productLineId,
    receipt?.payload?.workflowId,
    receipt?.payload?.packageRole,
    receipt?.payload?.reviewType,
    receipt?.payload?.role,
    receipt?.result?.external?.productLineId,
    receipt?.result?.external?.workflowId,
    receipt?.result?.external?.packageRole,
    receipt?.result?.external?.reviewType,
    receipt?.result?.external?.role,
  ];
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && (
      actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || productValues.some((value) => (
        canonicalProductLineId(value || '') === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
          || canonicalProductLineId(canonicalPackageRole(value || '')) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
      ))
    );
}

function proofHashPayload(payload = null) {
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

function proofHashStateSuggestion(value = null) {
  if (!value) return value;
  return {
    ...value,
    action: canonicalActionOrNull(value.action),
  };
}

function transitionHashGateDecision(value = null) {
  if (!value) return value;
  return {
    ...value,
    action: canonicalActionOrNull(value.action),
  };
}

function transitionHashDecision(value = null) {
  if (!value) return value;
  return {
    ...value,
    action: canonicalActionOrNull(value.action),
    gateDecision: transitionHashGateDecision(value.gateDecision),
  };
}

function transitionHashAuditEvent(value = null) {
  if (!value) return value;
  return {
    ...value,
    action: canonicalActionOrNull(value.action),
  };
}

function transitionHashResult(value = null) {
  if (!value) return value;
  return {
    ...value,
    decision: transitionHashDecision(value.decision),
    auditEvent: transitionHashAuditEvent(value.auditEvent),
  };
}

function normalizeStateEvidence(value = {}) {
  const artifactNames = normalizeNames(value.artifactNames || value.uploadedArtifactNames || value.uploadedFiles || value.files || []);
  const messagePreviewContentHash = computeCustomerMessagePreviewHashFromFields(value);
  const messagePreviewHash = normalizeText(value.messagePreviewHash || value.previewHash || '') || messagePreviewContentHash;
  return {
    ok: value.ok === undefined ? null : Boolean(value.ok),
    verified: value.verified === undefined ? null : Boolean(value.verified),
    landed: value.landed === undefined ? null : Boolean(value.landed),
    externalId: normalizeText(value.externalId || '') || null,
    worksId: normalizeText(value.worksId || value.workId || '') || null,
    submissionId: normalizeText(value.submissionId || value.manuscriptId || '') || null,
    prepareId: normalizeText(value.prepareId || value.prepareRunId || '') || null,
    acceptanceId: normalizeText(value.acceptanceId || value.acceptanceApplyId || '') || null,
    messageId: normalizeText(value.messageId || '') || null,
    messagePreviewHash: messagePreviewHash || null,
    messagePreviewContentHash: messagePreviewContentHash || null,
    humanFeedbackRevisionContractHash: normalizeText(
      value.humanFeedbackRevisionContractHash
        || value.feedbackRevisionContractHash
        || value.humanFeedbackContractHash
        || '',
    ) || null,
    promptGenerationBinding: value.promptGenerationBinding || null,
    deploymentId: normalizeText(value.deploymentId || value.deployId || '') || null,
    buildId: normalizeText(value.buildId || '') || null,
    providerRunId: normalizeText(value.providerRunId || '') || null,
    modelRunId: normalizeText(value.modelRunId || '') || null,
    cacheKey: normalizeText(value.cacheKey || '') || null,
    url: normalizeText(value.url || '') || null,
    stateText: normalizeText(value.stateText || value.statusText || value.status || '') || null,
    stateCode: normalizeStateCode(value.stateCode || value.statusCode || value.failureCode || value.errorCode || '') || null,
    submissionConfirmed: value.submissionConfirmed === undefined || value.submissionConfirmed === null
      ? null
      : Boolean(value.submissionConfirmed),
    failureCode: normalizeText(value.failureCode || value.errorCode || '') || null,
    receiptHash: normalizeText(value.receiptHash || '') || null,
    artifactNames,
    artifactCount: Number.isFinite(Number(value.artifactCount)) ? Number(value.artifactCount) : (artifactNames.length || null),
    totalMyWorks: Number.isFinite(Number(value.totalMyWorks)) ? Number(value.totalMyWorks) : null,
    worksIsHidden: value.worksIsHidden === undefined ? null : Boolean(value.worksIsHidden),
    buyerIsHide: value.buyerIsHide === undefined ? null : Boolean(value.buyerIsHide),
    prepareEvidenceOk: value.prepareEvidenceOk === undefined ? null : Boolean(value.prepareEvidenceOk),
    buildEvidenceOk: value.buildEvidenceOk === undefined ? null : Boolean(value.buildEvidenceOk),
  };
}

function receiptExternal(receipt) {
  return receipt?.result?.external || {};
}

function receiptRequiredHash(receipt, key) {
  return normalizeText(
    receipt?.hashBinding?.[key]
      || receipt?.payload?.[key]
      || receipt?.result?.external?.[key]
      || '',
  ) || null;
}

function storedHashAliases(value = null, semanticKey) {
  const semanticHash = normalizeText(value?.[semanticKey] || '') || null;
  const genericHash = normalizeText(value?.hash || '') || null;
  return {
    semanticHash,
    genericHash,
    effectiveHash: semanticHash,
  };
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

function receiptPromptGenerationBinding(receipt = null) {
  return receipt?.hashBinding?.promptGenerationBinding
    || receipt?.payload?.promptGenerationBinding
    || receipt?.result?.external?.promptGenerationBinding
    || null;
}

function proofPromptGenerationBinding(proof = null) {
  return proof?.hashBinding?.promptGenerationBinding
    || proof?.payload?.promptGenerationBinding
    || proof?.evidence?.promptGenerationBinding
    || null;
}

function isPromptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonical === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function proofRequiredHash(proof, key) {
  return normalizeText(
    proof?.hashBinding?.[key]
      || proof?.payload?.[key]
      || proof?.evidence?.[key]
      || '',
  ) || null;
}

function proofHashBinding(receipt) {
  if (!receipt?.hashBinding && !receipt?.payload && !receipt?.result?.external) return null;
  return {
    manifestHash: receipt?.hashBinding?.manifestHash || null,
    previewHash: receipt?.hashBinding?.previewHash || null,
    approvalHash: receipt?.hashBinding?.approvalHash || null,
    evidenceHash: receipt?.hashBinding?.evidenceHash || null,
    approvalProvenanceHash: receipt?.hashBinding?.approvalProvenanceHash || null,
    humanFeedbackRevisionContractHash: receiptRequiredHash(receipt, 'humanFeedbackRevisionContractHash'),
    messagePreviewHash: receiptRequiredHash(receipt, 'messagePreviewHash'),
    promptGenerationBinding: receiptPromptGenerationBinding(receipt),
    platformStateSnapshotHash: receipt?.hashBinding?.platformStateSnapshotHash || null,
    dryRunReplayHash: receipt?.hashBinding?.dryRunReplayHash || null,
  };
}

function transitionHashBinding(proof) {
  if (!proof?.hashBinding && !proof?.payload && !proof?.evidence) return null;
  return {
    receiptHash: proof?.receiptHash || null,
    proofHash: proof?.proofHash || null,
    manifestHash: proof?.hashBinding?.manifestHash || null,
    previewHash: proof?.hashBinding?.previewHash || null,
    approvalHash: proof?.hashBinding?.approvalHash || null,
    evidenceHash: proof?.hashBinding?.evidenceHash || null,
    approvalProvenanceHash: proof?.hashBinding?.approvalProvenanceHash || null,
    humanFeedbackRevisionContractHash: proofRequiredHash(proof, 'humanFeedbackRevisionContractHash'),
    messagePreviewHash: proofRequiredHash(proof, 'messagePreviewHash'),
    promptGenerationBinding: proofPromptGenerationBinding(proof),
    platformStateSnapshotHash: proof?.hashBinding?.platformStateSnapshotHash || null,
    dryRunReplayHash: proof?.hashBinding?.dryRunReplayHash || null,
  };
}

function hasAny(value, fields) {
  return fields.some((field) => Boolean(value[field]));
}

function anyVerified(evidence) {
  return evidence.ok === true || evidence.verified === true || evidence.landed === true;
}

function valuesMismatch(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined && left !== right;
}

function matchReceiptHash(receipt, evidence) {
  const receiptHash = normalizeText(receipt?.receiptHash || '');
  const evidenceReceiptHash = normalizeText(evidence.receiptHash || '');
  if (!receiptHash) return [issue('receipt_hash_missing')];
  if (evidenceReceiptHash && evidenceReceiptHash !== receiptHash) return [issue('receipt_hash_mismatch')];
  return [];
}

function receiptContentHashBlockers(receipt) {
  const blockers = [];
  if (!receipt || receipt.kind !== 'AdapterRunReceipt') return blockers;
  const storedHashes = storedHashAliases(receipt, 'receiptHash');
  const recordedHash = storedHashes.effectiveHash || null;
  const recomputedHash = computeAdapterRunReceiptHash(receipt);
  if (!storedHashes.semanticHash) blockers.push(issue('receipt_hash_alias_required'));
  if (!storedHashes.genericHash) blockers.push(issue('receipt_generic_hash_required'));
  if (
    storedHashes.semanticHash
    && storedHashes.genericHash
    && storedHashes.semanticHash !== storedHashes.genericHash
  ) {
    blockers.push(issue('receipt_hash_alias_mismatch'));
  }
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('receipt_hash_content_mismatch'));
  }
  return blockers;
}

function validateArtifactEvidence({ receipt, evidence, blockers }) {
  const expectedNames = normalizeNames(receipt?.payload?.artifactNames || []);
  if (!expectedNames.length) return;
  if (evidence.artifactNames.length && !sameNameSet(expectedNames, evidence.artifactNames)) {
    blockers.push(issue('channel_artifact_names_mismatch'));
  }
  if (!evidence.artifactNames.length && evidence.artifactCount === null) {
    blockers.push(issue('channel_artifact_count_required'));
  }
  if (Number.isFinite(Number(evidence.artifactCount)) && Number(evidence.artifactCount) !== expectedNames.length) {
    blockers.push(issue('channel_artifact_count_mismatch', `${evidence.artifactCount}/${expectedNames.length}`));
  }
}

function validateIdMatches({ receipt, evidence, receiptFields, evidenceFields, blockers, requiredCode = 'channel_result_id_required' }) {
  const external = receiptExternal(receipt);
  const receiptIds = receiptFields.map((field) => external[field]).filter(Boolean);
  const evidenceIds = evidenceFields.map((field) => evidence[field]).filter(Boolean);
  if (!evidenceIds.length) blockers.push(issue(requiredCode));
  for (const field of receiptFields) {
    if (!evidenceFields.includes(field)) continue;
    if (external[field] && evidence[field] && external[field] !== evidence[field]) {
      blockers.push(issue('channel_result_id_mismatch'));
    }
  }
  const hasNamedMatch = receiptFields.some((field) => (
    evidenceFields.includes(field) && external[field] && evidence[field] && external[field] === evidence[field]
  ));
  const hasAnyIdMatch = receiptIds.some((receiptId) => evidenceIds.includes(receiptId));
  if (receiptIds.length && evidenceIds.length && !hasNamedMatch && !hasAnyIdMatch) {
    blockers.push(issue('channel_result_id_mismatch'));
  }
}

function actionSpecificBlockers({ receipt, evidence }) {
  const blockers = [];
  const rawAction = normalizeText(receipt?.action || '');
  const action = canonicalExternalAction(rawAction);
  if (!rawAction) {
    blockers.push(issue('receipt_action_missing'));
    return blockers;
  }

  if (receipt?.result?.status !== ADAPTER_RESULT_STATUS.SUCCESS) {
    blockers.push(issue('successful_receipt_required'));
    return blockers;
  }

  if (!anyVerified(evidence)) blockers.push(issue('channel_state_not_verified'));
  const expectedPromptGenerationBinding = receiptPromptGenerationBinding(receipt);
  const promptGenerationBindingRequired = action === EXTERNAL_ACTIONS.PROVIDER_SPEND
    || action === EXTERNAL_ACTIONS.MODEL_SPEND;
  if (promptGenerationBindingRequired && !expectedPromptGenerationBinding) {
    blockers.push(issue('receipt_prompt_generation_binding_required'));
  } else if (promptGenerationBindingRequired) {
    const missingExpectedKeys = missingPromptGenerationBindingKeys(expectedPromptGenerationBinding);
    if (missingExpectedKeys.length) {
      blockers.push(issue('receipt_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
    }
  }
  if (promptGenerationBindingRequired) {
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
  }
  if (promptGenerationBindingRequired && evidence.promptGenerationBinding) {
    const missingEvidenceKeys = missingPromptGenerationBindingKeys(evidence.promptGenerationBinding);
    if (missingEvidenceKeys.length) {
      blockers.push(issue('channel_prompt_generation_binding_incomplete', missingEvidenceKeys.join(', ')));
    }
  }
  if (
    expectedPromptGenerationBinding
    && evidence.promptGenerationBinding
    && !samePromptGenerationBinding(expectedPromptGenerationBinding, evidence.promptGenerationBinding)
  ) {
    blockers.push(issue('channel_prompt_generation_binding_mismatch'));
  }

  if (action === EXTERNAL_ACTIONS.LIVE_SUBMIT) {
    validateIdMatches({
      receipt,
      evidence,
      receiptFields: ['worksId', 'submissionId', 'externalResultId'],
      evidenceFields: ['worksId', 'submissionId'],
      blockers,
    });
    validateArtifactEvidence({ receipt, evidence, blockers });
    if (evidence.submissionConfirmed === false || SUBMISSION_NOT_CONFIRMED_STATE_CODES.has(evidence.stateCode)) {
      blockers.push(issue('channel_state_does_not_confirm_submission'));
    }
    if (valuesMismatch(receiptExternal(receipt).worksIsHidden, evidence.worksIsHidden)) {
      blockers.push(issue('works_hidden_state_mismatch'));
    }
    if (valuesMismatch(receiptExternal(receipt).buyerIsHide, evidence.buyerIsHide)) {
      blockers.push(issue('buyer_hide_state_mismatch'));
    }
  }

  if (action === EXTERNAL_ACTIONS.LIVE_PREPARE) {
    validateIdMatches({
      receipt,
      evidence,
      receiptFields: ['prepareId', 'externalResultId'],
      evidenceFields: ['prepareId'],
      blockers,
      requiredCode: 'prepare_result_id_required',
    });
    if (evidence.prepareEvidenceOk !== true) blockers.push(issue('prepare_evidence_ok_required'));
    validateArtifactEvidence({ receipt, evidence, blockers });
  }

  if (action === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) {
    validateIdMatches({
      receipt,
      evidence,
      receiptFields: ['acceptanceId', 'externalResultId'],
      evidenceFields: ['acceptanceId'],
      blockers,
      requiredCode: 'acceptance_result_id_required',
    });
  }

  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    validateIdMatches({
      receipt,
      evidence,
      receiptFields: ['messageId', 'externalResultId'],
      evidenceFields: ['messageId'],
      blockers,
      requiredCode: 'message_result_id_required',
    });
    const expectedMessagePreviewHash = normalizeText(receipt?.payload?.messagePreviewHash || '') || null;
    const receiptMessagePreview = normalizeText(receipt?.payload?.messagePreview || '') || null;
    const receiptMessagePreviewContentHash = computedMessagePreviewHash(receiptMessagePreview);
    if (!receiptMessagePreview) {
      blockers.push(issue('receipt_message_preview_required'));
    }
    if (!expectedMessagePreviewHash) {
      blockers.push(issue('receipt_message_preview_hash_required'));
    }
    if (
      receiptMessagePreviewContentHash
      && expectedMessagePreviewHash
      && receiptMessagePreviewContentHash !== expectedMessagePreviewHash
    ) {
      blockers.push(issue('receipt_message_preview_hash_mismatch'));
    }
    if (expectedMessagePreviewHash) {
      if (!evidence.messagePreviewHash) {
        blockers.push(issue('channel_message_preview_hash_required'));
      } else if (evidence.messagePreviewHash !== expectedMessagePreviewHash) {
        blockers.push(issue('channel_message_preview_hash_mismatch'));
      }
    }
    if (
      evidence.messagePreviewHash
      && evidence.messagePreviewContentHash
      && evidence.messagePreviewHash !== evidence.messagePreviewContentHash
    ) {
      blockers.push(issue('channel_message_preview_hash_content_mismatch'));
    }
  }

  const expectedHumanFeedbackRevisionContractHash = receiptRequiredHash(receipt, 'humanFeedbackRevisionContractHash');
  if (!expectedHumanFeedbackRevisionContractHash && receiptCarriesHumanFeedbackCustomerFacingAction(receipt, action)) {
    blockers.push(issue('receipt_human_feedback_contract_hash_required'));
  } else if (expectedHumanFeedbackRevisionContractHash) {
    if (!evidence.humanFeedbackRevisionContractHash) {
      blockers.push(issue('channel_human_feedback_contract_hash_required'));
    } else if (evidence.humanFeedbackRevisionContractHash !== expectedHumanFeedbackRevisionContractHash) {
      blockers.push(issue('channel_human_feedback_contract_hash_mismatch'));
    }
  }

  if (action === EXTERNAL_ACTIONS.DEPLOYMENT) {
    validateIdMatches({
      receipt,
      evidence,
      receiptFields: ['deploymentId', 'buildId', 'url', 'externalResultId'],
      evidenceFields: ['deploymentId', 'buildId', 'url'],
      blockers,
      requiredCode: 'deployment_result_id_required',
    });
    if (evidence.buildEvidenceOk === false) blockers.push(issue('deployment_build_evidence_failed'));
  }

  if (action === EXTERNAL_ACTIONS.PROVIDER_SPEND) {
    if (promptGenerationBindingRequired && !evidence.promptGenerationBinding) {
      blockers.push(issue('channel_prompt_generation_binding_required'));
    }
    validateIdMatches({
      receipt,
      evidence,
      receiptFields: ['providerRunId', 'cacheKey', 'externalResultId'],
      evidenceFields: ['providerRunId', 'cacheKey'],
      blockers,
      requiredCode: 'provider_result_id_required',
    });
  }

  if (action === EXTERNAL_ACTIONS.MODEL_SPEND) {
    if (promptGenerationBindingRequired && !evidence.promptGenerationBinding) {
      blockers.push(issue('channel_prompt_generation_binding_required'));
    }
    validateIdMatches({
      receipt,
      evidence,
      receiptFields: ['modelRunId', 'cacheKey', 'externalResultId'],
      evidenceFields: ['modelRunId', 'cacheKey'],
      blockers,
      requiredCode: 'model_result_id_required',
    });
  }

  return blockers;
}

function proofBlockers({ receipt, evidence }) {
  const blockers = [];
  if (receipt?.kind !== 'AdapterRunReceipt') blockers.push(issue('invalid_receipt_kind'));
  if (receipt?.status !== ADAPTER_RECEIPT_STATUS.ACCEPTED || receipt?.accepted !== true) {
    blockers.push(issue('accepted_receipt_required'));
  }
  blockers.push(...receiptContentHashBlockers(receipt));
  blockers.push(...matchReceiptHash(receipt, evidence));
  if (receipt?.status === ADAPTER_RECEIPT_STATUS.ACCEPTED && receipt?.accepted === true) {
    blockers.push(...actionSpecificBlockers({ receipt, evidence }));
  }
  return blockers;
}

export function buildChannelStateProof({
  receipt = null,
  stateEvidence = {},
  verifierId = 'design-production-core.channel-state-proof',
  evidenceRefs = [],
  observedAt = null,
  createdAt = null,
} = {}) {
  const evidence = normalizeStateEvidence(stateEvidence);
  const blockers = proofBlockers({ receipt, evidence });
  const proof = {
    version: CHANNEL_STATE_PROOF_VERSION,
    kind: 'ChannelStateProof',
    verifierId: normalizeText(verifierId || 'design-production-core.channel-state-proof'),
    status: blockers.length ? CHANNEL_STATE_PROOF_STATUS.BLOCKED : CHANNEL_STATE_PROOF_STATUS.VERIFIED,
    verified: blockers.length === 0,
    receiptHash: normalizeText(receipt?.receiptHash || '') || null,
    channelId: receipt?.channelId || null,
    actionId: receipt?.actionId || null,
    action: canonicalActionOrNull(receipt?.action || null),
    resultStatus: receipt?.result?.status || null,
    hashBinding: proofHashBinding(receipt),
    payload: {
      taskKey: receipt?.payload?.taskKey || null,
      externalId: receipt?.payload?.externalId || null,
      productLineId: canonicalProductLineOrNull(receipt?.payload?.productLineId),
      workflowId: canonicalProductLineOrNull(receipt?.payload?.workflowId),
      packageRole: canonicalPackageRole(receipt?.payload?.packageRole || '') || null,
      approvalProvenanceHash: receipt?.hashBinding?.approvalProvenanceHash || receipt?.payload?.approvalProvenanceHash || null,
      humanFeedbackRevisionContractHash: receipt?.payload?.humanFeedbackRevisionContractHash || null,
      ...(receiptPromptGenerationBinding(receipt)
        ? { promptGenerationBinding: receiptPromptGenerationBinding(receipt) }
        : {}),
      artifactNames: normalizeNames(receipt?.payload?.artifactNames || []),
      messagePreviewHash: normalizeText(receipt?.payload?.messagePreviewHash || '') || null,
    },
    evidence,
    stateSuggestion: proofHashStateSuggestion(receipt?.stateSuggestion),
    blockers,
    warnings: [
      issue('proof_verifies_only', 'Core state proofs normalize current-channel evidence and do not fetch platform state.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      proofOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      receiptRequired: true,
      independentChannelReadRequired: true,
    },
    observedAt: observedAt || createdAt || new Date().toISOString(),
    createdAt: createdAt || new Date().toISOString(),
  };
  const proofHash = computeChannelStateProofHash(proof);
  return {
    ...proof,
    proofHash,
    hash: proofHash,
  };
}

export function computeChannelStateProofHash(proof = null) {
  return digest({
    version: proof?.version,
    kind: proof?.kind,
    verifierId: proof?.verifierId,
    status: proof?.status,
    verified: proof?.verified,
    receiptHash: proof?.receiptHash,
    channelId: proof?.channelId,
    actionId: proof?.actionId,
    action: canonicalActionOrNull(proof?.action),
    resultStatus: proof?.resultStatus,
    hashBinding: proof?.hashBinding,
    payload: proofHashPayload(proof?.payload),
    evidence: proof?.evidence,
    stateSuggestion: proofHashStateSuggestion(proof?.stateSuggestion),
    blockers: proof?.blockers,
    warnings: proof?.warnings,
    evidenceRefs: proof?.evidenceRefs,
    safety: proof?.safety,
    observedAt: proof?.observedAt,
  });
}

export function computeReceiptStateTransitionHash(transition = null) {
  return digest({
    version: transition?.version,
    kind: transition?.kind,
    status: transition?.status,
    ready: transition?.ready,
    proofHash: transition?.proofHash,
    hashBinding: transition?.hashBinding,
    result: transitionHashResult(transition?.result),
    blockers: transition?.blockers,
    safety: transition?.safety,
    createdAt: transition?.createdAt,
  });
}

function receiptGateDecision(proof) {
  return {
    decision: EXECUTION_GATE_DECISIONS.ALLOW,
    allowed: true,
    action: proof.action,
    policy: 'receipt-and-channel-state-verified',
    taskKey: proof?.payload?.taskKey || null,
    channelId: proof?.channelId || null,
    externalId: proof?.payload?.externalId || null,
    approvalHash: proof?.hashBinding?.approvalHash || proof?.receiptHash || null,
    evidenceHash: proof?.hashBinding?.evidenceHash || proof?.proofHash || null,
  };
}

function proofContentHashBlockers(proof) {
  const blockers = [];
  if (!proof || proof.kind !== 'ChannelStateProof') return blockers;
  const storedHashes = storedHashAliases(proof, 'proofHash');
  const recordedHash = storedHashes.effectiveHash || null;
  const recomputedHash = computeChannelStateProofHash(proof);
  if (!recordedHash) blockers.push(issue('proof_hash_required'));
  if (!storedHashes.semanticHash) blockers.push(issue('proof_hash_alias_required'));
  if (!storedHashes.genericHash) blockers.push(issue('proof_generic_hash_required'));
  if (
    storedHashes.semanticHash
    && storedHashes.genericHash
    && storedHashes.semanticHash !== storedHashes.genericHash
  ) {
    blockers.push(issue('proof_hash_alias_mismatch'));
  }
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('proof_hash_content_mismatch'));
  }
  return blockers;
}

function proofMessagePreviewContentBlockers(proof) {
  const blockers = [];
  if (canonicalActionOrNull(proof?.action) !== EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) return blockers;
  const expectedMessagePreviewHash = proofRequiredHash(proof, 'messagePreviewHash');
  addMessagePreviewContentBlocker(
    proof?.payload,
    expectedMessagePreviewHash,
    'proof_message_preview_hash_content_mismatch',
    blockers,
  );
  addMessagePreviewContentBlocker(
    proof?.evidence,
    expectedMessagePreviewHash,
    'proof_evidence_message_preview_hash_content_mismatch',
    blockers,
  );
  return blockers;
}

function proofPromptGenerationBindingBlockers(proof) {
  const blockers = [];
  if (!isPromptGenerationSpendAction(proof?.action)) return blockers;
  const expected = proofPromptGenerationBinding(proof);
  if (!expected) {
    blockers.push(issue('proof_prompt_generation_binding_required'));
    return blockers;
  }
  const missingExpectedKeys = missingPromptGenerationBindingKeys(expected);
  if (missingExpectedKeys.length) {
    blockers.push(issue('proof_prompt_generation_binding_incomplete', missingExpectedKeys.join(', ')));
  }
  pushPromptGenerationBindingSourceBlockers(blockers, [
    {
      binding: proof?.hashBinding?.promptGenerationBinding,
      required: true,
      missingCode: 'proof_hash_binding_prompt_generation_binding_missing',
      incompleteCode: 'proof_hash_binding_prompt_generation_binding_incomplete',
      mismatchCode: 'proof_hash_binding_prompt_generation_binding_mismatch',
    },
  ], expected);
  for (const [binding, missingCode, incompleteCode, mismatchCode] of [
    [proof?.payload?.promptGenerationBinding, 'proof_payload_prompt_generation_binding_missing', 'proof_payload_prompt_generation_binding_incomplete', 'proof_payload_prompt_generation_binding_mismatch'],
    [proof?.evidence?.promptGenerationBinding, 'proof_evidence_prompt_generation_binding_missing', 'proof_evidence_prompt_generation_binding_incomplete', 'proof_evidence_prompt_generation_binding_mismatch'],
  ]) {
    if (!binding) {
      blockers.push(issue(missingCode));
      continue;
    }
    const missingKeys = missingPromptGenerationBindingKeys(binding);
    if (missingKeys.length) {
      blockers.push(issue(incompleteCode, missingKeys.join(', ')));
    } else if (!samePromptGenerationBinding(expected, binding)) {
      blockers.push(issue(mismatchCode));
    }
  }
  return blockers;
}

export function buildReceiptStateTransition({
  proof = null,
  actor = 'design-production-core.channel-state-proof',
  reason = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (proof?.kind !== 'ChannelStateProof') blockers.push(issue('invalid_channel_state_proof'));
  if (proof?.status !== CHANNEL_STATE_PROOF_STATUS.VERIFIED || proof?.verified !== true) {
    blockers.push(issue('verified_channel_state_proof_required'));
  }
  blockers.push(...proofContentHashBlockers(proof));
  blockers.push(...proofMessagePreviewContentBlockers(proof));
  blockers.push(...proofPromptGenerationBindingBlockers(proof));
  const suggestion = proof?.stateSuggestion || {};
  if (!suggestion?.fromStage || !suggestion?.toStage || !suggestion?.action) {
    blockers.push(issue('state_suggestion_required'));
  }
  if (suggestion?.toStage === CORE_STAGES.BLOCKED) blockers.push(issue('blocked_state_suggestion_cannot_advance'));

  if (blockers.length) {
    const transition = {
      version: CHANNEL_STATE_PROOF_VERSION,
      kind: 'ReceiptStateTransition',
      status: RECEIPT_TRANSITION_STATUS.BLOCKED,
      ready: false,
      proofHash: proof?.proofHash || null,
      hashBinding: transitionHashBinding(proof),
      result: null,
      blockers,
      safety: {
        localStateOnly: true,
        executesExternalAction: false,
      },
      createdAt: createdAt || new Date().toISOString(),
    };
    const transitionHash = computeReceiptStateTransitionHash(transition);
    return {
      ...transition,
      transitionHash,
      hash: transitionHash,
    };
  }

  const result = applyStateTransition({
    taskKey: proof.payload.taskKey,
    fromStage: suggestion.fromStage,
    toStage: suggestion.toStage,
    action: suggestion.action,
    gateDecision: receiptGateDecision(proof),
    reason: reason || `receipt ${proof.receiptHash} verified by channel state proof`,
    actor,
    evidenceRefs: [
      { kind: 'channel-state-proof', ref: proof.proofHash },
      ...normalizeRefs(proof.evidenceRefs || []),
    ],
    createdAt,
  });

  const transition = {
    version: CHANNEL_STATE_PROOF_VERSION,
    kind: 'ReceiptStateTransition',
    status: result.allowed ? RECEIPT_TRANSITION_STATUS.READY : RECEIPT_TRANSITION_STATUS.BLOCKED,
    ready: result.allowed,
    proofHash: proof.proofHash,
    hashBinding: transitionHashBinding(proof),
    result,
    blockers: result.decision.blockers || [],
    safety: {
      localStateOnly: true,
      executesExternalAction: false,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const transitionHash = computeReceiptStateTransitionHash(transition);
  return {
    ...transition,
    transitionHash,
    hash: transitionHash,
  };
}

export function summarizeChannelStateProofs(proofs = []) {
  const byStatus = {};
  const byChannel = {};
  const byAction = {};
  const blockerCodes = {};
  for (const proof of proofs || []) {
    byStatus[proof.status] = (byStatus[proof.status] || 0) + 1;
    const channelId = proof.channelId || 'unknown';
    byChannel[channelId] = (byChannel[channelId] || 0) + 1;
    const action = canonicalActionOrNull(proof.action) || 'unknown';
    byAction[action] = (byAction[action] || 0) + 1;
    for (const blocker of proof.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: CHANNEL_STATE_PROOF_VERSION,
    count: proofs.length,
    byStatus,
    byChannel,
    byAction,
    blockerCodes,
    safety: {
      proofOnly: true,
      executesExternalAction: proofs.some((proof) => proof.safety?.executesExternalAction === true),
      fetchesChannelState: proofs.some((proof) => proof.safety?.fetchesChannelState === true),
    },
  };
}
