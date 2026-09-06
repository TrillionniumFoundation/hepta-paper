import { addAbortListener as subscribeAbort } from 'node:events';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import {
  buildPlanningStateSnapshot,
  createPlanningSnapshotComponent,
} from './snapshot-builder.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const INPUT_FIELDS = Object.freeze([
  'request', 'moduleBindings', 'port', 'nowEpochMs', 'signal',
  'maximumConcurrency', 'componentTimeoutMs', 'closeTimeoutMs', 'builderLimits',
]);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'snapshotRequestId', 'readTransactionHash',
  'consistencyEpoch', 'deadline', 'requiredComponents',
]);
const REQUIREMENT_FIELDS = Object.freeze([
  'componentId', 'componentKind', 'minimumRevision',
  'maximumAgeMs', 'maximumPayloadBytes',
]);
const BINDING_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'projectionKinds',
  'qualificationSubjectHash', 'validUntil',
]);
const PORT_FIELDS = Object.freeze(['kind', 'open']);
const SESSION_FIELDS = Object.freeze([
  'kind', 'readTransactionHash', 'consistencyEpoch', 'readComponent', 'close',
]);
const RESPONSE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'component', 'authority',
]);
const COMPONENT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'componentId', 'componentKind',
  'sourceModuleId', 'sourceModuleVersion', 'sourceQualificationHash',
  'readTransactionHash', 'consistencyEpoch', 'revision', 'generation',
  'capturedAt', 'expiresAt', 'payload', 'componentPayloadHash',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'productionAuthorized', 'writerAuthorityGranted',
  'providerAuthorized', 'externalAuthorityClaimed',
]);
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

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
function hash(value, code) { return text(value, code, 71, HASH); }
function timestamp(value, code) {
  text(value, code, 64, DATE_TIME);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  return Object.freeze({ source: value, milliseconds });
}
function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}
function canonicalIdentifiers(value, maximum, code) {
  const values = arrayValues(value, maximum, code)
    .map((item) => text(item, code, 256, IDENTIFIER)).sort(compareText);
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values);
}
function aborted(signal) {
  if (signal === null) return false;
  try { return abortedGetter.call(signal); }
  catch { throw failure('planning_snapshot_signal_invalid'); }
}
function abortFailure() {
  return Object.assign(new Error('planning_snapshot_collection_aborted'), {
    name: 'AbortError', code: 'planning_snapshot_collection_aborted', retryable: false,
  });
}
function falseAuthority(value, code) {
  const data = record(value, AUTHORITY_FIELDS, AUTHORITY_FIELDS, code);
  if (AUTHORITY_FIELDS.some((field) => data[field] !== false)) throw failure(code);
  return Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, false])));
}

function captureRequirement(value) {
  const data = record(value, REQUIREMENT_FIELDS, REQUIREMENT_FIELDS,
    'planning_snapshot_requirement_invalid');
  return Object.freeze({
    componentId: text(data.componentId, 'planning_snapshot_component_id_invalid', 256, IDENTIFIER),
    componentKind: text(data.componentKind, 'planning_snapshot_component_kind_invalid', 256, IDENTIFIER),
    minimumRevision: safeInteger(data.minimumRevision, 0, Number.MAX_SAFE_INTEGER,
      'planning_snapshot_minimum_revision_invalid'),
    maximumAgeMs: safeInteger(data.maximumAgeMs, 0, 365 * 24 * 60 * 60 * 1000,
      'planning_snapshot_maximum_age_invalid'),
    maximumPayloadBytes: safeInteger(data.maximumPayloadBytes, 1, 16 * 1024 * 1024,
      'planning_snapshot_payload_limit_invalid'),
  });
}

function captureRequest(value, nowEpochMs) {
  const data = record(value, REQUEST_FIELDS, REQUEST_FIELDS,
    'planning_snapshot_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'PlanningStateSnapshotRequestV1') {
    throw failure('planning_snapshot_request_identity_invalid');
  }
  const deadline = timestamp(data.deadline, 'planning_snapshot_deadline_invalid');
  if (deadline.milliseconds <= nowEpochMs) throw failure('planning_snapshot_request_expired');
  const requirements = arrayValues(data.requiredComponents, 256,
    'planning_snapshot_requirements_invalid').map(captureRequirement)
    .sort((left, right) => compareText(left.componentId, right.componentId));
  if (requirements.length === 0
    || new Set(requirements.map((item) => item.componentId)).size !== requirements.length) {
    throw failure('planning_snapshot_requirement_coverage_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: text(data.snapshotRequestId,
      'planning_snapshot_request_id_invalid', 256, IDENTIFIER),
    readTransactionHash: hash(data.readTransactionHash,
      'planning_snapshot_transaction_invalid'),
    consistencyEpoch: safeInteger(data.consistencyEpoch, 0, Number.MAX_SAFE_INTEGER,
      'planning_snapshot_epoch_invalid'),
    deadline: deadline.source,
    requiredComponents: Object.freeze(requirements),
  });
}

