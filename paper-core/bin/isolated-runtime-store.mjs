import fs from 'node:fs';
import { createDefaultPaperStore } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';

function sqliteSidecars(dbPath) {
  return [`${dbPath}-wal`, `${dbPath}-shm`].filter((candidate) => fs.existsSync(candidate));
}

export function prepareIsolatedRuntimeStore({ root, runtimeRoot, dbPath, initialize = null } = {}) {
  const store = createDefaultPaperStore({ root, runtimeRoot, dbPath });
  try {
    initialize?.(store);
    const checkpoint = store.checkpoint({ mode: 'TRUNCATE' });
    if (!checkpoint?.ok) {
      throw new Error(checkpoint?.error || checkpoint?.stderr || 'isolated_runtime_checkpoint_failed');
    }
  } finally {
    store.close();
  }
  const sidecars = sqliteSidecars(dbPath);
  if (sidecars.length) throw new Error(`isolated_runtime_active_wal_present:${sidecars.join(',')}`);
  return Object.freeze({ dbPath, checkpointMode: 'TRUNCATE', connectionClosed: true });
}
