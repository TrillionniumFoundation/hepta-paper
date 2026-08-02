import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  publishAutonomousSubmissionDispatcherChallenge,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-challenge-repository.mjs';
import {
  publishAutonomousSubmissionDispatcherCycleEnvelope,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-cycle-publisher.mjs';
import {
  autonomousSubmissionDispatcherExchangeDirectory,
  dispatcherExchangeFilePath,
  publishDispatcherExchangeDocument,
  readDispatcherExchangeDocument,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-exchange-repository.mjs';
import {
  assertAutonomousSubmissionPortalCanaryAuthorityIndependentFromDispatcher,
  readAutonomousSubmissionDispatcherIdentityConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-cycle-verifier.mjs';
import {
  readAutonomousSubmissionDispatcherCycleSigningConfiguration,
  signAutonomousSubmissionDispatcherCycleReceipt,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-cycle-signer.mjs';
import {
  buildAutonomousSubmissionDispatcherCycleReceipt,
  buildAutonomousSubmissionPortalReadinessCanaryEvidence,
  buildAutonomousSubmissionPortalReadinessCanaryReceipt,
  buildAutonomousSubmissionPortalReadinessCanaryRequest,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  inspectAutonomousSubmissionDispatcherReadiness,
} from '../../paper-composition/automation/autonomous-submission-dispatcher-readiness-composition.mjs';
import {
  deliverAutonomousSubmissionStatesIfReady,
} from '../../paper-composition/automation/autonomous-submission-dispatcher-composition.mjs';
import {
  inspectAutonomousSubmissionDispatcherStoragePreflight,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-storage-preflight.mjs';
import {
  convergeAutonomousSubmissionHandoff,
} from '../../paper-composition/bootstrap/autonomous-submission-handoff-migration-composition.mjs';
import { createDefaultPaperStore }
  from '../../paper-adapters/persistence/store-provider.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
  buildAutonomousSubmissionPortalConfiguration,
  createAutonomousSubmissionPortalDescriptor,
  deriveAutonomousSubmissionPortalPublicConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  buildAutonomousSubmissionPortalIdentityAttestationBundle,
} from '../../paper-adapters/automation/autonomous-submission-portal-identity-attestation.mjs';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const H = (label) => hashRecord('AutonomousSubmissionDispatcherChallengeTest', { label });

function writeJson(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(candidate, mode);
}

function spkiHash(publicKey) {
  return hashBytes(publicKey.export({ type: 'spki', format: 'der' }));
}

function signedEvidenceEnvelope({
  subjectKind,
  subjectHash,
  keyId,
  role,
  privateKey,
  signedAt = new Date(NOW.getTime() - 60_000).toISOString(),
  expiresAt = new Date(NOW.getTime() + 10 * 60_000).toISOString(),
} = {}) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt,
    expiresAt,
    signatures: [{
      keyId,
      role,
      algorithm: 'ed25519',
      value: 'placeholder',
    }],
  });
  return buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{
      keyId,
      role,
      algorithm: 'ed25519',
      value: crypto.sign(
        null,
        pinnedExternalEvidenceSigningPayload(placeholder),
        privateKey,
      ).toString('base64'),
    }],
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dispatcher-challenge-'));
  fs.chmodSync(root, 0o700);
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const nativeStore = createDefaultPaperStore({
    root,
    dbPath: path.join(runtimeRoot, 'hepta-paper.sqlite'),
  });
  const cutover = convergeAutonomousSubmissionHandoff({ nativeStore, runtimeRoot, now: NOW });
  t.after(() => {
    nativeStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runtimeRoot, cutover };
}

function runPublisher({ scriptPath, runtimeRoot, hash, barrierPath, readyPath }) {
  const child = spawn(process.execPath, [
    scriptPath, runtimeRoot, hash, barrierPath, readyPath,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return Object.freeze({ child, completion });
}

async function waitForFiles(candidates, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!candidates.every((candidate) => fs.existsSync(candidate))) {
    if (Date.now() >= deadline) throw new Error('publisher_ready_timeout');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

test('exchange publish never exposes partial final files and converges concurrent writers', async (t) => {
  const { root, runtimeRoot } = fixture(t);
  const kind = 'dispatcher-challenges';
  const hash = H('atomic-publish');
  const directory = autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind,
    create: true,
  });
  const orphan = path.join(directory, `.publish-${hash.slice(7)}-crashed.tmp`);
  fs.writeFileSync(orphan, '{"partial":', { mode: 0o640 });
  const document = Object.freeze({ version: 1, kind: 'FixtureExchange', hash });
  const first = publishDispatcherExchangeDocument({ runtimeRoot, kind, hash, document });
  assert.equal(first.published, true);
  assert.deepEqual(readDispatcherExchangeDocument(first.target), document);
  assert.equal(fs.existsSync(orphan), true);

  const concurrentHash = H('concurrent-publish');
  const barrierPath = path.join(root, 'publisher-barrier');
  const scriptPath = path.join(root, 'publisher.mjs');
  const exchangeModule = new URL(
    '../../paper-adapters/automation/autonomous-submission-dispatcher-exchange-repository.mjs',
    import.meta.url,
  ).href;
  fs.writeFileSync(scriptPath, `import fs from 'node:fs';
import { publishDispatcherExchangeDocument } from ${JSON.stringify(exchangeModule)};
const [runtimeRoot, hash, barrierPath, readyPath] = process.argv.slice(2);
process.umask(0o077);
fs.writeFileSync(readyPath, 'ready\\n', { flag: 'wx', mode: 0o600 });
const waitArray = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(barrierPath)) Atomics.wait(waitArray, 0, 0, 5);
const result = publishDispatcherExchangeDocument({
  runtimeRoot,
  kind: 'dispatcher-cycles',
  hash,
  document: { version: 1, kind: 'ConcurrentFixtureExchange', hash },
});
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
  const publisherCount = 8;
  const readyPaths = Array.from({ length: publisherCount }, (_, index) => (
    path.join(root, `publisher-ready-${index}`)
  ));
  const publishers = readyPaths.map((readyPath) => runPublisher({
    scriptPath,
    runtimeRoot,
    hash: concurrentHash,
    barrierPath,
    readyPath,
  }));
  t.after(() => {
    for (const { child } of publishers) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
  await waitForFiles(readyPaths);
  fs.writeFileSync(barrierPath, 'go\n', { mode: 0o600 });
  const results = await Promise.all(publishers.map(({ completion }) => completion));
  assert.ok(results.every((result) => result.status === 0),
    results.map((result) => result.stderr).join('\n'));
  const publications = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(publications.map((result) => result.published).sort(), [
    ...Array.from({ length: publisherCount - 1 }, () => false),
    true,
  ]);
  const target = dispatcherExchangeFilePath({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    hash: concurrentHash,
  });
  assert.deepEqual(readDispatcherExchangeDocument(target), {
    version: 1,
    kind: 'ConcurrentFixtureExchange',
    hash: concurrentHash,
  });
  assert.equal(fs.lstatSync(path.dirname(target)).mode & 0o7777, 0o2750);
  assert.deepEqual(fs.readdirSync(path.dirname(target))
    .filter((name) => name.startsWith(`.publish-${concurrentHash.slice(7)}-`)), []);
});

test('exchange directory converges a same-owner umask-masked EEXIST target', (t) => {
  const { runtimeRoot } = fixture(t);
  const selected = autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
  });
  fs.mkdirSync(selected, { mode: 0o700 });
  fs.chmodSync(selected, 0o2700);
  assert.equal(autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    create: true,
  }), selected);
  assert.equal(fs.lstatSync(selected).mode & 0o7777, 0o2750);
});

test('exchange directory creation still fails closed on an unsafe EEXIST target', (t) => {
  const { runtimeRoot } = fixture(t);
  const selected = autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
  });
  fs.writeFileSync(selected, 'not a directory\n', { mode: 0o640 });
  assert.throws(() => autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    create: true,
  }), /autonomous_submission_dispatcher_exchange_directory_unsafe/);
});

test('exchange directory creation never follows a pre-existing symlink', (t) => {
  const { root, runtimeRoot } = fixture(t);
  const selected = autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
  });
  const outside = path.join(root, 'outside-directory');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.chmodSync(outside, 0o700);
  fs.symlinkSync(outside, selected, 'dir');
  assert.throws(() => autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    create: true,
  }), /autonomous_submission_dispatcher_exchange_directory_unsafe/);
  assert.equal(fs.lstatSync(outside).mode & 0o7777, 0o700);
});

test('exchange directory creation never chmods a replacement symlink target', (t) => {
  const { root, runtimeRoot } = fixture(t);
  const selected = autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
  });
  const outside = path.join(root, 'replacement-outside-directory');
  const displaced = path.join(root, 'displaced-created-directory');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.chmodSync(outside, 0o700);
  const scriptPath = path.join(root, 'replacement-race.mjs');
  const exchangeModule = new URL(
    '../../paper-adapters/automation/autonomous-submission-dispatcher-exchange-repository.mjs',
    import.meta.url,
  ).href;
  fs.writeFileSync(scriptPath, `import fs from 'node:fs';
import { autonomousSubmissionDispatcherExchangeDirectory } from ${JSON.stringify(exchangeModule)};
const [runtimeRoot, selected, outside, displaced] = process.argv.slice(2);
const originalMkdirSync = fs.mkdirSync;
fs.mkdirSync = (candidate, options) => {
  const result = originalMkdirSync(candidate, options);
  if (candidate === selected) {
    fs.renameSync(selected, displaced);
    fs.symlinkSync(outside, selected, 'dir');
  }
  return result;
};
try {
  autonomousSubmissionDispatcherExchangeDirectory({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    create: true,
  });
  process.exitCode = 2;
} catch (error) {
  if (error?.message !== 'autonomous_submission_dispatcher_exchange_directory_unsafe') {
    throw error;
  }
}
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [
    scriptPath, runtimeRoot, selected, outside, displaced,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.lstatSync(outside).mode & 0o7777, 0o700);
});

test('plan-bound challenge converges only through an externally signed resident cycle', (t) => {
  const { root, runtimeRoot, cutover } = fixture(t);
  const portalPair = crypto.generateKeyPairSync('ed25519');
  const dispatcherPair = crypto.generateKeyPairSync('ed25519');
  const identityAttestorPair = crypto.generateKeyPairSync('ed25519');
  const dispatcherPrivateKey = dispatcherPair.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  const planHash = H('plan');
  const idempotencyKey = H('idempotency');
  const portalId = 'portal:production';
  const portalSignerKeyId = 'portal-canary-key';
  const portalSignerRole = 'autonomous_submission_portal';
  const identityAttestorKeyId = 'portal-identity-attestor-key';
  const identityAttestorRole = 'external_principal_identity_attestor';
  const portalTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: portalSignerKeyId,
      subjectId: 'portal-canary-authority',
      algorithm: 'ed25519',
      publicKeyPem: portalPair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [portalSignerRole],
      status: 'active',
    }],
  };
  const identityTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: identityAttestorKeyId,
      subjectId: 'independent-portal-identity-attestor',
      organization: 'Independent Portal Identity Attestor',
      algorithm: 'ed25519',
      publicKeyPem: identityAttestorPair.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      roles: [identityAttestorRole],
      status: 'active',
    }],
  };
  const portalIdentity = buildExternalPrincipalIdentityAttestationSubject({
    serviceId: portalId,
    principalId: 'portal:production-principal',
    provider: 'portal-provider',
    providerAccountIdentityHash: H('portal-account'),
    credentialRootIdentityHash: H('portal-credential-root'),
    hostIdentityHash: H('portal-host'),
    processIdentityHash: H('portal-process'),
    trustDomainIdentityHash: H('portal-trust-domain'),
    signerPublicKeySpkiHash: spkiHash(portalPair.publicKey),
    challengeHash: H('portal-identity-challenge'),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
  });
  const localOriginIdentity = buildExternalPrincipalIdentityAttestationSubject({
    serviceId: 'research-origin',
    principalId: 'research-origin-principal',
    provider: 'research-provider',
    providerAccountIdentityHash: H('research-origin-account'),
    credentialRootIdentityHash: H('research-origin-credential-root'),
    hostIdentityHash: H('research-origin-host'),
    processIdentityHash: H('research-origin-process'),
    trustDomainIdentityHash: H('research-origin-trust-domain'),
    signerPublicKeySpkiHash: H('research-origin-signer'),
    challengeHash: H('research-origin-identity-challenge'),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
  });
  const identityBundle = (subject) => (
    buildAutonomousSubmissionPortalIdentityAttestationBundle({
      subject,
      authorityEnvelope: signedEvidenceEnvelope({
        subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
        subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
        keyId: identityAttestorKeyId,
        role: identityAttestorRole,
        privateKey: identityAttestorPair.privateKey,
      }),
      trustStore: identityTrustStore,
      signerKeyIds: [identityAttestorKeyId],
      signerRole: identityAttestorRole,
    })
  );
  const privatePortalConfiguration = buildAutonomousSubmissionPortalConfiguration({
    version: 3,
    portalId,
    endpoint: 'https://portal.example.test/submissions',
    serviceIdentityHash: portalIdentity.externalPrincipalIdentityAttestationSubjectHash,
    portalAccountIdentityHash: portalIdentity.providerAccountIdentityHash,
    portalTrustDomainIdentityHash: portalIdentity.trustDomainIdentityHash,
    tokenEnvironmentVariable: 'PORTAL_TEST_TOKEN',
    receiptTrustStore: portalTrustStore,
    receiptSignerKeyIds: [portalSignerKeyId],
    receiptSignerRole: portalSignerRole,
    portalIdentityAttestationBundle: identityBundle(portalIdentity),
    localOriginIdentityAttestationBundles: [identityBundle(localOriginIdentity)],
  });
  const portalConfigurationHash = privatePortalConfiguration.configurationHash;
  const portalDescriptor = deriveAutonomousSubmissionPortalPublicConfiguration({
    configuration: privatePortalConfiguration,
  });
  const portalDescriptorHash =
    autonomousSubmissionPortalPublicDescriptorHash(portalDescriptor);
  const portalDescriptorPath = path.join(root, 'portal-descriptor.json');
  writeJson(portalDescriptorPath, portalDescriptor);
  assert.equal(createAutonomousSubmissionPortalDescriptor({
    configuration: portalDescriptor,
    expectedConfigurationHash: portalConfigurationHash,
    expectedDescriptorHash: portalDescriptorHash,
    clock: { now: () => new Date(NOW.getTime() + 2_000) },
  }).fullProductionReady, true);
  const published = publishAutonomousSubmissionDispatcherChallenge({
    runtimeRoot,
    planHash,
    idempotencyKey,
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    now: NOW,
  });
  const repeated = publishAutonomousSubmissionDispatcherChallenge({
    runtimeRoot,
    planHash,
    idempotencyKey,
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    now: NOW,
  });
  assert.equal(published.challengeHash, repeated.challengeHash);
  assert.equal(repeated.published, false);

  const trustPath = path.join(root, 'dispatcher-cycle-trust.json');
  writeJson(trustPath, {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'dispatcher-cycle-key',
      subjectId: 'dispatcher-cycle-subject',
      algorithm: 'ed25519',
      publicKeyPem: dispatcherPair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['autonomous-submission-dispatcher-cycle-signer'],
      status: 'active',
    }],
  });
  const identityPath = path.join(root, 'dispatcher-identity.json');
  writeJson(identityPath, {
    version: 1,
    kind: 'AutonomousSubmissionDispatcherIdentityConfiguration',
    principalId: 'dispatcher:production',
    role: 'autonomous-submission-dispatcher',
    status: 'active',
    cycleMaximumLifetimeMs: 600_000,
    cycleSigner: {
      algorithm: 'ed25519',
      keyId: 'dispatcher-cycle-key',
      role: 'autonomous-submission-dispatcher-cycle-signer',
      trustStorePath: trustPath,
    },
  });
  const identity = readAutonomousSubmissionDispatcherIdentityConfiguration({
    configurationPath: identityPath,
  });
  const signerPath = path.join(root, 'signer.mjs');
  fs.writeFileSync(signerPath, `#!/usr/bin/env node
import crypto from 'node:crypto';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input); const key=Buffer.from(process.env.TEST_KEY,'base64').toString();
const signature=crypto.sign(null,Buffer.from(request.payloadBase64,'base64'),key).toString('base64');
process.stdout.write(JSON.stringify({version:1,kind:'AutonomousSubmissionDispatcherCycleSigningResponse',keyId:request.keyId,role:request.role,algorithm:'ed25519',payloadHash:request.payloadHash,signature}));
`, { mode: 0o700 });
  fs.chmodSync(signerPath, 0o700);
  const signingPath = path.join(root, 'signing.json');
  writeJson(signingPath, {
    version: 1,
    kind: 'AutonomousSubmissionDispatcherCycleSigningConfiguration',
    identityConfigurationPath: identityPath,
    identityConfigurationHash: identity.configurationHash,
    signer: {
      backendKind: 'external-command-ed25519-v1',
      algorithm: 'ed25519',
      keyId: identity.signer.keyId,
      role: identity.signer.role,
      command: signerPath,
      arguments: [],
      environmentAllowlist: ['TEST_KEY'],
      timeoutMs: 10_000,
    },
  });
  const signing = readAutonomousSubmissionDispatcherCycleSigningConfiguration({
    configurationPath: signingPath,
  });
  const signedAt = new Date(NOW.getTime() + 1_000).toISOString();
  const canaryRequest = buildAutonomousSubmissionPortalReadinessCanaryRequest({
    challenge: published.challenge,
    nonce: 'canary:test-cycle',
    requestedAt: NOW.toISOString(),
  });
  const canaryReceipt = buildAutonomousSubmissionPortalReadinessCanaryReceipt({
    request: canaryRequest,
    serviceIdentityHash: portalDescriptor.serviceIdentityHash,
    portalAccountIdentityHash: portalDescriptor.portalAccountIdentityHash,
    portalTrustDomainIdentityHash: portalDescriptor.portalTrustDomainIdentityHash,
    externalActionPerformed: false,
    observedAt: signedAt,
    expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
  });
  const canaryPlaceholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind: 'AutonomousSubmissionPortalReadinessCanaryReceipt',
    subjectHash: canaryReceipt.canaryReceiptHash,
    signedAt,
    expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    signatures: [{
      keyId: portalSignerKeyId,
      role: portalSignerRole,
      algorithm: 'ed25519',
      value: 'placeholder',
    }],
  });
  const canaryAuthorityEnvelope = buildPinnedExternalEvidenceEnvelope({
    ...canaryPlaceholder,
    signatures: [{
      keyId: portalSignerKeyId,
      role: portalSignerRole,
      algorithm: 'ed25519',
      value: crypto.sign(
        null,
        pinnedExternalEvidenceSigningPayload(canaryPlaceholder),
        portalPair.privateKey,
      ).toString('base64'),
    }],
  });
  const canaryEvidence = buildAutonomousSubmissionPortalReadinessCanaryEvidence({
    challenge: published.challenge,
    request: canaryRequest,
    receipt: canaryReceipt,
    authorityEnvelope: canaryAuthorityEnvelope,
  });
  const canaryVerification = assertPinnedExternalEvidenceEnvelope({
    envelope: canaryAuthorityEnvelope,
    subjectKind: 'AutonomousSubmissionPortalReadinessCanaryReceipt',
    subjectHash: canaryReceipt.canaryReceiptHash,
    trustStore: portalTrustStore,
    requiredRole: portalSignerRole,
    expectedKeyIds: [portalSignerKeyId],
    now: new Date(signedAt),
    maximumLifetimeMs: privatePortalConfiguration.receiptMaximumLifetimeMs,
  });
  assert.equal(
    assertAutonomousSubmissionPortalCanaryAuthorityIndependentFromDispatcher({
      verificationReceipt: canaryVerification,
      identity,
    }).independent,
    true,
  );
  assert.throws(
    () => assertAutonomousSubmissionPortalCanaryAuthorityIndependentFromDispatcher({
      verificationReceipt: canaryVerification,
      identity: {
        principalId: 'dispatcher:colliding',
        signerIdentity: {
          subjectId: 'portal-canary-authority',
          publicKeySpkiHash: spkiHash(portalPair.publicKey),
        },
      },
    }),
    /canary_authority_not_independent_from_dispatcher/,
  );
  const receipt = buildAutonomousSubmissionDispatcherCycleReceipt({
    challenge: published.challenge,
    cyclePlanHash: H('cycle-plan'),
    dispatcherPrincipalId: identity.principalId,
    dispatcherIdentityConfigurationHash: identity.configurationHash,
    processIdentityHash: H('process'),
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    portalBindingVerified: true,
    portalVerifierReady: true,
    portalIdentityIndependenceReady: true,
    portalFullProductionReady: true,
    livePortalCanaryVerified: true,
    livePortalCanaryReceiptHash: canaryReceipt.canaryReceiptHash,
    livePortalCanaryVerificationReceiptHash:
      canaryVerification.pinnedExternalEvidenceVerificationReceiptHash,
    livePortalCanaryVerificationVerifiedAt: canaryVerification.verifiedAt,
    livePortalCanaryAuthorityIndependentFromDispatcher: true,
    livePortalCanaryExternalActionPerformed: false,
    livePortalCanaryEvidence: canaryEvidence,
    cutoverId: cutover.cutoverId,
    handoffInstanceNonce: cutover.handoffInstanceNonce,
    handoffDatabaseIdentityHash: cutover.handoffDatabaseIdentityHash,
    nativeStoreInaccessibleOrReadOnlyVerified: true,
    handoffStoreWriteVerified: true,
    storageLayoutHash: H('storage-layout'),
    inspectedHandoffCount: 0,
    completedHandoffCount: 0,
    pendingHandoffCount: 0,
    explicitFailureCount: 0,
    networkActionPerformed: false,
    startedAt: NOW.toISOString(),
    signedAt,
    expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
  });
  const envelope = signAutonomousSubmissionDispatcherCycleReceipt({
    receipt,
    challenge: published.challenge,
    signingConfiguration: signing,
    environment: {
      TEST_KEY: Buffer.from(dispatcherPrivateKey).toString('base64'),
    },
  });
  publishAutonomousSubmissionDispatcherCycleEnvelope({
    runtimeRoot,
    challenge: published.challenge,
    envelope,
  });
  const inspection = inspectAutonomousSubmissionDispatcherReadiness({
    runtimeRoot,
    environment: {
      HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: identityPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: portalDescriptorPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
        portalConfigurationHash,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
        portalDescriptorHash,
    },
    now: new Date(NOW.getTime() + 2_000),
    planHash,
    idempotencyKey,
  });
  assert.equal(inspection.ready, true, JSON.stringify(inspection.blockers));
  assert.equal(inspection.signatureVerified, true);
  assert.equal(inspection.cycleReceiptHash, envelope.cycleReceiptHash);
  const cyclePath = dispatcherExchangeFilePath({
    runtimeRoot,
    kind: 'dispatcher-cycles',
    hash: published.challengeHash,
  });
  const wrongVerificationHashReceipt = buildAutonomousSubmissionDispatcherCycleReceipt({
    ...receipt,
    challenge: published.challenge,
    livePortalCanaryVerificationReceiptHash: H('wrong-canary-verification'),
  });
  const dispatcherSignedWrongVerificationHash =
    signAutonomousSubmissionDispatcherCycleReceipt({
      receipt: wrongVerificationHashReceipt,
      challenge: published.challenge,
      signingConfiguration: signing,
      environment: {
        TEST_KEY: Buffer.from(dispatcherPrivateKey).toString('base64'),
      },
    });
  writeJson(cyclePath, dispatcherSignedWrongVerificationHash, 0o640);
  const wrongVerificationHash = inspectAutonomousSubmissionDispatcherReadiness({
    runtimeRoot,
    environment: {
      HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: identityPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: portalDescriptorPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
        portalConfigurationHash,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
        portalDescriptorHash,
    },
    now: new Date(NOW.getTime() + 2_000),
    planHash,
    idempotencyKey,
  });
  assert.equal(wrongVerificationHash.signatureVerified, true);
  assert.equal(wrongVerificationHash.ready, false);
  assert.ok(wrongVerificationHash.blockers.includes(
    'autonomous_submission_dispatcher_portal_canary_not_independently_verified',
  ));
  const forgedPortalEnvelope = {
    ...canaryAuthorityEnvelope,
    signatures: [{
      ...canaryAuthorityEnvelope.signatures[0],
      value: Buffer.alloc(64, 7).toString('base64'),
    }],
  };
  const forgedEvidence = buildAutonomousSubmissionPortalReadinessCanaryEvidence({
    challenge: published.challenge,
    request: canaryRequest,
    receipt: canaryReceipt,
    authorityEnvelope: forgedPortalEnvelope,
  });
  const forgedReceipt = buildAutonomousSubmissionDispatcherCycleReceipt({
    ...receipt,
    challenge: published.challenge,
    livePortalCanaryEvidence: forgedEvidence,
  });
  const dispatcherSignedForgery = signAutonomousSubmissionDispatcherCycleReceipt({
    receipt: forgedReceipt,
    challenge: published.challenge,
    signingConfiguration: signing,
    environment: {
      TEST_KEY: Buffer.from(dispatcherPrivateKey).toString('base64'),
    },
  });
  writeJson(cyclePath, dispatcherSignedForgery, 0o640);
  const forgedCanary = inspectAutonomousSubmissionDispatcherReadiness({
    runtimeRoot,
    environment: {
      HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: identityPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: portalDescriptorPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
        portalConfigurationHash,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
        portalDescriptorHash,
    },
    now: new Date(NOW.getTime() + 2_000),
    planHash,
    idempotencyKey,
  });
  assert.equal(forgedCanary.signatureVerified, true);
  assert.equal(forgedCanary.ready, false);
  assert.ok(forgedCanary.blockers.includes(
    'autonomous_submission_dispatcher_portal_canary_not_independently_verified',
  ));
  const expired = inspectAutonomousSubmissionDispatcherReadiness({
    runtimeRoot,
    environment: {
      HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: identityPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: portalDescriptorPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
        portalConfigurationHash,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
        portalDescriptorHash,
    },
    now: new Date(NOW.getTime() + 400_000),
    planHash,
    idempotencyKey,
  });
  assert.equal(expired.ready, false);
  writeJson(cyclePath, { ...envelope, portalConfigurationHash: H('tampered') }, 0o640);
  const tampered = inspectAutonomousSubmissionDispatcherReadiness({
    runtimeRoot,
    environment: {
      HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: identityPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: portalDescriptorPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
        portalConfigurationHash,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
        portalDescriptorHash,
    },
    now: new Date(NOW.getTime() + 2_000),
    planHash,
    idempotencyKey,
  });
  assert.equal(tampered.ready, false);
  assert.ok(tampered.blockers.includes('autonomous_submission_dispatcher_cycle_invalid'));
});

