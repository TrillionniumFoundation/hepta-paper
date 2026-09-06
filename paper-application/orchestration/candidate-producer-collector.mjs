import { addAbortListener as subscribeAbort } from 'node:events';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import {
  captureQualifiedPlanningModuleSetV1,
  routeActionCandidatesV1,
} from './candidate-router.mjs';

const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const MAX_PRODUCERS = 1024;
const MAX_CONCURRENCY = 64;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function record(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw failure(code);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function dense(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) throw failure(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    result.push(descriptor.value);
  }
  return result;
}

function boundedString(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('\0')) {
    throw failure(code);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure(code);
  }
  return value;
}

function signalAborted(signal) {
  if (signal === null) return false;
  try {
    return abortedGetter.call(signal);
  } catch {
    throw failure('candidate_collection_abort_signal_invalid');
  }
}

function timestamp(clock, code) {
  let value;
  try {
    value = clock.now();
  } catch {
    throw failure(code);
  }
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw failure(code);
  return date.toISOString();
}

function captureInvocation(request, validation) {
  const descriptors = Object.getOwnPropertyDescriptors(request);
  const read = (key) => {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw failure('candidate_collection_planning_request_invalid');
    }
    return descriptor.value;
  };
  const sorted = (key) => Object.freeze([...read(key)].sort());
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ProducerPlanningInvocationV1',
    planningRequestHash: validation.planningRequestHash,
    planningRequestId: read('planningRequestId'),
    stateSnapshotHash: read('stateSnapshotHash'),
    capabilityId: read('capabilityId'),
    goalReference: descriptors.goalReference?.value ?? null,
    policyReference: descriptors.policyReference?.value ?? null,
    hardConstraintSetHash: read('hardConstraintSetHash'),
    objectiveVersion: read('objectiveVersion'),
    resourcePriceSnapshotHash: read('resourcePriceSnapshotHash'),
    qualifiedModuleSetHash: read('qualifiedModuleSetHash'),
    candidateLimit: read('candidateLimit'),
    maximumCandidateBytes: read('maximumCandidateBytes'),
    maximumTotalCandidateBytes: read('maximumTotalCandidateBytes'),
    deadline: new Date(read('deadline')).toISOString(),
    allowedSideEffectClasses: sorted('allowedSideEffectClasses'),
    inputArtifacts: descriptors.inputArtifacts ? sorted('inputArtifacts') : Object.freeze([]),
  });
}

function captureProducerBindings(value, expected) {
  const raw = dense(value, MAX_PRODUCERS, 'candidate_producer_set_invalid');
  const bindings = raw.map((item) => {
    const data = record(
      item, ['moduleId', 'moduleVersion', 'produce'], 'candidate_producer_binding_invalid',
    );
    if (Object.keys(data).length !== 3 || typeof data.produce !== 'function') {
      throw failure('candidate_producer_binding_invalid');
    }
    const binding = Object.freeze({
      moduleId: boundedString(data.moduleId, MODULE_ID, 'candidate_producer_module_invalid'),
      moduleVersion: boundedString(
        data.moduleVersion, TOKEN, 'candidate_producer_version_invalid',
      ),
      produce: data.produce,
    });
    return binding;
  }).sort((left, right) => {
    const l = `${left.moduleId}\0${left.moduleVersion}`;
    const r = `${right.moduleId}\0${right.moduleVersion}`;
    return l < r ? -1 : l > r ? 1 : 0;
  });
  const seen = new Set();
  for (const binding of bindings) {
    const key = `${binding.moduleId}\0${binding.moduleVersion}`;
    if (seen.has(key)) throw failure('candidate_producer_binding_duplicate');
    if (!expected.has(key)) throw failure('candidate_producer_not_qualified');
    seen.add(key);
  }
  if (seen.size !== expected.size || [...expected].some((key) => !seen.has(key))) {
    throw failure('candidate_producer_set_incomplete');
  }
  return Object.freeze(bindings);
}

