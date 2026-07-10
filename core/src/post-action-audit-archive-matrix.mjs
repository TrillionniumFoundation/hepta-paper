import {
  EXTERNAL_ACTIONS,
  canonicalExternalAction,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { buildExternalActionAuditArchive } from './external-action-audit-archive.mjs';
import { computeExternalActionAuditBundleHash } from './external-action-audit-bundle.mjs';
import {
  buildPostActionAuditBundleMatrixRecords,
  buildPostActionAuditBundleMatrixReport,
} from './post-action-audit-bundle-matrix.mjs';
import { digest } from './hash-utils.mjs';

export const POST_ACTION_AUDIT_ARCHIVE_MATRIX_VERSION = 1;

export const POST_ACTION_AUDIT_ARCHIVE_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_post_action_audit_archive_matrix',
  FAIL: 'fail_post_action_audit_archive_matrix',
});

const FIXED_CREATED_AT = '2026-06-08T08:55:00.000Z';

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes || '') || null,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function archiveForBundles({
  bundles,
  archiveRole = 'post_action_audit_archive_matrix',
  requireVerifiedBundles = true,
  requireInboxChain = true,
  actor = 'post-action-audit-archive-matrix.archive',
} = {}) {
  return buildExternalActionAuditArchive({
    bundles,
    archiveRole,
    requireVerifiedBundles,
    requireInboxChain,
    actor,
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-audit-archive-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function blockerCodes(record) {
  return uniqueStrings((record?.blockers || []).map((item) => item.code), 32);
}

function archiveForStrippedBundleSource(record, {
  source,
  key,
  archiveRole,
  actor,
}) {
  const bundle = cloneJson(record.auditBundle);
  if (source === 'payload') {
    if (!bundle.payload || !Object.prototype.hasOwnProperty.call(bundle.payload, key)) return null;
    delete bundle.payload[key];
  } else if (source === 'hashBinding') {
    if (!bundle.hashBinding || !Object.prototype.hasOwnProperty.call(bundle.hashBinding, key)) return null;
    delete bundle.hashBinding[key];
  } else {
    return null;
  }
  const bundleHash = computeExternalActionAuditBundleHash(bundle);
  bundle.bundleHash = bundleHash;
  bundle.hash = bundleHash;
  return archiveForBundles({
    bundles: [bundle],
    archiveRole,
    actor,
  });
}

function rowForRecord(record) {
  const action = canonicalExternalAction(record.row.action);
  const requiresMessageHash = action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE;
  const requiresContractHash = Boolean(record.auditBundle?.payload?.humanFeedbackRevisionContractHash);
  const requiresPromptBinding = action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND;
  const archive = archiveForBundles({
    bundles: [record.auditBundle],
    archiveRole: 'post_action_single_route_archive',
    actor: 'post-action-audit-archive-matrix.single-route',
  });
  const rawBundleArchive = archiveForBundles({
    bundles: [record.rawLedgerBundle],
    archiveRole: 'post_action_raw_bundle_archive_probe',
    actor: 'post-action-audit-archive-matrix.raw-bundle',
  });
  const missingTransitionArchive = archiveForBundles({
    bundles: [record.missingTransitionInboxBundle],
    archiveRole: 'post_action_missing_transition_archive_probe',
    requireVerifiedBundles: false,
    actor: 'post-action-audit-archive-matrix.missing-transition',
  });
  const strippedPayloadApprovalProvenanceArchive = archiveForStrippedBundleSource(record, {
    source: 'payload',
    key: 'approvalProvenanceHash',
    archiveRole: 'post_action_stripped_payload_approval_provenance_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-payload-approval-provenance',
  });
  const strippedBindingApprovalProvenanceArchive = archiveForStrippedBundleSource(record, {
    source: 'hashBinding',
    key: 'approvalProvenanceHash',
    archiveRole: 'post_action_stripped_binding_approval_provenance_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-binding-approval-provenance',
  });
  const strippedPayloadMessageHashArchive = requiresMessageHash ? archiveForStrippedBundleSource(record, {
    source: 'payload',
    key: 'messagePreviewHash',
    archiveRole: 'post_action_stripped_payload_message_hash_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-payload-message-hash',
  }) : null;
  const strippedBindingMessageHashArchive = requiresMessageHash ? archiveForStrippedBundleSource(record, {
    source: 'hashBinding',
    key: 'messagePreviewHash',
    archiveRole: 'post_action_stripped_binding_message_hash_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-binding-message-hash',
  }) : null;
  const strippedPayloadContractHashArchive = requiresContractHash ? archiveForStrippedBundleSource(record, {
    source: 'payload',
    key: 'humanFeedbackRevisionContractHash',
    archiveRole: 'post_action_stripped_payload_contract_hash_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-payload-contract-hash',
  }) : null;
  const strippedBindingContractHashArchive = requiresContractHash ? archiveForStrippedBundleSource(record, {
    source: 'hashBinding',
    key: 'humanFeedbackRevisionContractHash',
    archiveRole: 'post_action_stripped_binding_contract_hash_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-binding-contract-hash',
  }) : null;
  const strippedPayloadPromptBindingArchive = requiresPromptBinding ? archiveForStrippedBundleSource(record, {
    source: 'payload',
    key: 'promptGenerationBinding',
    archiveRole: 'post_action_stripped_payload_prompt_binding_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-payload-prompt-binding',
  }) : null;
  const strippedBindingPromptBindingArchive = requiresPromptBinding ? archiveForStrippedBundleSource(record, {
    source: 'hashBinding',
    key: 'promptGenerationBinding',
    archiveRole: 'post_action_stripped_binding_prompt_binding_archive_probe',
    actor: 'post-action-audit-archive-matrix.stripped-binding-prompt-binding',
  }) : null;

  const blockers = [];
  if (archive.status !== 'ready_external_action_audit_archive' || archive.ready !== true) {
    blockers.push(issue('per_route_archive_not_ready', record.row.scenarioId));
  }
  if (archive.summary.count !== 1 || archive.summary.verifiedCount !== 1) {
    blockers.push(issue('per_route_archive_entry_count_mismatch', record.row.scenarioId));
  }
  if (archive.entries[0]?.bundleHash !== record.auditBundle.bundleHash) {
    blockers.push(issue('per_route_archive_bundle_hash_mismatch', record.row.scenarioId));
  }
  if (archive.entries[0]?.ledgerHash !== record.ledger.ledgerHash) {
    blockers.push(issue('per_route_archive_ledger_hash_mismatch', record.row.scenarioId));
  }
  if (
    record.ledger.payload?.packageRole
    && archive.entries[0]?.packageRole !== record.ledger.payload.packageRole
  ) {
    blockers.push(issue('per_route_archive_package_role_mismatch', record.row.scenarioId));
  }
  if (
    record.ledger.payload?.approvalProvenanceHash
    && archive.entries[0]?.approvalProvenanceHash !== record.ledger.payload.approvalProvenanceHash
  ) {
    blockers.push(issue('per_route_archive_approval_provenance_hash_mismatch', record.row.scenarioId));
  }
  if (
    record.ledger.payload?.humanFeedbackRevisionContractHash
    && archive.entries[0]?.humanFeedbackRevisionContractHash !== record.ledger.payload.humanFeedbackRevisionContractHash
  ) {
    blockers.push(issue('per_route_archive_human_feedback_contract_hash_mismatch', record.row.scenarioId));
  }
  if (
    record.ledger.payload?.messagePreviewHash
    && archive.entries[0]?.messagePreviewHash !== record.ledger.payload.messagePreviewHash
  ) {
    blockers.push(issue('per_route_archive_message_preview_hash_mismatch', record.row.scenarioId));
  }
  if (rawBundleArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('raw_bundle_archive_not_blocked', record.row.scenarioId));
  }
  if (missingTransitionArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('missing_transition_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedPayloadApprovalProvenanceArchive && strippedPayloadApprovalProvenanceArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_payload_approval_provenance_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedBindingApprovalProvenanceArchive && strippedBindingApprovalProvenanceArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_binding_approval_provenance_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedPayloadMessageHashArchive && strippedPayloadMessageHashArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_payload_message_hash_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedBindingMessageHashArchive && strippedBindingMessageHashArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_binding_message_hash_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedPayloadContractHashArchive && strippedPayloadContractHashArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_payload_contract_hash_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedBindingContractHashArchive && strippedBindingContractHashArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_binding_contract_hash_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedPayloadPromptBindingArchive && strippedPayloadPromptBindingArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_payload_prompt_binding_archive_not_blocked', record.row.scenarioId));
  }
  if (strippedBindingPromptBindingArchive && strippedBindingPromptBindingArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('stripped_binding_prompt_binding_archive_not_blocked', record.row.scenarioId));
  }

  return {
    scenarioId: record.row.scenarioId,
    channelId: record.row.channelId,
    actionId: record.row.actionId,
    action: canonicalExternalAction(record.row.action),
    productLineId: canonicalProductLineOrNull(record.ledger.payload?.productLineId),
    workflowId: canonicalProductLineOrNull(record.ledger.payload?.workflowId),
    packageRole: canonicalPackageRole(record.ledger.payload?.packageRole || record.row.packageRole || '') || null,
    approvalProvenanceHash: record.ledger.payload?.approvalProvenanceHash || null,
    messagePreviewHash: record.ledger.payload?.messagePreviewHash || null,
    humanFeedbackRevisionContractHash: record.ledger.payload?.humanFeedbackRevisionContractHash || null,
    archiveStatus: archive.status,
    archiveHash: archive.archiveHash,
    archiveEntryCount: archive.summary.count,
    archiveVerifiedCount: archive.summary.verifiedCount,
    bundleHash: record.auditBundle.bundleHash,
    ledgerHash: record.ledger.ledgerHash,
    rawBundleArchiveStatus: rawBundleArchive.status,
    rawBundleArchiveBlockers: blockerCodes(rawBundleArchive),
    missingTransitionArchiveStatus: missingTransitionArchive.status,
    missingTransitionArchiveBlockers: blockerCodes(missingTransitionArchive),
    strippedPayloadApprovalProvenanceArchiveStatus: strippedPayloadApprovalProvenanceArchive?.status || null,
    strippedPayloadApprovalProvenanceArchiveBlockers: blockerCodes(strippedPayloadApprovalProvenanceArchive),
    strippedBindingApprovalProvenanceArchiveStatus: strippedBindingApprovalProvenanceArchive?.status || null,
    strippedBindingApprovalProvenanceArchiveBlockers: blockerCodes(strippedBindingApprovalProvenanceArchive),
    strippedPayloadMessageHashArchiveStatus: strippedPayloadMessageHashArchive?.status || null,
    strippedPayloadMessageHashArchiveBlockers: blockerCodes(strippedPayloadMessageHashArchive),
    strippedBindingMessageHashArchiveStatus: strippedBindingMessageHashArchive?.status || null,
    strippedBindingMessageHashArchiveBlockers: blockerCodes(strippedBindingMessageHashArchive),
    strippedPayloadContractHashArchiveStatus: strippedPayloadContractHashArchive?.status || null,
    strippedPayloadContractHashArchiveBlockers: blockerCodes(strippedPayloadContractHashArchive),
    strippedBindingContractHashArchiveStatus: strippedBindingContractHashArchive?.status || null,
    strippedBindingContractHashArchiveBlockers: blockerCodes(strippedBindingContractHashArchive),
    strippedPayloadPromptBindingArchiveStatus: strippedPayloadPromptBindingArchive?.status || null,
    strippedPayloadPromptBindingArchiveBlockers: blockerCodes(strippedPayloadPromptBindingArchive),
    strippedBindingPromptBindingArchiveStatus: strippedBindingPromptBindingArchive?.status || null,
    strippedBindingPromptBindingArchiveBlockers: blockerCodes(strippedBindingPromptBindingArchive),
    blockers,
  };
}

