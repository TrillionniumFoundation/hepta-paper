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
import { buildAdapterDispatchEnvelope } from './adapter-dispatch-envelope.mjs';
import { buildAdapterHandoffOutboxItem } from './adapter-handoff-outbox.mjs';
import { buildExternalActionAuditArchive } from './external-action-audit-archive.mjs';
import { buildExternalActionReplayGuardDecision } from './external-action-replay-guard.mjs';
import { buildPostActionAuditArchiveMatrixReport } from './post-action-audit-archive-matrix.mjs';
import { buildPostActionAuditBundleMatrixRecords } from './post-action-audit-bundle-matrix.mjs';
import { buildPostActionReplayGuardMatrixReport } from './post-action-replay-guard-matrix.mjs';
import { digest } from './hash-utils.mjs';

export const POST_ACTION_DISPATCH_ENVELOPE_MATRIX_VERSION = 1;

export const POST_ACTION_DISPATCH_ENVELOPE_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_post_action_dispatch_envelope_matrix',
  FAIL: 'fail_post_action_dispatch_envelope_matrix',
});

const FIXED_CREATED_AT = '2026-06-08T09:20:00.000Z';

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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function blockerCodes(record) {
  return uniqueStrings((record?.blockers || []).map((item) => item.code), 32);
}

