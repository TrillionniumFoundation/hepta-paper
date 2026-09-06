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
  sealCandidateBatchJsonV1,
} from '../../paper-application/orchestration/candidate-disposition-collector.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaRoot = path.join(root, 'docs/modules/schemas');
const schemas = Object.freeze({
  sealed: path.join(schemaRoot, 'sealed-candidate-batch-json-v1.schema.json'),
  disposition: path.join(schemaRoot, 'module-candidate-disposition-v1.schema.json'),
  request: path.join(schemaRoot, 'candidate-disposition-collection-request-v1.schema.json'),
  result: path.join(schemaRoot, 'candidate-disposition-collection-v1.schema.json'),
});
const h = (character) => `sha256:${character.repeat(64)}`;
const producer = Object.freeze({
  moduleId: 'module.alpha',
  moduleVersion: '1.0.0',
  qualificationMetadataHash: h('1'),
});

function authority() {
  return {
    productionAuthorized: false,
    providerAuthorized: false,
    campaignWriterActivated: false,
    releaseAuthorized: false,
    submissionAuthorized: false,
    externalAuthorityClaimed: false,
  };
}

function candidate() {
  return {
    candidateId: 'candidate-schema',
    candidatePayloadHash: h('2'),
    planningRequestId: 'planning-request-schema',
    stateSnapshotHash: h('3'),
    moduleId: producer.moduleId,
    moduleVersion: producer.moduleVersion,
    capabilityId: 'CAP-MOD-CANDIDATE',
    value: { utility: 1 },
  };
}

function sealed() {
  return sealCandidateBatchJsonV1({
    inputBoundary: CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
    planningRequestId: 'planning-request-schema',
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    moduleId: producer.moduleId,
    moduleVersion: producer.moduleVersion,
    candidates: [candidate()],
    maximumCandidates: 32,
    maximumBatchBytes: 1024 * 1024,
    maximumNodes: 10000,
  });
}

function completeDisposition(batch = sealed()) {
  return {
    schemaVersion: 1,
    kind: 'ModuleCandidateDispositionV1',
    moduleId: producer.moduleId,
    moduleVersion: producer.moduleVersion,
    qualificationMetadataHash: producer.qualificationMetadataHash,
    planningRequestId: 'planning-request-schema',
    planningRequestHash: h('4'),
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    status: 'candidate_batch_complete',
    completedAt: '2026-09-06T07:59:00Z',
    candidateCount: batch.candidateCount,
    candidateBatchJson: batch.candidateBatchJson,
    candidateBatchByteHash: batch.candidateBatchByteHash,
    emptyReason: null,
    failureCode: null,
    externalActionPerformed: false,
    authority: authority(),
  };
}

function failureDisposition() {
  return {
    ...completeDisposition(),
    status: 'candidate_batch_timeout',
    candidateCount: null,
    candidateBatchJson: null,
    candidateBatchByteHash: null,
    emptyReason: null,
    failureCode: 'producer_timeout_unreconciled',
  };
}

function request(dispositions = [completeDisposition()]) {
  return {
    schemaVersion: 1,
    kind: 'CandidateDispositionCollectionRequestV1',
    inputBoundary: CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
    planningRequestId: 'planning-request-schema',
    planningRequestHash: h('4'),
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    moduleQualificationMetadataSetHash: h('5'),
    observedAt: '2026-09-06T08:00:00Z',
    deadline: '2026-09-06T09:00:00Z',
    expectedProducers: [producer],
    dispositions,
    maximumProducers: 16,
    maximumCandidates: 32,
    maximumBatchBytes: 1024 * 1024,
    maximumTotalBytes: 2 * 1024 * 1024,
    maximumNodes: 10000,
  };
}

function validate(schema, instance) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-disposition-protocol-'));
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

function valid(schema, instance) {
  const result = validate(schema, instance);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function invalid(schema, instance) {
  const result = validate(schema, instance);
  assert.notEqual(result.status, 0, 'hostile protocol record matched schema');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('all four committed schemas accept real runtime records', () => {
  const batch = sealed();
  const disposition = completeDisposition(batch);
  const collectionRequest = request([disposition]);
  const result = collectCandidateDispositionBytesV1(collectionRequest);
  valid(schemas.sealed, batch);
  valid(schemas.disposition, disposition);
  valid(schemas.request, collectionRequest);
  valid(schemas.result, result);
});

test('module disposition schema distinguishes complete and failure shapes', () => {
  valid(schemas.disposition, completeDisposition());
  valid(schemas.disposition, failureDisposition());

  const completeWithFailure = clone(completeDisposition());
  completeWithFailure.failureCode = 'producer_failed';
  invalid(schemas.disposition, completeWithFailure);

  const failureWithBytes = clone(failureDisposition());
  failureWithBytes.candidateBatchJson = '[]';
  invalid(schemas.disposition, failureWithBytes);

  const completeWithoutCount = clone(completeDisposition());
  completeWithoutCount.candidateCount = null;
  invalid(schemas.disposition, completeWithoutCount);
});

test('zero-candidate complete disposition requires an explicit empty reason', () => {
  const batch = sealCandidateBatchJsonV1({
    inputBoundary: CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
    planningRequestId: 'planning-request-schema',
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    moduleId: producer.moduleId,
    moduleVersion: producer.moduleVersion,
    candidates: [],
    maximumCandidates: 32,
    maximumBatchBytes: 1024 * 1024,
    maximumNodes: 10000,
  });
  const value = {
    ...completeDisposition(batch),
    emptyReason: 'no_candidates',
  };
  valid(schemas.disposition, value);
  value.emptyReason = null;
  invalid(schemas.disposition, value);
});

test('request schema rejects trust-boundary, authority and hard-limit drift', () => {
  const value = request();
  valid(schemas.request, value);

  const boundary = clone(value);
  boundary.inputBoundary = 'untrusted';
  invalid(schemas.request, boundary);

  const authorityEscalation = clone(value);
  authorityEscalation.dispositions[0].authority.providerAuthorized = true;
  invalid(schemas.request, authorityEscalation);

  const widened = clone(value);
  widened.maximumProducers = 1025;
  invalid(schemas.request, widened);

  const unknown = clone(value);
  unknown.unregisteredField = false;
  invalid(schemas.request, unknown);
});

test('sealed batch schema rejects authority and unknown-field splicing', () => {
  const value = sealed();
  valid(schemas.sealed, value);

  const authorityEscalation = clone(value);
  authorityEscalation.authority.releaseAuthorized = true;
  invalid(schemas.sealed, authorityEscalation);

  const unknown = clone(value);
  unknown.unregisteredField = false;
  invalid(schemas.sealed, unknown);

  const malformedHash = clone(value);
  malformedHash.candidateBatchByteHash = 'sha256:nope';
  invalid(schemas.sealed, malformedHash);
});

test('all protocol schemas are closed at their authority boundary', () => {
  for (const schemaPath of Object.values(schemas)) {
    const value = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.equal(value.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(value.additionalProperties, false);
  }
});
