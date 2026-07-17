import crypto from 'node:crypto';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  signAuthorityDocument,
} from '../../paper-adapters/authority/authority-signatures.mjs';
import {
  installAutonomousResearchMachineIntakeExternalAuthorityTestDouble,
} from './test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs';

function publicKey(pair, { keyId, subjectId, role, effectiveFrom, expiresAt }) {
  return {
    keyId,
    subjectId,
    organization: 'Machine Intake Test Authority',
    algorithm: 'ed25519',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    roles: [role],
    status: 'active',
    effectiveFrom,
    expiresAt,
    revokedAt: null,
  };
}

export function installMachineIntakeExternalGenesisAuthority({
  configurationHash,
  producerProfileHash,
  now = new Date(),
}) {
  const observed = now instanceof Date ? now : new Date(now);
  const effectiveFrom = new Date(observed.getTime() - 60 * 60 * 1000).toISOString();
  const expiresAt = new Date(observed.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const owner = crypto.generateKeyPairSync('ed25519');
  const observer = crypto.generateKeyPairSync('ed25519');
  const ownerKey = publicKey(owner, {
    keyId: 'test-genesis-owner-key',
    subjectId: 'test-genesis-owner',
    role: 'capability_owner',
    effectiveFrom,
    expiresAt,
  });
  const observerKey = publicKey(observer, {
    keyId: 'test-genesis-observer-key',
    subjectId: 'test-genesis-observer',
    role: 'operational_observer',
    effectiveFrom,
    expiresAt,
  });
  const ownerTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [ownerKey, observerKey],
  };
  const unsigned = {
    version: 1,
    kind: 'AutonomousResearchMachineIntakeAuthorityGenesisEnvelope',
    status: 'external_genesis_authority_verified',
    configurationHash,
    producerProfileHash,
    authorityGeneration: 1,
    ownerTrustStoreHash: hashRecord('AuthorityTrustStore', ownerTrustStore),
    nonce: `genesis:${crypto.randomUUID()}`,
    signedAt: observed.toISOString(),
    validFrom: observed.toISOString(),
    expiresAt,
    signatures: [],
  };
  const ownerSigned = signAuthorityDocument(unsigned, {
    privateKeyPem: owner.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: ownerKey.keyId,
    role: 'capability_owner',
  });
  const genesisEnvelope = signAuthorityDocument(ownerSigned, {
    privateKeyPem: observer.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: observerKey.keyId,
    role: 'operational_observer',
  });
  const documents = Object.freeze({
    authorityRoot: '/test-only/authority-rotation',
    ownerTrustStore,
    rotationTrustStore: { version: 1, kind: 'AuthorityTrustStore', keys: [] },
    bootstrapReceipt: { version: 1, kind: 'TestBootstrapReceipt' },
    genesisEnvelope,
  });
  installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(() => documents);
  return documents;
}
