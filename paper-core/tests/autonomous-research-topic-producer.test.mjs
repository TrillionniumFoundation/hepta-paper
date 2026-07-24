import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  isResidentReactivationRequired,
} from '../../paper-application/automation/autonomous-research-resident-reactivation-required.mjs';

import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH,
  H,
  PROVIDER_HASH,
  appendMachineAutonomousResearchIntake,
  autonomousResearchOnlineWriterOperationManifestHash,
  buildAutonomousResearchMachineIntakeConfiguration,
  buildAutonomousResearchRecurringGoldenTemplate,
  buildAutonomousResearchTopicProducerCapabilityReceipt,
  canaryPair,
  canaryReservationFor,
  checkpointCanaryPair,
  composeAutonomousResearchMachineIntakePlane,
  createAutonomousResearchMachineIntakeRepository,
  createAutonomousResearchTopicProducerLiveAuthority,
  createAutonomousResearchTopicProducerRepository,
  createExternallyFencedSqliteMutationCoordinator,
  fullAutonomyCurrent,
  hashRecord,
  innerCanary,
  installMachineIntakeExternalGenesisAuthority,
  producerProfile,
  providerCanaryAction,
  recordingTopicMutationCoordinator,
  residentContext,
  setup,
} from './support/autonomous-research-topic-producer-fixture.mjs';

