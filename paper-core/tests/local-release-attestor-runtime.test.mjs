import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  readLocalReleaseAttestorDaemonConfiguration,
  startLocalReleaseAttestorDaemon,
} from '../../paper-adapters/build-package/local-release-attestor-runtime.mjs';
import {
  requestLocalReleaseAttestor,
} from '../../paper-adapters/build-package/local-release-attestor-socket.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DAEMON_ENTRYPOINT = fileURLToPath(new URL(
  '../bin/hepta-paper-release-attestor-daemon.mjs',
  import.meta.url,
));
const CLIENT_ENTRYPOINT = fileURLToPath(new URL(
  '../bin/hepta-paper-release-attestor-client.mjs',
  import.meta.url,
));
const SIGNER_UNIT = fileURLToPath(new URL(
  '../deploy/hepta-paper-release-attestor.service',
  import.meta.url,
));
const PROBE_UNIT = fileURLToPath(new URL(
  '../deploy/hepta-paper-release-attestor-probe.service',
  import.meta.url,
));
const SYSUSERS_CONFIGURATION = fileURLToPath(new URL(
  '../deploy/hepta-paper.sysusers.conf',
  import.meta.url,
));
const SOCKET_POLICY = Object.freeze({
  idleTimeoutMs: 1_000,
  requestDeadlineMs: 3_000,
  maximumConcurrentConnections: 2,
});

function write(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, value, { mode });
  fs.chmodSync(candidate, mode);
}

function keyFixture(root, name) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(root, `${name}-private.pem`);
  const publicKeyPath = path.join(root, `${name}-public.pem`);
  write(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  write(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), 0o644);
  return Object.freeze({
    pair,
    privateKeyPath,
    publicKeyPath,
    publicKeySpkiHash: hashBytes(pair.publicKey.export({ type: 'spki', format: 'der' })),
  });
}

function daemonProcess(configurationPath) {
  const child = spawn(process.execPath, [
    DAEMON_ENTRYPOINT,
    '--configuration',
    configurationPath,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return Object.freeze({
    child,
    closed,
    stdout: () => stdout,
    stderr: () => stderr,
  });
}

async function stopDaemon(runtime) {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill('SIGTERM');
  }
  const deadline = Date.now() + 5000;
  while (runtime.child.exitCode === null && runtime.child.signalCode === null
    && Date.now() < deadline) {
    await delay(20);
  }
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill('SIGKILL');
  }
  return runtime.closed;
}

async function waitForSocket(socketPath, runtime) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      const result = await runtime.closed;
      throw new Error(
        `release attestor exited before socket readiness: ${JSON.stringify({
          ...result,
          stdout: runtime.stdout(),
          stderr: runtime.stderr(),
        })}`,
      );
    }
    try {
      const stat = fs.lstatSync(socketPath);
      if (stat.isSocket()) return stat;
    } catch {}
    await delay(20);
  }
  throw new Error(`release attestor socket readiness timeout: ${socketPath}`);
}

function rawConnection(socketPath) {
  const socket = net.createConnection({ path: socketPath });
  let connectError = null;
  socket.on('error', (error) => { connectError ||= error; });
  const connected = new Promise((resolve) => {
    socket.once('connect', () => resolve(true));
    socket.once('error', () => resolve(false));
  });
  const closed = new Promise((resolve) => {
    socket.once('close', (hadError) => resolve({ hadError, error: connectError }));
  });
  return Object.freeze({ socket, connected, closed });
}

async function within(promise, timeoutMs, errorMessage) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function runClient({ socketPath, request }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLIENT_ENTRYPOINT,
      '--socket',
      socketPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(Object.freeze({
      code,
      signal,
      pid,
      stdout,
      stderr,
    })));
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}

