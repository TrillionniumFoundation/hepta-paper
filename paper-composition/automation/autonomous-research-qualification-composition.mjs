import { bootstrapCampaignExecutionContext } from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import { bootstrapSubmissionHandoffContext } from '../bootstrap/submission-handoff-context-bootstrap.mjs';
import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  createExternalResearchQualificationProcessAdapter,
} from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import {
  loadOperatorDatasetAuthorityTrustStoreSync,
  readOperatorDatasetHarness,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createAutonomousResearchQualificationContextProvider,
} from './autonomous-research-qualification-context.mjs';
import { queryAutomationReadiness } from './automation-readiness-query.mjs';
import {
  requireAutonomousResearchProviderConfiguration,
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  AUTONOMOUS_RESEARCH_LAUNCH_MODES,
  resolvePersistedAutonomousResearchLaunchMode,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  createAutonomousResearchQualificationRenewal,
} from '../../paper-application/automation/autonomous-research-qualification-renewal.mjs';
import {
  closeAutonomousResearchResourceBudgets,
} from './autonomous-research-resource-budget-composition.mjs';

export {
  closeAutonomousResearchResourceBudgets,
  requireAutonomousResearchProviderConfiguration,
  resolveAutonomousResearchProviderConfiguration,
};

export function campaignWorkerOptions(options = {}) {
  return Object.fromEntries(Object.entries({
    'agent-provider': options.agentProvider,
    model: options.model,
    'formal-review-provider': options.formalReviewProvider,
    'formal-review-model': options.formalReviewModel,
    'formal-review-codex-binary': options.formalReviewCodexBinary,
    'formal-review-codex-home': options.formalReviewCodexHome,
    'codex-home': options.codexHome,
    'codex-binary': options.codexBinary,
    'max-wall-ms': options.budgets?.maxWallTimeMs,
    'worker-memory-mib': options.workerMemoryMiB,
    'worker-cpu-seconds': options.workerCpuSeconds,
  }).filter(([, value]) => value !== undefined && value !== null));
}

export function readCurrentRelease({ root, runtimeRoot, campaignId }) {
  const handoff = bootstrapSubmissionHandoffContext({ root, runtimeRoot });
  try { return handoff.services.campaignReleaseQuery.getCurrentRelease({ campaignId }); }
  finally { handoff.services.persistenceSession.close(); }
}

export function readAutonomousDatasetAuthorityReceipt({ datasetMounts, runtimeRoot } = {}) {
  if (!Array.isArray(datasetMounts) || datasetMounts.length !== 1 || !runtimeRoot) return null;
  try {
    const authorityTrustStore = loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot });
    return readOperatorDatasetHarness(datasetMounts[0], {
      authorityTrustStore,
      runtimeRoot,
      now: new Date(),
    }).receipt;
  } catch {
    return null;
  }
}

export function providerBoundReadinessEnvironment(environment, providerConfiguration) {
  return Object.freeze({
    ...environment,
    HEPTA_RESEARCH_AUTHOR_PROVIDER: providerConfiguration.researchAuthor.provider,
    HEPTA_RESEARCH_AUTHOR_CODEX_BINARY: providerConfiguration.researchAuthor.codexBinary,
    ...(providerConfiguration.researchAuthor.codexHome
      ? { HEPTA_RESEARCH_AUTHOR_CODEX_HOME: providerConfiguration.researchAuthor.codexHome }
      : {}),
    ...(providerConfiguration.researchAuthor.model
      ? { HEPTA_RESEARCH_AUTHOR_MODEL: providerConfiguration.researchAuthor.model }
      : {}),
    HEPTA_FORMAL_REVIEW_PROVIDER: providerConfiguration.formalReviewer.provider,
    HEPTA_FORMAL_REVIEW_CODEX_BINARY: providerConfiguration.formalReviewer.codexBinary,
    ...(providerConfiguration.formalReviewer.codexHome
      ? { HEPTA_FORMAL_REVIEW_CODEX_HOME: providerConfiguration.formalReviewer.codexHome }
      : {}),
    ...(providerConfiguration.formalReviewer.model
      ? { HEPTA_FORMAL_REVIEW_MODEL: providerConfiguration.formalReviewer.model }
      : {}),
  });
}

export function configuredMaximumCost(environment, role) {
  return environment[`HEPTA_${role}_MAXIMUM_COST_PER_CALL_USD`]
    ?? environment[`HEPTA_${role}_MAX_COST_PER_CALL_USD`]
    ?? null;
}

