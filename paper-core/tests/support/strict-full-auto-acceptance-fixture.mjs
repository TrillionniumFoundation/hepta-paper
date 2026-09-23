import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  StrictFullAutoAcceptanceCommandRunner,
} from '../../../paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs';
import {
  StrictFullAutoAcceptanceRepository,
} from '../../../paper-adapters/automation/strict-full-auto-acceptance-repository.mjs';
import {
  buildAutonomousResearchAuthorIdentityConfiguration,
} from '../../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildResearchExecutionReleaseKmsHardwareAttestationBundle,
} from '../../../paper-adapters/build-package/research-execution-release-kms-hardware-attestation.mjs';
import {
  readProvisionedReleaseAttestorConfiguration,
} from '../../../paper-adapters/build-package/research-execution-release-attestor-configuration.mjs';
import {
  StrictFullAutoAcceptanceOrchestrator,
} from '../../../paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
  strictFullAutoAcceptanceHash,
} from '../../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  buildResearchExecutionReleaseKmsHardwareAttestationSubject,
  RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
} from '../../../paper-domain/automation/research-execution-release-kms-hardware-attestation-contract.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { hashBytes } from '../../../workflow-kernel/record-hash.mjs';

export const STRICT_FULL_AUTO_ACCEPTANCE_TEST_NOW = '2026-07-21T05:00:00.000Z';

