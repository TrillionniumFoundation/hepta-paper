import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord(
  'AutonomousExternalQualificationTestHash',
  { label },
);

export function productionReleaseInspection({ trustedKeys, activeKey }) {
  const trustSetHash = hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
    version: 1,
    keys: trustedKeys,
  });
  const backendProbeAttestorPublicKeySpkiHash =
    H('release-backend-probe-attestor-public-key');
  const backendDescriptorHash = hashRecord(
    'ResearchExecutionReleaseSignerBackendDescriptor',
    {
      version: 1,
      kind: 'ResearchExecutionReleaseSignerBackendDescriptor',
      backendKind: 'external-kms-command',
      backendId: 'release-kms:test',
      backendVersion: 'v1',
      algorithm: 'ed25519',
      hardwareProtected: true,
      privateKeyExportable: false,
      externalSignerProcess: true,
      productionEligible: true,
      kmsProvider: 'external-kms-test',
      providerAccountIdentityHash: H('release-kms-provider-account'),
      keyResourceIdentityHash: H('release-kms-key-resource'),
      credentialGenerationIdentityHash:
        H('release-kms-credential-generation'),
      activeKeyId: activeKey.keyId,
      activeKeyVersion: activeKey.keyVersion,
      activePublicKeySpkiHash: activeKey.publicKeySpkiHash,
      trustSetHash,
      commandIdentityHash: H('release-kms-command'),
      probeCommandIdentityHash: H('release-kms-probe-command'),
      probeAttestorPublicKeySpkiHash: backendProbeAttestorPublicKeySpkiHash,
      credentialMaterialReadByMainProcess: false,
    },
  );
  const payload = {
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfigurationInspection',
    status: 'research_execution_release_attestor_ready',
    ready: true,
    productionStatus: 'research_execution_release_attestor_production_ready',
    productionReady: true,
    fullProductionStatus:
      'research_execution_release_attestor_full_production_ready',
    fullProductionReady: true,
    inspectedAt: '2026-07-15T12:30:00.000Z',
    liveVerificationCompletedAt: '2026-07-15T12:30:00.000Z',
    keyId: activeKey.keyId,
    keyVersion: activeKey.keyVersion,
    subjectId: activeKey.subjectId,
    organization: activeKey.organization,
    role: activeKey.role,
    algorithm: activeKey.algorithm,
    publicKeySpkiHash: activeKey.publicKeySpkiHash,
    effectiveFrom: activeKey.effectiveFrom,
    expiresAt: activeKey.expiresAt,
    trustSetVersion: 1,
    trustSetHash,
    trustedKeys,
    configurationFileHash: H('release-attestor-configuration-file'),
    configurationIdentityHash: H('release-attestor-configuration-identity'),
    configurationIdentityProfile:
      'stable-kms-authority-policy-and-rotating-bundle-v3',
    configurationPinned: true,
    kmsHardwareAuthorityAttestationReady: true,
    kmsHardwareAuthorityAttestationInspectionHash:
      H('release-kms-hardware-authority-inspection'),
    kmsHardwareAuthorityAttestationBundleHash:
      H('release-kms-hardware-authority-bundle'),
    kmsHardwareAuthorityAttestationSubjectHash:
      H('release-kms-hardware-authority-subject'),
    kmsHardwareAuthorityTrustStoreHash:
      H('release-kms-hardware-authority-trust-store'),
    kmsHardwareAuthorityVerificationReceiptHash:
      H('release-kms-hardware-authority-verification'),
    kmsHardwareAuthorityAttestedAt: '2026-07-15T12:29:00.000Z',
    kmsHardwareAuthorityExpiresAt: '2026-07-15T12:35:00.000Z',
    kmsHardwareAuthorityIndependent: true,
    kmsHardwareAuthorityVerifiedKeyIds: ['release-kms-hardware-authority-key'],
    kmsHardwareAuthorityBlockers: [],
    kmsProvider: 'external-kms-test',
    kmsProviderAccountIdentityHash: H('release-kms-provider-account'),
    kmsKeyResourceIdentityHash: H('release-kms-key-resource'),
    kmsCredentialGenerationIdentityHash:
      H('release-kms-credential-generation'),
    backendKind: 'external-kms-command',
    backendId: 'release-kms:test',
    backendVersion: 'v1',
    backendProductionEligible: true,
    backendDescriptorHash,
    backendCommandIdentityHash: H('release-kms-command'),
    backendProbeCommandIdentityHash: H('release-kms-probe-command'),
    hardwareProtected: true,
    privateKeyExportable: false,
    externalSignerProcess: true,
    privateKeyLoadedIntoMainProcess: false,
    credentialMaterialReadByMainProcess: false,
    independentBackendProbeVerified: true,
    backendProbeAttestationHash: H('release-backend-probe-attestation'),
    backendProbeAttestorKeyId: 'release-probe:test',
    backendProbeAttestorKeyVersion: 'v1',
    backendProbeAttestorPublicKeySpkiHash,
    activeSignerChallengeVerified: true,
    activeSignerChallengeSigningPayloadHash:
      H('release-active-signer-challenge-payload'),
    activeSignerChallengeVerificationHash:
      H('release-active-signer-challenge-verification'),
    privateKeyDisclosed: false,
    blockers: [],
    productionBlockers: [],
    fullProductionBlockers: [],
  };
  return Object.freeze({
    ...payload,
    researchExecutionReleaseAttestorConfigurationInspectionHash: hashRecord(
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      payload,
    ),
  });
}
