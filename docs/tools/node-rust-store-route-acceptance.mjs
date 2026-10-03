// Real incumbent migration produces the seed databases. All writes below are
// fixture preparation only; ordinary status executions get the retained bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TIME = '2026-10-01T00:00:00.000Z';
const HANDOFF = 'autonomous-research/submission-handoff/submission-handoff.sqlite';
let baseline;
const liveWAL = new Map();
export function closeStoreStatusFixtureV1(fixture) { liveWAL.get(fixture)?.close(); liveWAL.delete(fixture); }
const quote = value => `"${value.replaceAll('"', '""')}"`;
function sql(file, statement) {
  const db = new DatabaseSync(file);
  try { db.exec(statement); } finally { db.close(); }
}
function seed(environment) {
  if (baseline) return baseline;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-status-seed-'));
  const runtime = path.join(directory, 'runtime');
  for (const name of ['runtime', 'assets', 'legacy']) fs.mkdirSync(path.join(directory, name));
  const loader = path.join(directory, 'clock.mjs');
  fs.writeFileSync(loader, `import crypto from 'node:crypto';\nconst DateOwner=Date;\nglobalThis.Date=class extends DateOwner { constructor(...args) { super(...(args.length?args:[${JSON.stringify(TIME)}])); } static now() {return DateOwner.parse(${JSON.stringify(TIME)});} };\ncrypto.randomUUID=()=> 'ddc3f123-3ef9-4ef3-b91b-48990febd36a';\n`);
  try {
    const output = spawnSync(process.execPath, ['--import', loader, path.join(ROOT, 'paper-core/bin/hepta-store.mjs'), 'migrate'],
      { cwd: ROOT, env: { ...environment, HEPTA_PAPER_ASSET_ROOT: path.join(directory, 'assets'),
        HEPTA_PAPER_RUNTIME_ROOT: runtime, PAPER_FACTORY_LEGACY_ROOT: path.join(directory, 'legacy') },
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    if (output.status !== 0) throw new Error(`store_acceptance_real_node_migration_failed:${output.stderr}`);
    const database = path.join(runtime, 'hepta-paper.sqlite');
    const db = new DatabaseSync(database);
    try {
      // SQLite CURRENT_TIMESTAMP is independent of Date. Normalize every
      // populated timestamp column before capturing a reproducible seed.
      for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        for (const column of db.prepare(`PRAGMA table_info(${quote(name)})`).all()) {
          if (/(?:_at|_time)$/.test(column.name)) db.prepare(`UPDATE ${quote(name)} SET ${quote(column.name)}=? WHERE ${quote(column.name)} IS NOT NULL AND ${quote(column.name)}<>?`).run(TIME, TIME);
        }
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;');
    } finally { db.close(); }
    baseline = { database: fs.readFileSync(database), handoff: fs.readFileSync(path.join(runtime, HANDOFF)) };
    return baseline;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
export const STORE_STATUS_PROFILES_V1 = Object.freeze([
  'ready', 'handoff-missing', 'verification-contamination', 'production-runtime-contamination',
  'production-release-contamination', 'all-terminal-qualifications', 'nonterminal-qualification',
  'metadata-and-job-data', 'metadata-blob', 'metadata-null-key', 'metadata-invalid-utf8', 'schema-24', 'schema-large-safe',
  'schema-number-unsafe', 'schema-text-number', 'schema-text-infinity', 'schema-text-invalid', 'schema-blob-number', 'main-missing', 'main-corrupt', 'main-required-table-missing',
  'handoff-text-versions', 'handoff-blob-versions', 'date-numeric-real', 'date-text-decimal', 'date-blob-number', 'handoff-migration-missing', 'handoff-migration-name', 'handoff-migration-hash', 'handoff-migration-date',
  'handoff-v2-table-missing', 'handoff-v2-table-conflict', 'handoff-instance-missing', 'handoff-instance-nonce',
  'handoff-instance-date', 'handoff-cutover-missing', 'native-cutover-missing', 'handoff-prepared',
  'handoff-identity-mismatch', 'runtime-world-writable', 'handoff-directory-world-writable',
  'handoff-file-other-readable', 'handoff-file-hardlink', 'handoff-file-symlink',
  'relative-runtime', 'empty-runtime', 'utf8-runtime', 'main-alias', 'live-wal', 'closed-wal', 'runtime-symlink',
  'date-only', 'date-space-seconds', 'date-offset-fraction', 'date-rollover', 'date-rfc', 'date-legacy-numeric',
  'date-max-instant', 'date-outside-range', 'date-local-timeclip', 'date-partial-calendar', 'handoff-blob-identity',
]);
const receipt = (id, environment, evidenceClass) => `INSERT INTO receipt_ledger(receipt_id,stream,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class) VALUES('${id}','fixture','PassiveClassification','observed','{}','sha256:fixture','${TIME}','${environment}','${evidenceClass}');`;
export function storeStatusFixtureV1(fixture, profile, environment) {
  const runtime = path.join(fixture, profile === 'utf8-runtime' ? '运行空间' : 'runtime');
  const assets = path.join(fixture, 'assets'), legacy = path.join(fixture, 'legacy');
  for (const directory of [runtime, assets, legacy, path.join(runtime, 'autonomous-research'), path.join(runtime, 'autonomous-research/submission-handoff')]) fs.mkdirSync(directory, { mode: 0o750 });
  const database = path.join(runtime, 'hepta-paper.sqlite'), handoff = path.join(runtime, HANDOFF);
  const source = seed(environment);
  fs.writeFileSync(database, source.database, { mode: 0o660 }); fs.writeFileSync(handoff, source.handoff, { mode: 0o660 });
  if (profile === 'handoff-missing') fs.unlinkSync(handoff);
  if (profile === 'verification-contamination') sql(database, receipt('verification', 'verification', 'technical_conformance'));
  if (profile === 'production-runtime-contamination') sql(database, receipt('runtime', 'production', 'runtime_unclassified'));
  if (profile === 'production-release-contamination') sql(database, receipt('release', 'production', 'release_conformance_with_operational_binding'));
  if (['all-terminal-qualifications', 'nonterminal-qualification'].includes(profile)) {
    const dispositions = profile === 'all-terminal-qualifications' ? ['administrative_exported', 'invalid', 'superseded', 'retention_tombstone'] : ['not-terminal'];
    // Controlled diagnostic rows carry no trusted signatures or authority.
    sql(database, 'DROP TRIGGER receipt_qualification_validate_insert;');
    for (const [index, disposition] of dispositions.entries()) {
      const id = `qualified-${index}`;
      sql(database, (profile === 'nonterminal-qualification' ? 'PRAGMA ignore_check_constraints=ON;' : '') + receipt(id, 'production', 'runtime_unclassified') + `INSERT INTO receipt_ledger_qualifications(qualification_id,receipt_id,disposition,reason,qualification_json,qualification_sha256,issuer_policy_id,created_at) VALUES('q-${index}','${id}','${disposition}','fixture','{}','sha256:fixture','fixture','${TIME}');`);
    }
  }
  if (profile === 'metadata-and-job-data') sql(database, `INSERT INTO store_metadata(key,value,updated_at) VALUES('参数','value with \\ and ? # %','${TIME}'); INSERT INTO jobs(job_id,deduplication_key,kind,status,spec_json,created_at,updated_at,environment,evidence_class) VALUES('job-fixture','dedup-fixture','FixtureJob','queued','{}','${TIME}','${TIME}','verification','technical_conformance');`);
  if (profile === 'metadata-null-key') sql(database, `INSERT INTO store_metadata(key,value,updated_at) VALUES(NULL,'null primary key diagnostic','${TIME}');`);
  if (profile === 'metadata-blob') sql(database, `INSERT INTO store_metadata(key,value,updated_at) VALUES('bytes',X'000180FF','${TIME}');`);
  if (profile === 'metadata-invalid-utf8') sql(database, `INSERT INTO store_metadata(key,value,updated_at) VALUES('utf8',CAST(X'80FF' AS TEXT),'${TIME}');`);
  if (profile === 'schema-24') sql(database, 'DELETE FROM schema_migrations WHERE version=25;');
  if (profile === 'schema-large-safe') sql(database, `INSERT INTO schema_migrations(version,name,applied_at,migration_sha256) VALUES(4294967296,'fixture','${TIME}','sha256:fixture');`);
  if (profile === 'schema-number-unsafe') sql(database, `INSERT INTO schema_migrations(version,name,applied_at,migration_sha256) VALUES(9007199254740992,'fixture','${TIME}','sha256:fixture');`);
  const versions = { 'schema-text-number': "'0x19'", 'schema-text-infinity': "'Infinity'", 'schema-text-invalid': "'not-a-number'", 'schema-blob-number': "X'19'" };
  if (versions[profile]) sql(database, `DROP TABLE schema_migrations; CREATE TABLE schema_migrations(version); INSERT INTO schema_migrations VALUES(${versions[profile]});`);
  if (profile === 'main-missing') fs.unlinkSync(database);
  if (profile === 'main-corrupt') fs.writeFileSync(database, 'not a database');
  if (profile === 'main-required-table-missing') sql(database, 'DROP TABLE venues;');
  if (['handoff-text-versions', 'handoff-blob-versions'].includes(profile)) {
    const version = profile === 'handoff-text-versions' ? "'0x'||version" : "CASE version WHEN 1 THEN X'01' ELSE X'02' END";
    sql(handoff, `CREATE TEMP TABLE old_migrations AS SELECT * FROM handoff_schema_migrations; DROP TABLE handoff_schema_migrations; CREATE TABLE handoff_schema_migrations(version,name,migration_sha256,applied_at); INSERT INTO handoff_schema_migrations SELECT ${version},name,migration_sha256,applied_at FROM old_migrations; DROP TABLE old_migrations;`);
  }
  if (profile === 'date-numeric-real') sql(handoff, 'CREATE TEMP TABLE old_migrations AS SELECT * FROM handoff_schema_migrations; DROP TABLE handoff_schema_migrations; CREATE TABLE handoff_schema_migrations(version,name,migration_sha256,applied_at); INSERT INTO handoff_schema_migrations SELECT version,name,migration_sha256,1.0 FROM old_migrations; DROP TABLE old_migrations;');
  if (profile === 'date-text-decimal') sql(handoff, "UPDATE handoff_schema_migrations SET applied_at='1.0';");
  if (profile === 'date-blob-number') sql(handoff, "UPDATE handoff_schema_migrations SET applied_at=X'01';");
  if (profile === 'handoff-migration-missing') sql(handoff, 'DELETE FROM handoff_schema_migrations WHERE version=2;');
  if (profile === 'handoff-migration-name') sql(handoff, "UPDATE handoff_schema_migrations SET name='changed' WHERE version=2;");
  if (profile === 'handoff-migration-hash') sql(handoff, "UPDATE handoff_schema_migrations SET migration_sha256='changed' WHERE version=2;");
  if (profile === 'handoff-migration-date') sql(handoff, "UPDATE handoff_schema_migrations SET applied_at='not-a-date' WHERE version=2;");
  if (profile === 'handoff-v2-table-missing') sql(handoff, 'DROP TABLE submission_authorization_consumptions;');
  if (profile === 'handoff-v2-table-conflict') sql(handoff, 'DROP TABLE submission_authorization_consumptions; CREATE TABLE submission_authorization_consumptions(nonce TEXT PRIMARY KEY);');
  if (profile === 'handoff-instance-missing') sql(handoff, 'DROP TRIGGER handoff_instance_no_delete; DELETE FROM handoff_instance;');
  if (profile === 'handoff-instance-nonce') sql(handoff, "DROP TRIGGER handoff_instance_no_update; UPDATE handoff_instance SET instance_nonce='invalid';");
  if (profile === 'handoff-instance-date') sql(handoff, "DROP TRIGGER handoff_instance_no_update; UPDATE handoff_instance SET provisioned_at='invalid';");
  if (profile === 'handoff-cutover-missing') sql(handoff, 'DELETE FROM handoff_cutover;');
  if (profile === 'native-cutover-missing') sql(database, 'DROP TRIGGER autonomous_submission_handoff_cutover_immutable_delete; DELETE FROM autonomous_submission_handoff_cutover;');
  if (profile === 'handoff-prepared') sql(handoff, "UPDATE handoff_cutover SET status='prepared';");
  if (profile === 'handoff-identity-mismatch') sql(handoff, "UPDATE handoff_cutover SET native_cutover_identity_hash='changed';");
  if (profile === 'runtime-world-writable') fs.chmodSync(runtime, 0o777);
  if (profile === 'handoff-directory-world-writable') fs.chmodSync(path.dirname(handoff), 0o777);
  if (profile === 'handoff-file-other-readable') fs.chmodSync(handoff, 0o664);
  if (profile === 'handoff-file-hardlink') fs.linkSync(handoff, path.join(fixture, 'handoff-copy.sqlite'));
  if (profile === 'handoff-file-symlink') { fs.renameSync(handoff, `${handoff}.real`); fs.symlinkSync(`${path.basename(handoff)}.real`, handoff); }
  if (profile === 'handoff-blob-identity') {sql(database, "DROP TRIGGER autonomous_submission_handoff_cutover_immutable_update; UPDATE autonomous_submission_handoff_cutover SET handoff_database_identity_hash=X'0102';");sql(handoff,"UPDATE handoff_cutover SET native_cutover_identity_hash=X'0102';");}
  const dates = { 'date-only': '2026-10-01', 'date-space-seconds': '2026-10-01 01:02:03', 'date-offset-fraction': '2026-10-01T01:02:03.123456+02:30', 'date-rollover': '2026-02-30T00:00:00Z', 'date-rfc': 'Thu, 01 Oct 2026 00:00:00 GMT', 'date-legacy-numeric': '10/1/2026', 'date-max-instant': '+275760-09-13T00:00:00.000Z', 'date-outside-range': '+275760-09-13T00:00:00.001Z', 'date-local-timeclip': '+275760-09-13T00:00:00.001', 'date-partial-calendar': '2026T01:02' };
  if (dates[profile]) { const db = new DatabaseSync(handoff); try {db.prepare('UPDATE handoff_schema_migrations SET applied_at=?').run(dates[profile]);} finally {db.close();} }
  if (profile === 'closed-wal') sql(database, 'PRAGMA journal_mode=WAL;');
  if (profile === 'live-wal') {const writer = new DatabaseSync(database); writer.exec('PRAGMA journal_mode=WAL;'); writer.exec(receipt('wal-result', 'verification', 'technical_conformance')); liveWAL.set(fixture, writer);}
  let selectedRuntime = runtime;
  if (profile === 'relative-runtime') selectedRuntime = path.relative(ROOT, runtime);
  if (profile === 'empty-runtime') {
    const fallback = path.join(path.dirname(ROOT), 'hepta-paper-runtime/native-runtime/hepta-paper.sqlite');
    if (fs.existsSync(fallback)) throw new Error('store_acceptance_default_input_not_isolated');
    selectedRuntime = '';
  }
  if (profile === 'runtime-symlink') {selectedRuntime = path.join(fixture, 'runtime-alias'); fs.symlinkSync(path.basename(runtime), selectedRuntime);}
  if (profile === 'main-alias') { const original = `${database}.real`; fs.renameSync(database, original); fs.symlinkSync(path.basename(original), database); }
  return { cwd: ROOT, environment: { NODE_OPTIONS: '--disable-warning=ExperimentalWarning', HEPTA_PAPER_ASSET_ROOT: assets, HEPTA_PAPER_RUNTIME_ROOT: selectedRuntime, PAPER_FACTORY_LEGACY_ROOT: legacy },
    node: ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'paper-core/bin/hepta-paper.mjs'), 'operator', 'store'] };
}
export function expectedStoreStatusV1(testCase, result) {
  if (['main-missing', 'empty-runtime', 'main-corrupt', 'main-required-table-missing', 'schema-number-unsafe'].includes(testCase.profile)) return result.outcome === 'refusal' && result.exitCode === 1;
  const allowed = testCase.argv.includes('--allow-isolated-verification-evidence');
  const ready = ['ready', 'closed-wal', 'all-terminal-qualifications', 'metadata-and-job-data', 'metadata-blob', 'metadata-null-key', 'metadata-invalid-utf8', 'schema-large-safe', 'schema-text-number', 'schema-text-infinity', 'handoff-text-versions', 'handoff-blob-versions', 'date-numeric-real', 'date-blob-number', 'relative-runtime', 'utf8-runtime', 'main-alias', 'date-only', 'date-space-seconds', 'date-offset-fraction', 'date-rollover', 'date-rfc', 'date-legacy-numeric', 'date-max-instant', 'date-partial-calendar'].includes(testCase.profile)
    || ['verification-contamination', 'live-wal'].includes(testCase.profile) && allowed
    || testCase.profile === 'date-local-timeclip' && Number.isFinite(Date.parse('+275760-09-13T00:00:00.001'));
  return result.outcome === 'report' && result.exitCode === (testCase.argv.includes('--require-trust-clean') && !ready ? 2 : 0)
    && result.stdout.version === 3 && result.stdout.kind === 'HeptaNativeStoreStatus'
    && result.stdout.ready === ready && result.stdout.status === (ready ? 'hepta_native_store_ready' : 'hepta_native_store_blocked')
    && result.stdout.legacyDefaultDependency === false;
}

// SQLite's public WAL index is volatile coordination, not product result data.
// Format/checksum owner: https://www.sqlite.org/walformat.html and src/wal.c.
const walHash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const coordinationByteRanges = Object.freeze([[8, 12], [40, 48], [56, 60], [88, 96], [104, 108], [128, 132]].map(Object.freeze));
const orderedPhysical = value => Array.isArray(value) ? value.map(orderedPhysical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedPhysical(value[key])])) : value;
const samePhysical = (left, right) => JSON.stringify(orderedPhysical(left)) === JSON.stringify(orderedPhysical(right));
export function assertStoreWalReadCoordinationClaimV1(proof) {
  if (!proof || proof.kind !== 'SQLiteColdWalReadCoordinationV1'
    || !['node', 'native'].includes(proof.firstReader)
    || !Number.isSafeInteger(proof.frameCount) || proof.frameCount < 1 || proof.frameCount >= 4062
    || ['formatAndAllChecksumsVerified', 'shmIdentityPermissionsAndLengthUnchanged',
      'headerRebuiltWithoutProductWrite', 'databaseWalAndOtherPathsUnchanged'].some(key => proof[key] !== true)
    || JSON.stringify(proof.allowedByteRanges) !== JSON.stringify(coordinationByteRanges)) {
    throw new Error('route_acceptance_cold_wal_claim_invalid');
  }
  try {
    const physical = proof.physicalObservations, before = physical.before;
    if (!Array.isArray(physical.byteChanges) || physical.byteChanges.length === 0) throw new Error();
    for (const state of [physical.afterNode, physical.afterNative]) {
      if (state.walSha256 !== before.walSha256 || !samePhysical(state.walIdentity, before.walIdentity)
        || !samePhysical(state.walTimes, before.walTimes) || !samePhysical(state.identity, before.identity)
        || BigInt(state.times.mtimeNs) < BigInt(before.times.mtimeNs)
        || BigInt(state.times.ctimeNs) < BigInt(before.times.ctimeNs)) throw new Error();
    }
    if (before.identity.size !== '32768' || before.identity.nlink !== '1' || before.walIdentity.nlink !== '1'
      || physical.afterNode.shmSha256 !== physical.afterNative.shmSha256) throw new Error();
    let last = -1;
    for (const byte of physical.byteChanges) {
      if (byte.offset <= last || !coordinationByteRanges.some(([start, end]) => byte.offset >= start && byte.offset < end)
        || byte.before === byte.afterNode || byte.afterNode !== byte.afterNative) throw new Error();
      last = byte.offset;
    }
    for (const [start, from, to] of [[8, 1, 0], [56, 1, 0], [104, 0, proof.frameCount], [128, 0, proof.frameCount]]) {
      for (let index = 0; index < 4; index++) {
        const previous = from >>> (8 * index) & 255, next = to >>> (8 * index) & 255;
        const byte = physical.byteChanges.find(value => value.offset === start + index);
        if (previous === next ? byte !== undefined : !byte || byte.before !== previous || byte.afterNode !== next) throw new Error();
      }
    }
  } catch { throw new Error('route_acceptance_cold_wal_claim_invalid'); }
  // This rejects internally inconsistent diagnostics. The held-file checks and
  // an independent ordinary CLI replay remain required for acceptance.
}

