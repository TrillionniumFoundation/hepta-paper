import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildControlSnapshot,
  controlProjectionPayloadHash,
} from '../../paper-application/orchestration/control-snapshot-builder.mjs';

const H = `sha256:${'a'.repeat(64)}`;
const observedAt = '2026-09-06T00:00:00.123456789Z';
const bindings = [
  { projectionKind: 'module-registry', moduleId: 'module.module-registry', moduleVersion: '1', minimumRevision: 2 },
  { projectionKind: 'state', moduleId: 'module.readonly-control', moduleVersion: '1', minimumRevision: 5 },
];
function request(overrides = {}) {
  return { version: 1, kind: 'ControlSnapshotRequestV1', requestId: 'snapshot-1', subjectHash: H,
    bindings, expiresAt: '2026-09-06T01:00:00Z', ...overrides };
}
function projection(projectionKind, producerModuleId, revision, payload = { value: projectionKind }, overrides = {}) {
  const row = { version: 1, kind: 'ControlProjectionV1', projectionKind,
    projectionId: `${projectionKind}-${revision}`, producerModuleId, producerVersion: '1',
    subjectHash: H, revision, observedAt: '2026-09-05T23:59:59.999999999Z',
    expiresAt: '2026-09-06T00:30:00Z', payload };
  row.payloadHash = controlProjectionPayloadHash(row);
  return { ...row, ...overrides };
}
function input(overrides = {}) {
  return { request: request(), observedAt,
    projections: [projection('module-registry', 'module.module-registry', 2),
      projection('state', 'module.readonly-control', 5)], ...overrides };
}

for (const order of [[0, 1], [1, 0]]) {
  test(`projection input order ${order.join('')} gives the same exact snapshot`, () => {
    const value = input(); value.projections = order.map((index) => value.projections[index]);
    const result = buildControlSnapshot(value);
    assert.deepEqual(result.projectionSet.map((row) => row.projectionKind), ['module-registry', 'state']);
    assert.equal(result.externalActionPerformed, false);
    assert.ok(Object.values(result.authority).every((flag) => flag === false));
    globalThis.snapshotHash ||= result.controlSnapshotHash;
    assert.equal(result.controlSnapshotHash, globalThis.snapshotHash);
  });
}

test('snapshot expiry is the minimum request or projection expiry', () => {
  assert.equal(buildControlSnapshot(input()).expiresAt, '2026-09-06T00:30:00Z');
});

test('exact producer, subject and minimum revision are mandatory', () => {
  for (const mutate of [
    (row) => { row.producerModuleId = 'module.other'; },
    (row) => { row.producerVersion = '2'; },
    (row) => { row.subjectHash = `sha256:${'b'.repeat(64)}`; },
    (row) => { row.revision = 1; },
    (row) => { row.projectionKind = 'other'; },
  ]) {
    const value = input(); mutate(value.projections[0]);
    assert.throws(() => buildControlSnapshot(value));
  }
});

test('coverage is exact; extra, missing and duplicate projections fail', () => {
  const missing = input(); missing.projections.pop();
  assert.throws(() => buildControlSnapshot(missing), { code: 'control_snapshot_projection_coverage_invalid' });
  const extra = input(); extra.projections.push(projection('extra', 'module.extra', 1));
  assert.throws(() => buildControlSnapshot(extra), { code: 'control_snapshot_projection_coverage_invalid' });
  const duplicate = input(); duplicate.projections[1] = duplicate.projections[0];
  assert.throws(() => buildControlSnapshot(duplicate), { code: 'control_snapshot_projection_duplicate' });
});

test('request and projections reject expiry, future observation and invalid civil time', () => {
  const expiredRequest = input(); expiredRequest.request.expiresAt = observedAt;
  assert.throws(() => buildControlSnapshot(expiredRequest), { code: 'control_snapshot_request_expired' });
  const expired = input(); expired.projections[0].expiresAt = observedAt;
  assert.throws(() => buildControlSnapshot(expired), { code: 'control_snapshot_projection_expired' });
  const future = input(); future.projections[0].observedAt = '2026-09-06T00:00:00.123456790Z';
  assert.throws(() => buildControlSnapshot(future), { code: 'control_snapshot_projection_from_future' });
  for (const invalid of ['2026-02-30T00:00:00Z', '2026-09-06T00:00:60Z',
    '2026-09-06T00:00:00+00:00', '2026-09-06T00:00:00.1234567890Z']) {
    assert.throws(() => buildControlSnapshot(input({ observedAt: invalid })));
  }
});

test('nanosecond order is not collapsed to Date milliseconds', () => {
  const value = input(); value.observedAt = '2026-09-06T00:00:00.000000001Z';
  value.projections.forEach((row) => { row.observedAt = '2026-09-06T00:00:00.000000002Z'; });
  assert.throws(() => buildControlSnapshot(value), { code: 'control_snapshot_projection_from_future' });
});

test('payload hash mismatch cannot be repaired by the builder', () => {
  const value = input(); value.projections[0].payload.value = 'changed';
  assert.throws(() => buildControlSnapshot(value), { code: 'control_snapshot_projection_payload_hash_mismatch' });
});

test('payload capture normalizes negative zero and protects against caller mutation', () => {
  const payload = { list: [{ n: -0, text: 'before' }] };
  const value = input(); value.projections[1] = projection('state', 'module.readonly-control', 5, payload);
  const result = buildControlSnapshot(value);
  payload.list[0].text = 'after';
  assert.equal(result.projectionSet[1].payload.list[0].text, 'before');
  assert.equal(Object.is(result.projectionSet[1].payload.list[0].n, -0), false);
  assert.throws(() => { result.projectionSet[1].payload.list[0].text = 'mutate'; }, TypeError);
});