async function reportQualificationProgress(onProgress, stage) {
  if (onProgress === null || onProgress === undefined) return;
  if (typeof onProgress !== 'function') {
    throw new Error('autonomous_research_qualification_progress_callback_invalid');
  }
  try { await onProgress(Object.freeze({ stage })); }
  catch (error) {
    if (error?.stateRecoverabilityFatal === true
      || error?.stateRecoverabilityDeferred === true
      || error?.authorityEvidenceRenewalFatal === true
      || error?.authorityEvidenceRenewalDeferred === true
      || error?.residentReactivationRequired === true) throw error;
    const fenceError = new Error('autonomous_research_qualification_progress_fence_lost', {
      cause: error,
    });
    if (error?.authorityEvidenceRenewalFatal === true) {
      fenceError.authorityEvidenceRenewalFatal = true;
    }
    if (error?.authorityEvidenceRenewalDeferred === true) {
      fenceError.authorityEvidenceRenewalDeferred = true;
      fenceError.retryAt = error.retryAt || null;
    }
    throw fenceError;
  }
}

export function requirePersistedAutonomousProviderConfiguration({
  action,
  existingCampaign = null,
  providerConfiguration,
} = {}) {
  if (!['launch', 'status', 'resume', 'converge'].includes(action)) {
    throw new Error(`autonomous_research_campaign_action_invalid:${action || '<empty>'}`);
  }
  const persistedHash = existingCampaign?.spec
    ?.autonomousResearchPreparation?.autonomousResearchProviderConfigurationHash || null;
  if (existingCampaign && !persistedHash) {
    if (action === 'status') return null;
    throw new Error('autonomous_research_provider_configuration_binding_required');
  }
  requireAutonomousResearchProviderConfiguration(providerConfiguration, {
    expectedHash: persistedHash
      || providerConfiguration?.autonomousResearchProviderConfigurationHash
      || null,
  });
  return persistedHash || providerConfiguration.autonomousResearchProviderConfigurationHash;
}

export function requireExistingProductionPricingEnvelope({
  action,
  existingCampaign,
  requestedBudgets = {},
  launchModeGate,
} = {}) {
  if (!existingCampaign || action === 'status' || launchModeGate?.productionRun !== true) return;
  const persisted = existingCampaign.spec?.budgets || {};
  const requestedMaximumAgentCalls = Number(
    requestedBudgets.maxAgentCalls ?? persisted.maxAgentCalls,
  );
  const effectiveMaximumAgentCalls = Number(
    launchModeGate.effectiveBudgets?.maxAgentCalls,
  );
  if (!Number.isFinite(requestedMaximumAgentCalls) || requestedMaximumAgentCalls < 1
    || !Number.isFinite(effectiveMaximumAgentCalls) || effectiveMaximumAgentCalls < 1
    || effectiveMaximumAgentCalls < requestedMaximumAgentCalls) {
    throw new Error('autonomous_research_production_provider_price_drift_exceeds_campaign_envelope');
  }
}

function qualificationCostAuthorityValid(maximumCostUsd, authority) {
  return Number.isFinite(maximumCostUsd) && maximumCostUsd >= 0 && maximumCostUsd <= 1_000
    && (maximumCostUsd === 0
      ? authority === 'externally_operated_zero_cost'
      : authority === 'operator_declared_worst_case_usd');
}

function qualificationCostAuthority({
  configurationInspection = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
} = {}) {
  if (configurationInspection?.ready === true) {
    const maximumCostUsd = Number(configurationInspection.maximumQualificationCostUsd);
    const authority = configurationInspection.qualificationCostAuthority;
    if (!qualificationCostAuthorityValid(maximumCostUsd, authority)) {
      throw new Error('autonomous_research_qualification_cost_authority_invalid');
    }
    return Object.freeze({ maximumCostUsd, authority });
  }
  const clientDeclaresCost = Object.hasOwn(
    externalQualificationClient || {},
    'maximumQualificationCostUsd',
  ) || Object.hasOwn(externalQualificationClient || {}, 'qualificationCostAuthority');
  const verifierDeclaresCost = Object.hasOwn(
    externalQualificationVerifier || {},
    'maximumQualificationCostUsd',
  ) || Object.hasOwn(externalQualificationVerifier || {}, 'qualificationCostAuthority');
  if (!externalQualificationClient && !externalQualificationVerifier) return null;
  const maximumCostUsd = Number(externalQualificationClient?.maximumQualificationCostUsd);
  const authority = externalQualificationClient?.qualificationCostAuthority;
  if (!clientDeclaresCost || !verifierDeclaresCost
    || maximumCostUsd !== Number(externalQualificationVerifier?.maximumQualificationCostUsd)
    || authority !== externalQualificationVerifier?.qualificationCostAuthority
    || !qualificationCostAuthorityValid(maximumCostUsd, authority)) {
    throw new Error('autonomous_research_qualification_cost_authority_invalid');
  }
  return Object.freeze({ maximumCostUsd, authority });
}

