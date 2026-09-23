import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectResearchExecutionReleaseAttestorConfiguration as inspectReleaseConfiguration,
  inspectResearchExecutionReleaseAttestorConfigurationAsync as inspectReleaseConfigurationAsync,
} from '../../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildResearchExecutionReleaseKmsHardwareAttestationBundle,
} from '../../../paper-adapters/build-package/research-execution-release-kms-hardware-attestation.mjs';
import {
  buildResearchExecutionReleaseKmsHardwareAttestationSubject,
  RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
} from '../../../paper-domain/automation/research-execution-release-kms-hardware-attestation-contract.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';
export const NOW = '2026-07-15T12:00:00.000Z';
export const H = (label) => hashRecord('ResearchExecutionReleaseAttestorRotationTestHash', { label });

export function inspectionClock(options) {
  if (options?.clock) return options.clock;
  const candidate = options?.now instanceof Date
    ? options.now : new Date(options?.now || NOW);
  const fixed = Number.isFinite(candidate.getTime()) ? candidate : new Date(NOW);
  return { now: () => new Date(fixed) };
}

export function inspectResearchExecutionReleaseAttestorConfiguration(options = {}) {
  return inspectReleaseConfiguration({
    clock: inspectionClock(options),
    ...options,
  });
}

export function inspectResearchExecutionReleaseAttestorConfigurationAsync(options = {}) {
  return inspectReleaseConfigurationAsync({
    clock: inspectionClock(options),
    ...options,
  });
}

export function writeFile(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, value, { mode });
  fs.chmodSync(candidate, mode);
}

