import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';
import test from 'node:test';
import {
  createPlanningSnapshotComponent,
} from '../../paper-application/orchestration/snapshot-builder.mjs';
import { createActionCandidate } from '../../paper-application/orchestration/candidate-router.mjs';
import {
  runCollectedBoundedPlanningPipeline,
} from '../../paper-application/orchestration/collected-bounded-planning-pipeline.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');

function fixture(specifications = [
  { module: 'module.a', id: 'a', utility: 7 },
  { module: 'module.b', id: 'b', utility: 5 },
], options = {}) {
  const snapshotRequest = {
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: 'collected-snapshot',
    readTransactionHash: options.readTransactionHash || H('1'),
    consistencyEpoch: options.consistencyEpoch || 1,
    deadline: options.snapshotDeadline || '2026-09-07T00:00:00Z',
    requiredComponents: [{
      componentId: 'campaign',
      componentKind: 'campaign-state',
      minimumRevision: options.minimumRevision || 1,
      maximumAgeMs: 60 * 60 * 1000,
      maximumPayloadBytes: 64 * 1024,
    }],
  };
  const snapshotBinding = {
    moduleId: 'module.readonly-control',
    moduleVersion: '1.0.0',
    projectionKinds: ['campaign-state'],
    qualificationSubjectHash: H('2'),
    validUntil: '2026-09-08T00:00:00Z',
  };
  const snapshotComponent = createPlanningSnapshotComponent({
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentV1',
    componentId: 'campaign',
    componentKind: 'campaign-state',
    sourceModuleId: snapshotBinding.moduleId,
    sourceModuleVersion: snapshotBinding.moduleVersion,
    sourceQualificationHash: snapshotBinding.qualificationSubjectHash,
    readTransactionHash: snapshotRequest.readTransactionHash,
    consistencyEpoch: snapshotRequest.consistencyEpoch,
    revision: options.revision || 1,
    generation: options.generation || 1,
    capturedAt: '2026-09-05T23:59:00Z',
    expiresAt: options.snapshotExpiry || '2026-09-07T00:00:00Z',
    payload: options.payload || { revision: options.revision || 1 },
  });
  const moduleIds = [...new Set(specifications.map((item) => item.module))].sort();
  const candidateBindings = moduleIds.map((moduleId, index) => ({
    moduleId,
    moduleVersion: '1.0.0',
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H(String.fromCharCode(51 + index)),
    validUntil: '2026-09-08T00:00:00Z',
  }));
  const bindingById = new Map(candidateBindings.map((item) => [item.moduleId, item]));
  const producers = candidateBindings.map((moduleBinding) => ({
    moduleId: moduleBinding.moduleId,
    moduleVersion: moduleBinding.moduleVersion,
    produce(input) {
      if (options.producerFailure === moduleBinding.moduleId) {
        throw new Error('private producer failure');
      }
      if (options.neverSettle === moduleBinding.moduleId) {
        return new Promise((resolve) => {
          addAbortListener(input.signal, () => resolve({
            schemaVersion: 1,
            kind: 'ModuleCandidateResponseV1',
            status: 'partial',
            moduleId: moduleBinding.moduleId,
            moduleVersion: moduleBinding.moduleVersion,
            planningRequestHash: input.planningRequestHash,
            candidates: [],
            emptyReason: 'aborted',
            authority: {
              productionAuthorized: false,
              providerAuthorized: false,
              writerAuthorityGranted: false,
              externalAuthorityClaimed: false,
            },
          }));
        });
      }
      const local = specifications.filter((item) => item.module === moduleBinding.moduleId)
        .map((item) => createActionCandidate({
          schemaVersion: 1,
          kind: 'ActionCandidateV1',
          candidateId: item.id,
          planningRequestId: input.planningRequest.planningRequestId,
          stateSnapshotHash: options.staleProducer === moduleBinding.moduleId
            ? H('9') : input.planningRequest.stateSnapshotHash,
          moduleId: moduleBinding.moduleId,
          moduleVersion: moduleBinding.moduleVersion,
          capabilityId: input.planningRequest.capabilityId,
          resourceVector: {
            cpuUnits: item.cpuUnits ?? 1,
            gpuUnits: 0,
            memoryMiB: item.memoryMiB ?? 0,
            storageBytes: 0,
            tokenCount: 0,
            maximumCostMicrousd: 0,
          },
          duration: {},
          cost: {},
          value: {},
          risk: {},
          preconditions: [],
          dependencyEffects: [],
          sideEffectClass: 'none',
          irreversibleBoundary: null,
          rollbackClass: 'no_effect',
          expiresAt: '2026-09-06T18:00:00Z',
          inputSchema: null,
          outputSchema: null,
          singletonReason: specifications.length === 1 ? 'only_feasible_candidate' : null,
        }));
      return {
        schemaVersion: 1,
        kind: 'ModuleCandidateResponseV1',
        status: 'complete',
        moduleId: moduleBinding.moduleId,
        moduleVersion: moduleBinding.moduleVersion,
        planningRequestHash: input.planningRequestHash,
        candidates: local,
        emptyReason: local.length ? null : 'no_local_candidate',
        authority: {
          productionAuthorized: false,
          providerAuthorized: false,
          writerAuthorityGranted: false,
          externalAuthorityClaimed: false,
        },
      };
    },
  }));
  const candidateRequest = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'collected-plan',
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: options.hardConstraintSetHash || H('6'),
    objectiveVersion: options.objectiveVersion || 'objective-v1',
    resourcePriceSnapshotHash: options.resourcePriceSnapshotHash || H('7'),
    candidateLimit: Math.max(1, specifications.length || 1),
    deadline: options.candidateDeadline || '2026-09-07T00:00:00Z',
    allowedSideEffectClasses: ['none'],
    inputArtifactHashes: [],
  };
  const selectionRequest = {
    schemaVersion: 1,
    kind: 'GlobalPlanSelectionRequestV1',
    selectionRequestId: 'collected-selection',
    deadline: options.selectionDeadline || '2026-09-06T12:00:00Z',
    expansionBudget: options.expansionBudget ?? 1000,
    maximumSelectedCandidates: options.maximumSelectedCandidates ?? specifications.length,
    resourceLimits: {
      cpuMilliunits: options.cpuMilliunits ?? 1000,
      gpuMilliunits: 0,
      memoryMiB: 100,
      storageBytes: 0,
      tokenCount: 0,
      maximumCostMicrousd: 0,
    },
    requiredCandidateIds: options.requiredCandidateIds || [],
    evaluations: specifications.map((item) => ({
      candidateId: item.id,
      utilityMicrounits: item.utility,
      dependencies: item.dependencies || [],
      mutexGroup: item.mutexGroup || null,
    })),
  };
  return {
    bindingById,
    input: {
      snapshot: {
        request: snapshotRequest,
        moduleBindings: [snapshotBinding],
        components: [snapshotComponent],
      },
      candidate: {
        request: candidateRequest,
        moduleBindings: candidateBindings,
        producers,
        producerTimeoutMs: options.producerTimeoutMs || 200,
        maximumConcurrency: options.maximumConcurrency || 2,
      },
      selection: {
        request: selectionRequest,
        ...(options.exactEnumerationLimit !== undefined
          ? { exactEnumerationLimit: options.exactEnumerationLimit } : {}),
      },
      nowEpochMs: NOW,
    },
  };
}

