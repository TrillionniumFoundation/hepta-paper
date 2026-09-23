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
  inspectAutonomousResearchOnlineFinalizedDatabaseHead,
} from '../../paper-adapters/automation/autonomous-research-online-finalized-head-inspection.mjs';
import {
  createAutonomousResearchOnlineMutationAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import {
  buildExternallyFencedSqliteMutationFinalizeRequest,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-recovery.mjs';
import { fileSha256HashSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  autonomousResearchOnlineMutationReceiptHash,
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

const NOW = new Date('2026-07-18T09:00:00.000Z');
const INSTANCE = 'resident-instance:test';
const OPERATION = 'resident-instance.finalized-head-test.v1';
const WRITER = 'writer:resident-finalized-head-test';
const H = (label) => hashRecord('OnlineFinalizedHeadInspectionTest', { label });

function writerManifest() {
  const requiredDatabaseRoles = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort();
  const operations = requiredDatabaseRoles.map((databaseRole, index) => Object.freeze({
    operationId: databaseRole === 'resident-instance'
      ? OPERATION : `${databaseRole}.finalized-head-placeholder.v1`,
    databaseRole,
    sourceFile: `paper-adapters/automation/finalized-head-${databaseRole}.mjs`,
    entrypoint: `finalizedHead${index}`,
    mutationClass: 'business-dml',
    protocolStatus: databaseRole === 'resident-instance'
      ? AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS
      : AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
    coordinatorIntegrated: databaseRole === 'resident-instance',
  }));
  return Object.freeze({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'online-finalized-head-inspection-test-v1',
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

function exactSchemaHash(database) {
  const rows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

function buildInventory(targetSchemaHash) {
  const instances = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map((role) => Object.freeze({
    instanceId: role === 'resident-instance' ? INSTANCE : role,
    role,
    paperId: null,
    sourceRelativePath: `autonomous-research/${role}.sqlite`,
    schemaContractId: role === 'resident-instance'
      ? 'resident-instance-schema-v1' : `${role}-schema-v1`,
    missingSchemaObjects: Object.freeze([]),
    sourceFileIdentity: Object.freeze({ identity: role }),
    sourceSha256: H(`source:${role}`),
    walFileIdentity: null,
    walSha256: null,
    quickCheck: 'ok',
    foreignKeyViolationCount: 0,
    schemaHash: role === 'resident-instance' ? targetSchemaHash : H(`schema:${role}`),
    schemaObjects: Object.freeze([]),
    userVersion: 0,
    applicationId: 0,
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: 'autonomous_research_state_database_inventory_ready',
    manifestId: 'finalized-head-test-state-databases',
    manifestHash: H('state-database-manifest'),
    databaseScopeHash: autonomousResearchStateDatabaseScopeHash(instances),
    instances: Object.freeze(instances),
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...base,
    inventoryHash: autonomousResearchStateDatabaseInventoryHash(base),
  });
}

function brokerSource({ privateKeyPem, statePath }) {
  const contractUrl = new URL(
    '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs',
    import.meta.url,
  ).href;
  const hashUrl = new URL('../../workflow-kernel/record-hash.mjs', import.meta.url).href;
  return `#!/usr/bin/node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { autonomousResearchOnlineMutationSignedPayload } from ${JSON.stringify(contractUrl)};
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
    globalHash: H('FinalizedHeadBrokerGlobal', request.mutationAttemptId),
    databaseSequence: request.databasePreviousSequence + 1,
    databaseHash: H('FinalizedHeadBrokerDatabase', request.mutationAttemptId),
    issuedAt: requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + requestedLeaseMs).toISOString(),
  });
  state.entries.push({ reserveRequest: request, reservation, status: 'reserved' });
  receipt = reservation;
} else if (request.kind === 'AutonomousResearchOnlineMutationFinalizeRequest') {
  const entry = state.entries.find((candidate) => (
    candidate.reservation.reservationId === request.reservationId
  ));
  if (!entry) process.exitCode = 65;
  else {
    entry.status = 'finalized';
    const head = state.databaseHeads.find((candidate) => (
      candidate.databaseInstanceId === request.databaseInstanceId
    ));
    head.sequence = request.databaseSequence;
    head.hash = request.databaseHash;
    head.schemaHash = request.schemaHash;
    head.stateHash = request.postStateHash;
    state.globalSequence = request.globalSequence;
    state.globalHash = request.globalHash;
  }
  const { version, kind, committedAt, ...mirrored } = request;
  receipt = sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
    status: 'autonomous_research_online_mutation_finalized',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineMutationFinalizeRequest', request),
    ...mirrored,
    sideEffectPermitHash: H('FinalizedHeadBrokerPermit', request.reservationId),
    finalizedAt: committedAt,
  });
} else if (request.kind === 'AutonomousResearchOnlineMutationCurrentHeadRequest') {
  receipt = sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationCurrentHeadReceipt',
    status: 'autonomous_research_online_mutation_current_head_observed',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineMutationCurrentHeadRequest', request),
    protocol: request.protocol,
    scopeId: request.scopeId,
    databaseScopeHash: request.databaseScopeHash,
    writerManifestHash: request.writerManifestHash,
    globalSequence: state.globalSequence,
    globalHash: state.globalHash,
    databaseHeads: state.databaseHeads,
    unresolvedReservationCount: 0,
    observedAt: request.requestedAt,
    expiresAt: new Date(Date.parse(request.requestedAt) + 60_000).toISOString(),
  });
} else {
  process.exitCode = 64;
}
fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
if (receipt) process.stdout.write(JSON.stringify(receipt) + '\\n');
`;
}

function configureAuthority(root, manifest, inventory, databaseHeads) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(root, 'authority-public-key.json');
  const authorityConfigurationPath = path.join(root, 'authority.json');
  const processConfigurationPath = path.join(root, 'authority-process.json');
  const commandPath = path.join(root, 'authority-broker.mjs');
  const statePath = path.join(root, 'authority-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    entries: [],
    globalSequence: 0,
    globalHash: H('global:genesis'),
    databaseHeads,
  }), { mode: 0o600 });
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
    databaseScopeHash: inventory.databaseScopeHash,
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

function createDatabaseAndInventory(manifest) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON;');
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS.forEach((statement) => {
    database.exec(statement);
  });
  const schemaHash = exactSchemaHash(database);
  const inventory = buildInventory(schemaHash);
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
    inventory.databaseScopeHash,
    autonomousResearchOnlineWriterOperationManifestHash(manifest),
    0,
    H('global:genesis'),
    0,
    H('database:genesis'),
    H('state:genesis'),
    NOW.toISOString(),
  );
  return Object.freeze({ database, inventory, schemaHash });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-finalized-head-'));
  const manifest = writerManifest();
  const created = createDatabaseAndInventory(manifest);
  const databaseHeads = created.inventory.instances.map((instance) => ({
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    sequence: 0,
    hash: instance.role === 'resident-instance'
      ? H('database:genesis') : H(`database:${instance.role}:genesis`),
    schemaHash: instance.schemaHash,
    stateHash: instance.role === 'resident-instance'
      ? H('state:genesis') : H(`state:${instance.role}:genesis`),
  }));
  const configured = configureAuthority(
    root,
    manifest,
    created.inventory,
    databaseHeads,
  );
  const client = createAutonomousResearchOnlineMutationAuthorityProcessClient({
    processConfigurationPath: configured.processConfigurationPath,
  });
  return Object.freeze({ root, manifest, client, ...created, ...configured });
}

function reserve(value, previous = {}) {
  const changeset = Buffer.from('finalized-head-changeset');
  const changesetHash = hashBytes(changeset);
  const databasePreviousSequence = previous.sequence ?? 0;
  const databasePreviousHash = previous.hash ?? H('database:genesis');
  const preStateHash = previous.stateHash ?? H('state:genesis');
  const request = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReserveRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: value.client.trust.scopeId,
    databaseScopeHash: value.client.trust.databaseScopeHash,
    writerManifestHash: value.client.trust.writerManifestHash,
    databaseRole: 'resident-instance',
    databaseInstanceId: INSTANCE,
    writerId: WRITER,
    operationId: OPERATION,
    codeProvenanceHash: H('writer-implementation'),
    mutationAttemptId: `mutation:${crypto.randomUUID()}`,
    globalPreviousSequence: 0,
    globalPreviousHash: H('global:genesis'),
    databasePreviousSequence,
    databasePreviousHash,
    schemaContractId: 'resident-instance-schema-v1',
    schemaHash: value.schemaHash,
    preStateHash,
    postStateHash: autonomousResearchOnlineMutationStateHash({
      databaseRole: 'resident-instance',
      databaseInstanceId: INSTANCE,
      writerId: WRITER,
      operationId: OPERATION,
      schemaHash: value.schemaHash,
      previousStateHash: preStateHash,
      changesetHash,
      databaseSequence: databasePreviousSequence + 1,
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
  return Object.freeze({
    request,
    reservation: value.client.reserveMutation({ request, now: NOW }),
  });
}

function finalize(value, pending) {
  const committedAt = new Date(NOW.getTime() + 1_000).toISOString();
  const request = buildExternallyFencedSqliteMutationFinalizeRequest(
    pending.reservation,
    committedAt,
  );
  return Object.freeze({
    request,
    receipt: value.client.finalizeMutation({
      request,
      reservation: pending.reservation,
      now: new Date(committedAt),
    }),
  });
}

function insertEvidence(value, pending, finalized, { tamperFinalization = false } = {}) {
  const finalization = tamperFinalization
    ? { ...finalized.receipt, sideEffectPermitHash: H('tampered-permit') }
    : finalized.receipt;
  value.database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_marker(
  reservation_id,database_role,database_instance_id,writer_id,operation_id,
  global_sequence,global_hash,database_sequence,database_hash,schema_hash,
  pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,
  reserve_request_json,reservation_receipt_hash,reservation_receipt_json,
  local_marker_hash,committed_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
    pending.reservation.reservationId,
    pending.reservation.databaseRole,
    pending.reservation.databaseInstanceId,
    pending.reservation.writerId,
    pending.reservation.operationId,
    pending.reservation.globalSequence,
    pending.reservation.globalHash,
    pending.reservation.databaseSequence,
    pending.reservation.databaseHash,
    pending.reservation.schemaHash,
    pending.reservation.preStateHash,
    pending.reservation.postStateHash,
    pending.reservation.changesetHash,
    hashRecord('AutonomousResearchOnlineMutationReserveRequest', pending.request),
    JSON.stringify(pending.request),
    autonomousResearchOnlineMutationReceiptHash(pending.reservation),
    JSON.stringify(pending.reservation),
    finalized.request.localMarkerHash,
    finalized.request.committedAt,
  );
  value.database.prepare(`
INSERT INTO autonomous_research_online_mutation_finalization_receipt(
  reservation_id,finalization_receipt_hash,finalization_receipt_json,
  side_effect_permit_hash,finalized_at,recorded_at
) VALUES(?,?,?,?,?,?);
`).run(
    pending.reservation.reservationId,
    autonomousResearchOnlineMutationReceiptHash(finalization),
    JSON.stringify(finalization),
    finalization.sideEffectPermitHash,
    finalization.finalizedAt,
    new Date(NOW.getTime() + 1_500).toISOString(),
  );
}

function inspect(value) {
  return inspectAutonomousResearchOnlineFinalizedDatabaseHead({
    database: value.database,
    databaseInstanceId: INSTANCE,
    inventory: value.inventory,
    authorityClient: value.client,
    writerManifest: value.manifest,
    clock: { now: () => new Date(NOW.getTime() + 2_000) },
  });
}

function cleanup(value) {
  value.database.close();
  fs.rmSync(value.root, { recursive: true, force: true });
}

test('signed genesis zero-head reconciles but does not activate runtime', () => {
  const value = setup();
  try {
    const receipt = inspect(value);
    assert.equal(receipt.localDatabaseSequence, 0);
    assert.equal(receipt.markerCount, 0);
    assert.equal(receipt.genesisZeroHeadVerified, true);
    assert.equal(receipt.runtimeReady, false);
    assert.equal(receipt.remainingBlockers.length, 2);
    assert.match(receipt.inspectionReceiptHash, /^sha256:[0-9a-f]{64}$/);
  } finally { cleanup(value); }
});

test('signed marker and finalization chain reconciles to the signed database head', () => {
  const value = setup();
  try {
    const pending = reserve(value);
    const finalized = finalize(value, pending);
    insertEvidence(value, pending, finalized);
    const receipt = inspect(value);
    assert.equal(receipt.localDatabaseSequence, 1);
    assert.equal(receipt.markerCount, 1);
    assert.equal(receipt.finalizationCount, 1);
    assert.equal(receipt.localStateHash, pending.reservation.postStateHash);
  } finally { cleanup(value); }
});

test('remote finalized head with a missing local marker is blocked as rollback evidence', () => {
  const value = setup();
  try {
    finalize(value, reserve(value));
    assert.throws(
      () => inspect(value),
      /autonomous_research_online_finalized_head_local_authority_mismatch/,
    );
  } finally { cleanup(value); }
});

test('local marker ahead of the signed database head is blocked', () => {
  const value = setup();
  try {
    const pending = reserve(value);
    const finalized = finalize(value, pending);
    insertEvidence(value, pending, finalized);
    const state = JSON.parse(fs.readFileSync(value.statePath, 'utf8'));
    const head = state.databaseHeads.find((candidate) => (
      candidate.databaseInstanceId === INSTANCE
    ));
    head.sequence = 0;
    head.hash = H('database:genesis');
    head.stateHash = H('state:genesis');
    fs.writeFileSync(value.statePath, JSON.stringify(state), { mode: 0o600 });
    assert.throws(
      () => inspect(value),
      /autonomous_research_online_finalized_head_local_authority_mismatch/,
    );
  } finally { cleanup(value); }
});

test('a signed marker sequence gap is blocked', () => {
  const value = setup();
  try {
    const pending = reserve(value, {
      sequence: 1,
      hash: H('database:missing-sequence-one'),
      stateHash: H('state:missing-sequence-one'),
    });
    const finalized = finalize(value, pending);
    insertEvidence(value, pending, finalized);
    assert.throws(
      () => inspect(value),
      /autonomous_research_online_finalized_head_marker_chain_invalid/,
    );
  } finally { cleanup(value); }
});

test('tampered finalization JSON is blocked even when its local row hash was recomputed', () => {
  const value = setup();
  try {
    const pending = reserve(value);
    const finalized = finalize(value, pending);
    insertEvidence(value, pending, finalized, { tamperFinalization: true });
    assert.throws(
      () => inspect(value),
      /autonomous_research_online_finalized_head_finalization_invalid/,
    );
  } finally { cleanup(value); }
});

test('actual schema drift is blocked even when metadata still names the pinned schema', () => {
  const value = setup();
  try {
    value.database.exec('CREATE TABLE unexpected_drift(id INTEGER PRIMARY KEY) STRICT;');
    assert.throws(
      () => inspect(value),
      /autonomous_research_online_finalized_head_metadata_invalid/,
    );
  } finally { cleanup(value); }
});
