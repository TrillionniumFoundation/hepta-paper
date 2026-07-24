import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  createExternallyFencedSqliteMutationCoordinator,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {
  NATIVE_STORE_LEDGER_MUTATION_PLANS,
  NATIVE_STORE_LEDGER_OPERATION_IDS,
  NATIVE_STORE_LEDGER_STATEMENT_IDS,
  NATIVE_STORE_LEDGER_WRITER_ID,
  NATIVE_STORE_LEDGER_WRITER_PLAN_HASH,
} from '../../paper-adapters/persistence/native-store-ledger-mutation-plan.mjs';
import {
  issueLedgerAdministratorWriter,
  issueWorkflowStateProjectorWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import {
  createSqliteJobReceiptStore,
} from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import {
  createSqliteReceiptLedger,
  preparedSqliteReceiptLedgerMutation,
} from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  createSqliteReceiptLedgerQualificationStore,
} from '../../paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs';
import {
  createSqliteWorkflowStateStore,
} from '../../paper-adapters/persistence/sqlite-workflow-state-store.mjs';
import {
  NATIVE_STORE_DATABASE_INSTANCE_ID,
  NATIVE_STORE_SCHEMA_CONTRACT_ID,
} from '../../paper-adapters/persistence/native-store-online-mutation-plan.mjs';
import {
  createDefaultPaperStore,
  openExistingExternallyFencedPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  sealReceiptHash,
} from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-18T13:00:00.000Z');
const H = (label) => hashRecord('NativeStoreLedgerOnlineMutationTest', { label });
const clock = Object.freeze({
  now: () => new Date(NOW),
  nowIso: () => NOW.toISOString(),
});

const NATIVE_OPERATIONS = Object.freeze([
  ['acquireJobLease', 'paper-adapters/persistence/sqlite-job-receipt-store.mjs', 'acquireLease', 'lease-or-budget-dml'],
  ['completeJob', 'paper-adapters/persistence/sqlite-job-receipt-store.mjs', 'completeJob', 'business-dml'],
  ['createJob', 'paper-adapters/persistence/sqlite-job-receipt-store.mjs', 'createJob', 'business-dml'],
  ['failJob', 'paper-adapters/persistence/sqlite-job-receipt-store.mjs', 'failJob', 'business-dml'],
  ['qualifyReceipt', 'paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs', 'qualify', 'business-dml'],
  ['recordJobAttempt', 'paper-adapters/persistence/sqlite-job-receipt-store.mjs', 'recordAttempt', 'lease-or-budget-dml'],
  ['recordReceipt', 'paper-adapters/persistence/sqlite-receipt-ledger.mjs', 'record', 'business-dml'],
  ['renewJobAttemptLease', 'paper-adapters/persistence/sqlite-job-receipt-store.mjs', 'renewAttemptLease', 'lease-or-budget-dml'],
  ['putWorkflowState', 'paper-adapters/persistence/sqlite-workflow-state-store.mjs', 'put', 'business-dml'],
]);

function writerManifest() {
  const native = NATIVE_OPERATIONS.map(([key, sourceFile, entrypoint, mutationClass]) => (
    Object.freeze({
      operationId: NATIVE_STORE_LEDGER_OPERATION_IDS[key],
      databaseRole: 'native-store',
      sourceFile,
      entrypoint,
      mutationClass,
      protocolStatus: AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
      coordinatorIntegrated: true,
    })
  ));
  const pending = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES
    .filter((databaseRole) => databaseRole !== 'native-store')
    .map((databaseRole) => Object.freeze({
      operationId: `${databaseRole}.pending.v1`,
      databaseRole,
      sourceFile: `paper-adapters/automation/${databaseRole}-pending.mjs`,
      entrypoint: 'pending',
      mutationClass: 'schema-or-genesis-ddl',
      protocolStatus: AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
      coordinatorIntegrated: false,
    }));
  const operationIds = Object.freeze(
    Object.keys(NATIVE_STORE_LEDGER_MUTATION_PLANS).sort(),
  );
  return Object.freeze({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'native-store-ledger-online-mutation-test-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze(
      [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort(),
    ),
    writers: Object.freeze([Object.freeze({
      writerId: NATIVE_STORE_LEDGER_WRITER_ID,
      databaseRoles: Object.freeze(['native-store']),
      operationIds,
      implementationHash: NATIVE_STORE_LEDGER_WRITER_PLAN_HASH,
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    })]),
    operations: Object.freeze([...native, ...pending]),
    coverage: Object.freeze({
      requiredRoleCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
      coveredRoleCount: 1,
      coveredDatabaseRoles: Object.freeze(['native-store']),
      percent: Number((100 / AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length).toFixed(2)),
    }),
  });
}