function captureBatch(value, binding, invocation) {
  const data = record(value, [
    'schemaVersion', 'kind', 'status', 'moduleId', 'moduleVersion',
    'planningRequestId', 'stateSnapshotHash', 'candidates',
  ], 'candidate_batch_invalid');
  if (Object.keys(data).length !== 8
    || data.schemaVersion !== 1
    || data.kind !== 'ModuleCandidateBatchV1'
    || data.status !== 'candidate_batch_complete'
    || data.moduleId !== binding.moduleId
    || data.moduleVersion !== binding.moduleVersion
    || data.planningRequestId !== invocation.planningRequestId
    || data.stateSnapshotHash !== invocation.stateSnapshotHash) {
    throw failure('candidate_batch_identity_invalid');
  }
  const candidates = dense(
    data.candidates, invocation.candidateLimit, 'candidate_batch_collection_invalid',
  );
  for (const candidate of candidates) {
    const identity = record(candidate, [
      'schemaVersion', 'kind', 'candidateId', 'planningRequestId',
      'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
      'resourceVector', 'duration', 'cost', 'value', 'risk', 'preconditions',
      'dependencyEffects', 'sideEffectClass', 'irreversibleBoundary',
      'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
      'singletonReason', 'candidatePayloadHash',
    ], 'candidate_batch_candidate_invalid');
    if (identity.moduleId !== binding.moduleId
      || identity.moduleVersion !== binding.moduleVersion
      || identity.planningRequestId !== invocation.planningRequestId
      || identity.stateSnapshotHash !== invocation.stateSnapshotHash
      || identity.capabilityId !== invocation.capabilityId) {
      throw failure('candidate_batch_candidate_identity_invalid');
    }
  }
  return candidates;
}

