import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseManifestHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_HASH,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from './autonomous-research-online-authority-journal.mjs';
import {
  inspectSqliteDatabase,
  resolveAutonomousResearchStateDatabaseInventory,
} from './autonomous-research-state-database-inventory.mjs';

const TARGET_SCHEMA_NAME = /\bCREATE\s+(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

export function schemaTransitionNow(clock) {
  const value = clock?.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail('autonomous_research_online_schema_transition_clock_invalid');
  }
  return date;
}

function exactSchemaRows(database) {
  return database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
}

export function schemaTransitionExactSchemaHash(database) {
  return hashRecord('AutonomousResearchStateDatabaseSchema', exactSchemaRows(database));
}

function schemaObjectsForStatements(statements) {
  const database = new DatabaseSync(':memory:');
  try {
    for (const statement of statements) database.exec(statement);
    return new Map(exactSchemaRows(database).map((row) => [row.name, row]));
  } finally { database.close(); }
}

const MARKER_SCHEMA_OBJECTS = schemaObjectsForStatements(
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
);
const JOURNAL_SCHEMA_OBJECTS = schemaObjectsForStatements(
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
);
const ONLINE_TARGET_OBJECT_NAMES = new Set([
  ...MARKER_SCHEMA_OBJECTS.keys(), ...JOURNAL_SCHEMA_OBJECTS.keys(),
]);

export function schemaTransitionTargetSchema(instance) {
  const resident = instance.role === 'resident-instance';
  return Object.freeze({
    statements: Object.freeze([
      ...AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
      ...(resident ? AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS : []),
    ]),
    objects: new Map([
      ...MARKER_SCHEMA_OBJECTS,
      ...(resident ? JOURNAL_SCHEMA_OBJECTS : []),
    ]),
  });
}

export function schemaTransitionFileIdentity(candidate, { databaseRole = null } = {}) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const mode = Number(stat.mode);
  const groupWritePermitted = databaseRole === 'submission-handoff';
  if (!stat.isFile() || stat.isSymbolicLink() || mode & 0o002
    || (!groupWritePermitted && mode & 0o020)) {
    fail('autonomous_research_online_schema_transition_database_unsafe', {
      databasePath: candidate,
      databaseMode: Number(stat.mode & 0o777n),
    });
  }
  return Object.freeze({
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    links: String(stat.nlink), bytes: String(stat.size), modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
  });
}

export function schemaTransitionSameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function schemaTransitionDatabasePath(runtimeRoot, instance) {
  const root = path.resolve(runtimeRoot);
  const candidate = path.resolve(root, String(instance?.sourceRelativePath || ''));
  if (!instance?.sourceRelativePath
    || !pathWithin(root, candidate)
    || !fs.existsSync(candidate)
    || !pathWithin(fs.realpathSync(root), fs.realpathSync(candidate))) {
    fail('autonomous_research_online_schema_transition_database_path_invalid');
  }
  schemaTransitionFileIdentity(candidate, { databaseRole: instance.role });
  return candidate;
}

export function assertSchemaTransitionNoSidecars(candidate) {
  if (fs.existsSync(`${candidate}-wal`) || fs.existsSync(`${candidate}-shm`)) {
    fail('autonomous_research_online_schema_transition_wal_or_shm_present', {
      databasePath: candidate,
    });
  }
}

export function assertSchemaTransitionTargetObjects(database, target) {
  const actual = new Map(exactSchemaRows(database).map((row) => [row.name, row]));
  for (const [name, expected] of target.objects) {
    const observed = actual.get(name);
    if (observed && JSON.stringify(observed) !== JSON.stringify(expected)) {
      fail('autonomous_research_online_schema_transition_target_schema_conflict', {
        schemaObject: name,
      });
    }
  }
}

