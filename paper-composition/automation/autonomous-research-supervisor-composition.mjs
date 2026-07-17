import fs from 'node:fs';
import path from 'node:path';
import { createAutonomousResearchSupervisor } from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import { createAutonomousResearchRuntimeRefresh } from '../../paper-application/automation/autonomous-research-runtime-refresh.mjs';
import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  loadConfiguredAutonomousResearchMachineIntakes,
  readAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  readExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {
  executeAutomationRuntimeReconciliation,
} from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import { openExistingWritablePaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { bootstrapCampaignExecutionContext } from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import { composeAutomationReconcilerReceiptLedger } from '../bootstrap/receipt-ledger-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  composeAutonomousResearchCampaignAction,
  composeAutonomousResearchMachineIntakeEnqueue,
  composeAutonomousResearchQualificationRenewal,
  issueAutonomousResearchSupervisorDispatchAuthorization,
} from './autonomous-research-campaign-composition.mjs';
import {
  runAutonomousResearchProviderCanaryPair,
} from './autonomous-research-provider-canary.mjs';
import {
  resolvePersistedAutonomousResearchLaunchMode,
  resolveAutonomousResearchProviderPricing,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  createRuntimeImageReproducibilityReceiptRepository,
  composeRuntimeImageReproducibilityStatus,
  composeRuntimeImageReproducibilityVerification,
} from './runtime-image-reproducibility-composition.mjs';
import {
  evaluateAutonomousResearchMachineIntakeConfigurationReadiness,
  inspectAutonomousResearchResidentPrerequisites,
} from './automation-machine-intake-readiness.mjs';
import {
  composeAutonomousResearchSupervisorState,
} from './autonomous-research-supervisor-state-composition.mjs';
import {
  composeAutonomousResearchMachineIntakePlane,
  createAutonomousResearchSupervisorMachineIntakeAdapter,
  createLegacyAutonomousResearchMachineIntakeRepository,
  inspectConfiguredAutonomousResearchTopicProducer,
} from './autonomous-research-machine-intake-composition.mjs';

export function resolveAutonomousResearchSupervisorDispatchPolicy(campaign) {
  return resolvePersistedAutonomousResearchLaunchMode({ campaign });
}

export function createFencedAutonomousResearchProviderCanary({
  stateRepository,
  providerConfiguration,
  environment,
  clock,
  providerCanaryRunner = runAutonomousResearchProviderCanaryPair,
} = {}) {
  if (typeof stateRepository?.assertCampaignLease !== 'function'
    || typeof stateRepository?.renewCampaignLease !== 'function'
    || typeof stateRepository?.recordExternalActionProgress !== 'function'
    || typeof providerCanaryRunner !== 'function'
    || typeof clock?.now !== 'function') {
    throw new Error('autonomous_research_supervisor_provider_canary_dependencies_invalid');
  }
  return async function fencedProviderCanary({
    campaign,
    supervisorLease,
    providerCanaryReservation,
    externalActionAttempt,
    signal: canarySignal,
  } = {}) {
    const persistedHash = campaign?.spec?.autonomousResearchPreparation
      ?.autonomousResearchProviderConfigurationHash || null;
    if (!persistedHash
      || persistedHash !== providerConfiguration?.autonomousResearchProviderConfigurationHash) {
      throw new Error('autonomous_research_provider_configuration_hash_mismatch');
    }
    stateRepository.assertCampaignLease({ lease: supervisorLease, now: clock.now() });
    if (!stateRepository.renewCampaignLease({
      lease: supervisorLease,
      leaseMs: 15 * 60 * 1000,
      now: clock.now(),
    })) throw new Error('autonomous_research_supervisor_lease_lost');
    const receipt = await providerCanaryRunner({
      providerConfiguration,
      expectedProviderConfigurationHash: persistedHash,
      environment,
      signal: canarySignal,
      clock,
      providerCanaryReservation,
      betweenCanaryChecks({ authorCanary } = {}) {
        stateRepository.assertCampaignLease({ lease: supervisorLease, now: clock.now() });
        if (!stateRepository.renewCampaignLease({
          lease: supervisorLease,
          leaseMs: 15 * 60 * 1000,
          now: clock.now(),
        })) throw new Error('autonomous_research_supervisor_lease_lost');
        stateRepository.recordExternalActionProgress({
          lease: supervisorLease,
          attempt: externalActionAttempt,
          evidence: Object.freeze({
            version: 1,
            kind: 'AutonomousResearchSupervisorProviderCanaryProgress',
            role: 'research_author',
            providerConfigurationHash: persistedHash,
            providerCanaryReceiptHash:
              authorCanary?.codexModelAvailabilityCanaryReceiptHash || null,
          }),
          now: clock.now(),
        });
      },
    });
    stateRepository.assertCampaignLease({ lease: supervisorLease, now: clock.now() });
    return receipt;
  };
}

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