export function qualificationRetryBoundToExternalCostAuthority({
  launchMode,
  action,
  qualificationRetry = {},
  configurationInspection = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
} = {}) {
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(launchMode)
    || !['launch', 'resume', 'converge'].includes(action)) return qualificationRetry;
  const cost = qualificationCostAuthority({
    configurationInspection,
    externalQualificationClient,
    externalQualificationVerifier,
  });
  if (!cost) return qualificationRetry;
  const maximumTotalCostUsd = Number(
    qualificationRetry.maximumTotalCostUsd ?? 25,
  );
  const requestedReservation = Number(
    qualificationRetry.attemptReservationCostUsd ?? 0,
  );
  if (!Number.isFinite(maximumTotalCostUsd) || maximumTotalCostUsd <= 0
    || maximumTotalCostUsd < cost.maximumCostUsd
    || !Number.isFinite(requestedReservation) || requestedReservation < 0) {
    throw new Error('autonomous_research_qualification_cost_envelope_insufficient');
  }
  return Object.freeze({
    ...qualificationRetry,
    attemptReservationCostUsd: Math.max(requestedReservation, cost.maximumCostUsd),
  });
}

export function qualificationRetryBoundToProviderPricing(options = {}) {
  return qualificationRetryBoundToExternalCostAuthority(options);
}