test('accessors are rejected without execution', () => {
  let calls = 0;
  const value = input();
  Object.defineProperty(value.projections[0].payload, 'secret', { enumerable: true,
    get() { calls += 1; return 'not-read'; } });
  assert.throws(() => buildControlSnapshot(value), { code: 'control_snapshot_payload_record_invalid' });
  assert.equal(calls, 0);
});

test('sparse arrays, symbols, unsupported values and cycles fail closed', () => {
  const cases = [];
  const sparse = []; sparse.length = 2; sparse[1] = 1; cases.push(sparse);
  cases.push({ [Symbol('x')]: 1 }, { value: undefined }, { value: 1n }, { value: () => 1 });
  const cycle = {}; cycle.self = cycle; cases.push(cycle);
  for (const payload of cases) {
    assert.throws(() => controlProjectionPayloadHash({ projectionKind: 'state', subjectHash: H,
      revision: 5, payload }));
  }
});

test('nonfinite and unsafe-magnitude numbers fail', () => {
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => controlProjectionPayloadHash({ projectionKind: 'state', subjectHash: H,
      revision: 5, payload: { value } }), { code: 'control_snapshot_payload_number_invalid' });
  }
});

test('bounds apply before oversized values can enter the snapshot', () => {
  const value = input({ bounds: { maximumProjections: 2, maximumPayloadBytes: 16,
    maximumSnapshotBytes: 1024, maximumDepth: 3, maximumNodes: 20,
    maximumCollectionEntries: 2, maximumStringBytes: 8 } });
  assert.throws(() => buildControlSnapshot(value));
  assert.throws(() => controlProjectionPayloadHash({ projectionKind: 'state', subjectHash: H,
    revision: 5, payload: { x: { y: { z: { q: 1 } } } } }, { maximumDepth: 2 }));
});

test('binding array is dense, unique and captured before caller mutation', () => {
  const value = input();
  const output = buildControlSnapshot(value);
  value.request.bindings[0].minimumRevision = 999;
  assert.equal(output.projectionSet[0].revision, 2);
  const duplicate = input(); duplicate.request.bindings[1] = { ...duplicate.request.bindings[0] };
  assert.throws(() => buildControlSnapshot(duplicate), { code: 'control_snapshot_binding_duplicate' });
  const sparse = input(); sparse.request.bindings = new Array(2); sparse.request.bindings[1] = bindings[1];
  assert.throws(() => buildControlSnapshot(sparse), { code: 'control_snapshot_bindings_invalid' });
});

test('locale and hash-seed changes do not alter the canonical snapshot', () => {
  const moduleUrl = new URL('../../paper-application/orchestration/control-snapshot-builder.mjs', import.meta.url).href;
  const source = `import {buildControlSnapshot,controlProjectionPayloadHash as h} from ${JSON.stringify(moduleUrl)};
const H='sha256:'+'a'.repeat(64), at='2026-09-06T00:00:00.123456789Z';
const mk=(k,m,r,p)=>{const x={version:1,kind:'ControlProjectionV1',projectionKind:k,projectionId:k+'-'+r,producerModuleId:m,producerVersion:'1',subjectHash:H,revision:r,observedAt:'2026-09-05T23:59:59.999999999Z',expiresAt:'2026-09-06T00:30:00Z',payload:p};x.payloadHash=h(x);return x};
const request={version:1,kind:'ControlSnapshotRequestV1',requestId:'snapshot-1',subjectHash:H,bindings:[{projectionKind:'é',moduleId:'m.e',moduleVersion:'1',minimumRevision:1},{projectionKind:'z',moduleId:'m.z',moduleVersion:'1',minimumRevision:1}],expiresAt:'2026-09-06T01:00:00Z'};
console.log(buildControlSnapshot({request,observedAt:at,projections:[mk('z','m.z',1,{é:1,z:2}),mk('é','m.e',1,{z:2,é:1})]}).controlSnapshotHash);`;
  const outputs = [['C', '1'], ['tr_TR.UTF-8', '2'], ['de_DE.UTF-8', '17']].map(([locale, seed]) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, LANG: locale, LC_ALL: locale, NODE_HASH_SEED: seed },
    });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  });
  assert.equal(new Set(outputs).size, 1);
});

test('projection hash commits producer, revision, expiry and payload', () => {
  const original = buildControlSnapshot(input()).projectionSet[0].projectionHash;
  for (const mutate of [
    (row) => { row.revision += 1; row.payloadHash = controlProjectionPayloadHash(row); },
    (row) => { row.expiresAt = '2026-09-06T00:31:00Z'; },
    (row) => { row.projectionId = 'different'; },
  ]) {
    const value = input(); mutate(value.projections[0]);
    assert.notEqual(buildControlSnapshot(value).projectionSet[0].projectionHash, original);
  }
});

test('unknown fields and malformed root records are rejected', () => {
  for (const value of [null, [], { ...input(), extra: true }, Object.create({ request: request() })]) {
    assert.throws(() => buildControlSnapshot(value), { code: 'control_snapshot_input_invalid' });
  }
  const p = input(); p.projections[0].extra = true;
  assert.throws(() => buildControlSnapshot(p), { code: 'control_snapshot_projection_invalid' });
});
