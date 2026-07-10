import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSqliteStore } from '../../../paper-adapters/persistence/sqlite-store.mjs';
import { applyStoreMigrations } from '../../../paper-adapters/persistence/store-provider.mjs';

export async function temporaryDirectory(t, prefix = 'hepta-capability-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

export function temporaryStore(root) {
  return applyStoreMigrations(createSqliteStore({ dbPath: path.join(root, 'store.sqlite') }));
}

export function fixedClock(iso = '2026-07-10T08:00:00.000Z') {
  return { now: () => new Date(iso), nowIso: () => iso };
}
