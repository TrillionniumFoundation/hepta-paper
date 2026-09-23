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
  NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS,
  NATIVE_STORE_CAMPAIGN_TELEMETRY_INSERT_STATEMENT_ID,
  NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID,
  NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID,
  NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_PLAN_HASH,
  NATIVE_STORE_DATABASE_INSTANCE_ID,
  NATIVE_STORE_SCHEMA_CONTRACT_ID,
} from '../../paper-adapters/persistence/native-store-online-mutation-plan.mjs';
import {
  createCampaignTelemetryOperations,
} from '../../paper-adapters/persistence/sqlite-campaign-telemetry-operations.mjs';
import {
  createExternallyFencedNativeSqliteStore,
} from '../../paper-adapters/persistence/sqlite-store.mjs';
import {
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
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-18T12:00:00.000Z');
const H = (label) => hashRecord('NativeStoreOnlineMutationTest', { label });

function writerManifest() {
  const operations = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map((databaseRole) => {
    const integrated = databaseRole === 'native-store';
    return Object.freeze({
      operationId: integrated
        ? NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID
        : `${databaseRole}.pending.v1`,
      databaseRole,
      sourceFile: integrated
        ? 'paper-adapters/persistence/sqlite-campaign-telemetry-operations.mjs'
        : `paper-adapters/automation/${databaseRole}-pending.mjs`,
      entrypoint: integrated ? 'recordTelemetry' : 'pending',
      mutationClass: integrated ? 'business-dml' : 'schema-or-genesis-ddl',
      protocolStatus: integrated
        ? AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS
        : AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
      coordinatorIntegrated: integrated,
    });
  });
  return Object.freeze({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'native-store-online-mutation-test-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze(
      [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort(),
    ),
    writers: Object.freeze([Object.freeze({
      writerId: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID,
      databaseRoles: Object.freeze(['native-store']),
      operationIds: Object.freeze([NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID]),
      implementationHash: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_PLAN_HASH,
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    })]),
    operations: Object.freeze(operations),
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
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

function provisionDatabase(databasePath, trust) {
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE paper_campaigns(
  campaign_id TEXT PRIMARY KEY
) STRICT;
CREATE TABLE campaign_telemetry_samples(
  telemetry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES paper_campaigns(campaign_id) ON DELETE CASCADE,
  node_id TEXT,
  sample_kind TEXT NOT NULL,
  phases_json TEXT NOT NULL DEFAULT '{}',
  lock_wait_ms INTEGER NOT NULL DEFAULT 0,
  queue_contention_count INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT,
  acquired_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE unrelated_legacy_rows(value TEXT NOT NULL);
CREATE TABLE unrelated_append_only(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TRIGGER unrelated_append_only_no_update
BEFORE UPDATE ON unrelated_append_only
BEGIN SELECT RAISE(ABORT, 'unrelated_append_only'); END;
INSERT INTO paper_campaigns(campaign_id) VALUES('campaign:test');`);
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
) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?);
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
        authorityId: 'authority:native-store-test',
        keyId: 'key:native-store-test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationReserveRequest', request),
        reservationId: `reservation:native-store:${sequence}`,
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
      if (failFinalize) throw new Error('simulated_native_store_finalize_outage');
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
        authorityId: 'authority:native-store-test',
        keyId: 'key:native-store-test',
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
        authorityId: 'authority:native-store-test',
        keyId: 'key:native-store-test',
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-online-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'hepta-paper.sqlite');
  const manifest = writerManifest();
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'authority:native-store-test',
    keyId: 'key:native-store-test',
    scopeId: 'scope:native-store-test',
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
    operationPlans: NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS,
    databaseInstances: Object.freeze([Object.freeze({
      databaseRole: 'native-store',
      databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
      schemaHash,
    })]),
    clock: { now: () => NOW },
  });
  const store = openExistingExternallyFencedPaperStore({
    dbPath: databasePath,
    mutationCoordinator: readyCoordinator(configured),
    databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
    schemaContractId: NATIVE_STORE_SCHEMA_CONTRACT_ID,
    operationWriters: {
      [NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID]:
        NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID,
    },
    operationIds: Object.keys(NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS),
  });
  t.after(() => store.close());
  return { authority, databasePath, store };
}

test('strict native store rejects unactivated coordination before filesystem I/O', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-blocked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'must-not-exist');
  const configured = Object.freeze({
    implemented: true,
    coveredDatabaseRoles: Object.freeze(['native-store']),
    executeMutation() { throw new Error('must_not_execute'); },
    recoverPendingMutations() { throw new Error('must_not_recover'); },
    inspectStatus() {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_coordinator_configured',
        implemented: true,
        coveredDatabaseRoles: Object.freeze(['native-store']),
        blockers: Object.freeze([
          'autonomous_research_online_mutation_runtime_activation_required',
        ]),
      });
    },
  });
  assert.throws(() => createExternallyFencedNativeSqliteStore({
    dbPath: path.join(parent, 'hepta-paper.sqlite'),
    mutationCoordinator: configured,
    databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
    schemaContractId: NATIVE_STORE_SCHEMA_CONTRACT_ID,
    writerId: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID,
    operationIds: [NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID],
  }), /native_store_external_mutation_coordinator_required/);
  assert.equal(fs.existsSync(parent), false);
});

test('strict native store selects the manifest writer independently for each operation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-writer-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'hepta-paper.sqlite');
  new DatabaseSync(databasePath).close();
  const calls = [];
  const coordinator = Object.freeze({
    implemented: true,
    coveredDatabaseRoles: Object.freeze(['native-store']),
    executeMutation(input) {
      calls.push({ operationId: input.operationId, writerId: input.writerId });
      return Object.freeze({ status: 'externally_fenced_sqlite_mutation_no_change' });
    },
    recoverPendingMutations() { return Object.freeze({ recovered: 0 }); },
    inspectStatus() {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles: Object.freeze(['native-store']),
        blockers: Object.freeze([]),
      });
    },
  });
  const operations = [
    'native-store.test.first.v1',
    'native-store.test.second.v1',
  ];
  const store = createExternallyFencedNativeSqliteStore({
    dbPath: databasePath,
    mutationCoordinator: coordinator,
    databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
    schemaContractId: NATIVE_STORE_SCHEMA_CONTRACT_ID,
    operationIds: operations,
    operationWriters: {
      [operations[0]]: 'writer:native-store:first:v1',
      [operations[1]]: 'writer:native-store:second:v1',
    },
  });
  t.after(() => store.close());
  for (const operationId of operations) {
    store.mutate({ operationId, mutate() {} });
  }
  assert.deepEqual(calls, [
    { operationId: operations[0], writerId: 'writer:native-store:first:v1' },
    { operationId: operations[1], writerId: 'writer:native-store:second:v1' },
  ]);
  assert.equal(store.writerId, null);
  assert.deepEqual(store.writerIds, [
    'writer:native-store:first:v1', 'writer:native-store:second:v1',
  ]);
});

test('strict native store blocks every generic write surface', (t) => {
  const { store } = setup(t);
  assert.equal(store.kind, 'ExternallyFencedNativeSqliteStoreAdapter');
  assert.equal(store.run(
    "INSERT INTO campaign_telemetry_samples(campaign_id,sample_kind,created_at) VALUES('campaign:test','escape','2026-07-18T12:00:00.000Z')",
  ).error, 'native_store_unfenced_write_forbidden');
  assert.equal(store.execute(
    "DELETE FROM paper_campaigns WHERE campaign_id='campaign:test'",
  ).error, 'native_store_unfenced_write_forbidden');
  assert.throws(
    () => store.transaction(() => null),
    /native_store_unfenced_write_forbidden/,
  );
  assert.throws(
    () => store.query(`UPDATE campaign_telemetry_samples SET sample_kind='escape'
      RETURNING telemetry_id`),
    /native_store_unfenced_query_write_forbidden/,
  );
  assert.throws(
    () => store.query(`WITH candidate(campaign_id,sample_kind,created_at) AS (
      VALUES('campaign:test','with-escape','2026-07-18T12:00:00.000Z')
    ) INSERT INTO campaign_telemetry_samples(campaign_id,sample_kind,created_at)
      SELECT campaign_id,sample_kind,created_at FROM candidate
      RETURNING telemetry_id`),
    /readonly|read-only/i,
  );
  assert.throws(() => store.mutate({
    operationId: 'native-store.unregistered.escape.v1',
    mutate() {},
  }), /native_store_online_mutation_input_invalid/);
  assert.equal(store.query(
    'SELECT count(*) AS count FROM campaign_telemetry_samples',
  ).rows[0].count, 0);
});

test('native telemetry callback failure rolls back before authority reservation', (t) => {
  const { authority, store } = setup(t);
  assert.throws(() => store.mutate({
    operationId: NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID,
    mutate(transaction) {
      transaction.run(
        NATIVE_STORE_CAMPAIGN_TELEMETRY_INSERT_STATEMENT_ID,
        'campaign:test',
        null,
        'fault-injection',
        '{}',
        0,
        0,
        null,
        null,
        null,
        NOW.toISOString(),
      );
      throw new Error('native_store_candidate_failed');
    },
  }), /native_store_candidate_failed/);
  assert.equal(store.query(
    'SELECT count(*) AS count FROM campaign_telemetry_samples',
  ).rows[0].count, 0);
  assert.deepEqual(authority.calls.map((call) => call.method), ['head']);
});

test('native telemetry finalization recovery never replays committed DML', (t) => {
  const { authority, store } = setup(t);
  const telemetry = createCampaignTelemetryOperations({
    store,
    clock: { nowIso: () => NOW.toISOString() },
  });
  authority.setFailFinalize(true);
  assert.throws(() => telemetry.recordTelemetry({
    campaignId: 'campaign:test',
    nodeId: 'node:test',
    sampleKind: 'campaign_node_execution',
    phases: { command: 7 },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_committed_finalization_pending'
    && error.committed === true
  ));
  assert.equal(store.query(
    'SELECT count(*) AS count FROM campaign_telemetry_samples',
  ).rows[0].count, 1);
  assert.equal(store.query(`SELECT count(*) AS count
    FROM autonomous_research_online_mutation_finalization_receipt`).rows[0].count, 0);
  authority.setFailFinalize(false);
  const recovered = store.recoverPendingMutations();
  assert.equal(recovered.recoveredReservationIds.length, 1);
  assert.equal(store.query(
    'SELECT count(*) AS count FROM campaign_telemetry_samples',
  ).rows[0].count, 1);
  assert.equal(store.query(`SELECT count(*) AS count
    FROM autonomous_research_online_mutation_finalization_receipt`).rows[0].count, 1);
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'finalize', 'finalize',
  ]);
});
