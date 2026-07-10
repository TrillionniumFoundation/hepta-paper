export function assertStorePort(store) {
  for (const method of ['query', 'execute']) {
    if (typeof store?.[method] !== 'function') throw new Error(`StorePort.${method} is required`);
  }
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

