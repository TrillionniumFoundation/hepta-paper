import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildPlanningStateSnapshot } from './snapshot-builder.mjs';
import { collectModuleCandidateFrontier } from './candidate-producer-collection.mjs';
import { selectBoundedGlobalPlan } from './bounded-plan-selector.mjs';
import { verifyFeasiblePlanSelection } from './plan-selection-verifier.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SNAPSHOT_FIELDS = Object.freeze(['request', 'moduleBindings', 'components', 'limits']);
const CANDIDATE_FIELDS = Object.freeze([
  'request', 'moduleBindings', 'producers', 'maximumConcurrency',
  'producerTimeoutMs', 'maximumCandidatesPerProducer',
  'maximumProducerResponseBytes', 'maximumTotalCandidates', 'routerLimits',
]);
const CANDIDATE_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'planningRequestId', 'capabilityId',
  'hardConstraintSetHash', 'objectiveVersion', 'resourcePriceSnapshotHash',
  'candidateLimit', 'deadline', 'allowedSideEffectClasses', 'inputArtifactHashes',
]);
const SELECTION_FIELDS = Object.freeze(['request', 'exactEnumerationLimit']);
const SELECTION_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'selectionRequestId', 'deadline', 'expansionBudget',
  'maximumSelectedCandidates', 'resourceLimits', 'requiredCandidateIds', 'evaluations',
]);
const EVALUATION_FIELDS = Object.freeze([
  'candidateId', 'utilityMicrounits', 'dependencies', 'mutexGroup',
]);
const RESOURCE_FIELDS = Object.freeze([
  'cpuMilliunits', 'gpuMilliunits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd',
]);

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function record(value, allowed, required, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw failure(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(output, key))) throw failure(code);
  return output;
}
function arrayValues(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')
    || keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) throw failure(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}
function text(value, code, maximumBytes = 4096, pattern = null) {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0')
    || (pattern && !pattern.test(value))) throw failure(code);
  return value;
}
function hash(value, code) { return text(value, code, 71, HASH); }
function timestamp(value, code) {
  text(value, code, 64, DATE_TIME);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  return Object.freeze({ source: value, milliseconds });
}
function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}
function canonicalIdentifiers(value, maximum, code) {
  const values = arrayValues(value, maximum, code)
    .map((item) => text(item, code, 256, IDENTIFIER)).sort(compareText);
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values);
}
function canonicalHashes(value, maximum, code) {
  const values = arrayValues(value, maximum, code)
    .map((item) => hash(item, code)).sort(compareText);
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values);
}
function captureClock(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('collected_pipeline_clock_invalid');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw failure('collected_pipeline_clock_invalid');
  return Object.freeze({ milliseconds: value, iso: date.toISOString() });
}
function captureResourceLimits(value) {
  const data = record(value, RESOURCE_FIELDS, RESOURCE_FIELDS,
    'collected_pipeline_resource_limits_invalid');
  return Object.freeze(Object.fromEntries(RESOURCE_FIELDS.map((field) => [
    field,
    safeInteger(data[field], 0, Number.MAX_SAFE_INTEGER,
      `collected_pipeline_resource_limit_invalid:${field}`),
  ])));
}

function planningRequest(template, stateSnapshotHash, snapshotExpiry) {
  const data = record(template, CANDIDATE_REQUEST_FIELDS, CANDIDATE_REQUEST_FIELDS,
    'collected_pipeline_planning_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'PlanningRequestV1') {
    throw failure('collected_pipeline_planning_request_identity_invalid');
  }
  const deadline = timestamp(data.deadline, 'collected_pipeline_planning_deadline_invalid');
  if (deadline.milliseconds > Date.parse(snapshotExpiry)) {
    throw failure('collected_pipeline_planning_deadline_exceeds_snapshot');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: text(data.planningRequestId,
      'collected_pipeline_planning_request_id_invalid', 256, IDENTIFIER),
    stateSnapshotHash,
    capabilityId: text(data.capabilityId,
      'collected_pipeline_capability_invalid', 256, IDENTIFIER),
    hardConstraintSetHash: hash(data.hardConstraintSetHash,
      'collected_pipeline_constraints_invalid'),
    objectiveVersion: text(data.objectiveVersion,
      'collected_pipeline_objective_invalid', 256, IDENTIFIER),
    resourcePriceSnapshotHash: hash(data.resourcePriceSnapshotHash,
      'collected_pipeline_prices_invalid'),
    candidateLimit: safeInteger(data.candidateLimit, 1, 4096,
      'collected_pipeline_candidate_limit_invalid'),
    deadline: deadline.source,
    allowedSideEffectClasses: canonicalIdentifiers(data.allowedSideEffectClasses, 64,
      'collected_pipeline_side_effect_classes_invalid'),
    inputArtifactHashes: canonicalHashes(data.inputArtifactHashes, 4096,
      'collected_pipeline_input_artifacts_invalid'),
  });
}

