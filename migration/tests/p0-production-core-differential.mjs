import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultLegacyPaperFactoryRoot } from '../../paper-core/src/workspace-layout.mjs';
import {
  buildLegacyProductionAudit,
  evaluateLegacyProductionSnapshot,
  legacyRepairLoopFrontier,
  legacyRepairLoopFrontierSlugShard,
  resolveLegacyArtifactLabel,
  summarizeLegacyProductionEvaluations,
} from '../../paper-core/src/production-state-compat.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = defaultLegacyPaperFactoryRoot();
const sourceModule = path.join(root, 'paperctl_modules', 'paper_production_core.py');
const createdAt = '2026-07-10 03:30:00';

function readySnapshot(slug) {
  return {
    slug,
    source_ready: true,
    main_tex: `papers/${slug}/main.tex`,
    proof_readiness: {
      contract_declared: true,
      blocker_count: 0,
      workflow_readiness_blocking: false,
      proof_state: 'READY',
      proof_readiness_hash: `sha256:${slug}`,
      failed_report_ids: [],
    },
    repair_queue: { open_proof_blocker_count: 0 },
    latest_gate: { status: 'PASS' },
    package: { status: 'PASS', present: true },
    submission_preflight: { status: 'PASS', present: true, warning_count: 0 },
    release_verify: {
      status: 'PASS',
      present: true,
      current_package_verify_semantics_pass: true,
    },
    manual_venue_authorization: { external_action_authorized: true },
  };
}

const fixtures = [
  { ...readySnapshot('source_missing'), source_ready: false, main_tex: '' },
  {
    ...readySnapshot('contract_missing'),
    proof_readiness: { contract_declared: false, blocker_count: 0, proof_state: '' },
  },
  {
    ...readySnapshot('proof_blocked'),
    proof_readiness: {
      contract_declared: true,
      blocker_count: '2',
      workflow_readiness_blocking: true,
      proof_state: 'BLOCKED',
      failed_report_ids: ['proof-a', 'proof-b'],
    },
  },
  {
    ...readySnapshot('repair_requested'),
    proof_readiness: {
      contract_declared: true,
      blocker_count: 2,
      workflow_readiness_blocking: true,
      proof_state: 'BLOCKED',
      failed_report_ids: ['proof-a'],
    },
    repair_queue: { open_proof_blocker_count: '2', request_ids: ['r1', 'r2'] },
  },
  { ...readySnapshot('gate_blocked'), latest_gate: { status: 'FAIL', gate_hash: 'sha256:gate' } },
  { ...readySnapshot('package_blocked'), package: { status: 'FAIL', present: false } },
  {
    ...readySnapshot('preflight_blocked'),
    submission_preflight: { status: 'FAIL', present: true, warning_count: 0 },
  },
  {
    ...readySnapshot('warning_review_blocked'),
    submission_preflight: { status: 'PASS', present: true, warning_count: 2 },
    warning_review: { status: 'FAIL', warning_count: 2, unresolved_count: 1 },
  },
  {
    ...readySnapshot('local_release_blocked'),
    release_verify: {
      status: 'PASS',
      present: true,
      current_package_verify_semantics_pass: false,
    },
  },
  {
    ...readySnapshot('external_auth_required'),
    manual_venue_authorization: { external_action_authorized: false },
  },
  readySnapshot('production_ready_local_only'),
];

const artifactCases = [
  {
    requestedLabel: 'requested',
    latestLabel: 'latest',
    requestedPackageCount: 2,
    requestedPresentCount: 2,
  },
  {
    requestedLabel: 'requested',
    latestLabel: 'latest',
    requestedPackageCount: 2,
    requestedPresentCount: 0,
  },
  {
    requestedLabel: '',
    latestLabel: 'latest',
    requestedPackageCount: '3',
    requestedPresentCount: null,
  },
  {
    requestedLabel: '',
    latestLabel: '',
    requestedPackageCount: 'invalid',
  },
];

