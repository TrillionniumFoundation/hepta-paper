import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertAutonomousResearchStateDatabaseManifest,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseManifestHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin, toPosixPath } from '../../workflow-kernel/runtime/file-utils.mjs';
import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';

function fileIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('autonomous_research_state_database_file_unsafe');
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

function sameFileIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertNoSymlinkComponents(runtimeRoot, candidate) {
  const relative = path.relative(runtimeRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('autonomous_research_state_database_path_outside_runtime');
  }
  let current = runtimeRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('autonomous_research_state_database_symlink_forbidden');
    }
  }
  const physicalRuntime = fs.realpathSync(runtimeRoot);
  const physicalCandidate = fs.realpathSync(candidate);
  if (!pathWithin(physicalRuntime, physicalCandidate)) {
    throw new Error('autonomous_research_state_database_physical_path_outside_runtime');
  }
}

function queryAll(database, sql) {
  return database.prepare(sql).all();
}

function inspectSqliteDatabase(sourcePath) {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const quickRows = queryAll(database, 'PRAGMA quick_check;');
    const foreignKeyRows = queryAll(database, 'PRAGMA foreign_key_check;');
    const schemaRows = queryAll(database, `
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`);
    const userVersion = Number(queryAll(database, 'PRAGMA user_version;')[0]?.user_version || 0);
    const applicationId = Number(queryAll(database, 'PRAGMA application_id;')[0]?.application_id || 0);
    return Object.freeze({
      quickCheck: String(quickRows[0]?.quick_check || quickRows[0]?.integrity_check || 'unknown'),
      foreignKeyViolationCount: foreignKeyRows.length,
      schemaHash: hashRecord('AutonomousResearchStateDatabaseSchema', schemaRows),
      schemaObjects: Object.freeze(schemaRows.map((row) => `${row.type}:${row.name}`)),
      userVersion,
      applicationId,
    });
  } finally { database.close(); }
}

function walkSqliteFiles(root, blockers, { maximumEntries = 10000 } = {}) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  let visited = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > maximumEntries) throw new Error('autonomous_research_state_database_inventory_limit_exceeded');
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        blockers.push(`autonomous_research_state_database_tree_symlink_forbidden:${toPosixPath(path.relative(root, candidate))}`);
      } else if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.sqlite')) files.push(candidate);
      else if (entry.name.endsWith('.sqlite')) {
        blockers.push(`autonomous_research_state_database_special_file_forbidden:${toPosixPath(path.relative(root, candidate))}`);
      }
    }
  };
  visit(root);
  return files.sort();
}

function topLevelSqliteFiles(runtimeRoot, blockers) {
  const files = [];
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith('.sqlite')) continue;
    const candidate = path.join(runtimeRoot, entry.name);
    if (entry.isSymbolicLink()) {
      blockers.push(`autonomous_research_state_database_tree_symlink_forbidden:${entry.name}`);
    } else if (entry.isFile()) files.push(candidate);
    else blockers.push(`autonomous_research_state_database_special_file_forbidden:${entry.name}`);
  }
  return files.sort();
}

function matchPerPaperPath(pattern, relativePath) {
  const [prefix, suffix] = pattern.split('{paperId}');
  if (!relativePath.startsWith(prefix) || !relativePath.endsWith(suffix)) return null;
  const paperId = relativePath.slice(prefix.length, relativePath.length - suffix.length);
  return paperId && !paperId.includes('/') ? paperId : null;
}

