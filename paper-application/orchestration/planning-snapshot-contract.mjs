import {
  capturePlanningModuleQualificationMetadataSetV1,
} from './candidate-router.mjs';
import {
  SNAPSHOT_LIMITS,
  captureSnapshotJson,
  compareSnapshotUtf8,
  snapshotAuthority,
  snapshotDenseArray,
  snapshotFailure,
  snapshotHash,
  snapshotHashRecord,
  snapshotInteger,
  snapshotRecordValues,
  snapshotText,
  snapshotTimestamp,
} from './planning-snapshot-canonical.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]{0,95}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'snapshotRequestId', 'readTransactionHash',
  'consistencyEpoch', 'moduleRegistryHash', 'policySetHash',
  'resourcePriceSnapshotHash', 'objectiveVersion',
  'moduleQualificationMetadataSetHash', 'issuedAt', 'deadline',
  'maximumComponentBytes', 'maximumTotalComponentBytes', 'requiredComponents',
]);
const REQUIREMENT_FIELDS = Object.freeze([
  'componentId', 'componentKind', 'sourceModuleId', 'sourceModuleVersion',
  'requiredCapabilityId', 'minimumRevision', 'maximumAgeMilliseconds',
  'maximumPayloadBytes',
]);
const COMPONENT_BODY_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'componentId', 'componentKind',
  'sourceModuleId', 'sourceModuleVersion', 'requiredCapabilityId',
  'sourceQualificationMetadataHash', 'readTransactionHash',
  'consistencyEpoch', 'revision', 'sourceGeneration', 'observedAt',
  'validUntil', 'payload',
]);
const COMPONENT_FIELDS = Object.freeze([...COMPONENT_BODY_FIELDS, 'componentHash']);
export const SNAPSHOT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'request', 'snapshotRequestHash',
  'moduleQualificationMetadata', 'moduleQualificationMetadataSetHash',
  'components', 'componentSetHash', 'componentCount', 'observedAt',
  'expiresAt', 'qualificationTrustClass', 'externalCurrentnessGateRequired',
  'consumerMustRevalidateBeforePlanning', 'authority', 'stateSnapshotHash',
]);
export const CURRENT_CONTEXT_FIELDS = Object.freeze([
  'moduleRegistryHash', 'policySetHash', 'resourcePriceSnapshotHash',
  'objectiveVersion', 'moduleQualificationMetadata', 'componentVersions',
]);
const VERSION_FIELDS = Object.freeze([
  'componentId', 'sourceModuleId', 'sourceModuleVersion', 'revision',
  'sourceGeneration',
]);

function hashValue(value, code) {
  return snapshotHash(value, HASH, code);
}

