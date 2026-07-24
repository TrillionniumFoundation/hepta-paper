import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  createAutonomousResearchOnlineMutationAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import {
  reconcileAutonomousResearchOnlineMutationDatabaseStartup,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs';
import {
  reconcileAndRenewAutonomousResearchStateBackup,
  reconcileAutonomousResearchStatePendingMutations,
} from '../../paper-application/automation/autonomous-research-state-reconcile-and-renew.mjs';
import {
  buildExternallyFencedSqliteMutationFinalizeRequest,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-recovery.mjs';
import {
  fileSha256HashSync,
} from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  autonomousResearchOnlineMutationStateHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-18T08:30:00.000Z');
const INSTANCE = 'resident-instance:test';
const OPERATION = 'resident-instance.startup-reconciliation-test.v1';
const WRITER = 'writer:resident-instance-test';
const H = (label) => hashRecord('OnlineStartupReconciliationTest', { label });

function writerManifest() {
  const requiredDatabaseRoles = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort();
  const operations = requiredDatabaseRoles.map((databaseRole, index) => Object.freeze({
    operationId: databaseRole === 'resident-instance'
      ? OPERATION : `${databaseRole}.startup-reconciliation-placeholder.v1`,
    databaseRole,
    sourceFile: `paper-adapters/automation/startup-reconciliation-${databaseRole}.mjs`,
    entrypoint: `startupReconciliation${index}`,
    mutationClass: 'business-dml',
    protocolStatus: databaseRole === 'resident-instance'
      ? AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS
      : AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
    coordinatorIntegrated: databaseRole === 'resident-instance',
  }));
  return Object.freeze({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'online-startup-reconciliation-test-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze(requiredDatabaseRoles),
    writers: Object.freeze([Object.freeze({
      writerId: WRITER,
      databaseRoles: Object.freeze(['resident-instance']),
      operationIds: Object.freeze([OPERATION]),
      implementationHash: H('writer-implementation'),
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    })]),
    operations: Object.freeze(operations),
    coverage: Object.freeze({
      requiredRoleCount: requiredDatabaseRoles.length,
      coveredRoleCount: 1,
      coveredDatabaseRoles: Object.freeze(['resident-instance']),
      percent: Number((100 / requiredDatabaseRoles.length).toFixed(2)),
    }),
  });
}

function brokerSource({ privateKeyPem, statePath }) {
  const contractUrl = new URL(
    '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs',
    import.meta.url,
  ).href;
  const unresolvedUrl = new URL(
    '../../paper-domain/automation/autonomous-research-online-unresolved-reservation-contract.mjs',
    import.meta.url,
  ).href;
  const hashUrl = new URL('../../workflow-kernel/record-hash.mjs', import.meta.url).href;
  return `#!/usr/bin/node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { autonomousResearchOnlineMutationSignedPayload } from ${JSON.stringify(contractUrl)};
import { autonomousResearchOnlineUnresolvedReservationSetHash } from ${JSON.stringify(unresolvedUrl)};
import { hashRecord } from ${JSON.stringify(hashUrl)};
const privateKey = crypto.createPrivateKey(${JSON.stringify(privateKeyPem)});
const statePath = ${JSON.stringify(statePath)};
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const H = (kind, value) => hashRecord(kind, value);
const sign = (unsigned) => ({
  ...unsigned,
  signature: crypto.sign(
    null,
    Buffer.from(autonomousResearchOnlineMutationSignedPayload(unsigned), 'utf8'),
    privateKey,
  ).toString('base64'),
});
let receipt;
if (request.kind === 'AutonomousResearchOnlineMutationReserveRequest') {
  const { version, kind, requestedAt, requestedLeaseMs, ...mirrored } = request;
  const reservation = sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReservationReceipt',
    status: 'autonomous_research_online_mutation_reserved',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineMutationReserveRequest', request),
    reservationId: 'reservation:' + request.mutationAttemptId,
    ...mirrored,
    globalSequence: request.globalPreviousSequence + 1,
    globalHash: H('StartupBrokerGlobal', request.mutationAttemptId),
    databaseSequence: request.databasePreviousSequence + 1,
    databaseHash: H('StartupBrokerDatabase', request.mutationAttemptId),
    issuedAt: requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + requestedLeaseMs).toISOString(),
  });
  state.entries.push({ reserveRequest: request, reservation, status: 'reserved' });
  receipt = reservation;
} else if (request.kind === 'AutonomousResearchOnlineUnresolvedReservationListRequest') {
  const entries = state.entries
    .filter((entry) => entry.status === 'reserved')
    .map(({ reserveRequest, reservation }) => ({ reserveRequest, reservation }))
    .sort((left, right) => left.reserveRequest.mutationAttemptId
      .localeCompare(right.reserveRequest.mutationAttemptId));
  const { version, kind, ...mirrored } = request;
  receipt = sign({
    version: 1,
    kind: 'AutonomousResearchOnlineUnresolvedReservationListReceipt',
    status: 'autonomous_research_online_unresolved_reservations_observed',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineUnresolvedReservationListRequest', request),
    ...mirrored,
    unresolvedReservationCount: entries.length,
    unresolvedReservationSetHash: autonomousResearchOnlineUnresolvedReservationSetHash(entries),
    unresolvedReservations: entries,
    observedAt: request.requestedAt,
    expiresAt: new Date(Date.parse(request.requestedAt) + 60_000).toISOString(),
  });
} else if (request.kind === 'AutonomousResearchOnlineMutationAbortRequest') {
  state.abortCallCount += 1;
  const entry = state.entries.find((candidate) => (
    candidate.reservation.reservationId === request.reservationId
  ));
  if (!entry) process.exitCode = 65;
  else entry.status = 'aborted';
  const { version, kind, ...mirrored } = request;
  receipt = sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAbortReceipt',
    status: 'autonomous_research_online_mutation_aborted',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineMutationAbortRequest', request),
    ...mirrored,
    abortedAt: request.requestedAt,
  });
} else if (request.kind === 'AutonomousResearchOnlineMutationFinalizeRequest') {
  if (state.failFinalize) process.exitCode = 75;
  else {
    const entry = state.entries.find((candidate) => (
      candidate.reservation.reservationId === request.reservationId
    ));
    if (!entry) process.exitCode = 65;
    else entry.status = 'finalized';
    const { version, kind, committedAt, ...mirrored } = request;
    receipt = sign({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
      status: 'autonomous_research_online_mutation_finalized',
      authorityId: 'authority:test',
      keyId: 'key:test',
      requestHash: H('AutonomousResearchOnlineMutationFinalizeRequest', request),
      ...mirrored,
      sideEffectPermitHash: H('StartupBrokerPermit', request.reservationId),
      finalizedAt: committedAt,
    });
  }
} else {
  process.exitCode = 64;
}
fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
if (receipt) process.stdout.write(JSON.stringify(receipt) + '\\n');
`;
}

function configureAuthority(root, manifest, {
  databaseScopeHash = H('database-scope'),
} = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(root, 'authority-public-key.json');
  const authorityConfigurationPath = path.join(root, 'authority.json');
  const processConfigurationPath = path.join(root, 'authority-process.json');
  const commandPath = path.join(root, 'authority-broker.mjs');
  const statePath = path.join(root, 'authority-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    entries: [], abortCallCount: 0, failFinalize: false,
  }), {
    mode: 0o600,
  });
  fs.writeFileSync(publicKeyPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityPublicKey',
    authorityId: 'authority:test',
    keyId: 'key:test',
    algorithm: 'ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  }), { mode: 0o600 });
  fs.writeFileSync(authorityConfigurationPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityConfiguration',
    authorityId: 'authority:test',
    keyId: 'key:test',
    scopeId: 'scope:test',
    databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest),
    publicKeyPath,
    publicKeySha256: fileSha256HashSync(publicKeyPath),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  }), { mode: 0o600 });
  fs.writeFileSync(commandPath, brokerSource({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    statePath,
  }), { mode: 0o700 });
  fs.chmodSync(commandPath, 0o700);
  fs.writeFileSync(processConfigurationPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',
    authorityConfigurationPath,
    authorityConfigurationSha256: fileSha256HashSync(authorityConfigurationPath),
    commandPath,
    commandSha256: fileSha256HashSync(commandPath),
    fixedArguments: [],
    timeoutMs: 10_000,
  }), { mode: 0o600 });
  return Object.freeze({ processConfigurationPath, statePath });
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

