// Independent test-only evidence generated using the actual Node builders and verifier.
// Ephemeral keys never authorize a real platform or deployment.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildNestedRuntimePlatformProfile,
  inspectNestedRuntimePlatformQualificationSubject,
  inspectNestedRuntimeStartupConformanceSubject,
  NESTED_RUNTIME_PLATFORM_QUALIFIER_ROLE,
  NESTED_RUNTIME_STARTUP_CONFORMANCE_ROLE,
} from '../../paper-domain/automation/nested-runtime-platform-qualification-contract.mjs';
import {
  buildNestedRuntimeAuthorityIndependenceSubject,
  inspectNestedRuntimeAuthorityIndependenceSubject,
  NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE,
} from '../../paper-domain/automation/nested-runtime-authority-independence-contract.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  verifyNestedRuntimePlatformQualification,
} from '../../paper-adapters/automation/nested-runtime-platform-qualification-verifier.mjs';
import {
  immutableAuthoritySigningPayload,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const NOW = new Date(input.now || '2026-07-24T08:00:00.000Z');
const at = (value) => new Date(NOW.getTime() + Date.parse(value)
  - Date.parse('2026-07-24T08:00:00.000Z')).toISOString();
const POD_UID = '89b0476e-1ae6-4ce1-8a20-98f13a223c1c';
const PLAN_HASH = `sha256:${'1'.repeat(64)}`;
const PROFILE_ID = 'nested-runtime-production-v1';
const RUNTIME_CLASS = 'hepta-nested-production';
const CPU_MILLIS = 4000;
const MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
const PIDS = 512;
let fixtureGpuDeclared = false;

function keyFixture(keyId, subjectId, role) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return Object.freeze({
    privateKey,
    trustKey: Object.freeze({
      keyId,
      subjectId,
      organization: `${subjectId}-organization`,
      algorithm: 'ed25519',
      publicKeyPem,
      roles: Object.freeze([role]),
      status: 'active',
    }),
    publicKeySpkiHash: hashBytes(publicKey.export({ type: 'spki', format: 'der' })),
  });
}

function signedEnvelope({ inspection, signer, role, issuedAt, expiresAt }) {
  const unsigned = buildPinnedExternalEvidenceEnvelope({
    subjectKind: inspection.canonical.kind,
    subjectHash: inspection.subjectHash,
    signedAt: issuedAt,
    expiresAt,
    signatures: [{
      algorithm: 'ed25519',
      keyId: signer.trustKey.keyId,
      role,
      value: Buffer.alloc(64).toString('base64'),
    }],
  });
  const value = crypto.sign(
    null,
    immutableAuthoritySigningPayload(unsigned),
    signer.privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...unsigned,
    signatures: [{
      algorithm: 'ed25519',
      keyId: signer.trustKey.keyId,
      role,
      value,
    }],
  });
}

function principalIdentity({
  label,
  principalId,
  signerPublicKeySpkiHash,
  challengeHash,
  overrides = {},
}) {
  return buildExternalPrincipalIdentityAttestationSubject({
    serviceId: `${label}-service`,
    principalId,
    provider: `${label}-provider`,
    providerAccountIdentityHash: hashRecord('FixtureProviderAccount', { label }),
    credentialRootIdentityHash: hashRecord('FixtureCredentialRoot', { label }),
    hostIdentityHash: hashRecord('FixtureHost', { label }),
    processIdentityHash: hashRecord('FixtureProcess', { label }),
    trustDomainIdentityHash: hashRecord('FixtureTrustDomain', { label }),
    signerPublicKeySpkiHash,
    challengeHash,
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: at('2026-07-24T07:59:30.000Z'),
    expiresAt: at('2026-07-24T08:09:55.000Z'),
    ...overrides,
  });
}

