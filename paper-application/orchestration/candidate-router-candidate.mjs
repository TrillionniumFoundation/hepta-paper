import { canonicalHashRecord, canonicalStringify } from './candidate-router-canonical.mjs';
import {
  boundedInteger, boundedNumber, failure, plainRecord, stringSet, text, timestamp,
} from './candidate-router-primitives.mjs';
import { captureData, normalizeBounds, structuredObject } from './candidate-router-structured.mjs';

const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId',
  'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
  'resourceVector', 'duration', 'cost', 'value', 'risk', 'preconditions',
  'dependencyEffects', 'sideEffectClass', 'irreversibleBoundary',
  'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
  'candidatePayloadHash', 'singletonReason',
]);
const CANDIDATE_REQUIRED = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId',
  'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
  'resourceVector', 'duration', 'cost', 'value', 'risk',
  'sideEffectClass', 'rollbackClass', 'expiresAt', 'candidatePayloadHash',
]);
const RESOURCE_FIELDS = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes', 'tokenCount',
  'maximumCostMicrousd',
]);
const RESOURCE_REQUIRED = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
]);

function normalizeResourceVector(value) {
  const raw = plainRecord(value, RESOURCE_FIELDS, RESOURCE_REQUIRED, 'candidate_resource_vector_invalid');
  return Object.freeze({
    cpuUnits: boundedNumber(raw.cpuUnits, Number.MAX_SAFE_INTEGER, 'candidate_resource_cpu_invalid'),
    gpuUnits: boundedNumber(raw.gpuUnits, Number.MAX_SAFE_INTEGER, 'candidate_resource_gpu_invalid'),
    memoryMiB: boundedInteger(raw.memoryMiB, 0, Number.MAX_SAFE_INTEGER,
      'candidate_resource_memory_invalid'),
    storageBytes: boundedInteger(raw.storageBytes, 0, Number.MAX_SAFE_INTEGER,
      'candidate_resource_storage_invalid'),
    ...(Object.hasOwn(raw, 'tokenCount') ? { tokenCount: boundedInteger(raw.tokenCount, 0,
      Number.MAX_SAFE_INTEGER, 'candidate_resource_token_invalid') } : {}),
    ...(Object.hasOwn(raw, 'maximumCostMicrousd') ? { maximumCostMicrousd: boundedInteger(
      raw.maximumCostMicrousd, 0, Number.MAX_SAFE_INTEGER, 'candidate_resource_cost_invalid') } : {}),
  });
}

function nullableText(value, bounds, code) {
  return text(value, bounds.maximumStringBytes, code, { nullable: true });
}

export function normalizeCandidate(value, bounds, request, modules, observedAt) {
  const raw = plainRecord(value, CANDIDATE_FIELDS, CANDIDATE_REQUIRED, 'action_candidate_invalid');
  if (raw.schemaVersion !== 1 || raw.kind !== 'ActionCandidateV1') {
    throw failure('action_candidate_identity_invalid');
  }
  const candidateId = text(raw.candidateId, bounds.maximumStringBytes, 'action_candidate_id_invalid');
  const moduleId = text(raw.moduleId, bounds.maximumStringBytes, 'action_candidate_module_invalid');
  const moduleVersion = text(raw.moduleVersion, bounds.maximumStringBytes,
    'action_candidate_module_version_invalid');
  const capabilityId = text(raw.capabilityId, bounds.maximumStringBytes,
    'action_candidate_capability_invalid');
  if (raw.planningRequestId !== request.planningRequestId) throw failure('action_candidate_request_mismatch');
  if (raw.stateSnapshotHash !== request.stateSnapshotHash) throw failure('action_candidate_snapshot_mismatch');
  if (capabilityId !== request.capabilityId) throw failure('action_candidate_capability_mismatch');
  const module = modules.byIdentity.get(`${moduleId}\0${moduleVersion}`);
  if (!module) throw failure('action_candidate_module_not_bound');
  if (!module.capabilityIds.includes(capabilityId)) throw failure('action_candidate_module_capability_mismatch');
  const expiry = timestamp(raw.expiresAt, 'action_candidate_expiry_invalid');
  if (expiry.epoch <= observedAt.epoch
    || expiry.epoch > timestamp(request.expiresAt, 'planning_request_expiry_invalid').epoch
    || expiry.epoch > timestamp(module.expiresAt, 'candidate_module_binding_expiry_invalid').epoch) {
    throw failure('action_candidate_not_current');
  }
  const sideEffectClass = text(raw.sideEffectClass, bounds.maximumStringBytes,
    'action_candidate_side_effect_invalid');
  if (!request.allowedSideEffectClasses.includes(sideEffectClass)) {
    throw failure('action_candidate_side_effect_not_allowed');
  }
  const semantic = Object.freeze({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    planningRequestId: request.planningRequestId,
    stateSnapshotHash: request.stateSnapshotHash,
    moduleId,
    moduleVersion,
    capabilityId,
    resourceVector: normalizeResourceVector(raw.resourceVector),
    duration: structuredObject(raw.duration, bounds, 'action_candidate_duration_invalid'),
    cost: structuredObject(raw.cost, bounds, 'action_candidate_cost_invalid'),
    value: structuredObject(raw.value, bounds, 'action_candidate_value_invalid'),
    risk: structuredObject(raw.risk, bounds, 'action_candidate_risk_invalid'),
    ...(Object.hasOwn(raw, 'preconditions') ? { preconditions: stringSet(raw.preconditions,
      bounds.maximumCollectionItems, bounds, 'action_candidate_preconditions_invalid') } : {}),
    ...(Object.hasOwn(raw, 'dependencyEffects') ? { dependencyEffects: stringSet(raw.dependencyEffects,
      bounds.maximumCollectionItems, bounds, 'action_candidate_dependency_effects_invalid') } : {}),
    sideEffectClass,
    ...(Object.hasOwn(raw, 'irreversibleBoundary') ? { irreversibleBoundary: nullableText(
      raw.irreversibleBoundary, bounds, 'action_candidate_irreversible_boundary_invalid') } : {}),
    rollbackClass: text(raw.rollbackClass, bounds.maximumStringBytes,
      'action_candidate_rollback_invalid'),
    expiresAt: expiry.value,
    ...(Object.hasOwn(raw, 'inputSchema') ? { inputSchema: nullableText(raw.inputSchema, bounds,
      'action_candidate_input_schema_invalid') } : {}),
    ...(Object.hasOwn(raw, 'outputSchema') ? { outputSchema: nullableText(raw.outputSchema, bounds,
      'action_candidate_output_schema_invalid') } : {}),
    ...(Object.hasOwn(raw, 'singletonReason') ? { singletonReason: nullableText(raw.singletonReason,
      bounds, 'action_candidate_singleton_reason_invalid') } : {}),
  });
  const expectedHash = canonicalHashRecord('ActionCandidateV1Payload', semantic);
  if (raw.candidatePayloadHash !== expectedHash) throw failure('action_candidate_payload_hash_invalid');
  return Object.freeze({
    candidate: Object.freeze({ candidateId, ...semantic, candidatePayloadHash: expectedHash }),
    semantic,
    semanticBytes: canonicalStringify(semantic),
  });
}

export function actionCandidatePayloadHash(semanticCandidate, bounds = {}) {
  const normalizedBounds = normalizeBounds(bounds);
  const captured = captureData(semanticCandidate, normalizedBounds,
    { ancestors: new WeakSet(), items: 0 });
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw failure('action_candidate_payload_invalid');
  }
  return canonicalHashRecord('ActionCandidateV1Payload', captured);
}