function processFixture(root) {
  const signerKey = keyFixture(root, 'process-signer');
  const probeKey = keyFixture(root, 'process-probe');
  const socketRoot = path.join(root, 'sockets');
  const signerSocketPath = path.join(socketRoot, 'signer.sock');
  const probeSocketPath = path.join(socketRoot, 'probe.sock');
  const signerConfigurationPath = path.join(root, 'process-signer.json');
  const probeConfigurationPath = path.join(root, 'process-probe.json');
  write(signerConfigurationPath, JSON.stringify({
    version: 2,
    kind: 'LocalResearchExecutionReleaseAttestorDaemonConfiguration',
    mode: 'signer',
    backendId: 'host-release-attestor',
    backendVersion: 'dedicated-process-v1',
    socketPath: signerSocketPath,
    socketPolicy: SOCKET_POLICY,
    authority: {
      keyId: 'release-key',
      keyVersion: 'v1',
      subjectId: 'release-attestor',
      organization: 'Hepta Paper Host Authority',
      privateKeyPath: signerKey.privateKeyPath,
      publicKeySpkiHash: signerKey.publicKeySpkiHash,
    },
  }));
  write(probeConfigurationPath, JSON.stringify({
    version: 2,
    kind: 'LocalResearchExecutionReleaseAttestorDaemonConfiguration',
    mode: 'probe',
    backendId: 'host-release-attestor',
    backendVersion: 'dedicated-process-v1',
    socketPath: probeSocketPath,
    socketPolicy: SOCKET_POLICY,
    signerSocketPath,
    signerKeyId: 'release-key',
    signerKeyVersion: 'v1',
    signerPublicKey: {
      publicKeyPath: signerKey.publicKeyPath,
      publicKeySpkiHash: signerKey.publicKeySpkiHash,
    },
    authority: {
      keyId: 'release-probe-key',
      keyVersion: 'v1',
      subjectId: 'release-attestor-probe',
      organization: 'Hepta Paper Host Probe Authority',
      privateKeyPath: probeKey.privateKeyPath,
      publicKeySpkiHash: probeKey.publicKeySpkiHash,
    },
  }));
  return Object.freeze({
    signerKey,
    probeKey,
    signerSocketPath,
    probeSocketPath,
    signerConfigurationPath,
    probeConfigurationPath,
  });
}

function processSignerRequest() {
  const backendDescriptorHash = hashRecord(
    'LocalReleaseAttestorProcessBoundaryTest',
    { scope: 'backend' },
  );
  const signingPayloadHash = hashRecord(
    'LocalReleaseAttestorProcessBoundaryTest',
    { scope: 'release' },
  );
  const requestNonce = crypto.randomBytes(32).toString('base64');
  return Object.freeze({
    signingPayloadHash,
    request: Object.freeze({
      version: 1,
      kind: 'ResearchExecutionReleaseSignerRequest',
      protocol: 'hepta-release-signer-json-stdio-v1',
      operation: 'sign-sha256-identity',
      backendDescriptorHash,
      backendId: 'host-release-attestor',
      backendVersion: 'dedicated-process-v1',
      keyId: 'release-key',
      keyVersion: 'v1',
      algorithm: 'ed25519',
      signingPayloadHash,
      requestNonce,
      requestNonceHash: hashBytes(Buffer.from(requestNonce, 'utf8')),
    }),
  });
}

function processProbeRequest(signerKey) {
  const challenge = crypto.randomBytes(32).toString('base64');
  return Object.freeze({
    version: 1,
    kind: 'ResearchExecutionReleaseSignerBackendProbeRequest',
    protocol: 'hepta-release-signer-probe-json-stdio-v1',
    backendDescriptorHash: hashRecord(
      'LocalReleaseAttestorProcessBoundaryTest',
      { scope: 'backend' },
    ),
    backendId: 'host-release-attestor',
    backendVersion: 'dedicated-process-v1',
    activeKeyId: 'release-key',
    activeKeyVersion: 'v1',
    activePublicKeySpkiHash: signerKey.publicKeySpkiHash,
    algorithm: 'ed25519',
    challenge,
    challengeHash: hashBytes(Buffer.from(challenge, 'utf8')),
  });
}

