import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  autonomousResearchOnlineSchemaTransitionReceiptHash,
  AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseManifestHash,
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  assertAutonomousResearchPristineRuntimeInspectionReceipt,
  autonomousResearchPristineRuntimeInspectionReceiptHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  inspectAutonomousResearchOnlineSchemaTransitionReadiness,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {
  autonomousResearchOnlineSchemaTransitionControlPaths,
  readAutonomousResearchOnlineSchemaTransitionJson,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  autonomousResearchPristineRuntimeStateHash,
  inspectAutonomousResearchPristineDatabaseState,
} from '../../paper-adapters/automation/autonomous-research-pristine-runtime-state.mjs';
import {
  buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt,
  PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
} from '../../paper-adapters/automation/autonomous-research-state-partial-root-maintenance-inspection.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  runtimeRootIdentity,
} from '../../paper-adapters/automation/strict-full-auto-acceptance-control-paths.mjs';
import {
  readRegularJsonFileSync,
} from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_INSPECTION_LIFETIME_MS = 5 * 60 * 1000;

export const DEFAULT_AUTONOMOUS_RESEARCH_PRISTINE_RUNTIME_AUTHORITY_PROCESS_CONFIGURATION_PATH =
  '/run/hepta/online-state-authority-process.json';
export const DEFAULT_AUTONOMOUS_RESEARCH_PRISTINE_RUNTIME_WRITER_QUIESCENCE_RECEIPT_PATH =
  '/run/hepta-authority/pre-resident-writer-quiescence.json';

const LOCAL_AUTHORITY_CONFIGURATION_KEYS = Object.freeze([
  'version', 'kind', 'authorityId', 'keyId', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'privateKeyPath', 'stateDatabasePath', 'socketPath',
  'maximumReservationLeaseMs', 'maximumObservationAgeMs',
]);
const PUBLIC_AUTHORITY_CONFIGURATION_KEYS = Object.freeze([
  'version', 'kind', 'authorityId', 'keyId', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'publicKeyPath', 'publicKeySha256',
  'maximumReservationLeaseMs', 'maximumObservationAgeMs',
]);

function fail(code) {
  throw new Error(code);
}

function assertAuthorityConfigurationBinding({ local, publicConfiguration }) {
  if (!hasExactObjectKeys(local, LOCAL_AUTHORITY_CONFIGURATION_KEYS)
    || local.version !== 1
    || local.kind !== 'HeptaLocalAutonomousResearchStateAuthorityConfiguration'
    || !hasExactObjectKeys(publicConfiguration, PUBLIC_AUTHORITY_CONFIGURATION_KEYS)
    || publicConfiguration.version !== 1
    || publicConfiguration.kind !== 'AutonomousResearchOnlineMutationAuthorityConfiguration'
    || local.authorityId !== publicConfiguration.authorityId
    || local.keyId !== publicConfiguration.keyId
    || local.scopeId !== publicConfiguration.scopeId
    || local.databaseScopeHash !== publicConfiguration.databaseScopeHash
    || local.writerManifestHash !== publicConfiguration.writerManifestHash
    || local.maximumReservationLeaseMs !== publicConfiguration.maximumReservationLeaseMs
    || local.maximumObservationAgeMs !== publicConfiguration.maximumObservationAgeMs) {
    fail('autonomous_research_pristine_runtime_authority_configuration_binding_invalid');
  }
  return local;
}

