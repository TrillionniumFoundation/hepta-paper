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
import { computeChannelActionManifestHash } from './action-manifest.mjs';
import { computeAdapterRunPreviewHash } from './adapter-runner.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_RECEIPT_VERSION = 1;

export const ADAPTER_RECEIPT_STATUS = Object.freeze({
  ACCEPTED: 'accepted_receipt',
  BLOCKED: 'blocked_receipt',
});

export const ADAPTER_RESULT_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  DRY_RUN: 'dry_run',
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

function normalizedResultStatus(value) {
  const status = normalizeText(value || ADAPTER_RESULT_STATUS.SUCCESS);
  return Object.values(ADAPTER_RESULT_STATUS).includes(status) ? status : null;
}

function resultText(value) {
  return normalizeText(value) || null;
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => resultText(left[key]) === resultText(right[key]));
}

function promptGenerationBindingCandidates({ preview = null, manifest = null } = {}) {
  return [
    preview?.payload?.promptGenerationBinding,
    preview?.adapter?.requiredHashes?.promptGenerationBinding,
    manifest?.payload?.promptGenerationBinding,
  ].filter(Boolean);
}

function promptGenerationBindingFor({ preview = null, manifest = null } = {}) {
  return promptGenerationBindingCandidates({ preview, manifest })[0] || null;
}

