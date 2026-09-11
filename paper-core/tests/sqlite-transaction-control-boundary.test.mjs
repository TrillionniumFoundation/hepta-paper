import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOfflineSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { assertNoSqliteTransactionControl } from '../../paper-adapters/persistence/sqlite-transaction-sql-guard.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-transaction-control-'));
  const store = createOfflineSqliteStore({ dbPath: path.join(root, 'native.sqlite') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(store.execute('CREATE TABLE sample(value TEXT); CREATE TABLE audit(value TEXT);').ok, true);
  return store;
}

const forbidden = /sqlite_transaction_control_statement_forbidden/;

test('all scoped SQL entry points reject hidden transaction ownership commands and poison the whole unit', (t) => {
  const store = fixture(t);
  const commands = [
    'BEGIN IMMEDIATE;', 'COMMIT;', 'END TRANSACTION;', 'ROLLBACK;',
    'SAVEPOINT nested;', 'RELEASE SAVEPOINT nested;',
    '/* prefix ; SELECT 1 */ CoMmIt;', '-- prefix\n\tCOMMIT;',
    ';; /* ;END; */ END;', '\uFEFFCOMMIT;',
    "INSERT INTO sample VALUES('must-not-run'); /* prefix */ COMMIT;",
    "SELECT 'COMMIT; END;'; -- command follows\nCOMMIT;",
    'CREATE TRIGGER hidden AFTER INSERT ON sample BEGIN SELECT 1; END; COMMIT;',
  ];
  for (const operation of ['query', 'run', 'execute']) {
    for (const sql of commands) {
      assert.throws(() => store.transaction((tx) => {
        assert.equal(tx.run("INSERT INTO sample VALUES('must-rollback')").ok, true);
        if (operation === 'query') {
          assert.throws(() => tx.query(sql), forbidden, `${operation}: ${sql}`);
        } else {
          const rejected = tx[operation](sql);
          assert.equal(rejected.ok, false, `${operation}: ${sql}`);
          assert.match(rejected.error, forbidden);
        }
        // Even a caught/ignored rejection must force the enclosing unit to roll back.
        return 'must-not-commit';
      }), forbidden, `${operation}: ${sql}`);
      assert.deepEqual(store.query('SELECT * FROM sample').rows, [], `${operation}: ${sql}`);
    }
  }
});

test('quoted control words, parameters, comments and a real trigger remain valid in scoped multi-statement SQL', (t) => {
  const store = fixture(t);
  store.transaction((tx) => {
    assert.equal(tx.execute(`
      CREATE TABLE "COMMIT"("END" TEXT, [ROLLBACK] TEXT, \`BEGIN\` TEXT);
      INSERT INTO "COMMIT" VALUES('value''; COMMIT; -- text', 'END; /* ROLLBACK */', 'SAVEPOINT');
      /* COMMIT; ROLLBACK; */
      CREATE TEMP TRIGGER "RELEASE" AFTER INSERT ON sample
      BEGIN
        INSERT INTO audit VALUES(CASE WHEN NEW.value='first' THEN 'COMMIT' ELSE 'END' END);
        INSERT INTO audit VALUES('second;END;');
      END;
      -- COMMIT; text in a comment
      INSERT INTO sample VALUES('first');
    `).ok, true);
    assert.deepEqual(tx.query('SELECT 1 AS semi, 2 AS other').rows, [{ semi: 1, other: 2 }]);
    assert.equal(tx.run('INSERT INTO sample VALUES(?)', ['BEGIN; COMMIT; ROLLBACK;']).ok, true);
    assert.equal(tx.query('SELECT "END", [ROLLBACK], `BEGIN` FROM "COMMIT"').rows[0].END,
      "value'; COMMIT; -- text");
    assert.equal(tx.query('EXPLAIN COMMIT').ok, true);
  });
  assert.deepEqual(store.query('SELECT * FROM sample').rows, [
    { value: 'first' }, { value: 'BEGIN; COMMIT; ROLLBACK;' },
  ]);
  assert.deepEqual(store.query('SELECT * FROM audit').rows, [
    { value: 'COMMIT' }, { value: 'second;END;' }, { value: 'END' }, { value: 'second;END;' },
  ]);
});

test('the SQL string validated by the guard is the exact string executed', (t) => {
  const store = fixture(t);
  for (const operation of ['query', 'run', 'execute']) {
    let conversions = 0;
    const sql = { toString() { conversions += 1; return conversions === 1 ? 'SELECT 1;' : 'COMMIT;'; } };
    assert.throws(() => store.transaction((tx) => {
      tx.run("INSERT INTO sample VALUES('rollback')");
      assert.equal(tx[operation](sql).ok, true);
      throw new Error('application-failed');
    }), /application-failed/);
    assert.equal(conversions, 1);
    assert.deepEqual(store.query('SELECT * FROM sample').rows, []);
  }
});

test('outer explicit migration transactions remain supported', (t) => {
  const store = fixture(t);
  assert.equal(store.execute("BEGIN IMMEDIATE; INSERT INTO sample VALUES('committed'); COMMIT;").ok, true);
  assert.deepEqual(store.query('SELECT * FROM sample').rows, [{ value: 'committed' }]);
});

test('trigger boundary recognition cannot hide a subsequent control statement behind CASE, comments or quoted END', () => {
  const trigger = `CREATE TEMP TRIGGER test AFTER INSERT ON sample BEGIN
    INSERT INTO audit VALUES(CASE WHEN 1 THEN 'END; COMMIT;' ELSE 'ROLLBACK' END);
    INSERT INTO audit VALUES('double''quote;END;');
  END /* ; COMMIT; */;`;
  assert.doesNotThrow(() => assertNoSqliteTransactionControl(trigger));
  for (const command of ['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT x', 'RELEASE x']) {
    assert.throws(() => assertNoSqliteTransactionControl(`${trigger} -- separator\n${command};`), forbidden);
  }
  assert.doesNotThrow(() => assertNoSqliteTransactionControl("SELECT 'COMMIT;'; -- no newline COMMIT;"));
  assert.doesNotThrow(() => assertNoSqliteTransactionControl('SELECT "END", `COMMIT`, [ROLLBACK]; /* BEGIN; */'));
});
