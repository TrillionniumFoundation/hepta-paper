import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildControlPlaneSnapshot, moduleQualificationSetHash, projectionHash,
} from '../../paper-application/orchestration/control-plane-snapshot-builder.mjs';
import { qualifiedModuleRegistrySnapshotHash }
  from '../../paper-application/orchestration/candidate-router.mjs';

const H = (c) => `sha256:${c.repeat(64)}`;
const now = Date.parse('2026-09-05T00:05:00.000Z');
const observedAt = '2026-09-05T00:04:00.000Z';
const expiresAt = '2026-09-05T01:00:00.000Z';
const seal = (kind, value, field = 'projectionHash') => ({ ...value,
  [field]: projectionHash(kind, value) });
const reseal = (kind, value, field = 'projectionHash') => {
  const copy = structuredClone(value); delete copy[field]; return seal(kind, copy, field);
};
const moduleRow = (id = 'module.author-node', capability = 'CAP-AUTHOR', evidence = 'a') => ({
  moduleId: id, moduleVersion: '1.0.0', protocolMinimum: 1, protocolMaximum: 1,
  capabilityIds: [capability], qualificationStatus: 'source_qualified',
  qualificationEvidenceHash: H(evidence),
});
function registry(modules = [moduleRow()]) {
  const value = { version: 1, kind: 'QualifiedModuleRegistrySnapshotV1', modules };
  return { ...value, snapshotHash: qualifiedModuleRegistrySnapshotHash(value) };
}
function fixture(overrides = {}) {
  const moduleRegistry = overrides.moduleRegistry || registry();
  const readSession = seal('ReadConsistencySessionV1', {
    version: 1, kind: 'ReadConsistencySessionV1', readSessionId: 'read-1',
    barrierGeneration: 7, startedAt: '2026-09-05T00:03:00.000Z', completedAt: observedAt,
    expiresAt,
  }, 'sessionHash');
  const common = { version: 1, readSessionId: 'read-1', readBarrierGeneration: 7,
    observedAt, expiresAt };
  const campaign = seal('CampaignReadProjectionV1', { ...common,
    kind: 'CampaignReadProjectionV1', campaignId: 'campaign-1', campaignRevision: 4,
    stateHash: H('1'), databaseIdentityHash: H('2'), budgetMicrousd: 1000 });
  const registryPolicyHash = H('3');
  const qualification = seal('QualificationCurrentnessProjectionV1', { ...common,
    kind: 'QualificationCurrentnessProjectionV1', registrySnapshotHash: moduleRegistry.snapshotHash,
    registryPolicyHash, qualificationGeneration: 11,
    qualificationSetHash: moduleQualificationSetHash(moduleRegistry), status: 'current' });
  const policy = seal('PlanningPolicyProjectionV1', { ...common,
    kind: 'PlanningPolicyProjectionV1', policyGeneration: 13, registryPolicyHash,
    objectiveVersion: 'objective-v1', constraintSetHash: H('4'),
    requiredCapabilityIds: ['CAP-AUTHOR'], randomSeed: 42 });
  const resources = seal('ResourceStateProjectionV1', { ...common,
    kind: 'ResourceStateProjectionV1', resourceGeneration: 17, resourceStateHash: H('5'),
    resourcePriceSnapshotHash: H('6'), resourceLimit: { cpuUnits: 4, gpuUnits: 1,
      memoryMiB: 4096, storageBytes: 1_000_000, tokenCount: 10_000,
      maximumCostMicrousd: 5000, externalActions: 0 } });
  return { readSession, campaign, moduleRegistry, qualification, policy, resources,
    nowEpochMs: now, ...overrides };
}

const kinds = { campaign: 'CampaignReadProjectionV1',
  qualification: 'QualificationCurrentnessProjectionV1', policy: 'PlanningPolicyProjectionV1',
  resources: 'ResourceStateProjectionV1' };

test('canonical order yields one snapshot identity', () => {
  const rows = [moduleRow('module.reviewer-node', 'CAP-REVIEW', 'b'), moduleRow()];
  const make = (moduleRegistry, requiredCapabilityIds) => {
    const value = fixture({ moduleRegistry });
    value.policy = reseal(kinds.policy, { ...value.policy, requiredCapabilityIds });
    return value;
  };
  assert.equal(buildControlPlaneSnapshot(make(registry(rows), ['CAP-REVIEW', 'CAP-AUTHOR'])).snapshotHash,
    buildControlPlaneSnapshot(make(registry(rows.slice().reverse()), ['CAP-AUTHOR', 'CAP-REVIEW'])).snapshotHash);
});

