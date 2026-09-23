export function assertStorePort(store) {
  for (const method of ['query', 'execute']) {
    if (typeof store?.[method] !== 'function') throw new Error(`StorePort.${method} is required`);
  }
  return store;
}

// StorePort.query has one unambiguous outcome shape: successful reads return
// rows (including [] for a legitimate no-row result); operational failures
// throw. Adapters that accept non-SQLite StorePort implementations can use
// this guard to prevent legacy `{ ok: false, rows: [] }` results from being
// mistaken for an empty query result.
export function assertStoreQueryResult(result) {
  if (!result?.ok) {
    throw new Error(result?.error || result?.stderr || 'store_query_failed');
  }
  if (!Array.isArray(result.rows)) throw new Error('StorePort.query rows are required');
  return result;
}

export function failClosedStoreQueries(store) {
  const ownedStore = assertStorePort(store);
  const guardedStore = Object.create(ownedStore);
  Object.defineProperty(guardedStore, 'query', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: (sql, parameters = []) => assertStoreQueryResult(ownedStore.query(sql, parameters)),
  });
  return Object.freeze(guardedStore);
}

export function assertParameterizedStorePort(store) {
  assertStorePort(store);
  if (Number(store?.version || 0) < 3) throw new Error('ParameterizedStorePort.version 3 is required');
  return store;
}

export function sqlEscape(value) {
  return String(value ?? '').replace(/'/g, "''");
}

export function sqlText(value) {
  return `'${sqlEscape(value)}'`;
}

export function sqlJson(value) {
  return sqlText(JSON.stringify(value ?? null));
}
