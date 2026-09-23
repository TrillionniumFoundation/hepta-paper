const TABLE_HEADER = 0x54; // 'T': SQLite session changeset table header.
const INSERT = 0x12;
const UPDATE = 0x17;
const DELETE = 0x09;
const MAX_CHANGESET_BYTES = 16 * 1024 * 1024;
const MAX_TABLES = 1024;
const MAX_COLUMNS = 4096;
const MAX_CHANGES = 1_000_000;
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function fail(code) { throw new Error(code); }

function byteAt(bytes, cursor) {
  if (cursor.offset >= bytes.length) fail('sqlite_changeset_truncated');
  return bytes[cursor.offset++];
}

function varint(bytes, cursor) {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    const byte = byteAt(bytes, cursor);
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('sqlite_changeset_varint_overflow');
      return Number(value);
    }
  }
  value = (value << 8n) | BigInt(byteAt(bytes, cursor));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('sqlite_changeset_varint_overflow');
  return Number(value);
}

function skip(bytes, cursor, length) {
  if (!Number.isSafeInteger(length) || length < 0 || cursor.offset + length > bytes.length) {
    fail('sqlite_changeset_truncated');
  }
  cursor.offset += length;
}

function skipValue(bytes, cursor) {
  const type = byteAt(bytes, cursor);
  if (type === 0 || type === 5) return;
  if (type === 1 || type === 2) {
    skip(bytes, cursor, 8);
    return;
  }
  if (type === 3 || type === 4) {
    const length = varint(bytes, cursor);
    if (length > MAX_CHANGESET_BYTES) fail('sqlite_changeset_value_too_large');
    skip(bytes, cursor, length);
    return;
  }
  fail('sqlite_changeset_value_type_invalid');
}

function skipRecord(bytes, cursor, columns) {
  for (let index = 0; index < columns; index += 1) skipValue(bytes, cursor);
}

function operationName(operation) {
  if (operation === INSERT) return 'INSERT';
  if (operation === UPDATE) return 'UPDATE';
  if (operation === DELETE) return 'DELETE';
  fail('sqlite_changeset_operation_invalid');
}

function readTable(bytes, cursor) {
  const start = cursor.offset;
  while (cursor.offset < bytes.length && bytes[cursor.offset] !== 0) cursor.offset += 1;
  if (cursor.offset >= bytes.length) fail('sqlite_changeset_table_name_unterminated');
  let table;
  try { table = UTF8.decode(bytes.subarray(start, cursor.offset)); }
  catch { fail('sqlite_changeset_table_name_invalid_utf8'); }
  cursor.offset += 1;
  if (!SAFE_TABLE.test(table)) fail('sqlite_changeset_table_name_invalid');
  return table;
}

/**
 * Parse the stable SQLite session changeset wire format without applying it.
 * Patchsets, indirect changes, malformed values and unbounded records fail closed.
 */
export function inspectSqliteChangesetEffects(input) {
  let bytes;
  try { bytes = Buffer.from(input); }
  catch { fail('sqlite_changeset_input_invalid'); }
  if (bytes.length > MAX_CHANGESET_BYTES) fail('sqlite_changeset_too_large');
  if (bytes.length === 0) return Object.freeze([]);

  const cursor = { offset: 0 };
  const effects = [];
  let tableCount = 0;
  let changeCount = 0;

  while (cursor.offset < bytes.length) {
    if (byteAt(bytes, cursor) !== TABLE_HEADER) fail('sqlite_changeset_header_invalid');
    tableCount += 1;
    if (tableCount > MAX_TABLES) fail('sqlite_changeset_table_limit_exceeded');
    const columns = varint(bytes, cursor);
    if (!Number.isSafeInteger(columns) || columns < 1 || columns > MAX_COLUMNS) {
      fail('sqlite_changeset_column_count_invalid');
    }
    const primaryKey = [];
    for (let index = 0; index < columns; index += 1) {
      const order = byteAt(bytes, cursor);
      if (order > columns) fail('sqlite_changeset_primary_key_invalid');
      primaryKey.push(order);
    }
    const primaryKeyOrder = primaryKey.filter((order) => order !== 0).sort((a, b) => a - b);
    if (primaryKeyOrder.length === 0
      || new Set(primaryKeyOrder).size !== primaryKeyOrder.length
      || primaryKeyOrder.some((order, index) => order !== index + 1)) {
      fail('sqlite_changeset_primary_key_required');
    }
    const table = readTable(bytes, cursor);

    while (cursor.offset < bytes.length && bytes[cursor.offset] !== TABLE_HEADER) {
      const operation = byteAt(bytes, cursor);
      const indirect = byteAt(bytes, cursor);
      if (indirect !== 0) fail('sqlite_changeset_indirect_change_forbidden');
      const operationNameValue = operationName(operation);
      if (operation === UPDATE) {
        skipRecord(bytes, cursor, columns);
        skipRecord(bytes, cursor, columns);
      } else {
        skipRecord(bytes, cursor, columns);
      }
      changeCount += 1;
      if (changeCount > MAX_CHANGES) fail('sqlite_changeset_change_limit_exceeded');
      effects.push(Object.freeze({ table, operation: operationNameValue }));
    }
  }

  if (cursor.offset !== bytes.length) fail('sqlite_changeset_trailing_bytes');
  return Object.freeze(effects);
}

function effectKey(effect) {
  const table = String(effect?.table || '');
  const operation = String(effect?.operation || '').toUpperCase();
  if (!SAFE_TABLE.test(table) || !['INSERT', 'UPDATE', 'DELETE'].includes(operation)) {
    fail('sqlite_changeset_authorization_effect_invalid');
  }
  return `${table}\0${operation}`;
}

/**
 * Prove every actual table/operation pair is both present in the signed plan and
 * reachable through a successfully invoked statement on the restricted surface.
 */
export function assertSqliteChangesetEffectsAuthorized({
  changeset,
  authorizedEffects = [],
  executedEffects = [],
} = {}) {
  if (!Array.isArray(authorizedEffects) || !Array.isArray(executedEffects)) {
    fail('sqlite_changeset_authorization_input_invalid');
  }
  const authorized = new Set(authorizedEffects.map(effectKey));
  const executed = new Set(executedEffects.map(effectKey));
  const actual = inspectSqliteChangesetEffects(changeset);
  for (const effect of actual) {
    const key = effectKey(effect);
    if (!authorized.has(key) || !executed.has(key)) {
      fail('externally_fenced_sqlite_mutation_changeset_not_authorized');
    }
  }
  return Object.freeze({
    effects: actual,
    effectCount: actual.length,
    tableOperationKeys: Object.freeze([...new Set(actual.map(effectKey))].sort()),
  });
}
