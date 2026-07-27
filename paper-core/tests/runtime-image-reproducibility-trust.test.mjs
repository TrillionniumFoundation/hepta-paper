import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { inspectRuntimeImageBuildInputClosures } from '../../paper-adapters/automation/runtime-image-build-input-closure.mjs';
import {
  createRuntimeImageReproducibilityReceiptRepository,
} from '../../paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs';
import {
  invokeRuntimeImageReproducibilityVerifier,
  readRuntimeImageReproducibilityProcessConfiguration,
} from '../../paper-adapters/automation/runtime-image-reproducibility-process-identity.mjs';
import {
  AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS,
  R_RUNTIME_SOURCE_CAS,
  RUNTIME_IMAGE_BUILD_REPRODUCIBILITY,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  composeRuntimeImageReproducibilityStatus,
} from '../../paper-composition/automation/runtime-image-reproducibility-composition.mjs';
import {
  buildRuntimeImageReproducibilityReceipt,
  buildRuntimeImageReproducibilityRequest,
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
  runtimeImageReproducibilityResponseSigningPayloadHash,
  verifyRuntimeImageReproducibilityReceipt,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NOW = new Date('2026-07-16T08:00:45.000Z');
const H = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const RECEIPT_REPOSITORY_MODULE = pathToFileURL(path.join(
  REPOSITORY_ROOT,
  'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs',
)).href;

function publicationReceipt(label, issuedAt) {
  const issuedAtMs = Date.parse(issuedAt);
  const payload = {
    version: 1,
    kind: 'RuntimeImageReproducibilityReceipt',
    status: label,
    issuedAt,
    expiresAt: new Date(issuedAtMs + 24 * 60 * 60 * 1000).toISOString(),
  };
  return Object.freeze({
    ...payload,
    runtimeImageReproducibilityReceiptHash: hashRecord(
      'RuntimeImageReproducibilityReceipt',
      payload,
    ),
  });
}

function acceptingReceiptVerifier(receipt) {
  return Object.freeze({
    ready: true,
    receiptAccepted: true,
    receiptHash: receipt.runtimeImageReproducibilityReceiptHash,
  });
}

function spawnReceiptPublisher({ runtimeRoot, receipt }) {
  const source = `
    const { createRuntimeImageReproducibilityReceiptRepository } = await import(process.argv[1]);
    const receipt = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
    const repository = createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot: process.argv[3],
      receiptVerifier: (value) => ({
        ready: true,
        receiptAccepted: true,
        receiptHash: value.runtimeImageReproducibilityReceiptHash,
      }),
    });
    try {
      repository.publish({ receipt, now: new Date(receipt.issuedAt) });
      process.stdout.write('published');
    } catch (error) {
      if (error?.message === 'runtime_reproducibility_receipt_monotonic_cas_rejected') {
        process.stderr.write(error.message);
        process.exitCode = 2;
      } else throw error;
    }
  `;
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', source,
    RECEIPT_REPOSITORY_MODULE,
    Buffer.from(JSON.stringify(receipt)).toString('base64url'),
    runtimeRoot,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function waitForChildOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`child_output_timeout:${marker}`)), 5_000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once('exit', (code, signal) => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(`child_exited_before_marker:${code}:${signal}:${output}`));
      }
    });
  });
}

function write(candidate, contents, mode) {
  fs.writeFileSync(candidate, contents, { mode });
  fs.chmodSync(candidate, mode);
}