function profile() {
  return buildNestedRuntimePlatformProfile({
    platform: {
      os: 'linux',
      architecture: 'amd64',
      cri: {
        name: 'containerd',
        version: '1.7.20',
        endpointIdentityHash: `sha256:${'2'.repeat(64)}`,
      },
      runtimeClass: { name: RUNTIME_CLASS, handler: 'hepta-nested-handler' },
      runtime: {
        name: 'sysbox-runc',
        version: '0.6.6',
        configurationHash: `sha256:${'3'.repeat(64)}`,
      },
      kernel: {
        release: '6.8.0-hepta',
        securityPolicyHash: `sha256:${'4'.repeat(64)}`,
      },
      nodeImage: {
        id: 'hepta-node-image-v1',
        contentHash: `sha256:${'5'.repeat(64)}`,
      },
      cgroup: {
        mode: 'v2',
        driver: 'systemd',
        delegationPolicyHash: `sha256:${'6'.repeat(64)}`,
      },
      security: {
        seccompProfile: 'runtime/default',
        appArmorProfile: 'hepta-nested',
        selinuxType: 'container_t',
        userNamespaceMode: 'pod-isolated',
        privileged: false,
        allowPrivilegeEscalation: false,
      },
      gpu: fixtureGpuDeclared ? { declared: true, driverVersion: '535.104', devicePluginId: 'nvidia-device-plugin', toolkitVersion: '12.2.0' } : {
        declared: false,
        driverVersion: null,
        devicePluginId: null,
        toolkitVersion: null,
      },
    },
    fixedDigestWorkerImage: `registry.example/hepta-worker@sha256:${'7'.repeat(64)}`,
    sharedScratchRoot: '/tmp/hepta-conformance',
    workerIdentity: { uid: 10001, gid: 10001 },
    parentPodResourceCeiling: {
      cpuMillis: CPU_MILLIS,
      memoryBytes: MEMORY_BYTES,
      pids: PIDS,
    },
  });
}

function qualificationSubject() {
  const selectedProfile = profile();
  return {
    version: 1,
    kind: 'NestedRuntimePlatformQualification',
    contractVersion: 'hepta-nested-container-runtime-v1',
    profileId: PROFILE_ID,
    profile: selectedProfile,
    profileHash: hashRecord('NestedRuntimePlatformProfile', selectedProfile),
    issuedAt: at('2026-07-24T07:00:00.000Z'),
    validFrom: at('2026-07-24T07:00:00.000Z'),
    expiresAt: at('2026-07-25T07:00:00.000Z'),
  };
}

function conformanceSubject(qualification) {
  return {
    version: 1,
    kind: 'NestedRuntimeStartupConformance',
    contractVersion: 'hepta-nested-container-runtime-v1',
    profileId: PROFILE_ID,
    profileHash: qualification.profileHash,
    qualificationSubjectHash: qualification.subjectHash,
    podUid: POD_UID,
    planHash: PLAN_HASH,
    observedAt: at('2026-07-24T07:59:50.000Z'),
    proofs: {
      fixedDigestWorker: {
        image: qualification.canonical.profile.fixedDigestWorkerImage,
        launched: true,
      },
      bindReadWrite: {
        sourcePath: '/tmp/hepta-conformance/source/challenge',
        resultPath: '/tmp/hepta-conformance/result/response',
        writable: true,
        readBackHash: `sha256:${'8'.repeat(64)}`,
        resultUid: 10001,
        resultGid: 10001,
        resultPathWithinSharedScratch: true,
      },
      network: { mode: 'none', outboundBlocked: true, dnsBlocked: true },
      resources: {
        memoryBytes: 1024 * 1024 * 1024,
        cpuMillis: 1000,
        pids: 64,
        memoryLimitEnforced: true,
        cpuLimitEnforced: true,
        pidsLimitEnforced: true,
        parentPodMemoryBytes: MEMORY_BYTES,
        parentPodCpuMillis: CPU_MILLIS,
        parentPodPids: PIDS,
        parentPodCeilingEnforced: true,
      },
      gpu: fixtureGpuDeclared ? { declared: true, deviceCount: 1, driverVersion: '535.104', devicePluginId: 'nvidia-device-plugin', toolkitVersion: '12.2.0' } : {
        declared: false,
        deviceCount: 0,
        driverVersion: null,
        devicePluginId: null,
        toolkitVersion: null,
      },
    },
    issuedAt: at('2026-07-24T07:59:55.000Z'),
    validFrom: at('2026-07-24T07:59:55.000Z'),
    expiresAt: at('2026-07-24T08:09:55.000Z'),
  };
}

