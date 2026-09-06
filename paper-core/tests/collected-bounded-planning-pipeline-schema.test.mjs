import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPlanningSnapshotComponent }
  from '../../paper-application/orchestration/snapshot-builder.mjs';
import { createActionCandidate }
  from '../../paper-application/orchestration/candidate-router.mjs';
import { runCollectedBoundedPlanningPipeline }
  from '../../paper-application/orchestration/collected-bounded-planning-pipeline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = (character) => `sha256:${character.repeat(64)}`;
const nowEpochMs = Date.parse('2026-09-06T00:00:00Z');
const snapshotRequest = {
  schemaVersion: 1,
  kind: 'PlanningStateSnapshotRequestV1',
  snapshotRequestId: 'collected-schema-snapshot',
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
const component = createPlanningSnapshotComponent({
  schemaVersion: 1,
  kind: 'PlanningSnapshotComponentV1',
  componentId: 'campaign',
  componentKind: 'campaign-state',
  sourceModuleId: snapshotBinding.moduleId,
  sourceModuleVersion: snapshotBinding.moduleVersion,
  sourceQualificationHash: snapshotBinding.qualificationSubjectHash,
  readTransactionHash: snapshotRequest.readTransactionHash,
  consistencyEpoch: 1,
  revision: 1,
  generation: 1,
  capturedAt: '2026-09-05T23:59:00Z',
  expiresAt: '2026-09-07T00:00:00Z',
  payload: { revision: 1 },
});
const candidateBinding = {
  moduleId: 'module.alpha',
  moduleVersion: '1.0.0',
  capabilityIds: ['CAP-MOD-CANDIDATES'],
  qualificationSubjectHash: H('c'),
  validUntil: '2026-09-08T00:00:00Z',
};
const planningTemplate = {
  schemaVersion: 1,
  kind: 'PlanningRequestV1',
  planningRequestId: 'collected-schema-plan',
  capabilityId: 'CAP-MOD-CANDIDATES',
  hardConstraintSetHash: H('d'),
  objectiveVersion: 'objective-v1',
  resourcePriceSnapshotHash: H('e'),
  candidateLimit: 1,
  deadline: '2026-09-07T00:00:00Z',
  allowedSideEffectClasses: ['none'],
  inputArtifactHashes: [],
};
const decision = await runCollectedBoundedPlanningPipeline({
  snapshot: {
    request: snapshotRequest,
    moduleBindings: [snapshotBinding],
    components: [component],
  },
  candidate: {
    request: planningTemplate,
    moduleBindings: [candidateBinding],
    producers: [{
      moduleId: candidateBinding.moduleId,
      moduleVersion: candidateBinding.moduleVersion,
      produce(input) {
        const action = createActionCandidate({
          schemaVersion: 1,
          kind: 'ActionCandidateV1',
          candidateId: 'candidate-a',
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
        });
        return {
          schemaVersion: 1,
          kind: 'ModuleCandidateResponseV1',
          status: 'complete',
          moduleId: candidateBinding.moduleId,
          moduleVersion: candidateBinding.moduleVersion,
          planningRequestHash: input.planningRequestHash,
          candidates: [action],
          emptyReason: null,
          authority: {
            productionAuthorized: false,
            providerAuthorized: false,
            writerAuthorityGranted: false,
            externalAuthorityClaimed: false,
          },
        };
      },
    }],
  },
  selection: {
    request: {
      schemaVersion: 1,
      kind: 'GlobalPlanSelectionRequestV1',
      selectionRequestId: 'collected-schema-selection',
      deadline: '2026-09-06T12:00:00Z',
      expansionBudget: 100,
      maximumSelectedCandidates: 1,
      resourceLimits: {
        cpuMilliunits: 1000, gpuMilliunits: 0, memoryMiB: 0,
        storageBytes: 0, tokenCount: 0, maximumCostMicrousd: 0,
      },
      requiredCandidateIds: [],
      evaluations: [{
        candidateId: 'candidate-a', utilityMicrounits: 7,
        dependencies: [], mutexGroup: null,
      }],
    },
  },
  nowEpochMs,
});

function validate(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collected-decision-schema-'));
  try {
    const instance = path.join(directory, 'instance.json');
    fs.writeFileSync(instance, `${JSON.stringify(value, null, 2)}\n`);
    return spawnSync('python3', [
      'docs/rust/tools/strict_json_schema.py',
      '--schema', 'docs/modules/schemas/collected-bounded-planning-decision-v1.schema.json',
      '--instance', instance,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('actual collected planning decision validates against closed schema', () => {
  const checked = validate(decision);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test('schema rejects authority, verification and disposition shape splicing', () => {
  for (const invalid of [
    { ...decision, executionEligible: true },
    { ...decision, authority: { ...decision.authority, executionAuthorized: true } },
    { ...decision, status: 'infeasible' },
    { ...decision, selectedCandidateIds: null },
    { ...decision, verifiedSelection: null },
    { ...decision, verifiedPlanSelectionHash: null },
    { ...decision, verificationStatus: 'no_feasible_selection_receipt' },
    { ...decision, credential: 'forbidden' },
  ]) {
    const checked = validate(invalid);
    assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  }
});