function verifierConfiguration(root, mutate = (value) => value) {
  const pairs = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  const verifiers = pairs.map((pair, index) => {
    const ordinal = index + 1;
    const executable = path.join(root, `verifier-${ordinal}.mjs`);
    const credentialRoot = path.join(root, `credentials-${ordinal}`);
    const publicKey = path.join(root, `verifier-${ordinal}.pub.pem`);
    fs.mkdirSync(credentialRoot, { mode: 0o700 });
    write(path.join(credentialRoot, 'identity'), `credential-${ordinal}\n`, 0o600);
    write(executable, `#!/usr/bin/env node\n// verifier-${ordinal}\n`, 0o755);
    write(publicKey, pair.publicKey.export({ type: 'spki', format: 'pem' }), 0o644);
    return {
      command: {
        serviceId: `runtime-builder-${ordinal}`,
        principalId: `runtime-principal-${ordinal}`,
        protocol: 'runtime-image-reproducibility-json-stdio-v1',
        executable,
        args: [],
        credentialRoot,
        environmentAllowlist: [],
        timeoutMs: 60_000,
        backend: {
          backendId: `buildkit-backend-${ordinal}`,
          workerId: `buildkit-worker-${ordinal}`,
          buildkitVersion: `v0.1${ordinal}.0`,
          platform: 'linux/amd64',
          endpointTlsSpkiHash: H(`backend-tls-${ordinal}`),
          stateRootIdentityHash: H(`state-root-${ordinal}`),
        },
      },
      attestor: {
        keyId: `runtime-key-${ordinal}`,
        keyVersion: 'version-1',
        subjectId: `runtime-attestor-${ordinal}`,
        organization: `runtime-office-${ordinal}`,
        role: 'runtime_image_reproducibility_external_verifier',
        algorithm: 'ed25519',
        status: 'active',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        expiresAt: '2027-07-01T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: publicKey,
      },
    };
  });
  const document = mutate({
    version: 1,
    kind: 'RuntimeImageReproducibilityProcessConfiguration',
    status: 'active',
    platform: 'linux/amd64',
    sourceDateEpoch: 1733097600,
    buildArgs: {},
    maximumReceiptAgeMs: 24 * 60 * 60 * 1000,
    maximumVerificationCostUsd: 5,
    verificationCostAuthority: 'operator_declared_worst_case_usd',
    verifiers,
  }, { root });
  const configPath = path.join(root, 'runtime-reproducibility.json');
  write(configPath, `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return { configPath, document, pairs };
}

function fixture(t, mutateConfiguration = undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provisioned = verifierConfiguration(root, mutateConfiguration);
  const configuration = readRuntimeImageReproducibilityProcessConfiguration({
    configPath: provisioned.configPath,
    environment: { PATH: process.env.PATH },
  });
  const inputs = inspectRuntimeImageBuildInputClosures({
    repositoryRoot: REPOSITORY_ROOT,
    definitions: AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS,
    profiles: REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
    platform: configuration.platform,
    buildArgs: configuration.buildArgs,
    sourceDateEpoch: configuration.sourceDateEpoch,
  });
  const request = buildRuntimeImageReproducibilityRequest({
    nonce: 'runtime-repro:fixture-1',
    requestedAt: '2026-07-16T07:59:00.000Z',
    expiresAt: '2026-07-16T08:01:00.000Z',
    configurationIdentityHash: configuration.configurationIdentityHash,
    trustIdentityHash: configuration.trustIdentityHash,
    codeProvenanceHash: H('current-code'),
    releaseIdentityHash: H('current-release'),
    inputs,
  });
  const responses = configuration.verifierTrust.map((verifier, index) => {
    const profileResults = request.inputs.map((input) => {
      const layerBlobDigests = [H(`${input.profile}:layer-1`), H(`${input.profile}:layer-2`)];
      const oci = {
        indexDigest: H(`${input.profile}:index`),
        manifestDigest: input.registeredImageDigest,
        configDigest: H(`${input.profile}:config`),
        layerBlobDigests,
        allBlobDigests: [...new Set([
          input.registeredImageDigest, H(`${input.profile}:config`), ...layerBlobDigests,
        ])].sort(),
      };
      oci.ociDigestSetHash = hashRecord('RuntimeImageOciDigestSet', oci);
      return {
        profile: input.profile,
        inputClosureHash: input.runtimeImageCanonicalBuildInputClosureHash,
        contextTarMetadataPolicy: input.contextTarMetadataPolicy,
        contextTarMetadataPolicyHash: input.contextTarMetadataPolicyHash,
        contextTarMetadataPolicyApplied: true,
        dockerfileFrontend: input.dockerfileFrontend,
        dockerfileFrontendDigest: input.dockerfileFrontendDigest,
        registeredImage: input.image,
        registeredImageDigest: input.registeredImageDigest,
        platform: input.platform,
        sourceDateEpoch: input.sourceDateEpoch,
        sourceDateEpochAppliedToBuildkit: true,
        cacheDisabled: true,
        ociExporter: input.ociExporter,
        backendIdentityHash: verifier.backend.backendIdentityHash,
        buildExecutionClosureHash: hashRecord('RuntimeImageExternalBuildExecutionClosure', {
          inputClosureHash: input.runtimeImageCanonicalBuildInputClosureHash,
          backendIdentityHash: verifier.backend.backendIdentityHash,
        }),
        oci,
      };
    });
    const payload = {
      version: 1,
      kind: 'RuntimeImageReproducibilityVerifierResponse',
      status: 'runtime_image_oci_bitwise_rebuild_attested',
      verifierId: verifier.serviceId,
      verifierServiceIdentityHash: verifier.serviceIdentityHash,
      requestHash: request.requestHash,
      nonce: request.nonce,
      backend: verifier.backend,
      backendIdentityHash: verifier.backend.backendIdentityHash,
      profileResults,
      signer: verifier.signer,
      startedAt: ['2026-07-16T07:59:10.000Z', '2026-07-16T07:59:20.000Z'][index],
      completedAt: ['2026-07-16T08:00:00.000Z', '2026-07-16T08:00:30.000Z'][index],
    };
    const responseHash = hashRecord('RuntimeImageReproducibilityVerifierResponse', payload);
    const signature = crypto.sign(
      null,
      Buffer.from(runtimeImageReproducibilityResponseSigningPayloadHash(payload), 'utf8'),
      provisioned.pairs[index].privateKey,
    ).toString('base64');
    return { ...payload, responseHash, signature };
  });
  const receipt = buildRuntimeImageReproducibilityReceipt({
    request,
    responses,
    issuedAt: NOW.toISOString(),
    expiresAt: '2026-07-17T08:00:45.000Z',
  });
  const profilePolicies = Object.freeze(Object.fromEntries(
    REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.map((profile) => [profile, Object.freeze({
      dependencyArtifactsContentHashed: true,
      sourceArchivesContentHashed: true,
    })]),
  ));
  const verificationContext = {
    now: NOW,
    currentCodeProvenanceHash: request.codeProvenanceHash,
    currentReleaseIdentityHash: request.releaseIdentityHash,
    currentInputs: inputs,
    configuration: {
      configurationIdentityHash: configuration.configurationIdentityHash,
      trustIdentityHash: configuration.trustIdentityHash,
      maximumReceiptAgeMs: configuration.maximumReceiptAgeMs,
      verifiers: configuration.verifierTrust,
    },
    profilePolicies,
    verifySignature: ({ signingPayloadHash, signature, verifier }) => {
      const index = configuration.verifierTrust.findIndex(
        (item) => item.serviceIdentityHash === verifier.serviceIdentityHash,
      );
      return index >= 0 && crypto.verify(
        null,
        Buffer.from(signingPayloadHash, 'utf8'),
        provisioned.pairs[index].publicKey,
        Buffer.from(signature, 'base64'),
      );
    },
  };
  return { root, ...provisioned, configuration, inputs, request, responses, receipt, verificationContext };
}

test('two independent Ed25519 verifier responses bind identical complete OCI digest sets', (t) => {
  const value = fixture(t);
  const inspection = verifyRuntimeImageReproducibilityReceipt(
    value.receipt,
    value.verificationContext,
  );
  assert.equal(inspection.ready, true, JSON.stringify(inspection.blockers));
  assert.equal(inspection.ociIndexManifestConfigAndLayerBlobDigestsCompared, true);
  assert.equal(inspection.canonicalContextTarMetadataAttested, true);
  assert.deepEqual(inspection.requiredProfiles, ['python', 'r']);
  assert.equal(inspection.runtimeImageReproducibilityActivePluginScopeHash,
    RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
      .runtimeImageReproducibilityActivePluginScopeHash);
  assert.deepEqual(inspection.activeProductionProfileHashes,
    RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes);
  assert.equal(Date.parse(value.request.expiresAt) - Date.parse(value.request.requestedAt), 120_000);
  assert.equal(Date.parse(value.receipt.expiresAt) - Date.parse(value.receipt.issuedAt),
    24 * 60 * 60 * 1000);
  assert.equal(inspection.expiresAt, '2026-07-17T08:00:45.000Z');

  const forged = structuredClone(value.receipt);
  forged.responses[1].profileResults[0].oci.layerBlobDigests[0] = H('attacker-layer');
  const forgedInspection = verifyRuntimeImageReproducibilityReceipt(forged, value.verificationContext);
  assert.equal(forgedInspection.ready, false);
  assert.ok(forgedInspection.blockers.includes('runtime_reproducibility_receipt_shape_or_hash_invalid'));

  const signatureForged = structuredClone(value.receipt);
  signatureForged.responses[1].signature = value.responses[0].signature;
  const { runtimeImageReproducibilityReceiptHash: _hash, ...unsigned } = signatureForged;
  signatureForged.runtimeImageReproducibilityReceiptHash = hashRecord(
    'RuntimeImageReproducibilityReceipt',
    unsigned,
  );
  const signatureInspection = verifyRuntimeImageReproducibilityReceipt(
    signatureForged,
    value.verificationContext,
  );
  assert.ok(signatureInspection.blockers.includes(
    'runtime_reproducibility_external_signature_or_binding_invalid',
  ));

  for (const mutate of [
    (result) => { result.sourceDateEpochAppliedToBuildkit = false; },
    (result) => { result.contextTarMetadataPolicyApplied = false; },
    (result) => { delete result.contextTarMetadataPolicy; },
    (result) => { result.contextTarMetadataPolicy.uid = 1000; },
    (result) => { result.contextTarMetadataPolicy.entryOrder = 'filesystem-order'; },
    (result) => { result.contextTarMetadataPolicy.mtime += 1; },
    (result) => { result.contextTarMetadataPolicy.xattrsIncluded = true; },
    (result) => { result.contextTarMetadataPolicy.deviceEntriesIncluded = true; },
    (result) => { delete result.ociExporter; },
    (result) => { result.ociExporter.rewriteTimestamp = false; },
    (result) => { result.ociExporter.provenance = true; },
    (result) => { result.dockerfileFrontendDigest = H('attacker-frontend'); },
  ]) {
    const invalidResponse = structuredClone(value.responses[1]);
    mutate(invalidResponse.profileResults[0]);
    const { responseHash: _oldResponseHash, signature: _oldSignature, ...invalidPayload } =
      invalidResponse;
    invalidResponse.responseHash = hashRecord(
      'RuntimeImageReproducibilityVerifierResponse',
      invalidPayload,
    );
    invalidResponse.signature = crypto.sign(
      null,
      Buffer.from(runtimeImageReproducibilityResponseSigningPayloadHash(invalidResponse), 'utf8'),
      value.pairs[1].privateKey,
    ).toString('base64');
    const invalidReceipt = buildRuntimeImageReproducibilityReceipt({
      request: value.request,
      responses: [value.responses[0], invalidResponse],
      issuedAt: NOW.toISOString(),
      expiresAt: value.receipt.expiresAt,
    });
    assert.ok(verifyRuntimeImageReproducibilityReceipt(
      invalidReceipt,
      value.verificationContext,
    ).blockers.includes('runtime_reproducibility_external_signature_or_binding_invalid'));
  }

  const swappedResponse = structuredClone(value.responses[1]);
  const swappedOci = swappedResponse.profileResults[0].oci;
  [swappedOci.manifestDigest, swappedOci.configDigest] = [
    swappedOci.configDigest,
    swappedOci.manifestDigest,
  ];
  swappedOci.ociDigestSetHash = hashRecord('RuntimeImageOciDigestSet', {
    indexDigest: swappedOci.indexDigest,
    manifestDigest: swappedOci.manifestDigest,
    configDigest: swappedOci.configDigest,
    layerBlobDigests: swappedOci.layerBlobDigests,
    allBlobDigests: swappedOci.allBlobDigests,
  });
  const { responseHash: _swappedHash, signature: _swappedSignature, ...swappedPayload } =
    swappedResponse;
  swappedResponse.responseHash = hashRecord(
    'RuntimeImageReproducibilityVerifierResponse',
    swappedPayload,
  );
  swappedResponse.signature = crypto.sign(
    null,
    Buffer.from(runtimeImageReproducibilityResponseSigningPayloadHash(swappedResponse), 'utf8'),
    value.pairs[1].privateKey,
  ).toString('base64');
  const swappedReceipt = buildRuntimeImageReproducibilityReceipt({
    request: value.request,
    responses: [value.responses[0], swappedResponse],
    issuedAt: NOW.toISOString(),
    expiresAt: value.receipt.expiresAt,
  });
  assert.ok(verifyRuntimeImageReproducibilityReceipt(
    swappedReceipt,
    value.verificationContext,
  ).blockers.includes('runtime_reproducibility_external_signature_or_binding_invalid'));

  const receiptPolicyDrift = structuredClone(value.receipt);
  receiptPolicyDrift.contextTarMetadataPolicyHashes.python = H('attacker-context-tar-policy');
  const { runtimeImageReproducibilityReceiptHash: _receiptPolicyHash, ...receiptPolicyPayload } =
    receiptPolicyDrift;
  receiptPolicyDrift.runtimeImageReproducibilityReceiptHash = hashRecord(
    'RuntimeImageReproducibilityReceipt',
    receiptPolicyPayload,
  );
  assert.ok(verifyRuntimeImageReproducibilityReceipt(
    receiptPolicyDrift,
    value.verificationContext,
  ).blockers.includes('runtime_reproducibility_receipt_shape_or_hash_invalid'));

  const receiptPolicyMissing = structuredClone(value.receipt);
  delete receiptPolicyMissing.contextTarMetadataPolicyHashes;
  const { runtimeImageReproducibilityReceiptHash: _receiptMissingHash, ...receiptMissingPayload } =
    receiptPolicyMissing;
  receiptPolicyMissing.runtimeImageReproducibilityReceiptHash = hashRecord(
    'RuntimeImageReproducibilityReceipt',
    receiptMissingPayload,
  );
  assert.ok(verifyRuntimeImageReproducibilityReceipt(
    receiptPolicyMissing,
    value.verificationContext,
  ).blockers.includes('runtime_reproducibility_receipt_shape_or_hash_invalid'));
});

test('configuration rejects shared service, principal, credential contents, organization, SPKI or backend identity', (t) => {
  const mutations = [
    (value) => { value.verifiers[1].command.serviceId = value.verifiers[0].command.serviceId; },
    (value) => { value.verifiers[1].command.principalId = value.verifiers[0].command.principalId; },
    (value) => { value.verifiers[1].command.executable = value.verifiers[0].command.executable; },
    (value) => { value.verifiers[1].command.credentialRoot = value.verifiers[0].command.credentialRoot; },
    (value) => { value.verifiers[1].attestor.publicKeyPath = value.verifiers[0].attestor.publicKeyPath; },
    (value) => { value.verifiers[1].attestor.organization = value.verifiers[0].attestor.organization; },
    (value) => {
      value.verifiers[1].attestor.organization =
        value.verifiers[0].attestor.organization.toUpperCase();
    },
    (_value, { root }) => {
      fs.writeFileSync(path.join(root, 'credentials-2', 'identity'), 'credential-1\n');
    },
    (_value, { root }) => {
      fs.rmSync(path.join(root, 'credentials-2', 'identity'));
      write(path.join(root, 'credentials-2', 'renamed-secret'), 'credential-1\n', 0o600);
      write(path.join(root, 'credentials-2', 'unrelated-secret'), 'unrelated\n', 0o600);
    },
    (value) => { value.verifiers[1].command.backend.backendId = value.verifiers[0].command.backend.backendId; },
  ];
  for (const mutate of mutations) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-independence-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configured = verifierConfiguration(root, (value, context) => {
      mutate(value, context);
      return value;
    });
    assert.throws(() => readRuntimeImageReproducibilityProcessConfiguration({
      configPath: configured.configPath,
      environment: { PATH: process.env.PATH },
    }), /runtime_reproducibility_independent_verifiers_required/);
  }
  const nullRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-null-org-'));
  t.after(() => fs.rmSync(nullRoot, { recursive: true, force: true }));
  const nullOrganization = verifierConfiguration(nullRoot, (value) => {
    value.verifiers[1].attestor.organization = null;
    return value;
  });
  assert.throws(() => readRuntimeImageReproducibilityProcessConfiguration({
    configPath: nullOrganization.configPath,
    environment: { PATH: process.env.PATH },
  }), /runtime_reproducibility_verifier_attestor_invalid/);

  for (const mutateRoot of [
    (root) => fs.rmSync(path.join(root, 'credentials-2', 'identity')),
    (root) => write(path.join(root, 'credentials-2', 'identity'), '', 0o600),
    (root) => {
      fs.rmSync(path.join(root, 'credentials-2', 'identity'));
      fs.linkSync(
        path.join(root, 'credentials-1', 'identity'),
        path.join(root, 'credentials-2', 'hard-linked-secret'),
      );
    },
  ]) {
    const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-empty-root-'));
    t.after(() => fs.rmSync(invalidRoot, { recursive: true, force: true }));
    const invalid = verifierConfiguration(invalidRoot, (value, { root }) => {
      mutateRoot(root);
      return value;
    });
    assert.throws(() => readRuntimeImageReproducibilityProcessConfiguration({
      configPath: invalid.configPath,
      environment: { PATH: process.env.PATH },
    }), /runtime_reproducibility_credential_root_contents_invalid/);
  }
});

test('configuration rejects operator-selected platform, epoch or build arguments', (t) => {
  const mutations = [
    (value) => { value.platform = 'linux/arm64'; value.verifiers.forEach((entry) => { entry.command.backend.platform = 'linux/arm64'; }); },
    (value) => { value.sourceDateEpoch += 1; },
    (value) => { value.buildArgs = { SOURCE_DATE_EPOCH: '1733097600' }; },
  ];
  for (const mutate of mutations) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-build-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configured = verifierConfiguration(root, (value) => { mutate(value); return value; });
    assert.throws(() => readRuntimeImageReproducibilityProcessConfiguration({
      configPath: configured.configPath,
      environment: { PATH: process.env.PATH },
    }), /runtime_reproducibility_canonical_build_configuration_drift/);
  }
});

test('configuration requires an explicit bounded dual-build cost authority', (t) => {
  const mutations = [
    (value) => { delete value.maximumVerificationCostUsd; },
    (value) => { value.maximumVerificationCostUsd = -1; },
    (value) => { value.maximumVerificationCostUsd = 0; },
    (value) => { value.verificationCostAuthority = 'externally_operated_zero_cost'; },
    (value) => { value.verificationCostAuthority = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-cost-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configured = verifierConfiguration(root, (value) => { mutate(value); return value; });
    assert.throws(() => readRuntimeImageReproducibilityProcessConfiguration({
      configPath: configured.configPath,
      environment: { PATH: process.env.PATH },
    }), /runtime_reproducibility_configuration_invalid/);
  }
  const zeroRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-zero-cost-'));
  t.after(() => fs.rmSync(zeroRoot, { recursive: true, force: true }));
  const zero = verifierConfiguration(zeroRoot, (value) => {
    value.maximumVerificationCostUsd = 0;
    value.verificationCostAuthority = 'externally_operated_zero_cost';
    return value;
  });
  const parsed = readRuntimeImageReproducibilityProcessConfiguration({
    configPath: zero.configPath,
    environment: { PATH: process.env.PATH },
  });
  assert.equal(parsed.maximumVerificationCostUsd, 0);
  assert.equal(parsed.verificationCostAuthority, 'externally_operated_zero_cost');
  assert.equal(parsed.maximumVerifierTimeoutMs, 60_000);
  assert.equal(parsed.minimumRefreshLeadMs, 120_000);
});

test('configuration clears Docker endpoint injection and invocation rechecks executable identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-docker-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forbidden = verifierConfiguration(root, (value) => {
    value.verifiers[0].command.environmentAllowlist = ['DOCKER_HOST'];
    return value;
  });
  assert.throws(() => readRuntimeImageReproducibilityProcessConfiguration({
    configPath: forbidden.configPath,
    environment: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://attacker.invalid:2375' },
  }), /runtime_reproducibility_verifier_command_invalid/);

  const value = fixture(t);
  fs.appendFileSync(value.configuration.verifiers[0].command.executable, '// drift\n');
  let called = false;
  await assert.rejects(() => invokeRuntimeImageReproducibilityVerifier(
    value.configuration.verifiers[0].command,
    value.request,
    {
      cwd: REPOSITORY_ROOT,
      environment: { PATH: process.env.PATH },
      runProcess: async () => { called = true; return {}; },
    },
  ), /runtime_reproducibility_external_verifier_identity_changed/);
  assert.equal(called, false);
});

test('expired receipts and current code, release or canonical input drift fail closed', (t) => {
  const value = fixture(t);
  const expired = verifyRuntimeImageReproducibilityReceipt(value.receipt, {
    ...value.verificationContext,
    now: new Date('2026-07-17T08:00:45.000Z'),
  });
  assert.ok(expired.blockers.includes('runtime_reproducibility_receipt_outside_time_window'));
  const beforeBoundary = verifyRuntimeImageReproducibilityReceipt(value.receipt, {
    ...value.verificationContext,
    now: new Date('2026-07-17T08:00:44.999Z'),
  });
  assert.equal(beforeBoundary.ready, true, JSON.stringify(beforeBoundary.blockers));
  const replay = structuredClone(value.receipt);
  replay.issuedAt = '2026-07-18T08:00:45.000Z';
  replay.expiresAt = '2026-07-19T08:00:45.000Z';
  const { runtimeImageReproducibilityReceiptHash: _oldReplayHash, ...replayPayload } = replay;
  replay.runtimeImageReproducibilityReceiptHash = hashRecord(
    'RuntimeImageReproducibilityReceipt',
    replayPayload,
  );
  const replayInspection = verifyRuntimeImageReproducibilityReceipt(replay, {
    ...value.verificationContext,
    now: new Date(replay.issuedAt),
  });
  assert.equal(replayInspection.ready, false);
  assert.ok(replayInspection.blockers.includes(
    'runtime_reproducibility_receipt_outside_time_window',
  ));
  const delayedResponses = value.responses.map((response, index) => {
    const delayed = structuredClone(response);
    delayed.completedAt = [
      '2026-07-16T07:59:15.000Z',
      '2026-07-16T07:59:30.000Z',
    ][index];
    const { responseHash: _responseHash, signature: _signature, ...payload } = delayed;
    delayed.responseHash = hashRecord('RuntimeImageReproducibilityVerifierResponse', payload);
    delayed.signature = crypto.sign(
      null,
      Buffer.from(runtimeImageReproducibilityResponseSigningPayloadHash(delayed), 'utf8'),
      value.pairs[index].privateKey,
    ).toString('base64');
    return delayed;
  });
  const delayedReceipt = buildRuntimeImageReproducibilityReceipt({
    request: value.request,
    responses: delayedResponses,
    issuedAt: value.receipt.issuedAt,
    expiresAt: value.receipt.expiresAt,
  });
  const delayedInspection = verifyRuntimeImageReproducibilityReceipt(delayedReceipt, {
    ...value.verificationContext,
    now: NOW,
  });
  assert.equal(delayedInspection.ready, false);
  assert.ok(delayedInspection.blockers.includes(
    'runtime_reproducibility_receipt_outside_time_window',
  ));
  const codeDrift = verifyRuntimeImageReproducibilityReceipt(value.receipt, {
    ...value.verificationContext,
    currentCodeProvenanceHash: H('changed-code'),
  });
  assert.ok(codeDrift.blockers.includes('runtime_reproducibility_code_or_release_drift'));
  const inputDrift = structuredClone(value.inputs);
  inputDrift[0].contextManifest[0].mode ^= 0o111;
  const closureDrift = verifyRuntimeImageReproducibilityReceipt(value.receipt, {
    ...value.verificationContext,
    currentInputs: inputDrift,
  });
  assert.ok(closureDrift.blockers.includes('runtime_reproducibility_build_input_closure_drift'));
});

test('the exact 104-package R source CAS permits attestations but cannot bypass trusted publication', (t) => {
  const value = fixture(t);
  assert.equal(R_RUNTIME_SOURCE_CAS.ready, true, JSON.stringify(R_RUNTIME_SOURCE_CAS.blockers));
  assert.equal(R_RUNTIME_SOURCE_CAS.packageCount, 104);
  const inspection = verifyRuntimeImageReproducibilityReceipt(value.receipt, {
    ...value.verificationContext,
    profilePolicies: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY,
  });
  assert.equal(inspection.ready, true, JSON.stringify(inspection.blockers));
  const repository = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot: path.join(value.root, 'runtime'),
  });
  assert.throws(() => repository.publish({ receipt: value.receipt, inspection, now: NOW }),
    /runtime_reproducibility_receipt_verifier_required/);
  assert.equal(fs.existsSync(repository.receiptPath), false);
});

test('status is read-only and a missing receipt can never become a verified report', (t) => {
  const value = fixture(t);
  const runtimeRoot = path.join(value.root, 'absent-runtime-root');
  const report = composeRuntimeImageReproducibilityStatus({
    runtimeRoot,
    repositoryRoot: REPOSITORY_ROOT,
    configPath: value.configPath,
    environment: { PATH: process.env.PATH },
    now: NOW,
    codeProvenance: {
      version: 2,
      packageVersion: 'fixture',
      commit: 'a'.repeat(40),
      commitTree: 'b'.repeat(40),
      treeDirty: false,
      repositoryContentHash: H('repo'),
      worktreeStateHash: H('worktree'),
    },
  });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.includes('runtime_reproducibility_receipt_missing'));
  assert.equal(report.externalActionPerformed, false);
  assert.equal(fs.existsSync(runtimeRoot), false);
});

test('canonical context closure covers every entry and rejects undeclared or ignored inputs', (t) => {
  const value = fixture(t);
  for (const input of value.inputs) {
    const contextPaths = input.contextManifest.map((entry) => entry.path);
    assert.deepEqual(contextPaths, [...contextPaths].sort());
    assert.equal(input.contextManifest.every((entry) => Number.isSafeInteger(entry.mode)), true);
    assert.equal(input.contextManifest.filter((entry) => entry.type !== 'directory').length,
      AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS[input.profile].definitionPaths.length);
    assert.deepEqual(input.contextTarMetadataPolicy, {
      version: 1,
      kind: 'RuntimeImageCanonicalContextTarMetadataPolicy',
      archiveFormat: 'posix-ustar',
      entryOrder: 'lexicographic-path',
      uid: 0,
      gid: 0,
      uname: '',
      gname: '',
      mtime: 1733097600,
      xattrsIncluded: false,
      deviceEntriesIncluded: false,
    });
  }
  const rContext = value.inputs.find((input) => input.profile === 'r');
  assert.ok(rContext);
  assert.equal(rContext.contextManifest.some((entry) => (
    entry.path === 'source-cas/.git' || entry.path === 'source-cas/.gitattributes'
  )), false);
  assert.deepEqual(AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.r.contextTransportMetadataPaths, [
    'source-cas/.git',
    'source-cas/.gitattributes',
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-context-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = path.join(root, 'context');
  fs.cpSync(path.join(REPOSITORY_ROOT, 'runtime-images/python-gpu'), context, { recursive: true });
  write(path.join(context, 'undeclared.txt'), 'attacker input\n', 0o644);
  assert.throws(() => inspectRuntimeImageBuildInputClosures({
    repositoryRoot: root,
    definitions: {
      pythonGpu: {
        ...AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.pythonGpu,
        contextPath: 'context',
      },
    },
    profiles: ['pythonGpu'],
    platform: 'linux/amd64',
    sourceDateEpoch: 1733097600,
    buildArgs: {},
  }), /runtime_reproducibility_context_definition_not_exhaustive/);
  fs.rmSync(path.join(context, 'undeclared.txt'));
  write(path.join(context, '.dockerignore'), 'requirements.lock\n', 0o644);
  assert.throws(() => inspectRuntimeImageBuildInputClosures({
    repositoryRoot: root,
    definitions: {
      pythonGpu: {
        ...AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.pythonGpu,
        contextPath: 'context',
      },
    },
    profiles: ['pythonGpu'],
    platform: 'linux/amd64',
    sourceDateEpoch: 1733097600,
    buildArgs: {},
  }), /runtime_reproducibility_canonical_context_required/);
  fs.rmSync(path.join(context, '.dockerignore'));
  const originalDockerfile = fs.readFileSync(path.join(context, 'Dockerfile'), 'utf8');
  for (const [firstLine, error] of [
    ['# syntax=docker/dockerfile:1.7', /runtime_reproducibility_dockerfile_frontend_digest_required/],
    [null, /runtime_reproducibility_dockerfile_frontend_digest_required/],
    [`# syntax=docker/dockerfile:1.7@sha256:${'0'.repeat(64)}`,
      /runtime_reproducibility_dockerfile_frontend_policy_drift/],
  ]) {
    const dockerfile = firstLine
      ? originalDockerfile.replace(/^# syntax=.*$/m, firstLine)
      : originalDockerfile.replace(/^# syntax=.*\n/m, '');
    write(path.join(context, 'Dockerfile'), dockerfile, 0o644);
    const definitionPaths = AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.pythonGpu.definitionPaths;
    const definitionManifestHash = hashRecord('RuntimeImageBuildDefinitionManifest',
      definitionPaths.map((relativePath) => ({
        path: `context/${relativePath}`,
        sha256: H(fs.readFileSync(path.join(context, relativePath))),
      })));
    assert.throws(() => inspectRuntimeImageBuildInputClosures({
      repositoryRoot: root,
      definitions: {
        pythonGpu: {
          ...AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.pythonGpu,
          contextPath: 'context',
          definitionPaths,
          definitionManifestHash,
        },
      },
      profiles: ['pythonGpu'],
      platform: 'linux/amd64',
      sourceDateEpoch: 1733097600,
      buildArgs: {},
    }), error);
  }
  for (const drift of [
    { platform: 'linux/arm64', sourceDateEpoch: 1733097600, buildArgs: {} },
    { platform: 'linux/amd64', sourceDateEpoch: 1733097601, buildArgs: {} },
    { platform: 'linux/amd64', sourceDateEpoch: 1733097600, buildArgs: { ATTACKER: '1' } },
  ]) {
    assert.throws(() => inspectRuntimeImageBuildInputClosures({
      repositoryRoot: REPOSITORY_ROOT,
      definitions: AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS,
      profiles: ['python', 'pythonGpu', 'r'],
      ...drift,
    }), /runtime_reproducibility_canonical_build_configuration_drift/);
  }
  for (const mutate of [
    (input) => { delete input.contextTarMetadataPolicy; },
    (input) => { input.contextTarMetadataPolicy.gid = 1000; },
    (input) => { input.contextTarMetadataPolicy.entryOrder = 'filesystem-order'; },
    (input) => { input.contextTarMetadataPolicy.xattrsIncluded = true; },
    (input) => { input.contextTarMetadataPolicy.deviceEntriesIncluded = true; },
    (input) => { input.contextTarMetadataPolicy.mtime += 1; },
    (input) => { delete input.ociExporter; },
    (input) => { input.ociExporter.rewriteTimestamp = false; },
    (input) => { input.ociExporter.sbom = true; },
  ]) {
    const invalidInputs = structuredClone(value.inputs);
    mutate(invalidInputs[0]);
    if (invalidInputs[0].contextTarMetadataPolicy) {
      invalidInputs[0].contextTarMetadataPolicyHash = hashRecord(
        'RuntimeImageCanonicalContextTarMetadataPolicy',
        invalidInputs[0].contextTarMetadataPolicy,
      );
    }
    const {
      runtimeImageCanonicalBuildInputClosureHash: _oldClosureHash,
      ...inputPayload
    } = invalidInputs[0];
    invalidInputs[0].runtimeImageCanonicalBuildInputClosureHash = hashRecord(
      'RuntimeImageCanonicalBuildInputClosure',
      inputPayload,
    );
    assert.throws(() => buildRuntimeImageReproducibilityRequest({
      nonce: 'runtime-repro:invalid-exporter',
      requestedAt: value.request.requestedAt,
      expiresAt: value.request.expiresAt,
      configurationIdentityHash: value.request.configurationIdentityHash,
      trustIdentityHash: value.request.trustIdentityHash,
      codeProvenanceHash: value.request.codeProvenanceHash,
      releaseIdentityHash: value.request.releaseIdentityHash,
      inputs: invalidInputs,
    }), /runtime_reproducibility_request_invalid/);
  }
});

