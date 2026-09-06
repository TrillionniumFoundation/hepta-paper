import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import {
  SNAPSHOT_FIELDS,
  SNAPSHOT_LIMITS,
  captureQualifiedProjectionSourceSetV1,
  compareSnapshotText,
  denseSnapshotArray,
  exactSnapshotRecord,
  failSnapshot,
  normalizeReadOnlyProjection,
  normalizeSnapshotBuildRequest,
  normalizeSnapshotProjection,
  projectionSourceComparator,
  sealReadOnlyProjectionV1,
  snapshotAuthority,
  snapshotHash,
  snapshotIdentifier,
  snapshotInteger,
  snapshotTimestamp,
  sourceFromSnapshotProjection,
} from './control-plane-snapshot-contract.mjs';

function snapshotProjection(projection, source, builtAt) {
  if (projection.projectionId !== source.projectionId
    || projection.projectionVersion !== source.projectionVersion
    || projection.moduleId !== source.moduleId
    || projection.moduleVersion !== source.moduleVersion) {
    failSnapshot('read_only_projection_source_binding_mismatch');
  }
  const observed = Date.parse(projection.observedAt);
  const built = Date.parse(builtAt);
  const validUntil = Date.parse(projection.validUntil);
  if (observed > built || built > validUntil
    || built - observed > source.maximumAgeMilliseconds) {
    failSnapshot('read_only_projection_stale_or_not_current');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'SnapshotProjectionV1',
    projectionId: projection.projectionId,
    projectionVersion: projection.projectionVersion,
    moduleId: projection.moduleId,
    moduleVersion: projection.moduleVersion,
    authorityClass: source.authorityClass,
    qualificationStatus: source.qualificationStatus,
    qualificationIdentity: source.qualificationIdentity,
    maximumAgeMilliseconds: source.maximumAgeMilliseconds,
    sourceGeneration: projection.sourceGeneration,
    observedAt: projection.observedAt,
    validUntil: projection.validUntil,
    payload: projection.payload,
    payloadHash: projection.payloadHash,
  });
}

export function buildControlPlaneSnapshotV1(value) {
  const input = exactSnapshotRecord(value,
    ['request', 'qualifiedProjectionSources', 'projections'],
    'snapshot_build_input_invalid');
  const request = normalizeSnapshotBuildRequest(input.request);
  const qualified = captureQualifiedProjectionSourceSetV1(input.qualifiedProjectionSources);
  if (request.qualifiedProjectionSetHash !== qualified.qualifiedProjectionSetHash) {
    failSnapshot('snapshot_projection_set_binding_mismatch');
  }
  const raw = denseSnapshotArray(input.projections, SNAPSHOT_LIMITS.projections,
    'snapshot_projection_collection_invalid', qualified.sources.length);
  if (raw.length !== qualified.sources.length) {
    failSnapshot('snapshot_projection_coverage_invalid');
  }
  const byId = new Map();
  let totalBytes = 0;
  for (const item of raw) {
    const projection = normalizeReadOnlyProjection(item, true);
    if (byId.has(projection.projectionId)) failSnapshot('snapshot_projection_duplicate');
    const bytes = Buffer.byteLength(stableStringify(projection.payload), 'utf8');
    if (bytes > request.maximumProjectionBytes) failSnapshot('snapshot_projection_byte_limit');
    totalBytes += bytes;
    if (totalBytes > request.maximumTotalProjectionBytes) failSnapshot('snapshot_total_byte_limit');
    byId.set(projection.projectionId, projection);
  }
  const projections = Object.freeze(qualified.sources.map((source) => {
    const projection = byId.get(source.projectionId);
    if (!projection) failSnapshot('snapshot_projection_coverage_invalid');
    return snapshotProjection(projection, source, request.builtAt);
  }));
  const expiresAt = new Date(Math.min(
    Date.parse(request.deadline),
    ...projections.map((item) => Date.parse(item.validUntil)),
  )).toISOString();
  const projectionSetHash = hashRecord('SnapshotProjectionSetV1', projections);
  const buildRequestHash = hashRecord('SnapshotBuildRequestV1', request);
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'ControlPlaneSnapshotV1',
    status: 'control_plane_snapshot_ready',
    snapshotId: request.snapshotId,
    moduleRegistryHash: request.moduleRegistryHash,
    policySetHash: request.policySetHash,
    resourcePriceSnapshotHash: request.resourcePriceSnapshotHash,
    objectiveVersion: request.objectiveVersion,
    qualifiedProjectionSetHash: qualified.qualifiedProjectionSetHash,
    buildRequestHash,
    issuedAt: request.issuedAt,
    builtAt: request.builtAt,
    deadline: request.deadline,
    expiresAt,
    maximumProjectionBytes: request.maximumProjectionBytes,
    maximumTotalProjectionBytes: request.maximumTotalProjectionBytes,
    projectionCount: projections.length,
    projectionSetHash,
    projections,
    consumerMustRevalidateBeforePlanning: true,
    authority: snapshotAuthority(),
  });
  return Object.freeze({
    ...body,
    stateSnapshotHash: hashRecord('ControlPlaneSnapshotV1', body),
  });
}

