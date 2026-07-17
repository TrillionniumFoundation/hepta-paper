function unique(values) {
  return Object.freeze([...new Set((values || []).filter(Boolean))]);
}

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function evaluateAutomationReadiness({
  runtimes = {},
  campaignQueryReady = false,
  nodeQueryReady = false,
  campaignStoreSchema = null,
  campaignStoreSchemaBlockers = [],
  operationalIntegrity = null,
  researchExecutionReleaseAttestor = null,
  runtimeImageReproducibility = null,
  fullResearchQualification = null,
  liveProviderCanaryRequired = false,
} = {}) {
  const agent = runtimes.agent || {};
  const sandbox = runtimes.sandbox || {};
  const automationRuntimeReady = agent.usable === true
    && runtimes.python?.usable === true
    && runtimes.latex?.usable === true
    && sandbox.usable === true;
  const academicEmpiricalReady = sandbox.academicEmpiricalReady === true;
  const academicEmpiricalReadinessReason = sandbox.academicEmpiricalReadinessReason
    || 'academic_empirical_readiness_not_reported';
  const campaignStoreReady = campaignQueryReady === true
    && nodeQueryReady === true
    && campaignStoreSchema?.status === 'scoped_schema_version_verified'
    && campaignStoreSchemaBlockers.length === 0
    && operationalIntegrity?.queryReady === true;
  const fullAutomaticResearchWritingRuntimePreflightReady = automationRuntimeReady
    && agent.researchAuthorConfigurationPreflightReady === true
    && agent.formalReviewConfigurationIndependentPrincipalReady === true
    && academicEmpiricalReady
    && researchExecutionReleaseAttestor?.ready === true
    && researchExecutionReleaseAttestor?.productionReady === true
    && runtimeImageReproducibility?.ready === true
    && runtimes.lean?.usable === true;
  const independentHypothesisPriorArtQualificationReady =
    fullResearchQualification?.independentHypothesisPriorArtReviewVerified === true
    && SHA256.test(String(
      fullResearchQualification?.independentHypothesisPriorArtReceiptHash || '',
    ));
  const fullResearchQualificationReady = fullResearchQualification?.ready === true
    && independentHypothesisPriorArtQualificationReady;
  const liveProviderCanaryReady = agent.researchAuthorProviderAvailable === true
    && agent.formalReviewProviderAvailable === true;
  const providersReady = liveProviderCanaryRequired
    ? liveProviderCanaryReady
    : liveProviderCanaryReady || fullResearchQualification?.ready === true;
  const operationalIntegrityReady = operationalIntegrity?.degraded === false;
  const fullAutomaticResearchWritingReady = fullAutomaticResearchWritingRuntimePreflightReady
    && providersReady
    && campaignStoreReady
    && operationalIntegrityReady
    && fullResearchQualificationReady;
  const campaignFullyQualified = fullAutomaticResearchWritingReady;
  const blockers = unique([
    ...(!automationRuntimeReady ? ['automation_runtime_not_ready'] : []),
    ...(!campaignStoreReady ? ['campaign_store_not_ready'] : []),
    ...(operationalIntegrity?.degraded === true ? ['automation_operational_integrity_degraded'] : []),
    ...(!agent.researchAuthorConfigurationPreflightReady ? ['research_author_configuration_not_ready'] : []),
    ...(!agent.formalReviewConfigurationIndependentPrincipalReady ? ['formal_review_independent_principal_not_ready'] : []),
    ...(!academicEmpiricalReady ? [academicEmpiricalReadinessReason] : []),
    ...(researchExecutionReleaseAttestor?.ready !== true ? ['research_execution_release_attestor_not_ready'] : []),
    ...(researchExecutionReleaseAttestor?.productionReady !== true
      ? ['research_execution_release_attestor_production_backend_not_ready'] : []),
    ...(runtimeImageReproducibility?.ready !== true
      ? ['runtime_image_reproducibility_not_ready'] : []),
    ...(runtimeImageReproducibility?.blockers || []),
    ...(runtimes.lean?.usable !== true ? ['lean_runtime_not_ready'] : []),
    ...(!providersReady ? ['qualified_provider_canaries_not_ready'] : []),
    ...(!independentHypothesisPriorArtQualificationReady
      ? ['independent_hypothesis_prior_art_qualification_not_ready'] : []),
    ...(fullResearchQualification?.blockers || []),
  ]);
  return Object.freeze({
    version: 1,
    kind: 'AutomationReadinessEvaluation',
    status: !automationRuntimeReady
      ? 'automation_plane_runtime_blocked'
      : !campaignStoreReady
        ? 'automation_plane_store_blocked'
        : !operationalIntegrityReady
          ? 'automation_plane_runtime_degraded'
          : 'automation_plane_runtime_ready',
    automationRuntimeReady,
    automationOperationalReady: automationRuntimeReady && campaignStoreReady && operationalIntegrityReady,
    academicEmpiricalReady,
    academicEmpiricalReadinessReason,
    campaignStoreReady,
    fullAutomaticResearchWritingRuntimePreflightReady,
    independentHypothesisPriorArtQualificationReady,
    fullResearchQualificationReady,
    liveProviderCanaryRequired,
    liveProviderCanaryReady,
    campaignFullyQualified,
    fullAutomaticResearchWritingReady,
    fullAutomaticResearchWritingStatus: fullAutomaticResearchWritingReady
      ? 'full_automatic_research_writing_runtime_ready'
      : fullAutomaticResearchWritingRuntimePreflightReady
          && providersReady
          && campaignStoreReady
          && operationalIntegrityReady
        ? 'full_automatic_research_writing_qualification_blocked'
        : 'full_automatic_research_writing_runtime_blocked',
    blockers,
  });
}

export function automationReadinessExitCode(evaluation, {
  requireFullResearch = false,
  requireFullyAutonomous = false,
  fullyAutonomousResearchSystemReady = false,
} = {}) {
  if (evaluation?.automationRuntimeReady !== true || evaluation?.campaignStoreReady !== true) return 1;
  if (evaluation?.automationOperationalReady !== true) return 2;
  if (requireFullResearch && evaluation?.fullAutomaticResearchWritingReady !== true) return 3;
  if (requireFullyAutonomous && fullyAutonomousResearchSystemReady !== true) return 4;
  return 0;
}