function runtimeRefreshPolicy(environment, supplied = {}) {
  const configured = (field, name) => supplied[field]
    ?? environment[`HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_${name}`];
  return Object.freeze({
    maximumAttemptsPerEpoch: configured(
      'maximumAttemptsPerEpoch', 'MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH',
    ),
    maximumCostUsdPerEpoch: configured(
      'maximumCostUsdPerEpoch', 'MAXIMUM_REFRESH_COST_USD_PER_EPOCH',
    ),
    budgetEpochMs: configured('budgetEpochMs', 'REFRESH_BUDGET_EPOCH_MS'),
    leaseMs: configured('leaseMs', 'REFRESH_LEASE_MS'),
    baseBackoffMs: configured('baseBackoffMs', 'REFRESH_BASE_BACKOFF_MS'),
    maximumBackoffMs: configured('maximumBackoffMs', 'REFRESH_MAXIMUM_BACKOFF_MS'),
    renewalLeadMs: configured('renewalLeadMs', 'REFRESH_RENEWAL_LEAD_MS'),
    actionSafetyMarginMs: configured(
      'actionSafetyMarginMs', 'REFRESH_ACTION_SAFETY_MARGIN_MS',
    ),
  });
}

function canonicalQualificationPointerEnvironment(environment, repository) {
  const canonicalPath = path.resolve(repository.qualificationReceiptPath);
  const configured = environment.HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT || null;
  if (configured) {
    const requested = path.resolve(String(configured));
    let requestedRealPath = requested;
    try { requestedRealPath = fs.realpathSync(requested); }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('autonomous_research_supervisor_qualification_pointer_path_invalid');
      }
    }
    let canonicalRealPath = canonicalPath;
    try { canonicalRealPath = fs.realpathSync(canonicalPath); }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('autonomous_research_supervisor_qualification_pointer_path_invalid');
      }
    }
    if (requested !== canonicalPath || requestedRealPath !== canonicalRealPath) {
      throw new Error('autonomous_research_supervisor_qualification_pointer_path_mismatch');
    }
  }
  return Object.freeze({
    ...environment,
    HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT: canonicalPath,
  });
}