function tamperedBundleFrom(bundle) {
  const tampered = cloneJson(bundle);
  tampered.hashBinding = {
    ...(tampered.hashBinding || {}),
    ledgerHash: 'sha256:tampered-post-action-audit-archive-matrix-ledger',
  };
  return tampered;
}

export function buildPostActionAuditArchiveMatrixReport({ generatedAt = new Date().toISOString() } = {}) {
  const {
    runtimeReport,
    postActionEvidenceMatrix,
    records,
  } = buildPostActionAuditBundleMatrixRecords();
  const postActionAuditBundleMatrix = buildPostActionAuditBundleMatrixReport({ generatedAt: FIXED_CREATED_AT });
  const bundles = records.map((record) => record.auditBundle);
  const aggregateArchive = archiveForBundles({
    bundles,
    archiveRole: 'post_action_all_routes_audit_archive',
    actor: 'post-action-audit-archive-matrix.aggregate',
  });
  const duplicateArchive = archiveForBundles({
    bundles: bundles.length ? [bundles[0], bundles[0]] : [],
    archiveRole: 'post_action_duplicate_archive_probe',
    actor: 'post-action-audit-archive-matrix.duplicate-probe',
  });
  const tamperedArchive = archiveForBundles({
    bundles: bundles.length ? [tamperedBundleFrom(bundles[0])] : [],
    archiveRole: 'post_action_tampered_archive_probe',
    actor: 'post-action-audit-archive-matrix.tampered-probe',
  });
  const emptyArchive = archiveForBundles({
    bundles: [],
    archiveRole: 'post_action_empty_archive_probe',
    actor: 'post-action-audit-archive-matrix.empty-probe',
  });
  const rows = records.map(rowForRecord);
  const blockers = [
    ...(runtimeReport.ok === true ? [] : [issue('runtime_dry_run_harness_not_ready')]),
    ...(postActionEvidenceMatrix.ok === true ? [] : [issue('post_action_evidence_matrix_not_ready')]),
    ...(postActionAuditBundleMatrix.ok === true ? [] : [issue('post_action_audit_bundle_matrix_not_ready')]),
    ...rows.flatMap((row) => row.blockers),
  ];

  if (aggregateArchive.status !== 'ready_external_action_audit_archive' || aggregateArchive.ready !== true) {
    blockers.push(issue('aggregate_archive_not_ready'));
  }
  if (aggregateArchive.summary.count !== records.length) {
    blockers.push(issue('aggregate_archive_entry_count_mismatch', `${aggregateArchive.summary.count}/${records.length}`));
  }
  if (aggregateArchive.summary.verifiedCount !== records.length) {
    blockers.push(issue('aggregate_archive_verified_count_mismatch', `${aggregateArchive.summary.verifiedCount}/${records.length}`));
  }
  if (duplicateArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('duplicate_archive_not_blocked'));
  }
  if (!duplicateArchive.blockers.some((item) => item.code === 'duplicate_audit_bundle_hash')) {
    blockers.push(issue('duplicate_bundle_hash_not_detected'));
  }
  if (!duplicateArchive.blockers.some((item) => item.code === 'duplicate_ledger_hash')) {
    blockers.push(issue('duplicate_ledger_hash_not_detected'));
  }
  if (tamperedArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('tampered_archive_not_blocked'));
  }
  if (!tamperedArchive.blockers.some((item) => item.code === 'audit_bundle_hash_content_mismatch')) {
    blockers.push(issue('tampered_bundle_hash_mismatch_not_detected'));
  }
  if (emptyArchive.status !== 'blocked_external_action_audit_archive') {
    blockers.push(issue('empty_archive_not_blocked'));
  }

  const actionClasses = uniqueStrings(rows.map((row) => row.action), 32);
  const summary = {
    routeCount: rows.length,
    actionClassCount: actionClasses.length,
    actionClasses,
    aggregateArchiveStatus: aggregateArchive.status,
    aggregateArchiveEntries: aggregateArchive.summary.count,
    aggregateVerifiedEntries: aggregateArchive.summary.verifiedCount,
    aggregateApprovalProvenanceHashBoundEntries: aggregateArchive.summary.approvalProvenanceHashBoundCount,
    aggregateCustomerMessagePreviewHashBoundEntries: aggregateArchive.summary.customerMessagePreviewHashBoundCount,
    aggregateHumanFeedbackContractBoundEntries: aggregateArchive.summary.humanFeedbackContractBoundCount,
    aggregateBundleHashes: aggregateArchive.summary.bundleHashes.length,
    aggregateLedgerHashes: aggregateArchive.summary.ledgerHashes.length,
    archivedActionIds: uniqueStrings(aggregateArchive.entries.map((entry) => entry.actionId), 64).length,
    archivedChannels: uniqueStrings(aggregateArchive.entries.map((entry) => entry.channelId), 16).length,
    packageRoleRouteCount: rows.filter((row) => row.packageRole).length,
    perRouteArchiveReadyCount: rows.filter((row) => row.archiveStatus === 'ready_external_action_audit_archive').length,
    humanFeedbackPackageRoleBoundRouteCount: rows.filter((row) => (
      row.humanFeedbackRevisionContractHash && row.packageRole
    )).length,
    strippedPayloadApprovalProvenanceArchiveBlockedCount: rows.filter((row) => row.strippedPayloadApprovalProvenanceArchiveStatus === 'blocked_external_action_audit_archive').length,
    strippedBindingApprovalProvenanceArchiveBlockedCount: rows.filter((row) => row.strippedBindingApprovalProvenanceArchiveStatus === 'blocked_external_action_audit_archive').length,
    rawBundleArchiveBlockedCount: rows.filter((row) => row.rawBundleArchiveStatus === 'blocked_external_action_audit_archive').length,
    missingTransitionArchiveBlockedCount: rows.filter((row) => row.missingTransitionArchiveStatus === 'blocked_external_action_audit_archive').length,
    strippedPayloadMessageHashArchiveBlockedCount: rows.filter((row) => row.strippedPayloadMessageHashArchiveStatus === 'blocked_external_action_audit_archive').length,
    strippedBindingMessageHashArchiveBlockedCount: rows.filter((row) => row.strippedBindingMessageHashArchiveStatus === 'blocked_external_action_audit_archive').length,
    strippedPayloadContractHashArchiveBlockedCount: rows.filter((row) => row.strippedPayloadContractHashArchiveStatus === 'blocked_external_action_audit_archive').length,
    strippedBindingContractHashArchiveBlockedCount: rows.filter((row) => row.strippedBindingContractHashArchiveStatus === 'blocked_external_action_audit_archive').length,
    strippedPayloadPromptBindingArchiveBlockedCount: rows.filter((row) => row.strippedPayloadPromptBindingArchiveStatus === 'blocked_external_action_audit_archive').length,
    strippedBindingPromptBindingArchiveBlockedCount: rows.filter((row) => row.strippedBindingPromptBindingArchiveStatus === 'blocked_external_action_audit_archive').length,
    duplicateArchiveBlocked: duplicateArchive.status === 'blocked_external_action_audit_archive',
    duplicateArchiveBlockers: blockerCodes(duplicateArchive),
    tamperedArchiveBlocked: tamperedArchive.status === 'blocked_external_action_audit_archive',
    tamperedArchiveBlockers: blockerCodes(tamperedArchive),
    emptyArchiveBlocked: emptyArchive.status === 'blocked_external_action_audit_archive',
    emptyArchiveBlockers: blockerCodes(emptyArchive),
    routeBlockerCount: rows.reduce((sum, row) => sum + row.blockers.length, 0),
  };
  if (summary.routeCount !== 20) blockers.push(issue('post_action_audit_archive_matrix_route_count_unexpected', `${summary.routeCount}/20`));
  if (summary.actionClassCount !== 7) blockers.push(issue('post_action_audit_archive_matrix_action_class_count_unexpected', `${summary.actionClassCount}/7`));
  if (summary.packageRoleRouteCount !== rows.length) blockers.push(issue('post_action_audit_archive_package_role_not_bound', `${summary.packageRoleRouteCount}/${rows.length}`));
  if (summary.aggregateApprovalProvenanceHashBoundEntries !== rows.length) blockers.push(issue(
    'post_action_audit_archive_approval_provenance_hash_not_bound',
    `${summary.aggregateApprovalProvenanceHashBoundEntries}/${rows.length}`,
  ));
  const customerMessageRows = rows.filter((row) => canonicalExternalAction(row.action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE);
  const humanFeedbackRows = rows.filter((row) => row.humanFeedbackRevisionContractHash);
  const promptGenerationRows = rows.filter((row) => (
    row.strippedPayloadPromptBindingArchiveStatus || row.strippedBindingPromptBindingArchiveStatus
  ));
  if (summary.strippedPayloadApprovalProvenanceArchiveBlockedCount !== rows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_payload_approval_provenance_not_blocked',
    `${summary.strippedPayloadApprovalProvenanceArchiveBlockedCount}/${rows.length}`,
  ));
  if (summary.strippedBindingApprovalProvenanceArchiveBlockedCount !== rows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_binding_approval_provenance_not_blocked',
    `${summary.strippedBindingApprovalProvenanceArchiveBlockedCount}/${rows.length}`,
  ));
  if (summary.aggregateCustomerMessagePreviewHashBoundEntries !== customerMessageRows.length) blockers.push(issue(
    'post_action_audit_archive_customer_message_preview_hash_not_bound',
    `${summary.aggregateCustomerMessagePreviewHashBoundEntries}/${customerMessageRows.length}`,
  ));
  if (summary.aggregateHumanFeedbackContractBoundEntries !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_archive_human_feedback_contract_hash_not_bound',
    `${summary.aggregateHumanFeedbackContractBoundEntries}/${humanFeedbackRows.length}`,
  ));
  if (summary.humanFeedbackPackageRoleBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_archive_human_feedback_package_role_not_bound',
    `${summary.humanFeedbackPackageRoleBoundRouteCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadMessageHashArchiveBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_payload_message_hash_not_blocked',
    `${summary.strippedPayloadMessageHashArchiveBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedBindingMessageHashArchiveBlockedCount !== customerMessageRows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_binding_message_hash_not_blocked',
    `${summary.strippedBindingMessageHashArchiveBlockedCount}/${customerMessageRows.length}`,
  ));
  if (summary.strippedPayloadContractHashArchiveBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_payload_contract_hash_not_blocked',
    `${summary.strippedPayloadContractHashArchiveBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedBindingContractHashArchiveBlockedCount !== humanFeedbackRows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_binding_contract_hash_not_blocked',
    `${summary.strippedBindingContractHashArchiveBlockedCount}/${humanFeedbackRows.length}`,
  ));
  if (summary.strippedPayloadPromptBindingArchiveBlockedCount !== promptGenerationRows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_payload_prompt_binding_not_blocked',
    `${summary.strippedPayloadPromptBindingArchiveBlockedCount}/${promptGenerationRows.length}`,
  ));
  if (summary.strippedBindingPromptBindingArchiveBlockedCount !== promptGenerationRows.length) blockers.push(issue(
    'post_action_audit_archive_stripped_binding_prompt_binding_not_blocked',
    `${summary.strippedBindingPromptBindingArchiveBlockedCount}/${promptGenerationRows.length}`,
  ));

  const status = blockers.length
    ? POST_ACTION_AUDIT_ARCHIVE_MATRIX_STATUS.FAIL
    : POST_ACTION_AUDIT_ARCHIVE_MATRIX_STATUS.PASS;
  const archiveMatrixHash = digest({
    version: POST_ACTION_AUDIT_ARCHIVE_MATRIX_VERSION,
    status,
    summary,
    rows: rows.map((row) => ({
      scenarioId: row.scenarioId,
      channelId: row.channelId,
      actionId: row.actionId,
      action: row.action,
      productLineId: row.productLineId,
      workflowId: row.workflowId,
      packageRole: row.packageRole,
      approvalProvenanceHash: row.approvalProvenanceHash,
      messagePreviewHash: row.messagePreviewHash,
      humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
      archiveStatus: row.archiveStatus,
      rawBundleArchiveStatus: row.rawBundleArchiveStatus,
      rawBundleArchiveBlockers: row.rawBundleArchiveBlockers,
      missingTransitionArchiveStatus: row.missingTransitionArchiveStatus,
      missingTransitionArchiveBlockers: row.missingTransitionArchiveBlockers,
      strippedPayloadApprovalProvenanceArchiveStatus: row.strippedPayloadApprovalProvenanceArchiveStatus,
      strippedBindingApprovalProvenanceArchiveStatus: row.strippedBindingApprovalProvenanceArchiveStatus,
      strippedPayloadMessageHashArchiveStatus: row.strippedPayloadMessageHashArchiveStatus,
      strippedBindingMessageHashArchiveStatus: row.strippedBindingMessageHashArchiveStatus,
      strippedPayloadContractHashArchiveStatus: row.strippedPayloadContractHashArchiveStatus,
      strippedBindingContractHashArchiveStatus: row.strippedBindingContractHashArchiveStatus,
      strippedPayloadPromptBindingArchiveStatus: row.strippedPayloadPromptBindingArchiveStatus,
      strippedBindingPromptBindingArchiveStatus: row.strippedBindingPromptBindingArchiveStatus,
      blockerCodes: row.blockers.map((item) => item.code),
    })),
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionAuditBundleMatrixHash: postActionAuditBundleMatrix.postActionAuditBundleMatrixHash,
    aggregateArchiveHash: aggregateArchive.archiveHash,
    blockers,
  });

  return {
    version: POST_ACTION_AUDIT_ARCHIVE_MATRIX_VERSION,
    kind: 'PostActionAuditArchiveMatrixReport',
    status,
    ok: blockers.length === 0,
    generatedAt,
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: postActionEvidenceMatrix.postActionEvidenceMatrixHash,
    postActionAuditBundleMatrixHash: postActionAuditBundleMatrix.postActionAuditBundleMatrixHash,
    aggregateArchiveHash: aggregateArchive.archiveHash,
    duplicateArchiveHash: duplicateArchive.archiveHash,
    tamperedArchiveHash: tamperedArchive.archiveHash,
    emptyArchiveHash: emptyArchive.archiveHash,
    summary,
    rows,
    blockers,
    safety: {
      syntheticFixturesOnly: true,
      archiveIndexOnly: true,
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
      mutatesArchiveStore: false,
      grantsExecutionPermission: false,
    },
    postActionAuditArchiveMatrixHash: archiveMatrixHash,
    hash: archiveMatrixHash,
  };
}