export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-attestor-rotation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const active = crypto.generateKeyPairSync('ed25519');
  const retiring = crypto.generateKeyPairSync('ed25519');
  const probe = crypto.generateKeyPairSync('ed25519');
  const kmsHardwareAuthority = crypto.generateKeyPairSync('ed25519');
  const activePublicKeyPath = path.join(root, 'active-public.pem');
  const retiringPublicKeyPath = path.join(root, 'retiring-public.pem');
  const probePublicKeyPath = path.join(root, 'probe-public.pem');
  const kmsHardwareAuthorityBundlePath =
    path.join(root, 'kms-hardware-authority-bundle.json');
  writeFile(activePublicKeyPath, active.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFile(retiringPublicKeyPath, retiring.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFile(probePublicKeyPath, probe.publicKey.export({ type: 'spki', format: 'pem' }));
  const signerExecutable = path.join(root, 'kms-signer');
  const probeExecutable = path.join(root, 'kms-independent-probe');
  const unexpectedSpawnPath = path.join(root, 'unexpected-direct-spawn.log');
  const unexpectedSpawn = (scope) => `#!/usr/bin/env node\n`
    + `require('node:fs').appendFileSync(${JSON.stringify(unexpectedSpawnPath)}, `
    + `${JSON.stringify(`${scope}\n`)});\n`;
  writeFile(signerExecutable, unexpectedSpawn('signer'), 0o700);
  writeFile(probeExecutable, unexpectedSpawn('probe'), 0o700);
  const signerCredentialRoot = path.join(root, 'signer-credentials');
  const probeCredentialRoot = path.join(root, 'probe-credentials');
  fs.mkdirSync(signerCredentialRoot, { mode: 0o700 });
  fs.mkdirSync(probeCredentialRoot, { mode: 0o700 });
  const configPath = path.join(root, 'release-attestor.json');
  const probeSigner = Object.freeze({
    keyId: 'kms-probe-key',
    keyVersion: 'probe-v3',
    subjectId: 'independent-kms-probe',
    organization: 'Independent KMS Operations',
    role: 'research_execution_release_signer_backend_probe_attestor',
    algorithm: 'ed25519',
  });
  const configuration = {
    version: 3,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    status: 'active',
    attestationLifetimeSeconds: 24 * 60 * 60,
    trustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: [{
        keyId: 'release-key-old',
        keyVersion: 'v1',
        subjectId: 'release-attestor',
        organization: 'Research Release Office',
        role: 'research_execution_release_attestor',
        algorithm: 'ed25519',
        status: 'retiring',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        expiresAt: '2026-08-01T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: retiringPublicKeyPath,
      }, {
        keyId: 'release-key-current',
        keyVersion: 'v2',
        subjectId: 'release-attestor',
        organization: 'Research Release Office',
        role: 'research_execution_release_attestor',
        algorithm: 'ed25519',
        status: 'active',
        effectiveFrom: '2026-07-10T00:00:00.000Z',
        expiresAt: '2026-09-01T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: activePublicKeyPath,
      }],
    },
    backend: {
      kind: 'external-kms-command',
      backendId: 'research-kms-production',
      backendVersion: 'hsm-cluster-v7',
      algorithm: 'ed25519',
      hardwareProtected: true,
      privateKeyExportable: false,
      externalSignerProcess: true,
      activeKeyId: 'release-key-current',
      activeKeyVersion: 'v2',
      kmsProvider: 'example-external-kms',
      providerAccountIdentityHash: H('kms-provider-account'),
      keyResourceIdentityHash: H('kms-key-resource'),
      credentialGenerationIdentityHash: H('kms-credential-generation'),
      signerCommand: {
        serviceId: 'release-kms-signer',
        principalId: 'release-kms-principal',
        protocol: 'hepta-release-signer-json-stdio-v2',
        executable: signerExecutable,
        credentialRoot: signerCredentialRoot,
        args: [],
        environmentAllowlist: [],
        timeoutMs: 5000,
      },
      probeCommand: {
        serviceId: 'independent-kms-probe',
        principalId: 'independent-kms-probe-principal',
        protocol: 'hepta-release-signer-probe-json-stdio-v1',
        executable: probeExecutable,
        credentialRoot: probeCredentialRoot,
        args: [],
        environmentAllowlist: [],
        timeoutMs: 5000,
      },
      probeAttestor: {
        ...probeSigner,
        status: 'active',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        expiresAt: '2027-07-01T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: probePublicKeyPath,
      },
    },
    hardwareAuthorityAttestation: null,
  };
  const kmsHardwareAuthorityTrustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: Object.freeze([Object.freeze({
      keyId: 'kms-hardware-authority-key',
      subjectId: 'external-kms-control-plane-authority',
      organization: 'External KMS Control Plane Authority',
      algorithm: 'ed25519',
      publicKeyPem: kmsHardwareAuthority.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      roles: Object.freeze([
        RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
      ]),
      status: 'active',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      expiresAt: '2027-07-01T00:00:00.000Z',
      revokedAt: null,
    })]),
  });
  const kmsHardwareChallengeHash = H('kms-hardware-authority-challenge');
  function signedHardwareAuthorityBundle({
    backendDescriptorHash,
    trustSetHash,
    attestedAt = '2026-07-15T11:59:00.000Z',
    expiresAt = '2026-07-15T12:05:00.000Z',
  }) {
    const subject = buildResearchExecutionReleaseKmsHardwareAttestationSubject({
      kmsProvider: configuration.backend.kmsProvider,
      providerAccountIdentityHash:
        configuration.backend.providerAccountIdentityHash,
      keyResourceIdentityHash:
        configuration.backend.keyResourceIdentityHash,
      credentialGenerationIdentityHash:
        configuration.backend.credentialGenerationIdentityHash,
      backendDescriptorHash,
      backendId: configuration.backend.backendId,
      backendVersion: configuration.backend.backendVersion,
      activeKeyId: configuration.backend.activeKeyId,
      activeKeyVersion: configuration.backend.activeKeyVersion,
      activePublicKeySpkiHash: hashBytes(
        active.publicKey.export({ type: 'spki', format: 'der' }),
      ),
      trustSetHash,
      challengeHash: kmsHardwareChallengeHash,
      attestedAt,
      expiresAt,
    });
    const placeholder = buildPinnedExternalEvidenceEnvelope({
      subjectKind: subject.kind,
      subjectHash:
        subject.researchExecutionReleaseKmsHardwareAttestationSubjectHash,
      signedAt: attestedAt,
      expiresAt,
      signatures: [{
        keyId: 'kms-hardware-authority-key',
        role: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
        algorithm: 'ed25519',
        value: 'placeholder',
      }],
    });
    const signature = crypto.sign(
      null,
      pinnedExternalEvidenceSigningPayload(placeholder),
      kmsHardwareAuthority.privateKey,
    ).toString('base64');
    const authorityEnvelope = buildPinnedExternalEvidenceEnvelope({
      ...placeholder,
      signatures: [{
        keyId: 'kms-hardware-authority-key',
        role: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
        algorithm: 'ed25519',
        value: signature,
      }],
    });
    return buildResearchExecutionReleaseKmsHardwareAttestationBundle({
      subject,
      authorityEnvelope,
      trustStore: kmsHardwareAuthorityTrustStore,
      signerKeyIds: ['kms-hardware-authority-key'],
      maximumLifetimeMs: 10 * 60 * 1000,
    });
  }
  function saveHardwareAuthorityBundle(bundle) {
    writeFile(
      kmsHardwareAuthorityBundlePath,
      `${JSON.stringify(bundle, null, 2)}\n`,
    );
    if (configuration.hardwareAuthorityAttestation === null) {
      configuration.hardwareAuthorityAttestation = {
        bundlePath: kmsHardwareAuthorityBundlePath,
        trustStoreHash: bundle.trustStoreHash,
        signerKeyIds: ['kms-hardware-authority-key'],
        challengeHash: kmsHardwareChallengeHash,
      };
    }
  }
  saveHardwareAuthorityBundle(signedHardwareAuthorityBundle({
    backendDescriptorHash: H('placeholder-kms-backend-descriptor'),
    trustSetHash: H('placeholder-release-trust-set'),
  }));
  const save = (value = configuration) => writeFile(
    configPath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
  save();
  const provisional = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath,
    now: new Date(NOW),
    activeVerification: false,
  });
  saveHardwareAuthorityBundle(signedHardwareAuthorityBundle({
    backendDescriptorHash: provisional.backendDescriptorHash,
    trustSetHash: provisional.trustSetHash,
  }));
  save();

  function spawnSyncImpl(executable, _args, options) {
    const request = JSON.parse(String(options.input));
    assert.equal(executable, '/proc/self/fd/3');
    assert.equal(Number.isSafeInteger(options.stdio?.[3]), true);
    if (request.kind === 'ResearchExecutionReleaseSignerBackendProbeRequest') {
      const payload = {
        version: 1,
        kind: 'ResearchExecutionReleaseSignerBackendProbeAttestation',
        status: 'research_execution_release_signer_backend_probe_verified',
        backendDescriptorHash: request.backendDescriptorHash,
        backendId: request.backendId,
        backendVersion: request.backendVersion,
        activeKeyId: request.activeKeyId,
        activeKeyVersion: request.activeKeyVersion,
        activePublicKeySpkiHash: request.activePublicKeySpkiHash,
        algorithm: 'ed25519',
        challengeHash: request.challengeHash,
        backendReachable: true,
        hardwareProtected: configuration.backend.hardwareProtected,
        privateKeyExportable: configuration.backend.privateKeyExportable,
        externalSignerProcess: true,
        probedAt: '2026-07-15T11:59:59.000Z',
        expiresAt: '2026-07-15T12:04:59.000Z',
        externalActionPerformed: true,
        externalActionScope: 'single_read_only_release_signer_backend_challenge',
        signer: probeSigner,
      };
      const signingPayloadHash = hashRecord(
        'ResearchExecutionReleaseSignerBackendProbeAttestationSigningPayload',
        payload,
      );
      const signature = crypto.sign(
        null,
        Buffer.from(signingPayloadHash, 'utf8'),
        probe.privateKey,
      ).toString('base64');
      const signed = { ...payload, signature };
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          ...signed,
          researchExecutionReleaseSignerBackendProbeAttestationHash: hashRecord(
            'ResearchExecutionReleaseSignerBackendProbeAttestation',
            signed,
          ),
        }),
      };
    }
    assert.equal(request.kind, 'ResearchExecutionReleaseSignerRequest');
    const signature = crypto.sign(
      null,
      Buffer.from(request.signingPayloadHash, 'utf8'),
      active.privateKey,
    ).toString('base64');
    const response = {
      version: request.version,
      kind: 'ResearchExecutionReleaseSignerResponse',
      status: 'research_execution_release_digest_signed',
      backendDescriptorHash: request.backendDescriptorHash,
      backendId: request.backendId,
      backendVersion: request.backendVersion,
      keyId: request.keyId,
      keyVersion: request.keyVersion,
      algorithm: 'ed25519',
      signingPayloadHash: request.signingPayloadHash,
      requestNonceHash: request.requestNonceHash,
      ...(request.version === 2 ? {
        authorizationExpiresAt: request.authorizationExpiresAt,
        signedAt: NOW,
      } : {}),
      signature,
    };
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        ...response,
        researchExecutionReleaseSignerResponseHash:
          hashRecord('ResearchExecutionReleaseSignerResponse', response),
      }),
    };
  }
  function rotateHardwareAuthorityBundle({
    attestedAt,
    expiresAt,
  }) {
    const current = inspectResearchExecutionReleaseAttestorConfiguration({
      configPath,
      now: new Date(NOW),
      activeVerification: false,
    });
    const bundle = signedHardwareAuthorityBundle({
      backendDescriptorHash: current.backendDescriptorHash,
      trustSetHash: current.trustSetHash,
      attestedAt,
      expiresAt,
    });
    saveHardwareAuthorityBundle(bundle);
    return bundle;
  }
  return {
    root,
    active,
    retiring,
    configPath,
    configuration,
    configurationFileHash: () => (
      `sha256:${crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex')}`
    ),
    configurationIdentityHash: (environment = process.env) => (
      inspectResearchExecutionReleaseAttestorConfiguration({
        configPath,
        now: new Date(NOW),
        activeVerification: false,
        environment,
      }).configurationIdentityHash
    ),
    save,
    rotateHardwareAuthorityBundle,
    spawnSyncImpl,
    unexpectedSpawnPath,
    activePublicKeyPath,
    retiringPublicKeyPath,
  };
}

export function signer(keyId, keyVersion) {
  return Object.freeze({
    keyId,
    keyVersion,
    subjectId: 'release-attestor',
    organization: 'Research Release Office',
    role: 'research_execution_release_attestor',
    algorithm: 'ed25519',
  });
}

export function manifest() {
  return Object.freeze({
    researchEvidenceCapsuleManifestHash: H('manifest'),
    campaignId: 'campaign:rotation',
    paperId: 'paper:rotation',
    researchReportHash: H('report'),
    experimentRegistryHash: H('registry'),
    campaignResearchSourceSnapshotHash: H('source-snapshot'),
    verifiedSourceMerkleHash: H('source-merkle'),
    verifiedSourceWorkspaceManifestHash: H('source-workspace'),
    researchVerifyNodeId: 'campaign:rotation:research-verify',
    researchVerifyAttemptId: 'attempt:rotation',
    researchVerifyLeaseGeneration: 1,
    academicExperimentCount: 1,
    experimentCount: 1,
    createdAt: NOW,
  });
}
