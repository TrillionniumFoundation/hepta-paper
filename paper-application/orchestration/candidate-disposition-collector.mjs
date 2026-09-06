import crypto from 'node:crypto';

export const CANDIDATE_DISPOSITION_INPUT_BOUNDARY = 'trusted_same_realm_plain_data';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]{0,95}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const COMPLETE = 'candidate_batch_complete';
const FAILURE_STATUSES = new Set([
  'candidate_batch_failed',
  'candidate_batch_cancelled',
  'candidate_batch_timeout',
  'candidate_batch_unavailable',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'productionAuthorized', 'providerAuthorized', 'campaignWriterActivated',
  'releaseAuthorized', 'submissionAuthorized', 'externalAuthorityClaimed',
]);
const LIMITS = Object.freeze({
  producers: 1024,
  candidates: 4096,
  batchBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  nodes: 131072,
  depth: 48,
  arrayItems: 16384,
  stringBytes: 64 * 1024,
});

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function scalarString(value, pattern, code, maximumBytes = LIMITS.stringBytes) {
  if (typeof value !== 'string' || value.includes('\0')) throw failure(code);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw failure(code);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw failure(code);
    }
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes
    || (pattern && !pattern.test(value))) throw failure(code);
  return value;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('candidate_batch_number_invalid');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  throw failure('candidate_batch_value_invalid');
}

function byteHash(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function recordHash(kind, value) {
  const record = Object.create(null);
  Object.defineProperties(record, {
    kind: { value: kind, enumerable: true },
    value: { value, enumerable: true },
  });
  return byteHash(canonicalStringify(record));
}

function dataValues(value, allowed, code) {
  if (!value || typeof value !== 'object') throw failure(code);
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw failure(code);
  }
  if (![Object.prototype, null].includes(prototype)
    || keys.length !== Reflect.ownKeys(descriptors).length
    || keys.some((key) => typeof key !== 'string'
      || !Object.hasOwn(descriptors, key)
      || (allowed && !allowed.includes(key)))) throw failure(code);
  const output = Object.create(null);
  for (const key of keys) {
    scalarString(key, null, code, 256);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    Object.defineProperty(output, key, {
      value: descriptor.value, enumerable: true, writable: false, configurable: false,
    });
  }
  return output;
}

function exactRecord(value, fields, code) {
  const data = dataValues(value, fields, code);
  if (Object.keys(data).length !== fields.length
    || fields.some((field) => !Object.hasOwn(data, field))) throw failure(code);
  return data;
}

function denseArray(value, code, maximum) {
  let array;
  let descriptors;
  let keys;
  try {
    array = Array.isArray(value);
    descriptors = array ? Object.getOwnPropertyDescriptors(value) : null;
    keys = array ? Reflect.ownKeys(value) : null;
  } catch {
    throw failure(code);
  }
  if (!array) throw failure(code);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || keys.length !== length + 1 || !keys.includes('length')) throw failure(code);
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}

function captureJson(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > state.maximumNodes || depth > LIMITS.depth) {
    throw failure('candidate_batch_structure_limit');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scalarString(value, null, 'candidate_batch_string_invalid');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('candidate_batch_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw failure('candidate_batch_value_invalid');
  if (state.stack.has(value)) throw failure('candidate_batch_cycle');
  state.stack.add(value);
  try {
    let array;
    try { array = Array.isArray(value); } catch {
      throw failure('candidate_batch_value_invalid');
    }
    if (array) {
      return Object.freeze(denseArray(
        value, 'candidate_batch_array_invalid', LIMITS.arrayItems,
      ).map((entry) => captureJson(entry, state, depth + 1)));
    }
    const values = dataValues(value, null, 'candidate_batch_record_invalid');
    const output = Object.create(null);
    for (const key of Object.keys(values).sort(compareUtf8)) {
      Object.defineProperty(output, key, {
        value: captureJson(values[key], state, depth + 1),
        enumerable: true, writable: false, configurable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    state.stack.delete(value);
  }
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

function timestamp(value, code) {
  scalarString(value, null, code, 40);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) throw failure(code);
  return canonical;
}

function authorityFalse(value) {
  const data = exactRecord(value, AUTHORITY_FIELDS, 'candidate_disposition_authority_invalid');
  if (AUTHORITY_FIELDS.some((field) => data[field] !== false)) {
    throw failure('candidate_disposition_authority_invalid');
  }
}

function authorityRecord() {
  return Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, false])));
}