test('daemon configuration requires explicit, reasonably bounded socket limits', async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-local-release-attestor-policy-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = processFixture(root);
  const base = JSON.parse(fs.readFileSync(fixture.signerConfigurationPath, 'utf8'));
  const invalidPolicies = [
    ['missing', undefined, /local_release_attestor_socket_policy_required/],
    ['null', null, /local_release_attestor_socket_policy_invalid/],
    ['coerced-string', {
      ...SOCKET_POLICY,
      idleTimeoutMs: '1000',
    }, /local_release_attestor_socket_policy_invalid/],
    ['idle-too-short', {
      ...SOCKET_POLICY,
      idleTimeoutMs: 999,
    }, /local_release_attestor_socket_policy_invalid/],
    ['idle-too-long', {
      ...SOCKET_POLICY,
      idleTimeoutMs: 30_001,
      requestDeadlineMs: 30_001,
    }, /local_release_attestor_socket_policy_invalid/],
    ['deadline-before-idle', {
      ...SOCKET_POLICY,
      requestDeadlineMs: 999,
    }, /local_release_attestor_socket_policy_invalid/],
    ['deadline-too-long', {
      ...SOCKET_POLICY,
      requestDeadlineMs: 30_001,
    }, /local_release_attestor_socket_policy_invalid/],
    ['connection-limit-too-small', {
      ...SOCKET_POLICY,
      maximumConcurrentConnections: 1,
    }, /local_release_attestor_socket_policy_invalid/],
    ['connection-limit-too-large', {
      ...SOCKET_POLICY,
      maximumConcurrentConnections: 129,
    }, /local_release_attestor_socket_policy_invalid/],
    ['connection-limit-not-integer', {
      ...SOCKET_POLICY,
      maximumConcurrentConnections: 2.5,
    }, /local_release_attestor_socket_policy_invalid/],
  ];
  for (const [name, socketPolicy, expectedError] of invalidPolicies) {
    const configuration = { ...base, socketPolicy };
    if (socketPolicy === undefined) delete configuration.socketPolicy;
    const configurationPath = path.join(root, `invalid-${name}.json`);
    write(configurationPath, JSON.stringify(configuration));
    await assert.rejects(
      startLocalReleaseAttestorDaemon({ configurationPath }),
      expectedError,
      name,
    );
    assert.equal(fs.existsSync(configuration.socketPath), false, name);
  }
});

test('daemon configuration rejects malformed identity and cryptographic material', (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-local-release-attestor-validation-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  function rejectedConfiguration(name, mutate, expected) {
    const candidateRoot = path.join(root, name);
    fs.mkdirSync(candidateRoot);
    const fixture = processFixture(candidateRoot);
    const signer = JSON.parse(fs.readFileSync(
      fixture.signerConfigurationPath,
      'utf8',
    ));
    const probe = JSON.parse(fs.readFileSync(
      fixture.probeConfigurationPath,
      'utf8',
    ));
    const selected = mutate({ fixture, signer, probe }) || signer;
    const configurationPath = path.join(candidateRoot, 'candidate.json');
    write(configurationPath, typeof selected === 'string'
      ? selected : JSON.stringify(selected));
    assert.throws(
      () => readLocalReleaseAttestorDaemonConfiguration({ configurationPath }),
      expected,
      name,
    );
  }

  rejectedConfiguration('invalid-owner-uid', ({ signer }) => {
    const configurationPath = path.join(root, 'invalid-owner-uid', 'owner.json');
    write(configurationPath, JSON.stringify(signer));
    assert.throws(
      () => readLocalReleaseAttestorDaemonConfiguration({
        configurationPath,
        privateKeyOwnerUid: -1,
      }),
      /local_release_attestor_private_key_owner_uid_invalid/,
    );
    return { ...signer, backendId: '' };
  }, /local_release_attestor_configuration_invalid/);
  rejectedConfiguration('malformed-json', () => '{',
    /local_release_attestor_configuration_invalid/);
  rejectedConfiguration('signer-metadata', ({ signer }) => ({
    ...signer,
    authority: { ...signer.authority, keyId: 'x' },
  }), /local_release_attestor_signer_metadata_invalid/);
  rejectedConfiguration('private-key', ({ fixture, signer }) => {
    write(fixture.signerKey.privateKeyPath, 'not a private key\n');
    return signer;
  }, /local_release_attestor_private_key_invalid/);
  rejectedConfiguration('private-key-pin', ({ signer }) => ({
    ...signer,
    authority: { ...signer.authority, publicKeySpkiHash: hashRecord(
      'LocalReleaseAttestorRuntimeTest',
      { mismatch: 'private-key-pin' },
    ) },
  }), /local_release_attestor_public_key_pin_mismatch/);
  rejectedConfiguration('probe-key', ({ fixture, probe }) => {
    write(fixture.signerKey.publicKeyPath, 'not a public key\n', 0o644);
    return probe;
  }, /local_release_attestor_public_key_invalid/);
  rejectedConfiguration('probe-key-pin', ({ probe }) => ({
    ...probe,
    signerPublicKey: {
      ...probe.signerPublicKey,
      publicKeySpkiHash: hashRecord(
        'LocalReleaseAttestorRuntimeTest',
        { mismatch: 'probe-key-pin' },
      ),
    },
  }), /local_release_attestor_public_key_pin_mismatch/);
  rejectedConfiguration('probe-signer-id', ({ probe }) => ({
    ...probe,
    signerKeyId: 'x',
  }), /local_release_attestor_configuration_invalid/);
  rejectedConfiguration('probe-signer-socket', ({ probe }) => ({
    ...probe,
    signerSocketPath: 'relative.sock',
  }), /local_release_attestor_configuration_invalid/);
});