export function normalizeSnapshotRequirement(value) {
  const data = snapshotRecordValues(value, REQUIREMENT_FIELDS,
    'snapshot_requirement_invalid');
  return Object.freeze({
    componentId: snapshotText(data.componentId, IDENTIFIER,
      'snapshot_component_id_invalid', 256),
    componentKind: snapshotText(data.componentKind, IDENTIFIER,
      'snapshot_component_kind_invalid', 256),
    sourceModuleId: snapshotText(data.sourceModuleId, MODULE_ID,
      'snapshot_source_module_invalid', 128),
    sourceModuleVersion: snapshotText(data.sourceModuleVersion, TOKEN,
      'snapshot_source_module_version_invalid', 128),
    requiredCapabilityId: snapshotText(data.requiredCapabilityId, CAPABILITY_ID,
      'snapshot_required_capability_invalid', 128),
    minimumRevision: snapshotInteger(data.minimumRevision, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_minimum_revision_invalid'),
    maximumAgeMilliseconds: snapshotInteger(data.maximumAgeMilliseconds, 0,
      Number.MAX_SAFE_INTEGER, 'snapshot_maximum_age_invalid'),
    maximumPayloadBytes: snapshotInteger(data.maximumPayloadBytes, 1,
      SNAPSHOT_LIMITS.componentBytes, 'snapshot_payload_limit_invalid'),
  });
}

export function normalizeSnapshotRequest(value) {
  const data = snapshotRecordValues(value, REQUEST_FIELDS, 'snapshot_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'PlanningStateSnapshotRequestV1') {
    throw snapshotFailure('snapshot_request_identity_invalid');
  }
  const maximumComponentBytes = snapshotInteger(data.maximumComponentBytes, 256,
    SNAPSHOT_LIMITS.componentBytes, 'snapshot_component_byte_limit_invalid');
  const maximumTotalComponentBytes = snapshotInteger(data.maximumTotalComponentBytes,
    maximumComponentBytes, SNAPSHOT_LIMITS.totalComponentBytes,
    'snapshot_total_byte_limit_invalid');
  const issuedAt = snapshotTimestamp(data.issuedAt, 'snapshot_request_issued_at_invalid');
  const deadline = snapshotTimestamp(data.deadline, 'snapshot_request_deadline_invalid');
  if (Date.parse(issuedAt) > Date.parse(deadline)) {
    throw snapshotFailure('snapshot_request_time_order_invalid');
  }
  const requiredComponents = snapshotDenseArray(data.requiredComponents,
    SNAPSHOT_LIMITS.components, 'snapshot_requirement_count_invalid', 1)
    .map(normalizeSnapshotRequirement)
    .sort((left, right) => compareSnapshotUtf8(left.componentId, right.componentId));
  if (new Set(requiredComponents.map((entry) => entry.componentId)).size
    !== requiredComponents.length) throw snapshotFailure('snapshot_requirement_duplicate');
  if (requiredComponents.some((entry) => entry.maximumPayloadBytes > maximumComponentBytes)) {
    throw snapshotFailure('snapshot_payload_limit_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: snapshotText(data.snapshotRequestId, IDENTIFIER,
      'snapshot_request_id_invalid', 256),
    readTransactionHash: hashValue(data.readTransactionHash, 'snapshot_transaction_invalid'),
    consistencyEpoch: snapshotInteger(data.consistencyEpoch, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_consistency_epoch_invalid'),
    moduleRegistryHash: hashValue(data.moduleRegistryHash, 'snapshot_registry_hash_invalid'),
    policySetHash: hashValue(data.policySetHash, 'snapshot_policy_hash_invalid'),
    resourcePriceSnapshotHash: hashValue(data.resourcePriceSnapshotHash,
      'snapshot_resource_price_hash_invalid'),
    objectiveVersion: snapshotText(data.objectiveVersion, TOKEN,
      'snapshot_objective_version_invalid', 128),
    moduleQualificationMetadataSetHash: hashValue(data.moduleQualificationMetadataSetHash,
      'snapshot_module_metadata_set_hash_invalid'),
    issuedAt,
    deadline,
    maximumComponentBytes,
    maximumTotalComponentBytes,
    requiredComponents: Object.freeze(requiredComponents),
  });
}

export function normalizeSnapshotComponent(value, requireHash, state) {
  const allowed = requireHash ? COMPONENT_FIELDS : COMPONENT_BODY_FIELDS;
  const data = snapshotRecordValues(value, allowed, 'snapshot_component_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'PlanningSnapshotComponentV1') {
    throw snapshotFailure('snapshot_component_identity_invalid');
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentV1',
    componentId: snapshotText(data.componentId, IDENTIFIER,
      'snapshot_component_id_invalid', 256),
    componentKind: snapshotText(data.componentKind, IDENTIFIER,
      'snapshot_component_kind_invalid', 256),
    sourceModuleId: snapshotText(data.sourceModuleId, MODULE_ID,
      'snapshot_source_module_invalid', 128),
    sourceModuleVersion: snapshotText(data.sourceModuleVersion, TOKEN,
      'snapshot_source_module_version_invalid', 128),
    requiredCapabilityId: snapshotText(data.requiredCapabilityId, CAPABILITY_ID,
      'snapshot_required_capability_invalid', 128),
    sourceQualificationMetadataHash: hashValue(data.sourceQualificationMetadataHash,
      'snapshot_source_qualification_metadata_invalid'),
    readTransactionHash: hashValue(data.readTransactionHash, 'snapshot_transaction_invalid'),
    consistencyEpoch: snapshotInteger(data.consistencyEpoch, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_consistency_epoch_invalid'),
    revision: snapshotInteger(data.revision, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_component_revision_invalid'),
    sourceGeneration: snapshotInteger(data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_component_generation_invalid'),
    observedAt: snapshotTimestamp(data.observedAt, 'snapshot_component_observed_at_invalid'),
    validUntil: snapshotTimestamp(data.validUntil, 'snapshot_component_valid_until_invalid'),
    payload: captureSnapshotJson(data.payload, state),
  });
  const componentHash = snapshotHashRecord('PlanningSnapshotComponentV1', body);
  if (requireHash && data.componentHash !== componentHash) {
    throw snapshotFailure('snapshot_component_hash_invalid');
  }
  return Object.freeze({ ...body, componentHash });
}

export function sealPlanningSnapshotComponentV1(value) {
  return normalizeSnapshotComponent(value, false, { nodes: 0, stack: new WeakSet() });
}

export function captureSnapshotMetadata(value) {
  const capture = capturePlanningModuleQualificationMetadataSetV1(value);
  if (capture.moduleQualificationMetadata.length > SNAPSHOT_LIMITS.moduleMetadata) {
    throw snapshotFailure('snapshot_module_metadata_count_invalid');
  }
  return capture;
}

export function validateSnapshotMetadataAt(metadata, observedAt) {
  const now = Date.parse(observedAt);
  for (const entry of metadata) {
    if (Date.parse(entry.qualificationObservedAt) > now
      || now > Date.parse(entry.qualificationExpiresAt)) {
      throw snapshotFailure('snapshot_module_qualification_not_current');
    }
  }
}

export function snapshotMetadataKey(moduleId, moduleVersion) {
  return `${moduleId}\0${moduleVersion}`;
}

export function buildSnapshotBody({ request, moduleQualificationMetadata,
  components, observedAt }) {
  const snapshotRequestHash = snapshotHashRecord('PlanningStateSnapshotRequestV1', request);
  const componentSetHash = snapshotHashRecord('PlanningSnapshotComponentSetV1', components);
  const expiresAt = new Date(Math.min(
    Date.parse(request.deadline),
    ...moduleQualificationMetadata.map((entry) => Date.parse(entry.qualificationExpiresAt)),
    ...components.map((entry) => Date.parse(entry.validUntil)),
  )).toISOString();
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotV1',
    status: 'planning_state_snapshot_ready',
    request,
    snapshotRequestHash,
    moduleQualificationMetadata,
    moduleQualificationMetadataSetHash: request.moduleQualificationMetadataSetHash,
    components,
    componentSetHash,
    componentCount: components.length,
    observedAt,
    expiresAt,
    qualificationTrustClass: 'caller_supplied_unverified',
    externalCurrentnessGateRequired: true,
    consumerMustRevalidateBeforePlanning: true,
    authority: snapshotAuthority(),
  });
}

export function normalizeSnapshotVersion(value) {
  const data = snapshotRecordValues(value, VERSION_FIELDS,
    'snapshot_component_version_invalid');
  return Object.freeze({
    componentId: snapshotText(data.componentId, IDENTIFIER,
      'snapshot_component_id_invalid', 256),
    sourceModuleId: snapshotText(data.sourceModuleId, MODULE_ID,
      'snapshot_source_module_invalid', 128),
    sourceModuleVersion: snapshotText(data.sourceModuleVersion, TOKEN,
      'snapshot_source_module_version_invalid', 128),
    revision: snapshotInteger(data.revision, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_component_revision_invalid'),
    sourceGeneration: snapshotInteger(data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_component_generation_invalid'),
  });
}

export { HASH, TOKEN };
export { compareSnapshotUtf8, snapshotAuthority, snapshotDenseArray,
  snapshotFailure, snapshotHashRecord, snapshotRecordValues, snapshotText,
  snapshotTimestamp, snapshotCanonicalStringify, SNAPSHOT_LIMITS }
  from './planning-snapshot-canonical.mjs';