function evaluation(value, candidateById) {
  const data = record(value, EVALUATION_FIELDS, EVALUATION_FIELDS,
    'collected_pipeline_evaluation_invalid');
  const candidateId = text(data.candidateId,
    'collected_pipeline_evaluation_candidate_invalid', 256, IDENTIFIER);
  const candidate = candidateById.get(candidateId);
  if (!candidate) throw failure('collected_pipeline_evaluation_candidate_unknown');
  return Object.freeze({
    candidateId,
    candidatePayloadHash: candidate.candidatePayloadHash,
    utilityMicrounits: safeInteger(data.utilityMicrounits,
      Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER,
      'collected_pipeline_evaluation_utility_invalid'),
    dependencies: canonicalIdentifiers(data.dependencies, 4096,
      'collected_pipeline_evaluation_dependencies_invalid'),
    mutexGroup: data.mutexGroup === null ? null : text(data.mutexGroup,
      'collected_pipeline_evaluation_mutex_invalid', 256, IDENTIFIER),
  });
}

function selectionRequest(template, frontier, snapshotExpiry) {
  const data = record(template, SELECTION_REQUEST_FIELDS, SELECTION_REQUEST_FIELDS,
    'collected_pipeline_selection_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'GlobalPlanSelectionRequestV1') {
    throw failure('collected_pipeline_selection_request_identity_invalid');
  }
  const deadline = timestamp(data.deadline, 'collected_pipeline_selection_deadline_invalid');
  if (deadline.milliseconds > Date.parse(snapshotExpiry)) {
    throw failure('collected_pipeline_selection_deadline_exceeds_snapshot');
  }
  const candidateById = new Map(frontier.candidates.map((candidate) => [
    candidate.candidateId, candidate,
  ]));
  const evaluations = arrayValues(data.evaluations, 4096,
    'collected_pipeline_evaluations_invalid')
    .map((item) => evaluation(item, candidateById))
    .sort((left, right) => compareText(left.candidateId, right.candidateId));
  if (new Set(evaluations.map((item) => item.candidateId)).size !== evaluations.length) {
    throw failure('collected_pipeline_evaluation_duplicate');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'GlobalPlanSelectionRequestV1',
    selectionRequestId: text(data.selectionRequestId,
      'collected_pipeline_selection_request_id_invalid', 256, IDENTIFIER),
    planningRequestHash: frontier.planningRequestHash,
    stateSnapshotHash: frontier.stateSnapshotHash,
    candidateSetHash: frontier.candidateSetHash,
    hardConstraintSetHash: frontier.hardConstraintSetHash,
    objectiveVersion: frontier.objectiveVersion,
    resourcePriceSnapshotHash: frontier.resourcePriceSnapshotHash,
    deadline: deadline.source,
    expansionBudget: safeInteger(data.expansionBudget, 1, 1_000_000,
      'collected_pipeline_expansion_budget_invalid'),
    maximumSelectedCandidates: safeInteger(data.maximumSelectedCandidates, 0, 4096,
      'collected_pipeline_selection_limit_invalid'),
    resourceLimits: captureResourceLimits(data.resourceLimits),
    requiredCandidateIds: canonicalIdentifiers(data.requiredCandidateIds, 4096,
      'collected_pipeline_required_candidates_invalid'),
    evaluations: Object.freeze(evaluations),
  });
}

