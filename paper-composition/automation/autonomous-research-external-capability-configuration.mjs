import {
  STRONG_PRIOR_ART_CAPABILITY_MODE,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  verifyAutonomousVenueTemplateAssetBundle,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';

export function autonomousResearchExternalCapabilityErrorCode(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 512);
}

export function autonomousSubmissionRequestVerifierReady(value) {
  return value?.version === 1
    && value?.kind === 'AutonomousSubmissionRequestVerifier'
    && typeof value.verify === 'function';
}

export function configuredAutonomousResearchPriorArtMode(port) {
  if (!port) return 'opaque-hash-v1';
  return port.evidenceProfile === STRONG_PRIOR_ART_CAPABILITY_MODE
    ? STRONG_PRIOR_ART_CAPABILITY_MODE : 'structured-receipt-v1';
}

export function autonomousResearchReviewerTrustSurface(inspection) {
  return inspection ? Object.freeze({
    ...(inspection.pool || {}),
    ...inspection,
  }) : null;
}

export function autonomousResearchLocalOriginIdentitySubjectHashes(port) {
  const subjects = port?.identitySeparationInspection?.localOriginIdentitySubjects
    || port?.receiptVerifier?.identitySeparationInspection?.localOriginIdentitySubjects
    || [];
  return subjects.map((subject) => (
    subject?.externalPrincipalIdentityAttestationSubjectHash || null
  )).filter(Boolean);
}

export function autonomousResearchVenueConfiguration(value) {
  if (value?.kind === 'VerifiedAutonomousVenueProfileRegistryConfiguration') {
    return Object.freeze({
      registry: value.registry,
      authority: value,
      templateAssetBundle: value.templateAssetBundle || null,
    });
  }
  return Object.freeze({
    registry: value || null,
    authority: null,
    templateAssetBundle: null,
  });
}

export function autonomousResearchVenueTemplateAssetsReady(registry, templateAssetBundle) {
  const required = registry?.profiles?.some((profile) => (
    profile.version === 3 && profile.externalSubmissionEnabled === true
  )) === true;
  return !required || verifyAutonomousVenueTemplateAssetBundle(
    templateAssetBundle,
    { registry },
  );
}

export function autonomousResearchMetadataConfiguration(value) {
  if (value?.kind === 'VerifiedAutonomousSubmissionMetadataProfileConfiguration') {
    return Object.freeze({ profile: value.profile, authority: value });
  }
  return Object.freeze({ profile: value || null, authority: null });
}

export function autonomousResearchSignedConfigurationReady(value) {
  return value?.configurationPinned === true
    && value?.cryptographicAuthorityReady === true
    && /^sha256:[0-9a-f]{64}$/.test(String(value?.configurationHash || ''))
    && /^sha256:[0-9a-f]{64}$/.test(String(value?.trustSetHash || ''))
    && /^sha256:[0-9a-f]{64}$/.test(String(
      value?.signatureVerificationPolicyHash || '',
    ));
}

export function autonomousResearchExternalReplayVerificationSurface(verifier) {
  if (verifier?.kind !== 'ExternalResearchReplayReceiptVerifier'
    || typeof verifier.verify !== 'function') return null;
  return Object.freeze({
    version: verifier.version,
    kind: verifier.kind,
    configurationHash: verifier.configurationHash,
    cryptographicAuthorityReady: verifier.cryptographicAuthorityReady === true,
    identityIndependenceReady: verifier.identityIndependenceReady === true,
    trustSetHash: verifier.trustSetHash,
    signatureVerificationPolicyHash: verifier.signatureVerificationPolicyHash,
    verify: (input) => verifier.verify(input),
  });
}

export function activeAutonomousResearchProductionEmpiricalFamilies() {
  const families = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles
    .filter((profile) => profile.productionExecutable === true)
    .map((profile) => profile.benchmarkFamily)
    .sort();
  if (AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified !== true
    || families.length === 0 || new Set(families).size !== families.length) {
    throw new Error('autonomous_research_active_empirical_family_registry_invalid');
  }
  return Object.freeze(families);
}
