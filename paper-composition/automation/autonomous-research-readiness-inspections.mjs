import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SAFE_ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 ._():-]{0,159}$/;
const RELEASE_ATTESTOR_ROLE = 'research_execution_release_attestor';
const OPERATOR_COST_AUTHORITY = 'operator_declared_worst_case_usd';
const ZERO_COST_AUTHORITY = 'externally_operated_zero_cost';

function sha256ValuesValid(...values) {
  return values.every((value) => SHA256.test(String(value)));
}

function recordHashValid(record, kind, hashField) {
  if (!record || typeof record !== 'object' || !record[hashField]) return false;
  const { [hashField]: claimedHash, ...payload } = record;
  return hashRecord(kind, payload) === claimedHash;
}

function releaseSignerBackendDescriptorHashValid(inspection) {
  return hashRecord('ResearchExecutionReleaseSignerBackendDescriptor', {
    version: 1,
    kind: 'ResearchExecutionReleaseSignerBackendDescriptor',
    backendKind: inspection?.backendKind,
    backendId: inspection?.backendId,
    backendVersion: inspection?.backendVersion,
    algorithm: inspection?.algorithm,
    hardwareProtected: inspection?.hardwareProtected,
    privateKeyExportable: inspection?.privateKeyExportable,
    externalSignerProcess: inspection?.externalSignerProcess,
    productionEligible: inspection?.backendProductionEligible,
    ...(inspection?.signerBackendAssuranceProfile
      ? { assuranceProfile: inspection.signerBackendAssuranceProfile } : {}),
    ...(inspection?.signerBackendThreatBoundary
      ? { threatBoundary: inspection.signerBackendThreatBoundary } : {}),
    ...(inspection?.kmsProvider
      ? {
        kmsProvider: inspection.kmsProvider,
        providerAccountIdentityHash:
          inspection.kmsProviderAccountIdentityHash,
        keyResourceIdentityHash:
          inspection.kmsKeyResourceIdentityHash,
        credentialGenerationIdentityHash:
          inspection.kmsCredentialGenerationIdentityHash,
      } : {}),
    activeKeyId: inspection?.keyId,
    activeKeyVersion: inspection?.keyVersion,
    activePublicKeySpkiHash: inspection?.publicKeySpkiHash,
    trustSetHash: inspection?.trustSetHash,
    commandIdentityHash: inspection?.backendCommandIdentityHash,
    probeCommandIdentityHash: inspection?.backendProbeCommandIdentityHash,
    probeAttestorPublicKeySpkiHash:
      inspection?.backendProbeAttestorPublicKeySpkiHash,
    credentialMaterialReadByMainProcess:
      inspection?.credentialMaterialReadByMainProcess,
  }) === inspection?.backendDescriptorHash;
}