export async function runCollectedBoundedPlanningPipeline(input) {
  const root = record(input, ['snapshot', 'candidate', 'selection', 'nowEpochMs', 'signal'],
    ['snapshot', 'candidate', 'selection', 'nowEpochMs'], 'collected_pipeline_input_invalid');
  const clock = captureClock(root.nowEpochMs);
  const snapshotStage = record(root.snapshot, SNAPSHOT_FIELDS,
    ['request', 'moduleBindings', 'components'], 'collected_pipeline_snapshot_stage_invalid');
  const snapshot = buildPlanningStateSnapshot({
    request: snapshotStage.request,
    moduleBindings: snapshotStage.moduleBindings,
    components: snapshotStage.components,
    nowEpochMs: clock.milliseconds,
    ...(Object.hasOwn(snapshotStage, 'limits') ? { limits: snapshotStage.limits } : {}),
  });

  const candidateStage = record(root.candidate, CANDIDATE_FIELDS,
    ['request', 'moduleBindings', 'producers'], 'collected_pipeline_candidate_stage_invalid');
  const planRequest = planningRequest(candidateStage.request,
    snapshot.stateSnapshotHash, snapshot.expiresAt);
  const collection = await collectModuleCandidateFrontier({
    request: planRequest,
    moduleBindings: candidateStage.moduleBindings,
    producers: candidateStage.producers,
    nowEpochMs: clock.milliseconds,
    ...(Object.hasOwn(root, 'signal') ? { signal: root.signal } : {}),
    ...Object.fromEntries(Object.entries(candidateStage).filter(([key]) => ![
      'request', 'moduleBindings', 'producers',
    ].includes(key))),
  });

  const selectionStage = record(root.selection, SELECTION_FIELDS,
    ['request'], 'collected_pipeline_selection_stage_invalid');
  const selectRequest = selectionRequest(selectionStage.request,
    collection.frontier, snapshot.expiresAt);
  const selection = selectBoundedGlobalPlan({
    frontier: collection.frontier,
    request: selectRequest,
    nowEpochMs: clock.milliseconds,
  });
  const verifiedSelection = ['optimal', 'bounded_feasible'].includes(selection.status)
    ? verifyFeasiblePlanSelection({
      frontier: collection.frontier,
      request: selectRequest,
      selection,
      nowEpochMs: clock.milliseconds,
      ...(Object.hasOwn(selectionStage, 'exactEnumerationLimit')
        ? { exactEnumerationLimit: selectionStage.exactEnumerationLimit } : {}),
    }) : null;
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CollectedBoundedPlanningDecisionV1',
    status: selection.status,
    verificationStatus: verifiedSelection?.status ?? 'no_feasible_selection_receipt',
    observedAt: clock.iso,
    snapshotRequestHash: snapshot.snapshotRequestHash,
    stateSnapshotHash: snapshot.stateSnapshotHash,
    planningRequestHash: collection.planningRequestHash,
    moduleBindingSetHash: collection.moduleBindingSetHash,
    candidateCollectionHash: collection.collectionHash,
    candidateSetHash: collection.candidateSetHash,
    selectionRequestHash: selection.selectionRequestHash,
    planSelectionHash: selection.planSelectionHash,
    verifiedPlanSelectionHash: verifiedSelection?.verifiedPlanSelectionHash ?? null,
    selectedCandidateIds: selection.selectedCandidateIds,
    expiresAt: new Date(Math.min(
      Date.parse(snapshot.expiresAt),
      Date.parse(collection.frontier.expiresAt),
      Date.parse(selectRequest.deadline),
    )).toISOString(),
    executionEligible: false,
    authority: Object.freeze({
      productionAuthorized: false,
      providerAuthorized: false,
      executionAuthorized: false,
      writerAuthorityGranted: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({
    ...body,
    snapshot,
    planningRequest: planRequest,
    candidateCollection: collection,
    selectionRequest: selectRequest,
    selection,
    verifiedSelection,
    planningDecisionHash: hashRecord('CollectedBoundedPlanningDecisionV1', body),
  });
}
