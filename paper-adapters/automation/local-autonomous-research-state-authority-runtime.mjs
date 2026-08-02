import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  autonomousResearchOnlineMutationSignedPayload,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  assertAutonomousResearchOnlineSchemaTransitionObserveRequest,
  assertAutonomousResearchOnlineSchemaTransitionReserveRequest,
  autonomousResearchOnlineSchemaTransitionReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousResearchStateBackupAuthoritySignaturePayload,
} from './autonomous-research-state-backup-authority.mjs';
import {
  createLocalAutonomousResearchStateAuthorityBackupHandlers,
} from './local-autonomous-research-state-authority-backup.mjs';
import {
  createLocalAutonomousResearchStateAuthorityMutationHandlers,
} from './local-autonomous-research-state-authority-mutation.mjs';
import {
  failLocalStateAuthority as fail,
  LOCAL_STATE_AUTHORITY_SAFE_ID as SAFE_ID,
  LOCAL_STATE_AUTHORITY_SHA256 as SHA256,
  localStateAuthorityExpiry as expiry,
  localStateAuthorityNow as isoNow,
  parseLocalStateAuthorityRecord as parseRecord,
  readLocalStateAuthorityDatabaseHeads as databaseHeads,
  readLocalStateAuthorityMetadata as metadata,
  runLocalStateAuthorityTransaction as transaction,
} from './local-autonomous-research-state-authority-support.mjs';

const CONFIGURATION_KEYS = Object.freeze([
  'version', 'kind', 'authorityId', 'keyId', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'privateKeyPath', 'stateDatabasePath', 'socketPath',
  'maximumReservationLeaseMs', 'maximumObservationAgeMs',
]);

function loadConfiguration(configurationPath) {
  const configuration = parseRecord(
    fs.readFileSync(configurationPath, 'utf8'),
    'local_state_authority_configuration_invalid',
  );
  if (!hasExactObjectKeys(configuration, CONFIGURATION_KEYS)
    || configuration.version !== 1
    || configuration.kind !== 'HeptaLocalAutonomousResearchStateAuthorityConfiguration'
    || !SAFE_ID.test(String(configuration.authorityId || ''))
    || !SAFE_ID.test(String(configuration.keyId || ''))
    || !SAFE_ID.test(String(configuration.scopeId || ''))
    || !SHA256.test(String(configuration.databaseScopeHash || ''))
    || !SHA256.test(String(configuration.writerManifestHash || ''))
    || !path.isAbsolute(String(configuration.privateKeyPath || ''))
    || !path.isAbsolute(String(configuration.stateDatabasePath || ''))
    || !path.isAbsolute(String(configuration.socketPath || ''))
    || !Number.isSafeInteger(configuration.maximumReservationLeaseMs)
    || configuration.maximumReservationLeaseMs < 1000
    || configuration.maximumReservationLeaseMs > 15 * 60 * 1000
    || !Number.isSafeInteger(configuration.maximumObservationAgeMs)
    || configuration.maximumObservationAgeMs < 1000
    || configuration.maximumObservationAgeMs > 15 * 60 * 1000) {
    fail('local_state_authority_configuration_invalid');
  }
  return Object.freeze(configuration);
}

function loadPrivateKey(privateKeyPath) {
  const stat = fs.lstatSync(privateKeyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail('local_state_authority_private_key_invalid');
  }
  let privateKey;
  try { privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath)); }
  catch { fail('local_state_authority_private_key_invalid'); }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    fail('local_state_authority_private_key_invalid');
  }
  return privateKey;
}

