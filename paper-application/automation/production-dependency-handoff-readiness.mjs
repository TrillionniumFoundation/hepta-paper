const SHA256 = /^sha256:[0-9a-f]{64}$/i;

const REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES = Object.freeze([
  'advanced_numerical_oracle_authority',
  'advanced_numerical_replay_authority',
  'advanced_numerical_scientific_reviewer',
  'advanced_numerical_uncertainty_reviewer',
]);

const ADVANCED_NUMERICAL_HASH_FIELDS = Object.freeze([
  'registryHash',
  'runtimeConfigurationHash',
  'entrypointHash',
  'sourceMerkleHash',
  'sourceWorkspaceManifestHash',
  'candidateManifestHash',
  'runtimeExecutableHash',
  'runtimePackageClosureHash',
  'signedBundleHash',
  'qualificationStatementHash',
  'qualificationEvidenceBundleHash',
  'qualificationInspectionHash',
  'referenceExecutionProcessIdentityHash',
  'replayExecutionProcessIdentityHash',
  'qualificationResultHash',
]);

const REQUIRED_ADVANCED_NUMERICAL_EVIDENCE_RECEIPT_HASH_FIELDS = Object.freeze([
  'independentNumericOracleReceiptHash',
  'referenceExecutionReceiptHash',
  'replayExecutionReceiptHash',
  'scientificReviewReceiptHash',
  'typedUncertaintyReviewReceiptHash',
]);

const SUBMISSION_READINESS_HASH_FIELDS = Object.freeze([
  'planHash',
  'challengeHash',
  'cycleReceiptHash',
  'portalConfigurationHash',
  'portalDescriptorHash',
  'livePortalCanaryCycleVerificationReceiptHash',
  'livePortalCanaryIndependentVerificationReceiptHash',
]);

