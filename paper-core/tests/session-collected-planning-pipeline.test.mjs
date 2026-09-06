import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';
import test from 'node:test';
import { createPlanningSnapshotComponent }
  from '../../paper-application/orchestration/snapshot-builder.mjs';
import { createActionCandidate }
  from '../../paper-application/orchestration/candidate-router.mjs';
import { runSessionCollectedBoundedPlanningPipeline }
  from '../../paper-application/orchestration/session-collected-planning-pipeline.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');

function fixture(options = {}) {
  const state = { opened: 0, reads: 0, closed: 0, producers: 0, observedSnapshotHash: null };
  const snapshotRequest = {
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: 'session-pipeline-snapshot',
    readTransactionHash: H('a'),
    consistencyEpoch: 1,
    deadline: '2026-09-07T00:00:00Z',
    requiredComponents: [{
      componentId: 'campaign',
      componentKind: 'campaign-state',
      minimumRevision: 1,
      maximumAgeMs: 3600000,
      maximumPayloadBytes: 65536,
    }],
  };
  const snapshotBinding = {
    moduleId: 'module.readonly-control',
    moduleVersion: '1.0.0',
    projectionKinds: ['campaign-state'],
    qualificationSubjectHash: H('b'),
    validUntil: '2026-09-08T00:00:00Z',
  };
  const candidateBinding = {
    moduleId: 'module.alpha',
    moduleVersion: '1.0.0',
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H('c'),
    validUntil: '2026-09-08T00:00:00Z',
  };
  const port = {
    kind: 'PlanningSnapshotReadPortV1',
    open(input) {
      state.opened += 1;
      return {
        kind: 'PlanningSnapshotReadSessionV1',
        readTransactionHash: input.snapshotRequest.readTransactionHash,
        consistencyEpoch: input.snapshotRequest.consistencyEpoch,
        readComponent(readInput) {
          state.reads += 1;
          if (options.readFailure) throw new Error('private read failure');
          if (options.neverRead) return new Promise(() => {});
          return {
            schemaVersion: 1,
            kind: 'PlanningSnapshotComponentResponseV1',
            status: 'complete',
            component: createPlanningSnapshotComponent({
              schemaVersion: 1,
              kind: 'PlanningSnapshotComponentV1',
              componentId: readInput.requirement.componentId,
              componentKind: readInput.requirement.componentKind,
              sourceModuleId: readInput.moduleBinding.moduleId,
              sourceModuleVersion: readInput.moduleBinding.moduleVersion,
              sourceQualificationHash: readInput.moduleBinding.qualificationSubjectHash,
              readTransactionHash: readInput.snapshotRequest.readTransactionHash,
              consistencyEpoch: readInput.snapshotRequest.consistencyEpoch,
              revision: 1,
              generation: 1,
              capturedAt: '2026-09-05T23:59:00Z',
              expiresAt: '2026-09-07T00:00:00Z',
              payload: { revision: 1 },
            }),
            authority: {
              productionAuthorized: false,
              writerAuthorityGranted: false,
              providerAuthorized: false,
              externalAuthorityClaimed: false,
            },
          };
        },
        close() {
          state.closed += 1;
          if (options.closeFailure) throw new Error('private close failure');
        },
      };
    },
  };
  const specifications = options.empty ? [] : [{ id: 'candidate-a', utility: 7 }];
  const producer = {
    moduleId: candidateBinding.moduleId,
    moduleVersion: candidateBinding.moduleVersion,
    produce(input) {
      state.producers += 1;
      state.observedSnapshotHash = input.planningRequest.stateSnapshotHash;
      if (options.neverProduce) return new Promise(() => {});
      const candidates = specifications.map((item) => createActionCandidate({
        schemaVersion: 1,
        kind: 'ActionCandidateV1',
        candidateId: item.id,
        planningRequestId: input.planningRequest.planningRequestId,
        stateSnapshotHash: input.planningRequest.stateSnapshotHash,
        moduleId: candidateBinding.moduleId,
        moduleVersion: candidateBinding.moduleVersion,
        capabilityId: input.planningRequest.capabilityId,
        resourceVector: {
          cpuUnits: 1, gpuUnits: 0, memoryMiB: 0, storageBytes: 0,
          tokenCount: 0, maximumCostMicrousd: 0,
        },
        duration: {}, cost: {}, value: {}, risk: {},
        preconditions: [], dependencyEffects: [], sideEffectClass: 'none',
        irreversibleBoundary: null, rollbackClass: 'no_effect',
        expiresAt: '2026-09-06T18:00:00Z', inputSchema: null, outputSchema: null,
        singletonReason: 'only_feasible_candidate',
      }));
      return {
        schemaVersion: 1,
        kind: 'ModuleCandidateResponseV1',
        status: 'complete',
        moduleId: candidateBinding.moduleId,
        moduleVersion: candidateBinding.moduleVersion,
        planningRequestHash: input.planningRequestHash,
        candidates,
        emptyReason: candidates.length ? null : 'no_local_candidate',
        authority: {
          productionAuthorized: false,
          providerAuthorized: false,
          writerAuthorityGranted: false,
          externalAuthorityClaimed: false,
        },
      };
    },
  };
  return {
    state,
    input: {
      snapshot: {
        request: snapshotRequest,
        moduleBindings: [snapshotBinding],
        port,
        componentTimeoutMs: options.componentTimeoutMs || 200,
        closeTimeoutMs: 200,
      },
      candidate: {
        request: {
          schemaVersion: 1,
          kind: 'PlanningRequestV1',
          planningRequestId: 'session-pipeline-plan',
          capabilityId: 'CAP-MOD-CANDIDATES',
          hardConstraintSetHash: H('d'),
          objectiveVersion: 'objective-v1',
          resourcePriceSnapshotHash: H('e'),
          candidateLimit: 1,
          deadline: '2026-09-07T00:00:00Z',
          allowedSideEffectClasses: ['none'],
          inputArtifactHashes: [],
        },
        moduleBindings: [candidateBinding],
        producers: [producer],
        producerTimeoutMs: options.producerTimeoutMs || 200,
      },
      selection: {
        request: {
          schemaVersion: 1,
          kind: 'GlobalPlanSelectionRequestV1',
          selectionRequestId: 'session-pipeline-selection',
          deadline: '2026-09-06T12:00:00Z',
          expansionBudget: options.expansionBudget || 100,
          maximumSelectedCandidates: specifications.length,
          resourceLimits: {
            cpuMilliunits: 1000, gpuMilliunits: 0, memoryMiB: 0,
            storageBytes: 0, tokenCount: 0, maximumCostMicrousd: 0,
          },
          requiredCandidateIds: [],
          evaluations: specifications.map((item) => ({
            candidateId: item.id,
            utilityMicrounits: item.utility,
            dependencies: [],
            mutexGroup: null,
          })),
        },
      },
      nowEpochMs: NOW,
    },
  };
}

