import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
  collectCandidateDispositionBytesV1,
} from '../../paper-application/orchestration/candidate-disposition-collector.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = path.join(
  root,
  'docs/modules/schemas/candidate-disposition-collection-v1.schema.json',
);
const h = (character) => `sha256:${character.repeat(64)}`;

function request(expectedProducers = []) {
  return {
    schemaVersion: 1,
    kind: 'CandidateDispositionCollectionRequestV1',
    inputBoundary: CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
    planningRequestId: 'planning-request-schema',
    planningRequestHash: h('1'),
    stateSnapshotHash: h('2'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    moduleQualificationMetadataSetHash: h('3'),
    observedAt: '2026-09-06T08:00:00Z',
    deadline: '2026-09-06T09:00:00Z',
    expectedProducers,
    dispositions: [],
    maximumProducers: 16,
    maximumCandidates: 32,
    maximumBatchBytes: 1024 * 1024,
    maximumTotalBytes: 2 * 1024 * 1024,
    maximumNodes: 10000,
  };
}

function validate(instance) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-disposition-schema-'));
  const instancePath = path.join(directory, 'instance.json');
  try {
    fs.writeFileSync(instancePath, `${JSON.stringify(instance, null, 2)}\n`);
    return spawnSync('python3', [
      'docs/rust/tools/strict_json_schema.py',
      '--schema', schema,
      '--instance', instancePath,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function expectValid(instance) {
  const result = validate(instance);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function expectInvalid(instance) {
  const result = validate(instance);
  assert.notEqual(result.status, 0, 'hostile instance unexpectedly matched schema');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('closed schema accepts real complete and incomplete runtime outputs', () => {
  const complete = collectCandidateDispositionBytesV1(request());
  const incomplete = collectCandidateDispositionBytesV1(request([{
    moduleId: 'module.alpha',
    moduleVersion: '1.0.0',
    qualificationMetadataHash: h('4'),
  }]));
  expectValid(complete);
  expectValid(incomplete);
  assert.equal(complete.status, 'candidate_dispositions_complete');
  assert.equal(incomplete.status, 'candidate_dispositions_incomplete');
});

test('schema rejects complete/incomplete status and null-shape splicing', () => {
  const complete = collectCandidateDispositionBytesV1(request());
  const incomplete = collectCandidateDispositionBytesV1(request([{
    moduleId: 'module.alpha',
    moduleVersion: '1.0.0',
    qualificationMetadataHash: h('4'),
  }]));

  const completeNotReady = clone(complete);
  completeNotReady.readyForRouting = false;
  expectInvalid(completeNotReady);

  const completeWithoutCandidates = clone(complete);
  completeWithoutCandidates.candidates = null;
  expectInvalid(completeWithoutCandidates);

  const incompleteWithCandidates = clone(incomplete);
  incompleteWithCandidates.candidates = [];
  expectInvalid(incompleteWithCandidates);

  const incompleteWithoutReason = clone(incomplete);
  incompleteWithoutReason.incompleteReasons = [];
  expectInvalid(incompleteWithoutReason);

  const incompleteWithSetHash = clone(incomplete);
  incompleteWithSetHash.candidateSetInputHash = h('5');
  expectInvalid(incompleteWithSetHash);
});

test('schema rejects authority, execution and unknown-field escalation', () => {
  const complete = collectCandidateDispositionBytesV1(request());

  const authority = clone(complete);
  authority.authority.productionAuthorized = true;
  expectInvalid(authority);

  const execution = clone(complete);
  execution.executionEligible = true;
  expectInvalid(execution);

  const unknown = clone(complete);
  unknown.unregisteredField = false;
  expectInvalid(unknown);
});

test('schema rejects malformed producer disposition shapes', () => {
  const incomplete = collectCandidateDispositionBytesV1(request([{
    moduleId: 'module.alpha',
    moduleVersion: '1.0.0',
    qualificationMetadataHash: h('4'),
  }]));

  const badStatus = clone(incomplete);
  badStatus.producerDispositions[0].status = 'success';
  expectInvalid(badStatus);

  const extra = clone(incomplete);
  extra.producerDispositions[0].candidateBatchJson = '[]';
  expectInvalid(extra);

  const invalidHash = clone(incomplete);
  invalidHash.producerDispositions[0].qualificationMetadataHash = 'sha256:nope';
  expectInvalid(invalidHash);
});

test('schema itself is closed and fixes all authority fields false', () => {
  const value = JSON.parse(fs.readFileSync(schema, 'utf8'));
  assert.equal(value.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(value.additionalProperties, false);
  assert.equal(value.$defs.authority.additionalProperties, false);
  for (const property of Object.values(value.$defs.authority.properties)) {
    assert.deepEqual(property, { const: false });
  }
});