test('all source identities and generations change the hash', () => {
  const original = buildControlPlaneSnapshot(fixture()).snapshotHash;
  for (const [name, key, changed] of [
    ['campaign', 'campaignRevision', 5], ['campaign', 'databaseIdentityHash', H('9')],
    ['qualification', 'qualificationGeneration', 12], ['policy', 'policyGeneration', 14],
    ['resources', 'resourceGeneration', 18], ['resources', 'resourceStateHash', H('8')],
  ]) {
    const value = fixture(); value[name] = reseal(kinds[name], { ...value[name], [key]: changed });
    assert.notEqual(buildControlPlaneSnapshot(value).snapshotHash, original, `${name}.${key}`);
  }
  const changedRegistry = registry([moduleRow('module.author-node', 'CAP-AUTHOR', 'b')]);
  assert.notEqual(buildControlPlaneSnapshot(fixture({ moduleRegistry: changedRegistry })).snapshotHash,
    original);
});

test('session ID and barrier generation must both match every projection', () => {
  for (const name of Object.keys(kinds)) {
    const mixedId = fixture(); mixedId[name] = reseal(kinds[name], { ...mixedId[name], readSessionId: 'other' });
    assert.throws(() => buildControlPlaneSnapshot(mixedId), { code: 'snapshot_mixed_read_sessions' });
    const mixedBarrier = fixture(); mixedBarrier[name] = reseal(kinds[name],
      { ...mixedBarrier[name], readBarrierGeneration: 8 });
    assert.throws(() => buildControlPlaneSnapshot(mixedBarrier), { code: 'snapshot_mixed_read_barriers' });
  }
});

test('observation and expiry windows fail closed', () => {
  const outside = fixture(); outside.resources = reseal(kinds.resources, { ...outside.resources,
    observedAt: '2026-09-05T00:02:59.999Z' });
  assert.throws(() => buildControlPlaneSnapshot(outside),
    { code: 'snapshot_resources_outside_read_session' });
  const expired = fixture(); expired.policy = reseal(kinds.policy, { ...expired.policy,
    expiresAt: '2026-09-05T00:05:00.000Z' });
  assert.throws(() => buildControlPlaneSnapshot(expired), { code: 'snapshot_policy_stale' });
  const future = fixture(); future.readSession = reseal('ReadConsistencySessionV1',
    { ...future.readSession, completedAt: '2026-09-05T00:06:00.000Z' }, 'sessionHash');
  assert.throws(() => buildControlPlaneSnapshot(future),
    { code: 'snapshot_read_session_stale_or_future' });
});

test('every projection hash is independently recomputed', () => {
  for (const [name, field] of [['readSession', 'sessionHash'], ...Object.keys(kinds)
    .map((name) => [name, 'projectionHash'])]) {
    const value = fixture(); value[name] = { ...value[name], [field]: H('f') };
    assert.throws(() => buildControlPlaneSnapshot(value), /hash_mismatch/u);
  }
});

test('qualification binds exact registry, policy and module evidence', () => {
  for (const [key, changed, code] of [
    ['registrySnapshotHash', H('9'), 'snapshot_qualification_registry_mismatch'],
    ['registryPolicyHash', H('9'), 'snapshot_registry_policy_mismatch'],
    ['qualificationSetHash', H('9'), 'snapshot_qualification_set_mismatch'],
  ]) {
    const value = fixture(); value.qualification = reseal(kinds.qualification,
      { ...value.qualification, [key]: changed });
    assert.throws(() => buildControlPlaneSnapshot(value), { code });
  }
});

test('every required capability needs a qualified module', () => {
  const value = fixture(); value.policy = reseal(kinds.policy, { ...value.policy,
    requiredCapabilityIds: ['CAP-AUTHOR', 'CAP-MISSING'] });
  assert.throws(() => buildControlPlaneSnapshot(value),
    { code: 'snapshot_required_capability_unavailable' });
});

test('registry capture rejects duplicates, accessors and unqualified rows', () => {
  const row = moduleRow(); assert.throws(() => registry([row, row]));
  let calls = 0; const accessorRow = { ...row };
  Object.defineProperty(accessorRow, 'moduleId', { enumerable: true,
    get() { calls += 1; return 'module.author-node'; } });
  const accessor = fixture(); accessor.moduleRegistry = { version: 1,
    kind: 'QualifiedModuleRegistrySnapshotV1', modules: [accessorRow], snapshotHash: H('f') };
  assert.throws(() => buildControlPlaneSnapshot(accessor),
    { code: 'snapshot_registry_module_invalid' }); assert.equal(calls, 0);
  const unqualified = fixture(); unqualified.moduleRegistry = { version: 1,
    kind: 'QualifiedModuleRegistrySnapshotV1', modules: [{ ...row, qualificationStatus: 'design_ready' }],
    snapshotHash: H('f') };
  assert.throws(() => buildControlPlaneSnapshot(unqualified),
    { code: 'snapshot_registry_module_not_qualified' });
});

