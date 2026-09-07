import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalAcceptancePayload,
  sha256Bytes,
  verifyProviderExternalAcceptanceReceipt,
} from '../../docs/provider-sandbox/tools/verify-provider-external-acceptance-receipt.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const roles = Object.freeze([
  'provider_owner',
  'evidence_owner',
  'release_owner',
]);

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function baseReceipt() {
  return {
    schemaVersion: 1,
    kind: 'ProviderExternalAcceptanceReceiptV1',
    status: 'technical_external_companion_accepted_non_authorizing',
    exactSubject: {
      repositoryId: 1349108143,
      repository: 'TrillionniumFoundation/hepta-paper',
      pullRequest: 103,
      baseRef: 'codex/planning-provider-convergence-20260907',
      baseCommit: '1'.repeat(40),
      baseTree: '2'.repeat(40),
      headRef: 'codex/provider-external-acceptance-kit-v1-20260907',
      headCommit: '3'.repeat(40),
      headTree: '4'.repeat(40),
      prospectiveMergeCommit: '5'.repeat(40),
      prospectiveMergeTree: '6'.repeat(40),
      mergeParents: ['1'.repeat(40), '3'.repeat(40)],
    },
    providerSubject: {
      providerOwnerId: 'provider-owner-alpha',
      providerAccountId: 'provider-sandbox-account-alpha',
      sandboxAccount: true,
      credentialVersionSha256: digest,
      endpointSetSha256: digest,
      companionReleaseId: 'provider-companion-v1.0.0',
      companionExecutableSha256: digest,
      targetHostId: 'provider-target-host-alpha',
      targetHostProfileSha256: digest,
    },
    evidence: {
      sourceManifestSha256: digest,
      conformanceResultSha256: digest,
      quarantineResultSha256: digest,
      idempotencyRecoveryResultSha256: digest,
      revocationResultSha256: digest,
      evidenceIndexSha256: digest,
      retentionReceiptSha256: digest,
    },
    currentness: {
      observedAt: '2026-09-07T00:10:00Z',
      validUntil: '2026-09-07T01:10:00Z',
      revocationSnapshotSha256: digest,
      currentnessVerifierSha256: digest,
      liveRevalidationRequired: true,
    },
    decisions: [],
    technicalCompanionAccepted: true,
    authority: {
      providerAuthorized: false,
      credentialCustodyEstablished: false,
      externalActionAuthorized: false,
      releaseAuthorized: false,
      submissionAuthorized: false,
      productionAuthorized: false,
      externalAuthorityClaimed: false,
    },
  };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-signature-verifier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o700);
  const receipt = baseReceipt();
  const payload = canonicalAcceptancePayload(receipt);
  const payloadSha256 = sha256Bytes(payload);
  assert.equal(payloadSha256, sha256(payload));
  const registry = {
    schemaVersion: 1,
    kind: 'ProviderExternalPrincipalRegistryV1',
    status: 'external_principal_registry_unaccepted',
    registryId: 'provider-external-principals-alpha',
    generation: 1,
    observedAt: '2026-09-07T00:05:00Z',
    principals: [],
    authority: structuredClone(receipt.authority),
  };
  const publicKeyPaths = Object.create(null);
  const signaturePaths = Object.create(null);
  const privateKeys = Object.create(null);
  for (const [index, role] of roles.entries()) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    privateKeys[role] = privateKey;
    const keyBytes = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }));
    const signatureBytes = sign(null, payload, privateKey);
    const publicKeyPath = path.join(directory, `${role}.public.pem`);
    const signaturePath = path.join(directory, `${role}.signature`);
    fs.writeFileSync(publicKeyPath, keyBytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(signaturePath, signatureBytes, { flag: 'wx', mode: 0o600 });
    publicKeyPaths[`--${role.replaceAll('_', '-')}-public-key`] = publicKeyPath;
    signaturePaths[`--${role.replaceAll('_', '-')}-signature`] = signaturePath;
    registry.principals.push({
      role,
      principalId: `${role}-principal-${index + 1}`,
      publicKeySha256: sha256(keyBytes),
      algorithm: 'ed25519',
      activeFrom: '2026-09-07T00:00:00Z',
      validUntil: '2026-09-07T02:00:00Z',
      revocationSnapshotSha256: digest,
    });
    receipt.decisions.push({
      role,
      principalId: `${role}-principal-${index + 1}`,
      decision: 'technical_external_acceptance_approved_non_authorizing',
      decidedAt: '2026-09-07T00:08:00Z',
      signedPayloadSha256: payloadSha256,
      signatureArtifactSha256: sha256(signatureBytes),
      algorithm: 'ed25519',
    });
  }
  const receiptPath = path.join(directory, 'receipt.json');
  const registryPath = path.join(directory, 'registry.json');
  const outputPath = path.join(directory, 'verification.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { flag: 'wx', mode: 0o600 });
  return {
    directory,
    receipt,
    receiptPath,
    registry,
    registryPath,
    outputPath,
    publicKeyPaths,
    signaturePaths,
    privateKeys,
    payload,
  };
}

