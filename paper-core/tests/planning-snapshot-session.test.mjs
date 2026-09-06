import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';
import test from 'node:test';
import {
  createPlanningSnapshotComponent,
} from '../../paper-application/orchestration/snapshot-builder.mjs';
import {
  collectPlanningStateSnapshot,
} from '../../paper-application/orchestration/planning-snapshot-session.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');
const request = Object.freeze({
  schemaVersion: 1,
  kind: 'PlanningStateSnapshotRequestV1',
  snapshotRequestId: 'session-snapshot',
  readTransactionHash: H('a'),
  consistencyEpoch: 7,
  deadline: '2026-09-07T00:00:00Z',
  requiredComponents: [
    {
      componentId: 'campaign',
      componentKind: 'campaign-state',
      minimumRevision: 3,
      maximumAgeMs: 60 * 60 * 1000,
      maximumPayloadBytes: 64 * 1024,
    },
    {
      componentId: 'policy',
      componentKind: 'policy-state',
      minimumRevision: 2,
      maximumAgeMs: 60 * 60 * 1000,
      maximumPayloadBytes: 64 * 1024,
    },
  ],
});
const bindings = Object.freeze([
  Object.freeze({
    moduleId: 'module.readonly-control',
    moduleVersion: '1.0.0',
    projectionKinds: ['campaign-state'],
    qualificationSubjectHash: H('b'),
    validUntil: '2026-09-08T00:00:00Z',
  }),
  Object.freeze({
    moduleId: 'module.policy-engine',
    moduleVersion: '1.0.0',
    projectionKinds: ['policy-state'],
    qualificationSubjectHash: H('c'),
    validUntil: '2026-09-08T00:00:00Z',
  }),
]);

function component(input, overrides = {}) {
  const { requirement, moduleBinding, snapshotRequest } = input;
  return createPlanningSnapshotComponent({
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentV1',
    componentId: requirement.componentId,
    componentKind: requirement.componentKind,
    sourceModuleId: moduleBinding.moduleId,
    sourceModuleVersion: moduleBinding.moduleVersion,
    sourceQualificationHash: moduleBinding.qualificationSubjectHash,
    readTransactionHash: snapshotRequest.readTransactionHash,
    consistencyEpoch: snapshotRequest.consistencyEpoch,
    revision: requirement.minimumRevision,
    generation: 1,
    capturedAt: '2026-09-05T23:59:00Z',
    expiresAt: '2026-09-07T00:00:00Z',
    payload: { componentId: requirement.componentId },
    ...overrides,
  });
}

function response(input, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentResponseV1',
    status: 'complete',
    component: component(input),
    authority: {
      productionAuthorized: false,
      writerAuthorityGranted: false,
      providerAuthorized: false,
      externalAuthorityClaimed: false,
    },
    ...overrides,
  };
}

function port(implementation = {}) {
  const state = { opened: 0, reads: 0, closed: 0, active: 0, maximum: 0 };
  return {
    state,
    value: {
      kind: 'PlanningSnapshotReadPortV1',
      open(input) {
        state.opened += 1;
        if (implementation.open) return implementation.open(input, state);
        return {
          kind: 'PlanningSnapshotReadSessionV1',
          readTransactionHash: input.snapshotRequest.readTransactionHash,
          consistencyEpoch: input.snapshotRequest.consistencyEpoch,
          async readComponent(readInput) {
            state.reads += 1;
            state.active += 1;
            state.maximum = Math.max(state.maximum, state.active);
            try {
              if (implementation.read) return await implementation.read(readInput, state);
              return response(readInput);
            } finally {
              state.active -= 1;
            }
          },
          async close() {
            state.closed += 1;
            if (implementation.close) return implementation.close(state);
          },
        };
      },
    },
  };
}

