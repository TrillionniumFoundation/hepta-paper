import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import * as owner from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';

test('shared online marker source preserves the complete incumbent Node schema protocol value', () => {
  const value = {
    markerStatements: owner.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
    markerHash: owner.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_HASH,
    journalStatements: owner.AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
    journalHash: owner.AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
    journalVersion: owner.AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION,
    journalContract: owner.AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
  };
  // Golden complete-value digest observed from the actual incumbent Node owner
  // before extraction; this is a compatibility oracle, not another SQL source.
  assert.equal(createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    'c746a6a60c2498c43bdb51752af751bcdf6d493605ce239300b14a930c25e4f9');
  assert.equal(value.markerHash,
    'sha256:e20837fdb68ac90bae2a5c3536857d75d2c1e2290f1d80a2001c0d3b4fd0328f');
  assert.equal(value.markerStatements.length, 11);
  assert.ok(Object.isFrozen(value.markerStatements));
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of value.markerStatements) db.exec(sql);
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name,tbl_name").all();
    assert.equal(objects.length, 11);
    assert.deepEqual(objects.reduce((counts, row) => {
      counts[row.type] = (counts[row.type] || 0) + 1;
      return counts;
    }, {}), { index: 1, table: 3, trigger: 7 });
    assert.throws(() => value.markerStatements.push('CREATE TABLE caller_sql(id)'), TypeError);
    const integrity = db.prepare('PRAGMA quick_check').all();
    assert.equal(integrity.length, 1);
    assert.equal(integrity[0].quick_check, 'ok');
  } finally {
    db.close();
  }
});
