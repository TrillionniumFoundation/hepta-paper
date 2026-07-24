import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
  buildAutonomousSubmissionPortalConfiguration,
  deriveAutonomousSubmissionPortalPublicConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const H = (label) => hashRecord('AutonomousSubmissionDispatcherChallengeTest', { label });

function writeJson(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(candidate, mode);
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

function runPublisher({ scriptPath, runtimeRoot, hash, barrierPath }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, runtimeRoot, hash, barrierPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
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
const [runtimeRoot, hash, barrierPath] = process.argv.slice(2);
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
  const publishers = [1, 2].map(() => runPublisher({
    scriptPath,
    runtimeRoot,
    hash: concurrentHash,
    barrierPath,
  }));
  fs.writeFileSync(barrierPath, 'go\n', { mode: 0o600 });
  const results = await Promise.all(publishers);
  assert.ok(results.every((result) => result.status === 0),
    results.map((result) => result.stderr).join('\n'));
  const publications = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(publications.map((result) => result.published).sort(), [false, true]);
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
});

test('plan-bound challenge converges only through an externally signed resident cycle', (t) => {
  const { root, runtimeRoot, cutover } = fixture(t);
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const planHash = H('plan');
  const idempotencyKey = H('idempotency');
  const portalId = 'portal:production';
  const portalSignerKeyId = 'dispatcher-cycle-key';
  const portalSignerRole = 'autonomous_submission_portal';
  const portalTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: portalSignerKeyId,
      subjectId: 'portal-canary-authority',
      algorithm: 'ed25519',
      publicKeyPem: publicKey,
      roles: [portalSignerRole],
      status: 'active',
    }],
  };
  const privatePortalConfiguration = buildAutonomousSubmissionPortalConfiguration({
    version: 2,
    portalId,
    endpoint: 'https://portal.example.test/submissions',
    serviceIdentityHash: H('portal-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'PORTAL_TEST_TOKEN',
    receiptTrustStore: portalTrustStore,
    receiptSignerKeyIds: [portalSignerKeyId],
    receiptSignerRole: portalSignerRole,
  });
  const portalConfigurationHash = privatePortalConfiguration.configurationHash;
  const portalDescriptor = deriveAutonomousSubmissionPortalPublicConfiguration({
    configuration: privatePortalConfiguration,
  });
  const portalDescriptorHash =
    autonomousSubmissionPortalPublicDescriptorHash(portalDescriptor);
  const portalDescriptorPath = path.join(root, 'portal-descriptor.json');
  writeJson(portalDescriptorPath, portalDescriptor);
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
      publicKeyPem: publicKey,
      roles: [
        'autonomous-submission-dispatcher-cycle-signer',
        portalSignerRole,
      ],
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
        pair.privateKey,
      ).toString('base64'),
    }],
  });
  const canaryEvidence = buildAutonomousSubmissionPortalReadinessCanaryEvidence({
    challenge: published.challenge,
    request: canaryRequest,
    receipt: canaryReceipt,
    authorityEnvelope: canaryAuthorityEnvelope,
  });
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
    livePortalCanaryVerified: true,
    livePortalCanaryReceiptHash: canaryReceipt.canaryReceiptHash,
    livePortalCanaryVerificationReceiptHash: H('portal-canary-verification'),
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
    environment: { TEST_KEY: Buffer.from(privateKey).toString('base64') },
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
    environment: { TEST_KEY: Buffer.from(privateKey).toString('base64') },
  });
  writeJson(cyclePath, dispatcherSignedForgery, 0o640);
  const forgedCanary = inspectAutonomousSubmissionDispatcherReadiness({
    runtimeRoot,
    environment: {
      HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: identityPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: portalDescriptorPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
        portalConfigurationHash,
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
