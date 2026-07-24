import {
  resolvePersistedAutonomousResearchLaunchMode,
  resolveAutonomousResearchProviderPricing,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';

function workerOptions(worker = {}) {
  return Object.freeze({
    concurrency: Number(worker.concurrency || 8),
    agentSlots: Number(worker.agentSlots || 4),
    cpuSlots: Number(worker.cpuSlots || 4),
    gpuSlots: Number(worker.gpuSlots || 1),
    memoryMiB: Number(worker.memoryMiB || 8192),
    agentProvider: worker.agentProvider,
    model: worker.model,
    formalReviewProvider: worker.formalReviewProvider,
    formalReviewModel: worker.formalReviewModel,
    formalReviewCodexBinary: worker.formalReviewCodexBinary,
    formalReviewCodexHome: worker.formalReviewCodexHome,
    codexHome: worker.codexHome,
    codexBinary: worker.codexBinary,
  });
}

function configuredMaximumCost(environment, role) {
  return environment[`HEPTA_${role}_MAXIMUM_COST_PER_CALL_USD`]
    ?? environment[`HEPTA_${role}_MAX_COST_PER_CALL_USD`]
    ?? null;
}

export function resolveAutonomousResearchSupervisorDispatchPolicy(campaign) {
  return resolvePersistedAutonomousResearchLaunchMode({ campaign });
}

export function prepareAutonomousResearchSupervisorProvider({
  worker,
  environment,
} = {}) {
  const options = workerOptions(worker);
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: Object.fromEntries(Object.entries({
      'agent-provider': options.agentProvider,
      model: options.model,
      'formal-review-provider': options.formalReviewProvider,
      'formal-review-model': options.formalReviewModel,
      'formal-review-codex-binary': options.formalReviewCodexBinary,
      'formal-review-codex-home': options.formalReviewCodexHome,
      'codex-home': options.codexHome,
      'codex-binary': options.codexBinary,
    }).filter(([, value]) => value !== undefined && value !== null)),
    environment,
  });
  return Object.freeze({ options, providerConfiguration });
}

export function resolveAutonomousResearchSupervisorLifecycleCostEnvelope({
  environment,
  lifecyclePolicy = {},
  externalQualificationConfiguration = null,
  providerConfiguration,
} = {}) {
  const pricing = resolveAutonomousResearchProviderPricing({
    researchAuthorProvider: providerConfiguration.researchAuthor.provider,
    researchAuthorModel: providerConfiguration.researchAuthor.model,
    formalReviewerProvider: providerConfiguration.formalReviewer.provider,
    formalReviewerModel: providerConfiguration.formalReviewer.model,
    researchAuthorMaximumCostPerCallUsd:
      configuredMaximumCost(environment, 'RESEARCH_AUTHOR'),
    formalReviewerMaximumCostPerCallUsd:
      configuredMaximumCost(environment, 'FORMAL_REVIEWER'),
  });
  if (pricing.pricingKnown !== true) {
    throw new Error('autonomous_research_supervisor_provider_pricing_required');
  }
  const pairMaximum = Number(pricing.providerCanaryPairMaximumCostUsd);
  const qualificationMaximumTotalCostUsd = Number(
    lifecyclePolicy.qualificationMaximumTotalCostUsd ?? 25,
  );
  const configuredQualificationAttemptMaximumCostUsd = Number(
    externalQualificationConfiguration?.maximumQualificationCostUsd ?? 0,
  );
  if (!Number.isFinite(pairMaximum) || pairMaximum <= 0) {
    throw new Error('autonomous_research_supervisor_provider_canary_pricing_invalid');
  }
  if (!Number.isFinite(configuredQualificationAttemptMaximumCostUsd)
    || configuredQualificationAttemptMaximumCostUsd < 0
    || !Number.isFinite(qualificationMaximumTotalCostUsd)
    || qualificationMaximumTotalCostUsd < configuredQualificationAttemptMaximumCostUsd) {
    throw new Error('autonomous_research_supervisor_qualification_cost_envelope_insufficient');
  }
  const maximumLifecycleCostUsd = Number(lifecyclePolicy.maximumLifecycleCostUsd ?? 150);
  const requestedMaximumProviderCanaries = Number(
    lifecyclePolicy.maximumProviderCanaries ?? 64,
  );
  const affordableProviderCanaries = Math.floor(
    (maximumLifecycleCostUsd - qualificationMaximumTotalCostUsd) / pairMaximum,
  );
  if (!Number.isFinite(maximumLifecycleCostUsd) || maximumLifecycleCostUsd <= 0
    || !Number.isSafeInteger(requestedMaximumProviderCanaries)
    || requestedMaximumProviderCanaries < 1 || affordableProviderCanaries < 1) {
    throw new Error('autonomous_research_supervisor_provider_canary_cost_envelope_insufficient');
  }
  return Object.freeze({
    pairMaximum,
    effectiveLifecyclePolicy: Object.freeze({
      ...lifecyclePolicy,
      maximumProviderCanaries: Math.min(
        requestedMaximumProviderCanaries,
        affordableProviderCanaries,
      ),
      providerCanaryReservationCostUsd: pairMaximum,
      qualificationAttemptReservationCostUsd: Math.max(
        Number(lifecyclePolicy.qualificationAttemptReservationCostUsd || 0),
        configuredQualificationAttemptMaximumCostUsd,
      ),
    }),
  });
}