function candidateRows(runtimeRoot, manifest, blockers) {
  const rows = [];
  const recognized = new Set();
  for (const definition of manifest.databases.filter((entry) => entry.cardinality === 'singleton')) {
    const sourcePath = path.resolve(runtimeRoot, definition.relativePath);
    if (!pathWithin(runtimeRoot, sourcePath)) {
      blockers.push(`autonomous_research_state_database_manifest_path_outside_runtime:${definition.role}`);
    } else if (!fs.existsSync(sourcePath)) {
      blockers.push(`autonomous_research_state_database_required_missing:${definition.role}`);
    } else {
      rows.push({ definition, sourcePath, paperId: null });
      recognized.add(sourcePath);
    }
  }
  for (const exclusion of manifest.excludedDatabases) {
    const excludedPath = path.resolve(runtimeRoot, exclusion.relativePath);
    recognized.add(excludedPath);
    if (!fs.existsSync(excludedPath)) continue;
    const stat = fs.lstatSync(excludedPath);
    if (!pathWithin(runtimeRoot, excludedPath)
      || stat.isSymbolicLink()
      || !stat.isFile()
      || stat.size !== exclusion.requiredBytes) {
      blockers.push(`autonomous_research_state_database_exclusion_invalid:${exclusion.relativePath}`);
    }
  }
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith('.sqlite')) continue;
    const sourcePath = path.join(runtimeRoot, entry.name);
    if (!recognized.has(sourcePath)) {
      blockers.push(`autonomous_research_state_database_unregistered:${entry.name}`);
    }
  }
  const autonomousRoot = path.join(runtimeRoot, 'autonomous-research');
  const autonomousSqlite = walkSqliteFiles(autonomousRoot, blockers);
  const activeStateSqlite = [
    ...topLevelSqliteFiles(runtimeRoot, blockers),
    ...autonomousSqlite,
  ];
  for (const definition of manifest.databases.filter((entry) => entry.cardinality === 'per-paper')) {
    let count = 0;
    for (const sourcePath of autonomousSqlite) {
      const relativePath = toPosixPath(path.relative(runtimeRoot, sourcePath));
      const paperId = matchPerPaperPath(definition.relativePathPattern, relativePath);
      if (!paperId) continue;
      rows.push({ definition, sourcePath, paperId });
      recognized.add(sourcePath);
      count += 1;
    }
    if (count < definition.minimumInstances) {
      blockers.push(`autonomous_research_state_database_required_missing:${definition.role}`);
    }
  }
  for (const exclusion of manifest.excludedDatabases) {
    const excludedPath = path.resolve(runtimeRoot, exclusion.relativePath);
    recognized.add(excludedPath);
    if (!fs.existsSync(excludedPath)) continue;
    try {
      assertNoSymlinkComponents(runtimeRoot, excludedPath);
      const stat = fs.lstatSync(excludedPath);
      if (!stat.isFile() || stat.isSymbolicLink()
        || stat.size !== exclusion.requiredBytes
        || fs.existsSync(`${excludedPath}-wal`)
        || fs.existsSync(`${excludedPath}-shm`)) {
        throw new Error('retired_placeholder_not_empty');
      }
    } catch (error) {
      blockers.push(`autonomous_research_state_database_exclusion_invalid:${exclusion.relativePath}:${error.message}`);
    }
  }
  if (manifest.unknownAutonomousResearchSqlitePolicy === 'block') {
    for (const sourcePath of activeStateSqlite) {
      if (!recognized.has(sourcePath)) {
        blockers.push(`autonomous_research_state_database_unregistered:${toPosixPath(path.relative(runtimeRoot, sourcePath))}`);
      }
    }
  }
  return rows.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function inspectCandidate(runtimeRoot, row) {
  assertNoSymlinkComponents(runtimeRoot, row.sourcePath);
  const sourceRelativePath = toPosixPath(path.relative(runtimeRoot, row.sourcePath));
  const walPath = `${row.sourcePath}-wal`;
  const sourceFileIdentity = fileIdentity(row.sourcePath);
  const walPresent = fs.existsSync(walPath);
  const initialWalFileIdentity = walPresent ? fileIdentity(walPath) : null;
  const inspection = inspectSqliteDatabase(row.sourcePath);
  const observedSchemaObjects = new Set(inspection.schemaObjects);
  const missingSchemaObjects = row.definition.requiredSchemaObjects
    .filter((schemaObject) => !observedSchemaObjects.has(schemaObject));
  const sourceSha256 = fileSha256HashSync(row.sourcePath);
  if (!sameFileIdentity(sourceFileIdentity, fileIdentity(row.sourcePath))) {
    throw new Error('autonomous_research_state_database_changed_during_inspection:source');
  }
  const walPresentAfterInspection = fs.existsSync(walPath);
  let walFileIdentity = walPresentAfterInspection ? fileIdentity(walPath) : null;
  if (walPresent !== walPresentAfterInspection) {
    const cleanReaderSideEffect = !walPresent && walPresentAfterInspection
      && walFileIdentity.bytes === '0';
    const cleanWalRemoved = walPresent && !walPresentAfterInspection
      && initialWalFileIdentity.bytes === '0';
    if (!cleanReaderSideEffect && !cleanWalRemoved) {
      throw new Error('autonomous_research_state_database_changed_during_inspection:wal_presence');
    }
  }
  if (walPresent && walPresentAfterInspection
    && !sameFileIdentity(initialWalFileIdentity, walFileIdentity)) {
    throw new Error('autonomous_research_state_database_changed_during_inspection:wal');
  }
  const walSha256 = walFileIdentity ? fileSha256HashSync(walPath) : null;
  if (walFileIdentity && !sameFileIdentity(walFileIdentity, fileIdentity(walPath))) {
    throw new Error('autonomous_research_state_database_changed_during_inspection:wal');
  }
  return Object.freeze({
    instanceId: row.paperId ? `${row.definition.role}:${row.paperId}` : row.definition.role,
    role: row.definition.role,
    paperId: row.paperId,
    sourceRelativePath,
    schemaContractId: row.definition.schemaContractId,
    missingSchemaObjects: Object.freeze(missingSchemaObjects),
    sourceFileIdentity,
    sourceSha256,
    walFileIdentity,
    walSha256,
    ...inspection,
  });
}

