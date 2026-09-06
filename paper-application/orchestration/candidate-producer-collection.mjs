import { addAbortListener as subscribeAbort } from 'node:events';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { createActionCandidate, routeActionCandidates } from './candidate-router.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'planningRequestId', 'stateSnapshotHash',
  'capabilityId', 'hardConstraintSetHash', 'objectiveVersion',
  'resourcePriceSnapshotHash', 'candidateLimit', 'deadline',
  'allowedSideEffectClasses', 'inputArtifactHashes',
]);
const BINDING_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'capabilityIds',
  'qualificationSubjectHash', 'validUntil',
]);
const PRODUCER_FIELDS = Object.freeze(['moduleId', 'moduleVersion', 'produce']);
const RESPONSE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'moduleId', 'moduleVersion',
  'planningRequestHash', 'candidates', 'emptyReason', 'authority',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId',
  'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
  'resourceVector', 'duration', 'cost', 'value', 'risk', 'preconditions',
  'dependencyEffects', 'sideEffectClass', 'irreversibleBoundary',
  'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
  'singletonReason', 'candidatePayloadHash',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'productionAuthorized', 'providerAuthorized',
  'writerAuthorityGranted', 'externalAuthorityClaimed',
]);
const INPUT_FIELDS = Object.freeze([
  'request', 'moduleBindings', 'producers', 'nowEpochMs', 'signal',
  'maximumConcurrency', 'producerTimeoutMs', 'maximumCandidatesPerProducer',
  'maximumProducerResponseBytes', 'maximumTotalCandidates', 'routerLimits',
]);

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function record(value, allowed, required, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw failure(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(output, key))) throw failure(code);
  return output;
}
function arrayValues(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')
    || keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) throw failure(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}
function text(value, code, maximumBytes = 4096, pattern = null) {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0')
    || (pattern && !pattern.test(value))) throw failure(code);
  return value;
}
function nullableText(value, code, maximumBytes = 4096) {
  return value === null ? null : text(value, code, maximumBytes);
}
function hash(value, code) { return text(value, code, 71, HASH); }
function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}
function timestamp(value, code) {
  text(value, code, 64, DATE_TIME);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  return Object.freeze({ source: value, milliseconds });
}
function canonicalTextSet(value, maximum, code) {
  const values = arrayValues(value, maximum, code)
    .map((item) => text(item, code, 256, IDENTIFIER)).sort(compareText);
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values);
}
function canonicalHashSet(value, maximum, code) {
  const values = arrayValues(value, maximum, code)
    .map((item) => hash(item, code)).sort(compareText);
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values);
}
function captureAuthority(value, code) {
  const data = record(value, AUTHORITY_FIELDS, AUTHORITY_FIELDS, code);
  if (AUTHORITY_FIELDS.some((field) => data[field] !== false)) throw failure(code);
  return Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, false])));
}

function captureRequest(value) {
  const data = record(value, REQUEST_FIELDS, REQUEST_FIELDS,
    'candidate_collection_request_invalid');
  const deadline = timestamp(data.deadline, 'candidate_collection_deadline_invalid');
  return Object.freeze({
    schemaVersion: data.schemaVersion,
    kind: data.kind,
    planningRequestId: text(data.planningRequestId,
      'candidate_collection_request_id_invalid', 256, IDENTIFIER),
    stateSnapshotHash: hash(data.stateSnapshotHash,
      'candidate_collection_snapshot_invalid'),
    capabilityId: text(data.capabilityId,
      'candidate_collection_capability_invalid', 256, IDENTIFIER),
    hardConstraintSetHash: hash(data.hardConstraintSetHash,
      'candidate_collection_constraints_invalid'),
    objectiveVersion: text(data.objectiveVersion,
      'candidate_collection_objective_invalid', 256, IDENTIFIER),
    resourcePriceSnapshotHash: hash(data.resourcePriceSnapshotHash,
      'candidate_collection_prices_invalid'),
    candidateLimit: safeInteger(data.candidateLimit, 1, 4096,
      'candidate_collection_candidate_limit_invalid'),
    deadline: deadline.source,
    allowedSideEffectClasses: canonicalTextSet(data.allowedSideEffectClasses, 64,
      'candidate_collection_side_effect_classes_invalid'),
    inputArtifactHashes: canonicalHashSet(data.inputArtifactHashes, 4096,
      'candidate_collection_input_artifacts_invalid'),
  });
}

