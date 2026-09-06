import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const AUTHORITY_CLASSES = new Set([
  'pure',
  'read_only',
  'prepared_result_only',
  'central_state_write',
  'external_effect',
]);
const COMPONENT_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'componentId',
  'componentKind',
  'sourceGeneration',
  'observedAt',
  'expiresAt',
  'consistencyDomainHash',
  'sourceIdentityHash',
  'schemaIdentityHash',
  'authorityClass',
  'dependsOn',
  'payload',
]);
const SEALED_COMPONENT_FIELDS = Object.freeze([...COMPONENT_FIELDS, 'componentHash']);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'snapshotId',
  'generation',
  'observedAt',
  'expiresAt',
  'consistencyDomainHash',
  'priorSnapshotHash',
  'requiredComponentIds',
  'components',
]);
const DEFAULT_LIMITS = Object.freeze({
  maximumComponents: 256,
  maximumTotalBytes: 16 * 1024 * 1024,
  maximumComponentBytes: 1024 * 1024,
  maximumStringBytes: 8192,
  maximumArrayItems: 8192,
  maximumObjectKeys: 1024,
  maximumDepth: 32,
  maximumNodes: 262144,
});

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordValues(value, allowed, code) {
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string'
    || (allowed !== null && !allowed.includes(key))
    || !descriptors[key].enumerable
    || !Object.hasOwn(descriptors[key], 'value'))) throw failure(code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArrayValues(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (!descriptors.length || descriptors.length.value !== value.length
    || descriptors.length.enumerable || keys.length !== value.length + 1
    || keys.some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= value.length))) throw failure(code);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    return descriptor.value;
  });
}

function boundedString(value, limits, code, { hash = false } = {}) {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > limits.maximumStringBytes
    || (hash && !HASH.test(value))) throw failure(code);
  return value;
}

function optionalHash(value, limits, code) {
  if (value === null) return null;
  return boundedString(value, limits, code, { hash: true });
}

function canonicalTimestamp(value, limits, code) {
  boundedString(value, limits, code);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw failure(code);
  return value;
}

function captureJson(value, limits, state, depth = 0, code = 'snapshot_payload_invalid') {
  if (depth > limits.maximumDepth || ++state.nodes > limits.maximumNodes) throw failure(code);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.maximumStringBytes) throw failure(code);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw failure(code);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const rows = denseArrayValues(value, code);
    if (rows.length > limits.maximumArrayItems) throw failure(code);
    return Object.freeze(rows.map((row) => captureJson(row, limits, state, depth + 1, code)));
  }
  if (value && typeof value === 'object') {
    const rows = recordValues(value, null, code);
    const keys = Object.keys(rows).sort(compareText);
    if (keys.length > limits.maximumObjectKeys) throw failure(code);
    return Object.freeze(Object.fromEntries(keys.map((key) => [
      key,
      captureJson(rows[key], limits, state, depth + 1, code),
    ])));
  }
  throw failure(code);
}

function captureStringSet(value, limits, code, { allowEmpty = true } = {}) {
  const rows = denseArrayValues(value, code);
  if (rows.length > limits.maximumArrayItems || (!allowEmpty && rows.length === 0)) {
    throw failure(code);
  }
  const values = rows.map((row) => boundedString(row, limits, code));
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values.sort(compareText));
}

function normalizeLimits(options = {}) {
  const values = recordValues(options, Object.keys(DEFAULT_LIMITS), 'snapshot_builder_limits_invalid');
  const limits = { ...DEFAULT_LIMITS, ...values };
  const ceilings = {
    maximumComponents: 4096,
    maximumTotalBytes: 128 * 1024 * 1024,
    maximumComponentBytes: 16 * 1024 * 1024,
    maximumStringBytes: 1024 * 1024,
    maximumArrayItems: 65536,
    maximumObjectKeys: 8192,
    maximumDepth: 64,
    maximumNodes: 2_000_000,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) {
      throw failure('snapshot_builder_limits_invalid');
    }
  }
  if (limits.maximumComponentBytes > limits.maximumTotalBytes) {
    throw failure('snapshot_builder_limits_invalid');
  }
  return Object.freeze(limits);
}