export function resolveAutonomousResearchStateDatabaseInventory({ runtimeRoot, manifest } = {}) {
  const resolvedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  if (!runtimeRoot || !fs.existsSync(resolvedRuntimeRoot) || !fs.statSync(resolvedRuntimeRoot).isDirectory()) {
    throw new Error('autonomous_research_state_database_runtime_root_invalid');
  }
  const validatedManifest = assertAutonomousResearchStateDatabaseManifest(manifest);
  const blockers = [];
  const instances = [];
  for (const row of candidateRows(resolvedRuntimeRoot, validatedManifest, blockers)) {
    try {
      const instance = inspectCandidate(resolvedRuntimeRoot, row);
      instances.push(instance);
      if (instance.quickCheck !== 'ok') blockers.push(`autonomous_research_state_database_quick_check_failed:${instance.instanceId}`);
      if (instance.foreignKeyViolationCount !== 0) blockers.push(`autonomous_research_state_database_foreign_key_check_failed:${instance.instanceId}`);
      if (instance.missingSchemaObjects.length !== 0) {
        blockers.push(
          `autonomous_research_state_database_schema_contract_mismatch:${instance.instanceId}:${instance.schemaContractId}:${instance.missingSchemaObjects.join(',')}`,
        );
      }
    } catch (error) {
      blockers.push(`autonomous_research_state_database_inspection_failed:${row.definition.role}:${error.message}`);
    }
  }
  const manifestHash = autonomousResearchStateDatabaseManifestHash(validatedManifest);
  const databaseScopeHash = instances.length
    ? autonomousResearchStateDatabaseScopeHash(instances)
    : null;
  const base = {
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: blockers.length
      ? 'autonomous_research_state_database_inventory_blocked'
      : 'autonomous_research_state_database_inventory_ready',
    manifestId: validatedManifest.manifestId,
    manifestHash,
    databaseScopeHash,
    instances: Object.freeze(instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId))),
    blockers: Object.freeze([...new Set(blockers)].sort()),
  };
  return Object.freeze({
    ...base,
    inventoryHash: blockers.length ? null : autonomousResearchStateDatabaseInventoryHash(base),
  });
}

export function resolveAutonomousSubmissionHandoffStateDatabaseInventory({
  runtimeRoot,
  manifest,
} = {}) {
  const resolvedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  if (!runtimeRoot || !fs.existsSync(resolvedRuntimeRoot)
    || !fs.statSync(resolvedRuntimeRoot).isDirectory()) {
    throw new Error('autonomous_submission_handoff_state_database_runtime_root_invalid');
  }
  const validatedManifest = assertAutonomousResearchStateDatabaseManifest(manifest);
  const definition = validatedManifest.databases.find((entry) => (
    entry.role === 'submission-handoff' && entry.cardinality === 'singleton'
  ));
  if (!definition) {
    throw new Error('autonomous_submission_handoff_state_database_manifest_invalid');
  }
  const blockers = [];
  const sourcePath = path.resolve(resolvedRuntimeRoot, definition.relativePath);
  const handoffDirectory = path.dirname(sourcePath);
  if (!pathWithin(resolvedRuntimeRoot, sourcePath)) {
    blockers.push('autonomous_submission_handoff_state_database_path_outside_runtime');
  } else if (!fs.existsSync(sourcePath)) {
    blockers.push('autonomous_submission_handoff_state_database_required_missing');
  }
  if (fs.existsSync(handoffDirectory)) {
    for (const candidate of walkSqliteFiles(handoffDirectory, blockers)) {
      if (path.resolve(candidate) !== sourcePath) {
        blockers.push(`autonomous_submission_handoff_state_database_unregistered:${
          toPosixPath(path.relative(resolvedRuntimeRoot, candidate))
        }`);
      }
    }
  }
  const instances = [];
  if (fs.existsSync(sourcePath)) {
    try {
      const instance = inspectCandidate(resolvedRuntimeRoot, {
        definition,
        sourcePath,
        paperId: null,
      });
      instances.push(instance);
      if (instance.quickCheck !== 'ok') {
        blockers.push('autonomous_submission_handoff_state_database_quick_check_failed');
      }
      if (instance.foreignKeyViolationCount !== 0) {
        blockers.push('autonomous_submission_handoff_state_database_foreign_key_check_failed');
      }
      if (instance.missingSchemaObjects.length !== 0) {
        blockers.push(`autonomous_submission_handoff_state_database_schema_contract_mismatch:${
          instance.missingSchemaObjects.join(',')
        }`);
      }
    } catch (error) {
      blockers.push(`autonomous_submission_handoff_state_database_inspection_failed:${error.message}`);
    }
  }
  const manifestHash = hashRecord(
    'AutonomousSubmissionHandoffStateDatabaseManifestProjection',
    {
      sourceManifestHash: autonomousResearchStateDatabaseManifestHash(validatedManifest),
      database: definition,
    },
  );
  const databaseScopeHash = instances.length
    ? autonomousResearchStateDatabaseScopeHash(instances)
    : null;
  const base = {
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: blockers.length
      ? 'autonomous_research_state_database_inventory_blocked'
      : 'autonomous_research_state_database_inventory_ready',
    manifestId: `${validatedManifest.manifestId}:submission-handoff`,
    manifestHash,
    databaseScopeHash,
    instances: Object.freeze(instances),
    blockers: Object.freeze([...new Set(blockers)].sort()),
  };
  return Object.freeze({
    ...base,
    inventoryHash: blockers.length ? null : autonomousResearchStateDatabaseInventoryHash(base),
  });
}

export { inspectSqliteDatabase };