function archiveForRecords(records) {
  return buildExternalActionAuditArchive({
    bundles: records.map((record) => record.auditBundle),
    archiveRole: 'post_action_dispatch_envelope_matrix_archive',
    actor: 'post-action-dispatch-envelope-matrix.archive',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-envelope-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function dispatchOutboxForRecord(record) {
  return buildAdapterHandoffOutboxItem({
    manifest: record.manifest,
    preview: record.preview,
    requestedBy: 'post-action-dispatch-envelope-matrix.outbox',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-envelope-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function freshnessAnchorsForRow(row, mode) {
  if (mode !== 'fresh') return {};
  return {
    platformStateSnapshotHash: digest({
      kind: 'post-action-dispatch-envelope-matrix',
      scenarioId: row.scenarioId,
      freshness: 'fresh-platform-state-snapshot',
    }),
    dryRunReplayHash: digest({
      kind: 'post-action-dispatch-envelope-matrix',
      scenarioId: row.scenarioId,
      freshness: 'fresh-dry-run-replay',
    }),
  };
}

function candidateForOutbox(outboxItem, row, { mismatch = false, freshnessAnchors = null } = {}) {
  const suffix = token(row.scenarioId);
  return {
    kind: 'ReplayGuardCandidate',
    channelId: outboxItem.channelId,
    actionId: outboxItem.actionId,
    action: canonicalActionOrNull(outboxItem.action),
    taskKey: mismatch ? `${outboxItem.payload?.taskKey || row.scenarioId}::mismatch-${suffix}` : outboxItem.payload?.taskKey,
    externalId: mismatch ? `${outboxItem.payload?.externalId || row.scenarioId}::mismatch-${suffix}` : outboxItem.payload?.externalId,
    productLineId: canonicalProductLineOrNull(outboxItem.payload?.productLineId),
    workflowId: canonicalProductLineOrNull(outboxItem.payload?.workflowId),
    packageRole: canonicalPackageRole(outboxItem.payload?.packageRole || '') || null,
    messagePreview: outboxItem.payload?.messagePreview || null,
    messagePreviewHash: outboxItem.payload?.messagePreviewHash || null,
    humanFeedbackRevisionContractHash: outboxItem.payload?.humanFeedbackRevisionContractHash || null,
    promptGenerationBinding: outboxItem.payload?.promptGenerationBinding || null,
    ...freshnessAnchorsForRow(row, freshnessAnchors),
    outboxHash: outboxItem.outboxHash || null,
  };
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
    reason: `post-action dispatch repeat approval ${suffix}`,
    requestedBy: 'post-action-dispatch-envelope-matrix',
    approved: true,
    approvedBy: 'post-action-dispatch-envelope-matrix',
    createdAt: FIXED_CREATED_AT,
    expiresAt: '2099-01-01T00:00:00.000Z',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-envelope-matrix' }],
  });
}

function replayDecision({
  archive,
  record,
  outboxItem = null,
  allowRepeat = false,
  repeatApproval = null,
  mismatch = false,
  freshnessAnchors = null,
  actor,
}) {
  return buildExternalActionReplayGuardDecision({
    archive,
    candidate: candidateForOutbox(outboxItem || dispatchOutboxForRecord(record), record.row, { mismatch, freshnessAnchors }),
    allowRepeat,
    repeatApproval,
    actor,
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-envelope-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function envelopeFor({
  outboxItem,
  replayGuardDecision,
  actor = 'post-action-dispatch-envelope-matrix.envelope',
}) {
  return buildAdapterDispatchEnvelope({
    outboxItem,
    replayGuardDecision,
    requestedBy: actor,
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-dispatch-envelope-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function tamperedOutbox(outboxItem) {
  return {
    ...cloneJson(outboxItem),
    outboxHash: 'sha256:tampered-post-action-dispatch-envelope-outbox',
    hash: 'sha256:tampered-post-action-dispatch-envelope-outbox',
  };
}

function strippedOutboxAlias(outboxItem) {
  const stripped = cloneJson(outboxItem);
  delete stripped.outboxHash;
  return stripped;
}

function strippedOutboxPayloadField(outboxItem, fieldName) {
  const stripped = cloneJson(outboxItem);
  if (stripped.payload) delete stripped.payload[fieldName];
  return stripped;
}

function isPromptGenerationSpendAction(action) {
  const canonicalAction = canonicalActionOrNull(action);
  return canonicalAction === EXTERNAL_ACTIONS.PROVIDER_SPEND
    || canonicalAction === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function dispatchRecordForAuditBundleRecord({ record, archive, mismatchRecord }) {
  const outboxItem = dispatchOutboxForRecord(record);
  const mismatchOutboxItem = dispatchOutboxForRecord(mismatchRecord);
  const repeatCandidate = candidateForOutbox(outboxItem, record.row, { freshnessAnchors: 'fresh' });
  const mismatchCandidate = candidateForOutbox(mismatchOutboxItem, mismatchRecord.row, { freshnessAnchors: 'fresh' });
  const repeatApproval = repeatApprovalForCandidate(repeatCandidate, token(record.row.scenarioId));
  const repeatApproved = replayDecision({
    archive,
    record,
    outboxItem,
    allowRepeat: true,
    repeatApproval,
    freshnessAnchors: 'fresh',
    actor: 'post-action-dispatch-envelope-matrix.repeat-approved',
  });
  const blockedReplay = replayDecision({
    archive,
    record,
    outboxItem,
    actor: 'post-action-dispatch-envelope-matrix.blocked-replay',
  });
  const mismatchReplay = replayDecision({
    archive,
    record: mismatchRecord,
    outboxItem: mismatchOutboxItem,
    allowRepeat: true,
    repeatApproval: repeatApprovalForCandidate(mismatchCandidate, `mismatch-${token(record.row.scenarioId)}`),
    mismatch: true,
    freshnessAnchors: 'fresh',
    actor: 'post-action-dispatch-envelope-matrix.mismatch-replay',
  });

  const readyEnvelope = envelopeFor({
    outboxItem,
    replayGuardDecision: repeatApproved,
    actor: 'post-action-dispatch-envelope-matrix.ready',
  });
  const blockedReplayEnvelope = envelopeFor({
    outboxItem,
    replayGuardDecision: blockedReplay,
    actor: 'post-action-dispatch-envelope-matrix.blocked-replay-envelope',
  });
  const mismatchEnvelope = envelopeFor({
    outboxItem,
    replayGuardDecision: mismatchReplay,
    actor: 'post-action-dispatch-envelope-matrix.mismatch-envelope',
  });
  const tamperedOutboxEnvelope = envelopeFor({
    outboxItem: tamperedOutbox(outboxItem),
    replayGuardDecision: repeatApproved,
    actor: 'post-action-dispatch-envelope-matrix.tampered-outbox-envelope',
  });
  const strippedOutboxAliasItem = strippedOutboxAlias(outboxItem);
  const strippedOutboxAliasReplay = replayDecision({
    archive,
    record,
    outboxItem: strippedOutboxAliasItem,
    allowRepeat: true,
    repeatApproval,
    freshnessAnchors: 'fresh',
    actor: 'post-action-dispatch-envelope-matrix.stripped-outbox-alias-replay',
  });
  const strippedOutboxAliasEnvelope = envelopeFor({
    outboxItem: strippedOutboxAliasItem,
    replayGuardDecision: strippedOutboxAliasReplay,
    actor: 'post-action-dispatch-envelope-matrix.stripped-outbox-alias-envelope',
  });
  const strippedPayloadMessageHashReplay = outboxItem.payload?.messagePreviewHash
    ? replayDecision({
      archive,
      record,
      outboxItem: strippedOutboxPayloadField(outboxItem, 'messagePreviewHash'),
      allowRepeat: true,
      repeatApproval,
      freshnessAnchors: 'fresh',
      actor: 'post-action-dispatch-envelope-matrix.stripped-payload-message-hash-replay',
    })
    : null;
  const strippedPayloadContractHashReplay = outboxItem.payload?.humanFeedbackRevisionContractHash
    ? replayDecision({
      archive,
      record,
      outboxItem: strippedOutboxPayloadField(outboxItem, 'humanFeedbackRevisionContractHash'),
      allowRepeat: true,
      repeatApproval,
      freshnessAnchors: 'fresh',
      actor: 'post-action-dispatch-envelope-matrix.stripped-payload-contract-hash-replay',
    })
    : null;
  const strippedPayloadPromptBindingReplay = isPromptGenerationSpendAction(outboxItem.action)
    ? replayDecision({
      archive,
      record,
      outboxItem: strippedOutboxPayloadField(outboxItem, 'promptGenerationBinding'),
      allowRepeat: true,
      repeatApproval,
      freshnessAnchors: 'fresh',
      actor: 'post-action-dispatch-envelope-matrix.stripped-payload-prompt-binding-replay',
    })
    : null;
  const missingReplayGuardEnvelope = envelopeFor({
    outboxItem,
    replayGuardDecision: null,
    actor: 'post-action-dispatch-envelope-matrix.missing-replay-guard-envelope',
  });

  const blockers = [];
  if (readyEnvelope.status !== 'ready_adapter_dispatch_envelope' || readyEnvelope.readyForExternalRunner !== true) {
    blockers.push(issue('repeat_approved_dispatch_envelope_not_ready', record.row.scenarioId));
  }
  if (!readyEnvelope.runner.requiredHashes.outboxHash || !readyEnvelope.runner.requiredHashes.replayGuardHash || !readyEnvelope.runner.requiredHashes.archiveHash) {
    blockers.push(issue('ready_dispatch_envelope_hash_binding_incomplete', record.row.scenarioId));
  }
  if (readyEnvelope.safety.readyForExecution === true || readyEnvelope.safety.executesExternalAction === true) {
    blockers.push(issue('ready_dispatch_envelope_claims_execution', record.row.scenarioId));
  }
  if (blockedReplayEnvelope.status !== 'blocked_adapter_dispatch_envelope') {
    blockers.push(issue('blocked_replay_envelope_not_blocked', record.row.scenarioId));
  }
  if (!blockedReplayEnvelope.blockers.some((item) => item.code === 'replay_guard_not_clear')) {
    blockers.push(issue('blocked_replay_guard_blocker_missing', record.row.scenarioId));
  }
  if (mismatchEnvelope.status !== 'blocked_adapter_dispatch_envelope') {
    blockers.push(issue('mismatch_envelope_not_blocked', record.row.scenarioId));
  }
  if (!mismatchEnvelope.blockers.some((item) => item.code === 'replay_guard_candidate_mismatch')) {
    blockers.push(issue('mismatch_candidate_blocker_missing', record.row.scenarioId));
  }
  if (tamperedOutboxEnvelope.status !== 'blocked_adapter_dispatch_envelope') {
    blockers.push(issue('tampered_outbox_envelope_not_blocked', record.row.scenarioId));
  }
  if (!tamperedOutboxEnvelope.blockers.some((item) => item.code === 'outbox_hash_content_mismatch')) {
    blockers.push(issue('tampered_outbox_hash_blocker_missing', record.row.scenarioId));
  }
  if (strippedOutboxAliasReplay.candidate?.outboxHash !== null) {
    blockers.push(issue('stripped_outbox_alias_candidate_used_generic_hash', record.row.scenarioId));
  }
  if (strippedOutboxAliasEnvelope.status !== 'blocked_adapter_dispatch_envelope') {
    blockers.push(issue('stripped_outbox_alias_envelope_not_blocked', record.row.scenarioId));
  }
  if (!strippedOutboxAliasEnvelope.blockers.some((item) => item.code === 'outbox_hash_alias_required')) {
    blockers.push(issue('stripped_outbox_alias_blocker_missing', record.row.scenarioId));
  }
  if (strippedPayloadMessageHashReplay && strippedPayloadMessageHashReplay.status !== 'blocked_replay_guard') {
    blockers.push(issue('stripped_payload_message_hash_replay_not_blocked', record.row.scenarioId));
  }
  if (strippedPayloadMessageHashReplay && !strippedPayloadMessageHashReplay.blockers.some((item) => item.code === 'candidate_message_preview_hash_required')) {
    blockers.push(issue('stripped_payload_message_hash_blocker_missing', record.row.scenarioId));
  }
  if (strippedPayloadContractHashReplay && strippedPayloadContractHashReplay.status !== 'blocked_replay_guard') {
    blockers.push(issue('stripped_payload_contract_hash_replay_not_blocked', record.row.scenarioId));
  }
  if (strippedPayloadContractHashReplay && !strippedPayloadContractHashReplay.blockers.some((item) => item.code === 'candidate_human_feedback_contract_hash_required')) {
    blockers.push(issue('stripped_payload_contract_hash_blocker_missing', record.row.scenarioId));
  }
  if (strippedPayloadPromptBindingReplay && strippedPayloadPromptBindingReplay.status !== 'blocked_replay_guard') {
    blockers.push(issue('stripped_payload_prompt_binding_replay_not_blocked', record.row.scenarioId));
  }
  if (strippedPayloadPromptBindingReplay && !strippedPayloadPromptBindingReplay.blockers.some((item) => item.code === 'candidate_prompt_generation_binding_required')) {
    blockers.push(issue('stripped_payload_prompt_binding_blocker_missing', record.row.scenarioId));
  }
  if (missingReplayGuardEnvelope.status !== 'blocked_adapter_dispatch_envelope') {
    blockers.push(issue('missing_replay_guard_envelope_not_blocked', record.row.scenarioId));
  }
  if (!missingReplayGuardEnvelope.blockers.some((item) => item.code === 'replay_guard_required')) {
    blockers.push(issue('missing_replay_guard_blocker_missing', record.row.scenarioId));
  }

  return {
    scenario: record.scenario,
    scenarioId: record.row.scenarioId,
    channelId: record.row.channelId,
    actionId: record.row.actionId,
    action: canonicalActionOrNull(record.row.action),
    packageRole: canonicalPackageRole(readyEnvelope.payload?.packageRole || outboxItem.payload?.packageRole || record.row.packageRole || '') || null,
    humanFeedbackRevisionContractHash: readyEnvelope.payload?.humanFeedbackRevisionContractHash
      || outboxItem.payload?.humanFeedbackRevisionContractHash
      || record.row.humanFeedbackRevisionContractHash
      || null,
    manifest: record.manifest,
    preview: record.preview,
    sourceReceipt: record.receipt,
    sourceProof: record.proof,
    sourceTransition: record.transition,
    sourceAuditBundle: record.auditBundle,
    outboxItem,
    replayGuardDecision: repeatApproved,
    dispatchEnvelope: readyEnvelope,
    blockedReplayDecision: blockedReplay,
    mismatchReplayDecision: mismatchReplay,
    blockedReplayEnvelope,
    mismatchEnvelope,
    tamperedOutboxEnvelope,
    strippedOutboxAliasReplay,
    strippedOutboxAliasEnvelope,
    strippedPayloadMessageHashReplay,
    strippedPayloadContractHashReplay,
    strippedPayloadPromptBindingReplay,
    missingReplayGuardEnvelope,
    readyEnvelopeStatus: readyEnvelope.status,
    readyEnvelopeHash: readyEnvelope.dispatchEnvelopeHash,
    readyEnvelopeReplayGuardHash: readyEnvelope.runner.requiredHashes.replayGuardHash,
    readyEnvelopeArchiveHash: readyEnvelope.runner.requiredHashes.archiveHash,
    blockedReplayEnvelopeStatus: blockedReplayEnvelope.status,
    blockedReplayEnvelopeBlockers: blockerCodes(blockedReplayEnvelope),
    mismatchEnvelopeStatus: mismatchEnvelope.status,
    mismatchEnvelopeBlockers: blockerCodes(mismatchEnvelope),
    tamperedOutboxEnvelopeStatus: tamperedOutboxEnvelope.status,
    tamperedOutboxEnvelopeBlockers: blockerCodes(tamperedOutboxEnvelope),
    strippedOutboxAliasReplayCandidateOutboxHash: strippedOutboxAliasReplay.candidate?.outboxHash || null,
    strippedOutboxAliasEnvelopeStatus: strippedOutboxAliasEnvelope.status,
    strippedOutboxAliasEnvelopeBlockers: blockerCodes(strippedOutboxAliasEnvelope),
    strippedPayloadMessageHashReplayStatus: strippedPayloadMessageHashReplay?.status || null,
    strippedPayloadMessageHashReplayBlockers: blockerCodes(strippedPayloadMessageHashReplay),
    strippedPayloadContractHashReplayStatus: strippedPayloadContractHashReplay?.status || null,
    strippedPayloadContractHashReplayBlockers: blockerCodes(strippedPayloadContractHashReplay),
    strippedPayloadPromptBindingReplayStatus: strippedPayloadPromptBindingReplay?.status || null,
    strippedPayloadPromptBindingReplayBlockers: blockerCodes(strippedPayloadPromptBindingReplay),
    missingReplayGuardEnvelopeStatus: missingReplayGuardEnvelope.status,
    missingReplayGuardEnvelopeBlockers: blockerCodes(missingReplayGuardEnvelope),
    blockers,
  };
}

function reportRowForRecord(record) {
  return {
    scenarioId: record.scenarioId,
    channelId: record.channelId,
    actionId: record.actionId,
    action: record.action,
    packageRole: record.packageRole,
    humanFeedbackRevisionContractHash: record.humanFeedbackRevisionContractHash,
    readyEnvelopeStatus: record.readyEnvelopeStatus,
    readyEnvelopeHash: record.readyEnvelopeHash,
    readyEnvelopeReplayGuardHash: record.readyEnvelopeReplayGuardHash,
    readyEnvelopeArchiveHash: record.readyEnvelopeArchiveHash,
    blockedReplayEnvelopeStatus: record.blockedReplayEnvelopeStatus,
    blockedReplayEnvelopeBlockers: record.blockedReplayEnvelopeBlockers,
    mismatchEnvelopeStatus: record.mismatchEnvelopeStatus,
    mismatchEnvelopeBlockers: record.mismatchEnvelopeBlockers,
    tamperedOutboxEnvelopeStatus: record.tamperedOutboxEnvelopeStatus,
    tamperedOutboxEnvelopeBlockers: record.tamperedOutboxEnvelopeBlockers,
    strippedOutboxAliasReplayCandidateOutboxHash: record.strippedOutboxAliasReplayCandidateOutboxHash,
    strippedOutboxAliasEnvelopeStatus: record.strippedOutboxAliasEnvelopeStatus,
    strippedOutboxAliasEnvelopeBlockers: record.strippedOutboxAliasEnvelopeBlockers,
    strippedPayloadMessageHashReplayStatus: record.strippedPayloadMessageHashReplayStatus,
    strippedPayloadMessageHashReplayBlockers: record.strippedPayloadMessageHashReplayBlockers,
    strippedPayloadContractHashReplayStatus: record.strippedPayloadContractHashReplayStatus,
    strippedPayloadContractHashReplayBlockers: record.strippedPayloadContractHashReplayBlockers,
    strippedPayloadPromptBindingReplayStatus: record.strippedPayloadPromptBindingReplayStatus,
    strippedPayloadPromptBindingReplayBlockers: record.strippedPayloadPromptBindingReplayBlockers,
    missingReplayGuardEnvelopeStatus: record.missingReplayGuardEnvelopeStatus,
    missingReplayGuardEnvelopeBlockers: record.missingReplayGuardEnvelopeBlockers,
    blockers: record.blockers,
  };
}

export function buildPostActionDispatchEnvelopeMatrixRecords() {
  const {
    runtimeReport,
    postActionEvidenceMatrix,
    records: auditBundleRecords,
  } = buildPostActionAuditBundleMatrixRecords();
  const postActionReplayGuardMatrix = buildPostActionReplayGuardMatrixReport({ generatedAt: FIXED_CREATED_AT });
  const archive = archiveForRecords(auditBundleRecords);
  const records = auditBundleRecords.map((record, index) => dispatchRecordForAuditBundleRecord({
    record,
    archive,
    mismatchRecord: auditBundleRecords[(index + 1) % auditBundleRecords.length] || record,
  }));
  return {
    runtimeReport,
    postActionEvidenceMatrix,
    postActionReplayGuardMatrix,
    archive,
    auditBundleRecords,
    records,
  };
}

export function buildPostActionDispatchEnvelopeMatrixReport({ generatedAt = new Date().toISOString() } = {}) {
  const {
    runtimeReport,
    postActionEvidenceMatrix,
    postActionReplayGuardMatrix,
    archive,
    records,
  } = buildPostActionDispatchEnvelopeMatrixRecords();
  const postActionAuditArchiveMatrix = buildPostActionAuditArchiveMatrixReport({ generatedAt: FIXED_CREATED_AT });
  const rows = records.map(reportRowForRecord);
  const blockers = [
    ...(runtimeReport.ok === true ? [] : [issue('runtime_dry_run_harness_not_ready')]),
    ...(postActionEvidenceMatrix.ok === true ? [] : [issue('post_action_evidence_matrix_not_ready')]),
    ...(postActionAuditArchiveMatrix.ok === true ? [] : [issue('post_action_audit_archive_matrix_not_ready')]),
    ...(postActionAuditArchiveMatrix.postActionAuditArchiveMatrixHash ? [] : [issue('post_action_audit_archive_matrix_hash_missing')]),
    ...(postActionReplayGuardMatrix.ok === true ? [] : [issue('post_action_replay_guard_matrix_not_ready')]),
    ...(postActionReplayGuardMatrix.postActionReplayGuardMatrixHash ? [] : [issue('post_action_replay_guard_matrix_hash_missing')]),
    ...rows.flatMap((row) => row.blockers),
  ];
  if (archive.status !== 'ready_external_action_audit_archive') {
    blockers.push(issue('aggregate_archive_not_ready'));
  }

  const actionClasses = uniqueStrings(rows.map((row) => row.action), 32);
  const customerMessageRows = rows.filter((row) => row.action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
  const humanFeedbackRows = rows.filter((row) => row.humanFeedbackRevisionContractHash);
  const promptGenerationSpendRows = rows.filter((row) => isPromptGenerationSpendAction(row.action));
  const summary = {
    routeCount: rows.length,
    actionClassCount: actionClasses.length,
    actionClasses,
    postActionAuditArchiveMatrixHash: postActionAuditArchiveMatrix.postActionAuditArchiveMatrixHash,
    postActionAuditArchiveMatrixOk: postActionAuditArchiveMatrix.ok === true,
    postActionReplayGuardMatrixHash: postActionReplayGuardMatrix.postActionReplayGuardMatrixHash,
    postActionReplayGuardMatrixOk: postActionReplayGuardMatrix.ok === true,
    archiveHash: archive.archiveHash,
    archiveEntries: archive.summary.count,
    readyEnvelopeCount: rows.filter((row) => row.readyEnvelopeStatus === 'ready_adapter_dispatch_envelope').length,
    blockedReplayEnvelopeCount: rows.filter((row) => row.blockedReplayEnvelopeStatus === 'blocked_adapter_dispatch_envelope').length,
    mismatchEnvelopeBlockedCount: rows.filter((row) => row.mismatchEnvelopeStatus === 'blocked_adapter_dispatch_envelope').length,
    tamperedOutboxEnvelopeBlockedCount: rows.filter((row) => row.tamperedOutboxEnvelopeStatus === 'blocked_adapter_dispatch_envelope').length,
    strippedOutboxAliasCandidateNullCount: rows.filter((row) => row.strippedOutboxAliasReplayCandidateOutboxHash === null).length,
    strippedOutboxAliasEnvelopeBlockedCount: rows.filter((row) => row.strippedOutboxAliasEnvelopeStatus === 'blocked_adapter_dispatch_envelope').length,
    strippedPayloadMessageHashReplayBlockedCount: rows.filter((row) => row.strippedPayloadMessageHashReplayStatus === 'blocked_replay_guard').length,
    strippedPayloadContractHashReplayBlockedCount: rows.filter((row) => row.strippedPayloadContractHashReplayStatus === 'blocked_replay_guard').length,
    strippedPayloadPromptBindingReplayBlockedCount: rows.filter((row) => row.strippedPayloadPromptBindingReplayStatus === 'blocked_replay_guard').length,
    missingReplayGuardEnvelopeBlockedCount: rows.filter((row) => row.missingReplayGuardEnvelopeStatus === 'blocked_adapter_dispatch_envelope').length,
    replayGuardNotClearBlockedCount: rows.filter((row) => row.blockedReplayEnvelopeBlockers.includes('replay_guard_not_clear')).length,
    mismatchCandidateBlockedCount: rows.filter((row) => row.mismatchEnvelopeBlockers.includes('replay_guard_candidate_mismatch')).length,
    tamperedOutboxHashBlockedCount: rows.filter((row) => row.tamperedOutboxEnvelopeBlockers.includes('outbox_hash_content_mismatch')).length,
    strippedOutboxAliasBlockedCount: rows.filter((row) => row.strippedOutboxAliasEnvelopeBlockers.includes('outbox_hash_alias_required')).length,
    strippedPayloadMessageHashBlockedCount: rows.filter((row) => row.strippedPayloadMessageHashReplayBlockers.includes('candidate_message_preview_hash_required')).length,
    strippedPayloadContractHashBlockedCount: rows.filter((row) => row.strippedPayloadContractHashReplayBlockers.includes('candidate_human_feedback_contract_hash_required')).length,
    strippedPayloadPromptBindingBlockedCount: rows.filter((row) => row.strippedPayloadPromptBindingReplayBlockers.includes('candidate_prompt_generation_binding_required')).length,
    missingReplayGuardBlockedCount: rows.filter((row) => row.missingReplayGuardEnvelopeBlockers.includes('replay_guard_required')).length,
    readyEnvelopeHashBindings: rows.filter((row) => row.readyEnvelopeReplayGuardHash && row.readyEnvelopeArchiveHash).length,
    packageRoleRouteCount: rows.filter((row) => row.packageRole).length,
    humanFeedbackPackageRoleBoundRouteCount: rows.filter((row) => (
      row.humanFeedbackRevisionContractHash && row.packageRole
    )).length,
    customerMessageRouteCount: customerMessageRows.length,
    humanFeedbackRouteCount: humanFeedbackRows.length,
    promptGenerationSpendRouteCount: promptGenerationSpendRows.length,
    routeBlockerCount: rows.reduce((sum, row) => sum + row.blockers.length, 0),
  };
  if (summary.routeCount !== 20) blockers.push(issue('post_action_dispatch_envelope_matrix_route_count_unexpected', `${summary.routeCount}/20`));
  if (summary.actionClassCount !== 7) blockers.push(issue('post_action_dispatch_envelope_matrix_action_class_count_unexpected', `${summary.actionClassCount}/7`));
  if (summary.packageRoleRouteCount !== rows.length) blockers.push(issue('post_action_dispatch_envelope_package_role_not_bound', `${summary.packageRoleRouteCount}/${rows.length}`));
  if (summary.humanFeedbackPackageRoleBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_dispatch_envelope_human_feedback_package_role_not_bound',
    `${summary.humanFeedbackPackageRoleBoundRouteCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedOutboxAliasCandidateNullCount !== rows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_outbox_alias_candidate_fallback',
    `${summary.strippedOutboxAliasCandidateNullCount}/${rows.length}`,
  ));
  if (summary.strippedOutboxAliasEnvelopeBlockedCount !== rows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_outbox_alias_not_blocked',
    `${summary.strippedOutboxAliasEnvelopeBlockedCount}/${rows.length}`,
  ));
  if (summary.strippedOutboxAliasBlockedCount !== rows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_outbox_alias_blocker_missing',
    `${summary.strippedOutboxAliasBlockedCount}/${rows.length}`,
  ));
  if (summary.strippedPayloadMessageHashReplayBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_payload_message_hash_replay_not_blocked',
    `${summary.strippedPayloadMessageHashReplayBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadMessageHashBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_payload_message_hash_blocker_missing',
    `${summary.strippedPayloadMessageHashBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadContractHashReplayBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_payload_contract_hash_replay_not_blocked',
    `${summary.strippedPayloadContractHashReplayBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadContractHashBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_payload_contract_hash_blocker_missing',
    `${summary.strippedPayloadContractHashBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingReplayBlockedCount !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_payload_prompt_binding_replay_not_blocked',
    `${summary.strippedPayloadPromptBindingReplayBlockedCount}/${promptGenerationSpendRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingBlockedCount !== promptGenerationSpendRows.length) blockers.push(issue(
    'post_action_dispatch_envelope_stripped_payload_prompt_binding_blocker_missing',
    `${summary.strippedPayloadPromptBindingBlockedCount}/${promptGenerationSpendRows.length}`,
  ));

  const status = blockers.length
    ? POST_ACTION_DISPATCH_ENVELOPE_MATRIX_STATUS.FAIL
    : POST_ACTION_DISPATCH_ENVELOPE_MATRIX_STATUS.PASS;
  const dispatchEnvelopeMatrixHash = digest({
    version: POST_ACTION_DISPATCH_ENVELOPE_MATRIX_VERSION,
    status,
    summary,
    rows: rows.map((row) => ({
      scenarioId: row.scenarioId,
      channelId: row.channelId,
      actionId: row.actionId,
      action: row.action,
      packageRole: row.packageRole,
      humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
      readyEnvelopeStatus: row.readyEnvelopeStatus,
      blockedReplayEnvelopeStatus: row.blockedReplayEnvelopeStatus,
      blockedReplayEnvelopeBlockers: row.blockedReplayEnvelopeBlockers,
      mismatchEnvelopeStatus: row.mismatchEnvelopeStatus,
      mismatchEnvelopeBlockers: row.mismatchEnvelopeBlockers,
      tamperedOutboxEnvelopeStatus: row.tamperedOutboxEnvelopeStatus,
      tamperedOutboxEnvelopeBlockers: row.tamperedOutboxEnvelopeBlockers,
      strippedOutboxAliasReplayCandidateOutboxHash: row.strippedOutboxAliasReplayCandidateOutboxHash,
      strippedOutboxAliasEnvelopeStatus: row.strippedOutboxAliasEnvelopeStatus,
      strippedOutboxAliasEnvelopeBlockers: row.strippedOutboxAliasEnvelopeBlockers,
      strippedPayloadMessageHashReplayStatus: row.strippedPayloadMessageHashReplayStatus,
      strippedPayloadMessageHashReplayBlockers: row.strippedPayloadMessageHashReplayBlockers,
      strippedPayloadContractHashReplayStatus: row.strippedPayloadContractHashReplayStatus,
      strippedPayloadContractHashReplayBlockers: row.strippedPayloadContractHashReplayBlockers,
      strippedPayloadPromptBindingReplayStatus: row.strippedPayloadPromptBindingReplayStatus,
      strippedPayloadPromptBindingReplayBlockers: row.strippedPayloadPromptBindingReplayBlockers,
      missingReplayGuardEnvelopeStatus: row.missingReplayGuardEnvelopeStatus,
      missingReplayGuardEnvelopeBlockers: row.missingReplayGuardEnvelopeBlockers,
      blockerCodes: row.blockers.map((item) => item.code),
    })),
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionAuditArchiveMatrixHash: postActionAuditArchiveMatrix.postActionAuditArchiveMatrixHash,
    postActionReplayGuardMatrixHash: postActionReplayGuardMatrix.postActionReplayGuardMatrixHash,
    archiveHash: archive.archiveHash,
    blockers,
  });

  return {
    version: POST_ACTION_DISPATCH_ENVELOPE_MATRIX_VERSION,
    kind: 'PostActionDispatchEnvelopeMatrixReport',
    status,
    ok: blockers.length === 0,
    generatedAt,
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionAuditArchiveMatrixHash: postActionAuditArchiveMatrix.postActionAuditArchiveMatrixHash,
    postActionReplayGuardMatrixHash: postActionReplayGuardMatrix.postActionReplayGuardMatrixHash,
    archiveHash: archive.archiveHash,
    summary,
    rows,
    blockers,
    safety: {
      syntheticFixturesOnly: true,
      dispatchEnvelopeOnly: true,
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
      dispatchesRunner: false,
      grantsExecutionPermission: false,
    },
    postActionDispatchEnvelopeMatrixHash: dispatchEnvelopeMatrixHash,
    hash: dispatchEnvelopeMatrixHash,
  };
}
