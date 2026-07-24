import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord(
  'AutonomousExternalQualificationTestHash',
  { label },
);

export function productionReleaseInspection({ trustedKeys, activeKey }) {
  const payload = {
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfigurationInspection',
    status: 'research_execution_release_attestor_ready',
    ready: true,
    productionStatus: 'research_execution_release_attestor_production_ready',
    productionReady: true,
    inspectedAt: '2026-07-15T12:30:00.000Z',
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
    trustSetHash: hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
      version: 1,
      keys: trustedKeys,
    }),
    trustedKeys,
    backendKind: 'external-kms-command',
    backendProductionEligible: true,
    hardwareProtected: true,
    privateKeyExportable: false,
    externalSignerProcess: true,
    independentBackendProbeVerified: true,
    activeSignerChallengeVerified: true,
    activeSignerChallengeSigningPayloadHash:
      H('release-active-signer-challenge-payload'),
    activeSignerChallengeVerificationHash:
      H('release-active-signer-challenge-verification'),
    blockers: [],
    productionBlockers: [],
  };
  return Object.freeze({
    ...payload,
    researchExecutionReleaseAttestorConfigurationInspectionHash: hashRecord(
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      payload,
    ),
  });
}
