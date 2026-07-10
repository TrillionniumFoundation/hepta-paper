import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  computeCustomerMessagePreviewHash,
  isHumanFeedbackCustomerFacingAction,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import {
  ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE,
  isExternalWorkspaceRunnerLocation,
} from './adapter-runner-location-boundary.mjs';
import {
  ADAPTER_DISPATCH_READINESS_REPORT_STATUS,
  computeAdapterDispatchReadinessReportHash,
} from './adapter-dispatch-readiness-report.mjs';
import { computeChannelActionManifestHash } from './action-manifest.mjs';
import { computeAdapterRunPreviewHash } from './adapter-runner.mjs';
import { handoffSnapshotIdentityMismatches } from './handoff-snapshot-identity.mjs';
import { digest } from './hash-utils.mjs';

export const ADAPTER_RUNNER_SDK_VERSION = 1;

export const ADAPTER_RUNNER_SDK_STATUS = Object.freeze({
  READY: 'ready_adapter_runner_sdk_contract',
  BLOCKED: 'blocked_adapter_runner_sdk_contract',
});

export const ADAPTER_RUNNER_SDK_PHASES = Object.freeze([
  'inspect',
  'prepare',
  'execute',
  'receipt',
  'stateProof',
]);

const REQUIRED_DISPATCH_HASHES = Object.freeze([
  'outboxHash',
  'replayGuardHash',
  'manifestHash',
  'previewHash',
  'approvalHash',
  'evidenceHash',
  'approvalProvenanceHash',
]);

const PROMPT_GENERATION_BINDING_KEYS = Object.freeze([
  'designReferenceRetrievalHash',
  'promptCompilerHash',
  'promptReadinessHash',
  'promptProductionContractHash',
  'generationJobId',
  'generationPromptProductionContractHash',
]);

