import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalAutonomousResearchOneShotCampaignAttemptJson,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import {
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_EXPECTED_SCHEMA_OBJECTS,
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH,
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID,
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_VERSION,
} from './campaign-one-shot-attempt-journal-schema.mjs';

const MAXIMUM_DATABASE_BYTES = 256 * 1024 * 1024;

function invalid(code, cause = undefined) {
  return new Error(code, cause ? { cause } : undefined);
}

export function currentUid(stat = null) {
  return typeof process.getuid === 'function' ? process.getuid() : stat?.uid;
}

export function pathContains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

export function syncDirectory(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function directoryIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const uid = currentUid(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== Number(uid)
    || (Number(stat.mode) & 0o777) !== 0o700
    || fs.realpathSync(candidate) !== candidate) {
    throw invalid('campaign_one_shot_attempt_control_root_invalid');
  }
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

export function databaseIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const uid = currentUid(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.uid) !== Number(uid)
    || Number(stat.nlink) !== 1 || (Number(stat.mode) & 0o777) !== 0o600
    || Number(stat.size) < 0 || Number(stat.size) > MAXIMUM_DATABASE_BYTES
    || fs.realpathSync(candidate) !== candidate) {
    throw invalid('campaign_one_shot_attempt_journal_file_invalid');
  }
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

export function sameIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

export function lstatIfPresent(candidate, options = undefined) {
  try { return fs.lstatSync(candidate, options); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function ensureNoSqliteSidecars(databasePath) {
  if (['-journal', '-wal', '-shm'].some((suffix) => (
    lstatIfPresent(`${databasePath}${suffix}`) !== null
  ))) {
    throw invalid('campaign_one_shot_attempt_journal_sidecar_forbidden');
  }
}

export function assertRecoverablePrivateSqliteSidecars(databasePath) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const stat = lstatIfPresent(`${databasePath}${suffix}`, { bigint: true });
    if (!stat) continue;
    const uid = currentUid(stat);
    const candidate = `${databasePath}${suffix}`;
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.uid) !== Number(uid)
      || Number(stat.nlink) !== 1 || (Number(stat.mode) & 0o077) !== 0
      || Number(stat.size) < 0 || Number(stat.size) > MAXIMUM_DATABASE_BYTES
      || fs.realpathSync(candidate) !== candidate) {
      throw invalid('campaign_one_shot_attempt_journal_sidecar_invalid');
    }
  }
}

export function canonicalRowJson(source, code) {
  let value;
  try { value = JSON.parse(String(source)); }
  catch { throw invalid(code); }
  if (canonicalAutonomousResearchOneShotCampaignAttemptJson(value) !== source) {
    throw invalid(code);
  }
  return value;
}

export function mustExecute(port, sql, code) {
  const result = port.execute(sql);
  if (!result?.ok) throw invalid(code, new Error(result?.error || code));
  return result;
}

export function mustRun(port, sql, parameters, code) {
  const result = port.run(sql, parameters);
  if (!result?.ok) throw invalid(code, new Error(result?.error || code));
  return result;
}

export function schemaRows(port) {
  return port.query(`SELECT type,name,tbl_name AS tableName,coalesce(sql,'') AS sql
    FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type,name,tbl_name,sql;`).rows.map((row) => Object.freeze({
    type: String(row.type),
    name: String(row.name),
    tableName: String(row.tableName),
    sql: String(row.sql),
  }));
}

export function sqliteSchemaHash(port) {
  return hashRecord('CampaignOneShotAttemptJournalSqliteSchema', schemaRows(port));
}

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertDatabaseIntegrity(port) {
  const quickCheck = port.query('PRAGMA quick_check;').rows;
  const foreignKeyViolations = port.query('PRAGMA foreign_key_check;').rows;
  if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok'
    || foreignKeyViolations.length !== 0) {
    throw invalid('campaign_one_shot_attempt_journal_integrity_invalid');
  }
}

export function assertJournalPragmas(port, { writable = false } = {}) {
  const foreignKeys = Number(port.query('PRAGMA foreign_keys;').rows[0]?.foreign_keys);
  const journalMode = String(port.query('PRAGMA journal_mode;').rows[0]?.journal_mode || '');
  const synchronous = Number(port.query('PRAGMA synchronous;').rows[0]?.synchronous);
  const recursiveTriggers = Number(
    port.query('PRAGMA recursive_triggers;').rows[0]?.recursive_triggers,
  );
  if (foreignKeys !== 1 || journalMode !== 'delete'
    || (writable && (synchronous !== 2 || recursiveTriggers !== 1))) {
    throw invalid('campaign_one_shot_attempt_journal_pragma_invalid');
  }
}

export function assertSchema(port) {
  const observedObjects = schemaRows(port);
  const identities = observedObjects.map((entry) => `${entry.type}:${entry.name}`).sort();
  if (stableStringify(identities)
    !== stableStringify(CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_EXPECTED_SCHEMA_OBJECTS)) {
    throw invalid('campaign_one_shot_attempt_journal_schema_invalid');
  }
  const metadata = port.query(`SELECT schema_version,schema_contract_id,
    schema_contract_hash,sqlite_schema_hash,created_at
    FROM campaign_one_shot_attempt_journal_metadata WHERE singleton=1;`).rows;
  if (metadata.length !== 1
    || Number(metadata[0].schema_version)
      !== CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_VERSION
    || metadata[0].schema_contract_id
      !== CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID
    || metadata[0].schema_contract_hash
      !== CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH
    || metadata[0].sqlite_schema_hash !== sqliteSchemaHash(port)
    || !canonicalInstant(metadata[0].created_at)) {
    throw invalid('campaign_one_shot_attempt_journal_schema_invalid');
  }
  assertDatabaseIntegrity(port);
}
