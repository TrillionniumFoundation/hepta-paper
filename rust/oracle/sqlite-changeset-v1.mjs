// Test-only incumbent oracle. All databases are in-memory; no authority is used.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { inspectSqliteChangesetEffects, assertSqliteChangesetEffectsAuthorized } from '../../paper-adapters/automation/sqlite-changeset-policy.mjs';

assert.equal(process.version, 'v22.23.1');
const capture = (fn) => { try { return { ok: fn() }; } catch (error) { return { error: error.message }; } };
const all = ['INSERT', 'UPDATE', 'DELETE'].flatMap((operation) => ['rows_a', 'rows_b', 'indirect_rows'].map((table) => ({ table, operation })));
const cases = [];
function add(name, bytes, authorized = all, executed = all) {
  cases.push({ name, hex: Buffer.from(bytes).toString('hex'), authorized, executed,
    inspect: capture(() => inspectSqliteChangesetEffects(bytes)),
    authorization: capture(() => assertSqliteChangesetEffectsAuthorized({ changeset: bytes, authorizedEffects: authorized, executedEffects: executed })) });
}
function fixture(indirect = false) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE rows_a(id INTEGER PRIMARY KEY, text TEXT, num REAL, data BLOB);
      CREATE TABLE rows_b(id INTEGER, other INTEGER, text TEXT, PRIMARY KEY(id,other));
      CREATE TABLE indirect_rows(id INTEGER PRIMARY KEY, text TEXT);
      INSERT INTO rows_a VALUES(1,'old',3.5,X'0001'),(2,'delete',NULL,NULL);`);
    if (indirect) db.exec('CREATE TRIGGER hidden AFTER UPDATE ON rows_a BEGIN INSERT INTO indirect_rows VALUES(new.id,new.text); END;');
    const session = db.createSession();
    try {
      db.exec("UPDATE rows_a SET text='new',num=4.5,data=X'0000ff' WHERE id=1; DELETE FROM rows_a WHERE id=2; INSERT INTO rows_a VALUES(3,'中🌍',NULL,X'00'); INSERT INTO rows_b VALUES(1,2,'compound');");
      return Buffer.from(session.changeset());
    } finally { session.close(); }
  } finally { db.close(); }
}
const valid = fixture();
add('actual-session-all-storage-types-and-composite-primary-key', valid);
add('actual-trigger-indirect-effect', fixture(true));
add('empty', Buffer.alloc(0));
add('missing-authorization', valid, [], all);
add('missing-successful-invocation', valid, all, []);
add('lowercase-authorization', valid, all.map((entry) => ({ ...entry, operation: entry.operation.toLowerCase() })), all);
add('invalid-authorization-even-empty', Buffer.alloc(0), [{ table: 'bad-name', operation: 'UPDATE' }], []);
const header = [0x54, 1, 1, ...Buffer.from('rows_a'), 0];
for (const [name, bytes] of [
  ['patchset', [0x50, 1, 1, 0]], ['columns-zero', [0x54, 0]],
  ['columns-too-many', [0x54, 0xa0, 0x01]], ['primary-key-missing', [0x54, 1, 0, 0]],
  ['primary-key-out-of-range', [0x54, 1, 2]], ['primary-key-order-gap', [0x54, 2, 0, 2]],
  ['primary-key-duplicate', [0x54, 2, 1, 1]], ['table-unterminated', [0x54, 1, 1, 0x61]],
  ['invalid-utf8', [0x54, 1, 1, 0xff, 0]], ['unsafe-table', [0x54, 1, 1, 0x2f, 0]],
  ['bom-table', [0x54, 1, 1, 0xef, 0xbb, 0xbf, ...Buffer.from('rows_a'), 0]],
  ['varint-overflow', [0x54, ...Array(9).fill(0xff)]],
  ['invalid-opcode', [...header, 3, 0]], ['indirect-precedes-opcode', [...header, 3, 1]],
  ['invalid-value', [...header, 0x12, 0, 6]],
  ['value-too-large', [...header, 0x12, 0, 3, 0x88, 0x80, 0x80, 0x01]],
  ['undefined-record', [...header, 0x12, 0, 0]],
  ['truncated-int', [...header, 0x12, 0, 1, 0, 0]],
  ['truncated-update', [...header, 0x17, 0, 5]],
]) add(name, Buffer.from(bytes));
for (let size = 0; size < valid.length; size += 1) add(`truncation-${size}`, valid.subarray(0, size));
for (let index = 0; index < valid.length; index += 1) {
  for (const byte of [0, 0x54, 0xff]) {
    const altered = Buffer.from(valid); altered[index] = byte;
    add(`mutation-${index}-${byte}`, altered);
  }
}
for (const [name, unit, count] of [
  ['table-limit', header, 1025],
  ['change-limit', [0x12, 0, 5], 1_000_001],
  ['byte-limit', [0], 16 * 1024 * 1024 + 1],
]) {
  const prefix = name === 'change-limit' ? header : [];
  const bytes = Buffer.concat([Buffer.from(prefix), Buffer.alloc(unit.length * count).map((_, index) => unit[index % unit.length])]);
  cases.push({ name, repeat: { unit, count, prefix }, authorized: all, executed: all,
    inspect: capture(() => inspectSqliteChangesetEffects(bytes)),
    authorization: capture(() => assertSqliteChangesetEffectsAuthorized({ changeset: bytes, authorizedEffects: all, executedEffects: all })) });
}
process.stdout.write(JSON.stringify(cases));