test('receipt publication is a cross-process monotonic SQLite compare-and-swap', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-cas-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  assert.throws(() => createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    busyTimeoutMs: Number.NaN,
  }), /runtime_reproducibility_receipt_busy_timeout_invalid/);
  const repository = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    receiptVerifier: acceptingReceiptVerifier,
  });
  const seed = publicationReceipt('seed', '2026-07-16T00:00:00.000Z');
  const older = publicationReceipt('older-contender', '2026-07-16T01:00:00.000Z');
  const newer = publicationReceipt('newer-contender', '2026-07-16T02:00:00.000Z');
  repository.publish({ receipt: seed, now: new Date(seed.issuedAt) });

  const [olderResult, newerResult] = await Promise.all([
    spawnReceiptPublisher({ runtimeRoot, receipt: older }),
    spawnReceiptPublisher({ runtimeRoot, receipt: newer }),
  ]);
  assert.equal(newerResult.code, 0, newerResult.stderr);
  assert.ok([0, 2].includes(olderResult.code), olderResult.stderr);
  const authority = repository.read();
  assert.equal(authority.receipt.runtimeImageReproducibilityReceiptHash,
    newer.runtimeImageReproducibilityReceiptHash);
  assert.ok(authority.publicationGeneration >= 2);
  assert.throws(() => repository.publish({ receipt: older, now: new Date(older.issuedAt) }),
    /runtime_reproducibility_receipt_monotonic_cas_rejected/);
  assert.equal(repository.read().receipt.runtimeImageReproducibilityReceiptHash,
    newer.runtimeImageReproducibilityReceiptHash);
});

