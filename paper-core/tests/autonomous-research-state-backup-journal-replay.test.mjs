import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  autonomousResearchStateBackupAuthoritySignaturePayload,
  AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL,
} from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import {
  autonomousResearchOnlineMutationChangesetHash,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import {
  createAutonomousResearchStateBackup,
  drillAutonomousResearchStateRestore,
  resolveLatestAutonomousResearchStateBackupSources,
} from '../../paper-adapters/automation/autonomous-research-state-backup-repository.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  autonomousResearchOnlineMutationLocalMarkerHash,
  autonomousResearchOnlineMutationReceiptHash,
  autonomousResearchOnlineMutationSignedPayload,
  autonomousResearchOnlineMutationStateHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  verifyAutonomousResearchOnlineMutationFinalization,
  verifyAutonomousResearchOnlineMutationReservation,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  evaluateAutonomousResearchStateSafetyReadiness,
  unavailableAutonomousResearchOnlineAntiRollbackInspection,
} from '../../paper-domain/automation/autonomous-research-state-safety-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core/config/autonomous-research-state-databases.v1.json',
), 'utf8'));
const WRITER_MANIFEST_HASH = hashRecord('BackupReplayTestWriterManifest', { version: 1 });
const CODE_PROVENANCE_HASH = hashRecord('BackupReplayTestCodeProvenance', { version: 1 });
const GENESIS_GLOBAL_HASH = hashRecord('BackupReplayTestGlobalGenesis', { sequence: 0 });

function clockFixture() {
  let now = new Date('2026-07-20T00:00:00.000Z');
  return Object.freeze({
    now: () => new Date(now),
    advance(milliseconds = 1) { now = new Date(now.getTime() + milliseconds); },
  });
}

