import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSqliteRefereeIssueQuery } from '../../paper-adapters/persistence/sqlite-referee-issue-query.mjs';
import { createReadOnlySqliteStore, createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { createSqliteUnitOfWork } from '../../paper-adapters/persistence/sqlite-unit-of-work.mjs';
import { composeTypedPersistenceServices } from '../../paper-composition/bootstrap/typed-persistence-composition.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-typed-persistence-'));
  const dbPath = path.join(root, 'store.sqlite');
  const store = createSqliteStore({ dbPath });
  t.after(() => {
    try { store.close(); } catch { /* already closed by a test */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { dbPath, store };
}

function createRefereeSchema(store) {
  const result = store.execute(`
    CREATE TABLE referee_revision_requests (
      request_id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      request_key TEXT NOT NULL,
      matrix_rank INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'requested',
      risk_class TEXT NOT NULL DEFAULT '',
      objection TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  assert.equal(result.ok, true, result.error);
}

function sampleRepository(transactionStore) {
  return Object.freeze({
    insert(value) {
      const result = transactionStore.run('INSERT INTO sample(value) VALUES(?);', [value]);
      if (!result.ok) throw new Error(result.error || 'sample_insert_failed');
      return true;
    },
    insertUnchecked(value) {
      return transactionStore.run('INSERT INTO sample(value) VALUES(?);', [value]);
    },
    list() {
      const result = transactionStore.query('SELECT value FROM sample ORDER BY value;');
      if (!result.ok) throw new Error(result.error || 'sample_list_failed');
      return result.rows.map((row) => row.value);
    },
  });
}

function createSampleUnitOfWork(store) {
  return createSqliteUnitOfWork({ store, repositoryFactories: { samples: sampleRepository } });
}

test('RefereeIssueQueryPort parameterizes hostile paper ids and maps camelCase DTOs', (t) => {
  const { store } = fixture(t);
  createRefereeSchema(store);
  const hostilePaperId = "paper' OR 1=1 --";
  for (const [paperId, key, rank, status, riskClass] of [
    [hostilePaperId, 'hostile-open', 2, 'requested', 'high'],
    [hostilePaperId, 'hostile-closed', 1, 'closed', 'low'],
    ['other-paper', 'other-open', 0, 'requested', 'medium'],
  ]) {
    const inserted = store.run(
      `INSERT INTO referee_revision_requests
       (slug,request_key,matrix_rank,status,risk_class,objection,metadata_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?);`,
      [paperId, key, rank, status, riskClass, 'quoted objection', JSON.stringify({ key }), '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'],
    );
    assert.equal(inserted.ok, true, inserted.error);
  }
  const query = createSqliteRefereeIssueQuery({ store });
  assert.equal(query.countOpenByPaperId(hostilePaperId), 1);
  const rows = query.listOpenByPaperId(hostilePaperId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paperId, hostilePaperId);
  assert.equal(rows[0].requestKey, 'hostile-open');
  assert.equal(rows[0].matrixRank, 2);
  assert.equal(rows[0].riskClass, 'high');
  assert.deepEqual(rows[0].metadata, { key: 'hostile-open' });
  assert.equal('request_id' in rows[0], false);
  assert.equal('metadata_json' in rows[0], false);
});

test('UnitOfWork commits one synchronous transaction and exposes transaction-scoped repositories', (t) => {
  const { store } = fixture(t);
  createRefereeSchema(store);
  const refereeIssueWriter = (transactionStore) => Object.freeze({
    insert(paperId, requestKey) {
      const inserted = transactionStore.run(
      'INSERT INTO referee_revision_requests(slug,request_key,status,metadata_json) VALUES(?,?,?,?);',
        [paperId, requestKey, 'requested', '{}'],
      );
      if (!inserted.ok) throw new Error(inserted.error);
    },
  });
  const unitOfWork = createSqliteUnitOfWork({
    store,
    repositoryFactories: {
      refereeIssues: (transactionStore) => createSqliteRefereeIssueQuery({ store: transactionStore }),
      refereeIssueWriter,
    },
  });
  const services = composeTypedPersistenceServices({ store, overrides: { unitOfWork } });
  const result = services.unitOfWork.run((scope) => {
    assert.equal(Object.hasOwn(scope, 'store'), false);
    const { repositories } = scope;
    repositories.refereeIssueWriter.insert('paper-1', 'issue-1');
    assert.equal(repositories.refereeIssues.countOpenByPaperId('paper-1'), 1);
    return { count: repositories.refereeIssues.listOpenByPaperId('paper-1').length };
  });
  assert.deepEqual(result, { count: 1 });
  assert.equal(services.refereeIssueQuery.countOpenByPaperId('paper-1'), 1);
});

test('UnitOfWork rolls back callback failures and ignored SQLite constraint failures', (t) => {
  const { store } = fixture(t);
  assert.equal(store.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT UNIQUE);').ok, true);
  const unitOfWork = createSampleUnitOfWork(store);
  assert.throws(() => unitOfWork.run(({ repositories }) => {
    repositories.samples.insert('callback');
    throw new Error('callback_failed');
  }), /callback_failed/);
  assert.equal(store.query('SELECT count(*) AS count FROM sample;').rows[0].count, 0);

  assert.throws(() => unitOfWork.run(({ repositories }) => {
    assert.equal(repositories.samples.insertUnchecked('duplicate').ok, true);
    assert.equal(repositories.samples.insertUnchecked('duplicate').ok, false);
    return 'must_not_commit';
  }), /UNIQUE constraint failed/);
  assert.equal(store.query('SELECT count(*) AS count FROM sample;').rows[0].count, 0);
});

test('UnitOfWork rejects nested and async callbacks without exposing transaction-control capabilities', (t) => {
  const { store } = fixture(t);
  assert.equal(store.execute('CREATE TABLE sample(value TEXT);').ok, true);
  const unitOfWork = createSampleUnitOfWork(store);
  assert.throws(() => unitOfWork.run(() => unitOfWork.run(() => null)), /nested_unit_of_work_forbidden/);
  assert.throws(() => unitOfWork.run(async () => null), /async_callback_forbidden/);
  unitOfWork.run(({ repositories, ...scope }) => {
    assert.deepEqual(scope, {});
    assert.equal(Object.values(repositories).some((repository) => typeof repository.query === 'function' || typeof repository.execute === 'function'), false);
  });
  assert.equal(unitOfWork.run(({ repositories }) => repositories.samples.insert('after')), true);
  assert.deepEqual(store.query('SELECT value FROM sample;').rows, [{ value: 'after' }]);
});

test('transaction scope blocks outer-store escape and becomes unusable after completion', (t) => {
  const { store } = fixture(t);
  assert.equal(store.execute('CREATE TABLE sample(value TEXT);').ok, true);
  const unitOfWork = createSampleUnitOfWork(store);
  let leakedRepository = null;
  assert.throws(() => unitOfWork.run(({ repositories }) => {
    leakedRepository = repositories.samples;
    repositories.samples.insert('scoped');
    assert.equal(store.run('INSERT INTO sample(value) VALUES(?);', ['escaped']).ok, false);
  }), /outer_store_access_during_unit_of_work_forbidden/);
  assert.equal(store.query('SELECT count(*) AS count FROM sample;').rows[0].count, 0);
  assert.throws(() => leakedRepository.insert('late'), /transaction_scope_inactive/);

  assert.throws(() => unitOfWork.run(({ repositories }) => {
    assert.deepEqual(repositories.samples.list(), []);
    assert.throws(
      () => store.query('SELECT count(*) AS count FROM sample;'),
      /outer_store_access_during_unit_of_work_forbidden/,
    );
  }, { readOnly: true }), /outer_store_access_during_unit_of_work_forbidden/);
  assert.throws(() => unitOfWork.run(() => {
    assert.equal(store.checkpoint({ mode: 'PASSIVE' }).ok, false);
  }), /outer_store_access_during_unit_of_work_forbidden/);
  assert.throws(() => unitOfWork.run(() => store.close()), /outer_store_access_during_unit_of_work_forbidden/);
  assert.equal(store.available(), true);
});

test('read-only UnitOfWork permits queries, rejects writes and honors a read-only SQLite connection', (t) => {
  const { dbPath, store } = fixture(t);
  assert.equal(store.execute("CREATE TABLE sample(value TEXT); INSERT INTO sample(value) VALUES('kept');").ok, true);
  const unitOfWork = createSampleUnitOfWork(store);
  assert.deepEqual(unitOfWork.run(({ repositories }) => repositories.samples.list(), { readOnly: true }), ['kept']);
  assert.throws(() => unitOfWork.run(({ repositories }) => {
    assert.equal(repositories.samples.insertUnchecked('blocked').ok, false);
  }, { readOnly: true }), /readonly_store_execute_forbidden/);
  assert.equal(store.query('SELECT count(*) AS count FROM sample;').rows[0].count, 1);
  assert.equal(store.run('INSERT INTO sample(value) VALUES(?);', ['after-readonly']).ok, true);
  store.checkpoint({ mode: 'TRUNCATE' });
  const readOnlyStore = createReadOnlySqliteStore({ dbPath });
  t.after(() => readOnlyStore.close());
  const readOnlyUnitOfWork = createSampleUnitOfWork(readOnlyStore);
  assert.throws(() => readOnlyUnitOfWork.run(() => null), /readonly_unit_of_work_write_forbidden/);
  assert.deepEqual(readOnlyUnitOfWork.run(({ repositories }) => repositories.samples.list(), { readOnly: true }), ['after-readonly', 'kept']);
});