function exactSchemaHash(database) {
  const rows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql
`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

function provisionDatabase(databasePath, trust) {
  const offline = createDefaultPaperStore({
    root: path.dirname(databasePath),
    runtimeRoot: path.dirname(databasePath),
    dbPath: databasePath,
  });
  const inserted = offline.execute(`INSERT INTO papers(
    slug,title,canonical_dir,status
  ) VALUES('paper-online','Online paper','paper-online','draft')`);
  assert.equal(inserted.ok, true);
  offline.close();

  const database = new DatabaseSync(databasePath);
  for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
    database.exec(statement);
  }
  const schemaHash = exactSchemaHash(database);
  database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_metadata(
  singleton,schema_version,protocol,database_role,database_instance_id,
  schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
  genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
  genesis_database_hash,genesis_state_hash,provisioned_at
) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
    AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    'native-store',
    NATIVE_STORE_DATABASE_INSTANCE_ID,
    NATIVE_STORE_SCHEMA_CONTRACT_ID,
    schemaHash,
    trust.databaseScopeHash,
    trust.writerManifestHash,
    0,
    H('genesis-global'),
    0,
    H('genesis-database'),
    H('genesis-state'),
    NOW.toISOString(),
  );
  database.close();
  return schemaHash;
}

function fakeAuthority(trust, schemaHash) {
  const calls = [];
  let failFinalize = false;
  let sequence = 0;
  let reservation = null;
  let head = Object.freeze({
    globalSequence: 0,
    globalHash: H('genesis-global'),
    databaseSequence: 0,
    databaseHash: H('genesis-database'),
    stateHash: H('genesis-state'),
  });
  const client = Object.freeze({
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    trust,
    observeCurrentHead({ request }) {
      calls.push(Object.freeze({ method: 'head', request }));
      return Object.freeze({
        globalSequence: head.globalSequence,
        globalHash: head.globalHash,
        databaseHeads: Object.freeze([Object.freeze({
          databaseRole: 'native-store',
          databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
          sequence: head.databaseSequence,
          hash: head.databaseHash,
          schemaHash,
          stateHash: head.stateHash,
        })]),
      });
    },
    reserveMutation({ request }) {
      calls.push(Object.freeze({ method: 'reserve', request }));
      sequence += 1;
      reservation = Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationReservationReceipt',
        status: 'autonomous_research_online_mutation_reserved',
        authorityId: 'authority:native-store-ledger-test',
        keyId: 'key:native-store-ledger-test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationReserveRequest', request),
        reservationId: `reservation:native-store-ledger:${sequence}`,
        globalSequence: request.globalPreviousSequence + 1,
        globalHash: H(`global:${sequence}`),
        databaseSequence: request.databasePreviousSequence + 1,
        databaseHash: H(`database:${sequence}`),
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        signature: 'dGVzdA==',
      });
      return reservation;
    },
    verifyStoredReservation() { return true; },
    resolveMutationAttempt() { return reservation; },
    finalizeMutation({ request, reservation: reserved, now }) {
      calls.push(Object.freeze({ method: 'finalize', request }));
      if (failFinalize) throw new Error('simulated_native_store_ledger_finalize_outage');
      head = Object.freeze({
        globalSequence: reserved.globalSequence,
        globalHash: reserved.globalHash,
        databaseSequence: reserved.databaseSequence,
        databaseHash: reserved.databaseHash,
        stateHash: reserved.postStateHash,
      });
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
        status: 'autonomous_research_online_mutation_finalized',
        authorityId: 'authority:native-store-ledger-test',
        keyId: 'key:native-store-ledger-test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationFinalizeRequest', request),
        sideEffectPermitHash: H(`permit:${reserved.reservationId}`),
        finalizedAt: new Date(now || NOW).toISOString(),
        signature: 'dGVzdA==',
      });
    },
    abortMutation({ request }) {
      calls.push(Object.freeze({ method: 'abort', request }));
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationAbortReceipt',
        status: 'autonomous_research_online_mutation_aborted',
        authorityId: 'authority:native-store-ledger-test',
        keyId: 'key:native-store-ledger-test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationAbortRequest', request),
        abortedAt: NOW.toISOString(),
        signature: 'dGVzdA==',
      });
    },
  });
  return Object.freeze({
    client,
    calls,
    setFailFinalize(value) { failFinalize = Boolean(value); },
  });
}

function readyCoordinator(configured) {
  const coveredDatabaseRoles = Object.freeze(['native-store']);
  return Object.freeze({
    implemented: true,
    protocol: configured.protocol,
    coveredDatabaseRoles,
    executeMutation(input) { return configured.executeMutation(input); },
    recoverPendingMutations(input) {
      return configured.recoverPendingMutations(input);
    },
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

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-ledger-online-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'hepta-paper.sqlite');
  const manifest = writerManifest();
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'authority:native-store-ledger-test',
    keyId: 'key:native-store-ledger-test',
    scopeId: 'scope:native-store-ledger-test',
    databaseScopeHash: H('database-scope'),
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  const schemaHash = provisionDatabase(databasePath, trust);
  const authority = fakeAuthority(trust, schemaHash);
  const configured = createExternallyFencedSqliteMutationCoordinator({
    authorityClient: authority.client,
    authorityTrust: trust,
    manifest,
    operationPlans: NATIVE_STORE_LEDGER_MUTATION_PLANS,
    databaseInstances: Object.freeze([Object.freeze({
      databaseRole: 'native-store',
      databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
      schemaHash,
    })]),
    clock,
  });
  const store = openExistingExternallyFencedPaperStore({
    dbPath: databasePath,
    mutationCoordinator: readyCoordinator(configured),
    databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
    schemaContractId: NATIVE_STORE_SCHEMA_CONTRACT_ID,
    writerId: NATIVE_STORE_LEDGER_WRITER_ID,
    operationIds: Object.keys(NATIVE_STORE_LEDGER_MUTATION_PLANS),
  });
  t.after(() => store.close());
  return { authority, databasePath, store };
}

function researchGapReceipt({ jobId, attemptId }) {
  return sealReceiptHash({
    version: 1,
    kind: 'ResearchGapPlanningReceipt',
    status: 'research_gap_planning_complete',
    jobId,
    attemptId,
    paperId: 'paper-online',
    createdAt: NOW.toISOString(),
  }, { hashField: 'receiptHash' });
}

test('real v23 native store coordinates ledger, job, qualification and workflow writers', (t) => {
  const { store } = setup(t);
  const ledger = createSqliteReceiptLedger({ store, clock });
  const first = ledger.record({
    version: 1,
    kind: 'UntrustedDiagnosticReceipt',
    status: 'recorded',
    createdAt: NOW.toISOString(),
    value: 1,
  }, { stream: 'diagnostic' });
  assert.equal(ledger.record({
    version: 1,
    kind: 'UntrustedDiagnosticReceipt',
    status: 'recorded',
    createdAt: NOW.toISOString(),
    value: 1,
  }, { stream: 'diagnostic' }).receiptId, first.receiptId);

  const qualifications = createSqliteReceiptLedgerQualificationStore({
    store,
    clock,
    issuerCapability: issueLedgerAdministratorWriter(),
  });
  assert.equal(qualifications.qualify({
    receiptId: first.receiptId,
    disposition: 'invalid',
    reason: 'strict-online-test',
  }).disposition, 'invalid');

  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  jobs.createJob({
    jobId: 'job:complete',
    deduplicationKey: 'dedupe:complete',
    paperId: 'paper-online',
    kind: 'test',
  });
  const leased = jobs.acquireLease({ jobId: 'job:complete', workerId: 'worker:1' });
  const attempt = jobs.recordAttempt({
    jobId: 'job:complete',
    workerId: 'worker:1',
    leaseGeneration: leased.leaseGeneration,
  });
  assert.equal(jobs.renewAttemptLease({
    jobId: 'job:complete',
    attemptId: attempt.attemptId,
    workerId: 'worker:1',
    leaseGeneration: attempt.leaseGeneration,
  }).status, 'running');
  assert.equal(jobs.completeJob({
    jobId: 'job:complete',
    attemptId: attempt.attemptId,
    workerId: 'worker:1',
    leaseGeneration: attempt.leaseGeneration,
    receipt: researchGapReceipt({
      jobId: 'job:complete',
      attemptId: attempt.attemptId,
    }),
  }).status, 'completed');

  jobs.createJob({
    jobId: 'job:fail',
    deduplicationKey: 'dedupe:fail',
    paperId: 'paper-online',
    kind: 'test',
  });
  const failLease = jobs.acquireLease({ jobId: 'job:fail', workerId: 'worker:2' });
  const failAttempt = jobs.recordAttempt({
    jobId: 'job:fail',
    workerId: 'worker:2',
    leaseGeneration: failLease.leaseGeneration,
  });
  assert.equal(jobs.failJob({
    jobId: 'job:fail',
    attemptId: failAttempt.attemptId,
    workerId: 'worker:2',
    leaseGeneration: failAttempt.leaseGeneration,
    failureClass: 'test_failure',
    retryable: false,
  }).status, 'failed_terminal');

  const workflowLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueWorkflowStateProjectorWriter(),
  });
  const workflows = createSqliteWorkflowStateStore({
    store,
    clock,
    receiptLedger: workflowLedger,
  });
  assert.equal(workflows.put({
    paperId: 'paper-online',
    mode: 'strict-online-test',
    state: { status: 'ready' },
  }).status, 'workflow_state_projection_persisted');
});

test('ledger callback failure rolls back before authority reservation', (t) => {
  const { authority, store } = setup(t);
  assert.throws(() => store.mutate({
    operationId: NATIVE_STORE_LEDGER_OPERATION_IDS.recordReceipt,
    mutate(transaction) {
      transaction.run(
        NATIVE_STORE_LEDGER_STATEMENT_IDS.insertReceipt,
        'diagnostic:fault',
        'diagnostic',
        null,
        'UntrustedDiagnosticReceipt',
        'recorded',
        '{}',
        H('fault-receipt'),
        NOW.toISOString(),
        'production',
        'runtime_unclassified',
        null,
        'untrusted-caller',
        'untrusted',
        0,
        null,
        null,
        'untrusted',
      );
      throw new Error('native_store_ledger_candidate_failed');
    },
  }), /native_store_ledger_candidate_failed/);
  assert.equal(store.query(
    "SELECT count(*) AS count FROM receipt_ledger WHERE receipt_id='diagnostic:fault'",
  ).rows[0].count, 0);
  assert.deepEqual(authority.calls.map((call) => call.method), ['head']);
});

test('workflow finalization recovery does not replay its committed receipt or projection DML', (t) => {
  const { authority, store } = setup(t);
  const workflowLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueWorkflowStateProjectorWriter(),
  });
  const workflows = createSqliteWorkflowStateStore({
    store,
    clock,
    receiptLedger: workflowLedger,
  });
  authority.setFailFinalize(true);
  assert.throws(() => workflows.put({
    paperId: 'paper-online',
    mode: 'pending-finalization-test',
    state: { status: 'committed' },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_committed_finalization_pending'
      && error.committed === true
  ));
  assert.equal(store.query(
    'SELECT count(*) AS count FROM workflow_states',
  ).rows[0].count, 1);
  assert.equal(store.query(
    "SELECT count(*) AS count FROM receipt_ledger WHERE stream='workflow-state'",
  ).rows[0].count, 1);
  authority.setFailFinalize(false);
  const recovered = store.recoverPendingMutations();
  assert.equal(recovered.recoveredReservationIds.length, 1);
  assert.equal(store.query(
    'SELECT count(*) AS count FROM workflow_states',
  ).rows[0].count, 1);
  assert.equal(store.query(
    "SELECT count(*) AS count FROM receipt_ledger WHERE stream='workflow-state'",
  ).rows[0].count, 1);
  assert.equal(store.query(`SELECT count(*) AS count
    FROM autonomous_research_online_mutation_finalization_receipt`).rows[0].count, 1);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'finalize', 'finalize',
  ]);
});

function coordinatedFailureJobStore(receipt) {
  const store = {
    query() { return { ok: true, rows: [] }; },
    execute() { return { ok: true }; },
    mutate() { return receipt; },
  };
  const receiptLedger = {
    prepare() { throw new Error('ledger_prepare_not_expected'); },
  };
  return createSqliteJobReceiptStore({ store, receiptLedger, clock });
}

function coordinatedGuardJobStore({ run, get }) {
  const transaction = Object.freeze({
    run(statementId, ...parameters) {
      return (run?.(statementId, ...parameters)) || Object.freeze({ changes: 1 });
    },
    get(statementId, ...parameters) {
      if (get) return get(statementId, ...parameters);
      if (statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.selectActiveJobAttempt) {
        return Object.freeze({ paper_id: 'paper-online' });
      }
      return Object.freeze({
        job_id: 'job:guard',
        paper_id: 'paper-online',
        spec_json: '{}',
        attempt_count: 1,
        lease_generation: 1,
        lease_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
        environment: 'production',
        evidence_class: 'runtime_unclassified',
      });
    },
  });
  const store = Object.freeze({
    query() { return Object.freeze({ ok: true, rows: Object.freeze([]) }); },
    execute() { return Object.freeze({ ok: true }); },
    mutate({ mutate }) {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_finalized',
        value: mutate(transaction),
      });
    },
  });
  return createSqliteJobReceiptStore({
    store,
    receiptLedger: Object.freeze({ prepare() { throw new Error('receipt_not_expected'); } }),
    clock,
  });
}

test('coordinated job callbacks fail closed at every row-count and result guard', () => {
  const input = Object.freeze({
    jobId: 'job:guard',
    attemptId: 'job:guard:attempt:1',
    workerId: 'worker:guard',
    leaseGeneration: 1,
  });
  const scenarios = [
    ['lease update ambiguous', {
      run: (statementId) => Object.freeze({
        changes: statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.acquireJobLease ? 2 : 1,
      }),
    }, (jobs) => jobs.acquireLease(input), /job_lease_update_ambiguous/],
    ['lease result missing', {
      get: () => null,
    }, (jobs) => jobs.acquireLease(input), /job_lease_result_missing/],
    ['attempt lease fence', {
      run: (statementId) => Object.freeze({
        changes: statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.startJobAttempt ? 0 : 1,
      }),
    }, (jobs) => jobs.recordAttempt(input), /active_job_lease_fence_required/],
    ['attempt job missing', {
      get: () => null,
    }, (jobs) => jobs.recordAttempt(input), /job_attempt_job_result_missing/],
    ['attempt insert ambiguous', {
      run: (statementId) => Object.freeze({
        changes: statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.insertJobAttempt ? 0 : 1,
      }),
    }, (jobs) => jobs.recordAttempt(input), /job_attempt_insert_ambiguous/],
    ['renewal lease fence', {
      run: (statementId) => Object.freeze({
        changes: statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.renewJobAttemptLease ? 0 : 1,
      }),
    }, (jobs) => jobs.renewAttemptLease(input), /active_job_attempt_lease_fence_required/],
    ['renewal result missing', {
      get: () => null,
    }, (jobs) => jobs.renewAttemptLease(input), /job_attempt_lease_renewal_result_missing/],
    ['settlement active attempt missing', {
      get: (statementId) => (
        statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.selectActiveJobAttempt
          ? null : Object.freeze({ spec_json: '{}' })
      ),
    }, (jobs) => jobs.failJob({ ...input, failureClass: 'fixture' }),
    /active_job_attempt_lease_fence_required/],
    ['attempt settlement fence', {
      run: (statementId) => Object.freeze({
        changes: statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.settleJobAttempt ? 0 : 1,
      }),
    }, (jobs) => jobs.failJob({ ...input, failureClass: 'fixture' }),
    /job_attempt_settlement_fence_lost/],
    ['job settlement fence', {
      run: (statementId) => Object.freeze({
        changes: statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.settleJob ? 0 : 1,
      }),
    }, (jobs) => jobs.failJob({ ...input, failureClass: 'fixture' }),
    /job_settlement_fence_lost/],
    ['settlement result missing', {
      get: (statementId) => (
        statementId === NATIVE_STORE_LEDGER_STATEMENT_IDS.getJob
          ? null : Object.freeze({ paper_id: 'paper-online' })
      ),
    }, (jobs) => jobs.failJob({ ...input, failureClass: 'fixture' }),
    /job_settlement_result_missing/],
  ];
  for (const [name, fixture, invoke, expected] of scenarios) {
    assert.throws(() => invoke(coordinatedGuardJobStore(fixture)), expected, name);
  }
});

test('receipt ledger fails closed across mutation receipts and replacement lineage', () => {
  const emptyStore = Object.freeze({
    query() { return Object.freeze({ ok: true, rows: Object.freeze([]) }); },
    execute() { return Object.freeze({ ok: true }); },
  });
  assert.throws(() => preparedSqliteReceiptLedgerMutation({}),
    /receipt_ledger_prepared_mutation_invalid/);
  assert.throws(() => createSqliteReceiptLedger(), /Receipt ledger store is required/);
  assert.throws(() => createSqliteReceiptLedger({ store: {} }),
    /Receipt ledger clock is required/);
  assert.throws(() => createSqliteReceiptLedger({
    store: emptyStore,
    clock,
    writerIdentity: { trusted: true },
  }), /raw_trusted_writer_identity_forbidden/);

  const genericReceipt = Object.freeze({
    version: 1,
    kind: 'UntrustedDiagnosticReceipt',
    status: 'recorded',
  });
  const coordinatedLedger = (coordinated) => createSqliteReceiptLedger({
    store: Object.freeze({
      query() { return Object.freeze({ ok: true, rows: Object.freeze([]) }); },
      execute() { return Object.freeze({ ok: true }); },
      mutate() { return coordinated; },
    }),
    clock,
  });
  assert.throws(() => coordinatedLedger(Object.freeze({
    status: 'externally_fenced_sqlite_mutation_finalized',
    value: 2,
  })).record(genericReceipt), /receipt_ledger_external_mutation_receipt_invalid/);
  assert.throws(() => coordinatedLedger(Object.freeze({
    status: 'externally_fenced_sqlite_mutation_no_change',
    value: 0,
  })).record(genericReceipt, { strictInsert: true }),
  /receipt_ledger_external_mutation_receipt_invalid/);
  assert.throws(() => coordinatedLedger(Object.freeze({
    status: 'unexpected',
    value: 1,
  })).record(genericReceipt), /receipt_ledger_external_mutation_receipt_invalid/);

  for (const [name, result, expected] of [
    ['error', { ok: false, error: 'ledger_error' }, /ledger_error/],
    ['stderr', { ok: false, stderr: 'ledger_stderr' }, /ledger_stderr/],
    ['fallback', { ok: false }, /receipt_ledger_write_failed/],
  ]) {
    const ledger = createSqliteReceiptLedger({
      store: Object.freeze({
        query() { return Object.freeze({ ok: true, rows: Object.freeze([]) }); },
        execute() { return result; },
      }),
      clock,
    });
    assert.throws(() => ledger.record(genericReceipt), expected, name);
  }

  const qualificationRow = (receiptId, disposition, replacementReceiptId) => {
    const payload = Object.freeze({ receiptId, replacementReceiptId });
    return Object.freeze({
      disposition,
      replacement_receipt_id: replacementReceiptId,
      qualification_json: JSON.stringify(payload),
      qualification_sha256: hashRecord('ReceiptLedgerQualification', payload),
    });
  };
  const resolutionLedger = (query) => createSqliteReceiptLedger({
    store: Object.freeze({ query, execute: () => Object.freeze({ ok: true }) }),
    clock,
  });
  assert.deepEqual(
    resolutionLedger(() => Object.freeze({ ok: true, rows: Object.freeze([]) }))
      .resolveEffective('missing').blockers,
    ['trusted_receipt_ledger_row_missing'],
  );
  const usable = resolutionLedger(() => Object.freeze({
    ok: true,
    rows: Object.freeze([Object.freeze({ effective_receipt_usable: 1 })]),
  })).resolveEffective('usable');
  assert.equal(usable.status, 'effective_receipt_resolved');

  const unusableRow = Object.freeze({ effective_receipt_usable: 0 });
  assert.deepEqual(resolutionLedger((sql) => Object.freeze({
    ok: true,
    rows: sql.includes('receipt_ledger_qualifications')
      ? Object.freeze([]) : Object.freeze([unusableRow]),
  })).resolveEffective('unqualified').blockers, ['trusted_receipt_qualification_missing']);
  assert.deepEqual(resolutionLedger((sql) => Object.freeze({
    ok: true,
    rows: sql.includes('receipt_ledger_qualifications')
      ? Object.freeze([Object.freeze({
        qualification_json: '{',
        qualification_sha256: H('malformed'),
      })]) : Object.freeze([unusableRow]),
  })).resolveEffective('malformed').blockers, ['trusted_receipt_qualification_hash_invalid']);

  const terminalId = 'terminal';
  const terminal = resolutionLedger((sql) => Object.freeze({
    ok: true,
    rows: sql.includes('receipt_ledger_qualifications')
      ? Object.freeze([qualificationRow(terminalId, 'invalid', null)])
      : Object.freeze([unusableRow]),
  })).resolveEffective(terminalId);
  assert.deepEqual(terminal.blockers, ['trusted_receipt_qualified_invalid']);

  const cycleId = 'cycle';
  const cycle = resolutionLedger((sql) => Object.freeze({
    ok: true,
    rows: sql.includes('receipt_ledger_qualifications')
      ? Object.freeze([qualificationRow(cycleId, 'superseded', cycleId)])
      : Object.freeze([unusableRow]),
  })).resolveEffective(cycleId);
  assert.deepEqual(cycle.blockers, ['trusted_receipt_replacement_cycle']);

  const depth = resolutionLedger((sql) => Object.freeze({
    ok: true,
    rows: sql.includes('receipt_ledger_qualifications')
      ? Object.freeze([qualificationRow('depth-a', 'superseded', 'depth-b')])
      : Object.freeze([unusableRow]),
  })).resolveEffective('depth-a', { maxDepth: 1 });
  assert.deepEqual(depth.blockers, ['trusted_receipt_replacement_depth_exceeded']);
});

test('job writers reject invalid or ambiguous external mutation receipts', () => {
  const job = {
    jobId: 'job:invalid-coordinator-receipt',
    deduplicationKey: 'dedupe:invalid-coordinator-receipt',
    paperId: 'paper-online',
    kind: 'test',
  };
  const invalid = coordinatedFailureJobStore({ status: 'unexpected', value: 1 });
  assert.throws(() => invalid.createJob(job),
    /job_create_external_mutation_receipt_invalid/);
  assert.throws(() => invalid.acquireLease({ jobId: job.jobId, workerId: 'worker:1' }),
    /job_lease_external_mutation_receipt_invalid/);
  assert.throws(() => invalid.recordAttempt({
    jobId: job.jobId,
    workerId: 'worker:1',
    leaseGeneration: 1,
  }), /job_attempt_external_mutation_receipt_invalid/);
  assert.throws(() => invalid.renewAttemptLease({
    jobId: job.jobId,
    attemptId: `${job.jobId}:attempt:1`,
    workerId: 'worker:1',
    leaseGeneration: 1,
  }), /job_attempt_lease_external_mutation_receipt_invalid/);
  assert.throws(() => invalid.completeJob({
    jobId: job.jobId,
    attemptId: `${job.jobId}:attempt:1`,
    workerId: 'worker:1',
    leaseGeneration: 1,
    receipt: { kind: 'ResearchGapPlanningReceipt' },
  }), /job_completion_external_mutation_receipt_invalid/);
  assert.throws(() => invalid.failJob({
    jobId: job.jobId,
    attemptId: `${job.jobId}:attempt:1`,
    workerId: 'worker:1',
    leaseGeneration: 1,
    failureClass: 'fixture_failure',
  }), /job_failure_external_mutation_receipt_invalid/);

  const ambiguous = coordinatedFailureJobStore({
    status: 'externally_fenced_sqlite_mutation_finalized',
    value: 2,
  });
  assert.throws(() => ambiguous.createJob(job),
    /job_create_external_mutation_receipt_invalid/);

  const noChange = coordinatedFailureJobStore({
    status: 'externally_fenced_sqlite_mutation_no_change',
    value: null,
  });
  assert.equal(noChange.acquireLease({ jobId: job.jobId, workerId: 'worker:1' }), null);
});
