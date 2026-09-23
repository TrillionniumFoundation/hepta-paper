import fs from 'node:fs';
import path from 'node:path';

import {
  assertPinnedExternalEvidenceVerificationReceipt,
  inspectPinnedExternalEvidenceTrustStore,
  verifyPinnedExternalEvidenceEnvelope,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  inspectNestedRuntimePlatformQualificationSubject,
  inspectNestedRuntimeStartupConformanceSubject,
  NESTED_RUNTIME_PLATFORM_QUALIFIER_ROLE,
  NESTED_RUNTIME_STARTUP_CONFORMANCE_ROLE,
} from '../../paper-domain/automation/nested-runtime-platform-qualification-contract.mjs';
import {
  inspectNestedRuntimeAuthorityIndependenceSubject,
  NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE,
} from '../../paper-domain/automation/nested-runtime-authority-independence-contract.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 .,&_:@/'()-]{2,191}$/;
const PLACEHOLDER = /(?:REPLACE_WITH|PLACEHOLDER|CHANGEME|INSERT_|TODO)/i;
const MAXIMUM_FILE_BYTES = 4 * 1024 * 1024;

function immutableJsonWithContentHash(candidate, maximumBytes = MAXIMUM_FILE_BYTES) {
  const requested = path.resolve(String(candidate || ''));
  let descriptor = null;
  try {
    if (fs.realpathSync(requested) !== requested) {
      throw new Error('nested_runtime_platform_evidence_path_not_canonical');
    }
    descriptor = fs.openSync(
      requested,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink?.() || before.nlink !== 1
      || before.size < 2 || before.size > maximumBytes || (before.mode & 0o022) !== 0) {
      throw new Error('nested_runtime_platform_evidence_file_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs) {
      throw new Error('nested_runtime_platform_evidence_changed_during_read');
    }
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('nested_runtime_platform_evidence_json_invalid');
    }
    return Object.freeze({ value, contentHash: hashBytes(bytes), path: requested });
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('nested_runtime_platform_evidence_json_invalid');
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function relativeToConfig(candidate, configPath) {
  return path.isAbsolute(String(candidate || ''))
    ? path.resolve(String(candidate))
    : path.resolve(path.dirname(configPath), String(candidate || ''));
}

function canonicalStringSet(values, { sha256 = false } = {}) {
  const selected = Array.isArray(values) ? values.map(String) : [];
  const pattern = sha256 ? SHA256 : SAFE_ID;
  if (selected.length < 1 || selected.length > 16
    || selected.some((value) => !pattern.test(value) || PLACEHOLDER.test(value))
    || new Set(selected).size !== selected.length
    || JSON.stringify(selected) !== JSON.stringify([...selected].sort())) {
    throw new Error('nested_runtime_platform_authority_binding_invalid');
  }
  return Object.freeze(selected);
}

function organizationIdentity(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalOrganizationSet(values) {
  const selected = Array.isArray(values) ? values.map(String) : [];
  if (selected.length !== 1 || selected.some((value) => (
    !SAFE_ORGANIZATION.test(value) || value !== value.trim()
      || value.normalize('NFC') !== value || PLACEHOLDER.test(value)
  ))) {
    throw new Error('nested_runtime_platform_authority_binding_invalid');
  }
  return Object.freeze(selected);
}

function canonicalAuthorityBinding(value) {
  if (!exactKeys(value, [
    'keyIds', 'organizations', 'publicKeySpkiHashes', 'subjectIds',
  ])) {
    throw new Error('nested_runtime_platform_authority_binding_invalid');
  }
  const keyIds = canonicalStringSet(value.keyIds);
  const subjectIds = canonicalStringSet(value.subjectIds);
  const organizations = canonicalOrganizationSet(value.organizations);
  const publicKeySpkiHashes = canonicalStringSet(value.publicKeySpkiHashes, { sha256: true });
  if (keyIds.length !== 1 || subjectIds.length !== 1
    || publicKeySpkiHashes.length !== 1) {
    throw new Error('nested_runtime_platform_authority_binding_invalid');
  }
  return Object.freeze({
    keyIds,
    subjectIds,
    organizations,
    publicKeySpkiHashes,
  });
}

function canonicalDeploymentOperator(value) {
  if (!exactKeys(value, [
    'identitySubjectHash', 'organization', 'principalId', 'provider',
    'trustDomainIdentityHash',
  ]) || !safeDeploymentIdentifier(value.principalId)
    || !safeDeploymentIdentifier(value.provider)
    || !SHA256.test(String(value.identitySubjectHash || ''))
    || !SHA256.test(String(value.trustDomainIdentityHash || ''))) {
    throw new Error('nested_runtime_deployment_operator_binding_invalid');
  }
  const organizations = canonicalOrganizationSet([value.organization]);
  return Object.freeze({
    principalId: String(value.principalId),
    provider: String(value.provider),
    organization: organizations[0],
    trustDomainIdentityHash: String(value.trustDomainIdentityHash),
    identitySubjectHash: String(value.identitySubjectHash),
  });
}

function safeDeploymentIdentifier(value) {
  return SAFE_ID.test(String(value || '')) && !PLACEHOLDER.test(String(value));
}

function positiveBoundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function loadConfiguration(configPath, expectedContentHash) {
  if (!SHA256.test(String(expectedContentHash || ''))) {
    throw new Error('nested_runtime_platform_configuration_content_hash_missing');
  }
  const source = immutableJsonWithContentHash(configPath, 256 * 1024);
  const value = source.value;
  if (source.contentHash !== expectedContentHash) {
    throw new Error('nested_runtime_platform_configuration_content_hash_mismatch');
  }
  if (!exactKeys(value, [
    'authorityIndependenceAuthority', 'authorityIndependenceBundlePath',
    'authorityIndependenceMaximumLifetimeMs', 'conformanceAuthority',
    'conformanceBundlePath', 'conformanceMaximumLifetimeMs',
    'conformanceMaximumObservationAgeMs', 'deploymentOperator',
    'expectedTrustStoreContentHash', 'expectedTrustStoreHash', 'kind',
    'qualificationAuthority', 'qualificationBundlePath',
    'qualificationMaximumLifetimeMs', 'trustStorePath', 'version',
  ]) || value.version !== 2
    || value.kind !== 'NestedRuntimePlatformQualificationConfiguration'
    || !SHA256.test(String(value.expectedTrustStoreContentHash || ''))
    || !SHA256.test(String(value.expectedTrustStoreHash || ''))
    || !positiveBoundedInteger(
      value.qualificationMaximumLifetimeMs,
      90 * 24 * 60 * 60 * 1000,
    )
    || !positiveBoundedInteger(value.conformanceMaximumLifetimeMs, 15 * 60 * 1000)
    || !positiveBoundedInteger(
      value.authorityIndependenceMaximumLifetimeMs,
      15 * 60 * 1000,
    )
    || !positiveBoundedInteger(
      value.conformanceMaximumObservationAgeMs,
      Math.min(value.conformanceMaximumLifetimeMs, 10 * 60 * 1000),
    )) {
    throw new Error('nested_runtime_platform_configuration_invalid');
  }
  const qualificationAuthority = canonicalAuthorityBinding(value.qualificationAuthority);
  const conformanceAuthority = canonicalAuthorityBinding(value.conformanceAuthority);
  const authorityIndependenceAuthority = canonicalAuthorityBinding(
    value.authorityIndependenceAuthority,
  );
  const authorities = [
    qualificationAuthority,
    conformanceAuthority,
    authorityIndependenceAuthority,
  ];
  for (const [ordinal, authority] of authorities.entries()) {
    for (const other of authorities.slice(ordinal + 1)) {
      for (const field of ['keyIds', 'subjectIds', 'publicKeySpkiHashes']) {
        if (authority[field].some((entry) => other[field].includes(entry))) {
          throw new Error('nested_runtime_platform_authorities_not_independent');
        }
      }
      if (organizationIdentity(authority.organizations[0])
        === organizationIdentity(other.organizations[0])) {
        throw new Error('nested_runtime_platform_authority_organizations_not_independent');
      }
    }
  }
  const deploymentOperator = canonicalDeploymentOperator(value.deploymentOperator);
  if (authorities.some((authority) => (
    organizationIdentity(authority.organizations[0])
      === organizationIdentity(deploymentOperator.organization)
  ))) {
    throw new Error('nested_runtime_deployment_operator_control_domain_not_independent');
  }
  return Object.freeze({
    sourcePath: source.path,
    configurationContentHash: source.contentHash,
    qualificationBundlePath: relativeToConfig(value.qualificationBundlePath, source.path),
    conformanceBundlePath: relativeToConfig(value.conformanceBundlePath, source.path),
    authorityIndependenceBundlePath: relativeToConfig(
      value.authorityIndependenceBundlePath,
      source.path,
    ),
    trustStorePath: relativeToConfig(value.trustStorePath, source.path),
    expectedTrustStoreContentHash: value.expectedTrustStoreContentHash,
    expectedTrustStoreHash: value.expectedTrustStoreHash,
    qualificationMaximumLifetimeMs: value.qualificationMaximumLifetimeMs,
    conformanceMaximumLifetimeMs: value.conformanceMaximumLifetimeMs,
    conformanceMaximumObservationAgeMs: value.conformanceMaximumObservationAgeMs,
    authorityIndependenceMaximumLifetimeMs:
      value.authorityIndependenceMaximumLifetimeMs,
    qualificationAuthority,
    conformanceAuthority,
    authorityIndependenceAuthority,
    deploymentOperator,
  });
}

function loadTrustStore(configuration) {
  const source = immutableJsonWithContentHash(configuration.trustStorePath, 1024 * 1024);
  if (source.contentHash !== configuration.expectedTrustStoreContentHash) {
    throw new Error('nested_runtime_platform_trust_store_content_hash_mismatch');
  }
  const inspection = inspectPinnedExternalEvidenceTrustStore(source.value);
  if (!inspection.ready || inspection.trustStoreHash !== configuration.expectedTrustStoreHash) {
    throw new Error('nested_runtime_platform_trust_store_identity_mismatch');
  }
  return Object.freeze({
    trustStore: source.value,
    trustStoreHash: inspection.trustStoreHash,
    trustStoreContentHash: source.contentHash,
    keys: inspection.keys,
  });
}

function assertAuthorityTrustBinding(trust, authority) {
  const key = trust.keys.find((candidate) => candidate.keyId === authority.keyIds[0]);
  if (!key || key.subjectId !== authority.subjectIds[0]
    || key.publicKeySpkiHash !== authority.publicKeySpkiHashes[0]
    || organizationIdentity(key.organization)
      !== organizationIdentity(authority.organizations[0])) {
    throw new Error('nested_runtime_platform_trust_key_authority_binding_mismatch');
  }
}

function loadBundle({
  bundlePath,
  expectedContentHash,
  kind,
} = {}) {
  if (!SHA256.test(String(expectedContentHash || ''))) {
    throw new Error('nested_runtime_platform_bundle_content_hash_missing');
  }
  const source = immutableJsonWithContentHash(bundlePath);
  if (source.contentHash !== expectedContentHash) {
    throw new Error('nested_runtime_platform_bundle_content_hash_mismatch');
  }
  if (!exactKeys(source.value, ['envelope', 'kind', 'subject', 'version'])
    || source.value.version !== 1 || source.value.kind !== kind) {
    throw new Error('nested_runtime_platform_bundle_invalid');
  }
  return Object.freeze({
    subject: source.value.subject,
    envelope: source.value.envelope,
    contentHash: source.contentHash,
  });
}

function verifyEnvelope({
  envelope,
  inspection,
  trustStore,
  authority,
  role,
  maximumLifetimeMs,
  now,
} = {}) {
  if (!inspection.ready) return null;
  const receipt = verifyPinnedExternalEvidenceEnvelope({
    envelope,
    subjectKind: inspection.canonical.kind,
    subjectHash: inspection.subjectHash,
    trustStore,
    requiredRole: role,
    expectedKeyIds: authority.keyIds,
    now,
    maximumLifetimeMs,
  });
  if (receipt.cryptographicAuthorityReady !== true) {
    throw new Error(
      receipt.blockers?.[0] || 'nested_runtime_platform_receipt_signature_invalid',
    );
  }
  if (receipt.signedAt !== inspection.canonical.issuedAt
    || receipt.expiresAt !== inspection.canonical.expiresAt
    || JSON.stringify(receipt.verifiedSubjectIds) !== JSON.stringify(authority.subjectIds)
    || JSON.stringify(receipt.verifiedPublicKeySpkiHashes)
      !== JSON.stringify(authority.publicKeySpkiHashes)) {
    throw new Error('nested_runtime_platform_receipt_authority_or_time_binding_invalid');
  }
  return assertPinnedExternalEvidenceVerificationReceipt(receipt, {
    subjectKind: inspection.canonical.kind,
    subjectHash: inspection.subjectHash,
    requiredRole: role,
  });
}

function blockedReport({ now, blockers, observations = {} } = {}) {
  const payload = Object.freeze({
    version: 1,
    kind: 'NestedRuntimePlatformQualificationVerificationReport',
    status: 'nested_runtime_platform_qualification_blocked',
    ready: false,
    cryptographicAuthorityReady: false,
    externallyQualified: false,
    startupConformanceReady: false,
    authorityIndependenceReady: false,
    verifiedAt: now.toISOString(),
    externalActionPerformed: false,
    ...observations,
    blockers: Object.freeze([...new Set(blockers)]),
  });
  return Object.freeze({
    ...payload,
    nestedRuntimePlatformQualificationVerificationReportHash: hashRecord(
      'NestedRuntimePlatformQualificationVerificationReport',
      payload,
    ),
  });
}

export function verifyNestedRuntimePlatformQualification({
  configPath,
  expectedConfigContentHash,
  expectedQualificationBundleContentHash,
  expectedConformanceBundleContentHash,
  expectedAuthorityIndependenceBundleContentHash,
  podUid,
  planHash,
  profileId,
  runtimeClassName,
  parentPodCpuMillis,
  parentPodMemoryBytes,
  parentPodPids,
  qualificationKeyId,
  qualificationSubjectId,
  qualificationPublicKeySpkiHash,
  conformanceKeyId,
  conformanceSubjectId,
  conformancePublicKeySpkiHash,
  now = new Date(),
} = {}) {
  const observedNow = now instanceof Date ? now : new Date(now);
  const blockers = [];
  if (!Number.isFinite(observedNow.getTime())) {
    throw new Error('nested_runtime_platform_verification_clock_invalid');
  }
  let configuration;
  let trust;
  let qualificationBundle;
  let conformanceBundle;
  let authorityIndependenceBundle;
  try {
    const expectedCeiling = {
      cpuMillis: Number(parentPodCpuMillis),
      memoryBytes: Number(parentPodMemoryBytes),
      pids: Number(parentPodPids),
    };
    if (!SAFE_ID.test(String(profileId || '')) || PLACEHOLDER.test(String(profileId))
      || !SAFE_ID.test(String(runtimeClassName || ''))
      || PLACEHOLDER.test(String(runtimeClassName))
      || !SHA256.test(String(planHash || ''))
      || Object.values(expectedCeiling).some((value) => (
        !Number.isSafeInteger(value) || value <= 0
      ))) {
      throw new Error('nested_runtime_platform_current_binding_invalid');
    }
    configuration = loadConfiguration(configPath, expectedConfigContentHash);
    const deploymentAuthorityBindings = [
      [qualificationKeyId, configuration.qualificationAuthority.keyIds[0], false],
      [qualificationSubjectId, configuration.qualificationAuthority.subjectIds[0], false],
      [
        qualificationPublicKeySpkiHash,
        configuration.qualificationAuthority.publicKeySpkiHashes[0],
        true,
      ],
      [conformanceKeyId, configuration.conformanceAuthority.keyIds[0], false],
      [conformanceSubjectId, configuration.conformanceAuthority.subjectIds[0], false],
      [
        conformancePublicKeySpkiHash,
        configuration.conformanceAuthority.publicKeySpkiHashes[0],
        true,
      ],
    ];
    if (deploymentAuthorityBindings.some(([actual, expected, sha256]) => (
      actual !== expected || !(sha256 ? SHA256 : SAFE_ID).test(String(actual || ''))
        || PLACEHOLDER.test(String(actual))
    ))) {
      throw new Error('nested_runtime_platform_deployment_authority_binding_mismatch');
    }
    trust = loadTrustStore(configuration);
    assertAuthorityTrustBinding(trust, configuration.qualificationAuthority);
    assertAuthorityTrustBinding(trust, configuration.conformanceAuthority);
    assertAuthorityTrustBinding(trust, configuration.authorityIndependenceAuthority);
    qualificationBundle = loadBundle({
      bundlePath: configuration.qualificationBundlePath,
      expectedContentHash: expectedQualificationBundleContentHash,
      kind: 'NestedRuntimePlatformQualificationBundle',
    });
    conformanceBundle = loadBundle({
      bundlePath: configuration.conformanceBundlePath,
      expectedContentHash: expectedConformanceBundleContentHash,
      kind: 'NestedRuntimeStartupConformanceBundle',
    });
    authorityIndependenceBundle = loadBundle({
      bundlePath: configuration.authorityIndependenceBundlePath,
      expectedContentHash: expectedAuthorityIndependenceBundleContentHash,
      kind: 'NestedRuntimeAuthorityIndependenceBundle',
    });
  } catch (error) {
    blockers.push(error?.message || 'nested_runtime_platform_configuration_or_evidence_invalid');
  }
  if (blockers.length) return blockedReport({ now: observedNow, blockers });
  const qualification = inspectNestedRuntimePlatformQualificationSubject(
    qualificationBundle.subject,
    {
      now: observedNow,
      maximumLifetimeMs: configuration.qualificationMaximumLifetimeMs,
    },
  );
  blockers.push(...qualification.blockers);
  if (qualification.ready && qualification.canonical.profileId !== profileId) {
    blockers.push('nested_runtime_platform_qualification_profile_id_mismatch');
  }
  if (qualification.ready
    && qualification.canonical.profile.platform.runtimeClass.name !== runtimeClassName) {
    blockers.push('nested_runtime_platform_qualification_runtime_class_mismatch');
  }
  if (qualification.ready) {
    const expectedCeiling = {
      cpuMillis: Number(parentPodCpuMillis),
      memoryBytes: Number(parentPodMemoryBytes),
      pids: Number(parentPodPids),
    };
    const actualCeiling = qualification.canonical.profile.parentPodResourceCeiling;
    if (actualCeiling.cpuMillis !== expectedCeiling.cpuMillis
      || actualCeiling.memoryBytes !== expectedCeiling.memoryBytes
      || actualCeiling.pids !== expectedCeiling.pids) {
      blockers.push('nested_runtime_platform_parent_pod_ceiling_mismatch');
    }
  }
  let qualificationAuthority = null;
  try {
    qualificationAuthority = verifyEnvelope({
      envelope: qualificationBundle.envelope,
      inspection: qualification,
      trustStore: trust.trustStore,
      authority: configuration.qualificationAuthority,
      role: NESTED_RUNTIME_PLATFORM_QUALIFIER_ROLE,
      maximumLifetimeMs: configuration.qualificationMaximumLifetimeMs,
      now: observedNow,
    });
  } catch (error) {
    blockers.push(error?.message || 'nested_runtime_platform_qualification_signature_invalid');
  }
  const conformance = inspectNestedRuntimeStartupConformanceSubject(
    conformanceBundle.subject,
    {
      qualification,
      expectedPodUid: podUid,
      expectedPlanHash: planHash,
      expectedProfileId: profileId,
      expectedRuntimeClassName: runtimeClassName,
      now: observedNow,
      maximumLifetimeMs: configuration.conformanceMaximumLifetimeMs,
      maximumObservationAgeMs: configuration.conformanceMaximumObservationAgeMs,
    },
  );
  blockers.push(...conformance.blockers);
  let conformanceAuthority = null;
  try {
    conformanceAuthority = verifyEnvelope({
      envelope: conformanceBundle.envelope,
      inspection: conformance,
      trustStore: trust.trustStore,
      authority: configuration.conformanceAuthority,
      role: NESTED_RUNTIME_STARTUP_CONFORMANCE_ROLE,
      maximumLifetimeMs: configuration.conformanceMaximumLifetimeMs,
      now: observedNow,
    });
  } catch (error) {
    blockers.push(error?.message || 'nested_runtime_startup_conformance_signature_invalid');
  }
  const authorityIndependence = inspectNestedRuntimeAuthorityIndependenceSubject(
    authorityIndependenceBundle.subject,
    {
      expectedProfileId: profileId,
      expectedQualificationSubjectHash: qualification.subjectHash,
      expectedConformanceSubjectHash: conformance.subjectHash,
      expectedPodUid: podUid,
      expectedPlanHash: planHash,
      expectedQualificationPrincipalId:
        configuration.qualificationAuthority.subjectIds[0],
      expectedQualificationSignerSpkiHash:
        configuration.qualificationAuthority.publicKeySpkiHashes[0],
      expectedQualificationOrganization:
        configuration.qualificationAuthority.organizations[0],
      expectedConformancePrincipalId:
        configuration.conformanceAuthority.subjectIds[0],
      expectedConformanceSignerSpkiHash:
        configuration.conformanceAuthority.publicKeySpkiHashes[0],
      expectedConformanceOrganization:
        configuration.conformanceAuthority.organizations[0],
      expectedDeploymentOperator: configuration.deploymentOperator,
      now: observedNow,
      maximumLifetimeMs: configuration.authorityIndependenceMaximumLifetimeMs,
    },
  );
  blockers.push(...authorityIndependence.blockers);
  let authorityIndependenceAuthority = null;
  try {
    authorityIndependenceAuthority = verifyEnvelope({
      envelope: authorityIndependenceBundle.envelope,
      inspection: authorityIndependence,
      trustStore: trust.trustStore,
      authority: configuration.authorityIndependenceAuthority,
      role: NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_ATTESTOR_ROLE,
      maximumLifetimeMs: configuration.authorityIndependenceMaximumLifetimeMs,
      now: observedNow,
    });
  } catch (error) {
    blockers.push(
      error?.message || 'nested_runtime_authority_independence_signature_invalid',
    );
  }
  if (blockers.length || !qualificationAuthority || !conformanceAuthority
    || !authorityIndependenceAuthority) {
    return blockedReport({
      now: observedNow,
      blockers: blockers.length
        ? blockers : ['nested_runtime_platform_authority_missing'],
      observations: {
        configurationContentHash: configuration.configurationContentHash,
        trustStoreContentHash: trust.trustStoreContentHash,
        qualificationBundleContentHash: qualificationBundle.contentHash,
        conformanceBundleContentHash: conformanceBundle.contentHash,
        authorityIndependenceBundleContentHash:
          authorityIndependenceBundle.contentHash,
        qualificationSubjectHash: qualification.subjectHash,
        conformanceSubjectHash: conformance.subjectHash,
        authorityIndependenceSubjectHash: authorityIndependence.subjectHash,
      },
    });
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'NestedRuntimePlatformQualificationVerificationReport',
    status: 'nested_runtime_platform_qualification_verified',
    ready: true,
    cryptographicAuthorityReady: true,
    externallyQualified: true,
    startupConformanceReady: true,
    authorityIndependenceReady: true,
    verifiedAt: observedNow.toISOString(),
    profileId,
    profileHash: qualification.profileHash,
    podUid,
    planHash,
    runtimeClassName,
    configurationContentHash: configuration.configurationContentHash,
    trustStoreHash: trust.trustStoreHash,
    trustStoreContentHash: trust.trustStoreContentHash,
    qualificationBundleContentHash: qualificationBundle.contentHash,
    conformanceBundleContentHash: conformanceBundle.contentHash,
    authorityIndependenceBundleContentHash: authorityIndependenceBundle.contentHash,
    qualificationSubjectHash: qualification.subjectHash,
    conformanceSubjectHash: conformance.subjectHash,
    authorityIndependenceSubjectHash: authorityIndependence.subjectHash,
    qualificationVerifiedKeyIds: qualificationAuthority.verifiedKeyIds,
    qualificationVerifiedSubjectIds: qualificationAuthority.verifiedSubjectIds,
    qualificationVerifiedPublicKeySpkiHashes:
      qualificationAuthority.verifiedPublicKeySpkiHashes,
    conformanceVerifiedKeyIds: conformanceAuthority.verifiedKeyIds,
    conformanceVerifiedSubjectIds: conformanceAuthority.verifiedSubjectIds,
    conformanceVerifiedPublicKeySpkiHashes:
      conformanceAuthority.verifiedPublicKeySpkiHashes,
    authorityIndependenceVerifiedKeyIds:
      authorityIndependenceAuthority.verifiedKeyIds,
    authorityIndependenceVerifiedSubjectIds:
      authorityIndependenceAuthority.verifiedSubjectIds,
    authorityIndependenceVerifiedPublicKeySpkiHashes:
      authorityIndependenceAuthority.verifiedPublicKeySpkiHashes,
    qualificationAuthorityOrganization:
      configuration.qualificationAuthority.organizations[0],
    conformanceAuthorityOrganization:
      configuration.conformanceAuthority.organizations[0],
    authorityIndependenceAttestorOrganization:
      configuration.authorityIndependenceAuthority.organizations[0],
    deploymentOperatorPrincipalId:
      configuration.deploymentOperator.principalId,
    deploymentOperatorOrganization:
      configuration.deploymentOperator.organization,
    deploymentOperatorProvider:
      configuration.deploymentOperator.provider,
    deploymentOperatorTrustDomainIdentityHash:
      configuration.deploymentOperator.trustDomainIdentityHash,
    qualificationExpiresAt: qualificationAuthority.expiresAt,
    conformanceExpiresAt: conformanceAuthority.expiresAt,
    authorityIndependenceExpiresAt: authorityIndependenceAuthority.expiresAt,
    externalActionPerformed: false,
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...payload,
    nestedRuntimePlatformQualificationVerificationReportHash: hashRecord(
      'NestedRuntimePlatformQualificationVerificationReport',
      payload,
    ),
  });
}
