import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  captureQualifiedPlanningModuleSetV1,
  routeActionCandidatesV1,
} from './candidate-router.mjs';

const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]{0,95}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const STATUSES = new Set([
  'candidate_batch_complete',
  'producer_timeout',
  'producer_failed',
  'producer_cancelled',
  'producer_unavailable',
]);
const MAX_PRODUCERS = 1024;
const DISPOSITION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'moduleId', 'moduleVersion', 'planningRequestId',
  'stateSnapshotHash', 'capabilityId', 'status', 'completedAt', 'candidates',
  'errorCode',
]);
const AUTHORITY = Object.freeze({
  executionAuthorized: false,
  writerAuthorized: false,
  providerAuthorized: false,
  releaseAuthorized: false,
  externalAuthorityClaimed: false,
});

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactRecord(value, fields, code) {
  const data = record(value, fields, code);
  if (Object.keys(data).length !== fields.length
    || fields.some((field) => !Object.hasOwn(data, field))) {
    throw failure(code);
  }
  return data;
}

function dense(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) throw failure(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    output.push(descriptor.value);
  }
  return output;
}

function text(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('\0')) {
    throw failure(code);
  }
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40) throw failure(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    throw failure(code);
  }
  return canonical;
}

function requestData(value) {
  if (!value || typeof value !== 'object') {
    throw failure('candidate_collection_planning_request_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const get = (key) => {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure('candidate_collection_planning_request_invalid');
    }
    return descriptor.value;
  };
  return Object.freeze({
    planningRequestId: text(
      get('planningRequestId'), IDENTIFIER,
      'candidate_collection_planning_request_invalid',
    ),
    stateSnapshotHash: text(
      get('stateSnapshotHash'), HASH,
      'candidate_collection_planning_request_invalid',
    ),
    capabilityId: text(
      get('capabilityId'), CAPABILITY_ID,
      'candidate_collection_planning_request_invalid',
    ),
    candidateLimit: get('candidateLimit'),
    deadline: timestamp(
      get('deadline'), 'candidate_collection_planning_request_invalid',
    ),
  });
}

function candidateOwner(value) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure('candidate_producer_candidate_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const moduleId = descriptors.moduleId;
  const moduleVersion = descriptors.moduleVersion;
  if (!moduleId?.enumerable || !Object.hasOwn(moduleId, 'value')
    || !moduleVersion?.enumerable || !Object.hasOwn(moduleVersion, 'value')) {
    throw failure('candidate_producer_candidate_invalid');
  }
  return Object.freeze({
    moduleId: text(
      moduleId.value, MODULE_ID, 'candidate_producer_candidate_invalid',
    ),
    moduleVersion: text(
      moduleVersion.value, TOKEN, 'candidate_producer_candidate_invalid',
    ),
  });
}

function dispositionComparator(left, right) {
  return compareText(
    `${left.moduleId}\0${left.moduleVersion}`,
    `${right.moduleId}\0${right.moduleVersion}`,
  );
}

function captureDisposition(value, request, observedAt) {
  const data = exactRecord(value, DISPOSITION_FIELDS,
    'candidate_producer_disposition_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'CandidateProducerDispositionV1') {
    throw failure('candidate_producer_disposition_identity_invalid');
  }
  const status = text(data.status, TOKEN,
    'candidate_producer_disposition_status_invalid');
  if (!STATUSES.has(status)) {
    throw failure('candidate_producer_disposition_status_invalid');
  }
  const completedAt = timestamp(
    data.completedAt, 'candidate_producer_disposition_time_invalid',
  );
  if (Date.parse(completedAt) > Date.parse(observedAt)
    || Date.parse(completedAt) > Date.parse(request.deadline)) {
    throw failure('candidate_producer_disposition_time_invalid');
  }
  if (data.planningRequestId !== request.planningRequestId
    || data.stateSnapshotHash !== request.stateSnapshotHash
    || data.capabilityId !== request.capabilityId) {
    throw failure('candidate_producer_disposition_subject_mismatch');
  }
  let candidates = null;
  let errorCode = null;
  if (status === 'candidate_batch_complete') {
    if (data.errorCode !== null) {
      throw failure('candidate_producer_disposition_complete_invalid');
    }
    candidates = dense(
      data.candidates, request.candidateLimit,
      'candidate_producer_candidate_collection_invalid',
    );
  } else {
    if (data.candidates !== null) {
      throw failure('candidate_producer_disposition_failure_invalid');
    }
    errorCode = text(
      data.errorCode, IDENTIFIER,
      'candidate_producer_disposition_error_invalid',
    );
  }
  return Object.freeze({
    moduleId: text(data.moduleId, MODULE_ID,
      'candidate_producer_module_invalid'),
    moduleVersion: text(data.moduleVersion, TOKEN,
      'candidate_producer_version_invalid'),
    status,
    completedAt,
    candidates,
    errorCode,
  });
}