export function sha256File(candidate) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`;
}

const EXAMPLE_CONFIGURATION = JSON.parse(fs.readFileSync(new URL(
  '../../deploy/strict-full-auto-acceptance.config.example.json',
  import.meta.url,
), 'utf8'));
const SEMANTIC_CONFIGURATION_REFERENCES = new Set([
  'research-author-identity-config',
  'release-attestor-config',
  'runtime-reproducibility-principal',
]);
const AUTHOR_IDENTITY_ROLE = 'external_principal_identity_attestor';
const RELEASE_ATTESTOR_ROLE = 'research_execution_release_attestor';
const RELEASE_PROBE_ROLE = 'research_execution_release_signer_backend_probe_attestor';

function strictAuthorIdentityFixture() {
  const authority = crypto.generateKeyPairSync('ed25519');
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'strict-author-identity-key',
      subjectId: 'strict-author-identity-authority',
      organization: 'Independent Strict Author Identity Authority',
      algorithm: 'ed25519',
      publicKeyPem: authority.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [AUTHOR_IDENTITY_ROLE],
      status: 'active',
      effectiveFrom: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-22T00:00:00.000Z',
      revokedAt: null,
    }],
  };
  const configuration = (rotation) => {
    const subject = buildExternalPrincipalIdentityAttestationSubject({
      serviceId: 'strict-author-platform',
      principalId: 'strict-author-principal',
      provider: 'openai',
      providerAccountIdentityHash:
        strictFullAutoAcceptanceHash({ author: 'provider-account' }),
      credentialRootIdentityHash:
        strictFullAutoAcceptanceHash({ author: 'credential-root' }),
      hostIdentityHash:
        strictFullAutoAcceptanceHash({ author: 'host', rotation }),
      processIdentityHash:
        strictFullAutoAcceptanceHash({ author: 'process', rotation }),
      trustDomainIdentityHash:
        strictFullAutoAcceptanceHash({ author: 'trust-domain' }),
      signerPublicKeySpkiHash:
        strictFullAutoAcceptanceHash({ author: 'platform-signer' }),
      challengeHash:
        strictFullAutoAcceptanceHash({ author: 'challenge', rotation }),
      assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
      attestedAt: rotation === 1
        ? '2026-07-21T04:57:00.000Z' : '2026-07-21T04:59:00.000Z',
      expiresAt: rotation === 1
        ? '2026-07-21T05:04:00.000Z' : '2026-07-21T05:06:00.000Z',
    });
    const unsigned = buildPinnedExternalEvidenceEnvelope({
      subjectKind: subject.kind,
      subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
      signedAt: rotation === 1
        ? '2026-07-21T04:58:00.000Z' : '2026-07-21T05:00:00.000Z',
      expiresAt: rotation === 1
        ? '2026-07-21T05:03:00.000Z' : '2026-07-21T05:05:00.000Z',
      signatures: [{
        keyId: 'strict-author-identity-key',
        role: AUTHOR_IDENTITY_ROLE,
        algorithm: 'ed25519',
        value: 'placeholder',
      }],
    });
    const value = crypto.sign(
      null,
      pinnedExternalEvidenceSigningPayload(unsigned),
      authority.privateKey,
    ).toString('base64');
    return buildAutonomousResearchAuthorIdentityConfiguration({
      version: 2,
      subject,
      authorityEnvelope: buildPinnedExternalEvidenceEnvelope({
        ...unsigned,
        signatures: [{
          keyId: 'strict-author-identity-key',
          role: AUTHOR_IDENTITY_ROLE,
          algorithm: 'ed25519',
          value,
        }],
      }),
      trustStore,
      signerKeyIds: ['strict-author-identity-key'],
      maximumLifetimeMs: 10 * 60 * 1000,
    });
  };
  return Object.freeze({
    initial: configuration(1),
    rotate: () => configuration(2),
  });
}

function strictReleaseAttestorFixture({ referenceRoot, references }) {
  const active = crypto.generateKeyPairSync('ed25519');
  const probe = crypto.generateKeyPairSync('ed25519');
  const hardwareAuthority = crypto.generateKeyPairSync('ed25519');
  const activePublicKeyPath = path.join(referenceRoot, 'strict-release-active-public.pem');
  const probePublicKeyPath = path.join(referenceRoot, 'strict-release-probe-public.pem');
  const bundlePath = path.join(referenceRoot, 'strict-release-kms-bundle.json');
  for (const [candidate, value] of [
    [activePublicKeyPath, active.publicKey.export({ type: 'spki', format: 'pem' })],
    [probePublicKeyPath, probe.publicKey.export({ type: 'spki', format: 'pem' })],
  ]) {
    fs.writeFileSync(candidate, value, { mode: 0o444 });
    fs.chmodSync(candidate, 0o444);
  }
  const challengeHash = strictFullAutoAcceptanceHash({
    release: 'hardware-authority-challenge',
  });
  const hardwareTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'strict-release-hardware-authority-key',
      subjectId: 'strict-release-hardware-authority',
      organization: 'Independent Strict KMS Control Plane',
      algorithm: 'ed25519',
      publicKeyPem: hardwareAuthority.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE],
      status: 'active',
      effectiveFrom: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-22T00:00:00.000Z',
      revokedAt: null,
    }],
  };
  const configuration = {
    version: 3,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    status: 'active',
    attestationLifetimeSeconds: 60 * 60,
    trustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: [{
        keyId: 'strict-release-active-key',
        keyVersion: 'v3',
        subjectId: 'strict-release-attestor',
        organization: 'Strict Research Release Office',
        role: RELEASE_ATTESTOR_ROLE,
        algorithm: 'ed25519',
        status: 'active',
        effectiveFrom: '2026-07-20T00:00:00.000Z',
        expiresAt: '2026-07-22T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: activePublicKeyPath,
      }],
    },
    backend: {
      kind: 'external-kms-command',
      backendId: 'strict-release-kms',
      backendVersion: 'v3',
      algorithm: 'ed25519',
      hardwareProtected: true,
      privateKeyExportable: false,
      externalSignerProcess: true,
      activeKeyId: 'strict-release-active-key',
      activeKeyVersion: 'v3',
      kmsProvider: 'strict-external-kms',
      providerAccountIdentityHash:
        strictFullAutoAcceptanceHash({ release: 'provider-account' }),
      keyResourceIdentityHash:
        strictFullAutoAcceptanceHash({ release: 'key-resource' }),
      credentialGenerationIdentityHash:
        strictFullAutoAcceptanceHash({ release: 'credential-generation' }),
      signerCommand: {
        serviceId: 'strict-release-signer',
        principalId: 'strict-release-signer-principal',
        protocol: 'hepta-release-signer-json-stdio-v2',
        executable: references['release-attestor-signer-command'].path,
        credentialRoot: references['release-attestor-signer-credential-root'].path,
        args: [],
        environmentAllowlist: [],
        timeoutMs: 5_000,
      },
      probeCommand: {
        serviceId: 'strict-release-probe',
        principalId: 'strict-release-probe-principal',
        protocol: 'hepta-release-signer-probe-json-stdio-v1',
        executable: references['release-attestor-probe-command'].path,
        credentialRoot: references['release-attestor-probe-credential-root'].path,
        args: [],
        environmentAllowlist: [],
        timeoutMs: 5_000,
      },
      probeAttestor: {
        keyId: 'strict-release-probe-key',
        keyVersion: 'v3',
        subjectId: 'strict-release-probe-attestor',
        organization: 'Independent Strict Release Probe',
        role: RELEASE_PROBE_ROLE,
        algorithm: 'ed25519',
        status: 'active',
        effectiveFrom: '2026-07-20T00:00:00.000Z',
        expiresAt: '2026-07-22T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: probePublicKeyPath,
      },
    },
    hardwareAuthorityAttestation: null,
  };
  const configPath = references['release-attestor-config'].path;
  const writeConfig = () => {
    fs.chmodSync(configPath, 0o600);
    fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
    fs.chmodSync(configPath, 0o400);
  };
  const bundleFor = ({ backendDescriptorHash, trustSetHash, rotation }) => {
    const subject = buildResearchExecutionReleaseKmsHardwareAttestationSubject({
      kmsProvider: configuration.backend.kmsProvider,
      providerAccountIdentityHash: configuration.backend.providerAccountIdentityHash,
      keyResourceIdentityHash: configuration.backend.keyResourceIdentityHash,
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
      challengeHash,
      attestedAt: rotation === 1
        ? '2026-07-21T04:58:00.000Z' : '2026-07-21T05:00:00.000Z',
      expiresAt: rotation === 1
        ? '2026-07-21T05:05:00.000Z' : '2026-07-21T05:07:00.000Z',
    });
    const unsigned = buildPinnedExternalEvidenceEnvelope({
      subjectKind: subject.kind,
      subjectHash:
        subject.researchExecutionReleaseKmsHardwareAttestationSubjectHash,
      signedAt: subject.attestedAt,
      expiresAt: subject.expiresAt,
      signatures: [{
        keyId: 'strict-release-hardware-authority-key',
        role: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
        algorithm: 'ed25519',
        value: 'placeholder',
      }],
    });
    const value = crypto.sign(
      null,
      pinnedExternalEvidenceSigningPayload(unsigned),
      hardwareAuthority.privateKey,
    ).toString('base64');
    return buildResearchExecutionReleaseKmsHardwareAttestationBundle({
      subject,
      authorityEnvelope: buildPinnedExternalEvidenceEnvelope({
        ...unsigned,
        signatures: [{
          keyId: 'strict-release-hardware-authority-key',
          role: RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTOR_ROLE,
          algorithm: 'ed25519',
          value,
        }],
      }),
      trustStore: hardwareTrustStore,
      signerKeyIds: ['strict-release-hardware-authority-key'],
      maximumLifetimeMs: 10 * 60 * 1000,
    });
  };
  const writeBundle = (bundle) => {
    try { fs.chmodSync(bundlePath, 0o600); } catch {}
    fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(bundlePath, 0o444);
    if (configuration.hardwareAuthorityAttestation === null) {
      configuration.hardwareAuthorityAttestation = {
        bundlePath,
        trustStoreHash: bundle.trustStoreHash,
        signerKeyIds: ['strict-release-hardware-authority-key'],
        challengeHash,
      };
      writeConfig();
    }
  };
  const passiveRead = () => readProvisionedReleaseAttestorConfiguration({
    configPath,
    environment: {},
    spawnSyncImpl() {
      throw new Error('strict_release_fixture_external_action_forbidden');
    },
  });
  writeBundle(bundleFor({
    backendDescriptorHash:
      strictFullAutoAcceptanceHash({ release: 'placeholder-descriptor' }),
    trustSetHash: strictFullAutoAcceptanceHash({ release: 'placeholder-trust-set' }),
    rotation: 1,
  }));
  const provisional = passiveRead();
  assert.equal(provisional.blocker, null);
  writeBundle(bundleFor({
    backendDescriptorHash: provisional.configuration.backendPort.describeBackend()
      .researchExecutionReleaseSignerBackendDescriptorHash,
    trustSetHash: provisional.configuration.trustSetHash,
    rotation: 1,
  }));
  const initial = passiveRead();
  assert.equal(initial.blocker, null);
  const configurationIdentityHash = initial.configuration.configurationIdentityHash;
  return Object.freeze({
    configurationIdentityHash,
    bundlePath,
    rotate() {
      const current = passiveRead();
      assert.equal(current.blocker, null);
      writeBundle(bundleFor({
        backendDescriptorHash: current.configuration.backendPort.describeBackend()
          .researchExecutionReleaseSignerBackendDescriptorHash,
        trustSetHash: current.configuration.trustSetHash,
        rotation: 2,
      }));
      const rotated = passiveRead();
      assert.equal(rotated.blocker, null);
      assert.equal(rotated.configuration.configurationIdentityHash, configurationIdentityHash);
      return Object.freeze({
        bundleHash: sha256File(bundlePath),
        configurationFileHash: sha256File(configPath),
      });
    },
  });
}

function fixtureArgument(value) {
  return value
    .replace('sha256:REPLACE_WITH_CHILD_PLAN', `sha256:${'a'.repeat(64)}`)
    .replaceAll('REPLACE_WITH_GOLDEN_PAPER', 'fixture-golden-paper')
    .replaceAll('REPLACE', '1');
}

const ARGUMENT_REFERENCE_FLAGS = Object.freeze({
  'state-provisioning': Object.freeze({
    '--machine-intake-config': 'machine-intake-principal',
    '--topic-producer-profile': 'topic-producer-profile',
    '--authority-process-config': 'online-state-authority-process-config',
  }),
  'online-transition': Object.freeze({
    '--authority-process-config': 'online-state-authority-process-config',
  }),
  'runtime-reproducibility': Object.freeze({
    '--config': 'runtime-reproducibility-principal',
  }),
  'advanced-numeric-activation': Object.freeze({
    '--signing-config': 'empirical-plugin-signing-config',
  }),
  'external-qualifier': Object.freeze({
    '--external-qualification-config': 'external-qualifier-principal',
  }),
  'golden-qualification': Object.freeze({
    '--external-qualification-config': 'external-qualifier-principal',
  }),
  'restore-drill': Object.freeze({
    '--authority-config': 'backup-restore-authority-principal',
  }),
});

const CHILD_IDEMPOTENCY_FLAGS = Object.freeze({
  'state-provisioning': '--plan-id',
  'online-transition': '--transition-id',
  'submission-dispatcher': '--idempotency-key',
});

function bindFixtureArgumentReferences(stepId, invocation, references) {
  for (const [flag, referenceId] of Object.entries(ARGUMENT_REFERENCE_FLAGS[stepId] || {})) {
    const index = invocation.arguments.indexOf(flag);
    if (index >= 0) invocation.arguments[index + 1] = references[referenceId].path;
  }
  if (stepId === 'submission-dispatcher') {
    const descriptor = JSON.parse(fs.readFileSync(
      references['submission-portal-descriptor-config'].path,
      'utf8',
    ));
    const values = {
      '--portal-id': descriptor.portalId,
      '--portal-configuration-hash': descriptor.configurationHash,
      '--portal-descriptor-hash': autonomousSubmissionPortalPublicDescriptorHash(descriptor),
    };
    for (const [flag, value] of Object.entries(values)) {
      const index = invocation.arguments.indexOf(flag);
      if (index >= 0) invocation.arguments[index + 1] = value;
    }
  }
}

export function strictFullAutoAcceptanceFixture(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-strict-acceptance-'));
  t.after(() => {
    try { fs.chmodSync(path.join(root, 'assets'), 0o700); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtimeRoot = path.join(root, 'runtime');
  const controlRoot = path.join(root, 'control');
  const assetRoot = path.join(root, 'assets');
  const datasetRoot = path.join(root, 'datasets');
  const restoreBundle = path.join(root, 'restore-bundle');
  const referenceRoot = path.join(root, 'references');
  fs.mkdirSync(controlRoot, { mode: 0o700 });
  fs.mkdirSync(referenceRoot, { recursive: true });
  const ownerAcceptanceRoot = path.join(referenceRoot, 'capabilities-public');
  fs.mkdirSync(ownerAcceptanceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(assetRoot, { mode: 0o700 });
  fs.mkdirSync(datasetRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(restoreBundle, { recursive: true });
  const references = {};
  const authorIdentity = strictAuthorIdentityFixture();
  let subjectOrdinal = 0;
  for (const [referenceId, kind] of Object.entries(
    STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  )) {
    const candidate = referenceId === 'owner-trust-store'
      ? path.join(ownerAcceptanceRoot, 'OWNER_TRUST_STORE.json')
      : referenceId === 'owner-acceptance-document'
        ? path.join(ownerAcceptanceRoot, 'CAPABILITY_OWNER_ACCEPTANCE.json')
        : path.join(referenceRoot, `${referenceId}.ref`);
    subjectOrdinal += 1;
    const subjectId = kind.startsWith('opaque-')
      ? `secret-reference-${subjectOrdinal}` : `authority-${subjectOrdinal}`;
    const principalDocument = referenceId.endsWith('-principal');
    const pinnedDocument = [
      'formal-sandbox-runtime-config',
      'production-mathlib-build-authority-config',
      'autonomous-venue-profile-config',
      'autonomous-submission-metadata-config',
      'submission-portal-descriptor-config',
      'prior-art-service-config',
      'external-replay-config',
      'runtime-reproducibility-principal',
      'research-author-identity-config',
    ].includes(referenceId);
    const portalDocument = referenceId === 'submission-portal-descriptor-config';
    if (kind === 'opaque-directory-reference') {
      fs.mkdirSync(candidate, { mode: 0o700 });
    } else {
      fs.writeFileSync(candidate, kind === 'public-reference'
        ? referenceId === 'research-author-identity-config'
          ? `${JSON.stringify(authorIdentity.initial, null, 2)}\n`
          : pinnedDocument || principalDocument
          ? `${JSON.stringify({
            ...(pinnedDocument
              ? { configurationHash: strictFullAutoAcceptanceHash({ referenceId }) } : {}),
            ...(principalDocument ? { principalId: subjectId } : {}),
            ...(portalDocument ? {
              version: 1,
              kind: 'AutonomousSubmissionPortalPublicConfiguration',
              portalId: 'strict-acceptance-portal',
              serviceIdentityHash: strictFullAutoAcceptanceHash({ portal: 'service' }),
              portalAccountIdentityHash: strictFullAutoAcceptanceHash({ portal: 'account' }),
              portalTrustDomainIdentityHash: strictFullAutoAcceptanceHash({ portal: 'trust' }),
              tokenEnvironmentVariableNameHash: strictFullAutoAcceptanceHash({ portal: 'token' }),
            } : {}),
            ...(referenceId === 'prior-art-service-config'
              ? { tokenEnvironmentVariable: 'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE' } : {}),
            ...(referenceId === 'external-replay-config'
              ? { tokenEnvironmentVariable: 'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE' } : {}),
          })}\n`
          : `${referenceId}:public-authority\n`
        : kind === 'private-configuration-reference'
          ? '{}\n'
          : `${referenceId}:opaque\n`, { mode: 0o600 });
      fs.chmodSync(candidate, kind === 'public-reference' ? 0o444 : 0o400);
    }
    references[referenceId] = ['public-reference', 'private-configuration-reference'].includes(kind)
      ? {
        kind,
        path: candidate,
        subjectId,
        ...(SEMANTIC_CONFIGURATION_REFERENCES.has(referenceId)
          ? ['research-author-identity-config', 'runtime-reproducibility-principal']
            .includes(referenceId)
            ? {
              expectedConfigurationIdentityHash:
                JSON.parse(fs.readFileSync(candidate, 'utf8')).configurationHash,
            } : {}
          : { expectedSha256: sha256File(candidate) }),
      }
      : { kind, path: candidate, subjectId };
  }
  for (const referenceId of [
    'empirical-plugin-signer-command',
    'release-attestor-signer-command',
    'release-attestor-probe-command',
    'package-recovery-readiness-command',
  ]) {
    fs.chmodSync(references[referenceId].path, 0o555);
  }
  const writePrivateConfiguration = (referenceId, value) => {
    const reference = references[referenceId];
    fs.chmodSync(reference.path, 0o600);
    fs.writeFileSync(reference.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.chmodSync(reference.path, 0o400);
    if (!SEMANTIC_CONFIGURATION_REFERENCES.has(referenceId)) {
      reference.expectedSha256 = sha256File(reference.path);
    }
  };
  writePrivateConfiguration('empirical-plugin-signing-config', {
    version: 1,
    kind: 'AutonomousEmpiricalPluginSigningAuthorityConfiguration',
    trustStorePath: references['empirical-plugin-trust-store'].path,
    signer: {
      command: references['empirical-plugin-signer-command'].path,
      environmentAllowlist: [],
    },
  });
  const releaseAttestor = strictReleaseAttestorFixture({ referenceRoot, references });
  references['release-attestor-config'].expectedConfigurationIdentityHash =
    releaseAttestor.configurationIdentityHash;
  const steps = Object.fromEntries(STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.map((stepId) => {
    const source = structuredClone(EXAMPLE_CONFIGURATION.steps[stepId]);
    source.idempotencyKey = strictFullAutoAcceptanceHash({ stepId, fixture: true });
    source.execute.arguments = source.execute.arguments.map(fixtureArgument);
    source.verify.arguments = source.verify.arguments.map(fixtureArgument);
    bindFixtureArgumentReferences(stepId, source.execute, references);
    bindFixtureArgumentReferences(stepId, source.verify, references);
    const idempotencyFlag = CHILD_IDEMPOTENCY_FLAGS[stepId];
    if (idempotencyFlag) {
      for (const invocation of [source.execute, source.verify]) {
        const index = invocation.arguments.indexOf(idempotencyFlag);
        if (index >= 0) invocation.arguments[index + 1] = source.idempotencyKey;
      }
    }
    return [stepId, source];
  }));
  const stateArguments = steps['state-provisioning'].execute.arguments;
  stateArguments[stateArguments.indexOf('--dataset-root') + 1] = datasetRoot;
  steps['state-provisioning'].verify.assertions.find((assertion) => (
    assertion.path === '/plan/transitionId'
  )).equals = steps['online-transition'].idempotencyKey;
  const restoreArguments = steps['restore-drill'].execute.arguments;
  restoreArguments[restoreArguments.indexOf('--bundle') + 1] = restoreBundle;
  const operationalEnvironment = structuredClone(EXAMPLE_CONFIGURATION.operationalEnvironment);
  operationalEnvironment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT =
    path.join(root, 'runtime-reproducibility-receipt.json');
  operationalEnvironment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER =
    path.join(root, 'empirical-plugin-activation-pointer.json');
  operationalEnvironment.HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT = datasetRoot;
  for (const phase of ['execute', 'verify']) {
    const invocation = steps['runtime-reproducibility'][phase];
    invocation.arguments[invocation.arguments.indexOf('--receipt') + 1] =
      operationalEnvironment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT;
    const activation = steps['advanced-numeric-activation'][phase];
    activation.arguments[activation.arguments.indexOf('--activation') + 1] =
      operationalEnvironment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER;
  }
  const finalVerification = structuredClone(EXAMPLE_CONFIGURATION.finalVerification);
  for (const [referenceId, pathFlag, hashFlag] of [
    ['owner-trust-store', '--owner-trust-store', '--owner-trust-store-sha256'],
    [
      'owner-acceptance-document',
      '--owner-acceptance-document',
      '--owner-acceptance-document-sha256',
    ],
    [
      'package-recovery-readiness-command',
      '--package-recovery-readiness-command',
      '--package-recovery-readiness-command-sha256',
    ],
  ]) {
    const reference = references[referenceId];
    finalVerification.arguments[finalVerification.arguments.indexOf(pathFlag) + 1] =
      reference.path;
    finalVerification.arguments[finalVerification.arguments.indexOf(hashFlag) + 1] =
      reference.expectedSha256;
  }
  const configuration = {
    version: 1,
    kind: 'StrictFullAutoAcceptanceConfiguration',
    controlRoot,
    runtimeRoot,
    assetRoot,
    datasetRoot,
    runtimeRootAdoption: {
      version: 1,
      kind: 'StrictFullAutoAcceptanceRuntimeRootAdoptionPolicy',
      mode: 'fresh-runtime-only',
      expectedRuntimeRootIdentityHash: null,
      expectedPristineRuntimeStateHash: null,
      adoptionMutationPerformed: false,
      preResidentSchemaRebindRequired: false,
    },
    operationalEnvironment,
    references,
    steps,
    finalVerification,
  };
  mutate({
    root, controlRoot, runtimeRoot, assetRoot, datasetRoot, referenceRoot, configuration,
  });
  fs.chmodSync(assetRoot, 0o500);
  fs.chmodSync(datasetRoot, 0o500);
  fs.chmodSync(configuration.datasetRoot, 0o500);
  const configurationPath = path.join(root, 'acceptance-config.json');
  fs.writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o444 });
  return {
    root, controlRoot, runtimeRoot, assetRoot, datasetRoot, referenceRoot,
    configuration, configurationPath,
    rotateAuthorIdentity() {
      const reference = references['research-author-identity-config'];
      const rotated = authorIdentity.rotate();
      // v2 pins the complete attested subject/envelope/trust material.  A
      // short-lived attestation rotation therefore requires a new acceptance
      // configuration/plan; it may not silently reuse the old plan hash.
      assert.notEqual(rotated.configurationHash, reference.expectedConfigurationIdentityHash);
      fs.chmodSync(reference.path, 0o600);
      fs.writeFileSync(reference.path, `${JSON.stringify(rotated, null, 2)}\n`);
      fs.chmodSync(reference.path, 0o444);
      reference.expectedConfigurationIdentityHash = rotated.configurationHash;
      fs.chmodSync(configurationPath, 0o600);
      fs.writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`);
      fs.chmodSync(configurationPath, 0o444);
      return rotated;
    },
    rotateReleaseHardwareAuthority: releaseAttestor.rotate,
  };
}