function writeJson(root, name, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes, { mode: 0o644 });
  return Object.freeze({ file, contentHash: hashBytes(bytes) });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-nested-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const qualifier = keyFixture(
    'platform-qualifier-key-v1',
    'independent-platform-qualifier',
    NESTED_RUNTIME_PLATFORM_QUALIFIER_ROLE,
  );
  const conformanceAttestor = keyFixture(
    'conformance-attestor-key-v1',
    'independent-conformance-attestor',
    NESTED_RUNTIME_STARTUP_CONFORMANCE_ROLE,
  );
  const independenceAttestor = keyFixture(
    'authority-independence-attestor-key-v1',
    'independent-authority-independence-attestor',
    NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE,
  );
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [
      qualifier.trustKey,
      conformanceAttestor.trustKey,
      independenceAttestor.trustKey,
    ],
  };
  const trustInspection = inspectPinnedExternalEvidenceTrustStore(trustStore);
  assert.equal(trustInspection.ready, true);
  const trust = writeJson(root, 'trust-store.json', trustStore);
  const qualification = inspectNestedRuntimePlatformQualificationSubject(
    qualificationSubject(),
    { now: NOW, maximumLifetimeMs: 30 * 24 * 60 * 60 * 1000 },
  );
  assert.equal(qualification.ready, true);
  const qualificationBundle = writeJson(root, 'qualification.json', {
    version: 1,
    kind: 'NestedRuntimePlatformQualificationBundle',
    subject: qualification.canonical,
    envelope: signedEnvelope({
      inspection: qualification,
      signer: qualifier,
      role: NESTED_RUNTIME_PLATFORM_QUALIFIER_ROLE,
      issuedAt: qualification.canonical.issuedAt,
      expiresAt: qualification.canonical.expiresAt,
    }),
  });
  const conformance = inspectNestedRuntimeStartupConformanceSubject(
    conformanceSubject(qualification),
    {
      qualification,
      expectedPodUid: POD_UID,
      expectedPlanHash: PLAN_HASH,
      expectedProfileId: PROFILE_ID,
      expectedRuntimeClassName: RUNTIME_CLASS,
      now: NOW,
      maximumLifetimeMs: 15 * 60 * 1000,
      maximumObservationAgeMs: 10 * 60 * 1000,
    },
  );
  assert.equal(conformance.ready, true);
  const conformanceBundle = writeJson(root, 'conformance.json', {
    version: 1,
    kind: 'NestedRuntimeStartupConformanceBundle',
    subject: conformance.canonical,
    envelope: signedEnvelope({
      inspection: conformance,
      signer: conformanceAttestor,
      role: NESTED_RUNTIME_STARTUP_CONFORMANCE_ROLE,
      issuedAt: conformance.canonical.issuedAt,
      expiresAt: conformance.canonical.expiresAt,
    }),
  });
  const qualificationPrincipalIdentity = principalIdentity({
    label: 'platform-qualification',
    principalId: qualifier.trustKey.subjectId,
    signerPublicKeySpkiHash: qualifier.publicKeySpkiHash,
    challengeHash: qualification.subjectHash,
  });
  const conformancePrincipalIdentity = principalIdentity({
    label: 'startup-conformance',
    principalId: conformanceAttestor.trustKey.subjectId,
    signerPublicKeySpkiHash: conformanceAttestor.publicKeySpkiHash,
    challengeHash: conformance.subjectHash,
  });
  const deploymentOperatorPrincipalIdentity = principalIdentity({
    label: 'deployment-operator',
    principalId: 'independent-deployment-operator',
    signerPublicKeySpkiHash: hashRecord('FixtureDeploymentOperatorKey', {
      principalId: 'independent-deployment-operator',
    }),
    challengeHash: PLAN_HASH,
  });
  const controlDomainOrganizations = {
    qualification: qualifier.trustKey.organization,
    conformance: conformanceAttestor.trustKey.organization,
    deploymentOperator: 'independent-deployment-operator-organization',
  };
  const authorityIndependenceSubject = buildNestedRuntimeAuthorityIndependenceSubject({
    version: 1,
    kind: 'NestedRuntimeAuthorityIndependenceAttestation',
    contractVersion: 'hepta-nested-container-runtime-v1',
    profileId: PROFILE_ID,
    qualificationSubjectHash: qualification.subjectHash,
    conformanceSubjectHash: conformance.subjectHash,
    podUid: POD_UID,
    planHash: PLAN_HASH,
    qualificationPrincipalIdentity,
    conformancePrincipalIdentity,
    deploymentOperatorPrincipalIdentity,
    controlDomainOrganizations,
    issuedAt: at('2026-07-24T07:59:40.000Z'),
    validFrom: at('2026-07-24T07:59:40.000Z'),
    expiresAt: at('2026-07-24T08:09:50.000Z'),
  });
  const authorityIndependence = inspectNestedRuntimeAuthorityIndependenceSubject(
    authorityIndependenceSubject,
    {
      expectedProfileId: PROFILE_ID,
      expectedQualificationSubjectHash: qualification.subjectHash,
      expectedConformanceSubjectHash: conformance.subjectHash,
      expectedPodUid: POD_UID,
      expectedPlanHash: PLAN_HASH,
      expectedQualificationPrincipalId: qualifier.trustKey.subjectId,
      expectedQualificationSignerSpkiHash: qualifier.publicKeySpkiHash,
      expectedQualificationOrganization: qualifier.trustKey.organization,
      expectedConformancePrincipalId: conformanceAttestor.trustKey.subjectId,
      expectedConformanceSignerSpkiHash: conformanceAttestor.publicKeySpkiHash,
      expectedConformanceOrganization: conformanceAttestor.trustKey.organization,
      expectedDeploymentOperator: {
        principalId: deploymentOperatorPrincipalIdentity.principalId,
        provider: deploymentOperatorPrincipalIdentity.provider,
        organization: controlDomainOrganizations.deploymentOperator,
        trustDomainIdentityHash:
          deploymentOperatorPrincipalIdentity.trustDomainIdentityHash,
        identitySubjectHash:
          deploymentOperatorPrincipalIdentity
            .externalPrincipalIdentityAttestationSubjectHash,
      },
      now: NOW,
      maximumLifetimeMs: 15 * 60 * 1000,
    },
  );
  assert.equal(authorityIndependence.ready, true);
  const authorityIndependenceBundle = writeJson(root, 'authority-independence.json', {
    version: 1,
    kind: 'NestedRuntimeAuthorityIndependenceBundle',
    subject: authorityIndependence.canonical,
    envelope: signedEnvelope({
      inspection: authorityIndependence,
      signer: independenceAttestor,
      role: NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE,
      issuedAt: authorityIndependence.canonical.issuedAt,
      expiresAt: authorityIndependence.canonical.expiresAt,
    }),
  });
  const configValue = {
    version: 2,
    kind: 'NestedRuntimePlatformQualificationConfiguration',
    qualificationBundlePath: qualificationBundle.file,
    conformanceBundlePath: conformanceBundle.file,
    authorityIndependenceBundlePath: authorityIndependenceBundle.file,
    trustStorePath: trust.file,
    expectedTrustStoreContentHash: trust.contentHash,
    expectedTrustStoreHash: trustInspection.trustStoreHash,
    qualificationMaximumLifetimeMs: 30 * 24 * 60 * 60 * 1000,
    conformanceMaximumLifetimeMs: 15 * 60 * 1000,
    conformanceMaximumObservationAgeMs: 10 * 60 * 1000,
    authorityIndependenceMaximumLifetimeMs: 15 * 60 * 1000,
    qualificationAuthority: {
      keyIds: [qualifier.trustKey.keyId],
      subjectIds: [qualifier.trustKey.subjectId],
      organizations: [qualifier.trustKey.organization],
      publicKeySpkiHashes: [qualifier.publicKeySpkiHash],
    },
    conformanceAuthority: {
      keyIds: [conformanceAttestor.trustKey.keyId],
      subjectIds: [conformanceAttestor.trustKey.subjectId],
      organizations: [conformanceAttestor.trustKey.organization],
      publicKeySpkiHashes: [conformanceAttestor.publicKeySpkiHash],
    },
    authorityIndependenceAuthority: {
      keyIds: [independenceAttestor.trustKey.keyId],
      subjectIds: [independenceAttestor.trustKey.subjectId],
      organizations: [independenceAttestor.trustKey.organization],
      publicKeySpkiHashes: [independenceAttestor.publicKeySpkiHash],
    },
    deploymentOperator: {
      principalId: deploymentOperatorPrincipalIdentity.principalId,
      provider: deploymentOperatorPrincipalIdentity.provider,
      organization: controlDomainOrganizations.deploymentOperator,
      trustDomainIdentityHash:
        deploymentOperatorPrincipalIdentity.trustDomainIdentityHash,
      identitySubjectHash:
        deploymentOperatorPrincipalIdentity.externalPrincipalIdentityAttestationSubjectHash,
    },
  };
  const config = writeJson(root, 'config.json', configValue);
  return {
    root,
    config,
    configValue,
    qualificationBundle,
    conformanceBundle,
    authorityIndependenceBundle,
    authorityIndependence,
    authorityIndependenceSubject,
    signers: { qualifier, conformanceAttestor, independenceAttestor },
    options: {
      configPath: config.file,
      expectedConfigContentHash: config.contentHash,
      expectedQualificationBundleContentHash: qualificationBundle.contentHash,
      expectedConformanceBundleContentHash: conformanceBundle.contentHash,
      expectedAuthorityIndependenceBundleContentHash:
        authorityIndependenceBundle.contentHash,
      podUid: POD_UID,
      planHash: PLAN_HASH,
      profileId: PROFILE_ID,
      runtimeClassName: RUNTIME_CLASS,
      parentPodCpuMillis: CPU_MILLIS,
      parentPodMemoryBytes: MEMORY_BYTES,
      parentPodPids: PIDS,
      qualificationKeyId: qualifier.trustKey.keyId,
      qualificationSubjectId: qualifier.trustKey.subjectId,
      qualificationPublicKeySpkiHash: qualifier.publicKeySpkiHash,
      conformanceKeyId: conformanceAttestor.trustKey.keyId,
      conformanceSubjectId: conformanceAttestor.trustKey.subjectId,
      conformancePublicKeySpkiHash: conformanceAttestor.publicKeySpkiHash,
      now: NOW,
    },
  };
}


