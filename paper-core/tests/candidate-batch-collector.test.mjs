import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCandidateBatchesV1 }
  from '../../paper-application/orchestration/candidate-batch-collector.mjs';
import {
  captureQualifiedPlanningModuleSetV1,
  sealActionCandidateV1,
} from '../../paper-application/orchestration/candidate-router.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;
const observedAt = '2026-09-06T02:00:00Z';
const modules = [
  Object.freeze({
    moduleId: 'module.author-node', moduleVersion: '1.0.0',
    capabilityIds: Object.freeze(['CAP-AUTHOR']),
    qualificationStatus: 'source_qualified', qualificationIdentity: hash('a'),
  }),
  Object.freeze({
    moduleId: 'module.reviewer-node', moduleVersion: '1.0.0',
    capabilityIds: Object.freeze(['CAP-AUTHOR']),
    qualificationStatus: 'source_qualified', qualificationIdentity: hash('b'),
  }),
];
const moduleSetHash = captureQualifiedPlanningModuleSetV1(modules)
  .qualifiedModuleSetHash;

function request(overrides = {}) {
  return {
    schemaVersion: 1, kind: 'PlanningRequestV1',
    planningRequestId: 'request:collect', stateSnapshotHash: hash('c'),
    capabilityId: 'CAP-AUTHOR', hardConstraintSetHash: hash('d'),
    objectiveVersion: 'objective-v1', resourcePriceSnapshotHash: hash('e'),
    qualifiedModuleSetHash: moduleSetHash, candidateLimit: 8,
    maximumCandidateBytes: 16 * 1024,
    maximumTotalCandidateBytes: 64 * 1024,
    deadline: '2026-09-06T03:00:00Z', allowedSideEffectClasses: ['none'],
    inputArtifacts: [], ...overrides,
  };
}

function candidate(moduleId, candidateId, overrides = {}) {
  return sealActionCandidateV1({
    schemaVersion: 1, kind: 'ActionCandidateV1', candidateId,
    planningRequestId: 'request:collect', stateSnapshotHash: hash('c'),
    moduleId, moduleVersion: '1.0.0', capabilityId: 'CAP-AUTHOR',
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 256, storageBytes: 0 },
    duration: { maximumMilliseconds: 1000 }, cost: { maximumMicrousd: 1 },
    value: { score: 1 }, risk: { failureProbabilityPpm: 1 },
    preconditions: [], dependencyEffects: [], sideEffectClass: 'none',
    irreversibleBoundary: null, rollbackClass: 'discard',
    expiresAt: '2026-09-06T02:30:00Z', inputSchema: null, outputSchema: null,
    singletonReason: null, ...overrides,
  });
}

function disposition(moduleId, status = 'candidate_batch_complete', overrides = {}) {
  const complete = status === 'candidate_batch_complete';
  return {
    schemaVersion: 1, kind: 'CandidateProducerDispositionV1',
    moduleId, moduleVersion: '1.0.0', planningRequestId: 'request:collect',
    stateSnapshotHash: hash('c'), capabilityId: 'CAP-AUTHOR', status,
    completedAt: '2026-09-06T01:59:00Z',
    candidates: complete ? [] : null,
    errorCode: complete ? null : status,
    ...overrides,
  };
}

function collect(producerDispositions, overrides = {}) {
  return collectCandidateBatchesV1({
    planningRequest: request(overrides.request),
    qualifiedModules: overrides.modules || modules,
    producerDispositions,
    observedAt: overrides.observedAt || observedAt,
  });
}