function producerIdentity(value) {
  const fields = ['moduleId', 'moduleVersion', 'qualificationMetadataHash'];
  const data = exactRecord(value, fields, 'candidate_expected_producer_invalid');
  return Object.freeze({
    moduleId: scalarString(data.moduleId, MODULE_ID, 'candidate_producer_module_invalid'),
    moduleVersion: scalarString(data.moduleVersion, TOKEN, 'candidate_producer_version_invalid'),
    qualificationMetadataHash: scalarString(
      data.qualificationMetadataHash, HASH, 'candidate_producer_qualification_invalid', 72,
    ),
  });
}

function producerKey(value) {
  return `${value.moduleId}\0${value.moduleVersion}`;
}

function validateCandidateBinding(candidate, subject, owner) {
  const data = dataValues(candidate, null, 'candidate_batch_candidate_invalid');
  const fields = [
    'candidateId', 'candidatePayloadHash', 'planningRequestId',
    'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
  ];
  if (fields.some((field) => !Object.hasOwn(data, field))) {
    throw failure('candidate_batch_candidate_invalid');
  }
  scalarString(data.candidateId, IDENTIFIER, 'candidate_batch_candidate_id_invalid');
  scalarString(data.candidatePayloadHash, HASH, 'candidate_batch_candidate_hash_invalid', 72);
  if (data.planningRequestId !== subject.planningRequestId
    || data.stateSnapshotHash !== subject.stateSnapshotHash
    || data.capabilityId !== subject.capabilityId
    || data.moduleId !== owner.moduleId
    || data.moduleVersion !== owner.moduleVersion) {
    throw failure('candidate_batch_candidate_subject_mismatch');
  }
}

function candidateOrder(left, right) {
  const identityOrder = compareUtf8(
    `${left.candidateId}\0${left.candidatePayloadHash}`,
    `${right.candidateId}\0${right.candidatePayloadHash}`,
  );
  return identityOrder || compareUtf8(canonicalStringify(left), canonicalStringify(right));
}

function captureCandidateBatch(raw, subject, owner, state, maximumCandidates) {
  const candidates = denseArray(raw, 'candidate_batch_candidates_invalid', maximumCandidates)
    .map((candidate) => captureJson(candidate, state));
  for (const candidate of candidates) validateCandidateBinding(candidate, subject, owner);
  candidates.sort(candidateOrder);
  return Object.freeze(candidates);
}

function preflightJsonDepth(source) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > LIMITS.depth) throw failure('candidate_batch_structure_limit');
    } else if (character === '}' || character === ']') {
      depth -= 1;
      if (depth < 0) throw failure('candidate_batch_json_invalid');
    }
  }
  if (inString || depth !== 0) throw failure('candidate_batch_json_invalid');
}

export function sealCandidateBatchJsonV1(input) {
  const fields = [
    'inputBoundary', 'planningRequestId', 'stateSnapshotHash', 'capabilityId',
    'moduleId', 'moduleVersion', 'candidates', 'maximumCandidates',
    'maximumBatchBytes', 'maximumNodes',
  ];
  const data = exactRecord(input, fields, 'candidate_batch_seal_request_invalid');
  if (data.inputBoundary !== CANDIDATE_DISPOSITION_INPUT_BOUNDARY) {
    throw failure('candidate_batch_seal_request_invalid');
  }
  const subject = Object.freeze({
    planningRequestId: scalarString(data.planningRequestId, IDENTIFIER, 'candidate_batch_request_invalid'),
    stateSnapshotHash: scalarString(data.stateSnapshotHash, HASH, 'candidate_batch_snapshot_invalid', 72),
    capabilityId: scalarString(data.capabilityId, CAPABILITY_ID, 'candidate_batch_capability_invalid'),
  });
  const owner = Object.freeze({
    moduleId: scalarString(data.moduleId, MODULE_ID, 'candidate_batch_module_invalid'),
    moduleVersion: scalarString(data.moduleVersion, TOKEN, 'candidate_batch_version_invalid'),
  });
  const maximumCandidates = boundedInteger(
    data.maximumCandidates, 0, LIMITS.candidates, 'candidate_batch_candidate_limit_invalid',
  );
  const maximumBatchBytes = boundedInteger(
    data.maximumBatchBytes, 2, LIMITS.batchBytes, 'candidate_batch_byte_limit_invalid',
  );
  const maximumNodes = boundedInteger(
    data.maximumNodes, 1, LIMITS.nodes, 'candidate_batch_node_limit_invalid',
  );
  const candidates = captureCandidateBatch(
    data.candidates, subject, owner, { nodes: 0, maximumNodes, stack: new Set() }, maximumCandidates,
  );
  const candidateBatchJson = canonicalStringify(candidates);
  if (Buffer.byteLength(candidateBatchJson, 'utf8') > maximumBatchBytes) {
    throw failure('candidate_batch_byte_limit');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'SealedCandidateBatchJsonV1',
    candidateCount: candidates.length,
    candidateBatchJson,
    candidateBatchByteHash: byteHash(candidateBatchJson),
    candidates,
    authority: authorityRecord(),
  });
}

