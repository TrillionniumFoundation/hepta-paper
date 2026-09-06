import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';
import test from 'node:test';
import {
  createActionCandidate,
} from '../../paper-application/orchestration/candidate-router.mjs';
import {
  collectModuleCandidateFrontier,
} from '../../paper-application/orchestration/candidate-producer-collection.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');
const request = Object.freeze({
  schemaVersion: 1,
  kind: 'PlanningRequestV1',
  planningRequestId: 'collect-plan',
  stateSnapshotHash: H('a'),
  capabilityId: 'CAP-MOD-CANDIDATES',
  hardConstraintSetHash: H('b'),
  objectiveVersion: 'objective-v1',
  resourcePriceSnapshotHash: H('c'),
  candidateLimit: 32,
  deadline: '2026-12-31T00:00:00Z',
  allowedSideEffectClasses: ['none'],
  inputArtifactHashes: [],
});

function binding(moduleId, moduleVersion = '1.0.0') {
  return Object.freeze({
    moduleId,
    moduleVersion,
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H(moduleId.endsWith('a') ? 'd' : moduleId.endsWith('b') ? 'e' : 'f'),
    validUntil: '2026-12-31T00:00:00Z',
  });
}

function candidate(moduleBinding, id, overrides = {}) {
  return createActionCandidate({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: id,
    planningRequestId: request.planningRequestId,
    stateSnapshotHash: request.stateSnapshotHash,
    moduleId: moduleBinding.moduleId,
    moduleVersion: moduleBinding.moduleVersion,
    capabilityId: request.capabilityId,
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
    value: {},
    risk: {},
    preconditions: [],
    dependencyEffects: [],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'no_effect',
    expiresAt: '2026-12-30T00:00:00Z',
    inputSchema: null,
    outputSchema: null,
    singletonReason: null,
    ...overrides,
  });
}

function response(moduleBinding, planningRequestHash, candidates, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ModuleCandidateResponseV1',
    status: 'complete',
    moduleId: moduleBinding.moduleId,
    moduleVersion: moduleBinding.moduleVersion,
    planningRequestHash,
    candidates,
    emptyReason: candidates.length ? null : 'no_local_candidate',
    authority: {
      productionAuthorized: false,
      providerAuthorized: false,
      writerAuthorityGranted: false,
      externalAuthorityClaimed: false,
    },
    ...overrides,
  };
}

function producer(moduleBinding, implementation) {
  return { moduleId: moduleBinding.moduleId, moduleVersion: moduleBinding.moduleVersion,
    produce: implementation };
}

