import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createExternallyFencedSqliteMutationCoordinator,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {
  externallyFencedSqliteWriterPlanHash,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('ExternallyFencedSqliteMutationCoordinatorTest', { label });
const NOW = new Date('2026-07-18T08:00:00.000Z');
const OPERATION_ID = 'resident-instance.commit.v1';

function operationPlans() {
  return Object.freeze({
    [OPERATION_ID]: Object.freeze({
      version: 1,
      operationId: OPERATION_ID,
      statements: Object.freeze([
        Object.freeze({
          statementId: 'increment',
          mode: 'run',
          sql: 'UPDATE resident_state SET generation=generation+1 WHERE singleton=1',
        }),
        Object.freeze({
          statementId: 'set',
          mode: 'run',
          sql: 'UPDATE resident_state SET generation=? WHERE singleton=1',
        }),
      ]),
    }),
  });
}

function manifest(plans) {
  const integratedRole = 'resident-instance';
  const operations = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map((role) => ({
    operationId: `${role}.commit.v1`,
    databaseRole: role,
    sourceFile: `paper-adapters/automation/${role}-writer.mjs`,
    entrypoint: `${role}.commit`,
    mutationClass: 'business-dml',
    protocolStatus: role === integratedRole
      ? AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS
      : AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
    coordinatorIntegrated: role === integratedRole,
  }));
  return Object.freeze({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'coordinator-test-manifest-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze(
      [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort(),
    ),
    writers: Object.freeze([{
      writerId: 'writer:resident-instance',
      databaseRoles: Object.freeze([integratedRole]),
      operationIds: Object.freeze([`${integratedRole}.commit.v1`]),
      implementationHash: externallyFencedSqliteWriterPlanHash({
        writerId: 'writer:resident-instance',
        operationPlans: [plans[OPERATION_ID]],
      }),
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    }]),
    operations: Object.freeze(operations),
    coverage: Object.freeze({
      requiredRoleCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
      coveredRoleCount: 1,
      coveredDatabaseRoles: Object.freeze([integratedRole]),
      percent: Number((100 / AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length).toFixed(2)),
    }),
  });
}

function schemaHash(database) {
  const rows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

function databaseFixture(trust, {
  rejectMarkerInsert = false,
  rejectFinalizationInsert = false,
  createNoPrimaryKeyTable = false,
  attachDatabase = false,
  createBusinessTrigger = false,
} = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE resident_state(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    generation INTEGER NOT NULL
  ) STRICT;
  INSERT INTO resident_state(singleton,generation) VALUES(1,0);`);
  for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
    database.exec(statement);
  }
  if (createNoPrimaryKeyTable) {
    database.exec('CREATE TABLE untracked_state(value INTEGER NOT NULL);');
  }
  if (attachDatabase) database.exec("ATTACH DATABASE ':memory:' AS auxiliary;");
  if (createBusinessTrigger) {
    database.exec(`CREATE TRIGGER resident_state_side_effect
AFTER UPDATE ON resident_state
BEGIN UPDATE resident_state SET generation=generation WHERE singleton=1; END;`);
  }
  if (rejectMarkerInsert) {
    database.exec(`CREATE TRIGGER coordinator_test_reject_marker
BEFORE INSERT ON autonomous_research_online_mutation_authority_marker
BEGIN SELECT RAISE(ABORT, 'coordinator_test_marker_rejected'); END;`);
  }
  if (rejectFinalizationInsert) {
    database.exec(`CREATE TRIGGER coordinator_test_reject_finalization
BEFORE INSERT ON autonomous_research_online_mutation_finalization_receipt
BEGIN SELECT RAISE(ABORT, 'coordinator_test_finalization_rejected'); END;`);
  }
  const observedSchemaHash = schemaHash(database);
  database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_metadata(
  singleton,schema_version,protocol,database_role,database_instance_id,
  schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
  genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
  genesis_database_hash,genesis_state_hash,provisioned_at
) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
    AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    'resident-instance',
    'resident-instance',
    'resident-instance-schema-v1',
    observedSchemaHash,
    trust.databaseScopeHash,
    trust.writerManifestHash,
    0,
    H('genesis-global'),
    0,
    H('genesis-database'),
    H('genesis-state'),
    NOW.toISOString(),
  );
  return { database, observedSchemaHash };
}

function fakeAuthority(trust, observedSchemaHash, {
  loseReserveResponse = false,
  failResolve = false,
  rejectReserveBeforeApply = false,
  reservationLeaseMs = 60_000,
} = {}) {
  const calls = [];
  let failFinalize = false;
  let resolvedReservation = null;
  let head = {
    globalSequence: 0,
    globalHash: H('genesis-global'),
    databaseSequence: 0,
    databaseHash: H('genesis-database'),
    stateHash: H('genesis-state'),
  };
  const client = {
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    trust,
    observeCurrentHead({ request }) {
      calls.push({ method: 'head', request });
      return {
        globalSequence: head.globalSequence,
        globalHash: head.globalHash,
        databaseHeads: [{
          databaseRole: 'resident-instance',
          databaseInstanceId: 'resident-instance',
          sequence: head.databaseSequence,
          hash: head.databaseHash,
          schemaHash: observedSchemaHash,
          stateHash: head.stateHash,
        }],
      };
    },
    reserveMutation({ request }) {
      calls.push({ method: 'reserve', request });
      if (rejectReserveBeforeApply) throw new Error('simulated_reserve_rejected');
      resolvedReservation = Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationReservationReceipt',
        status: 'autonomous_research_online_mutation_reserved',
        authorityId: 'authority:test',
        keyId: 'key:test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationReserveRequest', request),
        reservationId: `reservation:${calls.length}`,
        globalSequence: request.globalPreviousSequence + 1,
        globalHash: H(`global:${calls.length}`),
        databaseSequence: request.databasePreviousSequence + 1,
        databaseHash: H(`database:${calls.length}`),
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + reservationLeaseMs).toISOString(),
        signature: 'dGVzdA==',
      });
      if (loseReserveResponse) throw new Error('simulated_reserve_response_lost');
      return resolvedReservation;
    },
    verifyStoredReservation() { return true; },
    resolveMutationAttempt({ request }) {
      calls.push({ method: 'resolve', request });
      if (failResolve) throw new Error('simulated_reservation_resolution_outage');
      return resolvedReservation;
    },
    finalizeMutation({ request, reservation, now }) {
      calls.push({ method: 'finalize', request });
      if (failFinalize) throw new Error('simulated_finalize_outage');
      head = {
        globalSequence: reservation.globalSequence,
        globalHash: reservation.globalHash,
        databaseSequence: reservation.databaseSequence,
        databaseHash: reservation.databaseHash,
        stateHash: reservation.postStateHash,
      };
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
        status: 'autonomous_research_online_mutation_finalized',
        authorityId: 'authority:test',
        keyId: 'key:test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationFinalizeRequest', request),
        sideEffectPermitHash: H(`permit:${reservation.reservationId}`),
        finalizedAt: new Date(now || NOW).toISOString(),
        signature: 'dGVzdA==',
      });
    },
    abortMutation({ request }) {
      calls.push({ method: 'abort', request });
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationAbortReceipt',
        status: 'autonomous_research_online_mutation_aborted',
        authorityId: 'authority:test',
        keyId: 'key:test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationAbortRequest', request),
        abortedAt: NOW.toISOString(),
        signature: 'dGVzdA==',
      });
    },
  };
  return {
    client,
    calls,
    setFailFinalize(value) { failFinalize = value; },
  };
}

function recoverabilityFenceFixture() {
  const requirements = [];
  const finalizedHeads = [];
  return Object.freeze({
    requirements,
    finalizedHeads,
    fence: Object.freeze({
      markMutationFinalized(head) {
        finalizedHeads.push(Object.freeze({ ...head }));
      },
      markMutationReconciliationRequired(requirement) {
        requirements.push(Object.freeze({ ...requirement }));
      },
      assertCurrent() { return Object.freeze({ status: 'current' }); },
      async reconcile() { return Object.freeze({ status: 'ready' }); },
    }),
  });
}

function setup(t, options = {}) {
  const plans = operationPlans();
  const writerManifest = manifest(plans);
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'authority:test',
    keyId: 'key:test',
    scopeId: 'scope:test',
    databaseScopeHash: H('database-scope'),
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(writerManifest),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  const fixture = databaseFixture(trust, options);
  t.after(() => fixture.database.close());
  const authority = fakeAuthority(trust, fixture.observedSchemaHash, options);
  let clockNow = NOW;
  const coordinator = createExternallyFencedSqliteMutationCoordinator({
    authorityClient: authority.client,
    authorityTrust: trust,
    manifest: writerManifest,
    operationPlans: plans,
    databaseInstances: Object.freeze([{
      databaseRole: 'resident-instance',
      databaseInstanceId: 'resident-instance',
      schemaHash: fixture.observedSchemaHash,
    }]),
    recoverabilityEpochFence: options.recoverabilityEpochFence || null,
    clock: { now: () => clockNow },
  });
  const input = {
    database: fixture.database,
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    schemaContractId: 'resident-instance-schema-v1',
    writerId: 'writer:resident-instance',
    operationId: 'resident-instance.commit.v1',
    authorizationReceiptHashes: Object.freeze([H('authorization')]),
    sideEffectReservationHashes: Object.freeze([]),
  };
  return {
    ...fixture,
    authority,
    coordinator,
    input,
    setClock(value) { clockNow = new Date(value); },
  };
}

test('coordinator reserves, commits an immutable marker, finalizes, and exposes the permit', (t) => {
  const { database, authority, coordinator, input } = setup(t);
  let escapedTransaction = null;
  const receipt = coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      escapedTransaction = transaction;
      assert.equal(Object.hasOwn(transaction, 'exec'), false);
      assert.equal(Object.hasOwn(transaction, 'prepare'), false);
      return transaction.run('increment').changes;
    },
  });
  assert.equal(receipt.status, 'externally_fenced_sqlite_mutation_finalized');
  assert.equal(receipt.value, 1);
  assert.match(receipt.sideEffectPermitHash, /^sha256:/);
  assert.equal(database.prepare('SELECT generation FROM resident_state').get().generation, 1);
  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM autonomous_research_online_mutation_authority_marker',
  ).get().count, 1);
  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM autonomous_research_online_mutation_finalization_receipt',
  ).get().count, 1);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'finalize',
  ]);
  assert.equal(coordinator.inspectStatus().status,
    'externally_fenced_sqlite_mutation_coordinator_partial');
  assert.throws(
    () => escapedTransaction.run('increment'),
    /externally_fenced_sqlite_mutation_transaction_revoked/,
  );
});

test('callback, async, and unregistered-statement failures roll back without reserving authority state', async (t) => {
  const { database, authority, coordinator, input } = setup(t);
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      transaction.run('set', 1);
      throw new Error('candidate_failed');
    },
  }), /candidate_failed/);
  assert.equal(database.prepare('SELECT generation FROM resident_state').get().generation, 0);
  assert.deepEqual(authority.calls.map((call) => call.method), ['head']);

  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate: async () => 1,
  }), /externally_fenced_sqlite_mutation_async_callback_forbidden/);
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) { transaction.run('not-registered'); },
  }), /externally_fenced_sqlite_mutation_statement_not_authorized/);
  assert.equal(authority.calls.filter((call) => call.method === 'reserve').length, 0);
});

test('the next write auto-recovers a finalize outage and requires retry before new DML', (t) => {
  const recoverability = recoverabilityFenceFixture();
  const { database, authority, coordinator, input } = setup(t, {
    recoverabilityEpochFence: recoverability.fence,
  });
  let mutationCalls = 0;
  authority.setFailFinalize(true);
  let pendingReservationId;
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      mutationCalls += 1;
      transaction.run('increment');
      return 'committed-once';
    },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_committed_finalization_pending'
    && error.committed === true
    && error.stateRecoverabilityDeferred === true
    && error.retryable === true
    && Boolean(pendingReservationId = error.reservationId)
  ));
  assert.deepEqual(recoverability.requirements, [{
    reason: 'externally_fenced_sqlite_mutation_committed_finalization_pending',
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    reservationId: pendingReservationId,
    mutationAttemptId: recoverability.requirements[0].mutationAttemptId,
    committed: true,
  }]);
  assert.equal(database.prepare('SELECT generation FROM resident_state').get().generation, 1);
  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM autonomous_research_online_mutation_finalization_receipt',
  ).get().count, 0);
  authority.setFailFinalize(false);
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      mutationCalls += 1;
      transaction.run('increment');
      return 'must-not-run-during-recovery';
    },
  }), (error) => (
    error.message
      === 'externally_fenced_sqlite_mutation_pending_recovery_completed_retry_required'
    && error.stateRecoverabilityDeferred === true
    && error.retryable === true
    && Array.isArray(error.recoveredReservationIds)
    && error.recoveredReservationIds.length === 1
    && error.recoveredReservationIds[0] === pendingReservationId
  ));
  assert.equal(mutationCalls, 1);
  assert.deepEqual(recoverability.finalizedHeads, [{
    globalSequence: 1,
    globalHash: H('global:2'),
  }]);
  assert.equal(database.prepare('SELECT generation FROM resident_state').get().generation, 1);
  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM autonomous_research_online_mutation_finalization_receipt',
  ).get().count, 1);
  const receipt = coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      mutationCalls += 1;
      transaction.run('increment');
      return 'committed-after-retry';
    },
  });
  assert.equal(receipt.status, 'externally_fenced_sqlite_mutation_finalized');
  assert.equal(receipt.value, 'committed-after-retry');
  assert.equal(mutationCalls, 2);
  assert.equal(database.prepare('SELECT generation FROM resident_state').get().generation, 2);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'finalize',
    'finalize',
    'head', 'reserve', 'finalize',
  ]);
});

test('an unresolved remote reservation becomes sticky recoverability defer and rolls back local DML', (t) => {
  const recoverability = recoverabilityFenceFixture();
  const { database, coordinator, input } = setup(t, {
    loseReserveResponse: true,
    failResolve: true,
    recoverabilityEpochFence: recoverability.fence,
  });
  let mutationCalls = 0;
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      mutationCalls += 1;
      transaction.run('increment');
    },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_reservation_resolution_pending'
    && error.stateRecoverabilityDeferred === true
    && error.retryable === true
    && error.committed === undefined
  ));
  assert.equal(mutationCalls, 1);
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 0);
  assert.equal(recoverability.requirements.length, 1);
  assert.deepEqual(recoverability.requirements[0], {
    reason: 'externally_fenced_sqlite_mutation_reservation_resolution_pending',
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    reservationId: null,
    mutationAttemptId: recoverability.requirements[0].mutationAttemptId,
    committed: false,
  });
});

test('a local marker failure rolls back business DML and aborts the external reservation', (t) => {
  const { database, authority, coordinator, input } = setup(t, {
    rejectMarkerInsert: true,
  });
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      transaction.run('increment');
    },
  }), /coordinator_test_marker_rejected/);
  assert.equal(database.prepare('SELECT generation FROM resident_state').get().generation, 0);
  assert.equal(database.prepare(
    'SELECT count(*) AS count FROM autonomous_research_online_mutation_authority_marker',
  ).get().count, 0);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'abort',
  ]);
  assert.equal(authority.calls.at(-1).request.reason, 'local-marker-failed');
});

test('a lost reserve response is resolved by stable mutation attempt without rerunning DML', (t) => {
  const { database, authority, coordinator, input } = setup(t, {
    loseReserveResponse: true,
  });
  let mutationCalls = 0;
  const receipt = coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      mutationCalls += 1;
      transaction.run('increment');
    },
  });
  assert.equal(receipt.status, 'externally_fenced_sqlite_mutation_finalized');
  assert.equal(mutationCalls, 1);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'resolve', 'finalize',
  ]);
  assert.equal(
    authority.calls[1].request.mutationAttemptId,
    authority.calls[2].request.mutationAttemptId,
  );
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 1);
});

test('a signed not-found reserve resolution rolls back the local mutation', (t) => {
  const { database, authority, coordinator, input } = setup(t, {
    rejectReserveBeforeApply: true,
  });
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) { transaction.run('increment'); },
  }), /externally_fenced_sqlite_mutation_reservation_not_applied/);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'resolve',
  ]);
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 0);
});

test('operation plans reject transaction control and DDL before a coordinator can be built', () => {
  for (const sql of [
    'COMMIT; BEGIN IMMEDIATE',
    'END TRANSACTION',
    'CREATE TABLE escaped(id INTEGER PRIMARY KEY)',
    "ATTACH DATABASE ':memory:' AS escaped",
    'PRAGMA writable_schema=ON',
  ]) {
    assert.throws(() => externallyFencedSqliteWriterPlanHash({
      writerId: 'writer:resident-instance',
      operationPlans: [{
        version: 1,
        operationId: OPERATION_ID,
        statements: [{ statementId: 'attack', mode: 'run', sql }],
      }],
    }), /externally_fenced_sqlite_mutation_statement_plan_invalid/);
  }
});

test('operation plans accept CASE expressions without weakening transaction control', () => {
  assert.doesNotThrow(() => externallyFencedSqliteWriterPlanHash({
    writerId: 'writer:resident-instance',
    operationPlans: [{
      version: 1,
      operationId: OPERATION_ID,
      statements: [{
        statementId: 'case-expression',
        mode: 'run',
        sql: `UPDATE resident_state SET generation=CASE
          WHEN generation<0 THEN 0 ELSE generation+1 END
          WHERE singleton=1`,
      }],
    }],
  }));
});

test('attached databases and matching write triggers fail before authority observation', (t) => {
  for (const options of [
    { attachDatabase: true, blocker: /attached_database_forbidden/ },
    { createBusinessTrigger: true, blocker: /business_trigger_forbidden/ },
  ]) {
    const nested = setup(t, options);
    assert.throws(() => nested.coordinator.executeMutation({
      ...nested.input,
      mutate(transaction) { transaction.run('increment'); },
    }), options.blocker);
    assert.deepEqual(nested.authority.calls, []);
    assert.equal(nested.database.prepare(
      'SELECT generation FROM resident_state WHERE singleton=1',
    ).get().generation, 0);
  }
});

test('an unrelated no-PK table cannot block a pinned target-table mutation', (t) => {
  const { database, coordinator, input } = setup(t, { createNoPrimaryKeyTable: true });
  assert.doesNotThrow(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) { transaction.run('increment'); },
  }));
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 1);
});

test('an expiring reservation is rolled back and aborted before local commit', (t) => {
  const { database, authority, coordinator, input } = setup(t, {
    reservationLeaseMs: 500,
  });
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) { transaction.run('increment'); },
  }), /externally_fenced_sqlite_mutation_reservation_expiring/);
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 0);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'abort',
  ]);
});

test('an ambiguous COMMIT error never aborts a reservation that may have committed', (t) => {
  const recoverability = recoverabilityFenceFixture();
  const { database, authority, coordinator, input } = setup(t, {
    recoverabilityEpochFence: recoverability.fence,
  });
  const ambiguousDatabase = {
    get isTransaction() { return database.isTransaction; },
    prepare: (...arguments_) => database.prepare(...arguments_),
    createSession: (...arguments_) => database.createSession(...arguments_),
    exec(sql) {
      const result = database.exec(sql);
      if (sql === 'COMMIT;') throw new Error('simulated_commit_response_lost');
      return result;
    },
  };
  assert.throws(() => coordinator.executeMutation({
    ...input,
    database: ambiguousDatabase,
    mutate(transaction) { transaction.run('increment'); },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_commit_outcome_unknown'
    && error.committed === 'unknown'
    && error.stateRecoverabilityDeferred === true
    && error.retryable === true
  ));
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 1);
  assert.equal(database.prepare(`
SELECT count(*) AS count FROM autonomous_research_online_mutation_authority_marker;
`).get().count, 1);
  assert.deepEqual(authority.calls.map((call) => call.method), ['head', 'reserve']);
  assert.equal(recoverability.requirements.length, 1);
  assert.equal(
    recoverability.requirements[0].reason,
    'externally_fenced_sqlite_mutation_commit_outcome_unknown',
  );
  assert.equal(recoverability.requirements[0].committed, 'unknown');
  assert.match(recoverability.requirements[0].reservationId, /^reservation:/);
});

test('post-commit finalization recording failure is explicitly pending and blocks new writes', (t) => {
  const recoverability = recoverabilityFenceFixture();
  const { database, authority, coordinator, input } = setup(t, {
    rejectFinalizationInsert: true,
    recoverabilityEpochFence: recoverability.fence,
  });
  let mutationCalls = 0;
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      mutationCalls += 1;
      transaction.run('increment');
    },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_committed_finalization_record_pending'
    && error.committed === true
    && error.stateRecoverabilityDeferred === true
    && error.retryable === true
  ));
  assert.equal(recoverability.requirements.length, 1);
  assert.equal(
    recoverability.requirements[0].reason,
    'externally_fenced_sqlite_mutation_committed_finalization_record_pending',
  );
  assert.equal(recoverability.requirements[0].committed, true);
  const callCount = authority.calls.length;
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 1);
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) {
      mutationCalls += 1;
      transaction.run('increment');
    },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_pending_recovery_failed'
    && error.pendingFinalizationCount === 1
    && error.cause?.message === 'coordinator_test_finalization_rejected'
  ));
  assert.equal(mutationCalls, 1);
  assert.equal(database.prepare(
    'SELECT generation FROM resident_state WHERE singleton=1',
  ).get().generation, 1);
  assert.equal(authority.calls.length, callCount + 1);
  assert.equal(authority.calls.at(-1).method, 'finalize');
});

test('a committed marker can be finalized after its reservation lease expires', (t) => {
  const { database, authority, coordinator, input, setClock } = setup(t);
  authority.setFailFinalize(true);
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) { transaction.run('increment'); },
  }), /externally_fenced_sqlite_mutation_committed_finalization_pending/);
  authority.setFailFinalize(false);
  setClock(new Date(NOW.getTime() + 2 * 60_000));
  const recovery = coordinator.recoverPendingMutations({ database });
  assert.equal(recovery.recoveredReservationIds.length, 1);
  assert.equal(database.prepare(`
SELECT count(*) AS count FROM autonomous_research_online_mutation_finalization_receipt;
`).get().count, 1);
});

test('recovery rejects a same-schema marker whose signed reservation JSON was tampered', (t) => {
  const { database, authority, coordinator, input } = setup(t);
  authority.setFailFinalize(true);
  assert.throws(() => coordinator.executeMutation({
    ...input,
    mutate(transaction) { transaction.run('increment'); },
  }), /externally_fenced_sqlite_mutation_committed_finalization_pending/);
  const triggerSql = database.prepare(`
SELECT sql FROM sqlite_schema
WHERE type='trigger' AND name='autonomous_research_online_mutation_marker_no_update';
`).get().sql;
  database.exec('DROP TRIGGER autonomous_research_online_mutation_marker_no_update;');
  database.exec(`UPDATE autonomous_research_online_mutation_authority_marker
SET operation_id='tampered-operation',
    reservation_receipt_json=json_set(
      reservation_receipt_json,'$.operationId','tampered-operation'
    );`);
  database.exec(triggerSql);
  authority.setFailFinalize(false);
  const priorCalls = authority.calls.length;
  assert.throws(
    () => coordinator.recoverPendingMutations({ database }),
    /externally_fenced_sqlite_mutation_recovery_reservation_invalid/,
  );
  assert.equal(authority.calls.length, priorCalls);
});
