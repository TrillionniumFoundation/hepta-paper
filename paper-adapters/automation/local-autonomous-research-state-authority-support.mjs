export const LOCAL_STATE_AUTHORITY_SHA256 = /^sha256:[0-9a-f]{64}$/;
export const LOCAL_STATE_AUTHORITY_SAFE_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;

export function failLocalStateAuthority(code) {
  throw new Error(code);
}

export function localStateAuthorityTimestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function localStateAuthoritySortedUniqueIds(values) {
  return Array.isArray(values)
    && values.every((value) => LOCAL_STATE_AUTHORITY_SAFE_ID.test(String(value || '')))
    && values.every((value, index) => index === 0 || values[index - 1] < value);
}

export function parseLocalStateAuthorityRecord(value, code) {
  try {
    const record = JSON.parse(String(value || ''));
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      failLocalStateAuthority(code);
    }
    return record;
  } catch {
    failLocalStateAuthority(code);
  }
}

export function runLocalStateAuthorityTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = operation();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

export function readLocalStateAuthorityMetadata(database) {
  return database.prepare('SELECT * FROM authority_metadata WHERE singleton=1').get();
}

export function readLocalStateAuthorityDatabaseHeads(database) {
  return database.prepare(`
SELECT database_role,database_instance_id,sequence,hash,schema_hash,state_hash
FROM authority_database_head ORDER BY database_instance_id;
`).all().map((row) => Object.freeze({
    databaseRole: row.database_role,
    databaseInstanceId: row.database_instance_id,
    sequence: Number(row.sequence),
    hash: row.hash,
    schemaHash: row.schema_hash,
    stateHash: row.state_hash,
  }));
}

export function localStateAuthorityNow(clock) {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    failLocalStateAuthority('local_state_authority_clock_invalid');
  }
  return now.toISOString();
}

export function localStateAuthorityExpiry(issuedAt, durationMs) {
  return new Date(Date.parse(issuedAt) + durationMs).toISOString();
}