test('missing challenge never bypasses portal, identity, or storage readiness', async () => {
  let deliveryCalls = 0;
  const deliver = async () => {
    deliveryCalls += 1;
    return Object.freeze({ networkActionPerformed: true });
  };
  const common = {
    states: [Object.freeze({ request: Object.freeze({ campaignId: 'campaign:test' }) })],
    portal: Object.freeze({}),
    outbox: Object.freeze({}),
    submissionRequestVerifier: Object.freeze({}),
    portalFullProductionReady: true,
    livePortalCanaryReady: true,
    deliver,
  };
  for (const readiness of [
    {
      portalVerifierReady: false,
      portalIdentityIndependenceReady: true,
      storagePreflight: { ready: true },
    },
    {
      portalVerifierReady: true,
      portalIdentityIndependenceReady: false,
      storagePreflight: { ready: true },
    },
    {
      portalVerifierReady: true,
      portalIdentityIndependenceReady: true,
      storagePreflight: { ready: false },
    },
    {
      portalVerifierReady: true,
      portalIdentityIndependenceReady: true,
      portalFullProductionReady: false,
      storagePreflight: { ready: true },
    },
    {
      portalVerifierReady: true,
      portalIdentityIndependenceReady: true,
      livePortalCanaryReady: false,
      storagePreflight: { ready: true },
    },
  ]) {
    assert.deepEqual(await deliverAutonomousSubmissionStatesIfReady({
      ...common,
      ...readiness,
    }), []);
  }
  assert.equal(deliveryCalls, 0);
});

test('dispatcher private runtime base proves native absence and writable handoff identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dispatcher-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handoffDirectory = path.join(
    root, 'autonomous-research', 'submission-handoff',
  );
  fs.mkdirSync(handoffDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(handoffDirectory, 'submission-handoff.sqlite'), 'sqlite');
  const inspection = inspectAutonomousSubmissionDispatcherStoragePreflight({
    runtimeRoot: root,
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.nativeStoreDisposition, 'absent');
  assert.equal(inspection.nativeStoreInaccessibleOrReadOnlyVerified, true);
  assert.equal(inspection.handoffStoreWriteVerified, true);
  assert.match(inspection.storageLayoutHash, /^sha256:[0-9a-f]{64}$/);
});
