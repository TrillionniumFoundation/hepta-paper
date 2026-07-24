import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID,
  createOfflineExternalQualificationMutationCoordinator,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-mutation-plan.mjs';
import {
  createAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('ExternalQualificationSingletonTest', { label });
const FIXED_RELATIVE_PATH =
  'autonomous-research/qualification/external-qualification-state.sqlite';

function qualificationState(paperId, generation = 1) {
  return createAutonomousExternalQualificationState(Object.freeze({
    version: 4,
    kind: 'AutonomousExternalQualificationState',
    generation,
    campaignId: `autonomous-research:${paperId}`,
    paperId,
    campaignReleaseBundleHash: H(`release:${paperId}`),
    receipt: null,
    verifiedInspection: null,
    recovery: Object.freeze({
      status: 'qualification_retry_scheduled',
      recoveryIdentityHash: H(`recovery:${paperId}`),
      recoveryConfigurationIdentityHash: H('recovery-configuration'),
      retryPolicyIdentityHash: H('retry-policy'),
      configurationIdentityHash: H('configuration'),
      trustIdentityHash: H('trust'),
      clientServiceIdentityHash: H('client'),
      verifierServiceIdentityHash: H('verifier'),
      terminalFailure: null,
      cycle: 1,
      epoch: 1,
      maximumEpochs: 4,
      attemptCount: 0,
      maximumAttempts: 4,
      totalAttemptCount: 0,
      maximumTotalAttempts: 16,
      maximumTotalCostUsd: 10,
      reservedCostUsd: 0,
      attemptReservationCostUsd: 0.05,
      firstAttemptAt: '2026-07-20T00:00:00.000Z',
      nextAttemptAt: '2026-07-20T00:00:01.000Z',
      deadlineAt: '2026-07-20T01:00:00.000Z',
      globalFirstAttemptAt: '2026-07-20T00:00:00.000Z',
      globalDeadlineAt: '2026-07-21T00:00:00.000Z',
    }),
  }));
}

function readyCoordinator(calls = []) {
  const local = createOfflineExternalQualificationMutationCoordinator({
    databaseInstanceId:
      AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID,
  });
  const coveredDatabaseRoles = Object.freeze(['external-qualification']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      calls.push(Object.freeze({
        databaseInstanceId: input.databaseInstanceId,
        operationId: input.operationId,
      }));
      return local.executeMutation(input);
    },
    recoverPendingMutations() { return Object.freeze({ recoveredReservationIds: [] }); },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
  });
}

test('strict generated paper fails closed when the fixed singleton was not provisioned', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-singleton-missing-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

  assert.throws(() => createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'new-generated-paper',
    offlineProvision: false,
    mutationCoordinator: readyCoordinator(),
    requireExternallyFencedMutations: true,
  }), /qualification_state_offline_provisioning_required/);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

test('new generated papers share one fixed database while state and leases remain scoped', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-singleton-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const paperA = 'generated-paper-alpha';
  const paperB = 'generated-paper-beta';

  const provisioner = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: paperA,
  });
  const fixedStatePath = path.join(runtimeRoot, FIXED_RELATIVE_PATH);
  assert.equal(provisioner.statePath, fixedStatePath);
  provisioner.close();

  const calls = [];
  const mutationCoordinator = readyCoordinator(calls);
  const repositoryA = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: paperA,
    offlineProvision: false,
    mutationCoordinator,
    requireExternallyFencedMutations: true,
  });
  const repositoryB = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: paperB,
    offlineProvision: false,
    mutationCoordinator,
    requireExternallyFencedMutations: true,
  });
  t.after(() => { repositoryA.close(); repositoryB.close(); });

  assert.equal(repositoryA.statePath, fixedStatePath);
  assert.equal(repositoryB.statePath, fixedStatePath);
  assert.equal(
    repositoryA.databaseInstanceId,
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID,
  );
  assert.equal(repositoryB.databaseInstanceId, repositoryA.databaseInstanceId);

  const stateA = qualificationState(paperA);
  const stateB = qualificationState(paperB);
  repositoryA.compareAndSwapExternalQualificationState({ state: stateA });
  repositoryB.compareAndSwapExternalQualificationState({ state: stateB });
  assert.deepEqual(repositoryA.readExternalQualificationState(), stateA);
  assert.deepEqual(repositoryB.readExternalQualificationState(), stateB);

  const observedAt = new Date('2026-07-20T02:00:00.000Z');
  const leaseA = repositoryA.tryAcquireQualificationAttemptLease({
    ownerId: 'worker:alpha', leaseMs: 1_000, now: observedAt,
  });
  const leaseB = repositoryB.tryAcquireQualificationAttemptLease({
    ownerId: 'worker:beta', leaseMs: 1_000, now: observedAt,
  });
  assert.ok(leaseA);
  assert.ok(leaseB);

  const callsBeforeMismatch = calls.length;
  assert.throws(() => repositoryA.compareAndSwapExternalQualificationState({
    expectedStateHash: stateA.autonomousExternalQualificationStateHash,
    state: qualificationState(paperB, 2),
  }), /external_qualification_state_scope_invalid/);
  assert.equal(calls.length, callsBeforeMismatch);
  assert.equal(calls.every((call) => (
    call.databaseInstanceId
      === AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID
  )), true);
  assert.equal(fs.existsSync(path.join(
    runtimeRoot,
    'autonomous-research',
    paperB,
    'system-state',
    'external-qualification-state.sqlite',
  )), false);
});

test('read-side scope validation rejects a cross-paper row and never falls back to legacy JSON', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-singleton-read-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const paperA = 'generated-paper-read-alpha';
  const paperB = 'generated-paper-read-beta';
  const repository = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: paperA,
  });
  const stateA = qualificationState(paperA);
  repository.compareAndSwapExternalQualificationState({ state: stateA });
  const { statePath, legacyStatePath } = repository;
  repository.close();

  const stateB = qualificationState(paperB);
  const database = new DatabaseSync(statePath);
  database.prepare(`UPDATE autonomous_external_qualification_state
    SET generation=?,state_hash=?,state_json=? WHERE scope=?`).run(
    stateB.generation,
    stateB.autonomousExternalQualificationStateHash,
    JSON.stringify(stateB),
    `paper:${paperA}`,
  );
  database.close();

  const readOnly = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: paperA,
    create: false,
  });
  assert.throws(
    () => readOnly.readExternalQualificationState(),
    /external_qualification_state_fence_invalid/,
  );
  readOnly.close();

  fs.rmSync(statePath);
  fs.mkdirSync(path.dirname(legacyStatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacyStatePath, `${JSON.stringify(stateA)}\n`, { mode: 0o600 });
  const legacyDisabled = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: paperA,
    create: false,
  });
  assert.equal(legacyDisabled.readExternalQualificationState(), null);
  legacyDisabled.close();

  const offlineProvisioner = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: paperA,
  });
  assert.equal(offlineProvisioner.readExternalQualificationState(), null);
  offlineProvisioner.close();
});
