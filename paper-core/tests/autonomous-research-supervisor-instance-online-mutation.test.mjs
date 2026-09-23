import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_PLAN_HASH,
  createOfflineResidentInstanceMutationCoordinator,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-mutation-plan.mjs';
import {
  composeAutonomousResearchSupervisorState,
} from '../../paper-composition/automation/autonomous-research-supervisor-state-composition.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';

const H = (label) => hashRecord('ResidentInstanceOnlineMutationTest', { label });

function coordinator({
  calls = [],
  status = 'externally_fenced_sqlite_mutation_coordinator_ready',
  blockers = [],
} = {}) {
  const local = createOfflineResidentInstanceMutationCoordinator();
  const coveredDatabaseRoles = Object.freeze(['resident-instance']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      calls.push(Object.freeze({
        databaseRole: input.databaseRole,
        databaseInstanceId: input.databaseInstanceId,
        schemaContractId: input.schemaContractId,
        writerId: input.writerId,
        operationId: input.operationId,
        authorizationReceiptHashes: Object.freeze([...input.authorizationReceiptHashes]),
        sideEffectReservationHashes: Object.freeze([
          ...input.sideEffectReservationHashes,
        ]),
      }));
      return local.executeMutation(input);
    },
    recoverPendingMutations() { return Object.freeze({ recovered: 0 }); },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status,
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([...blockers]),
      });
    },
  });
}

test('resident strict mode rejects configured-but-unactivated fencing before provisioning', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-strict-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configured = coordinator({
    status: 'externally_fenced_sqlite_mutation_coordinator_configured',
    blockers: ['autonomous_research_online_mutation_runtime_activation_required'],
  });
  assert.throws(() => createAutonomousResearchSupervisorInstanceRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator: configured,
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchSupervisorState({
    runtimeRoot,
    residentInstanceMutationCoordinator: configured,
    requireExternallyFencedResidentInstance: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchSupervisorState({
    runtimeRoot,
    requireExternallyFencedResidentInstance: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => createAutonomousResearchSupervisorInstanceRepository({
    runtimeRoot,
    offlineProvision: true,
    mutationCoordinator: coordinator(),
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

test('resident six-operation writer uses pinned typed plans and preserves its API', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-online-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  provisioner.close();

  const calls = [];
  const mutationCoordinator = coordinator({ calls });
  const repository = createAutonomousResearchSupervisorInstanceRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator,
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());
  assert.equal(repository.offlineProvisioningPerformed, false);
  assert.equal(repository.externallyFencedMutations, true);
  assert.equal(Object.keys(AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS).length, 6);
  assert.match(AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_PLAN_HASH, /^sha256:/);
  assert.deepEqual(AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.coverage, {
    requiredRoleCount: 10,
    coveredRoleCount: 10,
    coveredDatabaseRoles: [
      'external-qualification',
      'full-research-qualification-publication',
      'machine-intake',
      'native-store',
      'resident-instance',
      'runtime-reproducibility-publication',
      'runtime-reproducibility-refresh',
      'submission-handoff',
      'supervisor-state',
      'topic-producer',
    ],
    percent: 100,
  });
  const residentWriter = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.writers
    .find((writer) => writer.writerId === AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID);
  assert.equal(
    residentWriter.implementationHash,
    AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_PLAN_HASH,
  );
  const residentConstructor = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations
    .find((operation) => operation.entrypoint
      === 'createAutonomousResearchSupervisorInstanceRepository');
  assert.equal(residentConstructor.mutationClass, 'schema-or-genesis-ddl');
  assert.equal(residentConstructor.coordinatorIntegrated, false);

  const startedAt = new Date('2026-07-18T08:00:00.000Z');
  let lease = repository.acquireInstanceLease({ ownerId: 'resident:test', now: startedAt });
  lease = repository.markStartupReconciled({
    lease,
    receiptHash: H('startup'),
    now: new Date(startedAt.getTime() + 1_000),
  });
  lease = repository.markMachineIntakeReconciled({
    lease,
    receiptHash: H('machine-intake'),
    configurationHash: H('machine-intake-configuration'),
    datasetSnapshotHash: H('machine-intake-dataset'),
    now: new Date(startedAt.getTime() + 2_000),
  });
  lease = repository.markMachineIntakeReconciliationFailed({
    lease,
    reason: 'source temporarily unavailable',
    now: new Date(startedAt.getTime() + 3_000),
  });
  lease = repository.heartbeatInstanceLease({
    lease,
    cycleReceipt: { autonomousResearchSupervisorCycleReceiptHash: H('cycle') },
    now: new Date(startedAt.getTime() + 4_000),
  });
  assert.equal(repository.releaseInstanceLease({
    lease,
    now: new Date(startedAt.getTime() + 5_000),
  }), true);
  assert.equal(repository.readInstance().status, 'stopped');

  assert.deepEqual(calls.map((call) => call.operationId), [
    'resident-instance.supervisor-instance-repository.acquireInstanceLease.v1',
    'resident-instance.supervisor-instance-repository.markStartupReconciled.v1',
    'resident-instance.supervisor-instance-repository.markMachineIntakeReconciled.v1',
    'resident-instance.supervisor-instance-repository.markMachineIntakeReconciliationFailed.v1',
    'resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1',
    'resident-instance.supervisor-instance-repository.releaseInstanceLease.v1',
  ]);
  assert.deepEqual(
    [...residentWriter.operationIds],
    calls.map((call) => call.operationId).sort(),
  );
  for (const call of calls) {
    assert.equal(call.databaseRole, 'resident-instance');
    assert.equal(call.databaseInstanceId, 'resident-instance');
    assert.equal(call.schemaContractId, 'resident-instance-schema-v1');
    assert.equal(call.writerId, AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID);
    assert.deepEqual(call.authorizationReceiptHashes, []);
    assert.deepEqual(call.sideEffectReservationHashes, []);
  }
});