function quoted(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function createDatabaseSchema(candidate, definition) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(candidate);
  try {
    database.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE backup_replay_state(id TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
INSERT INTO backup_replay_state(id,value) VALUES('subject','snapshot');
`);
    for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
      database.exec(statement);
    }
    if (definition.role === 'resident-instance') {
      for (const statement of AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS) {
        database.exec(statement);
      }
    }
    const alreadyCreated = new Set(database.prepare(`
SELECT type || ':' || name AS object_id FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%';
`).all().map((row) => row.object_id));
    for (const objectId of definition.requiredSchemaObjects) {
      if (alreadyCreated.has(objectId)) continue;
      const [type, name] = objectId.split(':');
      if (type === 'table') {
        database.exec(`CREATE TABLE ${quoted(name)}(id TEXT PRIMARY KEY) STRICT;`);
      } else if (type === 'index') {
        database.exec(`CREATE INDEX ${quoted(name)} ON backup_replay_state(value);`);
      } else if (type === 'trigger') {
        database.exec(`CREATE TRIGGER ${quoted(name)} BEFORE UPDATE ON backup_replay_state
BEGIN SELECT 1; END;`);
      } else if (type === 'view') {
        database.exec(`CREATE VIEW ${quoted(name)} AS SELECT id,value FROM backup_replay_state;`);
      } else {
        throw new Error(`backup_replay_test_schema_object_invalid:${objectId}`);
      }
    }
    database.exec('PRAGMA user_version=1;');
  } finally {
    database.close();
  }
}

function exactSchemaHash(database) {
  const rows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-backup-journal-'));
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeRoot, 'paper-automation.sqlite'), '', { mode: 0o600 });
  for (const definition of stateDatabaseManifest.databases) {
    createDatabaseSchema(path.join(runtimeRoot, definition.relativePath), definition);
  }
  const initial = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(initial.status, 'autonomous_research_state_database_inventory_ready');
  const databaseHeads = new Map();
  for (const instance of initial.instances) {
    const database = new DatabaseSync(path.join(runtimeRoot, instance.sourceRelativePath));
    const schemaHash = exactSchemaHash(database);
    const databaseHash = hashRecord('BackupReplayTestDatabaseGenesis', {
      instanceId: instance.instanceId,
    });
    const stateHash = hashRecord('BackupReplayTestStateGenesis', {
      instanceId: instance.instanceId,
    });
    database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_metadata(
  singleton,schema_version,protocol,database_role,database_instance_id,
  schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
  genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
  genesis_database_hash,genesis_state_hash,provisioned_at
) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
      AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
      instance.role,
      instance.instanceId,
      instance.schemaContractId,
      schemaHash,
      initial.databaseScopeHash,
      WRITER_MANIFEST_HASH,
      0,
      GENESIS_GLOBAL_HASH,
      0,
      databaseHash,
      stateHash,
      '2026-07-19T23:59:00.000Z',
    );
    database.close();
    databaseHeads.set(instance.instanceId, Object.freeze({
      databaseRole: instance.role,
      databaseInstanceId: instance.instanceId,
      sequence: 0,
      hash: databaseHash,
      schemaHash,
      stateHash,
    }));
  }
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return Object.freeze({ parent, runtimeRoot, databaseHeads });
}

function onlineAuthorityFixture(databaseScopeHash) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'online-mutation-authority',
    keyId: 'online-mutation-key-1',
    scopeId: 'backup-replay-scope',
    databaseScopeHash,
    writerManifestHash: WRITER_MANIFEST_HASH,
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  const sign = (payload) => Object.freeze({
    ...payload,
    signature: crypto.sign(
      null,
      Buffer.from(autonomousResearchOnlineMutationSignedPayload(payload), 'utf8'),
      privateKey,
    ).toString('base64'),
  });
  const verifySignature = (receipt) => crypto.verify(
    null,
    Buffer.from(autonomousResearchOnlineMutationSignedPayload(receipt), 'utf8'),
    publicKey,
    Buffer.from(receipt.signature, 'base64'),
  );
  return Object.freeze({
    trust,
    sign,
    verifier: Object.freeze({
      trust,
      verifyReservation(input) {
        return verifyAutonomousResearchOnlineMutationReservation({
          ...input,
          trust,
          verifySignature,
          hashChangesetBase64: autonomousResearchOnlineMutationChangesetHash,
        });
      },
      verifyFinalization(input) {
        return verifyAutonomousResearchOnlineMutationFinalization({
          ...input,
          trust,
          verifySignature,
        });
      },
    }),
  });
}

function insertMarker(database, request, reservation, finalizeRequest, finalization) {
  database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_marker(
  reservation_id,database_role,database_instance_id,writer_id,operation_id,
  global_sequence,global_hash,database_sequence,database_hash,schema_hash,
  pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,
  reserve_request_json,reservation_receipt_hash,reservation_receipt_json,
  local_marker_hash,committed_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
    reservation.reservationId,
    reservation.databaseRole,
    reservation.databaseInstanceId,
    reservation.writerId,
    reservation.operationId,
    reservation.globalSequence,
    reservation.globalHash,
    reservation.databaseSequence,
    reservation.databaseHash,
    reservation.schemaHash,
    reservation.preStateHash,
    reservation.postStateHash,
    reservation.changesetHash,
    reservation.requestHash,
    JSON.stringify(request),
    autonomousResearchOnlineMutationReceiptHash(reservation),
    JSON.stringify(reservation),
    finalizeRequest.localMarkerHash,
    finalizeRequest.committedAt,
  );
  database.prepare(`
INSERT INTO autonomous_research_online_mutation_finalization_receipt(
  reservation_id,finalization_receipt_hash,finalization_receipt_json,
  side_effect_permit_hash,finalized_at,recorded_at
) VALUES(?,?,?,?,?,?);
`).run(
    finalization.reservationId,
    autonomousResearchOnlineMutationReceiptHash(finalization),
    JSON.stringify(finalization),
    finalization.sideEffectPermitHash,
    finalization.finalizedAt,
    finalization.finalizedAt,
  );
}

function appendMutation({
  runtimeRoot,
  instance,
  databaseHead,
  globalHead,
  onlineAuthority,
  clock,
  ordinal,
}) {
  const database = new DatabaseSync(path.join(runtimeRoot, instance.sourceRelativePath));
  database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  const session = database.createSession();
  database.prepare('UPDATE backup_replay_state SET value=? WHERE id=?;')
    .run(`mutation-${ordinal}`, 'subject');
  const changeset = Buffer.from(session.changeset());
  const changesetBase64 = changeset.toString('base64');
  const changesetHash = autonomousResearchOnlineMutationChangesetHash(changesetBase64);
  const databaseSequence = databaseHead.sequence + 1;
  const postStateHash = autonomousResearchOnlineMutationStateHash({
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    writerId: 'backup-replay-test-writer',
    operationId: 'backup-replay-test-update',
    schemaHash: instance.schemaHash,
    previousStateHash: databaseHead.stateHash,
    changesetHash,
    databaseSequence,
    authorizationReceiptHashes: [],
    sideEffectReservationHashes: [],
  });
  const request = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReserveRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: onlineAuthority.trust.scopeId,
    databaseScopeHash: onlineAuthority.trust.databaseScopeHash,
    writerManifestHash: onlineAuthority.trust.writerManifestHash,
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    writerId: 'backup-replay-test-writer',
    operationId: 'backup-replay-test-update',
    codeProvenanceHash: CODE_PROVENANCE_HASH,
    mutationAttemptId: `backup-replay-attempt-${ordinal}`,
    globalPreviousSequence: globalHead.sequence,
    globalPreviousHash: globalHead.hash,
    databasePreviousSequence: databaseHead.sequence,
    databasePreviousHash: databaseHead.hash,
    schemaContractId: instance.schemaContractId,
    schemaHash: instance.schemaHash,
    preStateHash: databaseHead.stateHash,
    postStateHash,
    changesetEncoding: 'base64',
    changesetBase64,
    changesetByteLength: changeset.length,
    changesetHash,
    authorizationReceiptHashes: [],
    sideEffectReservationHashes: [],
    requestedAt: clock.now().toISOString(),
    requestedLeaseMs: 60_000,
  });
  const globalSequence = globalHead.sequence + 1;
  const reservation = onlineAuthority.sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReservationReceipt',
    status: 'autonomous_research_online_mutation_reserved',
    authorityId: onlineAuthority.trust.authorityId,
    keyId: onlineAuthority.trust.keyId,
    requestHash: hashRecord('AutonomousResearchOnlineMutationReserveRequest', request),
    reservationId: `backup-replay-reservation-${ordinal}`,
    protocol: request.protocol,
    scopeId: request.scopeId,
    databaseScopeHash: request.databaseScopeHash,
    writerManifestHash: request.writerManifestHash,
    databaseRole: request.databaseRole,
    databaseInstanceId: request.databaseInstanceId,
    writerId: request.writerId,
    operationId: request.operationId,
    codeProvenanceHash: request.codeProvenanceHash,
    mutationAttemptId: request.mutationAttemptId,
    globalPreviousSequence: request.globalPreviousSequence,
    globalPreviousHash: request.globalPreviousHash,
    globalSequence,
    globalHash: hashRecord('BackupReplayTestGlobalHead', { globalSequence, ordinal }),
    databasePreviousSequence: request.databasePreviousSequence,
    databasePreviousHash: request.databasePreviousHash,
    databaseSequence,
    databaseHash: hashRecord('BackupReplayTestDatabaseHead', {
      instanceId: instance.instanceId,
      databaseSequence,
      ordinal,
    }),
    schemaContractId: request.schemaContractId,
    schemaHash: request.schemaHash,
    preStateHash: request.preStateHash,
    postStateHash: request.postStateHash,
    changesetEncoding: request.changesetEncoding,
    changesetBase64: request.changesetBase64,
    changesetByteLength: request.changesetByteLength,
    changesetHash: request.changesetHash,
    authorizationReceiptHashes: request.authorizationReceiptHashes,
    sideEffectReservationHashes: request.sideEffectReservationHashes,
    issuedAt: clock.now().toISOString(),
    expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
  });
  const committedAt = clock.now().toISOString();
  const finalizeRequest = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationFinalizeRequest',
    protocol: reservation.protocol,
    scopeId: reservation.scopeId,
    databaseScopeHash: reservation.databaseScopeHash,
    writerManifestHash: reservation.writerManifestHash,
    reservationId: reservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineMutationReceiptHash(reservation),
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    schemaHash: reservation.schemaHash,
    postStateHash: reservation.postStateHash,
    changesetHash: reservation.changesetHash,
    localMarkerHash: autonomousResearchOnlineMutationLocalMarkerHash({ reservation, committedAt }),
    authorizationReceiptHashes: reservation.authorizationReceiptHashes,
    sideEffectReservationHashes: reservation.sideEffectReservationHashes,
    committedAt,
  });
  const finalization = onlineAuthority.sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
    status: 'autonomous_research_online_mutation_finalized',
    authorityId: onlineAuthority.trust.authorityId,
    keyId: onlineAuthority.trust.keyId,
    requestHash: hashRecord('AutonomousResearchOnlineMutationFinalizeRequest', finalizeRequest),
    reservationId: reservation.reservationId,
    reservationReceiptHash: finalizeRequest.reservationReceiptHash,
    protocol: reservation.protocol,
    scopeId: reservation.scopeId,
    databaseScopeHash: reservation.databaseScopeHash,
    writerManifestHash: reservation.writerManifestHash,
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    schemaHash: reservation.schemaHash,
    postStateHash: reservation.postStateHash,
    changesetHash: reservation.changesetHash,
    localMarkerHash: finalizeRequest.localMarkerHash,
    authorizationReceiptHashes: reservation.authorizationReceiptHashes,
    sideEffectReservationHashes: reservation.sideEffectReservationHashes,
    sideEffectPermitHash: hashRecord('BackupReplayTestSideEffectPermit', { ordinal }),
    finalizedAt: clock.now().toISOString(),
  });
  insertMarker(database, request, reservation, finalizeRequest, finalization);
  database.exec('COMMIT;');
  database.close();
  return Object.freeze({
    entry: Object.freeze({
      reserveRequest: request,
      reservationReceipt: reservation,
      finalizeRequest,
      finalizationReceipt: finalization,
    }),
    globalHead: Object.freeze({ sequence: reservation.globalSequence, hash: reservation.globalHash }),
    databaseHead: Object.freeze({
      databaseRole: reservation.databaseRole,
      databaseInstanceId: reservation.databaseInstanceId,
      sequence: reservation.databaseSequence,
      hash: reservation.databaseHash,
      schemaHash: reservation.schemaHash,
      stateHash: reservation.postStateHash,
    }),
  });
}

function backupAuthorityFixture(clock, onlineAuthority, databaseHeads) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityTrust',
    authorityId: 'backup-authority',
    keyId: 'backup-key-1',
    publicKey,
    maximumReservationLeaseMs: 60_000,
    maximumHeadObservationAgeMs: 60_000,
  });
  let head = Object.freeze({ sequence: 0, hash: GENESIS_GLOBAL_HASH });
  let reservation = null;
  let entries = Object.freeze([]);
  let transform = (value) => value;
  const sign = (payload) => Object.freeze({
    ...payload,
    signature: crypto.sign(
      null,
      Buffer.from(autonomousResearchStateBackupAuthoritySignaturePayload(payload), 'utf8'),
      privateKey,
    ).toString('base64'),
  });
  const client = Object.freeze({
    reserveSnapshot(request) {
      reservation = sign({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityReservation',
        status: 'autonomous_research_state_backup_authority_reserved',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchStateBackupAuthorityReserveRequest', request),
        reservationId: 'backup-reservation-1',
        inventoryHash: request.inventoryHash,
        databaseScopeHash: request.databaseScopeHash,
        databaseInstanceIds: request.databaseInstanceIds,
        headSequence: head.sequence,
        headHash: head.hash,
        issuedAt: clock.now().toISOString(),
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
        mutationFenceProtocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
        allRegisteredMutationsFenced: true,
      });
      return reservation;
    },
    finalizeSnapshot(request) {
      return sign({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityFinalization',
        status: 'autonomous_research_state_backup_authority_finalized',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchStateBackupAuthorityFinalizeRequest', request),
        reservationId: reservation.reservationId,
        inventoryHash: reservation.inventoryHash,
        databaseScopeHash: reservation.databaseScopeHash,
        snapshotContentHash: request.snapshotContentHash,
        headSequence: reservation.headSequence,
        headHash: reservation.headHash,
        finalizedAt: clock.now().toISOString(),
        allRegisteredMutationsFencedThroughFinalize: true,
      });
    },
    observeCurrentHead(request) {
      return sign({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityCurrentHead',
        status: 'autonomous_research_state_backup_authority_head_observed',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchStateBackupAuthorityCurrentHeadRequest', request),
        reservationId: request.reservationId,
        databaseScopeHash: request.databaseScopeHash,
        headSequence: head.sequence,
        headHash: head.hash,
        observedAt: clock.now().toISOString(),
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
        mutationFenceProtocol: 'external-linearizable-restore-validation-v1',
        allRegisteredMutationsFenced: true,
      });
    },
    readFinalizedMutationJournal(request) {
      const transformed = transform(entries.map((entry) => structuredClone(entry)));
      return sign({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityJournalRange',
        status: 'autonomous_research_state_backup_authority_journal_range_complete',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchStateBackupAuthorityJournalRangeRequest', request),
        reservationId: request.reservationId,
        databaseScopeHash: request.databaseScopeHash,
        snapshotContentHash: request.snapshotContentHash,
        onlineAuthorityId: onlineAuthority.trust.authorityId,
        onlineKeyId: onlineAuthority.trust.keyId,
        scopeId: onlineAuthority.trust.scopeId,
        writerManifestHash: onlineAuthority.trust.writerManifestHash,
        fromGlobalSequence: request.fromGlobalSequence,
        fromGlobalHash: request.fromGlobalHash,
        toGlobalSequence: request.toGlobalSequence,
        toGlobalHash: request.toGlobalHash,
        databaseHeads: [...databaseHeads.values()]
          .sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId)),
        entries: transformed,
        observedAt: clock.now().toISOString(),
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
        mutationFenceProtocol: AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL,
        completeFinalizedMutationJournal: true,
      });
    },
  });
  return Object.freeze({
    trust,
    client,
    publishJournal(nextEntries, nextHead) {
      entries = Object.freeze([...nextEntries]);
      head = Object.freeze({ ...nextHead });
    },
    setTransform(nextTransform) { transform = nextTransform; },
  });
}

async function preparedJournalFixture(t) {
  const setup = fixture(t);
  const clock = clockFixture();
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const onlineAuthority = onlineAuthorityFixture(inventory.databaseScopeHash);
  const databaseHeads = new Map(setup.databaseHeads);
  const backupAuthority = backupAuthorityFixture(clock, onlineAuthority, databaseHeads);
  const backupRoot = path.join(setup.runtimeRoot, 'backups/autonomous-research-state');
  const backup = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    backupRoot,
    stateDatabaseManifest,
    authorityClient: backupAuthority.client,
    authorityTrust: backupAuthority.trust,
    onlineMutationVerifier: onlineAuthority.verifier,
    clock,
  });
  assert.equal(backup.status, 'autonomous_research_state_backup_recorded');
  const mutableInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const targets = [
    mutableInventory.instances.find((entry) => entry.role === 'native-store'),
    mutableInventory.instances.find((entry) => entry.role === 'topic-producer'),
    mutableInventory.instances.find((entry) => entry.role === 'native-store'),
  ];
  const entries = [];
  let globalHead = Object.freeze({ sequence: 0, hash: GENESIS_GLOBAL_HASH });
  for (const [index, instance] of targets.entries()) {
    clock.advance(10);
    const result = appendMutation({
      runtimeRoot: setup.runtimeRoot,
      instance,
      databaseHead: databaseHeads.get(instance.instanceId),
      globalHead,
      onlineAuthority,
      clock,
      ordinal: index + 1,
    });
    entries.push(result.entry);
    globalHead = result.globalHead;
    databaseHeads.set(instance.instanceId, result.databaseHead);
  }
  backupAuthority.publishJournal(entries, globalHead);
  return {
    ...setup,
    clock,
    onlineAuthority,
    backupAuthority,
    backupRoot,
    backup,
    entries,
  };
}

test('restore drill replays a complete signed finalized journal across databases', async (t) => {
  const setup = await preparedJournalFixture(t);
  const productionValuesBefore = stateDatabaseManifest.databases.map((definition) => {
    const database = new DatabaseSync(path.join(setup.runtimeRoot, definition.relativePath), {
      readOnly: true,
    });
    const value = database.prepare('SELECT value FROM backup_replay_state WHERE id=?;')
      .get('subject').value;
    database.close();
    return value;
  });
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.backup.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.backupAuthority.client,
    authorityTrust: setup.backupAuthority.trust,
    onlineMutationVerifier: setup.onlineAuthority.verifier,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_passed');
  assert.equal(drill.journalReplayMutationCount, 3);
  assert.equal(drill.completeFinalizedMutationJournal, true);
  assert.equal(
    drill.recoverabilityProtocol,
    AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL,
  );
  assert.equal(drill.recoveredDatabaseHeads.length, 10);
  const sources = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityTrust: setup.backupAuthority.trust,
    onlineMutationVerifier: setup.onlineAuthority.verifier,
  });
  assert.equal(sources.status, 'autonomous_research_state_backup_sources_ready');
  assert.equal(sources.completeFinalizedMutationJournal, true);
  assert.equal(sources.journalReplayMutationCount, 3);
  const currentInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.notEqual(currentInventory.inventoryHash, sources.inventoryHash);
  const stateSafety = evaluateAutonomousResearchStateSafetyReadiness({
    inventory: currentInventory,
    latestRestoreDrill: sources,
    onlineAntiRollback: unavailableAutonomousResearchOnlineAntiRollbackInspection(),
    now: setup.clock.now(),
  });
  assert.equal(stateSafety.latestValidRestoreDrillReady, true);
  assert.equal(stateSafety.blockers.includes(
    'autonomous_research_state_restore_current_inventory_binding_required',
  ), false);
  const productionValuesAfter = stateDatabaseManifest.databases.map((definition) => {
    const database = new DatabaseSync(path.join(setup.runtimeRoot, definition.relativePath), {
      readOnly: true,
    });
    const value = database.prepare('SELECT value FROM backup_replay_state WHERE id=?;')
      .get('subject').value;
    database.close();
    return value;
  });
  assert.deepEqual(productionValuesAfter, productionValuesBefore);
});

test('snapshot creation rejects a marker row that no longer matches its signed receipts', async (t) => {
  const setup = fixture(t);
  const clock = clockFixture();
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const onlineAuthority = onlineAuthorityFixture(inventory.databaseScopeHash);
  const databaseHeads = new Map(setup.databaseHeads);
  const backupAuthority = backupAuthorityFixture(clock, onlineAuthority, databaseHeads);
  const target = inventory.instances.find((entry) => entry.role === 'native-store');
  const mutation = appendMutation({
    runtimeRoot: setup.runtimeRoot,
    instance: target,
    databaseHead: databaseHeads.get(target.instanceId),
    globalHead: Object.freeze({ sequence: 0, hash: GENESIS_GLOBAL_HASH }),
    onlineAuthority,
    clock,
    ordinal: 1,
  });
  databaseHeads.set(target.instanceId, mutation.databaseHead);
  backupAuthority.publishJournal([mutation.entry], mutation.globalHead);
  const database = new DatabaseSync(path.join(setup.runtimeRoot, target.sourceRelativePath));
  const markerNoUpdate = AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS.find(
    (statement) => statement.includes('CREATE TRIGGER autonomous_research_online_mutation_marker_no_update'),
  );
  database.exec('DROP TRIGGER autonomous_research_online_mutation_marker_no_update;');
  database.prepare(`
UPDATE autonomous_research_online_mutation_authority_marker
SET global_hash=? WHERE reservation_id=?;
`).run(hashRecord('TamperedMarkerGlobalHash', { tampered: true }), 'backup-replay-reservation-1');
  database.exec(markerNoUpdate);
  database.close();
  const backup = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: path.join(setup.runtimeRoot, 'backups/autonomous-research-state'),
    stateDatabaseManifest,
    authorityClient: backupAuthority.client,
    authorityTrust: backupAuthority.trust,
    onlineMutationVerifier: onlineAuthority.verifier,
    clock,
  });
  assert.equal(backup.status, 'autonomous_research_state_backup_blocked');
  assert.ok(backup.blockers.includes(
    'autonomous_research_state_restore_snapshot_authority_receipt_invalid',
  ));
});

for (const [label, transform, blocker] of [
  [
    'missing',
    (entries) => entries.slice(0, -1),
    'autonomous_research_state_restore_authority_journal_range_invalid',
  ],
  [
    'reordered',
    (entries) => [entries[1], entries[0], entries[2]],
    'autonomous_research_state_restore_journal_continuity_invalid',
  ],
  [
    'duplicate',
    (entries) => [entries[0], entries[0], entries[2]],
    'autonomous_research_state_restore_journal_continuity_invalid',
  ],
  [
    'tampered changeset',
    (entries) => {
      entries[1].reserveRequest.changesetBase64 = entries[0].reserveRequest.changesetBase64;
      return entries;
    },
    'autonomous_research_state_restore_journal_reservation_invalid',
  ],
]) {
  test(`restore drill blocks a ${label} finalized journal without touching production`, async (t) => {
    const setup = await preparedJournalFixture(t);
    setup.backupAuthority.setTransform(transform);
    const drill = await drillAutonomousResearchStateRestore({
      bundlePath: setup.backup.bundlePath,
      backupRoot: setup.backupRoot,
      stateDatabaseManifest,
      authorityClient: setup.backupAuthority.client,
      authorityTrust: setup.backupAuthority.trust,
      onlineMutationVerifier: setup.onlineAuthority.verifier,
      clock: setup.clock,
    });
    assert.equal(drill.status, 'autonomous_research_state_restore_drill_blocked');
    assert.ok(drill.blockers.includes(blocker), JSON.stringify(drill.blockers));
  });
}
