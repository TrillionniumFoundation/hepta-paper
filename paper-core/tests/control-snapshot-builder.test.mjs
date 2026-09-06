import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSnapshotBuilder,
  sealSnapshotComponent,
} from '../../paper-application/orchestration/control-snapshot-builder.mjs';

const H1 = `sha256:${'1'.repeat(64)}`;
const H2 = `sha256:${'2'.repeat(64)}`;
const H3 = `sha256:${'3'.repeat(64)}`;
const OBSERVED = '2026-09-06T00:00:00.000Z';
const EXPIRES = '2026-09-06T01:00:00.000Z';

function component(id, overrides = {}) {
  return sealSnapshotComponent({
    schemaVersion: 1,
    kind: 'SnapshotComponentV1',
    componentId: id,
    componentKind: `${id}-projection`,
    sourceGeneration: 1,
    observedAt: '2026-09-05T23:59:00.000Z',
    expiresAt: '2026-09-06T02:00:00.000Z',
    consistencyDomainHash: H1,
    sourceIdentityHash: H2,
    schemaIdentityHash: H3,
    authorityClass: 'read_only',
    dependsOn: [],
    payload: { id, value: 1 },
    ...overrides,
  });
}

function build({
  components = [component('registry'), component('state', { dependsOn: ['registry'] })],
  requiredComponentIds = ['registry', 'state'],
  overrides = {},
  limits,
} = {}) {
  return createSnapshotBuilder(limits).build({
    schemaVersion: 1,
    kind: 'SnapshotBuildRequestV1',
    snapshotId: 'snapshot-1',
    generation: 1,
    observedAt: OBSERVED,
    expiresAt: EXPIRES,
    consistencyDomainHash: H1,
    priorSnapshotHash: null,
    requiredComponentIds,
    components,
    ...overrides,
  });
}

test('snapshot order and hashes are deterministic across input order', () => {
  const registry = component('registry');
  const state = component('state', { dependsOn: ['registry'] });
  const policy = component('policy', { dependsOn: ['registry'] });
  const left = build({
    components: [state, policy, registry],
    requiredComponentIds: ['state', 'registry', 'policy'],
  });
  const right = build({
    components: [registry, policy, state],
    requiredComponentIds: ['policy', 'registry', 'state'],
  });
  assert.deepEqual(left, right);
  assert.deepEqual(left.components.map((row) => row.componentId), ['registry', 'policy', 'state']);
  assert.match(left.snapshotHash, /^sha256:[0-9a-f]{64}$/u);
});

test('component payload and metadata hashes are recomputed', () => {
  const sealed = component('registry');
  assert.throws(() => build({
    components: [{ ...sealed, componentHash: H1 }],
    requiredComponentIds: ['registry'],
  }), { code: 'snapshot_component_hash_invalid' });
});

test('missing required components and dependencies fail closed', () => {
  assert.throws(() => build({
    components: [component('registry')],
    requiredComponentIds: ['registry', 'state'],
  }), { code: 'snapshot_required_component_missing' });
  assert.throws(() => build({
    components: [component('state', { dependsOn: ['registry'] })],
    requiredComponentIds: ['state'],
  }), { code: 'snapshot_component_dependency_missing' });
});

test('dependency cycles are rejected even with fully sealed records', () => {
  assert.throws(() => build({
    components: [
      component('a', { dependsOn: ['b'] }),
      component('b', { dependsOn: ['a'] }),
    ],
    requiredComponentIds: ['a', 'b'],
  }), { code: 'snapshot_component_dependency_cycle' });
});

test('duplicate and conflicting component identities are rejected', () => {
  const a = component('a');
  assert.throws(() => build({
    components: [a, a],
    requiredComponentIds: ['a'],
  }), { code: 'snapshot_component_duplicate' });
  assert.throws(() => build({
    components: [a, component('a', { payload: { id: 'a', value: 2 } })],
    requiredComponentIds: ['a'],
  }), { code: 'snapshot_component_id_conflict' });
});

test('all components must share the exact consistency domain', () => {
  assert.throws(() => build({
    components: [component('registry', { consistencyDomainHash: H2 })],
    requiredComponentIds: ['registry'],
  }), { code: 'snapshot_consistency_domain_mismatch' });
});

test('components cannot be observed in the future or expire before the snapshot', () => {
  assert.throws(() => build({
    components: [component('registry', { observedAt: '2026-09-06T00:00:01.000Z' })],
    requiredComponentIds: ['registry'],
  }), { code: 'snapshot_component_freshness_invalid' });
  assert.throws(() => build({
    components: [component('registry', { expiresAt: '2026-09-06T00:30:00.000Z' })],
    requiredComponentIds: ['registry'],
  }), { code: 'snapshot_component_freshness_invalid' });
});