function rewrite(file, value) {
  fs.rmSync(file);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
}

function verify(value) {
  return verifyProviderExternalAcceptanceReceipt({
    receiptPath: value.receiptPath,
    registryPath: value.registryPath,
    now: '2026-09-07T00:20:00Z',
    publicKeyPaths: value.publicKeyPaths,
    signaturePaths: value.signaturePaths,
    outputPath: value.outputPath,
    temporaryParent: value.directory,
  });
}

test('three distinct Ed25519 principals verify one canonical acceptance payload', (t) => {
  const value = fixture(t);
  const result = verify(value);
  assert.equal(
    result.status,
    'cryptographically_verified_technical_external_acceptance_non_authorizing',
  );
  assert.equal(result.signedPayloadSha256, sha256(value.payload));
  assert.equal(result.decisions.length, 3);
  assert.deepEqual(result.decisions.map((decision) => decision.role), roles);
  assert.ok(result.decisions.every((decision) => decision.verified === true));
  for (const flag of [
    'providerAuthorized',
    'credentialCustodyEstablished',
    'externalActionAuthorized',
    'releaseAuthorized',
    'submissionAuthorized',
    'productionAuthorized',
    'externalAuthorityClaimed',
  ]) assert.equal(result[flag], false, flag);
  assert.equal(fs.statSync(value.outputPath).mode & 0o777, 0o600);
});

test('changed evidence cannot reuse the original signed payload', (t) => {
  const value = fixture(t);
  value.receipt.evidence.quarantineResultSha256 = `sha256:${'b'.repeat(64)}`;
  rewrite(value.receiptPath, value.receipt);
  assert.throws(() => verify(value), /provider_acceptance_signed_payload_hash_invalid/u);
  assert.equal(fs.existsSync(value.outputPath), false);
});

test('wrong principal key cannot satisfy a different role', (t) => {
  const value = fixture(t);
  [
    value.publicKeyPaths['--provider-owner-public-key'],
    value.publicKeyPaths['--evidence-owner-public-key'],
  ] = [
    value.publicKeyPaths['--evidence-owner-public-key'],
    value.publicKeyPaths['--provider-owner-public-key'],
  ];
  assert.throws(() => verify(value), /provider_acceptance_public_key_hash_invalid/u);
  assert.equal(fs.existsSync(value.outputPath), false);
});

test('signature bytes are cryptographically checked after their digest is rebound', (t) => {
  const value = fixture(t);
  const role = 'provider_owner';
  const signaturePath = value.signaturePaths['--provider-owner-signature'];
  const corrupted = Buffer.from(fs.readFileSync(signaturePath));
  corrupted[0] ^= 0xff;
  fs.rmSync(signaturePath);
  fs.writeFileSync(signaturePath, corrupted, { flag: 'wx', mode: 0o600 });
  value.receipt.decisions[0].signatureArtifactSha256 = sha256(corrupted);
  rewrite(value.receiptPath, value.receipt);
  assert.throws(() => verify(value), /provider_acceptance_signature_invalid/u);
  assert.equal(fs.existsSync(value.outputPath), false);
});

