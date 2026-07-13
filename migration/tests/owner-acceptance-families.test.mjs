import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { signAuthorityDocument } from '../../paper-core/src/authority-signatures.mjs';
import { buildOwnerAcceptanceFamilies, verifyOwnerAcceptanceDocument } from '../owner-acceptance.mjs';

test('owner acceptance expands only an exact externally signed capability family', () => {
  const plans = [{
    id: 'legacy-1',
    source: { sha256: 'sha256:source-1' },
    priorDisposition: 'retired_surface',
    businessDecision: 'capability_reimplementation',
    capabilityIds: ['research.claim-registry'],
  }, {
    id: 'legacy-2',
    source: { sha256: 'sha256:source-2' },
    priorDisposition: 'retired_surface',
    businessDecision: 'capability_reimplementation',
    capabilityIds: ['research.claim-registry'],
  }];
  const familyManifest = buildOwnerAcceptanceFamilies(plans);
  assert.equal(familyManifest.families.length, 1);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const family = familyManifest.families[0];
  let document = {
    version: 2,
    kind: 'CapabilityOwnerAcceptance',
    familyManifestHash: familyManifest.familyManifestHash,
    acceptedAt: '2026-07-10T00:00:00.000Z',
    acceptedFamilies: [{
      familyId: family.familyId,
      familyHash: family.familyHash,
      businessDecision: family.businessDecision,
    }],
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
  const accepted = verifyOwnerAcceptanceDocument({ document, trustStore, familyManifest });
  assert.equal(accepted.size, 2);
  const tampered = structuredClone(document);
  tampered.acceptedFamilies[0].familyHash = 'sha256:tampered';
  assert.equal(verifyOwnerAcceptanceDocument({ document: tampered, trustStore, familyManifest }).size, 0);
});

test('permanent retirements are grouped by their migration action, never an undefined family', () => {
  const manifest = buildOwnerAcceptanceFamilies([{
    id: 'legacy-retire-1',
    source: { sha256: 'sha256:source-retire-1' },
    migrationAction: 'retire_obsolete_report',
    businessDecision: 'permanent_retirement',
    capabilityIds: [],
  }, {
    id: 'legacy-retire-2',
    source: { sha256: 'sha256:source-retire-2' },
    migrationAction: 'retire_obsolete_command',
    businessDecision: 'permanent_retirement',
    capabilityIds: [],
  }]);
  assert.equal(manifest.families.length, 2);
  assert.ok(manifest.families.every((family) => !family.familyId.includes('undefined')));
  assert.deepEqual(manifest.families.map((family) => family.migrationAction).sort(), [
    'retire_obsolete_command',
    'retire_obsolete_report',
  ]);
});
