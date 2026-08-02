import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createResearchExecutionReleaseAttestor,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  inspectPinnedExternalEvidenceTrustStore,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
} from '../../paper-domain/automation/research-execution-release-kms-hardware-attestation-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  H,
  NOW,
  fixture,
  inspectResearchExecutionReleaseAttestorConfiguration,
  manifest,
  signer,
  writeFile,
} from './support/research-execution-release-attestor-rotation-fixture.mjs';
test('external KMS pin and exact schema fail before every process action', (t) => {
  const f = fixture(t);
  let externalCalls = 0;
  const spawn = (...args) => {
    externalCalls += 1;
    return f.spawnSyncImpl(...args);
  };
  const unpinned = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: spawn,
  });
  assert.equal(unpinned.ready, true);
  assert.equal(unpinned.configurationPinned, false);
  assert.equal(unpinned.productionReady, false);
  assert.equal(unpinned.externalActionPerformed, false);
  assert.ok(unpinned.productionBlockers.includes(
    'research_execution_release_attestor_config_pin_required',
  ));
  assert.equal(externalCalls, 0);

  const mismatched = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: H('wrong-release-attestor-config'),
    now: new Date(NOW),
    spawnSyncImpl: spawn,
  });
  assert.equal(mismatched.ready, false);
  assert.ok(mismatched.blockers.includes(
    'research_execution_release_attestor_config_pin_mismatch',
  ));
  assert.equal(externalCalls, 0);

  const semanticConfigurationHash = f.configurationIdentityHash();
  const signerExecutable = f.configuration.backend.signerCommand.executable;
  const originalSignerExecutable = fs.readFileSync(signerExecutable);
  writeFile(
    signerExecutable,
    '#!/usr/bin/env node\nprocess.stdout.write("{}\\n");\n',
    0o700,
  );
  const substitutedDependency =
    inspectResearchExecutionReleaseAttestorConfiguration({
      configPath: f.configPath,
      expectedConfigurationHash: semanticConfigurationHash,
      now: new Date(NOW),
      spawnSyncImpl: spawn,
    });
  assert.equal(substitutedDependency.ready, false);
  assert.ok(substitutedDependency.blockers.includes(
    'research_execution_release_attestor_config_pin_mismatch',
  ));
  assert.equal(substitutedDependency.externalActionPerformed, false);
  assert.equal(externalCalls, 0);
  writeFile(signerExecutable, originalSignerExecutable, 0o700);

  const unpinnedAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: spawn,
  });
  assert.throws(() => unpinnedAttestor.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_config_pin_required/);
  assert.equal(externalCalls, 0);

  const hardlinkPath = path.join(f.root, 'release-attestor-hardlink.json');
  fs.linkSync(f.configPath, hardlinkPath);
  const hardlinked = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: hardlinkPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    now: new Date(NOW),
    spawnSyncImpl: spawn,
  });
  assert.equal(hardlinked.ready, false);
  assert.ok(hardlinked.blockers.includes(
    'research_execution_release_attestor_config_not_private_regular_file',
  ));
  fs.unlinkSync(hardlinkPath);

  for (const mutate of [
    (value) => { value.apiToken = 'inline-secret-forbidden'; },
    (value) => { value.backend.signerCommand.args = ['--inline-secret']; },
    (value) => { value.backend.probeCommand.environmentAllowlist = ['HOME']; },
    (value) => {
      value.hardwareAuthorityAttestation.bundleFileHash =
        hashBytes(fs.readFileSync(value.hardwareAuthorityAttestation.bundlePath));
    },
    (value) => {
      value.backend.signerCommand.protocol = 'hepta-release-signer-json-stdio-v1';
    },
  ]) {
    const value = structuredClone(f.configuration);
    mutate(value);
    f.save(value);
    const blocked = inspectResearchExecutionReleaseAttestorConfiguration({
      configPath: f.configPath,
      expectedConfigurationHash: f.configurationIdentityHash(),
      now: new Date(NOW),
      spawnSyncImpl: spawn,
    });
    assert.equal(blocked.ready, false);
    assert.equal(blocked.externalActionPerformed, false);
    assert.equal(externalCalls, 0);
  }
});
test('v2 self-declared KMS hardware claims stay bounded and perform zero live actions', (t) => {
  const f = fixture(t);
  f.configuration.version = 2;
  delete f.configuration.hardwareAuthorityAttestation;
  delete f.configuration.backend.kmsProvider;
  delete f.configuration.backend.providerAccountIdentityHash;
  delete f.configuration.backend.keyResourceIdentityHash;
  delete f.configuration.backend.credentialGenerationIdentityHash;
  f.configuration.backend.signerCommand.protocol =
    'hepta-release-signer-json-stdio-v1';
  f.save();
  const expectedConfigurationHash = f.configurationIdentityHash();
  let externalCalls = 0;
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash,
    now: new Date(NOW),
    spawnSyncImpl(...args) {
      externalCalls += 1;
      return f.spawnSyncImpl(...args);
    },
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.configurationPinned, true);
  assert.equal(inspection.backendProductionEligible, true);
  assert.equal(inspection.productionReady, false);
  assert.equal(inspection.fullProductionReady, false);
  assert.equal(inspection.kmsHardwareAuthorityAttestationReady, false);
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(externalCalls, 0);
  assert.ok(inspection.productionBlockers.includes(
    'research_execution_release_attestor_kms_hardware_authority_attestation_required',
  ));
});

