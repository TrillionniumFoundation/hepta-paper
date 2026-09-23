import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchRuntimeRefreshStateRepository,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_PLAN_HASH,
  createOfflineRuntimeRefreshMutationCoordinator,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  composeAutonomousResearchSupervisorState,
} from '../../paper-composition/automation/autonomous-research-supervisor-state-composition.mjs';

const H = (value) => hashBytes(Buffer.from(String(value)));

function policy() {
  return {
    budgetEpochMs: 24 * 60 * 60 * 1000,
    maximumAttemptsPerEpoch: 2,
    maximumCostUsdPerEpoch: 10,
    leaseMs: 60_000,
    baseBackoffMs: 100,
    maximumBackoffMs: 1000,
    renewalLeadMs: 5000,
    actionSafetyMarginMs: 15 * 60 * 1000,
  };
}

function configuration() {
  return Object.freeze({
    ready: true,
    configurationIdentityHash: H('runtime-refresh-online-configuration'),
    maximumVerificationCostUsd: 3,
    verificationCostAuthority: 'operator_declared_worst_case_usd',
    maximumVerifierTimeoutMs: 1000,
    minimumRefreshLeadMs: 3000,
    maximumReceiptAgeMs: 24 * 60 * 60 * 1000,
    blockers: Object.freeze([]),
  });
}

function coordinator({
  calls = [],
  status = 'externally_fenced_sqlite_mutation_coordinator_ready',
  blockers = [],
} = {}) {
  const local = createOfflineRuntimeRefreshMutationCoordinator();
  const coveredDatabaseRoles = Object.freeze(['runtime-reproducibility-refresh']);
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

test('runtime refresh strict mode rejects unactivated fencing before provisioning', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-refresh-strict-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configured = coordinator({
    status: 'externally_fenced_sqlite_mutation_coordinator_configured',
    blockers: ['autonomous_research_online_mutation_runtime_activation_required'],
  });
  assert.throws(() => createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot,
    policy: policy(),
    offlineProvision: false,
    mutationCoordinator: configured,
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot,
    policy: policy(),
    offlineProvision: true,
    mutationCoordinator: coordinator(),
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchSupervisorState({
    runtimeRoot,
    runtimeRefreshPolicy: policy(),
    runtimeRefreshMutationCoordinator: configured,
    requireExternallyFencedRuntimeRefresh: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchSupervisorState({
    runtimeRoot,
    runtimeRefreshPolicy: policy(),
    requireExternallyFencedRuntimeRefresh: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchSupervisorState({
    runtimeRoot,
    runtimeRefreshPolicy: policy(),
    runtimeRefreshStateRepository: Object.freeze({}),
    runtimeRefreshMutationCoordinator: coordinator(),
    requireExternallyFencedRuntimeRefresh: true,
  }), /external_repository_override_forbidden/);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

test('runtime refresh seven-operation writer preserves lease and budget semantics', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-refresh-online-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot,
    policy: policy(),
  });
  provisioner.close();

  const calls = [];
  const repository = createAutonomousResearchRuntimeRefreshStateRepository({
    runtimeRoot,
    policy: policy(),
    offlineProvision: false,
    mutationCoordinator: coordinator({ calls }),
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());
  assert.equal(repository.offlineProvisioningPerformed, false);
  assert.equal(repository.externallyFencedMutations, true);
  assert.equal(Object.keys(AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS).length, 7);
  assert.match(AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_PLAN_HASH, /^sha256:/);
  const runtimeWriter = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.writers
    .find((writer) => writer.writerId === AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID);
  assert.equal(
    runtimeWriter.implementationHash,
    AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_PLAN_HASH,
  );
  const constructor = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations
    .find((operation) => operation.entrypoint
      === 'createAutonomousResearchRuntimeRefreshStateRepository');
  assert.equal(constructor.mutationClass, 'schema-or-genesis-ddl');
  assert.equal(constructor.coordinatorIntegrated, false);

  const initial = new Date('2026-07-18T08:00:00.000Z');
  assert.deepEqual(repository.reconcileStaleRefreshLease({ now: initial }), {
    recoveredLeaseCount: 0,
    reconciledAt: initial.toISOString(),
  });
  let lease = repository.tryAcquireRefreshLease({
    ownerId: 'supervisor:first',
    now: new Date(initial.getTime() + 1_000),
  }).lease;
  lease = repository.renewRefreshLease({
    lease,
    now: new Date(initial.getTime() + 2_000),
  });
  assert.equal(repository.assertRefreshLease({
    lease,
    now: new Date(initial.getTime() + 3_000),
  }), true);
  assert.equal(repository.releaseRefreshLease({
    lease,
    now: new Date(initial.getTime() + 4_000),
  }), true);

  lease = repository.tryAcquireRefreshLease({
    ownerId: 'supervisor:failed-attempt',
    now: new Date(initial.getTime() + 5_000),
  }).lease;
  assert.equal(repository.reserveRefreshAttempt({
    lease,
    campaignId: 'autonomous-research:failed-attempt',
    configuration: configuration(),
    now: new Date(initial.getTime() + 5_000),
  }).authorized, true);
  repository.failRefreshAttempt({
    lease,
    error: 'builder_failed',
    nextAttemptAt: new Date(initial.getTime() + 6_000),
    now: new Date(initial.getTime() + 5_500),
  });

  lease = repository.tryAcquireRefreshLease({
    ownerId: 'supervisor:successful-attempt',
    now: new Date(initial.getTime() + 6_000),
  }).lease;
  assert.equal(repository.reserveRefreshAttempt({
    lease,
    campaignId: 'autonomous-research:successful-attempt',
    configuration: configuration(),
    now: new Date(initial.getTime() + 6_000),
  }).authorized, true);
  const issuedAt = new Date(initial.getTime() + 6_500);
  repository.completeRefreshAttempt({
    lease,
    receiptHash: H('runtime-refresh-online-receipt'),
    receiptContentHash: H('runtime-refresh-online-content'),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 60_000),
    now: issuedAt,
  });
  assert.equal(repository.readState().status, 'refresh_verified');
  assert.equal(repository.listAttempts().length, 2);
  assert.equal(repository.listBudgetEpochs()[0].reservedCostUsd, 6);

  assert.deepEqual(new Set(calls.map((call) => call.operationId)), new Set([
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.reconcileStaleRefreshLease.v1',
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.tryAcquireRefreshLease.v1',
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.renewRefreshLease.v1',
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.releaseRefreshLease.v1',
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.reserveRefreshAttempt.v1',
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.failRefreshAttempt.v1',
    'runtime-reproducibility-refresh.runtime-refresh-state-repository.completeRefreshAttempt.v1',
  ]));
  assert.deepEqual(
    [...runtimeWriter.operationIds],
    [...new Set(calls.map((call) => call.operationId))].sort(),
  );
  for (const call of calls) {
    assert.equal(call.databaseRole, 'runtime-reproducibility-refresh');
    assert.equal(call.databaseInstanceId, 'runtime-reproducibility-refresh');
    assert.equal(call.schemaContractId, 'runtime-reproducibility-refresh-schema-v1');
    assert.equal(call.writerId, AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID);
    assert.deepEqual(call.authorizationReceiptHashes, []);
    assert.deepEqual(call.sideEffectReservationHashes, []);
  }
});
