import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createAutonomousResearchOnlineMutationAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import {
  buildExternallyFencedSqliteMutationFinalizeRequest,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-recovery.mjs';
import {
  createLocalAutonomousResearchStateAuthorityMutationHandlers,
} from '../../paper-adapters/automation/local-autonomous-research-state-authority-mutation.mjs';
import {
  requestLocalAutonomousResearchStateAuthority,
  startLocalAutonomousResearchStateAuthorityServer,
} from '../../paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs';
import {
  autonomousResearchOnlineMutationReceiptHash,
  autonomousResearchOnlineMutationStateHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  fileSha256HashSync,
} from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-18T08:00:00.000Z');
const H = (label) => hashRecord('AutonomousResearchOnlineAuthorityProcessTest', { label });

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
const H = (kind, value) => hashRecord(kind, value);
const sign = (unsigned) => Object.freeze({
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
  receipt = sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReservationReceipt',
    status: 'autonomous_research_online_mutation_reserved',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineMutationReserveRequest', request),
    reservationId: 'reservation:' + request.mutationAttemptId,
    ...mirrored,
    globalSequence: request.globalPreviousSequence + 1,
    globalHash: H('AuthorityProcessBrokerGlobal', request.mutationAttemptId),
    databaseSequence: request.databasePreviousSequence + 1,
    databaseHash: H('AuthorityProcessBrokerDatabase', request.mutationAttemptId),
    issuedAt: requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + requestedLeaseMs).toISOString(),
  });
  fs.writeFileSync(statePath, JSON.stringify(receipt), { mode: 0o600 });
} else if (request.kind === 'AutonomousResearchOnlineMutationResolutionRequest') {
  const reservation = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  receipt = sign({
    ...request,
    kind: 'AutonomousResearchOnlineMutationResolutionReceipt',
    status: 'autonomous_research_online_mutation_resolution_observed',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineMutationResolutionRequest', request),
    resolution: 'reserved',
    reservation,
    observedAt: request.requestedAt,
  });
} else if (request.kind === 'AutonomousResearchOnlineMutationFinalizeRequest') {
  const { version, kind, committedAt, ...mirrored } = request;
  receipt = sign({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
    status: 'autonomous_research_online_mutation_finalized',
    authorityId: 'authority:test',
    keyId: 'key:test',
    requestHash: H('AutonomousResearchOnlineMutationFinalizeRequest', request),
    ...mirrored,
    sideEffectPermitHash: H('AuthorityProcessBrokerPermit', request.reservationId),
    finalizedAt: committedAt,
  });
} else {
  process.exitCode = 64;
}
if (receipt) process.stdout.write(JSON.stringify(receipt) + '\\n');
`;
}

function configureAuthority(root) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(root, 'authority-public-key.json');
  const authorityConfigurationPath = path.join(root, 'authority.json');
  const processConfigurationPath = path.join(root, 'authority-process.json');
  const commandPath = path.join(root, 'authority-broker.mjs');
  const statePath = path.join(root, 'authority-state.json');
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
    databaseScopeHash: H('database-scope'),
    writerManifestHash: H('writer-manifest'),
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
    timeoutMs: 120_000,
  }), { mode: 0o600 });
  return processConfigurationPath;
}

function reserveRequest() {
  // The Base64 receipt is over 4 MiB, exercising the production process buffer ceiling.
  const changeset = Buffer.alloc(3 * 1024 * 1024, 7);
  const changesetHash = hashBytes(changeset);
  const shared = {
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    writerId: 'writer:resident-instance',
    operationId: 'resident-instance.commit.v1',
    schemaHash: H('schema'),
    previousStateHash: H('state:previous'),
    changesetHash,
    databaseSequence: 1,
    authorizationReceiptHashes: [],
    sideEffectReservationHashes: [],
  };
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReserveRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: 'scope:test',
    databaseScopeHash: H('database-scope'),
    writerManifestHash: H('writer-manifest'),
    databaseRole: shared.databaseRole,
    databaseInstanceId: shared.databaseInstanceId,
    writerId: shared.writerId,
    operationId: shared.operationId,
    codeProvenanceHash: H('writer-plan'),
    mutationAttemptId: 'mutation:authority-process-test',
    globalPreviousSequence: 0,
    globalPreviousHash: H('global:previous'),
    databasePreviousSequence: 0,
    databasePreviousHash: H('database:previous'),
    schemaContractId: 'resident-instance-schema-v1',
    schemaHash: shared.schemaHash,
    preStateHash: shared.previousStateHash,
    postStateHash: autonomousResearchOnlineMutationStateHash(shared),
    changesetEncoding: 'base64',
    changesetBase64: changeset.toString('base64'),
    changesetByteLength: changeset.length,
    changesetHash,
    authorizationReceiptHashes: shared.authorizationReceiptHashes,
    sideEffectReservationHashes: shared.sideEffectReservationHashes,
    requestedAt: NOW.toISOString(),
    requestedLeaseMs: 60_000,
  });
}

function localMutationAuthorityFixture(t) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
CREATE TABLE authority_metadata(
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
CREATE TABLE authority_database_head(
  database_instance_id TEXT PRIMARY KEY,
  database_role TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL
) STRICT;
CREATE TABLE authority_mutation(
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
`);
  const configuration = Object.freeze({
    authorityId: 'authority:local-test',
    keyId: 'key:local-test',
    scopeId: 'scope:local-test',
    databaseScopeHash: H('local:database-scope'),
    writerManifestHash: H('local:writer-manifest'),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    ...configuration,
  });
  const initial = Object.freeze({
    globalHash: H('local:global:genesis'),
    databaseHash: H('local:database:genesis'),
    schemaHash: H('local:schema'),
    stateHash: H('local:state:genesis'),
  });
  database.prepare(`
INSERT INTO authority_metadata(
  singleton,configuration_hash,authority_id,key_id,scope_id,database_scope_hash,
  writer_manifest_hash,global_sequence,global_hash,schema_transition_state
) VALUES(1,?,?,?,?,?,?,?,?, 'finalized');
`).run(
    H('local:configuration'),
    configuration.authorityId,
    configuration.keyId,
    configuration.scopeId,
    configuration.databaseScopeHash,
    configuration.writerManifestHash,
    0,
    initial.globalHash,
  );
  database.prepare(`
INSERT INTO authority_database_head(
  database_instance_id,database_role,sequence,hash,schema_hash,state_hash
) VALUES(?,?,?,?,?,?);
`).run(
    'native-store-test',
    'native-store',
    0,
    initial.databaseHash,
    initial.schemaHash,
    initial.stateHash,
  );
  const clock = Object.freeze({ now: () => new Date(NOW) });
  const handlers = createLocalAutonomousResearchStateAuthorityMutationHandlers({
    database,
    configuration,
    clock,
    trust,
    signOnline: (receipt) => Object.freeze({ ...receipt, signature: 'fixture-signature' }),
  });
  t.after(() => database.close());
  return Object.freeze({ database, configuration, handlers, initial, trust });
}