test('generation one has no prior snapshot and later generations require one', () => {
  assert.throws(() => build({ overrides: { priorSnapshotHash: H2 } }), {
    code: 'snapshot_generation_chain_invalid',
  });
  assert.throws(() => build({
    overrides: { generation: 2, priorSnapshotHash: null },
  }), { code: 'snapshot_generation_chain_invalid' });
  const next = build({
    overrides: { generation: 2, priorSnapshotHash: H2 },
  });
  assert.equal(next.generation, 2);
  assert.equal(next.priorSnapshotHash, H2);
});

test('payload accessors and sparse arrays are rejected without execution', () => {
  let calls = 0;
  const payload = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      calls += 1;
      return 'not-read';
    },
  });
  assert.throws(() => component('hostile', { payload }), {
    code: 'snapshot_payload_invalid',
  });
  assert.equal(calls, 0);
  const components = [];
  components.length = 1;
  assert.throws(() => build({ components }), { code: 'snapshot_component_set_invalid' });
});

test('nonfinite, unsafe and unsupported payload values fail closed', () => {
  for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, 1n, () => {}]) {
    assert.throws(() => component('bad', { payload: { value } }), {
      code: 'snapshot_payload_invalid',
    });
  }
});

test('component and total byte limits are independent', () => {
  assert.throws(() => sealSnapshotComponent({
    schemaVersion: 1,
    kind: 'SnapshotComponentV1',
    componentId: 'large',
    componentKind: 'large',
    sourceGeneration: 1,
    observedAt: '2026-09-05T23:59:00.000Z',
    expiresAt: '2026-09-06T02:00:00.000Z',
    consistencyDomainHash: H1,
    sourceIdentityHash: H2,
    schemaIdentityHash: H3,
    authorityClass: 'read_only',
    dependsOn: [],
    payload: { text: 'x'.repeat(3000) },
  }, { maximumComponentBytes: 1024 }), { code: 'snapshot_component_byte_limit' });
  assert.throws(() => build({
    limits: { maximumTotalBytes: 1024, maximumComponentBytes: 1024 },
  }), { code: 'snapshot_total_byte_limit' });
});

test('required IDs and dependency sets are canonical unique sets', () => {
  assert.throws(() => build({
    requiredComponentIds: ['registry', 'registry'],
  }), { code: 'snapshot_required_components_invalid' });
  assert.throws(() => component('a', { dependsOn: ['registry', 'registry'] }), {
    code: 'snapshot_component_dependencies_invalid',
  });
});

test('output is deeply immutable and detached from caller mutation', () => {
  const payload = { nested: { score: 1 } };
  const sealed = component('registry', { payload });
  payload.nested.score = 99;
  const snapshot = build({
    components: [sealed],
    requiredComponentIds: ['registry'],
  });
  assert.equal(snapshot.components[0].payload.nested.score, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.components), true);
  assert.equal(Object.isFrozen(snapshot.authority), true);
  assert.throws(() => {
    snapshot.components[0].payload.nested.score = 2;
  }, TypeError);
});

test('negative zero is normalized before component and snapshot hashing', () => {
  const sealed = component('registry', { payload: { value: -0 } });
  assert.equal(Object.is(sealed.payload.value, -0), false);
  const snapshot = build({
    components: [sealed],
    requiredComponentIds: ['registry'],
  });
  assert.equal(Object.is(snapshot.components[0].payload.value, -0), false);
});

test('authority in a component never becomes snapshot write authority', () => {
  const snapshot = build({
    components: [component('external', { authorityClass: 'external_effect' })],
    requiredComponentIds: ['external'],
  });
  assert.deepEqual(snapshot.authority, {
    stateMutationAuthorized: false,
    externalEffectAuthorized: false,
    productionActivationAuthorized: false,
  });
});

test('invalid bounds and empty component sets fail closed', () => {
  assert.throws(() => build({ components: [] }), { code: 'snapshot_component_count_limit' });
  for (const limits of [
    null,
    [],
    { maximumComponents: 0 },
    { maximumDepth: 65 },
    { maximumComponentBytes: 2048, maximumTotalBytes: 1024 },
    { unknown: 1 },
  ]) {
    assert.throws(() => createSnapshotBuilder(limits), {
      code: 'snapshot_builder_limits_invalid',
    });
  }
});
