import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRustCutoverFence } from '../../paper-adapters/migration/rust-cutover-fence.mjs';
import { createOfflineSqliteStore, createReadOnlySqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-node-cutover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'native.sqlite');
  const target = new DatabaseSync(dbPath);
  target.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT)');
  target.close();
  return { root, dbPath };
}

function enroll(dbPath) {
  const journalPath = `${dbPath}.rust-cutover.sqlite`;
  const journal = new DatabaseSync(journalPath);
  journal.exec('CREATE TABLE hepta_cutover_state(singleton INTEGER PRIMARY KEY, state_json TEXT NOT NULL)');
  journal.exec(`CREATE TABLE hepta_cutover_journal(revision INTEGER PRIMARY KEY,event TEXT,evidence_json TEXT,
    state_json TEXT,previous_hash TEXT,entry_hash TEXT)`);
  const state = { version: 1, databasePath: dbPath, cutoverId: 'test', mode: 'local_drill',
    phase: 'planned', oldWriterId: 'node', newWriterId: 'rust', writerId: 'node',
    generation: 1, token: 'test:1', revision: 0 };
  const save = () => {
    const maximum = journal.prepare('SELECT MAX(revision) AS revision FROM hepta_cutover_journal').get().revision;
    for (let revision = maximum === null ? 0 : Math.min(maximum + 1, state.revision); revision <= state.revision; revision += 1) {
      const stateJson = JSON.stringify({ ...state, revision });
      const previousHash = revision === 0 ? '' : journal.prepare('SELECT entry_hash FROM hepta_cutover_journal WHERE revision=?').get(revision - 1).entry_hash;
      const tuple = ['HeptaDurableCutoverJournalV1', revision, 'fixture_transition', '{}', stateJson, previousHash];
      const hash = `sha256:${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`;
      journal.prepare('INSERT OR REPLACE INTO hepta_cutover_journal VALUES(?,?,?,?,?,?)').run(...tuple.slice(1), hash);
    }
    journal.prepare('INSERT INTO hepta_cutover_state VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json').run(JSON.stringify(state));
  };
  save();
  const id = (file) => { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}`; };
  fs.writeFileSync(`${dbPath}.rust-cutover.enrolled.json`, JSON.stringify({
    version: 1, databasePath: dbPath, databaseIdentity: id(dbPath), journalIdentity: id(journalPath),
  }));
  return { state, journal, save };
}

test('a previously open Node store observes enrollment and retains its first epoch', (t) => {
  const { dbPath } = fixture(t);
  const fence = createRustCutoverFence({ dbPath });
  t.after(() => fence.close());
  assert.equal(fence.withWrite(() => 'unmanaged'), 'unmanaged');
  const enrolled = enroll(dbPath);
  t.after(() => enrolled.journal.close());
  assert.equal(fence.withWrite(() => fence.withWrite(() => 'node-write')), 'node-write');
  Object.assign(enrolled.state, { phase: 'canary', writerId: 'rust', generation: 3, token: 'test:3', revision: 4 });
  enrolled.save();
  let invoked = false;
  assert.throws(() => fence.withWrite(() => { invoked = true; }), /node_writer_disabled/);
  assert.equal(invoked, false);
  Object.assign(enrolled.state, { phase: 'rolled_back', writerId: 'node', generation: 4, token: 'test:4', revision: 5 });
  enrolled.save();
  assert.throws(() => fence.withWrite(() => 'stale'), /stale_writer_generation/);
  const restarted = createRustCutoverFence({ dbPath });
  t.after(() => restarted.close());
  assert.equal(restarted.withWrite(() => 'new-node-epoch'), 'new-node-epoch');
});

test('marker or journal removal fails closed for existing and newly opened stores', (t) => {
  const { dbPath } = fixture(t);
  const enrolled = enroll(dbPath);
  const fence = createRustCutoverFence({ dbPath });
  assert.equal(fence.withWrite(() => true), true);
  enrolled.journal.close();
  fs.renameSync(`${dbPath}.rust-cutover.sqlite`, `${dbPath}.moved.sqlite`);
  assert.throws(() => fence.withWrite(() => false), /enrollment_unavailable/);
  const fresh = createRustCutoverFence({ dbPath });
  assert.throws(() => fresh.withWrite(() => false), /enrollment_unavailable/);
  fence.close(); fresh.close();
});

test('a dormant pre-enrollment Node process cannot adopt a completed rollback epoch', (t) => {
  const { dbPath } = fixture(t);
  const dormant = createRustCutoverFence({ dbPath });
  t.after(() => dormant.close());
  const enrolled = enroll(dbPath);
  t.after(() => enrolled.journal.close());
  Object.assign(enrolled.state, { phase: 'rolled_back', writerId: 'node', generation: 4, token: 'test:4', revision: 5 });
  enrolled.save();
  assert.throws(() => dormant.withWrite(() => 'stale-work'), /stale_writer_generation/);
});

test('enrollment observed by construction cannot disappear before the first write', (t) => {
  const { dbPath } = fixture(t);
  const enrolled = enroll(dbPath);
  enrolled.journal.close();
  const fence = createRustCutoverFence({ dbPath });
  t.after(() => fence.close());
  fs.unlinkSync(`${dbPath}.rust-cutover.sqlite`);
  fs.unlinkSync(`${dbPath}.rust-cutover.enrolled.json`);
  assert.throws(() => fence.withWrite(() => assert.fail('must not execute')), /enrollment_unavailable/);
});

test('dangling enrollment symlinks cannot masquerade as an unenrolled database', (t) => {
  const { dbPath, root } = fixture(t);
  fs.symlinkSync(path.join(root, 'missing-journal'), `${dbPath}.rust-cutover.sqlite`);
  fs.symlinkSync(path.join(root, 'missing-marker'), `${dbPath}.rust-cutover.enrolled.json`);
  const fence = createRustCutoverFence({ dbPath });
  t.after(() => fence.close());
  assert.throws(() => fence.withWrite(() => assert.fail('must not execute')), /enrollment_unavailable/);
});

test('target file substitution and a corrupt coordinator fail closed', (t) => {
  const { dbPath } = fixture(t);
  const enrolled = enroll(dbPath);
  const fence = createRustCutoverFence({ dbPath });
  t.after(() => fence.close());
  t.after(() => enrolled.journal.close());
  fence.withWrite(() => true);
  fs.renameSync(dbPath, `${dbPath}.original`);
  fs.copyFileSync(`${dbPath}.original`, dbPath);
  assert.throws(() => fence.withWrite(() => false), /enrollment_identity_changed/);
});

test('application exceptions release the epoch lock without changing ownership', (t) => {
  const { dbPath } = fixture(t);
  const enrolled = enroll(dbPath);
  t.after(() => enrolled.journal.close());
  const fence = createRustCutoverFence({ dbPath });
  t.after(() => fence.close());
  assert.throws(() => fence.withWrite(() => { throw new Error('application-failed'); }), /application-failed/);
  assert.equal(fence.withWrite(() => 'retry'), 'retry');
  assert.throws(() => fence.withWrite(() => Promise.resolve()), /async_callback_forbidden/);
  assert.equal(fence.inspect().generation, 1);
});

test('malformed persisted epoch fields reject callbacks before any native write', (t) => {
  const { dbPath } = fixture(t);
  const enrolled = enroll(dbPath);
  t.after(() => enrolled.journal.close());
  enrolled.state.token = { malformed: true };
  enrolled.save();
  const fence = createRustCutoverFence({ dbPath });
  t.after(() => fence.close());
  assert.throws(() => fence.withWrite(() => assert.fail('must not execute')), /state_invalid/);
});

test('state-only ownership forgery and journal tail corruption cannot re-enable Node', (t) => {
  const { dbPath } = fixture(t);
  const enrolled = enroll(dbPath);
  t.after(() => enrolled.journal.close());
  const fence = createRustCutoverFence({ dbPath });
  t.after(() => fence.close());
  fence.withWrite(() => true);
  Object.assign(enrolled.state, { phase: 'canary', writerId: 'rust', generation: 3, token: 'test:3', revision: 4 });
  enrolled.save();
  const forged = { ...enrolled.state, phase: 'planned', writerId: 'node', generation: 1, token: 'test:1' };
  enrolled.journal.prepare('UPDATE hepta_cutover_state SET state_json=?').run(JSON.stringify(forged));
  assert.throws(() => fence.withWrite(() => assert.fail('forged state must not execute')), /journal_corrupt/);
  enrolled.state.phase = 'rolled_back'; enrolled.state.writerId = 'node';
  enrolled.save();
  enrolled.journal.prepare("UPDATE hepta_cutover_journal SET entry_hash='sha256:forged' WHERE revision=4").run();
  assert.throws(() => fence.withWrite(() => assert.fail('forged hash must not execute')), /journal_corrupt/);
});

test('actual native StorePort fences every mutation and preserves read-only inspection', (t) => {
  const { dbPath } = fixture(t);
  const store = createOfflineSqliteStore({ dbPath });
  t.after(() => store.close());
  assert.equal(store.run("INSERT INTO records VALUES(1,'pre-enrollment')").ok, true);
  const enrolled = enroll(dbPath);
  t.after(() => enrolled.journal.close());
  assert.equal(store.transaction((tx) => tx.run("INSERT INTO records VALUES(2,'node')")).ok, true);
  Object.assign(enrolled.state, { phase: 'canary', writerId: 'rust', generation: 3, token: 'test:3', revision: 4 });
  enrolled.save();
  const rejected = (action) => {
    try { assert.equal(action().ok, false); }
    catch (error) { assert.match(error.message, /node_writer_disabled/); }
  };
  rejected(() => store.run("INSERT INTO records VALUES(3,'stale')"));
  rejected(() => store.execute("INSERT INTO records VALUES(3,'stale')"));
  rejected(() => store.query("INSERT INTO records VALUES(3,'stale') RETURNING id"));
  assert.throws(() => store.transaction((tx) => tx.run("INSERT INTO records VALUES(3,'stale')")), /node_writer_disabled/);
  rejected(() => store.checkpoint());
  assert.throws(() => createOfflineSqliteStore({ dbPath }), /node_writer_disabled/);
  const readonly = createReadOnlySqliteStore({ dbPath });
  t.after(() => readonly.close());
  assert.equal(readonly.query('SELECT count(*) AS count FROM records').rows[0].count, 2);
});