if (input.operation === 'verify') {
  process.stdout.write(JSON.stringify(input.requests.map((request) => {
    try { return { ok: true, value: verifyNestedRuntimePlatformQualification(request) }; }
    catch (error) { return { ok: false, error: error.message }; }
  })));
} else if (input.operation === 'fixture') {
  fixtureGpuDeclared = input.scenario === 'gpu';
  const setup = fixture({ after() {} });
  function rewriteConfig() {
    setup.config = writeJson(setup.root, 'config.json', setup.configValue);
    setup.options.configPath = setup.config.file;
    setup.options.expectedConfigContentHash = setup.config.contentHash;
  }
  const scenario = input.scenario || 'valid';
  if (scenario === 'signature') {
    const bundle = JSON.parse(fs.readFileSync(setup.conformanceBundle.file, 'utf8'));
    bundle.envelope.signatures[0].value = Buffer.alloc(64, 1).toString('base64');
    setup.options.expectedConformanceBundleContentHash = writeJson(setup.root, 'conformance.json', bundle).contentHash;
  } else if (scenario === 'revoked-key' || scenario === 'wrong-role') {
    const trustValue = JSON.parse(fs.readFileSync(setup.configValue.trustStorePath, 'utf8'));
    if (scenario === 'revoked-key') trustValue.keys[1].revokedAt = at('2026-07-24T07:59:54.000Z');
    else trustValue.keys[1].roles = ['unrelated-role'];
    const trust = writeJson(setup.root, 'trust-store.json', trustValue);
    setup.configValue.expectedTrustStoreContentHash = trust.contentHash;
    setup.configValue.expectedTrustStoreHash = inspectPinnedExternalEvidenceTrustStore(trustValue).trustStoreHash;
    rewriteConfig();
  } else if (scenario === 'same-organization') {
    setup.configValue.conformanceAuthority.organizations = [setup.configValue.qualificationAuthority.organizations[0].toUpperCase()];
    rewriteConfig();
  } else if (scenario === 'shared-control-domain') {
    const qualificationIdentity = setup.authorityIndependenceSubject.qualificationPrincipalIdentity;
    const original = setup.authorityIndependenceSubject.conformancePrincipalIdentity;
    const coordinated = principalIdentity({
      label: 'coordinated-conformance', principalId: original.principalId,
      signerPublicKeySpkiHash: original.signerPublicKeySpkiHash, challengeHash: original.challengeHash,
      overrides: Object.fromEntries(['provider','providerAccountIdentityHash','credentialRootIdentityHash','hostIdentityHash','processIdentityHash','trustDomainIdentityHash'].map((key) => [key, qualificationIdentity[key]])),
    });
    const subject = { ...setup.authorityIndependenceSubject, conformancePrincipalIdentity: coordinated };
    const inspection = { canonical: subject, subjectHash: hashRecord('NestedRuntimeAuthorityIndependenceAttestation', subject) };
    const bundle = writeJson(setup.root, 'authority-independence.json', {
      version: 1, kind: 'NestedRuntimeAuthorityIndependenceBundle', subject,
      envelope: signedEnvelope({ inspection, signer: setup.signers.independenceAttestor,
        role: NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE,
        issuedAt: subject.issuedAt, expiresAt: subject.expiresAt }),
    });
    setup.options.expectedAuthorityIndependenceBundleContentHash = bundle.contentHash;
  } else if (scenario === 'unknown-field') {
    setup.configValue.unexpected = true; rewriteConfig();
  } else if (scenario === 'signed-invalid-proof') {
    const bundle = JSON.parse(fs.readFileSync(setup.conformanceBundle.file, 'utf8'));
    bundle.subject.proofs.resources.memoryBytes = MEMORY_BYTES + 1;
    const inspection = { canonical: bundle.subject, subjectHash: hashRecord('NestedRuntimeStartupConformance', bundle.subject) };
    bundle.envelope = signedEnvelope({ inspection, signer: setup.signers.conformanceAttestor, role: NESTED_RUNTIME_STARTUP_CONFORMANCE_ROLE, issuedAt: bundle.subject.issuedAt, expiresAt: bundle.subject.expiresAt });
    setup.options.expectedConformanceBundleContentHash = writeJson(setup.root, 'conformance.json', bundle).contentHash;
  } else if (scenario !== 'valid' && scenario !== 'gpu') throw new Error('unknown fixture scenario');
  process.stdout.write(JSON.stringify({ root: setup.root, request: setup.options,
    expected: verifyNestedRuntimePlatformQualification(setup.options) }));
} else throw new Error('unknown oracle operation');
