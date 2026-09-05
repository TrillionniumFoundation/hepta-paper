import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const DIMENSIONS = Object.freeze(['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd']);
const MAX_CANDIDATES = 256;
const MAX_CAPABILITIES = 1024;
const MAX_BYTES = 8 * 1024 * 1024;

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function plainRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || (allowed && !allowed.includes(key)))) {
    throw failure(code);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}

function token(value, code) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw failure(code);
  return value;
}

function hash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) throw failure(code);
  return value;
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

function stringSet(value, maximum, code) {
  const rows = denseArray(value, maximum, code).map((entry) => token(entry, code));
  rows.sort(compareUtf8);
  if (new Set(rows).size !== rows.length) throw failure(code);
  return Object.freeze(rows);
}

function resourceVector(value, code) {
  const row = plainRecord(value, DIMENSIONS, code);
  if (Object.keys(row).length !== DIMENSIONS.length) throw failure(code);
  const output = Object.create(null);
  for (const dimension of DIMENSIONS) {
    if (!Object.hasOwn(row, dimension)) throw failure(code);
    output[dimension] = safeInteger(row[dimension], 0, Number.MAX_SAFE_INTEGER, code);
  }
  return Object.freeze(output);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf8)) output[key] = canonicalValue(value[key]);
    return output;
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
}

function canonicalHash(kind, value) {
  return `sha256:${createHash('sha256').update(canonicalBytes({ kind, value })).digest('hex')}`;
}

function captureFrontier(value) {
  const row = plainRecord(value, null, 'candidate_model_frontier_invalid');
  if (row.version !== 1 || row.kind !== 'CandidateFrontierV1'
    || row.dominanceReductionApplied !== false || row.externalActionPerformed !== false) {
    throw failure('candidate_model_frontier_invalid');
  }
  const candidates = denseArray(row.candidates, MAX_CANDIDATES,
    'candidate_model_frontier_candidates_invalid').map((value) => {
    const candidate = plainRecord(value, null, 'candidate_model_frontier_candidate_invalid');
    return Object.freeze({
      candidateId: token(candidate.candidateId, 'candidate_model_candidate_id_invalid'),
      candidatePayloadHash: hash(candidate.candidatePayloadHash,
        'candidate_model_candidate_hash_invalid'),
      resourceVector: resourceVector(candidate.resourceVector,
        'candidate_model_candidate_resources_invalid'),
    });
  }).sort((left, right) => compareUtf8(left.candidateId, right.candidateId));
  if (!candidates.length) throw failure('candidate_model_frontier_candidates_invalid');
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw failure('candidate_model_candidate_id_duplicate');
  }
  if (new Set(candidates.map((candidate) => candidate.candidatePayloadHash)).size !== candidates.length) {
    throw failure('candidate_model_candidate_hash_duplicate');
  }
  return Object.freeze({
    planningRequestHash: hash(row.planningRequestHash, 'candidate_model_planning_hash_invalid'),
    stateSnapshotHash: hash(row.stateSnapshotHash, 'candidate_model_snapshot_hash_invalid'),
    candidateSetHash: hash(row.candidateSetHash, 'candidate_model_candidate_set_hash_invalid'),
    candidateFrontierHash: hash(row.candidateFrontierHash, 'candidate_model_frontier_hash_invalid'),
    candidates: Object.freeze(candidates),
  });
}

function captureEntry(value) {
  const row = plainRecord(value, ['candidateId', 'candidatePayloadHash', 'utilityMicrounits',
    'dependencies', 'conflicts', 'decisionGroup', 'providesCapabilities'],
  'candidate_model_entry_invalid');
  if (Object.keys(row).length !== 7) throw failure('candidate_model_entry_invalid');
  return Object.freeze({
    candidateId: token(row.candidateId, 'candidate_model_entry_id_invalid'),
    candidatePayloadHash: hash(row.candidatePayloadHash, 'candidate_model_entry_hash_invalid'),
    utilityMicrounits: safeInteger(row.utilityMicrounits, -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER, 'candidate_model_entry_utility_invalid'),
    dependencies: stringSet(row.dependencies, MAX_CANDIDATES,
      'candidate_model_entry_dependencies_invalid'),
    conflicts: stringSet(row.conflicts, MAX_CANDIDATES,
      'candidate_model_entry_conflicts_invalid'),
    decisionGroup: row.decisionGroup === null ? null
      : token(row.decisionGroup, 'candidate_model_entry_group_invalid'),
    providesCapabilities: stringSet(row.providesCapabilities, MAX_CAPABILITIES,
      'candidate_model_entry_capabilities_invalid'),
  });
}

