import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materializeLegacyDifferentialReference } from '../legacy-reference-fixture.mjs';
import {
  evidenceResyncConsumingSelection,
  evidenceResyncDecisionPlan,
  postApplyFinalGateConsumingSelection,
  postApplyFinalGateDecisionPlan,
  readyMergeBoundaryConsumingSelection,
  readyMergeBoundaryDecisionPlan,
  refereeRevisionRequestConsumingSelection,
  refereeRevisionRequestDecisionPlan,
} from '../../paper-adapters/referee-revise/decision-routing.mjs';
import { buildSafeApplyPlanContract } from '../../paper-domain/repair/command-contract.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = materializeLegacyDifferentialReference();
const root = fixture.root;
process.on('exit', fixture.cleanup);

const blockedRequests = [
  {
    request: { request_id: 11, request_key: 'req-11', slug: 'paper-a' },
    repair_mode: 'source_patch',
    next_command_after_repair: './bin/paperctl referee-revision-worker --request-id 11',
  },
  {
    request: { request_id: 12, request_key: 'req-12', slug: 'paper-b' },
    repair_mode: 'evidence_resync',
    next_command_after_repair: './bin/paperctl evidence-resync --request-id 12',
  },
];
const resyncItems = [
  {
    request: { request_id: 21, request_key: 'req-21', slug: 'paper-c' },
    patch_id: 31,
    classification: 'missing_evidence',
    recommended_action: 'resync',
    next_command: './bin/paperctl evidence-resync --request-id 21',
    patch_hygiene_command: './bin/paperctl patch-hygiene --patch-id 31',
  },
  {
    request: { request_id: 22, request_key: 'req-22', slug: 'paper-d' },
    patch_id: 32,
    classification: 'stale_evidence',
    recommended_action: 'recheck',
    next_command: './bin/paperctl evidence-resync --request-id 22',
    patch_hygiene_command: './bin/paperctl patch-hygiene --patch-id 32',
  },
];
const patches = [
  {
    patch_id: 41,
    slug: 'paper-e',
    batch_id: 'batch-1',
    patch_exists: true,
    sha256_ok: true,
    git_apply_check: { returncode: 0 },
  },
  {
    patch_id: 42,
    slug: 'paper-f',
    batch_id: 'batch-2',
    patch_exists: true,
    sha256_ok: true,
    git_apply_check: { returncode: 0 },
  },
  {
    patch_id: 43,
    slug: 'paper-g',
    batch_id: 'batch-3',
    patch_exists: true,
    sha256_ok: false,
    git_apply_check: { returncode: 1 },
  },
];
const routes = [
  {
    route_id: 'recheck-build',
    route_kind: 'build',
    slugs: ['paper-h'],
    next_command: './bin/paperctl build --slug paper-h',
  },
  {
    route_id: 'recheck-research',
    route_kind: 'research',
    slugs: ['paper-i', 'paper-j'],
    next_command: './bin/paperctl research-verify --slug paper-i',
  },
];
const validRef = { status: 'validated' };

const cases = [];
function add(name, args) {
  cases.push({ name, args });
}

add('referee_revision_request_decision_plan', [[]]);
add('referee_revision_request_decision_plan', [blockedRequests]);
add('referee_revision_request_decision_plan', [blockedRequests, {}, { validation_issues: ['bad hash'] }]);
add('referee_revision_request_decision_plan', [blockedRequests, {}, { validation_issues: [{ issue: 'bad schema' }] }]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'wrong' }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route', source_mutation_authorized: true }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route', selected_action: 'submit' }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route', allowed_command: './bin/paperctl route --execute' }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route', requires_human: true }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route' }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route', selected_request_id: 11 }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route', selected_slug: 'paper-b', selected_repair_mode: 'evidence_resync' }, validRef]);
add('referee_revision_request_decision_plan', [blockedRequests, { decision_point_id: 'referee_revision_request_route', selected_request_id: 'not-an-int' }, validRef]);
add('referee_revision_request_consuming_selection', [[]]);
add('referee_revision_request_consuming_selection', [blockedRequests, { reason: 'fallback' }]);
add('referee_revision_request_consuming_selection', [blockedRequests, {
  consume_allowed: true,
  consumption_state: 'PLAN_ONLY_CONSUMABLE',
  llm_request_id: 12,
  llm_request_key: 'req-12',
  llm_repair_mode: 'evidence_resync',
  llm_command: './bin/paperctl evidence-resync --request-id 12',
  would_change_route: true,
  decision_report_ref: validRef,
}]);
add('referee_revision_request_consuming_selection', [blockedRequests, {
  consume_allowed: true,
  consumption_state: 'PLAN_ONLY_CONSUMABLE',
  llm_request_id: 999,
  reason: 'stale plan',
}]);