export function releaseAttestorInspectionReady(inspection) {
  const inspectedAt = canonicalTimestamp(inspection?.inspectedAt);
  const liveVerificationCompletedAt = canonicalTimestamp(
    inspection?.liveVerificationCompletedAt,
  );
  const effectiveFrom = canonicalTimestamp(inspection?.effectiveFrom);
  const expiresAt = canonicalTimestamp(inspection?.expiresAt);
  const trustedKeys = Array.isArray(inspection?.trustedKeys) ? inspection.trustedKeys : [];
  const activeKey = trustedKeys.find((key) => key?.status === 'active'
    && key?.revokedAt === null) || null;
  const trustSetValid = inspection?.trustSetVersion === 1
    && SHA256.test(String(inspection?.trustSetHash || ''))
    && trustedKeys.length > 0
    && trustedKeys.every((key) => (
      SAFE_ID.test(String(key?.keyId || ''))
      && SAFE_VERSION.test(String(key?.keyVersion || ''))
      && SAFE_ID.test(String(key?.subjectId || ''))
      && SAFE_ORGANIZATION.test(String(key?.organization || ''))
      && key?.role === RELEASE_ATTESTOR_ROLE
      && key?.algorithm === 'ed25519'
      && ['active', 'retiring'].includes(key?.status)
      && SHA256.test(String(key?.publicKeySpkiHash || ''))
      && canonicalTimestamp(key?.effectiveFrom) !== null
      && canonicalTimestamp(key?.expiresAt) !== null
      && canonicalTimestamp(key.effectiveFrom) < canonicalTimestamp(key.expiresAt)
      && (key?.revokedAt === null || canonicalTimestamp(key.revokedAt) !== null)
    ))
    && new Set(trustedKeys.map((key) => `${key.keyId}:${key.keyVersion}`)).size
      === trustedKeys.length
    && new Set(trustedKeys.map((key) => key.publicKeySpkiHash)).size === trustedKeys.length
    && trustedKeys.filter((key) => key.status === 'active' && key.revokedAt === null).length === 1
    && hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
      version: inspection.trustSetVersion,
      keys: trustedKeys,
    }) === inspection.trustSetHash;
  return inspection?.version === 1
    && inspection?.kind === 'ResearchExecutionReleaseAttestorConfigurationInspection'
    && inspection?.status === 'research_execution_release_attestor_ready'
    && inspection?.ready === true
    && SAFE_ID.test(String(inspection?.keyId || ''))
    && SAFE_VERSION.test(String(inspection?.keyVersion || ''))
    && SAFE_ID.test(String(inspection?.subjectId || ''))
    && SAFE_ORGANIZATION.test(String(inspection?.organization || ''))
    && inspection?.role === RELEASE_ATTESTOR_ROLE
    && inspection?.algorithm === 'ed25519'
    && inspectedAt !== null
    && liveVerificationCompletedAt !== null
    && effectiveFrom !== null
    && expiresAt !== null
    && effectiveFrom <= inspectedAt
    && inspectedAt <= liveVerificationCompletedAt
    && liveVerificationCompletedAt < expiresAt
    && effectiveFrom < expiresAt
    && inspection?.privateKeyDisclosed === false
    && SHA256.test(String(inspection?.publicKeySpkiHash || ''))
    && SHA256.test(String(inspection?.configurationFileHash || ''))
    && SHA256.test(String(inspection?.configurationIdentityHash || ''))
    && typeof inspection?.configurationPinned === 'boolean'
    && trustSetValid
    && activeKey?.keyId === inspection.keyId
    && activeKey?.keyVersion === inspection.keyVersion
    && activeKey?.subjectId === inspection.subjectId
    && activeKey?.organization === inspection.organization
    && activeKey?.publicKeySpkiHash === inspection.publicKeySpkiHash
    && SHA256.test(String(inspection?.backendDescriptorHash || ''))
    && releaseSignerBackendDescriptorHashValid(inspection)
    && Array.isArray(inspection?.blockers)
    && inspection.blockers.length === 0
    && recordHashValid(
      inspection,
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      'researchExecutionReleaseAttestorConfigurationInspectionHash',
    );
}