function distinctNonemptyStrings(values, minimumLength = 1) {
  return Array.isArray(values)
    && values.length >= minimumLength
    && values.every((value) => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length;
}

function canonicalOrganization(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalOrganizations(values) {
  return Array.isArray(values) ? values.map(canonicalOrganization) : null;
}

/**
 * Automation status is a derived snapshot and can be stale. The handoff is
 * the final downstream gate before external submission, so a top-level ready
 * boolean is insufficient without the inspector's complete projection.
 */
export function submissionDispatcherReadinessCurrent(readiness, observedAt) {
  const inspection = readiness?.autonomousSubmissionDispatcherReadiness;
  const observedMs = observedAt instanceof Date
    ? observedAt.getTime() : Date.parse(String(observedAt || ''));
  const signedAtMs = Date.parse(String(inspection?.signedAt || ''));
  const expiresAtMs = Date.parse(String(inspection?.expiresAt || ''));
  return readiness?.autonomousSubmissionDispatcherReady === true
    && readiness?.autonomousSubmissionHandoffReady === true
    && inspection?.version === 1
    && inspection?.kind === 'AutonomousSubmissionDispatcherReadinessInspection'
    && inspection?.status === 'autonomous_submission_dispatcher_ready'
    && inspection?.ready === true
    && inspection?.handoffReady === true
    && inspection?.signatureVerified === true
    && inspection?.portalBindingVerified === true
    && inspection?.livePortalCanaryVerified === true
    && inspection?.portalConfigurationIdentityPinned === true
    && inspection?.portalDescriptorPinned === true
    && inspection?.portalFullProductionReady === true
    && inspection?.livePortalCanaryAuthorityIndependentFromDispatcher === true
    && typeof inspection?.portalId === 'string'
    && inspection.portalId.length > 0
    && typeof inspection?.dispatcherPrincipalId === 'string'
    && inspection.dispatcherPrincipalId.length > 0
    && Array.isArray(inspection?.blockers)
    && inspection.blockers.length === 0
    && SUBMISSION_READINESS_HASH_FIELDS.every((field) => (
      SHA256.test(String(inspection?.[field] || ''))
    ))
    && Number.isFinite(observedMs)
    && Number.isFinite(signedAtMs)
    && Number.isFinite(expiresAtMs)
    && signedAtMs <= observedMs
    && observedMs < expiresAtMs;
}

export function advancedNumericalCandidateReady(
  candidate,
  analysisFamily,
  observedAt,
) {
  const observedMs = observedAt instanceof Date
    ? observedAt.getTime() : Date.parse(String(observedAt || ''));
  const expiresAtMs = Date.parse(String(candidate?.qualificationExpiresAt || ''));
  const pluginSubjects = candidate?.pluginAuthoritySubjectIds;
  const qualificationSubjects = candidate?.qualificationAuthoritySubjectIds;
  const pluginOrganizations = candidate?.pluginAuthorityOrganizations;
  const qualificationOrganizations = candidate?.qualificationAuthorityOrganizations;
  const pluginPublicKeys = candidate?.pluginAuthorityPublicKeySpkiHashes;
  const qualificationPublicKeys = candidate?.qualificationAuthorityPublicKeySpkiHashes;
  const qualificationRoles = candidate?.qualificationAuthorityRoles;
  const evidenceReceiptHashes = candidate?.evidenceReceiptHashes;
  const canonicalPluginOrganizations = canonicalOrganizations(pluginOrganizations);
  const canonicalQualificationOrganizations = canonicalOrganizations(
    qualificationOrganizations,
  );
  const pluginSubjectSet = new Set(pluginSubjects || []);
  const pluginOrganizationSet = new Set(canonicalPluginOrganizations || []);
  const pluginPublicKeySet = new Set(pluginPublicKeys || []);
  const evidenceReceiptHashValues = REQUIRED_ADVANCED_NUMERICAL_EVIDENCE_RECEIPT_HASH_FIELDS
    .map((field) => evidenceReceiptHashes?.[field]);
  return candidate?.pluginId === `hepta.reference.${analysisFamily}`
    && candidate?.pluginVersion === '1.0.0'
    && candidate?.analysisFamily === analysisFamily
    && candidate?.status === 'reference_candidate_full_production_qualified'
    && candidate?.productionQualified === true
    && candidate?.fullProductionReady === true
    && candidate?.registryConfigured === true
    && candidate?.registryPinned === true
    && candidate?.runtimeConfigurationPinned === true
    && candidate?.dependentDocumentsPinned === true
    && candidate?.entrypoint === 'worker.py'
    && Array.isArray(candidate?.qualificationBlockers)
    && candidate.qualificationBlockers.length === 0
    && ADVANCED_NUMERICAL_HASH_FIELDS.every((field) => (
      SHA256.test(String(candidate?.[field] || ''))
    ))
    && distinctNonemptyStrings(pluginSubjects)
    && pluginSubjects.length === 1
    && distinctNonemptyStrings(canonicalPluginOrganizations)
    && canonicalPluginOrganizations.length === 1
    && distinctNonemptyStrings(pluginPublicKeys)
    && pluginPublicKeys.length === 1
    && pluginPublicKeys.every((value) => SHA256.test(value))
    && distinctNonemptyStrings(
      qualificationSubjects,
      REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES.length,
    )
    && qualificationSubjects.length
      === REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES.length
    && qualificationSubjects.every((value) => !pluginSubjectSet.has(value))
    && distinctNonemptyStrings(
      canonicalQualificationOrganizations,
      REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES.length,
    )
    && canonicalQualificationOrganizations.length
      === REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES.length
    && canonicalQualificationOrganizations.every((value) => !pluginOrganizationSet.has(value))
    && distinctNonemptyStrings(
      qualificationPublicKeys,
      REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES.length,
    )
    && qualificationPublicKeys.length
      === REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES.length
    && qualificationPublicKeys.every((value) => SHA256.test(value)
      && !pluginPublicKeySet.has(value))
    && JSON.stringify(qualificationRoles)
      === JSON.stringify(REQUIRED_ADVANCED_NUMERICAL_QUALIFICATION_ROLES)
    && evidenceReceiptHashes !== null
    && typeof evidenceReceiptHashes === 'object'
    && !Array.isArray(evidenceReceiptHashes)
    && JSON.stringify(Object.keys(evidenceReceiptHashes).sort())
      === JSON.stringify([...REQUIRED_ADVANCED_NUMERICAL_EVIDENCE_RECEIPT_HASH_FIELDS].sort())
    && evidenceReceiptHashValues.every((value) => SHA256.test(String(value || '')))
    && new Set(evidenceReceiptHashValues).size
      === REQUIRED_ADVANCED_NUMERICAL_EVIDENCE_RECEIPT_HASH_FIELDS.length
    && Number.isFinite(observedMs)
    && Number.isFinite(expiresAtMs)
    && observedMs < expiresAtMs
    && candidate.referenceExecutionProcessIdentityHash
      !== candidate.replayExecutionProcessIdentityHash;
}