test('pipeline issues the internally derived request, selects and independently verifies', async () => {
  const { input } = fixture();
  const decision = await runCollectedBoundedPlanningPipeline(input);
  assert.equal(decision.status, 'optimal');
  assert.deepEqual(decision.selectedCandidateIds, ['a']);
  assert.equal(decision.candidateCollection.frontier.stateSnapshotHash,
    decision.snapshot.stateSnapshotHash);
  assert.equal(decision.selection.candidateSetHash,
    decision.candidateCollection.candidateSetHash);
  assert.equal(decision.verifiedSelection.exactOptimalityVerified, true);
  assert.equal(decision.verifiedSelection.sourceOptimalityClaimAccepted, true);
  assert.equal(decision.executionEligible, false);
});

test('selection payload hashes are injected from collected candidates, not accepted from caller', async () => {
  const { input } = fixture();
  await assert.rejects(runCollectedBoundedPlanningPipeline({
    ...input,
    selection: {
      ...input.selection,
      request: {
        ...input.selection.request,
        evaluations: input.selection.request.evaluations.map((item) => ({
          ...item,
          candidatePayloadHash: H('9'),
        })),
      },
    },
  }), { code: 'collected_pipeline_evaluation_invalid' });
});

test('caller cannot inject snapshot or frontier identities into request templates', async () => {
  const { input } = fixture();
  await assert.rejects(runCollectedBoundedPlanningPipeline({
    ...input,
    candidate: {
      ...input.candidate,
      request: { ...input.candidate.request, stateSnapshotHash: H('9') },
    },
  }), { code: 'collected_pipeline_planning_request_invalid' });
  await assert.rejects(runCollectedBoundedPlanningPipeline({
    ...input,
    selection: {
      ...input.selection,
      request: { ...input.selection.request, candidateSetHash: H('9') },
    },
  }), { code: 'collected_pipeline_selection_request_invalid' });
});

test('producer failure or stale candidate returns no partial decision', async () => {
  await assert.rejects(runCollectedBoundedPlanningPipeline(
    fixture(undefined, { producerFailure: 'module.a' }).input,
  ), { code: 'candidate_producer_failed:module.a' });
  await assert.rejects(runCollectedBoundedPlanningPipeline(
    fixture(undefined, { staleProducer: 'module.a' }).input,
  ), { code: 'candidate_producer_failed:module.a' });
});