export function composeAutonomousResearchSupervisor({
  root,
  runtimeRoot,
  environment = process.env,
  externalQualificationConfigPath = null,
  machineIntakeConfigPath = null,
  topicProducerProfilePath = null,
  requireFullyAutonomous = false,
  qualificationRetry = {},
  lifecyclePolicy = {},
  runtimeReproducibilityPolicy = {},
  worker = {},
  pollMs = 5000,
  maximumCampaignsPerCycle = 100,
  residentInstanceLeaseMs = 15 * 60 * 1000,
  residentInstanceHeartbeatMs = 30_000,
  signal = null,
  ownerId = undefined,
  random = Math.random,
  onCycle = null,
  serviceOverrides = {},
  dispatchCampaignOverride = null,
  providerCanaryOverride = null,
  renewQualificationOverride = null,
  readQualificationStateOverride = null,
  reconcileRuntimeOverride = null,
  runtimeReproducibilityOverrides = {},
} = {}) {
  const receiptPointerRepository = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
  });
  const effectiveEnvironment = canonicalQualificationPointerEnvironment(
    environment,
    receiptPointerRepository,
  );
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
    environment: effectiveEnvironment,
  });
  const configuredExternalQualificationPath = externalQualificationConfigPath
    || effectiveEnvironment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG || null;
  const externalQualificationConfiguration = configuredExternalQualificationPath
    ? readExternalResearchQualificationProcessConfiguration({
      configPath: configuredExternalQualificationPath,
      environment: effectiveEnvironment,
    }) : null;
  const configuredMachineIntakePath = machineIntakeConfigPath
    || effectiveEnvironment.HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG || null;
  if (requireFullyAutonomous && !configuredMachineIntakePath) {
    throw new Error('autonomous_research_supervisor_machine_intake_configuration_required');
  }
  const initialMachineIntakeConfiguration = configuredMachineIntakePath
    ? readAutonomousResearchMachineIntakeConfiguration({
      configPath: configuredMachineIntakePath,
      environment: effectiveEnvironment,
    }).configuration : null;
  const initialTopicProducerInspection = initialMachineIntakeConfiguration?.version === 2
    ? inspectConfiguredAutonomousResearchTopicProducer({
      configuration: initialMachineIntakeConfiguration,
      providerConfiguration,
      environment: effectiveEnvironment,
      profilePath: topicProducerProfilePath,
    }) : null;
  const initialMachineIntakeReadiness = initialMachineIntakeConfiguration
    ? evaluateAutonomousResearchMachineIntakeConfigurationReadiness({
      configuration: initialMachineIntakeConfiguration,
      providerConfiguration,
      topicProducerInspection: initialTopicProducerInspection,
    }) : null;
  const coldStartAutonomyReady = initialMachineIntakeReadiness
    ?.configurationReady === true;
  if (requireFullyAutonomous && !coldStartAutonomyReady) {
    throw new Error('autonomous_research_supervisor_fully_autonomous_intake_required');
  }
  const execution = bootstrapCampaignExecutionContext({
    root,
    runtimeRoot,
    mode: 'autonomous-research-supervisor',
    execute: true,
    serviceOverrides,
  });
  const { context } = execution;
  const services = context.services;
  const supervisorState = composeAutonomousResearchSupervisorState({
    runtimeRoot,
    runtimeRefreshStateRepository: runtimeReproducibilityOverrides.stateRepository,
    runtimeRefreshPolicy: runtimeRefreshPolicy(
      effectiveEnvironment,
      runtimeReproducibilityPolicy,
    ),
  });
  const stateRepository = supervisorState.lifecycle;
  const residentInstanceRepository = supervisorState.residentInstance;
  let machineIntakeRepository = null;
  let machineIntakePlane = null;
  const runtimeRefreshStateRepository = supervisorState.runtimeRefresh;
  const readRuntimeReproducibilityStatus = runtimeReproducibilityOverrides.readStatus
    || (({ now }) => composeRuntimeImageReproducibilityStatus({
      runtimeRoot,
      repositoryRoot: root,
      environment: effectiveEnvironment,
      now,
    }));
  const publishRuntimeReproducibility = runtimeReproducibilityOverrides.publish
    || (({ signal: refreshSignal }) => composeRuntimeImageReproducibilityVerification({
      action: 'publish',
      runtimeRoot,
      repositoryRoot: root,
      environment: effectiveEnvironment,
      clock: services.clock,
      signal: refreshSignal,
    }));
  const runtimeRefresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: runtimeRefreshStateRepository,
    readStatus: readRuntimeReproducibilityStatus,
    publish: publishRuntimeReproducibility,
    clock: services.clock,
    scheduler: services.scheduler,
    random,
  });
  const pricing = resolveAutonomousResearchProviderPricing({
    researchAuthorProvider: providerConfiguration.researchAuthor.provider,
    researchAuthorModel: providerConfiguration.researchAuthor.model,
    formalReviewerProvider: providerConfiguration.formalReviewer.provider,
    formalReviewerModel: providerConfiguration.formalReviewer.model,
    researchAuthorMaximumCostPerCallUsd:
      configuredMaximumCost(effectiveEnvironment, 'RESEARCH_AUTHOR'),
    formalReviewerMaximumCostPerCallUsd:
      configuredMaximumCost(effectiveEnvironment, 'FORMAL_REVIEWER'),
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
  const effectiveLifecyclePolicy = Object.freeze({
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
  });

  if (configuredMachineIntakePath && initialMachineIntakeConfiguration.version === 2) {
    machineIntakePlane = composeAutonomousResearchMachineIntakePlane({
      runtimeRoot,
      configuration: initialMachineIntakeConfiguration,
      configPath: configuredMachineIntakePath,
      providerConfiguration,
      environment: effectiveEnvironment,
      producerInspection: initialTopicProducerInspection,
      providerCanaryPairMaximumCostUsd: pairMaximum,
      providerCanaryRunner: runAutonomousResearchProviderCanaryPair,
      clock: services.clock,
      ownerId: ownerId || `supervisor:${process.pid}`,
      signal,
    });
    machineIntakeRepository = machineIntakePlane.machineIntakeRepository;
  } else if (configuredMachineIntakePath) {
    machineIntakeRepository = createLegacyAutonomousResearchMachineIntakeRepository({
      runtimeRoot,
      create: true,
      authorizedSourceAuthorityHash: initialMachineIntakeConfiguration.configurationHash,
    });
  }

  const readQualificationState = readQualificationStateOverride || (async (campaign) => {
    const repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: campaign.paperId,
      create: true,
    });
    try {
      repository.reconcileStaleQualificationAttemptLease({ now: services.clock.now() });
      return repository.readExternalQualificationState();
    }
    finally { repository.close(); }
  });

  const runProviderCanary = providerCanaryOverride
    || createFencedAutonomousResearchProviderCanary({
      stateRepository,
      providerConfiguration,
      environment: effectiveEnvironment,
      clock: services.clock,
    });

  const renewQualification = renewQualificationOverride || (({
    campaign,
    runtimeReadiness,
    requiredQualificationValidityMs,
    qualificationRetry: boundedQualificationRetry,
    supervisorLease,
    signal: renewalSignal,
    onProgress,
    onSynchronousProgress,
  }) => composeAutonomousResearchQualificationRenewal({
    campaign,
    root,
    runtimeRoot,
    environment: effectiveEnvironment,
    externalQualificationConfigPath,
    qualificationRetry: {
      ...qualificationRetry,
      ...boundedQualificationRetry,
    },
    runtimeReadiness,
    requiredQualificationValidityMs,
    supervisorLease,
    assertSupervisorLease: ({ lease, now }) => stateRepository.assertCampaignLease({
      lease,
      now,
    }),
    receiptPointerRepository,
    serviceOverrides,
    runtimeSignal: renewalSignal,
    worker: options,
    onProgress,
    onSynchronousProgress,
  }));

  const dispatchCampaign = dispatchCampaignOverride || (({
    campaign,
    action,
    qualificationRetry: boundedQualificationRetry,
    supervisorDispatchEvidence,
    signal: dispatchSignal,
  }) => {
    const dispatchPolicy = resolveAutonomousResearchSupervisorDispatchPolicy(campaign);
    const supervisorDispatchAuthorization = campaign.spec?.autonomousResearchMachineIntake
      && supervisorDispatchEvidence?.residentLeaseContext
      ? issueAutonomousResearchSupervisorDispatchAuthorization({
        campaignId: campaign.campaignId,
        campaignPlanHash: campaign.spec?.campaignPlanHash,
        launchMode: dispatchPolicy.launchMode,
        action,
        providerConfigurationHash:
          providerConfiguration.autonomousResearchProviderConfigurationHash,
        campaignLease: supervisorDispatchEvidence?.campaignLease,
        residentLeaseContext: supervisorDispatchEvidence.residentLeaseContext,
        providerCanaryState: supervisorDispatchEvidence?.providerCanaryState,
        now: services.clock.now(),
        assertCampaignLease: ({ lease, now }) => stateRepository.assertCampaignLease({
          lease,
          now,
        }),
        readCampaignState: (campaignId) => stateRepository.getCampaign(campaignId),
      }) : null;
    const supervisorExternalActionJournal = supervisorDispatchAuthorization
      ? Object.freeze({
        begin({ actionKind, reservation, now }) {
          return stateRepository.beginExternalActionAttempt({
            lease: supervisorDispatchEvidence.campaignLease,
            actionKind,
            reservation,
            now,
          });
        },
        finish({
          attempt, successful, evidence, actionAccountingComplete,
          externalActionPerformed, blocker, now,
        }) {
          return stateRepository.finishExternalActionAttempt({
            lease: supervisorDispatchEvidence.campaignLease,
            attempt,
            successful,
            evidence,
            actionAccountingComplete,
            externalActionPerformed,
            blocker,
            now,
          });
        },
      }) : null;
    return composeAutonomousResearchCampaignAction({
      action,
      launchMode: dispatchPolicy.launchMode,
      paperId: campaign.paperId,
      campaignId: campaign.campaignId,
      root,
      runtimeRoot,
      datasetMounts: campaign.spec?.datasetMounts || [],
      budgets: dispatchPolicy.budgets,
      environment: effectiveEnvironment,
      externalQualificationConfigPath,
      qualificationRetry: {
        ...qualificationRetry,
        ...boundedQualificationRetry,
      },
      supervisorDispatchAuthorization,
      supervisorExternalActionJournal,
      readinessClock: services.clock,
      runtimeSignal: dispatchSignal,
      worker: options,
    });
  });

  const reconcileAutomationRuntime = reconcileRuntimeOverride || (() => {
    const reconciliationStore = openExistingWritablePaperStore({ root, runtimeRoot });
    try {
      return executeAutomationRuntimeReconciliation({
        store: reconciliationStore,
        clock: services.clock,
        receiptLedger: composeAutomationReconcilerReceiptLedger({
          store: reconciliationStore,
          clock: services.clock,
        }),
      });
    } finally { reconciliationStore.close(); }
  });
  const reconcileRuntimeMirror = runtimeReproducibilityOverrides.reconcileMirror
    || (() => createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot,
      receiptPath: effectiveEnvironment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
    }).reconcileMirror());
  const reconcileRuntime = async ({ now } = {}) => {
    const fullResearchQualificationMirror = receiptPointerRepository.reconcileMirror();
    const runtimeReproducibilityMirror = await reconcileRuntimeMirror();
    return Object.freeze({
      fullResearchQualificationMirror,
      runtimeReproducibilityMirror,
      automationRuntime: await reconcileAutomationRuntime({ now }),
      runtimeReproducibility: runtimeRefreshStateRepository
        .reconcileStaleRefreshLease({ now: now || services.clock.now() }),
    });
  };

  const machineIntake = createAutonomousResearchSupervisorMachineIntakeAdapter({
    repository: machineIntakeRepository,
    plane: machineIntakePlane,
    loadFallback({ now, operationMode }) {
      const configuration = readAutonomousResearchMachineIntakeConfiguration({
        configPath: configuredMachineIntakePath,
        environment: effectiveEnvironment,
        validateStaticContent: false,
      }).configuration;
      return loadConfiguredAutonomousResearchMachineIntakes({
        configuration,
        repository: machineIntakeRepository,
        now,
        operationMode,
      });
    },
    enqueueIntake({
      intake,
      machineIntakeAdmission,
      intakeLease,
      residentLeaseContext,
      assertAutonomyCurrent,
      signal: intakeSignal,
      now,
    }) {
      return composeAutonomousResearchMachineIntakeEnqueue({
        intake,
        machineIntakeAdmission,
        root,
        runtimeRoot,
        environment: effectiveEnvironment,
        externalQualificationConfigPath,
        serviceOverrides,
        worker: options,
        now,
        clock: services.clock,
        runtimeSignal: intakeSignal,
        intakeLeaseRepository: machineIntakeRepository,
        intakeLease,
        residentLeaseContext,
        assertAutonomyCurrent,
      });
    },
  });

  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: services.campaignStore,
    stateRepository,
    dispatchCampaign,
    readQualificationState,
    ensureRuntimeReproducibility: (input) => runtimeRefresh.ensureReady(input),
    runProviderCanary,
    renewQualification,
    machineIntake,
    requireFullyAutonomous,
    inspectFullyAutonomousPrerequisites: ({ now }) => (
      inspectAutonomousResearchResidentPrerequisites({
        runtimeRoot,
        environment: effectiveEnvironment,
        externalQualificationConfigPath: configuredExternalQualificationPath,
        now,
      })
    ),
    reconcileRuntime,
    residentInstanceRepository,
    residentInstanceLeaseMs,
    residentInstanceHeartbeatMs,
    lifecyclePolicy: effectiveLifecyclePolicy,
    clock: services.clock,
    scheduler: services.scheduler,
    ...(ownerId ? { ownerId } : {}),
    pollMs,
    maximumCampaignsPerCycle,
    random,
    signal,
    onCycle,
  });
  let closed = false;
  return Object.freeze({
    supervisor,
    stateRepository,
    runtimeRefreshStateRepository,
    machineIntakeConfigured: Boolean(machineIntakeRepository),
    coldStartAutonomyReady,
    close() {
      if (closed) return;
      runtimeRefreshStateRepository.close();
      if (machineIntakePlane) machineIntakePlane.close();
      else machineIntakeRepository?.close();
      residentInstanceRepository.close();
      stateRepository.close();
      services.persistenceSession.close();
      closed = true;
    },
  });
}