test('in-process signer and probe communicate only through bounded sockets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-local-release-attestor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signerKey = keyFixture(root, 'signer');
  const probeKey = keyFixture(root, 'probe');
  const signerSocketPath = path.join(root, 'signer.sock');
  const probeSocketPath = path.join(root, 'probe.sock');
  const signerConfigurationPath = path.join(root, 'signer.json');
  const probeConfigurationPath = path.join(root, 'probe.json');
  write(signerConfigurationPath, JSON.stringify({
    version: 2,
    kind: 'LocalResearchExecutionReleaseAttestorDaemonConfiguration',
    mode: 'signer',
    backendId: 'host-release-attestor',
    backendVersion: 'dedicated-uid-v1',
    socketPath: signerSocketPath,
    socketPolicy: SOCKET_POLICY,
    authority: {
      keyId: 'release-key',
      keyVersion: 'v1',
      subjectId: 'release-attestor',
      organization: 'Hepta Paper Host Authority',
      privateKeyPath: signerKey.privateKeyPath,
      publicKeySpkiHash: signerKey.publicKeySpkiHash,
    },
  }));
  write(probeConfigurationPath, JSON.stringify({
    version: 2,
    kind: 'LocalResearchExecutionReleaseAttestorDaemonConfiguration',
    mode: 'probe',
    backendId: 'host-release-attestor',
    backendVersion: 'dedicated-uid-v1',
    socketPath: probeSocketPath,
    socketPolicy: SOCKET_POLICY,
    signerSocketPath,
    signerKeyId: 'release-key',
    signerKeyVersion: 'v1',
    signerPublicKey: {
      publicKeyPath: signerKey.publicKeyPath,
      publicKeySpkiHash: signerKey.publicKeySpkiHash,
    },
    authority: {
      keyId: 'release-probe-key',
      keyVersion: 'v1',
      subjectId: 'release-attestor-probe',
      organization: 'Hepta Paper Host Probe Authority',
      privateKeyPath: probeKey.privateKeyPath,
      publicKeySpkiHash: probeKey.publicKeySpkiHash,
    },
  }));
  const signerRuntime = await startLocalReleaseAttestorDaemon({
    configurationPath: signerConfigurationPath,
  });
  const probeRuntime = await startLocalReleaseAttestorDaemon({
    configurationPath: probeConfigurationPath,
  });
  assert.deepEqual(signerRuntime.listener.socketPolicy, SOCKET_POLICY);
  assert.deepEqual(probeRuntime.listener.socketPolicy, SOCKET_POLICY);
  t.after(async () => {
    await probeRuntime.listener.close();
    await signerRuntime.listener.close();
  });
  const backendDescriptorHash = hashRecord('LocalReleaseAttestorRuntimeTest', {
    scope: 'backend',
  });
  const signingPayloadHash = hashRecord('LocalReleaseAttestorRuntimeTest', {
    scope: 'release',
  });
  const requestNonce = crypto.randomBytes(32).toString('base64');
  const signatureReceipt = await requestLocalReleaseAttestor({
    socketPath: signerSocketPath,
    request: {
      version: 1,
      kind: 'ResearchExecutionReleaseSignerRequest',
      protocol: 'hepta-release-signer-json-stdio-v1',
      operation: 'sign-sha256-identity',
      backendDescriptorHash,
      backendId: 'host-release-attestor',
      backendVersion: 'dedicated-uid-v1',
      keyId: 'release-key',
      keyVersion: 'v1',
      algorithm: 'ed25519',
      signingPayloadHash,
      requestNonce,
      requestNonceHash: hashBytes(Buffer.from(requestNonce, 'utf8')),
    },
  });
  assert.equal(crypto.verify(
    null,
    Buffer.from(signingPayloadHash, 'utf8'),
    signerKey.pair.publicKey,
    Buffer.from(signatureReceipt.signature, 'base64'),
  ), true);
  const challenge = crypto.randomBytes(32).toString('base64');
  const probeReceipt = await requestLocalReleaseAttestor({
    socketPath: probeSocketPath,
    request: {
      version: 1,
      kind: 'ResearchExecutionReleaseSignerBackendProbeRequest',
      protocol: 'hepta-release-signer-probe-json-stdio-v1',
      backendDescriptorHash,
      backendId: 'host-release-attestor',
      backendVersion: 'dedicated-uid-v1',
      activeKeyId: 'release-key',
      activeKeyVersion: 'v1',
      activePublicKeySpkiHash: signerKey.publicKeySpkiHash,
      algorithm: 'ed25519',
      challenge,
      challengeHash: hashBytes(Buffer.from(challenge, 'utf8')),
    },
  });
  assert.equal(probeReceipt.backendReachable, true);
  assert.equal(probeReceipt.hardwareProtected, false);
  assert.equal(probeReceipt.privateKeyExportable, true);
  assert.equal(crypto.verify(
    null,
    Buffer.from(hashRecord(
      'ResearchExecutionReleaseSignerBackendProbeAttestationSigningPayload',
      Object.fromEntries(Object.entries(probeReceipt).filter(([key]) => (
        !['signature', 'researchExecutionReleaseSignerBackendProbeAttestationHash']
          .includes(key)
      ))),
    ), 'utf8'),
    probeKey.pair.publicKey,
    Buffer.from(probeReceipt.signature, 'base64'),
  ), true);

  await assert.rejects(
    requestLocalReleaseAttestor({
      socketPath: probeSocketPath,
      request: {
        ...processProbeRequest(signerKey),
        challengeHash: hashRecord(
          'LocalReleaseAttestorRuntimeTest',
          { mismatch: 'challenge' },
        ),
      },
    }),
    /local_release_attestor_(?:probe_request_invalid|response_invalid)/,
  );

  const alternateSignerKey = keyFixture(root, 'alternate-signer');
  const mismatchedProbeConfigurationPath = path.join(root, 'mismatched-probe.json');
  const mismatchedProbeSocketPath = path.join(root, 'mismatched-probe.sock');
  write(mismatchedProbeConfigurationPath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(probeConfigurationPath, 'utf8')),
    socketPath: mismatchedProbeSocketPath,
    signerPublicKey: {
      publicKeyPath: alternateSignerKey.publicKeyPath,
      publicKeySpkiHash: alternateSignerKey.publicKeySpkiHash,
    },
  }));
  const mismatchedProbeRuntime = await startLocalReleaseAttestorDaemon({
    configurationPath: mismatchedProbeConfigurationPath,
  });
  try {
    await assert.rejects(
      requestLocalReleaseAttestor({
        socketPath: mismatchedProbeSocketPath,
        request: processProbeRequest(alternateSignerKey),
      }),
      /local_release_attestor_(?:signer_unreachable|response_invalid)/,
    );
  } finally {
    await mismatchedProbeRuntime.listener.close();
  }
});

