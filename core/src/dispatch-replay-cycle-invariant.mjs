import {
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  isHumanFeedbackMessageActionAlias,
  normalizeText,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const DISPATCH_REPLAY_CYCLE_INVARIANT_VERSION = 1;

export const DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS = Object.freeze({
  PASS: 'pass_dispatch_replay_cycle_invariant',
  BLOCKED: 'blocked_dispatch_replay_cycle_invariant',
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

function hashOf(item, keys = []) {
  for (const key of keys) {
    const value = text(item?.[key] || item?.hashBinding?.[key] || item?.chain?.[key] || item?.runner?.requiredHashes?.[key]);
    if (value) return value;
  }
  return null;
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function bindingValues(item, key) {
  const values = [
    text(item?.[key]),
    text(item?.hashBinding?.[key]),
    text(item?.hashBinding?.requiredHashes?.[key]),
    text(item?.chain?.[key]),
    text(item?.payload?.[key]),
    text(item?.runner?.requiredHashes?.[key]),
    text(item?.candidate?.[key]),
    text(item?.result?.external?.[key]),
    text(item?.evidence?.[key]),
  ];
  return unique(values);
}

function objectTextValues(item, keys = []) {
  const values = [];
  for (const key of keys) {
    values.push(
      text(item?.[key]),
      text(item?.payload?.[key]),
      text(item?.candidate?.[key]),
      text(item?.chain?.[key]),
      text(item?.runner?.[key]),
      text(item?.result?.external?.[key]),
    );
  }
  return unique(values);
}

function hasIssue(item, code, field = 'blockers') {
  return (item?.[field] || []).some((entry) => entry.code === code);
}

function addCheck(checks, id, passed, notes = null) {
  checks.push({
    id,
    passed: Boolean(passed),
    notes: text(notes),
  });
}

function statusIs(item, status) {
  return item?.status === status;
}

function blockedStatus(item) {
  return Boolean(item?.status && item.status.startsWith('blocked_'));
}

function archiveDispatchBound(archive) {
  return (archive?.entries || []).some((entry) => entry.usesDispatchInboxChain === true && entry.dispatchReplayGuardHash);
}

function archiveRepeatEntry(archive, { ledgerHash = null, bundleHash = null } = {}) {
  return (archive?.entries || []).find((entry) => (
    (ledgerHash && entry.ledgerHash === ledgerHash)
      || (bundleHash && entry.bundleHash === bundleHash)
  )) || null;
}

function repeatBindingRecords({
  envelopes = {},
  receiptInboxes = {},
  proofInboxes = {},
  transitionInboxes = {},
  ledgers = {},
  bundles = {},
  nextArchive = null,
} = {}) {
  const repeatLedgerHash = hashOf(ledgers.repeatApproved, ['ledgerHash']);
  const repeatBundleHash = hashOf(bundles.repeatApproved, ['bundleHash']);
  return [
    ['repeat_dispatch_envelope', envelopes.repeatApproved],
    ['repeat_receipt_inbox', receiptInboxes.repeatApproved],
    ['repeat_proof_inbox', proofInboxes.repeatApproved],
    ['repeat_transition_inbox', transitionInboxes.repeatApproved],
    ['repeat_ledger', ledgers.repeatApproved],
    ['repeat_bundle', bundles.repeatApproved],
    ['next_archive_repeat_entry', archiveRepeatEntry(nextArchive, {
      ledgerHash: repeatLedgerHash,
      bundleHash: repeatBundleHash,
    })],
  ].filter(([, record]) => record).map(([id, record]) => ({ id, record }));
}

function indicatesCustomerMessage(item) {
  return bindingValues(item, 'messagePreviewHash').length > 0
    || objectTextValues(item, ['action']).some((action) => canonicalExternalAction(action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
}

function indicatesHumanFeedback(item) {
  return bindingValues(item, 'humanFeedbackRevisionContractHash').length > 0
    || objectTextValues(item, ['action']).some((action) => isHumanFeedbackMessageActionAlias(action))
    || objectTextValues(item, ['productLineId', 'workflowId', 'packageRole', 'reviewType', 'role']).some((value) => (
      canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
        || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    ));
}

function bindingContinuity(records, key, required) {
  if (!required) {
    return {
      ok: true,
      expected: null,
      missing: [],
      mismatches: [],
    };
  }
  let expected = null;
  const missing = [];
  const mismatches = [];
  for (const { id, record } of records) {
    const values = bindingValues(record, key);
    if (!values.length) {
      missing.push(id);
      continue;
    }
    if (!expected) expected = values[0];
    for (const value of values) {
      if (value !== expected) {
        mismatches.push({ id, expected, actual: value });
      }
    }
  }
  return {
    ok: missing.length === 0 && mismatches.length === 0,
    expected,
    missing,
    mismatches,
  };
}

function bindingContinuityNotes(result) {
  if (result.ok) return null;
  const parts = [];
  if (result.missing.length) parts.push(`missing=${result.missing.join(',')}`);
  if (result.mismatches.length) {
    parts.push(`mismatch=${result.mismatches.map((item) => `${item.id}:${item.actual}`).join(',')}`);
  }
  return parts.join('; ');
}

function unsafeRecords(records) {
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
  return records.filter((record) => unsafeKeys.some((key) => record?.safety?.[key] === true));
}

function collectRecords({
  sourceArchive,
  replayGuards,
  envelopes,
  receiptInboxes,
  proofInboxes,
  transitionInboxes,
  ledgers,
  bundles,
  nextArchive,
}) {
  return [
    sourceArchive,
    ...(Object.values(replayGuards || {})),
    ...(Object.values(envelopes || {})),
    ...(Object.values(receiptInboxes || {})),
    ...(Object.values(proofInboxes || {})),
    ...(Object.values(transitionInboxes || {})),
    ...(Object.values(ledgers || {})),
    ...(Object.values(bundles || {})),
    nextArchive,
  ].filter(Boolean);
}

export function buildDispatchReplayCycleInvariantReport({
  sourceArchive = null,
  replayGuards = {},
  envelopes = {},
  receiptInboxes = {},
  proofInboxes = {},
  transitionInboxes = {},
  ledgers = {},
  bundles = {},
  nextArchive = null,
  actor = 'design-production-core.dispatch-replay-cycle-invariant',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const checks = [];
  const repeatRecords = repeatBindingRecords({
    envelopes,
    receiptInboxes,
    proofInboxes,
    transitionInboxes,
    ledgers,
    bundles,
    nextArchive,
  });
  const customerMessageCycle = repeatRecords.some((item) => indicatesCustomerMessage(item.record));
  const humanFeedbackCycle = repeatRecords.some((item) => indicatesHumanFeedback(item.record));
  const messagePreviewContinuity = bindingContinuity(repeatRecords, 'messagePreviewHash', customerMessageCycle);
  const humanFeedbackContractContinuity = bindingContinuity(
    repeatRecords,
    'humanFeedbackRevisionContractHash',
    humanFeedbackCycle,
  );

  addCheck(checks, 'source_archive_ready', statusIs(sourceArchive, 'ready_external_action_audit_archive') && sourceArchive?.ready === true);
  addCheck(checks, 'source_archive_dispatch_hash_bound', archiveDispatchBound(sourceArchive));

  addCheck(checks, 'archived_replay_guard_blocks_same_task', statusIs(replayGuards.archivedReplay, 'blocked_replay_guard') && hasIssue(replayGuards.archivedReplay, 'task_action_already_archived'));
  addCheck(checks, 'repeat_approved_guard_clears_only_same_task', statusIs(replayGuards.repeatApproved, 'clear_for_new_handoff') && replayGuards.repeatApproved?.clear === true);
  addCheck(checks, 'repeat_approved_guard_records_warning', hasIssue(replayGuards.repeatApproved, 'repeat_task_action_explicitly_allowed', 'warnings'));
  addCheck(
    checks,
    'exact_hash_replay_guard_blocks_bundle_and_ledger',
    statusIs(replayGuards.exactHashReplay, 'blocked_replay_guard')
      && hasIssue(replayGuards.exactHashReplay, 'bundle_hash_already_archived')
      && hasIssue(replayGuards.exactHashReplay, 'ledger_hash_already_archived'),
  );

  addCheck(checks, 'archived_replay_envelope_blocked', statusIs(envelopes.archivedReplay, 'blocked_adapter_dispatch_envelope') && hasIssue(envelopes.archivedReplay, 'replay_guard_not_clear'));
  addCheck(checks, 'repeat_approved_envelope_ready', statusIs(envelopes.repeatApproved, 'ready_adapter_dispatch_envelope') && envelopes.repeatApproved?.readyForExternalRunner === true);
  addCheck(checks, 'exact_hash_replay_envelope_blocked', statusIs(envelopes.exactHashReplay, 'blocked_adapter_dispatch_envelope') && hasIssue(envelopes.exactHashReplay, 'replay_guard_not_clear'));
  addCheck(checks, 'candidate_mismatch_envelope_blocked', statusIs(envelopes.candidateMismatch, 'blocked_adapter_dispatch_envelope') && hasIssue(envelopes.candidateMismatch, 'replay_guard_candidate_mismatch'));

  addCheck(checks, 'repeat_receipt_waits_for_proof', statusIs(receiptInboxes.repeatApproved, 'received_dispatch_receipt') && receiptInboxes.repeatApproved?.nextStep === 'channel_state_proof_required');
  addCheck(checks, 'blocked_receipts_do_not_advance', ['archivedReplay', 'exactHashReplay', 'candidateMismatch'].every((key) => statusIs(receiptInboxes[key], 'blocked_dispatch_receipt_inbox')));

  addCheck(checks, 'repeat_proof_waits_for_transition', statusIs(proofInboxes.repeatApproved, 'received_dispatch_channel_state_proof') && proofInboxes.repeatApproved?.nextStep === 'receipt_state_transition_ready');
  addCheck(checks, 'blocked_proofs_do_not_advance', ['archivedReplay', 'exactHashReplay', 'candidateMismatch'].every((key) => statusIs(proofInboxes[key], 'blocked_dispatch_channel_state_proof_inbox')));

  addCheck(checks, 'repeat_transition_waits_for_ledger', statusIs(transitionInboxes.repeatApproved, 'received_dispatch_receipt_state_transition') && transitionInboxes.repeatApproved?.nextStep === 'external_action_ledger_ready');
  addCheck(checks, 'blocked_transitions_do_not_advance', ['archivedReplay', 'exactHashReplay', 'candidateMismatch'].every((key) => statusIs(transitionInboxes[key], 'blocked_dispatch_receipt_state_transition_inbox')));

  addCheck(checks, 'repeat_ledger_verified', statusIs(ledgers.repeatApproved, 'verified_action_ledger') && ledgers.repeatApproved?.verified === true);
  addCheck(checks, 'blocked_ledgers_do_not_verify', ['archivedReplay', 'exactHashReplay', 'candidateMismatch'].every((key) => statusIs(ledgers[key], 'blocked_action_ledger') && ledgers[key]?.verified !== true));

  addCheck(checks, 'repeat_bundle_verified', statusIs(bundles.repeatApproved, 'verified_action_audit_bundle') && bundles.repeatApproved?.verified === true);
  addCheck(checks, 'blocked_replay_bundle_not_verified', statusIs(bundles.blockedReplay, 'blocked_action_audit_bundle') && bundles.blockedReplay?.verified !== true);
  addCheck(checks, 'next_archive_ready', statusIs(nextArchive, 'ready_external_action_audit_archive') && nextArchive?.ready === true);
  addCheck(checks, 'next_archive_preserves_dispatch_replay_guard_hash', archiveDispatchBound(nextArchive));
  addCheck(checks, 'repeat_customer_message_hash_continuous', messagePreviewContinuity.ok, bindingContinuityNotes(messagePreviewContinuity));
  addCheck(checks, 'repeat_human_feedback_contract_hash_continuous', humanFeedbackContractContinuity.ok, bindingContinuityNotes(humanFeedbackContractContinuity));

  addCheck(checks, 'exact_hash_replay_never_clears', statusIs(replayGuards.exactHashReplay, 'blocked_replay_guard')
    && statusIs(envelopes.exactHashReplay, 'blocked_adapter_dispatch_envelope')
    && blockedStatus(receiptInboxes.exactHashReplay)
    && blockedStatus(proofInboxes.exactHashReplay)
    && blockedStatus(transitionInboxes.exactHashReplay)
    && statusIs(ledgers.exactHashReplay, 'blocked_action_ledger'));
  addCheck(checks, 'archived_replay_never_clears', statusIs(replayGuards.archivedReplay, 'blocked_replay_guard')
    && statusIs(envelopes.archivedReplay, 'blocked_adapter_dispatch_envelope')
    && blockedStatus(receiptInboxes.archivedReplay)
    && blockedStatus(proofInboxes.archivedReplay)
    && blockedStatus(transitionInboxes.archivedReplay)
    && statusIs(ledgers.archivedReplay, 'blocked_action_ledger'));
  addCheck(checks, 'candidate_mismatch_never_clears', statusIs(envelopes.candidateMismatch, 'blocked_adapter_dispatch_envelope')
    && blockedStatus(receiptInboxes.candidateMismatch)
    && blockedStatus(proofInboxes.candidateMismatch)
    && blockedStatus(transitionInboxes.candidateMismatch)
    && statusIs(ledgers.candidateMismatch, 'blocked_action_ledger'));
  addCheck(checks, 'ready_envelope_is_not_execution_permission', envelopes.repeatApproved?.safety?.readyForExecution === false && envelopes.repeatApproved?.safety?.grantsExecutionPermission === false);

  const records = collectRecords({
    sourceArchive,
    replayGuards,
    envelopes,
    receiptInboxes,
    proofInboxes,
    transitionInboxes,
    ledgers,
    bundles,
    nextArchive,
  });
  addCheck(checks, 'cycle_records_do_not_execute_external_actions', unsafeRecords(records).length === 0);

  const failedChecks = checks.filter((check) => !check.passed);
  const blockers = failedChecks.map((check) => issue('dispatch_replay_cycle_check_failed', check.id));
  const status = blockers.length
    ? DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS.BLOCKED
    : DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS.PASS;

  const report = {
    version: DISPATCH_REPLAY_CYCLE_INVARIANT_VERSION,
    kind: 'DispatchReplayCycleInvariantReport',
    actor: normalizeText(actor) || 'design-production-core.dispatch-replay-cycle-invariant',
    status,
    passed: status === DISPATCH_REPLAY_CYCLE_INVARIANT_STATUS.PASS,
    chain: {
      sourceArchiveHash: hashOf(sourceArchive, ['archiveHash']),
      nextArchiveHash: hashOf(nextArchive, ['archiveHash']),
      repeatReplayGuardHash: hashOf(replayGuards.repeatApproved, ['replayGuardHash']),
      repeatDispatchEnvelopeHash: hashOf(envelopes.repeatApproved, ['dispatchEnvelopeHash']),
      repeatReceiptInboxHash: hashOf(receiptInboxes.repeatApproved, ['dispatchReceiptInboxHash']),
      repeatProofInboxHash: hashOf(proofInboxes.repeatApproved, ['dispatchProofInboxHash']),
      repeatTransitionInboxHash: hashOf(transitionInboxes.repeatApproved, ['dispatchTransitionInboxHash']),
      repeatLedgerHash: hashOf(ledgers.repeatApproved, ['ledgerHash']),
      repeatBundleHash: hashOf(bundles.repeatApproved, ['bundleHash']),
      repeatMessagePreviewHash: messagePreviewContinuity.expected,
      repeatHumanFeedbackRevisionContractHash: humanFeedbackContractContinuity.expected,
    },
    checkSummary: {
      total: checks.length,
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
      failedCheckIds: failedChecks.map((check) => check.id),
    },
    checks,
    blockers,
    warnings: [
      issue('dispatch_replay_cycle_invariant_only', 'This report summarizes replay-cycle invariants and never grants execution permission.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      invariantOnly: true,
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
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const invariantHash = digest({
    version: report.version,
    kind: report.kind,
    actor: report.actor,
    status: report.status,
    passed: report.passed,
    chain: report.chain,
    checkSummary: report.checkSummary,
    checks: report.checks,
    blockers: report.blockers,
    warnings: report.warnings,
    evidenceRefs: report.evidenceRefs,
    safety: report.safety,
  });

  return {
    ...report,
    invariantHash,
    hash: invariantHash,
  };
}

export function summarizeDispatchReplayCycleInvariants(reports = []) {
  const byStatus = {};
  const failedCheckIds = {};
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    for (const checkId of report.checkSummary?.failedCheckIds || []) {
      failedCheckIds[checkId] = (failedCheckIds[checkId] || 0) + 1;
    }
  }
  return {
    version: DISPATCH_REPLAY_CYCLE_INVARIANT_VERSION,
    count: reports.length,
    byStatus,
    failedCheckIds,
    safety: {
      invariantOnly: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
    },
  };
}