function check(value, code) { if (!value) throw new Error(`store_acceptance_wal_${code}`); }
function checksum(bytes, little, initial = [0, 0]) {
  check(bytes.length % 8 === 0, 'checksum_alignment');
  let [a, b] = initial;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    a = (a + (little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)) + b) >>> 0;
    b = (b + (little ? bytes.readUInt32LE(offset + 4) : bytes.readUInt32BE(offset + 4)) + a) >>> 0;
  }
  return [a, b];
}
function walFormat(bytes) {
  check(bytes.length >= 32, 'header_missing');
  const magic = bytes.readUInt32BE(0), page = bytes.readUInt32BE(8);
  check([0x377f0682, 0x377f0683].includes(magic) && bytes.readUInt32BE(4) === 3007000
    && page >= 512 && page <= 65536 && (page & (page - 1)) === 0, 'header_invalid');
  const little = magic === 0x377f0682;
  let sum = checksum(bytes.subarray(0, 24), little);
  check(sum[0] === bytes.readUInt32BE(24) && sum[1] === bytes.readUInt32BE(28), 'header_checksum');
  check((bytes.length - 32) % (page + 24) === 0, 'frame_length');
  const frames = (bytes.length - 32) / (page + 24), normalized = Buffer.from(bytes);
  check(frames > 0 && frames < 4062, 'fixture_frame_range');
  normalized.fill(0, 16, 32);
  let lastPages = 0;
  for (let frame = 0; frame < frames; frame++) {
    const offset = 32 + frame * (page + 24), head = bytes.subarray(offset, offset + 24);
    check(head.readUInt32BE(0) > 0 && head.subarray(8, 16).equals(bytes.subarray(16, 24)), 'frame_salt');
    sum = checksum(head.subarray(0, 8), little, sum);
    sum = checksum(bytes.subarray(offset + 24, offset + 24 + page), little, sum);
    check(sum[0] === head.readUInt32BE(16) && sum[1] === head.readUInt32BE(20), 'frame_checksum');
    normalized.fill(0, offset + 8, offset + 24);
    lastPages = head.readUInt32BE(4);
  }
  check(lastPages > 0, 'last_frame_uncommitted');
  return { magic, page, frames, lastPages, sum, normalized };
}
function shmFormat(bytes, wal, rawWal) {
  check(os.endianness() === 'LE' && bytes.length === 32768, 'fixture_shm_host_format');
  check(bytes.subarray(0, 48).equals(bytes.subarray(48, 96)), 'shm_header_copies');
  check(bytes.readUInt32LE(0) === 3007000 && bytes.readUInt32LE(4) === 0 && bytes[12] === 1
    && bytes[13] === (wal.magic & 1) && bytes.readUInt16LE(14) === (wal.page === 65536 ? 1 : wal.page)
    && bytes.readUInt32LE(16) === wal.frames && bytes.readUInt32LE(20) === wal.lastPages
    && bytes.readUInt32LE(24) === wal.sum[0] && bytes.readUInt32LE(28) === wal.sum[1]
    && bytes.subarray(32, 40).equals(rawWal.subarray(16, 24)), 'shm_header_binding');
  const sum = checksum(bytes.subarray(0, 40), true);
  check(bytes.readUInt32LE(40) === sum[0] && bytes.readUInt32LE(44) === sum[1], 'shm_checksum');
  check(bytes.readUInt32LE(96) === 0 && bytes.readUInt32LE(100) === 0
    && [108, 112, 116].every(offset => bytes.readUInt32LE(offset) === 0xffffffff)
    && bytes.subarray(120, 128).every(byte => byte === 0) && bytes.readUInt32LE(132) === 0,
  'fixture_checkpoint_or_lock_changed');
  return { generation: bytes.readUInt32LE(8), readMark: bytes.readUInt32LE(104),
    attempted: bytes.readUInt32LE(128) };
}
function normalizeShm(bytes, input) {
  const normalized = Buffer.from(bytes);
  for (const start of [0, 48]) {
    normalized.fill(0, start + 8, start + 12);
    normalized.fill(0, start + 40, start + 48);
    if (input) normalized.fill(0, start + 24, start + 40);
  }
  normalized.fill(0, 104, 108); normalized.fill(0, 128, 132);
  return normalized;
}
function heldWalFile(fixture, relative, limit, minimum = 1) {
  const file = path.join(fixture, relative);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    check(before.isFile() && before.nlink === 1n && before.size >= BigInt(minimum) && before.size <= BigInt(limit), 'held_file');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    check(fields.every(key => before[key] === after[key] && before[key] === named[key]), 'held_named_identity_changed');
    return { bytes, identity: Object.fromEntries(fields.slice(0, 7).map(key => [key, String(before[key])])),
      times: { mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) } };
  } finally { fs.closeSync(descriptor); }
}
export function observeStoreWalFilesV1(fixture) {
  const walPath = 'runtime/hepta-paper.sqlite-wal', shmPath = 'runtime/hepta-paper.sqlite-shm';
  const walFile = heldWalFile(fixture, walPath, 256 * 1024 * 1024), shmFile = heldWalFile(fixture, shmPath, 32768);
  const walBytes = walFile.bytes, shmBytes = shmFile.bytes;
  const format = walFormat(walBytes), header = shmFormat(shmBytes, format, walBytes);
  check(shmFile.identity.size === '32768', 'shm_identity');
  return { walPath, shmPath, walBytes, shmBytes, format, header,
    walSha256: walHash(walBytes), shmSha256: walHash(shmBytes),
    identity: shmFile.identity, times: shmFile.times, walIdentity: walFile.identity, walTimes: walFile.times,
    inputWal: format.normalized, inputShm: normalizeShm(shmBytes, true),
    effectShm: normalizeShm(shmBytes, false) };
}
export function storeWalContentV1(state, relative, purpose) {
  if (relative === state.walPath && purpose === 'input') return state.inputWal;
  if (relative === state.shmPath) return purpose === 'input' ? state.inputShm : state.effectShm;
  return null;
}
export function validateStoreWalReadCoordinationV1(before, node, native, first) {
  const states = [before, node, native];
  check(states.every(state => state.walSha256 === before.walSha256
    && JSON.stringify(state.walIdentity) === JSON.stringify(before.walIdentity)
    && JSON.stringify(state.walTimes) === JSON.stringify(before.walTimes)
    && JSON.stringify(state.identity) === JSON.stringify(before.identity)
    && state.effectShm.equals(before.effectShm)), 'durable_or_other_shm_change');
  check(before.header.generation === 1 && before.header.readMark === 0 && before.header.attempted === 0,
    'cold_initial_state');
  check([node, native].every(state => state.header.generation === 0
    && state.header.readMark === before.format.frames && state.header.attempted === before.format.frames),
  'reader_transition');
  check(node.shmBytes.equals(native.shmBytes), 'independent_reader_bytes_disagree');
  const offsets = [];
  for (let offset = 0; offset < before.shmBytes.length; offset++) if (before.shmBytes[offset] !== node.shmBytes[offset]) offsets.push(offset);
  const allowed = offset => [8, 40, 56, 88, 104, 128].some(start => offset >= start && offset < start + (start === 40 || start === 88 ? 8 : 4));
  check(offsets.every(allowed), 'unadmitted_byte_change');
  return { kind: 'SQLiteColdWalReadCoordinationV1', firstReader: first, formatAndAllChecksumsVerified: true,
    shmIdentityPermissionsAndLengthUnchanged: true,
    headerRebuiltWithoutProductWrite: true, frameCount: before.format.frames,
    allowedByteRanges: coordinationByteRanges,
    physicalObservations: { byteChanges: offsets.map(offset => ({offset, before:before.shmBytes[offset], afterNode:node.shmBytes[offset], afterNative:native.shmBytes[offset]})),
      before: { walSha256: before.walSha256, shmSha256: before.shmSha256, identity: before.identity, times: before.times, walIdentity: before.walIdentity, walTimes: before.walTimes },
      afterNode: { walSha256: node.walSha256, shmSha256: node.shmSha256, identity: node.identity, times: node.times, walIdentity: node.walIdentity, walTimes: node.walTimes },
      afterNative: { walSha256: native.walSha256, shmSha256: native.shmSha256, identity: native.identity, times: native.times, walIdentity: native.walIdentity, walTimes: native.walTimes } } };
}