function captureComponentBody(value, limits) {
  const input = recordValues(value, COMPONENT_FIELDS, 'snapshot_component_invalid');
  for (const key of COMPONENT_FIELDS) {
    if (!Object.hasOwn(input, key)) throw failure('snapshot_component_invalid');
  }
  if (input.schemaVersion !== 1 || input.kind !== 'SnapshotComponentV1'
    || !Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 0
    || !AUTHORITY_CLASSES.has(input.authorityClass)) throw failure('snapshot_component_invalid');
  const payload = captureJson(input.payload, limits, { nodes: 0 });
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'SnapshotComponentV1',
    componentId: boundedString(input.componentId, limits, 'snapshot_component_invalid'),
    componentKind: boundedString(input.componentKind, limits, 'snapshot_component_invalid'),
    sourceGeneration: input.sourceGeneration,
    observedAt: canonicalTimestamp(input.observedAt, limits, 'snapshot_component_time_invalid'),
    expiresAt: canonicalTimestamp(input.expiresAt, limits, 'snapshot_component_time_invalid'),
    consistencyDomainHash: boundedString(
      input.consistencyDomainHash,
      limits,
      'snapshot_component_invalid',
      { hash: true },
    ),
    sourceIdentityHash: boundedString(
      input.sourceIdentityHash,
      limits,
      'snapshot_component_invalid',
      { hash: true },
    ),
    schemaIdentityHash: boundedString(
      input.schemaIdentityHash,
      limits,
      'snapshot_component_invalid',
      { hash: true },
    ),
    authorityClass: input.authorityClass,
    dependsOn: captureStringSet(input.dependsOn, limits, 'snapshot_component_dependencies_invalid'),
    payload,
  });
  if (Date.parse(body.observedAt) >= Date.parse(body.expiresAt)) {
    throw failure('snapshot_component_time_invalid');
  }
  return body;
}

export function sealSnapshotComponent(value, options = {}) {
  const limits = normalizeLimits(options);
  const body = captureComponentBody(value, limits);
  const componentHash = hashRecord('SnapshotComponentV1', body);
  const sealed = Object.freeze({ ...body, componentHash });
  if (Buffer.byteLength(stableStringify(sealed), 'utf8') > limits.maximumComponentBytes) {
    throw failure('snapshot_component_byte_limit');
  }
  return sealed;
}

function captureSealedComponent(value, limits) {
  const input = recordValues(value, SEALED_COMPONENT_FIELDS, 'snapshot_component_invalid');
  if (!Object.hasOwn(input, 'componentHash')) throw failure('snapshot_component_invalid');
  const body = captureComponentBody(Object.fromEntries(
    COMPONENT_FIELDS.map((key) => [key, input[key]]),
  ), limits);
  const componentHash = boundedString(
    input.componentHash,
    limits,
    'snapshot_component_hash_invalid',
    { hash: true },
  );
  if (componentHash !== hashRecord('SnapshotComponentV1', body)) {
    throw failure('snapshot_component_hash_invalid');
  }
  const sealed = Object.freeze({ ...body, componentHash });
  if (Buffer.byteLength(stableStringify(sealed), 'utf8') > limits.maximumComponentBytes) {
    throw failure('snapshot_component_byte_limit');
  }
  return sealed;
}

function topologicalOrder(components) {
  const byId = new Map(components.map((component) => [component.componentId, component]));
  const incoming = new Map(components.map((component) => [component.componentId, 0]));
  const followers = new Map(components.map((component) => [component.componentId, []]));
  for (const component of components) {
    for (const dependency of component.dependsOn) {
      if (!byId.has(dependency)) throw failure('snapshot_component_dependency_missing');
      if (dependency === component.componentId) throw failure('snapshot_component_dependency_cycle');
      incoming.set(component.componentId, incoming.get(component.componentId) + 1);
      followers.get(dependency).push(component.componentId);
    }
  }
  for (const rows of followers.values()) rows.sort(compareText);
  const ready = [...incoming.entries()].filter(([, count]) => count === 0)
    .map(([id]) => id).sort(compareText);
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const follower of followers.get(id)) {
      const next = incoming.get(follower) - 1;
      incoming.set(follower, next);
      if (next === 0) {
        ready.push(follower);
        ready.sort(compareText);
      }
    }
  }
  if (ordered.length !== components.length) throw failure('snapshot_component_dependency_cycle');
  return Object.freeze(ordered);
}