export function applySchemaTransitionStatements(database, target) {
  for (const statement of target.statements) {
    const name = TARGET_SCHEMA_NAME.exec(statement)?.[1];
    if (!name) fail('autonomous_research_online_schema_transition_statement_invalid');
    const exists = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema WHERE name=?;
`).get(name);
    if (!exists) database.exec(statement);
  }
  assertSchemaTransitionTargetObjects(database, target);
}

function expectedPostSchemaHash({ candidate, instance }) {
  const beforeIdentity = schemaTransitionFileIdentity(candidate, {
    databaseRole: instance.role,
  });
  const beforeSha256 = fileSha256HashSync(candidate);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-schema-transition-'));
  const temporaryDatabasePath = path.join(temporaryRoot, 'candidate.sqlite');
  try {
    fs.copyFileSync(candidate, temporaryDatabasePath, fs.constants.COPYFILE_EXCL);
    if (!schemaTransitionSameIdentity(beforeIdentity, schemaTransitionFileIdentity(candidate, {
      databaseRole: instance.role,
    }))
      || beforeSha256 !== fileSha256HashSync(candidate)) {
      fail('autonomous_research_online_schema_transition_database_changed_during_simulation');
    }
    const database = new DatabaseSync(temporaryDatabasePath);
    try {
      const target = schemaTransitionTargetSchema(instance);
      assertSchemaTransitionTargetObjects(database, target);
      database.exec('BEGIN IMMEDIATE;');
      try {
        applySchemaTransitionStatements(database, target);
        database.exec('COMMIT;');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK;');
        throw error;
      }
      const inspection = inspectSqliteDatabase(temporaryDatabasePath);
      if (inspection.quickCheck !== 'ok' || inspection.foreignKeyViolationCount !== 0) {
        fail('autonomous_research_online_schema_transition_simulated_schema_invalid');
      }
      return inspection.schemaHash;
    } finally { database.close(); }
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
}

export function autonomousResearchOnlineSchemaTransitionBundleHash() {
  return hashRecord('AutonomousResearchOnlineSchemaTransitionBundle', {
    authorityJournalSchemaContractId:
      AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
    authorityJournalSchemaHash: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
    markerSchemaHash: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_HASH,
    authorityJournalStatements: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
    markerStatements: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
  });
}

function allowedInventoryBlocker(blocker, instancesById) {
  const prefix = 'autonomous_research_state_database_schema_contract_mismatch:';
  if (!String(blocker).startsWith(prefix)) return false;
  const instance = [...instancesById.values()].find((candidate) => (
    String(blocker).startsWith(
      `${prefix}${candidate.instanceId}:${candidate.schemaContractId}:`,
    )
  ));
  return Boolean(instance && instance.missingSchemaObjects.length > 0
    && instance.missingSchemaObjects.every((entry) => (
      ONLINE_TARGET_OBJECT_NAMES.has(entry.slice(entry.indexOf(':') + 1))
    )));
}

export function validateAutonomousResearchOnlineSchemaTransitionInventory({
  runtimeRoot,
  inventory,
  stateDatabaseManifest,
}) {
  const roles = [...new Set(inventory.instances.map((entry) => entry.role))].sort();
  const instancesById = new Map(inventory.instances.map((entry) => [entry.instanceId, entry]));
  const definitions = new Map(stateDatabaseManifest.databases.map((entry) => [entry.role, entry]));
  if (!inventory.databaseScopeHash
    || inventory.manifestHash !== autonomousResearchStateDatabaseManifestHash(stateDatabaseManifest)
    || roles.join('\0') !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')
    || inventory.instances.length < AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    || inventory.blockers.some((blocker) => !allowedInventoryBlocker(blocker, instancesById))) {
    fail('autonomous_research_online_schema_transition_inventory_invalid', {
      blockers: inventory.blockers,
    });
  }
  for (const instance of inventory.instances) {
    const definition = definitions.get(instance.role);
    const candidate = schemaTransitionDatabasePath(runtimeRoot, instance);
    assertSchemaTransitionNoSidecars(candidate);
    const businessObjects = definition.requiredSchemaObjects.filter((entry) => (
      !ONLINE_TARGET_OBJECT_NAMES.has(entry.slice(entry.indexOf(':') + 1))
    ));
    if (instance.quickCheck !== 'ok'
      || instance.foreignKeyViolationCount !== 0
      || businessObjects.some((entry) => !instance.schemaObjects.includes(entry))) {
      fail('autonomous_research_online_schema_transition_business_schema_not_preprovisioned', {
        databaseInstanceId: instance.instanceId,
      });
    }
  }
  return inventory;
}

function projectInstance(runtimeRoot, instance) {
  const candidate = schemaTransitionDatabasePath(runtimeRoot, instance);
  const database = new DatabaseSync(candidate, { readOnly: true });
  try { assertSchemaTransitionTargetObjects(database, schemaTransitionTargetSchema(instance)); }
  finally { database.close(); }
  const sourceFileIdentity = schemaTransitionFileIdentity(candidate, {
    databaseRole: instance.role,
  });
  return Object.freeze({
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    sourceRelativePath: instance.sourceRelativePath,
    schemaContractId: instance.schemaContractId,
    preSchemaHash: instance.schemaHash,
    expectedPostSchemaHash: expectedPostSchemaHash({ candidate, instance }),
    sourceSha256: fileSha256HashSync(candidate),
    sourceFileIdentityHash: hashRecord(
      'AutonomousResearchOnlineSchemaTransitionSourceFileIdentity', sourceFileIdentity,
    ),
  });
}

export function buildAutonomousResearchOnlineSchemaTransitionPlan({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  trust,
  clock,
  requestedLeaseMs,
  requiredExecutionWindowMs,
}) {
  const inventory = validateAutonomousResearchOnlineSchemaTransitionInventory({
    runtimeRoot,
    stateDatabaseManifest,
    inventory: resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot,
      manifest: stateDatabaseManifest,
    }),
  });
  const manifestHash = autonomousResearchStateDatabaseManifestHash(stateDatabaseManifest);
  const checkedWriterManifest = assertAutonomousResearchOnlineWriterOperationManifest(
    writerManifest,
  );
  const writerManifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    checkedWriterManifest,
  );
  if (trust.databaseScopeHash !== inventory.databaseScopeHash
    || trust.writerManifestHash !== writerManifestHash) {
    fail('autonomous_research_online_schema_transition_authority_scope_mismatch');
  }
  const instances = Object.freeze(inventory.instances.map((instance) => (
    projectInstance(runtimeRoot, instance)
  )).sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId)));
  const schemaBundleHash = autonomousResearchOnlineSchemaTransitionBundleHash();
  const transitionInventoryHash = hashRecord(
    'AutonomousResearchOnlineSchemaTransitionInventory',
    {
      stateDatabaseManifestHash: manifestHash,
      databaseScopeHash: inventory.databaseScopeHash,
      instances,
    },
  );
  const identity = {
    scopeId: trust.scopeId,
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash,
    stateDatabaseManifestHash: manifestHash,
    schemaBundleHash,
    instances: instances.map((entry) => ({
      databaseRole: entry.databaseRole,
      databaseInstanceId: entry.databaseInstanceId,
      sourceRelativePath: entry.sourceRelativePath,
      schemaContractId: entry.schemaContractId,
      expectedPostSchemaHash: entry.expectedPostSchemaHash,
    })),
  };
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineSchemaTransitionPlan',
    protocol: 'external-authority-quiesced-offline-schema-transition-v1',
    scopeId: trust.scopeId,
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash,
    stateDatabaseManifestHash: manifestHash,
    transitionInventoryHash,
    schemaBundleHash,
    authorityJournalSchemaContractId:
      AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
    authorityJournalSchemaHash: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
    markerSchemaHash: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_HASH,
    instances,
    plannedAt: schemaTransitionNow(clock).toISOString(),
    requestedLeaseMs,
    requiredExecutionWindowMs,
  });
  return Object.freeze({
    ...base,
    transitionId: hashRecord('AutonomousResearchOnlineSchemaTransitionIdentity', identity),
    planHash: hashRecord('AutonomousResearchOnlineSchemaTransitionPlan', base),
  });
}

export function resolveAutonomousResearchOnlineSchemaTransitionPostInventory({
  runtimeRoot,
  stateDatabaseManifest,
  plan,
}) {
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const expected = new Map(plan.instances.map((entry) => [
    entry.databaseInstanceId, entry.expectedPostSchemaHash,
  ]));
  if (inventory.status !== 'autonomous_research_state_database_inventory_ready'
    || inventory.blockers.length !== 0
    || inventory.databaseScopeHash !== plan.databaseScopeHash
    || inventory.inventoryHash !== autonomousResearchStateDatabaseInventoryHash(inventory)
    || inventory.instances.length !== plan.instances.length
    || inventory.instances.some((entry) => expected.get(entry.instanceId) !== entry.schemaHash)) {
    fail('autonomous_research_online_schema_transition_post_inventory_invalid', {
      blockers: inventory.blockers,
    });
  }
  for (const instance of inventory.instances) {
    assertSchemaTransitionNoSidecars(schemaTransitionDatabasePath(runtimeRoot, instance));
  }
  return inventory;
}
