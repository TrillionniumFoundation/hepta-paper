import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseManifestHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
  AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS,
} from '../persistence/autonomous-submission-handoff-store.mjs';
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
  withAutonomousResearchStateDatabasePrivateSnapshot,
} from './autonomous-research-state-database-inventory.mjs';
import {
  autonomousResearchPristineRuntimeStateHash,
  inspectAutonomousResearchPristineDatabaseState,
} from './autonomous-research-pristine-runtime-state.mjs';

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
const HANDOFF_SCHEMA_MIGRATION = AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS.at(-1);
if (HANDOFF_SCHEMA_MIGRATION?.version !== 2) {
  throw new Error('autonomous_submission_handoff_target_schema_migration_invalid');
}
const HANDOFF_SCHEMA_OBJECTS = schemaObjectsForStatements([
  HANDOFF_SCHEMA_MIGRATION.sql,
]);
const ONLINE_TARGET_OBJECT_NAMES = new Set([
  ...MARKER_SCHEMA_OBJECTS.keys(), ...JOURNAL_SCHEMA_OBJECTS.keys(),
  ...HANDOFF_SCHEMA_OBJECTS.keys(),
]);

export function schemaTransitionTargetSchema(instance, { appliedAt = null } = {}) {
  const resident = instance.role === 'resident-instance';
  const handoff = instance.role === 'submission-handoff';
  return Object.freeze({
    statements: Object.freeze([
      ...AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
      ...(resident ? AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS : []),
      ...(handoff ? [HANDOFF_SCHEMA_MIGRATION.sql] : []),
    ]),
    objects: new Map([
      ...MARKER_SCHEMA_OBJECTS,
      ...(resident ? JOURNAL_SCHEMA_OBJECTS : []),
      ...(handoff ? HANDOFF_SCHEMA_OBJECTS : []),
    ]),
    handoffMigrations: Object.freeze(handoff
      ? [Object.freeze({ ...HANDOFF_SCHEMA_MIGRATION, appliedAt })]
      : []),
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

export function schemaTransitionStableFileIdentity(identity) {
  return Object.freeze({
    device: identity?.device,
    inode: identity?.inode,
    mode: identity?.mode,
    links: identity?.links,
  });
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

export function schemaTransitionJournalPreimageHash(candidate, { databaseRole = null } = {}) {
  const walPath = `${candidate}-wal`;
  const shmPath = `${candidate}-shm`;
  if (fs.existsSync(walPath)) {
    const wal = fs.lstatSync(walPath);
    if (!wal.isFile() || wal.isSymbolicLink() || wal.nlink !== 1 || (wal.mode & 0o002)) {
      fail('autonomous_research_online_schema_transition_unsafe_wal', {
        databasePath: candidate,
      });
    }
  }
  if (fs.existsSync(shmPath)) {
    const shm = fs.lstatSync(shmPath);
    if (!shm.isFile() || shm.isSymbolicLink() || shm.nlink !== 1 || (shm.mode & 0o002)) {
      fail('autonomous_research_online_schema_transition_unsafe_shm', {
        databasePath: candidate,
      });
    }
  }
  const walIdentity = fs.existsSync(walPath)
    ? schemaTransitionFileIdentity(walPath, { databaseRole })
    : null;
  const walSha256 = walIdentity ? fileSha256HashSync(walPath) : null;
  if (walIdentity && !schemaTransitionSameIdentity(
    walIdentity,
    schemaTransitionFileIdentity(walPath, { databaseRole }),
  )) {
    fail('autonomous_research_online_schema_transition_wal_changed_during_inspection');
  }
  const shmIdentity = fs.existsSync(shmPath)
    ? schemaTransitionFileIdentity(shmPath, { databaseRole })
    : null;
  const shmSha256 = shmIdentity ? fileSha256HashSync(shmPath) : null;
  if (shmIdentity && !schemaTransitionSameIdentity(
    shmIdentity,
    schemaTransitionFileIdentity(shmPath, { databaseRole }),
  )) {
    fail('autonomous_research_online_schema_transition_shm_changed_during_inspection');
  }
  return hashRecord('AutonomousResearchOnlineSchemaTransitionJournalPreimage', {
    durableWalState: walIdentity ? Object.freeze({
      state: 'present',
      fileIdentity: walIdentity,
      sha256: walSha256,
    }) : Object.freeze({ state: 'absent' }),
    ephemeralSharedMemoryState: shmIdentity ? Object.freeze({
      state: 'present',
      fileIdentity: shmIdentity,
      sha256: shmSha256,
    }) : Object.freeze({ state: 'absent' }),
    sharedMemoryCarriesNoDurableDatabaseContent: true,
  });
}

function normalizeCopiedDatabaseJournal(candidate) {
  const database = new DatabaseSync(candidate);
  try {
    const walPresent = fs.existsSync(`${candidate}-wal`);
    const initialMode = String(database.prepare('PRAGMA journal_mode;').get()?.journal_mode || '');
    if (walPresent && initialMode === 'delete'
      && String(database.prepare('PRAGMA journal_mode=WAL;').get()?.journal_mode || '')
        !== 'wal') {
      fail('autonomous_research_online_schema_transition_simulated_stale_sidecar_cleanup_failed');
    }
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
    if (Number(checkpoint?.busy || 0) !== 0) {
      fail('autonomous_research_online_schema_transition_simulated_checkpoint_busy');
    }
    const mode = String(database.prepare('PRAGMA journal_mode=DELETE;').get()?.journal_mode || '');
    database.exec('PRAGMA synchronous=FULL;');
    if (mode !== 'delete') {
      fail('autonomous_research_online_schema_transition_simulated_journal_mode_invalid');
    }
  } finally { database.close(); }
}

function expectedNormalizedSourceSha256(candidate, databaseRole) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-journal-normalize-'));
  const temporaryDatabasePath = path.join(temporaryRoot, 'candidate.sqlite');
  try {
    const beforeSourceSha256 = fileSha256HashSync(candidate);
    const beforeJournalPreimageHash = schemaTransitionJournalPreimageHash(candidate, {
      databaseRole,
    });
    fs.copyFileSync(candidate, temporaryDatabasePath, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(`${candidate}-wal`)) {
      fs.copyFileSync(
        `${candidate}-wal`,
        `${temporaryDatabasePath}-wal`,
        fs.constants.COPYFILE_EXCL,
      );
    }
    if (beforeSourceSha256 !== fileSha256HashSync(candidate)
      || beforeJournalPreimageHash !== schemaTransitionJournalPreimageHash(candidate, {
        databaseRole,
      })) {
      fail('autonomous_research_online_schema_transition_database_changed_during_simulation');
    }
    normalizeCopiedDatabaseJournal(temporaryDatabasePath);
    assertSchemaTransitionNoSidecars(temporaryDatabasePath);
    return fileSha256HashSync(temporaryDatabasePath);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
}

export function schemaTransitionNormalizedProjectionMatches(
  candidate,
  expectedSha256,
  { databaseRole = null } = {},
) {
  try {
    return expectedSha256 === expectedNormalizedSourceSha256(candidate, databaseRole);
  } catch {
    return false;
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

function exactHandoffMigrationRows(database) {
  return database.prepare(`
SELECT version,name,migration_sha256,applied_at
FROM handoff_schema_migrations ORDER BY version;
`).all().map((row) => ({ ...row }));
}

function handoffMigrationRowsMatch(rows, migrations) {
  return rows.length === migrations.length && migrations.every((migration, index) => (
    Number(rows[index]?.version) === migration.version
    && rows[index]?.name === migration.name
    && rows[index]?.migration_sha256 === migration.migrationHash
    && Number.isFinite(Date.parse(String(rows[index]?.applied_at || '')))
  ));
}

function pendingHandoffSchemaMigrations(database, target) {
  const requested = target.handoffMigrations || [];
  if (requested.length === 0) return [];
  if (!database.isTransaction) {
    fail('autonomous_submission_handoff_schema_upgrade_authority_transaction_required');
  }
  const allMigrations = AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS;
  const priorMigrations = allMigrations.slice(0, -1);
  const rows = exactHandoffMigrationRows(database);
  const targetTable = database.prepare(`
SELECT type,name FROM sqlite_schema
WHERE type='table' AND name='submission_authorization_consumptions';
`).get() || null;
  if (handoffMigrationRowsMatch(rows, allMigrations)) {
    if (!targetTable) fail('autonomous_submission_handoff_schema_upgrade_partial_state');
    return [];
  }
  if (!handoffMigrationRowsMatch(rows, priorMigrations) || targetTable) {
    fail('autonomous_submission_handoff_schema_upgrade_preimage_mismatch');
  }
  const cutovers = database.prepare(`
SELECT status,activated_at FROM handoff_cutover WHERE singleton=1;
`).all();
  const outboxCount = Number(database.prepare(
    'SELECT count(*) AS count FROM submission_outbox;',
  ).get()?.count || 0);
  const quickCheck = database.prepare('PRAGMA quick_check;').all();
  if (cutovers.length !== 1
    || cutovers[0]?.status !== 'active'
    || !Number.isFinite(Date.parse(String(cutovers[0]?.activated_at || '')))
    || outboxCount !== 0
    || quickCheck.length !== 1
    || String(quickCheck[0]?.quick_check || quickCheck[0]?.integrity_check) !== 'ok'
    || database.prepare('PRAGMA foreign_key_check;').all().length !== 0) {
    fail(outboxCount !== 0
      ? 'autonomous_submission_handoff_schema_upgrade_empty_outbox_required'
      : 'autonomous_submission_handoff_schema_upgrade_preconditions_failed');
  }
  const migration = requested[0];
  if (requested.length !== 1
    || migration.version !== HANDOFF_SCHEMA_MIGRATION.version
    || migration.name !== HANDOFF_SCHEMA_MIGRATION.name
    || migration.migrationHash !== HANDOFF_SCHEMA_MIGRATION.migrationHash
    || !Number.isFinite(Date.parse(String(migration.appliedAt || '')))) {
    fail('autonomous_submission_handoff_schema_upgrade_target_invalid');
  }
  return requested;
}

export function applySchemaTransitionStatements(database, target) {
  const pendingHandoffMigrations = pendingHandoffSchemaMigrations(database, target);
  for (const statement of target.statements) {
    const name = TARGET_SCHEMA_NAME.exec(statement)?.[1];
    if (!name) fail('autonomous_research_online_schema_transition_statement_invalid');
    const exists = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema WHERE name=?;
`).get(name);
    if (!exists) database.exec(statement);
  }
  for (const migration of pendingHandoffMigrations) {
    database.prepare(`
INSERT INTO handoff_schema_migrations(version,name,migration_sha256,applied_at)
VALUES(?,?,?,?);
`).run(
      migration.version,
      migration.name,
      migration.migrationHash,
      new Date(migration.appliedAt).toISOString(),
    );
  }
  assertSchemaTransitionTargetObjects(database, target);
  if (target.handoffMigrations?.length
    && !handoffMigrationRowsMatch(
      exactHandoffMigrationRows(database),
      AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS,
    )) {
    fail('autonomous_submission_handoff_schema_upgrade_postcondition_failed');
  }
}

function expectedPostSchemaHash({ candidate, instance, appliedAt }) {
  function inspectExpectedPostSchemaSnapshot(temporaryDatabasePath) {
    normalizeCopiedDatabaseJournal(temporaryDatabasePath);
    const database = new DatabaseSync(temporaryDatabasePath);
    try {
      const target = schemaTransitionTargetSchema(instance, { appliedAt });
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
  }
  return withAutonomousResearchStateDatabasePrivateSnapshot({
    sourcePath: candidate,
    inspect: inspectExpectedPostSchemaSnapshot,
  });
}

export function autonomousResearchOnlineSchemaTransitionBundleHash() {
  return hashRecord('AutonomousResearchOnlineSchemaTransitionBundle', {
    authorityJournalSchemaContractId:
      AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
    authorityJournalSchemaHash: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
    markerSchemaHash: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_HASH,
    authorityJournalStatements: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
    markerStatements: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
    autonomousSubmissionHandoffMigrations:
      AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS,
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
  const instances = Array.isArray(inventory?.instances) ? inventory.instances : [];
  const roles = instances.map((entry) => entry?.role);
  const instanceIds = instances.map((entry) => entry?.instanceId);
  let scopeHash = null;
  try { scopeHash = autonomousResearchStateDatabaseScopeHash(instances); } catch { /* fail below */ }
  const instancesById = new Map(instances.map((entry) => [entry.instanceId, entry]));
  const definitions = new Map(stateDatabaseManifest.databases.map((entry) => [entry.role, entry]));
  if (!Array.isArray(inventory?.blockers)
    || !inventory.databaseScopeHash
    || inventory.manifestId !== 'hepta-paper-autonomous-research-state-databases-v1'
    || inventory.manifestHash !== autonomousResearchStateDatabaseManifestHash(stateDatabaseManifest)
    || inventory.databaseScopeHash !== scopeHash
    || instances.length !== AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    || new Set(instanceIds).size !== instanceIds.length
    || new Set(roles).size !== roles.length
    || [...roles].sort().join('\0')
      !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')
    || [...instanceIds].sort().join('\0') !== instanceIds.join('\0')
    || inventory.blockers.some((blocker) => !allowedInventoryBlocker(blocker, instancesById))) {
    fail('autonomous_research_online_schema_transition_inventory_invalid', {
      blockers: inventory.blockers,
    });
  }
  for (const instance of instances) {
    const definition = definitions.get(instance.role);
    const candidate = schemaTransitionDatabasePath(runtimeRoot, instance);
    schemaTransitionJournalPreimageHash(candidate, { databaseRole: instance.role });
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

function assertPristineRebindLocalPreimage(database, instance, {
  databaseScopeHash,
  sourceWriterManifestHash,
}) {
  const metadataRows = database.prepare(`
SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;
`).all();
  const markerCount = Number(database.prepare(`
SELECT count(*) AS count FROM autonomous_research_online_mutation_authority_marker;
`).get()?.count || 0);
  const finalizationCount = Number(database.prepare(`
SELECT count(*) AS count FROM autonomous_research_online_mutation_finalization_receipt;
`).get()?.count || 0);
  const metadata = metadataRows[0];
  if (metadataRows.length !== 1
    || metadata?.schema_version !== 1
    || metadata?.protocol !== 'external-linearizable-reserve-apply-finalize-v1'
    || metadata?.database_role !== instance.role
    || metadata?.database_instance_id !== instance.instanceId
    || !metadata?.schema_contract_id
    || metadata?.schema_hash !== instance.schemaHash
    || metadata?.database_scope_hash !== databaseScopeHash
    || metadata?.writer_manifest_hash !== sourceWriterManifestHash
    || Number(metadata?.genesis_global_sequence) !== 0
    || Number(metadata?.genesis_database_sequence) !== 0
    || markerCount !== 0
    || finalizationCount !== 0) {
    fail('autonomous_research_pristine_schema_rebind_local_preimage_invalid', {
      databaseInstanceId: instance.instanceId,
    });
  }
  return metadata.schema_contract_id;
}

function projectInstance(
  runtimeRoot,
  instance,
  plannedAt,
  stateDatabaseManifestHash,
  pristineInspections,
  rebind = null,
) {
  const candidate = schemaTransitionDatabasePath(runtimeRoot, instance);
  let preSchemaContractId = instance.schemaContractId;
  let prePristineStateHash = hashRecord(
    'AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable',
    { databaseInstanceId: instance.instanceId },
  );
  function inspectProjectedSourceSnapshot(snapshot) {
    const database = new DatabaseSync(snapshot, { readOnly: true });
    try {
      if (rebind) {
        preSchemaContractId = assertPristineRebindLocalPreimage(database, instance, rebind);
        const pristineInspection = inspectAutonomousResearchPristineDatabaseState({
          database,
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          schemaContractId: preSchemaContractId,
          schemaHash: instance.schemaHash,
          stateDatabaseManifestHash,
          phase: 'pre-rebind',
        });
        prePristineStateHash = pristineInspection.pristineStateHash;
        pristineInspections.push(pristineInspection);
      }
      assertSchemaTransitionTargetObjects(
        database,
        schemaTransitionTargetSchema(instance, { appliedAt: plannedAt }),
      );
    } finally { database.close(); }
  }
  withAutonomousResearchStateDatabasePrivateSnapshot({
    sourcePath: candidate,
    inspect: inspectProjectedSourceSnapshot,
  });
  const sourceFileIdentity = schemaTransitionFileIdentity(candidate, {
    databaseRole: instance.role,
  });
  return Object.freeze({
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    sourceRelativePath: instance.sourceRelativePath,
    preSchemaContractId,
    schemaContractId: instance.schemaContractId,
    preSchemaHash: instance.schemaHash,
    expectedPostSchemaHash: expectedPostSchemaHash({
      candidate,
      instance,
      appliedAt: plannedAt,
    }),
    sourceSha256: fileSha256HashSync(candidate),
    sourceFileIdentityHash: hashRecord(
      'AutonomousResearchOnlineSchemaTransitionSourceFileIdentity',
      schemaTransitionStableFileIdentity(sourceFileIdentity),
    ),
    journalPreimageHash: schemaTransitionJournalPreimageHash(candidate, {
      databaseRole: instance.role,
    }),
    expectedNormalizedSourceSha256: expectedNormalizedSourceSha256(candidate, instance.role),
    prePristineStateHash,
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
  expectedPreRebindPristineRuntimeStateHash = null,
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
  const pristineRebind = trust.writerManifestHash !== writerManifestHash;
  if (trust.databaseScopeHash !== inventory.databaseScopeHash) {
    fail('autonomous_research_online_schema_transition_authority_scope_mismatch');
  }
  const plannedAt = schemaTransitionNow(clock).toISOString();
  const pristineInspections = [];
  const instances = Object.freeze(inventory.instances.map((instance) => (
    projectInstance(
      runtimeRoot,
      instance,
      plannedAt,
      manifestHash,
      pristineInspections,
      pristineRebind ? {
        databaseScopeHash: inventory.databaseScopeHash,
        sourceWriterManifestHash: trust.writerManifestHash,
      } : null,
    )
  )).sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId)));
  const prePristineRuntimeStateHash = pristineRebind
    ? autonomousResearchPristineRuntimeStateHash(pristineInspections)
    : hashRecord('AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable', {
      databaseScopeHash: inventory.databaseScopeHash,
    });
  if (pristineRebind && (!/^sha256:[0-9a-f]{64}$/.test(
    String(expectedPreRebindPristineRuntimeStateHash || ''),
  ) || expectedPreRebindPristineRuntimeStateHash !== prePristineRuntimeStateHash)) {
    fail('autonomous_research_pristine_schema_rebind_expected_state_mismatch');
  }
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
      preSchemaContractId: entry.preSchemaContractId,
      schemaContractId: entry.schemaContractId,
      prePristineStateHash: entry.prePristineStateHash,
      expectedPostSchemaHash: entry.expectedPostSchemaHash,
    })),
  };
  if (pristineRebind) {
    identity.transitionMode = 'pristine-finalized-writer-manifest-rebind';
    identity.sourceWriterManifestHash = trust.writerManifestHash;
    identity.prePristineRuntimeStateHash = prePristineRuntimeStateHash;
  }
  const base = Object.freeze({
    version: pristineRebind ? 2 : 1,
    kind: 'AutonomousResearchOnlineSchemaTransitionPlan',
    protocol: pristineRebind
      ? AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL
      : AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
    ...(pristineRebind ? {
      transitionMode: 'pristine-finalized-writer-manifest-rebind',
      sourceWriterManifestHash: trust.writerManifestHash,
      prePristineRuntimeStateHash,
    } : {}),
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
    plannedAt,
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