function exactStartupInventory(revision = 1) {
  const instances = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map((role) => Object.freeze({
    role,
    instanceId: role === 'resident-instance' ? INSTANCE : role,
    sourceRelativePath: `autonomous-research/${role}.sqlite`,
    schemaContractId: `${role}-schema-v1`,
    schemaHash: H(`schema:${role}`),
    sourceSha256: H(`source:${role}:${revision}`),
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const base = {
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: 'autonomous_research_state_database_inventory_ready',
    manifestId: 'online-startup-reconciliation-test-state-v1',
    manifestHash: H('state-manifest'),
    databaseScopeHash: autonomousResearchStateDatabaseScopeHash(instances),
    instances: Object.freeze(instances),
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...base,
    inventoryHash: autonomousResearchStateDatabaseInventoryHash(base),
  });
}

function emptyStartupReconciliationReceipt(instance) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationUnresolvedReservationReconciliationReceipt',
    status: 'autonomous_research_online_mutation_unresolved_reservations_reconciled',
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    initialUnresolvedReservationCount: 0,
    recoveredReservationIds: Object.freeze([]),
    finalizedHeads: Object.freeze([]),
    abortedRemoteOnlyReservationIds: Object.freeze([]),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze([]),
    abortedRemoteOnlyAbortReceipts: Object.freeze([]),
    initialRemoteOnlyReservationCount: 0,
    remoteOnlyReservationCount: 0,
    businessDmlReplayed: false,
    confirmationReceiptHash: H(`confirmation:${instance.instanceId}`),
    remainingBlockers: Object.freeze([
      'autonomous_research_online_mutation_finalized_head_reconciliation_required',
      'autonomous_research_online_mutation_active_startup_head_challenge_required',
    ]),
    runtimeReady: false,
  });
}