export function releaseAttestorProductionInspectionReady(inspection) {
  return releaseAttestorInspectionReady(inspection)
    && inspection?.productionStatus === 'research_execution_release_attestor_production_ready'
    && inspection?.productionReady === true
    && inspection?.fullProductionStatus
      === 'research_execution_release_attestor_full_production_ready'
    && inspection?.fullProductionReady === true
    && inspection?.backendKind === 'external-kms-command'
    && inspection?.backendProductionEligible === true
    && inspection?.hardwareProtected === true
    && inspection?.privateKeyExportable === false
    && inspection?.externalSignerProcess === true
    && inspection?.privateKeyLoadedIntoMainProcess === false
    && inspection?.credentialMaterialReadByMainProcess === false
    && inspection?.configurationPinned === true
    && inspection?.configurationIdentityProfile
      === 'stable-kms-authority-policy-and-rotating-bundle-v3'
    && inspection?.kmsHardwareAuthorityAttestationReady === true
    && inspection?.kmsHardwareAuthorityIndependent === true
    && sha256ValuesValid(
      inspection?.kmsHardwareAuthorityAttestationInspectionHash,
      inspection?.kmsHardwareAuthorityAttestationBundleHash,
      inspection?.kmsHardwareAuthorityAttestationSubjectHash,
      inspection?.kmsHardwareAuthorityTrustStoreHash,
      inspection?.kmsHardwareAuthorityVerificationReceiptHash,
      inspection?.kmsProviderAccountIdentityHash,
      inspection?.kmsKeyResourceIdentityHash,
      inspection?.kmsCredentialGenerationIdentityHash,
    )
    && Array.isArray(inspection?.kmsHardwareAuthorityVerifiedKeyIds)
    && inspection.kmsHardwareAuthorityVerifiedKeyIds.length > 0
    && SAFE_ID.test(String(inspection?.kmsProvider || ''))
    && inspection?.independentBackendProbeVerified === true
    && SHA256.test(String(inspection?.backendProbeAttestationHash || ''))
    && inspection?.activeSignerChallengeVerified === true
    && SHA256.test(String(inspection?.activeSignerChallengeSigningPayloadHash || ''))
    && SHA256.test(String(inspection?.activeSignerChallengeVerificationHash || ''))
    && SAFE_ID.test(String(inspection?.backendProbeAttestorKeyId || ''))
    && SAFE_VERSION.test(String(inspection?.backendProbeAttestorKeyVersion || ''))
    && SHA256.test(String(inspection?.backendProbeAttestorPublicKeySpkiHash || ''))
    && Array.isArray(inspection?.productionBlockers)
    && inspection.productionBlockers.length === 0
    && Array.isArray(inspection?.fullProductionBlockers)
    && inspection.fullProductionBlockers.length === 0;
}

function canonicalTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function organizationIdentity(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
}

function externalTrustedSignerValid(key) {
  const expectedKeys = [
    'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'keyVersion', 'organization',
    'publicKeySpkiHash', 'revokedAt', 'role', 'status', 'subjectId',
  ];
  return key && typeof key === 'object' && !Array.isArray(key)
    && JSON.stringify(Object.keys(key).sort()) === JSON.stringify(expectedKeys.sort())
    && SAFE_ID.test(String(key.keyId || ''))
    && SAFE_VERSION.test(String(key.keyVersion || ''))
    && SAFE_ID.test(String(key.subjectId || ''))
    && SAFE_ORGANIZATION.test(String(key.organization || ''))
    && key.role === RELEASE_ATTESTOR_ROLE
    && key.algorithm === 'ed25519'
    && ['active', 'retiring'].includes(key.status)
    && SHA256.test(String(key.publicKeySpkiHash || ''))
    && canonicalTimestamp(key.effectiveFrom) !== null
    && canonicalTimestamp(key.expiresAt) !== null
    && canonicalTimestamp(key.effectiveFrom) < canonicalTimestamp(key.expiresAt)
    && (key.revokedAt === null || canonicalTimestamp(key.revokedAt) !== null);
}

function canonicalExternalTrustedSigner(key) {
  return Object.freeze({
    keyId: key?.keyId,
    keyVersion: key?.keyVersion,
    subjectId: key?.subjectId,
    organization: key?.organization ?? null,
    role: key?.role,
    algorithm: key?.algorithm,
    status: key?.status,
    effectiveFrom: key?.effectiveFrom,
    expiresAt: key?.expiresAt,
    revokedAt: key?.revokedAt ?? null,
    publicKeySpkiHash: key?.publicKeySpkiHash,
  });
}

function rotationStableTrustMaterial(key) {
  return Object.freeze({
    keyId: key?.keyId,
    keyVersion: key?.keyVersion,
    subjectId: key?.subjectId,
    organization: key?.organization ?? null,
    role: key?.role,
    algorithm: key?.algorithm,
    effectiveFrom: key?.effectiveFrom,
    expiresAt: key?.expiresAt,
    publicKeySpkiHash: key?.publicKeySpkiHash,
  });
}