function reconstructBuildRequest(data, maximumProjectionBytes,
  maximumTotalProjectionBytes) {
  return normalizeSnapshotBuildRequest({
    schemaVersion: 1,
    kind: 'SnapshotBuildRequestV1',
    snapshotId: data.snapshotId,
    moduleRegistryHash: data.moduleRegistryHash,
    policySetHash: data.policySetHash,
    resourcePriceSnapshotHash: data.resourcePriceSnapshotHash,
    objectiveVersion: data.objectiveVersion,
    qualifiedProjectionSetHash: data.qualifiedProjectionSetHash,
    issuedAt: data.issuedAt,
    builtAt: data.builtAt,
    deadline: data.deadline,
    maximumProjectionBytes,
    maximumTotalProjectionBytes,
  });
}

function captureSnapshot(value) {
  const data = exactSnapshotRecord(value, SNAPSHOT_FIELDS,
    'control_plane_snapshot_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'ControlPlaneSnapshotV1'
    || data.status !== 'control_plane_snapshot_ready'
    || data.consumerMustRevalidateBeforePlanning !== true) {
    failSnapshot('control_plane_snapshot_identity_invalid');
  }
  const projections = Object.freeze(denseSnapshotArray(
    data.projections, SNAPSHOT_LIMITS.projections,
    'snapshot_projection_collection_invalid', 1,
  ).map(normalizeSnapshotProjection));
  if (data.projectionCount !== projections.length) {
    failSnapshot('snapshot_projection_count_invalid');
  }
  const ordered = [...projections].sort((left, right) => compareSnapshotText(
    left.projectionId, right.projectionId,
  ));
  if (stableStringify(ordered) !== stableStringify(projections)) {
    failSnapshot('snapshot_projection_order_invalid');
  }
  if (new Set(projections.map((item) => item.projectionId)).size !== projections.length) {
    failSnapshot('snapshot_projection_duplicate');
  }
  const maximumProjectionBytes = snapshotInteger(
    data.maximumProjectionBytes, 256, SNAPSHOT_LIMITS.projectionBytes,
    'snapshot_build_projection_byte_limit_invalid',
  );
  const maximumTotalProjectionBytes = snapshotInteger(
    data.maximumTotalProjectionBytes, maximumProjectionBytes,
    SNAPSHOT_LIMITS.totalProjectionBytes, 'snapshot_build_total_byte_limit_invalid',
  );
  let totalBytes = 0;
  for (const projection of projections) {
    const bytes = Buffer.byteLength(stableStringify(projection.payload), 'utf8');
    if (bytes > maximumProjectionBytes) failSnapshot('snapshot_projection_byte_limit');
    totalBytes += bytes;
    if (totalBytes > maximumTotalProjectionBytes) failSnapshot('snapshot_total_byte_limit');
  }
  const derivedSources = captureQualifiedProjectionSourceSetV1(
    projections.map(sourceFromSnapshotProjection).sort(projectionSourceComparator),
  );
  if (data.qualifiedProjectionSetHash !== derivedSources.qualifiedProjectionSetHash) {
    failSnapshot('snapshot_projection_set_binding_mismatch');
  }
  const projectionSetHash = hashRecord('SnapshotProjectionSetV1', projections);
  if (data.projectionSetHash !== projectionSetHash) {
    failSnapshot('snapshot_projection_set_hash_invalid');
  }
  const request = reconstructBuildRequest(data, maximumProjectionBytes,
    maximumTotalProjectionBytes);
  const buildRequestHash = hashRecord('SnapshotBuildRequestV1', request);
  if (data.buildRequestHash !== buildRequestHash) {
    failSnapshot('snapshot_build_request_hash_invalid');
  }
  const expiresAt = snapshotTimestamp(data.expiresAt,
    'snapshot_expires_at_invalid');
  const expectedExpiresAt = new Date(Math.min(
    Date.parse(request.deadline),
    ...projections.map((item) => Date.parse(item.validUntil)),
  )).toISOString();
  if (expiresAt !== expectedExpiresAt) {
    failSnapshot('control_plane_snapshot_expiry_invalid');
  }
  const built = Date.parse(request.builtAt);
  for (const projection of projections) {
    const observed = Date.parse(projection.observedAt);
    const validUntil = Date.parse(projection.validUntil);
    if (observed > built || built > validUntil
      || built - observed > projection.maximumAgeMilliseconds) {
      failSnapshot('control_plane_snapshot_projection_time_invalid');
    }
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'ControlPlaneSnapshotV1',
    status: 'control_plane_snapshot_ready',
    snapshotId: request.snapshotId,
    moduleRegistryHash: request.moduleRegistryHash,
    policySetHash: request.policySetHash,
    resourcePriceSnapshotHash: request.resourcePriceSnapshotHash,
    objectiveVersion: request.objectiveVersion,
    qualifiedProjectionSetHash: request.qualifiedProjectionSetHash,
    buildRequestHash,
    issuedAt: request.issuedAt,
    builtAt: request.builtAt,
    deadline: request.deadline,
    expiresAt,
    maximumProjectionBytes,
    maximumTotalProjectionBytes,
    projectionCount: projections.length,
    projectionSetHash,
    projections,
    consumerMustRevalidateBeforePlanning: true,
    authority: snapshotAuthority(data.authority),
  });
  const stateSnapshotHash = hashRecord('ControlPlaneSnapshotV1', body);
  if (data.stateSnapshotHash !== stateSnapshotHash) {
    failSnapshot('control_plane_snapshot_hash_invalid');
  }
  return Object.freeze({ ...body, stateSnapshotHash });
}