function createDatabase(client) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON;');
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS.forEach((statement) => {
    database.exec(statement);
  });
  database.exec(`
CREATE TABLE startup_reconciliation_business_state(
  business_key TEXT PRIMARY KEY,
  applied_count INTEGER NOT NULL
) STRICT;
`);
  const schemaHash = exactSchemaHash(database);
  database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_metadata(
  singleton,schema_version,protocol,database_role,database_instance_id,
  schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
  genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
  genesis_database_hash,genesis_state_hash,provisioned_at
) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
    AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    'resident-instance',
    INSTANCE,
    'resident-instance-schema-v1',
    schemaHash,
    client.trust.databaseScopeHash,
    client.trust.writerManifestHash,
    0,
    H('global:genesis'),
    0,
    H('database:genesis'),
    H('state:genesis'),
    NOW.toISOString(),
  );
  return Object.freeze({ database, schemaHash });
}

function reserveRequest(
  schemaHash,
  operationId = OPERATION,
  changeset = Buffer.from('startup-reconciliation-changeset'),
  databaseScopeHash = H('database-scope'),
) {
  const changesetHash = hashBytes(changeset);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReserveRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: 'scope:test',
    databaseScopeHash,
    writerManifestHash: null,
    databaseRole: 'resident-instance',
    databaseInstanceId: INSTANCE,
    writerId: WRITER,
    operationId,
    codeProvenanceHash: H('writer-implementation'),
    mutationAttemptId: `mutation:${crypto.randomUUID()}`,
    globalPreviousSequence: 0,
    globalPreviousHash: H('global:genesis'),
    databasePreviousSequence: 0,
    databasePreviousHash: H('database:genesis'),
    schemaContractId: 'resident-instance-schema-v1',
    schemaHash,
    preStateHash: H('state:genesis'),
    postStateHash: autonomousResearchOnlineMutationStateHash({
      databaseRole: 'resident-instance',
      databaseInstanceId: INSTANCE,
      writerId: WRITER,
      operationId,
      schemaHash,
      previousStateHash: H('state:genesis'),
      changesetHash,
      databaseSequence: 1,
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
    }),
    changesetEncoding: 'base64',
    changesetBase64: changeset.toString('base64'),
    changesetByteLength: changeset.length,
    changesetHash,
    authorizationReceiptHashes: [],
    sideEffectReservationHashes: [],
    requestedAt: NOW.toISOString(),
    requestedLeaseMs: 60_000,
  });
}