export function evaluateUnattendedCampaignLaunchReadiness({
  loopPreparation = null,
  runtimePrincipalPreflight = null,
  providerConfigurationHash = null,
  releaseAttestorInspection = null,
} = {}) {
  const capabilityScope = loopPreparation?.capabilityScopeManifest || null;
  const machineAgendaReady = capabilityScope?.agendaMode !== 'machine-generated'
    || (verifyAutonomousResearchAgendaProductionReceipt(
      loopPreparation?.researchAgendaProducerReceipt,
    ).valid
      && capabilityScope.empiricalFamilies.includes(
        loopPreparation.researchAgendaProducerReceipt.selectedProtocolFamily,
      )
      && JSON.stringify(
        loopPreparation.researchAgendaProducerReceipt.allowedProtocolFamilies,
      ) === JSON.stringify(capabilityScope.empiricalFamilies));
  return loopPreparation?.autonomousExecutionLaunchReady === true
    && machineAgendaReady
    && runtimePrincipalPreflight?.status === 'autonomous_research_runtime_principals_ready'
    && Array.isArray(runtimePrincipalPreflight?.blockers)
    && runtimePrincipalPreflight.blockers.length === 0
    && SHA256.test(String(providerConfigurationHash || ''))
    && loopPreparation?.autonomousResearchProviderConfigurationHash
      === providerConfigurationHash
    && runtimePrincipalPreflight?.autonomousResearchProviderConfigurationHash
      === providerConfigurationHash
    && releaseAttestorInspectionReady(releaseAttestorInspection);
}

