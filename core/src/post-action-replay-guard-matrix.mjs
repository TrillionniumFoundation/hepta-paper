import {
  EXTERNAL_ACTIONS,
  canonicalExternalAction,
  canonicalExternalActionOrNull as canonicalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { buildApprovalPacket } from './approval-packets.mjs';
import { buildExternalActionAuditArchive } from './external-action-audit-archive.mjs';
import { computeExternalActionAuditBundleHash } from './external-action-audit-bundle.mjs';
import { buildExternalActionReplayGuardDecision } from './external-action-replay-guard.mjs';
import { buildPostActionAuditBundleMatrixRecords } from './post-action-audit-bundle-matrix.mjs';
import { buildPostActionAuditArchiveMatrixReport } from './post-action-audit-archive-matrix.mjs';
import { digest } from './hash-utils.mjs';

export const POST_ACTION_REPLAY_GUARD_MATRIX_VERSION = 1;

export const POST_ACTION_REPLAY_GUARD_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_post_action_replay_guard_matrix',
  FAIL: 'fail_post_action_replay_guard_matrix',
});

const FIXED_CREATED_AT = '2026-06-08T09:10:00.000Z';

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

function blockerCodes(record) {
  return uniqueStrings((record?.blockers || []).map((item) => item.code), 32);
}

function warningCodes(record) {
  return uniqueStrings((record?.warnings || []).map((item) => item.code), 32);
}

