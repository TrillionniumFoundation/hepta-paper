import { normalizeText } from './contracts.mjs';

export const DISPATCH_READINESS_OPERATOR_HINTS_VERSION = 1;

export const DISPATCH_READINESS_OPERATOR_HINT_CATALOG = Object.freeze([
  {
    code: 'external_runner_inspect_and_recheck',
    level: 'warning',
    category: 'external_runner_recheck',
    title: 'External runner must re-check',
    notes: 'Ready means descriptor-compatible only; the external runner must still re-check approval, evidence, replay guard, and channel state.',
    allowedScope: 'external_runner_recheck',
  },
  {
    code: 'refresh_runner_registry',
    level: 'error',
    category: 'runner_registry',
    title: 'Refresh runner registry',
    notes: 'Rebuild or inspect the runner registry before handoff.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebuild_runner_registry_hash',
    level: 'error',
    category: 'runner_registry',
    title: 'Rebuild registry hash',
    notes: 'The registry descriptor must carry a hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'select_supported_runner_route',
    level: 'error',
    category: 'runner_selection',
    title: 'Select supported runner route',
    notes: 'Select a ready runner for the dispatch channel/action.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebuild_runner_selection_hash',
    level: 'error',
    category: 'runner_selection',
    title: 'Rebuild runner selection hash',
    notes: 'The runner selection descriptor must carry a hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'reselect_runner_from_current_registry',
    level: 'error',
    category: 'runner_selection',
    title: 'Reselect from current registry',
    notes: 'Selection must bind to the current registry hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'refresh_dispatch_envelope_after_replay_guard',
    level: 'error',
    category: 'dispatch_envelope',
    title: 'Refresh dispatch envelope',
    notes: 'Rebuild the dispatch envelope after the replay guard is clear.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebuild_dispatch_envelope_hash',
    level: 'error',
    category: 'dispatch_envelope',
    title: 'Rebuild dispatch envelope hash',
    notes: 'The dispatch envelope must carry a hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'restore_required_handoff_hashes',
    level: 'error',
    category: 'dispatch_envelope',
    title: 'Restore required handoff hashes',
    notes: 'Outbox, replay, manifest, preview, approval, and evidence hashes are required.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebuild_dispatch_assignment',
    level: 'error',
    category: 'dispatch_assignment',
    title: 'Rebuild dispatch assignment',
    notes: 'Rebuild assignment after envelope, runner, or selection blockers are fixed.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebuild_dispatch_assignment_hash',
    level: 'error',
    category: 'dispatch_assignment',
    title: 'Rebuild dispatch assignment hash',
    notes: 'The assignment descriptor must carry a hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebind_assignment_to_dispatch_envelope',
    level: 'error',
    category: 'dispatch_assignment',
    title: 'Rebind assignment to envelope',
    notes: 'Assignment must bind the current dispatch envelope hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebind_assignment_to_runner_selection',
    level: 'error',
    category: 'dispatch_assignment',
    title: 'Rebind assignment to selection',
    notes: 'Assignment must bind the current runner selection hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'rebind_assignment_to_runner_registry',
    level: 'error',
    category: 'dispatch_assignment',
    title: 'Rebind assignment to registry',
    notes: 'Assignment must bind the current runner registry hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'select_matching_runner_route',
    level: 'error',
    category: 'route_binding',
    title: 'Select matching route',
    notes: 'Runner selection channel/action must match the dispatch envelope.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'select_matching_runner_capability',
    level: 'error',
    category: 'route_binding',
    title: 'Select matching capability',
    notes: 'Runner selection must match the assignment runner and capability hash.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'repair_runner_registry_route',
    level: 'error',
    category: 'route_binding',
    title: 'Repair registry route',
    notes: 'Registry route must match the selected runner and assigned capability.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'remove_execution_permission_claim',
    level: 'error',
    category: 'safety_boundary',
    title: 'Remove permission claim',
    notes: 'Ready assignment cannot claim execution permission.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'remove_core_execution_claims',
    level: 'error',
    category: 'safety_boundary',
    title: 'Remove core execution claims',
    notes: 'Readiness inputs must remain descriptor-only.',
    allowedScope: 'local_descriptor_repair',
  },
  {
    code: 'review_dispatch_readiness_blocker',
    level: 'error',
    category: 'manual_review',
    title: 'Review readiness blocker',
    notes: 'Review the failed readiness check and add a cataloged operator hint if it recurs.',
    allowedScope: 'operator_review',
  },
].map((hint) => Object.freeze({
  ...hint,
  executesExternalAction: false,
})));