test('topic producer strict fencing rejects unactivated or provisioning paths before I/O', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-topic-strict-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const profile = producerProfile();
  const configured = recordingTopicMutationCoordinator([], {
    status: 'externally_fenced_sqlite_mutation_coordinator_configured',
    blockers: ['autonomous_research_online_mutation_runtime_activation_required'],
  });
  const base = {
    runtimeRoot,
    machineIntakeConfigurationHash: H('strict-machine-intake'),
    producerProfile: profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority: Object.freeze({ consume() { return true; } }),
    requireExternallyFencedMutations: true,
  };
  assert.throws(() => createAutonomousResearchTopicProducerRepository({
    ...base,
    create: true,
    offlineProvision: false,
    mutationCoordinator: configured,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => createAutonomousResearchTopicProducerRepository({
    ...base,
    create: true,
    offlineProvision: true,
    mutationCoordinator: recordingTopicMutationCoordinator([]),
  }), /external_mutation_coordinator_required/);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

function strictTopicPermitFixture(t, {
  sideEffectMode,
  crashAfterAuthor = false,
} = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(), `hepta-topic-permit-${sideEffectMode}-`,
  ));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  let observedAt = new Date('2026-07-18T10:00:00.000Z');
  let providerCalls = 0;
  const calls = [];
  const clock = { now: () => new Date(observedAt) };
  const profile = producerProfile();
  const machineIntakeConfigurationHash = H(`machine-intake:${sideEffectMode}`);
  const liveMutationAuthority = createAutonomousResearchTopicProducerLiveAuthority({
    clock,
    hashRecord,
    providerCanaryPairMaximumCostUsd: 1,
    remeasureAuthorities() {
      return Object.freeze({ ready: true, authorityMeasurementHash: H('permit-authority') });
    },
    async runProviderCanary(input) {
      const receipt = canaryPair(clock.now());
      await input.beforeCanaryAction({
        role: 'research_author',
        failurePhase: 'research_author_canary',
      });
      providerCalls += 1;
      if (crashAfterAuthor) throw new Error('simulated_process_loss_after_author_call');
      await input.afterCanaryAction({
        action: providerCanaryAction({
          role: 'research_author',
          receipt: receipt.researchAuthorProviderCanaryReceipt,
        }),
        failurePhase: 'research_author_canary',
      });
      await input.betweenCanaryChecks();
      await input.beforeCanaryAction({
        role: 'formal_reviewer',
        failurePhase: 'formal_reviewer_canary',
      });
      providerCalls += 1;
      await input.afterCanaryAction({
        action: providerCanaryAction({
          role: 'formal_reviewer',
          receipt: receipt.formalReviewerProviderCanaryReceipt,
        }),
        failurePhase: 'formal_reviewer_canary',
      });
      return receipt;
    },
  });
  const repositoryOptions = Object.freeze({
    runtimeRoot,
    machineIntakeConfigurationHash,
    producerProfile: profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority,
  });
  const provisioner = createAutonomousResearchTopicProducerRepository(repositoryOptions);
  provisioner.close();
  let repository = createAutonomousResearchTopicProducerRepository({
    ...repositoryOptions,
    offlineProvision: false,
    mutationCoordinator: recordingTopicMutationCoordinator(calls, { sideEffectMode }),
    requireExternallyFencedMutations: true,
  });
  t.after(() => { try { repository.close(); } catch { /* already closed */ } });
  return {
    calls,
    clock,
    liveMutationAuthority,
    profile,
    get repository() { return repository; },
    providerCalls: () => providerCalls,
    setNow(value) { observedAt = new Date(value); },
    reopenAfterFinalizationRecovery() {
      repository.close();
      repository = createAutonomousResearchTopicProducerRepository({
        ...repositoryOptions,
        offlineProvision: false,
        mutationCoordinator: recordingTopicMutationCoordinator(calls, {
          sideEffectMode: 'finalized',
        }),
        requireExternallyFencedMutations: true,
      });
      return repository;
    },
    expected: Object.freeze({
      machineIntakeConfigurationHash,
      producerProfileHash: profile.producerProfileHash,
      providerConfigurationHash: profile.providerConfigurationHash,
      implementationSha256: profile.implementationSha256,
    }),
  };
}

async function authorizeStrictTopicPermit(fixture, lease, plan) {
  return fixture.liveMutationAuthority.authorize({
    producerLease: lease,
    assertProducerLease: fixture.repository.assertLease,
    residentLeaseContext: residentContext(),
    assertAutonomyCurrent: fullAutonomyCurrent,
    plannedGeneration: plan.plannedGeneration,
    expected: fixture.expected,
    beginProviderCanaryAction: fixture.repository.beginProviderCanaryAction,
    assertProviderCanaryActionPermit:
      fixture.repository.assertProviderCanaryActionPermit,
    finishProviderCanaryAction: fixture.repository.finishProviderCanaryAction,
  });
}

for (const sideEffectMode of ['pending', 'no-permit']) {
  test(`topic provider ${sideEffectMode} receipt performs zero provider calls and restart does not replay`, async (t) => {
    const fixture = strictTopicPermitFixture(t, { sideEffectMode });
    const lease = fixture.repository.tryAcquireLease({
      ownerId: `producer:${sideEffectMode}`,
      leaseMs: 1000,
      now: fixture.clock.now(),
    });
    const plan = fixture.repository.prepareGeneration({ lease, now: fixture.clock.now() });
    await assert.rejects(() => authorizeStrictTopicPermit(fixture, lease, plan),
      sideEffectMode === 'pending'
        ? /committed_finalization_pending/
        : /provider_canary_side_effect_permit_required/);
    assert.equal(fixture.providerCalls(), 0);
    const beginCalls = fixture.calls.filter((call) => call.operationId
      === AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS.beginCanary);
    assert.equal(beginCalls.length, 1);
    assert.equal(beginCalls[0].sideEffectReservationHashes.length, 1);
    assert.notEqual(
      beginCalls[0].sideEffectReservationHashes[0],
      plan.plannedGeneration.plannedGenerationHash,
    );

    fixture.setNow(new Date(fixture.clock.now().getTime() + 2000));
    const reopened = fixture.reopenAfterFinalizationRecovery();
    const recoveryLease = reopened.tryAcquireLease({
      ownerId: `producer:${sideEffectMode}:recovery`,
      leaseMs: 1000,
      now: fixture.clock.now(),
    });
    assert.ok(recoveryLease);
    assert.equal(reopened.prepareGeneration({
      lease: recoveryLease,
      now: fixture.clock.now(),
    }), null);
    assert.equal(reopened.readGeneration(plan.generationSequence).status, 'failed');
    assert.equal(fixture.providerCalls(), 0);
  });
}

test('topic provider finalized permits are role-bound and allow exactly two provider calls', async (t) => {
  const fixture = strictTopicPermitFixture(t, { sideEffectMode: 'finalized' });
  const lease = fixture.repository.tryAcquireLease({
    ownerId: 'producer:finalized', leaseMs: 1000, now: fixture.clock.now(),
  });
  const plan = fixture.repository.prepareGeneration({ lease, now: fixture.clock.now() });
  await authorizeStrictTopicPermit(fixture, lease, plan);
  assert.equal(fixture.providerCalls(), 2);
  const beginCalls = fixture.calls.filter((call) => call.operationId
    === AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS.beginCanary);
  assert.equal(beginCalls.length, 2);
  const reservations = beginCalls.map((call) => call.sideEffectReservationHashes[0]);
  assert.equal(new Set(reservations).size, 2);
  assert.equal(reservations.every((value) => /^sha256:[0-9a-f]{64}$/.test(value)), true);
  assert.equal(reservations.includes(plan.plannedGeneration.plannedGenerationHash), false);
});

test('topic finalized author permit followed by process loss is recovered without replay', async (t) => {
  const fixture = strictTopicPermitFixture(t, {
    sideEffectMode: 'finalized',
    crashAfterAuthor: true,
  });
  const lease = fixture.repository.tryAcquireLease({
    ownerId: 'producer:finalized-crash', leaseMs: 1000, now: fixture.clock.now(),
  });
  const plan = fixture.repository.prepareGeneration({ lease, now: fixture.clock.now() });
  await assert.rejects(() => authorizeStrictTopicPermit(fixture, lease, plan),
    /simulated_process_loss_after_author_call/);
  assert.equal(fixture.providerCalls(), 1);
  fixture.setNow(new Date(fixture.clock.now().getTime() + 2000));
  const reopened = fixture.reopenAfterFinalizationRecovery();
  const recoveryLease = reopened.tryAcquireLease({
    ownerId: 'producer:finalized-crash:recovery',
    leaseMs: 1000,
    now: fixture.clock.now(),
  });
  assert.equal(reopened.prepareGeneration({
    lease: recoveryLease,
    now: fixture.clock.now(),
  }), null);
  assert.equal(reopened.readGeneration(plan.generationSequence).status, 'failed');
  assert.equal(fixture.providerCalls(), 1);
});

function topicOnlineWriterManifest() {
  const operationIds = Object.values(AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS).sort();
  const topicOperations = operationIds.map((operationId, index) => Object.freeze({
    operationId,
    databaseRole: 'topic-producer',
    sourceFile: 'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs',
    entrypoint: `topicProducerOperation${index}`,
    mutationClass: 'business-dml',
    protocolStatus: AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
    coordinatorIntegrated: true,
  }));
  const uncovered = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES
    .filter((role) => role !== 'topic-producer')
    .map((role, index) => Object.freeze({
      operationId: `${role}.uncovered.v1`,
      databaseRole: role,
      sourceFile: `paper-adapters/automation/${role}-uncovered.mjs`,
      entrypoint: `uncoveredOperation${index}`,
      mutationClass: 'schema-or-genesis-ddl',
      protocolStatus: AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
      coordinatorIntegrated: false,
    }));
  return Object.freeze({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'topic-producer-real-coordinator-contract-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze([
      ...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
    ].sort()),
    writers: Object.freeze([Object.freeze({
      writerId: AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
      databaseRoles: Object.freeze(['topic-producer']),
      operationIds: Object.freeze(operationIds),
      implementationHash: AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH,
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    })]),
    operations: Object.freeze([...topicOperations, ...uncovered]),
    coverage: Object.freeze({
      requiredRoleCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
      coveredRoleCount: 1,
      coveredDatabaseRoles: Object.freeze(['topic-producer']),
      percent: Number((100 / AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length).toFixed(2)),
    }),
  });
}

