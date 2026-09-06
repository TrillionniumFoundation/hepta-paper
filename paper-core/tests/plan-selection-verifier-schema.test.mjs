import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createActionCandidate, routeActionCandidates }
  from '../../paper-application/orchestration/candidate-router.mjs';
import { selectBoundedGlobalPlan }
  from '../../paper-application/orchestration/bounded-plan-selector.mjs';
import { verifyFeasiblePlanSelection }
  from '../../paper-application/orchestration/plan-selection-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = (character) => `sha256:${character.repeat(64)}`;
const nowEpochMs = Date.parse('2026-09-06T00:00:00Z');
const planningRequest = {
  schemaVersion: 1,
  kind: 'PlanningRequestV1',
  planningRequestId: 'verify-schema-plan',
  stateSnapshotHash: H('a'),
  capabilityId: 'CAP-MOD-CANDIDATES',
  hardConstraintSetHash: H('b'),
  objectiveVersion: 'objective-v1',
  resourcePriceSnapshotHash: H('c'),
  candidateLimit: 1,
  deadline: '2027-01-01T00:00:00Z',
  allowedSideEffectClasses: ['none'],
  inputArtifactHashes: [],
};
const binding = {
  moduleId: 'module.alpha',
  moduleVersion: '1.0.0',
  capabilityIds: ['CAP-MOD-CANDIDATES'],
  qualificationSubjectHash: H('d'),
  validUntil: '2027-01-01T00:00:00Z',
};
const candidate = createActionCandidate({
  schemaVersion: 1,
  kind: 'ActionCandidateV1',
  candidateId: 'candidate-a',
  planningRequestId: planningRequest.planningRequestId,
  stateSnapshotHash: planningRequest.stateSnapshotHash,
  moduleId: binding.moduleId,
  moduleVersion: binding.moduleVersion,
  capabilityId: planningRequest.capabilityId,
  resourceVector: {
    cpuUnits: 1, gpuUnits: 0, memoryMiB: 0, storageBytes: 0,
    tokenCount: 0, maximumCostMicrousd: 0,
  },
  duration: {}, cost: {}, value: {}, risk: {},
  preconditions: [], dependencyEffects: [], sideEffectClass: 'none',
  irreversibleBoundary: null, rollbackClass: 'no_effect',
  expiresAt: '2026-12-31T00:00:00Z', inputSchema: null, outputSchema: null,
  singletonReason: 'only_feasible_candidate',
});
const frontier = routeActionCandidates({
  request: planningRequest,
  moduleBindings: [binding],
  candidates: [candidate],
  nowEpochMs,
});
const request = {
  schemaVersion: 1,
  kind: 'GlobalPlanSelectionRequestV1',
  selectionRequestId: 'verify-schema-selection',
  planningRequestHash: frontier.planningRequestHash,
  stateSnapshotHash: frontier.stateSnapshotHash,
  candidateSetHash: frontier.candidateSetHash,
  hardConstraintSetHash: frontier.hardConstraintSetHash,
  objectiveVersion: frontier.objectiveVersion,
  resourcePriceSnapshotHash: frontier.resourcePriceSnapshotHash,
  deadline: '2026-12-30T00:00:00Z',
  expansionBudget: 100,
  maximumSelectedCandidates: 1,
  resourceLimits: {
    cpuMilliunits: 1000, gpuMilliunits: 0, memoryMiB: 0,
    storageBytes: 0, tokenCount: 0, maximumCostMicrousd: 0,
  },
  requiredCandidateIds: [],
  evaluations: [{
    candidateId: candidate.candidateId,
    candidatePayloadHash: candidate.candidatePayloadHash,
    utilityMicrounits: 7,
    dependencies: [],
    mutexGroup: null,
  }],
};
const selection = selectBoundedGlobalPlan({ frontier, request, nowEpochMs });
const receipt = verifyFeasiblePlanSelection({ frontier, request, selection, nowEpochMs });

function validate(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-plan-schema-'));
  try {
    const instance = path.join(directory, 'instance.json');
    fs.writeFileSync(instance, `${JSON.stringify(value, null, 2)}\n`);
    return spawnSync('python3', [
      'docs/rust/tools/strict_json_schema.py',
      '--schema', 'docs/modules/schemas/verified-feasible-plan-selection-v1.schema.json',
      '--instance', instance,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('implementation receipt validates against closed schema', () => {
  const checked = validate(receipt);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.equal(receipt.exactOptimalityVerified, true);
});

test('schema rejects authority, exactness and source-claim splicing', () => {
  for (const invalid of [
    { ...receipt, authority: { ...receipt.authority, executionAuthorized: true } },
    { ...receipt, exactEnumerationPerformed: false },
    { ...receipt, exactOptimalityVerified: false },
    { ...receipt, proof: { ...receipt.proof, sourceUpperBoundVerified: false } },
    { ...receipt, sourceStatus: 'bounded_feasible', sourceOptimalityClaimAccepted: true },
    { ...receipt, credential: 'forbidden' },
  ]) {
    const checked = validate(invalid);
    assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  }
});