function localMutationReserveRequest(fixture, mutationAttemptId) {
  const metadata = fixture.database.prepare(
    'SELECT global_sequence,global_hash FROM authority_metadata WHERE singleton=1',
  ).get();
  const head = fixture.database.prepare(
    'SELECT * FROM authority_database_head WHERE database_instance_id=?',
  ).get('native-store-test');
  const changeset = Buffer.from(`changeset:${mutationAttemptId}`, 'utf8');
  const changesetHash = hashBytes(changeset);
  const authorizationReceiptHashes = [];
  const sideEffectReservationHashes = [];
  const shared = Object.freeze({
    databaseRole: 'native-store',
    databaseInstanceId: 'native-store-test',
    writerId: 'writer:native-store-test',
    operationId: 'native-store.test-mutation.v1',
    schemaHash: head.schema_hash,
    previousStateHash: head.state_hash,
    changesetHash,
    databaseSequence: Number(head.sequence) + 1,
    authorizationReceiptHashes,
    sideEffectReservationHashes,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReserveRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: fixture.configuration.scopeId,
    databaseScopeHash: fixture.configuration.databaseScopeHash,
    writerManifestHash: fixture.configuration.writerManifestHash,
    databaseRole: shared.databaseRole,
    databaseInstanceId: shared.databaseInstanceId,
    writerId: shared.writerId,
    operationId: shared.operationId,
    codeProvenanceHash: H(`local:code:${mutationAttemptId}`),
    mutationAttemptId,
    globalPreviousSequence: Number(metadata.global_sequence),
    globalPreviousHash: metadata.global_hash,
    databasePreviousSequence: Number(head.sequence),
    databasePreviousHash: head.hash,
    schemaContractId: 'native-store-schema-v1',
    schemaHash: shared.schemaHash,
    preStateHash: shared.previousStateHash,
    postStateHash: autonomousResearchOnlineMutationStateHash(shared),
    changesetEncoding: 'base64',
    changesetBase64: changeset.toString('base64'),
    changesetByteLength: changeset.length,
    changesetHash,
    authorizationReceiptHashes,
    sideEffectReservationHashes,
    requestedAt: NOW.toISOString(),
    requestedLeaseMs: 60_000,
  });
}