test('closed snapshot session precedes producer collection and exact verification', async () => {
  const { input, state } = fixture();
  const decision = await runSessionCollectedBoundedPlanningPipeline(input);
  assert.equal(state.opened, 1);
  assert.equal(state.reads, 1);
  assert.equal(state.closed, 1);
  assert.equal(state.producers, 1);
  assert.equal(state.observedSnapshotHash, decision.stateSnapshotHash);
  assert.equal(decision.snapshotCollection.sessionClosed, true);
  assert.equal(decision.planningDecision.verifiedSelection.exactOptimalityVerified, true);
  assert.deepEqual(decision.selectedCandidateIds, ['candidate-a']);
  assert.equal(decision.executionEligible, false);
});

test('snapshot read failure prevents every candidate producer invocation', async () => {
  const { input, state } = fixture({ readFailure: true });
  await assert.rejects(runSessionCollectedBoundedPlanningPipeline(input),
    { code: 'planning_snapshot_component_failed:campaign' });
  assert.equal(state.closed, 1);
  assert.equal(state.producers, 0);
});

test('snapshot close failure prevents producer invocation and final decision', async () => {
  const { input, state } = fixture({ closeFailure: true });
  await assert.rejects(runSessionCollectedBoundedPlanningPipeline(input),
    { code: 'planning_snapshot_session_close_failed' });
  assert.equal(state.closed, 1);
  assert.equal(state.producers, 0);
});