// A closed WAL-mode database can have no WAL/index files. The read-only SQLite
// connection still creates its coordination objects. Validate the complete
// zero-frame index reconstructed by walIndexRecover; no byte range is ignored.
const closedWalPaths = Object.freeze(['runtime/hepta-paper.sqlite-wal', 'runtime/hepta-paper.sqlite-shm']);
function emptyWalIndex() {
  check(os.endianness() === 'LE', 'closed_shm_host_format');
  const bytes = Buffer.alloc(32768);
  bytes.writeUInt32LE(3007000, 0); bytes[12] = 1;
  const sum = checksum(bytes.subarray(0, 40), true);
  bytes.writeUInt32LE(sum[0], 40); bytes.writeUInt32LE(sum[1], 44);
  bytes.copy(bytes, 48, 0, 48);
  for (const offset of [104, 108, 112, 116]) bytes.writeUInt32LE(0xffffffff, offset);
  return bytes;
}
function heldDirectory(fixture, relative) {
  const file = path.join(fixture, relative);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const names = fs.readdirSync(file).sort();
    const after = fs.fstatSync(descriptor, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    check(before.isDirectory() && fields.every(key => before[key] === after[key] && before[key] === named[key]), 'closed_parent_changed_during_observation');
    return { identity: Object.fromEntries(fields.slice(0, 6).map(key => [key, String(before[key])])),
      size: String(before.size), times: { mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) }, names };
  } finally { fs.closeSync(descriptor); }
}
function existsNamed(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function observeStoreClosedWalFilesV1(fixture, { allowIncomplete = false } = {}) {
  const database = heldWalFile(fixture, 'runtime/hepta-paper.sqlite', 256 * 1024 * 1024);
  check(database.bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))
    && database.bytes[18] === 2 && database.bytes[19] === 2, 'closed_database_wal_header');
  const expected = emptyWalIndex();
  const files = closedWalPaths.map((relative, index) => {
    if (!existsNamed(path.join(fixture, relative))) return null;
    const observed = heldWalFile(fixture, relative, index === 0 ? 0 : 32768, 0);
    check(observed.identity.uid === database.identity.uid && observed.identity.gid === database.identity.gid
      && observed.identity.mode === database.identity.mode, 'closed_created_ownership_or_mode');
    if (index === 0) check(observed.bytes.length === 0, 'closed_wal_not_empty');
    else if (allowIncomplete) {
      check([0, 32768].includes(observed.bytes.length)
        && [...observed.bytes].every((byte, offset) => byte === 0 || byte === expected[offset]), 'closed_interrupted_shm_bytes');
    } else check(observed.bytes.equals(expected), 'closed_zero_frame_shm_bytes');
    return { ...observed, sha256: walHash(observed.bytes) };
  });
  if (!allowIncomplete) check(files.every(Boolean) || files.every(value => value === null), 'closed_partial_objects');
  return { kind: 'SQLiteClosedWalPhysicalObservationV1', databaseSha256: walHash(database.bytes),
    databaseIdentity: database.identity, databaseTimes: database.times, parent: heldDirectory(fixture, 'runtime'),
    files, coordinationPaths: closedWalPaths, parentPath: 'runtime', expectedShmSha256: walHash(expected) };
}
export function validateStoreClosedWalReadCoordinationV1(before, stages, first) {
  check(before.files.every(value => value === null), 'closed_initial_objects_present');
  const final = stages.at(-1).state;
  check(final.files.every(Boolean), 'closed_final_objects_missing');
  const firstCreated = [null, null];
  for (const { state } of stages) {
    check(state.databaseSha256 === before.databaseSha256
      && JSON.stringify(state.databaseIdentity) === JSON.stringify(before.databaseIdentity)
      && JSON.stringify(state.databaseTimes) === JSON.stringify(before.databaseTimes), 'closed_database_changed');
    check(JSON.stringify(state.parent.identity) === JSON.stringify(before.parent.identity), 'closed_parent_identity_permissions_changed');
    const expectedNames = [...before.parent.names,
      ...state.files.flatMap((file, index) => file ? [path.basename(closedWalPaths[index])] : [])].sort();
    check(JSON.stringify(state.parent.names) === JSON.stringify(expectedNames), 'closed_other_namespace_changed');
    for (const key of ['mtimeNs', 'ctimeNs']) check(BigInt(state.parent.times[key]) >= BigInt(before.parent.times[key]), 'closed_parent_time_regressed');
    for (const [index, file] of state.files.entries()) if (file) {
      if (!firstCreated[index]) firstCreated[index] = file;
      const original = firstCreated[index];
      check(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'].every(key => original.identity[key] === file.identity[key]), 'closed_created_identity_changed');
      if (index === 0) check(JSON.stringify(original) === JSON.stringify(file), 'closed_empty_wal_changed');
    }
  }
  const finalWal = final.files[0], finalShm = final.files[1];
  check(finalWal.identity.size === '0' && finalShm.identity.size === '32768'
    && finalShm.sha256 === before.expectedShmSha256, 'closed_final_shape');
  const diagnostics = state => ({ databaseSha256: state.databaseSha256, databaseIdentity: state.databaseIdentity,
    databaseTimes: state.databaseTimes, parent: state.parent,
    files: state.files.map((file, index) => file ? { path: closedWalPaths[index], identity: file.identity,
      times: file.times, sha256: file.sha256 } : null) });
  return { kind: 'SQLiteClosedWalReadCoordinationV1', firstReader: first, frameCount: 0,
    initialCoordinationAbsent: true, databaseWalHeaderVerified: true,
    exactEmptyWalAndZeroFrameShmVerified: true, createdOwnershipPermissionsAndIdentityVerified: true,
    parentNamespaceOnlyValidatedCoordinationCreated: true, reusedCreatedFileIdentityUnchanged: true,
    createdFilePaths: closedWalPaths, emptyWalSha256: finalWal.sha256, zeroFrameShmSha256: finalShm.sha256,
    physicalObservations: { before: diagnostics(before), stages: stages.map(({ reader, phase, state }) => ({ reader, phase, ...diagnostics(state) })) } };
}
export function assertStoreClosedWalReadCoordinationClaimV1(proof) {
  if (!proof || proof.kind !== 'SQLiteClosedWalReadCoordinationV1' || !['node', 'native'].includes(proof.firstReader)
    || proof.frameCount !== 0 || JSON.stringify(proof.createdFilePaths) !== JSON.stringify(closedWalPaths)
    || proof.emptyWalSha256 !== walHash(Buffer.alloc(0)) || proof.zeroFrameShmSha256 !== walHash(emptyWalIndex())
    || ['initialCoordinationAbsent', 'databaseWalHeaderVerified', 'exactEmptyWalAndZeroFrameShmVerified',
      'createdOwnershipPermissionsAndIdentityVerified', 'parentNamespaceOnlyValidatedCoordinationCreated',
      'reusedCreatedFileIdentityUnchanged', 'databaseAndOtherPathsUnchanged'].some(key => proof[key] !== true)) {
    throw new Error('route_acceptance_closed_wal_claim_invalid');
  }
  try {
    const { before, stages } = proof.physicalObservations;
    if (!Array.isArray(before.files) || before.files.length !== 2 || !before.files.every(file => file === null)
      || !Array.isArray(stages) || ![2, 4].includes(stages.length)) throw new Error();
    const other = proof.firstReader === 'node' ? 'native' : 'node';
    const expected = stages.length === 2 ? [[proof.firstReader, 'complete'], [other, 'complete']]
      : [[proof.firstReader, 'interrupted'], [other, 'interrupted'], [proof.firstReader, 'retry'], [other, 'retry']];
    if (!samePhysical(stages.map(stage => [stage.reader, stage.phase]), expected)
      || before.databaseIdentity.nlink !== '1'
      || (BigInt(before.databaseIdentity.mode) & 0o170000n) !== 0o100000n
      || (BigInt(before.parent.identity.mode) & 0o170000n) !== 0o040000n) throw new Error();
    const created = [null, null];
    let priorParent = before.parent;
    for (const state of stages) {
      if (state.databaseSha256 !== before.databaseSha256 || !samePhysical(state.databaseIdentity, before.databaseIdentity)
        || !samePhysical(state.databaseTimes, before.databaseTimes) || !samePhysical(state.parent.identity, before.parent.identity)
        || !Array.isArray(state.files) || state.files.length !== 2) throw new Error();
      const names = [...before.parent.names, ...state.files.flatMap((file, index) => file ? [path.basename(closedWalPaths[index])] : [])].sort();
      if (!samePhysical(state.parent.names, names)) throw new Error();
      for (const key of ['mtimeNs', 'ctimeNs']) if (BigInt(state.parent.times[key]) < BigInt(priorParent.times[key])) throw new Error();
      priorParent = state.parent;
      for (const [index, file] of state.files.entries()) {
        if (!file) { if (created[index] || state.phase !== 'interrupted') throw new Error(); continue; }
        if (file.path !== closedWalPaths[index] || file.identity.nlink !== '1'
          || ['uid', 'gid', 'mode'].some(key => file.identity[key] !== before.databaseIdentity[key])) throw new Error();
        if (created[index] && ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'].some(key => file.identity[key] !== created[index].identity[key])) throw new Error();
        if (index === 0) {
          if (file.identity.size !== '0' || file.sha256 !== proof.emptyWalSha256
            || created[index] && !samePhysical(file, created[index])) throw new Error();
        } else if (state.phase === 'interrupted') {
          if (!['0', '32768'].includes(file.identity.size)
            || file.identity.size === '0' && file.sha256 !== proof.emptyWalSha256) throw new Error();
        } else if (file.identity.size !== '32768' || file.sha256 !== proof.zeroFrameShmSha256) throw new Error();
        created[index] ||= file;
      }
    }
  } catch { throw new Error('route_acceptance_closed_wal_claim_invalid'); }
}
