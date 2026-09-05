import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_CAPABILITIES = 256;
const MAX_MODULES = 256;
const MAX_TEXT_BYTES = 2048;
const MAX_RESOURCE = Number.MAX_SAFE_INTEGER;
const MAX_PROJECTION_DEPTH = 12;
const MAX_PROJECTION_NODES = 8192;
const MAX_PROJECTION_STRING_BYTES = 64 * 1024;
const QUALIFICATION_STATES = new Set([
  'source_qualified',
  'target_host_qualified',
  'external_authority_qualified',
]);
const PROJECTION_KINDS = new Set([
  'ReadConsistencySessionV1',
  'CampaignReadProjectionV1',
  'QualificationCurrentnessProjectionV1',
  'PlanningPolicyProjectionV1',
  'ResourceStateProjectionV1',
]);

const INPUT_FIELDS = Object.freeze([
  'readSession', 'campaign', 'moduleRegistry', 'qualification', 'policy', 'resources',
  'nowEpochMs',
]);
const SESSION_FIELDS = Object.freeze([
  'version', 'kind', 'readSessionId', 'barrierGeneration', 'startedAt', 'completedAt',
  'expiresAt', 'sessionHash',
]);
const CAMPAIGN_FIELDS = Object.freeze([
  'version', 'kind', 'readSessionId', 'readBarrierGeneration', 'campaignId', 'campaignRevision', 'stateHash',
  'databaseIdentityHash', 'budgetMicrousd', 'observedAt', 'expiresAt', 'projectionHash',
]);
const QUALIFICATION_FIELDS = Object.freeze([
  'version', 'kind', 'readSessionId', 'readBarrierGeneration', 'registrySnapshotHash', 'registryPolicyHash',
  'qualificationGeneration', 'qualificationSetHash', 'status', 'observedAt', 'expiresAt',
  'projectionHash',
]);
const POLICY_FIELDS = Object.freeze([
  'version', 'kind', 'readSessionId', 'readBarrierGeneration', 'policyGeneration', 'registryPolicyHash',
  'objectiveVersion', 'constraintSetHash', 'requiredCapabilityIds', 'randomSeed',
  'observedAt', 'expiresAt', 'projectionHash',
]);
const RESOURCE_FIELDS = Object.freeze([
  'version', 'kind', 'readSessionId', 'readBarrierGeneration', 'resourceGeneration', 'resourceStateHash',
  'resourcePriceSnapshotHash', 'resourceLimit', 'observedAt', 'expiresAt', 'projectionHash',
]);
const VECTOR_FIELDS = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes', 'tokenCount',
  'maximumCostMicrousd', 'externalActions',
]);
const VECTOR_REQUIRED = Object.freeze(['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes']);
const REGISTRY_MODULE_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'protocolMinimum', 'protocolMaximum', 'capabilityIds',
  'qualificationStatus', 'qualificationEvidenceHash',
]);