export async function composeAutonomousResearchQualificationRenewal({
  campaign,
  root,
  runtimeRoot,
  environment = process.env,
  externalQualificationConfigPath = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
  qualificationRetry = {},
  runtimeReadiness,
  requiredQualificationValidityMs,
  supervisorLease,
  assertSupervisorLease,
  qualificationStateMutationCoordinator = null,
  requireExternallyFencedQualificationState = false,
  receiptPointerRepository: suppliedReceiptPointerRepository = null,
  receiptPointerMutationCoordinator = null,
  requireExternallyFencedQualificationPublication = false,
  nativeStoreMutationCoordinator = null,
  requireExternallyFencedNativeStore = false,
  productionReadinessInspector = queryAutomationReadiness,
  serviceOverrides = {},
  runtimeSignal = null,
  worker = {},
  onProgress = null,
  onSynchronousProgress = null,
} = {}) {
  if (requireExternallyFencedQualificationPublication
    && suppliedReceiptPointerRepository !== null) {
    throw new Error(
      'autonomous_research_qualification_publication_external_repository_override_forbidden',
    );
  }
  if (!campaign?.campaignId || !campaign?.paperId
    || campaign?.spec?.autonomousResearchPreparation?.proposal?.paperId !== campaign.paperId
    || typeof assertSupervisorLease !== 'function'
    || (onProgress !== null && typeof onProgress !== 'function')
    || (onSynchronousProgress !== null && typeof onSynchronousProgress !== 'function')) {
    throw new Error('autonomous_research_qualification_renewal_campaign_invalid');
  }
  // Validate the activated publication authority before bootstrapping any
  // persistence session or configured external qualification process. Strict
  // mode must fail closed without touching the runtime or invoking a broker.
  const strictReceiptPointerRepository = requireExternallyFencedQualificationPublication
    ? createFullResearchQualificationReceiptPointerRepository({
      runtimeRoot,
      offlineProvision: false,
      mutationCoordinator: receiptPointerMutationCoordinator,
      requireExternallyFencedMutations: true,
    }) : null;
  const dispatchPolicy = resolvePersistedAutonomousResearchLaunchMode({ campaign });
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(dispatchPolicy.launchMode)) {
    throw new Error('autonomous_research_qualification_renewal_launch_mode_invalid');
  }
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: campaignWorkerOptions({ ...worker, budgets: dispatchPolicy.budgets }),
    environment,
  });
  const providerConfigurationHash = requirePersistedAutonomousProviderConfiguration({
    action: 'resume',
    existingCampaign: campaign,
    providerConfiguration,
  });
  const injectedQualificationServices = Boolean(
    externalQualificationClient || externalQualificationVerifier,
  );
  if (Boolean(externalQualificationClient) !== Boolean(externalQualificationVerifier)) {
    throw new Error('autonomous_research_external_qualification_services_incomplete');
  }
  if (injectedQualificationServices && (externalQualificationConfigPath
    || environment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG)) {
    throw new Error('autonomous_research_external_qualification_service_source_conflict');
  }
  const execution = bootstrapCampaignExecutionContext({
    root,
    runtimeRoot,
    mode: 'autonomous-research-supervisor-qualification-renewal',
    execute: true,
    serviceOverrides,
    nativeStoreMutationCoordinator,
    requireExternallyFencedNativeStore,
  });
  const { context } = execution;
  const qualificationStateStore = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: campaign.paperId,
    offlineProvision: !requireExternallyFencedQualificationState,
    mutationCoordinator: qualificationStateMutationCoordinator,
    requireExternallyFencedMutations: requireExternallyFencedQualificationState,
  });
  try {
    const configuredQualification = injectedQualificationServices ? null
      : createExternalResearchQualificationProcessAdapter({
        configPath: externalQualificationConfigPath,
        cwd: root,
        environment,
        clock: context.services.clock,
        fullVerificationContextProvider:
          createAutonomousResearchQualificationContextProvider({
            schemaVersionReceipt: context.services.schemaVersion,
            providerConfiguration,
            expectedProviderConfigurationHash: providerConfigurationHash,
            environment,
            runtimeRoot,
            repositoryRoot: root,
            clock: context.services.clock,
            onProgress,
            onSynchronousProgress,
          }),
      });
    const effectiveQualificationClient = externalQualificationClient
      || configuredQualification?.client || null;
    const effectiveQualificationVerifier = externalQualificationVerifier
      || configuredQualification?.verifier || null;
    const effectiveQualificationRetry = qualificationRetryBoundToExternalCostAuthority({
      launchMode: dispatchPolicy.launchMode,
      action: 'resume',
      qualificationRetry,
      configurationInspection: configuredQualification?.inspection || null,
      externalQualificationClient: effectiveQualificationClient,
      externalQualificationVerifier: effectiveQualificationVerifier,
    });
    await reportQualificationProgress(
      onProgress,
      'qualification_composition_before_current_release_read',
    );
    const campaignReleaseAuthority = readCurrentRelease({
      root,
      runtimeRoot,
      campaignId: campaign.campaignId,
    });
    await reportQualificationProgress(
      onProgress,
      'qualification_composition_after_current_release_read',
    );
    if (!campaignReleaseAuthority) {
      if (campaign.status === 'completed') {
        throw new Error('autonomous_research_qualification_renewal_current_release_required');
      }
      if (dispatchPolicy.launchMode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP) {
        return Object.freeze({
          ready: true,
          preReleaseExecutionAuthorized: true,
          campaignQualificationReady: false,
          globalQualificationReady: false,
          reason: 'golden_bootstrap_must_produce_fresh_promotable_release',
        });
      }
      await reportQualificationProgress(
        onProgress,
        'qualification_composition_before_pre_release_global_readiness',
      );
      const globalResult = await productionReadinessInspector({
        root,
        runtimeRoot,
        environment: providerBoundReadinessEnvironment(environment, providerConfiguration),
        liveProviderCanaryRequested: false,
        requireFullResearch: true,
        now: context.services.clock.now(),
      });
      await reportQualificationProgress(
        onProgress,
        'qualification_composition_after_pre_release_global_readiness',
      );
      const globalReadiness = globalResult?.report || globalResult?.readiness
        || globalResult || null;
      const globalQualification = globalReadiness?.fullResearchQualification || null;
      if (globalReadiness?.fullAutomaticResearchWritingReady !== true
        || globalReadiness?.boundedGoldenInfrastructureQualificationReady !== true
        || globalReadiness?.campaignFullyQualified === true
        || globalQualification?.runtimeImageReproducibilityReceiptHash
          !== runtimeReadiness?.receiptHash
        || Number(globalQualification?.remainingValidityMs)
          <= Number(requiredQualificationValidityMs)) {
        return Object.freeze({
          ready: false,
          terminal: false,
          preReleaseExecutionAuthorized: false,
          campaignQualificationReady: false,
          globalQualificationReady: false,
          reason: 'production_waiting_for_current_runtime_golden_qualification',
        });
      }
      return Object.freeze({
        ready: true,
        preReleaseExecutionAuthorized: true,
        campaignQualificationReady: false,
        globalQualificationReady: true,
        reason: 'production_global_qualification_covers_pre_release_execution',
      });
    }
    const receiptPointerRepository = suppliedReceiptPointerRepository
      || strictReceiptPointerRepository
      || createFullResearchQualificationReceiptPointerRepository({
        runtimeRoot,
      });
    const renewal = createAutonomousResearchQualificationRenewal({
      externalQualificationClient: effectiveQualificationClient,
      externalQualificationVerifier: effectiveQualificationVerifier,
      qualificationStateStore,
      receiptPointerRepository,
      assertSupervisorLease,
      inspectGlobalReadiness: ({ now }) => productionReadinessInspector({
        root,
        runtimeRoot,
        environment: providerBoundReadinessEnvironment(environment, providerConfiguration),
        liveProviderCanaryRequested: false,
        requireFullResearch: true,
        now,
      }),
      clock: context.services.clock,
      scheduler: context.services.scheduler,
    });
    return await renewal.renew({
      campaign,
      campaignReleaseAuthority,
      runtimeReadiness,
      requiredQualificationValidityMs,
      qualificationRetry: effectiveQualificationRetry,
      supervisorLease,
      signal: runtimeSignal,
      onProgress,
      onSynchronousProgress,
    });
  } finally {
    qualificationStateStore.close();
    context.services.persistenceSession.close();
  }
}
