import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertMachineIntakeAuthorityState,
  bindAuthorizedMachineProducerProfileHash,
  bindConfiguredSourceAuthorityHash,
  bindMachineIntakeAuthorityGenesis,
  readAuthorizedMachineProducerProfileHash,
  readConfiguredSourceAuthorityHash,
  readMachineIntakeAuthorityGeneration,
} from './autonomous-research-machine-intake-authority.mjs';
import {
  createMachineIntakeSchema,
  legacySchemaRequiresMigration,
  migrateLegacyMachineIntakeSchema,
} from './autonomous-research-machine-intake-repository-support.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function schemaObjects(database) {
  return database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name`).all()
    .map((row) => Object.freeze({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql,
    }));
}

function isUninitializedDatabase(database) {
  const observedObjects = schemaObjects(database);
  if (observedObjects.length === 0) return true;
  const canonicalDatabase = new DatabaseSync(':memory:');
  try {
    createMachineIntakeSchema(canonicalDatabase);
    if (JSON.stringify(observedObjects) !== JSON.stringify(schemaObjects(canonicalDatabase))) {
      return false;
    }
  } finally {
    canonicalDatabase.close();
  }
  return observedObjects.filter((object) => object.type === 'table')
    .every((object) => database.prepare(`SELECT COUNT(*) AS count
      FROM ${object.name}`).get().count === 0);
}

function validateOpenOptions({
  runtimeRoot,
  create,
  busyTimeoutMs,
  authorizedSourceAuthorityHash,
  authorizedMachineProducerProfileHash,
  machineProducerAppendAuthority,
  migrationHooks,
}) {
  if (!runtimeRoot) throw new Error('autonomous_research_machine_intake_runtime_root_required');
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new Error('autonomous_research_machine_intake_busy_timeout_invalid');
  }
  if (authorizedSourceAuthorityHash !== null
    && !SHA256.test(String(authorizedSourceAuthorityHash || ''))) {
    throw new Error('autonomous_research_machine_intake_source_authority_invalid');
  }
  if (authorizedMachineProducerProfileHash !== null
    && (!SHA256.test(String(authorizedMachineProducerProfileHash || ''))
      || typeof machineProducerAppendAuthority?.consumeAppendAuthorization !== 'function')) {
    throw new Error('autonomous_research_machine_intake_producer_authority_invalid');
  }
  if (create && authorizedSourceAuthorityHash === null) {
    throw new Error('autonomous_research_machine_intake_source_authority_required');
  }
  if (!migrationHooks || typeof migrationHooks !== 'object' || Array.isArray(migrationHooks)
    || Object.keys(migrationHooks).some((key) => key !== 'afterLegacyTablesRenamed')
    || (migrationHooks.afterLegacyTablesRenamed !== undefined
      && typeof migrationHooks.afterLegacyTablesRenamed !== 'function')) {
    throw new Error('autonomous_research_machine_intake_migration_hooks_invalid');
  }
}

export function openAutonomousResearchMachineIntakeRepository({
  runtimeRoot,
  create,
  busyTimeoutMs,
  authorizedSourceAuthorityHash,
  authorizedMachineProducerProfileHash,
  machineProducerAppendAuthority,
  migrationHooks,
}) {
  validateOpenOptions({
    runtimeRoot,
    create,
    busyTimeoutMs,
    authorizedSourceAuthorityHash,
    authorizedMachineProducerProfileHash,
    machineProducerAppendAuthority,
    migrationHooks,
  });
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'machine-intake');
  const databasePath = path.join(stateRoot, 'machine-intake.sqlite');
  if (create) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    if (!fs.existsSync(databasePath)) {
      fs.closeSync(fs.openSync(databasePath, 'wx', 0o600));
    }
  }
  if (fs.existsSync(databasePath)) {
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
      throw new Error('autonomous_research_machine_intake_database_invalid');
    }
  }
  const database = fs.existsSync(databasePath)
    ? new DatabaseSync(databasePath, { readOnly: !create }) : null;
  if (database) database.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  if (database && !create && legacySchemaRequiresMigration(database)) {
    database.close();
    throw new Error('autonomous_research_machine_intake_schema_migration_required');
  }
  let schemaMigration = null;
  let configuredSourceAuthorityHash = null;
  let configuredMachineProducerProfileHash = null;
  let configuredAuthorityGeneration = null;
  if (database && create) {
    try {
      database.exec('PRAGMA synchronous=FULL;');
      const journalMode = String(database.prepare('PRAGMA journal_mode').get().journal_mode);
      if (journalMode !== 'delete') {
        throw new Error('autonomous_research_machine_intake_database_journal_mode_invalid');
      }
      database.exec('BEGIN IMMEDIATE;');
      const uninitialized = isUninitializedDatabase(database);
      if (uninitialized) {
        createMachineIntakeSchema(database);
        configuredSourceAuthorityHash = bindConfiguredSourceAuthorityHash(
          database,
          authorizedSourceAuthorityHash,
        );
        configuredMachineProducerProfileHash = bindAuthorizedMachineProducerProfileHash(
          database,
          authorizedMachineProducerProfileHash,
        );
        if (configuredMachineProducerProfileHash !== null) {
          bindMachineIntakeAuthorityGenesis(database, {
            configurationHash: configuredSourceAuthorityHash,
            producerProfileHash: configuredMachineProducerProfileHash,
            createdAt: new Date().toISOString(),
          });
        }
      } else {
        const migrationRequired = legacySchemaRequiresMigration(database);
        if (migrationRequired && authorizedMachineProducerProfileHash !== null) {
          throw new Error('autonomous_research_machine_intake_producer_authority_mismatch');
        }
        if (migrationRequired) {
          schemaMigration = migrateLegacyMachineIntakeSchema(database, {
            authorizedSourceAuthorityHash,
            migrationHooks,
          });
        } else {
          createMachineIntakeSchema(database);
        }
        if (migrationRequired) {
          if (authorizedMachineProducerProfileHash !== null) {
            throw new Error('autonomous_research_machine_intake_producer_authority_mismatch');
          }
          configuredSourceAuthorityHash = bindConfiguredSourceAuthorityHash(
            database,
            authorizedSourceAuthorityHash,
          );
          configuredMachineProducerProfileHash = null;
        } else {
          const persisted = assertMachineIntakeAuthorityState(database);
          if (persisted.configuredSourceAuthorityHash !== authorizedSourceAuthorityHash) {
            throw new Error(
              'autonomous_research_machine_intake_configuration_authority_mismatch',
            );
          }
          if (persisted.authorizedMachineProducerProfileHash
            !== authorizedMachineProducerProfileHash) {
            throw new Error('autonomous_research_machine_intake_producer_authority_mismatch');
          }
          configuredSourceAuthorityHash = persisted.configuredSourceAuthorityHash;
          configuredMachineProducerProfileHash = persisted.authorizedMachineProducerProfileHash;
        }
      }
      if (configuredMachineProducerProfileHash !== null
        && !SHA256.test(configuredMachineProducerProfileHash)) {
          throw new Error('autonomous_research_machine_intake_producer_authority_mismatch');
      }
      configuredAuthorityGeneration = readMachineIntakeAuthorityGeneration(database);
      assertMachineIntakeAuthorityState(database);
      database.exec('COMMIT;');
    } catch (error) {
      if (database.isTransaction) {
        try { database.exec('ROLLBACK;'); } catch { /* retain original failure */ }
      }
      database.close();
      throw error;
    }
  } else if (database) {
    configuredSourceAuthorityHash = readConfiguredSourceAuthorityHash(database);
    configuredMachineProducerProfileHash = readAuthorizedMachineProducerProfileHash(database);
    configuredAuthorityGeneration = readMachineIntakeAuthorityGeneration(database);
    assertMachineIntakeAuthorityState(database);
  }
  return Object.freeze({
    database,
    databasePath,
    schemaMigration,
    configuredSourceAuthorityHash,
    configuredMachineProducerProfileHash,
    configuredAuthorityGeneration,
  });
}
