import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function canonicalExternalQualificationTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp : null;
}

function releaseTrustMaterial(key) {
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

function releaseInspectionBoundToConfiguration(inspection, configuration) {
  const releaseKeys = Array.isArray(inspection?.trustedKeys) ? inspection.trustedKeys : [];
  const configured = configuration.trustedSigners.map(releaseTrustMaterial);
  const released = releaseKeys.map(releaseTrustMaterial).sort((left, right) => (
    `${left.keyId}:${left.keyVersion}`.localeCompare(`${right.keyId}:${right.keyVersion}`)
  ));
  const { researchExecutionReleaseAttestorConfigurationInspectionHash: claimedHash,
    ...inspectionPayload } = inspection || {};
  return inspection?.version === 1
    && inspection?.kind === 'ResearchExecutionReleaseAttestorConfigurationInspection'
    && inspection?.status === 'research_execution_release_attestor_ready'
    && inspection?.ready === true
    && inspection?.productionStatus === 'research_execution_release_attestor_production_ready'
    && inspection?.productionReady === true
    && inspection?.backendKind === 'external-kms-command'
    && inspection?.backendProductionEligible === true
    && inspection?.hardwareProtected === true
    && inspection?.privateKeyExportable === false
    && inspection?.externalSignerProcess === true
    && inspection?.independentBackendProbeVerified === true
    && inspection?.activeSignerChallengeVerified === true
    && /^sha256:[0-9a-f]{64}$/i.test(String(
      inspection?.activeSignerChallengeSigningPayloadHash || '',
    ))
    && /^sha256:[0-9a-f]{64}$/i.test(String(
      inspection?.activeSignerChallengeVerificationHash || '',
    ))
    && Array.isArray(inspection?.blockers) && inspection.blockers.length === 0
    && Array.isArray(inspection?.productionBlockers)
    && inspection.productionBlockers.length === 0
    && hashRecord('ResearchExecutionReleaseAttestorConfigurationInspection', inspectionPayload)
      === claimedHash
    && JSON.stringify(configured) === JSON.stringify(released);
}

export function verifyExternalQualificationReleaseSignerAuthority({
  inspection,
  configuration,
  signer,
  signedAt,
  freshlyIssued = false,
} = {}) {
  if (!releaseInspectionBoundToConfiguration(inspection, configuration)) return false;
  const signedAtMs = canonicalExternalQualificationTimestamp(signedAt);
  const activeEffectiveFrom = canonicalExternalQualificationTimestamp(inspection.effectiveFrom);
  if (signedAtMs === null || activeEffectiveFrom === null) return false;
  const key = inspection.trustedKeys.find((candidate) => (
    candidate?.keyId === signer?.keyId
      && candidate?.keyVersion === signer?.keyVersion
      && candidate?.subjectId === signer?.subjectId
      && (candidate?.organization || null) === (signer?.organization || null)
      && candidate?.role === signer?.role
      && candidate?.algorithm === signer?.algorithm
  ));
  const keyEffectiveFrom = canonicalExternalQualificationTimestamp(key?.effectiveFrom);
  const keyExpiresAt = canonicalExternalQualificationTimestamp(key?.expiresAt);
  if (!key || key.revokedAt !== null
    || keyEffectiveFrom === null || keyExpiresAt === null
    || signedAtMs < keyEffectiveFrom || signedAtMs >= keyExpiresAt) return false;
  const isCurrentActive = key.keyId === inspection.keyId
    && key.keyVersion === inspection.keyVersion
    && key.publicKeySpkiHash === inspection.publicKeySpkiHash
    && key.status === 'active';
  if (freshlyIssued) return isCurrentActive;
  return isCurrentActive || (key.status === 'retiring' && signedAtMs < activeEffectiveFrom);
}