function captureBinding(value, nowEpochMs) {
  const data = record(value, BINDING_FIELDS, BINDING_FIELDS,
    'planning_snapshot_binding_invalid');
  const validUntil = timestamp(data.validUntil, 'planning_snapshot_binding_expiry_invalid');
  if (validUntil.milliseconds <= nowEpochMs) throw failure('planning_snapshot_binding_expired');
  return Object.freeze({
    moduleId: text(data.moduleId, 'planning_snapshot_module_invalid', 256, IDENTIFIER),
    moduleVersion: text(data.moduleVersion,
      'planning_snapshot_module_version_invalid', 256, IDENTIFIER),
    projectionKinds: canonicalIdentifiers(data.projectionKinds, 256,
      'planning_snapshot_projection_kinds_invalid'),
    qualificationSubjectHash: hash(data.qualificationSubjectHash,
      'planning_snapshot_qualification_invalid'),
    validUntil: validUntil.source,
  });
}

function capturePort(value) {
  const data = record(value, PORT_FIELDS, PORT_FIELDS, 'planning_snapshot_port_invalid');
  if (data.kind !== 'PlanningSnapshotReadPortV1' || typeof data.open !== 'function') {
    throw failure('planning_snapshot_port_invalid');
  }
  return Object.freeze({ kind: data.kind, open: data.open });
}

function captureSession(value, request) {
  const data = record(value, SESSION_FIELDS, SESSION_FIELDS,
    'planning_snapshot_session_invalid');
  if (data.kind !== 'PlanningSnapshotReadSessionV1'
    || data.readTransactionHash !== request.readTransactionHash
    || data.consistencyEpoch !== request.consistencyEpoch
    || typeof data.readComponent !== 'function' || typeof data.close !== 'function') {
    throw failure('planning_snapshot_session_identity_invalid');
  }
  return Object.freeze({
    kind: data.kind,
    readTransactionHash: data.readTransactionHash,
    consistencyEpoch: data.consistencyEpoch,
    readComponent: data.readComponent,
    close: data.close,
  });
}

function resolveBindings(requirements, bindings) {
  const keys = new Set();
  for (const binding of bindings) {
    const key = `${binding.moduleId}\0${binding.moduleVersion}`;
    if (keys.has(key)) throw failure('planning_snapshot_binding_duplicate');
    keys.add(key);
  }
  const used = new Set();
  const coverage = requirements.map((requirement) => {
    const matches = bindings.filter((binding) =>
      binding.projectionKinds.includes(requirement.componentKind));
    if (matches.length !== 1) {
      throw failure(`planning_snapshot_binding_coverage_invalid:${requirement.componentKind}`);
    }
    used.add(`${matches[0].moduleId}\0${matches[0].moduleVersion}`);
    return Object.freeze({ requirement, binding: matches[0] });
  });
  if (used.size !== bindings.length) throw failure('planning_snapshot_unused_binding');
  return Object.freeze(coverage);
}

function canonicalComponent(value, requirement, binding, request) {
  const data = record(value, COMPONENT_FIELDS, COMPONENT_FIELDS,
    'planning_snapshot_component_invalid');
  const source = Object.create(null);
  for (const field of COMPONENT_FIELDS) {
    if (field !== 'componentPayloadHash') source[field] = data[field];
  }
  const component = createPlanningSnapshotComponent(source);
  if (component.componentPayloadHash !== data.componentPayloadHash
    || stableStringify(component) !== stableStringify(data)) {
    throw failure('planning_snapshot_component_not_canonical');
  }
  if (component.componentId !== requirement.componentId
    || component.componentKind !== requirement.componentKind
    || component.sourceModuleId !== binding.moduleId
    || component.sourceModuleVersion !== binding.moduleVersion
    || component.sourceQualificationHash !== binding.qualificationSubjectHash
    || component.readTransactionHash !== request.readTransactionHash
    || component.consistencyEpoch !== request.consistencyEpoch) {
    throw failure('planning_snapshot_component_binding_mismatch');
  }
  return component;
}

function captureResponse(value, requirement, binding, request) {
  const data = record(value, RESPONSE_FIELDS, RESPONSE_FIELDS,
    'planning_snapshot_response_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'PlanningSnapshotComponentResponseV1'
    || data.status !== 'complete') throw failure('planning_snapshot_response_incomplete');
  falseAuthority(data.authority, 'planning_snapshot_response_authority_invalid');
  return canonicalComponent(data.component, requirement, binding, request);
}

function raceOperation(operation, signal, timeoutMs, timeoutCode) {
  operation.catch(() => {});
  let timer;
  let subscription;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure(timeoutCode)), timeoutMs);
  });
  const cancellation = new Promise((_, reject) => {
    subscription = subscribeAbort(signal, () => reject(abortFailure()));
  });
  return Promise.race([operation, timeout, cancellation]).finally(() => {
    clearTimeout(timer);
    subscription?.[Symbol.dispose]();
  });
}