test('invalid resource values and writable handles are rejected', () => {
  for (const resourceLimit of [
    { cpuUnits: NaN, gpuUnits: 0, memoryMiB: 1, storageBytes: 1 },
    { cpuUnits: -1, gpuUnits: 0, memoryMiB: 1, storageBytes: 1 },
    { cpuUnits: 1, gpuUnits: Infinity, memoryMiB: 1, storageBytes: 1 },
    { cpuUnits: 1, gpuUnits: 0, memoryMiB: 0.5, storageBytes: 1 },
    { cpuUnits: 1, gpuUnits: 0, memoryMiB: 1, storageBytes: Number.MAX_SAFE_INTEGER + 1 },
    { cpuUnits: 1, gpuUnits: 0, memoryMiB: 1, storageBytes: 1, writer() {} },
  ]) {
    const value = fixture(); value.resources = { ...value.resources, resourceLimit,
      projectionHash: H('f') };
    assert.throws(() => buildControlPlaneSnapshot(value));
  }
});

test('unknown fields and input accessors fail without getter execution', () => {
  const unknown = fixture(); unknown.campaign = { ...unknown.campaign, credential: 'secret' };
  assert.throws(() => buildControlPlaneSnapshot(unknown),
    { code: 'snapshot_campaign_projection_invalid' });
  let calls = 0; const accessor = fixture();
  Object.defineProperty(accessor, 'campaign', { enumerable: true,
    get() { calls += 1; return {}; } });
  assert.throws(() => buildControlPlaneSnapshot(accessor),
    { code: 'snapshot_builder_input_invalid' }); assert.equal(calls, 0);
});

test('projection hash helper has closed domains and never executes accessors', () => {
  assert.throws(() => projectionHash('ArbitraryAuthorityReceiptV1', {}),
    { code: 'snapshot_projection_kind_invalid' });
  let calls = 0; const value = Object.defineProperty({}, 'secret', { enumerable: true,
    get() { calls += 1; return 'credential'; } });
  assert.throws(() => projectionHash(kinds.campaign, value),
    { code: 'snapshot_projection_record_invalid' }); assert.equal(calls, 0);
});

test('qualification status, canonical timestamps and integer fields are strict', () => {
  for (const status of ['stale', 'unknown', null]) {
    const value = fixture(); value.qualification = reseal(kinds.qualification,
      { ...value.qualification, status });
    assert.throws(() => buildControlPlaneSnapshot(value),
      { code: 'snapshot_qualification_not_current' });
  }
  for (const completedAt of ['2026-09-05T00:04:00Z',
    '2026-09-05T01:04:00.000+01:00', '2026-02-30T00:04:00.000Z']) {
    const value = fixture(); value.readSession = reseal('ReadConsistencySessionV1',
      { ...value.readSession, completedAt }, 'sessionHash');
    assert.throws(() => buildControlPlaneSnapshot(value));
  }
  const booleanRevision = fixture(); booleanRevision.campaign = reseal(kinds.campaign,
    { ...booleanRevision.campaign, campaignRevision: true });
  assert.throws(() => buildControlPlaneSnapshot(booleanRevision));
  assert.throws(() => buildControlPlaneSnapshot(fixture({ nowEpochMs: now + 0.5 })),
    { code: 'snapshot_clock_invalid' });
});

test('captured output is immutable, non-authorizing and uses earliest expiry', () => {
  const value = fixture(); value.resources = reseal(kinds.resources, { ...value.resources,
    expiresAt: '2026-09-05T00:30:00.000Z' });
  const result = buildControlPlaneSnapshot(value);
  value.resources.resourceLimit.cpuUnits = 999;
  value.policy.requiredCapabilityIds.push('CAP-MISSING');
  assert.equal(result.resourceLimit.cpuUnits, 4);
  assert.deepEqual(result.requiredCapabilityIds, ['CAP-AUTHOR']);
  assert.equal(result.validUntil, '2026-09-05T00:30:00.000Z');
  assert.ok(Object.values(result.authority).every((entry) => entry === false));
  assert.throws(() => { result.resourceLimit.cpuUnits = 7; }, TypeError);
});

test('generation tuple and exact read barrier are present in output', () => {
  const result = buildControlPlaneSnapshot(fixture());
  assert.deepEqual([result.readBarrierGeneration, result.qualificationGeneration,
    result.policyGeneration, result.resourceGeneration], [7, 11, 13, 17]);
});

test('one hundred input permutations produce one snapshot identity', () => {
  const base = fixture(); let seed = 91_041; const hashes = new Set();
  const random = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
  for (let index = 0; index < 100; index += 1) {
    const value = structuredClone(base);
    value.moduleRegistry.modules.sort(() => (random() & 1) ? 1 : -1);
    value.policy.requiredCapabilityIds.sort(() => (random() & 1) ? 1 : -1);
    hashes.add(buildControlPlaneSnapshot(value).snapshotHash);
  }
  assert.equal(hashes.size, 1);
});