export function externalQualificationProcessConfigurationInspectionReady(inspection) {
  const trustedSigners = Array.isArray(inspection?.trustedSigners)
    ? inspection.trustedSigners : [];
  const activeTrustedSigners = trustedSigners.filter((key) => (
    key?.status === 'active' && key?.revokedAt === null
  ));
  const trustSetValid = inspection?.trustedSignerTrustSetVersion === 1
    && SHA256.test(String(inspection?.trustedSignerTrustSetHash || ''))
    && trustedSigners.length > 0 && trustedSigners.length <= 32
    && trustedSigners.every(externalTrustedSignerValid)
    && trustedSigners.every((key, index) => index === 0
      || `${trustedSigners[index - 1].keyId}:${trustedSigners[index - 1].keyVersion}`
        .localeCompare(`${key.keyId}:${key.keyVersion}`) < 0)
    && new Set(trustedSigners.map((key) => `${key.keyId}:${key.keyVersion}`)).size
      === trustedSigners.length
    && new Set(trustedSigners.map((key) => key.publicKeySpkiHash)).size
      === trustedSigners.length
    && activeTrustedSigners.length === 1
    && hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
      version: inspection.trustedSignerTrustSetVersion,
      keys: trustedSigners,
    }) === inspection.trustedSignerTrustSetHash;
  const maximumQualificationCostUsd = Number(inspection?.maximumQualificationCostUsd);
  const qualificationCostAuthorityValid = Number.isFinite(maximumQualificationCostUsd)
    && maximumQualificationCostUsd >= 0 && maximumQualificationCostUsd <= 1_000
    && (maximumQualificationCostUsd === 0
      ? inspection?.qualificationCostAuthority === ZERO_COST_AUTHORITY
      : inspection?.qualificationCostAuthority === OPERATOR_COST_AUTHORITY);
  if (!(inspection?.version === 1
    && inspection?.kind === 'ExternalResearchQualificationProcessConfigurationInspection'
    && inspection?.status === 'external_research_qualification_process_configuration_ready'
    && inspection?.ready === true
    && inspection?.independentVerifierConfigured === true
    && inspection?.authoritativeLookupSupported === true
    && inspection?.authoritativeLookupVerifierConfigured === true
    && inspection?.authoritativeLookupVerificationTrustSetHash
      === inspection?.trustedSignerTrustSetHash
    && inspection?.independentVerifierResponseAttestationRequired === true
    && inspection?.privateSigningKeyLoaded === false
    && qualificationCostAuthorityValid
    && Array.isArray(inspection?.blockers)
    && inspection.blockers.length === 0
    && [
      inspection.qualifierCommandIdentityHash,
      inspection.verifierCommandIdentityHash,
      inspection.qualifierCommandInspectionHash,
      inspection.verifierCommandInspectionHash,
      inspection.qualifierExecutableContentHash,
      inspection.verifierExecutableContentHash,
      inspection.qualifierCredentialRootIdentityHash,
      inspection.verifierCredentialRootIdentityHash,
      inspection.qualifierCredentialRootContentsIdentityHash,
      inspection.verifierCredentialRootContentsIdentityHash,
      inspection.qualifierChildEnvironmentIdentityHash,
      inspection.verifierChildEnvironmentIdentityHash,
      inspection.configurationIdentityHash,
      inspection.trustIdentityHash,
      inspection.clientServiceIdentityHash,
      inspection.verifierServiceIdentityHash,
      inspection.trustedSignerTrustSetHash,
      inspection.authoritativeLookupVerificationTrustSetHash,
      inspection.trustedSignerPublicKeySpkiHash,
      inspection.verifierAttestorPublicKeySpkiHash,
    ].every((value) => SHA256.test(String(value || '')))
    && trustSetValid
    && inspection.qualifierServiceId
    && inspection.verifierServiceId
    && inspection.qualifierServiceId !== inspection.verifierServiceId
    && inspection.qualifierPrincipalId
    && inspection.verifierPrincipalId
    && inspection.qualifierPrincipalId !== inspection.verifierPrincipalId
    && inspection.qualifierCommandIdentityHash !== inspection.verifierCommandIdentityHash
    && Number.isSafeInteger(inspection.qualifierCredentialUid)
    && inspection.qualifierCredentialUid >= 0
    && Number.isSafeInteger(inspection.verifierCredentialUid)
    && inspection.verifierCredentialUid >= 0
    && (inspection.qualifierInterpreterIdentityHash === null
      || SHA256.test(String(inspection.qualifierInterpreterIdentityHash || '')))
    && (inspection.verifierInterpreterIdentityHash === null
      || SHA256.test(String(inspection.verifierInterpreterIdentityHash || '')))
    && inspection.qualifierExecutableContentHash !== inspection.verifierExecutableContentHash
    && inspection.qualifierCredentialRootIdentityHash
      !== inspection.verifierCredentialRootIdentityHash
    && inspection.trustedSignerKeyId
    && inspection.trustedSignerKeyVersion
    && inspection.trustedSignerSubjectId
    && SAFE_ORGANIZATION.test(String(inspection.trustedSignerOrganization || ''))
    && inspection.trustedSignerAlgorithm === 'ed25519'
    && inspection.trustedSignerRole === 'research_execution_release_attestor'
    && inspection.trustedSignerStatus === 'active'
    && canonicalTimestamp(inspection.trustedSignerEffectiveFrom) !== null
    && canonicalTimestamp(inspection.trustedSignerExpiresAt) !== null
    && canonicalTimestamp(inspection.trustedSignerEffectiveFrom)
      < canonicalTimestamp(inspection.trustedSignerExpiresAt)
    && inspection.trustedSignerRevokedAt === null
    && inspection.verifierAttestorKeyId
    && inspection.verifierAttestorKeyVersion
    && inspection.verifierAttestorSubjectId
    && SAFE_ORGANIZATION.test(String(inspection.verifierAttestorOrganization || ''))
    && inspection.verifierAttestorAlgorithm === 'ed25519'
    && inspection.verifierAttestorRole === 'external_qualification_independent_verifier'
    && ['active', 'retiring'].includes(inspection.verifierAttestorStatus)
    && canonicalTimestamp(inspection.verifierAttestorEffectiveFrom) !== null
    && canonicalTimestamp(inspection.verifierAttestorExpiresAt) !== null
    && canonicalTimestamp(inspection.verifierAttestorEffectiveFrom)
      < canonicalTimestamp(inspection.verifierAttestorExpiresAt)
    && inspection.verifierAttestorRevokedAt === null
    && inspection.trustedSignerKeyId !== inspection.verifierAttestorKeyId
    && inspection.trustedSignerSubjectId !== inspection.verifierAttestorSubjectId
    && inspection.trustedSignerPublicKeySpkiHash
      !== inspection.verifierAttestorPublicKeySpkiHash
    && trustedSigners.every((key) => (
      key.keyId !== inspection.verifierAttestorKeyId
      && key.subjectId !== inspection.verifierAttestorSubjectId
      && key.publicKeySpkiHash !== inspection.verifierAttestorPublicKeySpkiHash
      && organizationIdentity(key.organization)
        !== organizationIdentity(inspection.verifierAttestorOrganization)
    ))
    && inspection.clientServiceIdentityHash !== inspection.verifierServiceIdentityHash
    && recordHashValid(
      inspection,
      'ExternalResearchQualificationProcessConfigurationInspection',
      'externalResearchQualificationProcessConfigurationInspectionHash',
    ))) return false;
  if (commandInspectionHash(inspection, 'qualifier')
      !== inspection.qualifierCommandInspectionHash
    || commandInspectionHash(inspection, 'verifier')
      !== inspection.verifierCommandInspectionHash) return false;
  const trustedSigner = Object.freeze({
    keyId: inspection.trustedSignerKeyId,
    keyVersion: inspection.trustedSignerKeyVersion,
    subjectId: inspection.trustedSignerSubjectId,
    organization: inspection.trustedSignerOrganization || null,
    role: inspection.trustedSignerRole,
    algorithm: inspection.trustedSignerAlgorithm,
    status: inspection.trustedSignerStatus,
    effectiveFrom: inspection.trustedSignerEffectiveFrom,
    expiresAt: inspection.trustedSignerExpiresAt,
    revokedAt: inspection.trustedSignerRevokedAt,
  });
  const activeTrustedSigner = activeTrustedSigners[0];
  if (JSON.stringify(canonicalExternalTrustedSigner(activeTrustedSigner))
    !== JSON.stringify(canonicalExternalTrustedSigner(Object.freeze({
    ...trustedSigner,
    publicKeySpkiHash: inspection.trustedSignerPublicKeySpkiHash,
    })))) return false;
  const verifierAttestor = Object.freeze({
    keyId: inspection.verifierAttestorKeyId,
    keyVersion: inspection.verifierAttestorKeyVersion,
    subjectId: inspection.verifierAttestorSubjectId,
    organization: inspection.verifierAttestorOrganization || null,
    role: inspection.verifierAttestorRole,
    algorithm: inspection.verifierAttestorAlgorithm,
    status: inspection.verifierAttestorStatus,
    effectiveFrom: inspection.verifierAttestorEffectiveFrom,
    expiresAt: inspection.verifierAttestorExpiresAt,
    revokedAt: inspection.verifierAttestorRevokedAt,
  });
  const trustIdentityHash = hashRecord('ExternalResearchQualificationTrustIdentity', {
    trustedSignerTrustSetVersion: inspection.trustedSignerTrustSetVersion,
    trustedSignerTrustSetHash: inspection.trustedSignerTrustSetHash,
    trustedSigners,
    verifierAttestor,
    verifierAttestorPublicKeySpkiHash: inspection.verifierAttestorPublicKeySpkiHash,
  });
  const configurationIdentityHash = hashRecord(
    'ExternalResearchQualificationConfigurationIdentity',
    {
      qualifierCommandIdentityHash: inspection.qualifierCommandIdentityHash,
      verifierCommandIdentityHash: inspection.verifierCommandIdentityHash,
      maximumQualificationCostUsd,
      qualificationCostAuthority: inspection.qualificationCostAuthority,
      trustIdentityHash,
    },
  );
  const clientServiceIdentityHash = hashRecord(
    'ExternalResearchQualificationClientServiceIdentity',
    {
      configurationIdentityHash,
      commandIdentityHash: inspection.qualifierCommandIdentityHash,
      serviceId: inspection.qualifierServiceId,
      principalId: inspection.qualifierPrincipalId,
    },
  );
  const verifierServiceIdentityHash = hashRecord(
    'ExternalResearchQualificationVerifierServiceIdentity',
    {
      configurationIdentityHash,
      commandIdentityHash: inspection.verifierCommandIdentityHash,
      serviceId: inspection.verifierServiceId,
      principalId: inspection.verifierPrincipalId,
      trustIdentityHash,
    },
  );
  return trustIdentityHash === inspection.trustIdentityHash
    && configurationIdentityHash === inspection.configurationIdentityHash
    && clientServiceIdentityHash === inspection.clientServiceIdentityHash
    && verifierServiceIdentityHash === inspection.verifierServiceIdentityHash;
}