test('duplicate principals and duplicate public keys are denied', (t) => {
  const duplicatePrincipal = fixture(t);
  duplicatePrincipal.registry.principals[1].principalId =
    duplicatePrincipal.registry.principals[0].principalId;
  duplicatePrincipal.receipt.decisions[1].principalId =
    duplicatePrincipal.receipt.decisions[0].principalId;
  rewrite(duplicatePrincipal.registryPath, duplicatePrincipal.registry);
  rewrite(duplicatePrincipal.receiptPath, duplicatePrincipal.receipt);
  assert.throws(() => verify(duplicatePrincipal), /provider_acceptance_principal_duplicate/u);

  const duplicateKey = fixture(t);
  const firstKey = duplicateKey.publicKeyPaths['--provider-owner-public-key'];
  const secondKey = duplicateKey.publicKeyPaths['--evidence-owner-public-key'];
  const firstBytes = fs.readFileSync(firstKey);
  fs.rmSync(secondKey);
  fs.writeFileSync(secondKey, firstBytes, { flag: 'wx', mode: 0o600 });
  duplicateKey.registry.principals[1].publicKeySha256 = sha256(firstBytes);
  const newSignature = sign(
    null,
    duplicateKey.payload,
    duplicateKey.privateKeys.provider_owner,
  );
  const secondSignature = duplicateKey.signaturePaths['--evidence-owner-signature'];
  fs.rmSync(secondSignature);
  fs.writeFileSync(secondSignature, newSignature, { flag: 'wx', mode: 0o600 });
  duplicateKey.receipt.decisions[1].signatureArtifactSha256 = sha256(newSignature);
  rewrite(duplicateKey.registryPath, duplicateKey.registry);
  rewrite(duplicateKey.receiptPath, duplicateKey.receipt);
  assert.throws(
    () => verify(duplicateKey),
    /provider_acceptance_cryptographic_identity_duplicate/u,
  );
});

test('expired receipt, expired principal and wrong merge parents fail closed', (t) => {
  const expiredReceipt = fixture(t);
  expiredReceipt.receipt.currentness.validUntil = '2026-09-07T00:15:00Z';
  const expiredPayload = canonicalAcceptancePayload(expiredReceipt.receipt);
  const expiredHash = sha256(expiredPayload);
  for (const [index, role] of roles.entries()) {
    const signatureBytes = sign(null, expiredPayload, expiredReceipt.privateKeys[role]);
    expiredReceipt.receipt.decisions[index].signedPayloadSha256 = expiredHash;
    expiredReceipt.receipt.decisions[index].signatureArtifactSha256 = sha256(signatureBytes);
    const signaturePath = expiredReceipt.signaturePaths[
      `--${role.replaceAll('_', '-')}-signature`
    ];
    fs.rmSync(signaturePath);
    fs.writeFileSync(signaturePath, signatureBytes, { flag: 'wx', mode: 0o600 });
  }
  rewrite(expiredReceipt.receiptPath, expiredReceipt.receipt);
  assert.throws(() => verify(expiredReceipt), /provider_acceptance_receipt_not_current/u);

  const expiredPrincipal = fixture(t);
  expiredPrincipal.registry.principals[2].validUntil = '2026-09-07T00:15:00Z';
  rewrite(expiredPrincipal.registryPath, expiredPrincipal.registry);
  assert.throws(() => verify(expiredPrincipal), /provider_acceptance_principal_not_current/u);

  const wrongParents = fixture(t);
  wrongParents.receipt.exactSubject.mergeParents.reverse();
  const wrongPayload = canonicalAcceptancePayload(wrongParents.receipt);
  const wrongHash = sha256(wrongPayload);
  for (const [index, role] of roles.entries()) {
    const signatureBytes = sign(null, wrongPayload, wrongParents.privateKeys[role]);
    wrongParents.receipt.decisions[index].signedPayloadSha256 = wrongHash;
    wrongParents.receipt.decisions[index].signatureArtifactSha256 = sha256(signatureBytes);
    const signaturePath = wrongParents.signaturePaths[
      `--${role.replaceAll('_', '-')}-signature`
    ];
    fs.rmSync(signaturePath);
    fs.writeFileSync(signaturePath, signatureBytes, { flag: 'wx', mode: 0o600 });
  }
  rewrite(wrongParents.receiptPath, wrongParents.receipt);
  assert.throws(() => verify(wrongParents), /provider_acceptance_merge_parent_mismatch/u);
});