function captureBinding(value, nowEpochMs) {
  const data = record(value, BINDING_FIELDS, BINDING_FIELDS,
    'candidate_collection_binding_invalid');
  const validUntil = timestamp(data.validUntil, 'candidate_collection_binding_expiry_invalid');
  if (validUntil.milliseconds <= nowEpochMs) throw failure('candidate_collection_binding_expired');
  return Object.freeze({
    moduleId: text(data.moduleId, 'candidate_collection_module_invalid', 256, IDENTIFIER),
    moduleVersion: text(data.moduleVersion, 'candidate_collection_module_version_invalid', 256, IDENTIFIER),
    capabilityIds: canonicalTextSet(data.capabilityIds, 256,
      'candidate_collection_binding_capabilities_invalid'),
    qualificationSubjectHash: hash(data.qualificationSubjectHash,
      'candidate_collection_qualification_invalid'),
    validUntil: validUntil.source,
  });
}

function captureProducer(value) {
  const data = record(value, PRODUCER_FIELDS, PRODUCER_FIELDS,
    'candidate_collection_producer_invalid');
  if (typeof data.produce !== 'function') throw failure('candidate_collection_producer_invalid');
  return Object.freeze({
    moduleId: text(data.moduleId, 'candidate_collection_producer_module_invalid', 256, IDENTIFIER),
    moduleVersion: text(data.moduleVersion,
      'candidate_collection_producer_version_invalid', 256, IDENTIFIER),
    produce: data.produce,
  });
}

function canonicalCandidate(value, binding, request) {
  const data = record(value, CANDIDATE_FIELDS, CANDIDATE_FIELDS,
    'candidate_collection_candidate_invalid');
  const source = Object.create(null);
  for (const field of CANDIDATE_FIELDS) {
    if (field !== 'candidatePayloadHash') source[field] = data[field];
  }
  const candidate = createActionCandidate(source);
  if (candidate.candidatePayloadHash !== data.candidatePayloadHash
    || stableStringify(candidate) !== stableStringify(data)) {
    throw failure('candidate_collection_candidate_not_canonical');
  }
  if (candidate.moduleId !== binding.moduleId
    || candidate.moduleVersion !== binding.moduleVersion
    || candidate.planningRequestId !== request.planningRequestId
    || candidate.stateSnapshotHash !== request.stateSnapshotHash
    || candidate.capabilityId !== request.capabilityId) {
    throw failure('candidate_collection_candidate_binding_mismatch');
  }
  return candidate;
}

function captureResponse(value, binding, request, planningRequestHash, limits) {
  const data = record(value, RESPONSE_FIELDS, RESPONSE_FIELDS,
    'candidate_collection_response_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'ModuleCandidateResponseV1'
    || data.status !== 'complete') throw failure('candidate_collection_response_incomplete');
  if (data.moduleId !== binding.moduleId || data.moduleVersion !== binding.moduleVersion
    || data.planningRequestHash !== planningRequestHash) {
    throw failure('candidate_collection_response_binding_mismatch');
  }
  const candidates = arrayValues(data.candidates, limits.maximumCandidatesPerProducer,
    'candidate_collection_response_candidates_invalid')
    .map((candidate) => canonicalCandidate(candidate, binding, request));
  const emptyReason = nullableText(data.emptyReason,
    'candidate_collection_empty_reason_invalid', 256);
  if ((candidates.length === 0) !== (emptyReason !== null)) {
    throw failure('candidate_collection_empty_reason_invalid');
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'ModuleCandidateResponseV1',
    status: 'complete',
    moduleId: binding.moduleId,
    moduleVersion: binding.moduleVersion,
    planningRequestHash,
    candidateCount: candidates.length,
    candidatePayloadHashes: Object.freeze(candidates
      .map((candidate) => candidate.candidatePayloadHash).sort(compareText)),
    emptyReason,
    authority: captureAuthority(data.authority,
      'candidate_collection_response_authority_invalid'),
  });
  if (Buffer.byteLength(stableStringify({ ...body, candidates }), 'utf8')
    > limits.maximumProducerResponseBytes) {
    throw failure('candidate_collection_response_byte_limit');
  }
  return Object.freeze({
    body,
    candidates: Object.freeze(candidates),
    responseHash: hashRecord('ModuleCandidateResponseV1', body),
  });
}

