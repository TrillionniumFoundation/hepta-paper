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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = (character) => `sha256:${character.repeat(64)}`;
const request = {
  schemaVersion: 1,
  kind: 'PlanningRequestV1',
  planningRequestId: 'schema-round-trip',
  stateSnapshotHash: H('a'),
  capabilityId: 'CAP-MOD-CANDIDATES',
  hardConstraintSetHash: H('b'),
  objectiveVersion: 'objective-v1',
  resourcePriceSnapshotHash: H('c'),
  candidateLimit: 4,
  deadline: '2030-01-01T00:00:00Z',
  allowedSideEffectClasses: ['none'],
  inputArtifactHashes: [],
};
const binding = {
  moduleId: 'module.alpha',
  moduleVersion: '1.0.0',
  capabilityIds: ['CAP-MOD-CANDIDATES'],
  qualificationSubjectHash: H('d'),
  validUntil: '2029-12-31T00:00:00Z',
};
const candidate = createActionCandidate({
  schemaVersion: 1,
  kind: 'ActionCandidateV1',
  candidateId: 'candidate-1',
  planningRequestId: request.planningRequestId,
  stateSnapshotHash: request.stateSnapshotHash,
  moduleId: binding.moduleId,
  moduleVersion: binding.moduleVersion,
  capabilityId: request.capabilityId,
  resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 128, storageBytes: 0 },
  duration: { upperMs: 100 },
  cost: { upperMicrousd: 0 },
  value: { expected: 1 },
  risk: { failureProbability: 0 },
  sideEffectClass: 'none',
  rollbackClass: 'no_effect',
  expiresAt: '2029-12-30T00:00:00Z',
  singletonReason: 'only_feasible_candidate',
});
const frontier = routeActionCandidates({
  request,
  moduleBindings: [binding],
  candidates: [candidate],
  nowEpochMs: Date.parse('2026-09-06T00:00:00Z'),
});

function validate(schema, value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-router-schema-'));
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

test('planning request, module binding, candidate and frontier validate against committed schemas', () => {
  for (const [schema, value] of [
    ['docs/modules/schemas/planning-request-v1.schema.json', request],
    ['docs/modules/schemas/qualified-module-binding-v1.schema.json', binding],
    ['docs/modules/schemas/action-candidate-v1.schema.json', candidate],
    ['docs/modules/schemas/candidate-frontier-v1.schema.json', frontier],
  ]) {
    const result = validate(schema, value);
    assert.equal(result.status, 0, `${schema}\n${result.stdout}\n${result.stderr}`);
  }
});

test('closed frontier schema rejects authority escalation and unknown fields', () => {
  for (const invalid of [
    { ...frontier, authority: { ...frontier.authority, productionAuthorized: true } },
    { ...frontier, unrecognizedAuthority: false },
    { ...frontier, dominanceReductionApplied: true },
  ]) {
    const result = validate('docs/modules/schemas/candidate-frontier-v1.schema.json', invalid);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});