function captureDisposition(value, request) {
  const fields = [
    'schemaVersion', 'kind', 'moduleId', 'moduleVersion',
    'qualificationMetadataHash', 'planningRequestId', 'planningRequestHash',
    'stateSnapshotHash', 'capabilityId', 'status', 'completedAt',
    'candidateCount', 'candidateBatchJson', 'candidateBatchByteHash',
    'emptyReason', 'failureCode', 'externalActionPerformed', 'authority',
  ];
  const data = exactRecord(value, fields, 'candidate_disposition_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'ModuleCandidateDispositionV1') {
    throw failure('candidate_disposition_invalid');
  }
  const normalized = {
    moduleId: scalarString(data.moduleId, MODULE_ID, 'candidate_disposition_module_invalid'),
    moduleVersion: scalarString(data.moduleVersion, TOKEN, 'candidate_disposition_version_invalid'),
    qualificationMetadataHash: scalarString(
      data.qualificationMetadataHash, HASH, 'candidate_disposition_qualification_invalid', 72,
    ),
    status: scalarString(data.status, TOKEN, 'candidate_disposition_status_invalid'),
    completedAt: timestamp(data.completedAt, 'candidate_disposition_completed_at_invalid'),
    candidateCount: data.candidateCount,
    candidateBatchJson: data.candidateBatchJson,
    candidateBatchByteHash: data.candidateBatchByteHash,
    emptyReason: data.emptyReason,
    failureCode: data.failureCode,
  };
  if (data.planningRequestId !== request.planningRequestId
    || data.planningRequestHash !== request.planningRequestHash
    || data.stateSnapshotHash !== request.stateSnapshotHash
    || data.capabilityId !== request.capabilityId) {
    throw failure('candidate_disposition_subject_mismatch');
  }
  if (Date.parse(normalized.completedAt) > Date.parse(request.observedAt)) {
    throw failure('candidate_disposition_completed_in_future');
  }
  if (data.externalActionPerformed !== false) {
    throw failure('candidate_disposition_external_action_invalid');
  }
  authorityFalse(data.authority);
  if (normalized.status === COMPLETE) {
    boundedInteger(normalized.candidateCount, 0, request.maximumCandidates,
      'candidate_disposition_count_invalid');
    scalarString(normalized.candidateBatchJson, null,
      'candidate_disposition_batch_json_invalid', request.maximumBatchBytes);
    scalarString(normalized.candidateBatchByteHash, HASH,
      'candidate_disposition_batch_hash_invalid', 72);
    if (normalized.failureCode !== null) throw failure('candidate_disposition_failure_shape_invalid');
    if (normalized.candidateCount === 0) {
      scalarString(normalized.emptyReason, IDENTIFIER, 'candidate_disposition_empty_reason_invalid');
    } else if (normalized.emptyReason !== null) {
      throw failure('candidate_disposition_empty_reason_invalid');
    }
  } else {
    if (!FAILURE_STATUSES.has(normalized.status)) {
      throw failure('candidate_disposition_status_invalid');
    }
    if (normalized.candidateCount !== null || normalized.candidateBatchJson !== null
      || normalized.candidateBatchByteHash !== null || normalized.emptyReason !== null) {
      throw failure('candidate_disposition_failure_shape_invalid');
    }
    scalarString(normalized.failureCode, TOKEN, 'candidate_disposition_failure_code_invalid');
  }
  return Object.freeze(normalized);
}

function collectionBodyBase(request, expected, supplied) {
  return {
    schemaVersion: 1,
    kind: 'CandidateDispositionCollectionV1',
    planningRequestId: request.planningRequestId,
    planningRequestHash: request.planningRequestHash,
    stateSnapshotHash: request.stateSnapshotHash,
    capabilityId: request.capabilityId,
    moduleQualificationMetadataSetHash: request.moduleQualificationMetadataSetHash,
    observedAt: request.observedAt,
    expectedProducerCount: expected.length,
    receivedProducerCount: supplied.size,
    externalCurrentnessGateRequired: true,
    executionEligible: false,
    authority: authorityRecord(),
  };
}