function fail(code) {
  throw Object.assign(new Error(code), { code, retryable: false });
}
function requireCondition(condition, code) {
  if (!condition) fail(code);
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}
function text(value, code, maximum = MAX_TEXT_BYTES) {
  requireCondition(typeof value === 'string' && value.length > 0
    && !value.includes('\0') && byteLength(value) <= maximum, code);
  return value;
}
function hash(value, code) {
  requireCondition(typeof value === 'string' && HASH.test(value), code);
  return value;
}
function integer(value, minimum, maximum, code) {
  requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum, code);
  return value;
}
function finite(value, maximum, code) {
  requireCondition(typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= maximum, code);
  return Object.is(value, -0) ? 0 : value;
}
function timestamp(value, code) {
  requireCondition(typeof value === 'string' && CANONICAL_TIME.test(value), code);
  const milliseconds = Date.parse(value);
  requireCondition(Number.isSafeInteger(milliseconds)
    && new Date(milliseconds).toISOString() === value, code);
  return Object.freeze({ value, milliseconds });
}
function record(value, allowed, required, code) {
  requireCondition(value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireCondition(keys.length <= allowed.length
    && keys.every((key) => typeof key === 'string' && allowed.includes(key)
      && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), code);
  requireCondition(required.every((key) => Object.hasOwn(descriptors, key)), code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function denseArray(value, maximum, code) {
  requireCondition(Array.isArray(value) && value.length <= maximum, code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireCondition(Reflect.ownKeys(descriptors).length === value.length + 1
    && Object.hasOwn(descriptors, 'length'), code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    requireCondition(descriptor && descriptor.enumerable
      && Object.hasOwn(descriptor, 'value'), code);
    output.push(descriptor.value);
  }
  return output;
}
function canonicalSet(value, maximum, item, code) {
  const output = denseArray(value, maximum, code).map(item).sort(compareText);
  requireCondition(output.length > 0 && new Set(output).size === output.length, code);
  return Object.freeze(output);
}
function captureProjectionValue(value, state, depth = 0) {
  requireCondition(depth <= MAX_PROJECTION_DEPTH, 'snapshot_projection_depth_limit');
  state.nodes += 1;
  requireCondition(state.nodes <= MAX_PROJECTION_NODES, 'snapshot_projection_node_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    state.stringBytes += byteLength(value);
    requireCondition(state.stringBytes <= MAX_PROJECTION_STRING_BYTES,
      'snapshot_projection_string_limit');
    return value;
  }
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value), 'snapshot_projection_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  requireCondition(value !== null && typeof value === 'object',
    'snapshot_projection_value_invalid');
  if (Array.isArray(value)) {
    return Object.freeze(denseArray(value, 4096, 'snapshot_projection_array_invalid')
      .map((item) => captureProjectionValue(item, state, depth + 1)));
  }
  requireCondition([Object.prototype, null].includes(Object.getPrototypeOf(value)),
    'snapshot_projection_record_invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireCondition(keys.length <= 4096 && keys.every((key) => typeof key === 'string'
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')),
  'snapshot_projection_record_invalid');
  return Object.freeze(Object.fromEntries(keys.slice().sort(compareText)
    .map((key) => [key, captureProjectionValue(descriptors[key].value, state, depth + 1)])));
}
function projectionBody(values, hashField) {
  return Object.freeze(Object.fromEntries(Object.entries(values)
    .filter(([key]) => key !== hashField)));
}
function verifyProjectionHash(kind, values, field, code) {
  requireCondition(values[field] === hashRecord(kind, projectionBody(values, field)), code);
}
function resourceVector(value) {
  const values = record(value, VECTOR_FIELDS, VECTOR_REQUIRED, 'snapshot_resource_vector_invalid');
  const output = Object.freeze({
    cpuUnits: finite(values.cpuUnits, 1_000_000_000, 'snapshot_cpu_units_invalid'),
    gpuUnits: finite(values.gpuUnits, 1_000_000, 'snapshot_gpu_units_invalid'),
    memoryMiB: integer(values.memoryMiB, 0, MAX_RESOURCE, 'snapshot_memory_invalid'),
    storageBytes: integer(values.storageBytes, 0, MAX_RESOURCE, 'snapshot_storage_invalid'),
    ...(Object.hasOwn(values, 'tokenCount') ? {
      tokenCount: integer(values.tokenCount, 0, MAX_RESOURCE, 'snapshot_token_invalid'),
    } : {}),
    ...(Object.hasOwn(values, 'maximumCostMicrousd') ? {
      maximumCostMicrousd: integer(values.maximumCostMicrousd, 0, MAX_RESOURCE,
        'snapshot_resource_cost_invalid'),
    } : {}),
    ...(Object.hasOwn(values, 'externalActions') ? {
      externalActions: integer(values.externalActions, 0, MAX_RESOURCE,
        'snapshot_external_action_limit_invalid'),
    } : {}),
  });
  return output;
}
function captureSession(value) {
  const values = record(value, SESSION_FIELDS, SESSION_FIELDS, 'snapshot_read_session_invalid');
  requireCondition(values.version === 1 && values.kind === 'ReadConsistencySessionV1',
    'snapshot_read_session_identity_invalid');
  const output = {
    version: 1,
    kind: 'ReadConsistencySessionV1',
    readSessionId: text(values.readSessionId, 'snapshot_read_session_id_invalid'),
    barrierGeneration: integer(values.barrierGeneration, 1, MAX_RESOURCE,
      'snapshot_barrier_generation_invalid'),
    startedAt: timestamp(values.startedAt, 'snapshot_session_started_invalid').value,
    completedAt: timestamp(values.completedAt, 'snapshot_session_completed_invalid').value,
    expiresAt: timestamp(values.expiresAt, 'snapshot_session_expiry_invalid').value,
    sessionHash: hash(values.sessionHash, 'snapshot_session_hash_invalid'),
  };
  const times = [output.startedAt, output.completedAt, output.expiresAt].map(Date.parse);
  requireCondition(times[0] <= times[1] && times[1] < times[2], 'snapshot_session_time_order_invalid');
  verifyProjectionHash('ReadConsistencySessionV1', output, 'sessionHash',
    'snapshot_session_hash_mismatch');
  return Object.freeze(output);
}
function captureCampaign(value) {
  const values = record(value, CAMPAIGN_FIELDS, CAMPAIGN_FIELDS,
    'snapshot_campaign_projection_invalid');
  requireCondition(values.version === 1 && values.kind === 'CampaignReadProjectionV1',
    'snapshot_campaign_projection_identity_invalid');
  const output = {
    version: 1,
    kind: 'CampaignReadProjectionV1',
    readSessionId: text(values.readSessionId, 'snapshot_campaign_session_invalid'),
    readBarrierGeneration: integer(values.readBarrierGeneration, 1, MAX_RESOURCE,
      'snapshot_campaign_barrier_invalid'),
    campaignId: text(values.campaignId, 'snapshot_campaign_id_invalid'),
    campaignRevision: integer(values.campaignRevision, 1, MAX_RESOURCE,
      'snapshot_campaign_revision_invalid'),
    stateHash: hash(values.stateHash, 'snapshot_campaign_state_hash_invalid'),
    databaseIdentityHash: hash(values.databaseIdentityHash, 'snapshot_database_identity_invalid'),
    budgetMicrousd: integer(values.budgetMicrousd, 0, MAX_RESOURCE,
      'snapshot_budget_invalid'),
    observedAt: timestamp(values.observedAt, 'snapshot_campaign_observed_invalid').value,
    expiresAt: timestamp(values.expiresAt, 'snapshot_campaign_expiry_invalid').value,
    projectionHash: hash(values.projectionHash, 'snapshot_campaign_projection_hash_invalid'),
  };
  verifyProjectionHash('CampaignReadProjectionV1', output, 'projectionHash',
    'snapshot_campaign_projection_hash_mismatch');
  return Object.freeze(output);
}
function captureQualification(value) {
  const values = record(value, QUALIFICATION_FIELDS, QUALIFICATION_FIELDS,
    'snapshot_qualification_projection_invalid');
  requireCondition(values.version === 1 && values.kind === 'QualificationCurrentnessProjectionV1'
    && values.status === 'current', 'snapshot_qualification_not_current');
  const output = {
    version: 1,
    kind: 'QualificationCurrentnessProjectionV1',
    readSessionId: text(values.readSessionId, 'snapshot_qualification_session_invalid'),
    readBarrierGeneration: integer(values.readBarrierGeneration, 1, MAX_RESOURCE,
      'snapshot_qualification_barrier_invalid'),
    registrySnapshotHash: hash(values.registrySnapshotHash,
      'snapshot_qualification_registry_invalid'),
    registryPolicyHash: hash(values.registryPolicyHash,
      'snapshot_qualification_registry_policy_invalid'),
    qualificationGeneration: integer(values.qualificationGeneration, 1, MAX_RESOURCE,
      'snapshot_qualification_generation_invalid'),
    qualificationSetHash: hash(values.qualificationSetHash,
      'snapshot_qualification_set_invalid'),
    status: 'current',
    observedAt: timestamp(values.observedAt, 'snapshot_qualification_observed_invalid').value,
    expiresAt: timestamp(values.expiresAt, 'snapshot_qualification_expiry_invalid').value,
    projectionHash: hash(values.projectionHash,
      'snapshot_qualification_projection_hash_invalid'),
  };
  verifyProjectionHash('QualificationCurrentnessProjectionV1', output, 'projectionHash',
    'snapshot_qualification_projection_hash_mismatch');
  return Object.freeze(output);
}
function capturePolicy(value) {
  const required = POLICY_FIELDS.filter((key) => key !== 'randomSeed');
  const values = record(value, POLICY_FIELDS, required, 'snapshot_policy_projection_invalid');
  requireCondition(values.version === 1 && values.kind === 'PlanningPolicyProjectionV1',
    'snapshot_policy_projection_identity_invalid');
  const output = {
    version: 1,
    kind: 'PlanningPolicyProjectionV1',
    readSessionId: text(values.readSessionId, 'snapshot_policy_session_invalid'),
    readBarrierGeneration: integer(values.readBarrierGeneration, 1, MAX_RESOURCE,
      'snapshot_policy_barrier_invalid'),
    policyGeneration: integer(values.policyGeneration, 1, MAX_RESOURCE,
      'snapshot_policy_generation_invalid'),
    registryPolicyHash: hash(values.registryPolicyHash, 'snapshot_registry_policy_invalid'),
    objectiveVersion: text(values.objectiveVersion, 'snapshot_objective_invalid'),
    constraintSetHash: hash(values.constraintSetHash, 'snapshot_constraint_set_invalid'),
    requiredCapabilityIds: canonicalSet(values.requiredCapabilityIds, MAX_CAPABILITIES,
      (item) => text(item, 'snapshot_capability_invalid', 128), 'snapshot_capabilities_invalid'),
    ...(Object.hasOwn(values, 'randomSeed') ? {
      randomSeed: integer(values.randomSeed, 0, MAX_RESOURCE, 'snapshot_random_seed_invalid'),
    } : {}),
    observedAt: timestamp(values.observedAt, 'snapshot_policy_observed_invalid').value,
    expiresAt: timestamp(values.expiresAt, 'snapshot_policy_expiry_invalid').value,
    projectionHash: hash(values.projectionHash, 'snapshot_policy_projection_hash_invalid'),
  };
  verifyProjectionHash('PlanningPolicyProjectionV1', output, 'projectionHash',
    'snapshot_policy_projection_hash_mismatch');
  return Object.freeze(output);
}
function captureResources(value) {
  const values = record(value, RESOURCE_FIELDS, RESOURCE_FIELDS,
    'snapshot_resource_projection_invalid');
  requireCondition(values.version === 1 && values.kind === 'ResourceStateProjectionV1',
    'snapshot_resource_projection_identity_invalid');
  const output = {
    version: 1,
    kind: 'ResourceStateProjectionV1',
    readSessionId: text(values.readSessionId, 'snapshot_resource_session_invalid'),
    readBarrierGeneration: integer(values.readBarrierGeneration, 1, MAX_RESOURCE,
      'snapshot_resource_barrier_invalid'),
    resourceGeneration: integer(values.resourceGeneration, 1, MAX_RESOURCE,
      'snapshot_resource_generation_invalid'),
    resourceStateHash: hash(values.resourceStateHash, 'snapshot_resource_state_invalid'),
    resourcePriceSnapshotHash: hash(values.resourcePriceSnapshotHash,
      'snapshot_resource_price_invalid'),
    resourceLimit: resourceVector(values.resourceLimit),
    observedAt: timestamp(values.observedAt, 'snapshot_resource_observed_invalid').value,
    expiresAt: timestamp(values.expiresAt, 'snapshot_resource_expiry_invalid').value,
    projectionHash: hash(values.projectionHash, 'snapshot_resource_projection_hash_invalid'),
  };
  verifyProjectionHash('ResourceStateProjectionV1', output, 'projectionHash',
    'snapshot_resource_projection_hash_mismatch');
  return Object.freeze(output);
}
function qualificationSetHash(moduleRegistry) {
  const modules = moduleRegistry.modules.map((module) => Object.freeze({
    moduleId: module.moduleId,
    moduleVersion: module.moduleVersion,
    qualificationStatus: module.qualificationStatus,
    qualificationEvidenceHash: module.qualificationEvidenceHash,
  }));
  return hashRecord('ModuleQualificationSetV1', Object.freeze(modules));
}
function captureRegistryModule(value) {
  const values = record(value, REGISTRY_MODULE_FIELDS, REGISTRY_MODULE_FIELDS,
    'snapshot_registry_module_invalid');
  const minimum = integer(values.protocolMinimum, 1, 65535,
    'snapshot_registry_module_protocol_invalid');
  const maximum = integer(values.protocolMaximum, minimum, 65535,
    'snapshot_registry_module_protocol_invalid');
  requireCondition(minimum <= 1 && maximum >= 1,
    'snapshot_registry_module_protocol_unsupported');
  requireCondition(QUALIFICATION_STATES.has(values.qualificationStatus),
    'snapshot_registry_module_not_qualified');
  return Object.freeze({
    moduleId: text(values.moduleId, 'snapshot_registry_module_invalid'),
    moduleVersion: text(values.moduleVersion, 'snapshot_registry_module_version_invalid'),
    protocolMinimum: minimum,
    protocolMaximum: maximum,
    capabilityIds: canonicalSet(values.capabilityIds, MAX_CAPABILITIES,
      (item) => text(item, 'snapshot_registry_module_capability_invalid', 128),
      'snapshot_registry_module_capabilities_invalid'),
    qualificationStatus: values.qualificationStatus,
    qualificationEvidenceHash: hash(values.qualificationEvidenceHash,
      'snapshot_registry_module_qualification_hash_invalid'),
  });
}
function captureRegistry(value) {
  const values = record(value, ['version', 'kind', 'modules', 'snapshotHash'],
    ['version', 'kind', 'modules', 'snapshotHash'], 'snapshot_registry_invalid');
  requireCondition(values.version === 1 && values.kind === 'QualifiedModuleRegistrySnapshotV1',
    'snapshot_registry_identity_invalid');
  const modules = denseArray(values.modules, MAX_MODULES, 'snapshot_registry_modules_invalid')
    .map(captureRegistryModule).sort((left, right) => compareText(left.moduleId, right.moduleId));
  requireCondition(modules.length > 0
    && new Set(modules.map((module) => module.moduleId)).size === modules.length,
  'snapshot_registry_module_duplicate');
  const body = Object.freeze({ version: 1, kind: 'QualifiedModuleRegistrySnapshotV1',
    modules: Object.freeze(modules) });
  const snapshotHash = hashRecord('QualifiedModuleRegistrySnapshotV1', body);
  requireCondition(hash(values.snapshotHash, 'snapshot_registry_hash_invalid') === snapshotHash,
    'snapshot_registry_hash_mismatch');
  return Object.freeze({ ...body, snapshotHash });
}
function validateProjectionWindow(session, projection, nowEpochMs, label) {
  const started = Date.parse(session.startedAt);
  const completed = Date.parse(session.completedAt);
  const observed = Date.parse(projection.observedAt);
  const expires = Date.parse(projection.expiresAt);
  requireCondition(observed >= started && observed <= completed,
    `snapshot_${label}_outside_read_session`);
  requireCondition(expires > nowEpochMs, `snapshot_${label}_stale`);
}

export function projectionHash(kind, projection) {
  requireCondition(typeof kind === 'string' && PROJECTION_KINDS.has(kind),
    'snapshot_projection_kind_invalid');
  const captured = captureProjectionValue(projection, { nodes: 0, stringBytes: 0 });
  requireCondition(captured !== null && typeof captured === 'object' && !Array.isArray(captured),
    'snapshot_projection_invalid');
  const field = kind === 'ReadConsistencySessionV1' ? 'sessionHash' : 'projectionHash';
  let body = projectionBody(captured, field);
  // Capability IDs are a mathematical set. Hash construction canonicalizes
  // order, while the consuming validator still rejects duplicates and bad data.
  if (kind === 'PlanningPolicyProjectionV1'
    && Array.isArray(body.requiredCapabilityIds)
    && body.requiredCapabilityIds.every((item) => typeof item === 'string')) {
    body = Object.freeze({ ...body,
      requiredCapabilityIds: Object.freeze(body.requiredCapabilityIds.slice().sort(compareText)) });
  }
  return hashRecord(kind, body);
}

export function moduleQualificationSetHash(moduleRegistry) {
  return qualificationSetHash(captureRegistry(moduleRegistry));
}

export function buildControlPlaneSnapshot(input) {
  const values = record(input, INPUT_FIELDS, INPUT_FIELDS, 'snapshot_builder_input_invalid');
  const nowEpochMs = integer(values.nowEpochMs, 0, MAX_RESOURCE, 'snapshot_clock_invalid');
  const session = captureSession(values.readSession);
  requireCondition(Date.parse(session.completedAt) <= nowEpochMs
    && nowEpochMs < Date.parse(session.expiresAt), 'snapshot_read_session_stale_or_future');
  const campaign = captureCampaign(values.campaign);
  const moduleRegistry = captureRegistry(values.moduleRegistry);
  const qualification = captureQualification(values.qualification);
  const policy = capturePolicy(values.policy);
  const resources = captureResources(values.resources);
  const projections = [campaign, qualification, policy, resources];
  requireCondition(projections.every((projection) => projection.readSessionId === session.readSessionId),
    'snapshot_mixed_read_sessions');
  requireCondition(projections.every((projection) =>
    projection.readBarrierGeneration === session.barrierGeneration),
  'snapshot_mixed_read_barriers');
  validateProjectionWindow(session, campaign, nowEpochMs, 'campaign');
  validateProjectionWindow(session, qualification, nowEpochMs, 'qualification');
  validateProjectionWindow(session, policy, nowEpochMs, 'policy');
  validateProjectionWindow(session, resources, nowEpochMs, 'resources');
  requireCondition(qualification.registrySnapshotHash === moduleRegistry.snapshotHash,
    'snapshot_qualification_registry_mismatch');
  requireCondition(qualification.registryPolicyHash === policy.registryPolicyHash,
    'snapshot_registry_policy_mismatch');
  requireCondition(qualification.qualificationSetHash === qualificationSetHash(moduleRegistry),
    'snapshot_qualification_set_mismatch');
  const covered = new Set(moduleRegistry.modules.flatMap((module) => module.capabilityIds));
  requireCondition(policy.requiredCapabilityIds.every((capability) => covered.has(capability)),
    'snapshot_required_capability_unavailable');
  const validUntilMs = Math.min(Date.parse(session.expiresAt), ...projections.map((item) =>
    Date.parse(item.expiresAt)));
  requireCondition(validUntilMs > nowEpochMs, 'snapshot_stale');
  const body = Object.freeze({
    version: 1,
    kind: 'ControlPlaneSnapshotV1',
    status: 'planning_snapshot_current',
    readSessionId: session.readSessionId,
    readBarrierGeneration: session.barrierGeneration,
    readSessionHash: session.sessionHash,
    capturedAt: session.completedAt,
    validUntil: new Date(validUntilMs).toISOString(),
    campaignId: campaign.campaignId,
    campaignRevision: campaign.campaignRevision,
    campaignStateHash: campaign.stateHash,
    databaseIdentityHash: campaign.databaseIdentityHash,
    moduleRegistrySnapshotHash: moduleRegistry.snapshotHash,
    qualificationGeneration: qualification.qualificationGeneration,
    qualificationSetHash: qualification.qualificationSetHash,
    registryPolicyHash: policy.registryPolicyHash,
    policyGeneration: policy.policyGeneration,
    objectiveVersion: policy.objectiveVersion,
    constraintSetHash: policy.constraintSetHash,
    resourceGeneration: resources.resourceGeneration,
    resourceStateHash: resources.resourceStateHash,
    resourcePriceSnapshotHash: resources.resourcePriceSnapshotHash,
    resourceLimit: resources.resourceLimit,
    budgetMicrousd: campaign.budgetMicrousd,
    requiredCapabilityIds: policy.requiredCapabilityIds,
    ...(Object.hasOwn(policy, 'randomSeed') ? { randomSeed: policy.randomSeed } : {}),
    projectionHashes: Object.freeze({
      campaign: campaign.projectionHash,
      qualification: qualification.projectionHash,
      policy: policy.projectionHash,
      resources: resources.projectionHash,
    }),
    authority: Object.freeze({
      productionAuthorized: false,
      writerAuthorityGranted: false,
      providerAuthorityGranted: false,
      releaseAuthorityGranted: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({ ...body, snapshotHash: hashRecord('ControlPlaneSnapshotV1', body) });
}