test('producer timeout remains a collection failure, never an empty frontier', async () => {
  await assert.rejects(runCollectedBoundedPlanningPipeline(
    fixture(undefined, {
      neverSettle: 'module.a',
      producerTimeoutMs: 25,
    }).input,
  ), { code: 'candidate_producer_timeout:module.a' });
});

test('outer cancellation rejects even when an earlier listener suppresses normal propagation', async () => {
  const { input } = fixture(undefined, { neverSettle: 'module.a', producerTimeoutMs: 1000 });
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
  const pending = runCollectedBoundedPlanningPipeline({ ...input, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'candidate_collection_aborted' });
});

test('all producers may explicitly return empty and yield an exact empty decision', async () => {
  const specifications = [];
  const { input } = fixture(specifications, { maximumSelectedCandidates: 0 });
  input.candidate.moduleBindings = [
    {
      moduleId: 'module.a', moduleVersion: '1.0.0',
      capabilityIds: ['CAP-MOD-CANDIDATES'], qualificationSubjectHash: H('3'),
      validUntil: '2026-09-08T00:00:00Z',
    },
  ];
  input.candidate.producers = [{
    moduleId: 'module.a', moduleVersion: '1.0.0',
    produce: ({ planningRequestHash }) => ({
      schemaVersion: 1,
      kind: 'ModuleCandidateResponseV1',
      status: 'complete',
      moduleId: 'module.a',
      moduleVersion: '1.0.0',
      planningRequestHash,
      candidates: [],
      emptyReason: 'no_local_candidate',
      authority: {
        productionAuthorized: false,
        providerAuthorized: false,
        writerAuthorityGranted: false,
        externalAuthorityClaimed: false,
      },
    }),
  }];
  const decision = await runCollectedBoundedPlanningPipeline(input);
  assert.equal(decision.status, 'optimal');
  assert.deepEqual(decision.selectedCandidateIds, []);
  assert.equal(decision.verifiedSelection.exactOptimalityVerified, true);
});

test('bounded feasible status is preserved and verified against an independent exact upper bound', async () => {
  const { input } = fixture(undefined, { expansionBudget: 1 });
  const decision = await runCollectedBoundedPlanningPipeline(input);
  assert.equal(decision.status, 'bounded_feasible');
  assert.equal(decision.selection.frontierExhausted, false);
  assert.equal(decision.verifiedSelection.exactEnumerationPerformed, true);
  assert.equal(decision.verifiedSelection.sourceOptimalityClaimAccepted, false);
  assert.equal(decision.executionEligible, false);
});

test('unknown or duplicate objective evaluations fail after collection', async () => {
  const { input } = fixture();
  await assert.rejects(runCollectedBoundedPlanningPipeline({
    ...input,
    selection: {
      ...input.selection,
      request: {
        ...input.selection.request,
        evaluations: [{
          candidateId: 'missing', utilityMicrounits: 1, dependencies: [], mutexGroup: null,
        }],
      },
    },
  }), { code: 'collected_pipeline_evaluation_candidate_unknown' });
  await assert.rejects(runCollectedBoundedPlanningPipeline({
    ...input,
    selection: {
      ...input.selection,
      request: {
        ...input.selection.request,
        evaluations: [input.selection.request.evaluations[0], input.selection.request.evaluations[0]],
      },
    },
  }), { code: 'collected_pipeline_evaluation_duplicate' });
});

test('downstream deadlines cannot outlive the exact snapshot', async () => {
  const candidate = fixture(undefined, { candidateDeadline: '2026-09-08T00:00:00Z' });
  await assert.rejects(runCollectedBoundedPlanningPipeline(candidate.input),
    { code: 'collected_pipeline_planning_deadline_exceeds_snapshot' });
  const selection = fixture(undefined, { selectionDeadline: '2026-09-08T00:00:00Z' });
  await assert.rejects(runCollectedBoundedPlanningPipeline(selection.input),
    { code: 'collected_pipeline_selection_deadline_exceeds_snapshot' });
});

test('result is deeply immutable and explicitly non-authorizing', async () => {
  const decision = await runCollectedBoundedPlanningPipeline(fixture().input);
  assert.deepEqual(decision.authority, {
    productionAuthorized: false,
    providerAuthorized: false,
    executionAuthorized: false,
    writerAuthorityGranted: false,
    externalAuthorityClaimed: false,
  });
  assert.throws(() => { decision.authority.executionAuthorized = true; }, TypeError);
  assert.throws(() => { decision.candidateCollection.frontier.candidates.push({}); }, TypeError);
  assert.throws(() => { decision.verifiedSelection.selectedCandidateIds.push('other'); }, TypeError);
});