function reserve(
  client,
  schemaHash,
  operationId = OPERATION,
  changeset = Buffer.from('startup-reconciliation-changeset'),
) {
  const request = Object.freeze({
    ...reserveRequest(
      schemaHash,
      operationId,
      changeset,
      client.trust.databaseScopeHash,
    ),
    writerManifestHash: client.trust.writerManifestHash,
  });
  const reservation = client.reserveMutation({ request, now: NOW });
  return Object.freeze({ request, reservation });
}

function insertMarker(database, request, reservation, {
  localMarkerHash = null,
} = {}) {
  const committedAt = new Date(NOW.getTime() + 1_000).toISOString();
  const finalRequest = buildExternallyFencedSqliteMutationFinalizeRequest(
    reservation,
    committedAt,
  );
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
    hashRecord('AutonomousResearchOnlineMutationReserveRequest', request),
    JSON.stringify(request),
    hashRecord('AutonomousResearchOnlineMutationReservationReceipt', reservation),
    JSON.stringify(reservation),
    localMarkerHash || finalRequest.localMarkerHash,
    committedAt,
  );
}

function setup(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-startup-reconcile-'));
  const manifest = writerManifest();
  const configured = configureAuthority(root, manifest, options);
  const client = createAutonomousResearchOnlineMutationAuthorityProcessClient({
    processConfigurationPath: configured.processConfigurationPath,
  });
  const created = createDatabase(client);
  return Object.freeze({ root, manifest, client, ...configured, ...created });
}

function reconcile(setupValue) {
  return reconcileAutonomousResearchOnlineMutationDatabaseStartup({
    database: setupValue.database,
    databaseRole: 'resident-instance',
    databaseInstanceId: INSTANCE,
    authorityClient: setupValue.client,
    writerManifest: setupValue.manifest,
    clock: { now: () => new Date(NOW.getTime() + 2_000) },
  });
}