export function strictFullAutoAcceptanceOrchestratorFor(
  configurationPath,
  runner,
  { pristineRuntimeInspector = null } = {},
) {
  return new StrictFullAutoAcceptanceOrchestrator({
    repository: new StrictFullAutoAcceptanceRepository({
      configurationPath,
      pristineRuntimeInspector,
      clock: { now: () => new Date(STRICT_FULL_AUTO_ACCEPTANCE_TEST_NOW) },
    }),
    commandRunner: strictFullAutoAcceptanceRuntimeActivatingRunner(runner),
    now: () => STRICT_FULL_AUTO_ACCEPTANCE_TEST_NOW,
  });
}

export function strictFullAutoAcceptanceSuccessfulOutput(invocation, extra = {}) {
  const output = { skippedCount: 0, ...extra };
  for (const assertion of invocation.assertions) {
    const segments = assertion.path.split('/').slice(1);
    let cursor = output;
    for (const segment of segments.slice(0, -1)) cursor = cursor[segment] ||= {};
    cursor[segments.at(-1)] = assertion.equals;
  }
  return Object.freeze(output);
}

export function strictFullAutoAcceptanceNotReadyOutput(invocation) {
  const output = structuredClone(strictFullAutoAcceptanceSuccessfulOutput(invocation));
  const [assertion] = invocation.assertions;
  const segments = assertion.path.split('/').slice(1);
  let cursor = output;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment];
  cursor[segments.at(-1)] = assertion.equals === true ? false : 'fixture-not-ready';
  return output;
}