test('deployment assigns signer and probe distinct dedicated nologin identities', () => {
  // This deterministic check deliberately does not require root or setuid. The
  // process-boundary test below therefore runs both daemons as the harness UID;
  // production UID separation is owned by these installed systemd/sysusers
  // contracts and is verified here instead of being simulated in-process.
  const signerUnit = fs.readFileSync(SIGNER_UNIT, 'utf8');
  const probeUnit = fs.readFileSync(PROBE_UNIT, 'utf8');
  const sysusers = fs.readFileSync(SYSUSERS_CONFIGURATION, 'utf8');
  const signerUser = signerUnit.match(/^User=(.+)$/m)?.[1] || null;
  const probeUser = probeUnit.match(/^User=(.+)$/m)?.[1] || null;

  assert.equal(signerUser, 'hepta-release-attestor');
  assert.equal(probeUser, 'hepta-release-probe');
  assert.notEqual(signerUser, probeUser);
  assert.match(
    sysusers,
    /^u hepta-release-attestor -:hepta-paper .* \/usr\/sbin\/nologin$/m,
  );
  assert.match(
    sysusers,
    /^u hepta-release-probe -:hepta-paper .* \/usr\/sbin\/nologin$/m,
  );
  for (const source of [signerUnit, probeUnit]) {
    assert.match(source, /^Group=hepta-paper$/m);
    assert.match(source, /^NoNewPrivileges=yes$/m);
    assert.match(source, /^PrivateNetwork=yes$/m);
    assert.match(source, /^RestrictAddressFamilies=AF_UNIX$/m);
    assert.match(source, /^UMask=0007$/m);
  }
  assert.match(probeUnit, /^Requires=hepta-paper-release-attestor\.service$/m);
});