test('colliding KMS control-plane authority is pinned but cannot trigger a live action', (t) => {
  const f = fixture(t);
  const bundlePath = f.configuration.hardwareAuthorityAttestation.bundlePath;
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  bundle.trustStore.keys[0].organization = 'Research Release Office';
  const trust = inspectPinnedExternalEvidenceTrustStore(bundle.trustStore, {
    requiredRole: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
    expectedKeyIds: bundle.signerKeyIds,
  });
  assert.equal(trust.ready, true);
  bundle.trustStore = trust.canonicalTrustStore;
  bundle.trustStoreHash = trust.trustStoreHash;
  const { bundleHash: _bundleHash, ...bundlePayload } = bundle;
  bundle.bundleHash = hashRecord(
    'ResearchExecutionReleaseKmsHardwareAttestationBundle',
    bundlePayload,
  );
  writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  f.configuration.hardwareAuthorityAttestation.trustStoreHash =
    bundle.trustStoreHash;
  f.save();
  const expectedConfigurationHash = f.configurationIdentityHash();
  let externalCalls = 0;
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash,
    now: new Date(NOW),
    spawnSyncImpl(...args) {
      externalCalls += 1;
      return f.spawnSyncImpl(...args);
    },
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.configurationPinned, true);
  assert.equal(inspection.kmsHardwareAuthorityAttestationReady, false);
  assert.ok(inspection.kmsHardwareAuthorityBlockers.includes(
    'research_execution_release_kms_hardware_attestation_authority_independence_invalid',
  ));
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(externalCalls, 0);
});

test('release signer and backend probe require distinct subjects and organizations', (t) => {
  const f = fixture(t);
  for (const mutate of [
    (value) => {
      value.backend.probeAttestor.subjectId = value.trustSet.keys[1].subjectId;
    },
    (value) => {
      value.backend.probeAttestor.organization =
        value.trustSet.keys[1].organization.toUpperCase();
    },
  ]) {
    const configuration = structuredClone(f.configuration);
    mutate(configuration);
    f.save(configuration);
    const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
      configPath: f.configPath,
      now: new Date(NOW),
      activeVerification: false,
      spawnSyncImpl: () => {
        throw new Error('independence failure must precede external action');
      },
    });
    assert.equal(inspection.ready, false);
    assert.ok(inspection.blockers.includes(
      'research_execution_release_attestor_independent_backend_probe_required',
    ));
    f.save();
  }
});

test('dedicated UID signer is production-ready only within the research-runtime UID boundary', (t) => {
  const f = fixture(t);
  f.configuration.version = 2;
  delete f.configuration.hardwareAuthorityAttestation;
  delete f.configuration.backend.kmsProvider;
  delete f.configuration.backend.providerAccountIdentityHash;
  delete f.configuration.backend.keyResourceIdentityHash;
  delete f.configuration.backend.credentialGenerationIdentityHash;
  Object.assign(f.configuration.backend, {
    kind: 'dedicated-uid-command',
    backendId: 'host-release-signer',
    backendVersion: 'dedicated-uid-v1',
    hardwareProtected: false,
    privateKeyExportable: true,
    assuranceProfile: 'dedicated-host-uid-unix-socket-v1',
    threatBoundary: 'research-runtime-uid',
  });
  f.configuration.backend.signerCommand.protocol =
    'hepta-release-signer-json-stdio-v1';
  f.save();
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
    randomBytesImpl: () => Buffer.alloc(32, 11),
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.productionReady, true);
  assert.equal(inspection.fullProductionReady, false);
  assert.equal(
    inspection.fullProductionStatus,
    'research_execution_release_attestor_full_production_blocked',
  );
  assert.deepEqual(inspection.fullProductionBlockers, [
    'research_execution_release_attestor_full_production_hardware_kms_required',
  ]);
  assert.equal(inspection.backendKind, 'dedicated-uid-command');
  assert.equal(inspection.hardwareProtected, false);
  assert.equal(inspection.privateKeyExportable, true);
  assert.equal(inspection.privateKeyLoadedIntoMainProcess, false);
  assert.equal(inspection.credentialMaterialReadByMainProcess, false);
  assert.equal(
    inspection.signerBackendAssuranceProfile,
    'dedicated-host-uid-unix-socket-v1',
  );
  assert.equal(inspection.signerBackendThreatBoundary, 'research-runtime-uid');
  assert.equal(
    inspection.signerBackendAssurance,
    'independently-probed-and-active-key-challenged-dedicated-host-uid-signer-v1',
  );
});