function localMutationResolutionRequest(fixture, reserve, mutationAttemptId) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationResolutionRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: fixture.configuration.scopeId,
    databaseScopeHash: fixture.configuration.databaseScopeHash,
    writerManifestHash: fixture.configuration.writerManifestHash,
    mutationAttemptId,
    reserveRequestHash: hashRecord(
      'AutonomousResearchOnlineMutationReserveRequest',
      reserve,
    ),
    requestedAt: NOW.toISOString(),
  });
}

function localMutationAbortRequest(reservation, reason = 'local-apply-failed') {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAbortRequest',
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
    mutationAttemptId: reservation.mutationAttemptId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    changesetHash: reservation.changesetHash,
    reason,
    requestedAt: NOW.toISOString(),
  });
}

test('pinned Ed25519 authority process verifies large reserve, lookup, and finalize receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-authority-process-'));
  try {
    const client = createAutonomousResearchOnlineMutationAuthorityProcessClient({
      processConfigurationPath: configureAuthority(root),
    });
    const request = reserveRequest();
    const reservation = client.reserveMutation({ request, now: NOW });
    assert.equal(reservation.mutationAttemptId, request.mutationAttemptId);
    assert.equal(client.verifyStoredReservation({ receipt: reservation, request }), true);

    const resolutionRequest = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationResolutionRequest',
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      mutationAttemptId: request.mutationAttemptId,
      reserveRequestHash: hashRecord(
        'AutonomousResearchOnlineMutationReserveRequest', request,
      ),
      requestedAt: NOW.toISOString(),
    });
    const resolved = client.resolveMutationAttempt({
      request: resolutionRequest,
      reserveRequest: request,
      now: NOW,
    });
    assert.equal(
      autonomousResearchOnlineMutationReceiptHash(resolved),
      autonomousResearchOnlineMutationReceiptHash(reservation),
    );

    const committedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const finalization = client.finalizeMutation({
      request: buildExternallyFencedSqliteMutationFinalizeRequest(
        reservation,
        committedAt,
      ),
      reservation,
      now: new Date(committedAt),
    });
    assert.equal(finalization.status, 'autonomous_research_online_mutation_finalized');
    assert.match(finalization.sideEffectPermitHash, /^sha256:[0-9a-f]{64}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local production mutation authority persists success and rolls back rejected transitions',
  (t) => {
    const fixture = localMutationAuthorityFixture(t);
    const firstRequest = localMutationReserveRequest(fixture, 'mutation:local:first');
    const firstReservation = fixture.handlers.reserveMutation(firstRequest);
    assert.equal(firstReservation.status, 'autonomous_research_online_mutation_reserved');
    assert.deepEqual(
      fixture.handlers.reserveMutation(firstRequest),
      firstReservation,
      'an exact pending request is idempotent',
    );

    const competing = localMutationReserveRequest(fixture, 'mutation:local:competing');
    assert.throws(
      () => fixture.handlers.reserveMutation(competing),
      /local_state_authority_global_head_conflict/,
    );
    assert.equal(fixture.database.prepare(
      "SELECT count(*) AS count FROM authority_mutation WHERE status='reserved'",
    ).get().count, 1);

    const unresolvedRequest = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineUnresolvedReservationListRequest',
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
      scopeId: fixture.configuration.scopeId,
      databaseScopeHash: fixture.configuration.databaseScopeHash,
      writerManifestHash: fixture.configuration.writerManifestHash,
      databaseRole: 'native-store',
      databaseInstanceId: 'native-store-test',
      nonce: 'nonce:unresolved:first',
      requestedAt: NOW.toISOString(),
    });
    const unresolved = fixture.handlers.listUnresolved(unresolvedRequest);
    assert.equal(unresolved.unresolvedReservationCount, 1);
    assert.equal(
      unresolved.unresolvedReservations[0].reservation.reservationId,
      firstReservation.reservationId,
    );

    const resolutionRequest = localMutationResolutionRequest(
      fixture,
      firstRequest,
      firstRequest.mutationAttemptId,
    );
    assert.equal(
      fixture.handlers.resolveMutation(resolutionRequest).resolution,
      'reserved',
    );

    const currentHeadRequest = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationCurrentHeadRequest',
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
      scopeId: fixture.configuration.scopeId,
      databaseScopeHash: fixture.configuration.databaseScopeHash,
      writerManifestHash: fixture.configuration.writerManifestHash,
      nonce: 'nonce:head:first',
      requestedAt: NOW.toISOString(),
    });
    const pendingHead = fixture.handlers.observeCurrentHead(currentHeadRequest);
    assert.equal(pendingHead.globalSequence, 0);
    assert.equal(pendingHead.unresolvedReservationCount, 1);
    assert.throws(
      () => fixture.handlers.observeCurrentHead({ ...currentHeadRequest, extra: true }),
      /local_state_authority_request_invalid/,
    );

    const challenge = fixture.handlers.challengeAuthority(Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationActiveChallengeRequest',
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
      scopeId: fixture.configuration.scopeId,
      databaseScopeHash: fixture.configuration.databaseScopeHash,
      writerManifestHash: fixture.configuration.writerManifestHash,
      challengeNonce: 'nonce:challenge:first',
      requestedAt: NOW.toISOString(),
    }));
    assert.equal(
      challenge.status,
      'autonomous_research_online_mutation_active_challenge_verified',
    );

    const roles = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort();
    const staticInspectionReceiptHash = H('local:static-inspection');
    const scope = fixture.handlers.observeScope(Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationScopeRequest',
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
      scopeId: fixture.configuration.scopeId,
      databaseScopeHash: fixture.configuration.databaseScopeHash,
      writerManifestHash: fixture.configuration.writerManifestHash,
      staticInspectionReceiptHash,
      astGateReceiptHash: staticInspectionReceiptHash,
      codeProvenanceHash: H('local:scope-code'),
      operationCount: 1,
      operationIds: ['native-store.test-mutation.v1'],
      requiredDatabaseRoles: roles,
      coveredDatabaseRoles: ['native-store'],
      nonce: 'nonce:scope:first',
      requestedAt: NOW.toISOString(),
    }));
    assert.equal(scope.globalSequence, 0);
    assert.deepEqual(scope.coveredDatabaseRoles, ['native-store']);

    fixture.database.prepare(`
INSERT INTO authority_mutation(
  mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,
  reserve_request_json,reservation_receipt_json
) VALUES(?,?,'reserved',?,?,?,?);
`).run(
      'mutation:local:corrupt-second',
      'mutation:local:corrupt-reservation',
      99,
      'native-store-test',
      '{}',
      '{}',
    );
    assert.throws(
      () => fixture.handlers.listUnresolved(unresolvedRequest),
      /local_state_authority_multiple_unresolved_reservations/,
    );
    fixture.database.prepare(
      'DELETE FROM authority_mutation WHERE mutation_attempt_id=?',
    ).run('mutation:local:corrupt-second');

    const committedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const firstFinalize = buildExternallyFencedSqliteMutationFinalizeRequest(
      firstReservation,
      committedAt,
    );
    assert.throws(
      () => fixture.handlers.finalizeMutation({
        ...firstFinalize,
        localMarkerHash: H('local:wrong-marker'),
      }),
      /autonomous_research_online_mutation_finalize_request_invalid/,
    );
    assert.equal(fixture.database.prepare(
      'SELECT status FROM authority_mutation WHERE reservation_id=?',
    ).get(firstReservation.reservationId).status, 'reserved');
    assert.equal(fixture.database.prepare(
      'SELECT global_sequence FROM authority_metadata WHERE singleton=1',
    ).get().global_sequence, 0);

    const firstFinalization = fixture.handlers.finalizeMutation(firstFinalize);
    assert.equal(
      firstFinalization.status,
      'autonomous_research_online_mutation_finalized',
    );
    assert.deepEqual(
      fixture.handlers.finalizeMutation(firstFinalize),
      firstFinalization,
    );
    const conflictingFinalize = buildExternallyFencedSqliteMutationFinalizeRequest(
      firstReservation,
      new Date(NOW.getTime() + 2_000).toISOString(),
    );
    assert.throws(
      () => fixture.handlers.finalizeMutation(conflictingFinalize),
      /local_state_authority_mutation_finalization_conflict/,
    );
    assert.equal(
      fixture.handlers.resolveMutation(resolutionRequest).resolution,
      'not-found',
    );
    assert.throws(
      () => fixture.handlers.reserveMutation(firstRequest),
      /local_state_authority_mutation_attempt_conflict/,
    );
    assert.throws(
      () => fixture.handlers.abortMutation(localMutationAbortRequest(firstReservation)),
      /local_state_authority_mutation_not_reserved/,
    );

    const secondRequest = localMutationReserveRequest(fixture, 'mutation:local:second');
    const secondReservation = fixture.handlers.reserveMutation(secondRequest);
    const secondAbort = localMutationAbortRequest(secondReservation);
    const aborted = fixture.handlers.abortMutation(secondAbort);
    assert.equal(aborted.status, 'autonomous_research_online_mutation_aborted');
    assert.deepEqual(fixture.handlers.abortMutation(secondAbort), aborted);
    assert.throws(
      () => fixture.handlers.abortMutation(localMutationAbortRequest(
        secondReservation,
        'local-marker-failed',
      )),
      /local_state_authority_mutation_abort_conflict/,
    );
    assert.equal(
      fixture.handlers.resolveMutation(localMutationResolutionRequest(
        fixture,
        secondRequest,
        secondRequest.mutationAttemptId,
      )).resolution,
      'not-found',
    );
    assert.equal(
      fixture.handlers.listUnresolved(unresolvedRequest).unresolvedReservationCount,
      0,
    );

    const absentReserve = Object.freeze({
      ...secondRequest,
      mutationAttemptId: 'mutation:local:absent',
    });
    const absentResolution = localMutationResolutionRequest(
      fixture,
      absentReserve,
      absentReserve.mutationAttemptId,
    );
    assert.equal(
      fixture.handlers.resolveMutation(absentResolution).resolution,
      'not-found',
    );
    assert.throws(
      () => fixture.handlers.resolveMutation({
        ...absentResolution,
        reserveRequestHash: 'invalid',
      }),
      /local_state_authority_resolution_request_invalid/,
    );
    assert.throws(
      () => fixture.handlers.finalizeMutation({
        ...firstFinalize,
        reservationId: 'mutation:local:missing-reservation',
      }),
      /local_state_authority_mutation_reservation_required/,
    );

    const finalHead = fixture.handlers.observeCurrentHead({
      ...currentHeadRequest,
      nonce: 'nonce:head:final',
    });
    assert.equal(finalHead.globalSequence, 1);
    assert.equal(finalHead.databaseHeads[0].stateHash, firstReservation.postStateHash);
  });

test('local authority socket answers after clients half-close and serializes requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-state-authority-socket-'));
  const socketPath = path.join(root, 'authority.sock');
  let sequence = 0;
  const listener = await startLocalAutonomousResearchStateAuthorityServer({
    socketPath,
    maximumMessageBytes: 4096,
    authority: Object.freeze({
      handle(request) {
        sequence += 1;
        return Object.freeze({
          version: 1,
          kind: 'LocalStateAuthoritySocketTestReceipt',
          requestId: request.requestId,
          sequence,
        });
      },
    }),
  });
  try {
    const receipts = await Promise.all(['a', 'b', 'c'].map((requestId) => (
      requestLocalAutonomousResearchStateAuthority({
        request: Object.freeze({ requestId }),
        socketPath,
        maximumMessageBytes: 4096,
      })
    )));
    assert.deepEqual(
      receipts.map((receipt) => receipt.requestId).sort(),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(
      receipts.map((receipt) => receipt.sequence).sort((left, right) => left - right),
      [1, 2, 3],
    );
  } finally {
    await listener.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
