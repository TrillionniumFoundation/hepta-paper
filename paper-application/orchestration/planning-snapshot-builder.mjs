import {
  CURRENT_CONTEXT_FIELDS,
  HASH,
  SNAPSHOT_FIELDS,
  SNAPSHOT_LIMITS,
  TOKEN,
  buildSnapshotBody,
  captureSnapshotMetadata,
  compareSnapshotUtf8,
  normalizeSnapshotComponent,
  normalizeSnapshotRequest,
  normalizeSnapshotVersion,
  sealPlanningSnapshotComponentV1,
  snapshotAuthority,
  snapshotCanonicalStringify,
  snapshotDenseArray,
  snapshotFailure,
  snapshotHashRecord,
  snapshotMetadataKey,
  snapshotRecordValues,
  snapshotText,
  snapshotTimestamp,
  validateSnapshotMetadataAt,
} from './planning-snapshot-contract.mjs';
import { CANDIDATE_ROUTER_INPUT_BOUNDARY } from './candidate-router.mjs';

export const SNAPSHOT_BUILDER_INPUT_BOUNDARY = CANDIDATE_ROUTER_INPUT_BOUNDARY;
export { sealPlanningSnapshotComponentV1 };

function hashValue(value, code) {
  return snapshotText(value, HASH, code, 71);
}

export function buildPlanningStateSnapshotV1(value) {
  const input = snapshotRecordValues(value,
    ['inputBoundary', 'request', 'moduleQualificationMetadata', 'components', 'observedAt'],
    'snapshot_builder_input_invalid');
  if (input.inputBoundary !== SNAPSHOT_BUILDER_INPUT_BOUNDARY) {
    throw snapshotFailure('snapshot_input_boundary_invalid');
  }
  const request = normalizeSnapshotRequest(input.request);
  const observedAt = snapshotTimestamp(input.observedAt, 'snapshot_observed_at_invalid');
  const observed = Date.parse(observedAt);
  if (observed < Date.parse(request.issuedAt) || observed > Date.parse(request.deadline)) {
    throw snapshotFailure('snapshot_observation_time_invalid');
  }
  const metadataCapture = captureSnapshotMetadata(input.moduleQualificationMetadata);
  if (metadataCapture.moduleQualificationMetadataSetHash
    !== request.moduleQualificationMetadataSetHash) {
    throw snapshotFailure('snapshot_module_metadata_set_mismatch');
  }
  const moduleQualificationMetadata = metadataCapture.moduleQualificationMetadata;
  validateSnapshotMetadataAt(moduleQualificationMetadata, observedAt);
  const metadataByKey = new Map(moduleQualificationMetadata.map((entry) => [
    snapshotMetadataKey(entry.moduleId, entry.moduleVersion), entry,
  ]));

  const rawComponents = snapshotDenseArray(input.components, SNAPSHOT_LIMITS.components,
    'snapshot_component_count_invalid');
  if (rawComponents.length !== request.requiredComponents.length) {
    throw snapshotFailure('snapshot_component_coverage_invalid');
  }
  const captureState = { nodes: 0, stack: new WeakSet() };
  const components = [];
  const byId = new Set();
  const usedMetadata = new Set();
  let totalBytes = 0;
  const requirements = new Map(request.requiredComponents.map((entry) => [
    entry.componentId, entry,
  ]));
  for (const raw of rawComponents) {
    const component = normalizeSnapshotComponent(raw, true, captureState);
    if (byId.has(component.componentId)) throw snapshotFailure('snapshot_component_duplicate');
    byId.add(component.componentId);
    const requirement = requirements.get(component.componentId);
    if (!requirement || requirement.componentKind !== component.componentKind
      || requirement.sourceModuleId !== component.sourceModuleId
      || requirement.sourceModuleVersion !== component.sourceModuleVersion
      || requirement.requiredCapabilityId !== component.requiredCapabilityId) {
      throw snapshotFailure('snapshot_component_requirement_mismatch');
    }
    if (component.readTransactionHash !== request.readTransactionHash
      || component.consistencyEpoch !== request.consistencyEpoch) {
      throw snapshotFailure('snapshot_component_transaction_mismatch');
    }
    if (component.revision < requirement.minimumRevision) {
      throw snapshotFailure('snapshot_component_revision_too_old');
    }
    const captured = Date.parse(component.observedAt);
    const validUntil = Date.parse(component.validUntil);
    if (captured > observed) throw snapshotFailure('snapshot_component_from_future');
    if (observed - captured > requirement.maximumAgeMilliseconds) {
      throw snapshotFailure('snapshot_component_stale');
    }
    if (validUntil < observed || validUntil < captured) {
      throw snapshotFailure('snapshot_component_expired');
    }
    const metadata = metadataByKey.get(snapshotMetadataKey(
      component.sourceModuleId, component.sourceModuleVersion,
    ));
    if (!metadata || metadata.qualificationMetadataHash
      !== component.sourceQualificationMetadataHash
      || !metadata.capabilityIds.includes(component.requiredCapabilityId)) {
      throw snapshotFailure('snapshot_component_module_metadata_mismatch');
    }
    usedMetadata.add(snapshotMetadataKey(metadata.moduleId, metadata.moduleVersion));
    const payloadBytes = Buffer.byteLength(snapshotCanonicalStringify(component.payload), 'utf8');
    const componentBytes = Buffer.byteLength(snapshotCanonicalStringify(component), 'utf8');
    if (payloadBytes > requirement.maximumPayloadBytes
      || componentBytes > request.maximumComponentBytes) {
      throw snapshotFailure('snapshot_component_byte_limit');
    }
    totalBytes += componentBytes;
    if (totalBytes > request.maximumTotalComponentBytes) {
      throw snapshotFailure('snapshot_total_byte_limit');
    }
    components.push(component);
  }
  if (usedMetadata.size !== moduleQualificationMetadata.length) {
    throw snapshotFailure('snapshot_unused_module_metadata');
  }
  components.sort((left, right) => compareSnapshotUtf8(left.componentId, right.componentId));
  if (components.some((entry, index) => entry.componentId
    !== request.requiredComponents[index].componentId)) {
    throw snapshotFailure('snapshot_component_coverage_invalid');
  }
  const frozenComponents = Object.freeze(components);
  const body = buildSnapshotBody({ request, moduleQualificationMetadata,
    components: frozenComponents, observedAt });
  const output = Object.freeze({
    ...body,
    stateSnapshotHash: snapshotHashRecord('PlanningStateSnapshotV1', body),
  });
  if (Buffer.byteLength(snapshotCanonicalStringify(output), 'utf8')
    > request.maximumTotalComponentBytes + request.maximumComponentBytes) {
    throw snapshotFailure('snapshot_output_byte_limit');
  }
  return output;
}