const pythonProgram = String.raw`
import importlib.util
import json
import sys

payload = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location("legacy_paper_production_core", payload["source_module"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
evaluations = [module.evaluate_paper(item) for item in payload["fixtures"]]
single_audits = [
    module.audit_report([item], label="single", created_at=payload["created_at"])
    for item in payload["fixtures"]
]
artifact_cases = [
    module.resolve_artifact_label(
        requested_label=item.get("requestedLabel", ""),
        latest_label=item.get("latestLabel", ""),
        requested_package_count=item.get("requestedPackageCount", 0),
        requested_present_count=item.get("requestedPresentCount"),
    )
    for item in payload["artifact_cases"]
]
result = {
    "evaluations": evaluations,
    "summary": module.summarize(evaluations),
    "audit": module.audit_report(
        payload["fixtures"],
        label="differential",
        created_at=payload["created_at"],
        skipped=["fixture-skip"],
    ),
    "single_frontiers": [module.repair_loop_frontier(item) for item in single_audits],
    "repair_shard": module.repair_loop_frontier_slug_shard(
        module.repair_loop_frontier(single_audits[3]),
        worker_limit=1,
    ),
    "terminal_shard": module.repair_loop_frontier_slug_shard(
        module.repair_loop_frontier(single_audits[-1]),
        worker_limit=1,
    ),
    "artifact_cases": artifact_cases,
}
json.dump(result, sys.stdout, sort_keys=True)
`;

const python = spawnSync('python3', ['-c', pythonProgram], {
  cwd: workspaceRoot,
  input: JSON.stringify({
    source_module: sourceModule,
    fixtures,
    artifact_cases: artifactCases,
    created_at: createdAt,
  }),
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(python.status, 0, python.stderr || python.stdout);
const expected = JSON.parse(python.stdout);

const evaluations = fixtures.map(evaluateLegacyProductionSnapshot);
const singleAudits = fixtures.map((paperSnapshots) => buildLegacyProductionAudit({
  paperSnapshots: [paperSnapshots],
  label: 'single',
  createdAt,
}));
const actual = {
  evaluations,
  summary: summarizeLegacyProductionEvaluations(evaluations),
  audit: buildLegacyProductionAudit({
    paperSnapshots: fixtures,
    label: 'differential',
    createdAt,
    skipped: ['fixture-skip'],
  }),
  single_frontiers: singleAudits.map(legacyRepairLoopFrontier),
  repair_shard: legacyRepairLoopFrontierSlugShard(
    legacyRepairLoopFrontier(singleAudits[3]),
    1,
  ),
  terminal_shard: legacyRepairLoopFrontierSlugShard(
    legacyRepairLoopFrontier(singleAudits.at(-1)),
    1,
  ),
  artifact_cases: artifactCases.map(resolveLegacyArtifactLabel),
};

assert.deepEqual(actual, expected);
assert.deepEqual(
  actual.evaluations.map((item) => item.production_state),
  [
    'SOURCE_MISSING',
    'CONTRACT_MISSING',
    'PROOF_BLOCKED',
    'REPAIR_REQUESTED',
    'GATE_BLOCKED',
    'PACKAGE_BLOCKED',
    'PREFLIGHT_BLOCKED',
    'WARNING_REVIEW_BLOCKED',
    'LOCAL_RELEASE_BLOCKED',
    'EXTERNAL_AUTH_REQUIRED',
    'PRODUCTION_READY_LOCAL_ONLY',
  ],
);
assert.equal(actual.audit.boundary.external_action_performed, false);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P0ProductionCoreDifferentialTest',
  stateCount: actual.evaluations.length,
  frontierCount: actual.single_frontiers.length,
  artifactResolutionCaseCount: actual.artifact_cases.length,
  exactDifferentialParity: true,
  externalActionPerformed: false,
}) + '\n');