function captureModelBody(value) {
  const row = plainRecord(value, ['version', 'kind', 'modelSetId', 'planningRequestHash',
    'stateSnapshotHash', 'candidateSetHash', 'objectiveVersion', 'entries',
    'requiredCandidateIds', 'requiredCapabilities', 'resourceLimits', 'maximumExpansions'],
  'candidate_model_set_invalid');
  if (Object.keys(row).length !== 12 || row.version !== 1
    || row.kind !== 'CandidateOptimizationModelSetV1') throw failure('candidate_model_set_invalid');
  const entries = denseArray(row.entries, MAX_CANDIDATES,
    'candidate_model_entries_invalid').map(captureEntry)
    .sort((left, right) => compareUtf8(left.candidateId, right.candidateId));
  if (!entries.length) throw failure('candidate_model_entries_invalid');
  if (new Set(entries.map((entry) => entry.candidateId)).size !== entries.length) {
    throw failure('candidate_model_entry_id_duplicate');
  }
  if (new Set(entries.map((entry) => entry.candidatePayloadHash)).size !== entries.length) {
    throw failure('candidate_model_entry_hash_duplicate');
  }
  return Object.freeze({ version: 1, kind: row.kind,
    modelSetId: token(row.modelSetId, 'candidate_model_set_id_invalid'),
    planningRequestHash: hash(row.planningRequestHash, 'candidate_model_planning_hash_invalid'),
    stateSnapshotHash: hash(row.stateSnapshotHash, 'candidate_model_snapshot_hash_invalid'),
    candidateSetHash: hash(row.candidateSetHash, 'candidate_model_candidate_set_hash_invalid'),
    objectiveVersion: token(row.objectiveVersion, 'candidate_model_objective_version_invalid'),
    entries: Object.freeze(entries),
    requiredCandidateIds: stringSet(row.requiredCandidateIds, MAX_CANDIDATES,
      'candidate_model_required_candidates_invalid'),
    requiredCapabilities: stringSet(row.requiredCapabilities, MAX_CAPABILITIES,
      'candidate_model_required_capabilities_invalid'),
    resourceLimits: resourceVector(row.resourceLimits, 'candidate_model_resource_limits_invalid'),
    maximumExpansions: safeInteger(row.maximumExpansions, 1, 1_000_000,
      'candidate_model_expansion_limit_invalid') });
}

export function candidateOptimizationModelSetHash(value) {
  const body = captureModelBody(value);
  if (canonicalBytes(body).length > MAX_BYTES) throw failure('candidate_model_byte_limit');
  return canonicalHash('CandidateOptimizationModelSetV1', body);
}

export function buildBoundedOptimizationRequest({ candidateFrontier, modelSet }) {
  const frontier = captureFrontier(candidateFrontier);
  const raw = plainRecord(modelSet, ['version', 'kind', 'modelSetId', 'planningRequestHash',
    'stateSnapshotHash', 'candidateSetHash', 'objectiveVersion', 'entries',
    'requiredCandidateIds', 'requiredCapabilities', 'resourceLimits', 'maximumExpansions',
    'modelSetHash'], 'candidate_model_set_invalid');
  if (Object.keys(raw).length !== 13) throw failure('candidate_model_set_invalid');
  const { modelSetHash: observedHash, ...bodyInput } = raw;
  const body = captureModelBody(bodyInput);
  const expectedHash = canonicalHash('CandidateOptimizationModelSetV1', body);
  if (observedHash !== expectedHash) throw failure('candidate_model_set_hash_mismatch');
  if (body.planningRequestHash !== frontier.planningRequestHash
    || body.stateSnapshotHash !== frontier.stateSnapshotHash
    || body.candidateSetHash !== frontier.candidateSetHash) {
    throw failure('candidate_model_frontier_binding_mismatch');
  }
  if (body.entries.length !== frontier.candidates.length) {
    throw failure('candidate_model_coverage_invalid');
  }
  const models = [];
  for (let index = 0; index < frontier.candidates.length; index += 1) {
    const candidate = frontier.candidates[index];
    const entry = body.entries[index];
    if (candidate.candidateId !== entry.candidateId
      || candidate.candidatePayloadHash !== entry.candidatePayloadHash) {
      throw failure('candidate_model_entry_binding_mismatch');
    }
    models.push(Object.freeze({ ...entry, resourceVector: candidate.resourceVector }));
  }
  const optimizationRequest = Object.freeze({ version: 1,
    kind: 'BoundedPlanOptimizationRequestV1', requestId: body.modelSetId,
    planningRequestHash: body.planningRequestHash, stateSnapshotHash: body.stateSnapshotHash,
    candidateSetHash: body.candidateSetHash, objectiveVersion: body.objectiveVersion,
    resourceLimits: body.resourceLimits, requiredCandidateIds: body.requiredCandidateIds,
    requiredCapabilities: body.requiredCapabilities, candidates: Object.freeze(models),
    maximumExpansions: body.maximumExpansions });
  if (canonicalBytes(optimizationRequest).length > MAX_BYTES) throw failure('candidate_model_byte_limit');
  return Object.freeze({ version: 1, kind: 'BoundedOptimizationRequestProjectionV1',
    status: 'projected_nonactivating', candidateFrontierHash: frontier.candidateFrontierHash,
    candidateOptimizationModelSetHash: expectedHash, optimizationRequest,
    optimizationRequestProjectionHash: canonicalHash('BoundedOptimizationRequestProjectionV1', {
      candidateFrontierHash: frontier.candidateFrontierHash,
      candidateOptimizationModelSetHash: expectedHash,
      optimizationRequest,
    }),
    authority: Object.freeze({ productionAuthorized: false, executionAuthorized: false,
      writerAuthorized: false, providerAuthorized: false, externalAuthorityClaimed: false }),
    externalActionPerformed: false });
}