function sameStrings(left, right) {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function noSqliteSidecars(runtimeRoot, inventory) {
  for (const instance of inventory.instances) {
    const candidate = path.resolve(runtimeRoot, instance.sourceRelativePath);
    if (!pathWithin(runtimeRoot, candidate)
      || instance.walFileIdentity !== null
      || fs.existsSync(`${candidate}-wal`)
      || fs.existsSync(`${candidate}-shm`)) {
      fail('autonomous_research_pristine_runtime_sqlite_sidecar_present');
    }
  }
}

function authoritySnapshot({
  authorityConfiguration,
  authorityConfigurationHash,
  auditReceipt,
}) {
  const candidate = path.resolve(String(authorityConfiguration?.stateDatabasePath || ''));
  const stat = fs.lstatSync(candidate);
  if (!path.isAbsolute(String(authorityConfiguration?.stateDatabasePath || ''))
    || !stat.isFile() || stat.isSymbolicLink()
    || (stat.mode & 0o022) !== 0) {
    fail('autonomous_research_pristine_runtime_authority_state_database_invalid');
  }
  const database = new DatabaseSync(candidate, { readOnly: true });
  try {
    database.exec('BEGIN;');
    const metadata = database.prepare(
      'SELECT * FROM authority_metadata WHERE singleton=1;',
    ).get();
    const databaseHeads = database.prepare(`
SELECT database_instance_id,database_role,sequence,hash,schema_hash,state_hash
FROM authority_database_head ORDER BY database_instance_id;
`).all().map((row) => Object.freeze({
      databaseInstanceId: row.database_instance_id,
      databaseRole: row.database_role,
      sequence: Number(row.sequence),
      hash: row.hash,
      schemaHash: row.schema_hash,
      stateHash: row.state_hash,
    }));
    const rebind = database.prepare(`
SELECT finalization_receipt_json,target_configuration_hash
FROM authority_schema_rebind
WHERE finalization_receipt_json IS NOT NULL
ORDER BY rowid DESC LIMIT 1;
`).get();
    const initialUnfinished = Number(database.prepare(`
SELECT count(*) AS count FROM authority_schema_transition
WHERE finalization_receipt_json IS NULL;
`).get().count);
    const rebindUnfinished = Number(database.prepare(`
SELECT count(*) AS count FROM authority_schema_rebind
WHERE finalization_receipt_json IS NULL;
`).get().count);
    const mutationUnfinished = Number(database.prepare(`
SELECT count(*) AS count FROM authority_mutation WHERE status='reserved';
`).get().count);
    const backupUnfinished = Number(database.prepare(`
SELECT count(*) AS count FROM authority_backup_reservation
WHERE finalization_receipt_json IS NULL;
`).get().count);
    database.exec('COMMIT;');
    let storedFinalization = null;
    try { storedFinalization = JSON.parse(rebind?.finalization_receipt_json || 'null'); }
    catch { fail('autonomous_research_pristine_runtime_authority_rebind_receipt_invalid'); }
    if (!metadata
      || metadata.configuration_hash !== authorityConfigurationHash
      || metadata.schema_transition_state !== 'finalized'
      || metadata.database_scope_hash !== auditReceipt.databaseScopeHash
      || metadata.writer_manifest_hash !== auditReceipt.writerManifestHash
      || Number(metadata.global_sequence) !== 0
      || metadata.global_hash !== auditReceipt.finalization.globalHash
      || rebind?.target_configuration_hash !== authorityConfigurationHash
      || JSON.stringify(storedFinalization) !== JSON.stringify(auditReceipt.finalization)
      || databaseHeads.length !== AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length) {
      fail('autonomous_research_pristine_runtime_authority_state_invalid');
    }
    return Object.freeze({
      metadata: Object.freeze({ ...metadata }),
      databaseHeads: Object.freeze(databaseHeads),
      unfinishedSchemaTransitionCount: initialUnfinished,
      unfinishedSchemaRebindCount: rebindUnfinished,
      unfinishedMutationCount: mutationUnfinished,
      unfinishedBackupCount: backupUnfinished,
    });
  } finally { database.close(); }
}

function inspectedInstances({ runtimeRoot, inventory, manifestHash }) {
  return Object.freeze(inventory.instances.map((instance) => {
    const candidate = path.resolve(runtimeRoot, instance.sourceRelativePath);
    if (!pathWithin(runtimeRoot, candidate)) {
      fail('autonomous_research_pristine_runtime_database_path_invalid');
    }
    const database = new DatabaseSync(candidate, { readOnly: true });
    try {
      const inspection = inspectAutonomousResearchPristineDatabaseState({
        database,
        databaseRole: instance.role,
        databaseInstanceId: instance.instanceId,
        schemaContractId: instance.schemaContractId,
        schemaHash: instance.schemaHash,
        stateDatabaseManifestHash: manifestHash,
        // The v2 audit receipt commits the finalized post-rebind state. Adoption
        // re-observes that exact state; using a new phase label would change the
        // phase-bound pristine hash even when no database byte or semantic row changed.
        phase: 'post-rebind',
      });
      const online = inspection.semanticBindings.onlineAuthority;
      const tableByName = new Map(inspection.tableStates.map((entry) => [
        entry.tableName, entry,
      ]));
      return Object.freeze({
        inspection,
        receiptInstance: Object.freeze({
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          sourceRelativePath: instance.sourceRelativePath,
          fileIdentityHash: hashRecord(
            'AutonomousResearchPristineRuntimeDatabaseFileIdentity',
            instance.sourceFileIdentity,
          ),
          sha256: instance.sourceSha256,
          schemaContractId: instance.schemaContractId,
          schemaHash: instance.schemaHash,
          stateHeadSequence: online.databaseSequence,
          stateHeadHash: online.databaseHash,
          stateHeadStateHash: online.stateHash,
          markerCount: tableByName.get(
            'autonomous_research_online_mutation_authority_marker',
          ).rowCount,
          finalizationCount: tableByName.get(
            'autonomous_research_online_mutation_finalization_receipt',
          ).rowCount,
          businessRowCount: inspection.businessRowCount,
        }),
      });
    } finally { database.close(); }
  }).sort((left, right) => left.receiptInstance.databaseInstanceId.localeCompare(
    right.receiptInstance.databaseInstanceId,
  )));
}

function assertQuiescence({ receipt, runtimeRoot, databaseScopeHash, writerManifestHash, now }) {
  let normalized;
  try { normalized = buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt(receipt); }
  catch { fail('autonomous_research_pristine_runtime_writer_quiescence_invalid'); }
  if (JSON.stringify(receipt) !== JSON.stringify(normalized)
    || receipt.receiptHash !== normalized.receiptHash
    || normalized.runtimeRoot !== runtimeRoot
    || normalized.databaseScopeHash !== databaseScopeHash
    || normalized.writerManifestHash !== writerManifestHash
    || !sameStrings(
      normalized.quiescedWriterServices,
      PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
    )
    || normalized.activeWriterProcessIds.length !== 0
    || normalized.serviceInspectionComplete !== true
    || normalized.processInspectionComplete !== true
    || !canonicalInstant(normalized.observedAt)
    || !canonicalInstant(normalized.expiresAt)
    || Date.parse(normalized.observedAt) > now.getTime()
    || Date.parse(normalized.expiresAt) <= now.getTime()) {
    fail('autonomous_research_pristine_runtime_writer_quiescence_invalid');
  }
  return normalized;
}

export function composeAutonomousResearchPristineRuntimeInspector({
  workspaceRoot,
  authorityProcessConfigurationPath =
    DEFAULT_AUTONOMOUS_RESEARCH_PRISTINE_RUNTIME_AUTHORITY_PROCESS_CONFIGURATION_PATH,
  authorityConfigurationPath = null,
  writerQuiescenceReceiptPath =
    DEFAULT_AUTONOMOUS_RESEARCH_PRISTINE_RUNTIME_WRITER_QUIESCENCE_RECEIPT_PATH,
  clock = { now: () => new Date() },
} = {}) {
  const resolvedWorkspaceRoot = path.resolve(String(workspaceRoot || ''));
  const resolvedAuthorityProcessConfigurationPath = path.resolve(
    authorityProcessConfigurationPath,
  );
  const resolvedAuthorityConfigurationPath = authorityConfigurationPath
    ? path.resolve(authorityConfigurationPath) : null;
  const resolvedWriterQuiescenceReceiptPath = path.resolve(writerQuiescenceReceiptPath);
  if (!workspaceRoot || typeof clock?.now !== 'function') {
    fail('autonomous_research_pristine_runtime_inspector_configuration_invalid');
  }
  const manifestPath = path.join(
    resolvedWorkspaceRoot,
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  );
  return Object.freeze({
    inspect({ runtimeRoot, planHash, configurationHash, clock: requestClock = clock } = {}) {
      if (!SHA256.test(String(planHash || ''))
        || !SHA256.test(String(configurationHash || ''))
        || typeof requestClock?.now !== 'function') {
        fail('autonomous_research_pristine_runtime_inspection_request_invalid');
      }
      const now = new Date(requestClock.now());
      if (!Number.isFinite(now.getTime())) {
        fail('autonomous_research_pristine_runtime_inspection_clock_invalid');
      }
      const resolvedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
      const rootIdentity = runtimeRootIdentity({ runtimeRoot: resolvedRuntimeRoot });
      const stateDatabaseManifest = readRegularJsonFileSync(manifestPath);
      const manifestHash = autonomousResearchStateDatabaseManifestHash(
        stateDatabaseManifest,
      );
      const readyReceipt = inspectAutonomousResearchOnlineSchemaTransitionReadiness({
        runtimeRoot: resolvedRuntimeRoot,
        stateDatabaseManifest,
        writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
        authorityProcessConfigurationPath: resolvedAuthorityProcessConfigurationPath,
        clock: Object.freeze({ now: () => new Date(now) }),
      });
      const paths = autonomousResearchOnlineSchemaTransitionControlPaths(
        resolvedRuntimeRoot,
        { create: false },
      );
      const auditReceipt = readAutonomousResearchOnlineSchemaTransitionJson(
        paths.finalReceiptPath,
      );
      const processConfiguration = readRegularJsonFileSync(
        resolvedAuthorityProcessConfigurationPath,
      );
      if (!resolvedAuthorityConfigurationPath) {
        fail('autonomous_research_pristine_runtime_authority_configuration_required');
      }
      const publicConfiguration = readRegularJsonFileSync(
        processConfiguration.authorityConfigurationPath,
      );
      const authorityConfiguration = assertAuthorityConfigurationBinding({
        local: readRegularJsonFileSync(resolvedAuthorityConfigurationPath),
        publicConfiguration,
      });
      const authorityConfigurationHash = hashRecord(
        'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
        authorityConfiguration,
      );
      if (readyReceipt.version !== 2
        || auditReceipt?.version !== 2
        || auditReceipt.protocol !== AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL
        || auditReceipt.transitionMode
          !== 'pristine-finalized-writer-manifest-rebind'
        || readyReceipt.schemaTransitionReceiptHash
          !== auditReceipt.schemaTransitionReceiptHash
        || auditReceipt.finalization.targetAuthorityConfigurationHash
          !== authorityConfigurationHash) {
        fail('autonomous_research_pristine_runtime_schema_rebind_not_verified');
      }
      const inventory = resolveAutonomousResearchStateDatabaseInventory({
        runtimeRoot: resolvedRuntimeRoot,
        manifest: stateDatabaseManifest,
      });
      if (inventory.status !== 'autonomous_research_state_database_inventory_ready'
        || inventory.blockers.length !== 0
        || inventory.manifestHash !== manifestHash
        || inventory.inventoryHash !== autonomousResearchStateDatabaseInventoryHash(inventory)
        || inventory.databaseScopeHash !== auditReceipt.databaseScopeHash
        || inventory.instances.length !== AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length) {
        fail('autonomous_research_pristine_runtime_inventory_invalid');
      }
      noSqliteSidecars(resolvedRuntimeRoot, inventory);
      const inspected = inspectedInstances({
        runtimeRoot: resolvedRuntimeRoot,
        inventory,
        manifestHash,
      });
      const pristineRuntimeStateHash = autonomousResearchPristineRuntimeStateHash(
        inspected.map((entry) => entry.inspection),
      );
      if (pristineRuntimeStateHash !== auditReceipt.postPristineRuntimeStateHash) {
        fail('autonomous_research_pristine_runtime_transition_state_hash_mismatch');
      }
      const authority = authoritySnapshot({
        authorityConfiguration,
        authorityConfigurationHash,
        auditReceipt,
      });
      const headById = new Map(authority.databaseHeads.map((entry) => [
        entry.databaseInstanceId, entry,
      ]));
      for (const entry of inspected) {
        const instance = entry.receiptInstance;
        const head = headById.get(instance.databaseInstanceId);
        if (!head || head.databaseRole !== instance.databaseRole
          || head.sequence !== instance.stateHeadSequence
          || head.hash !== instance.stateHeadHash
          || head.schemaHash !== instance.schemaHash
          || head.stateHash !== instance.stateHeadStateHash) {
          fail('autonomous_research_pristine_runtime_authority_head_mismatch');
        }
      }
      const inventoryAfter = resolveAutonomousResearchStateDatabaseInventory({
        runtimeRoot: resolvedRuntimeRoot,
        manifest: stateDatabaseManifest,
      });
      noSqliteSidecars(resolvedRuntimeRoot, inventoryAfter);
      if (inventoryAfter.inventoryHash !== inventory.inventoryHash) {
        fail('autonomous_research_pristine_runtime_inventory_changed_during_inspection');
      }
      const quiescence = assertQuiescence({
        receipt: readRegularJsonFileSync(resolvedWriterQuiescenceReceiptPath),
        runtimeRoot: resolvedRuntimeRoot,
        databaseScopeHash: inventory.databaseScopeHash,
        writerManifestHash: auditReceipt.writerManifestHash,
        now,
      });
      const evidenceFreshThroughMilliseconds = Math.min(
        Date.parse(readyReceipt.expiresAt),
        Date.parse(quiescence.expiresAt),
        now.getTime() + MAXIMUM_INSPECTION_LIFETIME_MS,
      );
      if (!Number.isFinite(evidenceFreshThroughMilliseconds)
        || evidenceFreshThroughMilliseconds <= now.getTime()) {
        fail('autonomous_research_pristine_runtime_evidence_stale');
      }
      const body = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchPristineRuntimeInspectionReceipt',
        status: 'autonomous_research_pristine_runtime_inspection_ready',
        inspectedAt: now.toISOString(),
        runtimeRootIdentityHash: rootIdentity.runtimeRootIdentityHash,
        stateDatabaseManifestHash: manifestHash,
        databaseScopeHash: inventory.databaseScopeHash,
        writerManifestHash: auditReceipt.writerManifestHash,
        inventoryHash: inventory.inventoryHash,
        pristineRuntimeStateHash,
        authority: Object.freeze({
          authorityId: authorityConfiguration.authorityId,
          keyId: authorityConfiguration.keyId,
          scopeId: authorityConfiguration.scopeId,
          configurationHash: authorityConfigurationHash,
          writerManifestHash: auditReceipt.writerManifestHash,
          observationReceiptHash: readyReceipt.liveObservationReceiptHash,
          schemaTransitionState: authority.metadata.schema_transition_state,
          schemaRebindFinalizationReceiptHash:
            autonomousResearchOnlineSchemaTransitionReceiptHash(auditReceipt.finalization),
          schemaRebindTargetConfigurationHash:
            auditReceipt.finalization.targetAuthorityConfigurationHash,
          globalSequence: Number(authority.metadata.global_sequence),
          globalHash: authority.metadata.global_hash,
          databaseHeads: Object.freeze(authority.databaseHeads.map((head) => Object.freeze({
            databaseInstanceId: head.databaseInstanceId,
            schemaHash: head.schemaHash,
            sequence: head.sequence,
            hash: head.hash,
            stateHash: head.stateHash,
          }))),
          writerQuiescenceStatus: 'pre_resident_writer_quiescence_verified',
          writerQuiescenceReceiptHash: quiescence.receiptHash,
          writerQuiescenceScopeHash: quiescence.databaseScopeHash,
          writerQuiescenceFreshThrough: quiescence.expiresAt,
          unfinishedSchemaTransitionCount: authority.unfinishedSchemaTransitionCount,
          unfinishedSchemaRebindCount: authority.unfinishedSchemaRebindCount,
          unfinishedMutationCount: authority.unfinishedMutationCount,
          unfinishedBackupCount: authority.unfinishedBackupCount,
        }),
        instances: Object.freeze(inspected.map((entry) => entry.receiptInstance)),
        businessRowCount: inspected.reduce((total, entry) => (
          total + entry.receiptInstance.businessRowCount
        ), 0),
        adoptionMutationPerformed: false,
        preResidentSchemaRebindVerified: true,
        evidenceFreshThrough: new Date(evidenceFreshThroughMilliseconds).toISOString(),
      });
      return assertAutonomousResearchPristineRuntimeInspectionReceipt(
        Object.freeze({
          ...body,
          receiptHash: autonomousResearchPristineRuntimeInspectionReceiptHash(body),
        }),
        { now },
      );
    },
    verify(receipt, { now = clock.now() } = {}) {
      try {
        assertAutonomousResearchPristineRuntimeInspectionReceipt(receipt, { now });
        return true;
      } catch { return false; }
    },
    authorityProcessConfigurationPath: resolvedAuthorityProcessConfigurationPath,
    writerQuiescenceReceiptPath: resolvedWriterQuiescenceReceiptPath,
    manifestPath,
  });
}