function incompleteResult({ invocation, qualified, startedAt, completedAt, dispositions }) {
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateCollectionResultV1',
    status: 'candidate_frontier_incomplete',
    planningRequestId: invocation.planningRequestId,
    planningRequestHash: invocation.planningRequestHash,
    stateSnapshotHash: invocation.stateSnapshotHash,
    capabilityId: invocation.capabilityId,
    qualifiedModuleSetHash: qualified.qualifiedModuleSetHash,
    startedAt,
    completedAt,
    producerDispositions: Object.freeze(dispositions),
    frontier: null,
    authority: Object.freeze({
      executionAuthorized: false,
      writerAuthorized: false,
      providerAuthorized: false,
      releaseAuthorized: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({
    ...body,
    candidateCollectionResultHash: hashRecord('CandidateCollectionResultV1', body),
  });
}

export async function collectActionCandidateFrontierV1(value) {
  const input = record(value, [
    'planningRequest', 'qualifiedModules', 'producers', 'collectorPolicy',
    'clock', 'scheduler', 'signal',
  ], 'candidate_collection_input_invalid');
  for (const field of [
    'planningRequest', 'qualifiedModules', 'producers', 'collectorPolicy', 'clock', 'scheduler',
  ]) {
    if (!Object.hasOwn(input, field)) throw failure('candidate_collection_input_invalid');
  }
  const policy = record(input.collectorPolicy, [
    'maximumConcurrency', 'producerTimeoutMilliseconds',
  ], 'candidate_collection_policy_invalid');
  if (Object.keys(policy).length !== 2) throw failure('candidate_collection_policy_invalid');
  const maximumConcurrency = boundedInteger(
    policy.maximumConcurrency, 1, MAX_CONCURRENCY,
    'candidate_collection_concurrency_invalid',
  );
  const producerTimeoutMilliseconds = boundedInteger(
    policy.producerTimeoutMilliseconds, 1, MAX_TIMEOUT_MS,
    'candidate_collection_timeout_invalid',
  );
  if (!input.clock || typeof input.clock.now !== 'function'
    || !input.scheduler || typeof input.scheduler.setTimeout !== 'function'
    || typeof input.scheduler.clearTimeout !== 'function') {
    throw failure('candidate_collection_ports_invalid');
  }
  const signal = Object.hasOwn(input, 'signal') ? input.signal : null;
  signalAborted(signal);
  const qualified = captureQualifiedPlanningModuleSetV1(input.qualifiedModules);
  const startedAt = timestamp(input.clock, 'candidate_collection_clock_invalid');
  const requestValidation = routeActionCandidatesV1({
    planningRequest: input.planningRequest,
    qualifiedModules: input.qualifiedModules,
    candidates: [],
    observedAt: startedAt,
  });
  const invocation = captureInvocation(input.planningRequest, requestValidation);
  const expectedBindings = new Set(qualified.modules
    .filter((module) => module.capabilityIds.includes(invocation.capabilityId))
    .map((module) => `${module.moduleId}\0${module.moduleVersion}`));
  const bindings = captureProducerBindings(input.producers, expectedBindings);
  if (bindings.length === 0) {
    const completedAt = timestamp(input.clock, 'candidate_collection_clock_invalid');
    return incompleteResult({ invocation, qualified, startedAt, completedAt,
      dispositions: Object.freeze([{ status: 'no_qualified_producer' }]) });
  }
  let cursor = 0;
  const candidates = [];
  const dispositions = [];
  async function execute(binding) {
    if (signalAborted(signal)) {
      return { moduleId: binding.moduleId, moduleVersion: binding.moduleVersion,
        status: 'producer_cancelled', candidateCount: 0 };
    }
    const controller = new AbortController();
    let parentSubscription = null;
    let timer = null;
    let settled = false;
    const operation = Promise.resolve().then(() => binding.produce(invocation, {
      signal: controller.signal,
    })).then((batch) => {
      if (settled) return null;
      const captured = captureBatch(batch, binding, invocation);
      return { status: 'producer_complete', candidates: captured };
    }, () => ({ status: 'producer_failed', candidates: [] }));
    const timeout = new Promise((resolve) => {
      timer = input.scheduler.setTimeout(() => {
        controller.abort('candidate_producer_timeout');
        resolve({ status: 'producer_timeout', candidates: [] });
      }, producerTimeoutMilliseconds);
    });
    if (signal) {
      parentSubscription = subscribeAbort(signal, () => controller.abort(
        'candidate_collection_cancelled',
      ));
    }
    let outcome;
    try {
      outcome = await Promise.race([operation, timeout]);
      if (controller.signal.aborted && outcome?.status === 'producer_complete') {
        outcome = { status: signalAborted(signal) ? 'producer_cancelled' : 'producer_timeout',
          candidates: [] };
      }
    } finally {
      settled = true;
      if (timer !== null) input.scheduler.clearTimeout(timer);
      parentSubscription?.[Symbol.dispose]();
    }
    if (outcome === null) outcome = { status: 'producer_failed', candidates: [] };
    if (outcome.status === 'producer_complete') candidates.push(...outcome.candidates);
    return {
      moduleId: binding.moduleId,
      moduleVersion: binding.moduleVersion,
      status: outcome.status,
      candidateCount: outcome.candidates.length,
    };
  }
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= bindings.length) return;
      dispositions.push(await execute(bindings[index]));
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(maximumConcurrency, bindings.length) }, () => worker(),
  ));
  dispositions.sort((left, right) => {
    const l = `${left.moduleId || ''}\0${left.moduleVersion || ''}`;
    const r = `${right.moduleId || ''}\0${right.moduleVersion || ''}`;
    return l < r ? -1 : l > r ? 1 : 0;
  });
  const completedAt = timestamp(input.clock, 'candidate_collection_clock_invalid');
  const complete = dispositions.every((item) => item.status === 'producer_complete');
  if (!complete || signalAborted(signal)) {
    return incompleteResult({ invocation, qualified, startedAt, completedAt, dispositions });
  }
  const frontier = routeActionCandidatesV1({
    planningRequest: input.planningRequest,
    qualifiedModules: input.qualifiedModules,
    candidates,
    observedAt: completedAt,
  });
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateCollectionResultV1',
    status: 'candidate_frontier_complete',
    planningRequestId: invocation.planningRequestId,
    planningRequestHash: invocation.planningRequestHash,
    stateSnapshotHash: invocation.stateSnapshotHash,
    capabilityId: invocation.capabilityId,
    qualifiedModuleSetHash: qualified.qualifiedModuleSetHash,
    startedAt,
    completedAt,
    producerSetHash: hashRecord('CandidateProducerSetV1', bindings.map((binding) => ({
      moduleId: binding.moduleId, moduleVersion: binding.moduleVersion,
    }))),
    producerDispositions: Object.freeze(dispositions),
    frontier,
    authority: Object.freeze({
      executionAuthorized: false,
      writerAuthorized: false,
      providerAuthorized: false,
      releaseAuthorized: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({
    ...body,
    candidateCollectionResultHash: hashRecord('CandidateCollectionResultV1', body),
  });
}

export function sealModuleCandidateBatchV1(value) {
  const data = record(value, [
    'moduleId', 'moduleVersion', 'planningRequestId', 'stateSnapshotHash', 'candidates',
  ], 'candidate_batch_invalid');
  if (Object.keys(data).length !== 5) throw failure('candidate_batch_invalid');
  const candidates = dense(data.candidates, 4096, 'candidate_batch_collection_invalid');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ModuleCandidateBatchV1',
    status: 'candidate_batch_complete',
    moduleId: boundedString(data.moduleId, MODULE_ID, 'candidate_batch_module_invalid'),
    moduleVersion: boundedString(data.moduleVersion, TOKEN, 'candidate_batch_version_invalid'),
    planningRequestId: boundedString(
      data.planningRequestId, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u,
      'candidate_batch_request_invalid',
    ),
    stateSnapshotHash: boundedString(
      data.stateSnapshotHash, /^sha256:[0-9a-f]{64}$/u,
      'candidate_batch_snapshot_invalid',
    ),
    candidates: Object.freeze([...candidates]),
  });
}
