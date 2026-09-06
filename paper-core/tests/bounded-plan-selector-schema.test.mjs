import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createActionCandidate,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';
import { selectBoundedGlobalPlan } from '../../paper-application/orchestration/bounded-plan-selector.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = (character) => `sha256:${character.repeat(64)}`;
const planningRequest = {
  schemaVersion: 1,
  kind: 'PlanningRequestV1',
  planningRequestId: 'schema-plan',
  stateSnapshotHash: H('a'),
  capabilityId: 'CAP-MOD-CANDIDATES',
  hardConstraintSetHash: H('b'),
  objectiveVersion: 'objective-v1',
  resourcePriceSnapshotHash: H('c'),
  candidateLimit: 2,
  deadline: '2030-01-01T00:00:00Z',
  allowedSideEffectClasses: ['none'],
  inputArtifactHashes: [],
};
const moduleBinding = {
  moduleId: 'module.alpha',
  moduleVersion: '1.0.0',
  capabilityIds: ['CAP-MOD-CANDIDATES'],
  qualificationSubjectHash: H('d'),
  validUntil: '2029-12-31T00:00:00Z',
};
const action = createActionCandidate({
  schemaVersion: 1,
  kind: 'ActionCandidateV1',
  candidateId: 'candidate-a',
  planningRequestId: planningRequest.planningRequestId,
  stateSnapshotHash: planningRequest.stateSnapshotHash,
  moduleId: moduleBinding.moduleId,
  moduleVersion: moduleBinding.moduleVersion,
  capabilityId: planningRequest.capabilityId,
  resourceVector: {
    cpuUnits: 1,
    gpuUnits: 0,
    memoryMiB: 128,
    storageBytes: 0,
    tokenCount: 0,
    maximumCostMicrousd: 0,
  },
  duration: { upperMs: 100 },
  cost: { upperMicrousd: 0 },
  value: { advisory: 1 },
  risk: { failureProbability: 0 },
  preconditions: [],
  dependencyEffects: [],
  sideEffectClass: 'none',
  irreversibleBoundary: null,
  rollbackClass: 'no_effect',
  expiresAt: '2029-12-30T00:00:00Z',
  inputSchema: null,
  outputSchema: null,
  singletonReason: 'only_feasible_candidate',
});
const frontier = routeActionCandidates({
  request: planningRequest,
  moduleBindings: [moduleBinding],
  candidates: [action],
  nowEpochMs: Date.parse('2026-09-06T00:00:00Z'),
});
const request = {
  schemaVersion: 1,
  kind: 'GlobalPlanSelectionRequestV1',
  selectionRequestId: 'selection-schema',
  planningRequestHash: frontier.planningRequestHash,
  stateSnapshotHash: frontier.stateSnapshotHash,
  candidateSetHash: frontier.candidateSetHash,
  hardConstraintSetHash: frontier.hardConstraintSetHash,
  objectiveVersion: frontier.objectiveVersion,
  resourcePriceSnapshotHash: frontier.resourcePriceSnapshotHash,
  deadline: '2029-12-29T00:00:00Z',
  expansionBudget: 100,
  maximumSelectedCandidates: 1,
  resourceLimits: {
    cpuMilliunits: 1000,
    gpuMilliunits: 0,
    memoryMiB: 128,
    storageBytes: 0,
    tokenCount: 0,
    maximumCostMicrousd: 0,
  },
  requiredCandidateIds: [],
  evaluations: [{
    candidateId: action.candidateId,
    candidatePayloadHash: action.candidatePayloadHash,
    utilityMicrounits: 7,
    dependencies: [],
    mutexGroup: null,
  }],
};
const result = selectBoundedGlobalPlan({
  frontier,
  request,
  nowEpochMs: Date.parse('2026-09-06T00:00:00Z'),
});

function validate(schema, value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-plan-schema-'));
  try {
    const instance = path.join(directory, 'instance.json');
    fs.writeFileSync(instance, `${JSON.stringify(value, null, 2)}\n`);
    return spawnSync('python3', [
      'docs/rust/tools/strict_json_schema.py',
      '--schema', schema,
      '--instance', instance,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('selection request and implementation result validate against committed schemas', () => {
  for (const [schema, value] of [
    ['docs/modules/schemas/global-plan-selection-request-v1.schema.json', request],
    ['docs/modules/schemas/bounded-global-plan-selection-v1.schema.json', result],
  ]) {
    const checked = validate(schema, value);
    assert.equal(checked.status, 0, `${schema}\n${checked.stdout}\n${checked.stderr}`);
  }
  assert.equal(result.status, 'optimal');
  assert.equal(result.optimalityGapMicrounits, 0);
});

test('result schema rejects authority escalation and disposition splicing', () => {
  for (const invalid of [
    { ...result, authority: { ...result.authority, executionAuthorized: true } },
    { ...result, status: 'infeasible' },
    { ...result, proof: { ...result.proof, optimalSelectionProven: false } },
    { ...result, unrecognizedAuthority: false },
  ]) {
    const checked = validate('docs/modules/schemas/bounded-global-plan-selection-v1.schema.json', invalid);
    assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  }
});