test('revocation, duplicate SPKI encodings, wrong algorithm, and private-key disclosure fail closed', (t) => {
  const f = fixture(t);
  const revoked = structuredClone(f.configuration);
  revoked.trustSet.keys[0].revokedAt = '2026-07-15T11:30:00.000Z';
  f.save(revoked);
  const revokedAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: f.spawnSyncImpl,
  });
  const payloadHash = H('revoked-payload');
  const signature = crypto.sign(
    null,
    Buffer.from(payloadHash, 'utf8'),
    f.retiring.privateKey,
  ).toString('base64');
  assert.equal(revokedAttestor.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature,
    signer: signer('release-key-old', 'v1'),
    signedAt: '2026-07-15T11:00:00.000Z',
  }), false);

  const duplicatePemPath = path.join(f.root, 'retiring-public-alternate.pem');
  const alternatePem = String(
    f.retiring.publicKey.export({ type: 'spki', format: 'pem' }),
  ).replaceAll('\n', '\r\n');
  writeFile(duplicatePemPath, alternatePem);
  const duplicate = structuredClone(f.configuration);
  duplicate.trustSet.keys.push({
    ...duplicate.trustSet.keys[0],
    keyId: 'release-key-alias',
    keyVersion: 'alias-v9',
    publicKeyPath: duplicatePemPath,
  });
  f.save(duplicate);
  const duplicateInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(duplicateInspection.ready, false);
  assert.ok(duplicateInspection.blockers.includes(
    'research_execution_release_attestor_trust_set_key_identity_collision',
  ));

  const wrongAlgorithm = structuredClone(f.configuration);
  wrongAlgorithm.backend.algorithm = 'rsa-sha256';
  f.save(wrongAlgorithm);
  const algorithmInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(algorithmInspection.ready, false);
  assert.ok(algorithmInspection.blockers.includes(
    'research_execution_release_attestor_backend_descriptor_invalid',
  ));

  const disclosure = structuredClone(f.configuration);
  disclosure.backend.privateKeyPath = '/forbidden/main-process-private-key.pem';
  f.save(disclosure);
  const disclosureInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(disclosureInspection.ready, false);
  assert.ok(disclosureInspection.blockers.includes(
    'research_execution_release_attestor_private_key_disclosure_forbidden',
  ));
  assert.equal(disclosureInspection.privateKeyDisclosed, false);
  assert.equal(JSON.stringify(disclosureInspection).includes('main-process-private-key.pem'), false);
});

