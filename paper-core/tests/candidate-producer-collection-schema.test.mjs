import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createActionCandidate } from '../../paper-application/orchestration/candidate-router.mjs';
import { collectModuleCandidateFrontier } from '../../paper-application/orchestration/candidate-producer-collection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = (character) => `sha256:${character.repeat(64)}`;
const nowEpochMs = Date.parse('2026-09-06T00:00:00Z');
const request = Object.freeze({
  schemaVersion: 1,
  kind: 'PlanningRequestV1',
  planningRequestId: 'collection-schema-plan',
  stateSnapshotHash: H('a'),
  capabilityId: 'CAP-MOD-CANDIDATES',
  hardConstraintSetHash: H('b'),
  objectiveVersion: 'objective-v1',
  resourcePriceSnapshotHash: H('c'),
  candidateLimit: 4,
  deadline: '2026-12-31T00:00:00Z',
  allowedSideEffectClasses: ['none'],
  inputArtifactHashes: [],
});
const binding = Object.freeze({
  moduleId: 'module.alpha',
  moduleVersion: '1.0.0',
  capabilityIds: ['CAP-MOD-CANDIDATES'],
  qualificationSubjectHash: H('d'),
  validUntil: '2026-12-31T00:00:00Z',
});
const action = createActionCandidate({
  schemaVersion: 1,
  kind: 'ActionCandidateV1',
  candidateId: 'candidate-a',
  planningRequestId: request.planningRequestId,
  stateSnapshotHash: request.stateSnapshotHash,
  moduleId: binding.moduleId,
  moduleVersion: binding.moduleVersion,
  capabilityId: request.capabilityId,
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
  expiresAt: '2026-12-30T00:00:00Z',
  inputSchema: null,
  outputSchema: null,
  singletonReason: 'only_feasible_candidate',
});
let capturedResponse;
const collection = await collectModuleCandidateFrontier({
  request,
  moduleBindings: [binding],
  producers: [{
    moduleId: binding.moduleId,
    moduleVersion: binding.moduleVersion,
    produce(input) {
      capturedResponse = {
        schemaVersion: 1,
        kind: 'ModuleCandidateResponseV1',
        status: 'complete',
        moduleId: binding.moduleId,
        moduleVersion: binding.moduleVersion,
        planningRequestHash: input.planningRequestHash,
        candidates: [action],
        emptyReason: null,
        authority: {
          productionAuthorized: false,
          providerAuthorized: false,
          writerAuthorityGranted: false,
          externalAuthorityClaimed: false,
        },
      };
      return capturedResponse;
    },
  }],
  nowEpochMs,
});

function validate(schema, value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-collection-schema-'));
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

test('actual module response and collection receipt validate against closed schemas', () => {
  for (const [schema, value] of [
    ['docs/modules/schemas/module-candidate-response-v1.schema.json', capturedResponse],
    ['docs/modules/schemas/collected-candidate-frontier-v1.schema.json', collection],
  ]) {
    const checked = validate(schema, value);
    assert.equal(checked.status, 0, `${schema}\n${checked.stdout}\n${checked.stderr}`);
  }
});

test('module response schema rejects partial status, empty-reason and authority splicing', () => {
  for (const invalid of [
    { ...capturedResponse, status: 'partial' },
    { ...capturedResponse, emptyReason: 'not-empty' },
    { ...capturedResponse, authority: { ...capturedResponse.authority, providerAuthorized: true } },
    { ...capturedResponse, credential: 'forbidden' },
  ]) {
    const checked = validate('docs/modules/schemas/module-candidate-response-v1.schema.json', invalid);
    assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  }
});

test('collection schema rejects receipt/frontier count and authority splicing', () => {
  for (const invalid of [
    { ...collection, producerCount: 2 },
    { ...collection, rawCandidateCount: 0 },
    { ...collection, candidateSetHash: H('9') },
    { ...collection, authority: { ...collection.authority, productionAuthorized: true } },
    { ...collection, unrecognizedField: false },
  ]) {
    const checked = validate('docs/modules/schemas/collected-candidate-frontier-v1.schema.json', invalid);
    assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  }
});
