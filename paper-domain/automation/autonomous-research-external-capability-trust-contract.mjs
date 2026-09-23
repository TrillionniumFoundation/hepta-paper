import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

const COMPONENTS = Object.freeze([
  'priorArt',
  'reviewerPool',
  'externalReplay',
  'submissionPortal',
]);

function canonicalHash(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}
function componentInspection(componentId, value, {
  requiredEvidenceProfile = null,
} = {}) {
  const productionConfigurationRequired = [
    'prior_art', 'external_replay', 'submission_portal',
  ].includes(componentId);
  const freshReviewerSessionReady = componentId === 'reviewer_pool'
    && value?.authorityMode === 'fresh-isolated-session'
    && value?.sessionIsolationReady === true
    && value?.identityIndependenceReady === true;
  const cryptographicAuthorityReady = value?.cryptographicAuthorityReady === true;
  const identityIndependenceReady = value?.identityIndependenceReady === true;
  const configurationPinned = value?.configurationPinned === true;
  const crashRecoveryReady = value?.crashRecoveryReady === true;
  const fullProductionReady = value?.fullProductionReady === true;
  const trustSetHash = canonicalHash(value?.trustSetHash);
  const signatureVerificationPolicyHash = canonicalHash(
    value?.signatureVerificationPolicyHash,
  );
  const evidenceProfile = requiredEvidenceProfile
    ? String(value?.evidenceProfile || '') || null : null;
  const blockers = [];
  if (requiredEvidenceProfile && evidenceProfile !== requiredEvidenceProfile) {
    blockers.push(`autonomous_research_${componentId}_evidence_profile_not_ready`);
  }
  if (!cryptographicAuthorityReady && !freshReviewerSessionReady) {
    blockers.push(`autonomous_research_${componentId}_cryptographic_authority_not_ready`);
  }
  if (!identityIndependenceReady) {
    blockers.push(`autonomous_research_${componentId}_identity_independence_not_ready`);
  }
  if (!trustSetHash && !freshReviewerSessionReady) {
    blockers.push(`autonomous_research_${componentId}_trust_set_not_bound`);
  }
  if (!signatureVerificationPolicyHash && !freshReviewerSessionReady) {
    blockers.push(`autonomous_research_${componentId}_signature_policy_not_bound`);
  }
  if (productionConfigurationRequired && !configurationPinned) {
    blockers.push(`autonomous_research_${componentId}_configuration_not_pinned`);
  }
  if (componentId === 'external_replay' && !crashRecoveryReady) {
    blockers.push('autonomous_research_external_replay_crash_recovery_not_ready');
  }
  if (productionConfigurationRequired && !fullProductionReady) {
    blockers.push(`autonomous_research_${componentId}_full_production_not_ready`);
  }
  if (fullProductionReady
    && (!configurationPinned
      || !cryptographicAuthorityReady
      || !identityIndependenceReady
      || (componentId === 'external_replay' && !crashRecoveryReady))) {
    blockers.push(`autonomous_research_${componentId}_full_production_claim_invalid`);
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    componentId,
    evidenceProfile,
    requiredEvidenceProfile,
    cryptographicAuthorityReady,
    identityIndependenceReady,
    configurationPinned,
    crashRecoveryReady,
    fullProductionReady,
    trustSetHash,
    signatureVerificationPolicyHash,
    authorityMode: freshReviewerSessionReady
      ? 'fresh-isolated-session' : 'external-cryptographic-authority',
    sessionIsolationReady: freshReviewerSessionReady,
    ready: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
  });
}

export function buildAutonomousResearchExternalCapabilityTrustInspection({
  priorArt = null,
  reviewerPool = null,
  externalReplay = null,
  submissionPortal = null,
} = {}) {
  const components = Object.freeze({
    priorArt: componentInspection('prior_art', priorArt, {
      requiredEvidenceProfile: 'structured-ranked-deduplicated-v2',
    }),
    reviewerPool: componentInspection('reviewer_pool', reviewerPool),
    externalReplay: componentInspection('external_replay', externalReplay),
    submissionPortal: componentInspection('submission_portal', submissionPortal),
  });
  const blockers = Object.freeze(COMPONENTS.flatMap((component) => (
    components[component].blockers
  )));
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchExternalCapabilityTrustInspection',
    status: blockers.length
      ? 'autonomous_research_external_capability_trust_blocked'
      : 'autonomous_research_external_capability_trust_ready',
    ready: blockers.length === 0,
    components,
    blockers,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchExternalCapabilityTrustInspectionHash: hashRecord(
      'AutonomousResearchExternalCapabilityTrustInspection',
      payload,
    ),
  });
}

export function verifyAutonomousResearchExternalCapabilityTrustInspection(inspection) {
  let rebuilt = null;
  try {
    rebuilt = buildAutonomousResearchExternalCapabilityTrustInspection({
      priorArt: inspection?.components?.priorArt,
      reviewerPool: inspection?.components?.reviewerPool,
      externalReplay: inspection?.components?.externalReplay,
      submissionPortal: inspection?.components?.submissionPortal,
    });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(inspection);
}
