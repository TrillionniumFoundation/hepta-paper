import {
  CANDIDATE_ROUTER_INPUT_BOUNDARY,
  capturePlanningModuleQualificationMetadataSetV1,
  routeActionCandidatesV1,
  sealActionCandidateV1,
  sealPlanningModuleQualificationMetadataV1,
} from '../../paper-application/orchestration/candidate-router.mjs';
import {
  SNAPSHOT_BUILDER_INPUT_BOUNDARY,
  buildPlanningStateSnapshotV1,
  sealPlanningSnapshotComponentV1,
  verifyPlanningStateSnapshotCurrentV1,
} from '../../paper-application/orchestration/planning-snapshot-builder.mjs';

export {
  CANDIDATE_ROUTER_INPUT_BOUNDARY,
  capturePlanningModuleQualificationMetadataSetV1,
  routeActionCandidatesV1,
  sealActionCandidateV1,
  sealPlanningModuleQualificationMetadataV1,
  SNAPSHOT_BUILDER_INPUT_BOUNDARY,
  buildPlanningStateSnapshotV1,
  sealPlanningSnapshotComponentV1,
  verifyPlanningStateSnapshotCurrentV1,
};

export const hash = (character) => `sha256:${character.repeat(64)}`;
export const observedAt = '2026-09-06T00:10:00Z';

export function modulePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningModuleQualificationMetadataV1',
    moduleId: 'module.readonly-control',
    moduleVersion: '1.0.0',
    capabilityIds: ['CAP-AUTHOR', 'CAP-CTL-SNAPSHOT'],
    qualificationStatus: 'source_qualified',
    qualificationIdentity: hash('a'),
    qualificationGeneration: 4,
    qualificationTrustClass: 'caller_supplied_unverified',
    qualificationCurrentnessMode: 'external_live_revalidation_required',
    qualificationObservedAt: '2026-09-05T23:50:00Z',
    qualificationExpiresAt: '2026-09-06T01:00:00Z',
    qualificationRevocationSetHash: hash('8'),
    qualificationCurrentnessReceiptHash: hash('9'),
    ...overrides,
  };
}

export const moduleMetadata = (overrides = {}) => (
  sealPlanningModuleQualificationMetadataV1(modulePayload(overrides))
);

export function requirement(componentId, overrides = {}) {
  return {
    componentId,
    componentKind: `projection:${componentId}`,
    sourceModuleId: 'module.readonly-control',
    sourceModuleVersion: '1.0.0',
    requiredCapabilityId: 'CAP-CTL-SNAPSHOT',
    minimumRevision: 2,
    maximumAgeMilliseconds: 15 * 60 * 1000,
    maximumPayloadBytes: 64 * 1024,
    ...overrides,
  };
}

export function request(metadata, overrides = {}) {
  const metadataSetHash = capturePlanningModuleQualificationMetadataSetV1(
    metadata,
  ).moduleQualificationMetadataSetHash;
  return {
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: 'snapshot-request:alpha',
    readTransactionHash: hash('b'),
    consistencyEpoch: 7,
    moduleRegistryHash: hash('c'),
    policySetHash: hash('d'),
    resourcePriceSnapshotHash: hash('e'),
    objectiveVersion: 'objective-v1',
    moduleQualificationMetadataSetHash: metadataSetHash,
    issuedAt: '2026-09-06T00:00:00Z',
    deadline: '2026-09-06T00:45:00Z',
    maximumComponentBytes: 128 * 1024,
    maximumTotalComponentBytes: 512 * 1024,
    requiredComponents: [requirement('campaign'), requirement('resources')],
    ...overrides,
  };
}

export function component(componentId, overrides = {}) {
  const metadata = moduleMetadata();
  return sealPlanningSnapshotComponentV1({
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentV1',
    componentId,
    componentKind: `projection:${componentId}`,
    sourceModuleId: 'module.readonly-control',
    sourceModuleVersion: '1.0.0',
    requiredCapabilityId: 'CAP-CTL-SNAPSHOT',
    sourceQualificationMetadataHash: metadata.qualificationMetadataHash,
    readTransactionHash: hash('b'),
    consistencyEpoch: 7,
    revision: 2,
    sourceGeneration: componentId === 'campaign' ? 11 : 13,
    observedAt: '2026-09-06T00:05:00Z',
    validUntil: '2026-09-06T00:35:00Z',
    payload: { componentId, value: 1 },
    ...overrides,
  });
}

export function build(overrides = {}) {
  const metadata = overrides.moduleQualificationMetadata || [moduleMetadata()];
  return buildPlanningStateSnapshotV1({
    inputBoundary: Object.hasOwn(overrides, 'inputBoundary')
      ? overrides.inputBoundary : SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    request: overrides.request || request(metadata),
    moduleQualificationMetadata: metadata,
    components: overrides.components || [component('campaign'), component('resources')],
    observedAt: overrides.observedAt || observedAt,
  });
}

export function currentContext(snapshot, overrides = {}) {
  return {
    moduleRegistryHash: snapshot.request.moduleRegistryHash,
    policySetHash: snapshot.request.policySetHash,
    resourcePriceSnapshotHash: snapshot.request.resourcePriceSnapshotHash,
    objectiveVersion: snapshot.request.objectiveVersion,
    moduleQualificationMetadata: snapshot.moduleQualificationMetadata,
    componentVersions: snapshot.components.map((entry) => ({
      componentId: entry.componentId,
      sourceModuleId: entry.sourceModuleId,
      sourceModuleVersion: entry.sourceModuleVersion,
      revision: entry.revision,
      sourceGeneration: entry.sourceGeneration,
    })),
    ...overrides,
  };
}

export function resealComponent(value, overrides = {}) {
  const { componentHash: ignored, ...body } = value;
  return sealPlanningSnapshotComponentV1({ ...body, ...overrides });
}
