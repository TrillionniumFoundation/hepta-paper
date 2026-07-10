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
  approvalProvenanceDigest,
  computeApprovalPacketHash,
} from './approval-evidence-hashes.mjs';
import { computeAdapterHandoffOutboxHash } from './adapter-handoff-outbox.mjs';
import {
  EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS,
  computeExternalActionAuditArchiveHash,
} from './external-action-audit-archive.mjs';
import { digest } from './hash-utils.mjs';

export const EXTERNAL_ACTION_REPLAY_GUARD_VERSION = 1;

export const EXTERNAL_ACTION_REPLAY_GUARD_STATUS = Object.freeze({
  CLEAR: 'clear_for_new_handoff',
  BLOCKED: 'blocked_replay_guard',
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

function text(value) {
  return normalizeText(value || '') || null;
}

function expectedArchiveHash(archive) {
  return computeExternalActionAuditArchiveHash(archive);
}

function hashFrom(value, key) {
  return text(value?.[key]
    || value?.payload?.[key]
    || value?.hashBinding?.[key]
    || value?.chain?.[key]
    || value?.runner?.requiredHashes?.[key]
    || '');
}

function messagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function promptGenerationBindingFrom(candidate = {}) {
  return candidate?.promptGenerationBinding
    || candidate?.payload?.promptGenerationBinding
    || candidate?.runner?.requiredHashes?.promptGenerationBinding
    || candidate?.hashBinding?.promptGenerationBinding
    || null;
}

function isPromptGenerationSpendAction(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = uniqueStrings([...Object.keys(left), ...Object.keys(right)], 32);
  return keys.every((key) => text(left[key]) === text(right[key]));
}

function promptGenerationBindingValues(candidate = {}) {
  return [
    candidate?.promptGenerationBinding,
    candidate?.payload?.promptGenerationBinding,
    candidate?.runner?.requiredHashes?.promptGenerationBinding,
    candidate?.hashBinding?.promptGenerationBinding,
  ];
}

function outboxPromptGenerationBindingValues(candidate = {}) {
  const snapshots = candidate?.runner?.handoffSnapshots || {};
  return [
    candidate?.payload?.promptGenerationBinding,
    candidate?.runner?.requiredHashes?.promptGenerationBinding,
    snapshots.manifest?.payload?.promptGenerationBinding,
    snapshots.preview?.payload?.promptGenerationBinding,
    snapshots.preview?.adapter?.requiredHashes?.promptGenerationBinding,
  ];
}

function isPromptGenerationSpendCandidate(candidate = {}) {
  const snapshots = candidate?.runner?.handoffSnapshots || {};
  return [
    candidate?.action,
    candidate?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => isPromptGenerationSpendAction(value));
}

function promptGenerationBindingBlockers(candidate = {}) {
  if (!isPromptGenerationSpendCandidate(candidate)) return [];
  const blockers = [];
  const pushOnce = (code) => {
    if (!blockers.some((blocker) => blocker.code === code)) blockers.push(issue(code));
  };
  const values = promptGenerationBindingValues(candidate);
  const present = values.filter(Boolean);
  if (!present.length) {
    pushOnce('candidate_prompt_generation_binding_required');
  } else if (!present.every((value) => samePromptGenerationBinding(value, present[0]))) {
    pushOnce('candidate_prompt_generation_binding_mismatch');
  } else if (PROMPT_GENERATION_BINDING_KEYS.some((key) => !text(present[0]?.[key]))) {
    pushOnce('candidate_prompt_generation_binding_incomplete');
  }
  if (candidate?.kind === 'AdapterHandoffOutboxItem') {
    const outboxValues = outboxPromptGenerationBindingValues(candidate);
    const outboxPresent = outboxValues.filter(Boolean);
    if (outboxPresent.length !== outboxValues.length) {
      pushOnce('candidate_prompt_generation_binding_required');
    } else if (!outboxPresent.every((value) => samePromptGenerationBinding(value, outboxPresent[0]))) {
      pushOnce('candidate_prompt_generation_binding_mismatch');
    } else if (PROMPT_GENERATION_BINDING_KEYS.some((key) => !text(outboxPresent[0]?.[key]))) {
      pushOnce('candidate_prompt_generation_binding_incomplete');
    }
  }
  return blockers;
}

function contractHashesFromApproval(approval) {
  return uniqueStrings([
    approval?.humanFeedbackRevisionContractHash,
    approval?.plan?.humanFeedbackRevisionContractHash,
    approval?.artifactPackage?.humanFeedbackRevisionContractHash,
    approval?.reviewReport?.humanFeedbackRevisionContractHash,
  ], 16);
}

function customerMessageCandidate(candidate) {
  return canonicalExternalAction(candidate?.action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
}

function customerMessageOutboxCandidate(candidate = {}) {
  if (candidate?.kind !== 'AdapterHandoffOutboxItem') return false;
  const snapshots = candidate?.runner?.handoffSnapshots || {};
  return [
    candidate?.action,
    candidate?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ].some((value) => canonicalExternalAction(value) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function humanFeedbackValue(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function boundHashValues(candidate = {}, key) {
  const snapshots = candidate?.runner?.handoffSnapshots || {};
  return [
    ['payload', candidate?.payload?.[key]],
    ['runner_required_hashes', candidate?.runner?.requiredHashes?.[key]],
    ['manifest_payload', snapshots.manifest?.payload?.[key]],
    ['preview_payload', snapshots.preview?.payload?.[key]],
    ['preview_required_hashes', snapshots.preview?.adapter?.requiredHashes?.[key]],
  ];
}

function hasBoundHashValue(candidate = {}, key) {
  return boundHashValues(candidate, key).some(([, value]) => text(value));
}

function humanFeedbackOutboxCandidate(candidate = {}) {
  if (candidate?.kind !== 'AdapterHandoffOutboxItem') return false;
  const snapshots = candidate?.runner?.handoffSnapshots || {};
  const productValues = [
    candidate?.payload?.productLineId,
    candidate?.payload?.workflowId,
    candidate?.payload?.packageRole,
    snapshots.manifest?.productLineId,
    snapshots.manifest?.workflowId,
    snapshots.manifest?.payload?.productLineId,
    snapshots.manifest?.payload?.workflowId,
    snapshots.manifest?.payload?.packageRole,
    snapshots.manifest?.payload?.reviewType,
    snapshots.manifest?.payload?.role,
    snapshots.preview?.payload?.productLineId,
    snapshots.preview?.payload?.workflowId,
    snapshots.preview?.payload?.packageRole,
    snapshots.preview?.payload?.reviewType,
    snapshots.preview?.payload?.role,
  ];
  const actionValues = [
    candidate?.action,
    candidate?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ];
  return productValues.some((value) => humanFeedbackValue(value))
    || actionValues.some((value) => isHumanFeedbackMessageActionAlias(value));
}

function humanFeedbackActionOutboxCandidate(candidate = {}) {
  if (candidate?.kind !== 'AdapterHandoffOutboxItem') return false;
  const snapshots = candidate?.runner?.handoffSnapshots || {};
  const actionValues = [
    candidate?.action,
    candidate?.payload?.action,
    snapshots.manifest?.action,
    snapshots.manifest?.payload?.action,
    snapshots.preview?.payload?.action,
  ];
  return actionValues.some((value) => isHumanFeedbackCustomerFacingAction(value))
    && (
      humanFeedbackOutboxCandidate(candidate)
      || hasBoundHashValue(candidate, 'humanFeedbackRevisionContractHash')
    );
}

function requiredBoundHashBlockers(candidate, key, {
  required,
  requiredCode,
  mismatchCode,
}) {
  const values = boundHashValues(candidate, key);
  const present = values.map(([, value]) => text(value)).filter(Boolean);
  if (!required && !present.length) return [];
  const blockers = [];
  const missingSources = values.filter(([, value]) => !text(value)).map(([source]) => source);
  if (missingSources.length) blockers.push(issue(requiredCode, missingSources.join(', ')));
  if (present.length && present.some((value) => value !== present[0])) blockers.push(issue(mismatchCode));
  return blockers;
}

function outboxMessagePreviewHashBlockers(candidate = {}) {
  return requiredBoundHashBlockers(candidate, 'messagePreviewHash', {
    required: customerMessageOutboxCandidate(candidate),
    requiredCode: 'candidate_outbox_message_preview_hash_required',
    mismatchCode: 'candidate_outbox_message_preview_hash_mismatch',
  });
}

function outboxHumanFeedbackContractHashBlockers(candidate = {}) {
  return requiredBoundHashBlockers(candidate, 'humanFeedbackRevisionContractHash', {
    required: humanFeedbackActionOutboxCandidate(candidate),
    requiredCode: 'candidate_outbox_human_feedback_contract_hash_required',
    mismatchCode: 'candidate_outbox_human_feedback_contract_hash_mismatch',
  });
}

function humanFeedbackCandidate(candidate) {
  return isHumanFeedbackCustomerFacingAction(candidate?.action)
    && (
      humanFeedbackValue(candidate?.productLineId)
      || humanFeedbackValue(candidate?.workflowId)
      || humanFeedbackValue(candidate?.packageRole || candidate?.payload?.packageRole)
      || humanFeedbackValue(candidate?.reviewType || candidate?.payload?.reviewType)
      || humanFeedbackValue(candidate?.role || candidate?.payload?.role)
      || Boolean(candidate?.humanFeedbackRevisionContractHash)
    );
}

function normalizeCandidate(candidate = {}) {
  const action = canonicalExternalAction(candidate?.action || candidate?.payload?.action)
    || text(candidate?.action || candidate?.payload?.action);
  return {
    kind: candidate?.kind || 'ReplayGuardCandidate',
    channelId: text(candidate?.channelId || candidate?.adapter?.channelId),
    actionId: text(candidate?.actionId || candidate?.adapter?.actionId),
    action,
    taskKey: text(candidate?.taskKey || candidate?.payload?.taskKey),
    externalId: text(candidate?.externalId || candidate?.payload?.externalId),
    productLineId: canonicalProductLineId(candidate?.productLineId || candidate?.payload?.productLineId || ''),
    workflowId: canonicalProductLineId(candidate?.workflowId || candidate?.payload?.workflowId || ''),
    packageRole: canonicalPackageRole(candidate?.packageRole || candidate?.payload?.packageRole || '') || null,
    messagePreviewHash: hashFrom(candidate, 'messagePreviewHash'),
    humanFeedbackRevisionContractHash: hashFrom(candidate, 'humanFeedbackRevisionContractHash'),
    promptGenerationBinding: promptGenerationBindingFrom(candidate),
    platformStateSnapshotHash: hashFrom(candidate, 'platformStateSnapshotHash'),
    dryRunReplayHash: hashFrom(candidate, 'dryRunReplayHash'),
    bundleHash: text(candidate?.bundleHash || candidate?.hashBinding?.bundleHash),
    ledgerHash: hashFrom(candidate, 'ledgerHash'),
    manifestHash: hashFrom(candidate, 'manifestHash'),
    previewHash: hashFrom(candidate, 'previewHash'),
    outboxHash: text(candidate?.outboxHash),
  };
}

function outboxCandidateBlockers(candidate) {
  const blockers = [];
  if (candidate?.kind !== 'AdapterHandoffOutboxItem') return blockers;
  const outboxAliasHash = text(candidate.outboxHash);
  const outboxGenericHash = text(candidate.hash);
  if (!outboxAliasHash) blockers.push(issue('candidate_outbox_hash_alias_required'));
  if (!outboxGenericHash) blockers.push(issue('candidate_outbox_generic_hash_required'));
  if (outboxAliasHash && outboxGenericHash && outboxAliasHash !== outboxGenericHash) {
    blockers.push(issue('candidate_outbox_hash_alias_mismatch'));
  }
  const expectedHash = computeAdapterHandoffOutboxHash(candidate);
  if (outboxAliasHash && expectedHash && outboxAliasHash !== expectedHash) {
    blockers.push(issue('candidate_outbox_hash_content_mismatch'));
  }
  blockers.push(...outboxMessagePreviewHashBlockers(candidate));
  blockers.push(...outboxHumanFeedbackContractHashBlockers(candidate));
  return blockers;
}

function sameTaskAction(entry, candidate) {
  if (!entry || !candidate) return false;
  const taskMatches = text(entry.taskKey) && candidate.taskKey && text(entry.taskKey) === candidate.taskKey;
  const externalMatches = text(entry.externalId) && candidate.externalId && text(entry.externalId) === candidate.externalId;
  const entryAction = canonicalExternalAction(entry.action);
  const candidateAction = canonicalExternalAction(candidate.action);
  const actionMatches = (text(entry.actionId) && candidate.actionId && text(entry.actionId) === candidate.actionId)
    || (
      entryAction
      && candidateAction
      && entryAction !== EXTERNAL_ACTIONS.NONE
      && candidateAction !== EXTERNAL_ACTIONS.NONE
      && entryAction === candidateAction
    );
  return actionMatches && (taskMatches || externalMatches);
}

function matchArchiveEntries(archive, candidate) {
  const entries = archive?.entries || [];
  return entries.filter((entry) => {
    if (candidate.bundleHash && entry.bundleHash === candidate.bundleHash) return true;
    if (candidate.ledgerHash && entry.ledgerHash === candidate.ledgerHash) return true;
    return sameTaskAction(entry, candidate);
  });
}

function repeatFreshnessAnchorBlockers(matchedEntries, candidate) {
  const blockers = [];
  const platformStateSnapshotHash = text(candidate?.platformStateSnapshotHash);
  const dryRunReplayHash = text(candidate?.dryRunReplayHash);
  const archivedPlatformStateSnapshotHashes = uniqueStrings(
    (matchedEntries || []).map((entry) => entry.platformStateSnapshotHash),
    64,
  );
  const archivedDryRunReplayHashes = uniqueStrings(
    (matchedEntries || []).map((entry) => entry.dryRunReplayHash),
    64,
  );

  if (!platformStateSnapshotHash) {
    blockers.push(issue('repeat_candidate_platform_state_snapshot_hash_required'));
  } else if (archivedPlatformStateSnapshotHashes.includes(platformStateSnapshotHash)) {
    blockers.push(issue('repeat_candidate_platform_state_snapshot_hash_stale'));
  }
  if (!dryRunReplayHash) {
    blockers.push(issue('repeat_candidate_dry_run_replay_hash_required'));
  } else if (archivedDryRunReplayHashes.includes(dryRunReplayHash)) {
    blockers.push(issue('repeat_candidate_dry_run_replay_hash_stale'));
  }
  return blockers;
}

function archiveBlockers(archive, requireReadyArchive) {
  const blockers = [];
  if (!archive) {
    if (requireReadyArchive) blockers.push(issue('audit_archive_required'));
    return blockers;
  }
  if (archive.kind !== 'ExternalActionAuditArchive') blockers.push(issue('invalid_audit_archive'));
  const archiveAliasHash = text(archive.archiveHash);
  const archiveGenericHash = text(archive.hash);
  const archiveHash = archiveAliasHash || archiveGenericHash;
  const expectedHash = expectedArchiveHash(archive);
  if (!archiveHash) blockers.push(issue('audit_archive_hash_required'));
  if (!archiveAliasHash) blockers.push(issue('audit_archive_hash_alias_required'));
  if (!archiveGenericHash) blockers.push(issue('audit_archive_generic_hash_required'));
  if (archiveAliasHash && archiveGenericHash && archiveAliasHash !== archiveGenericHash) {
    blockers.push(issue('audit_archive_hash_alias_mismatch'));
  }
  if (archiveHash && expectedHash && archiveHash !== expectedHash) blockers.push(issue('audit_archive_hash_content_mismatch'));
  if (requireReadyArchive && (archive.status !== EXTERNAL_ACTION_AUDIT_ARCHIVE_STATUS.READY || archive.ready !== true)) {
    blockers.push(issue('audit_archive_not_ready'));
  }
  if (archive.safety?.executesExternalAction === true) blockers.push(issue('audit_archive_claims_external_execution'));
  if (archive.safety?.grantsExecutionPermission === true) blockers.push(issue('audit_archive_claims_permission'));
  return blockers;
}

function timeMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function repeatApprovalBlockers(repeatApproval, candidate, evaluatedAt) {
  const blockers = [];
  if (!repeatApproval) {
    blockers.push(issue('repeat_approval_required'));
    return blockers;
  }
  if (repeatApproval.kind !== 'ApprovalPacket') {
    blockers.push(issue('repeat_approval_packet_required'));
    return blockers;
  }

  const recordedAliasHash = text(repeatApproval.approvalHash);
  const recordedGenericHash = text(repeatApproval.hash);
  const recordedHash = recordedAliasHash || recordedGenericHash;
  const recomputedHash = computeApprovalPacketHash(repeatApproval);
  if (!recordedHash) blockers.push(issue('repeat_approval_hash_required'));
  if (!recordedAliasHash) blockers.push(issue('repeat_approval_hash_alias_required'));
  if (!recordedGenericHash) blockers.push(issue('repeat_approval_generic_hash_required'));
  if (recordedAliasHash && recordedGenericHash && recordedAliasHash !== recordedGenericHash) {
    blockers.push(issue('repeat_approval_hash_alias_mismatch'));
  }
  if (recordedHash && recomputedHash && recordedHash !== recomputedHash) {
    blockers.push(issue('repeat_approval_hash_content_mismatch'));
  }
  if (repeatApproval.ok !== true || repeatApproval.status !== 'approved') {
    blockers.push(issue('repeat_approval_not_approved'));
  }

  const provenance = approvalProvenanceDigest(repeatApproval.approvalProvenance || repeatApproval.provenance);
  if (!provenance) {
    blockers.push(issue('repeat_approval_current_chat_provenance_required'));
  } else {
    for (const [field, code] of [
      ['currentChatId', 'repeat_approval_current_chat_id_required'],
      ['sourceMessageId', 'repeat_approval_source_message_required'],
      ['requesterId', 'repeat_approval_requester_identity_required'],
      ['intentNonce', 'repeat_approval_intent_nonce_required'],
      ['approvalNonce', 'repeat_approval_nonce_required'],
      ['approvalTextHash', 'repeat_approval_explicit_text_hash_required'],
    ]) {
      if (!text(provenance[field])) blockers.push(issue(code));
    }
    if (provenance.explicitApproval !== true) {
      blockers.push(issue('repeat_approval_explicit_wording_required'));
    }
  }

  const approvalAction = canonicalExternalAction(repeatApproval.action);
  const candidateAction = canonicalExternalAction(candidate.action);
  if (approvalAction && candidateAction && approvalAction !== candidateAction) {
    blockers.push(issue('repeat_approval_action_mismatch'));
  }

  const approvalTaskKey = text(repeatApproval.taskKey);
  const approvalExternalId = text(repeatApproval.externalId);
  const candidateTaskKey = text(candidate.taskKey);
  const candidateExternalId = text(candidate.externalId);
  if (!approvalTaskKey && !approvalExternalId) {
    blockers.push(issue('repeat_approval_identity_required'));
  } else if (
    (candidateTaskKey || candidateExternalId)
    && approvalTaskKey !== candidateTaskKey
    && approvalExternalId !== candidateExternalId
  ) {
    blockers.push(issue('repeat_approval_identity_mismatch'));
  }

  const expiresAt = text(repeatApproval.expiresAt);
  if (!expiresAt) {
    blockers.push(issue('repeat_approval_expiry_required'));
  } else {
    const expiryMs = timeMs(expiresAt);
    const evaluatedMs = timeMs(evaluatedAt);
    if (expiryMs === null || evaluatedMs === null) {
      blockers.push(issue('repeat_approval_time_invalid'));
    } else if (expiryMs <= evaluatedMs) {
      blockers.push(issue('repeat_approval_expired'));
    }
  }

  if (customerMessageCandidate(candidate)) {
    const candidateMessageHash = text(candidate.messagePreviewHash);
    const approvalMessageHash = messagePreviewHash(repeatApproval.messagePreview);
    if (!candidateMessageHash) {
      blockers.push(issue('repeat_candidate_message_preview_hash_required'));
    } else if (!approvalMessageHash) {
      blockers.push(issue('repeat_approval_message_preview_required'));
    } else if (approvalMessageHash !== candidateMessageHash) {
      blockers.push(issue('repeat_approval_message_preview_hash_mismatch'));
    }
  }

  if (humanFeedbackCandidate(candidate)) {
    const candidateContractHash = text(candidate.humanFeedbackRevisionContractHash);
    const approvalContractHashes = contractHashesFromApproval(repeatApproval);
    if (!candidateContractHash) {
      blockers.push(issue('repeat_candidate_human_feedback_contract_hash_required'));
    } else if (!approvalContractHashes.length) {
      blockers.push(issue('repeat_approval_human_feedback_contract_hash_required'));
    } else if (!approvalContractHashes.includes(candidateContractHash)) {
      blockers.push(issue('repeat_approval_human_feedback_contract_hash_mismatch'));
    }
  }

  return blockers;
}

function replayBlockers({ archive, candidate, allowRepeat, repeatApproval, evaluatedAt }) {
  const blockers = [];
  const warnings = [];
  const matchedEntries = matchArchiveEntries(archive, candidate);
  const exactBundleMatch = matchedEntries.some((entry) => candidate.bundleHash && entry.bundleHash === candidate.bundleHash);
  const exactLedgerMatch = matchedEntries.some((entry) => candidate.ledgerHash && entry.ledgerHash === candidate.ledgerHash);
  const taskActionMatches = matchedEntries.filter((entry) => sameTaskAction(entry, candidate));

  if (exactBundleMatch) blockers.push(issue('bundle_hash_already_archived'));
  if (exactLedgerMatch) blockers.push(issue('ledger_hash_already_archived'));
  if (taskActionMatches.length && !allowRepeat) {
    blockers.push(issue('task_action_already_archived'));
  }
  if (taskActionMatches.length && allowRepeat) {
    const approvalBlockers = repeatApprovalBlockers(repeatApproval, candidate, evaluatedAt);
    blockers.push(...approvalBlockers);
    const freshnessBlockers = approvalBlockers.length
      ? []
      : repeatFreshnessAnchorBlockers(taskActionMatches, candidate);
    blockers.push(...freshnessBlockers);
    if (!approvalBlockers.length && !freshnessBlockers.length && !exactBundleMatch && !exactLedgerMatch) {
      warnings.push(issue('repeat_task_action_explicitly_allowed', repeatApproval.approvalHash, 'warning'));
    }
  }

  return { blockers, warnings, matchedEntries };
}

function hashCandidate(candidate = null) {
  if (!candidate) return candidate;
  return {
    ...candidate,
    action: canonicalActionOrNull(candidate.action),
    productLineId: canonicalProductLineOrNull(candidate.productLineId),
    workflowId: canonicalProductLineOrNull(candidate.workflowId),
    packageRole: Object.hasOwn(candidate, 'packageRole') ? canonicalPackageRole(candidate.packageRole) || null : undefined,
  };
}

function hashEntry(entry = null) {
  if (!entry) return entry;
  return {
    ...entry,
    action: canonicalActionOrNull(entry.action),
    productLineId: canonicalProductLineOrNull(entry.productLineId),
    workflowId: canonicalProductLineOrNull(entry.workflowId),
    packageRole: Object.hasOwn(entry, 'packageRole') ? canonicalPackageRole(entry.packageRole) || null : undefined,
  };
}

export function computeExternalActionReplayGuardHash(replayGuardDecision) {
  if (!replayGuardDecision) return null;
  return digest({
    version: replayGuardDecision.version,
    kind: replayGuardDecision.kind,
    actor: replayGuardDecision.actor,
    status: replayGuardDecision.status,
    clear: replayGuardDecision.clear,
    candidate: hashCandidate(replayGuardDecision.candidate),
    archiveHash: replayGuardDecision.archiveHash,
    matchedEntries: (replayGuardDecision.matchedEntries || []).map(hashEntry),
    blockers: replayGuardDecision.blockers,
    warnings: replayGuardDecision.warnings,
    evidenceRefs: replayGuardDecision.evidenceRefs,
    safety: replayGuardDecision.safety,
  });
}

export function buildExternalActionReplayGuardDecision({
  archive = null,
  candidate = null,
  allowRepeat = false,
  repeatApproval = null,
  requireReadyArchive = true,
  actor = 'design-production-core.external-action-replay-guard',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const timestamp = createdAt || new Date().toISOString();
  const normalizedCandidate = normalizeCandidate(candidate);
  const blockers = [
    ...archiveBlockers(archive, requireReadyArchive),
    ...outboxCandidateBlockers(candidate),
  ];
  if (!candidate) blockers.push(issue('candidate_required'));
  if (!normalizedCandidate.taskKey && !normalizedCandidate.externalId && !normalizedCandidate.ledgerHash && !normalizedCandidate.bundleHash) {
    blockers.push(issue('candidate_identity_required'));
  }
  if (customerMessageCandidate(normalizedCandidate) && !normalizedCandidate.messagePreviewHash) {
    blockers.push(issue('candidate_message_preview_hash_required'));
  }
  if (humanFeedbackCandidate(normalizedCandidate) && !normalizedCandidate.humanFeedbackRevisionContractHash) {
    blockers.push(issue('candidate_human_feedback_contract_hash_required'));
  }
  blockers.push(...promptGenerationBindingBlockers(candidate));

  const replay = blockers.length ? { blockers: [], warnings: [], matchedEntries: [] } : replayBlockers({
    archive,
    candidate: normalizedCandidate,
    allowRepeat,
    repeatApproval,
    evaluatedAt: timestamp,
  });
  blockers.push(...replay.blockers);
  const status = blockers.length
    ? EXTERNAL_ACTION_REPLAY_GUARD_STATUS.BLOCKED
    : EXTERNAL_ACTION_REPLAY_GUARD_STATUS.CLEAR;

  const decision = {
    version: EXTERNAL_ACTION_REPLAY_GUARD_VERSION,
    kind: 'ExternalActionReplayGuardDecision',
    actor: normalizeText(actor) || 'design-production-core.external-action-replay-guard',
    status,
    clear: status === EXTERNAL_ACTION_REPLAY_GUARD_STATUS.CLEAR,
    candidate: normalizedCandidate,
    archiveHash: text(archive?.archiveHash),
    matchedEntries: replay.matchedEntries.map((entry) => ({
      bundleHash: entry.bundleHash || null,
      ledgerHash: entry.ledgerHash || null,
      channelId: entry.channelId || null,
      actionId: entry.actionId || null,
      action: canonicalActionOrNull(entry.action),
      taskKey: entry.taskKey || null,
      externalId: entry.externalId || null,
      productLineId: canonicalProductLineOrNull(entry.productLineId),
      workflowId: canonicalProductLineOrNull(entry.workflowId),
      packageRole: canonicalPackageRole(entry.packageRole || '') || null,
      messagePreviewHash: entry.messagePreviewHash || null,
      humanFeedbackRevisionContractHash: entry.humanFeedbackRevisionContractHash || null,
      platformStateSnapshotHash: entry.platformStateSnapshotHash || null,
      dryRunReplayHash: entry.dryRunReplayHash || null,
      usesDispatchInboxChain: entry.usesDispatchInboxChain === true,
      dispatchEnvelopeHash: entry.dispatchEnvelopeHash || null,
      dispatchReplayGuardHash: entry.dispatchReplayGuardHash || null,
    })),
    blockers,
    warnings: [
      issue('replay_guard_verifies_only', 'Replay guard decisions never grant execution permission.', 'warning'),
      ...replay.warnings,
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      replayGuardOnly: true,
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
      exactHashReplayAlwaysBlocked: true,
      repeatTaskActionRequiresApproval: true,
    },
    createdAt: timestamp,
  };
  const replayGuardHash = computeExternalActionReplayGuardHash(decision);

  return {
    ...decision,
    replayGuardHash,
    hash: replayGuardHash,
  };
}

export function summarizeExternalActionReplayGuardDecisions(decisions = []) {
  const byStatus = {};
  const blockerCodes = {};
  const warningCodes = {};
  for (const decision of decisions || []) {
    byStatus[decision.status] = (byStatus[decision.status] || 0) + 1;
    for (const blocker of decision.blockers || []) {
      blockerCodes[blocker.code] = (blockerCodes[blocker.code] || 0) + 1;
    }
    for (const warning of decision.warnings || []) {
      warningCodes[warning.code] = (warningCodes[warning.code] || 0) + 1;
    }
  }
  return {
    version: EXTERNAL_ACTION_REPLAY_GUARD_VERSION,
    count: decisions.length,
    byStatus,
    blockerCodes,
    warningCodes,
    safety: {
      replayGuardOnly: true,
      executesExternalAction: decisions.some((decision) => decision.safety?.executesExternalAction === true),
      appliesLocalStateTransition: decisions.some((decision) => decision.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: decisions.some((decision) => decision.safety?.grantsExecutionPermission === true),
    },
  };
}
