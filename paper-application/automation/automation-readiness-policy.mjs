import {
  BOUNDED_CAPABILITY_QUALIFICATION_SCOPE,
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';

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
  const boundedGoldenInfrastructureQualificationReady = fullResearchQualificationReady
    && fullResearchQualification?.qualificationScope
      === BOUNDED_CAPABILITY_QUALIFICATION_SCOPE
    && fullResearchQualification?.genericContentCanaryVerified === true;
  const productionGenericResearchQualificationReady = fullResearchQualificationReady
    && fullResearchQualification?.qualificationScope
      === PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE;
  const autonomousQualificationAuthorityReady =
    boundedGoldenInfrastructureQualificationReady
    || productionGenericResearchQualificationReady;
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
    && autonomousQualificationAuthorityReady;
  const campaignFullyQualified = fullAutomaticResearchWritingReady
    && productionGenericResearchQualificationReady;
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
    ...(!autonomousQualificationAuthorityReady
      ? ['generic_content_qualification_authority_not_ready'] : []),
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
    boundedGoldenInfrastructureQualificationReady,
    productionGenericResearchQualificationReady,
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

export function evaluateAutomationReadinessLevels({
  runtimeReady = false,
  runtimeStatus = null,
  boundedProfileReady = false,
  configuredScopeReady = false,
  genericCapabilityReady = false,
  formalSandboxRuntimeReady = false,
  dynamicFormalProjectClosureReady = false,
  submissionDispatcherReady = false,
} = {}) {
  const effectiveRuntimeReady = runtimeReady === true;
  const effectiveBoundedProfileReady = effectiveRuntimeReady
    && boundedProfileReady === true;
  const effectiveConfiguredScopeReady = effectiveBoundedProfileReady
    && configuredScopeReady === true;
  const genericResearchReady = effectiveBoundedProfileReady
    && effectiveConfiguredScopeReady
    && genericCapabilityReady === true
    && formalSandboxRuntimeReady === true
    && dynamicFormalProjectClosureReady === true;
  const productionReady = genericResearchReady
    && submissionDispatcherReady === true;
  const blockedRuntimeStatus = runtimeStatus
    && runtimeStatus !== 'automation_plane_runtime_ready'
    ? runtimeStatus
    : 'automation_plane_runtime_blocked';
  return Object.freeze({
    version: 1,
    kind: 'AutomationReadinessLevels',
    status: !effectiveRuntimeReady
      ? blockedRuntimeStatus
      : !effectiveBoundedProfileReady
        ? 'automation_plane_bounded_profile_blocked'
        : !genericResearchReady
          ? 'automation_plane_generic_research_blocked'
          : !productionReady
            ? 'automation_plane_production_blocked'
            : 'automation_plane_production_ready',
    runtimeReady: effectiveRuntimeReady,
    boundedProfileReady: effectiveBoundedProfileReady,
    configuredScopeReady: effectiveConfiguredScopeReady,
    genericResearchReady,
    productionReady,
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
