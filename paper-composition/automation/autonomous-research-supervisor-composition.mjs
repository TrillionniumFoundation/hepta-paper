import { createAutonomousResearchSupervisor } from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  ResidentReactivationRequired,
} from '../../paper-application/automation/autonomous-research-resident-reactivation-required.mjs';
import {
  createAutonomousResearchOnlineAuthorityEvidenceRenewalController,
} from '../../paper-application/automation/autonomous-research-online-authority-evidence-renewal-controller.mjs';
import { createAutonomousResearchQualificationStateRepository } from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  createAutonomousResearchResidentCycleIntentRepository,
} from '../../paper-adapters/automation/autonomous-research-resident-cycle-intent-repository.mjs';
import {
  loadConfiguredAutonomousResearchMachineIntakes,
  readAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import { HEPTA_WORKSPACE_ROOT } from '../../paper-adapters/runtime/workspace-layout.mjs';
import {
  bootstrapCampaignExecutionContext,
} from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import {
  composeAutonomousResearchCampaignAction,
  composeAutonomousResearchMachineIntakeEnqueue,
  composeAutonomousResearchQualificationRenewal,
  issueAutonomousResearchSupervisorDispatchAuthorization,
} from './autonomous-research-campaign-composition.mjs';
import {
  createAutonomousResearchSubmissionHandoffInspection,
} from './autonomous-research-submission-composition.mjs';
import {
  createFencedAutonomousResearchProviderCanary,
  runAutonomousResearchProviderCanaryPair,
} from './autonomous-research-provider-canary.mjs';
import {
  evaluateAutonomousResearchMachineIntakeConfigurationReadiness,
  inspectAutonomousResearchResidentPrerequisites,
} from './automation-machine-intake-readiness.mjs';
import { composeAutonomousResearchSupervisorState } from './autonomous-research-supervisor-state-composition.mjs';
import {
  assertAutonomousResearchSupervisorMachineIntakeConfiguration,
  assertAutonomousResearchSupervisorStrictOverridePolicy,
  assertAutonomousResearchSupervisorStateSafety,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SAFETY_CLOCK,
  prepareAutonomousResearchSupervisorQualificationPrerequisites,
} from './autonomous-research-supervisor-prerequisites.mjs';
import {
  composeAutonomousResearchMachineIntakePlane,
  createAutonomousResearchSupervisorMachineIntakeAdapter,
  createLegacyAutonomousResearchMachineIntakeRepository,
  inspectConfiguredAutonomousResearchTopicProducer,
} from './autonomous-research-machine-intake-composition.mjs';
import {
  composeAutonomousResearchSupervisorRuntime,
  resolveAutonomousResearchSupervisorRuntimeRefreshPolicy,
} from './autonomous-research-supervisor-runtime-composition.mjs';
import {
  composeAutonomousResearchCampaignExternalSideEffectControl,
  createAutonomousResearchStateRecoverabilityReconciler,
} from './autonomous-research-campaign-external-side-effect-composition.mjs';
import {
  prepareAutonomousResearchSupervisorProvider,
  resolveAutonomousResearchSupervisorDispatchPolicy,
  resolveAutonomousResearchSupervisorLifecycleCostEnvelope,
} from './autonomous-research-supervisor-provider-preparation.mjs';
import {
  composeAutonomousResearchSupervisorExternalActionRecovery,
} from './autonomous-research-supervisor-external-action-recovery-composition.mjs';

export { resolveAutonomousResearchSupervisorDispatchPolicy };

export { createFencedAutonomousResearchProviderCanary };

export function composeAutonomousResearchSupervisor({
  root,
  runtimeRoot,
  workspaceRoot = HEPTA_WORKSPACE_ROOT,
  environment = process.env,
  externalQualificationConfigPath = null,
  externalActionRecoveryConfigPath = null,
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
  stateSafetyInspector = undefined,
  stateSafetyActiveAuthorityRefresh = undefined,
  composeStateSafetyBackupService = undefined,
  stateSafetyClock = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SAFETY_CLOCK,
  createQualificationPointerRepository = undefined,
  bootstrapExecutionContext = bootstrapCampaignExecutionContext,
  composeSupervisorState = composeAutonomousResearchSupervisorState,
} = {}) {
  assertAutonomousResearchSupervisorStrictOverridePolicy({
    required: requireFullyAutonomous,
    serviceOverrides,
    runtimeReproducibilityOverrides,
    dispatchCampaignOverride,
    providerCanaryOverride,
    renewQualificationOverride,
    readQualificationStateOverride,
    reconcileRuntimeOverride,
    stateSafetyInspector,
    stateSafetyActiveAuthorityRefresh,
    composeStateSafetyBackupService,
    stateSafetyClock,
    createQualificationPointerRepository,
    bootstrapExecutionContextIsDefault: bootstrapExecutionContext === bootstrapCampaignExecutionContext,
    composeSupervisorStateIsDefault:
      composeSupervisorState === composeAutonomousResearchSupervisorState,
  });
  const stateSafetyActivation = assertAutonomousResearchSupervisorStateSafety({
    required: requireFullyAutonomous,
    workspaceRoot,
    runtimeRoot,
    environment,
    inspector: stateSafetyInspector,
    activeAuthorityRefresh: stateSafetyActiveAuthorityRefresh,
    composeStateBackupService: composeStateSafetyBackupService,
    clock: stateSafetyClock,
  });
  const qualificationPrerequisites =
    prepareAutonomousResearchSupervisorQualificationPrerequisites({
      runtimeRoot,
      environment,
      externalQualificationConfigPath,
      publicationMutationCoordinator:
        stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedPublication: requireFullyAutonomous,
      createQualificationPointerRepository,
    });
  const {
    receiptPointerRepository,
    effectiveEnvironment,
    configuredExternalQualificationPath,
    externalQualificationConfiguration,
  } = qualificationPrerequisites;
  const { options, providerConfiguration } =
    prepareAutonomousResearchSupervisorProvider({
      worker,
      environment: effectiveEnvironment,
    });
  const configuredMachineIntakePath = machineIntakeConfigPath
    || effectiveEnvironment.HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG || null;
  assertAutonomousResearchSupervisorMachineIntakeConfiguration({
    required: requireFullyAutonomous, configuredPath: configuredMachineIntakePath,
  });
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
  const execution = bootstrapExecutionContext({
    root,
    runtimeRoot,
    mode: 'autonomous-research-supervisor',
    execute: true,
    serviceOverrides,
    environment: effectiveEnvironment,
    nativeStoreMutationCoordinator: stateSafetyActivation?.mutationCoordinator || null,
    requireExternallyFencedNativeStore: requireFullyAutonomous,
  });
  const { context } = execution;
  const services = context.services;
  const onlineAuthorityEvidenceController = stateSafetyActivation
    ?.authorityEvidenceRenewalAdapter
    ? createAutonomousResearchOnlineAuthorityEvidenceRenewalController({
      adapter: stateSafetyActivation.authorityEvidenceRenewalAdapter,
      clock: services.clock,
      random,
      requireResidentFence: true,
      residentLeaseMs: residentInstanceLeaseMs,
      pollMs,
      residentHeartbeatMs: residentInstanceHeartbeatMs,
    }) : null;
  const stateRecoverabilityController =
    stateSafetyActivation?.stateRecoverabilityController || null;
  if (requireFullyAutonomous && !onlineAuthorityEvidenceController) {
    throw new Error(
      'autonomous_research_supervisor_online_authority_evidence_renewal_required',
    );
  }
  if (requireFullyAutonomous && !stateRecoverabilityController) {
    throw new Error(
      'autonomous_research_supervisor_state_recoverability_required',
    );
  }
  const reconcileStateRecoverability =
    createAutonomousResearchStateRecoverabilityReconciler({
      onlineAuthorityEvidenceController,
      stateRecoverabilityController,
    });
  const recoverAutonomousSubmission = createAutonomousResearchSubmissionHandoffInspection({
    environment: effectiveEnvironment,
    autonomousSubmissionOutbox: services.autonomousSubmissionOutbox,
    autonomousSubmissionRequestVerifier:
      services.autonomousSubmissionRequestVerifier,
  });
  const supervisorState = composeSupervisorState({
    runtimeRoot,
    runtimeRefreshStateRepository: runtimeReproducibilityOverrides.stateRepository,
    runtimeRefreshPolicy: resolveAutonomousResearchSupervisorRuntimeRefreshPolicy(
      effectiveEnvironment,
      runtimeReproducibilityPolicy,
    ),
    supervisorStateMutationCoordinator: stateSafetyActivation?.mutationCoordinator || null,
    requireExternallyFencedSupervisorState: requireFullyAutonomous,
    residentInstanceMutationCoordinator: stateSafetyActivation?.mutationCoordinator || null, requireExternallyFencedResidentInstance: requireFullyAutonomous,
    runtimeRefreshMutationCoordinator: stateSafetyActivation?.mutationCoordinator || null, requireExternallyFencedRuntimeRefresh: requireFullyAutonomous,
  });
  const stateRepository = supervisorState.lifecycle;
  const residentInstanceRepository = supervisorState.residentInstance;
  const residentCycleIntentRepository =
    createAutonomousResearchResidentCycleIntentRepository({ runtimeRoot });
  let machineIntakeRepository = null;
  let machineIntakePlane = null;
  const runtimeRefreshStateRepository = supervisorState.runtimeRefresh;
  const {
    externalActionRecoveryPort,
    externalActionRecoveryController,
  } = composeAutonomousResearchSupervisorExternalActionRecovery({
    configPath: externalActionRecoveryConfigPath,
    environment: effectiveEnvironment,
    clock: services.clock,
    requireFullyAutonomous,
    stateRepository,
    providerConfiguration,
  });
  const { runtimeRefresh, reconcileRuntime } = composeAutonomousResearchSupervisorRuntime({
    root,
    runtimeRoot,
    environment: effectiveEnvironment,
    clock: services.clock,
    scheduler: services.scheduler,
    random,
    runtimeRefreshStateRepository,
    runtimeReproducibilityOverrides,
    mutationCoordinator: stateSafetyActivation?.mutationCoordinator || null,
    requireFullyAutonomous,
    receiptPointerRepository,
    reconcileRuntimeOverride,
  });
  const { pairMaximum, effectiveLifecyclePolicy } =
    resolveAutonomousResearchSupervisorLifecycleCostEnvelope({
      environment: effectiveEnvironment,
      lifecyclePolicy,
      externalQualificationConfiguration,
      providerConfiguration,
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
      topicProducerMutationCoordinator:
        stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedTopicProducer: requireFullyAutonomous,
      machineIntakeMutationCoordinator:
        stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedMachineIntake: requireFullyAutonomous,
    });
    machineIntakeRepository = machineIntakePlane.machineIntakeRepository;
  } else if (configuredMachineIntakePath) {
    machineIntakeRepository = createLegacyAutonomousResearchMachineIntakeRepository({
      runtimeRoot,
      create: true,
      authorizedSourceAuthorityHash: initialMachineIntakeConfiguration.configurationHash,
      offlineProvision: !requireFullyAutonomous,
      mutationCoordinator: stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedMutations: requireFullyAutonomous,
    });
  }

  const readQualificationState = readQualificationStateOverride || (async (campaign) => {
    const repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: campaign.paperId,
      create: true,
      offlineProvision: !requireFullyAutonomous,
      mutationCoordinator: stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedMutations: requireFullyAutonomous,
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
      stateRecoverabilityController,
      onlineAuthorityEvidenceController,
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
    qualificationStateMutationCoordinator:
      stateSafetyActivation?.mutationCoordinator || null,
    requireExternallyFencedQualificationState: requireFullyAutonomous,
    receiptPointerRepository,
    nativeStoreMutationCoordinator:
      stateSafetyActivation?.mutationCoordinator || null,
    requireExternallyFencedNativeStore: requireFullyAutonomous,
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
    const {
      assertCampaignExternalSideEffectReady,
      supervisorExternalActionJournal,
    } = composeAutonomousResearchCampaignExternalSideEffectControl({
      stateRepository,
      supervisorDispatchEvidence,
      supervisorDispatchAuthorization,
      onlineAuthorityEvidenceController,
      stateRecoverabilityController,
      reconcileStateRecoverability,
      clock: services.clock,
      boundedQualificationRetry,
      externalActionRecoveryPort,
    });
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
      qualificationStateMutationCoordinator:
        stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedQualificationState: requireFullyAutonomous,
      nativeStoreMutationCoordinator:
        stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedNativeStore: requireFullyAutonomous,
      qualificationPublicationMutationCoordinator:
        stateSafetyActivation?.mutationCoordinator || null,
      requireExternallyFencedQualificationPublication: requireFullyAutonomous,
      supervisorDispatchAuthorization,
      supervisorExternalActionJournal,
      assertExternalSideEffectReady: assertCampaignExternalSideEffectReady,
      readinessClock: services.clock,
      runtimeSignal: dispatchSignal,
      worker: options,
    });
  });

  const machineIntake = createAutonomousResearchSupervisorMachineIntakeAdapter({
    repository: machineIntakeRepository,
    plane: machineIntakePlane,
    loadFallback({ now, operationMode }) {
      const configuration = readAutonomousResearchMachineIntakeConfiguration({
        configPath: configuredMachineIntakePath,
        environment: effectiveEnvironment,
        validateStaticContent: false,
      }).configuration;
      if (configuration.configurationHash
        !== initialMachineIntakeConfiguration.configurationHash) {
        throw new ResidentReactivationRequired({
          source: 'machine_intake_configuration',
          reason: 'autonomous_research_machine_intake_configuration_rotated',
          startupIdentityHash: initialMachineIntakeConfiguration.configurationHash,
          observedIdentityHash: configuration.configurationHash,
        });
      }
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
        nativeStoreMutationCoordinator:
          stateSafetyActivation?.mutationCoordinator || null,
        requireExternallyFencedNativeStore: requireFullyAutonomous,
        qualificationPublicationMutationCoordinator:
          stateSafetyActivation?.mutationCoordinator || null,
        requireExternallyFencedQualificationPublication: requireFullyAutonomous,
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
    recoverAutonomousSubmission,
    onlineAuthorityEvidenceController,
    stateRecoverabilityController,
    externalActionRecoveryController,
    machineIntake,
    requireFullyAutonomous,
    inspectFullyAutonomousPrerequisites: ({ now }) => (
      inspectAutonomousResearchResidentPrerequisites({
        runtimeRoot,
        environment: effectiveEnvironment,
        externalQualificationConfigPath: configuredExternalQualificationPath,
        externalActionRecoveryConfigPath,
        now,
      })
    ),
    reconcileRuntime,
    residentInstanceRepository,
    residentCycleIntentRepository,
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