function captureSnapshot(value) {
  const data = snapshotRecordValues(value, SNAPSHOT_FIELDS,
    'planning_state_snapshot_invalid');
  const rebuilt = buildPlanningStateSnapshotV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    request: data.request,
    moduleQualificationMetadata: data.moduleQualificationMetadata,
    components: data.components,
    observedAt: data.observedAt,
  });
  if (snapshotCanonicalStringify(data) !== snapshotCanonicalStringify(rebuilt)) {
    throw snapshotFailure('planning_state_snapshot_integrity_invalid');
  }
  return rebuilt;
}

export function verifyPlanningStateSnapshotCurrentV1(value) {
  const input = snapshotRecordValues(value,
    ['inputBoundary', 'snapshot', 'observedAt', 'currentContext'],
    'snapshot_currentness_input_invalid');
  if (input.inputBoundary !== SNAPSHOT_BUILDER_INPUT_BOUNDARY) {
    throw snapshotFailure('snapshot_input_boundary_invalid');
  }
  const snapshot = captureSnapshot(input.snapshot);
  const observedAt = snapshotTimestamp(input.observedAt,
    'snapshot_currentness_observed_at_invalid');
  const observed = Date.parse(observedAt);
  if (observed < Date.parse(snapshot.observedAt) || observed > Date.parse(snapshot.expiresAt)) {
    throw snapshotFailure('snapshot_not_current');
  }
  const context = snapshotRecordValues(input.currentContext, CURRENT_CONTEXT_FIELDS,
    'snapshot_current_context_invalid');
  const request = snapshot.request;
  if (hashValue(context.moduleRegistryHash, 'snapshot_registry_hash_invalid')
      !== request.moduleRegistryHash
    || hashValue(context.policySetHash, 'snapshot_policy_hash_invalid')
      !== request.policySetHash
    || hashValue(context.resourcePriceSnapshotHash, 'snapshot_resource_price_hash_invalid')
      !== request.resourcePriceSnapshotHash
    || snapshotText(context.objectiveVersion, TOKEN, 'snapshot_objective_version_invalid', 128)
      !== request.objectiveVersion) {
    throw snapshotFailure('snapshot_current_context_drift');
  }
  const metadataCapture = captureSnapshotMetadata(context.moduleQualificationMetadata);
  if (metadataCapture.moduleQualificationMetadataSetHash
    !== snapshot.moduleQualificationMetadataSetHash) {
    throw snapshotFailure('snapshot_module_metadata_drift');
  }
  validateSnapshotMetadataAt(metadataCapture.moduleQualificationMetadata, observedAt);
  const versions = snapshotDenseArray(context.componentVersions, SNAPSHOT_LIMITS.components,
    'snapshot_component_versions_invalid', snapshot.componentCount)
    .map(normalizeSnapshotVersion)
    .sort((left, right) => compareSnapshotUtf8(left.componentId, right.componentId));
  if (versions.length !== snapshot.componentCount
    || new Set(versions.map((entry) => entry.componentId)).size !== versions.length) {
    throw snapshotFailure('snapshot_component_version_coverage_invalid');
  }
  for (let index = 0; index < snapshot.components.length; index += 1) {
    const component = snapshot.components[index];
    const current = versions[index];
    if (!current || current.componentId !== component.componentId
      || current.sourceModuleId !== component.sourceModuleId
      || current.sourceModuleVersion !== component.sourceModuleVersion
      || current.revision !== component.revision
      || current.sourceGeneration !== component.sourceGeneration) {
      throw snapshotFailure('snapshot_component_generation_drift');
    }
  }
  const componentVersionSetHash = snapshotHashRecord(
    'PlanningSnapshotComponentVersionSetV1', versions,
  );
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotCurrentnessReceiptV1',
    status: 'planning_state_snapshot_current_against_supplied_context',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    observedAt,
    moduleRegistryHash: request.moduleRegistryHash,
    policySetHash: request.policySetHash,
    resourcePriceSnapshotHash: request.resourcePriceSnapshotHash,
    objectiveVersion: request.objectiveVersion,
    moduleQualificationMetadataSetHash: snapshot.moduleQualificationMetadataSetHash,
    componentVersionSetHash,
    qualificationTrustClass: 'caller_supplied_unverified',
    externalCurrentnessGateRequired: true,
    authority: snapshotAuthority(),
  });
  return Object.freeze({
    ...body,
    currentnessReceiptHash: snapshotHashRecord(
      'PlanningStateSnapshotCurrentnessReceiptV1', body,
    ),
  });
}
