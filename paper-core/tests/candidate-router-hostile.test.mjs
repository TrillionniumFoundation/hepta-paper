import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  actionCandidatePayloadHash, routeCandidateFrontier,
} from '../../paper-application/orchestration/candidate-router.mjs';
import {
  H, observedAt, request, binding, semantic, candidate, input, singleton, code,
} from './candidate-router-test-support.mjs';

test('nested data rejects cycles, excessive depth and unsupported primitive types', () => {
  const cyclic = singleton('cycle');
  const cycle = {}; cycle.self = cycle; cyclic.value = cycle;
  assert.throws(() => routeCandidateFrontier(input([cyclic])), code('candidate_data_cycle'));
  let deep = {};
  for (let index = 0; index < 18; index += 1) deep = { next: deep };
  const deepCandidate = singleton('deep'); deepCandidate.value = deep;
  assert.throws(() => routeCandidateFrontier(input([deepCandidate])),
    code('candidate_data_depth_limit'));
  for (const value of [1n, undefined, Symbol('x'), () => {}]) {
    const hostile = singleton(`unsupported-${typeof value}`);
    hostile.value = { unsupported: value };
    assert.throws(() => routeCandidateFrontier(input([hostile])));
  }
});

test('duplicate module identities and unqualified module status are rejected', () => {
  assert.throws(() => routeCandidateFrontier(input([singleton()], {
    moduleBindings: [binding(), structuredClone(binding())],
  })), code('candidate_module_binding_duplicate'));
  assert.throws(() => routeCandidateFrontier(input([singleton()], {
    moduleBindings: [binding({ qualificationStatus: 'design_ready' })],
  })), code('candidate_module_binding_identity_invalid'));
});

test('null-prototype request, module, candidate and resource records are supported', () => {
  const req = Object.assign(Object.create(null), request());
  const mod = Object.assign(Object.create(null), binding());
  const row = singleton();
  row.resourceVector = Object.assign(Object.create(null), row.resourceVector);
  const cand = Object.assign(Object.create(null), row);
  const result = routeCandidateFrontier({ planningRequest: req, moduleBindings: [mod],
    candidates: [cand], observedAt });
  assert.equal(result.candidateCount, 1);
});

test('optional resource dimensions remain explicit and validated', () => {
  const withoutOptional = { cpuUnits: 0.5, gpuUnits: 0, memoryMiB: 0, storageBytes: 0 };
  const result = routeCandidateFrontier(input([singleton('x', { resourceVector: withoutOptional })]));
  assert.deepEqual(result.candidates[0].resourceVector, withoutOptional);
});

test('authority and side-effect declarations remain nonactivating', () => {
  const result = routeCandidateFrontier(input([singleton()]));
  assert.equal(result.externalActionPerformed, false);
  assert.deepEqual(result.authority, {
    productionAuthorized: false,
    providerAuthorized: false,
    writerAuthorized: false,
    releaseAuthorized: false,
    submissionAuthorized: false,
  });
});

test('invalid timestamp syntax and impossible calendar values are rejected rather than normalized', () => {
  for (const value of ['2026-09-05', '2026-09-05T00:00:00',
    '2026-09-05T00:00:00+00:60', '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z', '2026-09-05T24:00:00Z',
    '2026-09-05T00:00:60Z', 'not-a-time']) {
    assert.throws(() => routeCandidateFrontier(input([singleton()], { observedAt: value })),
      code('candidate_router_observed_at_invalid'));
  }
});

test('router bounds are themselves closed, integer and finite', () => {
  for (const bounds of [null, [], { unknown: 1 }, { maximumDepth: 0 },
    { maximumCandidateBytes: Infinity }, { maximumModules: '2' }]) {
    assert.throws(() => routeCandidateFrontier(input([singleton()], { bounds })));
  }
});

test('empty candidate batches are explicit failure rather than implicit success', () => {
  assert.throws(() => routeCandidateFrontier(input([])), code('candidate_frontier_empty'));
});

test('sub-millisecond expiry ordering is not collapsed by Date.parse precision', () => {
  const result = routeCandidateFrontier(input([singleton('nano', {
    expiresAt: '2026-09-05T00:30:00.000000002Z',
  })], { observedAt: '2026-09-05T00:30:00.000000001Z' }));
  assert.equal(result.candidateCount, 1);
});

test('canonical candidate hashes are independent of host collation locale', () => {
  const moduleUrl = new URL('../../paper-application/orchestration/candidate-router.mjs', import.meta.url).href;
  const payload = semantic({ value: { 'ä': 1, z: 2, alpha: 3 } });
  const script = `import { actionCandidatePayloadHash } from ${JSON.stringify(moduleUrl)};
`
    + `process.stdout.write(actionCandidatePayloadHash(${JSON.stringify(payload)}));`;
  const outputs = ['C', 'en_US.UTF-8', 'sv_SE.UTF-8', 'tr_TR.UTF-8'].map((locale) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, LANG: locale, LC_ALL: locale }, timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
  assert.equal(new Set(outputs).size, 1);
});

test('semantic duplicates choose the smallest UTF-8 identifier without locale collation', () => {
  const first = singleton('ä-id');
  const second = { ...first, candidateId: 'z-id' };
  const result = routeCandidateFrontier(input([first, second]));
  assert.equal(result.candidates[0].candidateId, 'z-id');
});

test('candidate payload helper rejects cycles, accessors and unsupported values before hashing', () => {
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => actionCandidatePayloadHash(cycle), code('candidate_data_cycle'));
  let calls = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true, get() { calls += 1; return 1; },
  });
  assert.throws(() => actionCandidatePayloadHash(accessor), code('candidate_data_record_invalid'));
  assert.equal(calls, 0);
  assert.throws(() => actionCandidatePayloadHash({ value: undefined }),
    code('candidate_data_type_invalid'));
});

test('one hundred deterministic permutations preserve the complete frontier identity', () => {
  const rows = Array.from({ length: 8 }, (_, index) => candidate(`candidate-${index}`, {
    value: { expectedMicrounits: 100 - index },
    dependencyEffects: [`dependency-${index % 3}`],
  }));
  const expected = routeCandidateFrontier(input(rows));
  let seed = 99173;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const shuffled = [...rows];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const selected = random() % (index + 1);
      [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
    }
    const result = routeCandidateFrontier(input(shuffled));
    assert.equal(result.candidateSetHash, expected.candidateSetHash);
    assert.deepEqual(result.candidates, expected.candidates);
  }
});

test('explicitly widened structural bounds are applied consistently to validation and hashing', () => {
  let deep = { leaf: 1 };
  for (let index = 0; index < 20; index += 1) deep = { next: deep };
  const body = semantic({ value: deep, singletonReason: 'only_feasible_candidate' });
  const row = { candidateId: 'deep-allowed', ...body,
    candidatePayloadHash: actionCandidatePayloadHash(body, { maximumDepth: 32 }) };
  const result = routeCandidateFrontier(input([row], { bounds: { maximumDepth: 32 } }));
  assert.equal(result.candidateCount, 1);
});
