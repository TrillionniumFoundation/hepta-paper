import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  compileExternallyFencedSqliteMutationOperation,
  createExternallyFencedSqliteMutationTransaction,
  defineExternallyFencedSqliteMutationStatement,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  assertSqliteChangesetEffectsAuthorized,
} from '../../paper-adapters/automation/sqlite-changeset-policy.mjs';
import {
  createExternallyFencedNativeSqliteStore,
} from '../../paper-adapters/persistence/sqlite-store.mjs';

const OPERATION_ID = 'native-store.authority-boundary.v1';
const WRITER_ID = 'writer:native-store:authority-boundary:v1';

function readyCoordinator() {
  const calls = { reservations: 0, recoveries: 0 };
  const coveredDatabaseRoles = Object.freeze(['native-store']);
  const coordinator = Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    inspectStatus() {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
    executeMutation(input) {
      input.database.exec('BEGIN IMMEDIATE;');
      try {
        const value = input.mutate(Object.freeze({}));
        calls.reservations += 1;
        input.database.exec('COMMIT;');
        return Object.freeze({
          status: 'externally_fenced_sqlite_mutation_finalized',
          value,
        });
      } catch (error) {
        if (input.database.isTransaction) input.database.exec('ROLLBACK;');
        throw error;
      }
    },
    recoverPendingMutations() {
      calls.recoveries += 1;
      return Object.freeze({ recoveredReservationIds: Object.freeze([]) });
    },
  });
  return Object.freeze({ coordinator, calls });
}

function storeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-authority-'));
  const dbPath = path.join(root, 'native.sqlite');
  const setup = new DatabaseSync(dbPath);
  setup.exec(`
CREATE TABLE planned_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE unplanned_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO planned_rows(id,value) VALUES(1,'before');
INSERT INTO unplanned_rows(id,value) VALUES(1,'before');
`);
  setup.close();
  const controlled = readyCoordinator();
  const store = createExternallyFencedNativeSqliteStore({
    dbPath,
    mutationCoordinator: controlled.coordinator,
    databaseInstanceId: 'database:native-store:authority-boundary:v1',
    schemaContractId: 'schema:native-store:authority-boundary:v1',
    writerId: WRITER_ID,
    operationIds: [OPERATION_ID],
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({ ...controlled, store });
}

const DATA_CHANGING_CTE = `WITH value(v) AS (VALUES('unauthorized'))
UPDATE unplanned_rows SET value=(SELECT v FROM value) WHERE id=1
RETURNING value`;

function outerSurfaceAttempts(store) {
  return Object.freeze([
    Object.freeze({
      name: 'query',
      invoke() { assert.throws(() => store.query(DATA_CHANGING_CTE), /outer_store_access/); },
    }),
    Object.freeze({
      name: 'run',
      invoke() {
        assert.equal(store.run("UPDATE unplanned_rows SET value='run' WHERE id=1").error,
          'sqlite_outer_store_access_during_unit_of_work_forbidden');
      },
    }),
    Object.freeze({
      name: 'execute',
      invoke() {
        assert.equal(store.execute("DELETE FROM unplanned_rows WHERE id=1").error,
          'sqlite_outer_store_access_during_unit_of_work_forbidden');
      },
    }),
    Object.freeze({
      name: 'transaction',
      invoke() { assert.throws(() => store.transaction(() => null), /outer_store_access/); },
    }),
    Object.freeze({
      name: 'checkpoint',
      invoke() {
        assert.equal(store.checkpoint().error,
          'sqlite_outer_store_access_during_unit_of_work_forbidden');
      },
    }),
    Object.freeze({
      name: 'recoverPendingMutations',
      invoke() { assert.throws(() => store.recoverPendingMutations(), /outer_store_access/); },
    }),
    Object.freeze({
      name: 'close',
      invoke() { assert.throws(() => store.close(), /outer_store_access/); },
    }),
    Object.freeze({
      name: 'available',
      invoke() { assert.equal(store.available(), false); },
    }),
  ]);
}

test('captured outer StorePort is revoked for the entire online mutation callback', (t) => {
  const { calls, store } = storeFixture(t);
  for (const surface of outerSurfaceAttempts(store)) {
    assert.throws(() => store.mutate({
      operationId: OPERATION_ID,
      mutate() {
        surface.invoke();
        return 'must-not-commit';
      },
    }), /sqlite_outer_store_access_during_unit_of_work_forbidden/, surface.name);
    assert.equal(calls.reservations, 0, surface.name);
    assert.equal(calls.recoveries, 0, surface.name);
    assert.deepEqual(store.query('SELECT value FROM unplanned_rows WHERE id=1').rows,
      [{ value: 'before' }], surface.name);
  }
});

test('public online-store queries execute on a physically read-only SQLite connection', (t) => {
  const { store } = storeFixture(t);
  assert.throws(() => store.query(DATA_CHANGING_CTE), /readonly|read-only/i);
  assert.deepEqual(store.query('WITH current AS (SELECT value FROM unplanned_rows WHERE id=1) SELECT value FROM current').rows,
    [{ value: 'before' }]);
});

test('restricted mutation transaction validates actual changeset tables and operations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-changeset-authority-'));
  const dbPath = path.join(root, 'changeset.sqlite');
  const database = new DatabaseSync(dbPath);
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.exec(`
CREATE TABLE planned_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE unplanned_rows(value TEXT NOT NULL) STRICT;
INSERT INTO planned_rows(id,value) VALUES(1,'before');
INSERT INTO unplanned_rows(value) VALUES('before');
`);
  const plan = compileExternallyFencedSqliteMutationOperation(
    OPERATION_ID,
    [defineExternallyFencedSqliteMutationStatement(
      'planned-update',
      'UPDATE planned_rows SET value=? WHERE id=?',
    )],
  );

  database.exec('BEGIN IMMEDIATE;');
  const escaped = createExternallyFencedSqliteMutationTransaction(database, plan);
  escaped.transaction.run('planned-update', 'authorized', 1);
  assert.throws(
    () => database.prepare(`WITH value(v) AS (VALUES('unauthorized'))
      UPDATE unplanned_rows SET value=(SELECT v FROM value) RETURNING value`).all(),
    /externally_fenced_sqlite_mutation_table_operation_forbidden/,
  );
  assert.deepEqual(escaped.revoke().tableOperationKeys, ['planned_rows\0UPDATE']);
  database.exec('ROLLBACK;');
  assert.deepEqual(database.prepare('SELECT value FROM planned_rows WHERE id=1').all().map((row) => ({ ...row })),
    [{ value: 'before' }]);
  assert.deepEqual(database.prepare('SELECT value FROM unplanned_rows').all().map((row) => ({ ...row })),
    [{ value: 'before' }]);

  database.exec('BEGIN IMMEDIATE;');
  const authorized = createExternallyFencedSqliteMutationTransaction(database, plan);
  authorized.transaction.run('planned-update', 'after', 1);
  const report = authorized.revoke();
  assert.deepEqual(report.tableOperationKeys, ['planned_rows\0UPDATE']);
  database.exec('COMMIT;');
  assert.deepEqual(database.prepare('SELECT value FROM planned_rows WHERE id=1').all().map((row) => ({ ...row })),
    [{ value: 'after' }]);
});

test('changeset decoder independently rejects an unplanned table-operation pair', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-changeset-decoder-'));
  const database = new DatabaseSync(path.join(root, 'decoder.sqlite'));
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.exec(`
CREATE TABLE planned_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE unplanned_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO planned_rows(id,value) VALUES(1,'before');
INSERT INTO unplanned_rows(id,value) VALUES(1,'before');
BEGIN IMMEDIATE;
`);
  const session = database.createSession();
  database.prepare("UPDATE planned_rows SET value='planned' WHERE id=1").run();
  database.prepare("UPDATE unplanned_rows SET value='unplanned' WHERE id=1").run();
  const changeset = Buffer.from(session.changeset());
  session.close();
  assert.throws(() => assertSqliteChangesetEffectsAuthorized({
    changeset,
    authorizedEffects: [{ table: 'planned_rows', operation: 'UPDATE' }],
    executedEffects: [{ table: 'planned_rows', operation: 'UPDATE' }],
  }), /externally_fenced_sqlite_mutation_changeset_not_authorized/);
  database.exec('ROLLBACK;');
});
