import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

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

const NOW = new Date('2026-07-24T08:00:00.000Z');
const POD_UID = '89b0476e-1ae6-4ce1-8a20-98f13a223c1c';
const PLAN_HASH = `sha256:${'1'.repeat(64)}`;
const PROFILE_ID = 'nested-runtime-production-v1';
const RUNTIME_CLASS = 'hepta-nested-production';
const CPU_MILLIS = 4000;
const MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
const PIDS = 512;

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
    attestedAt: '2026-07-24T07:59:30.000Z',
    expiresAt: '2026-07-24T08:09:55.000Z',
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
      gpu: {
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
    issuedAt: '2026-07-24T07:00:00.000Z',
    validFrom: '2026-07-24T07:00:00.000Z',
    expiresAt: '2026-07-25T07:00:00.000Z',
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
    observedAt: '2026-07-24T07:59:50.000Z',
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
      gpu: {
        declared: false,
        deviceCount: 0,
        driverVersion: null,
        devicePluginId: null,
        toolkitVersion: null,
      },
    },
    issuedAt: '2026-07-24T07:59:55.000Z',
    validFrom: '2026-07-24T07:59:55.000Z',
    expiresAt: '2026-07-24T08:09:55.000Z',
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
    issuedAt: '2026-07-24T07:59:40.000Z',
    validFrom: '2026-07-24T07:59:40.000Z',
    expiresAt: '2026-07-24T08:09:50.000Z',
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

test('independent platform and current-Pod conformance receipts pass the read-only gate', (t) => {
  const setup = fixture(t);
  const report = verifyNestedRuntimePlatformQualification(setup.options);
  assert.equal(report.status, 'nested_runtime_platform_qualification_verified');
  assert.equal(report.ready, true);
  assert.equal(report.authorityIndependenceReady, true);
  assert.equal(report.podUid, POD_UID);
  assert.equal(report.planHash, PLAN_HASH);
  assert.notDeepEqual(
    report.qualificationVerifiedSubjectIds,
    report.conformanceVerifiedSubjectIds,
  );
  assert.notEqual(
    report.qualificationAuthorityOrganization,
    report.conformanceAuthorityOrganization,
  );
  assert.equal(
    report.deploymentOperatorPrincipalId,
    'independent-deployment-operator',
  );
});

test('current Pod, plan, ceiling and exact receipt bytes are non-replayable bindings', (t) => {
  const setup = fixture(t);
  const wrongPod = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    podUid: 'c94bd80d-f812-43f8-8988-d535a1417f2c',
  });
  assert.ok(wrongPod.blockers.includes(
    'nested_runtime_startup_conformance_pod_uid_mismatch',
  ));
  const wrongPlan = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    planHash: `sha256:${'9'.repeat(64)}`,
  });
  assert.ok(wrongPlan.blockers.includes(
    'nested_runtime_startup_conformance_plan_hash_mismatch',
  ));
  const wrongCeiling = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    parentPodPids: PIDS + 1,
  });
  assert.ok(wrongCeiling.blockers.includes(
    'nested_runtime_platform_parent_pod_ceiling_mismatch',
  ));
  const wrongBytes = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    expectedConformanceBundleContentHash: `sha256:${'0'.repeat(64)}`,
  });
  assert.deepEqual(wrongBytes.blockers, [
    'nested_runtime_platform_bundle_content_hash_mismatch',
  ]);
  const wrongAuthority = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    qualificationKeyId: 'coordinated-replacement-key',
  });
  assert.deepEqual(wrongAuthority.blockers, [
    'nested_runtime_platform_deployment_authority_binding_mismatch',
  ]);
});

test('same signer authority for qualification and conformance is rejected before verification', (t) => {
  const setup = fixture(t);
  const invalid = {
    ...setup.configValue,
    conformanceAuthority: setup.configValue.qualificationAuthority,
  };
  const config = writeJson(setup.root, 'same-authority.json', invalid);
  const report = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    configPath: config.file,
    expectedConfigContentHash: config.contentHash,
  });
  assert.deepEqual(report.blockers, [
    'nested_runtime_platform_authorities_not_independent',
  ]);
});

