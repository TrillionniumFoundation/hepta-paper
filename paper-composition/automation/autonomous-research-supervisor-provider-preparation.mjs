import {
  resolvePersistedAutonomousResearchLaunchMode,
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
  lifecyclePolicy = {},
  externalQualificationConfiguration = null,
} = {}) {
  const qualificationMaximumTotalCostUsd = Number(
    lifecyclePolicy.qualificationMaximumTotalCostUsd ?? 25,
  );
  const configuredQualificationAttemptMaximumCostUsd = Number(
    externalQualificationConfiguration?.maximumQualificationCostUsd ?? 0,
  );
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
  const providerCanaryBudgetUsd = maximumLifecycleCostUsd - qualificationMaximumTotalCostUsd;
  if (!Number.isFinite(maximumLifecycleCostUsd) || maximumLifecycleCostUsd <= 0
    || !Number.isSafeInteger(requestedMaximumProviderCanaries)
    || requestedMaximumProviderCanaries < 1 || providerCanaryBudgetUsd <= 0) {
    throw new Error('autonomous_research_supervisor_provider_canary_cost_envelope_insufficient');
  }
  const pairMaximum = providerCanaryBudgetUsd / requestedMaximumProviderCanaries;
  return Object.freeze({
    pairMaximum,
    effectiveLifecyclePolicy: Object.freeze({
      ...lifecyclePolicy,
      maximumProviderCanaries: requestedMaximumProviderCanaries,
      providerCanaryReservationCostUsd: pairMaximum,
      qualificationAttemptReservationCostUsd: Math.max(
        Number(lifecyclePolicy.qualificationAttemptReservationCostUsd || 0),
        configuredQualificationAttemptMaximumCostUsd,
      ),
    }),
  });
}
