import { canonicalHashRecord, compareUtf8 } from './candidate-router-canonical.mjs';
import {
  boundedInteger, denseArray, failure, hash, plainRecord, stringSet, text, timestamp,
} from './candidate-router-primitives.mjs';

const QUALIFICATION_STATES = new Set([
  'source_qualified', 'target_host_qualified', 'external_authority_qualified',
]);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'planningRequestId', 'stateSnapshotHash',
  'capabilityId', 'hardConstraintSetHash', 'objectiveVersion',
  'resourcePriceSnapshotHash', 'candidateLimit', 'candidateBytesLimit',
  'expiresAt', 'allowedSideEffectClasses',
]);
const MODULE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'moduleId', 'moduleVersion', 'protocolVersion',
  'capabilityIds', 'sourceIdentityHash', 'configurationHash',
  'qualificationSubjectHash', 'qualificationStatus', 'expiresAt',
]);

export function normalizePlanningRequest(value, bounds, observedAt) {
  const request = plainRecord(value, REQUEST_FIELDS, REQUEST_FIELDS, 'planning_request_invalid');
  if (request.schemaVersion !== 1 || request.kind !== 'PlanningRequestV1') {
    throw failure('planning_request_identity_invalid');
  }
  const normalized = Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: text(request.planningRequestId, bounds.maximumStringBytes, 'planning_request_id_invalid'),
    stateSnapshotHash: hash(request.stateSnapshotHash, 'planning_request_snapshot_invalid'),
    capabilityId: text(request.capabilityId, bounds.maximumStringBytes, 'planning_request_capability_invalid'),
    hardConstraintSetHash: hash(request.hardConstraintSetHash, 'planning_request_constraints_invalid'),
    objectiveVersion: text(request.objectiveVersion, bounds.maximumStringBytes, 'planning_request_objective_invalid'),
    resourcePriceSnapshotHash: hash(request.resourcePriceSnapshotHash, 'planning_request_resource_price_invalid'),
    candidateLimit: boundedInteger(request.candidateLimit, 1, bounds.maximumCandidateLimit,
      'planning_request_candidate_limit_invalid'),
    candidateBytesLimit: boundedInteger(request.candidateBytesLimit, 1, bounds.maximumCandidateBytes,
      'planning_request_candidate_bytes_invalid'),
    expiresAt: timestamp(request.expiresAt, 'planning_request_expiry_invalid').value,
    allowedSideEffectClasses: stringSet(request.allowedSideEffectClasses, 32, bounds,
      'planning_request_side_effect_classes_invalid', { allowEmpty: false }),
  });
  if (timestamp(normalized.expiresAt, 'planning_request_expiry_invalid').epoch <= observedAt.epoch) {
    throw failure('planning_request_expired');
  }
  return normalized;
}

export function normalizeModuleBindings(value, bounds, request, observedAt) {
  const capturedRows = denseArray(value, bounds.maximumModules, 'candidate_module_bindings_invalid');
  if (capturedRows.length === 0) throw failure('candidate_module_bindings_empty');
  const byIdentity = new Map();
  const normalized = [];
  for (const raw of capturedRows) {
    const item = plainRecord(raw, MODULE_FIELDS, MODULE_FIELDS, 'candidate_module_binding_invalid');
    if (item.schemaVersion !== 1 || item.kind !== 'QualifiedCandidateModuleV1'
      || item.protocolVersion !== 1 || !QUALIFICATION_STATES.has(item.qualificationStatus)) {
      throw failure('candidate_module_binding_identity_invalid');
    }
    const expiresAt = timestamp(item.expiresAt, 'candidate_module_binding_expiry_invalid');
    if (expiresAt.epoch <= observedAt.epoch || expiresAt.epoch > timestamp(request.expiresAt,
      'planning_request_expiry_invalid').epoch) throw failure('candidate_module_binding_not_current');
    const binding = Object.freeze({
      schemaVersion: 1,
      kind: 'QualifiedCandidateModuleV1',
      moduleId: text(item.moduleId, bounds.maximumStringBytes, 'candidate_module_id_invalid'),
      moduleVersion: text(item.moduleVersion, bounds.maximumStringBytes, 'candidate_module_version_invalid'),
      protocolVersion: 1,
      capabilityIds: stringSet(item.capabilityIds, 128, bounds, 'candidate_module_capabilities_invalid',
        { allowEmpty: false }),
      sourceIdentityHash: hash(item.sourceIdentityHash, 'candidate_module_source_identity_invalid'),
      configurationHash: hash(item.configurationHash, 'candidate_module_configuration_invalid'),
      qualificationSubjectHash: hash(item.qualificationSubjectHash,
        'candidate_module_qualification_subject_invalid'),
      qualificationStatus: item.qualificationStatus,
      expiresAt: expiresAt.value,
    });
    const key = `${binding.moduleId}\0${binding.moduleVersion}`;
    if (byIdentity.has(key)) throw failure('candidate_module_binding_duplicate');
    byIdentity.set(key, binding);
    normalized.push(binding);
  }
  normalized.sort((left, right) => compareUtf8(left.moduleId, right.moduleId)
    || compareUtf8(left.moduleVersion, right.moduleVersion));
  return Object.freeze({
    rows: Object.freeze(normalized),
    byIdentity,
    hash: canonicalHashRecord('QualifiedCandidateModuleSetV1', normalized),
  });
}