export function createSnapshotBuilder(options = {}) {
  const limits = normalizeLimits(options);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ControlPlaneSnapshotBuilderV1',
    limits,
    build(value) {
      const input = recordValues(value, REQUEST_FIELDS, 'snapshot_build_request_invalid');
      for (const key of REQUEST_FIELDS) {
        if (!Object.hasOwn(input, key)) throw failure('snapshot_build_request_invalid');
      }
      if (input.schemaVersion !== 1 || input.kind !== 'SnapshotBuildRequestV1'
        || !Number.isSafeInteger(input.generation) || input.generation < 1) {
        throw failure('snapshot_build_request_invalid');
      }
      const snapshotId = boundedString(input.snapshotId, limits, 'snapshot_build_request_invalid');
      const observedAt = canonicalTimestamp(input.observedAt, limits, 'snapshot_time_invalid');
      const expiresAt = canonicalTimestamp(input.expiresAt, limits, 'snapshot_time_invalid');
      if (Date.parse(observedAt) >= Date.parse(expiresAt)) throw failure('snapshot_time_invalid');
      const consistencyDomainHash = boundedString(
        input.consistencyDomainHash,
        limits,
        'snapshot_build_request_invalid',
        { hash: true },
      );
      const priorSnapshotHash = optionalHash(
        input.priorSnapshotHash,
        limits,
        'snapshot_prior_hash_invalid',
      );
      if ((input.generation === 1 && priorSnapshotHash !== null)
        || (input.generation > 1 && priorSnapshotHash === null)) {
        throw failure('snapshot_generation_chain_invalid');
      }
      const requiredComponentIds = captureStringSet(
        input.requiredComponentIds,
        limits,
        'snapshot_required_components_invalid',
        { allowEmpty: false },
      );
      const rawComponents = denseArrayValues(input.components, 'snapshot_component_set_invalid');
      if (rawComponents.length === 0 || rawComponents.length > limits.maximumComponents) {
        throw failure('snapshot_component_count_limit');
      }
      const components = rawComponents.map((row) => captureSealedComponent(row, limits));
      const byId = new Map();
      for (const component of components) {
        const prior = byId.get(component.componentId);
        if (prior) {
          if (stableStringify(prior) === stableStringify(component)) {
            throw failure('snapshot_component_duplicate');
          }
          throw failure('snapshot_component_id_conflict');
        }
        byId.set(component.componentId, component);
        if (component.consistencyDomainHash !== consistencyDomainHash) {
          throw failure('snapshot_consistency_domain_mismatch');
        }
        if (Date.parse(component.observedAt) > Date.parse(observedAt)
          || Date.parse(component.expiresAt) < Date.parse(expiresAt)) {
          throw failure('snapshot_component_freshness_invalid');
        }
      }
      for (const requiredId of requiredComponentIds) {
        if (!byId.has(requiredId)) throw failure('snapshot_required_component_missing');
      }
      const ordered = topologicalOrder(components);
      const captured = Object.freeze({
        snapshotId,
        generation: input.generation,
        observedAt,
        expiresAt,
        consistencyDomainHash,
        priorSnapshotHash,
        requiredComponentIds,
        components: ordered,
      });
      if (Buffer.byteLength(stableStringify(captured), 'utf8') > limits.maximumTotalBytes) {
        throw failure('snapshot_total_byte_limit');
      }
      const componentSetHash = hashRecord('SnapshotComponentSetV1', Object.freeze({
        consistencyDomainHash,
        components: ordered,
      }));
      const body = Object.freeze({
        schemaVersion: 1,
        kind: 'ControlPlaneSnapshotV1',
        status: 'complete',
        snapshotId,
        generation: input.generation,
        observedAt,
        expiresAt,
        consistencyDomainHash,
        priorSnapshotHash,
        requiredComponentIds,
        componentCount: ordered.length,
        components: ordered,
        componentSetHash,
        authority: Object.freeze({
          stateMutationAuthorized: false,
          externalEffectAuthorized: false,
          productionActivationAuthorized: false,
        }),
      });
      return Object.freeze({
        ...body,
        snapshotHash: hashRecord('ControlPlaneSnapshotV1', body),
      });
    },
  });
}
