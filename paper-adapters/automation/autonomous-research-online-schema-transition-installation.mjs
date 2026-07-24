import { DatabaseSync } from 'node:sqlite';

import {
  autonomousResearchOnlineSchemaTransitionReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION,
} from './autonomous-research-online-authority-journal.mjs';
import {
  applySchemaTransitionStatements,
  assertSchemaTransitionNoSidecars,
  assertSchemaTransitionTargetObjects,
  schemaTransitionDatabasePath,
  schemaTransitionExactSchemaHash,
  schemaTransitionFileIdentity,
  schemaTransitionNow,
  schemaTransitionSameIdentity,
  schemaTransitionTargetSchema,
} from './autonomous-research-online-schema-transition-schema.mjs';
import {
  writeAutonomousResearchOnlineSchemaTransitionJson,
} from './autonomous-research-online-schema-transition-state-repository.mjs';

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

function remainingLeaseMs(reservation, clock) {
  return Date.parse(reservation.expiresAt) - schemaTransitionNow(clock).getTime();
}

export function assertAutonomousResearchOnlineSchemaTransitionLease(
  reservation,
  clock,
  minimumMs,
  code,
) {
  const remaining = remainingLeaseMs(reservation, clock);
  if (!Number.isFinite(remaining) || remaining < minimumMs) fail(code);
}

function metadataExpectation(plan, instance, genesis) {
  return Object.freeze({
    singleton: 1,
    schema_version: 1,
    protocol: 'external-linearizable-reserve-apply-finalize-v1',
    database_role: instance.databaseRole,
    database_instance_id: instance.databaseInstanceId,
    schema_contract_id: instance.schemaContractId,
    schema_hash: instance.expectedPostSchemaHash,
    database_scope_hash: plan.databaseScopeHash,
    writer_manifest_hash: plan.writerManifestHash,
    genesis_global_sequence: genesis.globalSequence,
    genesis_global_hash: genesis.globalHash,
    genesis_database_sequence: genesis.databaseSequence,
    genesis_database_hash: genesis.databaseHash,
    genesis_state_hash: genesis.stateHash,
    provisioned_at: plan.plannedAt,
  });
}