function initializeDatabase(database, configuration) {
  database.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS authority_metadata(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  configuration_hash TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  database_scope_hash TEXT NOT NULL,
  writer_manifest_hash TEXT NOT NULL,
  global_sequence INTEGER NOT NULL CHECK(global_sequence>=0),
  global_hash TEXT NOT NULL,
  schema_transition_state TEXT NOT NULL
    CHECK(schema_transition_state IN('uninitialized','reserved','finalized'))
) STRICT;
CREATE TABLE IF NOT EXISTS authority_database_head(
  database_instance_id TEXT PRIMARY KEY,
  database_role TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS authority_schema_transition(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  reserve_request_json TEXT NOT NULL,
  reservation_receipt_json TEXT NOT NULL,
  finalize_request_json TEXT,
  finalization_receipt_json TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS authority_mutation(
  mutation_attempt_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN('reserved','finalized','aborted')),
  global_sequence INTEGER NOT NULL UNIQUE,
  database_instance_id TEXT NOT NULL,
  reserve_request_json TEXT NOT NULL,
  reservation_receipt_json TEXT NOT NULL,
  finalize_request_json TEXT,
  finalization_receipt_json TEXT,
  abort_request_json TEXT,
  abort_receipt_json TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS authority_backup_reservation(
  reservation_id TEXT PRIMARY KEY,
  reserve_request_json TEXT NOT NULL,
  reservation_receipt_json TEXT NOT NULL,
  finalize_request_json TEXT,
  finalization_receipt_json TEXT
) STRICT;
`);
  const configurationHash = hashRecord(
    'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
    configuration,
  );
  const current = metadata(database);
  if (!current) {
    const globalHash = hashRecord('HeptaLocalStateAuthorityGenesisGlobalHead', {
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      scopeId: configuration.scopeId,
      databaseScopeHash: configuration.databaseScopeHash,
      writerManifestHash: configuration.writerManifestHash,
    });
    database.prepare(`
INSERT INTO authority_metadata(
  singleton,configuration_hash,authority_id,key_id,scope_id,database_scope_hash,
  writer_manifest_hash,global_sequence,global_hash,schema_transition_state
) VALUES(1,?,?,?,?,?,?,?,?,?);
`).run(
      configurationHash,
      configuration.authorityId,
      configuration.keyId,
      configuration.scopeId,
      configuration.databaseScopeHash,
      configuration.writerManifestHash,
      0,
      globalHash,
      'uninitialized',
    );
    return;
  }
  if (current.configuration_hash !== configurationHash
    || current.authority_id !== configuration.authorityId
    || current.key_id !== configuration.keyId
    || current.scope_id !== configuration.scopeId
    || current.database_scope_hash !== configuration.databaseScopeHash
    || current.writer_manifest_hash !== configuration.writerManifestHash) {
    fail('local_state_authority_persisted_identity_mismatch');
  }
}

function onlineTrust(configuration) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: configuration.authorityId,
    keyId: configuration.keyId,
    scopeId: configuration.scopeId,
    databaseScopeHash: configuration.databaseScopeHash,
    writerManifestHash: configuration.writerManifestHash,
    maximumReservationLeaseMs: configuration.maximumReservationLeaseMs,
    maximumObservationAgeMs: configuration.maximumObservationAgeMs,
  });
}

export function createLocalAutonomousResearchStateAuthority({
  configurationPath,
  clock = { now: () => new Date() },
} = {}) {
  if (!path.isAbsolute(String(configurationPath || ''))) {
    fail('local_state_authority_configuration_path_required');
  }
  const configuration = loadConfiguration(configurationPath);
  const privateKey = loadPrivateKey(configuration.privateKeyPath);
  fs.mkdirSync(path.dirname(configuration.stateDatabasePath), {
    recursive: true,
    mode: 0o700,
  });
  const database = new DatabaseSync(configuration.stateDatabasePath);
  initializeDatabase(database, configuration);
  try { fs.chmodSync(configuration.stateDatabasePath, 0o600); } catch {}
  const trust = onlineTrust(configuration);
  const signOnline = (receipt) => Object.freeze({
    ...receipt,
    signature: crypto.sign(
      null,
      Buffer.from(autonomousResearchOnlineMutationSignedPayload(receipt), 'utf8'),
      privateKey,
    ).toString('base64'),
  });
  const signBackup = (receipt) => Object.freeze({
    ...receipt,
    signature: crypto.sign(
      null,
      Buffer.from(autonomousResearchStateBackupAuthoritySignaturePayload(receipt), 'utf8'),
      privateKey,
    ).toString('base64'),
  });

  function reserveSchemaTransition(request) {
    assertAutonomousResearchOnlineSchemaTransitionReserveRequest(request, { trust });
    return transaction(database, () => {
      const existing = database.prepare(
        'SELECT * FROM authority_schema_transition WHERE singleton=1',
      ).get();
      if (existing) {
        const storedRequest = parseRecord(
          existing.reserve_request_json,
          'local_state_authority_schema_transition_state_invalid',
        );
        if (JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          fail('local_state_authority_schema_transition_conflict');
        }
        return Object.freeze(parseRecord(
          existing.reservation_receipt_json,
          'local_state_authority_schema_transition_state_invalid',
        ));
      }
      const current = metadata(database);
      if (current.schema_transition_state !== 'uninitialized'
        || database.prepare('SELECT count(*) AS count FROM authority_database_head')
          .get().count !== 0) {
        fail('local_state_authority_schema_transition_already_initialized');
      }
      const issuedAt = isoNow(clock);
      const databaseGenesis = request.instances.map((instance) => Object.freeze({
        databaseRole: instance.databaseRole,
        databaseInstanceId: instance.databaseInstanceId,
        schemaContractId: instance.schemaContractId,
        schemaHash: instance.expectedPostSchemaHash,
        globalSequence: 0,
        globalHash: current.global_hash,
        databaseSequence: 0,
        databaseHash: hashRecord('HeptaLocalStateAuthorityDatabaseGenesisHead', {
          databaseRole: instance.databaseRole,
          databaseInstanceId: instance.databaseInstanceId,
          schemaHash: instance.expectedPostSchemaHash,
        }),
        stateHash: hashRecord('HeptaLocalStateAuthorityDatabaseGenesisState', {
          databaseRole: instance.databaseRole,
          databaseInstanceId: instance.databaseInstanceId,
          sourceSha256: instance.sourceSha256,
          schemaHash: instance.expectedPostSchemaHash,
        }),
      }));
      const receipt = signOnline({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionReservationReceipt',
        status: 'autonomous_research_online_schema_transition_reserved',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord(
          'AutonomousResearchOnlineSchemaTransitionReserveRequest',
          request,
        ),
        reservationId: `schema:${crypto.randomUUID()}`,
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        stateDatabaseManifestHash: request.stateDatabaseManifestHash,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        authorityJournalSchemaContractId: request.authorityJournalSchemaContractId,
        authorityJournalSchemaHash: request.authorityJournalSchemaHash,
        markerSchemaHash: request.markerSchemaHash,
        transitionId: request.transitionId,
        instances: request.instances,
        databaseGenesis,
        issuedAt,
        expiresAt: expiry(issuedAt, request.requestedLeaseMs),
        allRegisteredMutationsFenced: true,
        quiescenceMode: 'scope-wide-no-new-reservations-until-finalize-or-expiry',
      });
      database.prepare(`
INSERT INTO authority_schema_transition(
  singleton,reserve_request_json,reservation_receipt_json
) VALUES(1,?,?);
`).run(JSON.stringify(request), JSON.stringify(receipt));
      database.prepare(`
UPDATE authority_metadata SET schema_transition_state='reserved' WHERE singleton=1;
`).run();
      return receipt;
    });
  }

  function finalizeSchemaTransition(request) {
    return transaction(database, () => {
      const row = database.prepare(
        'SELECT * FROM authority_schema_transition WHERE singleton=1',
      ).get();
      if (!row) fail('local_state_authority_schema_transition_reservation_required');
      const reservation = parseRecord(
        row.reservation_receipt_json,
        'local_state_authority_schema_transition_state_invalid',
      );
      assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(request, reservation);
      if (row.finalization_receipt_json) {
        const storedRequest = parseRecord(
          row.finalize_request_json,
          'local_state_authority_schema_transition_state_invalid',
        );
        if (JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          fail('local_state_authority_schema_transition_finalization_conflict');
        }
        return Object.freeze(parseRecord(
          row.finalization_receipt_json,
          'local_state_authority_schema_transition_state_invalid',
        ));
      }
      const current = metadata(database);
      const finalizedAt = isoNow(clock);
      const receipt = signOnline({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionFinalizationReceipt',
        status: 'autonomous_research_online_schema_transition_finalized',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord(
          'AutonomousResearchOnlineSchemaTransitionFinalizeRequest',
          request,
        ),
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        transitionId: request.transitionId,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        reservationId: request.reservationId,
        reservationReceiptHash: request.reservationReceiptHash,
        postInventoryHash: request.postInventoryHash,
        installations: request.installations,
        globalSequence: Number(current.global_sequence),
        globalHash: current.global_hash,
        finalizedAt,
        allRegisteredMutationsFencedThroughFinalize: true,
      });
      const insertHead = database.prepare(`
INSERT INTO authority_database_head(
  database_instance_id,database_role,sequence,hash,schema_hash,state_hash
) VALUES(?,?,?,?,?,?);
`);
      for (const genesis of reservation.databaseGenesis) {
        insertHead.run(
          genesis.databaseInstanceId,
          genesis.databaseRole,
          genesis.databaseSequence,
          genesis.databaseHash,
          genesis.schemaHash,
          genesis.stateHash,
        );
      }
      database.prepare(`
UPDATE authority_schema_transition
SET finalize_request_json=?,finalization_receipt_json=? WHERE singleton=1;
`).run(JSON.stringify(request), JSON.stringify(receipt));
      database.prepare(`
UPDATE authority_metadata SET schema_transition_state='finalized' WHERE singleton=1;
`).run();
      return receipt;
    });
  }

  function observeSchemaTransition(request) {
    assertAutonomousResearchOnlineSchemaTransitionObserveRequest(request, { trust });
    const row = database.prepare(
      'SELECT * FROM authority_schema_transition WHERE singleton=1',
    ).get();
    if (!row?.finalization_receipt_json) {
      fail('local_state_authority_schema_transition_not_finalized');
    }
    const finalization = parseRecord(
      row.finalization_receipt_json,
      'local_state_authority_schema_transition_state_invalid',
    );
    if (request.transitionId !== finalization.transitionId
      || request.transitionInventoryHash !== finalization.transitionInventoryHash
      || request.schemaBundleHash !== finalization.schemaBundleHash
      || request.finalizationReceiptHash
        !== autonomousResearchOnlineSchemaTransitionReceiptHash(finalization)
      || request.postInventoryHash !== finalization.postInventoryHash) {
      fail('local_state_authority_schema_transition_observation_mismatch');
    }
    const current = metadata(database);
    const observedAt = isoNow(clock);
    return signOnline({
      version: 1,
      kind: 'AutonomousResearchOnlineSchemaTransitionObservationReceipt',
      status: 'autonomous_research_online_schema_transition_observed_finalized',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchOnlineSchemaTransitionObserveRequest',
        request,
      ),
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      transitionId: request.transitionId,
      transitionInventoryHash: request.transitionInventoryHash,
      schemaBundleHash: request.schemaBundleHash,
      finalizationReceiptHash: request.finalizationReceiptHash,
      postInventoryHash: request.postInventoryHash,
      transitionState: 'finalized',
      globalSequence: Number(current.global_sequence),
      globalHash: current.global_hash,
      observedAt,
      expiresAt: expiry(observedAt, configuration.maximumObservationAgeMs),
    });
  }

  const mutationHandlers =
    createLocalAutonomousResearchStateAuthorityMutationHandlers({
      database,
      configuration,
      clock,
      trust,
      signOnline,
    });
  const backupHandlers =
    createLocalAutonomousResearchStateAuthorityBackupHandlers({
      database,
      configuration,
      clock,
      signBackup,
    });

  function handle(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      fail('local_state_authority_request_invalid');
    }
    switch (request.kind) {
      case 'AutonomousResearchOnlineSchemaTransitionReserveRequest':
        return reserveSchemaTransition(request);
      case 'AutonomousResearchOnlineSchemaTransitionFinalizeRequest':
        return finalizeSchemaTransition(request);
      case 'AutonomousResearchOnlineSchemaTransitionObserveRequest':
        return observeSchemaTransition(request);
      case 'AutonomousResearchOnlineMutationReserveRequest':
        return mutationHandlers.reserveMutation(request);
      case 'AutonomousResearchOnlineMutationFinalizeRequest':
        return mutationHandlers.finalizeMutation(request);
      case 'AutonomousResearchOnlineMutationAbortRequest':
        return mutationHandlers.abortMutation(request);
      case 'AutonomousResearchOnlineMutationResolutionRequest':
        return mutationHandlers.resolveMutation(request);
      case 'AutonomousResearchOnlineUnresolvedReservationListRequest':
        return mutationHandlers.listUnresolved(request);
      case 'AutonomousResearchOnlineMutationCurrentHeadRequest':
        return mutationHandlers.observeCurrentHead(request);
      case 'AutonomousResearchOnlineMutationActiveChallengeRequest':
        return mutationHandlers.challengeAuthority(request);
      case 'AutonomousResearchOnlineMutationScopeRequest':
        return mutationHandlers.observeScope(request);
      case 'AutonomousResearchStateBackupAuthorityReserveRequest':
        return backupHandlers.reserveBackup(request);
      case 'AutonomousResearchStateBackupAuthorityFinalizeRequest':
        return backupHandlers.finalizeBackup(request);
      case 'AutonomousResearchStateBackupAuthorityCurrentHeadRequest':
        return backupHandlers.observeBackupHead(request);
      case 'AutonomousResearchStateBackupAuthorityJournalRangeRequest':
        return backupHandlers.readBackupJournal(request);
      default:
        fail('local_state_authority_request_kind_unsupported');
    }
  }

  return Object.freeze({
    configuration,
    trust,
    handle,
    inspect() {
      const current = metadata(database);
      return Object.freeze({
        version: 1,
        kind: 'HeptaLocalAutonomousResearchStateAuthorityInspection',
        status: current.schema_transition_state === 'finalized'
          ? 'local_state_authority_ready'
          : 'local_state_authority_waiting_for_schema_transition',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        scopeId: configuration.scopeId,
        databaseScopeHash: configuration.databaseScopeHash,
        writerManifestHash: configuration.writerManifestHash,
        globalSequence: Number(current.global_sequence),
        globalHash: current.global_hash,
        databaseHeads: databaseHeads(database),
        unresolvedReservationCount: Number(database.prepare(`
SELECT count(*) AS count FROM authority_mutation WHERE status='reserved';
`).get().count),
        schemaTransitionState: current.schema_transition_state,
      });
    },
    close() {
      database.close();
    },
  });
}