function abortError() {
  return Object.assign(new Error('candidate_collection_aborted'), {
    name: 'AbortError', code: 'candidate_collection_aborted', retryable: false,
  });
}

async function runProducer({ producer, binding, request, planningRequestHash,
  collectionSignal, timeoutMs, limits }) {
  const controller = new AbortController();
  const abortController = () => controller.abort('candidate_collection_aborted');
  const collectionSubscription = subscribeAbort(collectionSignal, abortController);
  let abortSubscription;
  let timer;
  const operation = Promise.resolve().then(() => producer.produce(Object.freeze({
    planningRequest: request,
    planningRequestHash,
    moduleBinding: binding,
    signal: controller.signal,
  })));
  operation.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort('candidate_producer_timeout');
      reject(failure(`candidate_producer_timeout:${binding.moduleId}`));
    }, timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    abortSubscription = subscribeAbort(collectionSignal, () => reject(abortError()));
  });
  try {
    const response = await Promise.race([operation, timeout, aborted]);
    if (collectionSignal.aborted) throw abortError();
    return captureResponse(response, binding, request, planningRequestHash, limits);
  } catch (error) {
    if (error?.code === 'candidate_collection_aborted'
      || String(error?.code || '').startsWith('candidate_producer_timeout:')) throw error;
    throw failure(`candidate_producer_failed:${binding.moduleId}`);
  } finally {
    clearTimeout(timer);
    collectionSubscription[Symbol.dispose]();
    abortSubscription?.[Symbol.dispose]();
  }
}