const HINTS_BY_CODE = new Map(DISPATCH_READINESS_OPERATOR_HINT_CATALOG.map((hint) => [hint.code, hint]));

function normalizeHintCode(input) {
  return normalizeText(typeof input === 'string' ? input : input?.code);
}

export function dispatchReadinessOperatorHint(code, notesOverride = null) {
  const normalizedCode = normalizeHintCode(code);
  const entry = HINTS_BY_CODE.get(normalizedCode) || HINTS_BY_CODE.get('review_dispatch_readiness_blocker');
  const notes = normalizeText(notesOverride) || entry.notes;
  return {
    version: DISPATCH_READINESS_OPERATOR_HINTS_VERSION,
    code: entry.code,
    level: entry.level,
    category: entry.category,
    title: entry.title,
    notes,
    allowedScope: entry.allowedScope,
    catalogKnown: entry.code === normalizedCode,
    executesExternalAction: false,
    safety: {
      hintOnly: true,
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
      readyForExecution: false,
    },
  };
}

export function resolveDispatchReadinessOperatorHints(hints = []) {
  return (hints || []).map((hint) => {
    const code = normalizeHintCode(hint);
    const entry = HINTS_BY_CODE.get(code);
    if (!entry) {
      return {
        inputCode: code || null,
        resolved: false,
        hint: dispatchReadinessOperatorHint('review_dispatch_readiness_blocker', code ? `Unknown hint code: ${code}.` : 'Missing hint code.'),
      };
    }
    const notesOverride = typeof hint === 'string' ? null : hint?.notes;
    return {
      inputCode: code,
      resolved: true,
      hint: dispatchReadinessOperatorHint(code, notesOverride),
    };
  });
}

export function summarizeDispatchReadinessOperatorHints(hints = []) {
  const resolved = resolveDispatchReadinessOperatorHints(hints);
  const byCode = {};
  const byLevel = {};
  const byCategory = {};
  const unknownCodes = [];
  for (const item of resolved) {
    const hint = item.hint;
    byCode[hint.code] = (byCode[hint.code] || 0) + 1;
    byLevel[hint.level] = (byLevel[hint.level] || 0) + 1;
    byCategory[hint.category] = (byCategory[hint.category] || 0) + 1;
    if (!item.resolved) unknownCodes.push(item.inputCode);
  }
  return {
    version: DISPATCH_READINESS_OPERATOR_HINTS_VERSION,
    count: resolved.length,
    catalogCount: DISPATCH_READINESS_OPERATOR_HINT_CATALOG.length,
    resolvedCount: resolved.filter((item) => item.resolved).length,
    unknownCount: unknownCodes.length,
    unknownCodes,
    byCode,
    byLevel,
    byCategory,
    safety: {
      hintCatalogOnly: unknownCodes.length === 0,
      executesExternalAction: resolved.some((item) => item.hint.executesExternalAction === true),
      fetchesChannelState: resolved.some((item) => item.hint.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: resolved.some((item) => item.hint.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: resolved.some((item) => item.hint.safety?.grantsExecutionPermission === true),
      readyForExecution: resolved.some((item) => item.hint.safety?.readyForExecution === true),
    },
  };
}