function ensureMarkerMetadata(database, plan, instance, genesis) {
  const expected = metadataExpectation(plan, instance, genesis);
  const existing = database.prepare(`
SELECT singleton,schema_version,protocol,database_role,database_instance_id,
       schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
       genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
       genesis_database_hash,genesis_state_hash,provisioned_at
FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;
`).all();
  if (existing.length === 0) {
    database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_metadata(
  singleton,schema_version,protocol,database_role,database_instance_id,
  schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
  genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
  genesis_database_hash,genesis_state_hash,provisioned_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(...Object.values(expected));
  } else if (existing.length !== 1 || JSON.stringify(existing[0]) !== JSON.stringify(expected)) {
    fail('autonomous_research_online_schema_transition_marker_metadata_conflict', {
      databaseInstanceId: instance.databaseInstanceId,
    });
  }
}

function ensureJournalMetadata(database) {
  const expected = Object.freeze({
    singleton: 1,
    schema_version: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION,
    schema_contract_id: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
    schema_contract_hash: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
  });
  const rows = database.prepare(`
SELECT singleton,schema_version,schema_contract_id,schema_contract_hash
FROM autonomous_research_online_authority_journal_metadata WHERE singleton=1;
`).all();
  if (rows.length === 0) {
    database.prepare(`
INSERT INTO autonomous_research_online_authority_journal_metadata(
  singleton,schema_version,schema_contract_id,schema_contract_hash
) VALUES(?,?,?,?);
`).run(...Object.values(expected));
  } else if (rows.length !== 1 || JSON.stringify(rows[0]) !== JSON.stringify(expected)) {
    fail('autonomous_research_online_schema_transition_journal_metadata_conflict');
  }
}

function validateLockedDatabase(database, instance, planInstance) {
  const quick = database.prepare('PRAGMA quick_check;').all();
  if (quick.length !== 1
    || String(quick[0]?.quick_check || quick[0]?.integrity_check) !== 'ok'
    || database.prepare('PRAGMA foreign_key_check;').all().length !== 0) {
    fail('autonomous_research_online_schema_transition_locked_database_invalid');
  }
  assertSchemaTransitionTargetObjects(database, schemaTransitionTargetSchema(instance));
  const schemaHash = schemaTransitionExactSchemaHash(database);
  if (![planInstance.preSchemaHash, planInstance.expectedPostSchemaHash].includes(schemaHash)) {
    fail('autonomous_research_online_schema_transition_locked_schema_changed');
  }
  return schemaHash;
}

export function acquireAutonomousResearchOnlineSchemaTransitionLocks({
  runtimeRoot,
  currentInventory,
  plan,
}) {
  const currentById = new Map(currentInventory.instances.map((entry) => [entry.instanceId, entry]));
  const locks = [];
  try {
    for (const planInstance of plan.instances) {
      const instance = currentById.get(planInstance.databaseInstanceId);
      if (!instance || instance.role !== planInstance.databaseRole
        || instance.sourceRelativePath !== planInstance.sourceRelativePath) {
        fail('autonomous_research_online_schema_transition_scope_changed');
      }
      const candidate = schemaTransitionDatabasePath(runtimeRoot, instance);
      assertSchemaTransitionNoSidecars(candidate);
      const beforeIdentity = schemaTransitionFileIdentity(candidate);
      if (instance.schemaHash === planInstance.preSchemaHash
        && (fileSha256HashSync(candidate) !== planInstance.sourceSha256
          || hashRecord(
            'AutonomousResearchOnlineSchemaTransitionSourceFileIdentity', beforeIdentity,
          ) !== planInstance.sourceFileIdentityHash)) {
        fail('autonomous_research_online_schema_transition_preimage_changed');
      }
      const database = new DatabaseSync(candidate);
      database.exec('PRAGMA busy_timeout=10000;');
      const journalMode = String(database.prepare('PRAGMA journal_mode;').get().journal_mode);
      if (journalMode !== 'delete') {
        database.close();
        fail('autonomous_research_online_schema_transition_journal_mode_not_delete');
      }
      database.exec('BEGIN EXCLUSIVE;');
      if (!schemaTransitionSameIdentity(beforeIdentity, schemaTransitionFileIdentity(candidate))) {
        database.exec('ROLLBACK;');
        database.close();
        fail('autonomous_research_online_schema_transition_database_identity_changed');
      }
      const lockedSchemaHash = validateLockedDatabase(database, instance, planInstance);
      locks.push({ database, instance, planInstance, lockedSchemaHash });
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) {
      if (lock.database.isTransaction) {
        try { lock.database.exec('ROLLBACK;'); } catch { /* retain original error */ }
      }
      lock.database.close();
    }
    throw error;
  }
}

function installationRecord(plan, reservation, planInstance) {
  const payload = Object.freeze({
    transitionId: plan.transitionId,
    reservationReceiptHash: autonomousResearchOnlineSchemaTransitionReceiptHash(reservation),
    databaseRole: planInstance.databaseRole,
    databaseInstanceId: planInstance.databaseInstanceId,
    schemaContractId: planInstance.schemaContractId,
    preSchemaHash: planInstance.preSchemaHash,
    postSchemaHash: planInstance.expectedPostSchemaHash,
  });
  return Object.freeze({
    databaseRole: payload.databaseRole,
    databaseInstanceId: payload.databaseInstanceId,
    schemaContractId: payload.schemaContractId,
    preSchemaHash: payload.preSchemaHash,
    postSchemaHash: payload.postSchemaHash,
    installationHash: hashRecord(
      'AutonomousResearchOnlineSchemaTransitionDatabaseInstallation', payload,
    ),
  });
}

export function installAutonomousResearchOnlineSchemaTransitionLocks({
  locks,
  plan,
  reservation,
  clock,
  commitSafetyMarginMs,
  state,
  statePath,
  faultInjector,
}) {
  const genesisById = new Map(reservation.databaseGenesis.map((entry) => [
    entry.databaseInstanceId, entry,
  ]));
  const installations = new Map((state.installations || []).map((entry) => [
    entry.databaseInstanceId, entry,
  ]));
  try {
    for (const lock of locks) {
      const target = schemaTransitionTargetSchema(lock.instance);
      if (lock.lockedSchemaHash === lock.planInstance.preSchemaHash) {
        applySchemaTransitionStatements(lock.database, target);
      }
      ensureMarkerMetadata(
        lock.database,
        plan,
        lock.planInstance,
        genesisById.get(lock.planInstance.databaseInstanceId),
      );
      if (lock.instance.role === 'resident-instance') ensureJournalMetadata(lock.database);
      if (schemaTransitionExactSchemaHash(lock.database)
          !== lock.planInstance.expectedPostSchemaHash
        || lock.database.prepare('PRAGMA quick_check;').all()[0]?.quick_check !== 'ok'
        || lock.database.prepare('PRAGMA foreign_key_check;').all().length !== 0) {
        fail('autonomous_research_online_schema_transition_post_schema_invalid');
      }
      assertAutonomousResearchOnlineSchemaTransitionLease(
        reservation,
        clock,
        commitSafetyMarginMs,
        'autonomous_research_online_schema_transition_lease_expiring_before_commit',
      );
      faultInjector?.({
        point: 'before_instance_commit',
        databaseInstanceId: lock.planInstance.databaseInstanceId,
        completedCount: installations.size,
      });
      lock.database.exec('COMMIT;');
      const installation = installationRecord(plan, reservation, lock.planInstance);
      installations.set(lock.planInstance.databaseInstanceId, installation);
      writeAutonomousResearchOnlineSchemaTransitionJson(statePath, Object.freeze({
        ...state,
        phase: 'installing',
        installations: Object.freeze([...installations.values()].sort((left, right) => (
          left.databaseInstanceId.localeCompare(right.databaseInstanceId)
        ))),
      }));
      faultInjector?.({
        point: 'after_instance_commit',
        databaseInstanceId: lock.planInstance.databaseInstanceId,
        completedCount: installations.size,
      });
    }
    return Object.freeze([...installations.values()].sort((left, right) => (
      left.databaseInstanceId.localeCompare(right.databaseInstanceId)
    )));
  } finally {
    for (const lock of locks.reverse()) {
      if (lock.database.isTransaction) {
        try { lock.database.exec('ROLLBACK;'); } catch { /* caller receives primary failure */ }
      }
      lock.database.close();
    }
  }
}