add('evidence_resync_decision_plan', [[]]);
add('evidence_resync_decision_plan', [resyncItems]);
add('evidence_resync_decision_plan', [resyncItems, {}, { validation_issues: ['bad ref'] }]);
add('evidence_resync_decision_plan', [resyncItems, { decision_point_id: 'wrong' }, validRef]);
add('evidence_resync_decision_plan', [resyncItems, { decision_point_id: 'evidence_resync_route', patch_queue_merge_performed: true }, validRef]);
add('evidence_resync_decision_plan', [resyncItems, { decision_point_id: 'evidence_resync_route', allowed_command: 'curl https://example.invalid' }, validRef]);
add('evidence_resync_decision_plan', [resyncItems, { decision_point_id: 'evidence_resync_route', humanReviewRequired: true }, validRef]);
add('evidence_resync_decision_plan', [resyncItems, { decision_point_id: 'evidence_resync_route' }, validRef]);
add('evidence_resync_decision_plan', [resyncItems, { decision_point_id: 'evidence_resync_route', selected_patch_id: 31 }, validRef]);
add('evidence_resync_decision_plan', [resyncItems, { decision_point_id: 'evidence_resync_route', selected_request_key: 'req-22', allowed_command: './bin/paperctl patch-hygiene --patch-id 32' }, validRef]);
add('evidence_resync_consuming_selection', [[]]);
add('evidence_resync_consuming_selection', [resyncItems, { reason: 'fallback' }]);
add('evidence_resync_consuming_selection', [resyncItems, {
  consume_allowed: true,
  consumption_state: 'PLAN_ONLY_CONSUMABLE',
  llm_request_id: 22,
  llm_patch_id: 32,
  llm_classification: 'stale_evidence',
  llm_command: './bin/paperctl patch-hygiene --patch-id 32',
  would_change_route: true,
  decision_report_ref: validRef,
}]);

add('ready_merge_boundary_decision_plan', [[]]);
add('ready_merge_boundary_decision_plan', [[patches[2]], {}, validRef, 'blocked', 'checked']);
add('ready_merge_boundary_decision_plan', [patches]);
add('ready_merge_boundary_decision_plan', [patches, {}, { validation_issues: ['bad ref'] }]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'wrong' }, validRef]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'ready_merge_boundary', commit_authorized: true }, validRef]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'ready_merge_boundary', allowed_command: './bin/paperctl merge-queue --patch-id 41 --json; rm x' }, validRef]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'ready_merge_boundary', requiresHumanConfirmation: true }, validRef]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'ready_merge_boundary' }, validRef]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'ready_merge_boundary', selected_patch_id: 41 }, validRef]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'ready_merge_boundary', selected_patch_id: 42, selected_slug: 'paper-f' }, validRef]);
add('ready_merge_boundary_decision_plan', [patches, { decision_point_id: 'ready_merge_boundary', selected_patch_id: 43 }, validRef]);
add('ready_merge_boundary_consuming_selection', [[]]);
add('ready_merge_boundary_consuming_selection', [patches, { reason: 'fallback' }]);
add('ready_merge_boundary_consuming_selection', [patches, {
  consume_allowed: true,
  consumption_state: 'PLAN_ONLY_CONSUMABLE',
  llm_patch_id: 42,
  llm_slug: 'paper-f',
  llm_batch_id: 'batch-2',
  llm_command: './bin/paperctl merge-queue --patch-id 42 --json',
  would_change_route: true,
  decision_report_ref: validRef,
}]);

