import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { signAuthorityDocument } from '../../paper-core/src/authority-signatures.mjs';
import { verifyCapabilityOperationalReceipt } from '../operational-proof-intake.mjs';

test('operational proof requires production binding, replay equality, target hashes and external owner signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const targetBindings = [{ path: 'paper-domain/research/claim-registry.mjs', sha256: `sha256:${'1'.repeat(64)}` }];
  let document = {
    version: 1,
    kind: 'CapabilityOperationalReceipt',
    capabilityId: 'research.claim-registry',
    status: 'production_capability_replay_verified',
    evidenceEnvironment: 'production',
    evidenceClass: 'operational',
    productionEligible: true,
    productionSubject: { paperId: 'real-paper' },
    inputHashes: [`sha256:${'2'.repeat(64)}`],
    executionReceiptHash: `sha256:${'3'.repeat(64)}`,
    resultHash: `sha256:${'4'.repeat(64)}`,
    replayReceiptHash: `sha256:${'5'.repeat(64)}`,
    replayMatched: true,
    releaseCommit: 'abc123',
    targetHashes: targetBindings,
    signatures: [],
  };
  document = signAuthorityDocument(document, {
    keyId: 'owner-key',
    subjectId: 'external-owner',
    role: 'capability_owner',
    privateKeyPem,
  });
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{ keyId: 'owner-key', subjectId: 'external-owner', roles: ['capability_owner'], publicKeyPem, status: 'active', algorithm: 'ed25519' }],
  };
  const verified = verifyCapabilityOperationalReceipt({
    document,
    trustStore,
    capabilityId: 'research.claim-registry',
    targetBindings,
    releaseCommit: 'abc123',
  });
  assert.equal(verified.status, 'capability_operational_receipt_verified');
  const replayMismatch = structuredClone(document);
  replayMismatch.replayMatched = false;
  const blocked = verifyCapabilityOperationalReceipt({
    document: replayMismatch,
    trustStore,
    capabilityId: 'research.claim-registry',
    targetBindings,
    releaseCommit: 'abc123',
  });
  assert.equal(blocked.status, 'capability_operational_receipt_blocked');
  assert.ok(blocked.blockers.includes('operational_replay_not_matched'));
});
