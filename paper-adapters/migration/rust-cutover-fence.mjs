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
export function createRustCutoverFence({ dbPath, busyTimeoutMs = 10_000,
  expectedStorageRoot = null, expectedEnrollmentHash = null } = {}) {
  if (!dbPath) fail('database_path_required');
  const targetPath = path.resolve(dbPath);
  const legacyJournalPath = `${targetPath}.rust-cutover.sqlite`;
  let journalPath = legacyJournalPath;
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
  let external = null;

  function externalObserve(marker, markerBytes) {
    const keys = ['version', 'kind', 'databasePath', 'databaseIdentity', 'storageRoot',
      'storageRootIdentity', 'storageSlot', 'storageSlotIdentity', 'journalIdentity', 'markerIdentity'].sort();
    if (!marker || Object.keys(marker).sort().join(',') !== keys.join(',')
      || marker.version !== 2 || marker.kind !== 'HeptaDurableCutoverExternalEnrollment'
      || marker.databasePath !== targetPath
      || keys.filter((key) => key !== 'version').some((key) => typeof marker[key] !== 'string')) {
      fail('external_enrollment_invalid');
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (artifactPresent(`${legacyJournalPath}${suffix}`)) fail('mixed_enrollment');
    }
    const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const markerHash = hash(markerBytes);
    if ((expectedStorageRoot !== null && expectedStorageRoot !== marker.storageRoot)
      || (expectedEnrollmentHash !== null && expectedEnrollmentHash !== markerHash)) {
      fail('storage_expectation_mismatch');
    }
    const parent = path.dirname(targetPath);
    const contains = (a, b) => a === b || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
    if (!path.isAbsolute(marker.storageRoot) || path.resolve(marker.storageRoot) !== marker.storageRoot
      || contains(parent, marker.storageRoot) || contains(marker.storageRoot, parent)) fail('external_root_invalid');
    const slot = createHash('sha256').update(JSON.stringify([
      'HeptaDurableCutoverExternalStorageV2', targetPath, marker.databaseIdentity,
    ])).digest('hex');
    if (slot !== marker.storageSlot) fail('external_enrollment_invalid');
    const slotPath = path.join(marker.storageRoot, slot);
    const selectedJournal = path.join(slotPath, 'journal.sqlite');
    const current = (pin) => {
      if (fs.realpathSync(pin.path) !== pin.path) fail('enrollment_identity_changed');
      const observed = [fs.lstatSync(pin.path, { bigint: true })];
      if (pin.fd !== null) observed.push(fs.fstatSync(pin.fd, { bigint: true }));
      for (const stat of observed) {
        if (identity(stat) !== identity(pin.initial) || stat.mode !== pin.initial.mode
          || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o022n) !== 0n
          || (pin.directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail('enrollment_identity_changed');
      }
    };
    const pins = [];
    const pin = (file, directory, mode, sqlite = false) => {
      if (fs.realpathSync(file) !== file) fail('enrollment_identity_changed');
      // SQLite retains its database handles. Closing an auxiliary raw fd can
      // release another same-process connection's POSIX advisory locks.
      const fd = sqlite ? null : fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        | (directory ? fs.constants.O_DIRECTORY : 0));
      const observed = { path: file, fd, directory, initial: fd === null ? fs.lstatSync(file, { bigint: true }) : fs.fstatSync(fd, { bigint: true }) };
      pins.push(observed);
      try {
        current(observed);
        if (mode !== null && (observed.initial.mode & 0o7777n) !== mode) fail('enrollment_identity_changed');
      } catch (error) { pins.pop(); if (fd !== null) fs.closeSync(fd); throw error; }
      return observed;
    };
    if (!external) {
      try {
        const target = pin(targetPath, false, null, true);
        const root = pin(marker.storageRoot, true, 0o700n);
        const directory = pin(slotPath, true, 0o700n);
        const selectedMarker = pin(markerPath, false, 0o600n);
        const journal = pin(selectedJournal, false, 0o600n, true);
        if (identity(target.initial) !== marker.databaseIdentity || identity(root.initial) !== marker.storageRootIdentity
          || identity(directory.initial) !== marker.storageSlotIdentity || identity(journal.initial) !== marker.journalIdentity
          || identity(selectedMarker.initial) !== marker.markerIdentity
          || (journalIdentity !== null && journalIdentity !== identity(journal.initial))
          || (targetIdentity !== null && targetIdentity !== identity(target.initial))
          || (markerIdentity !== null && markerIdentity !== identity(selectedMarker.initial))) fail('enrollment_identity_changed');
        external = { pins, marker: selectedMarker, markerHash, journalPath: selectedJournal };
      } catch (error) {
        for (const observed of pins) if (observed.fd !== null) fs.closeSync(observed.fd);
        throw error;
      }
    }
    for (const observed of external.pins) current(observed);
    const size = fs.fstatSync(external.marker.fd, { bigint: true }).size;
    if (size > 16_384n) fail('enrollment_marker_invalid');
    const heldBytes = Buffer.alloc(Number(size));
    if (fs.readSync(external.marker.fd, heldBytes, 0, heldBytes.length, 0) !== heldBytes.length
      || hash(heldBytes) !== external.markerHash || markerHash !== external.markerHash
      || selectedJournal !== external.journalPath) fail('enrollment_identity_changed');
    current(external.marker);
    journalPath = selectedJournal;
    if (!database) {
      database = new DatabaseSync(journalPath, { readOnly: false });
      database.exec(`PRAGMA busy_timeout=${Math.min(30_000, Math.max(1, Number(busyTimeoutMs) || 10_000))}; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;`);
    }
    for (const observed of external.pins) current(observed);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${journalPath}${suffix}`;
      if (artifactPresent(sidecar)) {
        // Opening then closing SHM here would release this process's POSIX
        // SQLite locks even while its BEGIN IMMEDIATE transaction is active.
        const stat = fs.lstatSync(sidecar, { bigint: true });
        if (fs.realpathSync(sidecar) !== sidecar || !stat.isFile() || stat.nlink !== 1n
          || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o7777n) !== 0o600n) fail('enrollment_identity_changed');
      }
    }
    assertExternalSchema(database);
    return true;
  }

  function observe() {
    if (closed) fail('fence_closed');
    if (!enrolled && !artifactPresent(journalPath) && !artifactPresent(markerPath)) {
      if (expectedStorageRoot !== null || expectedEnrollmentHash !== null) fail('storage_expectation_mismatch');
      return false;
    }
    enrolled = true;
    if (artifactPresent(markerPath)) {
      let bytes; let candidate;
      try {
        const stat = fs.lstatSync(markerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) fail('enrollment_marker_invalid');
        bytes = fs.readFileSync(markerPath);
        candidate = JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        const wrapped = new Error('rust_cutover_enrollment_unavailable'); wrapped.cause = error; throw wrapped;
      }
      if (candidate.version === 2 || external) return externalObserve(candidate, bytes);
    }
    if (expectedStorageRoot !== null || expectedEnrollmentHash !== null) fail('storage_expectation_mismatch');
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
      if (external) for (const pin of external.pins) if (pin.fd !== null) fs.closeSync(pin.fd);
      closed = true;
    },
  });
}

function assertExternalSchema(database) {
  const expected = [
    ['table', 'hepta_cutover_journal', 'hepta_cutover_journal', 'CREATE TABLE hepta_cutover_journal(revision INTEGER PRIMARY KEY, event TEXT NOT NULL,\n  evidence_json TEXT NOT NULL, state_json TEXT NOT NULL, previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL)'],
    ['table', 'hepta_cutover_state', 'hepta_cutover_state', 'CREATE TABLE hepta_cutover_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state_json TEXT NOT NULL)'],
    ['trigger', 'hepta_cutover_no_journal_delete', 'hepta_cutover_journal', "CREATE TRIGGER hepta_cutover_no_journal_delete BEFORE DELETE ON hepta_cutover_journal\nBEGIN SELECT RAISE(ABORT, 'cutover_journal_append_only'); END"],
    ['trigger', 'hepta_cutover_no_journal_update', 'hepta_cutover_journal', "CREATE TRIGGER hepta_cutover_no_journal_update BEFORE UPDATE ON hepta_cutover_journal\nBEGIN SELECT RAISE(ABORT, 'cutover_journal_append_only'); END"],
  ];
  const rows = database.prepare("SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all()
    .map((row) => [row.type, row.name, row.tbl_name, row.sql]);
  if (JSON.stringify(rows) !== JSON.stringify(expected)) fail('journal_schema_invalid');
}