function topicOnlineSchemaHash(database) {
  const rows = database.prepare(`SELECT type,name,tbl_name,coalesce(sql,'') AS sql
    FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type,name,tbl_name,sql`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

function realTopicCoordinatorFixture({ databasePath, now }) {
  const manifest = topicOnlineWriterManifest();
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'authority:topic-real-contract',
    keyId: 'key:topic-real-contract',
    scopeId: 'scope:topic-real-contract',
    databaseScopeHash: H('topic-real-database-scope'),
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  const database = new DatabaseSync(databasePath);
  for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
    database.exec(statement);
  }
  const schemaHash = topicOnlineSchemaHash(database);
  database.prepare(`INSERT INTO autonomous_research_online_mutation_authority_metadata(
    singleton,schema_version,protocol,database_role,database_instance_id,
    schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
    genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
    genesis_database_hash,genesis_state_hash,provisioned_at
  ) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    'topic-producer',
    'topic-producer',
    'topic-producer-schema-v1',
    schemaHash,
    trust.databaseScopeHash,
    trust.writerManifestHash,
    0,
    H('topic-real-genesis-global'),
    0,
    H('topic-real-genesis-database'),
    H('topic-real-genesis-state'),
    now.toISOString(),
  );
  database.close();

  const calls = [];
  let head = Object.freeze({
    globalSequence: 0,
    globalHash: H('topic-real-genesis-global'),
    databaseSequence: 0,
    databaseHash: H('topic-real-genesis-database'),
    stateHash: H('topic-real-genesis-state'),
  });
  const authorityClient = {
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    trust,
    observeCurrentHead({ request }) {
      calls.push({ method: 'head', request });
      return Object.freeze({
        globalSequence: head.globalSequence,
        globalHash: head.globalHash,
        databaseHeads: Object.freeze([Object.freeze({
          databaseRole: 'topic-producer',
          databaseInstanceId: 'topic-producer',
          sequence: head.databaseSequence,
          hash: head.databaseHash,
          schemaHash,
          stateHash: head.stateHash,
        })]),
      });
    },
    reserveMutation({ request }) {
      calls.push({ method: 'reserve', request });
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationReservationReceipt',
        status: 'autonomous_research_online_mutation_reserved',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineMutationReserveRequest', request),
        reservationId: `reservation:topic-real:${calls.length}`,
        globalSequence: request.globalPreviousSequence + 1,
        globalHash: H(`topic-real-global:${calls.length}`),
        databaseSequence: request.databasePreviousSequence + 1,
        databaseHash: H(`topic-real-database:${calls.length}`),
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        signature: 'dGVzdA==',
      });
    },
    verifyStoredReservation() { return true; },
    resolveMutationAttempt() { return null; },
    finalizeMutation({ request, reservation }) {
      calls.push({ method: 'finalize', request });
      head = Object.freeze({
        globalSequence: reservation.globalSequence,
        globalHash: reservation.globalHash,
        databaseSequence: reservation.databaseSequence,
        databaseHash: reservation.databaseHash,
        stateHash: reservation.postStateHash,
      });
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
        status: 'autonomous_research_online_mutation_finalized',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineMutationFinalizeRequest', request),
        sideEffectPermitHash: H(`topic-real-permit:${reservation.reservationId}`),
        finalizedAt: now.toISOString(),
        signature: 'dGVzdA==',
      });
    },
    abortMutation({ request }) {
      calls.push({ method: 'abort', request });
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationAbortReceipt',
        status: 'autonomous_research_online_mutation_aborted',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineMutationAbortRequest', request),
        abortedAt: now.toISOString(),
        signature: 'dGVzdA==',
      });
    },
  };
  const real = createExternallyFencedSqliteMutationCoordinator({
    authorityClient,
    authorityTrust: trust,
    manifest,
    operationPlans: AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
    databaseInstances: Object.freeze([Object.freeze({
      databaseRole: 'topic-producer',
      databaseInstanceId: 'topic-producer',
      schemaHash,
    })]),
    clock: { now: () => new Date(now) },
  });
  const coveredDatabaseRoles = Object.freeze(['topic-producer']);
  return Object.freeze({
    calls,
    coordinator: Object.freeze({
      implemented: true,
      coveredDatabaseRoles,
      executeMutation(input) { return real.executeMutation(input); },
      recoverPendingMutations(input) { return real.recoverPendingMutations(input); },
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
    }),
  });
}

test('topic lease, prepare, and canary action reach the real coordinator with exact side-effect contracts', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-topic-real-contract-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const now = new Date('2026-07-18T11:00:00.000Z');
  const profile = producerProfile();
  const machineIntakeConfigurationHash = H('topic-real-machine-intake');
  const liveMutationAuthority = Object.freeze({ consume() { return true; } });
  const provisioner = createAutonomousResearchTopicProducerRepository({
    runtimeRoot,
    machineIntakeConfigurationHash,
    producerProfile: profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority,
  });
  const databasePath = provisioner.databasePath;
  provisioner.close();
  const actual = realTopicCoordinatorFixture({ databasePath, now });
  const repository = createAutonomousResearchTopicProducerRepository({
    runtimeRoot,
    machineIntakeConfigurationHash,
    producerProfile: profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority,
    offlineProvision: false,
    mutationCoordinator: actual.coordinator,
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());

  let lease = repository.tryAcquireLease({
    ownerId: 'producer:real-contract:first', leaseMs: 5000, now,
  });
  lease = repository.renewLease({ lease, leaseMs: 5000, now });
  assert.equal(repository.releaseLease({ lease }), true);
  lease = repository.tryAcquireLease({
    ownerId: 'producer:real-contract:second', leaseMs: 5000, now,
  });
  const generation = repository.prepareGeneration({ lease, now });
  const reservation = canaryReservationFor(generation.plannedGeneration);
  const journal = repository.beginProviderCanaryAction({
    lease,
    generationSequence: generation.generationSequence,
    reservation,
    role: 'research_author',
    failurePhase: 'research_author_canary',
    now,
  });
  assert.equal(repository.assertProviderCanaryActionPermit({
    journal,
    lease,
    generationSequence: generation.generationSequence,
    reservation,
    role: 'research_author',
    failurePhase: 'research_author_canary',
  }), true);
  let providerCalls = 0;
  providerCalls += 1;
  repository.finishProviderCanaryAction({
    lease,
    generationSequence: generation.generationSequence,
    reservation,
    action: providerCanaryAction({
      role: 'research_author',
      receipt: innerCanary({ role: 'author', now }),
    }),
    failurePhase: 'research_author_canary',
    now,
  });
  repository.failGeneration({
    lease,
    generationSequence: generation.generationSequence,
    error: new Error('real_coordinator_contract_completed'),
    retryAfterMs: 60_000,
    now,
  });
  assert.equal(repository.releaseLease({ lease }), true);
  assert.equal(providerCalls, 1);

  const reserveRequests = actual.calls
    .filter((call) => call.method === 'reserve')
    .map((call) => call.request);
  assert.ok(reserveRequests.length >= 8);
  const canaryRequest = reserveRequests.find((request) => request.operationId
    === AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS.beginCanary);
  assert.ok(canaryRequest);
  assert.equal(canaryRequest.authorizationReceiptHashes.length, 0);
  assert.equal(canaryRequest.sideEffectReservationHashes.length, 1);
  assert.notEqual(
    canaryRequest.sideEffectReservationHashes[0],
    generation.plannedGeneration.plannedGenerationHash,
  );
  for (const request of reserveRequests.filter((item) => item !== canaryRequest)) {
    assert.deepEqual(request.authorizationReceiptHashes, []);
    assert.deepEqual(request.sideEffectReservationHashes, []);
  }
});

test('topic producer ten-operation typed writer covers every public DML boundary', async (t) => {
  const calls = [];
  const fixture = setup(t, {
    topicMutationCoordinator: recordingTopicMutationCoordinator(calls),
  });
  const generated = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(generated.generated, true);
  fixture.setNow('2026-07-18T00:00:00.000Z');
  let lease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:typed-plan',
    leaseMs: 60_000,
    now: fixture.clock.now(),
  });
  lease = fixture.producerRepository.renewLease({
    lease,
    leaseMs: 60_000,
    now: fixture.clock.now(),
  });
  const planned = fixture.producerRepository.prepareGeneration({
    lease,
    now: fixture.clock.now(),
  });
  assert.throws(() => fixture.producerRepository.recoverCommittedGeneration({
    lease,
    intakeRecord: Object.freeze({}),
    now: fixture.clock.now(),
  }), /crash_recovery_binding_invalid/);
  fixture.producerRepository.failGeneration({
    lease,
    generationSequence: planned.generationSequence,
    error: new Error('typed-plan-test-failure'),
    retryAfterMs: 60_000,
    now: fixture.clock.now(),
  });
  assert.equal(fixture.producerRepository.releaseLease({ lease }), true);
  assert.equal(Object.keys(AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS).length, 10);
  assert.match(AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH, /^sha256:/);
  assert.deepEqual(
    new Set(calls.map((call) => call.operationId)),
    new Set(Object.values(AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS)),
  );
  assert.ok(calls.every((call) => call.databaseRole === 'topic-producer'
    && call.databaseInstanceId === 'topic-producer'
    && call.schemaContractId === 'topic-producer-schema-v1'));
});

test('bootstrap-only machine intake plane admits recurring golden without producer canaries', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-bootstrap-only-plane-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const profile = producerProfile();
  const recurringGolden = buildAutonomousResearchRecurringGoldenTemplate({
    templateId: 'bootstrap-only-golden',
    epochDurationMs: 12 * 60 * 60 * 1000,
    objective: 'Renew the global autonomous research qualification without production intake.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: profile.registeredResearchProfiles[0].datasetMounts,
    providerConfigurationHash: PROVIDER_HASH,
    revisionRounds: 1,
    refereeCount: 2,
  });
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [recurringGolden],
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  installMachineIntakeExternalGenesisAuthority({
    configurationHash: configuration.configurationHash,
    producerProfileHash: profile.producerProfileHash,
  });
  const configPath = path.join(runtimeRoot, 'machine-intake.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  let providerCanaryCalls = 0;
  const now = new Date('2026-07-17T00:00:00.000Z');
  const plane = composeAutonomousResearchMachineIntakePlane({
    runtimeRoot,
    configuration,
    configPath,
    providerConfiguration: {
      autonomousResearchProviderConfigurationHash: PROVIDER_HASH,
    },
    environment: {},
    producerInspection: {
      ready: true,
      producerProfile: profile,
      implementationIdentity: { ready: true, implementationSha256: profile.implementationSha256 },
      datasetSnapshot: { datasetSnapshotHash: H('bootstrap-dataset-snapshot') },
      profilePath: path.join(runtimeRoot, 'unused-profile.json'),
    },
    providerCanaryPairMaximumCostUsd: 1,
    async providerCanaryRunner(input) {
      providerCanaryCalls += 1;
      const receipt = canaryPair(now);
      checkpointCanaryPair(input, receipt);
      return receipt;
    },
    clock: { now: () => new Date(now) },
    ownerId: 'producer:bootstrap-only',
  });
  t.after(() => plane.close());

  const loaded = await plane.loadConfiguredIntakes({
    now,
    residentLeaseContext: residentContext(),
    operationMode: 'bootstrap-only',
    assertAutonomyCurrent() {
      return Object.freeze({ ready: true, operationMode: 'bootstrap-only' });
    },
  });
  assert.equal(providerCanaryCalls, 0);
  assert.equal(loaded.topicProducer, null);
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.results[0].record.sourceKind, 'recurring-golden');
  assert.equal(plane.producerRepository.readStatus({ now }).providerCanaryAttemptCount, 0);
  assert.equal(plane.machineIntakeRepository.listPendingIntakes({ now, limit: 10 })
    .every((record) => record.sourceKind === 'recurring-golden'), true);
});

test('machine intake plane rejects tampered config and requests restart only for valid rotation', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-plane-config-rotation-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const profile = producerProfile();
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  installMachineIntakeExternalGenesisAuthority({
    configurationHash: configuration.configurationHash,
    producerProfileHash: profile.producerProfileHash,
  });
  const configPath = path.join(runtimeRoot, 'machine-intake.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  const now = new Date('2026-07-20T01:15:00.000Z');
  let providerCanaryCalls = 0;
  const plane = composeAutonomousResearchMachineIntakePlane({
    runtimeRoot,
    configuration,
    configPath,
    providerConfiguration: {
      autonomousResearchProviderConfigurationHash: PROVIDER_HASH,
    },
    environment: {},
    producerInspection: {
      ready: true,
      producerProfile: profile,
      implementationIdentity: { ready: true, implementationSha256: profile.implementationSha256 },
      datasetSnapshot: { datasetSnapshotHash: H('config-rotation-dataset-snapshot') },
      profilePath: path.join(runtimeRoot, 'unused-profile.json'),
    },
    providerCanaryPairMaximumCostUsd: 1,
    async providerCanaryRunner() { providerCanaryCalls += 1; throw new Error('unexpected'); },
    clock: { now: () => new Date(now) },
    ownerId: 'producer:config-rotation',
  });
  t.after(() => plane.close());
  const request = {
    now,
    residentLeaseContext: residentContext(),
    operationMode: 'full',
    assertAutonomyCurrent: fullAutonomyCurrent,
  };
  const tampered = { ...configuration, machineAppendEnabled: false };
  fs.writeFileSync(configPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(() => plane.loadConfiguredIntakes(request), (error) =>
    !isResidentReactivationRequired(error)
      && /autonomous_research_machine_intake_configuration_invalid/.test(error.message));
  assert.equal(plane.machineIntakeRepository.readStatus().configuredSourceAuthorityHash,
    configuration.configurationHash);
  assert.equal(plane.machineIntakeRepository.readStatus().pendingCount, 0);

  const recurringGolden = buildAutonomousResearchRecurringGoldenTemplate({
    templateId: 'configuration-rotation-golden',
    epochDurationMs: 12 * 60 * 60 * 1000,
    objective: 'Qualify a valid replacement configuration after resident restart.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: profile.registeredResearchProfiles[0].datasetMounts,
    providerConfigurationHash: PROVIDER_HASH,
    revisionRounds: 1,
    refereeCount: 2,
  });
  const rotated = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [recurringGolden],
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  fs.writeFileSync(configPath, `${JSON.stringify(rotated)}\n`, { mode: 0o600 });
  await assert.rejects(() => plane.loadConfiguredIntakes(request), (error) =>
    isResidentReactivationRequired(error)
      && error.source === 'machine_intake_configuration'
      && error.startupIdentityHash === configuration.configurationHash
      && error.observedIdentityHash === rotated.configurationHash);
  assert.equal(providerCanaryCalls, 0);
  assert.equal(plane.machineIntakeRepository.readStatus().pendingCount, 0);
});

test('second autonomy check downgrade prevents topic reservation, canary, and generation', async (t) => {
  const fixture = setup(t);
  let autonomyChecks = 0;
  const result = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent() {
      autonomyChecks += 1;
      return Object.freeze({
        ready: true,
        operationMode: autonomyChecks === 1 ? 'full' : 'bootstrap-only',
      });
    },
  });
  const status = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
  assert.equal(autonomyChecks, 2);
  assert.equal(result.ready, false);
  assert.match(result.error, /autonomy_fence_invalid/);
  assert.equal(fixture.canaryCalls(), 0);
  assert.equal(status.providerCanaryAttemptCount, 0);
  assert.equal(status.providerCanaryReservedCostUsd, 0);
  assert.equal(status.producedTopicCount, 0);
  assert.equal(fixture.machineIntakeRepository.readStatus().pendingProductionCount, 0);
});

test('machine intake plane preserves the supervisor autonomy callback into producer actions', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-plane-autonomy-fence-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const profile = producerProfile();
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  installMachineIntakeExternalGenesisAuthority({
    configurationHash: configuration.configurationHash,
    producerProfileHash: profile.producerProfileHash,
  });
  const configPath = path.join(runtimeRoot, 'machine-intake.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  const now = new Date('2026-07-17T00:00:00.000Z');
  let autonomyChecks = 0;
  let providerCanaryCalls = 0;
  const plane = composeAutonomousResearchMachineIntakePlane({
    runtimeRoot,
    configuration,
    configPath,
    providerConfiguration: {
      autonomousResearchProviderConfigurationHash: PROVIDER_HASH,
    },
    environment: {},
    producerInspection: {
      ready: true,
      producerProfile: profile,
      implementationIdentity: { ready: true, implementationSha256: profile.implementationSha256 },
      datasetSnapshot: { datasetSnapshotHash: H('fenced-dataset-snapshot') },
      profilePath: path.join(runtimeRoot, 'unused-profile.json'),
    },
    providerCanaryPairMaximumCostUsd: 1,
    async providerCanaryRunner(input) {
      providerCanaryCalls += 1;
      const receipt = canaryPair(now);
      checkpointCanaryPair(input, receipt);
      return receipt;
    },
    clock: { now: () => new Date(now) },
    ownerId: 'producer:plane-autonomy-fence',
  });
  t.after(() => plane.close());
  const loaded = await plane.loadConfiguredIntakes({
    now,
    residentLeaseContext: residentContext(),
    operationMode: 'full',
    assertAutonomyCurrent() {
      autonomyChecks += 1;
      return Object.freeze({
        ready: true,
        operationMode: autonomyChecks === 1 ? 'full' : 'bootstrap-only',
      });
    },
  });
  const status = plane.producerRepository.readStatus({ now });
  assert.equal(autonomyChecks, 2);
  assert.equal(loaded.topicProducer.ready, false);
  assert.equal(providerCanaryCalls, 0);
  assert.equal(status.providerCanaryAttemptCount, 0);
  assert.equal(status.producedTopicCount, 0);
  assert.equal(plane.machineIntakeRepository.readStatus().pendingProductionCount, 0);
});

test('production producer emits one bounded v2 admission and suppresses paid work while pending', async (t) => {
  const fixture = setup(t);
  const first = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(first.status, 'autonomous_research_topic_producer_intake_generated');
  assert.equal(fixture.canaryCalls(), 1);
  const record = fixture.machineIntakeRepository.readIntake(first.intakeId);
  assert.equal(record.sourceKind, 'machine');
  assert.equal(record.intake.launchMode, 'production-run');
  assert.equal(record.intake.recurringGoldenProvenance, null);
  assert.equal(record.admission.version, 2);
  assert.equal(record.admission.topicProducerCapabilityReceipt.safety
    .scientificNoveltyVerified, false);
  assert.equal(record.admission.topicProducerCapabilityReceipt.producerProfileHash,
    fixture.profile.producerProfileHash);
  assert.match(record.intake.objective, /does not assert scientific novelty/);

  fixture.setNow('2026-07-17T00:01:00.000Z');
  const suppressed = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(suppressed.status,
    'autonomous_research_topic_producer_suppressed_by_pending_production');
  assert.equal(suppressed.externalActionPerformed, false);
  assert.equal(fixture.canaryCalls(), 1);
  assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
    .providerCanaryAttemptCount, 1);
});

test('self-hashed forged capability and replay cannot cross the opaque append authority', async (t) => {
  const fixture = setup(t);
  const lease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:attacker', leaseMs: 15 * 60 * 1000, now: fixture.clock.now(),
  });
  const plan = fixture.producerRepository.prepareGeneration({ lease, now: fixture.clock.now() });
  const forged = buildAutonomousResearchTopicProducerCapabilityReceipt({
    producerProfile: fixture.profile,
    machineIntakeConfigurationHash: fixture.configuration.configurationHash,
    generationSequence: plan.generationSequence,
    intake: plan.plannedGeneration.intake,
    plannedGeneration: plan.plannedGeneration,
    providerCanaryPairReceipt: canaryPair(fixture.clock.now()),
    producerLeaseGeneration: lease.leaseGeneration,
    producerLeaseTokenHash: hashRecord(
      'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
    ),
    residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
    residentLeaseTokenHash: hashRecord(
      'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
    ),
    capabilityNonce: 'producer-nonce:00000000000000000000000000000000',
    now: fixture.clock.now(),
  });
  assert.throws(() => fixture.machineIntakeRepository.appendMachineIntake({
    intake: plan.plannedGeneration.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    topicProducerCapabilityReceipt: forged,
    topicProducerAppendAuthorization: Object.freeze({ forged: true }),
    now: fixture.clock.now(),
  }), /append_authorization_invalid_or_replayed/);
  assert.equal(fixture.machineIntakeRepository.readStatus().pendingProductionCount, 0);
  fixture.producerRepository.releaseLease({ lease });

  const produced = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(produced.generated, true);
  const record = fixture.machineIntakeRepository.readIntake(produced.intakeId);
  assert.throws(() => fixture.machineIntakeRepository.appendMachineIntake({
    intake: record.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    topicProducerCapabilityReceipt: record.admission.topicProducerCapabilityReceipt,
    topicProducerAppendAuthorization: Object.freeze({ replay: true }),
    now: fixture.clock.now(),
  }), /append_authorization_invalid_or_replayed/);
});

test('v2 direct API bypass and legacy preseed upgrade both fail closed', (t) => {
  const fixture = setup(t);
  const bypassLease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:direct-bypass', leaseMs: 15 * 60 * 1000, now: fixture.clock.now(),
  });
  const generated = fixture.producerRepository.prepareGeneration({
    lease: bypassLease,
    now: fixture.clock.now(),
  });
  assert.throws(() => appendMachineAutonomousResearchIntake({
    configuration: fixture.configuration,
    repository: fixture.machineIntakeRepository,
    intake: generated.plannedGeneration.intake,
    now: fixture.clock.now(),
  }), /producer_capability_required/);

  const preseedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-topic-preseed-'));
  t.after(() => fs.rmSync(preseedRoot, { recursive: true, force: true }));
  const legacy = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: preseedRoot,
    authorizedSourceAuthorityHash: fixture.configuration.configurationHash,
  });
  legacy.appendMachineIntake({
    intake: generated.plannedGeneration.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    now: fixture.clock.now(),
  });
  legacy.close();
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: preseedRoot,
    authorizedSourceAuthorityHash: fixture.configuration.configurationHash,
    authorizedMachineProducerProfileHash: fixture.profile.producerProfileHash,
    machineProducerAppendAuthority: fixture.producerRepository,
  }), /producer_authority_mismatch/);
  fixture.producerRepository.releaseLease({ lease: bypassLease });
});
