import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';

function fileIdentity(candidate, { databaseRole = null } = {}) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const mode = Number(stat.mode);
  const groupWritePermitted = databaseRole === 'submission-handoff';
  if (!stat.isFile() || stat.isSymbolicLink() || mode & 0o002
    || (!groupWritePermitted && mode & 0o020)) {
    throw new Error('autonomous_research_state_reconciliation_database_unsafe');
  }
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    links: String(stat.nlink),
    bytes: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
  });
}

export function openAutonomousResearchStateReconciliationDatabase({
  runtimeRoot,
  instance,
} = {}) {
  const root = path.resolve(String(runtimeRoot || ''));
  const candidate = path.resolve(root, String(instance?.sourceRelativePath || ''));
  if (!runtimeRoot
    || !instance?.sourceRelativePath
    || !pathWithin(root, candidate)
    || !fs.existsSync(candidate)
    || !pathWithin(fs.realpathSync(root), fs.realpathSync(candidate))
    || JSON.stringify(fileIdentity(candidate, { databaseRole: instance.role }))
      !== JSON.stringify(instance.sourceFileIdentity)) {
    throw new Error('autonomous_research_state_reconciliation_database_identity_changed');
  }
  return new DatabaseSync(candidate);
}

export function inspectAutonomousResearchStatePendingFinalizations({
  database,
  databaseRole,
  databaseInstanceId,
} = {}) {
  if (!database || database.isTransaction || typeof database.prepare !== 'function') {
    throw new Error('autonomous_research_state_pending_finalization_inspection_invalid');
  }
  const pendingFinalizationCount = Number(database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL;
`).get()?.count);
  if (!Number.isSafeInteger(pendingFinalizationCount)
    || pendingFinalizationCount < 0) {
    throw new Error('autonomous_research_state_pending_finalization_inspection_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStatePendingFinalizationInspection',
    databaseRole,
    databaseInstanceId,
    pendingFinalizationCount,
  });
}
