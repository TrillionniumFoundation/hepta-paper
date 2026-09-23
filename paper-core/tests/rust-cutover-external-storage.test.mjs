import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRustCutoverFence } from '../../paper-adapters/migration/rust-cutover-fence.mjs';
import { createRustCutoverFence as oldFence } from '../../rust/oracle/fixtures/rust-cutover-fence-v1.mjs';

const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const id = (file) => { const stat = fs.statSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime'); const storage = path.join(root, 'coordinator');
  fs.mkdirSync(runtime, { mode: 0o700 }); fs.mkdirSync(storage, { mode: 0o700 });
  const dbPath = path.join(runtime, 'native.sqlite');
  const target = new DatabaseSync(dbPath); target.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT)'); target.close();
  const slot = createHash('sha256').update(JSON.stringify(['HeptaDurableCutoverExternalStorageV2', dbPath, id(dbPath)])).digest('hex');
  const slotPath = path.join(storage, slot); fs.mkdirSync(slotPath, { mode: 0o700 });
  const journalPath = path.join(slotPath, 'journal.sqlite'); const journal = new DatabaseSync(journalPath);
  fs.chmodSync(journalPath, 0o600);
  journal.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE hepta_cutover_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state_json TEXT NOT NULL);
CREATE TABLE hepta_cutover_journal(revision INTEGER PRIMARY KEY, event TEXT NOT NULL,
  evidence_json TEXT NOT NULL, state_json TEXT NOT NULL, previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL);
