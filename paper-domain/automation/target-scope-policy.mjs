import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function unique(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

export function buildTargetScopeReceipt({
  mode,
  execute = false,
  requestedPaperIds = [],
  selectedTasks = [],
  inventorySource = null,
  inventoryFallback = null,
  limit = null,
  requireExplicitScope = false,
} = {}) {
  const requested = unique(requestedPaperIds);
  const selected = unique(selectedTasks.map((task) => task?.paperId));
  const selectedTaskBindings = selectedTasks.map((task) => ({
    paperId: task?.paperId || null,
    taskHash: task?.taskHash || null,
    paperQualityProfile: task?.paperQualityProfile || null,
  })).sort((left, right) => String(left.paperId).localeCompare(String(right.paperId)));
  const missingRequestedPaperIds = requested.filter((paperId) => !selected.includes(paperId));
  const blockers = [];
  if (!selected.length) blockers.push('target_scope_empty');
  if (missingRequestedPaperIds.length) blockers.push(...missingRequestedPaperIds.map((paperId) => `target_scope_requested_paper_missing:${paperId}`));
  if (requireExplicitScope && !requested.length) blockers.push('target_scope_explicit_paper_ids_required');
  if (execute && inventoryFallback) blockers.push(`target_scope_inventory_fallback_forbidden:${inventoryFallback}`);
  if (limit && selected.length === Number(limit) && !requested.length) blockers.push('target_scope_limit_truncation_requires_explicit_ids');
  const scopeSubject = {
    mode: mode || null,
    requestedPaperIds: requested,
    selectedPaperIds: selected,
    inventorySource: inventorySource || null,
    inventoryFallback: inventoryFallback || null,
    selectedTaskBindings,
  };
  const payload = {
    version: 1,
    kind: 'TargetScopeReceipt',
    status: blockers.length ? 'target_scope_blocked' : 'target_scope_verified',
    execute: Boolean(execute),
    ...scopeSubject,
    targetPaperCount: selected.length,
    targetScopeHash: hashRecord('TargetScopeSubject', scopeSubject),
    missingRequestedPaperIds,
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, targetScopeReceiptHash: hashRecord('TargetScopeReceipt', payload) });
}
