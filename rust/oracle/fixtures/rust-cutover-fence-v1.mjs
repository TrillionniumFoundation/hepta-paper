import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const fail = (code) => { throw new Error(`rust_cutover_${code}`); };
const identity = (stat) => `${stat.dev}:${stat.ino}`;
function artifactPresent(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    const wrapped = new Error('rust_cutover_enrollment_unavailable');
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * Serialize the complete synchronous native mutation against writer handoff.
 * This supplements the existing external mutation authority; it never grants it.
 * An absent enrollment is compatible with existing Node deployments. Once either
 * enrollment artifact appears, missing/replaced/corrupt artifacts fail closed.
 */
export function createRustCutoverFence({ dbPath, busyTimeoutMs = 10_000 } = {}) {
  if (!dbPath) fail('database_path_required');
  const targetPath = path.resolve(dbPath);
  const journalPath = `${targetPath}.rust-cutover.sqlite`;
  const markerPath = `${targetPath}.rust-cutover.enrolled.json`;
  const enrollmentAtCreation = artifactPresent(journalPath) || artifactPresent(markerPath);
  let enrolled = enrollmentAtCreation;
  let database = null;
  let journalIdentity = null;
  let targetIdentity = null;
  let markerIdentity = null;
  let lease = null;
  let depth = 0;
  let closed = false;

  function observe() {
    if (closed) fail('fence_closed');
    if (!enrolled && !artifactPresent(journalPath) && !artifactPresent(markerPath)) return false;
    enrolled = true;
    let journalStat; let markerStat; let targetStat; let marker;
    try {
      journalStat = fs.lstatSync(journalPath);
      markerStat = fs.lstatSync(markerPath);
      targetStat = fs.lstatSync(targetPath);
      if (![journalStat, markerStat, targetStat].every((stat) => stat.isFile() && !stat.isSymbolicLink())) {
        fail('enrollment_identity_invalid');
      }
      if (markerStat.size > 16_384) fail('enrollment_marker_invalid');
      marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch (error) {
      const wrapped = new Error('rust_cutover_enrollment_unavailable');
      wrapped.cause = error;
      throw wrapped;
    }
    if (fs.realpathSync(targetPath) !== targetPath || marker.version !== 1
      || marker.databasePath !== targetPath
      || marker.journalIdentity !== identity(journalStat)
      || marker.databaseIdentity !== identity(targetStat)
      || (journalIdentity !== null && journalIdentity !== identity(journalStat))
      || (targetIdentity !== null && targetIdentity !== identity(targetStat))
      || (markerIdentity !== null && markerIdentity !== identity(markerStat))) {
      fail('enrollment_identity_changed');
    }
    journalIdentity = identity(journalStat);
    targetIdentity = identity(targetStat);
    markerIdentity = identity(markerStat);
    if (!database) {
      database = new DatabaseSync(journalPath, { readOnly: false });
      database.exec(`PRAGMA busy_timeout=${Math.min(30_000, Math.max(1, Number(busyTimeoutMs) || 10_000))};`);
      const afterOpen = fs.lstatSync(journalPath);
      if (identity(afterOpen) !== journalIdentity) fail('enrollment_identity_changed');
    }
    return true;
  }

  function readState() {
    const row = database.prepare('SELECT state_json FROM hepta_cutover_state WHERE singleton=1').get();
    if (!row) fail('state_missing');
    if (typeof row.state_json !== 'string' || Buffer.byteLength(row.state_json, 'utf8') > 131_072) fail('state_invalid');
    const state = JSON.parse(row.state_json);
    const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
    if (state.version !== 1 || state.databasePath !== targetPath
      || !Number.isSafeInteger(state.generation) || state.generation < 1
      || !Number.isSafeInteger(state.revision) || state.revision < 0
      || !validId(state.cutoverId) || !validId(state.oldWriterId) || !validId(state.newWriterId)
      || state.oldWriterId === state.newWriterId
      || state.token !== `${state.cutoverId}:${state.generation}`
      || !['planned', 'quiesced', 'backed_up', 'shadow_verified', 'canary', 'active', 'rolled_back'].includes(state.phase)
      || !['local_drill', 'production'].includes(state.mode)) fail('state_invalid');
    const tail = database.prepare(`SELECT revision,event,evidence_json,state_json,previous_hash,entry_hash
      FROM hepta_cutover_journal ORDER BY revision DESC LIMIT 1`).get();
    if (!tail || tail.revision !== state.revision || tail.state_json !== row.state_json
      || ['event', 'evidence_json', 'state_json', 'previous_hash', 'entry_hash'].some((key) => typeof tail[key] !== 'string')) {
      fail('journal_corrupt');
    }
    // This is exactly Rust's domain-separated entry_hash tuple. Journal hashes
    // are integrity checks, not signatures or independent production authority.
    const expectedHash = `sha256:${createHash('sha256').update(JSON.stringify([
      'HeptaDurableCutoverJournalV1', tail.revision, tail.event, tail.evidence_json,
      tail.state_json, tail.previous_hash,
    ])).digest('hex')}`;
    if (tail.entry_hash !== expectedHash) fail('journal_corrupt');
    if (tail.revision === 0) {
      if (tail.previous_hash !== '') fail('journal_corrupt');
    } else {
      const previous = database.prepare('SELECT entry_hash FROM hepta_cutover_journal WHERE revision=?').get(tail.revision - 1);
      if (!previous || previous.entry_hash !== tail.previous_hash) fail('journal_corrupt');
    }
    return state;
  }

  function withWrite(callback) {
    if (typeof callback !== 'function') fail('callback_required');
    if (depth > 0) {
      const value = callback();
      if (value && typeof value.then === 'function') fail('async_callback_forbidden');
      return value;
    }
    if (!observe()) {
      const value = callback();
      if (value && typeof value.then === 'function') fail('async_callback_forbidden');
      return value;
    }
    database.exec('BEGIN IMMEDIATE;');
    try {
      observe();
      const state = readState();
      if (!['planned', 'rolled_back'].includes(state.phase) || state.writerId !== state.oldWriterId) {
        fail('node_writer_disabled');
      }
      // A store opened before enrollment must not silently adopt a later Node
      // rollback epoch if it happened to perform no calls during the cutover.
      if (lease === null && !enrollmentAtCreation && state.generation !== 1) fail('stale_writer_generation');
      if (lease === null) lease = Object.freeze({ generation: state.generation, token: state.token, writerId: state.writerId });
      if (state.generation !== lease.generation || state.token !== lease.token || state.writerId !== lease.writerId) {
        fail('stale_writer_generation');
      }
      depth = 1;
      const value = callback();
      if (value && typeof value.then === 'function') fail('async_callback_forbidden');
      // No coordinator data is mutated: ROLLBACK releases the lock without an
      // extra durable commit that could misclassify an already committed write.
      database.exec('ROLLBACK;');
      return value;
    } catch (error) {
      if (database.isTransaction) {
        try { database.exec('ROLLBACK;'); } catch { /* preserve failure */ }
      }
      throw error;
    } finally { depth = 0; }
  }

  return Object.freeze({
    withWrite,
    inspect() {
      if (!observe()) return null;
      if (depth) return Object.freeze(readState());
      database.exec('BEGIN;');
      try { return Object.freeze(readState()); }
      finally { database.exec('ROLLBACK;'); }
    },
    close() {
      if (depth) fail('close_during_write');
      if (database) database.close();
      closed = true;
    },
  });
}