async function readOne({ session, request, item, requestHash, signal, timeoutMs }) {
  const operation = Promise.resolve().then(() => session.readComponent(Object.freeze({
    snapshotRequest: request,
    snapshotRequestHash: requestHash,
    requirement: item.requirement,
    moduleBinding: item.binding,
    signal,
  })));
  try {
    const response = await raceOperation(operation, signal, timeoutMs,
      `planning_snapshot_component_timeout:${item.requirement.componentId}`);
    if (aborted(signal)) throw abortFailure();
    return captureResponse(response, item.requirement, item.binding, request);
  } catch (error) {
    if (error?.code === 'planning_snapshot_collection_aborted'
      || String(error?.code || '').startsWith('planning_snapshot_component_timeout:')) throw error;
    throw failure(`planning_snapshot_component_failed:${item.requirement.componentId}`);
  }
}

export async function collectPlanningStateSnapshot(input) {
  const root = record(input, INPUT_FIELDS,
    ['request', 'moduleBindings', 'port', 'nowEpochMs'],
    'planning_snapshot_input_invalid');
  const nowEpochMs = safeInteger(root.nowEpochMs, 0, Number.MAX_SAFE_INTEGER,
    'planning_snapshot_clock_invalid');
  const request = captureRequest(root.request, nowEpochMs);
  const bindings = arrayValues(root.moduleBindings, 256,
    'planning_snapshot_bindings_invalid').map((value) => captureBinding(value, nowEpochMs))
    .sort((left, right) => compareText(left.moduleId, right.moduleId)
      || compareText(left.moduleVersion, right.moduleVersion));
  const coverage = resolveBindings(request.requiredComponents, bindings);
  const port = capturePort(root.port);
  const maximumConcurrency = Object.hasOwn(root, 'maximumConcurrency')
    ? safeInteger(root.maximumConcurrency, 1, 64,
      'planning_snapshot_concurrency_invalid') : 4;
  const componentTimeoutMs = Object.hasOwn(root, 'componentTimeoutMs')
    ? safeInteger(root.componentTimeoutMs, 1, 600_000,
      'planning_snapshot_component_timeout_invalid') : 10_000;
  const closeTimeoutMs = Object.hasOwn(root, 'closeTimeoutMs')
    ? safeInteger(root.closeTimeoutMs, 1, 600_000,
      'planning_snapshot_close_timeout_invalid') : 10_000;
  const externalSignal = Object.hasOwn(root, 'signal') ? root.signal : null;
  if (aborted(externalSignal)) throw abortFailure();
  const controller = new AbortController();
  const externalSubscription = externalSignal
    ? subscribeAbort(externalSignal, () => controller.abort('planning_snapshot_collection_aborted'))
    : null;
  const requestHash = hashRecord('PlanningStateSnapshotRequestV1', request);
  let session = null;
  let primaryFailure = null;
  let snapshot = null;
  try {
    let opened;
    try {
      opened = port.open(Object.freeze({
        snapshotRequest: request,
        snapshotRequestHash: requestHash,
        moduleBindings: Object.freeze(bindings),
        signal: controller.signal,
      }));
    } catch {
      throw failure('planning_snapshot_session_open_failed');
    }
    if (opened && typeof opened.then === 'function') {
      throw failure('planning_snapshot_async_session_open_unsupported');
    }
    session = captureSession(opened, request);
    const results = Array(coverage.length);
    let nextIndex = 0;
    let firstFailure = null;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= coverage.length) return;
        try {
          results[index] = await readOne({
            session, request, item: coverage[index], requestHash,
            signal: controller.signal, timeoutMs: componentTimeoutMs,
          });
        } catch (error) {
          if (firstFailure === null && error?.code !== 'planning_snapshot_collection_aborted') {
            firstFailure = error;
          }
          controller.abort('planning_snapshot_component_failed');
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maximumConcurrency, coverage.length) }, worker));
    if (firstFailure) throw firstFailure;
    if (externalSignal && aborted(externalSignal)) throw abortFailure();
    if (controller.signal.aborted) throw abortFailure();
    snapshot = buildPlanningStateSnapshot({
      request,
      moduleBindings: bindings,
      components: results,
      nowEpochMs,
      ...(Object.hasOwn(root, 'builderLimits') ? { limits: root.builderLimits } : {}),
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    externalSubscription?.[Symbol.dispose]();
    controller.abort('planning_snapshot_collection_closed');
    if (session) {
      try {
        const closeOperation = Promise.resolve().then(() => session.close());
        await raceOperation(closeOperation, new AbortController().signal,
          closeTimeoutMs, 'planning_snapshot_session_close_timeout');
      } catch {
        throw failure(primaryFailure
          ? 'planning_snapshot_collection_and_close_failed'
          : 'planning_snapshot_session_close_failed');
      }
    }
  }
  if (primaryFailure) throw primaryFailure;
  return snapshot;
}