CREATE TRIGGER hepta_cutover_no_journal_update BEFORE UPDATE ON hepta_cutover_journal
BEGIN SELECT RAISE(ABORT, 'cutover_journal_append_only'); END;
CREATE TRIGGER hepta_cutover_no_journal_delete BEFORE DELETE ON hepta_cutover_journal
BEGIN SELECT RAISE(ABORT, 'cutover_journal_append_only'); END;`);
  const state = { version: 1, cutoverId: 'external', databasePath: dbPath, mode: 'local_drill', phase: 'planned',
    oldWriterId: 'node', newWriterId: 'rust', writerId: 'node', generation: 1, token: 'external:1', revision: 0,
    shadowCases: 0, shadowMismatches: 0, canaryScopes: [], productionActivation: false, activationReceiptHash: null };
  let previous = '';
  const save = () => {
    const text = JSON.stringify(state); const entry = hash(JSON.stringify(['HeptaDurableCutoverJournalV1', state.revision, 'fixture', '{}', text, previous]));
    journal.prepare('INSERT INTO hepta_cutover_journal VALUES(?,?,?,?,?,?)').run(state.revision, 'fixture', '{}', text, previous, entry);
    journal.prepare('INSERT INTO hepta_cutover_state VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json').run(text);
    previous = entry;
  }; save();
  t.after(() => journal.close());
  const markerPath = `${dbPath}.rust-cutover.enrolled.json`;
  fs.writeFileSync(markerPath, '{}', { mode: 0o600 });
  fs.writeFileSync(markerPath, JSON.stringify({ version: 2, kind: 'HeptaDurableCutoverExternalEnrollment',
    databasePath: dbPath, databaseIdentity: id(dbPath), storageRoot: storage, storageRootIdentity: id(storage),
    storageSlot: slot, storageSlotIdentity: id(slotPath), journalIdentity: id(journalPath), markerIdentity: id(markerPath) }), { mode: 0o600 });
  const fence = (extra = {}) => { const result = createRustCutoverFence({ dbPath, ...extra }); t.after(() => result.close()); return result; };
  return { root, runtime, storage, slotPath, dbPath, markerPath, journalPath, journal, state, save, fence };
}

test('v2 marker dispatch shares writer epochs and old V1 client fails closed', (t) => {
  const f = fixture(t); const fence = f.fence();
  assert.equal(fence.withWrite(() => fence.withWrite(() => 'node')), 'node');
  const old = oldFence({ dbPath: f.dbPath }); t.after(() => old.close());
  assert.throws(() => old.withWrite(() => assert.fail('old client must not bypass v2')), /enrollment_unavailable/);
  Object.assign(f.state, { revision: 1, phase: 'canary', writerId: 'rust', generation: 3, token: 'external:3' }); f.save();
  assert.throws(() => fence.withWrite(() => assert.fail('canary denies Node')), /node_writer_disabled/);
  Object.assign(f.state, { revision: 2, phase: 'rolled_back', writerId: 'node', generation: 4, token: 'external:4' }); f.save();
  assert.throws(() => fence.withWrite(() => assert.fail('old lease')), /stale_writer_generation/);
  assert.equal(f.fence().withWrite(() => 'new epoch'), 'new epoch');
});

test('explicit root and marker hash only constrain marker selection', (t) => {
  const f = fixture(t); const pin = hash(fs.readFileSync(f.markerPath));
  assert.equal(f.fence({ expectedStorageRoot: f.storage, expectedEnrollmentHash: pin }).withWrite(() => true), true);
  for (const extra of [{ expectedStorageRoot: f.root }, { expectedEnrollmentHash: 'sha256:wrong' }]) {
    assert.throws(() => f.fence(extra).withWrite(() => assert.fail('mismatched expectation')), /storage_expectation_mismatch/);
  }
});

for (const kind of ['storage', 'slotPath', 'markerPath', 'journalPath', 'dbPath']) {
  test(`v2 retains actual ${kind} identity against byte-identical substitution`, (t) => {
    const f = fixture(t); const fence = f.fence(); fence.withWrite(() => true);
    const selected = f[kind]; const saved = `${selected}.saved`; const stat = fs.statSync(selected);
    fs.renameSync(selected, saved);
    if (stat.isDirectory()) fs.mkdirSync(selected, { mode: 0o700 });
    else { fs.copyFileSync(saved, selected); fs.chmodSync(selected, stat.mode & 0o7777); }
    assert.throws(() => fence.withWrite(() => assert.fail('substitution')), /enrollment_identity_changed/);
  });
}

test('mixed legacy remnants, altered journal schema and pending sentinel never permit callback', (t) => {
  const f = fixture(t); const fence = f.fence(); fence.withWrite(() => true);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const mixed = `${f.dbPath}.rust-cutover.sqlite${suffix}`; fs.writeFileSync(mixed, 'legacy');
    assert.throws(() => fence.withWrite(() => assert.fail('mixed enrollment')), /mixed_enrollment/); fs.unlinkSync(mixed);
  }
  f.journal.exec('CREATE TABLE injected(id INTEGER)');
  assert.throws(() => fence.withWrite(() => assert.fail('extra schema')), /journal_schema_invalid/);
  fs.writeFileSync(f.markerPath, JSON.stringify({ version: 2, kind: 'HeptaDurableCutoverEnrollmentPending' }));
  assert.throws(() => f.fence().withWrite(() => assert.fail('pending enrollment')), /external_enrollment_invalid/);
});

test('v2 rejects unsafe directory mode and marker mutation, and callback failure releases lock', (t) => {
  const f = fixture(t); const fence = f.fence();
  assert.throws(() => fence.withWrite(() => { throw new Error('application-failed'); }), /application-failed/);
  assert.equal(fence.withWrite(() => 'retry'), 'retry');
  fs.chmodSync(f.storage, 0o755);
  assert.throws(() => fence.withWrite(() => assert.fail('root mode')), /enrollment_identity_changed/);
  fs.chmodSync(f.storage, 0o700);
  fs.appendFileSync(f.markerPath, ' ');
  assert.throws(() => fence.withWrite(() => assert.fail('marker bytes')), /enrollment_identity_changed/);
});

test('hardlinked marker is rejected before opening its bytes', (t) => {
  const f = fixture(t); const fence = f.fence(); fence.withWrite(() => true);
  fs.linkSync(f.markerPath, `${f.markerPath}.link`);
  assert.throws(() => fence.withWrite(() => assert.fail('hardlinked marker')), /enrollment_unavailable/);
  assert.throws(() => f.fence().withWrite(() => assert.fail('fresh hardlinked marker')), /enrollment_unavailable/);
});