function commandInspectionHash(inspection, prefix) {
  return hashRecord('ExternalResearchQualificationProcessCommandInspection', {
    serviceId: inspection[`${prefix}ServiceId`],
    principalId: inspection[`${prefix}PrincipalId`],
    commandIdentityHash: inspection[`${prefix}CommandIdentityHash`],
    executableContentHash: inspection[`${prefix}ExecutableContentHash`],
    credentialRootIdentityHash: inspection[`${prefix}CredentialRootIdentityHash`],
    credentialRootContentsIdentityHash:
      inspection[`${prefix}CredentialRootContentsIdentityHash`],
    childEnvironmentIdentityHash: inspection[`${prefix}ChildEnvironmentIdentityHash`],
    interpreterIdentityHash: inspection[`${prefix}InterpreterIdentityHash`],
    credentialUid: inspection[`${prefix}CredentialUid`],
  });
}

function injectedPairReady(client, verifier) {
  return client?.kind === 'ExternalResearchQualificationClient'
    && typeof client?.requestQualification === 'function'
    && typeof client?.lookupQualification === 'function'
    && verifier?.kind === 'IndependentExternalResearchQualificationVerifier'
    && typeof verifier?.verifyLookup === 'function'
    && typeof verifier?.verify === 'function'
    && [
      client.configurationIdentityHash,
      client.trustIdentityHash,
      client.serviceIdentityHash,
      verifier.configurationIdentityHash,
      verifier.trustIdentityHash,
      verifier.serviceIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))
    && client.configurationIdentityHash === verifier.configurationIdentityHash
    && client.trustIdentityHash === verifier.trustIdentityHash
    && client.serviceIdentityHash !== verifier.serviceIdentityHash;
}

