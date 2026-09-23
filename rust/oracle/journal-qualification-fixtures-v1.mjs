// TEST-ONLY ephemeral authorities. These fixtures exercise local verification;
// they do not describe or authorize a real portal, network action or live commit.
import crypto from 'node:crypto';
import {
  PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES as ROLES,
  PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES as POLICIES,
  buildPortalTargetQualification, buildPortalTargetQualificationEvidenceAttestation,
  buildPortalTargetQualificationRegistry, buildPortalTargetQualificationSubjectHash,
} from '../../paper-domain/submission/portal-target-qualification-contract.mjs';
import { getJournalSubmissionTargetProfile } from '../../paper-domain/submission/journal-submission-target-registry.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const sha = (label) => hashRecord('RustParityTestOnlyValue', { label });
function authority(role, suffix, pair = crypto.generateKeyPairSync('ed25519')) {
  return { privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), trustKey: {
    keyId: `test-only-${suffix}`, subjectId: `test-only-principal:${suffix}`, organization: `test-only-organization:${suffix}`,
    algorithm: 'ed25519', status: 'active', roles: [role], publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  } };
}
function fixture({ now, sandbox = false, sharedPair = null, venues = ['tmlr'], empty = false, generation = 1, unsignedEvidence = false, issuerMismatch = false } = {}) {
  const stamp = (offset) => new Date(now + offset).toISOString();
  const owner = authority(ROLES.owner, 'owner', sharedPair || undefined);
  const observer = authority(ROLES.observer, 'observer', sharedPair || undefined);
  const authorizer = authority(ROLES.productionAuthorizer, 'authorizer', sharedPair || undefined);
  const authorities = [owner, observer, authorizer];
  const sign = (document, signer) => signAuthorityDocument(document, { privateKeyPem: signer.privateKeyPem, keyId: signer.trustKey.keyId, role: signer.trustKey.roles[0] });
  const entries = empty ? [] : venues.map((venue) => {
    const target = getJournalSubmissionTargetProfile(venue);
    const binding = {
      venueId: venue, venueKind: target.venueKind, baseTargetProfileHash: target.journalSubmissionTargetProfileHash,
      targetInstanceId: `TEST_ONLY/${venue}/2026`, edition: target.venueKind === 'conference' ? '2026' : null,
      track: target.venueKind === 'conference' ? 'test-track' : null, connectorFamily: 'openreview-api-v2',
      portalOriginHash: sha('origin'), submissionRouteHash: sha('route'), schemaFingerprintHash: sha('schema'),
      authenticationProfileHash: sha('auth'), automationPolicyEvidenceHash: sha('policy'), statusMappingHash: sha('status'),
      portalConfigurationHash: sha('config'), portalDescriptorHash: sha('descriptor'),
    };
    const subjectHash = buildPortalTargetQualificationSubjectHash(binding);
    const evidence = Object.fromEntries(Object.entries(POLICIES).map(([kind, policy], index) => {
      if (sandbox && index >= 3) return [kind, null];
      const signer = kind === 'discovery' ? owner : kind === 'productionAuthorization' ? authorizer : observer;
      let attestation = buildPortalTargetQualificationEvidenceAttestation({
        evidenceType: kind, issuerPrincipalId: issuerMismatch && kind === 'sandboxCanary' ? owner.trustKey.subjectId : signer.trustKey.subjectId,
        subjectHash, artifactKind: policy.artifactKind, artifactHash: sha(`artifact:${kind}`),
        verificationReceiptKind: policy.verificationReceiptKind, verificationReceiptHash: sha(`receipt:${kind}`),
        verificationPolicyHash: sha(`policy:${kind}`), verifierRole: policy.authorityRole,
        evidenceEnvironment: policy.evidenceEnvironment, authorizationScope: policy.authorizationScope,
        observedAt: stamp(-60_000), expiresAt: stamp(40 * 60_000),
      });
      if (!unsignedEvidence) attestation = sign(attestation, signer);
      return [kind, attestation];
    }));
    return buildPortalTargetQualification({ ...binding, qualificationLevel: sandbox ? 'sandbox' : 'production', qualifiedAt: stamp(-30_000), expiresAt: stamp(40 * 60_000), evidence });
  });
  let registry = buildPortalTargetQualificationRegistry({
    generation, predecessorRegistryHash: generation > 1 ? sha('prior-registry') : null,
    issuedAt: stamp(-10_000), expiresAt: stamp(20 * 60_000), entries, signatures: [],
  });
  const signers = sandbox || empty ? [owner, observer] : authorities;
  const resign = (value) => signers.reduce((value, signer) => sign(value, signer), { ...value, signatures: [] });
  registry = resign(registry);
  return { registry, trust: { version: 1, kind: 'AuthorityTrustStore', keys: authorities.map((a) => a.trustKey) }, resign, authorities };
}
export function qualificationFixtures(now = Date.now()) {
  const fixtures = [];
  const add = (label, fixture) => {
    const registryText = `${JSON.stringify(fixture.registry, null, 2)}\n`;
    const trustText = `${JSON.stringify(fixture.trust, null, 2)}\n`;
    fixtures.push({ label, registryText, trustText, expectedRegistryHash: fixture.registry.portalTargetQualificationRegistryHash,
      expectedTrustStoreHash: hashBytes(Buffer.from(trustText)), now: new Date(now).toISOString() });
  };
  const base = fixture({ now });
  add('production', base);
  add('sandbox', fixture({ now, sandbox: true }));
  add('two-conferences', fixture({ now, venues: ['neurips', 'iclr'] }));
  add('empty', fixture({ now, empty: true }));
  add('successor', fixture({ now, generation: 2 }));
  add('shared-spki', fixture({ now, sharedPair: crypto.generateKeyPairSync('ed25519') }));
  add('unsigned-evidence', fixture({ now, unsignedEvidence: true }));
  add('issuer-mismatch', fixture({ now, issuerMismatch: true }));
  const mutate = (label, change) => { const f = { ...base, registry: structuredClone(base.registry), trust: structuredClone(base.trust) }; change(f); add(label, f); };
  mutate('unsigned-registry', f => { f.registry.signatures = []; });
  mutate('missing-registry-role', f => { f.registry.signatures.pop(); });
  mutate('extra-registry-signature', f => { f.registry.signatures.push(f.registry.signatures[0]); });
  mutate('invalid-registry-signature', f => { f.registry.signatures[0].value = 'invalid-signature'; });
  mutate('untrusted-owner', f => { f.trust.keys.shift(); });
  mutate('inactive-owner', f => { f.trust.keys[0].status = 'revoked'; });
  mutate('role-denied', f => { f.trust.keys[0].roles = []; });
  mutate('trust-algorithm-mismatch', f => { f.trust.keys[0].algorithm = 'rsa'; });
  mutate('invalid-public-key', f => { f.trust.keys[0].publicKeyPem = 'invalid'; });
  mutate('invalid-pem-base64', f => { f.trust.keys[0].publicKeyPem = f.trust.keys[0].publicKeyPem.replace('\n', '\n!'); });
  mutate('private-material', f => { f.trust.keys[0].privateKeyPem = 'TEST_ONLY_PRIVATE_KEY_FORBIDDEN'; });
  mutate('duplicate-trust-id', f => { f.trust.keys.push(f.trust.keys[0]); });
  mutate('organization-alias', f => { f.trust.keys[1].organization = ` ${f.trust.keys[0].organization.toUpperCase()} `; });
  mutate('organization-empty', f => { f.trust.keys[1].organization = ' '; });
  mutate('principal-alias', f => { f.trust.keys[1].subjectId = f.trust.keys[0].subjectId; });
  mutate('invalid-trust-kind', f => { f.trust.kind = 'InvalidTrustStore'; });
  for (const [kind, options] of [['rsa', {modulusLength: 2048}], ['ec', {namedCurve: 'P-256'}], ['ed448', {}]]) {
    mutate(`wrong-key-type-${kind}`, f => { f.trust.keys[0].publicKeyPem = crypto.generateKeyPairSync(kind, options).publicKey.export({type: 'spki',format: 'pem'}); });
  }
  mutate('entry-hash-tamper', f => { f.registry.entries[0].portalOriginHash = sha('changed'); });
  mutate('registry-order-tamper', f => { const {version, ...rest} = f.registry; f.registry = {...rest, version}; });
  mutate('evidence-order-tamper', f => { const {version, ...rest} = f.registry.entries[0].evidence.discovery; f.registry.entries[0].evidence.discovery = {...rest, version}; });
  mutate('registry-extra-key', f => { f.registry.unexpected = true; });
  mutate('generation-coercion', f => { f.registry.generation = '1'; });
  mutate('timestamp-noncanonical', f => { f.registry.issuedAt = f.registry.issuedAt.replace('.000Z', 'Z') + ' '; });
  mutate('signature-key-order', f => { const {keyId, ...rest} = f.registry.signatures[0]; f.registry.signatures[0] = {...rest, keyId}; });
  mutate('base64-lenient', f => { f.registry.signatures[0].value = ` \n${f.registry.signatures[0].value.replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}!!`; });
  mutate('evidence-invalid-signature', f => {
    f.registry.entries[0].evidence.sandboxCanary.signatures[0].value = 'tampered';
    f.registry.entries = f.registry.entries.map(buildPortalTargetQualification);
    f.registry = f.resign(buildPortalTargetQualificationRegistry(f.registry));
  });
  return fixtures;
}
