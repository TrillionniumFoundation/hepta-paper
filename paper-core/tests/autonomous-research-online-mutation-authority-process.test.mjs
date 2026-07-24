import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAutonomousResearchOnlineMutationAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import {
  buildExternallyFencedSqliteMutationFinalizeRequest,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-recovery.mjs';
import {
  autonomousResearchOnlineMutationReceiptHash,
  autonomousResearchOnlineMutationStateHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
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