const ACTION_EVIDENCE_CONTRACTS = Object.freeze({
  [EXTERNAL_ACTIONS.PROVIDER_SPEND]: Object.freeze({
    receiptResultFields: ['providerRunId', 'cacheKey', 'externalResultId'],
    stateProofFields: ['providerRunId', 'cacheKey'],
    terminalEvidenceFields: ['providerRunId_or_cacheKey_or_externalResultId'],
  }),
  [EXTERNAL_ACTIONS.MODEL_SPEND]: Object.freeze({
    receiptResultFields: ['modelRunId', 'cacheKey', 'externalResultId'],
    stateProofFields: ['modelRunId', 'cacheKey'],
    terminalEvidenceFields: ['modelRunId_or_cacheKey_or_externalResultId'],
  }),
  [EXTERNAL_ACTIONS.LIVE_PREPARE]: Object.freeze({
    receiptResultFields: ['prepareId', 'externalResultId', 'prepareEvidenceOk', 'uploadedArtifactNames'],
    stateProofFields: ['prepareId', 'prepareEvidenceOk', 'artifactNames', 'artifactCount'],
    terminalEvidenceFields: ['prepareId_or_externalResultId', 'prepareEvidenceOk'],
  }),
  [EXTERNAL_ACTIONS.LIVE_SUBMIT]: Object.freeze({
    receiptResultFields: ['worksId', 'submissionId', 'externalResultId', 'uploadedArtifactNames', 'totalMyWorks', 'worksIsHidden', 'buyerIsHide'],
    stateProofFields: ['worksId', 'submissionId', 'artifactCount', 'artifactNames', 'worksIsHidden', 'buyerIsHide'],
    terminalEvidenceFields: ['worksId_or_submissionId_or_externalResultId'],
  }),
  [EXTERNAL_ACTIONS.ACCEPTANCE_APPLY]: Object.freeze({
    receiptResultFields: ['acceptanceId', 'externalResultId'],
    stateProofFields: ['acceptanceId'],
    terminalEvidenceFields: ['acceptanceId_or_externalResultId'],
  }),
  [EXTERNAL_ACTIONS.CUSTOMER_MESSAGE]: Object.freeze({
    receiptResultFields: ['messageId', 'externalResultId', 'messagePreviewHash'],
    stateProofFields: ['messageId', 'messagePreviewHash'],
    terminalEvidenceFields: ['messageId_or_externalResultId', 'messagePreviewHash'],
  }),
  [EXTERNAL_ACTIONS.DEPLOYMENT]: Object.freeze({
    receiptResultFields: ['deploymentId', 'buildId', 'url', 'externalResultId', 'buildEvidenceOk'],
    stateProofFields: ['deploymentId', 'buildId', 'url', 'buildEvidenceOk'],
    terminalEvidenceFields: ['deploymentId_or_buildId_or_url_or_externalResultId'],
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

function text(value) {
  return normalizeText(value || '') || null;
}

function hashOf(record, keys = []) {
  for (const key of keys) {
    const value = text(record?.[key] || record?.hashBinding?.[key]);
    if (value) return value;
  }
  return null;
}

function genericHashOf(record) {
  return text(record?.hash);
}

function isCustomerMessageAction(value) {
  return canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
}

function isHumanFeedbackIdentity(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function unsafeReadinessClaims(report) {
  const unsafeKeys = [
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
  ];
  return unsafeKeys.filter((key) => report?.safety?.[key] === true);
}

function requiredHashBlockers(report) {
  const hashes = report?.hashBinding?.requiredHashes || {};
  const blockers = REQUIRED_DISPATCH_HASHES
    .filter((key) => !text(hashes[key]))
    .map((key) => issue('required_dispatch_hash_missing', key));
  if (isCustomerMessageAction(report?.handoff?.action) && !text(hashes.messagePreviewHash)) {
    blockers.push(issue('required_dispatch_hash_missing', 'messagePreviewHash'));
  }
  return blockers;
}

function allEqualNonEmpty(values = []) {
  const normalized = values.map((value) => text(value));
  return normalized.every(Boolean) && new Set(normalized).size === 1;
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return keys.every((key) => text(left[key]) === text(right[key]));
}

function isPromptGenerationSpendAction(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function promptGenerationBindingValues(report) {
  const hashes = report?.hashBinding?.requiredHashes || {};
  const snapshots = report?.handoffSnapshots || {};
  return [
    report?.handoff?.promptGenerationBinding,
    hashes.promptGenerationBinding,
    snapshots.manifest?.payload?.promptGenerationBinding,
    snapshots.preview?.payload?.promptGenerationBinding,
    snapshots.preview?.adapter?.requiredHashes?.promptGenerationBinding,
  ];
}

function promptGenerationBindingFor(report) {
  return promptGenerationBindingValues(report).find(Boolean) || null;
}

function isPromptGenerationSpendHandoff(report) {
  const handoff = report?.handoff || {};
  const snapshots = report?.handoffSnapshots || {};
  return [
    handoff.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => isPromptGenerationSpendAction(value));
}

function promptGenerationBindingBlockers(report) {
  const values = promptGenerationBindingValues(report);
  const present = values.filter(Boolean);
  if (!present.length) {
    return isPromptGenerationSpendHandoff(report)
      ? [issue('prompt_generation_binding_required')]
      : [];
  }
  if (present.length !== values.length) {
    return [issue('prompt_generation_binding_required')];
  }
  if (!present.every((value) => samePromptGenerationBinding(value, present[0]))) {
    return [issue('prompt_generation_binding_mismatch')];
  }
  const missingKeys = PROMPT_GENERATION_BINDING_KEYS.filter((key) => !text(present[0]?.[key]));
  if (missingKeys.length) {
    return [issue('prompt_generation_binding_incomplete', missingKeys.join(', '))];
  }
  return [];
}

function isHumanFeedbackMessageHandoff(report) {
  const handoff = report?.handoff || {};
  const hashes = report?.hashBinding?.requiredHashes || {};
  const snapshots = report?.handoffSnapshots || {};
  const actionValues = [
    handoff.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ];
  const productValues = [
    handoff.productLineId,
    handoff.workflowId,
    handoff.packageRole,
    handoff.reviewType,
    handoff.role,
    snapshots.manifest?.productLineId,
    snapshots.manifest?.workflowId,
    snapshots.manifest?.payload?.packageRole,
    snapshots.manifest?.payload?.reviewType,
    snapshots.manifest?.payload?.role,
    snapshots.manifest?.payload?.productLineId,
    snapshots.manifest?.payload?.workflowId,
    snapshots.preview?.payload?.productLineId,
    snapshots.preview?.payload?.workflowId,
    snapshots.preview?.payload?.packageRole,
    snapshots.preview?.payload?.reviewType,
    snapshots.preview?.payload?.role,
  ];
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && (
      actionValues.some((value) => isHumanFeedbackMessageActionAlias(value))
      || productValues.some((value) => isHumanFeedbackIdentity(value))
      || text(handoff.humanFeedbackRevisionContractHash)
      || text(hashes.humanFeedbackRevisionContractHash)
      || text(snapshots.manifest?.payload?.humanFeedbackRevisionContractHash)
      || text(snapshots.preview?.payload?.humanFeedbackRevisionContractHash)
      || text(snapshots.preview?.adapter?.requiredHashes?.humanFeedbackRevisionContractHash)
    );
}

function humanFeedbackContractHashBlockers(report) {
  if (!isHumanFeedbackMessageHandoff(report)) return [];
  const hashes = report?.hashBinding?.requiredHashes || {};
  const snapshots = report?.handoffSnapshots || {};
  const values = [
    report?.handoff?.humanFeedbackRevisionContractHash,
    hashes.humanFeedbackRevisionContractHash,
    snapshots.manifest?.payload?.humanFeedbackRevisionContractHash,
    snapshots.preview?.payload?.humanFeedbackRevisionContractHash,
    snapshots.preview?.adapter?.requiredHashes?.humanFeedbackRevisionContractHash,
  ];
  if (allEqualNonEmpty(values)) return [];
  if (values.some((value) => !text(value))) {
    return [issue('human_feedback_contract_hash_required')];
  }
  return [issue('human_feedback_contract_hash_mismatch')];
}

function computedMessagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function customerMessagePreviewHashBlockers(report) {
  if (!isCustomerMessageAction(report?.handoff?.action)) return [];
  const expected = computedMessagePreviewHash(report?.handoff?.messagePreview);
  const values = [
    report?.handoff?.messagePreviewHash,
    report?.hashBinding?.requiredHashes?.messagePreviewHash,
    report?.handoffSnapshots?.manifest?.payload?.messagePreviewHash,
    report?.handoffSnapshots?.preview?.payload?.messagePreviewHash,
    report?.handoffSnapshots?.preview?.adapter?.requiredHashes?.messagePreviewHash,
  ].map((value) => text(value));
  const blockers = [];
  if (!expected || values.some((value) => !value)) {
    blockers.push(issue('message_preview_hash_required'));
  }
  if (expected && values.some((value) => value && value !== expected)) {
    blockers.push(issue('message_preview_hash_mismatch'));
  }
  return blockers;
}

function hashIdentityPayload(value = null) {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(hashIdentityPayload);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'action' || key === 'sideEffectClass') {
      out[key] = canonicalActionOrNull(item);
    } else if (key === 'productLineId' || key === 'workflowId') {
      out[key] = canonicalProductLineOrNull(item);
    } else if (key === 'packageRole' || key === 'reviewType' || key === 'role') {
      out[key] = canonicalPackageRole(item) || null;
    } else {
      out[key] = hashIdentityPayload(item);
    }
  }
  return out;
}

function handoffSnapshotBlockers(report) {
  const blockers = [];
  const hashes = report?.hashBinding?.requiredHashes || {};
  const snapshots = report?.handoffSnapshots || {};
  const manifestAliasHash = text(snapshots.manifest?.manifestHash);
  const manifestGenericHash = genericHashOf(snapshots.manifest);
  const manifestHash = manifestAliasHash || manifestGenericHash;
  const previewAliasHash = text(snapshots.preview?.previewHash);
  const previewGenericHash = genericHashOf(snapshots.preview);
  const previewHash = previewAliasHash || previewGenericHash;
  if (snapshots.manifest?.kind !== 'ChannelActionManifest') {
    blockers.push(issue('manifest_snapshot_required'));
  } else {
    if (!manifestHash) blockers.push(issue('manifest_snapshot_hash_required'));
    if (!manifestAliasHash) blockers.push(issue('manifest_snapshot_hash_alias_required'));
    if (!manifestGenericHash) blockers.push(issue('manifest_snapshot_generic_hash_required'));
    if (manifestAliasHash && manifestGenericHash && manifestAliasHash !== manifestGenericHash) {
      blockers.push(issue('manifest_snapshot_hash_alias_mismatch'));
    }
    if (manifestHash && text(hashes.manifestHash) && manifestHash !== text(hashes.manifestHash)) {
      blockers.push(issue('manifest_snapshot_hash_mismatch'));
    }
    if (manifestHash && manifestHash !== computeChannelActionManifestHash(snapshots.manifest)) {
      blockers.push(issue('manifest_snapshot_hash_content_mismatch'));
    }
  }
  if (snapshots.preview?.kind !== 'AdapterRunPreview') {
    blockers.push(issue('preview_snapshot_required'));
  } else {
    if (!previewHash) blockers.push(issue('preview_snapshot_hash_required'));
    if (!previewAliasHash) blockers.push(issue('preview_snapshot_hash_alias_required'));
    if (!previewGenericHash) blockers.push(issue('preview_snapshot_generic_hash_required'));
    if (previewAliasHash && previewGenericHash && previewAliasHash !== previewGenericHash) {
      blockers.push(issue('preview_snapshot_hash_alias_mismatch'));
    }
    if (previewHash && text(hashes.previewHash) && previewHash !== text(hashes.previewHash)) {
      blockers.push(issue('preview_snapshot_hash_mismatch'));
    }
    if (previewHash && previewHash !== computeAdapterRunPreviewHash(snapshots.preview)) {
      blockers.push(issue('preview_snapshot_hash_content_mismatch'));
    }
  }
  return blockers;
}

function handoffSnapshotIdentityBlockers(report) {
  const mismatches = handoffSnapshotIdentityMismatches({
    handoff: report?.handoff || {},
    snapshots: report?.handoffSnapshots || {},
  });
  return mismatches.length
    ? [issue('handoff_snapshot_identity_mismatch', mismatches.slice(0, 8).join('; '))]
    : [];
}

export function actionEvidenceContract(action) {
  const normalizedAction = canonicalExternalAction(action);
  const spec = ACTION_EVIDENCE_CONTRACTS[normalizedAction] || Object.freeze({
    receiptResultFields: [],
    stateProofFields: [],
    terminalEvidenceFields: [],
  });
  return {
    action: normalizedAction,
    receiptResultFields: uniqueStrings(spec.receiptResultFields || [], 32),
    stateProofFields: uniqueStrings(spec.stateProofFields || [], 32),
    terminalEvidenceFields: uniqueStrings(spec.terminalEvidenceFields || [], 32),
    failureEvidenceFields: ['failureCode', 'statusText'],
    receiptMustBindPlatformSnapshotHash: true,
    receiptMustBindDryRunReplayHash: true,
    stateProofMustBindReceiptHash: true,
  };
}

function sdkBlockers(readinessReport) {
  const blockers = [];
  if (!readinessReport || readinessReport.kind !== 'AdapterDispatchReadinessReport') {
    blockers.push(issue('invalid_dispatch_readiness_report'));
    return blockers;
  }
  if (readinessReport.status !== ADAPTER_DISPATCH_READINESS_REPORT_STATUS.READY || readinessReport.readyForExternalRunner !== true) {
    blockers.push(issue('dispatch_readiness_not_ready'));
  }
  const readinessReportAliasHash = text(readinessReport.reportHash);
  const readinessReportGenericHash = genericHashOf(readinessReport);
  const readinessReportHash = readinessReportAliasHash || readinessReportGenericHash;
  if (!readinessReportHash) {
    blockers.push(issue('dispatch_readiness_report_hash_required'));
  }
  if (!readinessReportAliasHash) {
    blockers.push(issue('dispatch_readiness_report_hash_alias_required'));
  }
  if (!readinessReportGenericHash) {
    blockers.push(issue('dispatch_readiness_report_generic_hash_required'));
  }
  if (readinessReportAliasHash && readinessReportGenericHash && readinessReportAliasHash !== readinessReportGenericHash) {
    blockers.push(issue('dispatch_readiness_report_hash_alias_mismatch'));
  }
  if (readinessReportHash && readinessReportHash !== computeAdapterDispatchReadinessReportHash(readinessReport)) {
    blockers.push(issue('dispatch_readiness_report_hash_content_mismatch'));
  }
  if (!text(readinessReport.handoff?.channelId)) blockers.push(issue('channel_id_required'));
  if (!text(readinessReport.handoff?.actionId)) blockers.push(issue('action_id_required'));
  if (!text(readinessReport.runner?.runnerId)) blockers.push(issue('runner_id_required'));
  const runnerLocation = text(readinessReport.runner?.runnerLocation);
  if (!runnerLocation) {
    blockers.push(issue('runner_location_required'));
  } else if (!isExternalWorkspaceRunnerLocation(runnerLocation)) {
    blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, runnerLocation));
  }
  if (!text(readinessReport.runner?.capabilityHash)) blockers.push(issue('runner_capability_hash_required'));
  if (readinessReport.runner?.runnerMayExecuteExternalAction !== true) {
    blockers.push(issue('external_runner_execute_capability_required'));
  }
  blockers.push(...requiredHashBlockers(readinessReport));
  blockers.push(...handoffSnapshotBlockers(readinessReport));
  blockers.push(...handoffSnapshotIdentityBlockers(readinessReport));
  blockers.push(...customerMessagePreviewHashBlockers(readinessReport));
  blockers.push(...humanFeedbackContractHashBlockers(readinessReport));
  blockers.push(...promptGenerationBindingBlockers(readinessReport));
  for (const key of unsafeReadinessClaims(readinessReport)) {
    blockers.push(issue('dispatch_readiness_claims_unsafe_side_effect', key));
  }
  if (readinessReport.safety?.externalRunnerMustRecheckApproval !== true) {
    blockers.push(issue('approval_recheck_requirement_missing'));
  }
  if (readinessReport.safety?.externalRunnerMustRecheckEvidence !== true) {
    blockers.push(issue('evidence_recheck_requirement_missing'));
  }
  if (readinessReport.safety?.externalRunnerMustRecheckReplayGuard !== true) {
    blockers.push(issue('replay_guard_recheck_requirement_missing'));
  }
  if (readinessReport.safety?.externalRunnerMustRecheckChannelState !== true) {
    blockers.push(issue('channel_state_recheck_requirement_missing'));
  }
  return blockers;
}

function phaseSpec(phaseId, readinessReport) {
  const hashes = readinessReport?.hashBinding?.requiredHashes || {};
  const channelId = text(readinessReport?.handoff?.channelId);
  const actionId = text(readinessReport?.handoff?.actionId);
  const action = canonicalExternalAction(readinessReport?.handoff?.action);
  const taskKey = text(readinessReport?.handoff?.taskKey);
  const externalId = text(readinessReport?.handoff?.externalId);
  const humanFeedbackRevisionContractHash = text(readinessReport?.handoff?.humanFeedbackRevisionContractHash);
  const promptGenerationBinding = promptGenerationBindingFor(readinessReport);
  const promptGenerationBindingRequired = Boolean(promptGenerationBinding) || isPromptGenerationSpendHandoff(readinessReport);
  const evidenceContract = actionEvidenceContract(action);
  const receiptResultFields = uniqueStrings([
    ...evidenceContract.receiptResultFields,
    ...(humanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
  ], 32);
  const stateProofFields = uniqueStrings([
    ...evidenceContract.stateProofFields,
    ...(humanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
    ...(promptGenerationBindingRequired ? ['promptGenerationBinding'] : []),
  ], 32);
  const commonInputs = [
    'dispatchEnvelopeHash',
    'assignmentHash',
    'manifestSnapshot',
    'adapterRunPreviewSnapshot',
    ...REQUIRED_DISPATCH_HASHES,
    ...(action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE ? ['messagePreviewHash'] : []),
    ...(humanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
    ...(promptGenerationBindingRequired ? ['promptGenerationBinding'] : []),
  ];
  const commonRechecks = [
    'recompute_all_handoff_hashes',
    'recheck_current_approval_hash',
    'recheck_fresh_evidence_hash',
    'recheck_replay_guard_against_current_archive',
    'recheck_channel_account_and_capability',
    ...(promptGenerationBindingRequired ? ['recheck_prompt_generation_binding'] : []),
  ];
  const byPhase = {
    inspect: {
      runnerSideEffect: 'read_only_inspection',
      requiredInputs: commonInputs,
      requiredRechecks: [
        ...commonRechecks,
        'verify_task_identity_before_any_browser_or_api_action',
      ],
      requiredEvidenceKinds: [
        'handoff_hash_recompute_report',
        'runner_identity_snapshot',
      ],
      expectedOutputKind: 'RunnerInspectionReport',
    },
    prepare: {
      runnerSideEffect: 'external_prepare_may_upload_or_stage_when_action_allows',
      requiredInputs: [
        ...commonInputs,
        'artifactNames',
        'runnerLocation',
        'readOnlyPlatformStateSnapshot',
        'dryRunReplayEvidence',
      ],
      requiredRechecks: [
        ...commonRechecks,
        'recheck_submit_ready_artifact_names_and_hashes',
        'recheck_prepare_or_dryrun_limits',
        'recheck_platform_state_snapshot_is_current',
        'replay_dry_run_without_live_write',
        'stop_on_upload_or_prepare_mismatch',
      ],
      requiredEvidenceKinds: [
        'platform_state_snapshot',
        'dry_run_replay_evidence',
        'prepare_evidence_or_terminal_result',
      ],
      expectedOutputKind: 'PrepareEvidenceOrTerminalRunnerResult',
    },
    execute: {
      runnerSideEffect: 'external_action_may_execute_only_outside_core',
      requiredInputs: [
        ...commonInputs,
        'explicit_current_chat_action_approval',
        'readOnlyPlatformStateSnapshot',
        'platformStateSnapshotHash',
        'dryRunReplayEvidence',
        'dryRunReplayHash',
        'prepareEvidenceWhenRequired',
        ...(humanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
      ],
      requiredRechecks: [
        ...commonRechecks,
        'recheck_current_chat_specific_approval',
        'recheck_duplicate_or_replay_preflight',
        'recheck_platform_state_immediately_before_click_or_submit',
        'bind_execute_attempt_to_platform_state_snapshot_hash',
        'bind_execute_attempt_to_dry_run_replay_hash',
        'stop_if_snapshot_or_replay_is_stale',
        ...(humanFeedbackRevisionContractHash ? ['bind_human_feedback_contract_hash_before_external_action'] : []),
      ],
      requiredEvidenceKinds: [
        'current_chat_execution_approval',
        'fresh_platform_state_snapshot',
        'dry_run_replay_evidence',
        'duplicate_or_replay_preflight',
        'external_runner_result',
      ],
      expectedOutputKind: 'ExternalRunnerResult',
    },
    receipt: {
      runnerSideEffect: 'local_receipt_recording',
      requiredInputs: [
        ...commonInputs,
        'externalRunnerResult',
        'platformStateSnapshotHash',
        'dryRunReplayHash',
        ...(humanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
      ],
      requiredRechecks: [
        'bind_receipt_to_manifest_preview_approval_and_evidence_hashes',
        ...(humanFeedbackRevisionContractHash ? ['bind_receipt_to_human_feedback_contract_hash'] : []),
        ...(promptGenerationBindingRequired ? ['recheck_prompt_generation_binding'] : []),
        'bind_receipt_to_platform_state_snapshot_and_dry_run_replay_hashes',
        'bind_receipt_to_action_specific_external_id',
        'record_terminal_failed_or_cancelled_results_without_retrying',
      ],
      requiredEvidenceKinds: [
        'post_action_receipt',
        'terminal_result_record',
      ],
      expectedOutputKind: 'AdapterRunReceipt',
    },
    stateProof: {
      runnerSideEffect: 'read_only_channel_state_verification',
      requiredInputs: [
        ...commonInputs,
        'adapterRunReceipt',
        'postActionReceiptHash',
        'postActionChannelStateSnapshot',
        ...(humanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
      ],
      requiredRechecks: [
        'read_current_channel_state_without_mutation',
        'bind_state_proof_to_receipt_hash',
        ...(humanFeedbackRevisionContractHash ? ['bind_state_proof_to_human_feedback_contract_hash'] : []),
        ...(promptGenerationBindingRequired ? ['recheck_prompt_generation_binding'] : []),
        'bind_state_proof_to_post_action_platform_snapshot',
        'do_not_advance_lifecycle_without_local_state_transition_gate',
      ],
      requiredEvidenceKinds: [
        'post_action_channel_state_proof',
        'receipt_bound_state_snapshot',
      ],
      expectedOutputKind: 'ChannelStateProof',
    },
  };
  const spec = byPhase[phaseId];
  return {
    phaseId,
    channelId,
    actionId,
    action,
    taskKey,
    externalId,
    runnerSideEffect: spec.runnerSideEffect,
    coreCanRun: false,
    coreGrantsPermission: false,
    runnerMustLiveOutsideCore: true,
    requiredInputs: uniqueStrings(spec.requiredInputs, 64),
    requiredRechecks: uniqueStrings(spec.requiredRechecks, 64),
    requiredEvidenceKinds: uniqueStrings(spec.requiredEvidenceKinds, 64),
    actionEvidenceFields: phaseId === 'receipt'
      ? receiptResultFields
      : (phaseId === 'stateProof' ? stateProofFields : []),
    expectedOutputKind: spec.expectedOutputKind,
    hashBinding: {
      dispatchEnvelopeHash: hashOf(readinessReport, ['dispatchEnvelopeHash']),
      assignmentHash: hashOf(readinessReport, ['assignmentHash']),
      outboxHash: text(hashes.outboxHash),
      replayGuardHash: text(hashes.replayGuardHash),
      manifestHash: text(hashes.manifestHash),
      previewHash: text(hashes.previewHash),
      approvalHash: text(hashes.approvalHash),
      evidenceHash: text(hashes.evidenceHash),
      approvalProvenanceHash: text(hashes.approvalProvenanceHash),
      ledgerHash: text(hashes.ledgerHash),
      promptGenerationBinding,
    },
  };
}

export function computeAdapterRunnerSdkContractHash(contract = {}) {
  return digest({
    version: contract?.version,
    kind: contract?.kind,
    sdkId: contract?.sdkId,
    actor: contract?.actor,
    status: contract?.status,
    readyForExternalImplementation: contract?.readyForExternalImplementation,
    handoff: hashIdentityPayload(contract?.handoff),
    runner: contract?.runner,
    hashBinding: contract?.hashBinding,
    handoffSnapshots: hashIdentityPayload(contract?.handoffSnapshots),
    actionEvidenceContract: hashIdentityPayload(contract?.actionEvidenceContract),
    phases: hashIdentityPayload(contract?.phases),
    acceptanceCriteria: contract?.acceptanceCriteria,
    blockers: contract?.blockers,
    warnings: contract?.warnings,
    evidenceRefs: contract?.evidenceRefs,
    safety: contract?.safety,
  });
}

export function buildAdapterRunnerSdkContract({
  readinessReport = null,
  sdkId = 'external-adapter-runner-sdk',
  actor = 'design-production-core.adapter-runner-sdk',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const blockers = sdkBlockers(readinessReport);
  const status = blockers.length
    ? ADAPTER_RUNNER_SDK_STATUS.BLOCKED
    : ADAPTER_RUNNER_SDK_STATUS.READY;
  const actionEvidence = actionEvidenceContract(readinessReport?.handoff?.action);
  const phases = ADAPTER_RUNNER_SDK_PHASES.map((phaseId) => phaseSpec(phaseId, readinessReport));
  const contract = {
    version: ADAPTER_RUNNER_SDK_VERSION,
    kind: 'AdapterRunnerSdkContract',
    sdkId: normalizeText(sdkId) || 'external-adapter-runner-sdk',
    actor: normalizeText(actor) || 'design-production-core.adapter-runner-sdk',
    status,
    readyForExternalImplementation: status === ADAPTER_RUNNER_SDK_STATUS.READY,
    handoff: {
      channelId: text(readinessReport?.handoff?.channelId),
      actionId: text(readinessReport?.handoff?.actionId),
      action: canonicalActionOrNull(readinessReport?.handoff?.action),
      taskKey: text(readinessReport?.handoff?.taskKey),
      externalId: text(readinessReport?.handoff?.externalId),
      productLineId: canonicalProductLineOrNull(readinessReport?.handoff?.productLineId),
      workflowId: canonicalProductLineOrNull(readinessReport?.handoff?.workflowId),
      packageRole: canonicalPackageRole(readinessReport?.handoff?.packageRole || '') || null,
      approvalProvenanceHash: text(readinessReport?.handoff?.approvalProvenanceHash),
      humanFeedbackRevisionContractHash: text(readinessReport?.handoff?.humanFeedbackRevisionContractHash),
      promptGenerationBinding: promptGenerationBindingFor(readinessReport),
      messagePreview: text(readinessReport?.handoff?.messagePreview),
      messagePreviewHash: text(readinessReport?.handoff?.messagePreviewHash),
      artifactNames: uniqueStrings(readinessReport?.handoff?.artifactNames || [], 128),
      artifactCount: readinessReport?.handoff?.artifactCount || 0,
    },
    runner: {
      runnerId: text(readinessReport?.runner?.runnerId),
      capabilityHash: text(readinessReport?.runner?.capabilityHash),
      registryHash: text(readinessReport?.runner?.registryHash),
      selectionHash: text(readinessReport?.runner?.selectionHash),
      runnerLocation: text(readinessReport?.runner?.runnerLocation),
      runnerLocationExternalWorkspace: isExternalWorkspaceRunnerLocation(readinessReport?.runner?.runnerLocation),
      runnerMayExecuteExternalAction: readinessReport?.runner?.runnerMayExecuteExternalAction === true,
    },
    hashBinding: {
      readinessReportHash: hashOf(readinessReport, ['reportHash']),
      dispatchEnvelopeHash: hashOf(readinessReport, ['dispatchEnvelopeHash']),
      assignmentHash: hashOf(readinessReport, ['assignmentHash']),
      requiredHashes: {
        ...Object.fromEntries(REQUIRED_DISPATCH_HASHES.map((key) => [key, text(readinessReport?.hashBinding?.requiredHashes?.[key])])),
        humanFeedbackRevisionContractHash: text(readinessReport?.hashBinding?.requiredHashes?.humanFeedbackRevisionContractHash),
        messagePreviewHash: text(readinessReport?.hashBinding?.requiredHashes?.messagePreviewHash),
        promptGenerationBinding: promptGenerationBindingFor(readinessReport),
        ledgerHash: text(readinessReport?.hashBinding?.requiredHashes?.ledgerHash),
      },
    },
    handoffSnapshots: readinessReport?.handoffSnapshots || null,
    actionEvidenceContract: actionEvidence,
    phases,
    acceptanceCriteria: [
      'external_runner_recomputes_all_hashes_before_each_phase',
      'external_runner_recomputes_manifest_and_preview_snapshots_before_receipt',
      'external_runner_rechecks_current_approval_and_fresh_evidence',
      'external_runner_rechecks_prompt_generation_binding_when_present',
      'external_runner_rechecks_replay_guard_and_channel_duplicate_state',
      'external_runner_binds_platform_state_snapshot_before_prepare_or_execute',
      'external_runner_binds_dry_run_replay_before_prepare_or_execute',
      'external_runner_records_adapter_receipt_for_success_failure_or_cancel',
      'external_runner_binds_receipt_to_snapshot_and_replay_hashes',
      'external_runner_supplies_action_specific_receipt_and_state_proof_fields',
      'external_runner_supplies_read_only_channel_state_proof_before_local_transition',
      'core_never_executes_or_grants_permission_from_this_contract',
    ],
    blockers,
    warnings: [
      issue('adapter_runner_sdk_contract_only', 'SDK contracts describe external runner implementation phases but never execute them.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      sdkContractOnly: true,
      executesExternalAction: false,
      runnerMayExecuteExternalAction: readinessReport?.runner?.runnerMayExecuteExternalAction === true,
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
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
      currentChatApprovalStillRequired: true,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const sdkHash = computeAdapterRunnerSdkContractHash(contract);
  return {
    ...contract,
    sdkHash,
    hash: sdkHash,
  };
}

export function summarizeAdapterRunnerSdkContracts(contracts = []) {
  const byStatus = {};
  const byChannel = {};
  const byActionId = {};
  const blockerCodes = {};
  let readyCount = 0;
  let blockedCount = 0;
  let phaseCount = 0;
  for (const contract of contracts || []) {
    byStatus[contract.status] = (byStatus[contract.status] || 0) + 1;
    byChannel[contract.handoff?.channelId || 'unknown'] = (byChannel[contract.handoff?.channelId || 'unknown'] || 0) + 1;
    byActionId[contract.handoff?.actionId || 'unknown'] = (byActionId[contract.handoff?.actionId || 'unknown'] || 0) + 1;
    if (contract.status === ADAPTER_RUNNER_SDK_STATUS.READY) readyCount += 1;
    if (contract.status === ADAPTER_RUNNER_SDK_STATUS.BLOCKED) blockedCount += 1;
    phaseCount += contract.phases?.length || 0;
    for (const blocker of contract.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
  }
  return {
    version: ADAPTER_RUNNER_SDK_VERSION,
    count: contracts.length,
    readyCount,
    blockedCount,
    phaseCount,
    byStatus,
    byChannel,
    byActionId,
    blockerCodes,
    safety: {
      sdkContractOnly: true,
      executesExternalAction: contracts.some((contract) => contract.safety?.executesExternalAction === true),
      fetchesChannelState: contracts.some((contract) => contract.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: contracts.some((contract) => contract.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: contracts.some((contract) => contract.safety?.grantsExecutionPermission === true),
      readyForExecution: contracts.some((contract) => contract.safety?.readyForExecution === true),
    },
  };
}