test('complete producer batches yield one canonical frontier independent of order', () => {
  const author = candidate('module.author-node', 'candidate:author');
  const reviewer = candidate('module.reviewer-node', 'candidate:reviewer');
  const a = collect([
    disposition('module.reviewer-node', 'candidate_batch_complete', { candidates: [reviewer] }),
    disposition('module.author-node', 'candidate_batch_complete', { candidates: [author] }),
  ]);
  const b = collect([
    disposition('module.author-node', 'candidate_batch_complete', { candidates: [author] }),
    disposition('module.reviewer-node', 'candidate_batch_complete', { candidates: [reviewer] }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'candidate_frontier_complete');
  assert.equal(a.frontier.candidateCount, 2);
  assert.deepEqual(a.producerDispositions.map((item) => item.moduleId), [
    'module.author-node', 'module.reviewer-node',
  ]);
});

test('one timeout discards every partial candidate and returns incomplete', () => {
  const result = collect([
    disposition('module.author-node', 'candidate_batch_complete', {
      candidates: [candidate('module.author-node', 'candidate:author', {
        singletonReason: 'only_feasible_candidate',
      })],
    }),
    disposition('module.reviewer-node', 'producer_timeout'),
  ]);
  assert.equal(result.status, 'candidate_frontier_incomplete');
  assert.equal(result.frontier, null);
  assert.deepEqual(result.incompleteReasons, ['producer_timeout']);
  const complete = result.producerDispositions[0];
  assert.equal(complete.submittedCandidateCount, 1);
  assert.equal(complete.acceptedCandidateCount, 0);
  assert.equal(complete.candidateSetHash, null);
});

test('missing producer disposition is explicit and never an empty success', () => {
  const result = collect([disposition('module.author-node')]);
  assert.equal(result.status, 'candidate_frontier_incomplete');
  assert.deepEqual(result.incompleteReasons, ['producer_missing']);
  assert.equal(result.producerDispositions[1].status, 'producer_missing');
});

test('failure cancellation and unavailability reasons are deterministic', () => {
  const one = collect([
    disposition('module.author-node', 'producer_failed'),
    disposition('module.reviewer-node', 'producer_cancelled'),
  ]);
  assert.deepEqual(one.incompleteReasons, ['producer_cancelled', 'producer_failed']);
  const two = collect([
    disposition('module.author-node', 'producer_unavailable'),
    disposition('module.reviewer-node'),
  ]);
  assert.deepEqual(two.incompleteReasons, ['producer_unavailable']);
});

test('all producers may complete with an explicit empty frontier', () => {
  const result = collect([
    disposition('module.author-node'), disposition('module.reviewer-node'),
  ]);
  assert.equal(result.status, 'candidate_frontier_complete');
  assert.equal(result.frontier.status, 'candidate_frontier_empty');
  assert.equal(result.frontier.candidateCount, 0);
});

test('a producer cannot submit another qualified modules candidate', () => {
  assert.throws(() => collect([
    disposition('module.author-node', 'candidate_batch_complete', {
      candidates: [candidate('module.reviewer-node', 'candidate:smuggled', {
        singletonReason: 'only_feasible_candidate',
      })],
    }),
    disposition('module.reviewer-node'),
  ]), { code: 'candidate_producer_candidate_owner_mismatch' });
});

test('partial results do not inspect or hash unused candidate payloads', () => {
  let calls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'moduleId', { enumerable: true,
    get() { calls += 1; return 'module.author-node'; } });
  const result = collect([
    disposition('module.author-node', 'candidate_batch_complete', {
      candidates: [hostile],
    }),
    disposition('module.reviewer-node', 'producer_timeout'),
  ]);
  assert.equal(result.status, 'candidate_frontier_incomplete');
  assert.equal(calls, 0);
});

test('complete collection validates every candidate payload hash', () => {
  const valid = candidate('module.author-node', 'candidate:author', {
    singletonReason: 'only_feasible_candidate',
  });
  assert.throws(() => collect([
    disposition('module.author-node', 'candidate_batch_complete', {
      candidates: [{ ...valid, value: { score: 999 } }],
    }),
    disposition('module.reviewer-node'),
  ]), { code: 'action_candidate_payload_hash_invalid' });
});

test('duplicate and extra producer dispositions are rejected', () => {
  assert.throws(() => collect([
    disposition('module.author-node'), disposition('module.author-node'),
  ]), { code: 'candidate_producer_disposition_duplicate' });
  assert.throws(() => collect([
    disposition('module.author-node'), disposition('module.reviewer-node'),
    disposition('module.formal-node'),
  ]), { code: 'candidate_producer_not_qualified' });
});

test('disposition subject and completion time are exact', () => {
  for (const changed of [
    { planningRequestId: 'request:other' },
    { stateSnapshotHash: hash('f') },
    { capabilityId: 'CAP-REVIEW' },
  ]) assert.throws(() => collect([
    disposition('module.author-node', 'producer_failed', changed),
  ]), { code: 'candidate_producer_disposition_subject_mismatch' });
  assert.throws(() => collect([
    disposition('module.author-node', 'producer_failed', {
      completedAt: '2026-09-06T02:00:01Z',
    }),
  ]), { code: 'candidate_producer_disposition_time_invalid' });
});

test('complete and failure disposition shapes cannot be confused', () => {
  assert.throws(() => collect([
    disposition('module.author-node', 'candidate_batch_complete', {
      errorCode: 'unexpected',
    }),
  ]), { code: 'candidate_producer_disposition_complete_invalid' });
  assert.throws(() => collect([
    disposition('module.author-node', 'producer_failed', { candidates: [] }),
  ]), { code: 'candidate_producer_disposition_failure_invalid' });
});

test('candidate count remains a global request bound across batches', () => {
  const author = candidate('module.author-node', 'candidate:author');
  const reviewer = candidate('module.reviewer-node', 'candidate:reviewer');
  assert.throws(() => collect([
    disposition('module.author-node', 'candidate_batch_complete', { candidates: [author] }),
    disposition('module.reviewer-node', 'candidate_batch_complete', { candidates: [reviewer] }),
  ], { request: { candidateLimit: 1 } }), {
    code: 'candidate_producer_candidate_collection_invalid',
  });
});

test('exact duplicate candidates are deduplicated inside their owner batch', () => {
  const only = candidate('module.author-node', 'candidate:only', {
    singletonReason: 'only_feasible_candidate',
  });
  const result = collect([
    disposition('module.author-node', 'candidate_batch_complete', {
      candidates: [only, structuredClone(only)],
    }),
    disposition('module.reviewer-node'),
  ]);
  assert.equal(result.frontier.candidateCount, 1);
  assert.equal(result.producerDispositions[0].submittedCandidateCount, 2);
  assert.equal(result.producerDispositions[0].acceptedCandidateCount, 1);
});

test('candidate identity conflicts across producers fail the complete collection', () => {
  const author = candidate('module.author-node', 'candidate:same');
  const reviewer = candidate('module.reviewer-node', 'candidate:same');
  assert.throws(() => collect([
    disposition('module.author-node', 'candidate_batch_complete', { candidates: [author] }),
    disposition('module.reviewer-node', 'candidate_batch_complete', { candidates: [reviewer] }),
  ]), { code: 'action_candidate_id_conflict' });
});

test('no qualified producer is incomplete rather than authoritative emptiness', () => {
  const other = [{
    moduleId: 'module.author-node', moduleVersion: '1.0.0',
    capabilityIds: ['CAP-REVIEW'], qualificationStatus: 'source_qualified',
    qualificationIdentity: hash('a'),
  }];
  const otherHash = captureQualifiedPlanningModuleSetV1(other).qualifiedModuleSetHash;
  const result = collect([], { modules: other, request: { qualifiedModuleSetHash: otherHash } });
  assert.equal(result.status, 'candidate_frontier_incomplete');
  assert.deepEqual(result.incompleteReasons, ['no_qualified_producer']);
  assert.equal(result.frontier, null);
});

test('disposition getters and sparse arrays fail without invoking producer data', () => {
  let calls = 0;
  const value = disposition('module.author-node');
  Object.defineProperty(value, 'status', { enumerable: true,
    get() { calls += 1; return 'candidate_batch_complete'; } });
  assert.throws(() => collect([value]), {
    code: 'candidate_producer_disposition_invalid',
  });
  assert.equal(calls, 0);
  assert.throws(() => collectCandidateBatchesV1({ planningRequest: request(),
    qualifiedModules: modules, producerDispositions: new Array(2), observedAt }), {
    code: 'candidate_producer_disposition_collection_invalid',
  });
});

test('complete candidate owner accessors are rejected without invocation', () => {
  let calls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'moduleId', { enumerable: true,
    get() { calls += 1; return 'module.author-node'; } });
  Object.defineProperty(hostile, 'moduleVersion', { enumerable: true, value: '1.0.0' });
  assert.throws(() => collect([
    disposition('module.author-node', 'candidate_batch_complete', { candidates: [hostile] }),
    disposition('module.reviewer-node'),
  ]), { code: 'candidate_producer_candidate_invalid' });
  assert.equal(calls, 0);
});

test('collection output is immutable and never grants authority', () => {
  const result = collect([
    disposition('module.author-node'), disposition('module.reviewer-node'),
  ]);
  assert.ok(Object.values(result.authority).every((value) => value === false));
  assert.throws(() => { result.producerDispositions[0].status = 'producer_failed'; }, TypeError);
  assert.throws(() => { result.frontier.candidates.push({}); }, TypeError);
});