test('distinct keys controlled by one normalized organization are not independent', (t) => {
  const setup = fixture(t);
  const invalid = structuredClone(setup.configValue);
  invalid.conformanceAuthority.organizations = [
    setup.configValue.qualificationAuthority.organizations[0].toUpperCase(),
  ];
  const config = writeJson(setup.root, 'shared-organization.json', invalid);
  const report = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    configPath: config.file,
    expectedConfigContentHash: config.contentHash,
  });
  assert.deepEqual(report.blockers, [
    'nested_runtime_platform_authority_organizations_not_independent',
  ]);
});

test('trust-store organization must match the content-pinned authority binding', (t) => {
  const setup = fixture(t);
  const invalid = structuredClone(setup.configValue);
  invalid.qualificationAuthority.organizations = ['unrelated-claimed-organization'];
  const config = writeJson(setup.root, 'wrong-trust-organization.json', invalid);
  const report = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    configPath: config.file,
    expectedConfigContentHash: config.contentHash,
  });
  assert.deepEqual(report.blockers, [
    'nested_runtime_platform_trust_key_authority_binding_mismatch',
  ]);
});

test('externally signed dual-key identities in one provider control domain are rejected', (t) => {
  const setup = fixture(t);
  const qualificationIdentity =
    setup.authorityIndependenceSubject.qualificationPrincipalIdentity;
  const originalConformanceIdentity =
    setup.authorityIndependenceSubject.conformancePrincipalIdentity;
  const coordinatedConformanceIdentity = principalIdentity({
    label: 'coordinated-conformance',
    principalId: originalConformanceIdentity.principalId,
    signerPublicKeySpkiHash: originalConformanceIdentity.signerPublicKeySpkiHash,
    challengeHash: originalConformanceIdentity.challengeHash,
    overrides: {
      provider: qualificationIdentity.provider,
      providerAccountIdentityHash: qualificationIdentity.providerAccountIdentityHash,
      credentialRootIdentityHash: qualificationIdentity.credentialRootIdentityHash,
      hostIdentityHash: qualificationIdentity.hostIdentityHash,
      processIdentityHash: qualificationIdentity.processIdentityHash,
      trustDomainIdentityHash: qualificationIdentity.trustDomainIdentityHash,
    },
  });
  const subject = {
    ...setup.authorityIndependenceSubject,
    conformancePrincipalIdentity: coordinatedConformanceIdentity,
  };
  const inspection = {
    canonical: subject,
    subjectHash: hashRecord('NestedRuntimeAuthorityIndependenceAttestation', subject),
  };
  const bundle = writeJson(setup.root, 'coordinated-independence.json', {
    version: 1,
    kind: 'NestedRuntimeAuthorityIndependenceBundle',
    subject,
    envelope: signedEnvelope({
      inspection,
      signer: setup.signers.independenceAttestor,
      role: NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE,
      issuedAt: subject.issuedAt,
      expiresAt: subject.expiresAt,
    }),
  });
  const config = writeJson(setup.root, 'coordinated-independence-config.json', {
    ...setup.configValue,
    authorityIndependenceBundlePath: bundle.file,
  });
  const report = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    configPath: config.file,
    expectedConfigContentHash: config.contentHash,
    expectedAuthorityIndependenceBundleContentHash: bundle.contentHash,
  });
  assert.ok(report.blockers.includes(
    'nested_runtime_authority_control_domain_independence_invalid',
  ), JSON.stringify(report.blockers));
  assert.equal(report.externallyQualified, false);
});

