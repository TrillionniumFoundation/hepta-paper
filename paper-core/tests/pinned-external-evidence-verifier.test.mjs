import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  assertPinnedExternalEvidenceEnvelope,
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
  pinnedExternalEvidenceSigningPayload,
  verifyPinnedExternalEvidenceEnvelope,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
  evaluateExternalPrincipalIdentitySeparation,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-19T02:00:00.000Z');
const ROLE = 'autonomous_submission_portal';
const H = (label) => hashRecord('PinnedExternalEvidenceVerifierTest', { label });

function trustKey(pair, {
  keyId = 'portal-key-1',
  subjectId = 'portal-authority-1',
  role = ROLE,
} = {}) {
  return Object.freeze({
    keyId,
    subjectId,
    organization: 'Example Portal Authority',
    algorithm: 'ed25519',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    roles: [role],
    status: 'active',
    effectiveFrom: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    revokedAt: null,
  });
}

function trustStore(keys) {
  return Object.freeze({ version: 1, kind: 'AuthorityTrustStore', keys });
}

function signedEnvelope(pair, {
  subjectKind = 'AutonomousSubmissionPortalLookupOutcome',
  subjectHash = H('subject'),
  keyId = 'portal-key-1',
  role = ROLE,
  signedAt = '2026-07-19T01:59:00.000Z',
  expiresAt = '2026-07-19T02:01:00.000Z',
} = {}) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt,
    expiresAt,
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const value = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(placeholder),
    pair.privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{ keyId, role, algorithm: 'ed25519', value }],
  });
}

test('pinned external evidence verifier produces a local cryptographic capability receipt', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const subjectHash = H('verified-subject');
  const envelope = signedEnvelope(pair, { subjectHash });
  const selectedTrustStore = trustStore([trustKey(pair)]);
  const receipt = assertPinnedExternalEvidenceEnvelope({
    envelope,
    subjectKind: envelope.subjectKind,
    subjectHash,
    trustStore: selectedTrustStore,
    requiredRole: ROLE,
    expectedKeyIds: ['portal-key-1'],
    now: NOW,
    maximumLifetimeMs: 5 * 60 * 1000,
  });
  assert.equal(receipt.status, 'pinned_external_evidence_verified');
  assert.equal(receipt.cryptographicAuthorityReady, true);
  assert.deepEqual(receipt.verifiedKeyIds, ['portal-key-1']);
  assert.deepEqual(receipt.verifiedSubjectIds, ['portal-authority-1']);
  assert.equal(receipt.verifiedPublicKeySpkiHashes[0], hashBytes(
    pair.publicKey.export({ type: 'spki', format: 'der' }),
  ));
  assert.match(receipt.pinnedExternalEvidenceVerificationReceiptHash,
    /^sha256:[0-9a-f]{64}$/);
});

test('wrong key, role, expiry, and subject tampering all fail closed', () => {
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const selectedTrustStore = trustStore([trustKey(trusted)]);
  const input = (envelope, subjectHash = envelope.subjectHash) => ({
    envelope,
    subjectKind: 'AutonomousSubmissionPortalLookupOutcome',
    subjectHash,
    trustStore: selectedTrustStore,
    requiredRole: ROLE,
    expectedKeyIds: ['portal-key-1'],
    now: NOW,
  });
  const wrongKey = verifyPinnedExternalEvidenceEnvelope(input(signedEnvelope(attacker)));
  assert.equal(wrongKey.cryptographicAuthorityReady, false);
  assert.ok(wrongKey.blockers.includes('immutable_signed_json_authority_signature_invalid'));

  const wrongRole = verifyPinnedExternalEvidenceEnvelope(input(signedEnvelope(trusted, {
    role: 'untrusted_portal_role',
  })));
  assert.equal(wrongRole.cryptographicAuthorityReady, false);
  assert.ok(wrongRole.blockers.includes('immutable_signed_json_authority_signature_invalid'));

  const expired = verifyPinnedExternalEvidenceEnvelope({
    ...input(signedEnvelope(trusted, {
      signedAt: '2026-07-19T01:00:00.000Z',
      expiresAt: '2026-07-19T01:01:00.000Z',
    })),
    maximumLifetimeMs: 5 * 60 * 1000,
  });
  assert.equal(expired.cryptographicAuthorityReady, false);
  assert.ok(expired.blockers.includes('immutable_signed_json_authority_time_window_invalid'));

  const valid = signedEnvelope(trusted);
  const tampered = verifyPinnedExternalEvidenceEnvelope(input(valid, H('tampered-subject')));
  assert.equal(tampered.cryptographicAuthorityReady, false);
  assert.ok(tampered.blockers.includes('pinned_external_evidence_subject_binding_invalid'));
});

test('trust store rejects a single Ed25519 key hidden behind multiple key ids', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const inspection = inspectPinnedExternalEvidenceTrustStore(trustStore([
    trustKey(pair),
    trustKey(pair, { keyId: 'portal-key-alias', subjectId: 'portal-authority-alias' }),
  ]), { requiredRole: ROLE });
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes('pinned_external_evidence_trust_key_spki_duplicate'));
});

function identity(label, overrides = {}) {
  return buildExternalPrincipalIdentityAttestationSubject({
    serviceId: `service-${label}`,
    principalId: `principal-${label}`,
    provider: 'provider',
    providerAccountIdentityHash: H(`account-${label}`),
    credentialRootIdentityHash: H(`credential-${label}`),
    hostIdentityHash: H(`host-${label}`),
    processIdentityHash: H(`process-${label}`),
    trustDomainIdentityHash: H(`domain-${label}`),
    signerPublicKeySpkiHash: H(`spki-${label}`),
    challengeHash: H(`challenge-${label}`),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:02:00.000Z',
    ...overrides,
  });
}

test('identity separation checks signer, account, credential, host, process, and trust domain', () => {
  const reference = identity('origin');
  const ready = evaluateExternalPrincipalIdentitySeparation({
    candidate: identity('remote'),
    references: [reference],
    now: NOW,
    requirePlatformAttestation: true,
  });
  assert.equal(ready.identityIndependenceReady, true);

  for (const [field, property] of Object.entries({
    signerSpki: 'signerPublicKeySpkiHash',
    providerAccount: 'providerAccountIdentityHash',
    credentialRoot: 'credentialRootIdentityHash',
    host: 'hostIdentityHash',
    process: 'processIdentityHash',
    trustDomain: 'trustDomainIdentityHash',
  })) {
    const blocked = evaluateExternalPrincipalIdentitySeparation({
      candidate: identity(`remote-${field}`, { [property]: reference[property] }),
      references: [reference],
      now: NOW,
      requirePlatformAttestation: true,
    });
    assert.equal(blocked.identityIndependenceReady, false, field);
    assert.ok(blocked.blockers.includes(
      `external_principal_identity_not_distinct:${field}:0`,
    ), field);
  }
});