test('a killed SQLite lock owner cannot leave a stale publication lock', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-lock-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    receiptVerifier: acceptingReceiptVerifier,
    busyTimeoutMs: 2_000,
  });
  const first = publicationReceipt('before-killed-lock', '2026-07-16T00:00:00.000Z');
  const successor = publicationReceipt('after-killed-lock', '2026-07-16T01:00:00.000Z');
  repository.publish({ receipt: first, now: new Date(first.issuedAt) });

  const holderSource = `
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(process.argv[1]);
    database.exec('PRAGMA busy_timeout=2000;');
    database.exec('BEGIN IMMEDIATE;');
    process.stdout.write('locked\\n');
    setInterval(() => {}, 60000);
  `;
  const holder = spawn(process.execPath, [
    '--input-type=module', '--eval', holderSource, repository.databasePath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('sqlite_lock_holder_timeout')), 5_000);
    holder.once('error', reject);
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('locked\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    holder.once('exit', (code, signal) => {
      if (!output.includes('locked\n')) {
        clearTimeout(timeout);
        reject(new Error(`sqlite_lock_holder_exited:${code}:${signal}`));
      }
    });
  });
  const holderExited = once(holder, 'exit');
  assert.equal(holder.kill('SIGKILL'), true);
  await holderExited;

  repository.publish({ receipt: successor, now: new Date(successor.issuedAt) });
  assert.equal(repository.read().receipt.runtimeImageReproducibilityReceiptHash,
    successor.runtimeImageReproducibilityReceiptHash);
});