export async function collectModuleCandidateFrontier(input) {
  const root = record(input, INPUT_FIELDS,
    ['request', 'moduleBindings', 'producers', 'nowEpochMs'],
    'candidate_collection_input_invalid');
  const nowEpochMs = safeInteger(root.nowEpochMs, 0, Number.MAX_SAFE_INTEGER,
    'candidate_collection_clock_invalid');
  const request = captureRequest(root.request);
  const maximumConcurrency = Object.hasOwn(root, 'maximumConcurrency')
    ? safeInteger(root.maximumConcurrency, 1, 64,
      'candidate_collection_concurrency_invalid') : 4;
  const producerTimeoutMs = Object.hasOwn(root, 'producerTimeoutMs')
    ? safeInteger(root.producerTimeoutMs, 1, 600_000,
      'candidate_collection_timeout_invalid') : 10_000;
  const limits = Object.freeze({
    maximumCandidatesPerProducer: Object.hasOwn(root, 'maximumCandidatesPerProducer')
      ? safeInteger(root.maximumCandidatesPerProducer, 0, 4096,
        'candidate_collection_per_producer_limit_invalid') : 256,
    maximumProducerResponseBytes: Object.hasOwn(root, 'maximumProducerResponseBytes')
      ? safeInteger(root.maximumProducerResponseBytes, 1024, 16 * 1024 * 1024,
        'candidate_collection_response_byte_limit_invalid') : 2 * 1024 * 1024,
    maximumTotalCandidates: Object.hasOwn(root, 'maximumTotalCandidates')
      ? safeInteger(root.maximumTotalCandidates, 0, 4096,
        'candidate_collection_total_limit_invalid') : 4096,
  });
  const moduleBindings = arrayValues(root.moduleBindings, 256,
    'candidate_collection_bindings_invalid')
    .map((binding) => captureBinding(binding, nowEpochMs))
    .sort((left, right) => compareText(left.moduleId, right.moduleId)
      || compareText(left.moduleVersion, right.moduleVersion));
  const producers = arrayValues(root.producers, 256,
    'candidate_collection_producers_invalid')
    .map(captureProducer)
    .sort((left, right) => compareText(left.moduleId, right.moduleId)
      || compareText(left.moduleVersion, right.moduleVersion));
  if (moduleBindings.length === 0 || producers.length !== moduleBindings.length) {
    throw failure('candidate_collection_producer_coverage_invalid');
  }
  const bindingKeys = moduleBindings.map((item) => `${item.moduleId}\0${item.moduleVersion}`);
  const producerKeys = producers.map((item) => `${item.moduleId}\0${item.moduleVersion}`);
  if (new Set(bindingKeys).size !== bindingKeys.length
    || new Set(producerKeys).size !== producerKeys.length
    || stableStringify(bindingKeys) !== stableStringify(producerKeys)) {
    throw failure('candidate_collection_producer_coverage_invalid');
  }
  const preflightInput = {
    request,
    moduleBindings,
    candidates: [],
    emptyReason: 'candidate_collection_preflight',
    nowEpochMs,
    ...(Object.hasOwn(root, 'routerLimits') ? { limits: root.routerLimits } : {}),
  };
  const preflight = routeActionCandidates(preflightInput);
  const collectionController = new AbortController();
  const externalSignal = Object.hasOwn(root, 'signal') ? root.signal : null;
  let externalSubscription;
  if (externalSignal !== null) {
    if (!(externalSignal instanceof AbortSignal)) throw failure('candidate_collection_signal_invalid');
    if (externalSignal.aborted) throw abortError();
    externalSubscription = subscribeAbort(externalSignal,
      () => collectionController.abort('candidate_collection_aborted'));
  }
  const results = Array(producers.length);
  let nextIndex = 0;
  let firstFailure = null;
  const worker = async () => {
    while (!collectionController.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= producers.length) return;
      try {
        results[index] = await runProducer({
          producer: producers[index], binding: moduleBindings[index], request,
          planningRequestHash: preflight.planningRequestHash,
          collectionSignal: collectionController.signal,
          timeoutMs: producerTimeoutMs, limits,
        });
      } catch (error) {
        if (firstFailure === null && error?.code !== 'candidate_collection_aborted') {
          firstFailure = error;
        }
        collectionController.abort('candidate_collection_failed');
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(maximumConcurrency, producers.length) }, worker));
  } finally {
    externalSubscription?.[Symbol.dispose]();
  }
  if (firstFailure) throw firstFailure;
  if (externalSignal?.aborted || collectionController.signal.aborted) throw abortError();
  let rawCandidateCount = 0;
  const candidates = [];
  for (const result of results) {
    rawCandidateCount += result.candidates.length;
    if (rawCandidateCount > limits.maximumTotalCandidates) {
      throw failure('candidate_collection_total_limit_exceeded');
    }
    candidates.push(...result.candidates);
  }
  const frontier = routeActionCandidates({
    request,
    moduleBindings,
    candidates,
    ...(candidates.length === 0
      ? { emptyReason: 'all_candidate_producers_returned_empty' } : {}),
    nowEpochMs,
    ...(Object.hasOwn(root, 'routerLimits') ? { limits: root.routerLimits } : {}),
  });
  const producerReceipts = Object.freeze(results.map((result) => Object.freeze({
    ...result.body,
    responseHash: result.responseHash,
  })));
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CollectedCandidateFrontierV1',
    status: 'complete',
    planningRequestHash: preflight.planningRequestHash,
    moduleBindingSetHash: preflight.moduleBindingSetHash,
    producerCount: producerReceipts.length,
    producerResponseHashes: Object.freeze(producerReceipts.map((receipt) => receipt.responseHash)),
    rawCandidateCount,
    candidateSetHash: frontier.candidateSetHash,
    authority: Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, false]))),
  });
  return Object.freeze({
    ...body,
    producerReceipts,
    frontier,
    collectionHash: hashRecord('CollectedCandidateFrontierV1', body),
  });
}