test('file signer is explicit local degradation and forged independent probes never unlock production', (t) => {
  const f = fixture(t);
  const localPrivateKeyPath = path.join(f.root, 'local-private.pem');
  const localConfigPath = path.join(f.root, 'local-config.json');
  writeFile(localPrivateKeyPath, f.active.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFile(localConfigPath, JSON.stringify({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    keyId: 'local-release-key',
    keyVersion: 'local-v1',
    subjectId: 'local-release-attestor',
    organization: 'Local Test Release Office',
    algorithm: 'ed25519',
    role: 'research_execution_release_attestor',
    status: 'active',
    revoked: false,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    attestationLifetimeSeconds: 86400,
    privateKeyPath: localPrivateKeyPath,
  }));
  const localInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: localConfigPath,
    now: new Date(NOW),
  });
  assert.equal(localInspection.ready, true);
  assert.equal(localInspection.productionReady, false);
  assert.equal(localInspection.backendKind, 'local-file');
  assert.equal(localInspection.privateKeyLoadedIntoMainProcess, true);
  assert.equal(localInspection.externalActionPerformed, false);
  assert.ok(localInspection.productionBlockers.includes(
    'research_execution_release_attestor_production_backend_required',
  ));
  assert.equal(JSON.stringify(localInspection).includes(localPrivateKeyPath), false);

  const forgedProbe = (executable, args, options) => {
    const result = f.spawnSyncImpl(executable, args, options);
    const request = JSON.parse(String(options.input));
    if (request.kind !== 'ResearchExecutionReleaseSignerBackendProbeRequest') return result;
    const response = JSON.parse(result.stdout);
    response.backendVersion = 'attacker-downgrade';
    return { ...result, stdout: JSON.stringify(response) };
  };
  const forgedInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    now: new Date(NOW),
    spawnSyncImpl: forgedProbe,
  });
  assert.equal(forgedInspection.ready, false);
  assert.equal(forgedInspection.productionReady, false);
  assert.ok(forgedInspection.blockers.includes(
    'research_execution_release_attestor_backend_probe_not_verified',
  ));
  assert.equal(forgedInspection.activeSignerChallengeVerified, false);
  assert.equal(forgedInspection.externalActionScope, 'independent_release_backend_probe');

  const wrongVersionSigner = (executable, args, options) => {
    const result = f.spawnSyncImpl(executable, args, options);
    const request = JSON.parse(String(options.input));
    if (request.kind !== 'ResearchExecutionReleaseSignerRequest') return result;
    const response = JSON.parse(result.stdout);
    const { researchExecutionReleaseSignerResponseHash: _hash, ...payload } = response;
    payload.keyVersion = 'retired-version-downgrade';
    return {
      ...result,
      stdout: JSON.stringify({
        ...payload,
        researchExecutionReleaseSignerResponseHash:
          hashRecord('ResearchExecutionReleaseSignerResponse', payload),
      }),
    };
  };
  const downgradedAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: wrongVersionSigner,
  });
  assert.throws(() => downgradedAttestor.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_backend_signing_response_invalid/);
});

test('an independent probe cannot hide an unreachable or wrong active KMS signing key', (t) => {
  const f = fixture(t);
  const unreachableSigner = (executable, args, options) => {
    const request = JSON.parse(String(options.input));
    if (request.kind === 'ResearchExecutionReleaseSignerRequest') {
      return { status: 1, signal: null, stdout: '', stderr: 'active key unavailable' };
    }
    return f.spawnSyncImpl(executable, args, options);
  };
  const unreachable = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    now: new Date(NOW),
    spawnSyncImpl: unreachableSigner,
    randomBytesImpl: () => Buffer.alloc(32, 11),
  });
  assert.equal(unreachable.independentBackendProbeVerified, true);
  assert.equal(unreachable.activeSignerChallengeVerified, false);
  assert.equal(unreachable.ready, false);
  assert.equal(unreachable.productionReady, false);
  assert.ok(unreachable.blockers.includes(
    'research_execution_release_attestor_active_signer_challenge_not_verified',
  ));
  assert.ok(unreachable.productionBlockers.includes(
    'research_execution_release_attestor_active_signer_challenge_required',
  ));

  const wrongKey = crypto.generateKeyPairSync('ed25519');
  const wrongKeySigner = (executable, args, options) => {
    const result = f.spawnSyncImpl(executable, args, options);
    const request = JSON.parse(String(options.input));
    if (request.kind !== 'ResearchExecutionReleaseSignerRequest') return result;
    const response = JSON.parse(result.stdout);
    const { researchExecutionReleaseSignerResponseHash: _hash, ...payload } = response;
    payload.signature = crypto.sign(
      null,
      Buffer.from(request.signingPayloadHash, 'utf8'),
      wrongKey.privateKey,
    ).toString('base64');
    return {
      ...result,
      stdout: JSON.stringify({
        ...payload,
        researchExecutionReleaseSignerResponseHash:
          hashRecord('ResearchExecutionReleaseSignerResponse', payload),
      }),
    };
  };
  const mismatched = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    now: new Date(NOW),
    spawnSyncImpl: wrongKeySigner,
    randomBytesImpl: () => Buffer.alloc(32, 12),
  });
  assert.equal(mismatched.independentBackendProbeVerified, true);
  assert.equal(mismatched.activeSignerChallengeVerified, false);
  assert.equal(mismatched.productionReady, false);

  const mismatchedAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: wrongKeySigner,
  });
  assert.throws(() => mismatchedAttestor.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_backend_signature_invalid/);
});