add('post_apply_final_gate_decision_plan', [[]]);
add('post_apply_final_gate_decision_plan', [routes]);
add('post_apply_final_gate_decision_plan', [routes, {}, { validation_issues: ['bad ref'] }]);
add('post_apply_final_gate_decision_plan', [routes, { decision_point_id: 'wrong' }, validRef]);
add('post_apply_final_gate_decision_plan', [routes, { decision_point_id: 'post_apply_final_gate_route', external_action_authorized: true }, validRef]);
add('post_apply_final_gate_decision_plan', [routes, { decision_point_id: 'post_apply_final_gate_route', allowed_command: 'ssh host' }, validRef]);
add('post_apply_final_gate_decision_plan', [routes, { decision_point_id: 'post_apply_final_gate_route', human_review_required: true }, validRef]);
add('post_apply_final_gate_decision_plan', [routes, { decision_point_id: 'post_apply_final_gate_route' }, validRef]);
add('post_apply_final_gate_decision_plan', [routes, { decision_point_id: 'post_apply_final_gate_route', selected_route: 'recheck-build' }, validRef]);
add('post_apply_final_gate_decision_plan', [routes, { decision_point_id: 'post_apply_final_gate_route', selected_slug: 'paper-j' }, validRef]);
add('post_apply_final_gate_consuming_selection', [[]]);
add('post_apply_final_gate_consuming_selection', [routes, { reason: 'fallback' }]);
add('post_apply_final_gate_consuming_selection', [routes, {
  consume_allowed: true,
  consumption_state: 'PLAN_ONLY_CONSUMABLE',
  llm_route: 'recheck-research',
  llm_route_kind: 'research',
  llm_command: './bin/paperctl research-verify --slug paper-i',
  llm_slugs: ['paper-i', 'paper-j'],
  would_change_route: true,
  decision_report_ref: validRef,
}]);

const implementations = {
  referee_revision_request_decision_plan: refereeRevisionRequestDecisionPlan,
  referee_revision_request_consuming_selection: refereeRevisionRequestConsumingSelection,
  evidence_resync_decision_plan: evidenceResyncDecisionPlan,
  evidence_resync_consuming_selection: evidenceResyncConsumingSelection,
  ready_merge_boundary_decision_plan: readyMergeBoundaryDecisionPlan,
  ready_merge_boundary_consuming_selection: readyMergeBoundaryConsumingSelection,
  post_apply_final_gate_decision_plan: postApplyFinalGateDecisionPlan,
  post_apply_final_gate_consuming_selection: postApplyFinalGateConsumingSelection,
};

function migrateReadyMergeCommand(value) {
  if (Array.isArray(value)) return value.map(migrateReadyMergeCommand);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, migrateReadyMergeCommand(item)]),
  );
  if (typeof value !== 'string') return value;
  const match = /^\.\/bin\/paperctl merge-queue --patch-id (\d+) --json$/.exec(value);
  return match ? buildSafeApplyPlanContract(match[1]) : value;
}

const runner = String.raw`
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))
from paperctl_modules import referee_revision
cases = json.load(sys.stdin)
results = []
for case in cases:
    fn = getattr(referee_revision, case["name"])
    results.append(fn(*case["args"]))
json.dump(results, sys.stdout, sort_keys=True)
`;
const reference = spawnSync('python3', ['-c', runner, root], {
  cwd: root,
  input: JSON.stringify(cases),
  encoding: 'utf8',
  timeout: 120000,
});
assert.equal(reference.status, 0, reference.stderr);
const expected = JSON.parse(reference.stdout);
const normalizedExpected = expected.map(migrateReadyMergeCommand);
const nativeCases = cases.map(migrateReadyMergeCommand);
const actual = nativeCases.map((testCase) => implementations[testCase.name](...testCase.args));
assert.equal(actual.length, expected.length);
for (let index = 0; index < cases.length; index += 1) {
  assert.deepEqual(actual[index], normalizedExpected[index], `${index}:${cases[index].name}`);
}

const planStates = uniqueStates(actual, 'consumption_state');
const selectionStates = uniqueStates(actual, 'selection_state');
assert.ok(planStates.includes('PLAN_ONLY_CONSUMABLE'));
assert.ok(planStates.includes('FORBIDDEN_DECISION_BOUNDARY'));
assert.ok(planStates.includes('HUMAN_REVIEW_REQUIRED'));
assert.ok(selectionStates.some((state) => state.startsWith('CONSUMED_LLM_')));
assert.ok(selectionStates.some((state) => state.startsWith('DETERMINISTIC_FALLBACK_')));

function uniqueStates(rows, key) {
  return [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort();
}

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P1RefereeRevisionDifferentialTest',
  exactParityCaseCount: cases.length,
  commandContractMigration: 'legacy_merge_queue_to_hepta_safe_apply_plan',
  semanticParityAfterCommandContractMigration: true,
  rawCommandStringParity: false,
  publicFunctionCount: Object.keys(implementations).length,
  planStates,
  selectionStates,
}) + '\n');
fixture.cleanup();