function signerBound(configuration, release) {
  const configuredKeys = Array.isArray(configuration?.trustedSigners)
    ? configuration.trustedSigners : [];
  const releaseKeys = Array.isArray(release?.trustedKeys) ? release.trustedKeys : [];
  const normalizedConfiguredKeys = configuredKeys.map(rotationStableTrustMaterial);
  const normalizedReleaseKeys = releaseKeys.map(rotationStableTrustMaterial)
    .sort((left, right) => (
      `${left?.keyId}:${left?.keyVersion}`.localeCompare(`${right?.keyId}:${right?.keyVersion}`)
    ));
  return configuration?.trustedSignerTrustSetVersion === release?.trustSetVersion
    && JSON.stringify(normalizedConfiguredKeys) === JSON.stringify(normalizedReleaseKeys);
}

export function evaluateExternalQualificationServiceReadiness({
  configurationInspection = null,
  releaseAttestorInspection = null,
  injectedClient = null,
  injectedVerifier = null,
  required = true,
} = {}) {
  if (required === false) {
    const payload = {
      version: 1,
      kind: 'ExternalQualificationServiceInspection',
      status: 'external_qualification_service_not_required',
      ready: true,
      source: 'local-run',
      processConfigurationInspection: null,
      processConfigurationInspectionHash: null,
      releaseAttestorInspectionHash: null,
      configurationIdentityHash: null,
      trustIdentityHash: null,
      clientServiceIdentityHash: null,
      verifierServiceIdentityHash: null,
      trustedSignerKeyId: null,
      trustedSignerSubjectId: null,
      trustedSignerOrganization: null,
      trustedSignerRole: null,
      trustedSignerAlgorithm: null,
      trustedSignerPublicKeySpkiHash: null,
      trustedSignerTrustSetHash: null,
      injectedServicePairValid: null,
      releaseSignerBindingVerified: false,
      blockers: Object.freeze([]),
    };
    return Object.freeze({
      ...payload,
      externalQualificationServiceInspectionHash:
        hashRecord('ExternalQualificationServiceInspection', payload),
    });
  }
  const blockers = [];
  const injected = Boolean(injectedClient || injectedVerifier);
  const source = injected ? 'paired_injection'
    : configurationInspection ? 'process_configuration' : 'unconfigured';
  const releaseReady = releaseAttestorInspectionReady(releaseAttestorInspection);
  if (!releaseReady) blockers.push('external_qualification_release_attestor_not_ready');
  let processReady = false;
  let pairReady = false;
  if (injected) {
    pairReady = injectedPairReady(injectedClient, injectedVerifier);
    if (!pairReady) blockers.push('external_qualification_injected_service_pair_invalid');
    blockers.push('external_qualification_injected_service_configuration_inspection_required');
  } else {
    processReady = externalQualificationProcessConfigurationInspectionReady(
      configurationInspection,
    );
    if (!processReady) blockers.push('external_qualification_process_configuration_not_ready');
  }
  const signerBindingVerified = processReady && releaseReady
    && signerBound(configurationInspection, releaseAttestorInspection);
  if (processReady && releaseReady && !signerBindingVerified) {
    blockers.push('external_qualification_release_signer_binding_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const ready = uniqueBlockers.length === 0 && signerBindingVerified;
  const payload = {
    version: 1,
    kind: 'ExternalQualificationServiceInspection',
    status: ready
      ? 'external_qualification_service_ready'
      : 'external_qualification_service_blocked',
    ready,
    source,
    processConfigurationInspection: injected ? null : configurationInspection,
    processConfigurationInspectionHash:
      configurationInspection
        ?.externalResearchQualificationProcessConfigurationInspectionHash || null,
    releaseAttestorInspectionHash:
      releaseAttestorInspection
        ?.researchExecutionReleaseAttestorConfigurationInspectionHash || null,
    configurationIdentityHash: configurationInspection?.configurationIdentityHash
      || injectedClient?.configurationIdentityHash || null,
    trustIdentityHash: configurationInspection?.trustIdentityHash
      || injectedClient?.trustIdentityHash || null,
    clientServiceIdentityHash: configurationInspection?.clientServiceIdentityHash
      || injectedClient?.serviceIdentityHash || null,
    verifierServiceIdentityHash: configurationInspection?.verifierServiceIdentityHash
      || injectedVerifier?.serviceIdentityHash || null,
    trustedSignerKeyId: configurationInspection?.trustedSignerKeyId || null,
    trustedSignerSubjectId: configurationInspection?.trustedSignerSubjectId || null,
    trustedSignerOrganization: configurationInspection?.trustedSignerOrganization || null,
    trustedSignerRole: configurationInspection?.trustedSignerRole || null,
    trustedSignerAlgorithm: configurationInspection?.trustedSignerAlgorithm || null,
    trustedSignerPublicKeySpkiHash:
      configurationInspection?.trustedSignerPublicKeySpkiHash || null,
    trustedSignerTrustSetHash:
      configurationInspection?.trustedSignerTrustSetHash || null,
    injectedServicePairValid: injected ? pairReady : null,
    releaseSignerBindingVerified: signerBindingVerified,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    externalQualificationServiceInspectionHash:
      hashRecord('ExternalQualificationServiceInspection', payload),
  });
}