test('SQLite authority survives crashes before commit and before derived mirror rename', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-repro-crash-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    receiptVerifier: acceptingReceiptVerifier,
  });
  const seed = publicationReceipt('crash-seed', '2026-07-16T00:00:00.000Z');
  const beforeCommit = publicationReceipt('killed-before-commit', '2026-07-16T01:00:00.000Z');
  const afterCommit = publicationReceipt('killed-after-commit', '2026-07-16T02:00:00.000Z');
  repository.publish({ receipt: seed, now: new Date(seed.issuedAt) });

  const beforeCommitSource = `
    const { createRuntimeImageReproducibilityReceiptRepository } = await import(process.argv[1]);
    const receipt = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
    const repository = createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot: process.argv[3],
      receiptVerifier: () => {
        process.stdout.write('inside-cas-before-commit\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      },
    });
    repository.publish({ receipt, now: new Date(receipt.issuedAt) });
  `;
  const firstChild = spawn(process.execPath, [
    '--input-type=module', '--eval', beforeCommitSource,
    RECEIPT_REPOSITORY_MODULE,
    Buffer.from(JSON.stringify(beforeCommit)).toString('base64url'),
    runtimeRoot,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForChildOutput(firstChild, 'inside-cas-before-commit\n');
  const firstExit = once(firstChild, 'exit');
  assert.equal(firstChild.kill('SIGKILL'), true);
  await firstExit;
  assert.equal(repository.read().receipt.runtimeImageReproducibilityReceiptHash,
    seed.runtimeImageReproducibilityReceiptHash);

  const afterCommitSource = `
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const path = await import('node:path');
    const require = createRequire(import.meta.url);
    const fs = require('node:fs');
    const destination = path.resolve(process.argv[4]);
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (path.resolve(target) === destination) {
        process.stdout.write('authority-committed-before-mirror-rename\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return originalRename(source, target);
    };
    syncBuiltinESMExports();
    const { createRuntimeImageReproducibilityReceiptRepository } = await import(process.argv[1]);
    const receipt = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
    const repository = createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot: process.argv[3],
      receiptVerifier: (value) => ({
        ready: true,
        receiptAccepted: true,
        receiptHash: value.runtimeImageReproducibilityReceiptHash,
      }),
    });
    repository.publish({ receipt, now: new Date(receipt.issuedAt) });
  `;
  const secondChild = spawn(process.execPath, [
    '--input-type=module', '--eval', afterCommitSource,
    RECEIPT_REPOSITORY_MODULE,
    Buffer.from(JSON.stringify(afterCommit)).toString('base64url'),
    runtimeRoot,
    repository.receiptPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForChildOutput(secondChild, 'authority-committed-before-mirror-rename\n');
  const secondExit = once(secondChild, 'exit');
  assert.equal(secondChild.kill('SIGKILL'), true);
  await secondExit;

  const mirrorBeforeRead = fs.readFileSync(repository.receiptPath);
  const databaseMtimeBeforeRead = fs.statSync(repository.databasePath).mtimeMs;
  assert.throws(() => repository.read(), /runtime_reproducibility_receipt_mirror_drift/);
  assert.deepEqual(fs.readFileSync(repository.receiptPath), mirrorBeforeRead);
  assert.equal(fs.statSync(repository.databasePath).mtimeMs, databaseMtimeBeforeRead);
  const reconciliation = repository.reconcileMirror();
  assert.equal(reconciliation.receiptHash,
    afterCommit.runtimeImageReproducibilityReceiptHash);
  assert.equal(repository.read().receipt.runtimeImageReproducibilityReceiptHash,
    afterCommit.runtimeImageReproducibilityReceiptHash);
});