test('startup safely aborts a remote-only reservation when the local head proves no commit', () => {
  const value = setup();
  try {
    // The list transports both the original request and signed reservation,
    // exercising a response that is over the old 4 MiB process ceiling.
    reserve(value.client, value.schemaHash, OPERATION, Buffer.alloc(3 * 1024 * 1024, 9));
    const receipt = reconcile(value);
    assert.equal(receipt.initialRemoteOnlyReservationCount, 1);
    assert.equal(receipt.remoteOnlyReservationCount, 0);
    assert.equal(receipt.businessDmlReplayed, false);
    assert.equal(receipt.abortedRemoteOnlyReservationIds.length, 1);
    assert.equal(receipt.abortedRemoteOnlyAbortReceiptHashes.length, 1);
    assert.equal(receipt.abortedRemoteOnlyAbortReceipts.length, 1);
    assert.equal(receipt.abortedRemoteOnlyAbortReceipts[0].kind,
      'AutonomousResearchOnlineMutationAbortReceipt');
    assert.match(receipt.abortedRemoteOnlyAbortReceipts[0].signature,
      /^[A-Za-z0-9+/]+={0,2}$/);
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(state.entries[0].status, 'aborted');
    assert.equal(state.abortCallCount, 1);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup treats a bound local marker as committed, finalizes it, and never aborts', () => {
  const value = setup();
  try {
    const pending = reserve(value.client, value.schemaHash);
    insertMarker(value.database, pending.request, pending.reservation);
    const receipt = reconcile(value);
    assert.deepEqual(receipt.recoveredReservationIds, [pending.reservation.reservationId]);
    assert.deepEqual(receipt.finalizedHeads, [{
      reservationId: pending.reservation.reservationId,
      globalSequence: pending.reservation.globalSequence,
      globalHash: pending.reservation.globalHash,
    }]);
    assert.deepEqual(receipt.abortedRemoteOnlyReservationIds, []);
    assert.deepEqual(receipt.abortedRemoteOnlyAbortReceiptHashes, []);
    assert.deepEqual(receipt.abortedRemoteOnlyAbortReceipts, []);
    assert.equal(receipt.remoteOnlyReservationCount, 0);
    assert.equal(receipt.businessDmlReplayed, false);
    assert.equal(receipt.runtimeReady, false);
    assert.deepEqual(receipt.remainingBlockers, [
      'autonomous_research_online_mutation_finalized_head_reconciliation_required',
      'autonomous_research_online_mutation_active_startup_head_challenge_required',
    ]);
    assert.equal(value.database.prepare(`
SELECT count(*) AS count FROM autonomous_research_online_mutation_finalization_receipt;
`).get().count, 1);
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(state.abortCallCount, 0);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('resident quiet-point reconciliation finalizes a committed marker without replaying business DML or renewing backup', async () => {
  const initialInventory = exactStartupInventory(1);
  const currentInventory = exactStartupInventory(2);
  const value = setup({ databaseScopeHash: initialInventory.databaseScopeHash });
  try {
    value.database.prepare(`
INSERT INTO startup_reconciliation_business_state(business_key,applied_count)
VALUES('quiet-point-committed-once',1);
`).run();
    const pending = reserve(value.client, value.schemaHash);
    insertMarker(value.database, pending.request, pending.reservation);
    let inventoryCalls = 0;
    const receipt = await reconcileAutonomousResearchStatePendingMutations({
      resolveInventory() {
        inventoryCalls += 1;
        return inventoryCalls === 1 ? initialInventory : currentInventory;
      },
      authorityTrust: value.client.trust,
      backupOnlineMutationTrust: value.client.trust,
      writerManifest: value.manifest,
      reconcileDatabaseStartup({ instance }) {
        if (instance.role === 'resident-instance') return reconcile(value);
        return emptyStartupReconciliationReceipt(instance);
      },
      inspectPendingFinalizations({ instance }) {
        const pendingFinalizationCount = instance.role === 'resident-instance'
          ? value.database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL;
`).get().count
          : 0;
        return Object.freeze({
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          pendingFinalizationCount,
        });
      },
      clock: { now: () => new Date(NOW.getTime() + 3_000) },
    });
    assert.equal(receipt.status,
      'autonomous_research_state_pending_reconciliation_complete');
    assert.equal(receipt.businessDmlReplayed, false);
    assert.equal(receipt.reconciledDatabaseCount,
      AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length);
    assert.equal(receipt.recoveredFinalizationCount, 1);
    assert.deepEqual(receipt.recovery.finalizedHeads, [{
      reservationId: pending.reservation.reservationId,
      globalSequence: pending.reservation.globalSequence,
      globalHash: pending.reservation.globalHash,
    }]);
    assert.deepEqual(value.database.prepare(`
SELECT business_key,applied_count
FROM startup_reconciliation_business_state;
`).all().map((row) => ({ ...row })), [
      { business_key: 'quiet-point-committed-once', applied_count: 1 },
    ]);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('resident quiet-point reconciliation aborts remote-only work with signed evidence and no business DML', async () => {
  const inventory = exactStartupInventory(1);
  const value = setup({ databaseScopeHash: inventory.databaseScopeHash });
  try {
    const reserved = reserve(value.client, value.schemaHash);
    const receipt = await reconcileAutonomousResearchStatePendingMutations({
      resolveInventory: () => inventory,
      authorityTrust: value.client.trust,
      backupOnlineMutationTrust: value.client.trust,
      writerManifest: value.manifest,
      reconcileDatabaseStartup({ instance }) {
        if (instance.role === 'resident-instance') return reconcile(value);
        return emptyStartupReconciliationReceipt(instance);
      },
      inspectPendingFinalizations({ instance }) {
        return Object.freeze({
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          pendingFinalizationCount: 0,
        });
      },
      clock: { now: () => new Date(NOW.getTime() + 3_000) },
    });
    assert.equal(receipt.status,
      'autonomous_research_state_pending_reconciliation_complete');
    assert.equal(receipt.businessDmlReplayed, false);
    assert.equal(receipt.recoveredFinalizationCount, 0);
    assert.equal(receipt.abortedRemoteOnlyReservationCount, 1);
    assert.deepEqual(receipt.recovery.abortedRemoteOnlyReservationIds, [
      reserved.reservation.reservationId,
    ]);
    assert.equal(receipt.recovery.abortedRemoteOnlyAbortReceipts.length, 1);
    assert.match(
      receipt.recovery.abortedRemoteOnlyAbortReceipts[0].signature,
      /^[A-Za-z0-9+/]+={0,2}$/,
    );
    assert.equal(value.database.prepare(`
SELECT count(*) AS count FROM startup_reconciliation_business_state;
`).get().count, 0);
    const authorityState = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(authorityState.entries[0].status, 'aborted');
    assert.equal(authorityState.abortCallCount, 1);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup blocks a signed unresolved reservation with an unknown operation', () => {
  const value = setup();
  try {
    reserve(value.client, value.schemaHash, 'resident-instance.unknown-operation.v1');
    assert.throws(
      () => reconcile(value),
      /autonomous_research_online_mutation_startup_manifest_binding_invalid/,
    );
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(state.entries[0].status, 'reserved');
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup rejects a broker list whose nested reservation signature was changed', () => {
  const value = setup();
  try {
    reserve(value.client, value.schemaHash);
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    state.entries[0].reservation.operationId = 'resident-instance.tampered.v1';
    fs.writeFileSync(value.statePath, JSON.stringify(state), { mode: 0o600 });
    assert.throws(
      () => reconcile(value),
      /autonomous_research_online_unresolved_reservation_list_receipt_invalid/,
    );
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup rejects more than one unresolved global reservation for one scope', () => {
  const value = setup();
  try {
    reserve(value.client, value.schemaHash);
    reserve(value.client, value.schemaHash);
    assert.throws(
      () => reconcile(value),
      /autonomous_research_online_unresolved_reservation_list_receipt_invalid/,
    );
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(state.entries.filter((entry) => entry.status === 'reserved').length, 2);
    assert.equal(state.abortCallCount, 0);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup never aborts a remote-only reservation after local schema drift', () => {
  const value = setup();
  try {
    reserve(value.client, value.schemaHash);
    value.database.exec('CREATE TABLE suspicious_unfenced_state(value TEXT) STRICT;');
    assert.throws(
      () => reconcile(value),
      /metadata_mismatch/,
    );
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(state.entries[0].status, 'reserved');
    assert.equal(state.abortCallCount, 0);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup never aborts an unresolved reservation with an ambiguous local commit marker', () => {
  const value = setup();
  try {
    const pending = reserve(value.client, value.schemaHash);
    insertMarker(value.database, pending.request, pending.reservation, {
      localMarkerHash: H('ambiguous-local-marker'),
    });
    assert.throws(
      () => reconcile(value),
      /externally_fenced_sqlite_mutation_recovery_marker_mismatch/,
    );
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(state.entries[0].status, 'reserved');
    assert.equal(state.abortCallCount, 0);
    assert.equal(value.database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_authority_marker;
`).get().count, 1);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup reconcile-and-renew finalizes a committed marker before backup without replaying business DML', async () => {
  const initialInventory = exactStartupInventory(1);
  const currentInventory = exactStartupInventory(2);
  const value = setup({ databaseScopeHash: initialInventory.databaseScopeHash });
  try {
    value.database.prepare(`
INSERT INTO startup_reconciliation_business_state(business_key,applied_count)
VALUES('committed-once',1);
`).run();
    const pending = reserve(value.client, value.schemaHash);
    insertMarker(value.database, pending.request, pending.reservation);
    let inventoryCalls = 0;
    let renewalCalls = 0;
    const receipt = await reconcileAndRenewAutonomousResearchStateBackup({
      resolveInventory() {
        inventoryCalls += 1;
        return inventoryCalls === 1 ? initialInventory : currentInventory;
      },
      authorityTrust: value.client.trust,
      backupOnlineMutationTrust: value.client.trust,
      writerManifest: value.manifest,
      reconcileDatabaseStartup({ instance }) {
        if (instance.role === 'resident-instance') return reconcile(value);
        return emptyStartupReconciliationReceipt(instance);
      },
      inspectPendingFinalizations({ instance }) {
        const pendingFinalizationCount = instance.role === 'resident-instance'
          ? value.database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL;
`).get().count
          : 0;
        return Object.freeze({
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          pendingFinalizationCount,
        });
      },
      renewBackup() {
        renewalCalls += 1;
        assert.equal(value.database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_finalization_receipt;
`).get().count, 1);
        return Object.freeze({
          status: 'autonomous_research_state_backup_renewal_complete',
          renewalReceiptHash: H('renewal'),
          blockers: Object.freeze([]),
        });
      },
      clock: { now: () => new Date(NOW.getTime() + 3_000) },
    });
    assert.equal(receipt.status,
      'autonomous_research_state_reconcile_and_renew_complete');
    assert.equal(receipt.recoveredFinalizationCount, 1);
    assert.equal(receipt.businessDmlReplayed, false);
    assert.equal(renewalCalls, 1);
    assert.deepEqual(value.database.prepare(`
SELECT business_key,applied_count
FROM startup_reconciliation_business_state;
`).all().map((row) => ({ ...row })), [
      { business_key: 'committed-once', applied_count: 1 },
    ]);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup reconcile-and-renew aborts a reserve-only crash before starting backup', async () => {
  const initialInventory = exactStartupInventory(1);
  const currentInventory = exactStartupInventory(2);
  const value = setup({ databaseScopeHash: initialInventory.databaseScopeHash });
  try {
    const reserved = reserve(value.client, value.schemaHash);
    let inventoryCalls = 0;
    let renewalCalls = 0;
    const receipt = await reconcileAndRenewAutonomousResearchStateBackup({
      resolveInventory() {
        inventoryCalls += 1;
        return inventoryCalls === 1 ? initialInventory : currentInventory;
      },
      authorityTrust: value.client.trust,
      backupOnlineMutationTrust: value.client.trust,
      writerManifest: value.manifest,
      reconcileDatabaseStartup({ instance }) {
        if (instance.role === 'resident-instance') return reconcile(value);
        return emptyStartupReconciliationReceipt(instance);
      },
      inspectPendingFinalizations({ instance }) {
        return Object.freeze({
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          pendingFinalizationCount: 0,
        });
      },
      renewBackup() {
        renewalCalls += 1;
        const authorityState = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
        assert.equal(authorityState.entries[0].status, 'aborted');
        assert.equal(authorityState.abortCallCount, 1);
        return Object.freeze({
          status: 'autonomous_research_state_backup_renewal_complete',
          renewalReceiptHash: H('reserve-only-renewal'),
          blockers: Object.freeze([]),
        });
      },
      clock: { now: () => new Date(NOW.getTime() + 3_000) },
    });
    assert.equal(receipt.status,
      'autonomous_research_state_reconcile_and_renew_complete');
    assert.equal(receipt.abortedRemoteOnlyReservationCount, 1);
    assert.equal(receipt.recoveredFinalizationCount, 0);
    assert.equal(receipt.businessDmlReplayed, false);
    assert.equal(renewalCalls, 1);
    const resident = receipt.reconciliations.find((entry) => (
      entry.databaseInstanceId === INSTANCE
    ));
    assert.deepEqual(resident.abortedRemoteOnlyReservationIds, [
      reserved.reservation.reservationId,
    ]);
    assert.equal(resident.abortedRemoteOnlyAbortReceiptHashes.length, 1);
    assert.equal(resident.abortedRemoteOnlyAbortReceipts.length, 1);
    assert.equal(resident.abortedRemoteOnlyAbortReceipts[0].reservationId,
      reserved.reservation.reservationId);
    assert.equal(value.database.prepare(`
SELECT count(*) AS count FROM startup_reconciliation_business_state;
`).get().count, 0);
    assert.equal(value.database.prepare(`
SELECT count(*) AS count FROM autonomous_research_online_mutation_authority_marker;
`).get().count, 0);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup reconcile-and-renew blocks before backup when committed-marker finalization fails', async () => {
  const initialInventory = exactStartupInventory(1);
  const currentInventory = exactStartupInventory(2);
  const value = setup({ databaseScopeHash: initialInventory.databaseScopeHash });
  try {
    value.database.prepare(`
INSERT INTO startup_reconciliation_business_state(business_key,applied_count)
VALUES('committed-once',1);
`).run();
    const pending = reserve(value.client, value.schemaHash);
    insertMarker(value.database, pending.request, pending.reservation);
    const authorityState = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    authorityState.failFinalize = true;
    fs.writeFileSync(value.statePath, JSON.stringify(authorityState), { mode: 0o600 });
    let inventoryCalls = 0;
    let renewalCalls = 0;
    const receipt = await reconcileAndRenewAutonomousResearchStateBackup({
      resolveInventory() {
        inventoryCalls += 1;
        return inventoryCalls === 1 ? initialInventory : currentInventory;
      },
      authorityTrust: value.client.trust,
      backupOnlineMutationTrust: value.client.trust,
      writerManifest: value.manifest,
      reconcileDatabaseStartup({ instance }) {
        if (instance.role === 'resident-instance') return reconcile(value);
        return emptyStartupReconciliationReceipt(instance);
      },
      inspectPendingFinalizations({ instance }) {
        return Object.freeze({
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          pendingFinalizationCount: 0,
        });
      },
      renewBackup() {
        renewalCalls += 1;
        return Object.freeze({
          status: 'autonomous_research_state_backup_renewal_complete',
          renewalReceiptHash: H('must-not-renew'),
        });
      },
      clock: { now: () => new Date(NOW.getTime() + 3_000) },
    });
    assert.equal(receipt.status,
      'autonomous_research_state_reconcile_and_renew_blocked');
    assert.equal(receipt.backupAttempted, false);
    assert.ok(receipt.blockers.includes(
      'autonomous_research_online_mutation_authority_process_failed',
    ));
    assert.equal(renewalCalls, 0);
    assert.equal(value.database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL;
`).get().count, 1);
    assert.deepEqual(value.database.prepare(`
SELECT business_key,applied_count
FROM startup_reconciliation_business_state;
`).all().map((row) => ({ ...row })), [
      { business_key: 'committed-once', applied_count: 1 },
    ]);
    const failedAuthorityState = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    assert.equal(failedAuthorityState.entries[0].status, 'reserved');
    assert.equal(failedAuthorityState.abortCallCount, 0);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
