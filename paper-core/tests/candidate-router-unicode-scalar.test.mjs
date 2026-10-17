import assert from 'node:assert/strict';
import test from 'node:test';
import { sealActionCandidateV1 } from '../../paper-application/orchestration/candidate-router.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;

function candidatePayload(value) {
  return {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: 'candidate:unicode-scalar-control',
    planningRequestId: 'request:unicode-scalar-control',
    stateSnapshotHash: hash('b'),
    moduleId: 'module.author-node',
    moduleVersion: '1.0.0',
    capabilityId: 'CAP-AUTHOR',
    resourceVector: {
      cpuUnits: 1,
      gpuUnits: 0,
      memoryMiB: 1,
      storageBytes: 0,
      tokenCount: 0,
      maximumCostMicrousd: 0,
    },
    duration: {},
    cost: {},
    value,
    risk: {},
    preconditions: [],
    dependencyEffects: [],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'discard-prepared-result',
    expiresAt: '2026-09-06T23:00:00Z',
    inputSchema: null,
    outputSchema: null,
    singletonReason: 'only_feasible_candidate',
  };
}

function ownRecord(entries) {
  const value = Object.create(null);
  for (const [key, item] of entries) {
    Object.defineProperty(value, key, { value: item, enumerable: true });
  }
  return value;
}

test('opposite lone-high-surrogate insertion orders are both rejected', () => {
  for (const entries of [
    [['\uD800', 1], ['\uD801', 2]],
    [['\uD801', 2], ['\uD800', 1]],
  ]) {
    assert.throws(
      () => sealActionCandidateV1(candidatePayload(ownRecord(entries))),
      { code: 'candidate_value_key_invalid' },
    );
  }
});

test('opposite lone-low-surrogate insertion orders are both rejected', () => {
  for (const entries of [
    [['\uDC00', 1], ['\uDC01', 2]],
    [['\uDC01', 2], ['\uDC00', 1]],
  ]) {
    assert.throws(
      () => sealActionCandidateV1(candidatePayload(ownRecord(entries))),
      { code: 'candidate_value_key_invalid' },
    );
  }
});

test('unpaired surrogate string values are rejected before hashing', () => {
  for (const text of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF']) {
    assert.throws(
      () => sealActionCandidateV1(candidatePayload({ text })),
      { code: 'candidate_value_string_invalid' },
    );
  }
});

test('valid surrogate pairs and U+FFFD remain insertion-order invariant', () => {
  const entries = [['😀', 1], ['😁', 2], ['\uFFFD', 3]];
  const forward = sealActionCandidateV1(candidatePayload(ownRecord(entries)));
  const reverse = sealActionCandidateV1(candidatePayload(ownRecord([...entries].reverse())));
  assert.equal(forward.candidatePayloadHash, reverse.candidatePayloadHash);
  assert.deepEqual(forward.value, reverse.value);
  assert.equal(forward.value['😀'], 1);
  assert.equal(forward.value['😁'], 2);
  assert.equal(forward.value['\uFFFD'], 3);
});