test('snapshot collection hash and downstream planning hash are both bound', async () => {
  const decision = await runSessionCollectedBoundedPlanningPipeline(fixture().input);
  assert.equal(decision.snapshotCollectionHash, decision.snapshotCollection.collectionHash);
  assert.equal(decision.planningDecisionHash, decision.planningDecision.planningDecisionHash);
  assert.match(decision.sessionPlanningDecisionHash, /^sha256:[0-9a-f]{64}$/u);
});

test('all-empty producer response remains an exact non-authorizing empty plan', async () => {
  const decision = await runSessionCollectedBoundedPlanningPipeline(fixture({ empty: true }).input);
  assert.equal(decision.status, 'optimal');
  assert.deepEqual(decision.selectedCandidateIds, []);
  assert.equal(decision.planningDecision.verifiedSelection.exactOptimalityVerified, true);
});

test('bounded selector state is preserved through the session wrapper', async () => {
  const decision = await runSessionCollectedBoundedPlanningPipeline(
    fixture({ expansionBudget: 1 }).input,
  );
  assert.equal(decision.status, 'bounded_feasible');
  assert.equal(decision.planningDecision.selection.frontierExhausted, false);
  assert.equal(decision.executionEligible, false);
});

test('outer cancellation during snapshot acquisition returns no producer work', async () => {
  const { input, state } = fixture({ neverRead: true, componentTimeoutMs: 1000 });
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
  const pending = runSessionCollectedBoundedPlanningPipeline({ ...input, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'planning_snapshot_collection_aborted' });
  assert.equal(state.closed, 1);
  assert.equal(state.producers, 0);
});

test('outer cancellation during producer collection preserves the closed snapshot receipt but returns no decision', async () => {
  const { input, state } = fixture({ neverProduce: true, producerTimeoutMs: 1000 });
  const controller = new AbortController();
  const pending = runSessionCollectedBoundedPlanningPipeline({ ...input, signal: controller.signal });
  while (state.producers === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(pending, { code: 'candidate_collection_aborted' });
  assert.equal(state.closed, 1);
});

test('malformed snapshot stage accessors fail before port open', async () => {
  const { input, state } = fixture();
  let calls = 0;
  const snapshot = { ...input.snapshot };
  Object.defineProperty(snapshot, 'request', {
    enumerable: true,
    get() { calls += 1; return input.snapshot.request; },
  });
  await assert.rejects(runSessionCollectedBoundedPlanningPipeline({ ...input, snapshot }),
    { code: 'session_pipeline_snapshot_stage_invalid' });
  assert.equal(calls, 0);
  assert.equal(state.opened, 0);
});

test('wrapper output is deeply immutable and authority-false', async () => {
  const decision = await runSessionCollectedBoundedPlanningPipeline(fixture().input);
  assert.deepEqual(decision.authority, {
    productionAuthorized: false,
    providerAuthorized: false,
    executionAuthorized: false,
    writerAuthorityGranted: false,
    externalAuthorityClaimed: false,
  });
  assert.throws(() => { decision.authority.executionAuthorized = true; }, TypeError);
  assert.throws(() => { decision.snapshotCollection.snapshot.components.push({}); }, TypeError);
  assert.throws(() => { decision.planningDecision.selectedCandidateIds.push('other'); }, TypeError);
});
