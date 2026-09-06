import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildPlanningStateSnapshot } from './snapshot-builder.mjs';
import { routeActionCandidates } from './candidate-router.mjs';
import { selectBoundedGlobalPlan } from './bounded-plan-selector.mjs';

const SNAPSHOT_STAGE_FIELDS = Object.freeze(['request', 'moduleBindings', 'components', 'limits']);
const CANDIDATE_STAGE_FIELDS = Object.freeze(['request', 'moduleBindings', 'candidates', 'emptyReason', 'limits']);
const CANDIDATE_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'planningRequestId', 'capabilityId',
  'hardConstraintSetHash', 'objectiveVersion', 'resourcePriceSnapshotHash',
  'candidateLimit', 'deadline', 'allowedSideEffectClasses', 'inputArtifactHashes',
]);
const SELECTION_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'selectionRequestId', 'deadline', 'expansionBudget',
  'maximumSelectedCandidates', 'resourceLimits', 'requiredCandidateIds', 'evaluations',
]);

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

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

function captureClock(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('planning_pipeline_clock_invalid');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw failure('planning_pipeline_clock_invalid');
  return Object.freeze({ milliseconds: value, iso: date.toISOString() });
}

function captureTemplate(value, fields, code) {
  return record(value, fields, fields, code);
}

function candidateRequest(template, snapshot) {
  const data = captureTemplate(template, CANDIDATE_REQUEST_FIELDS,
    'planning_pipeline_candidate_request_invalid');
  const request = Object.freeze({
    schemaVersion: data.schemaVersion,
    kind: data.kind,
    planningRequestId: data.planningRequestId,
    stateSnapshotHash: snapshot.stateSnapshotHash,
    capabilityId: data.capabilityId,
    hardConstraintSetHash: data.hardConstraintSetHash,
    objectiveVersion: data.objectiveVersion,
    resourcePriceSnapshotHash: data.resourcePriceSnapshotHash,
    candidateLimit: data.candidateLimit,
    deadline: data.deadline,
    allowedSideEffectClasses: data.allowedSideEffectClasses,
    inputArtifactHashes: data.inputArtifactHashes,
  });
  if (Date.parse(request.deadline) > Date.parse(snapshot.expiresAt)) {
    throw failure('planning_pipeline_candidate_deadline_exceeds_snapshot');
  }
  return request;
}

function selectionRequest(template, frontier, snapshot) {
  const data = captureTemplate(template, SELECTION_REQUEST_FIELDS,
    'planning_pipeline_selection_request_invalid');
  const request = Object.freeze({
    schemaVersion: data.schemaVersion,
    kind: data.kind,
    selectionRequestId: data.selectionRequestId,
    planningRequestHash: frontier.planningRequestHash,
    stateSnapshotHash: frontier.stateSnapshotHash,
    candidateSetHash: frontier.candidateSetHash,
    hardConstraintSetHash: frontier.hardConstraintSetHash,
    objectiveVersion: frontier.objectiveVersion,
    resourcePriceSnapshotHash: frontier.resourcePriceSnapshotHash,
    deadline: data.deadline,
    expansionBudget: data.expansionBudget,
    maximumSelectedCandidates: data.maximumSelectedCandidates,
    resourceLimits: data.resourceLimits,
    requiredCandidateIds: data.requiredCandidateIds,
    evaluations: data.evaluations,
  });
  if (Date.parse(request.deadline) > Date.parse(snapshot.expiresAt)) {
    throw failure('planning_pipeline_selection_deadline_exceeds_snapshot');
  }
  return request;
}

export function runBoundedPlanningPipeline(input) {
  const root = record(input, ['snapshot', 'candidate', 'selection', 'nowEpochMs'],
    ['snapshot', 'candidate', 'selection', 'nowEpochMs'], 'planning_pipeline_input_invalid');
  const clock = captureClock(root.nowEpochMs);

  const snapshotStage = record(root.snapshot, SNAPSHOT_STAGE_FIELDS,
    ['request', 'moduleBindings', 'components'], 'planning_pipeline_snapshot_stage_invalid');
  const snapshot = buildPlanningStateSnapshot({
    request: snapshotStage.request,
    moduleBindings: snapshotStage.moduleBindings,
    components: snapshotStage.components,
    nowEpochMs: clock.milliseconds,
    ...(Object.hasOwn(snapshotStage, 'limits') ? { limits: snapshotStage.limits } : {}),
  });

  const candidateStage = record(root.candidate, CANDIDATE_STAGE_FIELDS,
    ['request', 'moduleBindings', 'candidates'], 'planning_pipeline_candidate_stage_invalid');
  const planningRequest = candidateRequest(candidateStage.request, snapshot);
  const frontier = routeActionCandidates({
    request: planningRequest,
    moduleBindings: candidateStage.moduleBindings,
    candidates: candidateStage.candidates,
    nowEpochMs: clock.milliseconds,
    ...(Object.hasOwn(candidateStage, 'emptyReason') ? { emptyReason: candidateStage.emptyReason } : {}),
    ...(Object.hasOwn(candidateStage, 'limits') ? { limits: candidateStage.limits } : {}),
  });

  const selectionStage = record(root.selection, ['request'], ['request'],
    'planning_pipeline_selection_stage_invalid');
  const selectRequest = selectionRequest(selectionStage.request, frontier, snapshot);
  const selection = selectBoundedGlobalPlan({
    frontier,
    request: selectRequest,
    nowEpochMs: clock.milliseconds,
  });

  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'BoundedPlanningDecisionV1',
    status: selection.status,
    observedAt: clock.iso,
    snapshotRequestHash: snapshot.snapshotRequestHash,
    stateSnapshotHash: snapshot.stateSnapshotHash,
    planningRequestHash: frontier.planningRequestHash,
    candidateSetHash: frontier.candidateSetHash,
    selectionRequestHash: selection.selectionRequestHash,
    planSelectionHash: selection.planSelectionHash,
    selectedCandidateIds: selection.selectedCandidateIds,
    expiresAt: new Date(Math.min(
      Date.parse(snapshot.expiresAt),
      Date.parse(frontier.expiresAt),
      Date.parse(selectRequest.deadline),
    )).toISOString(),
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
    frontier,
    selection,
    planningDecisionHash: hashRecord('BoundedPlanningDecisionV1', body),
  });
}
