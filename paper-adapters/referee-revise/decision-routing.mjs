import { buildSafeApplyPlanContract } from '../../paper-domain/repair/command-contract.mjs';

// Exact local compatibility implementation of legacy referee_revision.py decision routing.
const EXTERNAL_OPERATION_NAMES = new Set(['delete', 'email', 'publish', 'sendmail', 'submit', 'upload', 'withdraw']);
const OPERATION_FIELD_NAMES = new Set([
  'action',
  'external_operation',
  'operation',
  'operation_id',
  'requested_operation',
  'runtime_operation',
  'selected_action',
  'selected_operation',
]);
const FORBIDDEN_ALLOWED_COMMAND_TOKENS = new Set([
  'curl', 'email', 'ftp', 'portal', 'scp', 'sendmail', 'ssh', 'submit', 'upload',
]);
const FORBIDDEN_ALLOWED_COMMAND_FLAGS = new Set([
  '--apply', '--apply-status', '--execute', '--send-approved',
]);
const FORBIDDEN_DECISION_CONSUMPTION_FLAGS = new Set([
  'human_authorized',
  'recorder_write_path_authorized',
  'decision_consumption_authorized',
  'workflow_execution_authorized',
  'model_call_authorized',
  'external_action_authorized',
  'external_action_performed',
  'source_mutation_authorized',
  'source_mutation_performed',
  'package_mutation_authorized',
  'package_mutation_performed',
  'archive_mutation_authorized',
  'archive_mutation_performed',
  'provider_model_call_authorized',
  'provider_model_call_performed',
  'secret_material_read_authorized',
  'secret_material_read_performed',
  'candidate_patch_queue_mutation_performed',
  'patch_queue_merge_performed',
  'crontab_mutation_authorized',
  'crontab_mutation_performed',
  'commit_authorized',
  'commit_performed',
  'approval_execution_authorized',
  'applies_decision',
  'apply_decision',
  'closes_human_boundary',
  'human_decision_closed',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => object(item)) : [];
}

function truthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function firstTruthy(value, keys) {
  for (const key of keys) if (truthy(value[key])) return value[key];
  return '';
}

function intValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isInteger(value) ? value : 0;
  const text = String(value ?? '').trim();
  return /^[+-]?\d+$/.test(text) ? Number(text) : 0;
}

function request(item) {
  return object(item.request);
}

function requestId(item) {
  return intValue(request(item).request_id || 0);
}

function patchId(item) {
  return intValue(item.patch_id || 0);
}

function unique(values) {
  const result = [];
  for (const value of values) if (truthy(value) && !result.includes(value)) result.push(value);
  return result;
}

function canonicalFieldName(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\-]+/g, '_')
    .toLowerCase();
}

function operationSegments(operation) {
  return String(operation || '').trim().toLowerCase().split(/[._-]+/).filter(Boolean);
}

function isExternalOperation(operation) {
  const value = String(operation || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]*$/.test(value)) return false;
  return operationSegments(value).some((segment) => EXTERNAL_OPERATION_NAMES.has(segment));
}

function forbiddenConsumptionIssue(decisionOutput) {
  for (const [key, value] of Object.entries(decisionOutput)) {
    if (FORBIDDEN_DECISION_CONSUMPTION_FLAGS.has(canonicalFieldName(key)) && truthy(value)) {
      return `${key} must be false for plan-only decision consumption`;
    }
  }
  for (const [key, value] of Object.entries(decisionOutput)) {
    const field = canonicalFieldName(key);
    if ((!OPERATION_FIELD_NAMES.has(field) && !field.endsWith('_operation')) || typeof value !== 'string') continue;
    if (isExternalOperation(value)) {
      return `external_action_operation ${key}=${value} must not be consumed by plan-only decision routing`;
    }
  }
  return '';
}

function commandSafetyIssue(command) {
  const value = String(command || '').trim();
  if (!value) return '';
  if (['\n', '\r', ';', '|', '&&', '||', '`', '$('].some((token) => value.includes(token))) {
    return 'allowed_command contains shell control syntax';
  }
  const lowered = value.toLowerCase();
  for (const match of lowered.matchAll(/(^|[^a-z0-9_.-])(--[a-z0-9][a-z0-9_.-]*)/g)) {
    if (FORBIDDEN_ALLOWED_COMMAND_FLAGS.has(match[2])) {
      return `allowed_command contains approval/execution boundary flag ${match[2]}`;
    }
  }
  for (const token of lowered.match(/[a-z][a-z0-9_.-]*/g) || []) {
    if (FORBIDDEN_ALLOWED_COMMAND_TOKENS.has(token) || isExternalOperation(token)) {
      return 'allowed_command contains external-action token';
    }
  }
  return '';
}