test('daemon bounds concurrent sockets and survives idle and slow-drip clients', {
  timeout: 20_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-local-release-attestor-availability-',
  ));
  const fixture = processFixture(root);
  const signerDaemon = daemonProcess(fixture.signerConfigurationPath);
  let stopped = false;
  t.after(async () => {
    if (!stopped) await stopDaemon(signerDaemon);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitForSocket(fixture.signerSocketPath, signerDaemon);

  const heldFirst = rawConnection(fixture.signerSocketPath);
  const heldSecond = rawConnection(fixture.signerSocketPath);
  assert.deepEqual(
    await Promise.all([heldFirst.connected, heldSecond.connected]),
    [true, true],
  );

  const rejectedAt = Date.now();
  const rejected = rawConnection(fixture.signerSocketPath);
  await within(
    rejected.closed,
    900,
    'release attestor did not reject a connection above its concurrency limit',
  );
  assert.ok(Date.now() - rejectedAt < SOCKET_POLICY.idleTimeoutMs);
  assert.equal(signerDaemon.child.exitCode, null);
  assert.equal(signerDaemon.child.signalCode, null);

  heldSecond.socket.write(' ');
  heldFirst.socket.destroy();
  await within(heldFirst.closed, 1_000, 'released connection did not close');
  const signerRequest = processSignerRequest();
  const acceptedAfterRelease = await runClient({
    socketPath: fixture.signerSocketPath,
    request: signerRequest.request,
  });
  assert.equal(acceptedAfterRelease.code, 0, acceptedAfterRelease.stderr);
  assert.equal(acceptedAfterRelease.stderr, '');

  await within(
    heldSecond.closed,
    2_000,
    'idle release-attestor connection was not closed',
  );
  assert.equal(signerDaemon.child.exitCode, null);
  assert.equal(signerDaemon.child.signalCode, null);

  const concurrent = await Promise.all([
    runClient({
      socketPath: fixture.signerSocketPath,
      request: processSignerRequest().request,
    }),
    runClient({
      socketPath: fixture.signerSocketPath,
      request: processSignerRequest().request,
    }),
  ]);
  for (const result of concurrent) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
  }

  const slowDrip = rawConnection(fixture.signerSocketPath);
  assert.equal(await slowDrip.connected, true);
  const slowDripStartedAt = Date.now();
  const drip = setInterval(() => {
    if (!slowDrip.socket.destroyed) slowDrip.socket.write(' ');
  }, 200);
  drip.unref();
  try {
    await within(
      slowDrip.closed,
      4_000,
      'absolute release-attestor request deadline was not enforced',
    );
  } finally {
    clearInterval(drip);
  }
  const slowDripDurationMs = Date.now() - slowDripStartedAt;
  assert.ok(slowDripDurationMs >= 2_000, slowDripDurationMs);
  assert.ok(slowDripDurationMs < 4_000, slowDripDurationMs);
  assert.equal(signerDaemon.child.exitCode, null);
  assert.equal(signerDaemon.child.signalCode, null);

  const acceptedAfterTimeout = await runClient({
    socketPath: fixture.signerSocketPath,
    request: signerRequest.request,
  });
  assert.equal(acceptedAfterTimeout.code, 0, acceptedAfterTimeout.stderr);
  assert.equal(acceptedAfterTimeout.stderr, '');

  const stoppedResult = await stopDaemon(signerDaemon);
  stopped = true;
  assert.equal(stoppedResult.code, 0);
  assert.equal(stoppedResult.signal, null);
  assert.equal(fs.existsSync(fixture.signerSocketPath), false);
});