function isPromptGenerationSpendAction(action) {
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function promptGenerationSnapshotBlockers({ action = null, preview = null, manifest = null } = {}) {
  const candidates = promptGenerationBindingCandidates({ preview, manifest });
  if (!candidates.length) {
    return isPromptGenerationSpendAction(action) ? [issue('prompt_generation_binding_required')] : [];
  }
  const blockers = [];
  const expected = candidates[0];
  const missingSources = [
    ['preview_payload', preview?.payload?.promptGenerationBinding],
    ['preview_required_hashes', preview?.adapter?.requiredHashes?.promptGenerationBinding],
    ['manifest_payload', manifest?.payload?.promptGenerationBinding],
  ].filter(([, value]) => !value).map(([source]) => source);
  if (missingSources.length) {
    blockers.push(issue('prompt_generation_binding_required', missingSources.join(', ')));
  }
  if (!candidates.every((candidate) => samePromptGenerationBinding(candidate, expected))) {
    blockers.push(issue('prompt_generation_binding_mismatch'));
  }
  const missingKeys = PROMPT_GENERATION_BINDING_KEYS.filter((key) => !resultText(expected?.[key]));
  if (missingKeys.length) {
    blockers.push(issue('prompt_generation_binding_incomplete', missingKeys.join(', ')));
  }
  return blockers;
}

function computedMessagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function normalizeExternalResult(value = {}) {
  const uploadedArtifactNames = uniqueStrings(value.uploadedArtifactNames || value.uploadedFiles || value.files || [], 128);
  const reportedMessagePreviewHash = resultText(value.messagePreviewHash || value.previewHash);
  const messagePreviewContentHash = computeCustomerMessagePreviewHashFromFields(value);
  return {
    externalResultId: resultText(value.externalResultId || value.resultId || value.id),
    worksId: resultText(value.worksId || value.workId),
    submissionId: resultText(value.submissionId || value.manuscriptId),
    prepareId: resultText(value.prepareId || value.prepareRunId),
    acceptanceId: resultText(value.acceptanceId || value.acceptanceApplyId),
    messageId: resultText(value.messageId),
    messagePreviewHash: reportedMessagePreviewHash || messagePreviewContentHash,
    messagePreviewContentHash: messagePreviewContentHash || null,
    humanFeedbackRevisionContractHash: resultText(
      value.humanFeedbackRevisionContractHash
        || value.feedbackRevisionContractHash
        || value.humanFeedbackContractHash,
    ),
    deploymentId: resultText(value.deploymentId || value.deployId),
    buildId: resultText(value.buildId),
    providerRunId: resultText(value.providerRunId),
    modelRunId: resultText(value.modelRunId),
    cacheKey: resultText(value.cacheKey),
    url: resultText(value.url),
    statusText: resultText(value.statusText || value.message),
    failureCode: resultText(value.failureCode || value.errorCode),
    totalMyWorks: Number.isFinite(Number(value.totalMyWorks)) ? Number(value.totalMyWorks) : null,
    worksIsHidden: value.worksIsHidden === undefined ? null : Boolean(value.worksIsHidden),
    buyerIsHide: value.buyerIsHide === undefined ? null : Boolean(value.buyerIsHide),
    prepareEvidenceOk: value.prepareEvidenceOk === undefined ? null : Boolean(value.prepareEvidenceOk),
    buildEvidenceOk: value.buildEvidenceOk === undefined ? null : Boolean(value.buildEvidenceOk),
    uploadedArtifactNames,
  };
}

function hasAny(result, fields) {
  return fields.some((field) => Boolean(result[field]));
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

function successEvidenceBlockers({
  action,
  result,
  artifactCount,
  expectedMessagePreviewHash = null,
  expectedHumanFeedbackRevisionContractHash = null,
}) {
  const blockers = [];
  if (action === EXTERNAL_ACTIONS.LIVE_SUBMIT && !hasAny(result, ['worksId', 'submissionId', 'externalResultId'])) {
    blockers.push(issue('external_result_id_required', 'live_submit requires worksId/submissionId/externalResultId'));
  }
  if (action === EXTERNAL_ACTIONS.LIVE_PREPARE) {
    if (result.prepareEvidenceOk !== true) blockers.push(issue('prepare_evidence_ok_required'));
    if (artifactCount > 0 && result.uploadedArtifactNames.length > 0 && result.uploadedArtifactNames.length !== artifactCount) {
      blockers.push(issue('uploaded_artifact_count_mismatch', `${result.uploadedArtifactNames.length}/${artifactCount}`));
    }
  }
  if (action === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY && !hasAny(result, ['acceptanceId', 'externalResultId'])) {
    blockers.push(issue('external_result_id_required', 'acceptance_apply requires acceptanceId/externalResultId'));
  }
  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE && !hasAny(result, ['messageId', 'externalResultId'])) {
    blockers.push(issue('external_result_id_required', 'customer_message requires messageId/externalResultId'));
  }
  if (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE && expectedMessagePreviewHash) {
    if (!result.messagePreviewHash) {
      blockers.push(issue('message_preview_hash_required'));
    } else if (result.messagePreviewHash !== expectedMessagePreviewHash) {
      blockers.push(issue('message_preview_hash_mismatch'));
    }
  }
  if (
    action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
    && result.messagePreviewHash
    && result.messagePreviewContentHash
    && result.messagePreviewHash !== result.messagePreviewContentHash
  ) {
    blockers.push(issue('message_preview_hash_content_mismatch'));
  }
  if (expectedHumanFeedbackRevisionContractHash) {
    if (!result.humanFeedbackRevisionContractHash) {
      blockers.push(issue('human_feedback_contract_hash_required'));
    } else if (result.humanFeedbackRevisionContractHash !== expectedHumanFeedbackRevisionContractHash) {
      blockers.push(issue('human_feedback_contract_hash_mismatch'));
    }
  }
  if (action === EXTERNAL_ACTIONS.DEPLOYMENT) {
    if (!hasAny(result, ['deploymentId', 'buildId', 'url', 'externalResultId'])) {
      blockers.push(issue('external_result_id_required', 'deployment requires deployment/build/url evidence'));
    }
    if (result.buildEvidenceOk === false) blockers.push(issue('deployment_build_evidence_failed'));
  }
  if (action === EXTERNAL_ACTIONS.PROVIDER_SPEND && !hasAny(result, ['providerRunId', 'cacheKey', 'externalResultId'])) {
    blockers.push(issue('external_result_id_required', 'provider_spend requires providerRunId/cacheKey/externalResultId'));
  }
  if (action === EXTERNAL_ACTIONS.MODEL_SPEND && !hasAny(result, ['modelRunId', 'cacheKey', 'externalResultId'])) {
    blockers.push(issue('external_result_id_required', 'model_spend requires modelRunId/cacheKey/externalResultId'));
  }
  return blockers;
}

function hashBlockers({
  preview,
  manifest,
  reportedHashes,
  requireReportedCoreHashes = false,
  requireReportedActionHashes = false,
}) {
  const blockers = [];
  const manifestContentHash = manifest ? computeChannelActionManifestHash(manifest) : null;
  const previewContentHash = preview ? computeAdapterRunPreviewHash(preview) : null;
  const manifestStoredHashes = storedHashAliases(manifest, 'manifestHash');
  const previewStoredHashes = storedHashAliases(preview, 'previewHash');
  const manifestStoredHash = manifestStoredHashes.effectiveHash || null;
  const previewStoredHash = previewStoredHashes.effectiveHash || null;
  const expectedManifestHash = manifestStoredHash || preview?.payload?.manifestHash || preview?.adapter?.requiredHashes?.manifestHash || manifestContentHash || null;
  const expectedPreviewHash = previewStoredHash || previewContentHash || null;
  const expectedApprovalHash = preview?.payload?.approvalHash || preview?.adapter?.requiredHashes?.approvalHash || manifest?.payload?.approvalHash || null;
  const expectedEvidenceHash = preview?.payload?.evidenceHash || preview?.adapter?.requiredHashes?.evidenceHash || manifest?.payload?.evidenceHash || null;
  const expectedApprovalProvenanceHash = preview?.payload?.approvalProvenanceHash
    || preview?.adapter?.requiredHashes?.approvalProvenanceHash
    || manifest?.payload?.approvalProvenanceHash
    || null;

  const reportedManifestHash = normalizeText(reportedHashes.manifestHash || '');
  const reportedPreviewHash = normalizeText(reportedHashes.previewHash || '');
  const reportedApprovalHash = normalizeText(reportedHashes.approvalHash || '');
  const reportedEvidenceHash = normalizeText(reportedHashes.evidenceHash || '');
  const reportedApprovalProvenanceHash = normalizeText(reportedHashes.approvalProvenanceHash || '');
  const manifestHash = reportedManifestHash || expectedManifestHash;
  const previewHash = reportedPreviewHash || expectedPreviewHash;
  const approvalHash = reportedApprovalHash || expectedApprovalHash;
  const evidenceHash = reportedEvidenceHash || expectedEvidenceHash;
  const approvalProvenanceHash = reportedApprovalProvenanceHash || expectedApprovalProvenanceHash;
  const platformStateSnapshotHash = reportedHashes.platformStateSnapshotHash || null;
  const dryRunReplayHash = reportedHashes.dryRunReplayHash || null;

  if (!manifestHash) blockers.push(issue('manifest_hash_missing'));
  if (!previewHash) blockers.push(issue('preview_hash_missing'));
  if (!approvalHash) blockers.push(issue('approval_hash_missing'));
  if (!evidenceHash) blockers.push(issue('evidence_hash_missing'));
  if (!approvalProvenanceHash) blockers.push(issue('approval_provenance_hash_missing'));
  if (requireReportedCoreHashes && expectedManifestHash && !reportedManifestHash) {
    blockers.push(issue('manifest_hash_report_required'));
  }
  if (requireReportedCoreHashes && expectedPreviewHash && !reportedPreviewHash) {
    blockers.push(issue('preview_hash_report_required'));
  }
  if (requireReportedActionHashes && expectedApprovalHash && !reportedApprovalHash) {
    blockers.push(issue('approval_hash_report_required'));
  }
  if (requireReportedActionHashes && expectedEvidenceHash && !reportedEvidenceHash) {
    blockers.push(issue('evidence_hash_report_required'));
  }
  if (requireReportedActionHashes && expectedApprovalProvenanceHash && !reportedApprovalProvenanceHash) {
    blockers.push(issue('approval_provenance_hash_report_required'));
  }
  if (!platformStateSnapshotHash) blockers.push(issue('platform_state_snapshot_hash_missing'));
  if (!dryRunReplayHash) blockers.push(issue('dry_run_replay_hash_missing'));
  if (manifest) {
    if (!manifestStoredHashes.semanticHash) blockers.push(issue('manifest_hash_alias_required'));
    if (!manifestStoredHashes.genericHash) blockers.push(issue('manifest_generic_hash_required'));
    if (
      manifestStoredHashes.semanticHash
      && manifestStoredHashes.genericHash
      && manifestStoredHashes.semanticHash !== manifestStoredHashes.genericHash
    ) {
      blockers.push(issue('manifest_hash_alias_mismatch'));
    }
  }
  if (preview) {
    if (!previewStoredHashes.semanticHash) blockers.push(issue('preview_hash_alias_required'));
    if (!previewStoredHashes.genericHash) blockers.push(issue('preview_generic_hash_required'));
    if (
      previewStoredHashes.semanticHash
      && previewStoredHashes.genericHash
      && previewStoredHashes.semanticHash !== previewStoredHashes.genericHash
    ) {
      blockers.push(issue('preview_hash_alias_mismatch'));
    }
  }
  if (manifestStoredHash && manifestContentHash && manifestStoredHash !== manifestContentHash) blockers.push(issue('manifest_hash_content_mismatch'));
  if (previewStoredHash && previewContentHash && previewStoredHash !== previewContentHash) blockers.push(issue('preview_hash_content_mismatch'));
  if (expectedManifestHash && manifestHash && manifestHash !== expectedManifestHash) blockers.push(issue('manifest_hash_mismatch'));
  if (expectedPreviewHash && previewHash && previewHash !== expectedPreviewHash) blockers.push(issue('preview_hash_mismatch'));
  if (expectedApprovalHash && approvalHash && approvalHash !== expectedApprovalHash) blockers.push(issue('approval_hash_mismatch'));
  if (expectedEvidenceHash && evidenceHash && evidenceHash !== expectedEvidenceHash) blockers.push(issue('evidence_hash_mismatch'));
  if (
    expectedApprovalProvenanceHash
    && approvalProvenanceHash
    && approvalProvenanceHash !== expectedApprovalProvenanceHash
  ) {
    blockers.push(issue('approval_provenance_hash_mismatch'));
  }

  return {
    blockers,
    hashes: {
      manifestHash: manifestHash || null,
      previewHash: previewHash || null,
      approvalHash: approvalHash || null,
      evidenceHash: evidenceHash || null,
      approvalProvenanceHash: approvalProvenanceHash || null,
      platformStateSnapshotHash: platformStateSnapshotHash || null,
      dryRunReplayHash: dryRunReplayHash || null,
    },
    expected: {
      manifestHash: expectedManifestHash || null,
      previewHash: expectedPreviewHash || null,
      approvalHash: expectedApprovalHash || null,
      evidenceHash: expectedEvidenceHash || null,
      approvalProvenanceHash: expectedApprovalProvenanceHash || null,
    },
  };
}

function messagePreviewSnapshotBlockers({ action, preview, manifest }) {
  if (action !== EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) return [];
  const blockers = [];
  const previewText = normalizeText(preview?.payload?.messagePreview || '');
  const previewPayloadHash = normalizeText(preview?.payload?.messagePreviewHash || '');
  const previewRequiredHash = normalizeText(preview?.adapter?.requiredHashes?.messagePreviewHash || '');
  const manifestText = normalizeText(manifest?.payload?.messagePreview || '');
  const manifestPayloadHash = normalizeText(manifest?.payload?.messagePreviewHash || '');
  const expectedPreviewHash = computedMessagePreviewHash(previewText);
  const expectedManifestHash = computedMessagePreviewHash(manifestText);

  if (!previewText) blockers.push(issue('preview_message_preview_required'));
  if (!previewPayloadHash) blockers.push(issue('preview_message_preview_hash_required'));
  if (!previewRequiredHash) blockers.push(issue('preview_message_preview_required_hash_missing'));
  if (expectedPreviewHash && previewPayloadHash && expectedPreviewHash !== previewPayloadHash) {
    blockers.push(issue('preview_message_preview_hash_mismatch'));
  }
  if (previewPayloadHash && previewRequiredHash && previewPayloadHash !== previewRequiredHash) {
    blockers.push(issue('preview_message_preview_required_hash_mismatch'));
  }
  if (manifest) {
    if (!manifestText) blockers.push(issue('manifest_message_preview_required'));
    if (!manifestPayloadHash) blockers.push(issue('manifest_message_preview_hash_required'));
    if (expectedManifestHash && manifestPayloadHash && expectedManifestHash !== manifestPayloadHash) {
      blockers.push(issue('manifest_message_preview_hash_mismatch'));
    }
    if (previewPayloadHash && manifestPayloadHash && previewPayloadHash !== manifestPayloadHash) {
      blockers.push(issue('preview_manifest_message_preview_hash_mismatch'));
    }
  }
  return blockers;
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function humanFeedbackReceiptContext({ action, preview, manifest }) {
  if (!isHumanFeedbackCustomerFacingAction(action)) return false;
  const actionValues = [
    preview?.payload?.action,
    manifest?.action,
    manifest?.payload?.action,
  ];
  const productValues = [
    preview?.payload?.productLineId,
    preview?.payload?.workflowId,
    preview?.payload?.packageRole,
    preview?.payload?.reviewType,
    preview?.payload?.role,
    manifest?.productLineId,
    manifest?.workflowId,
    manifest?.payload?.productLineId,
    manifest?.payload?.workflowId,
    manifest?.payload?.packageRole,
    manifest?.payload?.reviewType,
    manifest?.payload?.role,
  ];
  return actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
    || productValues.some((value) => isHumanFeedbackIdentity(value))
    || normalizeText(preview?.payload?.humanFeedbackRevisionContractHash || '')
    || normalizeText(manifest?.payload?.humanFeedbackRevisionContractHash || '');
}

function humanFeedbackContractSnapshotBlockers({ action, preview, manifest }) {
  if (!humanFeedbackReceiptContext({ action, preview, manifest })) return [];
  const blockers = [];
  const values = [
    ['preview_payload', preview?.payload?.humanFeedbackRevisionContractHash],
    ['preview_required_hashes', preview?.adapter?.requiredHashes?.humanFeedbackRevisionContractHash],
    ['manifest_payload', manifest?.payload?.humanFeedbackRevisionContractHash],
  ];
  const present = values.map(([, value]) => normalizeText(value || '') || null).filter(Boolean);
  const missingSources = values
    .filter(([, value]) => !normalizeText(value || ''))
    .map(([source]) => source);
  if (missingSources.length) {
    blockers.push(issue('human_feedback_contract_hash_required', missingSources.join(', ')));
  }
  if (present.length && present.some((value) => value !== present[0])) {
    blockers.push(issue('human_feedback_contract_hash_mismatch'));
  }
  return blockers;
}

function receiptBlockers({
  preview,
  manifest,
  resultStatus,
  externalResult,
  reportedHashes,
}) {
  const blockers = [];
  const action = canonicalExternalAction(preview?.payload?.action || manifest?.action);
  if (preview?.kind !== 'AdapterRunPreview') blockers.push(issue('invalid_preview_kind'));
  if (preview?.status !== 'dry_run_ready' || preview?.readyForDryRun !== true) blockers.push(issue('preview_not_ready'));
  if (preview?.readyForExecution === true) blockers.push(issue('unsafe_preview_claims_execution_ready'));
  if (manifest && manifest.kind !== 'ChannelActionManifest') blockers.push(issue('invalid_manifest_kind'));
  if (!resultStatus) blockers.push(issue('unknown_result_status'));

  const hashCheck = hashBlockers({
    preview,
    manifest,
    reportedHashes,
    requireReportedCoreHashes: true,
    requireReportedActionHashes: true,
  });
  blockers.push(...hashCheck.blockers);
  blockers.push(...messagePreviewSnapshotBlockers({ action, preview, manifest }));
  blockers.push(...humanFeedbackContractSnapshotBlockers({ action, preview, manifest }));
  blockers.push(...promptGenerationSnapshotBlockers({ action, preview, manifest }));
  const expectedHumanFeedbackRevisionContractHash = normalizeText(
    preview?.payload?.humanFeedbackRevisionContractHash
      || manifest?.payload?.humanFeedbackRevisionContractHash
      || '',
  ) || null;
  if (
    humanFeedbackReceiptContext({ action, preview, manifest })
    && !expectedHumanFeedbackRevisionContractHash
  ) {
    blockers.push(issue('human_feedback_contract_hash_required'));
  }

  if (resultStatus === ADAPTER_RESULT_STATUS.SUCCESS) {
    blockers.push(...successEvidenceBlockers({
      action,
      result: externalResult,
      artifactCount: preview?.payload?.artifactCount || 0,
      expectedMessagePreviewHash: normalizeText(preview?.payload?.messagePreviewHash || manifest?.payload?.messagePreviewHash || '') || null,
      expectedHumanFeedbackRevisionContractHash,
    }));
  }
  if (resultStatus === ADAPTER_RESULT_STATUS.FAILED && !externalResult.failureCode) {
    blockers.push(issue('failure_code_required'));
  }
  return {
    blockers,
    hashCheck,
    promptGenerationBinding: promptGenerationBindingFor({ preview, manifest }),
  };
}

function stateSuggestion({ preview, manifest, resultStatus }) {
  const transition = manifest?.payload?.transition || null;
  const action = canonicalActionOrNull(preview?.payload?.action || manifest?.action);
  if (resultStatus === ADAPTER_RESULT_STATUS.SUCCESS) {
    return {
      action,
      fromStage: transition?.fromStage || null,
      toStage: transition?.toStage || null,
      shouldApplyTransition: Boolean(transition?.toStage),
    };
  }
  return {
    action,
    fromStage: transition?.fromStage || null,
    toStage: CORE_STAGES.BLOCKED,
    shouldApplyTransition: false,
  };
}

function receiptHashPayload(payload = null) {
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

function receiptHashStateSuggestion(value = null) {
  if (!value) return value;
  return {
    ...value,
    action: canonicalActionOrNull(value.action),
  };
}

export function buildAdapterRunReceipt({
  preview = null,
  manifest = null,
  resultStatus = ADAPTER_RESULT_STATUS.SUCCESS,
  externalResult = {},
  reportedHashes = {},
  runnerId = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const normalizedStatus = normalizedResultStatus(resultStatus);
  const normalizedExternalResult = normalizeExternalResult(externalResult);
  const { blockers, hashCheck, promptGenerationBinding } = receiptBlockers({
    preview,
    manifest,
    resultStatus: normalizedStatus,
    externalResult: normalizedExternalResult,
    reportedHashes,
  });
  const receipt = {
    version: ADAPTER_RECEIPT_VERSION,
    kind: 'AdapterRunReceipt',
    runnerId: normalizeText(runnerId || preview?.runnerId || 'external-adapter-runner'),
    status: blockers.length ? ADAPTER_RECEIPT_STATUS.BLOCKED : ADAPTER_RECEIPT_STATUS.ACCEPTED,
    accepted: blockers.length === 0,
    channelId: normalizeText(preview?.adapter?.channelId || manifest?.channelId || '') || null,
    actionId: normalizeText(preview?.adapter?.actionId || manifest?.adapter?.actionId || '') || null,
    action: canonicalExternalAction(preview?.payload?.action || manifest?.action),
    result: {
      status: normalizedStatus || resultStatus || null,
      external: normalizedExternalResult,
    },
    hashBinding: {
      ...hashCheck.hashes,
      dispatchEnvelopeHash: resultText(reportedHashes.dispatchEnvelopeHash),
      outboxHash: resultText(reportedHashes.outboxHash),
      replayGuardHash: resultText(reportedHashes.replayGuardHash),
      platformStateSnapshotHash: hashCheck.hashes.platformStateSnapshotHash,
      dryRunReplayHash: hashCheck.hashes.dryRunReplayHash,
      archiveHash: resultText(reportedHashes.archiveHash),
      ledgerHash: resultText(reportedHashes.ledgerHash),
      promptGenerationBinding,
      expected: hashCheck.expected,
      matches: {
        manifestHash: !hashCheck.blockers.some((blocker) => blocker.code === 'manifest_hash_mismatch'),
        previewHash: !hashCheck.blockers.some((blocker) => blocker.code === 'preview_hash_mismatch'),
        approvalHash: !hashCheck.blockers.some((blocker) => blocker.code === 'approval_hash_mismatch'),
        evidenceHash: !hashCheck.blockers.some((blocker) => blocker.code === 'evidence_hash_mismatch'),
        approvalProvenanceHash: !hashCheck.blockers.some((blocker) => blocker.code === 'approval_provenance_hash_mismatch'),
      },
    },
    payload: {
      taskKey: normalizeText(preview?.payload?.taskKey || manifest?.taskKey || '') || null,
      externalId: normalizeText(preview?.payload?.externalId || manifest?.payload?.externalId || '') || null,
      productLineId: canonicalProductLineOrNull(preview?.payload?.productLineId || manifest?.productLineId),
      workflowId: canonicalProductLineOrNull(preview?.payload?.workflowId || manifest?.workflowId),
      packageRole: canonicalPackageRole(preview?.payload?.packageRole || manifest?.payload?.packageRole || '') || null,
      approvalProvenanceHash: normalizeText(
        preview?.payload?.approvalProvenanceHash
          || manifest?.payload?.approvalProvenanceHash
          || '',
      ) || null,
      humanFeedbackRevisionContractHash: normalizeText(
        preview?.payload?.humanFeedbackRevisionContractHash
          || manifest?.payload?.humanFeedbackRevisionContractHash
          || '',
      ) || null,
      ...(promptGenerationBinding
        ? { promptGenerationBinding }
        : {}),
      artifactNames: uniqueStrings(preview?.payload?.artifactNames || manifest?.payload?.artifactNames || [], 128),
      messagePreview: normalizeText(preview?.payload?.messagePreview || manifest?.payload?.messagePreview || '') || null,
      messagePreviewHash: normalizeText(preview?.payload?.messagePreviewHash || manifest?.payload?.messagePreviewHash || '') || null,
    },
    stateSuggestion: stateSuggestion({ preview, manifest, resultStatus: normalizedStatus }),
    blockers,
    warnings: [
      issue('receipt_verifies_only', 'Core receipts describe runner output and do not execute adapters.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      receiptOnly: true,
      executesExternalAction: false,
      verifiesExternalActionResult: true,
      requiresHashBinding: true,
      sourceSnapshotRedacted: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const receiptHash = computeAdapterRunReceiptHash(receipt);
  return {
    ...receipt,
    receiptHash,
    hash: receiptHash,
  };
}

export function computeAdapterRunReceiptHash(receipt = null) {
  return digest({
    version: receipt?.version,
    kind: receipt?.kind,
    runnerId: receipt?.runnerId,
    status: receipt?.status,
    accepted: receipt?.accepted,
    channelId: receipt?.channelId,
    actionId: receipt?.actionId,
    action: canonicalActionOrNull(receipt?.action),
    result: receipt?.result,
    hashBinding: receipt?.hashBinding,
    payload: receiptHashPayload(receipt?.payload),
    stateSuggestion: receiptHashStateSuggestion(receipt?.stateSuggestion),
    blockers: receipt?.blockers,
    warnings: receipt?.warnings,
    evidenceRefs: receipt?.evidenceRefs,
    safety: receipt?.safety,
  });
}

export function summarizeAdapterRunReceipts(receipts = []) {
  const byStatus = {};
  const byResultStatus = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  for (const receipt of receipts || []) {
    byStatus[receipt.status] = (byStatus[receipt.status] || 0) + 1;
    const resultStatus = receipt.result?.status || 'unknown';
    byResultStatus[resultStatus] = (byResultStatus[resultStatus] || 0) + 1;
    const channelId = receipt.channelId || 'unknown';
    byChannel[channelId] = (byChannel[channelId] || 0) + 1;
    const actionId = receipt.actionId || 'unknown';
    byActionId[actionId] = (byActionId[actionId] || 0) + 1;
    for (const blocker of receipt.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_RECEIPT_VERSION,
    count: receipts.length,
    byStatus,
    byResultStatus,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      receiptOnly: true,
      executesExternalAction: receipts.some((receipt) => receipt.safety?.executesExternalAction === true),
    },
  };
}