async function collect(moduleBindings, producers, overrides = {}) {
  return collectModuleCandidateFrontier({
    request,
    moduleBindings,
    producers,
    nowEpochMs: NOW,
    producerTimeoutMs: 500,
    ...overrides,
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('all exact producers receive one request and completion order does not affect frontier order', async () => {
  const a = binding('module.a');
  const b = binding('module.b');
  const observed = [];
  const result = await collect([b, a], [
    producer(b, async (input) => {
      observed.push([input.moduleBinding.moduleId, input.planningRequestHash]);
      await delay(5);
      return response(b, input.planningRequestHash, [candidate(b, 'b')]);
    }),
    producer(a, async (input) => {
      observed.push([input.moduleBinding.moduleId, input.planningRequestHash]);
      await delay(20);
      return response(a, input.planningRequestHash, [candidate(a, 'a')]);
    }),
  ]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.producerReceipts.map((item) => item.moduleId), ['module.a', 'module.b']);
  assert.deepEqual(result.frontier.candidates.map((item) => item.candidateId), ['a', 'b']);
  assert.equal(new Set(observed.map((item) => item[1])).size, 1);
  assert.equal(result.planningRequestHash, observed[0][1]);
});

test('configured concurrency is a hard upper bound', async () => {
  const bindings = ['a', 'b', 'c', 'd'].map((id) => binding(`module.${id}`));
  let active = 0;
  let maximum = 0;
  const producers = bindings.map((item) => producer(item, async (input) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(20);
    active -= 1;
    return response(item, input.planningRequestHash, []);
  }));
  await collect(bindings, producers, { maximumConcurrency: 2 });
  assert.equal(maximum, 2);
});

test('one producer failure aborts peers and no partial frontier is returned', async () => {
  const a = binding('module.a');
  const b = binding('module.b');
  let peerAborted = false;
  const promise = collect([a, b], [
    producer(a, async () => { throw new Error('private producer diagnostic'); }),
    producer(b, ({ signal }) => new Promise((resolve) => {
      addAbortListener(signal, () => {
        peerAborted = true;
        resolve(response(b, H('1'), []));
      });
    })),
  ]);
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'candidate_producer_failed:module.a');
    assert.equal(error.message.includes('private producer diagnostic'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(peerAborted, true);
});

test('producer timeout aborts its port and fails closed', async () => {
  const a = binding('module.a');
  let aborted = false;
  await assert.rejects(collect([a], [producer(a, ({ signal }) => new Promise(() => {
    addAbortListener(signal, () => { aborted = true; });
  }))], { producerTimeoutMs: 30 }), { code: 'candidate_producer_timeout:module.a' });
  assert.equal(aborted, true);
});

test('outer cancellation cannot be suppressed by an earlier ordinary listener', async () => {
  const a = binding('module.a');
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
  const pending = collect([a], [producer(a, () => new Promise(() => {}))], {
    signal: controller.signal,
    producerTimeoutMs: 1000,
  });
  controller.abort('stop');
  await assert.rejects(pending, { code: 'candidate_collection_aborted' });
});

test('producer coverage must exactly match module bindings', async () => {
  const a = binding('module.a');
  const b = binding('module.b');
  const noOp = producer(a, (input) => response(a, input.planningRequestHash, []));
  await assert.rejects(collect([a, b], [noOp]),
    { code: 'candidate_collection_producer_coverage_invalid' });
  await assert.rejects(collect([a], [noOp, producer(b, () => null)]),
    { code: 'candidate_collection_producer_coverage_invalid' });
  await assert.rejects(collect([a, a], [noOp, noOp]),
    { code: 'candidate_collection_producer_coverage_invalid' });
});

test('response identity status and authority are exact', async () => {
  const a = binding('module.a');
  const cases = [
    (input) => response(a, input.planningRequestHash, [], { status: 'partial' }),
    (input) => response(a, input.planningRequestHash, [], { moduleVersion: 'other' }),
    (input) => response(a, H('9'), []),
    (input) => response(a, input.planningRequestHash, [], {
      authority: {
        productionAuthorized: true,
        providerAuthorized: false,
        writerAuthorityGranted: false,
        externalAuthorityClaimed: false,
      },
    }),
  ];
  for (const implementation of cases) {
    await assert.rejects(collect([a], [producer(a, implementation)]), /candidate_collection_/u);
  }
});

test('empty reason must match candidate count', async () => {
  const a = binding('module.a');
  await assert.rejects(collect([a], [producer(a, (input) =>
    response(a, input.planningRequestHash, [], { emptyReason: null }))]),
  { code: 'candidate_collection_empty_reason_invalid' });
  await assert.rejects(collect([a], [producer(a, (input) =>
    response(a, input.planningRequestHash, [candidate(a, 'a')], { emptyReason: 'wrong' }))]),
  { code: 'candidate_collection_empty_reason_invalid' });
});

test('candidate identity must bind the exact producer and planning subject', async () => {
  const a = binding('module.a');
  const b = binding('module.b');
  for (const invalid of [
    candidate(b, 'wrong-module'),
    candidate(a, 'wrong-request', { planningRequestId: 'other' }),
    candidate(a, 'wrong-snapshot', { stateSnapshotHash: H('9') }),
    candidate(a, 'wrong-capability', { capabilityId: 'CAP-OTHER' }),
  ]) {
    await assert.rejects(collect([a], [producer(a, (input) =>
      response(a, input.planningRequestHash, [invalid]))]),
    { code: 'candidate_collection_candidate_binding_mismatch' });
  }
});

test('per-producer total-candidate and response-byte limits fail closed', async () => {
  const a = binding('module.a');
  const values = [candidate(a, 'a'), candidate(a, 'b')];
  await assert.rejects(collect([a], [producer(a, (input) =>
    response(a, input.planningRequestHash, values))], {
    maximumCandidatesPerProducer: 1,
  }), { code: 'candidate_collection_response_candidates_invalid' });
  await assert.rejects(collect([a], [producer(a, (input) =>
    response(a, input.planningRequestHash, values))], {
    maximumTotalCandidates: 1,
  }), { code: 'candidate_collection_total_limit_exceeded' });
  const large = candidate(a, 'large', { value: { text: 'x'.repeat(4000) } });
  await assert.rejects(collect([a], [producer(a, (input) =>
    response(a, input.planningRequestHash, [large]))], {
    maximumProducerResponseBytes: 1024,
  }), { code: 'candidate_collection_response_byte_limit' });
});

test('identical duplicates collapse but conflicting candidate IDs are rejected by the router', async () => {
  const a = binding('module.a');
  const exact = candidate(a, 'same');
  const deduplicated = await collect([a], [producer(a, (input) =>
    response(a, input.planningRequestHash, [exact, exact]))]);
  assert.equal(deduplicated.rawCandidateCount, 2);
  assert.equal(deduplicated.frontier.candidateCount, 1);
  assert.equal(deduplicated.frontier.duplicateCount, 1);

  const conflict = candidate(a, 'same', { value: { changed: true } });
  await assert.rejects(collect([a], [producer(a, (input) =>
    response(a, input.planningRequestHash, [exact, conflict]))]),
  /candidate_/u);
});

test('all-empty complete responses produce one explicit empty frontier', async () => {
  const a = binding('module.a');
  const b = binding('module.b');
  const result = await collect([a, b], [
    producer(a, (input) => response(a, input.planningRequestHash, [])),
    producer(b, (input) => response(b, input.planningRequestHash, [])),
  ]);
  assert.equal(result.frontier.status, 'empty');
  assert.equal(result.frontier.emptyReason, 'all_candidate_producers_returned_empty');
  assert.equal(result.rawCandidateCount, 0);
});

test('accessors and sparse arrays are rejected without invoking getters or producers', async () => {
  const a = binding('module.a');
  let getterCalls = 0;
  let producerCalls = 0;
  const hostile = { ...request };
  Object.defineProperty(hostile, 'objectiveVersion', {
    enumerable: true,
    get() { getterCalls += 1; return 'objective-v1'; },
  });
  await assert.rejects(collectModuleCandidateFrontier({
    request: hostile,
    moduleBindings: [a],
    producers: [producer(a, () => { producerCalls += 1; })],
    nowEpochMs: NOW,
  }), { code: 'candidate_collection_request_invalid' });
  assert.equal(getterCalls, 0);
  assert.equal(producerCalls, 0);

  const sparse = Array(2);
  sparse[1] = producer(a, () => null);
  await assert.rejects(collectModuleCandidateFrontier({
    request,
    moduleBindings: [a],
    producers: sparse,
    nowEpochMs: NOW,
  }), { code: 'candidate_collection_producers_invalid' });
});

test('captured result remains immutable after producer-owned records mutate', async () => {
  const a = binding('module.a');
  const owned = candidate(a, 'owned');
  const producerResponse = response(a, null, [owned]);
  const result = await collect([a], [producer(a, (input) => {
    producerResponse.planningRequestHash = input.planningRequestHash;
    return producerResponse;
  })]);
  producerResponse.candidates.length = 0;
  producerResponse.authority.productionAuthorized = true;
  assert.equal(result.frontier.candidateCount, 1);
  assert.equal(result.producerReceipts[0].candidateCount, 1);
  assert.equal(result.producerReceipts[0].authority.productionAuthorized, false);
  assert.throws(() => { result.authority.productionAuthorized = true; }, TypeError);
});