function archiveForBundles({
  bundles,
  archiveRole = 'post_action_replay_guard_matrix_archive',
  actor = 'post-action-replay-guard-matrix.archive',
} = {}) {
  return buildExternalActionAuditArchive({
    bundles,
    archiveRole,
    actor,
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-replay-guard-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function customerMessageAction(action) {
  return canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
}

function promptGenerationSpendAction(action) {
  const canonical = canonicalExternalAction(action);
  return canonical === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonical === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function strippedAuditBundlePayloadRecord(record, key) {
  const stripped = JSON.parse(JSON.stringify(record));
  if (stripped.auditBundle?.payload) {
    delete stripped.auditBundle.payload[key];
    const bundleHash = computeExternalActionAuditBundleHash(stripped.auditBundle);
    stripped.auditBundle.bundleHash = bundleHash;
    stripped.auditBundle.hash = bundleHash;
  }
  return stripped;
}

function freshnessAnchorsForRecord(record, mode) {
  if (mode === 'archived') {
    return {
      platformStateSnapshotHash: record.auditBundle?.hashBinding?.platformStateSnapshotHash || null,
      dryRunReplayHash: record.auditBundle?.hashBinding?.dryRunReplayHash || null,
    };
  }
  if (mode === 'fresh') {
    return {
      platformStateSnapshotHash: digest({
        kind: 'post-action-replay-guard-matrix',
        scenarioId: record.row.scenarioId,
        freshness: 'fresh-platform-state-snapshot',
      }),
      dryRunReplayHash: digest({
        kind: 'post-action-replay-guard-matrix',
        scenarioId: record.row.scenarioId,
        freshness: 'fresh-dry-run-replay',
      }),
    };
  }
  return {};
}

function candidateFromRecord(record, {
  includeHashes = false,
  newIdentity = false,
  freshnessAnchors = null,
} = {}) {
  const suffix = token(record.row.scenarioId);
  const taskKey = record.auditBundle.payload?.taskKey || record.row.scenarioId;
  const externalId = record.auditBundle.payload?.externalId || record.row.scenarioId;
  return {
    kind: 'ReplayGuardCandidate',
    channelId: record.row.channelId,
    actionId: record.row.actionId,
    action: canonicalActionOrNull(record.row.action),
    taskKey: newIdentity ? `${taskKey}::new-${suffix}` : taskKey,
    externalId: newIdentity ? `${externalId}::new-${suffix}` : externalId,
    productLineId: canonicalProductLineOrNull(record.auditBundle.payload?.productLineId || record.row.productLineId),
    workflowId: canonicalProductLineOrNull(record.auditBundle.payload?.workflowId || record.row.workflowId),
    packageRole: canonicalPackageRole(record.auditBundle.payload?.packageRole || record.row.packageRole || '') || null,
    messagePreview: record.preview?.payload?.messagePreview || record.manifest?.payload?.messagePreview || null,
    messagePreviewHash: record.auditBundle.payload?.messagePreviewHash || null,
    humanFeedbackRevisionContractHash: record.auditBundle.payload?.humanFeedbackRevisionContractHash || null,
    promptGenerationBinding: record.auditBundle.payload?.promptGenerationBinding || null,
    ...freshnessAnchorsForRecord(record, freshnessAnchors),
    ...(includeHashes ? {
      bundleHash: record.auditBundle.bundleHash,
      ledgerHash: record.ledger.ledgerHash,
    } : {}),
  };
}

function replayDecision({
  archive,
  candidate,
  allowRepeat = false,
  repeatApproval = null,
  actor,
}) {
  return buildExternalActionReplayGuardDecision({
    archive,
    candidate,
    allowRepeat,
    repeatApproval,
    actor,
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-replay-guard-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function repeatApprovalForCandidate(candidate, suffix) {
  return buildApprovalPacket({
    action: candidate.action,
    policy: 'repeat-allowed',
    channelTask: {
      taskKey: candidate.taskKey,
      channelId: candidate.channelId,
      externalId: candidate.externalId,
    },
    plan: candidate.humanFeedbackRevisionContractHash
      ? {
        taskKey: candidate.taskKey,
        channelId: candidate.channelId,
        externalId: candidate.externalId,
        productLineId: candidate.productLineId,
        workflowId: candidate.workflowId,
        humanFeedbackRevisionContract: {
          contractHash: candidate.humanFeedbackRevisionContractHash,
        },
      }
      : null,
    messagePreview: candidate.messagePreview || null,
    reason: `post-action replay repeat approval ${suffix}`,
    requestedBy: 'post-action-replay-guard-matrix',
    approved: true,
    approvedBy: 'post-action-replay-guard-matrix',
    createdAt: FIXED_CREATED_AT,
    expiresAt: '2099-01-01T00:00:00.000Z',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-replay-guard-matrix' }],
  });
}

function rowForRecord({ record, aggregateArchive, blockedArchive }) {
  const newCandidate = replayDecision({
    archive: aggregateArchive,
    candidate: candidateFromRecord(record, { newIdentity: true }),
    actor: 'post-action-replay-guard-matrix.new-candidate',
  });
  const archivedTaskAction = replayDecision({
    archive: aggregateArchive,
    candidate: candidateFromRecord(record),
    actor: 'post-action-replay-guard-matrix.archived-task-action',
  });
  const repeatMissingApproval = replayDecision({
    archive: aggregateArchive,
    candidate: candidateFromRecord(record),
    allowRepeat: true,
    actor: 'post-action-replay-guard-matrix.repeat-missing-approval',
  });
  const repeatCandidate = candidateFromRecord(record, { freshnessAnchors: 'fresh' });
  const repeatMissingFreshnessCandidate = candidateFromRecord(record);
  const repeatStaleFreshnessCandidate = candidateFromRecord(record, { freshnessAnchors: 'archived' });
  const exactReplayCandidate = candidateFromRecord(record, { includeHashes: true });
  const repeatApproved = replayDecision({
    archive: aggregateArchive,
    candidate: repeatCandidate,
    allowRepeat: true,
    repeatApproval: repeatApprovalForCandidate(repeatCandidate, token(record.row.scenarioId)),
    actor: 'post-action-replay-guard-matrix.repeat-approved',
  });
  const repeatApprovedMissingFreshness = replayDecision({
    archive: aggregateArchive,
    candidate: repeatMissingFreshnessCandidate,
    allowRepeat: true,
    repeatApproval: repeatApprovalForCandidate(repeatMissingFreshnessCandidate, `missing-freshness-${token(record.row.scenarioId)}`),
    actor: 'post-action-replay-guard-matrix.repeat-approved-missing-freshness',
  });
  const repeatApprovedStaleFreshness = replayDecision({
    archive: aggregateArchive,
    candidate: repeatStaleFreshnessCandidate,
    allowRepeat: true,
    repeatApproval: repeatApprovalForCandidate(repeatStaleFreshnessCandidate, `stale-freshness-${token(record.row.scenarioId)}`),
    actor: 'post-action-replay-guard-matrix.repeat-approved-stale-freshness',
  });
  const exactReplay = replayDecision({
    archive: aggregateArchive,
    candidate: exactReplayCandidate,
    allowRepeat: true,
    repeatApproval: repeatApprovalForCandidate(exactReplayCandidate, `exact-${token(record.row.scenarioId)}`),
    actor: 'post-action-replay-guard-matrix.exact-replay',
  });
  const blockedArchiveDecision = replayDecision({
    archive: blockedArchive,
    candidate: candidateFromRecord(record, { newIdentity: true }),
    actor: 'post-action-replay-guard-matrix.blocked-archive',
  });
  const strippedPayloadMessageHashReplay = replayDecision({
    archive: aggregateArchive,
    candidate: candidateFromRecord(strippedAuditBundlePayloadRecord(record, 'messagePreviewHash'), { newIdentity: true }),
    actor: 'post-action-replay-guard-matrix.stripped-payload-message-hash',
  });
  const strippedPayloadContractHashReplay = replayDecision({
    archive: aggregateArchive,
    candidate: candidateFromRecord(strippedAuditBundlePayloadRecord(record, 'humanFeedbackRevisionContractHash'), { newIdentity: true }),
    actor: 'post-action-replay-guard-matrix.stripped-payload-contract-hash',
  });
  const strippedPayloadPromptBindingReplay = replayDecision({
    archive: aggregateArchive,
    candidate: candidateFromRecord(strippedAuditBundlePayloadRecord(record, 'promptGenerationBinding'), { newIdentity: true }),
    actor: 'post-action-replay-guard-matrix.stripped-payload-prompt-binding',
  });

  const blockers = [];
  const isCustomerMessage = customerMessageAction(record.row.action);
  const isHumanFeedbackMessage = Boolean(record.row.humanFeedbackRevisionContractHash);
  const isPromptGenerationSpend = promptGenerationSpendAction(record.row.action);
  if (newCandidate.status !== 'clear_for_new_handoff' || newCandidate.clear !== true) {
    blockers.push(issue('new_candidate_not_clear', record.row.scenarioId));
  }
  if (archivedTaskAction.status !== 'blocked_replay_guard') {
    blockers.push(issue('archived_task_action_not_blocked', record.row.scenarioId));
  }
  if (!archivedTaskAction.blockers.some((item) => item.code === 'task_action_already_archived')) {
    blockers.push(issue('archived_task_action_blocker_missing', record.row.scenarioId));
  }
  if (repeatMissingApproval.status !== 'blocked_replay_guard') {
    blockers.push(issue('repeat_missing_approval_not_blocked', record.row.scenarioId));
  }
  if (!repeatMissingApproval.blockers.some((item) => item.code === 'repeat_approval_required')) {
    blockers.push(issue('repeat_approval_required_blocker_missing', record.row.scenarioId));
  }
  if (repeatApproved.status !== 'clear_for_new_handoff' || repeatApproved.clear !== true) {
    blockers.push(issue('repeat_approved_not_clear', record.row.scenarioId));
  }
  if (!repeatApproved.warnings.some((item) => item.code === 'repeat_task_action_explicitly_allowed')) {
    blockers.push(issue('repeat_approved_warning_missing', record.row.scenarioId));
  }
  if (repeatApprovedMissingFreshness.status !== 'blocked_replay_guard') {
    blockers.push(issue('repeat_approved_missing_freshness_not_blocked', record.row.scenarioId));
  }
  for (const code of ['repeat_candidate_platform_state_snapshot_hash_required', 'repeat_candidate_dry_run_replay_hash_required']) {
    if (!repeatApprovedMissingFreshness.blockers.some((item) => item.code === code)) {
      blockers.push(issue('repeat_approved_missing_freshness_blocker_missing', `${record.row.scenarioId}:${code}`));
    }
  }
  if (repeatApprovedStaleFreshness.status !== 'blocked_replay_guard') {
    blockers.push(issue('repeat_approved_stale_freshness_not_blocked', record.row.scenarioId));
  }
  for (const code of ['repeat_candidate_platform_state_snapshot_hash_stale', 'repeat_candidate_dry_run_replay_hash_stale']) {
    if (!repeatApprovedStaleFreshness.blockers.some((item) => item.code === code)) {
      blockers.push(issue('repeat_approved_stale_freshness_blocker_missing', `${record.row.scenarioId}:${code}`));
    }
  }
  if (exactReplay.status !== 'blocked_replay_guard') {
    blockers.push(issue('exact_replay_not_blocked', record.row.scenarioId));
  }
  if (!exactReplay.blockers.some((item) => item.code === 'bundle_hash_already_archived')) {
    blockers.push(issue('exact_bundle_replay_blocker_missing', record.row.scenarioId));
  }
  if (!exactReplay.blockers.some((item) => item.code === 'ledger_hash_already_archived')) {
    blockers.push(issue('exact_ledger_replay_blocker_missing', record.row.scenarioId));
  }
  if (blockedArchiveDecision.status !== 'blocked_replay_guard') {
    blockers.push(issue('blocked_archive_decision_not_blocked', record.row.scenarioId));
  }
  if (!blockedArchiveDecision.blockers.some((item) => item.code === 'audit_archive_not_ready')) {
    blockers.push(issue('blocked_archive_not_ready_blocker_missing', record.row.scenarioId));
  }
  if (isCustomerMessage) {
    if (strippedPayloadMessageHashReplay.candidate?.messagePreviewHash !== null) {
      blockers.push(issue('stripped_payload_message_hash_candidate_fallback', record.row.scenarioId));
    }
    if (
      strippedPayloadMessageHashReplay.status !== 'blocked_replay_guard'
      || !strippedPayloadMessageHashReplay.blockers.some((item) => item.code === 'candidate_message_preview_hash_required')
    ) {
      blockers.push(issue('stripped_payload_message_hash_replay_not_blocked', record.row.scenarioId));
    }
  }
  if (isHumanFeedbackMessage) {
    if (strippedPayloadContractHashReplay.candidate?.humanFeedbackRevisionContractHash !== null) {
      blockers.push(issue('stripped_payload_human_feedback_contract_candidate_fallback', record.row.scenarioId));
    }
    if (
      strippedPayloadContractHashReplay.status !== 'blocked_replay_guard'
      || !strippedPayloadContractHashReplay.blockers.some((item) => item.code === 'candidate_human_feedback_contract_hash_required')
    ) {
      blockers.push(issue('stripped_payload_human_feedback_contract_replay_not_blocked', record.row.scenarioId));
    }
  }
  if (isPromptGenerationSpend) {
    if (strippedPayloadPromptBindingReplay.candidate?.promptGenerationBinding !== null) {
      blockers.push(issue('stripped_payload_prompt_binding_candidate_fallback', record.row.scenarioId));
    }
    if (
      strippedPayloadPromptBindingReplay.status !== 'blocked_replay_guard'
      || !strippedPayloadPromptBindingReplay.blockers.some((item) => item.code === 'candidate_prompt_generation_binding_required')
    ) {
      blockers.push(issue('stripped_payload_prompt_binding_replay_not_blocked', record.row.scenarioId));
    }
  }

  return {
    scenarioId: record.row.scenarioId,
    channelId: record.row.channelId,
    actionId: record.row.actionId,
    action: canonicalActionOrNull(record.row.action),
    packageRole: repeatCandidate.packageRole,
    humanFeedbackRevisionContractHash: repeatCandidate.humanFeedbackRevisionContractHash,
    newCandidateStatus: newCandidate.status,
    archivedTaskActionStatus: archivedTaskAction.status,
    archivedTaskActionBlockers: blockerCodes(archivedTaskAction),
    repeatMissingApprovalStatus: repeatMissingApproval.status,
    repeatMissingApprovalBlockers: blockerCodes(repeatMissingApproval),
    repeatApprovedStatus: repeatApproved.status,
    repeatApprovedWarnings: warningCodes(repeatApproved),
    repeatApprovedMissingFreshnessStatus: repeatApprovedMissingFreshness.status,
    repeatApprovedMissingFreshnessBlockers: blockerCodes(repeatApprovedMissingFreshness),
    repeatApprovedStaleFreshnessStatus: repeatApprovedStaleFreshness.status,
    repeatApprovedStaleFreshnessBlockers: blockerCodes(repeatApprovedStaleFreshness),
    exactReplayStatus: exactReplay.status,
    exactReplayBlockers: blockerCodes(exactReplay),
    blockedArchiveStatus: blockedArchiveDecision.status,
    blockedArchiveBlockers: blockerCodes(blockedArchiveDecision),
    strippedPayloadMessageHashReplayStatus: strippedPayloadMessageHashReplay.status,
    strippedPayloadMessageHashReplayBlockers: blockerCodes(strippedPayloadMessageHashReplay),
    strippedPayloadMessageHashReplayCandidateNull: isCustomerMessage
      && strippedPayloadMessageHashReplay.candidate?.messagePreviewHash === null,
    strippedPayloadContractHashReplayStatus: strippedPayloadContractHashReplay.status,
    strippedPayloadContractHashReplayBlockers: blockerCodes(strippedPayloadContractHashReplay),
    strippedPayloadContractHashReplayCandidateNull: isHumanFeedbackMessage
      && strippedPayloadContractHashReplay.candidate?.humanFeedbackRevisionContractHash === null,
    strippedPayloadPromptBindingReplayStatus: strippedPayloadPromptBindingReplay.status,
    strippedPayloadPromptBindingReplayBlockers: blockerCodes(strippedPayloadPromptBindingReplay),
    strippedPayloadPromptBindingReplayCandidateNull: isPromptGenerationSpend
      && strippedPayloadPromptBindingReplay.candidate?.promptGenerationBinding === null,
    matchedEntries: archivedTaskAction.matchedEntries.length,
    blockers,
  };
}

export function buildPostActionReplayGuardMatrixReport({ generatedAt = new Date().toISOString() } = {}) {
  const {
    runtimeReport,
    postActionEvidenceMatrix,
    records,
  } = buildPostActionAuditBundleMatrixRecords();
  const postActionAuditArchiveMatrix = buildPostActionAuditArchiveMatrixReport({ generatedAt: FIXED_CREATED_AT });
  const aggregateArchive = archiveForBundles({
    bundles: records.map((record) => record.auditBundle),
    archiveRole: 'post_action_replay_guard_all_routes_archive',
    actor: 'post-action-replay-guard-matrix.aggregate-archive',
  });
  const blockedArchive = archiveForBundles({
    bundles: records.length ? [records[0].rawLedgerBundle] : [],
    archiveRole: 'post_action_replay_guard_blocked_archive_probe',
    actor: 'post-action-replay-guard-matrix.blocked-archive-probe',
  });
  const rows = records.map((record) => rowForRecord({ record, aggregateArchive, blockedArchive }));
  const blockers = [
    ...(runtimeReport.ok === true ? [] : [issue('runtime_dry_run_harness_not_ready')]),
    ...(postActionEvidenceMatrix.ok === true ? [] : [issue('post_action_evidence_matrix_not_ready')]),
    ...(postActionAuditArchiveMatrix.ok === true ? [] : [issue('post_action_audit_archive_matrix_not_ready')]),
    ...rows.flatMap((row) => row.blockers),
  ];
  if (aggregateArchive.status !== 'ready_external_action_audit_archive') {
    blockers.push(issue('aggregate_archive_not_ready'));
  }
  if (blockedArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('blocked_archive_probe_not_blocked'));
  }

  const actionClasses = uniqueStrings(rows.map((row) => row.action), 32);
  const summary = {
    routeCount: rows.length,
    actionClassCount: actionClasses.length,
    actionClasses,
    aggregateArchiveHash: aggregateArchive.archiveHash,
    aggregateArchiveEntries: aggregateArchive.summary.count,
    newCandidateClearCount: rows.filter((row) => row.newCandidateStatus === 'clear_for_new_handoff').length,
    archivedTaskActionBlockedCount: rows.filter((row) => row.archivedTaskActionStatus === 'blocked_replay_guard').length,
    repeatMissingApprovalBlockedCount: rows.filter((row) => row.repeatMissingApprovalStatus === 'blocked_replay_guard').length,
    repeatApprovedClearCount: rows.filter((row) => row.repeatApprovedStatus === 'clear_for_new_handoff').length,
    repeatApprovedMissingFreshnessBlockedCount: rows.filter((row) => row.repeatApprovedMissingFreshnessStatus === 'blocked_replay_guard').length,
    repeatApprovedStaleFreshnessBlockedCount: rows.filter((row) => row.repeatApprovedStaleFreshnessStatus === 'blocked_replay_guard').length,
    exactReplayBlockedCount: rows.filter((row) => row.exactReplayStatus === 'blocked_replay_guard').length,
    blockedArchiveDecisionBlockedCount: rows.filter((row) => row.blockedArchiveStatus === 'blocked_replay_guard').length,
    taskActionReplayBlockedCount: rows.filter((row) => row.archivedTaskActionBlockers.includes('task_action_already_archived')).length,
    repeatApprovalRequiredBlockedCount: rows.filter((row) => row.repeatMissingApprovalBlockers.includes('repeat_approval_required')).length,
    repeatApprovedWarningCount: rows.filter((row) => row.repeatApprovedWarnings.includes('repeat_task_action_explicitly_allowed')).length,
    repeatFreshnessRequiredBlockedCount: rows.filter((row) => (
      row.repeatApprovedMissingFreshnessBlockers.includes('repeat_candidate_platform_state_snapshot_hash_required')
        && row.repeatApprovedMissingFreshnessBlockers.includes('repeat_candidate_dry_run_replay_hash_required')
    )).length,
    repeatStaleFreshnessBlockedCount: rows.filter((row) => (
      row.repeatApprovedStaleFreshnessBlockers.includes('repeat_candidate_platform_state_snapshot_hash_stale')
        && row.repeatApprovedStaleFreshnessBlockers.includes('repeat_candidate_dry_run_replay_hash_stale')
    )).length,
    exactBundleReplayBlockedCount: rows.filter((row) => row.exactReplayBlockers.includes('bundle_hash_already_archived')).length,
    exactLedgerReplayBlockedCount: rows.filter((row) => row.exactReplayBlockers.includes('ledger_hash_already_archived')).length,
    blockedArchiveNotReadyBlockedCount: rows.filter((row) => row.blockedArchiveBlockers.includes('audit_archive_not_ready')).length,
    strippedPayloadMessageHashReplayCandidateNullCount: rows.filter((row) => row.strippedPayloadMessageHashReplayCandidateNull).length,
    strippedPayloadMessageHashReplayBlockedCount: rows.filter((row) => row.strippedPayloadMessageHashReplayBlockers.includes('candidate_message_preview_hash_required')).length,
    strippedPayloadContractHashReplayCandidateNullCount: rows.filter((row) => row.strippedPayloadContractHashReplayCandidateNull).length,
    strippedPayloadContractHashReplayBlockedCount: rows.filter((row) => row.strippedPayloadContractHashReplayBlockers.includes('candidate_human_feedback_contract_hash_required')).length,
    strippedPayloadPromptBindingReplayCandidateNullCount: rows.filter((row) => row.strippedPayloadPromptBindingReplayCandidateNull).length,
    strippedPayloadPromptBindingReplayBlockedCount: rows.filter((row) => row.strippedPayloadPromptBindingReplayBlockers.includes('candidate_prompt_generation_binding_required')).length,
    matchedEntryRows: rows.filter((row) => row.matchedEntries > 0).length,
    packageRoleRouteCount: rows.filter((row) => row.packageRole).length,
    humanFeedbackPackageRoleBoundRouteCount: rows.filter((row) => (
      row.humanFeedbackRevisionContractHash && row.packageRole
    )).length,
    routeBlockerCount: rows.reduce((sum, row) => sum + row.blockers.length, 0),
  };
  if (summary.routeCount !== 20) blockers.push(issue('post_action_replay_guard_matrix_route_count_unexpected', `${summary.routeCount}/20`));
  if (summary.actionClassCount !== 7) blockers.push(issue('post_action_replay_guard_matrix_action_class_count_unexpected', `${summary.actionClassCount}/7`));
  if (summary.packageRoleRouteCount !== rows.length) blockers.push(issue('post_action_replay_guard_package_role_not_bound', `${summary.packageRoleRouteCount}/${rows.length}`));
  const humanFeedbackRows = rows.filter((row) => row.humanFeedbackRevisionContractHash);
  const customerMessageRows = rows.filter((row) => customerMessageAction(row.action));
  const promptGenerationSpendRows = rows.filter((row) => promptGenerationSpendAction(row.action));
  if (summary.strippedPayloadMessageHashReplayCandidateNullCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_replay_guard_stripped_payload_message_hash_candidate_fallback',
    `${summary.strippedPayloadMessageHashReplayCandidateNullCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadMessageHashReplayBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_replay_guard_stripped_payload_message_hash_replay_not_blocked',
    `${summary.strippedPayloadMessageHashReplayBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadContractHashReplayCandidateNullCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_replay_guard_stripped_payload_human_feedback_contract_candidate_fallback',
    `${summary.strippedPayloadContractHashReplayCandidateNullCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadContractHashReplayBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_replay_guard_stripped_payload_human_feedback_contract_replay_not_blocked',
    `${summary.strippedPayloadContractHashReplayBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingReplayCandidateNullCount !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_replay_guard_stripped_payload_prompt_binding_candidate_fallback',
    `${summary.strippedPayloadPromptBindingReplayCandidateNullCount}/${promptGenerationSpendRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingReplayBlockedCount !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_replay_guard_stripped_payload_prompt_binding_replay_not_blocked',
    `${summary.strippedPayloadPromptBindingReplayBlockedCount}/${promptGenerationSpendRows.length}`,
  ));
  if (summary.humanFeedbackPackageRoleBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_replay_guard_human_feedback_package_role_not_bound',
    `${summary.humanFeedbackPackageRoleBoundRouteCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.repeatApprovedMissingFreshnessBlockedCount !== rows.length) blockers.push(issue(
    'post_action_replay_guard_repeat_missing_freshness_not_blocked',
    `${summary.repeatApprovedMissingFreshnessBlockedCount}/${rows.length}`,
  ));
  if (summary.repeatApprovedStaleFreshnessBlockedCount !== rows.length) blockers.push(issue(
    'post_action_replay_guard_repeat_stale_freshness_not_blocked',
    `${summary.repeatApprovedStaleFreshnessBlockedCount}/${rows.length}`,
  ));
  if (summary.repeatFreshnessRequiredBlockedCount !== rows.length) blockers.push(issue(
    'post_action_replay_guard_repeat_freshness_required_blocker_missing',
    `${summary.repeatFreshnessRequiredBlockedCount}/${rows.length}`,
  ));
  if (summary.repeatStaleFreshnessBlockedCount !== rows.length) blockers.push(issue(
    'post_action_replay_guard_repeat_stale_freshness_blocker_missing',
    `${summary.repeatStaleFreshnessBlockedCount}/${rows.length}`,
  ));

  const status = blockers.length
    ? POST_ACTION_REPLAY_GUARD_MATRIX_STATUS.FAIL
    : POST_ACTION_REPLAY_GUARD_MATRIX_STATUS.PASS;
  const replayGuardMatrixHash = digest({
    version: POST_ACTION_REPLAY_GUARD_MATRIX_VERSION,
    status,
    summary,
    rows: rows.map((row) => ({
      scenarioId: row.scenarioId,
      channelId: row.channelId,
      actionId: row.actionId,
      action: row.action,
      packageRole: row.packageRole,
      humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
      newCandidateStatus: row.newCandidateStatus,
      archivedTaskActionStatus: row.archivedTaskActionStatus,
      archivedTaskActionBlockers: row.archivedTaskActionBlockers,
      repeatMissingApprovalStatus: row.repeatMissingApprovalStatus,
      repeatMissingApprovalBlockers: row.repeatMissingApprovalBlockers,
      repeatApprovedStatus: row.repeatApprovedStatus,
      repeatApprovedWarnings: row.repeatApprovedWarnings,
      repeatApprovedMissingFreshnessStatus: row.repeatApprovedMissingFreshnessStatus,
      repeatApprovedMissingFreshnessBlockers: row.repeatApprovedMissingFreshnessBlockers,
      repeatApprovedStaleFreshnessStatus: row.repeatApprovedStaleFreshnessStatus,
      repeatApprovedStaleFreshnessBlockers: row.repeatApprovedStaleFreshnessBlockers,
      exactReplayStatus: row.exactReplayStatus,
      exactReplayBlockers: row.exactReplayBlockers,
      blockedArchiveStatus: row.blockedArchiveStatus,
      blockedArchiveBlockers: row.blockedArchiveBlockers,
      strippedPayloadMessageHashReplayStatus: row.strippedPayloadMessageHashReplayStatus,
      strippedPayloadMessageHashReplayBlockers: row.strippedPayloadMessageHashReplayBlockers,
      strippedPayloadMessageHashReplayCandidateNull: row.strippedPayloadMessageHashReplayCandidateNull,
      strippedPayloadContractHashReplayStatus: row.strippedPayloadContractHashReplayStatus,
      strippedPayloadContractHashReplayBlockers: row.strippedPayloadContractHashReplayBlockers,
      strippedPayloadContractHashReplayCandidateNull: row.strippedPayloadContractHashReplayCandidateNull,
      strippedPayloadPromptBindingReplayStatus: row.strippedPayloadPromptBindingReplayStatus,
      strippedPayloadPromptBindingReplayBlockers: row.strippedPayloadPromptBindingReplayBlockers,
      strippedPayloadPromptBindingReplayCandidateNull: row.strippedPayloadPromptBindingReplayCandidateNull,
      blockerCodes: row.blockers.map((item) => item.code),
    })),
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionAuditArchiveMatrixHash: postActionAuditArchiveMatrix.postActionAuditArchiveMatrixHash,
    blockers,
  });

  return {
    version: POST_ACTION_REPLAY_GUARD_MATRIX_VERSION,
    kind: 'PostActionReplayGuardMatrixReport',
    status,
    ok: blockers.length === 0,
    generatedAt,
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionAuditArchiveMatrixHash: postActionAuditArchiveMatrix.postActionAuditArchiveMatrixHash,
    aggregateArchiveHash: aggregateArchive.archiveHash,
    blockedArchiveHash: blockedArchive.archiveHash,
    summary,
    rows,
    blockers,
    safety: {
      syntheticFixturesOnly: true,
      replayGuardOnly: true,
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
      mutatesReplayState: false,
      grantsExecutionPermission: false,
    },
    postActionReplayGuardMatrixHash: replayGuardMatrixHash,
    hash: replayGuardMatrixHash,
  };
}