async function collect(value, overrides = {}) {
  return collectPlanningStateSnapshot({
    request,
    moduleBindings: bindings,
    port: value,
    nowEpochMs: NOW,
    componentTimeoutMs: 500,
    closeTimeoutMs: 500,
    ...overrides,
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('one exact session produces a complete immutable snapshot and closes once', async () => {
  const fixture = port();
  const snapshot = await collect(fixture.value);
  assert.equal(fixture.state.opened, 1);
  assert.equal(fixture.state.reads, 2);
  assert.equal(fixture.state.closed, 1);
  assert.equal(snapshot.componentCount, 2);
  assert.deepEqual(snapshot.components.map((item) => item.componentId), ['campaign', 'policy']);
  assert.equal(snapshot.readTransactionHash, request.readTransactionHash);
  assert.equal(snapshot.consistencyEpoch, request.consistencyEpoch);
  assert.throws(() => { snapshot.components[0].payload.changed = true; }, TypeError);
});

test('component read concurrency is bounded', async () => {
  const fixture = port({ read: async (input) => { await delay(20); return response(input); } });
  await collect(fixture.value, { maximumConcurrency: 1 });
  assert.equal(fixture.state.maximum, 1);
  assert.equal(fixture.state.closed, 1);
});

test('one component failure aborts a peer and no partial snapshot is returned', async () => {
  let peerAborted = false;
  const fixture = port({
    read: async (input) => {
      if (input.requirement.componentId === 'campaign') {
        throw new Error('private read diagnostic');
      }
      return new Promise((resolve) => {
        addAbortListener(input.signal, () => {
          peerAborted = true;
          resolve(response(input));
        });
      });
    },
  });
  await assert.rejects(collect(fixture.value), (error) => {
    assert.equal(error.code, 'planning_snapshot_component_failed:campaign');
    assert.equal(error.message.includes('private read diagnostic'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(peerAborted, true);
  assert.equal(fixture.state.closed, 1);
});

test('component timeout aborts reads and still closes the session', async () => {
  let aborted = false;
  const fixture = port({
    read: (input) => new Promise(() => {
      addAbortListener(input.signal, () => { aborted = true; });
    }),
  });
  await assert.rejects(collect(fixture.value, { componentTimeoutMs: 25 }),
    { code: 'planning_snapshot_component_timeout:campaign' });
  assert.equal(aborted, true);
  assert.equal(fixture.state.closed, 1);
});

test('outer cancellation cannot be suppressed by an earlier ordinary listener', async () => {
  const fixture = port({ read: () => new Promise(() => {}) });
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
  const pending = collect(fixture.value, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'planning_snapshot_collection_aborted' });
  assert.equal(fixture.state.closed, 1);
});

test('session transaction and epoch must match before component reads', async () => {
  for (const changed of [
    { readTransactionHash: H('9') },
    { consistencyEpoch: 8 },
  ]) {
    const fixture = port({
      open: (input, state) => ({
        kind: 'PlanningSnapshotReadSessionV1',
        readTransactionHash: changed.readTransactionHash || input.snapshotRequest.readTransactionHash,
        consistencyEpoch: changed.consistencyEpoch ?? input.snapshotRequest.consistencyEpoch,
        readComponent() { state.reads += 1; },
        close() { state.closed += 1; },
      }),
    });
    await assert.rejects(collect(fixture.value),
      { code: 'planning_snapshot_session_identity_invalid' });
    assert.equal(fixture.state.reads, 0);
  }
});

test('asynchronous session opening is rejected rather than timing out after ownership ambiguity', async () => {
  const fixture = port({ open: () => Promise.resolve({}) });
  await assert.rejects(collect(fixture.value),
    { code: 'planning_snapshot_async_session_open_unsupported' });
  assert.equal(fixture.state.reads, 0);
});

test('response status and authority must be complete and non-authorizing', async () => {
  for (const mutate of [
    (value) => ({ ...value, status: 'partial' }),
    (value) => ({ ...value, authority: { ...value.authority, writerAuthorityGranted: true } }),
  ]) {
    const fixture = port({ read: (input) => mutate(response(input)) });
    await assert.rejects(collect(fixture.value), /planning_snapshot_component_failed/u);
    assert.equal(fixture.state.closed, 1);
  }
});

test('component module transaction epoch and identity are rebound independently', async () => {
  const changes = [
    { sourceModuleId: 'module.other' },
    { sourceQualificationHash: H('9') },
    { readTransactionHash: H('9') },
    { consistencyEpoch: 8 },
    { componentId: 'other' },
  ];
  for (const changed of changes) {
    const fixture = port({
      read: (input) => response(input, { component: component(input, changed) }),
    });
    await assert.rejects(collect(fixture.value),
      /planning_snapshot_component_failed/u);
  }
});

test('snapshot builder still rejects stale revision and oversized payload', async () => {
  const stale = port({
    read: (input) => response(input, { component: component(input, { revision: 0 }) }),
  });
  await assert.rejects(collect(stale.value), /snapshot|revision/u);
  const oversized = port({
    read: (input) => response(input, {
      component: component(input, { payload: { text: 'x'.repeat(70 * 1024) } }),
    }),
  });
  await assert.rejects(collect(oversized.value), /snapshot|payload|byte/u);
});

test('ambiguous and unused bindings fail before opening a session', async () => {
  const fixture = port();
  await assert.rejects(collectPlanningStateSnapshot({
    request,
    moduleBindings: [...bindings, {
      moduleId: 'module.ambiguous', moduleVersion: '1.0.0',
      projectionKinds: ['campaign-state'], qualificationSubjectHash: H('d'),
      validUntil: '2026-09-08T00:00:00Z',
    }],
    port: fixture.value,
    nowEpochMs: NOW,
  }), { code: 'planning_snapshot_binding_coverage_invalid:campaign-state' });
  assert.equal(fixture.state.opened, 0);

  await assert.rejects(collectPlanningStateSnapshot({
    request,
    moduleBindings: [...bindings, {
      moduleId: 'module.unused', moduleVersion: '1.0.0',
      projectionKinds: ['unused-state'], qualificationSubjectHash: H('e'),
      validUntil: '2026-09-08T00:00:00Z',
    }],
    port: fixture.value,
    nowEpochMs: NOW,
  }), { code: 'planning_snapshot_unused_binding' });
  assert.equal(fixture.state.opened, 0);
});

test('close failure prevents a collected snapshot from being returned', async () => {
  const fixture = port({ close: () => { throw new Error('private close diagnostic'); } });
  await assert.rejects(collect(fixture.value),
    { code: 'planning_snapshot_session_close_failed' });
  assert.equal(fixture.state.closed, 1);
});

test('read plus close failure reports conservative combined cleanup failure', async () => {
  const fixture = port({
    read: () => { throw new Error('read failed'); },
    close: () => { throw new Error('close failed'); },
  });
  await assert.rejects(collect(fixture.value),
    { code: 'planning_snapshot_collection_and_close_failed' });
  assert.equal(fixture.state.closed, 1);
});

test('accessors are rejected without opening the read port', async () => {
  const fixture = port();
  let calls = 0;
  const hostile = { ...request };
  Object.defineProperty(hostile, 'consistencyEpoch', {
    enumerable: true,
    get() { calls += 1; return 7; },
  });
  await assert.rejects(collectPlanningStateSnapshot({
    request: hostile,
    moduleBindings: bindings,
    port: fixture.value,
    nowEpochMs: NOW,
  }), { code: 'planning_snapshot_request_invalid' });
  assert.equal(calls, 0);
  assert.equal(fixture.state.opened, 0);
});