function requiresHuman(decisionOutput) {
  const fields = new Set(['requires_human', 'requires_human_confirmation', 'human_review_required']);
  return Object.entries(decisionOutput).some(([key, value]) => fields.has(canonicalFieldName(key)) && truthy(value));
}

function decisionRefIssue(decisionRef) {
  const issues = Array.isArray(decisionRef.validation_issues) ? decisionRef.validation_issues : [];
  return issues.map((issue) => {
    if (issue && typeof issue === 'object' && !Array.isArray(issue)) {
      return String(issue.issue || issue.message || issue);
    }
    return String(issue);
  }).filter(Boolean).join('; ');
}

function forbiddenState(issue) {
  return String(issue || '').startsWith('external_action_')
    ? 'EXTERNAL_ACTION_FORBIDDEN'
    : 'FORBIDDEN_DECISION_BOUNDARY';
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requestRouteMatches(item, output) {
  const requestRow = request(item);
  const selectedId = firstTruthy(output, ['selected_request_id', 'request_id', 'target_request_id']);
  if (truthy(selectedId) && intValue(selectedId) !== intValue(requestRow.request_id || 0)) return false;
  const selectedKey = firstTruthy(output, ['selected_request_key', 'request_key']);
  if (truthy(selectedKey) && selectedKey !== (requestRow.request_key || '')) return false;
  const selectedSlug = firstTruthy(output, ['selected_slug', 'slug']);
  if (truthy(selectedSlug) && selectedSlug !== (requestRow.slug || '')) return false;
  const selectedMode = firstTruthy(output, [
    'selected_repair_mode', 'repair_mode', 'selected_route', 'route', 'selected_task', 'task',
  ]);
  if (truthy(selectedMode) && selectedMode !== (item.repair_mode || '')) return false;
  const allowedCommand = output.allowed_command || '';
  if (truthy(allowedCommand) && allowedCommand !== (item.next_command_after_repair || '')) return false;
  const nextAction = firstTruthy(output, ['next_action', 'selected_action']);
  if (truthy(nextAction) && ![
    item.repair_mode || '', item.next_command_after_repair || '', requestRow.request_key || '',
  ].includes(nextAction)) return false;
  return [selectedId, selectedKey, selectedSlug, selectedMode, allowedCommand, nextAction].some(truthy);
}

export function refereeRevisionRequestDecisionPlan(blockedRequests, decisionOutput = null, decisionRef = null) {
  const items = list(blockedRequests);
  const output = object(decisionOutput);
  const reportRef = object(decisionRef);
  const deterministic = items[0] || {};
  const deterministicRequest = request(deterministic);
  const candidateRequestIds = items.map(requestId).filter(Boolean);
  const candidateRepairModes = unique(items.map((item) => item.repair_mode || ''));
  const base = (state, reason, overrides = {}) => ({
    consume_allowed: false,
    consumption_state: state,
    reason,
    deterministic_request_id: requestId(deterministic),
    deterministic_request_key: deterministicRequest.request_key || '',
    deterministic_repair_mode: deterministic.repair_mode || '',
    deterministic_command: deterministic.next_command_after_repair || '',
    llm_request_id: 0,
    llm_request_key: '',
    llm_repair_mode: '',
    llm_command: '',
    would_change_route: false,
    candidate_count: items.length,
    candidate_request_ids: candidateRequestIds,
    candidate_repair_modes: candidateRepairModes,
    decision_report_ref: reportRef,
    ...overrides,
  });
  if (!items.length) return base('NO_BLOCKED_REQUEST_ROUTE_REQUIRED', 'blocked repair plan has no blocked requests');
  if (!truthy(reportRef)) return base('NO_LLM_DECISION_REPORT', 'missing referee_revision_request_route LLM decision report', { decision_report_ref: {} });
  const reportIssue = decisionRefIssue(reportRef);
  if (reportIssue) return base('INVALID_LLM_DECISION_REPORT', `referee_revision_request_route decision report is not valid: ${reportIssue}`);
  if (output.decision_point_id !== 'referee_revision_request_route') return base('INVALID_DECISION_POINT', 'decision output is not for referee_revision_request_route');
  const forbidden = forbiddenConsumptionIssue(output);
  if (forbidden) return base(forbiddenState(forbidden), forbidden);
  const commandIssue = commandSafetyIssue(output.allowed_command || '');
  if (commandIssue) return base('ALLOWED_COMMAND_NOT_SAFE_REQUEST_ROUTE', commandIssue);
  if (requiresHuman(output)) return base('HUMAN_REVIEW_REQUIRED', 'decision output requires human review before request route consumption');
  const matched = items.find((item) => requestRouteMatches(item, output));
  if (!matched) return base('NO_SELECTABLE_REQUEST_ROUTE', 'decision output does not identify a blocked request repair route');
  const matchedRequest = request(matched);
  const llmRequestId = requestId(matched);
  const llmRepairMode = matched.repair_mode || '';
  const llmCommand = matched.next_command_after_repair || '';
  return base('PLAN_ONLY_CONSUMABLE', 'decision output identifies a blocked request repair route', {
    consume_allowed: true,
    llm_request_id: llmRequestId,
    llm_request_key: matchedRequest.request_key || '',
    llm_repair_mode: llmRepairMode,
    llm_command: llmCommand,
    would_change_route: llmRequestId !== requestId(deterministic)
      || llmRepairMode !== (deterministic.repair_mode || '')
      || llmCommand !== (deterministic.next_command_after_repair || ''),
  });
}

export function refereeRevisionRequestConsumingSelection(blockedRequests, decisionPlan = null) {
  const items = list(blockedRequests);
  const plan = object(decisionPlan);
  const deterministic = items[0] || {};
  const deterministicRequest = request(deterministic);
  const candidateRequestIds = items.map(requestId).filter(Boolean);
  const candidateRepairModes = unique(items.map((item) => item.repair_mode || ''));
  const payload = (consumed, state, item, reason, changed = false) => {
    const requestRow = request(item);
    return {
      decision_consumed: Boolean(consumed),
      selection_state: state,
      plan_state: plan.consumption_state || '',
      selected_request_id: requestId(item),
      selected_request_key: requestRow.request_key || '',
      selected_slug: requestRow.slug || '',
      selected_repair_mode: item.repair_mode || '',
      selected_command: item.next_command_after_repair || '',
      deterministic_request_id: requestId(deterministic),
      deterministic_request_key: deterministicRequest.request_key || '',
      deterministic_slug: deterministicRequest.slug || '',
      deterministic_repair_mode: deterministic.repair_mode || '',
      deterministic_command: deterministic.next_command_after_repair || '',
      would_change_route: Boolean(changed),
      candidate_count: items.length,
      candidate_request_ids: candidateRequestIds,
      candidate_repair_modes: candidateRepairModes,
      fallback_reason: reason,
      decision_report_ref: object(plan.decision_report_ref),
    };
  };
  if (truthy(plan.consume_allowed)) {
    const matched = items.find((item) => {
      const requestRow = request(item);
      if (truthy(plan.llm_request_id) && requestId(item) !== intValue(plan.llm_request_id)) return false;
      if (truthy(plan.llm_request_key) && plan.llm_request_key !== (requestRow.request_key || '')) return false;
      if (truthy(plan.llm_repair_mode) && plan.llm_repair_mode !== (item.repair_mode || '')) return false;
      if (truthy(plan.llm_command) && plan.llm_command !== (item.next_command_after_repair || '')) return false;
      return true;
    });
    if (matched) return payload(true, 'CONSUMED_LLM_REFEREE_REVISION_REQUEST_ROUTE', matched, '', plan.would_change_route);
  }
  if (!items.length) return payload(false, 'NO_BLOCKED_REQUEST_ROUTE_REQUIRED', {}, plan.reason || 'blocked repair plan has no blocked requests');
  return payload(false, 'DETERMINISTIC_FALLBACK_NO_LLM_REFEREE_REVISION_REQUEST_CONSUMPTION', deterministic, plan.reason || 'missing consumable referee_revision_request_route LLM decision report');
}

function resyncMatches(item, output) {
  const requestRow = request(item);
  const selectedRequestId = firstTruthy(output, ['selected_request_id', 'request_id', 'target_request_id']);
  if (truthy(selectedRequestId) && intValue(selectedRequestId) !== intValue(requestRow.request_id || 0)) return false;
  const selectedPatchId = firstTruthy(output, ['selected_patch_id', 'patch_id', 'target_patch_id']);
  if (truthy(selectedPatchId) && intValue(selectedPatchId) !== patchId(item)) return false;
  const selectedKey = firstTruthy(output, ['selected_request_key', 'request_key']);
  if (truthy(selectedKey) && selectedKey !== (requestRow.request_key || '')) return false;
  const selectedClassification = firstTruthy(output, [
    'selected_classification', 'classification', 'selected_route', 'route', 'selected_task', 'task',
  ]);
  if (truthy(selectedClassification) && selectedClassification !== (item.classification || '')) return false;
  const allowedCommand = output.allowed_command || '';
  if (truthy(allowedCommand) && ![item.next_command || '', item.patch_hygiene_command || ''].includes(allowedCommand)) return false;
  const nextAction = firstTruthy(output, ['next_action', 'selected_action']);
  if (truthy(nextAction) && ![
    item.classification || '', item.recommended_action || '', item.next_command || '',
    item.patch_hygiene_command || '', requestRow.request_key || '',
  ].includes(nextAction)) return false;
  return [selectedRequestId, selectedPatchId, selectedKey, selectedClassification, allowedCommand, nextAction].some(truthy);
}

export function evidenceResyncDecisionPlan(resyncItems, decisionOutput = null, decisionRef = null) {
  const items = list(resyncItems);
  const output = object(decisionOutput);
  const reportRef = object(decisionRef);
  const deterministic = items[0] || {};
  const deterministicRequest = request(deterministic);
  const candidateKeys = items.map((item) => `${requestId(item)}:${patchId(item)}:${item.classification || ''}:${request(item).request_key || ''}`);
  const candidateClassifications = unique(items.map((item) => item.classification || ''));
  const base = (state, reason, overrides = {}) => ({
    consume_allowed: false,
    consumption_state: state,
    reason,
    deterministic_request_id: requestId(deterministic),
    deterministic_request_key: deterministicRequest.request_key || '',
    deterministic_patch_id: patchId(deterministic),
    deterministic_classification: deterministic.classification || '',
    deterministic_command: deterministic.next_command || '',
    llm_request_id: 0,
    llm_request_key: '',
    llm_patch_id: 0,
    llm_classification: '',
    llm_command: '',
    would_change_route: false,
    candidate_count: items.length,
    candidate_keys: candidateKeys,
    candidate_classifications: candidateClassifications,
    decision_report_ref: reportRef,
    ...overrides,
  });
  if (!items.length) return base('NO_RESYNC_ACTION_REQUIRED', 'evidence resync report has no selected items');
  if (!truthy(reportRef)) return base('NO_LLM_DECISION_REPORT', 'missing evidence_resync_route LLM decision report', { decision_report_ref: {} });
  const reportIssue = decisionRefIssue(reportRef);
  if (reportIssue) return base('INVALID_LLM_DECISION_REPORT', `evidence_resync_route decision report is not valid: ${reportIssue}`);
  if (output.decision_point_id !== 'evidence_resync_route') return base('INVALID_DECISION_POINT', 'decision output is not for evidence_resync_route');
  const forbidden = forbiddenConsumptionIssue(output);
  if (forbidden) return base(forbiddenState(forbidden), forbidden);
  const commandIssue = commandSafetyIssue(output.allowed_command || '');
  if (commandIssue) return base('ALLOWED_COMMAND_NOT_SAFE_EVIDENCE_RESYNC_ROUTE', commandIssue);
  if (requiresHuman(output)) return base('HUMAN_REVIEW_REQUIRED', 'decision output requires human review before evidence resync route consumption');
  const matched = items.find((item) => resyncMatches(item, output));
  if (!matched) return base('NO_SELECTABLE_RESYNC_ROUTE', 'decision output does not identify an evidence resync item');
  const matchedRequest = request(matched);
  const llmRequestId = requestId(matched);
  const llmPatchId = patchId(matched);
  const llmClassification = matched.classification || '';
  const llmCommand = output.allowed_command || matched.next_command || '';
  return base('PLAN_ONLY_CONSUMABLE', 'decision output identifies an evidence resync item', {
    consume_allowed: true,
    llm_request_id: llmRequestId,
    llm_request_key: matchedRequest.request_key || '',
    llm_patch_id: llmPatchId,
    llm_classification: llmClassification,
    llm_command: llmCommand,
    would_change_route: llmRequestId !== requestId(deterministic)
      || llmPatchId !== patchId(deterministic)
      || llmClassification !== (deterministic.classification || '')
      || llmCommand !== (deterministic.next_command || ''),
  });
}

export function evidenceResyncConsumingSelection(resyncItems, decisionPlan = null) {
  const items = list(resyncItems);
  const plan = object(decisionPlan);
  const deterministic = items[0] || {};
  const deterministicRequest = request(deterministic);
  const candidateKeys = items.map((item) => `${requestId(item)}:${patchId(item)}:${item.classification || ''}:${request(item).request_key || ''}`);
  const candidateClassifications = unique(items.map((item) => item.classification || ''));
  const payload = (consumed, state, item, reason, changed = false) => ({
    decision_consumed: Boolean(consumed),
    selection_state: state,
    plan_state: plan.consumption_state || '',
    selected_request_id: requestId(item),
    selected_request_key: request(item).request_key || '',
    selected_slug: request(item).slug || '',
    selected_patch_id: patchId(item),
    selected_classification: item.classification || '',
    selected_command: item.next_command || '',
    selected_patch_hygiene_command: item.patch_hygiene_command || '',
    deterministic_request_id: requestId(deterministic),
    deterministic_request_key: deterministicRequest.request_key || '',
    deterministic_patch_id: patchId(deterministic),
    deterministic_classification: deterministic.classification || '',
    deterministic_command: deterministic.next_command || '',
    would_change_route: Boolean(changed),
    candidate_count: items.length,
    candidate_keys: candidateKeys,
    candidate_classifications: candidateClassifications,
    fallback_reason: reason,
    decision_report_ref: object(plan.decision_report_ref),
  });
  if (truthy(plan.consume_allowed)) {
    const selectedCommand = plan.llm_command || '';
    const matched = items.find((item) => {
      const requestRow = request(item);
      if (truthy(plan.llm_request_id) && requestId(item) !== intValue(plan.llm_request_id)) return false;
      if (truthy(plan.llm_request_key) && plan.llm_request_key !== (requestRow.request_key || '')) return false;
      if (truthy(plan.llm_patch_id) && patchId(item) !== intValue(plan.llm_patch_id)) return false;
      if (truthy(plan.llm_classification) && plan.llm_classification !== (item.classification || '')) return false;
      if (truthy(selectedCommand) && ![item.next_command || '', item.patch_hygiene_command || ''].includes(selectedCommand)) return false;
      return true;
    });
    if (matched) {
      const selected = payload(true, 'CONSUMED_LLM_EVIDENCE_RESYNC_ROUTE', matched, '', plan.would_change_route);
      if (truthy(selectedCommand)) selected.selected_command = selectedCommand;
      return selected;
    }
  }
  if (!items.length) return payload(false, 'NO_RESYNC_ACTION_REQUIRED', {}, plan.reason || 'evidence resync report has no selected items');
  return payload(false, 'DETERMINISTIC_FALLBACK_NO_LLM_EVIDENCE_RESYNC_CONSUMPTION', deterministic, plan.reason || 'missing consumable evidence_resync_route LLM decision report');
}

function readyMergeCommand(item) {
  return buildSafeApplyPlanContract(patchId(item));
}

function isReadyMergeCandidate(item) {
  return Boolean(item.patch_exists && item.sha256_ok && object(item.git_apply_check).returncode === 0);
}

function readyMergeMatches(item, output) {
  const selectedPatchId = firstTruthy(output, ['selected_patch_id', 'patch_id', 'target_patch_id']);
  if (truthy(selectedPatchId) && intValue(selectedPatchId) !== patchId(item)) return false;
  const selectedSlug = firstTruthy(output, ['selected_slug', 'slug']);
  if (truthy(selectedSlug) && selectedSlug !== (item.slug || '')) return false;
  const selectedBatchId = firstTruthy(output, ['selected_batch_id', 'batch_id', 'target_batch_id']);
  if (truthy(selectedBatchId) && selectedBatchId !== (item.batch_id || '')) return false;
  const selectedRoute = firstTruthy(output, [
    'selected_ready_merge_route', 'selected_route', 'route', 'selected_task', 'task',
  ]);
  if (truthy(selectedRoute) && ![
    'ready_merge', 'ready_merge_boundary', 'merge_plan', 'merge_queue_plan', readyMergeCommand(item),
  ].includes(selectedRoute)) return false;
  const allowedCommand = output.allowed_command || '';
  if (truthy(allowedCommand) && allowedCommand !== readyMergeCommand(item)) return false;
  const nextAction = firstTruthy(output, ['next_action', 'selected_action']);
  if (truthy(nextAction) && ![
    'ready_merge', 'ready_merge_boundary', 'merge_plan', 'merge_queue_plan', readyMergeCommand(item),
    item.slug || '', item.batch_id || '', String(patchId(item)),
  ].includes(nextAction)) return false;
  return [selectedPatchId, selectedSlug, selectedBatchId, selectedRoute, allowedCommand, nextAction].some(truthy);
}

export function readyMergeBoundaryDecisionPlan(patches, decisionOutput = null, decisionRef = null, readyMergeState = '', status = '') {
  const inspected = list(patches);
  const output = object(decisionOutput);
  const reportRef = object(decisionRef);
  const ready = inspected.filter(isReadyMergeCandidate);
  const deterministic = ready[0] || {};
  const base = (state, reason, overrides = {}) => ({
    consume_allowed: false,
    consumption_state: state,
    reason,
    ready_merge_state: readyMergeState || '',
    ready_merge_status: status || '',
    deterministic_patch_id: patchId(deterministic),
    deterministic_slug: deterministic.slug || '',
    deterministic_batch_id: deterministic.batch_id || '',
    deterministic_command: readyMergeCommand(deterministic),
    llm_patch_id: 0,
    llm_slug: '',
    llm_batch_id: '',
    llm_command: '',
    llm_patch_ready: false,
    would_change_route: false,
    candidate_count: ready.length,
    inspected_patch_count: inspected.length,
    candidate_patch_ids: ready.map(patchId).filter(Boolean),
    inspected_patch_ids: inspected.map(patchId).filter(Boolean),
    candidate_slugs: unique(ready.map((item) => item.slug || '')),
    decision_report_ref: reportRef,
    ...overrides,
  });
  if (!ready.length) return base('NO_READY_MERGE_CANDIDATE', inspected.length ? 'ready-merge-set patches exist but none pass ready merge checks' : 'ready-merge-set report has no ready checked patch candidates');
  if (!truthy(reportRef)) return base('NO_LLM_DECISION_REPORT', 'missing ready_merge_boundary LLM decision report', { decision_report_ref: {} });
  const reportIssue = decisionRefIssue(reportRef);
  if (reportIssue) return base('INVALID_LLM_DECISION_REPORT', `ready_merge_boundary decision report is not valid: ${reportIssue}`);
  if (output.decision_point_id !== 'ready_merge_boundary') return base('INVALID_DECISION_POINT', 'decision output is not for ready_merge_boundary');
  const forbidden = forbiddenConsumptionIssue(output);
  if (forbidden) return base(forbiddenState(forbidden), forbidden);
  const commandIssue = commandSafetyIssue(output.allowed_command || '');
  if (commandIssue) return base('ALLOWED_COMMAND_NOT_SAFE_READY_MERGE_BOUNDARY', commandIssue);
  if (requiresHuman(output)) return base('HUMAN_REVIEW_REQUIRED', 'decision output requires human review before ready merge boundary consumption');
  const matched = inspected.find((item) => readyMergeMatches(item, output));
  if (!matched) return base('NO_SELECTABLE_READY_MERGE_CANDIDATE', 'decision output does not identify a ready merge candidate');
  const llmCommand = readyMergeCommand(matched);
  if (!isReadyMergeCandidate(matched)) return base('SELECTED_PATCH_NOT_READY', 'decision output identifies a patch that failed ready merge checks', {
    llm_patch_id: patchId(matched),
    llm_slug: matched.slug || '',
    llm_batch_id: matched.batch_id || '',
    llm_command: llmCommand,
    llm_patch_ready: false,
  });
  return base('PLAN_ONLY_CONSUMABLE', 'decision output identifies a ready merge candidate', {
    consume_allowed: true,
    llm_patch_id: patchId(matched),
    llm_slug: matched.slug || '',
    llm_batch_id: matched.batch_id || '',
    llm_command: llmCommand,
    llm_patch_ready: true,
    would_change_route: patchId(matched) !== patchId(deterministic)
      || (matched.slug || '') !== (deterministic.slug || '')
      || (matched.batch_id || '') !== (deterministic.batch_id || '')
      || llmCommand !== readyMergeCommand(deterministic),
  });
}

export function readyMergeBoundaryConsumingSelection(patches, decisionPlan = null) {
  const inspected = list(patches);
  const plan = object(decisionPlan);
  const ready = inspected.filter(isReadyMergeCandidate);
  const deterministic = ready[0] || {};
  const payload = (consumed, state, item, reason, changed = false) => ({
    decision_consumed: Boolean(consumed),
    selection_state: state,
    plan_state: plan.consumption_state || '',
    selected_patch_id: patchId(item),
    selected_slug: item.slug || '',
    selected_batch_id: item.batch_id || '',
    selected_command: readyMergeCommand(item),
    deterministic_patch_id: patchId(deterministic),
    deterministic_slug: deterministic.slug || '',
    deterministic_batch_id: deterministic.batch_id || '',
    deterministic_command: readyMergeCommand(deterministic),
    would_change_route: Boolean(changed),
    candidate_count: ready.length,
    inspected_patch_count: inspected.length,
    candidate_patch_ids: ready.map(patchId).filter(Boolean),
    inspected_patch_ids: inspected.map(patchId).filter(Boolean),
    candidate_slugs: unique(ready.map((item) => item.slug || '')),
    fallback_reason: reason,
    decision_report_ref: object(plan.decision_report_ref),
  });
  if (truthy(plan.consume_allowed)) {
    const matched = ready.find((item) => {
      if (truthy(plan.llm_patch_id) && patchId(item) !== intValue(plan.llm_patch_id)) return false;
      if (truthy(plan.llm_slug) && plan.llm_slug !== (item.slug || '')) return false;
      if (truthy(plan.llm_batch_id) && plan.llm_batch_id !== (item.batch_id || '')) return false;
      if (truthy(plan.llm_command) && plan.llm_command !== readyMergeCommand(item)) return false;
      return true;
    });
    if (matched) return payload(true, 'CONSUMED_LLM_READY_MERGE_BOUNDARY', matched, '', plan.would_change_route);
  }
  if (!ready.length) return payload(false, 'NO_READY_MERGE_CANDIDATE', {}, plan.reason || 'ready-merge-set report has no ready checked patch candidates');
  return payload(false, 'DETERMINISTIC_FALLBACK_NO_LLM_READY_MERGE_CONSUMPTION', deterministic, plan.reason || 'missing consumable ready_merge_boundary LLM decision report');
}

function routeId(item) {
  return item.route_id || item.route || item.task || '';
}

function candidateRouteSlugs(items) {
  const values = [];
  for (const item of items) {
    for (const slug of Array.isArray(item.slugs) ? item.slugs : []) if (truthy(slug) && !values.includes(slug)) values.push(slug);
    if (truthy(item.slug) && !values.includes(item.slug)) values.push(item.slug);
  }
  return values;
}

function finalGateMatches(item, output) {
  const selectedRoute = firstTruthy(output, [
    'selected_final_gate_route', 'selected_route', 'route', 'selected_task', 'task',
    'next_action', 'selected_action',
  ]);
  if (truthy(selectedRoute) && ![routeId(item), item.route_kind || '', item.next_command || ''].includes(selectedRoute)) return false;
  const selectedSlug = firstTruthy(output, ['selected_slug', 'slug']);
  const slugs = Array.isArray(item.slugs) ? [...item.slugs] : [];
  if (truthy(selectedSlug) && !slugs.includes(selectedSlug) && selectedSlug !== (item.slug || '')) return false;
  const allowedCommand = output.allowed_command || '';
  if (truthy(allowedCommand) && allowedCommand !== (item.next_command || '')) return false;
  return [selectedRoute, selectedSlug, allowedCommand].some(truthy);
}

export function postApplyFinalGateDecisionPlan(routes, decisionOutput = null, decisionRef = null) {
  const items = list(routes);
  const output = object(decisionOutput);
  const reportRef = object(decisionRef);
  const deterministic = items[0] || {};
  const deterministicSlugs = Array.isArray(deterministic.slugs) ? [...deterministic.slugs] : [];
  const base = (state, reason, overrides = {}) => ({
    consume_allowed: false,
    consumption_state: state,
    reason,
    deterministic_route: routeId(deterministic),
    deterministic_route_kind: deterministic.route_kind || '',
    deterministic_command: deterministic.next_command || '',
    deterministic_slugs: deterministicSlugs,
    llm_route: '',
    llm_route_kind: '',
    llm_command: '',
    llm_slugs: [],
    would_change_route: false,
    candidate_count: items.length,
    candidate_route_ids: unique(items.map(routeId)),
    candidate_slugs: candidateRouteSlugs(items),
    decision_report_ref: reportRef,
    ...overrides,
  });
  if (!items.length) return base('NO_POST_APPLY_FINAL_GATE_ACTION_REQUIRED', 'no post-apply final gate route candidates');
  if (!truthy(reportRef)) return base('NO_LLM_DECISION_REPORT', 'missing post_apply_final_gate_route LLM decision report', { decision_report_ref: {} });
  const reportIssue = decisionRefIssue(reportRef);
  if (reportIssue) return base('INVALID_LLM_DECISION_REPORT', `post_apply_final_gate_route decision report is not valid: ${reportIssue}`);
  if (output.decision_point_id !== 'post_apply_final_gate_route') return base('INVALID_DECISION_POINT', 'decision output is not for post_apply_final_gate_route');
  const forbidden = forbiddenConsumptionIssue(output);
  if (forbidden) return base(forbiddenState(forbidden), forbidden);
  const commandIssue = commandSafetyIssue(output.allowed_command || '');
  if (commandIssue) return base('ALLOWED_COMMAND_NOT_SAFE_POST_APPLY_FINAL_GATE_ROUTE', commandIssue);
  if (requiresHuman(output)) return base('HUMAN_REVIEW_REQUIRED', 'decision output requires human review before final-gate route consumption');
  const matched = items.find((item) => finalGateMatches(item, output));
  if (!matched) return base('NO_SELECTABLE_POST_APPLY_FINAL_GATE_ROUTE', 'decision output does not identify a post-apply final gate route');
  const llmSlugs = Array.isArray(matched.slugs) ? [...matched.slugs] : [];
  return base('PLAN_ONLY_CONSUMABLE', 'decision output identifies a post-apply final gate route', {
    consume_allowed: true,
    llm_route: routeId(matched),
    llm_route_kind: matched.route_kind || '',
    llm_command: matched.next_command || '',
    llm_slugs: llmSlugs,
    would_change_route: routeId(matched) !== routeId(deterministic)
      || (matched.next_command || '') !== (deterministic.next_command || '')
      || !sameArray(llmSlugs, deterministicSlugs),
  });
}

export function postApplyFinalGateConsumingSelection(routes, decisionPlan = null) {
  const items = list(routes);
  const plan = object(decisionPlan);
  const deterministic = items[0] || {};
  const deterministicSlugs = Array.isArray(deterministic.slugs) ? [...deterministic.slugs] : [];
  const payload = (consumed, state, item, reason, changed = false) => ({
    decision_consumed: Boolean(consumed),
    selection_state: state,
    plan_state: plan.consumption_state || '',
    selected_route: routeId(item),
    selected_route_kind: item.route_kind || '',
    selected_slugs: Array.isArray(item.slugs) ? [...item.slugs] : [],
    selected_command: item.next_command || '',
    deterministic_route: routeId(deterministic),
    deterministic_route_kind: deterministic.route_kind || '',
    deterministic_slugs: deterministicSlugs,
    deterministic_command: deterministic.next_command || '',
    would_change_route: Boolean(changed),
    candidate_count: items.length,
    candidate_route_ids: unique(items.map(routeId)),
    candidate_slugs: candidateRouteSlugs(items),
    fallback_reason: reason,
    decision_report_ref: object(plan.decision_report_ref),
  });
  if (truthy(plan.consume_allowed)) {
    const selectedSlugs = Array.isArray(plan.llm_slugs) ? [...plan.llm_slugs] : [];
    const matched = items.find((item) => {
      if (truthy(plan.llm_route) && routeId(item) !== plan.llm_route) return false;
      if (truthy(plan.llm_route_kind) && (item.route_kind || '') !== plan.llm_route_kind) return false;
      if (truthy(plan.llm_command) && (item.next_command || '') !== plan.llm_command) return false;
      if (truthy(selectedSlugs) && !sameArray(Array.isArray(item.slugs) ? item.slugs : [], selectedSlugs)) return false;
      return true;
    });
    if (matched) return payload(true, 'CONSUMED_LLM_POST_APPLY_FINAL_GATE_ROUTE', matched, '', plan.would_change_route);
  }
  if (!items.length) return payload(false, 'NO_POST_APPLY_FINAL_GATE_ACTION_REQUIRED', {}, plan.reason || 'no post-apply final gate route candidates');
  return payload(false, 'DETERMINISTIC_FALLBACK_NO_LLM_POST_APPLY_FINAL_GATE_CONSUMPTION', deterministic, plan.reason || 'missing consumable post_apply_final_gate_route LLM decision report');
}