export function revalidateControlPlaneSnapshotV1(value) {
  const input = exactSnapshotRecord(value, [
    'snapshot', 'observedAt', 'moduleRegistryHash', 'policySetHash',
    'resourcePriceSnapshotHash', 'objectiveVersion', 'qualifiedProjectionSetHash',
    'currentProjectionGenerations',
  ], 'snapshot_revalidation_input_invalid');
  const snapshot = captureSnapshot(input.snapshot);
  const observedAt = snapshotTimestamp(input.observedAt,
    'snapshot_revalidation_time_invalid');
  if (Date.parse(observedAt) < Date.parse(snapshot.builtAt)
    || Date.parse(observedAt) > Date.parse(snapshot.expiresAt)) {
    failSnapshot('control_plane_snapshot_expired_or_time_invalid');
  }
  if (input.moduleRegistryHash !== snapshot.moduleRegistryHash
    || input.policySetHash !== snapshot.policySetHash
    || input.resourcePriceSnapshotHash !== snapshot.resourcePriceSnapshotHash
    || input.objectiveVersion !== snapshot.objectiveVersion
    || input.qualifiedProjectionSetHash !== snapshot.qualifiedProjectionSetHash) {
    failSnapshot('control_plane_snapshot_context_changed');
  }
  const generations = denseSnapshotArray(
    input.currentProjectionGenerations, SNAPSHOT_LIMITS.projections,
    'snapshot_generation_set_invalid', snapshot.projections.length,
  ).map((item) => {
    const data = exactSnapshotRecord(item, ['projectionId', 'sourceGeneration'],
      'snapshot_generation_invalid');
    return Object.freeze({
      projectionId: snapshotIdentifier(data.projectionId,
        'snapshot_generation_projection_invalid'),
      sourceGeneration: snapshotInteger(
        data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
        'snapshot_generation_value_invalid',
      ),
    });
  }).sort((left, right) => compareSnapshotText(left.projectionId, right.projectionId));
  if (generations.length !== snapshot.projections.length
    || new Set(generations.map((item) => item.projectionId)).size !== generations.length) {
    failSnapshot('snapshot_generation_coverage_invalid');
  }
  for (let index = 0; index < snapshot.projections.length; index += 1) {
    const projection = snapshot.projections[index];
    const current = generations[index];
    if (current.projectionId !== projection.projectionId
      || current.sourceGeneration !== projection.sourceGeneration) {
      failSnapshot('control_plane_snapshot_generation_changed');
    }
  }
  const frozenGenerations = Object.freeze(generations);
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'ControlPlaneSnapshotCurrentnessReceiptV1',
    status: 'control_plane_snapshot_current',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    buildRequestHash: snapshot.buildRequestHash,
    observedAt,
    moduleRegistryHash: snapshot.moduleRegistryHash,
    policySetHash: snapshot.policySetHash,
    resourcePriceSnapshotHash: snapshot.resourcePriceSnapshotHash,
    objectiveVersion: snapshot.objectiveVersion,
    qualifiedProjectionSetHash: snapshot.qualifiedProjectionSetHash,
    currentGenerationSetHash: hashRecord(
      'CurrentProjectionGenerationSetV1', frozenGenerations,
    ),
    currentProjectionGenerations: frozenGenerations,
    authority: snapshotAuthority(),
  });
  return Object.freeze({
    ...body,
    currentnessReceiptHash: hashRecord(
      'ControlPlaneSnapshotCurrentnessReceiptV1', body,
    ),
  });
}

export {
  captureQualifiedProjectionSourceSetV1,
  sealReadOnlyProjectionV1,
};