test('deployment operator must be outside every evidence and attestor organization', (t) => {
  const setup = fixture(t);
  const invalid = structuredClone(setup.configValue);
  invalid.deploymentOperator.organization =
    setup.configValue.qualificationAuthority.organizations[0];
  const config = writeJson(setup.root, 'shared-deployment-operator.json', invalid);
  const report = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    configPath: config.file,
    expectedConfigContentHash: config.contentHash,
  });
  assert.deepEqual(report.blockers, [
    'nested_runtime_deployment_operator_control_domain_not_independent',
  ]);
});

test('missing externally signed authority-independence bytes fail closed', (t) => {
  const setup = fixture(t);
  const report = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    expectedAuthorityIndependenceBundleContentHash: null,
  });
  assert.deepEqual(report.blockers, [
    'nested_runtime_platform_bundle_content_hash_missing',
  ]);
});

test('a content-pinned but cryptographically invalid conformance receipt stays blocked', (t) => {
  const setup = fixture(t);
  const tamperedValue = JSON.parse(fs.readFileSync(
    setup.conformanceBundle.file,
    'utf8',
  ));
  tamperedValue.envelope.signatures[0].value = Buffer.alloc(64, 1).toString('base64');
  const tampered = writeJson(setup.root, 'tampered-conformance.json', tamperedValue);
  const config = writeJson(setup.root, 'tampered-config.json', {
    ...setup.configValue,
    conformanceBundlePath: tampered.file,
  });
  const report = verifyNestedRuntimePlatformQualification({
    ...setup.options,
    configPath: config.file,
    expectedConfigContentHash: config.contentHash,
    expectedConformanceBundleContentHash: tampered.contentHash,
  });
  assert.ok(
    report.blockers.includes('immutable_signed_json_authority_signature_invalid'),
    JSON.stringify(report.blockers),
  );
});

test('conformance stays inside the qualification window and signed paths are canonical', () => {
  assert.throws(() => buildNestedRuntimePlatformProfile({
    ...profile(),
    sharedScratchRoot: '/tmp/hepta\nescape',
  }), /nested_runtime_platform_execution_profile_invalid/);

  const shortened = qualificationSubject();
  shortened.expiresAt = '2026-07-24T08:05:00.000Z';
  const qualification = inspectNestedRuntimePlatformQualificationSubject(shortened, {
    now: NOW,
    maximumLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  });
  assert.equal(qualification.ready, true);
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
  assert.ok(conformance.blockers.includes(
    'nested_runtime_startup_conformance_outside_qualification_window',
  ));
});

test('canonical Kubernetes deployment runs the verifier gate and retains hard-fail placeholders', () => {
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const manifest = fs.readFileSync(path.join(
    repositoryRoot,
    'paper-core/deploy/autonomous-research-supervisor.k8s.yaml',
  ), 'utf8');
  assert.match(manifest, /name: nested-runtime-platform-qualification-gate/);
  assert.match(manifest, /paper-core\/bin\/nested-runtime-platform-qualification\.mjs/);
  assert.match(manifest, /fieldPath: metadata\.uid/);
  assert.match(manifest, /nested-runtime-conformance-receipt-sha256/);
  assert.match(manifest, /nested-runtime-authority-independence-receipt-sha256/);
  assert.match(manifest, /nested-runtime-parent-pod-pids/);
  assert.match(manifest, /HEPTA_NESTED_RUNTIME_QUALIFICATION_PUBLIC_KEY_SPKI_SHA256/);
  assert.match(manifest, /HEPTA_NESTED_RUNTIME_CONFORMANCE_SUBJECT_ID/);
  assert.match(
    manifest,
    /HEPTA_NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_RECEIPT_SHA256/,
  );
  assert.match(manifest, /claimName: hepta-nested-runtime-platform-qualification/);
  assert.doesNotMatch(manifest, /deployment-no-go-until-nested-runtime-qualified/);
  assert.doesNotMatch(manifest, /exit 78/);

  const result = spawnSync(process.execPath, [
    'paper-core/bin/nested-runtime-platform-qualification.mjs',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /nested_runtime_platform_qualification_blocked/);
});