test('daemon and client processes isolate failures and fail closed across Unix sockets', {
  timeout: 20_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-local-release-attestor-process-',
  ));
  const fixture = processFixture(root);
  const daemons = [];
  t.after(async () => {
    for (const daemon of [...daemons].reverse()) await stopDaemon(daemon);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const insecureConfigurationPath = path.join(root, 'insecure-signer.json');
  const insecureSocketPath = path.join(root, 'insecure-signer.sock');
  write(insecureConfigurationPath, JSON.stringify({
    version: 2,
    kind: 'LocalResearchExecutionReleaseAttestorDaemonConfiguration',
    mode: 'signer',
    backendId: 'host-release-attestor',
    backendVersion: 'dedicated-process-v1',
    socketPath: insecureSocketPath,
    socketPolicy: SOCKET_POLICY,
    authority: {
      keyId: 'release-key',
      keyVersion: 'v1',
      subjectId: 'release-attestor',
      organization: 'Hepta Paper Host Authority',
      privateKeyPath: fixture.signerKey.privateKeyPath,
      publicKeySpkiHash: fixture.signerKey.publicKeySpkiHash,
    },
  }), 0o666);
  const insecureDaemon = daemonProcess(insecureConfigurationPath);
  daemons.push(insecureDaemon);
  const insecureResult = await insecureDaemon.closed;
  assert.equal(insecureResult.code, 1);
  assert.match(insecureDaemon.stderr(), /local_release_attestor_file_invalid/);
  assert.equal(fs.existsSync(insecureSocketPath), false);

  const signerDaemon = daemonProcess(fixture.signerConfigurationPath);
  daemons.push(signerDaemon);
  const signerSocket = await waitForSocket(
    fixture.signerSocketPath,
    signerDaemon,
  );
  const probeDaemon = daemonProcess(fixture.probeConfigurationPath);
  daemons.push(probeDaemon);
  const probeSocket = await waitForSocket(fixture.probeSocketPath, probeDaemon);

  assert.notEqual(signerDaemon.child.pid, process.pid);
  assert.notEqual(probeDaemon.child.pid, process.pid);
  assert.notEqual(signerDaemon.child.pid, probeDaemon.child.pid);
  for (const socket of [signerSocket, probeSocket]) {
    assert.equal(socket.isSocket(), true);
    assert.equal(socket.mode & 0o777, 0o660);
    if (typeof process.getuid === 'function') {
      assert.equal(socket.uid, process.getuid());
    }
    if (typeof process.getgid === 'function') {
      assert.equal(socket.gid, process.getgid());
    }
  }
  assert.equal(fs.lstatSync(path.dirname(fixture.signerSocketPath)).mode & 0o777, 0o750);

  const rejectedRequest = await runClient({
    socketPath: fixture.signerSocketPath,
    request: { version: 1, kind: 'InvalidSignerRequest' },
  });
  assert.equal(rejectedRequest.code, 1);
  assert.equal(rejectedRequest.stdout, '');
  assert.equal(signerDaemon.child.exitCode, null);
  assert.equal(signerDaemon.child.signalCode, null);

  const signerRequest = processSignerRequest();
  const signed = await runClient({
    socketPath: fixture.signerSocketPath,
    request: signerRequest.request,
  });
  assert.equal(signed.code, 0, signed.stderr);
  assert.equal(signed.signal, null);
  assert.equal(signed.stderr, '');
  assert.notEqual(signed.pid, signerDaemon.child.pid);
  assert.notEqual(signed.pid, probeDaemon.child.pid);
  const signatureReceipt = JSON.parse(signed.stdout);
  assert.equal(crypto.verify(
    null,
    Buffer.from(signerRequest.signingPayloadHash, 'utf8'),
    fixture.signerKey.pair.publicKey,
    Buffer.from(signatureReceipt.signature, 'base64'),
  ), true);
  assert.equal(signerDaemon.child.exitCode, null);
  assert.equal(probeDaemon.child.exitCode, null);

  const probeRequest = processProbeRequest(fixture.signerKey);
  const probed = await runClient({
    socketPath: fixture.probeSocketPath,
    request: probeRequest,
  });
  assert.equal(probed.code, 0, [
    probed.stderr,
    signerDaemon.stderr(),
    probeDaemon.stderr(),
  ].join('\n'));
  assert.equal(probed.stderr, '');
  const probeReceipt = JSON.parse(probed.stdout);
  assert.equal(probeReceipt.backendReachable, true);
  assert.equal(probeReceipt.externalSignerProcess, true);

  const signerStopped = await stopDaemon(signerDaemon);
  assert.equal(signerStopped.code, 0);
  assert.equal(signerStopped.signal, null);
  assert.equal(fs.existsSync(fixture.signerSocketPath), false);
  assert.equal(probeDaemon.child.exitCode, null);
  assert.equal(probeDaemon.child.signalCode, null);
  assert.equal(fs.lstatSync(fixture.probeSocketPath).isSocket(), true);

  const unavailableProbe = await runClient({
    socketPath: fixture.probeSocketPath,
    request: processProbeRequest(fixture.signerKey),
  });
  assert.equal(unavailableProbe.code, 1);
  assert.equal(unavailableProbe.stdout, '');
  assert.match(
    unavailableProbe.stderr,
    /local_release_attestor_(?:response_invalid|unavailable)/,
  );
  await delay(50);
  assert.equal(probeDaemon.child.exitCode, null);
  assert.equal(probeDaemon.child.signalCode, null);
  assert.equal(fs.lstatSync(fixture.probeSocketPath).isSocket(), true);

  const missingSigner = await runClient({
    socketPath: fixture.signerSocketPath,
    request: signerRequest.request,
  });
  assert.equal(missingSigner.code, 1);
  assert.equal(missingSigner.stdout, '');
  assert.match(missingSigner.stderr, /local_release_attestor_unavailable/);

  const probeStopped = await stopDaemon(probeDaemon);
  assert.equal(probeStopped.code, 0);
  assert.equal(probeStopped.signal, null);
  assert.equal(fs.existsSync(fixture.probeSocketPath), false);
});
