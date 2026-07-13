import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { verifyCapabilityConformanceReceipt, verifyCapabilityOperationalReceipt } from '../operational-proof-intake.mjs';

function signer(keyId, subjectId, role, assurance = 'external_independent') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    subjectId,
    role,
    assurance,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trustKey: {
      keyId,
      subjectId,
      assurance,
      roles: [role],
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      status: 'active',
      algorithm: 'ed25519',
    },
  };
}

const targetBindings = [{ path: 'paper-domain/research/claim-registry.mjs', sha256: `sha256:${'1'.repeat(64)}` }];
const common = {
  capabilityId: 'research.claim-registry',
  productionSubject: { paperId: 'real-paper' },
  inputHashes: [`sha256:${'2'.repeat(64)}`],
  executionReceiptHash: `sha256:${'3'.repeat(64)}`,
  resultHash: `sha256:${'4'.repeat(64)}`,
  replayReceiptHash: `sha256:${'5'.repeat(64)}`,
  replayMatched: true,
  releaseCommit: 'abc123',
  targetHashes: targetBindings,
};

test('operational proof requires distinct externally independent owner and observer signatures', () => {
  const owner = signer('owner-key', 'external-owner', 'capability_owner');
  const observer = signer('observer-key', 'external-observer', 'operational_observer');
  let document = {
    version: 2,
    kind: 'CapabilityOperationalReceipt',
    ...common,
    status: 'production_runtime_observation_verified',
    executionClass: 'production_runtime_observation',
    evidenceEnvironment: 'production',
    evidenceClass: 'operational',
    productionEligible: true,
    signatures: [],
  };
  for (const authority of [owner, observer]) {
    document = signAuthorityDocument(document, {
      keyId: authority.keyId,
      role: authority.role,
      privateKeyPem: authority.privateKeyPem,
    });
  }
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey, observer.trustKey] };
  const verified = verifyCapabilityOperationalReceipt({ document, trustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit: 'abc123' });
  assert.equal(verified.status, 'capability_operational_receipt_verified');

  const localTrustStore = structuredClone(trustStore);
  localTrustStore.keys[0].assurance = 'local_admin_delegated';
  const blocked = verifyCapabilityOperationalReceipt({ document, trustStore: localTrustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit: 'abc123' });
  assert.equal(blocked.status, 'capability_operational_receipt_blocked');
  assert.ok(blocked.blockers.includes('operational_signer_assurance_not_external_independent'));
});

test('local-admin signed production-source replay is conformance, never operational', () => {
  const owner = signer('local-owner-key', 'local-owner', 'capability_owner', 'local_admin_delegated');
  let document = {
    version: 1,
    kind: 'CapabilityConformanceReceipt',
    ...common,
    status: 'production_source_bound_conformance_replay_verified',
    executionClass: 'production_source_bound_conformance',
    evidenceEnvironment: 'production_source_bound',
    evidenceClass: 'conformance',
    productionEligible: false,
    signatures: [],
  };
  document = signAuthorityDocument(document, { keyId: owner.keyId, role: owner.role, privateKeyPem: owner.privateKeyPem });
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey] };
  const verified = verifyCapabilityConformanceReceipt({ document, trustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit: 'abc123' });
  assert.equal(verified.status, 'capability_conformance_receipt_verified');
  assert.equal(verified.issuerAssurance, 'local_admin_delegated');
  const operational = verifyCapabilityOperationalReceipt({ document, trustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit: 'abc123' });
  assert.equal(operational.status, 'capability_operational_receipt_blocked');
});