function producerMetadata(binding, disposition, accepted = null) {
  if (!disposition) {
    return Object.freeze({
      moduleId: binding.moduleId,
      moduleVersion: binding.moduleVersion,
      status: 'producer_missing',
      completedAt: null,
      errorCode: 'producer_missing',
      submittedCandidateCount: 0,
      acceptedCandidateCount: 0,
      candidateSetHash: null,
    });
  }
  const acceptedCandidates = accepted || Object.freeze([]);
  return Object.freeze({
    moduleId: binding.moduleId,
    moduleVersion: binding.moduleVersion,
    status: disposition.status,
    completedAt: disposition.completedAt,
    errorCode: disposition.errorCode,
    submittedCandidateCount: disposition.candidates?.length || 0,
    acceptedCandidateCount: accepted === null ? 0 : acceptedCandidates.length,
    candidateSetHash: accepted === null
      ? null : hashRecord('ModuleCandidateSetV1', acceptedCandidates),
  });
}

export function collectCandidateBatchesV1(value) {
  const input = exactRecord(value, [
    'planningRequest', 'qualifiedModules', 'producerDispositions', 'observedAt',
  ], 'candidate_collection_input_invalid');
  const observedAt = timestamp(input.observedAt,
    'candidate_collection_observed_at_invalid');
  const requestProbe = routeActionCandidatesV1({
    planningRequest: input.planningRequest,
    qualifiedModules: input.qualifiedModules,
    candidates: [],
    observedAt,
  });
  const request = requestData(input.planningRequest);
  const qualified = captureQualifiedPlanningModuleSetV1(input.qualifiedModules);
  const expected = qualified.modules
    .filter((module) => module.capabilityIds.includes(request.capabilityId))
    .sort(dispositionComparator);
  const expectedByKey = new Map(expected.map((module) => [
    `${module.moduleId}\0${module.moduleVersion}`, module,
  ]));
  const supplied = dense(
    input.producerDispositions, MAX_PRODUCERS,
    'candidate_producer_disposition_collection_invalid',
  );
  const byKey = new Map();
  for (const raw of supplied) {
    const disposition = captureDisposition(raw, request, observedAt);
    const key = `${disposition.moduleId}\0${disposition.moduleVersion}`;
    if (!expectedByKey.has(key)) {
      throw failure('candidate_producer_not_qualified');
    }
    if (byKey.has(key)) {
      throw failure('candidate_producer_disposition_duplicate');
    }
    byKey.set(key, disposition);
  }
  const collectionComplete = expected.length > 0
    && expected.every((binding) => byKey.get(
      `${binding.moduleId}\0${binding.moduleVersion}`,
    )?.status === 'candidate_batch_complete');
  let frontier = null;
  let dispositions;
  let incompleteReasons;
  if (collectionComplete) {
    const candidates = [];
    for (const binding of expected) {
      const disposition = byKey.get(`${binding.moduleId}\0${binding.moduleVersion}`);
      for (const candidate of disposition.candidates) {
        const owner = candidateOwner(candidate);
        if (owner.moduleId !== binding.moduleId
          || owner.moduleVersion !== binding.moduleVersion) {
          throw failure('candidate_producer_candidate_owner_mismatch');
        }
        candidates.push(candidate);
      }
    }
    frontier = routeActionCandidatesV1({
      planningRequest: input.planningRequest,
      qualifiedModules: input.qualifiedModules,
      candidates,
      observedAt,
    });
    dispositions = expected.map((binding) => {
      const disposition = byKey.get(`${binding.moduleId}\0${binding.moduleVersion}`);
      const accepted = Object.freeze(frontier.candidates.filter((candidate) =>
        candidate.moduleId === binding.moduleId
        && candidate.moduleVersion === binding.moduleVersion));
      return producerMetadata(binding, disposition, accepted);
    });
    incompleteReasons = Object.freeze([]);
  } else {
    dispositions = expected.map((binding) => producerMetadata(
      binding, byKey.get(`${binding.moduleId}\0${binding.moduleVersion}`), null,
    ));
    incompleteReasons = Object.freeze(expected.length === 0
      ? ['no_qualified_producer']
      : [...new Set(dispositions
        .filter((item) => item.status !== 'candidate_batch_complete')
        .map((item) => item.status))].sort(compareText));
  }
  const frozenDispositions = Object.freeze(dispositions);
  const producerSet = Object.freeze(expected.map((binding) => Object.freeze({
    moduleId: binding.moduleId,
    moduleVersion: binding.moduleVersion,
    qualificationStatus: binding.qualificationStatus,
    qualificationIdentity: binding.qualificationIdentity,
  })));
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateCollectionResultV1',
    status: collectionComplete
      ? 'candidate_frontier_complete' : 'candidate_frontier_incomplete',
    planningRequestId: request.planningRequestId,
    planningRequestHash: requestProbe.planningRequestHash,
    stateSnapshotHash: request.stateSnapshotHash,
    capabilityId: request.capabilityId,
    qualifiedModuleSetHash: qualified.qualifiedModuleSetHash,
    producerSetHash: hashRecord('CandidateProducerSetV1', producerSet),
    observedAt,
    producerCount: expected.length,
    producerDispositions: frozenDispositions,
    incompleteReasons,
    frontier,
    authority: AUTHORITY,
  });
  return Object.freeze({
    ...body,
    candidateCollectionResultHash: hashRecord(
      'CandidateCollectionResultV1', body,
    ),
  });
}
