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
import {
  buildPostActionDispatchCompletionMatrixRecords,
  buildPostActionDispatchCompletionMatrixReport,
} from './post-action-dispatch-completion-matrix.mjs';
import { digest } from './hash-utils.mjs';

export const POST_ACTION_RECONCILIATION_MATRIX_VERSION = 1;

export const POST_ACTION_RECONCILIATION_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_post_action_reconciliation_matrix',
  FAIL: 'fail_post_action_reconciliation_matrix',
});

const FIXED_CREATED_AT = '2026-06-08T10:05:00.000Z';

const EXPECTED_ROUTE_COUNT = 20;
const EXPECTED_ACTION_CLASS_COUNT = 7;

const DISPATCH_CHAIN_KEYS = Object.freeze([
  'dispatchEnvelopeHash',
  'dispatchOutboxHash',
  'dispatchReplayGuardHash',
  'dispatchArchiveHash',
  'dispatchReceiptInboxHash',
  'dispatchProofInboxHash',
  'dispatchTransitionInboxHash',
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
    notes: normalizeText(notes || '') || null,
  };
}

function token(value) {
  return normalizeText(value || '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashOf(value, key) {
  return normalizeText(value?.[key] || '') || null;
}

function routeKey(value) {
  return [
    normalizeText(value?.channelId || ''),
    normalizeText(value?.actionId || ''),
    normalizeText(canonicalActionOrNull(value?.action) || ''),
    normalizeText(canonicalProductLineOrNull(value?.productLineId) || ''),
    normalizeText(canonicalProductLineOrNull(value?.workflowId) || ''),
  ].join('::');
}

function archiveEntryForRoute(archive, row) {
  const key = routeKey(row);
  return (archive?.entries || []).find((entry) => routeKey(entry) === key) || null;
}

function perRouteEntryForRoute(perRouteArchive, row) {
  return archiveEntryForRoute(perRouteArchive, row);
}

function bundleBinding(row, key) {
  return normalizeText(row?.auditBundle?.hashBinding?.[key] || '') || null;
}

function ledgerChain(row, key) {
  return normalizeText(row?.ledger?.chain?.[key] || '') || null;
}

function matches(left, right) {
  return Boolean(left && right && left === right);
}

function samePromptGenerationBinding(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const keys = uniqueStrings([...Object.keys(left), ...Object.keys(right)], 32);
  return keys.every((key) => normalizeText(left[key] || '') === normalizeText(right[key] || ''));
}

function promptGenerationBindingComplete(binding = null) {
  return Boolean(binding)
    && PROMPT_GENERATION_BINDING_KEYS.every((key) => normalizeText(binding?.[key] || ''));
}

function fieldCode(key) {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function compareField({ blockers, actual, expected, code, notes }) {
  const normalizedActual = normalizeText(actual || '');
  const normalizedExpected = normalizeText(expected || '');
  if (!normalizedActual || !normalizedExpected || normalizedActual !== normalizedExpected) {
    blockers.push(issue(code, notes || `${normalizedActual || 'missing'} != ${normalizedExpected || 'missing'}`));
  }
}

function dispatchChainComplete(entry, row) {
  if (entry?.usesDispatchInboxChain !== true) return false;
  return DISPATCH_CHAIN_KEYS.every((key) => normalizeText(entry?.[key] || '') === normalizeText(rowValueForKey(row, key) || ''));
}

function rowValueForKey(row, key) {
  if (key === 'dispatchOutboxHash') return bundleBinding(row, key) || ledgerChain(row, key);
  if (key === 'dispatchReplayGuardHash') return bundleBinding(row, key) || ledgerChain(row, key);
  if (key === 'dispatchArchiveHash') return bundleBinding(row, key) || ledgerChain(row, key);
  return normalizeText(row?.[key] || bundleBinding(row, key) || ledgerChain(row, key) || '') || null;
}

function archiveEntryMatchesRow({ entry, row, scope, blockers }) {
  if (!entry) {
    blockers.push(issue(`${scope}_archive_entry_missing`, row.scenarioId));
    return {
      entryMatched: false,
      dispatchChainMatched: false,
    };
  }

  compareField({
    blockers,
    actual: entry.bundleHash,
    expected: row.bundleHash,
    code: `${scope}_bundle_hash_mismatch`,
    notes: row.scenarioId,
  });
  compareField({
    blockers,
    actual: entry.ledgerHash,
    expected: row.ledgerHash,
    code: `${scope}_ledger_hash_mismatch`,
    notes: row.scenarioId,
  });
  compareField({
    blockers,
    actual: entry.channelId,
    expected: row.channelId,
    code: `${scope}_channel_id_mismatch`,
    notes: row.scenarioId,
  });
  compareField({
    blockers,
    actual: entry.actionId,
    expected: row.actionId,
    code: `${scope}_action_id_mismatch`,
    notes: row.scenarioId,
  });
  compareField({
    blockers,
    actual: entry.action,
    expected: row.action,
    code: `${scope}_action_mismatch`,
    notes: row.scenarioId,
  });
  if (row.productLineId) {
    compareField({
      blockers,
      actual: entry.productLineId,
      expected: row.productLineId,
      code: `${scope}_product_line_id_mismatch`,
      notes: row.scenarioId,
    });
  }
  if (row.workflowId) {
    compareField({
      blockers,
      actual: entry.workflowId,
      expected: row.workflowId,
      code: `${scope}_workflow_id_mismatch`,
      notes: row.scenarioId,
    });
  }
  if (row.packageRole) {
    compareField({
      blockers,
      actual: entry.packageRole,
      expected: row.packageRole,
      code: `${scope}_package_role_mismatch`,
      notes: row.scenarioId,
    });
  }
  if (row.messagePreviewHash) {
    compareField({
      blockers,
      actual: entry.messagePreviewHash,
      expected: row.messagePreviewHash,
      code: `${scope}_message_preview_hash_mismatch`,
      notes: row.scenarioId,
    });
  }
  if (row.humanFeedbackRevisionContractHash) {
    compareField({
      blockers,
      actual: entry.humanFeedbackRevisionContractHash,
      expected: row.humanFeedbackRevisionContractHash,
      code: `${scope}_human_feedback_contract_hash_mismatch`,
      notes: row.scenarioId,
    });
  }
  if (promptGenerationBindingComplete(row.promptGenerationBinding)) {
    if (!samePromptGenerationBinding(entry.promptGenerationBinding, row.promptGenerationBinding)) {
      blockers.push(issue(`${scope}_prompt_generation_binding_mismatch`, row.scenarioId));
    }
    if (!samePromptGenerationBinding(entry.promptGenerationBindingHashBinding, row.promptGenerationBinding)) {
      blockers.push(issue(`${scope}_prompt_generation_hash_binding_mismatch`, row.scenarioId));
    }
  }
  if (entry.verified !== true || entry.status !== 'verified_action_audit_bundle') {
    blockers.push(issue(`${scope}_entry_not_verified`, row.scenarioId));
  }
  if (entry.usesDispatchInboxChain !== true) {
    blockers.push(issue(`${scope}_dispatch_chain_missing`, row.scenarioId));
  }
  for (const key of DISPATCH_CHAIN_KEYS) {
    compareField({
      blockers,
      actual: entry[key],
      expected: rowValueForKey(row, key),
      code: `${scope}_${fieldCode(key)}_mismatch`,
      notes: row.scenarioId,
    });
  }

  return {
    entryMatched: matches(entry.bundleHash, row.bundleHash)
      && matches(entry.ledgerHash, row.ledgerHash)
      && matches(entry.channelId, row.channelId)
      && matches(entry.actionId, row.actionId)
      && matches(entry.action, row.action),
    dispatchChainMatched: dispatchChainComplete(entry, row),
  };
}

function bundleAndLedgerMatch(row, blockers) {
  const bundle = row.auditBundle;
  const ledger = row.ledger;
  if (bundle?.status !== 'verified_action_audit_bundle' || bundle?.verified !== true) {
    blockers.push(issue('reconciliation_audit_bundle_not_verified', row.scenarioId));
  }
  if (ledger?.status !== 'verified_action_ledger' || ledger?.verified !== true) {
    blockers.push(issue('reconciliation_ledger_not_verified', row.scenarioId));
  }
  compareField({
    blockers,
    actual: bundleBinding(row, 'ledgerHash'),
    expected: row.ledgerHash,
    code: 'reconciliation_bundle_ledger_hash_mismatch',
    notes: row.scenarioId,
  });
  compareField({
    blockers,
    actual: hashOf(bundle, 'bundleHash'),
    expected: row.bundleHash,
    code: 'reconciliation_bundle_hash_mismatch',
    notes: row.scenarioId,
  });
  for (const key of DISPATCH_CHAIN_KEYS) {
    compareField({
      blockers,
      actual: bundleBinding(row, key),
      expected: rowValueForKey(row, key),
      code: `reconciliation_bundle_${fieldCode(key)}_mismatch`,
      notes: row.scenarioId,
    });
    compareField({
      blockers,
      actual: ledgerChain(row, key),
      expected: rowValueForKey(row, key),
      code: `reconciliation_ledger_${fieldCode(key)}_mismatch`,
      notes: row.scenarioId,
    });
  }
  if (promptGenerationBindingComplete(row.promptGenerationBinding)) {
    if (!samePromptGenerationBinding(bundle?.hashBinding?.promptGenerationBinding, row.promptGenerationBinding)) {
      blockers.push(issue('reconciliation_bundle_prompt_generation_binding_mismatch', row.scenarioId));
    }
    if (!samePromptGenerationBinding(ledger?.chain?.promptGenerationBinding, row.promptGenerationBinding)) {
      blockers.push(issue('reconciliation_ledger_prompt_generation_binding_mismatch', row.scenarioId));
    }
  }
  return bundle?.status === 'verified_action_audit_bundle'
    && ledger?.status === 'verified_action_ledger'
    && matches(bundleBinding(row, 'ledgerHash'), row.ledgerHash)
    && matches(hashOf(bundle, 'bundleHash'), row.bundleHash);
}

function reconcileRow(row, aggregateArchive, overrides = {}) {
  const blockers = [];
  const archive = overrides.aggregateArchive || aggregateArchive;
  const perRouteArchive = overrides.perRouteArchive || row.perRouteArchive;
  const aggregateEntry = archiveEntryForRoute(archive, row);
  const perRouteEntry = perRouteEntryForRoute(perRouteArchive, row);

  if (archive?.status !== 'ready_external_action_audit_archive' || archive?.ready !== true) {
    blockers.push(issue('reconciliation_aggregate_archive_not_ready', row.scenarioId));
  }
  if (perRouteArchive?.status !== 'ready_external_action_audit_archive' || perRouteArchive?.ready !== true) {
    blockers.push(issue('reconciliation_per_route_archive_not_ready', row.scenarioId));
  }
  if (row.usesDispatchInboxChain !== true || row.dispatchChainHashesPresent !== true) {
    blockers.push(issue('reconciliation_completion_dispatch_chain_incomplete', row.scenarioId));
  }

  const aggregateMatch = archiveEntryMatchesRow({
    entry: aggregateEntry,
    row,
    scope: 'reconciliation_aggregate',
    blockers,
  });
  const perRouteMatch = archiveEntryMatchesRow({
    entry: perRouteEntry,
    row,
    scope: 'reconciliation_per_route',
    blockers,
  });
  const bundleLedgerMatched = bundleAndLedgerMatch(row, blockers);
  const ok = blockers.length === 0;

  return {
    scenarioId: row.scenarioId,
    channelId: row.channelId,
    actionId: row.actionId,
    action: canonicalActionOrNull(row.action),
    productLineId: canonicalProductLineOrNull(row.productLineId),
    workflowId: canonicalProductLineOrNull(row.workflowId),
    packageRole: canonicalPackageRole(row.packageRole || '') || null,
    messagePreviewHash: row.messagePreviewHash,
    humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
    promptGenerationBinding: row.promptGenerationBinding,
    ok,
    aggregateEntryMatched: aggregateMatch.entryMatched,
    perRouteEntryMatched: perRouteMatch.entryMatched,
    bundleLedgerMatched,
    aggregateDispatchChainMatched: aggregateMatch.dispatchChainMatched,
    perRouteDispatchChainMatched: perRouteMatch.dispatchChainMatched,
    dispatchChainMatched: aggregateMatch.dispatchChainMatched && perRouteMatch.dispatchChainMatched,
    blockerCodes: blockers.map((item) => item.code),
    blockers,
  };
}

function tamperAggregateEntry(row, aggregateArchive, mutateEntry) {
  const archive = cloneJson(aggregateArchive);
  archive.entries = (archive.entries || []).map((entry) => {
    if (routeKey(entry) !== routeKey(row)) return entry;
    return mutateEntry(entry);
  });
  return archive;
}

function missingAggregateArchive(row, aggregateArchive) {
  const archive = cloneJson(aggregateArchive);
  archive.entries = (archive.entries || []).filter((entry) => routeKey(entry) !== routeKey(row));
  archive.summary = {
    ...(archive.summary || {}),
    count: archive.entries.length,
    dispatchInboxChainCount: archive.entries.filter((entry) => entry.usesDispatchInboxChain === true).length,
  };
  return archive;
}

function rowMissingBundleDispatchSource(row, key) {
  const next = cloneJson(row);
  delete next.auditBundle.hashBinding[key];
  return next;
}

function rowMissingLedgerDispatchSource(row, key) {
  const next = cloneJson(row);
  delete next.ledger.chain[key];
  return next;
}

function negativeProbeForRow(row, aggregateArchive) {
  const suffix = token(row.scenarioId);
  const strippedBundleAliasRow = cloneJson(row);
  delete strippedBundleAliasRow.auditBundle.bundleHash;
  const strippedBundleAlias = reconcileRow(strippedBundleAliasRow, aggregateArchive);
  const missingAggregate = reconcileRow(row, missingAggregateArchive(row, aggregateArchive));
  const tamperedBundle = reconcileRow(row, tamperAggregateEntry(row, aggregateArchive, (entry) => ({
    ...entry,
    bundleHash: `sha256:tampered-reconciliation-bundle-${suffix}`,
  })));
  const missingDispatchChain = reconcileRow(row, tamperAggregateEntry(row, aggregateArchive, (entry) => ({
    ...entry,
    usesDispatchInboxChain: false,
    dispatchEnvelopeHash: null,
    dispatchReceiptInboxHash: null,
    dispatchProofInboxHash: null,
    dispatchTransitionInboxHash: null,
  })));
  const perRouteArchive = cloneJson(row.perRouteArchive);
  perRouteArchive.entries = (perRouteArchive.entries || []).map((entry) => ({
    ...entry,
    ledgerHash: `sha256:tampered-reconciliation-ledger-${suffix}`,
  }));
  const perRouteArchiveDrift = reconcileRow(row, aggregateArchive, { perRouteArchive });
  const humanFeedbackContractDrift = row.humanFeedbackRevisionContractHash
    ? reconcileRow(row, tamperAggregateEntry(row, aggregateArchive, (entry) => ({
      ...entry,
      humanFeedbackRevisionContractHash: `sha256:tampered-reconciliation-feedback-contract-${suffix}`,
    })))
    : null;
  const customerMessagePreviewHashDrift = row.messagePreviewHash
    ? reconcileRow(row, tamperAggregateEntry(row, aggregateArchive, (entry) => ({
      ...entry,
      messagePreviewHash: `sha256:tampered-reconciliation-message-preview-${suffix}`,
    })))
    : null;
  const packageRoleDrift = row.packageRole
    ? reconcileRow(row, tamperAggregateEntry(row, aggregateArchive, (entry) => ({
      ...entry,
      packageRole: row.packageRole === 'delivery' ? 'human_feedback_revision' : 'delivery',
    })))
    : null;
  const promptGenerationBindingDrift = promptGenerationBindingComplete(row.promptGenerationBinding)
    ? reconcileRow(row, tamperAggregateEntry(row, aggregateArchive, (entry) => ({
      ...entry,
      promptGenerationBinding: {
        ...entry.promptGenerationBinding,
        generationJobId: `tampered-reconciliation-prompt-generation-${suffix}`,
      },
    })))
    : null;
  const missingBundleDispatchSources = DISPATCH_CHAIN_KEYS.map((key) => ({
    key,
    result: reconcileRow(rowMissingBundleDispatchSource(row, key), aggregateArchive),
  }));
  const missingLedgerDispatchSources = DISPATCH_CHAIN_KEYS.map((key) => ({
    key,
    result: reconcileRow(rowMissingLedgerDispatchSource(row, key), aggregateArchive),
  }));

  return {
    scenarioId: row.scenarioId,
    strippedBundleAliasBlocked: strippedBundleAlias.ok === false
      && strippedBundleAlias.blockerCodes.includes('reconciliation_bundle_hash_mismatch'),
    missingAggregateEntryBlocked: missingAggregate.ok === false
      && missingAggregate.blockerCodes.includes('reconciliation_aggregate_archive_entry_missing'),
    tamperedBundleBlocked: tamperedBundle.ok === false
      && tamperedBundle.blockerCodes.includes('reconciliation_aggregate_bundle_hash_mismatch'),
    missingDispatchChainBlocked: missingDispatchChain.ok === false
      && missingDispatchChain.blockerCodes.includes('reconciliation_aggregate_dispatch_chain_missing'),
    perRouteArchiveDriftBlocked: perRouteArchiveDrift.ok === false
      && perRouteArchiveDrift.blockerCodes.includes('reconciliation_per_route_ledger_hash_mismatch'),
    humanFeedbackContractDriftBlocked: humanFeedbackContractDrift
      ? humanFeedbackContractDrift.ok === false
        && humanFeedbackContractDrift.blockerCodes.includes('reconciliation_aggregate_human_feedback_contract_hash_mismatch')
      : true,
    customerMessagePreviewHashDriftBlocked: customerMessagePreviewHashDrift
      ? customerMessagePreviewHashDrift.ok === false
        && customerMessagePreviewHashDrift.blockerCodes.includes('reconciliation_aggregate_message_preview_hash_mismatch')
      : true,
    packageRoleDriftBlocked: packageRoleDrift
      ? packageRoleDrift.ok === false
        && packageRoleDrift.blockerCodes.includes('reconciliation_aggregate_package_role_mismatch')
      : true,
    promptGenerationBindingDriftBlocked: promptGenerationBindingDrift
      ? promptGenerationBindingDrift.ok === false
        && promptGenerationBindingDrift.blockerCodes.includes('reconciliation_aggregate_prompt_generation_binding_mismatch')
      : true,
    missingBundleDispatchSourceBlocked: missingBundleDispatchSources.every(({ key, result }) => (
      result.ok === false
      && result.blockerCodes.includes(`reconciliation_bundle_${fieldCode(key)}_mismatch`)
    )),
    missingLedgerDispatchSourceBlocked: missingLedgerDispatchSources.every(({ key, result }) => (
      result.ok === false
      && result.blockerCodes.includes(`reconciliation_ledger_${fieldCode(key)}_mismatch`)
    )),
    blockerCodes: uniqueStrings([
      ...strippedBundleAlias.blockerCodes,
      ...missingAggregate.blockerCodes,
      ...tamperedBundle.blockerCodes,
      ...missingDispatchChain.blockerCodes,
      ...perRouteArchiveDrift.blockerCodes,
      ...(humanFeedbackContractDrift?.blockerCodes || []),
      ...(customerMessagePreviewHashDrift?.blockerCodes || []),
      ...(packageRoleDrift?.blockerCodes || []),
      ...(promptGenerationBindingDrift?.blockerCodes || []),
      ...missingBundleDispatchSources.flatMap(({ result }) => result.blockerCodes),
      ...missingLedgerDispatchSources.flatMap(({ result }) => result.blockerCodes),
    ], 64),
  };
}

function reportRows(rows) {
  return rows.map((row) => ({
    scenarioId: row.scenarioId,
    channelId: row.channelId,
    actionId: row.actionId,
    action: canonicalActionOrNull(row.action),
    productLineId: canonicalProductLineOrNull(row.productLineId),
    workflowId: canonicalProductLineOrNull(row.workflowId),
    packageRole: canonicalPackageRole(row.packageRole || '') || null,
    messagePreviewHash: row.messagePreviewHash,
    humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
    promptGenerationBinding: row.promptGenerationBinding,
    ok: row.ok,
    aggregateEntryMatched: row.aggregateEntryMatched,
    perRouteEntryMatched: row.perRouteEntryMatched,
    bundleLedgerMatched: row.bundleLedgerMatched,
    aggregateDispatchChainMatched: row.aggregateDispatchChainMatched,
    perRouteDispatchChainMatched: row.perRouteDispatchChainMatched,
    dispatchChainMatched: row.dispatchChainMatched,
    blockerCodes: row.blockerCodes,
  }));
}

export function buildPostActionReconciliationMatrixReport({ generatedAt = new Date().toISOString() } = {}) {
  const postActionDispatchCompletionMatrix = buildPostActionDispatchCompletionMatrixReport({ generatedAt: FIXED_CREATED_AT });
  const { aggregateArchive, rows } = buildPostActionDispatchCompletionMatrixRecords();
  const actionClasses = uniqueStrings(rows.map((row) => row.action), 32);
  const reconciliations = rows.map((row) => reconcileRow(row, aggregateArchive));
  const negativeProbes = rows.map((row) => negativeProbeForRow(row, aggregateArchive));
  const humanFeedbackContractRows = rows.filter((row) => row.humanFeedbackRevisionContractHash);
  const customerMessageHashRows = rows.filter((row) => row.messagePreviewHash);
  const packageRoleRows = rows.filter((row) => row.packageRole);
  const humanFeedbackPackageRoleRows = humanFeedbackContractRows.filter((row) => row.packageRole);
  const promptGenerationBindingRows = rows.filter((row) => promptGenerationBindingComplete(row.promptGenerationBinding));

  const summary = {
    routeCount: rows.length,
    actionClassCount: actionClasses.length,
    actionClasses,
    postActionDispatchCompletionMatrixHash: postActionDispatchCompletionMatrix.postActionDispatchCompletionMatrixHash,
    postActionDispatchCompletionMatrixOk: postActionDispatchCompletionMatrix.ok === true,
    aggregateArchiveHash: hashOf(aggregateArchive, 'archiveHash'),
    aggregateArchiveEntries: aggregateArchive.summary?.count || 0,
    aggregateDispatchInboxChainEntries: aggregateArchive.summary?.dispatchInboxChainCount || 0,
    reconciledRouteCount: reconciliations.filter((row) => row.ok).length,
    aggregateEntryMatchCount: reconciliations.filter((row) => row.aggregateEntryMatched).length,
    perRouteArchiveMatchCount: reconciliations.filter((row) => row.perRouteEntryMatched).length,
    bundleLedgerMatchCount: reconciliations.filter((row) => row.bundleLedgerMatched).length,
    aggregateDispatchChainMatchCount: reconciliations.filter((row) => row.aggregateDispatchChainMatched).length,
    perRouteDispatchChainMatchCount: reconciliations.filter((row) => row.perRouteDispatchChainMatched).length,
    dispatchChainMatchCount: reconciliations.filter((row) => row.dispatchChainMatched).length,
    strippedBundleAliasBlockedCount: negativeProbes.filter((probe) => probe.strippedBundleAliasBlocked).length,
    missingAggregateEntryBlockedCount: negativeProbes.filter((probe) => probe.missingAggregateEntryBlocked).length,
    tamperedBundleBlockedCount: negativeProbes.filter((probe) => probe.tamperedBundleBlocked).length,
    missingDispatchChainBlockedCount: negativeProbes.filter((probe) => probe.missingDispatchChainBlocked).length,
    missingBundleDispatchSourceBlockedCount: negativeProbes.filter((probe) => probe.missingBundleDispatchSourceBlocked).length,
    missingLedgerDispatchSourceBlockedCount: negativeProbes.filter((probe) => probe.missingLedgerDispatchSourceBlocked).length,
    perRouteArchiveDriftBlockedCount: negativeProbes.filter((probe) => probe.perRouteArchiveDriftBlocked).length,
    customerMessageHashRouteCount: customerMessageHashRows.length,
    customerMessageHashDriftBlockedCount: negativeProbes.filter((probe) => (
      customerMessageHashRows.some((row) => row.scenarioId === probe.scenarioId)
      && probe.customerMessagePreviewHashDriftBlocked
    )).length,
    humanFeedbackContractRouteCount: humanFeedbackContractRows.length,
    humanFeedbackPackageRoleBoundRouteCount: humanFeedbackPackageRoleRows.length,
    humanFeedbackContractDriftBlockedCount: negativeProbes.filter((probe) => (
      humanFeedbackContractRows.some((row) => row.scenarioId === probe.scenarioId)
      && probe.humanFeedbackContractDriftBlocked
    )).length,
    packageRoleRouteCount: packageRoleRows.length,
    packageRoleDriftBlockedCount: negativeProbes.filter((probe) => (
      packageRoleRows.some((row) => row.scenarioId === probe.scenarioId)
      && probe.packageRoleDriftBlocked
    )).length,
    promptGenerationBindingRouteCount: promptGenerationBindingRows.length,
    promptGenerationBindingDriftBlockedCount: negativeProbes.filter((probe) => (
      promptGenerationBindingRows.some((row) => row.scenarioId === probe.scenarioId)
      && probe.promptGenerationBindingDriftBlocked
    )).length,
    routeBlockerCount: reconciliations.reduce((sum, row) => sum + row.blockers.length, 0),
  };

  const blockers = [
    ...(postActionDispatchCompletionMatrix.ok === true ? [] : [issue('post_action_dispatch_completion_matrix_not_ready')]),
    ...(postActionDispatchCompletionMatrix.postActionDispatchCompletionMatrixHash ? [] : [issue('post_action_dispatch_completion_matrix_hash_missing')]),
    ...(postActionDispatchCompletionMatrix.aggregateArchiveHash === hashOf(aggregateArchive, 'archiveHash') ? [] : [issue('post_action_reconciliation_aggregate_archive_hash_mismatch')]),
    ...(aggregateArchive.status === 'ready_external_action_audit_archive' ? [] : [issue('post_action_reconciliation_aggregate_archive_not_ready')]),
    ...reconciliations.flatMap((row) => row.blockers),
  ];
  if (summary.routeCount !== EXPECTED_ROUTE_COUNT) blockers.push(issue('post_action_reconciliation_matrix_route_count_unexpected', `${summary.routeCount}/${EXPECTED_ROUTE_COUNT}`));
  if (summary.actionClassCount !== EXPECTED_ACTION_CLASS_COUNT) blockers.push(issue('post_action_reconciliation_matrix_action_class_count_unexpected', `${summary.actionClassCount}/${EXPECTED_ACTION_CLASS_COUNT}`));
  if (summary.aggregateArchiveEntries !== rows.length) blockers.push(issue('post_action_reconciliation_aggregate_entry_count_mismatch', `${summary.aggregateArchiveEntries}/${rows.length}`));
  if (summary.aggregateDispatchInboxChainEntries !== rows.length) blockers.push(issue('post_action_reconciliation_aggregate_dispatch_chain_count_mismatch', `${summary.aggregateDispatchInboxChainEntries}/${rows.length}`));
  if (summary.reconciledRouteCount !== rows.length) blockers.push(issue('post_action_reconciliation_matrix_routes_not_reconciled', `${summary.reconciledRouteCount}/${rows.length}`));
  if (summary.strippedBundleAliasBlockedCount !== rows.length) blockers.push(issue('post_action_reconciliation_stripped_bundle_alias_probe_not_blocked', `${summary.strippedBundleAliasBlockedCount}/${rows.length}`));
  if (summary.missingAggregateEntryBlockedCount !== rows.length) blockers.push(issue('post_action_reconciliation_missing_aggregate_probe_not_blocked', `${summary.missingAggregateEntryBlockedCount}/${rows.length}`));
  if (summary.tamperedBundleBlockedCount !== rows.length) blockers.push(issue('post_action_reconciliation_tampered_bundle_probe_not_blocked', `${summary.tamperedBundleBlockedCount}/${rows.length}`));
  if (summary.missingDispatchChainBlockedCount !== rows.length) blockers.push(issue('post_action_reconciliation_missing_dispatch_chain_probe_not_blocked', `${summary.missingDispatchChainBlockedCount}/${rows.length}`));
  if (summary.missingBundleDispatchSourceBlockedCount !== rows.length) blockers.push(issue('post_action_reconciliation_missing_bundle_dispatch_source_probe_not_blocked', `${summary.missingBundleDispatchSourceBlockedCount}/${rows.length}`));
  if (summary.missingLedgerDispatchSourceBlockedCount !== rows.length) blockers.push(issue('post_action_reconciliation_missing_ledger_dispatch_source_probe_not_blocked', `${summary.missingLedgerDispatchSourceBlockedCount}/${rows.length}`));
  if (summary.perRouteArchiveDriftBlockedCount !== rows.length) blockers.push(issue('post_action_reconciliation_per_route_archive_probe_not_blocked', `${summary.perRouteArchiveDriftBlockedCount}/${rows.length}`));
  if (summary.customerMessageHashDriftBlockedCount !== customerMessageHashRows.length) blockers.push(issue(
    'post_action_reconciliation_customer_message_hash_probe_not_blocked',
    `${summary.customerMessageHashDriftBlockedCount}/${customerMessageHashRows.length}`,
  ));
  if (summary.humanFeedbackContractDriftBlockedCount !== humanFeedbackContractRows.length) blockers.push(issue(
    'post_action_reconciliation_human_feedback_contract_probe_not_blocked',
    `${summary.humanFeedbackContractDriftBlockedCount}/${humanFeedbackContractRows.length}`,
  ));
  if (summary.humanFeedbackPackageRoleBoundRouteCount !== humanFeedbackContractRows.length) blockers.push(issue(
    'post_action_reconciliation_human_feedback_package_role_not_bound',
    `${summary.humanFeedbackPackageRoleBoundRouteCount}/${humanFeedbackContractRows.length}`,
  ));
  if (summary.packageRoleDriftBlockedCount !== packageRoleRows.length) blockers.push(issue(
    'post_action_reconciliation_package_role_probe_not_blocked',
    `${summary.packageRoleDriftBlockedCount}/${packageRoleRows.length}`,
  ));
  if (summary.promptGenerationBindingDriftBlockedCount !== promptGenerationBindingRows.length) blockers.push(issue(
    'post_action_reconciliation_prompt_generation_binding_probe_not_blocked',
    `${summary.promptGenerationBindingDriftBlockedCount}/${promptGenerationBindingRows.length}`,
  ));

  const status = blockers.length
    ? POST_ACTION_RECONCILIATION_MATRIX_STATUS.FAIL
    : POST_ACTION_RECONCILIATION_MATRIX_STATUS.PASS;
  const postActionReconciliationMatrixHash = digest({
    version: POST_ACTION_RECONCILIATION_MATRIX_VERSION,
    status,
    summary,
    rows: reportRows(reconciliations),
    negativeProbes,
    postActionDispatchCompletionMatrixHash: postActionDispatchCompletionMatrix.postActionDispatchCompletionMatrixHash,
    aggregateArchiveHash: hashOf(aggregateArchive, 'archiveHash'),
    blockers,
  });

  return {
    version: POST_ACTION_RECONCILIATION_MATRIX_VERSION,
    kind: 'PostActionReconciliationMatrixReport',
    status,
    ok: blockers.length === 0,
    generatedAt,
    postActionDispatchCompletionMatrixHash: postActionDispatchCompletionMatrix.postActionDispatchCompletionMatrixHash,
    aggregateArchiveHash: hashOf(aggregateArchive, 'archiveHash'),
    postActionReconciliationMatrixHash,
    summary,
    rows: reportRows(reconciliations),
    negativeProbes,
    blockers,
    safety: {
      syntheticFixturesOnly: true,
      reconciliationEvidenceOnly: true,
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
      consumesQueue: false,
      acknowledgesDispatchCompletion: false,
      grantsExecutionPermission: false,
    },
    hash: postActionReconciliationMatrixHash,
  };
}