export function strictFullAutoAcceptanceRuntimeActivatingRunner(runner) {
  return {
    async run(request) {
      const output = await runner.run(request);
      if (request.step.stepId === 'state-provisioning' && request.phase === 'execute') {
        fs.mkdirSync(request.plan.runtimeRoot, { recursive: true, mode: 0o700 });
      }
      return output;
    },
  };
}

export function strictFullAutoAcceptanceSuccessfulRunner(calls = []) {
  return strictFullAutoAcceptanceRuntimeActivatingRunner({
    async run({ step, phase, invocation }) {
      calls.push(`${step.stepId}:${phase}`);
      return strictFullAutoAcceptanceSuccessfulOutput(
        invocation,
        { stepId: step.stepId, phase },
      );
    },
  });
}

export async function strictFullAutoAcceptanceProductionRunnerBindingTest(t) {
  const value = strictFullAutoAcceptanceFixture(t);
  const plan = strictFullAutoAcceptanceOrchestratorFor(
    value.configurationPath,
    strictFullAutoAcceptanceSuccessfulRunner(),
  ).plan();
  const captured = [];
  const runner = new StrictFullAutoAcceptanceCommandRunner({
    workspaceRoot: path.resolve('.'),
    environment: { PATH: process.env.PATH, HEPTA_RAW_TOKEN: 'must-not-leak' },
    runProcess: async (request) => {
      captured.push(request);
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        stdout: JSON.stringify({ ready: true }),
      };
    },
  });
  const step = plan.steps.find((item) => item.stepId === 'state-provisioning');
  const invocation = step.execute;
  const controller = new AbortController();
  assert.deepEqual(await runner.run({
    plan, step, phase: 'execute', invocation, signal: controller.signal,
  }), { ready: true });
  assert.equal(captured[0].signal, controller.signal);
  assert.equal(captured[0].env.HEPTA_RAW_TOKEN, undefined);
  assert.equal(captured[0].env.HEPTA_RESEARCH_AUTHOR_CODEX_HOME,
    value.configuration.references['research-author-credential-root'].path);
  assert.equal(captured[0].env.HEPTA_FORMAL_REVIEW_CODEX_HOME,
    value.configuration.references['research-author-credential-root'].path);
  assert.equal(captured[0].env.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG, undefined);
  assert.equal(captured[0].env.HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG, undefined);
  assert.equal(captured[0].env.HEPTA_PAPER_RUNTIME_ROOT, plan.runtimeRoot);
  assert.equal(captured[0].env.HEPTA_PAPER_ASSET_ROOT, plan.assetRoot);
  assert.equal(captured[0].env.ELAN_HOME,
    plan.operationalEnvironment.HEPTA_FORMAL_ELAN_HOME);
  assert.equal(captured[0].env.HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH,
    plan.operationalEnvironment.HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH);
  assert.equal(captured[0].env.HOME, path.join(plan.controlRoot, 'restricted-child-home'));
  assert.equal(captured[0].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
    step.idempotencyKey);
  assert.equal(captured[0].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH, plan.planHash);
  assert.equal(captured[0].timeoutMs, (4 * 60 * 60 + 15 * 60) * 1000);
  await runner.run({
    plan, step, phase: 'verify', invocation: step.verify, signal: controller.signal,
  });
  assert.equal(captured[1].timeoutMs, 15 * 60 * 1000);
  assert.match(captured[1].args[0],
    /paper-core\/bin\/autonomous-research-online-schema-transition\.mjs$/);
  assert.deepEqual(captured[1].args.slice(1, 3), ['--action', 'plan']);
  await assert.rejects(runner.run({
    plan,
    step,
    phase: 'execute',
    invocation: { ...invocation, command: 'autonomous-submission-dispatcher' },
  }), /command_forbidden/);

  const productionStep = plan.steps.find((item) => (
    item.stepId === 'production-campaign-qualification'
  ));
  const productionRunnerPlan = Object.freeze({
    ...plan,
    operationalEnvironment: Object.freeze({
      ...plan.operationalEnvironment,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER: '',
    }),
  });
  assert.deepEqual(await runner.run({
    plan: productionRunnerPlan,
    step: productionStep,
    phase: 'execute',
    invocation: productionStep.execute,
    signal: controller.signal,
  }), { ready: true });
  assert.match(captured[2].args[0],
    /paper-core\/bin\/autonomous-research-supervisor\.mjs$/);
  assert.deepEqual(captured[2].args.slice(1), ['--request-resident-cycle']);
  assert.equal(captured[2].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
    productionStep.idempotencyKey);
  assert.equal(captured[2].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH,
    plan.planHash);

  const restoreStep = plan.steps.find((item) => item.stepId === 'restore-drill');
  const restoreVerificationPlan = Object.freeze({
    ...plan,
    operationalEnvironment: Object.freeze({
      ...plan.operationalEnvironment,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER: '',
    }),
  });
  assert.deepEqual(await runner.run({
    plan: restoreVerificationPlan,
    step: restoreStep,
    phase: 'verify',
    invocation: restoreStep.verify,
    signal: controller.signal,
  }), { ready: true });
  assert.match(captured[3].args[0], /paper-core\/bin\/automation-status\.mjs$/);
  const portalReference = plan.referenceBindings.find((item) => (
    item.referenceId === 'submission-portal-descriptor-config'
  ));
  assert.equal(captured[3].env.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG,
    portalReference.resolvedPath);
  assert.equal(captured[3].env.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH,
    portalReference.documentPins.configurationHash);
  assert.equal(captured[3].env.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH,
    portalReference.documentPins.portalDescriptorHash);
  const authorIdentityReference = plan.referenceBindings.find((item) => (
    item.referenceId === 'research-author-identity-config'
  ));
  assert.equal(captured[3].env.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG,
    authorIdentityReference.resolvedPath);
  assert.equal(captured[3].env.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH,
    authorIdentityReference.documentPins.configurationHash);
  const releaseAttestorReference = plan.referenceBindings.find((item) => (
    item.referenceId === 'release-attestor-config'
  ));
  assert.equal(
    releaseAttestorReference.documentPins.configurationHash,
    releaseAttestorReference.contentHash,
  );
  assert.notEqual(
    sha256File(releaseAttestorReference.resolvedPath),
    releaseAttestorReference.contentHash,
  );
  assert.equal(captured[3].env.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH,
    releaseAttestorReference.documentPins.configurationHash);

  const submissionStep = plan.steps.find((item) => item.stepId === 'submission-dispatcher');
  assert.deepEqual(await runner.run({
    plan: restoreVerificationPlan,
    step: submissionStep,
    phase: 'execute',
    invocation: submissionStep.execute,
    signal: controller.signal,
  }), { ready: true });
  assert.match(captured[4].args[0],
    /paper-core\/bin\/autonomous-submission-dispatcher-challenge\.mjs$/);
  assert.equal(captured[4].env.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG,
    portalReference.resolvedPath);
  assert.equal(captured[4].env.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH,
    portalReference.documentPins.configurationHash);
  assert.equal(captured[4].env.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH,
    portalReference.documentPins.portalDescriptorHash);
  const finalStep = Object.freeze({ stepId: 'final-aggregate-live-verification' });
  assert.deepEqual(await runner.run({
    plan: restoreVerificationPlan,
    step: finalStep,
    phase: 'verify',
    invocation: plan.finalVerification,
    signal: controller.signal,
  }), { ready: true });
  assert.match(captured[5].args[0],
    /paper-core\/bin\/full-production-readiness\.mjs$/);
  assert.deepEqual(captured[5].args.slice(1), plan.finalVerification.arguments);
  for (const [referenceId, pathFlag, hashFlag] of [
    ['owner-trust-store', '--owner-trust-store', '--owner-trust-store-sha256'],
    [
      'owner-acceptance-document',
      '--owner-acceptance-document',
      '--owner-acceptance-document-sha256',
    ],
    [
      'package-recovery-readiness-command',
      '--package-recovery-readiness-command',
      '--package-recovery-readiness-command-sha256',
    ],
  ]) {
    const reference = plan.referenceBindings.find((item) => (
      item.referenceId === referenceId
    ));
    assert.equal(captured[5].args[captured[5].args.indexOf(pathFlag) + 1],
      reference.resolvedPath);
    assert.equal(captured[5].args[captured[5].args.indexOf(hashFlag) + 1],
      reference.contentHash);
  }
}