export function collectCandidateDispositionBytesV1(input) {
  const fields = [
    'schemaVersion', 'kind', 'inputBoundary', 'planningRequestId',
    'planningRequestHash', 'stateSnapshotHash', 'capabilityId',
    'moduleQualificationMetadataSetHash', 'observedAt', 'deadline',
    'expectedProducers', 'dispositions', 'maximumProducers',
    'maximumCandidates', 'maximumBatchBytes', 'maximumTotalBytes', 'maximumNodes',
  ];
  const data = exactRecord(input, fields, 'candidate_disposition_request_invalid');
  if (data.schemaVersion !== 1
    || data.kind !== 'CandidateDispositionCollectionRequestV1'
    || data.inputBoundary !== CANDIDATE_DISPOSITION_INPUT_BOUNDARY) {
    throw failure('candidate_disposition_request_invalid');
  }
  const request = Object.freeze({
    planningRequestId: scalarString(data.planningRequestId, IDENTIFIER,
      'candidate_disposition_request_id_invalid'),
    planningRequestHash: scalarString(data.planningRequestHash, HASH,
      'candidate_disposition_request_hash_invalid', 72),
    stateSnapshotHash: scalarString(data.stateSnapshotHash, HASH,
      'candidate_disposition_snapshot_invalid', 72),
    capabilityId: scalarString(data.capabilityId, CAPABILITY_ID,
      'candidate_disposition_capability_invalid'),
    moduleQualificationMetadataSetHash: scalarString(
      data.moduleQualificationMetadataSetHash, HASH,
      'candidate_disposition_metadata_set_invalid', 72,
    ),
    observedAt: timestamp(data.observedAt, 'candidate_disposition_observed_at_invalid'),
    deadline: timestamp(data.deadline, 'candidate_disposition_deadline_invalid'),
    maximumProducers: boundedInteger(data.maximumProducers, 1, LIMITS.producers,
      'candidate_disposition_producer_limit_invalid'),
    maximumCandidates: boundedInteger(data.maximumCandidates, 0, LIMITS.candidates,
      'candidate_disposition_candidate_limit_invalid'),
    maximumBatchBytes: boundedInteger(data.maximumBatchBytes, 2, LIMITS.batchBytes,
      'candidate_disposition_batch_byte_limit_invalid'),
    maximumTotalBytes: boundedInteger(data.maximumTotalBytes, 2, LIMITS.totalBytes,
      'candidate_disposition_total_byte_limit_invalid'),
    maximumNodes: boundedInteger(data.maximumNodes, 1, LIMITS.nodes,
      'candidate_disposition_node_limit_invalid'),
  });
  if (request.maximumBatchBytes > request.maximumTotalBytes
    || Date.parse(request.observedAt) > Date.parse(request.deadline)) {
    throw failure('candidate_disposition_request_invalid');
  }

  const expected = denseArray(data.expectedProducers,
    'candidate_expected_producers_invalid', request.maximumProducers)
    .map(producerIdentity)
    .sort((left, right) => compareUtf8(producerKey(left), producerKey(right)));
  const expectedMap = new Map();
  for (const item of expected) {
    const key = producerKey(item);
    if (expectedMap.has(key)) throw failure('candidate_expected_producer_duplicate');
    expectedMap.set(key, item);
  }

  const supplied = new Map();
  let declaredCompleteBytes = 0;
  let declaredCompleteCandidates = 0;
  for (const raw of denseArray(data.dispositions,
    'candidate_dispositions_invalid', request.maximumProducers)) {
    const item = captureDisposition(raw, request);
    const key = producerKey(item);
    if (supplied.has(key)) throw failure('candidate_disposition_duplicate');
    const expectedItem = expectedMap.get(key);
    if (!expectedItem
      || expectedItem.qualificationMetadataHash !== item.qualificationMetadataHash) {
      throw failure('candidate_disposition_unexpected_producer');
    }
    if (item.status === COMPLETE) {
      declaredCompleteBytes += Buffer.byteLength(item.candidateBatchJson, 'utf8');
      declaredCompleteCandidates += item.candidateCount;
      if (declaredCompleteBytes > request.maximumTotalBytes) {
        throw failure('candidate_disposition_byte_limit');
      }
      if (declaredCompleteCandidates > request.maximumCandidates) {
        throw failure('candidate_disposition_candidate_limit');
      }
    }
    supplied.set(key, item);
  }

  const incompleteSummaries = [];
  const incompleteReasons = [];
  for (const expectedItem of expected) {
    const item = supplied.get(producerKey(expectedItem));
    if (!item) {
      incompleteSummaries.push(Object.freeze({
        ...expectedItem,
        status: 'candidate_batch_missing',
        completedAt: null,
        candidateCount: null,
        candidateBatchByteHash: null,
        candidateBytesValidated: false,
        failureCode: 'producer_missing',
      }));
      incompleteReasons.push(`${expectedItem.moduleId}@${expectedItem.moduleVersion}:producer_missing`);
      continue;
    }
    incompleteSummaries.push(Object.freeze({
      moduleId: item.moduleId,
      moduleVersion: item.moduleVersion,
      qualificationMetadataHash: item.qualificationMetadataHash,
      status: item.status,
      completedAt: item.completedAt,
      candidateCount: item.candidateCount,
      candidateBatchByteHash: item.candidateBatchByteHash,
      candidateBytesValidated: false,
      failureCode: item.failureCode,
    }));
    if (item.status !== COMPLETE) {
      incompleteReasons.push(`${item.moduleId}@${item.moduleVersion}:${item.failureCode}`);
    }
  }

  if (incompleteReasons.length > 0) {
    const body = Object.freeze({
      ...collectionBodyBase(request, expected, supplied),
      status: 'candidate_dispositions_incomplete',
      producerDispositions: Object.freeze(incompleteSummaries),
      incompleteReasons: Object.freeze(incompleteReasons.sort(compareUtf8)),
      candidates: null,
      candidateSetInputHash: null,
      candidateBatchSetHash: null,
      readyForRouting: false,
    });
    return Object.freeze({
      ...body,
      candidateDispositionCollectionHash: recordHash('CandidateDispositionCollectionV1', body),
    });
  }

  let totalBytes = 0;
  let totalCandidates = 0;
  const candidates = [];
  const completeSummaries = [];
  const state = { nodes: 0, maximumNodes: request.maximumNodes, stack: new Set() };
  for (const expectedItem of expected) {
    const item = supplied.get(producerKey(expectedItem));
    const bytes = Buffer.byteLength(item.candidateBatchJson, 'utf8');
    totalBytes += bytes;
    if (bytes > request.maximumBatchBytes || totalBytes > request.maximumTotalBytes) {
      throw failure('candidate_disposition_byte_limit');
    }
    if (byteHash(item.candidateBatchJson) !== item.candidateBatchByteHash) {
      throw failure('candidate_disposition_batch_hash_mismatch');
    }
    preflightJsonDepth(item.candidateBatchJson);
    let parsed;
    try { parsed = JSON.parse(item.candidateBatchJson); } catch {
      throw failure('candidate_disposition_batch_json_invalid');
    }
    const captured = captureCandidateBatch(
      parsed, request, expectedItem, state, request.maximumCandidates,
    );
    const canonical = canonicalStringify(captured);
    if (canonical !== item.candidateBatchJson
      || byteHash(canonical) !== item.candidateBatchByteHash
      || captured.length !== item.candidateCount) {
      throw failure('candidate_disposition_batch_canonical_mismatch');
    }
    totalCandidates += captured.length;
    if (totalCandidates > request.maximumCandidates) {
      throw failure('candidate_disposition_candidate_limit');
    }
    candidates.push(...captured);
    completeSummaries.push(Object.freeze({
      moduleId: expectedItem.moduleId,
      moduleVersion: expectedItem.moduleVersion,
      qualificationMetadataHash: expectedItem.qualificationMetadataHash,
      status: COMPLETE,
      completedAt: item.completedAt,
      candidateCount: captured.length,
      candidateBatchByteHash: item.candidateBatchByteHash,
      candidateBytesValidated: true,
      failureCode: null,
    }));
  }

  candidates.sort(candidateOrder);
  const immutableCandidates = Object.freeze(candidates);
  const candidateBatchSetHash = recordHash('CandidateBatchSummarySetV1',
    completeSummaries.map((item) => ({
      moduleId: item.moduleId,
      moduleVersion: item.moduleVersion,
      qualificationMetadataHash: item.qualificationMetadataHash,
      candidateCount: item.candidateCount,
      candidateBatchByteHash: item.candidateBatchByteHash,
    })));
  const body = Object.freeze({
    ...collectionBodyBase(request, expected, supplied),
    status: 'candidate_dispositions_complete',
    producerDispositions: Object.freeze(completeSummaries),
    incompleteReasons: Object.freeze([]),
    candidates: immutableCandidates,
    candidateSetInputHash: recordHash('CandidateDispositionCandidateSetV1', immutableCandidates),
    candidateBatchSetHash,
    readyForRouting: true,
  });
  return Object.freeze({
    ...body,
    candidateDispositionCollectionHash: recordHash('CandidateDispositionCollectionV1', body),
  });
}
