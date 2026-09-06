import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { collectPlanningStateSnapshot } from './planning-snapshot-session.mjs';
import { runCollectedBoundedPlanningPipeline } from './collected-bounded-planning-pipeline.mjs';

const INPUT_FIELDS = Object.freeze(['snapshot', 'candidate', 'selection', 'nowEpochMs', 'signal']);
const SNAPSHOT_FIELDS = Object.freeze([
  'request', 'moduleBindings', 'port', 'maximumConcurrency',
  'componentTimeoutMs', 'closeTimeoutMs', 'builderLimits',
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
  if (!Number.isSafeInteger(value) || value < 0) throw failure('session_pipeline_clock_invalid');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw failure('session_pipeline_clock_invalid');
  return Object.freeze({ milliseconds: value, iso: date.toISOString() });
}

export async function runSessionCollectedBoundedPlanningPipeline(input) {
  const root = record(input, INPUT_FIELDS,
    ['snapshot', 'candidate', 'selection', 'nowEpochMs'],
    'session_pipeline_input_invalid');
  const clock = captureClock(root.nowEpochMs);
  const snapshotStage = record(root.snapshot, SNAPSHOT_FIELDS,
    ['request', 'moduleBindings', 'port'], 'session_pipeline_snapshot_stage_invalid');
  const snapshotCollection = await collectPlanningStateSnapshot({
    request: snapshotStage.request,
    moduleBindings: snapshotStage.moduleBindings,
    port: snapshotStage.port,
    nowEpochMs: clock.milliseconds,
    ...(Object.hasOwn(root, 'signal') ? { signal: root.signal } : {}),
    ...Object.fromEntries(Object.entries(snapshotStage).filter(([key]) => ![
      'request', 'moduleBindings', 'port',
    ].includes(key))),
  });

  const planningDecision = await runCollectedBoundedPlanningPipeline({
    snapshot: {
      request: snapshotStage.request,
      moduleBindings: snapshotStage.moduleBindings,
      components: snapshotCollection.snapshot.components,
      ...(Object.hasOwn(snapshotStage, 'builderLimits')
        ? { limits: snapshotStage.builderLimits } : {}),
    },
    candidate: root.candidate,
    selection: root.selection,
    nowEpochMs: clock.milliseconds,
    ...(Object.hasOwn(root, 'signal') ? { signal: root.signal } : {}),
  });
  if (planningDecision.stateSnapshotHash !== snapshotCollection.stateSnapshotHash
    || planningDecision.snapshot.snapshotRequestHash !== snapshotCollection.snapshotRequestHash) {
    throw failure('session_pipeline_snapshot_rebuild_mismatch');
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'SessionCollectedBoundedPlanningDecisionV1',
    status: planningDecision.status,
    verificationStatus: planningDecision.verificationStatus,
    observedAt: clock.iso,
    snapshotCollectionHash: snapshotCollection.collectionHash,
    snapshotRequestHash: snapshotCollection.snapshotRequestHash,
    stateSnapshotHash: snapshotCollection.stateSnapshotHash,
    candidateCollectionHash: planningDecision.candidateCollectionHash,
    candidateSetHash: planningDecision.candidateSetHash,
    planSelectionHash: planningDecision.planSelectionHash,
    verifiedPlanSelectionHash: planningDecision.verifiedPlanSelectionHash,
    planningDecisionHash: planningDecision.planningDecisionHash,
    selectedCandidateIds: planningDecision.selectedCandidateIds,
    expiresAt: planningDecision.expiresAt,
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
    snapshotCollection,
    planningDecision,
    sessionPlanningDecisionHash: hashRecord('SessionCollectedBoundedPlanningDecisionV1', body),
  });
}
